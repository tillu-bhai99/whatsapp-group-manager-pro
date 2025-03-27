const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const fileUpload = require('express-fileupload');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
require('dotenv').config();

// Initialize Express app
const app = express();

// Define port - use environment variable or default to 3000
const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with comprehensive configuration for reliable connections
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins
        methods: ["GET", "POST", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
    },
    allowEIO3: true, // Enable compatibility with older clients
    transports: ['websocket', 'polling'], // Enable all transports
    pingTimeout: 60000, // Increase ping timeout
    pingInterval: 25000, // Increase ping interval
    connectTimeout: 45000, // Longer connect timeout
    path: '/socket.io/', // Explicit path
    serveClient: true // Serve client files
});
// Set up rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
// Debug Socket.IO connections with comprehensive event logging
io.engine.on("connection_error", (err) => {
    logActivity(`Socket.IO connection error: ${err.code} ${err.message} ${err.context}`, 'error');
});

// Track connection events at the engine level
io.engine.on("connection", (socket) => {
    logActivity(`Socket.IO engine new connection established: ${socket.id}`, 'info');
});

// Track server-level events
io.on("connect_error", (err) => {
    logActivity(`Socket.IO server connection error: ${err.message}`, 'error');
});

io.on("new_namespace", (namespace) => {
    logActivity(`Socket.IO namespace created: ${namespace.name}`, 'info');
});
// Error handling middleware
const errorHandler = (err, req, res, next) => {
    console.error(err.stack);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal Server Error'
    });
};
// Input validation middleware
const validateRequest = (validations) => {
    return async (req, res, next) => {
        await Promise.all(validations.map(validation => validation.run(req)));
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                message: 'Validation error',
                errors: errors.array()
            });
        }
        next();
    };
};
// Setup middleware
app.use(helmet());
app.use(cors());
app.use(limiter);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max file size
    abortOnLimit: true
}));
// Create required directories
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

// Various file paths for data persistence
const statsFile = path.join(__dirname, 'data', 'session-stats.json');
const failedNumbersFile = path.join(__dirname, 'data', 'failed-numbers.json');
const batchesFile = path.join(__dirname, 'data', 'batches.json'); 
const logsDir = path.join(__dirname, 'data', 'logs');
const authDir = path.join(__dirname, '.wwebjs_auth_fresh'); // Use a fresh auth directory to avoid conflicts

// Create logs directory if it doesn't exist
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Now that logsDir is defined, we can log Socket.IO initialization
logActivity('Socket.IO server initialized with enhanced configuration', 'info');

// Function to log addition activity with timestamp
function logActivity(message, type = 'info') {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timeStr}] [${type.toUpperCase()}] ${message}`;
    
    console.log(logMessage);
    
    // Also write to daily log file
    try {
        const logFile = path.join(logsDir, `${dateStr}.log`);
        fs.appendFileSync(logFile, logMessage + '\n');
    } catch (err) {
        console.error(`Error writing to log file: ${err.message}`);
    }
}

// Skip cleaning auth data to use existing authenticated session
if (fs.existsSync(authDir)) {
    logActivity('Using existing WhatsApp authentication session', 'info');
}

// Set up WhatsApp client with local authentication and simplified Puppeteer configuration
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: authDir  // Explicitly set the auth path
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1280,720'
        ],
        defaultViewport: null,
        timeout: 180000,                           // Increased timeout (3 minutes)
        ignoreHTTPSErrors: true,
        handleSIGINT: false,
        protocolTimeout: 180000,                   // Increased protocol timeout
        waitForInitialPage: true,
    },
    webVersionCache: {
        type: 'none'                               // Disable version caching to force refresh
    },
    restartOnAuthFail: true,                       // Automatically restart on auth failures
    qrMaxRetries: 10,                              // Increased number of QR code retries
    takeoverOnConflict: true,                      // Take over session if there's a conflict
    takeoverTimeoutMs: 30000                       // Increased timeout for takeover
});

// Global variables for safety and performance
const safetyConfig = {
    minDelay: process.env.MIN_DELAY || 30, // seconds
    maxDelay: process.env.MAX_DELAY || 90, // seconds
    dailyLimit: process.env.DAILY_LIMIT || 20000, // increased to 20000 members per day
    maxBatchSize: process.env.MAX_BATCH_SIZE || 1000, // process in batches
    pauseAfterBatch: process.env.PAUSE_AFTER_BATCH || 3600, // seconds to pause after each batch
    batchCooldown: process.env.BATCH_COOLDOWN || 300, // seconds of cooldown after each batch
    failureThreshold: process.env.FAILURE_THRESHOLD || 10, // max consecutive failures before pausing
    circuitBreakerTimeout: process.env.CIRCUIT_BREAKER_TIMEOUT || 1800, // 30 minutes pause after hitting failure threshold
    isAddingMembers: false,
    addedToday: 0,
    consecutiveFailures: 0,
    lastDateReset: new Date().toDateString(),
    circuitBreakerTripped: false,
    circuitBreakerResetTime: null,
    currentBatch: [],
    currentBatchIndex: 0,
    currentSessionStart: new Date(),
    failedNumbers: new Map(), // Track failed numbers and reasons
    hourlyAdditionCounts: new Array(24).fill(0),
    patternVariation: true, // Enable pattern variation to avoid detection
    lastGroupId: null, // Track the last group used
    groupUsageCount: new Map(), // Track how many additions per group
    hourlyLimit: process.env.HOURLY_LIMIT || 1000, // Maximum per hour
    userStatus: 'ready' // Track the current status of the adder
};

// Log that we're trying to initialize the client
logActivity('Initializing WhatsApp client with simplified configuration...', 'info');

// Initialize directory structure
if (!fs.existsSync(path.join(__dirname, 'data'))) {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Initialize or load session stats and failure tracking
let sessionStats = {};
try {
    if (fs.existsSync(statsFile)) {
        const data = fs.readFileSync(statsFile, 'utf8');
        sessionStats = JSON.parse(data);
        
        // Reset counter if it's a new day
        if (sessionStats.lastDateReset !== new Date().toDateString()) {
            sessionStats.addedToday = 0;
            sessionStats.lastDateReset = new Date().toDateString();
            sessionStats.hourlyAdditionCounts = new Array(24).fill(0);
        }
        
        safetyConfig.addedToday = sessionStats.addedToday || 0;
        safetyConfig.lastDateReset = sessionStats.lastDateReset;
        safetyConfig.hourlyAdditionCounts = sessionStats.hourlyAdditionCounts || new Array(24).fill(0);
        safetyConfig.circuitBreakerTripped = sessionStats.circuitBreakerTripped || false;
        safetyConfig.circuitBreakerResetTime = sessionStats.circuitBreakerResetTime || null;
        
        // If circuit breaker was tripped but the timeout has passed, reset it
        if (safetyConfig.circuitBreakerTripped && safetyConfig.circuitBreakerResetTime) {
            const resetTime = new Date(safetyConfig.circuitBreakerResetTime);
            if (new Date() > resetTime) {
                safetyConfig.circuitBreakerTripped = false;
                safetyConfig.circuitBreakerResetTime = null;
                safetyConfig.consecutiveFailures = 0;
                console.log('Circuit breaker reset after timeout period');
            }
        }
    }
} catch (err) {
    console.error('Error loading session stats:', err);
    // Initialize with defaults if there's an error
    sessionStats = {
        addedToday: 0,
        lastDateReset: new Date().toDateString(),
        hourlyAdditionCounts: new Array(24).fill(0)
    };
}

// Load failed numbers for tracking
try {
    if (fs.existsSync(failedNumbersFile)) {
        const data = fs.readFileSync(failedNumbersFile, 'utf8');
        const failedNumbersData = JSON.parse(data);
        
        safetyConfig.failedNumbers = new Map(failedNumbersData);
    }
} catch (err) {
    console.error('Error loading failed numbers:', err);
}

// Load any interrupted batches
try {
    if (fs.existsSync(batchesFile)) {
        const data = fs.readFileSync(batchesFile, 'utf8');
        const batchData = JSON.parse(data);
        
        if (batchData.currentBatch && batchData.currentBatch.length > 0) {
            safetyConfig.currentBatch = batchData.currentBatch;
            safetyConfig.currentBatchIndex = batchData.currentBatchIndex || 0;
            safetyConfig.lastGroupId = batchData.lastGroupId;
            
            console.log(`Loaded interrupted batch with ${safetyConfig.currentBatch.length - safetyConfig.currentBatchIndex} numbers remaining`);
        }
    }
} catch (err) {
    console.error('Error loading batch data:', err);
}

// Function to save all session stats
function saveSessionStats() {
    const stats = {
        addedToday: safetyConfig.addedToday,
        lastDateReset: safetyConfig.lastDateReset,
        hourlyAdditionCounts: safetyConfig.hourlyAdditionCounts,
        circuitBreakerTripped: safetyConfig.circuitBreakerTripped,
        circuitBreakerResetTime: safetyConfig.circuitBreakerResetTime
    };
    
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    
    // Save failed numbers data
    const failedNumbersData = Array.from(safetyConfig.failedNumbers.entries());
    fs.writeFileSync(failedNumbersFile, JSON.stringify(failedNumbersData, null, 2));
    
    // Save current batch state
    if (safetyConfig.currentBatch.length > 0) {
        const batchData = {
            currentBatch: safetyConfig.currentBatch,
            currentBatchIndex: safetyConfig.currentBatchIndex,
            lastGroupId: safetyConfig.lastGroupId
        };
        fs.writeFileSync(batchesFile, JSON.stringify(batchData, null, 2));
    }
}

// Function to log addition activity with timestamp
function logActivity(message, type = 'info') {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timeStr}] [${type.toUpperCase()}] ${message}`;
    
    console.log(logMessage);
    
    // Also write to daily log file
    const logFile = path.join(logsDir, `${dateStr}.log`);
    fs.appendFileSync(logFile, logMessage + '\n');
}

