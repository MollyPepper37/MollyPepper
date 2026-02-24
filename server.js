const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Simple logging
const debugLogs = [];
let systemState = {
    isPaused: false,
    maxConcurrent: 5,
    spinDelay: 7,
    minFundsThreshold: 10000,
    activeUsers: 0,
    completedUsers: 0,
    totalUsers: 0
};

let processingInterval = null;

function log(userId, message, important = true) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message };
    
    // Always show in console
    console.log(`[${timestamp}] ${userId}: ${message}`);
    
    // Only store important events for dashboard
    if (important) {
        debugLogs.unshift(logEntry);
        if (debugLogs.length > 200) debugLogs.pop();
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
                totalSpinsRun: 0,
                totalPacksOpened: 0,
                initialFunds: 0,
                currentFunds: 0,
                spinsThisRound: 0,
                spinsDoneThisRound: 0,
                lastError: null,
                status: 'idle',
                achievementsClaimed: 0,
                startTime: null,
                endTime: null
            };
        }
        
        systemState.totalUsers = users.length;
        log('system', `Loaded ${users.length} users`);
    } catch (error) {
        console.error('Error loading user config:', error);
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
            status: error.response?.status
        };
    }
}

// Refresh token
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) return false;
    
    log(userId, 'Refreshing token...', false);
    
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
        log(userId, 'Token refreshed');
        return true;
    } else {
        user.isActive = false;
        user.status = 'error';
        user.lastError = 'Token refresh failed';
        log(userId, 'Token refresh failed');
        return false;
    }
}

