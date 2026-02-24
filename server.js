const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced logging
const debugLogs = [];
let systemState = {
    isPaused: false,
    maxConcurrent: 5,
    spinDelay: 7,
    activeUsers: 0,
    completedUsers: 0,
    totalUsers: 0,
    queuePosition: 0
};

function debugLog(userId, action, url, method, data = null, response = null, error = null) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        action,
        request: { url, method, body: data },
        response: response ? { status: response.status, data: response.data } : null,
        error: error ? { message: error.message, status: error.response?.status } : null
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 500) debugLogs.pop();

    console.log(`[${debugEntry.timestamp}] ${userId}: ${action} - ${url}`);
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
let activeProcesses = new Map();

// Load user configuration
async function loadUserConfig() {
    try {
        const configData = await fs.readFile(CONFIG.USERS_FILE, 'utf8');
        const users = JSON.parse(configData);
        
        for (const user of users) {
            userData[user.userId] = {
                ...user,
                jwtToken: null,
                jwtTokenShort: null, // For display only
                isActive: false,
                isProcessing: false,
                spinCount: 0,
                packsOpened: 0,
                totalSpinsRun: 0,
                totalPacksOpened: 0,
                lastFunds: 0,
                maxSpinsThisRound: 0,
                spinsCompletedThisRound: 0,
                fundsHistory: [],
                lastError: null,
                status: 'idle', // idle, refreshing, claiming, spinning, checking, completed
                logs: [],
                achievementsClaimed: 0,
                startTime: null,
                endTime: null
            };
        }
        
        systemState.totalUsers = users.length;
        console.log(`✅ Loaded ${users.length} users`);
    } catch (error) {
        console.error('❌ Error loading user config:', error);
        userData = {};
    }
}

// API request function
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    try {
        debugLog(userId, 'REQUEST', url, method, data);
        
        const response = await axios({
            method: method.toLowerCase(),
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data,
            timeout: 15000
        });

        debugLog(userId, 'SUCCESS', url, method, data, response);
        return { success: true, data: response.data, status: response.status };
        
    } catch (error) {
        debugLog(userId, 'ERROR', url, method, data, null, error);
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
    logActivity(userId, '🔄 Refreshing token...');

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_REF, 
        'POST', 
        { 'Content-Type': 'application/json' },
        { refreshToken: user.refreshToken },
        userId
    );

    if (result.success && result.data.data?.jwt) {
        user.jwtToken = result.data.data.jwt;
        // Store short version for display (first 20 chars)
        user.jwtTokenShort = user.jwtToken.substring(0, 20) + '...';
        user.isActive = true;
        logActivity(userId, '✅ Token refreshed');
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = `Token refresh failed: ${result.error}`;
        logActivity(userId, `❌ Token refresh failed: ${result.error}`);
        return false;
    }
}

// Claim achievements
async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, '❌ No JWT token for achievements');
        return 0;
    }

    user.status = 'claiming';
    let totalClaimed = 0;
    const userAchievementsUrl = `${CONFIG.BASE_URL_ACH}/${user.userId}/user`;
    const headers = { 'x-user-jwt': user.jwtToken };

    logActivity(userId, '🎯 Starting achievements claim...');

    try {
        // Get available achievements
        const achievementsResult = await makeAPIRequest(userAchievementsUrl, 'GET', headers, null, userId);
        
        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                logActivity(userId, 'JWT expired during achievements, refreshing...');
                const refreshSuccess = await refreshToken(userId);
                if (refreshSuccess) {
                    return await claimAchievements(userId);
                }
            }
            logActivity(userId, `❌ Achievements check failed: ${achievementsResult.error}`);
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
            logActivity(userId, 'ℹ️ No achievements to claim');
            return 0;
        }

        logActivity(userId, `🎯 Found ${validIDs.length} achievements to claim`);

        // Claim achievements
        for (const achievementId of validIDs) {
            const claimUrl = `${CONFIG.BASE_URL_ACH}/${achievementId}/claim/`;
            const claimResult = await makeAPIRequest(claimUrl, 'POST', headers, null, userId);
            
            if (claimResult.success) {
                totalClaimed++;
                logActivity(userId, `✅ Claimed achievement: ${achievementId}`);
            } else {
                logActivity(userId, `❌ Failed to claim ${achievementId}: ${claimResult.error}`);
            }
            
            // Small delay between claims
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        user.achievementsClaimed += totalClaimed;
        logActivity(userId, `🎉 Successfully claimed ${totalClaimed} achievements`);
        return totalClaimed;

    } catch (error) {
        logActivity(userId, `❌ Error in achievements: ${error.message}`);
        return 0;
    }
}