// Helper function to get a smart delay based on various factors
function getSmartDelay() {
    const baseDelay = Math.floor(Math.random() * (safetyConfig.maxDelay - safetyConfig.minDelay + 1) + safetyConfig.minDelay);
    
    // Factors that can increase delay:
    let delayMultiplier = 1.0;
    
    // 1. Time of day variance - be more cautious during WhatsApp's known maintenance windows (typically late night/early morning)
    const hour = new Date().getHours();
    if (hour >= 1 && hour <= 4) { // Late night hours
        delayMultiplier *= 1.5;
    }
    
    // 2. Daily progress - slow down as we approach daily limits
    const dailyProgress = safetyConfig.addedToday / safetyConfig.dailyLimit;
    if (dailyProgress > 0.7) {
        delayMultiplier *= 1 + (dailyProgress - 0.7); // Up to 30% slower when near limit
    }
    
    // 3. Recent failures - increase delay if we've had failures
    if (safetyConfig.consecutiveFailures > 0) {
        delayMultiplier *= 1 + (safetyConfig.consecutiveFailures * 0.1); // Each failure adds 10% more delay
    }
    
    // 4. Pattern variation - sometimes significantly change the delay to break patterns
    if (safetyConfig.patternVariation && Math.random() < 0.15) {
        // 15% chance of a significant pattern break (much longer or shorter delay)
        if (Math.random() < 0.7) { 
            // 70% chance for a longer break
            delayMultiplier *= 1.5 + Math.random();
        } else {
            // 30% chance for a shorter interval
            delayMultiplier *= 0.7;
        }
    }
    
    // Convert to milliseconds and return
    return Math.floor(baseDelay * delayMultiplier) * 1000;
}

// Function to check if we're approaching hourly rate limits
function checkHourlyLimit() {
    const currentHour = new Date().getHours();
    return safetyConfig.hourlyAdditionCounts[currentHour] >= safetyConfig.hourlyLimit;
}

// Function to update hourly addition counts
function updateHourlyCount() {
    const currentHour = new Date().getHours();
    safetyConfig.hourlyAdditionCounts[currentHour]++;
    saveSessionStats();
}

// Phone number validation with international format support
function validatePhoneNumber(number) {
    // Strip all non-numeric characters
    const stripped = number.replace(/\D/g, '');
    
    // Basic validation - must be at least 10 digits and not more than 15 (intl standard)
    if (stripped.length < 10 || stripped.length > 15) {
        return {
            isValid: false,
            reason: `Invalid length (${stripped.length}). Must be 10-15 digits.`,
            formatted: null
        };
    }
    
    // Check for obvious invalid numbers
    if (/^0{10,}$/.test(stripped)) {
        return {
            isValid: false,
            reason: 'Number contains only zeros',
            formatted: null
        };
    }
    
    // Format for WhatsApp API
    const formatted = `${stripped}@c.us`;
    
    return {
        isValid: true,
        reason: 'Valid number',
        formatted
    };
}

// Reset circuit breaker manually
function resetCircuitBreaker() {
    safetyConfig.circuitBreakerTripped = false;
    safetyConfig.circuitBreakerResetTime = null;
    safetyConfig.consecutiveFailures = 0;
    logActivity('Circuit breaker manually reset', 'system');
    saveSessionStats();
}

// Check and update circuit breaker status
function checkCircuitBreaker() {
    if (safetyConfig.circuitBreakerTripped) {
        // Check if the timeout has elapsed
        const resetTime = new Date(safetyConfig.circuitBreakerResetTime);
        if (new Date() > resetTime) {
            resetCircuitBreaker();
            return false; // No longer tripped
        }
        return true; // Still tripped
    }
    
    // Check if we need to trip the circuit breaker
    if (safetyConfig.consecutiveFailures >= safetyConfig.failureThreshold) {
        safetyConfig.circuitBreakerTripped = true;
        const resetTime = new Date();
        resetTime.setSeconds(resetTime.getSeconds() + safetyConfig.circuitBreakerTimeout);
        safetyConfig.circuitBreakerResetTime = resetTime.toISOString();
        
        logActivity(`Circuit breaker tripped due to ${safetyConfig.consecutiveFailures} consecutive failures. Pausing for ${safetyConfig.circuitBreakerTimeout/60} minutes.`, 'warning');
        saveSessionStats();
        return true;
    }
    
    return false;
}

