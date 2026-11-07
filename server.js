const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ============================================================
// 🎯 DEBUG LOGS
// ============================================================
const debugLogs = [];
function debugLog(userId, action, url, method, headers = {}, data = null, response = null, error = null) {
    const e = {
        timestamp: new Date().toISOString(), userId, action,
        request: { url, method, headers: JSON.stringify(headers, null, 2), body: data ? JSON.stringify(data, null, 2) : null },
        response: response ? { status: response.status, data: JSON.stringify(response.data, null, 2) } : null,
        error: error ? { message: error.message, status: error.response?.status,
                          data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null } : null
    };
    debugLogs.unshift(e);
    if (debugLogs.length > 200) debugLogs.pop();
    console.log(`\n${'='.repeat(80)}\n🔍 [${e.timestamp}] ${userId} ${action}\n  ${method} ${url}`);
    if (data) console.log('  BODY:', JSON.stringify(data));
    if (response) console.log('  ✅', response.status);
    if (error) console.log('  ❌', error.message, error.response?.status || '');
    console.log('='.repeat(80) + '\n');
}

// ============================================================
// ⚙️ CONFIG — env vars used by project 1's automation only
// ============================================================
const BASE_URL_REF       = process.env.BASE_URL_REF;
const BASE_URL_MONEY     = process.env.BASE_URL_MONEY;
const BASE_URL_SPRAY     = process.env.BASE_URL_SPRAY;
const BASE_URL_ACH       = process.env.BASE_URL_ACH;
const BASE_URL_OPENPACK  = process.env.BASE_URL_OPENPACK;
const USERS_CONFIG       = 'users.json';

// ---------- ✅ FIX: Derive kolex API base for collections / market ----------
// Priority:
//   1. explicit BASE_URL_COLLECTIONS / BASE_URL_MARKET env vars
//   2. strip known suffix from BASE_URL_SPRAY  (…/spinner/spin → …/api/v1)
//   3. strip known suffix from BASE_URL_REF    (…/auth/refresh  → …/api/v1)
//   4. strip known suffix from BASE_URL_MONEY  (…/user/funds    → …/api/v1)
//   5. empty → log a loud warning at startup
function deriveApiBase() {
    if (process.env.BASE_URL_COLLECTIONS) return process.env.BASE_URL_COLLECTIONS.replace(/\/+$/, '');
    if (process.env.BASE_URL_MARKET)      return process.env.BASE_URL_MARKET.replace(/\/+$/, '');

    const tryStrip = (url, patterns) => {
        if (!url) return null;
        const noQuery = url.split('?')[0].replace(/\/+$/, '');
        for (const p of patterns) {
            const s = noQuery.replace(p, '');
            if (s !== noQuery) return s;
        }
        return null;
    };

    const fromSpray = tryStrip(BASE_URL_SPRAY, [
        /\/spinner\/spin$/, /\/spinner$/, /\/spin$/,
    ]);
    if (fromSpray) return fromSpray;

    const fromRef = tryStrip(BASE_URL_REF, [
        /\/auth\/refresh$/, /\/refresh$/, /\/auth$/,
    ]);
    if (fromRef) return fromRef;

    const fromMoney = tryStrip(BASE_URL_MONEY, [
        /\/user\/funds$/, /\/funds$/,
    ]);
    if (fromMoney) return fromMoney;

    return '';
}

const KOLEX_API_BASE = deriveApiBase();
const BASE_URL_COLLECTIONS = process.env.BASE_URL_COLLECTIONS || KOLEX_API_BASE;
const BASE_URL_MARKET      = process.env.BASE_URL_MARKET      || KOLEX_API_BASE;

// Spinner endpoint — derive from SPRAY (…/spinner/spin → …/spinner), or override via env
let BASE_URL_SPINNER = process.env.BASE_URL_SPINNER;
if (!BASE_URL_SPINNER && BASE_URL_SPRAY) {
    BASE_URL_SPINNER = BASE_URL_SPRAY.split('?')[0].replace(/\/spin\/?$/, '');
}

// ============================================================
// 📊 STATE
// ============================================================
let userData = {};
let activityLogs = [];
let globalSpinnerConfig = {
    spinnerId: 7063,
    packIds: [11953, 12053, 12079, 12121, 12145, 12316, 14356, 12343, 12350, 14554],
    autoFetch: true,
    lastAutoFetch: null,
};
let globalListingConfig = { delayMs: 2400 };
let templateCirculationCache = {};
let collectionCirculationProfiles = {};