// Check funds
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, '❌ No JWT token for funds check');
        return null;
    }

    user.status = 'checking';
    const fundsUrl = `${CONFIG.BASE_URL_MONEY}`;
    const headers = { 'x-user-jwt': user.jwtToken };

    const result = await makeAPIRequest(fundsUrl, 'GET', headers, null, userId);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.lastFunds = silvercoins;
        user.fundsHistory.push({ time: new Date().toISOString(), amount: silvercoins });
        if (user.fundsHistory.length > 10) user.fundsHistory.shift();
        
        logActivity(userId, `💰 Funds: ${silvercoins.toLocaleString()} silvercoins`);
        return silvercoins;
    } else {
        if (result.status === 401) {
            logActivity(userId, 'JWT expired during funds check, refreshing...');
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) {
                return await checkFunds(userId);
            }
        }
        logActivity(userId, `❌ Funds check failed: ${result.error}`);
        return null;
    }
}

// Buy spin
async function buySpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (result.success) {
        logActivity(userId, '✅ Spin purchased');
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await buySpin(userId);
    }
    
    logActivity(userId, `❌ Spin purchase failed: ${result.error}`);
    return false;
}

// Open pack
async function openPack(userId, packId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

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
        logActivity(userId, `✅ Pack opened: ${packId}`);
        
        // Extra delay after opening pack
        await new Promise(resolve => setTimeout(resolve, 3000));
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await openPack(userId, packId);
    }
    
    logActivity(userId, `❌ Pack open failed: ${result.error}`);
    return false;
}

// Execute spin
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) {
        logActivity(userId, '❌ No JWT token');
        return null;
    }

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
        logActivity(userId, `❌ Spin failed: ${result.error}`);
        return null;
    }

    const spinData = result.data.data;
    const resultId = spinData.id;
    user.spinCount++;
    user.totalSpinsRun++;
    user.spinsCompletedThisRound++;

    // Prize mapping for better logging
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

    // Check if we got a pack (IDs: 11914, 11782, 11750, 11848)
    if ([11782, 11750, 11914, 11848].includes(resultId) && spinData.packs && spinData.packs.length > 0) {
        const packId = spinData.packs[0].id;
        logActivity(userId, `🎁 Got pack from spin: ${packId}`);
        await openPack(userId, packId);
    } else {
        logActivity(userId, `🎰 Spin result: ${prizeName}`);
    }

    return resultId;
}