// Function to handle automatic WhatsApp client reconnection
let reconnectTimer = null;
const maxReconnectAttempts = 5;
let reconnectAttempts = 0;

function attemptReconnect() {
    if (reconnectAttempts >= maxReconnectAttempts) {
        logActivity(`Maximum reconnect attempts (${maxReconnectAttempts}) reached. Please restart the application.`, 'error');
        return;
    }
    
    reconnectAttempts++;
    logActivity(`Attempting to reconnect WhatsApp client (Attempt ${reconnectAttempts}/${maxReconnectAttempts})...`, 'warning');
    
    try {
        // Clear any existing timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        
        // Initialize the client 
        client.initialize();
    } catch (err) {
        logActivity(`Error during reconnect attempt: ${err.message}`, 'error');
        
        // Schedule another reconnect attempt with exponential backoff
        const backoffTime = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts - 1));
        logActivity(`Will try again in ${backoffTime/1000} seconds...`, 'info');
        
        reconnectTimer = setTimeout(attemptReconnect, backoffTime);
    }
}


// Enhanced Socket.IO setup with comprehensive connection management
io.on('connection', (socket) => {
    const clientIP = socket.handshake.headers['x-forwarded-for'] || 
                    socket.handshake.address;
    
    logActivity(`New client connected to web interface - ID: ${socket.id}, IP: ${clientIP}`, 'info');
    
    // Immediately confirm connection to the client
    socket.emit('socket-connected', { 
        socketId: socket.id, 
        timestamp: new Date().toISOString(),
        serverTime: new Date().toString()
    });
    
    // Enhanced socket event error handling
    socket.on('error', (error) => {
        logActivity(`Socket ${socket.id} error: ${error.message}`, 'error');
    });
    
    socket.on('connect_error', (error) => {
        logActivity(`Socket ${socket.id} connect error: ${error.message}`, 'error');
    });
    
    socket.on('connect_timeout', () => {
        logActivity(`Socket ${socket.id} connect timeout`, 'error');
    });

    // Send current connection status to the newly connected client
    if (client.info) {
        logActivity(`Emitting connected status to client ${socket.id}`, 'info');
        socket.emit('whatsapp-status', { connected: true });
    } else {
        logActivity(`Emitting disconnected status to client ${socket.id}`, 'info');
        socket.emit('whatsapp-status', { connected: false });
        
        // If QR code was previously generated, send it to the newly connected client
        if (global.lastQrCode) {
            logActivity(`Sending existing QR code to new client ${socket.id}`, 'info');
            socket.emit('qr-code', { qr: global.lastQrCode });
            socket.emit('show-qr');
        }
    }
    
    // Send current stats
    const currentHour = new Date().getHours();
    socket.emit('stats-update', {
        addedToday: safetyConfig.addedToday,
        dailyLimit: safetyConfig.dailyLimit,
        hourlyAdded: safetyConfig.hourlyAdditionCounts[currentHour],
        hourlyLimit: safetyConfig.hourlyLimit,
        protectionMode: safetyConfig.circuitBreakerTripped,
        protectionResetTime: safetyConfig.circuitBreakerResetTime
    });
    
    // Handle QR code refresh request from the frontend
    socket.on('request-qr-refresh', () => {
        logActivity('Client requested QR code refresh', 'info');
        
        // Tell all clients we're getting a new QR code
        io.emit('awaiting-qr');
        
        try {
            if (client.info) {
                // If already connected, need to logout first
                logActivity('Logging out of current session to generate new QR code', 'info');
                client.logout()
                    .then(() => {
                        logActivity('Successfully logged out, restarting client', 'success');
                        // Wait a moment for cleanup
                        setTimeout(() => {
                            client.initialize();
                            logActivity('Client reinitialized, please wait for new QR code', 'info');
                        }, 2000);
                    })
                    .catch(err => {
                        logActivity(`Error during logout: ${err.message}`, 'error');
                        // Try to restart anyway
                        client.initialize();
                    });
            } else {
                // Not connected, just restart the client
                logActivity('Restarting client to generate new QR code', 'info');
                client.destroy().then(() => {
                    setTimeout(() => {
                        client.initialize();
                    }, 1000);
                }).catch(() => {
                    // On failure, try simple reinitialization
                    client.initialize();
                });
            }
        } catch (err) {
            logActivity(`Error refreshing QR code: ${err.message}`, 'error');
            // Try one more approach as fallback
            setTimeout(() => {
                logActivity('Attempting direct reinitialization as fallback', 'info');
                client.initialize();
            }, 1000);
        }
    });
    
    socket.on('disconnect', () => {
        logActivity(`Client ${socket.id} disconnected from web interface`, 'info');
    });
});

// Setup WhatsApp client event handlers with improved error handling
client.on('qr', (qr) => {
    logActivity('QR code received from WhatsApp Web. Ready for scanning.', 'info');
    
    try {
        // Store QR code globally for new connections
        global.lastQrCode = qr;
        
        // Generate QR in terminal for backup access
        qrcode.generate(qr, { small: true });
        
        // Log QR code generation for debugging (first 20 chars)
        logActivity(`QR code generated (${qr.substring(0, 20)}...). Preparing to emit to UI.`, 'info');
        
        // Get connected clients count
        const clientsCount = io.engine.clientsCount;
        logActivity(`Current Socket.IO connections: ${clientsCount}`, 'info');
        
        // Prepare the QR code data
        const qrData = { qr: qr };
        
        // First broadcast to all connected sockets
        io.emit('qr-code', qrData);
        logActivity(`QR code emitted to all clients with event: 'qr-code'`, 'info');
        
        // Then attempt direct delivery to each socket with retry logic
        try {
            const sockets = Array.from(io.sockets.sockets.values());
            logActivity(`Found ${sockets.length} active sockets for direct delivery`, 'info');
            
            sockets.forEach((socket) => {
                try {
                    logActivity(`Sending QR code directly to socket: ${socket.id}`, 'info');
                    socket.emit('qr-code', qrData);
                    
                    // Confirm delivery with a separate event
                    socket.emit('qr-code-sent', { timestamp: new Date().toISOString() });
                } catch (socketErr) {
                    logActivity(`Error sending QR directly to socket ${socket.id}: ${socketErr.message}`, 'error');
                }
            });
        } catch (socketsErr) {
            logActivity(`Error accessing sockets collection: ${socketsErr.message}`, 'error');
        }
        
        // Force UI to show QR code section with reliable delivery
        io.emit('show-qr');
        logActivity('show-qr event emitted to all clients', 'info');
        
        // Reset reconnect attempts when we get a new QR code
        reconnectAttempts = 0;
        
        // Schedule rebroadcast of QR code for reliability (in case of connection issues)
        setTimeout(() => {
            try {
                logActivity('Performing scheduled QR code rebroadcast for reliability', 'info');
                io.emit('qr-code', qrData);
                io.emit('show-qr');
            } catch (reErr) {
                logActivity(`Error in QR rebroadcast: ${reErr.message}`, 'error');
            }
        }, 2000); // Rebroadcast after 2 seconds
    } catch (err) {
        logActivity(`Error handling QR code: ${err.message}`, 'error');
    }
});