const DEFAULT_EXCLUDED_COLLECTIONS = new Set([
    1,2,3,4,5,6,7,8,9,10,11,104,105,106,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,
    181,183,188,928,929,930,931,932,933,934,935,936,937,938,939,940,941,943,945,946,947,
    2740,2938,2939,2940,2941,2942,2943,2944,2945,2946,2947,2948,2950,2953,2954,2955,2957,2958,2959,
    2961,2964,2966,6650,6651,6652,6653,6654,6655,6656,6657,6658,6659,6660,6661,6662,6663,6664,6665,6666,
    18316,18514,18877,18911,18913,18914,18927,18928,18930,20131,18918,18932,
    11155,11156,11157,11225,11551,16411,16412,16413,2542,2543,1376,1378,1379,1380,1381,1383,1384,1385
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ============================================================
// 💵 PRICE FORMULA (tiered)
// ============================================================
function mintDesirability(M, circulation) {
    const m = Math.max(1, Math.floor(M));
    let B;
    if (m === 1) B = 1.00;
    else if (m === 2) B = 0.60;
    else if (m <= 5) B = 0.52 - 0.04 * (m - 3);
    else if (m <= 9) B = 0.38 - 0.025 * (m - 6);
    else if (m <= 19) B = 0.25 - 0.009 * (m - 10);
    else if (m <= 49) B = 0.15 * Math.exp(-0.035 * (m - 20));
    else B = 0.055 * Math.exp(-0.045 * (m - 50));
    if (circulation > 500 && m >= 11) B *= 0.50;
    return B;
}
function classifyTier(CL) {
    if (CL <= 150) return 'legendary';
    if (CL <= 500) return 'epic';
    return 'ordinary';
}
function tierFloor(tier, CL) {
    if (tier === 'legendary') return clamp(2.00 + 0.50 * (150 - CL) / 100, 2.00, 2.50);
    if (tier === 'epic') return clamp(0.25 + 0.15 * (500 - CL) / 250, 0.25, 0.40);
    return 0.10;
}
function mintOneValue(tier, R, CL) {
    if (tier === 'legendary') return 10.00 * Math.pow(150 / CL, 0.20) * Math.exp(0.25 * (R - 9.00));
    if (tier === 'epic')      return 5.50 * Math.pow(250 / CL, 0.55) * Math.exp(0.22 * (R - 9.00));
    return Math.min(5.50, 3.40 * Math.exp(0.28 * (R - 4.30)));
}
function randomStrength(tier, M, premium) {
    if (premium < 0.015) return 0;
    const m = Math.max(1, Math.floor(M));
    if (tier === 'legendary') {
        if (m === 1) return 0.51;
        if (m === 2) return 0.345;
        if (m <= 5) return 0.27;
    }
    if (m === 1) return 0.33;
    if (m === 2) return 0.27;
    if (m <= 9) return 0.225;
    if (m <= 19) return 0.195;
    if (m <= 49) return 0.15;
    return 0.10 * clamp(premium / 0.50, 0, 1);
}
function roundMarketPrice(v) {
    if (v < 1) return Math.round(v * 100) / 100;
    if (v < 5) return Math.round(v * 20) / 20;
    return Math.round(v * 10) / 10;
}
function deterministicRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
    return ((h >>> 0) % 100000) / 50000 - 1;
}

async function loadCirculationCache() {
    try {
        const raw = await fs.readFile('circulation-cache.json', 'utf8');
        const p = JSON.parse(raw);
        templateCirculationCache = p.templateCache || {};
        collectionCirculationProfiles = p.collectionProfiles || {};
        console.log(`✅ Cache: ${Object.keys(templateCirculationCache).length} templates, ` +
                    `${Object.keys(collectionCirculationProfiles).length} collections`);
    } catch { console.log('ℹ️ No circulation cache yet'); }
}
async function saveCirculationCache() {
    try {
        await fs.writeFile('circulation-cache.json', JSON.stringify({
            templateCache: templateCirculationCache,
            collectionProfiles: collectionCirculationProfiles,
        }, null, 2));
    } catch (e) { console.error('Cache save failed:', e); }
}
function recordTemplateCirculation(templateId, minted) {
    if (!templateId || !minted || minted <= 0) return;
    templateCirculationCache[templateId] = minted;
}
function mergeCollectionObservation(collectionId, minted, rating) {
    if (!collectionId || !minted || minted <= 0) return;
    if (!collectionCirculationProfiles[collectionId]) collectionCirculationProfiles[collectionId] = [];
    const groups = collectionCirculationProfiles[collectionId];
    const found = groups.find(g => g.minted === minted);
    if (found) {
        found.count += 1;
        found.ratingMin = Math.min(found.ratingMin, rating);
        found.ratingMax = Math.max(found.ratingMax, rating);
    } else {
        groups.push({ minted, count: 1, ratingMin: rating, ratingMax: rating });
        groups.sort((a, b) => a.minted - b.minted);
    }
}
function resolveCirculation({ totalMinted, templateId, collectionId, mintNumber, rating }) {
    const M = Math.max(1, Math.floor(mintNumber || 1));
    const R = clamp(rating || 0, 0, 10);
    if (totalMinted != null && Number.isFinite(totalMinted) && totalMinted >= M) {
        recordTemplateCirculation(templateId, totalMinted);
        return { circulation: totalMinted, source: 'direct', confidence: 1.00 };
    }
    const cached = templateId != null ? templateCirculationCache[templateId] : undefined;
    if (cached !== undefined && cached >= M) {
        return { circulation: cached, source: 'template-cache', confidence: 0.98 };
    }
    const groups = collectionId != null ? (collectionCirculationProfiles[collectionId] || []) : [];
    const valid = groups.filter(g => g.minted >= M);
    if (valid.length === 1) {
        return { circulation: valid[0].minted, source: 'collection-single', confidence: 0.90 };
    }
    if (valid.length > 1) {
        let best = null, bestDist = Infinity;
        for (const g of valid) {
            let dist = 0;
            if (R < g.ratingMin) dist = g.ratingMin - R;
            else if (R > g.ratingMax) dist = R - g.ratingMax;
            if (dist < bestDist || (dist === bestDist && (best === null || g.minted > best.minted))) {
                best = g; bestDist = dist;
            }
        }
        const confidence = clamp(0.88 - bestDist * 0.15, 0.60, 0.88);
        return { circulation: best.minted, source: 'collection-rating-match', confidence };
    }
    let estimated;
    if (R >= 7.75 && M > 20) estimated = 100;
    else if (R >= 7.50) estimated = 250;
    else if (R >= 6.00) estimated = 250;
    else if (R >= 4.50) estimated = 2500;
    else estimated = 10000;
    if (estimated < M) {
        if (M <= 250) estimated = 250;
        else if (M <= 500) estimated = 500;
        else if (M <= 2500) estimated = 2500;
        else if (M <= 5000) estimated = 5000;
        else if (M <= 7500) estimated = 7500;
        else estimated = 10000;
    }
    return { circulation: estimated, source: 'rating-fallback', confidence: 0.45 };
}

function calculateListingPrice(card, userId, opts = {}) {
    const M = Math.max(1, Math.floor(card.mintNumber || 1));
    const R = clamp(card.rating || 0, 0, 10);
    const aggression = clamp(opts.aggression ?? 0, -1, 1);
    const circ = resolveCirculation({
        totalMinted: card.minted, templateId: card.templateId,
        collectionId: card.collectionId, mintNumber: M, rating: R,
    });
    const CL = circ.circulation;
    const tier = classifyTier(CL);
    const F = tierFloor(tier, CL);
    const V = Math.max(F, mintOneValue(tier, R, CL));
    const B = mintDesirability(M, CL);
    let basePrice = F + (V - F) * B;
    if (circ.source === 'rating-fallback') basePrice = F + (basePrice - F) * 0.82;
    else if (circ.source === 'collection-rating-match') basePrice = F + (basePrice - F) * 0.95;
    const premium = Math.max(0, basePrice - F);
    const rs = randomStrength(tier, M, premium);
    const period = opts.pricingPeriod || new Date().toISOString().slice(0, 10);
    const RM = (opts.randomValue != null) ? clamp(opts.randomValue, -1, 1)
                                          : deterministicRandom(`${card.id}:${userId}:${period}`);
    const randomMultiplier = Math.exp(rs * RM);
    const aggressionMultiplier = Math.exp(0.12 * aggression);
    let adjustedPrice = F + premium * randomMultiplier * aggressionMultiplier;
    const minRatio = tier === 'legendary' && M === 1 ? 0.70 : 0.78;
    const maxRatio = tier === 'legendary' && M === 1 ? 1.55 : 1.35;
    adjustedPrice = clamp(adjustedPrice, Math.max(F, basePrice * minRatio), basePrice * maxRatio);
    adjustedPrice = Math.min(adjustedPrice, 15.00);
    const finalPrice = Math.max(F, adjustedPrice);
    return {
        price: roundMarketPrice(finalPrice), basePrice: roundMarketPrice(basePrice),
        floor: F, mintOneValue: V, mintFactor: B, tier,
        circulationUsed: CL, circulationSource: circ.source, circulationConfidence: circ.confidence,
        randomValue: RM, randomStrength: rs, randomMultiplier,
        aggression, aggressionMultiplier,
    };
}
function getUserAggression(user) { return clamp(Number(user.aggression ?? 0), -1, 1); }

// ============================================================
// 🚀 INIT
// ============================================================
async function initializeApp() {
    try {
        console.log('🚀 INITIALIZING...');
        console.log('🔧 URL Resolution:');
        console.log(`   BASE_URL_REF       = ${BASE_URL_REF || '(unset)'}`);
        console.log(`   BASE_URL_SPRAY     = ${BASE_URL_SPRAY || '(unset)'}`);
        console.log(`   BASE_URL_MONEY     = ${BASE_URL_MONEY || '(unset)'}`);
        console.log(`   BASE_URL_SPINNER   = ${BASE_URL_SPINNER || '(unset)'}`);
        console.log(`   KOLEX_API_BASE     = ${KOLEX_API_BASE || '(EMPTY! ⚠️)'}`);
        console.log(`   BASE_URL_COLLECTIONS = ${BASE_URL_COLLECTIONS || '(EMPTY! ⚠️)'}`);
        console.log(`   BASE_URL_MARKET      = ${BASE_URL_MARKET || '(EMPTY! ⚠️)'}`);
        if (!BASE_URL_COLLECTIONS || !BASE_URL_MARKET) {
            console.warn('⚠️  Scanner will fail — set BASE_URL_COLLECTIONS and BASE_URL_MARKET env vars');
            console.warn('   (or ensure BASE_URL_SPRAY ends with /spinner/spin so it can be derived)');
        }

        await loadUserConfig();
        await loadCirculationCache();

        try {
            const p = JSON.parse(await fs.readFile('spinner-config.json', 'utf8'));
            globalSpinnerConfig = {
                spinnerId: p.spinnerId || globalSpinnerConfig.spinnerId,
                packIds: Array.isArray(p.packIds) ? p.packIds : globalSpinnerConfig.packIds,
                autoFetch: p.autoFetch !== undefined ? !!p.autoFetch : true,
                lastAutoFetch: p.lastAutoFetch || null,
            };
        } catch { await saveSpinnerConfig(); }

        try {
            const p = JSON.parse(await fs.readFile('listing-config.json', 'utf8'));
            globalListingConfig.delayMs = p.delayMs || 2400;
        } catch { await fs.writeFile('listing-config.json', JSON.stringify(globalListingConfig, null, 2)); }

        for (const userId of Object.keys(userData)) await refreshToken(userId);
        startImmediateOperations();
        startScheduledTasks();
        startContinuousOperations();
        console.log('✅ Init complete');
    } catch (e) { console.error('❌ Init failed:', e); }
}

function startImmediateOperations() {
    setTimeout(() => {
        Object.keys(userData).forEach(userId => {
            const user = userData[userId];
            if (user.isActive && isWithinActiveWindow(userId)) {
                setTimeout(() => claimAchievements(userId), 10000);
                checkFunds(userId);
                if (!user.nextSpinTime) calculateNextSpinTime(userId);
            }
        });
    }, 120000);
}

async function loadUserConfig() {
    try {
        const users = JSON.parse(await fs.readFile(USERS_CONFIG, 'utf8'));
        for (const u of users) {
            userData[u.userId] = {
                ...u, jwtToken: null, lastRefresh: null, nextSpinTime: null, nextListerTime: null,
                spinCount: 0, achievementsClaimed: 0, lastFunds: 0, lastCoronas: 0, lastUsd: 0,
                logs: [], isActive: false, dailyAchievementsDone: false, dailyFundsChecks: 0, packsOpened: 0,
                aggression: u.aggression != null ? Number(u.aggression) : 0,
                listerJitter: u.listerJitter ?? u['lister-jitter'] ?? 150,
            };
        }
        console.log(`✅ Loaded ${users.length} users`);
    } catch (e) { console.error('❌ User config:', e); userData = {}; }
}

// ============================================================
// 🔌 API REQUEST HELPER
// ============================================================
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    try {
        debugLog(userId, 'REQ', url, method, headers, data);
        const response = await axios({
            method: method.toLowerCase(), url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data, timeout: 20000,
        });
        debugLog(userId, 'RES', url, method, headers, data, response);
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
        debugLog(userId, 'ERR', url, method, headers, data, null, error);
        return { success: false, error: error.message, status: error.response?.status, responseData: error.response?.data };
    }
}