// Process a single user through the complete workflow
async function processUser(userId) {
    if (systemState.isPaused) {
        logActivity(userId, '⏸️ System paused, returning user to queue');
        userQueue.unshift(userId);
        return;
    }

    const user = userData[userId];
    if (!user) return;

    user.isProcessing = true;
    user.startTime = new Date().toISOString();
    systemState.activeUsers++;
    
    try {
        logActivity(userId, '🚀 Starting user processing');
        
        while (user.isActive && !systemState.isPaused) {
            // Step 1: Claim achievements
            await claimAchievements(userId);
            
            // Step 2: Check funds
            const funds = await checkFunds(userId);
            if (funds === null) {
                user.lastError = 'Failed to check funds';
                break;
            }
            
            // Step 3: Check if funds > 100'000
            if (funds < 100000) {
                logActivity(userId, `🏁 Funds below 10,000 (${funds.toLocaleString()}). User completed.`);
                user.status = 'completed';
                user.endTime = new Date().toISOString();
                systemState.completedUsers++;
                break;
            }
            
            // Step 4: Calculate max spins for this round
            const maxSpins = Math.floor(funds / 1000);
            user.maxSpinsThisRound = maxSpins;
            user.spinsCompletedThisRound = 0;
            
            logActivity(userId, `🎯 Will run ${maxSpins} spins this round (${funds.toLocaleString()} funds / 1000)`);
            
            // Step 5: Run the spins
            for (let i = 0; i < maxSpins; i++) {
                if (systemState.isPaused) {
                    logActivity(userId, '⏸️ System paused during spins');
                    userQueue.unshift(userId);
                    return;
                }
                
                user.status = 'spinning';
                
                // Buy spin
                const buySuccess = await buySpin(userId);
                if (!buySuccess) {
                    user.lastError = 'Failed to buy spin';
                    break;
                }
                
                // Delay between buy and execute
                await new Promise(resolve => setTimeout(resolve, systemState.spinDelay * 1000));
                
                // Execute spin
                const spinResult = await executeSpin(userId);
                if (spinResult === null) {
                    user.lastError = 'Failed to execute spin';
                    break;
                }
                
                // Delay before next spin
                if (i < maxSpins - 1) {
                    await new Promise(resolve => setTimeout(resolve, systemState.spinDelay * 1000));
                }
            }
            
            // Brief pause before checking funds again
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
    } catch (error) {
        logActivity(userId, `❌ Critical error: ${error.message}`);
        user.lastError = error.message;
        user.status = 'error';
    } finally {
        user.isProcessing = false;
        systemState.activeUsers--;
        
        // Process next user in queue
        processNextInQueue();
    }
}

// Process next user in queue
function processNextInQueue() {
    if (systemState.isPaused) return;
    
    while (userQueue.length > 0 && systemState.activeUsers < systemState.maxConcurrent) {
        const nextUserId = userQueue.shift();
        systemState.queuePosition = userQueue.length;
        
        if (userData[nextUserId] && userData[nextUserId].isActive) {
            processUser(nextUserId);
        }
    }
}

// Initialize all users
async function initializeApp() {
    try {
        console.log('🚀 Initializing application...');
        await loadUserConfig();
        
        // Refresh tokens for all users
        console.log('🔄 Refreshing tokens for all users...');
        for (const userId of Object.keys(userData)) {
            await refreshToken(userId);
            // Small delay between refreshes
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log('✅ All users initialized. Waiting for start command...');
        logActivity('system', 'System ready. Click Start to begin processing.');
        
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

// Start processing
function startProcessing() {
    if (systemState.isPaused) {
        systemState.isPaused = false;
        logActivity('system', '▶️ Resuming processing');
    } else {
        logActivity('system', '▶️ Starting processing');
    }
    
    // Build queue of active users in order
    userQueue = Object.keys(userData)
        .filter(id => userData[id].isActive)
        .sort(); // Sort alphabetically for consistent order
    
    logActivity('system', `📋 Queue built with ${userQueue.length} users`);
    
    // Start initial batch
    processNextInQueue();
}

// Pause processing
function pauseProcessing() {
    systemState.isPaused = true;
    logActivity('system', '⏸️ Processing paused');
}

// Update settings
function updateSettings(maxConcurrent, spinDelay) {
    systemState.maxConcurrent = parseInt(maxConcurrent) || 5;
    systemState.spinDelay = parseFloat(spinDelay) || 7;
    logActivity('system', `⚙️ Settings updated: Max concurrent=${systemState.maxConcurrent}, Delay=${systemState.spinDelay}s`);
}

// Activity logging
function logActivity(userId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message };

    debugLogs.unshift(logEntry);
    if (userData[userId]) {
        userData[userId].logs.unshift(logEntry);
        userData[userId].logs = userData[userId].logs.slice(0, 100);
    }

    console.log(`[${timestamp}] ${userId}: ${message}`);
}

// Safe user data for frontend
function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        out[id] = {
            userId: u.userId,
            jwtToken: u.jwtTokenShort || 'No token',
            isActive: u.isActive,
            isProcessing: u.isProcessing,
            spinCount: u.spinCount,
            packsOpened: u.packsOpened,
            totalSpinsRun: u.totalSpinsRun || 0,
            totalPacksOpened: u.totalPacksOpened || 0,
            lastFunds: u.lastFunds,
            maxSpinsThisRound: u.maxSpinsThisRound,
            spinsCompletedThisRound: u.spinsCompletedThisRound,
            achievementsClaimed: u.achievementsClaimed || 0,
            lastError: u.lastError,
            status: u.status || 'idle',
            startTime: u.startTime,
            endTime: u.endTime,
            logs: u.logs.slice(0, 10)
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
    const limit = parseInt(req.query.limit) || 50;
    res.json(debugLogs.slice(0, limit));
});

app.get('/api/system-state', (req, res) => {
    res.json(systemState);
});

// Control endpoints
app.post('/api/start', (req, res) => {
    startProcessing();
    res.json({ success: true, message: 'Processing started' });
});

app.post('/api/pause', (req, res) => {
    pauseProcessing();
    res.json({ success: true, message: 'Processing paused' });
});

app.post('/api/settings', (req, res) => {
    const { maxConcurrent, spinDelay } = req.body;
    updateSettings(maxConcurrent, spinDelay);
    res.json({ success: true, message: 'Settings updated' });
});

app.post('/api/user/:userId/refresh', async (req, res) => {
    const userId = req.params.userId;
    const success = await refreshToken(userId);
    res.json({ success });
});

app.post('/api/user/:userId/process', (req, res) => {
    const userId = req.params.userId;
    if (userData[userId] && userData[userId].isActive) {
        userQueue.unshift(userId);
        processNextInQueue();
        res.json({ success: true, message: 'User added to queue' });
    } else {
        res.json({ success: false, message: 'User not active' });
    }
});

app.post('/api/reset', (req, res) => {
    // Reset all user stats
    for (const userId of Object.keys(userData)) {
        const user = userData[userId];
        user.spinCount = 0;
        user.packsOpened = 0;
        user.totalSpinsRun = 0;
        user.totalPacksOpened = 0;
        user.achievementsClaimed = 0;
        user.lastError = null;
        user.status = 'idle';
        user.startTime = null;
        user.endTime = null;
        user.fundsHistory = [];
    }
    
    systemState.completedUsers = 0;
    systemState.activeUsers = 0;
    systemState.isPaused = false;
    userQueue = [];
    
    logActivity('system', '🔄 System reset');
    res.json({ success: true, message: 'System reset' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    initializeApp();
});