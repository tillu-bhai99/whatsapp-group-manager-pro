/**
 * Logger Middleware
 * Provides request logging for all API endpoints
 */

const logger = require('../utils/logger');

/**
 * Request logger middleware
 * Logs details about each incoming request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const loggerMiddleware = (req, res, next) => {
    // Get request start time
    const startTime = new Date();
    
    // Generate a unique request ID
    const requestId = Math.random().toString(36).substring(2, 15);
    
    // Get client IP address
    const clientIp = req.headers['x-forwarded-for'] || 
                    req.connection.remoteAddress || 
                    req.socket.remoteAddress || 
                    '0.0.0.0';
    
    // Attach request ID to the request object for later use
    req.requestId = requestId;
    
    // Log request details
    logger.info(`REQUEST ${requestId} : ${req.method} ${req.originalUrl} - ${clientIp}`, false);
    
    // Log request body for non-GET requests (if not too large)
    if (req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
        // Create a sanitized copy of the body for sensitive information
        const sanitizedBody = { ...req.body };
        
        // Sanitize potentially sensitive fields
        if (sanitizedBody.password) sanitizedBody.password = '[REDACTED]';
        if (sanitizedBody.token) sanitizedBody.token = '[REDACTED]';
        
        // Only log body if it's not too large
        if (JSON.stringify(sanitizedBody).length < 1000) {
            logger.info(`REQUEST ${requestId} BODY: ${JSON.stringify(sanitizedBody)}`, false);
        } else {
            logger.info(`REQUEST ${requestId} BODY: [Large body content - ${JSON.stringify(sanitizedBody).length} bytes]`, false);
        }
    }
    
    // Override response end method to log response details
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
        // Calculate request duration
        const endTime = new Date();
        const duration = endTime - startTime;
        
        // Get response status code
        const statusCode = res.statusCode;
        
        // Determine log level based on status code
        let logLevel = 'info';
        if (statusCode >= 400 && statusCode < 500) {
            logLevel = 'warn';
        } else if (statusCode >= 500) {
            logLevel = 'error';
        }
        
        // Log response details
        logger[logLevel](
            `RESPONSE ${requestId} : ${req.method} ${req.originalUrl} - ${statusCode} - ${duration}ms`,
            false
        );
        
        // Call original end method
        originalEnd.call(this, chunk, encoding);
    };
    
    next();
};

module.exports = {
    loggerMiddleware
};