// ============================================================
// 🎡 SPINNER
// ============================================================
async function saveSpinnerConfig() {
    try { await fs.writeFile('spinner-config.json', JSON.stringify(globalSpinnerConfig, null, 2)); }
    catch (e) { console.error('save spinner:', e); }
}
async function fetchAndUpdateSpinnerInfo(userId, force = false) {
    const user = userData[userId];
    if (!user?.jwtToken) { logActivity('system', `❌ Spinner: no JWT for ${userId}`); return false; }
    if (!force) {
        if (!globalSpinnerConfig.autoFetch) return false;
        if (globalSpinnerConfig.lastAutoFetch) {
            const elapsed = Date.now() - new Date(globalSpinnerConfig.lastAutoFetch).getTime();
            if (elapsed < 5 * 60 * 1000) return true;
        }
    }
    if (!BASE_URL_SPINNER) { logActivity('system', '❌ BASE_URL_SPINNER missing'); return false; }

    const url = `${BASE_URL_SPINNER}?categoryId=1`;
    const res = await makeAPIRequest(url, 'GET',
        { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken }, null, userId);
    if (!res.success || !res.data?.data) {
        logActivity('system', `❌ Spinner fetch failed: ${res.error || 'no data'}`);
        return false;
    }
    const data = res.data.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const packPrizeIds = items
        .filter(it => Array.isArray(it.properties?.pack_templates) && it.properties.pack_templates.length > 0)
        .map(it => it.id);

    globalSpinnerConfig.spinnerId = data.id;
    globalSpinnerConfig.packIds = packPrizeIds;
    globalSpinnerConfig.lastAutoFetch = new Date().toISOString();
    await saveSpinnerConfig();
    logActivity('system', `🎡 Spinner: ID=${data.id}, packs=[${packPrizeIds.join(',')}]`);
    return true;
}

