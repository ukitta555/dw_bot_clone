const { createClient } = require('@supabase/supabase-js');

// Create Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Validar credenciales de Supabase
function validateCredentials() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    
    if (!url || !key || !url.includes('supabase.co') || !key.startsWith('eyJ')) {
        console.error('❌ Invalid or unconfigured Supabase credentials');
        return false;
    }
    return true;
}

class SupabaseService {
    constructor() {
        this.initialized = false;
        this.available = validateCredentials();
        if (this.available) {
            this.initializeTables();
        }
    }

    // Check if Supabase is available
    isAvailable() {
        return this.available;
    }

    // Inicializar tablas necesarias
    async initializeTables() {
        try {
            // Verificar si las tablas existen
            const { error: checkError } = await supabase
                .from('bot_config')
                .select('count')
                .limit(1);

            // Si hay error, las tablas no existen
            if (checkError) {
                console.log('Creating required tables...');
                
                // Crear tabla bot_config
                const { error: createError } = await supabase
                    .from('bot_config')
                    .insert([
                        { key: 'sort_criteria', value: 'mc' },
                        { key: 'update_interval', value: '30' }
                    ]);

                if (createError) {
                    console.error('Error creating bot_config table:', createError);
                }

                // Verificar tabla secondary_admins
                const { error: adminsError } = await supabase
                    .from('secondary_admins')
                    .select('count')
                    .limit(1);

                if (adminsError) {
                    console.log('secondary_admins table does not exist, you must create it manually using SQL:');
                    console.log(`
-- Create secondary admins table
CREATE TABLE IF NOT EXISTS secondary_admins (
    user_id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create security policy to allow all operations
CREATE POLICY "Enable all operations for service role" ON secondary_admins
    USING (true)
    WITH CHECK (true);

-- Enable RLS (Row Level Security)
ALTER TABLE secondary_admins ENABLE ROW LEVEL SECURITY;
                    `);
                }
            }

            this.initialized = true;
            console.log('✅ Tables initialized successfully');
        } catch (error) {
            console.error('Error initializing tables:', error);
        }
    }

    // Ensure tables are initialized
    async ensureInitialized() {
        if (!this.available) {
            return false;
        }
        
        if (!this.initialized) {
            await this.initializeTables();
        }
        return this.initialized;
    }

    // Save or update token price
    async saveTokenPrice(token, price) {
        try {
            const { data, error } = await supabase
                .from('token_prices')
                .upsert({
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
                });

            if (error) throw error;
            console.log('📦 Price saved to Supabase:', token.ticker);
            return data;
        } catch (error) {
            console.error('Error saving price:', error);
            return null;
        }
    }

    // Get latest token price
    async getTokenPrice(poolAddress) {
        try {
            // Select only required fields
            const { data, error } = await supabase
                .from('token_prices')
                .select('price, market_cap, liquidity, volume_24h, dex_id, updated_at')
                .eq('pool_address', poolAddress)
                .order('updated_at', { ascending: false })
                .limit(1)
                .single();

            if (error) return null;

            // If price is older than 30 seconds, return null
            const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
            if (new Date(data.updated_at) < thirtySecondsAgo) {
                return null;
            }

            console.log('📦 Price retrieved from Supabase:', poolAddress);
            return {
                price: data.price,
                marketCap: data.market_cap,
                liquidity: data.liquidity,
                volume24h: data.volume_24h,
                dexId: data.dex_id
            };
        } catch (error) {
            console.error('Error getting price:', error);
            return null;
        }
    }

    // Get price history for a token
    async getPriceHistory(poolAddress, limit = 24) {
        try {
            // Select only required fields and use composite index
            const { data, error } = await supabase
                .from('token_prices')
                .select('price, updated_at')
                .eq('pool_address', poolAddress)
                .order('updated_at', { ascending: false })
                .limit(limit);

            if (error) throw error;
            console.log('📦 History retrieved from Supabase:', poolAddress);
            return data;
        } catch (error) {
            console.error('Error getting history:', error);
            return [];
        }
    }

    // Get stats for the last 24 hours
    async getStats() {
        try {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            
            // Use parallel queries for better performance
            const [updatesResult, countResult] = await Promise.all([
                supabase
                    .from('token_prices')
                    .select('pool_address, updated_at')
                    .gte('updated_at', oneDayAgo),
                supabase
                    .from('token_prices')
                    .select('count')
                    .limit(1)
            ]);

            if (updatesResult.error) throw updatesResult.error;
            if (countResult.error) throw countResult.error;

            return {
                updates: updatesResult.data,
                totalRecords: countResult.count
            };
        } catch (error) {
            console.error('Error getting stats:', error);
            return null;
        }
    }

    // Update bot configuration
    async updateConfig(key, value) {
        await this.ensureInitialized();
        
        try {
            const { error } = await supabase
                .from('bot_config')
                .upsert({ 
                    key, 
                    value: value.toString(),
                    updated_at: new Date().toISOString()
                });

            if (error) {
                console.error('Error in updateConfig:', error);
                return false;
            }
            console.log('📦 Configuration saved to Supabase:', key);
            return true;
        } catch (error) {
            console.error('Error updating configuration:', error);
            return false;
        }
    }

    // Get configuration
    async getConfig(key) {
        await this.ensureInitialized();
        
        try {
            const { data, error } = await supabase
                .from('bot_config')
                .select('*')
                .eq('key', key)
                .single();

            if (error) {
                console.error('Error in getConfig:', error);
                return null;
            }
            return data;
        } catch (error) {
            console.error('Error getting configuration:', error);
            return null;
        }
    }

    // Clear token history
    async clearHistory(poolAddress) {
        try {
            const { error } = await supabase
                .from('token_prices')
                .delete()
                .eq('pool_address', poolAddress);

            if (error) {
                console.error('Error clearing history in Supabase:', error);
                return false;
            }
            console.log('📦 History cleared in Supabase:', poolAddress);
            return true;
        } catch (error) {
            console.error('Error clearing history:', error);
            return false;
        }
    }

    // Test connection with Supabase
    async testConnection() {
        if (!this.available) {
            return false;
        }

        try {
            const { data, error } = await supabase
                .from('token_prices')
                .select('count')
                .limit(1);

            if (error) {
                console.error('Error testing connection:', error);
                return false;
            }
            return true;
        } catch (error) {
            console.error('Error testing connection:', error);
            return false;
        }
    }

    // Methods for managing secondary admins
    async getSecondaryAdmins() {
        try {
            const { data, error } = await supabase
                .from('secondary_admins')
                .select('user_id');

            if (error) throw error;
            console.log('📦 Secondary admins retrieved from Supabase');
            return new Set(data.map(admin => admin.user_id));
        } catch (error) {
            console.error('Error getting secondary admins:', error);
            return new Set();
        }
    }

    async addSecondaryAdmin(userId) {
        try {
            const { error } = await supabase
                .from('secondary_admins')
                .insert({ user_id: userId.toString() });

            if (error) throw error;
            console.log('📦 Secondary admin added to Supabase:', userId);
            return true;
        } catch (error) {
            console.error('Error adding secondary admin:', error);
            return false;
        }
    }

    async removeSecondaryAdmin(userId) {
        try {
            const { error } = await supabase
                .from('secondary_admins')
                .delete()
                .eq('user_id', userId.toString());

            if (error) throw error;
            console.log('📦 Secondary admin removed from Supabase:', userId);
            return true;
        } catch (error) {
            console.error('Error removing secondary admin:', error);
            return false;
        }
    }
}

module.exports = new SupabaseService(); 