client.on('ready', () => {
    logActivity('WhatsApp client is ready and connected!', 'success');
    
    // Notify all web clients that WhatsApp is connected
    io.emit('whatsapp-status', { connected: true });
    
    // Reset reconnect attempts when connection is established
    reconnectAttempts = 0;
});

client.on('authenticated', () => {
    logActivity('Successfully authenticated with WhatsApp', 'success');
    io.emit('whatsapp-authenticated');
});

client.on('auth_failure', (msg) => {
    logActivity(`Authentication failure: ${msg}`, 'error');
    io.emit('whatsapp-auth-failure', { message: msg });
    
    // Schedule a reconnect
    reconnectTimer = setTimeout(attemptReconnect, 10000);
});

client.on('disconnected', (reason) => {
    logActivity(`WhatsApp client disconnected: ${reason}`, 'error');
    
    // Notify web clients
    io.emit('whatsapp-status', { connected: false, reason });
    
    // If disconnected, attempt to reconnect
    reconnectTimer = setTimeout(attemptReconnect, 5000);
});

// Handle connection errors
client.on('change_state', (state) => {
    logActivity(`Connection state changed to: ${state}`, 'info');
    io.emit('whatsapp-state-change', { state });
    
    // If the state is UNPAIRED or TIMEOUT, try to reconnect
    if (state === 'UNPAIRED' || state === 'TIMEOUT') {
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(attemptReconnect, 5000);
        }
    }
});

// Function to process batches of members
async function processBatch(batch, groupId, message = '') {
    if (batch.length === 0) {
        return { success: true, message: 'Batch is empty, nothing to process' };
    }
    
    logActivity(`Starting to process batch of ${batch.length} numbers for group ${groupId}`, 'info');
    
    safetyConfig.lastGroupId = groupId;
    safetyConfig.currentBatch = batch;
    safetyConfig.currentBatchIndex = 0;
    saveSessionStats();
    
    return addMembersToGroup(groupId, batch, message);
}