// ============================================================
// 🪙 TOKEN REFRESH
// ============================================================
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) { logActivity(userId, 'ERROR: user not found'); return false; }
    logActivity(userId, 'Starting token refresh...');
    const res = await makeAPIRequest(BASE_URL_REF, 'POST',
        { 'Content-Type': 'application/json' }, { refreshToken: user.refreshToken }, userId);
    if (res.success && res.data.data?.jwt) {
        user.jwtToken = res.data.data.jwt;
        user.lastRefresh = new Date().toISOString();
        user.isActive = true;
        if (res.data.data.refreshToken && res.data.data.refreshToken !== 'Not provided') {
            user.refreshToken = res.data.data.refreshToken;
            await updateUserConfig(userId, 'refreshToken', user.refreshToken);
        }
        logActivity(userId, '✅ Token refreshed');
        try { await fetchAndUpdateSpinnerInfo(userId, false); }
        catch (e) { logActivity(userId, `⚠️ Spinner auto-fetch: ${e.message}`); }
        scheduleNextTokenRefresh(userId);
        return true;
    }
    logActivity(userId, `❌ Refresh failed: ${res.error}`);
    user.isActive = false;
    return false;
}
function scheduleNextTokenRefresh(userId) {
    const user = userData[userId];
    if (!user) return;
    const { h, m } = parseHHMM(user.dayStart);
    let base = utcTodayAt(h, m, 0, 0);
    base = addMs(base, 24 * 60 * 60 * 1000);
    const range = minutesToMs(20);
    const randMs = Math.floor(Math.random() * (2 * range + 1)) - range;
    const next = addMs(base, randMs);
    setTimeout(async () => {
        logActivity(userId, `🔄 Daily refresh (jitter ${Math.round(randMs/60000)}m)`);
        await refreshToken(userId);
    }, Math.max(next.getTime() - Date.now(), 1000));
    logActivity(userId, `⏰ Next refresh: ${next.toUTCString()}`);
}

