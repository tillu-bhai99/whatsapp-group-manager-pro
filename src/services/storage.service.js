/**
 * Storage Service
 * Handles all data persistence operations
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Define file paths
const DATA_DIR = path.join(process.cwd(), 'data');
const STATS_FILE = path.join(DATA_DIR, 'session-stats.json');
const FAILED_NUMBERS_FILE = path.join(DATA_DIR, 'failed-numbers.json');
const BATCHES_FILE = path.join(DATA_DIR, 'batches.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Global state object for in-memory storage
let sessionStats = {
    addedToday: 0,
    lastDateReset: new Date().toDateString(),
    hourlyAdditionCounts: new Array(24).fill(0),
    circuitBreakerTripped: false,
    circuitBreakerResetTime: null,
    isAddingMembers: false,
    userStatus: 'ready',
    consecutiveFailures: 0,
    failedNumbers: new Map(),
    currentBatch: [],
    currentBatchIndex: 0,
    lastGroupId: null,
    
    // Configuration settings - could be moved to .env in the future
    minDelay: process.env.MIN_DELAY || 30, // seconds
    maxDelay: process.env.MAX_DELAY || 90, // seconds
    dailyLimit: process.env.DAILY_LIMIT || 20000, // max members per day
    maxBatchSize: process.env.MAX_BATCH_SIZE || 1000, // process in batches
    pauseAfterBatch: process.env.PAUSE_AFTER_BATCH || 3600, // seconds to pause after each batch
    batchCooldown: process.env.BATCH_COOLDOWN || 300, // seconds of cooldown after each batch
    failureThreshold: process.env.FAILURE_THRESHOLD || 10, // max consecutive failures before pausing
    circuitBreakerTimeout: process.env.CIRCUIT_BREAKER_TIMEOUT || 1800, // 30 minutes pause after hitting failure threshold
    hourlyLimit: process.env.HOURLY_LIMIT || 1000, // Maximum additions per hour
    patternVariation: true // Enable pattern variation to avoid detection
};

/**
 * Initialize data storage by creating necessary directories and loading existing data
 */
function initializeDataStorage() {
    logger.info('Initializing data storage...');
    
    // Create required directories
    createDirectoryStructure();
    
    // Load existing data if available
    loadSessionStats();
    loadFailedNumbers();
    loadBatchData();
    
    logger.success('Data storage initialized successfully');
    
    return {
        sessionStats
    };
}

/**
 * Create all required directories for data storage
 */
function createDirectoryStructure() {
    try {
        // Create data directory if it doesn't exist
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            logger.info(`Created data directory: ${DATA_DIR}`);
        }
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(LOGS_DIR)) {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
            logger.info(`Created logs directory: ${LOGS_DIR}`);
        }
    } catch (err) {
        logger.error(`Error creating directory structure: ${err.message}`);
    }
}

/**
 * Load session statistics from file if available
 */
function loadSessionStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const stats = JSON.parse(data);
            
            // Reset counter if it's a new day
            if (stats.lastDateReset !== new Date().toDateString()) {
                stats.addedToday = 0;
                stats.lastDateReset = new Date().toDateString();
                stats.hourlyAdditionCounts = new Array(24).fill(0);
            }
            
            // Update session stats with loaded data
            sessionStats.addedToday = stats.addedToday || 0;
            sessionStats.lastDateReset = stats.lastDateReset;
            sessionStats.hourlyAdditionCounts = stats.hourlyAdditionCounts || new Array(24).fill(0);
            sessionStats.circuitBreakerTripped = stats.circuitBreakerTripped || false;
            sessionStats.circuitBreakerResetTime = stats.circuitBreakerResetTime || null;
            
            // If circuit breaker was tripped but the timeout has passed, reset it
            if (sessionStats.circuitBreakerTripped && sessionStats.circuitBreakerResetTime) {
                const resetTime = new Date(sessionStats.circuitBreakerResetTime);
                if (new Date() > resetTime) {
                    sessionStats.circuitBreakerTripped = false;
                    sessionStats.circuitBreakerResetTime = null;
                    sessionStats.consecutiveFailures = 0;
                    logger.info('Circuit breaker reset after timeout period');
                }
            }
            
            logger.info(`Loaded session stats: ${stats.addedToday} members added today`);
        } else {
            logger.info('No existing session stats found, using defaults');
        }
    } catch (err) {
        logger.error(`Error loading session stats: ${err.message}`);
        // Use defaults if there's an error
    }
}

/**
 * Load failed numbers data from file if available
 */
function loadFailedNumbers() {
    try {
        if (fs.existsSync(FAILED_NUMBERS_FILE)) {
            const data = fs.readFileSync(FAILED_NUMBERS_FILE, 'utf8');
            const failedNumbersData = JSON.parse(data);
            
            sessionStats.failedNumbers = new Map(failedNumbersData);
            logger.info(`Loaded ${sessionStats.failedNumbers.size} failed numbers`);
        } else {
            logger.info('No failed numbers data found');
        }
    } catch (err) {
        logger.error(`Error loading failed numbers: ${err.message}`);
        // Use empty Map if there's an error
        sessionStats.failedNumbers = new Map();
    }
}

