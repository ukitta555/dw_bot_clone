const fs = require('fs').promises;
const path = require('path');

class MemoryStorage {
    constructor() {
        this.prices = new Map();
        this.config = new Map([
            ['sort_criteria', 'mc'],
            ['update_interval', '30']
        ]);
        this.history = new Map();
        this.secondaryAdmins = new Set();
        this.dataDir = path.join(process.cwd(), 'data');
        
        // Índices para búsqueda rápida
        this.pricesByTicker = new Map();
        this.last24hUpdates = new Set();
        this.lastCleanup = Date.now();
        
        this.initialized = false;
        this.initStorage();
        
        // Limpiar índices cada hora
        setInterval(() => this.cleanupIndices(), 60 * 60 * 1000);
    }

    // Limpiar índices antiguos
    cleanupIndices() {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        this.last24hUpdates = new Set(
            Array.from(this.last24hUpdates)
                .filter(update => update.timestamp > oneDayAgo)
        );
        this.lastCleanup = Date.now();
    }

    // Inicializar almacenamiento
    async initStorage() {
        try {
            // Crear directorio de datos si no existe
            await fs.mkdir(this.dataDir, { recursive: true });
            
            // Cargar datos existentes
            await this.loadData();
            
            this.initialized = true;
            console.log('✅ Local storage initialized');
            
            // Guardar datos cada 5 minutos
            setInterval(() => this.saveData(), 5 * 60 * 1000);
        } catch (error) {
            console.error('Error initializing storage:', error);
        }
    }

    // Cargar datos desde archivos
    async loadData() {
        try {
            // Cargar precios
            const pricesPath = path.join(this.dataDir, 'prices.json');
            if (await this.fileExists(pricesPath)) {
                const pricesData = JSON.parse(await fs.readFile(pricesPath, 'utf8'));
                this.prices = new Map(Object.entries(pricesData));
            }

            // Cargar configuración
            const configPath = path.join(this.dataDir, 'config.json');
            if (await this.fileExists(configPath)) {
                const configData = JSON.parse(await fs.readFile(configPath, 'utf8'));
                this.config = new Map(Object.entries(configData));
            }

            // Cargar historial
            const historyPath = path.join(this.dataDir, 'history.json');
            if (await this.fileExists(historyPath)) {
                const historyData = JSON.parse(await fs.readFile(historyPath, 'utf8'));
                this.history = new Map(Object.entries(historyData));
            }

            // Cargar admins secundarios
            const adminsPath = path.join(this.dataDir, 'admins.json');
            if (await this.fileExists(adminsPath)) {
                const adminsData = JSON.parse(await fs.readFile(adminsPath, 'utf8'));
                this.secondaryAdmins = new Set(adminsData);
            }

            console.log('📥 Data loaded from local files');
        } catch (error) {
            console.error('Error loading data:', error);
        }
    }

    // Guardar datos en archivos
    async saveData() {
        try {
            // Guardar precios
            await fs.writeFile(
                path.join(this.dataDir, 'prices.json'),
                JSON.stringify(Object.fromEntries(this.prices)),
                'utf8'
            );

            // Guardar configuración
            await fs.writeFile(
                path.join(this.dataDir, 'config.json'),
                JSON.stringify(Object.fromEntries(this.config)),
                'utf8'
            );

            // Guardar historial
            await fs.writeFile(
                path.join(this.dataDir, 'history.json'),
                JSON.stringify(Object.fromEntries(this.history)),
                'utf8'
            );

            // Guardar admins secundarios
            await fs.writeFile(
                path.join(this.dataDir, 'admins.json'),
                JSON.stringify(Array.from(this.secondaryAdmins)),
                'utf8'
            );

            console.log('💾 Data saved to local files');
        } catch (error) {
            console.error('Error saving data:', error);
        }
    }