// ============================================================
// 💰 FUNDS / ACHIEVEMENTS / PACKS / SPINS
// ============================================================
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return null;
    const res = await makeAPIRequest(BASE_URL_MONEY, 'GET', { 'x-user-jwt': user.jwtToken }, null, userId);
    if (res.success && res.data.data) {
        const { silvercoins = 0, coronas = 0, usd = '0' } = res.data.data;
        user.lastFunds = silvercoins; user.lastCoronas = coronas; user.lastUsd = usd;
        user.dailyFundsChecks = (user.dailyFundsChecks || 0) + 1;
        logActivity(userId, `💰 ${silvercoins.toLocaleString()} / ${coronas.toLocaleString()} / ${usd} USD`);
        return { silvercoins, coronas, usd };
    }
    if (res.status === 401 && await refreshToken(userId)) return checkFunds(userId);
    logActivity(userId, `❌ Funds: ${res.error}`);
    return null;
}
async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return 0;
    const headers = { 'x-user-jwt': user.jwtToken };
    const r = await makeAPIRequest(`${BASE_URL_ACH}/${user.userId}/user`, 'GET', headers, null, userId);
    if (!r.success) {
        if (r.status === 401 && await refreshToken(userId)) return claimAchievements(userId);
        return 0;
    }
    const ids = [];
    ['achievements','daily','weekly','monthly'].forEach(cat => {
        (r.data.data[cat] || []).forEach(item => { if (item.progress?.claimAvailable) ids.push(item.id); });
    });
    if (!ids.length) { logActivity(userId, 'ℹ️ No achievements'); return 0; }
    let claimed = 0;
    for (const id of ids) {
        const c = await makeAPIRequest(`${BASE_URL_ACH}/${id}/claim/`, 'POST', headers, null, userId);
        if (c.success) claimed++;
        await sleep(800);
    }
    user.achievementsClaimed += claimed;
    logActivity(userId, `🎉 Claimed ${claimed}`);
    return claimed;
}
async function openPack(userId, packId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;
    const r = await makeAPIRequest(BASE_URL_OPENPACK, 'POST', { 'x-user-jwt': user.jwtToken }, { packId }, userId);
    if (r.success) { user.packsOpened = (user.packsOpened || 0) + 1; logActivity(userId, `✅ Pack opened: ${packId}`); return true; }
    if (r.status === 401 && await refreshToken(userId)) return openPack(userId, packId);
    return false;
}
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) { calculateNextSpinTime(userId); return null; }
    if (!isWithinActiveWindow(userId)) return null;
    const spinnerId = globalSpinnerConfig.spinnerId;
    logActivity(userId, `🎰 Spin with spinner ${spinnerId}`);
    try {
        const headers = { 'x-user-jwt': user.jwtToken, 'Content-Type': 'application/json' };
        const r = await makeAPIRequest(BASE_URL_SPRAY, 'POST', headers, { spinnerId }, userId);
        if (r.success) {
            const data = r.data.data;
            user.spinCount++;
            if (globalSpinnerConfig.packIds.includes(data.id) && data.packs?.length > 0) {
                await openPack(userId, data.packs[0].id);
            } else {
                logActivity(userId, `🎰 Prize ID=${data.id}`);
            }
        } else if (r.status === 401) await refreshToken(userId);
    } catch (e) { logActivity(userId, `❌ Spin: ${e.message}`); }
    finally { calculateNextSpinTime(userId); }
}
function calculateNextSpinTime(userId) {
    const user = userData[userId];
    if (!user) return;
    const base = user.baseInterval * 60 * 1000;
    const r1 = user.randomScale1 * 60 * 1000, r2 = user.randomScale2 * 60 * 1000;
    const total = base + Math.floor(Math.random() * (r2 - r1) + r1);
    user.nextSpinTime = new Date(Date.now() + total).toISOString();
    logActivity(userId, `⏰ Next spin in ${Math.round(total/60000)}m`);
}
function isWithinActiveWindow(userId) {
    const user = userData[userId];
    if (!user) return false;
    const now = new Date();
    if (!user._effectiveStartUTC || !user._effectiveEndUTC) {
        const { effectiveStart, effectiveEnd, randMs } = computeEffectiveWindow(user, now);
        user._effectiveStartUTC = effectiveStart;
        user._effectiveEndUTC = effectiveEnd;
        user._startJitterMin = Math.round(randMs / 60000);
    }
    return now >= user._effectiveStartUTC && now <= user._effectiveEndUTC;
}
function timeToMinutes(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }
async function updateUserConfig(userId, field, value) {
    try {
        const users = JSON.parse(await fs.readFile(USERS_CONFIG, 'utf8'));
        const idx = users.findIndex(u => u.userId === userId);
        if (idx !== -1) { users[idx][field] = value; await fs.writeFile(USERS_CONFIG, JSON.stringify(users, null, 2)); }
    } catch (e) { console.error('updateUserConfig:', e); }
}
function logActivity(userId, message) {
    const ts = new Date().toISOString();
    const e = { timestamp: ts, userId, message };
    activityLogs.unshift(e); activityLogs = activityLogs.slice(0, 1000);
    if (userData[userId]) { userData[userId].logs.unshift(e); userData[userId].logs = userData[userId].logs.slice(0, 200); }
    console.log(`[${ts}] User ${userId}: ${message}`);
}

// ============================================================
// 🕒 TIME / SERIALIZATION
// ============================================================
function utcTodayAt(h, m, s = 0, ms = 0) { const d = new Date(); d.setUTCHours(h, m, s, ms); return d; }
function addMs(d, ms) { return new Date(d.getTime() + ms); }
function minutesToMs(m) { return m * 60 * 1000; }
function parseHHMM(s) { const [h, m] = s.split(':').map(Number); return { h, m }; }
function toISOStringOrNull(v) { if (!v) return null; try { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); } catch { return null; } }

