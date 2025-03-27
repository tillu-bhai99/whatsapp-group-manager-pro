/**
 * WhatsApp Pro Group Adder
 * Secure and efficient WhatsApp group member addition tool
 * with advanced anti-ban protection
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const { setupSocketIO } = require('./src/services/socket.service');
const { setupWhatsAppClient } = require('./src/services/whatsapp.service');
const { initializeDataStorage } = require('./src/services/storage.service');
const { errorHandler } = require('./src/middleware/error.middleware');
const { loggerMiddleware } = require('./src/middleware/logger.middleware');
const apiRoutes = require('./src/routes/api.routes');
const logger = require('./src/utils/logger');

// Set process title for better identification
process.title = 'whatsapp-pro-adder';

// Initialize Express app
const app = express();

// Define port - use environment variable or default to 3001
const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Setup middleware
app.use(helmet({ contentSecurityPolicy: false })); // Disable CSP for QR code generation
app.use(cors());
app.use(loggerMiddleware);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max file size
    abortOnLimit: true
}));

// Set up rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
app.use('/api', limiter);

// Initialize data storage
initializeDataStorage();

// Socket.IO setup with comprehensive configuration for reliable connections
const io = setupSocketIO(server);

// Set up WhatsApp client
const whatsappClient = setupWhatsAppClient(io);

// Configure routes with dependency injection
app.use('/api', apiRoutes(whatsappClient, io));

// API documentation route
app.get('/api/docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
});

// Error handling middleware
app.use(errorHandler);

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
                    logger.warn(`Port ${port} is already in use, trying port ${port + 1}...`);
                    tryPort(port + 1);
                } else {
                    logger.error(`Could not find available port after ${maxPortAttempts} attempts`);
                }
            } else {
                logger.error(`Error testing port ${port}: ${err.message}`);
            }
        });
        
        testServer.once('listening', () => {
            // Found an available port, close test server and start actual server
            testServer.close();
            
            server.listen(port, () => {
                logger.success(`Server running on http://localhost:${port}`);
            });
        });
        
        // Test if port is available
        testServer.listen(port);
    }
    
    // Start the port finding process
    tryPort(currentPort);
    
    return server;
}

// Global error handler for uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    if (err.stack) {
        logger.error(`Stack trace: ${err.stack}`);
    }
    
    // If the error is related to Puppeteer or browser context
    if (err.message.includes('Execution context was destroyed') || 
        err.message.includes('Protocol error') ||
        err.message.includes('Target closed') ||
        err.message.includes('Session closed')) {
        
        logger.warn('Error appears to be related to Puppeteer browser context. Attempting recovery...');
        
        // Signal WhatsApp service to attempt reconnection
        if (whatsappClient && typeof whatsappClient.attemptReconnect === 'function') {
            whatsappClient.attemptReconnect();
        }
    }
    
    // We don't exit the process - let the application continue running
    logger.info('Application will continue running despite the error');
});

// Handling promise rejections 
process.on('unhandledRejection', (reason, promise) => {
    logger.error(`UNHANDLED REJECTION: ${reason}`);
    
    // Log additional details if available
    if (reason instanceof Error) {
        if (reason.stack) {
            logger.error(`Stack trace: ${reason.stack}`);
        }
        
        // Handle specific WhatsApp/Puppeteer errors
        if (reason.message && (
            reason.message.includes('Execution context was destroyed') || 
            reason.message.includes('Protocol error') ||
            reason.message.includes('Target closed') ||
            reason.message.includes('Session closed'))) {
            
            logger.warn('Error appears to be related to Puppeteer/WhatsApp connection. Attempting recovery...');
            
            // Attempt to reconnect after a short delay
            if (whatsappClient && typeof whatsappClient.attemptReconnect === 'function') {
                setTimeout(() => whatsappClient.attemptReconnect(), 5000);
            }
        }
    }
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
    logger.info('Shutdown signal received. Closing gracefully...');
    try {
        if (whatsappClient && typeof whatsappClient.destroy === 'function') {
            await whatsappClient.destroy();
            logger.info('WhatsApp client destroyed successfully');
        }
    } catch (err) {
        logger.error(`Error during shutdown: ${err.message}`);
    }
    
    // Save any pending data
    try {
        if (typeof saveAllData === 'function') {
            saveAllData();
            logger.info('Session data saved');
        }
    } catch (err) {
        logger.error(`Error saving session data: ${err.message}`);
    }
    
    logger.info('Shutdown complete. Exiting process.');
    process.exit(0);
});

// Start the server
startServer(PORT);

module.exports = { app, server };