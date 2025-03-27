/**
 * API Routes
 * Defines all API endpoints and their handlers
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const csvParser = require('csv-parser');
const { createError } = require('../middleware/error.middleware');
const { getSessionStats, updateSessionStats, clearFailedNumbers, getFailedNumbers, getLogDates, getLogs } = require('../services/storage.service');
const logger = require('../utils/logger');

/**
 * Initialize API routes with WhatsApp client and Socket.IO instance
 * @param {Object} whatsappClient - WhatsApp client instance
 * @param {Object} io - Socket.IO instance
 * @returns {express.Router} Configured router
 */
function apiRoutes(whatsappClient, io) {
    const router = express.Router();
    
    /**
     * @route GET /api/status
     * @description Get current status of the WhatsApp client and session
     * @access Public
     */
    router.get('/status', (req, res) => {
        const sessionStats = getSessionStats();
        const currentHour = new Date().getHours();
        
        // Check if circuit breaker wait time has elapsed
        if (sessionStats.circuitBreakerTripped && sessionStats.circuitBreakerResetTime) {
            const resetTime = new Date(sessionStats.circuitBreakerResetTime);
            if (new Date() > resetTime) {
                // Reset circuit breaker
                updateSessionStats({
                    circuitBreakerTripped: false,
                    circuitBreakerResetTime: null,
                    consecutiveFailures: 0
                });
                logger.info('Circuit breaker automatically reset after timeout period');
            }
        }
        
        res.json({
            success: true,
            clientReady: whatsappClient.info !== undefined,
            dailyLimit: sessionStats.dailyLimit,
            addedToday: sessionStats.addedToday,
            remaining: Math.max(0, sessionStats.dailyLimit - sessionStats.addedToday),
            hourlyLimit: sessionStats.hourlyLimit,
            hourlyAdded: sessionStats.hourlyAdditionCounts[currentHour],
            hourlyRemaining: Math.max(0, sessionStats.hourlyLimit - sessionStats.hourlyAdditionCounts[currentHour]),
            status: sessionStats.userStatus,
            protectionMode: sessionStats.circuitBreakerTripped,
            protectionResetTime: sessionStats.circuitBreakerResetTime,
            currentBatchSize: sessionStats.currentBatch.length,
            currentBatchProgress: sessionStats.currentBatchIndex,
            consecutiveFailures: sessionStats.consecutiveFailures
        });
    });
    
    /**
     * @route POST /api/reset-protection
     * @description Manually reset circuit breaker protection
     * @access Public
     */
    router.post('/reset-protection', (req, res) => {
        if (whatsappClient && typeof whatsappClient.resetCircuitBreaker === 'function') {
            whatsappClient.resetCircuitBreaker();
        } else {
            // Fallback to direct state update
            updateSessionStats({
                circuitBreakerTripped: false,
                circuitBreakerResetTime: null,
                consecutiveFailures: 0
            });
            logger.info('Circuit breaker manually reset');
        }
        
        res.json({
            success: true,
            message: 'Protection mode disabled'
        });
    });
    
    /**
     * @route POST /api/add-members
     * @description Add members to WhatsApp group
     * @access Public
     */
    router.post('/add-members', [
        body('groupId').notEmpty().withMessage('Group ID is required'),
        body('numbers').isArray().withMessage('Numbers must be an array'),
        body('numbers.*').matches(/^\d+$/).withMessage('Invalid phone number format'),
        body('message').optional().isString().withMessage('Message must be a string')
    ], async (req, res, next) => {
        try {
            // Check for validation errors
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Validation error',
                    errors: errors.array() 
                });
            }
            
            const { groupId, numbers, message } = req.body;
            
        // Check WhatsApp client status - use both info and authentication flag
        if (!whatsappClient.info && !global.whatsappAuthenticated) {
            return res.status(503).json({ 
                success: false, 
                message: 'WhatsApp not connected. Please scan the QR code first.' 
            });
        }
            
            // Validate group ID format
            if (!whatsappClient.isGroupId(groupId) && !whatsappClient.isInvitationLink(groupId)) {
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
            const result = await whatsappClient.processGroupAddition(groupId, numbers, message);
            res.json(result);
            
        } catch (err) {
            next(err);
        }
    });
    
    /**
     * @route POST /api/upload-csv
     * @description Upload and parse CSV file with phone numbers
     * @access Public
     */
    router.post('/upload-csv', async (req, res, next) => {
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
            
            // Create temporary file path
            const fs = require('fs');
            const path = require('path');
            const uploadPath = path.join(process.cwd(), 'data', csvFile.name);
            
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
    
    /**
     * @route POST /api/resume-batch
     * @description Resume interrupted batch process
     * @access Public
     */
    router.post('/resume-batch', async (req, res, next) => {
        try {
            const sessionStats = getSessionStats();
            
            if (sessionStats.isAddingMembers) {
                return res.status(409).json({ 
                    success: false, 
                    message: 'Already adding members to a group' 
                });
            }
            
            if (!sessionStats.currentBatch || sessionStats.currentBatch.length === 0 || !sessionStats.lastGroupId) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'No interrupted batch found to resume' 
                });
            }
            
            const remainingNumbers = sessionStats.currentBatch.slice(sessionStats.currentBatchIndex);
            
            logger.info(`Resuming batch with ${remainingNumbers.length} remaining numbers for group ${sessionStats.lastGroupId}`);
            
            const result = await whatsappClient.processGroupAddition(
                sessionStats.lastGroupId, 
                sessionStats.currentBatch
            );
            
            res.json(result);
            
        } catch (err) {
            next(err);
        }
    });
    
    /**
     * @route GET /api/failed-numbers
     * @description Get list of failed phone numbers
     * @access Public
     */
    router.get('/failed-numbers', (req, res) => {
        const failedNumbers = getFailedNumbers();
        
        res.json({
            success: true,
            count: failedNumbers.length,
            failedNumbers
        });
    });
    
    /**
     * @route POST /api/clear-failed-numbers
     * @description Clear failed numbers list
     * @access Public
     */
    router.post('/clear-failed-numbers', (req, res) => {
        clearFailedNumbers();
        
        res.json({
            success: true,
            message: 'Failed numbers list cleared'
        });
    });
    
    /**
     * @route POST /api/config
     * @description Update application configuration
     * @access Public
     */
    router.post('/config', [
        body('dailyLimit').optional().isInt({ min: 1, max: 50000 }),
        body('hourlyLimit').optional().isInt({ min: 1, max: 5000 }),
        body('maxBatchSize').optional().isInt({ min: 10, max: 5000 }),
        body('minDelay').optional().isInt({ min: 10, max: 300 }),
        body('maxDelay').optional().isInt({ min: 20, max: 600 }),
        body('patternVariation').optional().isBoolean()
    ], (req, res, next) => {
        try {
            // Check for validation errors
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Validation error',
                    errors: errors.array() 
                });
            }
            
            const sessionStats = getSessionStats();
            const updates = {};
            
            // Update only provided fields
            if (req.body.dailyLimit) updates.dailyLimit = parseInt(req.body.dailyLimit);
            if (req.body.hourlyLimit) updates.hourlyLimit = parseInt(req.body.hourlyLimit);
            if (req.body.maxBatchSize) updates.maxBatchSize = parseInt(req.body.maxBatchSize);
            if (req.body.minDelay) updates.minDelay = parseInt(req.body.minDelay);
            if (req.body.maxDelay) updates.maxDelay = parseInt(req.body.maxDelay);
            if (req.body.patternVariation !== undefined) updates.patternVariation = req.body.patternVariation;
            
            // Validate that minDelay is less than maxDelay
            if (updates.minDelay && updates.maxDelay && updates.minDelay >= updates.maxDelay) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum delay must be less than maximum delay'
                });
            } else if (updates.minDelay && !updates.maxDelay && updates.minDelay >= sessionStats.maxDelay) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum delay must be less than maximum delay'
                });
            } else if (!updates.minDelay && updates.maxDelay && sessionStats.minDelay >= updates.maxDelay) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum delay must be less than maximum delay'
                });
            }
            
            // Update session stats
            updateSessionStats(updates);
            
            // Broadcast updated stats to all clients
            if (io && typeof io.broadcastStats === 'function') {
                io.broadcastStats(getSessionStats());
            }
            
            res.json({
                success: true,
                message: 'Configuration updated successfully',
                config: {
                    dailyLimit: getSessionStats().dailyLimit,
                    hourlyLimit: getSessionStats().hourlyLimit,
                    maxBatchSize: getSessionStats().maxBatchSize,
                    minDelay: getSessionStats().minDelay,
                    maxDelay: getSessionStats().maxDelay,
                    patternVariation: getSessionStats().patternVariation
                }
            });
            
        } catch (err) {
            next(err);
        }
    });
    
    /**
     * @route GET /api/logs
     * @description Get application logs for a specific date
     * @access Public
     */
    router.get('/logs', (req, res) => {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const logs = getLogs(date);
        
        res.json({
            success: true,
            logs,
            date
        });
    });
    
    /**
     * @route GET /api/log-dates
     * @description Get available log dates
     * @access Public
     */
    router.get('/log-dates', (req, res) => {
        const dates = getLogDates();
        
        res.json({
            success: true,
            dates
        });
    });
    
    return router;
}

module.exports = apiRoutes;