function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        const { _achTimers, _dailyRolloverTimer, _listerTimer, ...rest } = u;
        out[id] = { ...rest, _effectiveStartUTC: toISOStringOrNull(u._effectiveStartUTC), _effectiveEndUTC: toISOStringOrNull(u._effectiveEndUTC) };
    }
    return out;
}
function ensureTimerHolders(user) {
    ['_achTimers', '_dailyRolloverTimer', '_listerTimer'].forEach(name => {
        const d = Object.getOwnPropertyDescriptor(user, name);
        if (!d || d.enumerable) {
            Object.defineProperty(user, name, {
                value: name === '_achTimers' ? [] : null,
                writable: true, configurable: true, enumerable: false,
            });
        }
    });
}
function computeEffectiveWindow(user, now = new Date()) {
    const { h: sh, m: sm } = parseHHMM(user.dayStart);
    const { h: eh, m: em } = parseHHMM(user.dayEnd);
    let baseStart = utcTodayAt(sh, sm), baseEnd = utcTodayAt(eh, em);
    if (baseEnd <= baseStart) baseEnd = addMs(baseEnd, 24*60*60*1000);
    if (now > baseEnd) { baseStart = addMs(baseStart, 24*60*60*1000); baseEnd = addMs(baseEnd, 24*60*60*1000); }
    const range = minutesToMs(20);
    const randMs = Math.floor(Math.random() * (2*range + 1)) - range;
    return { effectiveStart: addMs(baseStart, randMs), effectiveEnd: baseEnd, randMs };
}
function clearAchievementTimers(userId) {
    const user = userData[userId];
    if (!user) return;
    ensureTimerHolders(user);
    if (Array.isArray(user._achTimers)) user._achTimers.forEach(t => clearTimeout(t));
    Object.defineProperty(user, '_achTimers', { value: [], writable: true, configurable: true, enumerable: false });
    if (user._dailyRolloverTimer) clearTimeout(user._dailyRolloverTimer);
    Object.defineProperty(user, '_dailyRolloverTimer', { value: null, writable: true, configurable: true, enumerable: false });
    if (user._listerTimer) clearTimeout(user._listerTimer);
    Object.defineProperty(user, '_listerTimer', { value: null, writable: true, configurable: true, enumerable: false });
}

// ============================================================
// 📅 DAILY PLAN
// ============================================================
function scheduleDailyPlan(userId) {
    const user = userData[userId];
    if (!user) return;
    ensureTimerHolders(user);
    clearAchievementTimers(userId);
    const now = new Date();
    const { effectiveStart, effectiveEnd, randMs } = computeEffectiveWindow(user, now);
    user._effectiveStartUTC = effectiveStart;
    user._effectiveEndUTC = effectiveEnd;
    user._startJitterMin = Math.round(randMs / 60000);
    logActivity(userId, `📅 Plan: start=${effectiveStart.toUTCString()} (jitter ${user._startJitterMin}m), end=${effectiveEnd.toUTCString()}`);

    const c1 = addMs(effectiveStart, minutesToMs(35));
    const c2 = addMs(c1, minutesToMs(8 * 60));
    const c3 = addMs(effectiveEnd, -minutesToMs(25));
    const scheduleClaim = (when, label) => {
        const delay = when.getTime() - Date.now();
        if (delay <= 0) { logActivity(userId, `⏭ ${label} skipped`); return; }
        const t = setTimeout(async () => {
            try {
                if (user.isActive) { logActivity(userId, `🏁 ${label}`); await claimAchievements(userId); }
            } catch (e) { logActivity(userId, `⚠️ ${label}: ${e.message}`); }
        }, delay);
        user._achTimers.push(t);
        logActivity(userId, `⏰ ${label} at ${when.toUTCString()}`);
    };
    scheduleClaim(c1, 'Ach #1');
    scheduleClaim(c2, 'Ach #2');
    scheduleClaim(c3, 'Ach #3');

    const listerJitterMin = Number(user.listerJitter) || 150;
    const listerAt = addMs(effectiveStart, minutesToMs(listerJitterMin));
    const listerDelay = listerAt.getTime() - Date.now();
    if (listerDelay > 0) {
        user._listerTimer = setTimeout(async () => {
            logActivity(userId, '📋 Daily lister firing');
            if (user.isActive && user.jwtToken) {
                try { await scanAndListCards(userId); }
                catch (e) { logActivity(userId, `❌ Lister: ${e.message}`); }
            }
        }, listerDelay);
        user.nextListerTime = listerAt.toISOString();
        logActivity(userId, `⏰ Lister at ${listerAt.toUTCString()} (+${listerJitterMin}m)`);
    } else {
        user.nextListerTime = null;
        logActivity(userId, `⏭ Lister skipped (past)`);
    }

    const rolloverAt = addMs(effectiveEnd, minutesToMs(2));
    user._dailyRolloverTimer = setTimeout(() => {
        logActivity(userId, '🔁 Rollover');
        scheduleDailyPlan(userId);
    }, Math.max(rolloverAt.getTime() - Date.now(), 1000));
}
function scheduleDailyPlanForAllUsers() {
    logActivity('system', '🗓️ Scheduling all daily plans');
    Object.keys(userData).forEach(scheduleDailyPlan);
}

// ============================================================
// 📋 SCAN + LIST  (uses BASE_URL_COLLECTIONS / BASE_URL_MARKET)
// ============================================================
async function fetchMarketTemplatesForCollection(userId, headers, collectionId) {
    const out = {};
    if (!BASE_URL_MARKET) return out;
    let page = 1;
    while (page <= 20) {
        const url = `${BASE_URL_MARKET}/market/templates?type=card&page=${page}&categoryId=1&collectionIds=${collectionId}`;
        const r = await makeAPIRequest(url, 'GET', headers, null, userId);
        if (!r.success || !r.data?.data) break;
        const tpl = r.data.data.templates || [];
        for (const t of tpl) {
            const cardT = t.cardTemplate;
            if (!cardT?.id) continue;
            out[cardT.id] = {
                minted: Number(cardT.minted) > 0 ? Number(cardT.minted) : null,
                inCirculation: Number(cardT.inCirculation) > 0 ? Number(cardT.inCirculation) : null,
            };
        }
        if (tpl.length < 40) break;
        page++;
        await sleep(400);
    }
    return out;
}

