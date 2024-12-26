const supabase = require('./supabase');
const memoryStorage = require('./memoryStorage');

/**
 * Storage service that manages both Supabase and local memory storage
 */
class StorageService {
    constructor() {
        this.useSupabase = true;
        this.storage = supabase;
        this.syncLock = new Map(); // Locks for synchronization
        this.syncQueue = new Map(); // Synchronization queue
        this.lastSync = new Map(); // Last sync time by type
        this.syncInterval = 5000; // 5 seconds between syncs

        this.loadSecondaryAdmins();
    }

    /**
     * Get a synchronization lock
     * @param {string} key - Lock key
     * @returns {boolean} true if lock was acquired
     */
    async acquireLock(key) {
        if (this.syncLock.get(key)) {
            return false;
        }
        this.syncLock.set(key, true);
        return true;
    }

    /**
     * Release a synchronization lock
     * @param {string} key - Lock key
     */
    releaseLock(key) {
        this.syncLock.delete(key);
    }

    /**
     * Validate data integrity
     * @param {Object} data - Data to validate
     * @param {string} type - Data type
     * @returns {boolean} true if data is valid
     */
    validateData(data, type) {
        if (!data) return false;

        switch (type) {
            case 'price':
                return (
                    data.price &&
                    typeof data.price === 'number' &&
                    data.marketCap &&
                    typeof data.marketCap === 'number' &&
                    data.liquidity &&
                    typeof data.liquidity === 'number'
                );
            case 'token':
                return (
                    data.address &&
                    typeof data.address === 'string' &&
                    data.poolAddress &&
                    typeof data.poolAddress === 'string' &&
                    data.ticker &&
                    typeof data.ticker === 'string'
                );
            case 'config':
                return (
                    data.key &&
                    typeof data.key === 'string' &&
                    data.value !== undefined
                );
            default:
                return false;
        }
    }

    /**
     * Queue an operation for synchronization
     * @param {string} type - Operation type
     * @param {Function} operation - Function to execute
     */
    async queueSync(type, operation) {
        if (!this.syncQueue.has(type)) {
            this.syncQueue.set(type, []);
        }
        this.syncQueue.get(type).push(operation);

        // Process queue if no recent sync
        const lastSyncTime = this.lastSync.get(type) || 0;
        if (Date.now() - lastSyncTime > this.syncInterval) {
            await this.processSyncQueue(type);
        }
    }

    /**
     * Process synchronization queue
     * @param {string} type - Operation type
     */
    async processSyncQueue(type) {
        if (!await this.acquireLock(type)) return;

        try {
            const operations = this.syncQueue.get(type) || [];
            this.syncQueue.set(type, []);
            this.lastSync.set(type, Date.now());

            for (const operation of operations) {
                try {
                    await operation();
                } catch (error) {
                    console.error(`Error in synchronization of ${type}:`, error);
                }
            }
        } finally {
            this.releaseLock(type);
        }
    }

    // Load secondary admins on startup
    async loadSecondaryAdmins() {
        try {
            if (!await this.acquireLock('admins')) {
                console.log('Admin synchronization in progress...');
                return;
            }

            try {
                if (this.useSupabase) {
                    const supabaseAdmins = await supabase.getSecondaryAdmins();
                    for (const adminId of supabaseAdmins) {
                        await memoryStorage.addSecondaryAdmin(adminId);
                    }
                }
            } finally {
                this.releaseLock('admins');
            }
        } catch (error) {
            console.error('Error loading secondary admins:', error);
        }
    }

    // Save token price with validation and synchronization
    async saveTokenPrice(token, price) {
        if (!this.validateData(token, 'token') || !this.validateData(price, 'price')) {
            throw new Error('Invalid data for saving price');
        }

        // Save to active storage
        const result = await this.storage.saveTokenPrice(token, price);

        // Sync with memory if needed
        if (this.useSupabase) {
            await this.queueSync('price', async () => {
                await memoryStorage.saveTokenPrice(token, price);
            });
        }

        return result;
    }

