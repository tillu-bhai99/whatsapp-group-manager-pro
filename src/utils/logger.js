/**
 * Logger Utility
 * Provides standardized logging functionality across the application
 */

const fs = require('fs');
const path = require('path');

// Create required directories
const logsDir = path.join(process.cwd(), 'data', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Log a message with a specified type and optionally write to file
 * @param {string} message - Message to log
 * @param {string} type - Log type (info, success, warning, error)
 * @param {boolean} writeToFile - Whether to write log to file
 */
function logActivity(message, type = 'info', writeToFile = true) {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toISOString().split('T')[1].split('.')[0];
    const logMessage = `[${timeStr}] [${type.toUpperCase()}] ${message}`;
    
    // Set console color based on type
    let coloredMessage = logMessage;
    switch (type.toLowerCase()) {
        case 'success':
            coloredMessage = `\x1b[32m${logMessage}\x1b[0m`; // Green
            break;
        case 'warning':
            coloredMessage = `\x1b[33m${logMessage}\x1b[0m`; // Yellow
            break;
        case 'error':
            coloredMessage = `\x1b[31m${logMessage}\x1b[0m`; // Red
            break;
        case 'info':
        default:
            coloredMessage = `\x1b[36m${logMessage}\x1b[0m`; // Cyan
            break;
    }
    
    console.log(coloredMessage);
    
    // Also write to daily log file if requested
    if (writeToFile) {
        try {
            const logFile = path.join(logsDir, `${dateStr}.log`);
            fs.appendFileSync(logFile, logMessage + '\n');
        } catch (err) {
            console.error(`\x1b[31mError writing to log file: ${err.message}\x1b[0m`);
        }
    }
}

// Shortcut methods for different log types
const logger = {
    info: (message, writeToFile = true) => logActivity(message, 'info', writeToFile),
    success: (message, writeToFile = true) => logActivity(message, 'success', writeToFile),
    warn: (message, writeToFile = true) => logActivity(message, 'warning', writeToFile),
    error: (message, writeToFile = true) => logActivity(message, 'error', writeToFile),
    debug: (message, writeToFile = false) => {
        // Only log debug messages if in development mode
        if (process.env.NODE_ENV === 'development') {
            logActivity(message, 'debug', writeToFile);
        }
    },
    // Raw log without colors or timestamps (for special cases)
    raw: (message) => console.log(message)
};

module.exports = logger;