    // Verificar si un archivo existe
    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    // Guardar o actualizar precio de token
    async saveTokenPrice(token, price) {
        try {
            const key = token.poolAddress;
            const data = {
                token_address: token.address,
                pool_address: token.poolAddress,
                ticker: token.ticker,
                name: token.name,
                price: price.price,
                market_cap: price.marketCap,
                liquidity: price.liquidity,
                volume_24h: price.volume24h,
                dex_id: price.dexId,
                updated_at: new Date().toISOString()
            };

            this.prices.set(key, data);
            this.pricesByTicker.set(token.ticker, key);
            
            // Registrar actualización para estadísticas
            this.last24hUpdates.add({
                poolAddress: key,
                timestamp: Date.now()
            });
            
            // Guardar en historial
            if (!this.history.has(key)) {
                this.history.set(key, []);
            }
            this.history.get(key).unshift(data);
            
            // Mantener solo últimas 24 entradas
            if (this.history.get(key).length > 24) {
                this.history.get(key).pop();
            }

            // Guardar cambios en disco
            await this.saveData();

            return data;
        } catch (error) {
            console.error('Error saving price to memory:', error);
            return null;
        }
    }

    // Obtener último precio de un token
    async getTokenPrice(poolAddress) {
        try {
            const data = this.prices.get(poolAddress);
            if (!data) return null;

            // Si el precio tiene más de 30 segundos, retornar null
            const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
            if (new Date(data.updated_at) < thirtySecondsAgo) {
                return null;
            }

            return {
                price: data.price,
                marketCap: data.market_cap,
                liquidity: data.liquidity,
                volume24h: data.volume_24h,
                dexId: data.dex_id
            };
        } catch (error) {
            console.error('Error getting price from memory:', error);
            return null;
        }
    }

    // Obtener historial de precios de un token
    async getPriceHistory(poolAddress, limit = 24) {
        try {
            const history = this.history.get(poolAddress) || [];
            return history.slice(0, limit).map(h => ({
                price: h.price,
                updated_at: h.updated_at
            }));
        } catch (error) {
            console.error('Error getting history from memory:', error);
            return [];
        }
    }

    // Obtener estadísticas
    async getStats() {
        try {
            const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
            
            // Limpiar índices si es necesario
            if (Date.now() - this.lastCleanup > 60 * 60 * 1000) {
                this.cleanupIndices();
            }

            return {
                updates: Array.from(this.last24hUpdates),
                totalRecords: this.prices.size
            };
        } catch (error) {
            console.error('Error getting stats from memory:', error);
            return null;
        }
    }

    // Actualizar configuración
    async updateConfig(key, value) {
        try {
            this.config.set(key, value.toString());
            // Guardar cambios en disco
            await this.saveData();
            return true;
        } catch (error) {
            console.error('Error updating config in memory:', error);
            return false;
        }
    }

    // Obtener configuración
    async getConfig(key) {
        try {
            const value = this.config.get(key);
            return value ? { key, value } : null;
        } catch (error) {
            console.error('Error getting config from memory:', error);
            return null;
        }
    }

    // Limpiar historial de un token
    async clearHistory(poolAddress) {
        try {
            this.history.delete(poolAddress);
            // Guardar cambios en disco
            await this.saveData();
            return true;
        } catch (error) {
            console.error('Error clearing history in memory:', error);
            return false;
        }
    }

    // Probar conexión (siempre disponible en memoria)
    async testConnection() {
        return true;
    }

    // Métodos para gestionar admins secundarios
    async getSecondaryAdmins() {
        return this.secondaryAdmins;
    }

    async addSecondaryAdmin(userId) {
        try {
            this.secondaryAdmins.add(userId.toString());
            await this.saveData();
            return true;
        } catch (error) {
            console.error('Error adding secondary admin:', error);
            return false;
        }
    }

    async removeSecondaryAdmin(userId) {
        try {
            const result = this.secondaryAdmins.delete(userId.toString());
            await this.saveData();
            return result;
        } catch (error) {
            console.error('Error removing secondary admin:', error);
            return false;
        }
    }