    // Update configuration with validation and synchronization
    async updateConfig(key, value) {
        const configData = { key, value };
        if (!this.validateData(configData, 'config')) {
            throw new Error('Invalid configuration data');
        }

        try {
            // Always save to memory
            await memoryStorage.updateConfig(key, value);

            // Sync with Supabase if active
            if (this.useSupabase) {
                await this.queueSync('config', async () => {
                    await supabase.updateConfig(key, value);
                });
            }

            return true;
        } catch (error) {
            console.error('Error updating configuration:', error);
            return false;
        }
    }

    // Check if Supabase is available
    isSupabaseAvailable() {
        return supabase.isAvailable();
    }

    // Change storage mode
    setStorageMode(useSupabase) {
        // If trying to switch to Supabase but it's not available, keep memory mode
        if (useSupabase && !this.isSupabaseAvailable()) {
            console.log('⚠️ Cannot switch to Supabase mode: not available');
            return;
        }
        
        this.useSupabase = useSupabase;
        console.log(`🔄 Switched to ${useSupabase ? 'Supabase' : 'Memory'} mode`);
    }

    // Get current storage mode
    getStorageMode() {
        return this.useSupabase ? 'supabase' : 'memory';
    }

    // Delegate data methods to active storage
    async getTokenPrice(poolAddress) {
        return this.storage.getTokenPrice(poolAddress);
    }

    async getPriceHistory(poolAddress, limit) {
        return this.storage.getPriceHistory(poolAddress, limit);
    }

    async getStats() {
        return this.storage.getStats();
    }

    async clearHistory(poolAddress) {
        return this.storage.clearHistory(poolAddress);
    }

    // Configuration methods with dual backup
    async getConfig(key) {
        try {
            let config = null;

            // Try to get from Supabase first if active
            if (this.useSupabase) {
                config = await supabase.getConfig(key);
            }

            // If no data from Supabase, use memory
            if (!config) {
                config = await memoryStorage.getConfig(key);
            }

            // If obtained from Supabase, sync with memory
            if (config && this.useSupabase) {
                await memoryStorage.updateConfig(key, config.value);
            }

            return config;
        } catch (error) {
            console.error('Error getting configuration:', error);
            // In case of error, try to use memory
            return memoryStorage.getConfig(key);
        }
    }

    // Test connection with current storage
    async testConnection() {
        return this.storage.testConnection();
    }

    // Methods for managing secondary admins with dual backup
    async getSecondaryAdmins() {
        try {
            let admins = new Set();

            // Try to get from Supabase first if active
            if (this.useSupabase) {
                admins = await supabase.getSecondaryAdmins();
            }

            // If no data from Supabase or not active, use memory
            if (!admins.size) {
                admins = await memoryStorage.getSecondaryAdmins();
            }

            // If obtained from Supabase, sync with memory
            if (admins.size && this.useSupabase) {
                for (const adminId of admins) {
                    await memoryStorage.addSecondaryAdmin(adminId);
                }
            }

            return admins;
        } catch (error) {
            console.error('Error obtaining secondary admins:', error);
            return memoryStorage.getSecondaryAdmins();
        }
    }

    async addSecondaryAdmin(userId) {
        try {
            // Always save to memory
            await memoryStorage.addSecondaryAdmin(userId);

            // Try to save to Supabase if available
            if (this.useSupabase) {
                await supabase.addSecondaryAdmin(userId);
            }

            return true;
        } catch (error) {
            console.error('Error adding secondary admin:', error);
            return false;
        }
    }

    async removeSecondaryAdmin(userId) {
        try {
            // Always remove from memory
            await memoryStorage.removeSecondaryAdmin(userId);

            // Try to remove from Supabase if available
            if (this.useSupabase) {
                await supabase.removeSecondaryAdmin(userId);
            }

            return true;
        } catch (error) {
            console.error('Error removing secondary admin:', error);
            return false;
        }
    }
}

module.exports = new StorageService(); 