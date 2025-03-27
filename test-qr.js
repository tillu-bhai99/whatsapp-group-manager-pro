const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Path for auth data
// Create a dedicated test auth directory that doesn't conflict with main app
const authDir = path.join(__dirname, '.wwebjs_auth_test_only');

// Clean auth directory if it exists to force new QR
if (fs.existsSync(authDir)) {
    try {
        console.log('Cleaning auth directory to force new QR code...');
        fs.rmSync(authDir, { recursive: true, force: true });
    } catch (err) {
        console.log(`Error cleaning auth directory: ${err.message}`);
    }
}

// Initialize the client with minimal configuration
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: authDir  // Use a different auth path for testing
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ],
        defaultViewport: null
    }
});

// QR code event handler - prints QR directly to terminal
client.on('qr', (qr) => {
    console.log('QR CODE RECEIVED!');
    console.log('------------------------');
    qrcode.generate(qr, { small: true });
    console.log('------------------------');
    console.log('Scan this QR code with WhatsApp to login');
});

// Ready event handler
client.on('ready', () => {
    console.log('WhatsApp client is ready and connected!');
    console.log('You can now close this test (Ctrl+C)');
});

// Authentication event handler
client.on('authenticated', () => {
    console.log('Successfully authenticated with WhatsApp');
});

// Authentication failure event handler
client.on('auth_failure', (msg) => {
    console.log(`Authentication failure: ${msg}`);
});

// Initialize the client
console.log('Initializing WhatsApp Web.js...');
console.log('Please wait for the QR code to appear...');
client.initialize();

console.log('Test script running. Waiting for events...');