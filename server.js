const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Simple logging - only important events
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

function debugLog(userId, action, message) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        message: message
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop();
    console.log(`[${debugEntry.timestamp}] ${userId}: ${message}`);
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
let userQueue = []; // Queue of users not yet started

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
                spinsRemainingInRound: 0, // Tracks spins left in current batch
                spinsCompletedInRound: 0,
                lastError: null,
                status: 'idle', // idle, spinning, completed, error
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
        const response = await axios({
            method: method.toLowerCase(),
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            data,
            timeout: 15000
        });
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
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
        debugLog(userId, 'REFRESH', '🔄 Token refreshed');
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = `Token refresh failed`;
        debugLog(userId, 'ERROR', '❌ Token refresh failed');
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

        if (validIDs.length === 0) return 0;

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
            debugLog(userId, 'CLAIM', `🎯 Claimed ${totalClaimed} achievements`);
        }
        
        return totalClaimed;

    } catch (error) {
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

    const result = await makeAPIRequest(fundsUrl, 'GET', headers, null, userId);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.currentFunds = silvercoins;
        
        // Store initial funds if not set
        if (user.initialFunds === 0) {
            user.initialFunds = silvercoins;
            debugLog(userId, 'FUNDS', `💰 Initial funds: ${silvercoins.toLocaleString()}`);
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

    const result = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (result.success) {
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await buySpin(userId);
    }
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
        debugLog(userId, 'PACK', `📦 Pack opened: ${packId}`);
        await new Promise(resolve => setTimeout(resolve, 3000)); // Extra delay for packs
        return true;
    } else if (result.status === 401) {
        const refreshSuccess = await refreshToken(userId);
        if (refreshSuccess) return await openPack(userId, packId);
    }
    return false;
}

// Execute spin
async function executeSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return null;

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
        return null;
    }

    const spinData = result.data.data;
    const resultId = spinData.id;
    user.totalSpinsRun++;
    user.spinsCompletedInRound++;

    // Check if we got a pack
    if ([11782, 11750, 11914, 11848].includes(resultId) && spinData.packs && spinData.packs.length > 0) {
        const packId = spinData.packs[0].id;
        await openPack(userId, packId);
    }

    return resultId;
}

// Initialize a new round for a user (check funds, calculate spins)
async function initializeUserRound(userId) {
    const user = userData[userId];
    if (!user || !user.isActive) return false;

    // Check current funds
    const funds = await checkFunds(userId);
    if (funds === null) return false;

    // If below threshold, user is done
    if (funds < systemState.minFundsThreshold) {
        user.status = 'completed';
        user.endTime = new Date().toISOString();
        systemState.completedUsers++;
        debugLog(userId, 'COMPLETE', `✅ User completed (final funds: ${funds.toLocaleString()})`);
        
        // Add next user from queue if available
        addNextUserFromQueue();
        return false;
    }

    // Calculate spins for this round (funds / 1000)
    const spinsThisRound = Math.floor(funds / 1000);
    user.spinsRemainingInRound = spinsThisRound;
    user.spinsCompletedInRound = 0;
    
    debugLog(userId, 'NEW_ROUND', `🔄 New round: ${spinsThisRound} spins (funds: ${funds.toLocaleString()})`);
    return true;
}

// Process a single spin for a user
async function processUserSpin(userId) {
    const user = userData[userId];
    if (!user || !user.isActive || systemState.isPaused) return false;

    try {
        user.status = 'spinning';
        systemState.activeUsers++;
        
        // Buy spin
        const buySuccess = await buySpin(userId);
        if (!buySuccess) {
            user.lastError = 'Failed to buy spin';
            systemState.activeUsers--;
            return false;
        }
        
        // Execute spin
        const spinResult = await executeSpin(userId);
        if (spinResult === null) {
            user.lastError = 'Failed to execute spin';
            systemState.activeUsers--;
            return false;
        }
        
        user.spinsRemainingInRound--;
        systemState.activeUsers--;
        
        // Check if round is complete
        if (user.spinsRemainingInRound <= 0) {
            // Round complete - claim achievements
            await claimAchievements(userId);
            
            // Initialize next round (will check funds again)
            const roundStarted = await initializeUserRound(userId);
            
            if (!roundStarted) {
                // User is completed, remove from active pool
                return false;
            }
        }
        
        return true;
        
    } catch (error) {
        systemState.activeUsers--;
        return false;
    }
}

