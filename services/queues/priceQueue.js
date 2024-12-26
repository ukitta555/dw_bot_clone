/**
 * Optimized queue for handling price updates
 */
class PriceQueue {
    constructor(options = {}) {
        // Limits and timeouts configuration
        this.maxQueueSize = options.maxQueueSize || 1000;
        this.processingTimeout = options.processingTimeout || 30000; // 30 seconds
        this.handlerTimeout = options.handlerTimeout || 5000; // 5 seconds
        this.maxRetries = options.maxRetries || 3;

        this.handlers = new Set();
        this.processing = false;
        this.queue = [];
        this.failedItems = new Map(); // Failed items registry
        
        // Statistics
        this.stats = {
            processed: 0,
            failed: 0,
            retried: 0,
            timeouts: 0
        };

        // Clean failed items every hour
        setInterval(() => this.cleanupFailedItems(), 60 * 60 * 1000);
    }

    /**
     * Register a handler to process updates
     * @param {Function} handler - Function that processes the update
     * @throws {Error} If handler is not a function
     */
    process(handler) {
        if (typeof handler !== 'function') {
            throw new Error('Handler must be a function');
        }
        this.handlers.add(handler);
    }

    /**
     * Add an update to the queue
     * @param {Object} data - Update data
     * @throws {Error} If queue is full
     */
    async add(data) {
        if (this.queue.length >= this.maxQueueSize) {
            throw new Error(`Queue full: maximum ${this.maxQueueSize} items`);
        }

        // Validate data before adding
        if (!this.validateData(data)) {
            throw new Error('Invalid data for queue');
        }

        const item = {
            id: this.generateItemId(),
            data,
            addedAt: Date.now(),
            retries: 0
        };

        this.queue.push(item);
        
        if (!this.processing) {
            await this.processQueue();
        }
    }

    /**
     * Generate a unique ID for each item
     * @returns {string} Unique ID
     */
    generateItemId() {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Validate data before adding to queue
     * @param {Object} data - Data to validate
     * @returns {boolean} true if data is valid
     */
    validateData(data) {
        if (!data || typeof data !== 'object') return false;
        // Add specific validations according to your needs
        return true;
    }

    /**
     * Process an individual item with timeout
     * @param {Object} item - Item to process
     * @returns {Promise} Processing result
     */
    async processItem(item) {
        const results = await Promise.allSettled(
            Array.from(this.handlers).map(handler =>
                Promise.race([
                    handler({ data: item.data }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Handler timeout')), this.handlerTimeout)
                    )
                ])
            )
        );

        // Analyze results
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            throw new Error(`${failed.length} handlers failed`);
        }
    }

    /**
     * Process all updates in the queue
     */
    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        const processingStartTime = Date.now();

        try {
            while (this.queue.length > 0) {
                // Check global processing timeout
                if (Date.now() - processingStartTime > this.processingTimeout) {
                    console.warn('Global processing timeout reached');
                    this.stats.timeouts++;
                    break;
                }

                const item = this.queue.shift();
                try {
                    await this.processItem(item);
                    this.stats.processed++;
                } catch (error) {
                    await this.handleFailedItem(item, error);
                }
            }
        } finally {
            this.processing = false;
            this.logStats();
        }
    }

    /**
     * Handle items that failed during processing
     * @param {Object} item - Failed item
     * @param {Error} error - Error that caused the failure
     */
    async handleFailedItem(item, error) {
        this.stats.failed++;
        
        if (item.retries < this.maxRetries) {
            item.retries++;
            item.lastError = error.message;
            this.stats.retried++;
            this.queue.push(item); // Retry
        } else {
            this.failedItems.set(item.id, {
                ...item,
                finalError: error.message,
                failedAt: Date.now()
            });
        }
    }

    /**
     * Clean old failed items
     */
    cleanupFailedItems() {
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        for (const [id, item] of this.failedItems) {
            if (item.failedAt < oneHourAgo) {
                this.failedItems.delete(id);
            }
        }
    }

    /**
     * Log queue statistics
     */
    logStats() {
        console.log('Queue statistics:', {
            ...this.stats,
            queueLength: this.queue.length,
            failedItems: this.failedItems.size
        });
    }

    /**
     * Get current queue status
     * @returns {Object} Queue status
     */
    getStatus() {
        return {
            queueLength: this.queue.length,
            processing: this.processing,
            stats: { ...this.stats },
            failedItems: this.failedItems.size
        };
    }
}

module.exports = new PriceQueue({
    maxQueueSize: 1000,
    processingTimeout: 30000,
    handlerTimeout: 5000,
    maxRetries: 3
}); 