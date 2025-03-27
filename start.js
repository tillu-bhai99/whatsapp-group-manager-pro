/**
 * WhatsApp Group Manager Pro - Startup Script
 * 
 * This script serves as the entry point for the application,
 * handling initialization of the server and displaying startup information.
 */

const logger = require('./src/utils/logger');
const { app, server } = require('./server');

// Print welcome message
console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                                                                    ║
║               WHATSAPP GROUP MANAGER PRO                           ║
║                                                                    ║
║  Safe, efficient WhatsApp group member addition with anti-ban      ║
║  protection and intelligent rate limiting.                         ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
`);

// Process environment variables
const PORT = process.env.PORT || 3001;

logger.info('Starting WhatsApp Group Manager Pro...');
logger.info(`Node.js version: ${process.version}`);
logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);

// Log when server is ready
server.on('listening', () => {
  const address = server.address();
  const port = typeof address === 'string' ? address : address.port;
  
  logger.success(`
Server running on:
  → Local:    http://localhost:${port}
  → Network:  http://${getLocalIp()}:${port}
  
Ready to connect to WhatsApp and add members!
  `);
  
  // Show QR code scan instructions
  logger.info('Please open the web interface and scan the QR code with your phone to connect to WhatsApp');
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use. The application may already be running.`);
    logger.info(`Try accessing http://localhost:${PORT} in your browser or check running processes.`);
    process.exit(1);
  } else {
    logger.error(`Server error: ${error.message}`);
  }
});

// Helper function to get local IP address
function getLocalIp() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip internal and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  
  return '127.0.0.1'; // Fallback to localhost
}

// Handle graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  logger.info('Shutdown signal received, closing server gracefully...');
  
  server.close(() => {
    logger.info('Server closed successfully');
    process.exit(0);
  });
  
  // Force close after 5 seconds if server doesn't close gracefully
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 5000);
}