// Get random active user (only those with spins remaining)
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

// Add next user from queue to active pool
async function addNextUserFromQueue() {
    if (userQueue.length === 0) return false;
    
    const nextUserId = userQueue.shift();
    const user = userData[nextUserId];
    
    if (!user || !user.isActive) return false;
    
    // Initialize first round for this user
    const roundStarted = await initializeUserRound(nextUserId);
    
    if (roundStarted) {
        debugLog(nextUserId, 'ADDED', `➕ Added to active pool (queue position: ${userQueue.length})`);
        return true;
    }
    
    return false;
}

// Main processing function
async function processNextBatch() {
    if (systemState.isPaused) return;
    
    // Get current spinning count
    const spinningCount = Object.values(userData).filter(u => u.status === 'spinning').length;
    
    // Start new spins if we have capacity
    if (spinningCount < systemState.maxConcurrent) {
        const slotsToFill = systemState.maxConcurrent - spinningCount;
        
        for (let i = 0; i < slotsToFill; i++) {
            const nextUser = getRandomActiveUser();
            if (!nextUser) {
                // No active users with spins remaining, try to add from queue
                if (userQueue.length > 0) {
                    await addNextUserFromQueue();
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
        console.log('🚀 Initializing application...');
        await loadUserConfig();
        
        // Refresh tokens for all users and build queue
        console.log('🔄 Refreshing tokens for all users...');
        const userIds = Object.keys(userData);
        
        for (const userId of userIds) {
            await refreshToken(userId);
            // Initial funds check
            await checkFunds(userId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Build queue (all users in random order)
        userQueue = userIds.sort(() => Math.random() - 0.5);
        
        console.log('✅ All users initialized. Waiting for start command...');
        debugLog('system', 'READY', `System ready. ${userIds.length} users in queue. Click Start to begin.`);
        
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

// Start processing
function startProcessing() {
    if (processingInterval) {
        clearInterval(processingInterval);
    }
    
    // Update settings from request body if provided
    if (global.pendingMaxConcurrent) {
        systemState.maxConcurrent = parseInt(global.pendingMaxConcurrent) || 5;
        systemState.spinDelay = parseFloat(global.pendingSpinDelay) || 7;
        systemState.minFundsThreshold = parseInt(global.pendingMinFunds) || 10000;
    }
    
    systemState.isPaused = false;
    debugLog('system', 'START', `▶️ Processing started (Max: ${systemState.maxConcurrent}, Delay: ${systemState.spinDelay}s, Min Funds: ${systemState.minFundsThreshold})`);
    
    // Add initial users from queue
    for (let i = 0; i < systemState.maxConcurrent; i++) {
        if (userQueue.length > 0) {
            addNextUserFromQueue();
        }
    }
    
    // Process immediately
    processNextBatch();
    
    // Set up interval for continuous processing
    processingInterval = setInterval(processNextBatch, systemState.spinDelay * 1000);
}

// Pause processing
function pauseProcessing() {
    systemState.isPaused = true;
    if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
    }
    debugLog('system', 'PAUSE', '⏸️ Processing paused');
}

// Update settings (store as pending)
function updateSettings(maxConcurrent, spinDelay, minFundsThreshold) {
    global.pendingMaxConcurrent = maxConcurrent;
    global.pendingSpinDelay = spinDelay;
    global.pendingMinFunds = minFundsThreshold;
    debugLog('system', 'SETTINGS', `⚙️ Settings updated: Max=${maxConcurrent}, Delay=${spinDelay}s, Min Funds=${minFundsThreshold}`);
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
    // Reset all user stats but keep tokens
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
    
    // Rebuild queue
    userQueue = Object.keys(userData).sort(() => Math.random() - 0.5);
    systemState.completedUsers = 0;
    systemState.isPaused = false;
    
    debugLog('system', 'RESET', `🔄 System reset. ${userQueue.length} users in queue.`);
    res.json({ success: true, message: 'System reset' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    initializeApp();
});