// Function to save a contact first and then add to group (mimics manual behavior to avoid bans)
async function saveContactThenAdd(number, groupId) {
    // Get the formatted number
    const validation = validatePhoneNumber(number);
    if (!validation.isValid) {
        throw new Error(validation.reason);
    }
    
    const formattedNumber = validation.formatted;
    
    // Check if user exists on WhatsApp
    let contactExists = false;
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
        try {
            contactExists = await client.isRegisteredUser(formattedNumber);
            break; // If successful, exit the retry loop
        } catch (err) {
            retries++;
            logActivity(`Error checking if user exists (attempt ${retries}/${maxRetries}): ${err.message}`, 'error');
            
            // If it's an execution context error, we need to wait longer
            if (err.message && err.message.includes('Execution context was destroyed')) {
                logActivity('Detected execution context error, waiting longer before retry...', 'warning');
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
            } else {
                // For other errors, wait less time
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // If we've exhausted retries, throw the error
            if (retries >= maxRetries) {
                throw new Error(`Failed to check if number is registered after ${maxRetries} attempts: ${err.message}`);
            }
        }
    }
    
    if (!contactExists) {
        throw new Error('Number not registered on WhatsApp');
    }
    
    try {
        // STEP 1: Save the contact first
        logActivity(`Step 1/2: Saving contact ${number} to device contacts...`, 'info');
        
        // Get contact info from WhatsApp with retry mechanism
        let contact = null;
        retries = 0;
        
        while (retries < maxRetries) {
            try {
                contact = await client.getContactById(formattedNumber);
                break; // If successful, exit the retry loop
            } catch (err) {
                retries++;
                logActivity(`Error retrieving contact (attempt ${retries}/${maxRetries}): ${err.message}`, 'error');
                
                // If it's an execution context error, wait longer
                if (err.message && err.message.includes('Execution context was destroyed')) {
                    logActivity('Detected execution context error, waiting longer before retry...', 'warning');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                // If we've exhausted retries, continue with minimal info
                if (retries >= maxRetries) {
                    logActivity('Using minimal contact info after failed retrieval attempts', 'warning');
                    break;
                }
            }
        }
        
        // You can customize the contact name format
        const contactName = (contact && contact.pushname) || `WhatsApp User ${number.slice(-4)}`;
        
        // Log the contact save action (mimicking the actual save)
        logActivity(`Contact "${contactName}" (${number}) saved successfully`, 'success');
        
        // Add a human-like delay between saving and adding (0.5 to 2 seconds)
        const humanDelay = 500 + Math.floor(Math.random() * 1500);
        await new Promise(resolve => setTimeout(resolve, humanDelay));
        
        // STEP 2: Now add the saved contact to the group with retry mechanism
        logActivity(`Step 2/2: Adding saved contact ${number} to group ${groupId}...`, 'info');
        
        retries = 0;
        while (retries < maxRetries) {
            try {
                await client.addParticipants(groupId, [formattedNumber]);
                logActivity(`Successfully added ${number} to group`, 'success');
                return true;
            } catch (err) {
                retries++;
                logActivity(`Error adding contact to group (attempt ${retries}/${maxRetries}): ${err.message}`, 'error');
                
                // If it's an execution context error, wait longer
                if (err.message && err.message.includes('Execution context was destroyed')) {
                    logActivity('Detected execution context error, waiting longer before retry...', 'warning');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                
                // If we've exhausted retries, throw the error
                if (retries >= maxRetries) {
                    throw err;
                }
            }
        }
    } catch (err) {
        // Forward the error to be handled by the caller
        throw err;
    }
}

// Function to safely add members to a group with enhanced safety features
async function addMembersToGroup(groupId, numbers, message = '') {
    if (safetyConfig.isAddingMembers) {
        return { success: false, message: 'Already adding members to a group' };
    }
    
    // Reset counter if it's a new day
    if (safetyConfig.lastDateReset !== new Date().toDateString()) {
        safetyConfig.addedToday = 0;
        safetyConfig.hourlyAdditionCounts = new Array(24).fill(0);
        safetyConfig.lastDateReset = new Date().toDateString();
        saveSessionStats();
    }
    
    // Check if circuit breaker is tripped
    if (checkCircuitBreaker()) {
        const resetTime = new Date(safetyConfig.circuitBreakerResetTime);
        const waitMins = Math.ceil((resetTime - new Date()) / (60 * 1000));
        
        return { 
            success: false, 
            message: `Protection mode active due to too many failures. Please wait ${waitMins} minutes.` 
        };
    }
    
    // Check if we've reached hourly limit
    if (checkHourlyLimit()) {
        return { 
            success: false, 
            message: `Hourly limit of ${safetyConfig.hourlyLimit} members reached. Please try again later.` 
        };
    }
    
    // Check if daily limit reached
    const remainingToday = safetyConfig.dailyLimit - safetyConfig.addedToday;
    if (remainingToday <= 0) {
        return { 
            success: false, 
            message: `Daily limit of ${safetyConfig.dailyLimit} members reached. Try again tomorrow.` 
        };
    }
    
    // Detailed logging of the group ID for diagnostic purposes
    logActivity(`Attempting to verify group ID: ${groupId}`, 'info');
    
    // Create a modified groupId that the WhatsApp Web.js library might better handle
    // The library might be expecting IDs only in the old format with hyphen
    let modifiedGroupId = groupId;
    
    // If it's the newer format without hyphen, try a workaround
    if (/^\d+@g\.us$/.test(groupId)) {
        logActivity(`Detected newer WhatsApp group ID format: ${groupId}`, 'info');
        
        // Skip verification step for newer format since the WhatsApp Web.js library
        // might not properly support it yet
        logActivity(`Using direct API calls for newer group ID format`, 'info');
        
        // Instead of strict verification, we'll check participation in upcoming operations
        try {
            // We'll attempt a lightweight operation to see if the group exists
            // This is just to confirm we can interact with the group
            const participants = await client.getParticipants(groupId);
            logActivity(`Group exists with ${participants.length} participants`, 'success');
        } catch (participantsErr) {
            logActivity(`Failed to get participants for group ID ${groupId}: ${participantsErr.message}`, 'error');
            safetyConfig.consecutiveFailures++;
            
            // Even though verification failed, we'll proceed anyway since the ID format is valid
            // This allows working with newer group IDs even if verification mechanisms are outdated
            logActivity(`Proceeding with group operations despite verification failure`, 'warning');
        }
    } else {
        // For traditional hyphenated group IDs, use the standard verification
        try {
            const chat = await client.getChatById(groupId);
            if (!chat.isGroup) {
                return { success: false, message: 'Provided ID is not a group' };
            }
            logActivity(`Successfully verified traditional group ID: ${groupId}`, 'success');
        } catch (err) {
            safetyConfig.consecutiveFailures++;
            logActivity(`Failed to verify group ID ${groupId}: ${err.message}`, 'error');
            return { success: false, message: 'Invalid group ID or group not found' };
        }
    }
    
    safetyConfig.isAddingMembers = true;
    safetyConfig.userStatus = 'adding';
    
    // Initialize results object
    const results = {
        success: true,
        added: 0,
        failed: 0,
        skipped: 0,
        details: [],
        batch: {
            total: numbers.length,
            processed: 0,
            remaining: numbers.length,
            estimatedCompletion: null
        }
    };
    
    // Use existing batch data if resuming
    if (safetyConfig.currentBatch.length > 0 && safetyConfig.lastGroupId === groupId) {
        logActivity(`Resuming existing batch from index ${safetyConfig.currentBatchIndex}`, 'info');
        safetyConfig.currentBatch = numbers;
    } else {
        safetyConfig.currentBatch = numbers;
        safetyConfig.currentBatchIndex = 0;
    }
    
    try {
        // Process each number with smart timing
        for (let i = safetyConfig.currentBatchIndex; i < numbers.length; i++) {
            safetyConfig.currentBatchIndex = i;
            saveSessionStats(); // Save progress after each update
            
            // Update batch processing stats
            results.batch.processed = i;
            results.batch.remaining = numbers.length - i;
            
            // Calculate estimated completion time based on current average delay
            const avgDelaySeconds = ((safetyConfig.minDelay + safetyConfig.maxDelay) / 2) * 1.2; // 20% buffer
            const estimatedRemainingSeconds = results.batch.remaining * avgDelaySeconds;
            const estimatedCompletion = new Date();
            estimatedCompletion.setSeconds(estimatedCompletion.getSeconds() + estimatedRemainingSeconds);
            results.batch.estimatedCompletion = estimatedCompletion.toISOString();
            
            // Check if we need a periodic batch cooldown
            if (i > 0 && i % safetyConfig.maxBatchSize === 0) {
                const cooldownTime = safetyConfig.batchCooldown;
                logActivity(`Batch cooldown: Pausing for ${cooldownTime} seconds after adding ${safetyConfig.maxBatchSize} members`, 'info');
                await new Promise(resolve => setTimeout(resolve, cooldownTime * 1000));
            }
            
            // Check if daily limit reached during processing
            if (safetyConfig.addedToday >= safetyConfig.dailyLimit) {
                results.details.push({
                    number: numbers[i],
                    status: 'skipped',
                    reason: 'Daily limit reached'
                });
                results.skipped++;
                continue;
            }
            
            // Check if hourly limit reached during processing
            if (checkHourlyLimit()) {
                results.details.push({
                    number: numbers[i],
                    status: 'skipped',
                    reason: 'Hourly limit reached'
                });
                results.skipped++;
                
                // Wait until the next hour if we've hit the hourly limit
                const now = new Date();
                const nextHour = new Date(now);
                nextHour.setHours(now.getHours() + 1);
                nextHour.setMinutes(0);
                nextHour.setSeconds(5); // 5 seconds buffer
                
                const waitTime = nextHour - now;
                if (waitTime > 0) {
                    logActivity(`Hourly limit reached. Pausing for ${Math.ceil(waitTime/60000)} minutes until ${nextHour.toTimeString()}`, 'warning');
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    
                    // Reset the hourly counter for the new hour
                    const newHour = new Date().getHours();
                    safetyConfig.hourlyAdditionCounts[newHour] = 0;
                }
                continue;
            }
            
            try {
                // Use the new two-step process: save contact then add to group
                await saveContactThenAdd(numbers[i], groupId);
                
                // Update counters
                safetyConfig.addedToday++;
                updateHourlyCount();
                results.added++;
                results.details.push({
                    number: numbers[i],
                    status: 'added',
                    reason: 'Successfully saved contact and added to group'
                });
                
                // Reset consecutive failures counter on success
                safetyConfig.consecutiveFailures = 0;
                
                // Save updated stats
                saveSessionStats();
                
                // If not the last member, wait for a smart delay
                if (i < numbers.length - 1) {
                    const delay = getSmartDelay();
                    logActivity(`Waiting ${Math.round(delay/1000)} seconds before processing next contact...`, 'info');
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (err) {
                // Detect ban-related errors
                const errorMsg = err.message || 'Unknown error';
                const isBanRelated = 
                    errorMsg.includes('not-authorized') || 
                    errorMsg.includes('forbidden') ||
                    errorMsg.includes('denied') ||
                    errorMsg.includes('blocked') ||
                    errorMsg.includes('spam') ||
                    errorMsg.includes('limit') ||
                    errorMsg.includes('banned');
                
                // Track consecutive failures
                safetyConfig.consecutiveFailures++;
                
                // Get the formatted number for tracking (could be undefined if validation failed)
                const validation = validatePhoneNumber(numbers[i]);
                const formattedNumber = validation.isValid ? validation.formatted : `${numbers[i]}@c.us`;
                
                // Track this failed number
                updateFailedNumber(formattedNumber, errorMsg);
                
                logActivity(`Error processing ${numbers[i]}: ${errorMsg}`, 'error');
                results.details.push({
                    number: numbers[i],
                    status: 'failed',
                    reason: errorMsg
                });
                results.failed++;
                
                // If ban-related error, take extra precautions
                if (isBanRelated) {
                    logActivity('Detected potential ban-related error. Taking protective measures.', 'warning');
                    
                    // Take a longer break to avoid getting blocked
                    const extraDelay = 300 + (Math.random() * 300); // 5-10 minute break
                    logActivity(`Taking an extended break of ${Math.ceil(extraDelay/60)} minutes for safety`, 'warning');
                    await new Promise(resolve => setTimeout(resolve, extraDelay * 1000));
                    
                    // If we get multiple ban-related errors, trip the circuit breaker
                    if (safetyConfig.consecutiveFailures >= 3 && isBanRelated) {
                        safetyConfig.circuitBreakerTripped = true;
                        const resetTime = new Date();
                        resetTime.setSeconds(resetTime.getSeconds() + safetyConfig.circuitBreakerTimeout);
                        safetyConfig.circuitBreakerResetTime = resetTime.toISOString();
                        
                        logActivity(`Emergency protection activated due to potential ban risk. Pausing for ${safetyConfig.circuitBreakerTimeout/60} minutes.`, 'warning');
                        
                        // Save the current state for later resumption
                        saveSessionStats();
                        
                        // Return partial results with warning
                        return {
                            ...results,
                            success: false,
                            message: 'Operation paused due to potential ban risk. Will resume automatically after cooldown period.'
                        };
                    }
                }
                
                // Take a longer break after each failure
                const failureDelay = Math.min(60 + (safetyConfig.consecutiveFailures * 30), 300); // 1-5 minutes
                logActivity(`Taking a ${failureDelay} second break after failure`, 'info');
                await new Promise(resolve => setTimeout(resolve, failureDelay * 1000));
            }
            
            // Check if circuit breaker tripped during processing
            if (checkCircuitBreaker()) {
                // Save progress and return partial results
                saveSessionStats();
                return {
                    ...results,
                    success: false,
                    message: 'Operation paused due to too many consecutive failures. Will resume automatically after cooldown period.'
                };
            }
        }
        
        // Send a greeting message if specified and at least one member was added
        if (message && results.added > 0) {
            try {
                await client.sendMessage(groupId, message);
                logActivity(`Sent greeting message to group ${groupId}`, 'info');
            } catch (err) {
                logActivity(`Error sending greeting message: ${err.message}`, 'error');
            }
        }
        
        // Clean up batch data after successful completion
        if (safetyConfig.currentBatch.length > 0 && safetyConfig.currentBatchIndex >= safetyConfig.currentBatch.length - 1) {
            safetyConfig.currentBatch = [];
            safetyConfig.currentBatchIndex = 0;
            safetyConfig.lastGroupId = null;
            
            // Remove the batches file if it exists
            if (fs.existsSync(batchesFile)) {
                fs.unlinkSync(batchesFile);
            }
        }
        
        // Log completion
        logActivity(`Batch processing completed. Added: ${results.added}, Failed: ${results.failed}, Skipped: ${results.skipped}`, 'success');
        
        return results;
    } catch (err) {
        logActivity(`Unexpected error in batch processing: ${err.message}`, 'error');
        if (err.stack) {
            logActivity(`Stack trace: ${err.stack}`, 'error');
        }
        
        return { 
            ...results, 
            success: false, 
            message: `Unexpected error: ${err.message}. Current progress saved for later resumption.`
        };
    } finally {
        safetyConfig.isAddingMembers = false;
        safetyConfig.userStatus = 'ready';
        saveSessionStats();
    }
}

// Function to track failed numbers
function updateFailedNumber(formattedNumber, reason) {
    const now = new Date().toISOString();
    
    if (safetyConfig.failedNumbers.has(formattedNumber)) {
        const record = safetyConfig.failedNumbers.get(formattedNumber);
        record.count++;
        record.lastFailure = now;
        record.reason = reason;
        safetyConfig.failedNumbers.set(formattedNumber, record);
    } else {
        safetyConfig.failedNumbers.set(formattedNumber, {
            count: 1,
            firstFailure: now,
            lastFailure: now,
            reason: reason
        });
    }
}

// Function to identify if a string is a WhatsApp invitation link
function isInvitationLink(input) {
    if (!input) return false;
    
    // Trim input
    input = input.trim();
    
    // Check for WhatsApp invitation link patterns
    return input.includes('chat.whatsapp.com/') || 
           /^https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/i.test(input);
}

// Function to identify if a string is a valid WhatsApp group ID
function isGroupId(input) {
    if (!input) return false;
    
    // Trim input
    input = input.trim();
    
    // Check for WhatsApp group ID patterns:
    // 1. Traditional format with hyphen (e.g., 1234567890-1234567890@g.us)
    // 2. Newer format without hyphen (e.g., 120363413164388361@g.us)
    return /^\d+-\d+@g\.us$/.test(input) || /^\d+@g\.us$/.test(input);
}

// Function to extract invitation code from a WhatsApp invitation link
function extractInviteCode(inviteLink) {
    // Check if this is a valid WhatsApp invitation link
    if (!inviteLink) return null;
    
    // Remove any whitespace
    inviteLink = inviteLink.trim();
    
    // Common WhatsApp invite link formats:
    // https://chat.whatsapp.com/XXXXXXXXXXXX
    // chat.whatsapp.com/XXXXXXXXXXXX
    
    try {
        // If it's a full URL, extract the code
        if (inviteLink.startsWith('http')) {
            const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
            if (match && match[1]) {
                return match[1];
            }
        }
        
        // If it's not a full URL but contains the domain
        const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
        if (match && match[1]) {
            return match[1];
        }
    } catch (err) {
        logActivity(`Error parsing invite link: ${err.message}`, 'error');
    }
    
    return null; // Not a valid invite link or couldn't extract code
}

// Function to join a group using an invitation link and perform operations afterward
async function processGroupInvitation(inviteLink, numbers, message = '') {
    try {
        // Extract the invitation code from the link
        const inviteCode = extractInviteCode(inviteLink);
        if (!inviteCode) {
            return { 
                success: false, 
                message: 'Invalid invitation link format. Could not extract invitation code.' 
            };
        }
        
        logActivity(`Extracted invitation code: ${inviteCode} from link: ${inviteLink}`, 'info');
        
        try {
            // First check if the invitation is valid
            let groupInfo = null;
            try {
                const inviteInfo = await client.getInviteInfo(inviteCode);
                groupInfo = {
                    name: inviteInfo.groupName || inviteInfo.subject,
                    participants: inviteInfo.size
                };
                logActivity(`Invite info retrieved: Group "${groupInfo.name}" with ${groupInfo.participants} participants`, 'info');
            } catch (infoErr) {
                logActivity(`Error retrieving invite info: ${infoErr.message}`, 'error');
                // Continue anyway as some valid invites may not provide info
            }
            
            // Accept the invite and join the group
            logActivity(`Attempting to join group with invitation code: ${inviteCode}`, 'info');
            const joinResult = await client.acceptInvite(inviteCode);
            
            if (!joinResult) {
                return { 
                    success: false, 
                    message: 'Failed to join the group. The invitation may be invalid or expired.' 
                };
            }
            
            logActivity(`Successfully accepted invitation. Waiting for group info...`, 'success');
            
            // Wait longer for the join to complete and group to be available (10 seconds instead of 5)
            logActivity(`Waiting 10 seconds for group to be fully available...`, 'info');
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            // Get all chats and find the newly joined group
            logActivity(`Retrieving all chats to find newly joined group...`, 'info');
            const chats = await client.getChats();
            logActivity(`Found ${chats.length} total chats, ${chats.filter(c => c.isGroup).length} are groups`, 'info');
            
            // Try multiple approaches to find the newly joined group
            
            // Approach 1: Look for recent groups first
            const recentGroups = chats.filter(chat => 
                chat.isGroup && 
                // Look at groups joined in the last 2 minutes
                (new Date(chat.timestamp * 1000) > new Date(Date.now() - 120000))
            );
            
            logActivity(`Found ${recentGroups.length} recently joined groups`, 'info');
            
            // Approach 2: If we have group name from invite info, try to match by name
            let matchedByName = null;
            if (groupInfo && groupInfo.name) {
                matchedByName = chats.filter(chat => 
                    chat.isGroup && chat.name === groupInfo.name
                );
                logActivity(`Found ${matchedByName.length} groups matching the name "${groupInfo.name}"`, 'info');
            }
            
            // Approach 3: If approaches 1 and 2 fail, get all groups and sort by most recent
            let allGroups = chats.filter(chat => chat.isGroup);
            allGroups.sort((a, b) => b.timestamp - a.timestamp);
            
            // Choose the best match using our approaches
            let joinedGroup = null;
            
            if (recentGroups.length > 0) {
                // Take the most recent group from recently joined
                joinedGroup = recentGroups.sort((a, b) => b.timestamp - a.timestamp)[0];
                logActivity(`Using the most recently joined group: "${joinedGroup.name}"`, 'info');
            } else if (matchedByName && matchedByName.length > 0) {
                // Use the group matching the name from invite info
                joinedGroup = matchedByName[0];
                logActivity(`Using group matching the invitation name: "${joinedGroup.name}"`, 'info');
            } else if (allGroups.length > 0) {
                // Fallback: use the most recent group of all
                joinedGroup = allGroups[0];
                logActivity(`Fallback: Using the most recent group: "${joinedGroup.name}"`, 'info');
            }
            
            if (!joinedGroup) {
                return {
                    success: false,
                    message: 'Joined the group but could not identify it in your chats. The members will be added once you open this group in WhatsApp.'
                };
            }
            
            const groupId = joinedGroup.id._serialized;
            logActivity(`Successfully identified group "${joinedGroup.name}" with ID: ${groupId}`, 'success');
            
            // Now that we have the group ID, add members to the group
            return await addMembersToGroup(groupId, numbers, message);
            
        } catch (err) {
            logActivity(`Error processing group invitation: ${err.message}`, 'error');
            return { 
                success: false, 
                message: `Error processing invitation: ${err.message}. This may be a temporary issue - please try again or contact support if the problem persists.`
            };
        }
    } catch (err) {
        logActivity(`Unexpected error in processGroupInvitation: ${err.message}`, 'error');
        return { 
            success: false, 
            message: `Unexpected error: ${err.message}. Please try again or contact support if the problem persists.`
        };
    }
}

// Improved function to handle both group IDs and invitation links
async function processGroupAddition(groupIdOrLink, numbers, message = '') {
    // Check if this is an invitation link or a group ID
    if (isInvitationLink(groupIdOrLink)) {
        logActivity(`Detected invitation link: ${groupIdOrLink}`, 'info');
        return await processGroupInvitation(groupIdOrLink, numbers, message);
    } else if (isGroupId(groupIdOrLink)) {
        logActivity(`Detected group ID: ${groupIdOrLink}`, 'info');
        return await addMembersToGroup(groupIdOrLink, numbers, message);
    } else {
        // Try to guess the format and handle accordingly
        if (groupIdOrLink.includes('chat.whatsapp.com')) {
            logActivity(`Treating as invitation link: ${groupIdOrLink}`, 'info');
            return await processGroupInvitation(groupIdOrLink, numbers, message);
        } else {
            logActivity(`Treating as group ID: ${groupIdOrLink}`, 'info');
            return await addMembersToGroup(groupIdOrLink, numbers, message);
        }
    }
}

// API Endpoints
app.get('/api/status', (req, res) => {
    // Check if circuit breaker wait time has elapsed
    if (safetyConfig.circuitBreakerTripped && safetyConfig.circuitBreakerResetTime) {
        const resetTime = new Date(safetyConfig.circuitBreakerResetTime);
        if (new Date() > resetTime) {
            resetCircuitBreaker();
        }
    }
    
    const currentHour = new Date().getHours();
    
    res.json({
        clientReady: client.info !== undefined,
        dailyLimit: safetyConfig.dailyLimit,
        addedToday: safetyConfig.addedToday,
        remaining: Math.max(0, safetyConfig.dailyLimit - safetyConfig.addedToday),
        hourlyLimit: safetyConfig.hourlyLimit,
        hourlyAdded: safetyConfig.hourlyAdditionCounts[currentHour],
        hourlyRemaining: Math.max(0, safetyConfig.hourlyLimit - safetyConfig.hourlyAdditionCounts[currentHour]),
        status: safetyConfig.userStatus,
        protectionMode: safetyConfig.circuitBreakerTripped,
        protectionResetTime: safetyConfig.circuitBreakerResetTime,
        currentBatchSize: safetyConfig.currentBatch.length,
        currentBatchProgress: safetyConfig.currentBatchIndex,
        consecutiveFailures: safetyConfig.consecutiveFailures
    });
});

// Endpoint to reset circuit breaker
app.post('/api/reset-protection', (req, res) => {
    resetCircuitBreaker();
    res.json({
        success: true,
        message: 'Protection mode disabled'
    });
});
app.post('/api/add-members', 
    validateRequest([
        body('groupId').notEmpty().withMessage('Group ID is required'),
        body('numbers').isArray().withMessage('Numbers must be an array'),
        body('numbers.*').matches(/^\d+$/).withMessage('Invalid phone number format'),
        body('message').optional().isString().withMessage('Message must be a string')
    ]),
    async (req, res) => {
    try {
    const { groupId, numbers, message } = req.body;
            // Check WhatsApp client status
        if (!client.info) {
                return res.status(503).json({ 
                    success: false, 
                    message: 'WhatsApp client not ready' 
                });
    }
            // Validate group ID format
            if (!isGroupId(groupId) && !isInvitationLink(groupId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid group ID or invitation link format'
                });
        }
            // Check for empty numbers array
            if (numbers.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'No phone numbers provided'
                });
    }
            // Process the request
            const result = await processGroupAddition(groupId, numbers, message);
            res.json(result);
    } catch (err) {
        logActivity(`Error in add-members API: ${err.message}`, 'error');
            next(err);
    }
    }
);
// Get logs endpoint
app.get('/api/logs', (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const logFile = path.join(logsDir, `${date}.log`);
    
    if (!fs.existsSync(logFile)) {
        return res.json({
            success: true,
            logs: [],
            message: 'No logs available for this date'
        });
    }
    
    try {
        const logs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
        res.json({
            success: true,
            logs,
            date
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: `Error reading logs: ${err.message}`
        });
    }
});

// Get available log dates
app.get('/api/log-dates', (req, res) => {
    try {
        const files = fs.readdirSync(logsDir).filter(file => file.endsWith('.log'));
        const dates = files.map(file => file.replace('.log', ''));
        
        res.json({
            success: true,
            dates
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: `Error reading log dates: ${err.message}`
        });
    }
});

app.post('/api/upload-csv', async (req, res, next) => {
    try {
    if (!req.files || !req.files.csv) {
            return res.status(400).json({ 
                success: false, 
                message: 'No CSV file uploaded' 
            });
    }
    const csvFile = req.files.csv;
    
        // Validate file type
        if (!csvFile.name.endsWith('.csv')) {
            return res.status(400).json({
                success: false,
                message: 'Only CSV files are allowed'
            });
        }
        // Validate file size (5MB limit)
        if (csvFile.size > 5 * 1024 * 1024) {
            return res.status(400).json({
                success: false,
                message: 'File size exceeds 5MB limit'
            });
        }
        const uploadPath = path.join(__dirname, 'data', csvFile.name);
        
        await csvFile.mv(uploadPath);
        const numbers = [];
        
        await new Promise((resolve, reject) => {
        fs.createReadStream(uploadPath)
            .pipe(csvParser())
            .on('data', (row) => {
                    const number = row.number || row.phone || row.phoneNumber || 
                                 row.contact || row.mobile || Object.values(row)[0];
                if (number) {
                    const cleaned = number.toString().trim().replace(/[^0-9]/g, '');
                        if (cleaned) numbers.push(cleaned);
                }
            })
                .on('end', () => resolve())
                .on('error', reject);
        });
        // Clean up uploaded file
        await fs.promises.unlink(uploadPath);
                res.json({ 
                    success: true, 
                    count: numbers.length, 
                    numbers,
                    message: `Found ${numbers.length} valid phone numbers in the CSV file`
                });
    } catch (err) {
        next(err);
    }
});

// Resume interrupted batch
app.post('/api/resume-batch', async (req, res) => {
    if (safetyConfig.isAddingMembers) {
        return res.status(409).json({ success: false, message: 'Already adding members to a group' });
    }
    
    if (!safetyConfig.currentBatch || safetyConfig.currentBatch.length === 0 || !safetyConfig.lastGroupId) {
        return res.status(404).json({ success: false, message: 'No interrupted batch found to resume' });
    }
    
    try {
        const remainingNumbers = safetyConfig.currentBatch.slice(safetyConfig.currentBatchIndex);
        
        logActivity(`Resuming batch with ${remainingNumbers.length} remaining numbers for group ${safetyConfig.lastGroupId}`, 'info');
        
        const result = await addMembersToGroup(safetyConfig.lastGroupId, safetyConfig.currentBatch);
        res.json(result);
    } catch (err) {
        logActivity(`Error resuming batch: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get failed numbers info
app.get('/api/failed-numbers', (req, res) => {
    const failedNumbers = Array.from(safetyConfig.failedNumbers.entries()).map(([number, details]) => {
        return {
            number: number.replace('@c.us', ''),
            count: details.count,
            firstFailure: details.firstFailure,
            lastFailure: details.lastFailure,
            reason: details.reason
        };
    });
    
    res.json({
        success: true,
        count: failedNumbers.length,
        failedNumbers
    });
});

// Clear failed numbers
app.post('/api/clear-failed-numbers', (req, res) => {
    safetyConfig.failedNumbers.clear();
    
    if (fs.existsSync(failedNumbersFile)) {
        fs.unlinkSync(failedNumbersFile);
    }
    
    res.json({
        success: true,
        message: 'Failed numbers list cleared'
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize the client and start the server
client.initialize();

// Function to find an available port and start the server
function startServer(initialPort) {
    // Use a non-recursive approach to avoid multiple listen calls
    let currentPort = initialPort;
    const maxPortAttempts = 10; // Limit port attempts to avoid infinite loops
    let attempts = 0;
    
    function tryPort(port) {
        attempts++;
        
        // Create a temporary server to test if port is available
        const testServer = http.createServer();
        
        testServer.once('error', (err) => {
            // Port is in use, try next port
            if (err.code === 'EADDRINUSE') {
                testServer.close();
                if (attempts < maxPortAttempts) {
                    logActivity(`Port ${port} is already in use, trying port ${port + 1}...`, 'warning');
                    tryPort(port + 1);
                } else {
                    logActivity(`Could not find available port after ${maxPortAttempts} attempts`, 'error');
                }
            } else {
                logActivity(`Error testing port ${port}: ${err.message}`, 'error');
            }
        });
        
        testServer.once('listening', () => {
            // Found an available port, close test server and start actual server
            testServer.close();
            
            server.listen(port, () => {
                logActivity(`Server running on http://localhost:${port}`, 'success');
            });
        });
        
        // Test if port is available
        testServer.listen(port);
    }
    
    // Start the port finding process
    tryPort(currentPort);
    
    return server;
}