// Claim achievements
async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) return 0;

    let totalClaimed = 0;
    const userAchievementsUrl = `${CONFIG.BASE_URL_ACH}/${user.userId}/user`;
    const headers = { 'x-user-jwt': user.jwtToken };

    log(userId, 'Checking achievements...', false);

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

        log(userId, `Found ${validIDs.length} achievements to claim`);

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
            log(userId, `Claimed ${totalClaimed} achievements`);
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

    const fundsUrl = `${CONFIG.BASE_URL_MONEY}`;
    const headers = { 'x-user-jwt': user.jwtToken };

    log(userId, 'Checking funds...', false);

    const result = await makeAPIRequest(fundsUrl, 'GET', headers, null, userId);
    
    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        user.currentFunds = silvercoins;
        
        if (user.initialFunds === 0) {
            user.initialFunds = silvercoins;
            log(userId, `Initial funds: ${silcoins.toLocaleString()}`);
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

// Buy and execute spin (together)
async function buyAndSpin(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    log(userId, 'Buying spin...', false);

    // Buy spin
    const buyResult = await makeAPIRequest(
        CONFIG.BASE_URL_BUY_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { categoryId: 1, amount: 1 },
        userId
    );

    if (!buyResult.success) {
        if (buyResult.status === 401) {
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) return await buyAndSpin(userId);
        }
        log(userId, 'Spin purchase failed', true);
        return false;
    }

    log(userId, 'Executing spin...', false);

    // Execute spin
    const spinResult = await makeAPIRequest(
        CONFIG.BASE_URL_SPIN,
        'POST',
        { 'x-user-jwt': user.jwtToken },
        { spinnerId: 6799 },
        userId
    );

    if (!spinResult.success) {
        if (spinResult.status === 401) {
            const refreshSuccess = await refreshToken(userId);
            if (refreshSuccess) return await buyAndSpin(userId);
        }
        log(userId, 'Spin failed', true);
        return false;
    }

    const spinData = spinResult.data.data;
    const resultId = spinData.id;
    user.totalSpinsRun++;
    user.spinsDoneThisRound++;

    // Prize mapping
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

    const prizeName = prizeMap[resultId] || `ID ${resultId}`;
    log(userId, `Spin result: ${prizeName}`, false);

    // Check for pack
    if ([11782, 11750, 11914, 11848].includes(resultId) && spinData.packs?.length > 0) {
        const packId = spinData.packs[0].id;
        log(userId, `Got pack from spin!`, true);
        
        // Open pack
        const packResult = await makeAPIRequest(
            CONFIG.BASE_URL_OPENPACK,
            'POST',
            { 'x-user-jwt': user.jwtToken },
            { packId },
            userId
        );

        if (packResult.success) {
            user.totalPacksOpened++;
            log(userId, `Pack opened: ${packId}`, true);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    return true;
}

// Process one user for their turn
async function processUserTurn(userId) {
    const user = userData[userId];
    if (!user || !user.isActive || systemState.isPaused) return;

    try {
        user.status = 'spinning';
        systemState.activeUsers++;

        // Buy and spin
        const success = await buyAndSpin(userId);
        
        if (success) {
            user.spinsThisRound--;
            
            // If round complete, check achievements and funds
            if (user.spinsThisRound <= 0) {
                log(userId, 'Round complete, claiming achievements...', true);
                await claimAchievements(userId);
                
                // Check funds for next round
                const funds = await checkFunds(userId);
                if (funds >= systemState.minFundsThreshold) {
                    user.spinsThisRound = Math.floor(funds / 1000);
                    user.spinsDoneThisRound = 0;
                    log(userId, `New round: ${user.spinsThisRound} spins`, true);
                } else {
                    user.status = 'completed';
                    user.endTime = new Date().toISOString();
                    systemState.completedUsers++;
                    log(userId, `User completed (final funds: ${funds?.toLocaleString() || 0})`, true);
                    
                    // Add next user from queue
                    addNextUser();
                }
            }
        } else {
            user.lastError = 'Spin failed';
            user.status = 'error';
        }

        systemState.activeUsers--;

    } catch (error) {
        systemState.activeUsers--;
        log(userId, `Error: ${error.message}`, true);
    }
}

// Get random active user
function getRandomActiveUser() {
    const activeUsers = Object.keys(userData).filter(id => {
        const user = userData[id];
        return user.isActive && 
               user.status === 'idle' && 
               user.spinsThisRound > 0;
    });
    
    if (activeUsers.length === 0) return null;
    
    const randomIndex = Math.floor(Math.random() * activeUsers.length);
    return activeUsers[randomIndex];
}

// Add next user from queue
async function addNextUser() {
    if (userQueue.length === 0) return false;
    
    const nextUserId = userQueue.shift();
    const user = userData[nextUserId];
    
    if (!user || !user.isActive) return false;
    
    // Initialize user
    const funds = await checkFunds(nextUserId);
    if (funds >= systemState.minFundsThreshold) {
        user.spinsThisRound = Math.floor(funds / 1000);
        user.spinsDoneThisRound = 0;
        user.status = 'idle';
        user.startTime = new Date().toISOString();
        log(nextUserId, `Added to active pool - ${user.spinsThisRound} spins`, true);
        return true;
    } else {
        user.status = 'completed';
        systemState.completedUsers++;
        return false;
    }
}

// Main loop
async function processingLoop() {
    if (systemState.isPaused) return;

    const spinningCount = Object.values(userData).filter(u => u.status === 'spinning').length;
    
    // Fill empty slots
    if (spinningCount < systemState.maxConcurrent) {
        const slotsToFill = systemState.maxConcurrent - spinningCount;
        
        for (let i = 0; i < slotsToFill; i++) {
            const nextUser = getRandomActiveUser();
            if (nextUser) {
                processUserTurn(nextUser);
            } else if (userQueue.length > 0) {
                await addNextUser();
            }
        }
    }
}

// Initialize app
async function initializeApp() {
    try {
        log('system', 'Initializing application...');
        await loadUserConfig();
        
        log('system', 'Refreshing tokens...');
        const userIds = Object.keys(userData);
        
        for (const userId of userIds) {
            await refreshToken(userId);
            await checkFunds(userId);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Random queue
        userQueue = userIds.sort(() => Math.random() - 0.5);
        log('system', `Ready. ${userIds.length} users in queue.`);
        
    } catch (error) {
        console.error('Initialization failed:', error);
    }
}

// Start processing
function startProcessing() {
    if (processingInterval) {
        clearInterval(processingInterval);
    }
    
    // Update settings
    if (global.pendingMaxConcurrent) {
        systemState.maxConcurrent = parseInt(global.pendingMaxConcurrent);
        systemState.spinDelay = parseFloat(global.pendingSpinDelay);
        systemState.minFundsThreshold = parseInt(global.pendingMinFunds);
    }
    
    systemState.isPaused = false;
    log('system', `Started (Max: ${systemState.maxConcurrent}, Delay: ${systemState.spinDelay}s, Min: ${systemState.minFundsThreshold})`);
    
    // Add initial users
    for (let i = 0; i < systemState.maxConcurrent; i++) {
        if (userQueue.length > 0) {
            addNextUser();
        }
    }
    
    // Run loop
    processingLoop();
    processingInterval = setInterval(processingLoop, systemState.spinDelay * 1000);
}

// Pause processing
function pauseProcessing() {
    systemState.isPaused = true;
    if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
    }
    log('system', 'Paused');
}

// Update settings
function updateSettings(maxConcurrent, spinDelay, minFundsThreshold) {
    global.pendingMaxConcurrent = maxConcurrent;
    global.pendingSpinDelay = spinDelay;
    global.pendingMinFunds = minFundsThreshold;
    log('system', `Settings updated: ${maxConcurrent}/${spinDelay}s/${minFundsThreshold}`);
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
            spinsThisRound: u.spinsThisRound || 0,
            spinsDoneThisRound: u.spinsDoneThisRound || 0,
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
    res.json({ success: true });
});

app.post('/api/pause', (req, res) => {
    pauseProcessing();
    res.json({ success: true });
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
        user.spinsThisRound = 0;
        user.spinsDoneThisRound = 0;
    }
    
    userQueue = Object.keys(userData).sort(() => Math.random() - 0.5);
    systemState.completedUsers = 0;
    systemState.isPaused = false;
    
    log('system', `Reset. ${userQueue.length} users in queue.`);
    res.json({ success: true });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    initializeApp();
});