async function scanUserCards(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return [];
    if (!BASE_URL_COLLECTIONS) {
        logActivity(userId, '❌ Scan: BASE_URL_COLLECTIONS empty — set env var (see startup log)');
        return [];
    }

    const headers = { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken };
    const collected = [];

    const summaryUrl = `${BASE_URL_COLLECTIONS}/collections/users/${user.userId}/user-summary?categoryId=1&seasons=2026`;
    const summary = await makeAPIRequest(summaryUrl, 'GET', headers, null, userId);
    if (!summary.success || !Array.isArray(summary.data?.data)) {
        logActivity(userId, `⚠️ Scan: collections fetch failed (status=${summary.status} err=${summary.error || 'none'})`);
        return [];
    }

    const collections = [];
    for (const row of summary.data.data) {
        if (!row || row.count === 0) continue;
        const coll = row.collection;
        if (!coll) continue;
        if (coll.properties?.tiers?.includes('Loadout')) continue;
        if (DEFAULT_EXCLUDED_COLLECTIONS.has(coll.id)) continue;
        const type = coll.properties?.entity_types?.[0] || 'card';
        if (type !== 'card') continue;
        if (!collections.some(c => c.id === coll.id)) collections.push({ id: coll.id });
    }
    logActivity(userId, `🔍 Scan: ${collections.length} collections`);

    for (const coll of collections) {
        if (!user.isActive) break;
        const marketTpl = await fetchMarketTemplatesForCollection(userId, headers, coll.id);
        const itemsUrl = `${BASE_URL_COLLECTIONS}/collections/${coll.id}/users/${user.userId}/owned2`;
        const items = await makeAPIRequest(itemsUrl, 'GET', headers, null, userId);
        if (!items.success) { logActivity(userId, `⚠️ Items fail coll ${coll.id}`); continue; }
        const cards = items.data?.data?.cards || [];
        for (const item of cards) {
            if (item.status !== 'available') continue;
            if (!item.id || item.mintNumber == null) continue;
            const templateId = item.cardTemplateId || null;
            const mkt = templateId != null ? marketTpl[templateId] : null;
            const minted = mkt?.minted || null;
            const rating = Number(item.rating) || 0;
            collected.push({
                id: item.id, mintNumber: Number(item.mintNumber) || 0,
                rating, templateId, collectionId: coll.id, minted,
            });
            if (templateId && minted) {
                recordTemplateCirculation(templateId, minted);
                mergeCollectionObservation(coll.id, minted, rating);
            }
        }
    }
    const seen = new Set();
    const unique = [];
    for (const it of collected) { if (!seen.has(it.id)) { seen.add(it.id); unique.push(it); } }
    logActivity(userId, `🔍 Scan: ${unique.length} unique available cards`);
    return unique;
}

async function listCardOnMarket(userId, cardId, price) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;
    if (!BASE_URL_MARKET) return false;
    const r = await makeAPIRequest(`${BASE_URL_MARKET}/market/list`, 'POST',
        { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken },
        { id: cardId, type: 'card', price: String(price) }, userId);   // ← was: price
    return r.success;
}

async function scanAndListCards(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) { logActivity(userId, '❌ no JWT'); return { scanned: 0, listed: 0, failed: 0 }; }
    logActivity(userId, '🔍 Scan+list start');
    const cards = await scanUserCards(userId);
    await saveCirculationCache();
    if (!cards.length) { logActivity(userId, 'ℹ️ Nothing to list'); return { scanned: 0, listed: 0, failed: 0 }; }

    const aggression = getUserAggression(user);
    const delay = Math.max(Number(globalListingConfig.delayMs) || 2400, 100);
    const period = new Date().toISOString().slice(0, 10);
    let listed = 0, failed = 0;

    for (let i = 0; i < cards.length; i++) {
        if (!user.isActive) { logActivity(userId, '⏸ Inactive mid-list'); break; }
        const card = cards[i];
        const info = calculateListingPrice(card, userId, { aggression, pricingPeriod: period });
        logActivity(userId,
            `💵 [${i+1}/${cards.length}] ${card.id} M=${card.mintNumber} R=${card.rating.toFixed(2)} ` +
            `→ ${info.price.toFixed(2)} ` +
            `(${info.tier}, CL=${info.circulationUsed}/${info.circulationSource}, ` +
            `base=${info.basePrice.toFixed(2)}, RM=${info.randomValue.toFixed(2)}, A=${aggression})`);
        const ok = await listCardOnMarket(userId, card.id, info.price);
        if (ok) listed++; else failed++;
        if (i < cards.length - 1) await sleep(delay);
    }
    logActivity(userId, `📋 Listed ${listed}, failed ${failed} of ${cards.length}`);
    return { scanned: cards.length, listed, failed };
}

// ============================================================
// 🔁 CONTINUOUS OPS
// ============================================================
function startContinuousOperations() {
    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            const u = userData[userId];
            if (!u.isActive || !isWithinActiveWindow(userId)) continue;
            if (!u.nextSpinTime || new Date() >= new Date(u.nextSpinTime)) await executeSpin(userId);
        }
    }, 30000);
    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            if (isWithinActiveWindow(userId) && userData[userId].isActive) await checkFunds(userId);
        }
    }, 60 * 60 * 1000);
}
function startScheduledTasks() { scheduleDailyPlanForAllUsers(); }