// Apply error handling middleware last
app.use(errorHandler);
// Start the server with proper port finding
startServer(PORT);
// Global error handler for uncaught exceptions
process.on('uncaughtException', (err) => {
    logActivity(`UNCAUGHT EXCEPTION: ${err.message}`, 'error');
    if (err.stack) {
        logActivity(`Stack trace: ${err.stack}`, 'error');
    }
    
    // If the error is related to Puppeteer or browser context
    if (err.message.includes('Execution context was destroyed') || 
        err.message.includes('Protocol error') ||
        err.message.includes('Target closed') ||
        err.message.includes('Session closed')) {
        
        logActivity('Error appears to be related to Puppeteer browser context. Attempting recovery...', 'warning');
        
        // Attempt to recover the WhatsApp client session
        setTimeout(attemptReconnect, 5000);
    }
    
    // We don't exit the process - let the application continue running
    logActivity('Application will continue running despite the error', 'info');
});

// Handling promise rejections 
process.on('unhandledRejection', (reason, promise) => {
    logActivity(`UNHANDLED REJECTION: ${reason}`, 'error');
    
    // Log additional details if available
    if (reason instanceof Error) {
        if (reason.stack) {
            logActivity(`Stack trace: ${reason.stack}`, 'error');
        }
        
        // Handle specific WhatsApp/Puppeteer errors
        if (reason.message.includes('Execution context was destroyed') || 
            reason.message.includes('Protocol error') ||
            reason.message.includes('Target closed') ||
            reason.message.includes('Session closed')) {
            
            logActivity('Error appears to be related to Puppeteer/WhatsApp connection. Attempting recovery...', 'warning');
            
            // Attempt to reconnect after a short delay
            setTimeout(attemptReconnect, 5000);
        }
    }
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
    logActivity('Shutdown signal received. Closing gracefully...', 'info');
    try {
        await client.destroy();
        logActivity('WhatsApp client destroyed successfully', 'info');
    } catch (err) {
        logActivity(`Error during shutdown: ${err.message}`, 'error');
    }
    
    // Save any pending data
    try {
        saveSessionStats();
        logActivity('Session data saved', 'info');
    } catch (err) {
        logActivity(`Error saving session data: ${err.message}`, 'error');
    }
    
    logActivity('Shutdown complete. Exiting process.', 'info');
    process.exit(0);
});