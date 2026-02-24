const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Simple logging - only important events for dashboard
const debugLogs = [];
let systemState = {
    isPaused: false,
    maxConcurrent: 5,
    spinDelay: 7,
    minFundsThreshold: 10000,
    activeUsers: 0,
    completedUsers: 0,
    totalUsers: 0,
    queuePosition: 0
};

let processingInterval = null;

// This function logs to console ONLY (for Render logs) - shows ALL API requests
function consoleLog(userId, message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${userId}: ${message}`);
}

// This function logs to dashboard (only important events)
function dashboardLog(userId, message) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        message: message
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop();
}

// Combined logging - console always shows, dashboard only for important events
function log(userId, message, type = 'INFO', important = false) {
    // Always show in console (Render logs)
    consoleLog(userId, message, type);
    
    // Only show in dashboard if important
    if (important) {
        dashboardLog(userId, message);
    }
}

// Configuration
const CONFIG = {
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_SPIN: process.env.BASE_URL_SPIN,
    BASE_URL_BUY_SPIN: process.env.BASE_URL_BUY_SPIN,
    BASE_URL_OPENPACK: process.env.BASE_URL_OPENPACK,
    BASE_URL_ACH: process.env.BASE_URL_ACH,
    BASE_URL_MONEY: process.env.BASE_URL_MONEY,
    USERS_FILE: 'users.json',
};

// Global storage
let userData = {};
let userQueue = [];

// Load user configuration
async function loadUserConfig() {
    try {
        const configData = await fs.readFile(CONFIG.USERS_FILE, 'utf8');
        const users = JSON.parse(configData);
        
        for (const user of users) {
            userData[user.userId] = {
                ...user,
                jwtToken: null,
                isActive: false,
                spinCount: 0,
                packsOpened: 0,
                totalSpinsRun: 0,
                totalPacksOpened: 0,
                initialFunds: 0,
                currentFunds: 0,
                spinsRemainingInRound: 0,
                spinsCompletedInRound: 0,
                lastError: null,
                status: 'idle',
                achievementsClaimed: 0,
                startTime: null,
                endTime: null
            };
        }
        
        systemState.totalUsers = users.length;
        log('system', `✅ Loaded ${users.length} users`, 'INFO', true);
    } catch (error) {
        console.error('❌ Error loading user config:', error);
        userData = {};
    }
}

// API request function with console logging only
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    const requestId = Math.random().toString(36).substring(7);
    log(userId, `🌐 API ${method} ${url}`, 'API', false);
    
    try {
        const response = await axios({
            method: method.toLowerCase(),
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data,
            timeout: 15000
        });
        
        log(userId, `✅ API Success ${method} ${url} (${response.status})`, 'API', false);
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
        log(userId, `❌ API Error ${method} ${url}: ${error.message}`, 'API_ERROR', false);
        return {
            success: false,
            error: error.message,
            status: error.response?.status,
            responseData: error.response?.data
        };
    }
}

// Refresh token
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) return false;
    
    user.status = 'refreshing';
    log(userId, '🔄 Refreshing token...', 'REFRESH', true);

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_REF, 
        'POST', 
        { 'Content-Type': 'application/json' },
        { refreshToken: user.refreshToken },
        userId
    );

    if (result.success && result.data.data?.jwt) {
        user.jwtToken = result.data.data.jwt;
        user.isActive = true;
        log(userId, '✅ Token refreshed', 'REFRESH', true);
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = `Token refresh failed`;
        log(userId, '❌ Token refresh failed', 'ERROR', true);
        return false;
    }
}

// Claim achievements
async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) return 0;

    user.status = 'claiming';
    let totalClaimed = 0;
    const userAchievementsUrl = `${CONFIG.BASE_URL_ACH}/${user.userId}/user`;
    const headers = { 'x-user-jwt': user.jwtToken };

    log(userId, '🎯 Checking achievements...', 'CLAIM', false);

    try {
        const achievementsResult = await makeAPIRequest(userAchievementsUrl, 'GET', headers, null, userId);
        
        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) return await claimAchievements(userId);
            }
            return 0;
        }

        const validIDs = [];
        const categories = ['achievements', 'daily', 'weekly', 'monthly'];

        categories.forEach((category) => {
            if (achievementsResult.data.data[category]) {
                achievementsResult.data.data[category].forEach((item) => {
                    if (item.progress?.claimAvailable) {
                        validIDs.push(item.id);
                    }
                });
            }
        });

        if (validIDs.length === 0) {
            log(userId, 'ℹ️ No achievements to claim', 'CLAIM', false);
            return 0;
        }

        log(userId, `🎯 Found ${validIDs.length} achievements to claim`, 'CLAIM', true);

        for (const achievementId of validIDs) {
            const claimUrl = `${CONFIG.BASE_URL_ACH}/${achievementId}/claim/`;
            const claimResult = await makeAPIRequest(claimUrl, 'POST', headers, null, userId);
            
            if (claimResult.success) {
                totalClaimed++;
            }
            
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (totalClaimed > 0) {
            user.achievementsClaimed += totalClaimed;
            log(userId, `🎯 Claimed ${totalClaimed} achievements`, 'CLAIM', true);
        }
        
        return totalClaimed;

    } catch (error) {
        log(userId, `❌ Error in achievements: ${error.message}`, 'ERROR', true);
        return 0;
    }
}

// Check funds
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) return null;

    user.status = 'checking';
    const fundsUrl = `${CONFIG.BASE_URL_MONEY}`;
    const headers = { 'x-user-jwt': user.jwtToken };

    log(userId, '💰 Checking funds...', 'FUNDS', false);

    const result = await makeAPIRequest(fundsUrl, 'GET', headers, null, userId);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.currentFunds = silvercoins;
        
        if (user.initialFunds === 0) {
            user.initialFunds = silvercoins;
            log(userId, `💰 Initial funds: ${silvercoins.toLocaleString()}`, 'FUNDS', true);
        }
        
        return silvercoins;
    } else {
        if (result.status === 401) {
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) return await checkFunds(userId);
        }
        return null;
    }
}

// Buy spin
async function buySpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    log(userId, '💎 Buying spin...', 'SPIN', false);

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (result.success) {
        log(userId, '✅ Spin purchased', 'SPIN', false);
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await buySpin(userId);
    }
    log(userId, '❌ Spin purchase failed', 'ERROR', true);
    return false;
}

// Open pack
async function openPack(userId, packId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    log(userId, `📦 Opening pack: ${packId}...`, 'PACK', false);

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_OPENPACK,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { packId },
        userId
    );

    if (result.success) {
        user.packsOpened++;
        user.totalPacksOpened++;
        log(userId, `📦 Pack opened: ${packId}`, 'PACK', true);
        await new Promise(resolve => setTimeout(resolve, 3000));
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await openPack(userId, packId);
    }
    log(userId, `❌ Pack open failed: ${packId}`, 'ERROR', true);
    return false;
}

// Execute spin
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return null;

    log(userId, '🎰 Executing spin...', 'SPIN', false);

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { spinnerId: 6799 },
        userId
    );

    if (!result.success) {
        if (result.status === 401) {
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) return await executeSpin(userId);
        }
        log(userId, '❌ Spin failed', 'ERROR', true);
        return null;
    }

    const spinData = result.data.data;
    const resultId = spinData.id;
    user.totalSpinsRun++;
    user.spinsCompletedInRound++;

    const prizeMap = {
        11755: '5,000 Spraycoins',
        11750: 'Standard Box 2025',
        11914: 'Krakow Box 2026',
        11782: 'New Standard Box 2025',
        11749: '500 Spraycoins',
        11754: '1,000,000 Spraycoins',
        11753: '100,000 Spraycoins',
        11752: '2,500 Spraycoins',
        11751: '1,000 Spraycoins',
    };

    const prizeName = prizeMap[resultId] || `ID = ${resultId}`;
    log(userId, `🎰 Spin result: ${prizeName}`, 'SPIN', false);

    // Check if we got a pack
    if ([11782, 11750, 11914, 11848].includes(resultId) && spinData.packs && spinData.packs.length > 0) {
        const packId = spinData.packs[0].id;
        log(userId, `🎁 Got pack from spin!`, 'PACK', true);
        await openPack(userId, packId);
    }

    return resultId;
}

// Initialize a new round for a user
async function initializeUserRound(userId) {
    const user = userData[userId];
    if (!user || !user.isActive) return false;

    const funds = await checkFunds(userId);
    if (funds === null) return false;

    if (funds < systemState.minFundsThreshold) {
        user.status = 'completed';
        user.endTime = new Date().toISOString();
        systemState.completedUsers++;
        log(userId, `✅ User completed (final funds: ${funds.toLocaleString()})`, 'COMPLETE', true);
        
        // Add next user from queue
        addNextUserFromQueue();
        return false;
    }

    const spinsThisRound = Math.floor(funds / 1000);
    user.spinsRemainingInRound = spinsThisRound;
    user.spinsCompletedInRound = 0;
    
    log(userId, `🔄 New round: ${spinsThisRound} spins (funds: ${funds.toLocaleString()})`, 'ROUND', true);
    return true;
}

// Process a single spin for a user
async function processUserSpin(userId) {
    const user = userData[userId];
    if (!user || !user.isActive || systemState.isPaused) return false;

    try {
        user.status = 'spinning';
        systemState.activeUsers++;
        
        const buySuccess = await buySpin(userId);
        if (!buySuccess) {
            user.lastError = 'Failed to buy spin';
            systemState.activeUsers--;
            return false;
        }
        
        const spinResult = await executeSpin(userId);
        if (spinResult === null) {
            user.lastError = 'Failed to execute spin';
            systemState.activeUsers--;
            return false;
        }
        
        user.spinsRemainingInRound--;
        systemState.activeUsers--;
        
        // If round complete, claim achievements and start new round
        if (user.spinsRemainingInRound <= 0) {
            log(userId, `🏁 Round complete! Claiming achievements...`, 'ROUND', true);
            await claimAchievements(userId);
            await initializeUserRound(userId);
        }
        
        return true;
        
    } catch (error) {
        systemState.activeUsers--;
        log(userId, `❌ Error in spin: ${error.message}`, 'ERROR', true);
        return false;
    }
}

// Get random active user
function getRandomActiveUser() {
    const activeUsers = Object.keys(userData).filter(id => {
        const user = userData[id];
        return user.isActive && 
               user.status !== 'completed' && 
               user.status !== 'error' &&
               user.status !== 'spinning' &&
               user.spinsRemainingInRound > 0;
    });
    
    if (activeUsers.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * activeUsers.length);
    return activeUsers[randomIndex];
}

// Add next user from queue
async function addNextUserFromQueue() {
    if (userQueue.length === 0) return false;
    
    const nextUserId = userQueue.shift();
    const user = userData[nextUserId];
    
    if (!user || !user.isActive) return false;
    
    const roundStarted = await initializeUserRound(nextUserId);
    
    if (roundStarted) {
        log(nextUserId, `➕ Added to active pool`, 'QUEUE', true);
        return true;
    }
    
    return false;
}

// Main processing function
async function processNextBatch() {
    if (systemState.isPaused) return;
    
    // Get current spinning count
    const spinningCount = Object.values(userData).filter(u => u.status === 'spinning').length;
    
    // Log current state
    const activeWithSpins = Object.values(userData).filter(u => u.spinsRemainingInRound > 0).length;
    log('system', `📊 State: ${spinningCount} spinning, ${activeWithSpins} ready, ${userQueue.length} in queue`, 'STATUS', false);
    
    // Start new spins if we have capacity
    if (spinningCount < systemState.maxConcurrent) {
        const slotsToFill = systemState.maxConcurrent - spinningCount;
        
        for (let i = 0; i < slotsToFill; i++) {
            const nextUser = getRandomActiveUser();
            if (!nextUser) {
                // No active users with spins, try to add from queue
                if (userQueue.length > 0) {
                    await addNextUserFromQueue();
                    // Try again after adding
                    const newUser = getRandomActiveUser();
                    if (newUser) {
                        processUserSpin(newUser).catch(console.error);
                    }
                }
                break;
            }
            
            // Process this user's spin
            processUserSpin(nextUser).catch(console.error);
        }
    }
}

// Initialize all users
async function initializeApp() {
    try {
        log('system', '🚀 Initializing application...', 'INIT', true);
        await loadUserConfig();
        
        log('system', '🔄 Refreshing tokens for all users...', 'INIT', true);
        const userIds = Object.keys(userData);
        
        for (const userId of userIds) {
            await refreshToken(userId);
            await checkFunds(userId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Build queue (random order)
        userQueue = userIds.sort(() => Math.random() - 0.5);
        
        log('system', `✅ System ready. ${userIds.length} users in queue.`, 'INIT', true);
        
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

// Start processing
function startProcessing() {
    if (processingInterval) {
        clearInterval(processingInterval);
    }
    
    // Update settings
    if (global.pendingMaxConcurrent) {
        systemState.maxConcurrent = parseInt(global.pendingMaxConcurrent) || 5;
        systemState.spinDelay = parseFloat(global.pendingSpinDelay) || 7;
        systemState.minFundsThreshold = parseInt(global.pendingMinFunds) || 10000;
    }
    
    systemState.isPaused = false;
    log('system', `▶️ Processing started (Max: ${systemState.maxConcurrent}, Delay: ${systemState.spinDelay}s, Min Funds: ${systemState.minFundsThreshold})`, 'START', true);
    
    // Add initial users from queue
    for (let i = 0; i < systemState.maxConcurrent; i++) {
        if (userQueue.length > 0) {
            addNextUserFromQueue();
        }
    }
    
    // Process immediately and repeatedly
    processNextBatch();
    processingInterval = setInterval(processNextBatch, 1000); // Check every second, but respect spinDelay between spins
}

// Pause processing
function pauseProcessing() {
    systemState.isPaused = true;
    if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
    }
    log('system', '⏸️ Processing paused', 'PAUSE', true);
}

// Update settings
function updateSettings(maxConcurrent, spinDelay, minFundsThreshold) {
    global.pendingMaxConcurrent = maxConcurrent;
    global.pendingSpinDelay = spinDelay;
    global.pendingMinFunds = minFundsThreshold;
    log('system', `⚙️ Settings updated: Max=${maxConcurrent}, Delay=${spinDelay}s, Min Funds=${minFundsThreshold}`, 'SETTINGS', true);
}

// Safe user data for frontend
function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        out[id] = {
            userId: u.userId,
            nick: u.nick || u.name || id,
            jwtToken: u.jwtToken || 'No token',
            isActive: u.isActive,
            isProcessing: u.status === 'spinning',
            totalSpinsRun: u.totalSpinsRun || 0,
            totalPacksOpened: u.totalPacksOpened || 0,
            initialFunds: u.initialFunds || 0,
            currentFunds: u.currentFunds || 0,
            spinsRemainingInRound: u.spinsRemainingInRound || 0,
            spinsCompletedInRound: u.spinsCompletedInRound || 0,
            achievementsClaimed: u.achievementsClaimed || 0,
            lastError: u.lastError,
            status: u.status || 'idle',
            startTime: u.startTime,
            endTime: u.endTime
        };
    }
    return out;
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/users', (req, res) => {
    res.json(safeUsersSnapshot());
});

app.get('/api/debug-logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(debugLogs.slice(0, limit));
});

app.get('/api/system-state', (req, res) => {
    res.json({
        ...systemState,
        queueLength: userQueue.length
    });
});

// Control endpoints
app.post('/api/start', (req, res) => {
    const { maxConcurrent, spinDelay, minFundsThreshold } = req.body;
    if (maxConcurrent) updateSettings(maxConcurrent, spinDelay, minFundsThreshold);
    startProcessing();
    res.json({ success: true, message: 'Processing started' });
});

app.post('/api/pause', (req, res) => {
    pauseProcessing();
    res.json({ success: true, message: 'Processing paused' });
});

app.post('/api/user/:userId/refresh', async (req, res) => {
    const userId = req.params.userId;
    const success = await refreshToken(userId);
    await checkFunds(userId);
    res.json({ success });
});

app.post('/api/reset', (req, res) => {
    for (const userId of Object.keys(userData)) {
        const user = userData[userId];
        user.totalSpinsRun = 0;
        user.totalPacksOpened = 0;
        user.initialFunds = user.currentFunds;
        user.achievementsClaimed = 0;
        user.lastError = null;
        user.status = 'idle';
        user.startTime = null;
        user.endTime = null;
        user.spinsRemainingInRound = 0;
        user.spinsCompletedInRound = 0;
    }
    
    userQueue = Object.keys(userData).sort(() => Math.random() - 0.5);
    systemState.completedUsers = 0;
    systemState.isPaused = false;
    
    log('system', `🔄 System reset. ${userQueue.length} users in queue.`, 'RESET', true);
    res.json({ success: true, message: 'System reset' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    initializeApp();
});