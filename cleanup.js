#!/usr/bin/env node

/**
 * WhatsApp Group Manager Pro - Cleanup Script
 * 
 * This script helps transition from the old application structure
 * to the new modular architecture by:
 * 
 * 1. Creating backups of important data
 * 2. Removing deprecated files
 * 3. Ensuring all required directories exist
 * 
 * Usage: node cleanup.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const BACKUP_DIR = path.join(process.cwd(), 'backups', `backup-${new Date().toISOString().replace(/:/g, '-')}`);
const DATA_DIR = path.join(process.cwd(), 'data');

// Files to be backed up (critical user data)
const IMPORTANT_DATA_FILES = [
    path.join(DATA_DIR, 'batches.json'),
    path.join(DATA_DIR, 'failed-numbers.json'),
    path.join(DATA_DIR, 'session-stats.json')
];

// Directories to ensure exist in the new structure
const REQUIRED_DIRS = [
    path.join(process.cwd(), 'src'),
    path.join(process.cwd(), 'src', 'services'),
    path.join(process.cwd(), 'src', 'middleware'),
    path.join(process.cwd(), 'src', 'routes'),
    path.join(process.cwd(), 'src', 'utils'),
    path.join(DATA_DIR),
    path.join(DATA_DIR, 'logs')
];

// Files that are no longer needed and should be removed
const DEPRECATED_FILES = [
    path.join(process.cwd(), 'index.js'),
    path.join(process.cwd(), 'test-qr.js'),
    path.join(process.cwd(), 'public', 'new-index.html') // Since we've replaced the main index.html
];

/**
 * Creates a directory if it doesn't exist
 * @param {string} dir - Directory path
 */
function ensureDirectoryExists(dir) {
    if (!fs.existsSync(dir)) {
        console.log(`Creating directory: ${dir}`);
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Creates a backup of important data files
 */
function backupImportantData() {
    console.log('\n=== Backing up important data ===');
    ensureDirectoryExists(BACKUP_DIR);

    IMPORTANT_DATA_FILES.forEach(file => {
        if (fs.existsSync(file)) {
            const backupPath = path.join(BACKUP_DIR, path.basename(file));
            console.log(`Backing up: ${file} → ${backupPath}`);
            fs.copyFileSync(file, backupPath);
        } else {
            console.log(`File not found, skipping backup: ${file}`);
        }
    });

    // Also backup the logs directory
    const logsDir = path.join(DATA_DIR, 'logs');
    if (fs.existsSync(logsDir)) {
        const backupLogsDir = path.join(BACKUP_DIR, 'logs');
        ensureDirectoryExists(backupLogsDir);
        
        const logFiles = fs.readdirSync(logsDir);
        logFiles.forEach(logFile => {
            const sourcePath = path.join(logsDir, logFile);
            const destPath = path.join(backupLogsDir, logFile);
            console.log(`Backing up log: ${sourcePath} → ${destPath}`);
            fs.copyFileSync(sourcePath, destPath);
        });
    }

    console.log(`✅ Backup completed: ${BACKUP_DIR}`);
}

/**
 * Ensures all required directories exist
 */
function ensureDirectories() {
    console.log('\n=== Ensuring required directories exist ===');
    REQUIRED_DIRS.forEach(dir => {
        ensureDirectoryExists(dir);
    });
    console.log('✅ All required directories are in place');
}

/**
 * Removes deprecated files
 */
function removeDeprecatedFiles() {
    console.log('\n=== Removing deprecated files ===');
    DEPRECATED_FILES.forEach(file => {
        if (fs.existsSync(file)) {
            console.log(`Removing: ${file}`);
            fs.unlinkSync(file);
        } else {
            console.log(`File not found, skipping: ${file}`);
        }
    });
    console.log('✅ Removed all deprecated files');
}

/**
 * Main cleanup function
 */
function cleanup() {
    console.log('🧹 Starting WhatsApp Group Manager Pro cleanup...');
    
    try {
        // Step 1: Create backup of important data
        backupImportantData();
        
        // Step 2: Ensure all required directories exist
        ensureDirectories();
        
        // Step 3: Remove deprecated files
        removeDeprecatedFiles();
        
        console.log('\n✨ Cleanup completed successfully!');
        console.log('\n📋 Next steps:');
        console.log('1. Start the application with: npm start');
        console.log('2. Access the application at: http://localhost:3001');
        console.log('\nThank you for upgrading to WhatsApp Group Manager Pro!');
    } catch (error) {
        console.error('\n❌ Error during cleanup:', error.message);
        console.error('Please resolve the issue and try running the cleanup script again');
    }
}

// Run the cleanup
cleanup();