    // Guardar datos en archivos
    async saveToFiles() {
        try {
            await fs.writeFile('prices.json', JSON.stringify(Array.from(this.prices.entries())));
            await fs.writeFile('config.json', JSON.stringify(Array.from(this.config.entries())));
            await fs.writeFile('history.json', JSON.stringify(Array.from(this.history.entries())));
            await fs.writeFile('admins.json', JSON.stringify(Array.from(this.secondaryAdmins)));
            console.log('💾 Data saved to local files');
        } catch (error) {
            console.error('Error saving data to files:', error);
        }
    }

    // Cargar datos desde archivos
    async loadFromFiles() {
        try {
            try {
                const pricesData = await fs.readFile('prices.json', 'utf8');
                this.prices = new Map(JSON.parse(pricesData));
            } catch (e) {
                this.prices = new Map();
            }

            try {
                const configData = await fs.readFile('config.json', 'utf8');
                this.config = new Map(JSON.parse(configData));
            } catch (e) {
                this.config = new Map();
            }

            try {
                const historyData = await fs.readFile('history.json', 'utf8');
                this.history = new Map(JSON.parse(historyData));
            } catch (e) {
                this.history = new Map();
            }

            try {
                const adminsData = await fs.readFile('admins.json', 'utf8');
                this.secondaryAdmins = new Set(JSON.parse(adminsData));
            } catch (e) {
                this.secondaryAdmins = new Set();
            }

            console.log('📥 Data loaded from local files');
        } catch (error) {
            console.error('Error loading data from files:', error);
        }
    }

    // Guardar o actualizar precio de token
    async saveTokenPrice(token, price) {
        const key = token.poolAddress;
        this.prices.set(key, {
            token,
            price,
            updated_at: new Date().toISOString()
        });
        
        // Guardar en historial
        if (!this.history.has(key)) {
            this.history.set(key, []);
        }
        const history = this.history.get(key);
        history.unshift({
            price: price.price,
            updated_at: new Date().toISOString()
        });
        
        // Mantener solo últimas 24 entradas
        if (history.length > 24) {
            history.length = 24;
        }
        
        await this.saveToFiles();
        console.log('💾 Price saved to memory:', token.ticker);
        return true;
    }

    // Obtener último precio de un token
    async getTokenPrice(poolAddress) {
        const data = this.prices.get(poolAddress);
        if (!data) return null;

        // Si el precio tiene más de 30 segundos, retornar null
        const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
        if (new Date(data.updated_at) < thirtySecondsAgo) {
            return null;
        }

        console.log('💾 Price retrieved from memory:', poolAddress);
        return data.price;
    }

    // Obtener historial de precios de un token
    async getPriceHistory(poolAddress) {
        const history = this.history.get(poolAddress) || [];
        console.log('💾 History retrieved from memory:', poolAddress);
        return history;
    }

    // Limpiar historial de un token
    async clearHistory(poolAddress) {
        this.history.delete(poolAddress);
        await this.saveToFiles();
        console.log('💾 History cleared in memory:', poolAddress);
        return true;
    }

    // Actualizar configuración
    async updateConfig(key, value) {
        this.config.set(key, value);
        await this.saveToFiles();
        console.log('💾 Config saved to memory:', key);
        return true;
    }

    // Obtener configuración
    async getConfig(key) {
        const value = this.config.get(key);
        if (value !== undefined) {
            console.log('💾 Config retrieved from memory:', key);
        }
        return value ? { key, value } : null;
    }

    // Métodos para gestionar admins secundarios
    async getSecondaryAdmins() {
        console.log('💾 Secondary admins retrieved from memory');
        return this.secondaryAdmins;
    }

    async addSecondaryAdmin(userId) {
        this.secondaryAdmins.add(userId.toString());
        await this.saveToFiles();
        console.log('💾 Secondary admin added to memory:', userId);
        return true;
    }

    async removeSecondaryAdmin(userId) {
        this.secondaryAdmins.delete(userId.toString());
        await this.saveToFiles();
        console.log('💾 Secondary admin removed from memory:', userId);
        return true;
    }
}

module.exports = new MemoryStorage(); 