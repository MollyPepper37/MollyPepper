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

function debugLog(userId, action, url, method, data = null, response = null, error = null) {
    // Only log important events, not every spin
    const importantActions = ['REFRESH', 'CLAIM', 'FUNDS', 'PACK', 'ERROR', 'START', 'PAUSE', 'COMPLETE'];
    if (!importantActions.includes(action) && action !== 'REQUEST' && action !== 'SUCCESS') {
        return; // Skip logging for regular spin requests/results
    }
    
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId,
        message: action === 'ERROR' ? `❌ ${error?.message || 'Error'}` :
                 action === 'REFRESH' ? '🔄 Token refresh' :
                 action === 'CLAIM' ? `🎯 Claimed achievements` :
                 action === 'FUNDS' ? `💰 Funds check` :
                 action === 'PACK' ? `📦 Pack opened` :
                 action === 'START' ? '▶️ Started' :
                 action === 'PAUSE' ? '⏸️ Paused' :
                 action === 'COMPLETE' ? '✅ Completed' : ''
    };

    if (debugEntry.message) {
        debugLogs.unshift(debugEntry);
        if (debugLogs.length > 200) debugLogs.pop();
        console.log(`[${debugEntry.timestamp}] ${userId}: ${debugEntry.message}`);
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
let activeUsers = []; // Array of users currently being processed
let pendingQueue = [];

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
                isProcessing: false,
                spinCount: 0,
                packsOpened: 0,
                totalSpinsRun: 0,
                totalPacksOpened: 0,
                initialFunds: 0, // Store initial funds
                currentFunds: 0,
                lastFunds: 0,
                maxSpinsThisRound: 0,
                spinsCompletedThisRound: 0,
                lastError: null,
                status: 'idle',
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
    console.log(`[${userId}] 🔄 Refreshing token...`);

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
        debugLog(userId, 'REFRESH');
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = `Token refresh failed`;
        debugLog(userId, 'ERROR', null, null, null, null, { message: 'Token refresh failed' });
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
            debugLog(userId, 'CLAIM');
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
        }
        
        debugLog(userId, 'FUNDS');
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
        debugLog(userId, 'PACK');
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
    user.spinCount++;
    user.totalSpinsRun++;
    user.spinsCompletedThisRound++;

    // Check if we got a pack
    if ([11782, 11750, 11914, 11848].includes(resultId) && spinData.packs && spinData.packs.length > 0) {
        const packId = spinData.packs[0].id;
        await openPack(userId, packId);
    }

    return resultId;
}

// Process a single spin action for a user
async function processSingleSpin(userId) {
    const user = userData[userId];
    if (!user || !user.isActive || systemState.isPaused) return false;

    try {
        user.status = 'spinning';
        
        // Buy spin
        const buySuccess = await buySpin(userId);
        if (!buySuccess) {
            user.lastError = 'Failed to buy spin';
            return false;
        }
        
        // Delay between buy and execute
        await new Promise(resolve => setTimeout(resolve, systemState.spinDelay * 1000));
        
        // Execute spin
        const spinResult = await executeSpin(userId);
        if (spinResult === null) {
            user.lastError = 'Failed to execute spin';
            return false;
        }
        
        return true;
    } catch (error) {
        return false;
    }
}

// Check if user should continue
async function shouldUserContinue(userId) {
    const user = userData[userId];
    if (!user) return false;
    
    // Check funds
    const funds = await checkFunds(userId);
    if (funds === null) return false;
    
    return funds >= systemState.minFundsThreshold;
}

// Process a single user's turn
async function processUserTurn(userId) {
    const user = userData[userId];
    if (!user || !user.isActive || systemState.isPaused) return;

    try {
        // Do one spin
        const spinSuccess = await processSingleSpin(userId);
        
        if (!spinSuccess) {
            // If spin failed, mark as error
            user.status = 'error';
            debugLog(userId, 'ERROR', null, null, null, null, { message: 'Spin failed' });
        }
        
    } catch (error) {
        console.error(`Error processing user ${userId}:`, error);
    }
}