// ============================================================
// 🌐 API ROUTES
// ============================================================
app.get('/api/users', (req, res) => res.json(safeUsersSnapshot()));
app.get('/api/activity', (req, res) => res.json(activityLogs.slice(0, parseInt(req.query.limit) || 100)));
app.get('/api/user/:userId/activity', (req, res) => {
    const u = userData[req.params.userId];
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json(u.logs.slice(0, parseInt(req.query.limit) || 50));
});
app.get('/api/debug-logs', (req, res) => res.json(debugLogs.slice(0, parseInt(req.query.limit) || 50)));

// Diagnostic — hit this if scanner 404s
app.get('/api/test-collections/:userId', async (req, res) => {
    const userId = req.params.userId;
    const user = userData[userId];
    if (!user?.jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    if (!BASE_URL_COLLECTIONS) return res.status(500).json({
        error: 'BASE_URL_COLLECTIONS empty',
        KOLEX_API_BASE,
        BASE_URL_SPRAY,
        hint: 'Set BASE_URL_COLLECTIONS env var to the API root (e.g. https://api.kolex.gg/api/v1)',
    });
    const url = `${BASE_URL_COLLECTIONS}/collections/users/${user.userId}/user-summary?categoryId=1&seasons=2026`;
    const result = await makeAPIRequest(url, 'GET', { 'x-user-jwt': user.jwtToken }, null, userId);
    res.json({
        url,
        success: result.success,
        status: result.status,
        error: result.error,
        dataPreview: result.data ? JSON.stringify(result.data).slice(0, 800) : null,
    });
});

app.get('/api/spinner-config', (req, res) => res.json(globalSpinnerConfig));
app.post('/api/spinner-config', async (req, res) => {
    const { spinnerId, packIds, autoFetch } = req.body;
    if (spinnerId !== undefined && spinnerId !== '') globalSpinnerConfig.spinnerId = parseInt(spinnerId) || globalSpinnerConfig.spinnerId;
    if (packIds !== undefined) {
        if (typeof packIds === 'string') globalSpinnerConfig.packIds = packIds.split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
        else if (Array.isArray(packIds)) globalSpinnerConfig.packIds = packIds.map(x => parseInt(x)).filter(x => !isNaN(x));
    }
    if (autoFetch !== undefined) globalSpinnerConfig.autoFetch = !!autoFetch;
    await saveSpinnerConfig();
    logActivity('system', `⚙️ Spinner config saved`);
    res.json({ success: true, config: globalSpinnerConfig });
});

app.post('/api/spinner-check', async (req, res) => {
    let userId = req.body?.userId;
    if (!userId) userId = Object.keys(userData).find(id => userData[id].jwtToken);
    if (!userId) return res.status(400).json({ error: 'No user with JWT' });
    if (!userData[userId]?.jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    const success = await fetchAndUpdateSpinnerInfo(userId, true);
    res.json({ success, config: globalSpinnerConfig, usedUserId: userId });
});

app.post('/api/user/:userId/spinner-check', async (req, res) => {
    const userId = req.params.userId;
    if (!userData[userId]) return res.status(404).json({ error: 'User not found' });
    if (!userData[userId].jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    const success = await fetchAndUpdateSpinnerInfo(userId, true);
    res.json({ success, config: globalSpinnerConfig, usedUserId: userId });
});

app.get('/api/listing-config', (req, res) => res.json(globalListingConfig));
app.post('/api/listing-config', async (req, res) => {
    if (req.body.delayMs !== undefined) globalListingConfig.delayMs = Math.max(parseInt(req.body.delayMs) || 2400, 100);
    try { await fs.writeFile('listing-config.json', JSON.stringify(globalListingConfig, null, 2)); } catch {}
    logActivity('system', `⚙️ Listing delay = ${globalListingConfig.delayMs}ms`);
    res.json({ success: true, config: globalListingConfig });
});

app.get('/api/circulation-cache', (req, res) => res.json({
    templateCount: Object.keys(templateCirculationCache).length,
    collectionCount: Object.keys(collectionCirculationProfiles).length,
    collectionProfiles: collectionCirculationProfiles,
}));

app.get('/api/export/user-jwt', (req, res) => {
    const out = {};
    for (const [id, u] of Object.entries(userData)) out[id] = { userId: id, jwtToken: u.jwtToken || '' };
    res.json(out);
});
app.get('/api/export/full-data', (req, res) => {
    const out = [];
    for (const [id, u] of Object.entries(userData)) out.push({
        nick: u.userNick || '', userId: id,
        funds: u.lastFunds || 0, coronas: u.lastCoronas || 0, usd: u.lastUsd || '0', jwtToken: u.jwtToken || ''
    });
    res.json(out);
});

app.post('/api/user/:userId/refresh', async (req, res) => res.json({ success: await refreshToken(req.params.userId) }));
app.post('/api/user/:userId/spin', async (req, res) => res.json({ success: !!(await executeSpin(req.params.userId)) }));
app.post('/api/user/:userId/claim-achievements', async (req, res) => res.json({ success: true, claimed: await claimAchievements(req.params.userId) }));
app.post('/api/user/:userId/check-funds', async (req, res) => res.json({ success: true, funds: await checkFunds(req.params.userId) }));
app.post('/api/user/:userId/scan-list', async (req, res) => {
    const userId = req.params.userId;
    if (!userData[userId]) return res.status(404).json({ error: 'User not found' });
    if (!userData[userId].jwtToken) return res.status(400).json({ error: 'No JWT' });
    try { res.json({ success: true, ...(await scanAndListCards(userId)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 🚀 START
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    initializeApp();
});