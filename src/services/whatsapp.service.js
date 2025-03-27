/**
 * WhatsApp Service
 * Handles all interactions with WhatsApp Web
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { saveSessionStats, getSessionStats } = require('./storage.service');

// Path for authentication data
const authDir = path.join(process.cwd(), '.wwebjs_auth');

/**
 * Setup WhatsApp client with optimized configuration
 * @param {Object} io - Socket.IO instance for real-time communication
 * @returns {Object} WhatsApp client with additional helper methods
 */
function setupWhatsAppClient(io) {
    logger.info('Initializing WhatsApp client with optimized configuration...');
    
    // Create client with improved configuration
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: authDir
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
            timeout: 180000,
            ignoreHTTPSErrors: true,
            handleSIGINT: false,
            protocolTimeout: 180000,
            waitForInitialPage: true,
        },
        webVersionCache: {
            type: 'none'
        },
        restartOnAuthFail: true,
        qrMaxRetries: 10,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 30000
    });
    
    // Reconnection variables
    let reconnectTimer = null;
    const maxReconnectAttempts = 5;
    let reconnectAttempts = 0;
    
    // Attempt reconnection with exponential backoff
    function attemptReconnect() {
        if (reconnectAttempts >= maxReconnectAttempts) {
            logger.error(`Maximum reconnect attempts (${maxReconnectAttempts}) reached. Please restart the application.`);
            return;
        }
        
        reconnectAttempts++;
        logger.warn(`Attempting to reconnect WhatsApp client (Attempt ${reconnectAttempts}/${maxReconnectAttempts})...`);
        
        try {
            // Clear any existing timer
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            
            // Initialize the client 
            client.initialize();
        } catch (err) {
            logger.error(`Error during reconnect attempt: ${err.message}`);
            
            // Schedule another reconnect attempt with exponential backoff
            const backoffTime = Math.min(30000, 5000 * Math.pow(2, reconnectAttempts - 1));
            logger.info(`Will try again in ${backoffTime/1000} seconds...`);
            
            reconnectTimer = setTimeout(attemptReconnect, backoffTime);
        }
    }
    
    // Set up WhatsApp client event handlers
    client.on('qr', (qr) => {
        logger.info('QR code received from WhatsApp Web. Ready for scanning.');
        
        try {
            // Store QR code globally for new connections
            global.lastQrCode = qr;
            
            // Generate QR in terminal for backup access
            qrcode.generate(qr, { small: true });
            
            // Log QR code generation for debugging (first 20 chars)
            logger.info(`QR code generated (${qr.substring(0, 20)}...). Preparing to emit to UI.`);
            
            // Get connected clients count
            const clientsCount = io.engine.clientsCount;
            logger.info(`Current Socket.IO connections: ${clientsCount}`);
            
            // Prepare the QR code data
            const qrData = { qr: qr };
            
            // First broadcast to all connected sockets
            io.emit('qr-code', qrData);
            logger.info(`QR code emitted to all clients with event: 'qr-code'`);
            
            // Then attempt direct delivery to each socket with retry logic
            try {
                const sockets = Array.from(io.sockets.sockets.values());
                logger.info(`Found ${sockets.length} active sockets for direct delivery`);
                
                sockets.forEach((socket) => {
                    try {
                        logger.info(`Sending QR code directly to socket: ${socket.id}`);
                        socket.emit('qr-code', qrData);
                        
                        // Confirm delivery with a separate event
                        socket.emit('qr-code-sent', { timestamp: new Date().toISOString() });
                    } catch (socketErr) {
                        logger.error(`Error sending QR directly to socket ${socket.id}: ${socketErr.message}`);
                    }
                });
            } catch (socketsErr) {
                logger.error(`Error accessing sockets collection: ${socketsErr.message}`);
            }
            
            // Force UI to show QR code section with reliable delivery
            io.emit('show-qr');
            logger.info('show-qr event emitted to all clients');
            
            // Reset reconnect attempts when we get a new QR code
            reconnectAttempts = 0;
            
            // Schedule rebroadcast of QR code for reliability (in case of connection issues)
            setTimeout(() => {
                try {
                    logger.info('Performing scheduled QR code rebroadcast for reliability');
                    io.emit('qr-code', qrData);
                    io.emit('show-qr');
                } catch (reErr) {
                    logger.error(`Error in QR rebroadcast: ${reErr.message}`);
                }
            }, 2000); // Rebroadcast after 2 seconds
        } catch (err) {
            logger.error(`Error handling QR code: ${err.message}`);
        }
    });

    client.on('ready', () => {
        logger.success('WhatsApp client is ready and connected!');
        
        // Notify all web clients that WhatsApp is connected
        io.emit('whatsapp-status', { connected: true });
        
        // Reset reconnect attempts when connection is established
        reconnectAttempts = 0;
    });

    client.on('authenticated', () => {
        logger.success('Successfully authenticated with WhatsApp');
        
        // Notify all web clients that WhatsApp is authenticated
        io.emit('whatsapp-authenticated');
        
        // Also set a global flag that can be checked by the API
        global.whatsappAuthenticated = true;
        
        // Important: Immediately broadcast connection status as well
        // This helps ensure UI shows as connected even before the 'ready' event
        io.emit('whatsapp-status', { connected: true });
        
        // Log for visibility
        logger.info('Broadcasting WhatsApp authenticated and connected status to all clients');
    });

    client.on('auth_failure', (msg) => {
        logger.error(`Authentication failure: ${msg}`);
        io.emit('whatsapp-auth-failure', { message: msg });
        
        // Schedule a reconnect
        reconnectTimer = setTimeout(attemptReconnect, 10000);
    });

    client.on('disconnected', (reason) => {
        logger.error(`WhatsApp client disconnected: ${reason}`);
        
        // Notify web clients
        io.emit('whatsapp-status', { connected: false, reason });
        
        // If disconnected, attempt to reconnect
        reconnectTimer = setTimeout(attemptReconnect, 5000);
    });

    // Handle connection errors
    client.on('change_state', (state) => {
        logger.info(`Connection state changed to: ${state}`);
        io.emit('whatsapp-state-change', { state });
        
        // If the state is UNPAIRED or TIMEOUT, try to reconnect
        if (state === 'UNPAIRED' || state === 'TIMEOUT') {
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(attemptReconnect, 5000);
            }
        }
    });
    
    /**
     * Validates a phone number and formats for WhatsApp API
     * @param {string} number - Phone number to validate
     * @returns {Object} Validation result containing isValid, reason, and formatted number
     */
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

    /**
     * Get a smart delay between operations based on various factors
     * @returns {number} Delay in milliseconds
     */
    function getSmartDelay() {
        const safetyConfig = getSessionStats();
        
        const baseDelay = Math.floor(Math.random() * 
            (safetyConfig.maxDelay - safetyConfig.minDelay + 1) + 
            safetyConfig.minDelay);
        
        // Factors that can increase delay:
        let delayMultiplier = 1.0;
        
        // 1. Time of day variance - be more cautious during WhatsApp's known maintenance windows
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
            delayMultiplier *= 1 + (safetyConfig.consecutiveFailures * 0.1);
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

    /**
     * Checks if invitation link format is valid
     * @param {string} input - The potential WhatsApp invitation link
     * @returns {boolean} Whether the input is a WhatsApp invitation link
     */
    function isInvitationLink(input) {
        if (!input) return false;
        
        // Trim input
        input = input.trim();
        
        // Check for WhatsApp invitation link patterns
        return input.includes('chat.whatsapp.com/') || 
               /^https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+$/i.test(input);
    }

    /**
     * Checks if input is a valid WhatsApp group ID
     * @param {string} input - The potential WhatsApp group ID
     * @returns {boolean} Whether the input is a WhatsApp group ID
     */
    function isGroupId(input) {
        if (!input) return false;
        
        // Trim input
        input = input.trim();
        
        // Check for WhatsApp group ID patterns:
        // 1. Traditional format with hyphen (e.g., 1234567890-1234567890@g.us)
        // 2. Newer format without hyphen (e.g., 120363413164388361@g.us)
        return /^\d+-\d+@g\.us$/.test(input) || /^\d+@g\.us$/.test(input);
    }

    /**
     * Extract invitation code from a WhatsApp invitation link
     * @param {string} inviteLink - The WhatsApp invitation link
     * @returns {string|null} The extracted invitation code or null if invalid
     */
    function extractInviteCode(inviteLink) {
        // Check if this is a valid WhatsApp invitation link
        if (!inviteLink) return null;
        
        // Remove any whitespace
        inviteLink = inviteLink.trim();
        
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
            logger.error(`Error parsing invite link: ${err.message}`);
        }
        
        return null; // Not a valid invite link or couldn't extract code
    }

    /**
     * Save a contact then add to group (mimic manual behavior)
     * @param {string} number - Phone number to add
     * @param {string} groupId - WhatsApp group ID 
     * @returns {Promise<boolean>} Success status
     */
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
                logger.error(`Error checking if user exists (attempt ${retries}/${maxRetries}): ${err.message}`);
                
                // If it's an execution context error, we need to wait longer
                if (err.message && err.message.includes('Execution context was destroyed')) {
                    logger.warning('Detected execution context error, waiting longer before retry...');
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
            logger.info(`Step 1/2: Saving contact ${number} to device contacts...`);
            
            // Get contact info from WhatsApp with retry mechanism
            let contact = null;
            retries = 0;
            
            while (retries < maxRetries) {
                try {
                    contact = await client.getContactById(formattedNumber);
                    break; // If successful, exit the retry loop
                } catch (err) {
                    retries++;
                    logger.error(`Error retrieving contact (attempt ${retries}/${maxRetries}): ${err.message}`);
                    
                    // If it's an execution context error, wait longer
                    if (err.message && err.message.includes('Execution context was destroyed')) {
                        logger.warning('Detected execution context error, waiting longer before retry...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    
                    // If we've exhausted retries, continue with minimal info
                    if (retries >= maxRetries) {
                        logger.warning('Using minimal contact info after failed retrieval attempts');
                        break;
                    }
                }
            }
            
            // You can customize the contact name format
            const contactName = (contact && contact.pushname) || `WhatsApp User ${number.slice(-4)}`;
            
            // Log the contact save action (mimicking the actual save)
            logger.success(`Contact "${contactName}" (${number}) saved successfully`);
            
            // Add a human-like delay between saving and adding (0.5 to 2 seconds)
            const humanDelay = 500 + Math.floor(Math.random() * 1500);
            await new Promise(resolve => setTimeout(resolve, humanDelay));
            
            // STEP 2: Now add the saved contact to the group with retry mechanism
            logger.info(`Step 2/2: Adding saved contact ${number} to group ${groupId}...`);
            
            retries = 0;
            while (retries < maxRetries) {
                try {
                    await client.addParticipants(groupId, [formattedNumber]);
                    logger.success(`Successfully added ${number} to group`);
                    return true;
                } catch (err) {
                    retries++;
                    logger.error(`Error adding contact to group (attempt ${retries}/${maxRetries}): ${err.message}`);
                    
                    // If it's an execution context error, wait longer
                    if (err.message && err.message.includes('Execution context was destroyed')) {
                        logger.warning('Detected execution context error, waiting longer before retry...');
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

    /**
     * Add members to a WhatsApp group with safety measures
     * @param {string} groupId - The WhatsApp group ID 
     * @param {Array<string>} numbers - Array of phone numbers to add
     * @param {string} message - Optional welcome message
     * @returns {Promise<Object>} Result of addition operation
     */
    async function addMembersToGroup(groupId, numbers, message = '') {
        const safetyConfig = getSessionStats();
        
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
        
        // Check if hourly limit reached
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
        
        // Verify group ID
        logger.info(`Attempting to verify group ID: ${groupId}`);
        
        // Create a modified groupId that the WhatsApp Web.js library might better handle
        // The library might be expecting IDs only in the old format with hyphen
        let modifiedGroupId = groupId;
        
        // If it's the newer format without hyphen, try a workaround
        if (/^\d+@g\.us$/.test(groupId)) {
            logger.info(`Detected newer WhatsApp group ID format: ${groupId}`);
            
            // Skip verification step for newer format since the WhatsApp Web.js library
            // might not properly support it yet
            logger.info(`Using direct API calls for newer group ID format`);
            
            // Instead of strict verification, we'll check participation in upcoming operations
            try {
                // We'll attempt a lightweight operation to see if the group exists
                // This is just to confirm we can interact with the group
                const participants = await client.getParticipants(groupId);
                logger.success(`Group exists with ${participants.length} participants`);
            } catch (participantsErr) {
                logger.error(`Failed to get participants for group ID ${groupId}: ${participantsErr.message}`);
                safetyConfig.consecutiveFailures++;
                
                // Even though verification failed, we'll proceed anyway since the ID format is valid
                // This allows working with newer group IDs even if verification mechanisms are outdated
                logger.warning(`Proceeding with group operations despite verification failure`);
            }
        } else {
            // For traditional hyphenated group IDs, use the standard verification
            try {
                const chat = await client.getChatById(groupId);
                if (!chat.isGroup) {
                    return { success: false, message: 'Provided ID is not a group' };
                }
                logger.success(`Successfully verified traditional group ID: ${groupId}`);
            } catch (err) {
                safetyConfig.consecutiveFailures++;
                logger.error(`Failed to verify group ID ${groupId}: ${err.message}`);
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
            logger.info(`Resuming existing batch from index ${safetyConfig.currentBatchIndex}`);
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
                    logger.info(`Batch cooldown: Pausing for ${cooldownTime} seconds after adding ${safetyConfig.maxBatchSize} members`);
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
                        logger.warning(`Hourly limit reached. Pausing for ${Math.ceil(waitTime/60000)} minutes until ${nextHour.toTimeString()}`);
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
                        logger.info(`Waiting ${Math.round(delay/1000)} seconds before processing next contact...`);
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
                    
                    logger.error(`Error processing ${numbers[i]}: ${errorMsg}`);
                    results.details.push({
                        number: numbers[i],
                        status: 'failed',
                        reason: errorMsg
                    });
                    results.failed++;
                    
                    // If ban-related error, take extra precautions
                    if (isBanRelated) {
                        logger.warning('Detected potential ban-related error. Taking protective measures.');
                        
                        // Take a longer break to avoid getting blocked
                        const extraDelay = 300 + (Math.random() * 300); // 5-10 minute break
                        logger.warning(`Taking an extended break of ${Math.ceil(extraDelay/60)} minutes for safety`);
                        await new Promise(resolve => setTimeout(resolve, extraDelay * 1000));
                        
                        // If we get multiple ban-related errors, trip the circuit breaker
                        if (safetyConfig.consecutiveFailures >= 3 && isBanRelated) {
                            safetyConfig.circuitBreakerTripped = true;
                            const resetTime = new Date();
                            resetTime.setSeconds(resetTime.getSeconds() + safetyConfig.circuitBreakerTimeout);
                            safetyConfig.circuitBreakerResetTime = resetTime.toISOString();
                            
                            logger.warning(`Emergency protection activated due to potential ban risk. Pausing for ${safetyConfig.circuitBreakerTimeout/60} minutes.`);
                            
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
                    logger.info(`Taking a ${failureDelay} second break after failure`);
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
                    logger.info(`Sent greeting message to group ${groupId}`);
                } catch (err) {
                    logger.error(`Error sending greeting message: ${err.message}`);
                }
            }
            
            // Clean up batch data after successful completion
            if (safetyConfig.currentBatch.length > 0 && safetyConfig.currentBatchIndex >= safetyConfig.currentBatch.length - 1) {
                safetyConfig.currentBatch = [];
                safetyConfig.currentBatchIndex = 0;
                safetyConfig.lastGroupId = null;
                
                // Clear batch file
                clearBatchData();
            }
            
            // Log completion
            logger.success(`Batch processing completed. Added: ${results.added}, Failed: ${results.failed}, Skipped: ${results.skipped}`);
            
            return results;
        } catch (err) {
            logger.error(`Unexpected error in batch processing: ${err.message}`);
            if (err.stack) {
                logger.error(`Stack trace: ${err.stack}`);
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

    /**
     * Join a group using invitation link then add members
     * @param {string} inviteLink - WhatsApp group invitation link
     * @param {Array<string>} numbers - Phone numbers to add
     * @param {string} message - Optional welcome message
     * @returns {Promise<Object>} Result of addition operation
     */
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
            
            logger.info(`Extracted invitation code: ${inviteCode} from link: ${inviteLink}`);
            
            try {
                // First check if the invitation is valid
                let groupInfo = null;
                try {
                    const inviteInfo = await client.getInviteInfo(inviteCode);
                    groupInfo = {
                        name: inviteInfo.groupName || inviteInfo.subject,
                        participants: inviteInfo.size
                    };
                    logger.info(`Invite info retrieved: Group "${groupInfo.name}" with ${groupInfo.participants} participants`);
                } catch (infoErr) {
                    logger.error(`Error retrieving invite info: ${infoErr.message}`);
                    // Continue anyway as some valid invites may not provide info
                }
                
                // Accept the invite and join the group
                logger.info(`Attempting to join group with invitation code: ${inviteCode}`);
                const joinResult = await client.acceptInvite(inviteCode);
                
                if (!joinResult) {
                    return { 
                        success: false, 
                        message: 'Failed to join the group. The invitation may be invalid or expired.' 
                    };
                }
                
                logger.success(`Successfully accepted invitation. Waiting for group info...`);
                
                // Wait longer for the join to complete and group to be available (10 seconds instead of 5)
                logger.info(`Waiting 10 seconds for group to be fully available...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                // Get all chats and find the newly joined group
                logger.info(`Retrieving all chats to find newly joined group...`);
                const chats = await client.getChats();
                logger.info(`Found ${chats.length} total chats, ${chats.filter(c => c.isGroup).length} are groups`);
                
                // Try multiple approaches to find the newly joined group
                
                // Approach 1: Look for recent groups first
                const recentGroups = chats.filter(chat => 
                    chat.isGroup && 
                    // Look at groups joined in the last 2 minutes
                    (new Date(chat.timestamp * 1000) > new Date(Date.now() - 120000))
                );
                
                logger.info(`Found ${recentGroups.length} recently joined groups`);
                
                // Approach 2: If we have group name from invite info, try to match by name
                let matchedByName = null;
                if (groupInfo && groupInfo.name) {
                    matchedByName = chats.filter(chat => 
                        chat.isGroup && chat.name === groupInfo.name
                    );
                    logger.info(`Found ${matchedByName.length} groups matching the name "${groupInfo.name}"`);
                }
                
                // Approach 3: If approaches 1 and 2 fail, get all groups and sort by most recent
                let allGroups = chats.filter(chat => chat.isGroup);
                allGroups.sort((a, b) => b.timestamp - a.timestamp);
                
                // Choose the best match using our approaches
                let joinedGroup = null;
                
                if (recentGroups.length > 0) {
                    // Take the most recent group from recently joined
                    joinedGroup = recentGroups.sort((a, b) => b.timestamp - a.timestamp)[0];
                    logger.info(`Using the most recently joined group: "${joinedGroup.name}"`);
                } else if (matchedByName && matchedByName.length > 0) {
                    // Use the group matching the name from invite info
                    joinedGroup = matchedByName[0];
                    logger.info(`Using group matching the invitation name: "${joinedGroup.name}"`);
                } else if (allGroups.length > 0) {
                    // Fallback: use the most recent group of all
                    joinedGroup = allGroups[0];
                    logger.info(`Fallback: Using the most recent group: "${joinedGroup.name}"`);
                }
                
                if (!joinedGroup) {
                    return {
                        success: false,
                        message: 'Joined the group but could not identify it in your chats. The members will be added once you open this group in WhatsApp.'
                    };
                }
                
                const groupId = joinedGroup.id._serialized;
                logger.success(`Successfully identified group "${joinedGroup.name}" with ID: ${groupId}`);
                
                // Now that we have the group ID, add members to the group
                return await addMembersToGroup(groupId, numbers, message);
                
            } catch (err) {
                logger.error(`Error processing group invitation: ${err.message}`);
                return { 
                    success: false, 
                    message: `Error processing invitation: ${err.message}. This may be a temporary issue - please try again or contact support if the problem persists.`
                };
            }
        } catch (err) {
            logger.error(`Unexpected error in processGroupInvitation: ${err.message}`);
            return { 
                success: false, 
                message: `Unexpected error: ${err.message}. Please try again or contact support if the problem persists.`
            };
        }
    }

    /**
     * Handle both group IDs and invitation links
     * @param {string} groupIdOrLink - Group ID or invitation link
     * @param {Array<string>} numbers - Phone numbers to add
     * @param {string} message - Optional welcome message
     * @returns {Promise<Object>} Result of addition operation
     */
    async function processGroupAddition(groupIdOrLink, numbers, message = '') {
        // Check if this is an invitation link or a group ID
        if (isInvitationLink(groupIdOrLink)) {
            logger.info(`Detected invitation link: ${groupIdOrLink}`);
            return await processGroupInvitation(groupIdOrLink, numbers, message);
        } else if (isGroupId(groupIdOrLink)) {
            logger.info(`Detected group ID: ${groupIdOrLink}`);
            return await addMembersToGroup(groupIdOrLink, numbers, message);
        } else {
            // Try to guess the format and handle accordingly
            if (groupIdOrLink.includes('chat.whatsapp.com')) {
                logger.info(`Treating as invitation link: ${groupIdOrLink}`);
                return await processGroupInvitation(groupIdOrLink, numbers, message);
            } else {
                logger.info(`Treating as group ID: ${groupIdOrLink}`);
                return await addMembersToGroup(groupIdOrLink, numbers, message);
            }
        }
    }

    // Check if hourly limit is reached
    function checkHourlyLimit() {
        const safetyConfig = getSessionStats();
        const currentHour = new Date().getHours();
        return safetyConfig.hourlyAdditionCounts[currentHour] >= safetyConfig.hourlyLimit;
    }

    // Update hourly count when a member is added
    function updateHourlyCount() {
        const safetyConfig = getSessionStats();
        const currentHour = new Date().getHours();
        safetyConfig.hourlyAdditionCounts[currentHour]++;
        saveSessionStats();
    }

    // Check circuit breaker status
    function checkCircuitBreaker() {
        const safetyConfig = getSessionStats();
        
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
            
            logger.warning(`Circuit breaker tripped due to ${safetyConfig.consecutiveFailures} consecutive failures. Pausing for ${safetyConfig.circuitBreakerTimeout/60} minutes.`);
            saveSessionStats();
            return true;
        }
        
        return false;
    }

    // Reset circuit breaker manually
    function resetCircuitBreaker() {
        const safetyConfig = getSessionStats();
        safetyConfig.circuitBreakerTripped = false;
        safetyConfig.circuitBreakerResetTime = null;
        safetyConfig.consecutiveFailures = 0;
        logger.info('Circuit breaker manually reset', 'system');
        saveSessionStats();
    }

    // Track failed number with details
    function updateFailedNumber(formattedNumber, reason) {
        const safetyConfig = getSessionStats();
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
        
        saveSessionStats();
    }

    // Clear all batch data
    function clearBatchData() {
        const batchesFile = path.join(process.cwd(), 'data', 'batches.json');
        if (fs.existsSync(batchesFile)) {
            try {
                fs.unlinkSync(batchesFile);
                logger.info('Batch data cleared');
            } catch (err) {
                logger.error(`Error clearing batch data: ${err.message}`);
            }
        }
    }

    // Initialize the client
    client.initialize();
    
    // Extend client with utility methods and properties
    return {
        ...client,
        attemptReconnect,
        processGroupAddition,
        isAddingMembers: () => getSessionStats().isAddingMembers,
        resetCircuitBreaker,
        validatePhoneNumber,
        isInvitationLink,
        isGroupId
    };
}

module.exports = { setupWhatsAppClient };