// Select next random user from active pool
function selectNextRandomUser() {
    const availableUsers = Object.keys(userData).filter(id => {
        const user = userData[id];
        return user.isActive && 
               user.status !== 'completed' && 
               user.status !== 'error' &&
               !systemState.isPaused;
    });
    
    if (availableUsers.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * availableUsers.length);
    return availableUsers[randomIndex];
}

// Main processing loop
async function processingLoop() {
    if (systemState.isPaused) {
        setTimeout(processingLoop, 1000);
        return;
    }
    
    // Check if we have active users
    const activeCount = Object.values(userData).filter(u => u.status === 'spinning' || u.status === 'checking').length;
    
    if (activeCount < systemState.maxConcurrent) {
        const nextUser = selectNextRandomUser();
        
        if (nextUser) {
            // Check if this user should continue
            const shouldContinue = await shouldUserContinue(nextUser);
            
            if (!shouldContinue) {
                userData[nextUser].status = 'completed';
                userData[nextUser].endTime = new Date().toISOString();
                systemState.completedUsers++;
                debugLog(nextUser, 'COMPLETE');
                
                // Check funds one last time for display
                await checkFunds(nextUser);
            } else {
                // Process this user's turn
                await processUserTurn(nextUser);
            }
        }
    }
    
    // Schedule next iteration with delay
    setTimeout(processingLoop, systemState.spinDelay * 1000);
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
            // Initial funds check
            await checkFunds(userId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        console.log('✅ All users initialized. Waiting for start command...');
        debugLog('system', 'START', null, null, null, null, null, 'System ready. Click Start to begin processing.');
        
    } catch (error) {
        console.error('❌ Initialization failed:', error);
    }
}

// Start processing
function startProcessing() {
    if (systemState.isPaused) {
        systemState.isPaused = false;
        debugLog('system', 'START', null, null, null, null, null, '▶️ Resuming processing');
    } else {
        debugLog('system', 'START', null, null, null, null, null, '▶️ Starting processing');
    }
    
    // Start the processing loop if not already running
    processingLoop();
}

// Pause processing
function pauseProcessing() {
    systemState.isPaused = true;
    debugLog('system', 'PAUSE', null, null, null, null, null, '⏸️ Processing paused');
}

// Update settings
function updateSettings(maxConcurrent, spinDelay, minFundsThreshold) {
    systemState.maxConcurrent = parseInt(maxConcurrent) || 5;
    systemState.spinDelay = parseFloat(spinDelay) || 7;
    systemState.minFundsThreshold = parseInt(minFundsThreshold) || 10000;
    debugLog('system', 'SETTINGS', null, null, null, null, null, 
        `⚙️ Settings: Max=${systemState.maxConcurrent}, Delay=${systemState.spinDelay}s, Min Funds=${systemState.minFundsThreshold}`);
}

// Safe user data for frontend
function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        out[id] = {
            userId: u.userId,
            name: u.name || id, // Keep name field
            jwtToken: u.jwtToken || 'No token', // Full JWT for copying
            isActive: u.isActive,
            isProcessing: u.isProcessing,
            spinCount: u.spinCount,
            packsOpened: u.packsOpened,
            totalSpinsRun: u.totalSpinsRun || 0,
            totalPacksOpened: u.totalPacksOpened || 0,
            initialFunds: u.initialFunds || 0,
            currentFunds: u.currentFunds || 0,
            maxSpinsThisRound: u.maxSpinsThisRound,
            spinsCompletedThisRound: u.spinsCompletedThisRound,
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
    const { maxConcurrent, spinDelay, minFundsThreshold } = req.body;
    updateSettings(maxConcurrent, spinDelay, minFundsThreshold);
    res.json({ success: true, message: 'Settings updated' });
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
        user.spinCount = 0;
        user.packsOpened = 0;
        user.totalSpinsRun = 0;
        user.totalPacksOpened = 0;
        user.initialFunds = user.currentFunds; // Set initial to current
        user.achievementsClaimed = 0;
        user.lastError = null;
        user.status = 'idle';
        user.startTime = null;
        user.endTime = null;
    }
    
    systemState.completedUsers = 0;
    systemState.isPaused = false;
    
    debugLog('system', 'RESET', null, null, null, null, null, '🔄 System reset');
    res.json({ success: true, message: 'System reset' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    initializeApp();
});