/**
 * Error Handling Middleware
 * Provides consistent error responses across the application
 */

const logger = require('../utils/logger');

/**
 * Default error handling middleware
 * Provides consistent error responses for all routes
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const errorHandler = (err, req, res, next) => {
    // Log the error
    logger.error(`API Error: ${err.message}`);
    if (err.stack) {
        logger.error(`Stack trace: ${err.stack}`);
    }
    
    // Determine status code based on error type
    const statusCode = err.status || err.statusCode || 500;
    
    // Create formatted error response
    const errorResponse = {
        success: false,
        message: err.message || 'Internal Server Error',
        code: err.code || 'SERVER_ERROR'
    };
    
    // Add validation errors if available
    if (err.errors) {
        errorResponse.errors = err.errors;
    }
    
    // Return error response to client
    res.status(statusCode).json(errorResponse);
};

/**
 * Not found middleware for handling 404 errors
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const notFound = (req, res) => {
    logger.warn(`Route not found: ${req.method} ${req.originalUrl}`);
    
    res.status(404).json({
        success: false,
        message: `Route not found: ${req.method} ${req.originalUrl}`,
        code: 'NOT_FOUND'
    });
};

/**
 * Validation error middleware
 * Used with express-validator for request validation
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const validationError = (req, res, next) => {
    const { validationErrors } = req;
    
    if (validationErrors && validationErrors.length > 0) {
        const error = new Error('Validation error');
        error.status = 400;
        error.code = 'VALIDATION_ERROR';
        error.errors = validationErrors;
        
        return next(error);
    }
    
    next();
};

/**
 * Create a custom error with status code and optional error code
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code
 * @param {string} code - Error code for client
 * @returns {Error} Custom error object
 */
const createError = (message, statusCode = 500, code = null) => {
    const error = new Error(message);
    error.status = statusCode;
    
    if (code) {
        error.code = code;
    }
    
    return error;
};

module.exports = {
    errorHandler,
    notFound,
    validationError,
    createError
};