/**
 * Load batch data from file if available
 */
function loadBatchData() {
    try {
        if (fs.existsSync(BATCHES_FILE)) {
            const data = fs.readFileSync(BATCHES_FILE, 'utf8');
            const batchData = JSON.parse(data);
            
            if (batchData.currentBatch && batchData.currentBatch.length > 0) {
                sessionStats.currentBatch = batchData.currentBatch;
                sessionStats.currentBatchIndex = batchData.currentBatchIndex || 0;
                sessionStats.lastGroupId = batchData.lastGroupId;
                
                logger.info(`Loaded interrupted batch with ${sessionStats.currentBatch.length - sessionStats.currentBatchIndex} numbers remaining`);
            } else {
                logger.info('No active batch found');
            }
        } else {
            logger.info('No batch data file found');
        }
    } catch (err) {
        logger.error(`Error loading batch data: ${err.message}`);
        // Use empty batch if there's an error
        sessionStats.currentBatch = [];
        sessionStats.currentBatchIndex = 0;
        sessionStats.lastGroupId = null;
    }
}

/**
 * Save all session statistics to disk
 */
function saveSessionStats() {
    try {
        const stats = {
            addedToday: sessionStats.addedToday,
            lastDateReset: sessionStats.lastDateReset,
            hourlyAdditionCounts: sessionStats.hourlyAdditionCounts,
            circuitBreakerTripped: sessionStats.circuitBreakerTripped,
            circuitBreakerResetTime: sessionStats.circuitBreakerResetTime
        };
        
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        
        // Save failed numbers data
        const failedNumbersData = Array.from(sessionStats.failedNumbers.entries());
        fs.writeFileSync(FAILED_NUMBERS_FILE, JSON.stringify(failedNumbersData, null, 2));
        
        // Save current batch state if there's an active batch
        if (sessionStats.currentBatch && sessionStats.currentBatch.length > 0) {
            const batchData = {
                currentBatch: sessionStats.currentBatch,
                currentBatchIndex: sessionStats.currentBatchIndex,
                lastGroupId: sessionStats.lastGroupId
            };
            fs.writeFileSync(BATCHES_FILE, JSON.stringify(batchData, null, 2));
        }
    } catch (err) {
        logger.error(`Error saving session data: ${err.message}`);
    }
}

/**
 * Clear failed numbers data
 */
function clearFailedNumbers() {
    sessionStats.failedNumbers = new Map();
    
    try {
        if (fs.existsSync(FAILED_NUMBERS_FILE)) {
            fs.unlinkSync(FAILED_NUMBERS_FILE);
            logger.info('Failed numbers data cleared');
        }
    } catch (err) {
        logger.error(`Error clearing failed numbers data: ${err.message}`);
    }
    
    return true;
}

/**
 * Clear current batch data
 */
function clearBatchData() {
    sessionStats.currentBatch = [];
    sessionStats.currentBatchIndex = 0;
    sessionStats.lastGroupId = null;
    
    try {
        if (fs.existsSync(BATCHES_FILE)) {
            fs.unlinkSync(BATCHES_FILE);
            logger.info('Batch data cleared');
        }
    } catch (err) {
        logger.error(`Error clearing batch data: ${err.message}`);
    }
    
    return true;
}

/**
 * Get current session statistics
 * @returns {Object} Current session stats
 */
function getSessionStats() {
    return sessionStats;
}

/**
 * Update session status
 * @param {Object} updates - Properties to update
 */
function updateSessionStats(updates) {
    Object.assign(sessionStats, updates);
    saveSessionStats();
}

/**
 * Get available log dates
 * @returns {Array<string>} Array of available log dates
 */
function getLogDates() {
    try {
        const files = fs.readdirSync(LOGS_DIR).filter(file => file.endsWith('.log'));
        return files.map(file => file.replace('.log', ''));
    } catch (err) {
        logger.error(`Error reading log dates: ${err.message}`);
        return [];
    }
}

/**
 * Get logs for a specific date
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Array<string>} Array of log entries
 */
function getLogs(date) {
    const today = new Date().toISOString().split('T')[0];
    const logDate = date || today;
    const logFile = path.join(LOGS_DIR, `${logDate}.log`);
    
    try {
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
            return logs;
        }
        return [];
    } catch (err) {
        logger.error(`Error reading logs for ${logDate}: ${err.message}`);
        return [];
    }
}

/**
 * Get failed numbers data
 * @returns {Array<Object>} Array of failed number records
 */
function getFailedNumbers() {
    const failedNumbers = Array.from(sessionStats.failedNumbers.entries()).map(([number, details]) => {
        return {
            number: number.replace('@c.us', ''),
            count: details.count,
            firstFailure: details.firstFailure,
            lastFailure: details.lastFailure,
            reason: details.reason
        };
    });
    
    return failedNumbers;
}

// Export service functions
module.exports = {
    initializeDataStorage,
    saveSessionStats,
    getSessionStats,
    updateSessionStats,
    clearFailedNumbers,
    clearBatchData,
    getLogDates,
    getLogs,
    getFailedNumbers
};