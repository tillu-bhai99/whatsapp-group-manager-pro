/**
 * Socket.IO Service
 * Handles real-time communication between server and clients
 */

const socketIo = require('socket.io');
const logger = require('../utils/logger');

/**
 * Set up Socket.IO with comprehensive configuration for reliable connections
 * @param {Object} server - HTTP server instance
 * @returns {Object} Configured Socket.IO instance
 */
function setupSocketIO(server) {
    logger.info('Initializing Socket.IO with enhanced configuration');
    
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
    
    // Debug Socket.IO connections with comprehensive event logging
    io.engine.on("connection_error", (err) => {
        logger.error(`Socket.IO connection error: ${err.code} ${err.message} ${err.context}`);
    });
    
    // Track connection events at the engine level
    io.engine.on("connection", (socket) => {
        logger.info(`Socket.IO engine new connection established: ${socket.id}`);
    });
    
    // Track server-level events
    io.on("connect_error", (err) => {
        logger.error(`Socket.IO server connection error: ${err.message}`);
    });
    
    io.on("new_namespace", (namespace) => {
        logger.info(`Socket.IO namespace created: ${namespace.name}`);
    });
    
    // Enhanced Socket.IO setup with comprehensive connection management
    io.on('connection', (socket) => {
        const clientIP = socket.handshake.headers['x-forwarded-for'] || 
                        socket.handshake.address;
        
        logger.info(`New client connected to web interface - ID: ${socket.id}, IP: ${clientIP}`);
        
        // Immediately confirm connection to the client
        socket.emit('socket-connected', { 
            socketId: socket.id, 
            timestamp: new Date().toISOString(),
            serverTime: new Date().toString()
        });

        // If QR code was previously generated, send it to this new client
        if (global.lastQrCode) {
            logger.info(`Sending cached QR code to new client ${socket.id}`);
            socket.emit('qr-code', { qr: global.lastQrCode });
            socket.emit('show-qr');
        }
        
        // Enhanced socket event error handling
        socket.on('error', (error) => {
            logger.error(`Socket ${socket.id} error: ${error.message}`);
        });
        
        socket.on('connect_error', (error) => {
            logger.error(`Socket ${socket.id} connect error: ${error.message}`);
        });
        
        socket.on('connect_timeout', () => {
            logger.error(`Socket ${socket.id} connect timeout`);
        });
        
        // Handle QR code refresh request from the frontend
        socket.on('request-qr-refresh', () => {
            logger.info(`Client ${socket.id} requested QR code refresh`);
            
            // Broadcast to all clients that we're getting a new QR code
            io.emit('awaiting-qr');
            
            // This event will be handled by whatsapp.service.js to generate a new QR code
        });
        
        socket.on('disconnect', () => {
            logger.info(`Client ${socket.id} disconnected from web interface`);
        });
    });
    
    /**
     * Broadcast WhatsApp connection status to all clients
     * @param {boolean} connected - Connection status
     * @param {string} reason - Reason for disconnection (if disconnected)
     */
    io.broadcastConnectionStatus = function(connected, reason = null) {
        const statusData = { connected };
        if (reason) statusData.reason = reason;
        
        io.emit('whatsapp-status', statusData);
        logger.info(`Broadcasting WhatsApp status: ${connected ? 'Connected' : 'Disconnected'}`);
    };
    
    /**
     * Update all clients with current stats
     * @param {Object} stats - Current session stats
     */
    io.broadcastStats = function(stats) {
        io.emit('stats-update', {
            addedToday: stats.addedToday,
            dailyLimit: stats.dailyLimit,
            hourlyAdded: stats.hourlyAdditionCounts[new Date().getHours()],
            hourlyLimit: stats.hourlyLimit,
            protectionMode: stats.circuitBreakerTripped,
            protectionResetTime: stats.circuitBreakerResetTime
        });
    };
    
    /**
     * Broadcast batch progress to all clients
     * @param {Object} batchData - Current batch progress data
     */
    io.broadcastBatchProgress = function(batchData) {
        io.emit('batch-progress', batchData);
    };
    
    /**
     * Send direct message to a specific client
     * @param {string} socketId - Target socket ID
     * @param {string} event - Event name
     * @param {Object} data - Event data
     * @returns {boolean} Success status
     */
    io.sendToClient = function(socketId, event, data) {
        try {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.emit(event, data);
                return true;
            }
            return false;
        } catch (err) {
            logger.error(`Error sending to client ${socketId}: ${err.message}`);
            return false;
        }
    };
    
    // Return the enhanced io instance
    return io;
}

module.exports = { setupSocketIO };