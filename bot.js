require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const storage = require('./services/storage');

// Bot Token from environment variable
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, {polling: true});

// Admin invitation system
let ADMIN_INVITE_ENABLED = true;
let ADMIN_INVITE_CODE = null;

// Generate new invitation code
function generateInviteCode() {
    ADMIN_INVITE_CODE = Math.random().toString(36).substring(2, 8).toUpperCase();
    return ADMIN_INVITE_CODE;
}

// Check if user is main admin
function isMainAdmin(msgOrUser) {
    try {
        const userId = msgOrUser.chat ? 
            msgOrUser.from?.id?.toString() : 
            msgOrUser.id?.toString() || msgOrUser.toString();
        return userId === process.env.ADMIN_CHAT_ID;
    } catch (error) {
        return false;
    }
}

// Check if user is admin
async function isAdmin(msgOrUser) {
    try {
        const userId = msgOrUser.chat ? 
            msgOrUser.from?.id?.toString() : 
            msgOrUser.id?.toString() || msgOrUser.toString();
        
        if (userId === process.env.ADMIN_CHAT_ID) return true;
        
        const admins = await storage.getSecondaryAdmins();
        return admins.has(userId);
    } catch (error) {
        console.error('Error checking admin:', error);
        return false;
    }
}

// Sorting criteria
const SORT_CRITERIA = {
    mc: { field: 'marketCap', name: 'Market Cap' },
    liq: { field: 'liquidity', name: 'Liquidity' },
    vol: { field: 'volume24h', name: '24h Volume' }
};

// Get DexScreener data with cache
async function getDexInfo(poolAddress) {
    try {
        // Validate address format
        if (!poolAddress || !/^0x[a-fA-F0-9]{40}$/.test(poolAddress)) {
            console.error('DexScreener Error: Invalid pool address');
            return null;
        }

        // Try to get from storage
        const cached = await storage.getTokenPrice(poolAddress);
        if (cached) {
            return cached;
        }

        const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/base/${poolAddress}`);
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        if (!data.pairs?.length) {
            console.error('DexScreener Error: Pair not found');
            return null;
        }
        
        const pair = data.pairs[0];
        
        // Validate required data
        if (!pair.baseToken?.address || !pair.baseToken?.symbol || !pair.baseToken?.name) {
            console.error('DexScreener Error: Incomplete token data');
            return null;
        }

        // Validate and convert numeric data
        const price = parseFloat(pair.priceUsd) || 0;
        const marketCap = parseFloat(pair.marketCap || pair.fdv) || 0;
        const liquidity = parseFloat(pair.liquidity?.usd) || 0;
        const volume24h = parseFloat(pair.volume?.h24) || 0;

        const dexInfo = {
            price,
            marketCap,
            liquidity,
            volume24h,
            dexId: pair.dexId || 'unknown'
        };

        // Validate we have at least price and market cap
        if (price === 0 || marketCap === 0) {
            console.error('DexScreener Error: Invalid price or market cap data');
            return null;
        }

        // Save to storage
        await storage.saveTokenPrice({
            address: pair.baseToken.address,
            poolAddress,
            ticker: pair.baseToken.symbol,
            name: pair.baseToken.name
        }, dexInfo);

        return dexInfo;
    } catch (error) {
        console.error('DexScreener Error:', error.message);
        return null;
    }
}

// Get tokens data
async function getTokens() {
    try {
        const response = await fetch('https://daos.pockethost.io/api/collections/Fund/records?filter=upcoming!=true');
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Verify we have valid data
        if (!data || !data.items || !Array.isArray(data.items)) {
            console.error('Error: Invalid API data:', data);
            return [];
        }

        const tokens = [];
        const visibleTokens = data.items.filter(f => f.visible === true);

        // Process tokens in parallel for better performance
        const tokenPromises = visibleTokens.map(async fund => {
            try {
                // Verify we have required data
                if (!fund.uniswapv3pool || !fund.name || !fund.ticker || !fund.address) {
                    console.warn('Token with incomplete data:', fund);
                    return null;
                }

                const dexInfo = await getDexInfo(fund.uniswapv3pool);
                if (!dexInfo) {
                    console.warn(`Could not get DEX info for ${fund.ticker}`);
                    return null;
                }

                return {
                    name: fund.name,
                    ticker: fund.ticker,
                    address: fund.address,
                    poolAddress: fund.uniswapv3pool,
                    creator: fund.creatorTwitter || 'N/A',
                    telegram: fund.telegram || '',
                    dex: dexInfo
                };
            } catch (error) {
                console.error(`Error processing token ${fund.ticker}:`, error);
                return null;
            }
        });

        // Wait for all tokens to be processed and filter out nulls
        const results = await Promise.all(tokenPromises);
        const validTokens = results.filter(token => token !== null);
        
        // Get current sorting criteria
        const config = await storage.getConfig('sort_criteria');
        const currentCriteria = config?.value || 'mc';
        const sortConfig = SORT_CRITERIA[currentCriteria] || SORT_CRITERIA.mc;

        // Sort tokens by criteria
        return validTokens.sort((a, b) => {
            const valueA = a.dex?.[sortConfig.field] || 0;
            const valueB = b.dex?.[sortConfig.field] || 0;
            return valueB - valueA; // Descending order
        });
    } catch (error) {
        console.error('Error getting tokens:', error);
        return [];
    }
}

// Number formatting
function formatNumber(num) {
    if (!num) return 'N/A';
    if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
    return num.toFixed(2);
}

// Calculate percentage change
function calculatePercentChange(oldValue, newValue) {
    if (!oldValue || !newValue) return null;
    return ((newValue - oldValue) / oldValue * 100).toFixed(2);
}

// Bot commands
bot.onText(/\/start/, async (msg) => {
    const config = await storage.getConfig('ui_mode');
    const currentUI = config?.value || 'text';
    
    const message = '👑 *DAOs World Bot*\n\n' +
        '*Commands:*\n' +
        '/tokens - List active tokens\n' +
        '/price alch - Detailed token information\n' +
        '/history alch - Token price history analysis';

    if (currentUI === 'buttons') {
        const keyboard = {
            inline_keyboard: [
                [{ text: '📊 View Tokens', callback_data: 'tokens_1' }],
                [{ text: '💰 View Price', callback_data: 'price_select' }],
                [{ text: '📈 View History', callback_data: 'history_select' }]
            ]
        };
        
        bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } else {
        bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
    }
});

// Tokens per page
const TOKENS_PER_PAGE = 5;

// /tokens command with pagination
bot.onText(/\/tokens(?:\s+(\d+))?/, async (msg, match) => {
    try {
        const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Loading tokens...');
        const tokens = await getTokens();
        const config = await storage.getConfig('ui_mode');
        const currentUI = config?.value || 'text';
        
        // Calculate pages
        const totalPages = Math.ceil(tokens.length / TOKENS_PER_PAGE);
        const page = Math.min(Math.max(parseInt(match[1] || 1), 1), totalPages);
        const start = (page - 1) * TOKENS_PER_PAGE;
        const end = start + TOKENS_PER_PAGE;
        
        let message = `📊 *Active Tokens* (${tokens.length} total)\n`;
        message += `📄 Page ${page}/${totalPages}\n\n`;
        
        // Display tokens from the current page
        const pageTokens = tokens.slice(start, end);
        pageTokens.forEach(token => {
            message += `*${token.name}* (${token.ticker})\n`;
            if (token.dex) {
                message += `💰 $${token.dex.price || 'N/A'}\n`;
                message += `💎 MC: $${formatNumber(token.dex.marketCap)}\n`;
                message += `💧 Liq: $${formatNumber(token.dex.liquidity)}\n`;
            }
            message += '\n';
        });

        if (currentUI === 'buttons') {
            // Create navigation buttons and actions
            const keyboard = {
                inline_keyboard: [
                    // Buttons for each token in the page
                    ...pageTokens.map(token => ([
                        { text: `💰 ${token.ticker}`, callback_data: `price_${token.ticker}` },
                        { text: `📈 ${token.ticker}`, callback_data: `history_${token.ticker}` }
                    ])),
                    // Navigation buttons
                    [
                        page > 1 ? { text: '« Previous', callback_data: `tokens_${page - 1}` } : { text: ' ', callback_data: 'noop' },
                        { text: `${page}/${totalPages}`, callback_data: 'noop' },
                        page < totalPages ? { text: 'Next »', callback_data: `tokens_${page + 1}` } : { text: ' ', callback_data: 'noop' }
                    ]
                ]
            };

            await bot.editMessageText(message, {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            // Add navigation instructions in text mode
            if (totalPages > 1) {
                message += `\n📱 *Navigation*:\n`;
                message += `Use /tokens ${page > 1 ? page - 1 : totalPages} for previous page\n`;
                message += `Use /tokens ${page < totalPages ? page + 1 : 1} for next page`;
            }

            await bot.editMessageText(message, {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        console.error('Error listing tokens:', error);
        bot.sendMessage(msg.chat.id, '❌ Error loading tokens');
    }
});

// /price command with button support
bot.onText(/\/price (.+)/, async (msg, match) => {
    try {
        const allTokens = await getTokens();
        const token = allTokens.find(t => t.ticker.toUpperCase() === match[1].toUpperCase());
        const config = await storage.getConfig('ui_mode');
        const currentUI = config?.value || 'text';
        
        if (!token) {
            if (currentUI === 'buttons') {
                // Show available tokens
                const keyboard = {
                    inline_keyboard: allTokens.map(t => ([
                        { text: t.ticker, callback_data: `price_${t.ticker}` }
                    ])).concat([[
                        { text: '« Back', callback_data: 'start' }
                    ]])
                };
                
                bot.sendMessage(msg.chat.id,
                    '🔍 *Select a Token*\n\n' +
                    'Select the token to view its price:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    }
                );
            } else {
                bot.sendMessage(msg.chat.id, `❌ Token not found: ${match[1]}`);
            }
            return;
        }
        
        let message = `📊 *${token.name.replace(/[*_`]/g, '')}* (${token.ticker})\n\n`;
        
        if (token.dex) {
            message += `💰 *Market Data*\n`;
            message += `Price: $${token.dex.price || 'N/A'}\n`;
            message += `MC: $${formatNumber(token.dex.marketCap)}\n`;
            message += `Liquidity: $${formatNumber(token.dex.liquidity)}\n`;
            message += `24h Volume: $${formatNumber(token.dex.volume24h)}\n`;
            message += `DEX: ${token.dex.dexId}\n\n`;
        }

        message += `📝 *Information*\n`;
        message += `Contract: \`${token.address.replace(/[`]/g, '')}\`\n`;
        message += `Pool: \`${token.poolAddress.replace(/[`]/g, '')}\`\n`;
        message += `Creator: @${token.creator.replace(/[*_`]/g, '')}\n`;
        if (token.telegram) message += `Telegram: @${token.telegram.replace(/[*_`]/g, '')}`;

        if (currentUI === 'buttons') {
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📈 View History', callback_data: `history_${token.ticker}` },
                        { text: '🔄 Refresh', callback_data: `price_${token.ticker}` }
                    ],
                    [{ text: '« Back', callback_data: 'tokens_1' }]
                ]
            };
            
            bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: keyboard
            });
        } else {
            bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        }
    } catch (error) {
        bot.sendMessage(msg.chat.id, '❌ Error getting information');
    }
});

// /history command with button support
bot.onText(/\/history (.+)/, async (msg, match) => {
    try {
        const allTokens = await getTokens();
        const token = allTokens.find(t => t.ticker.toUpperCase() === match[1].toUpperCase());
        const config = await storage.getConfig('ui_mode');
        const currentUI = config?.value || 'text';
        
        if (!token) {
            if (currentUI === 'buttons') {
                // Show available tokens
                const keyboard = {
                    inline_keyboard: allTokens.map(t => ([
                        { text: t.ticker, callback_data: `history_${t.ticker}` }
                    ])).concat([[
                        { text: '« Back', callback_data: 'start' }
                    ]])
                };
                
                bot.sendMessage(msg.chat.id,
                    '🔍 *Select a Token*\n\n' +
                    'Select the token to view its history:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    }
                );
            } else {
                bot.sendMessage(msg.chat.id, `❌ Token not found: ${match[1]}`);
            }
            return;
        }

        const history = await storage.getPriceHistory(token.poolAddress);
        
        if (history.length === 0) {
            const message = '📊 No historical data available';
            if (currentUI === 'buttons') {
                const keyboard = {
                    inline_keyboard: [[
                        { text: '« Back', callback_data: 'tokens_1' }
                    ]]
                };
                bot.sendMessage(msg.chat.id, message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } else {
                bot.sendMessage(msg.chat.id, message);
            }
            return;
        }

        // Price analysis
        const currentPrice = history[0].price;
        const prices = {
            hour1: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 60 * 60 * 1000))?.price,
            hour4: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 4 * 60 * 60 * 1000))?.price,
            hour12: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 12 * 60 * 60 * 1000))?.price,
            hour24: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 24 * 60 * 60 * 1000))?.price
        };

        let message = `📊 *${token.name}*\n\n`;
        message += `💰 *Price:* $${currentPrice}\n\n`;
        message += `📈 *Changes*:\n`;
        
        if (prices.hour1) {
            const change1h = calculatePercentChange(prices.hour1, currentPrice);
            message += `1h: ${change1h >= 0 ? '🟢' : '🔴'} ${change1h}%\n`;
        }
        
        if (prices.hour4) {
            const change4h = calculatePercentChange(prices.hour4, currentPrice);
            message += `4h: ${change4h >= 0 ? '🟢' : '🔴'} ${change4h}%\n`;
        }

        if (prices.hour12) {
            const change12h = calculatePercentChange(prices.hour12, currentPrice);
            message += `12h: ${change12h >= 0 ? '🟢' : '🔴'} ${change12h}%\n`;
        }
        
        if (prices.hour24) {
            const change24h = calculatePercentChange(prices.hour24, currentPrice);
            message += `24h: ${change24h >= 0 ? '🟢' : '🔴'} ${change24h}%\n`;
        }

        if (currentUI === 'buttons') {
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💰 View Price', callback_data: `price_${token.ticker}` },
                        { text: '🔄 Refresh', callback_data: `history_${token.ticker}` }
                    ],
                    [{ text: '« Back', callback_data: 'tokens_1' }]
                ]
            };
            
            bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
        }
    } catch (error) {
        console.error('Error in price history analysis:', error);
        bot.sendMessage(msg.chat.id, '❌ Error getting history');
    }
});

// Configuration interface
const UI_MODES = {
    'text': { name: 'Text 📝', description: 'Traditional commands' },
    'buttons': { name: 'Buttons 🔘', description: 'Interactive interface' }
};

// Modify admin message to include UI mode
bot.onText(/\/admin/, async (msg) => {
    if (!await isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    const currentMode = storage.getStorageMode();
    const config = await storage.getConfig('ui_mode');
    const currentUI = config?.value || 'text';
    const admins = await storage.getSecondaryAdmins();
    
    let message = '👑 *Admin Panel*\n\n';
    
    // Show additional information for main admin
    if (isMainAdmin(msg)) {
        message += '*Admin Management:*\n';
        message += `• Invitation Status: ${ADMIN_INVITE_ENABLED ? '✅ Active' : '❌ Inactive'}\n`;
        message += `• Secondary Admins: ${admins.size}\n\n`;
    }
    
    message += `*Storage Mode:* ${currentMode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}\n`;
    message += `*UI Mode:* ${UI_MODES[currentUI].name}\n\n`;
    message += '*Commands:*\n';
    message += '/setinterval 30 - Change update interval\n';
    message += '/stats - View bot statistics\n';
    message += '/clearhistory ticker - Clear history of a token\n';
    message += '/setcriteria - Change exposure criteria\n';
    message += '/setmode - Change storage mode\n';
    message += '/setui - Change UI mode';

    // If we're in button mode, show buttons
    if (currentUI === 'buttons') {
        const keyboard = {
            inline_keyboard: [
                [{ text: '⏱️ Change Update Interval', callback_data: 'admin_interval' }],
                [{ text: '📊 View Bot Statistics', callback_data: 'admin_stats' }],
                [{ text: '🧹 Clear Token History', callback_data: 'admin_clear' }],
                [{ text: '📈 Change Exposure Criteria', callback_data: 'admin_criteria' }],
                [{ text: '💾 Change Storage Mode', callback_data: 'admin_storage' }],
                [{ text: '🔄 Change UI Mode', callback_data: 'admin_ui' }]
            ]
        };

        // Add admin management buttons for main admin
        if (isMainAdmin(msg)) {
            keyboard.inline_keyboard.unshift(
                [{ text: '👥 Manage Admins', callback_data: 'admin_manage' }]
            );
        }
        
        await bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } else {
        await bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
    }
});

// Command to change UI mode
bot.onText(/\/setui(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    const config = await storage.getConfig('ui_mode');
    const currentUI = config?.value || 'text';

    // If no parameter, show current mode
    if (!match[1]) {
        let message = '🔄 *Current UI Mode*\n\n';
        message += `${UI_MODES[currentUI].name}\n`;
        message += `${UI_MODES[currentUI].description}\n\n`;
        message += '*To change, use:*\n';
        message += '`/setui text` - Text mode\n';
        message += '`/setui buttons` - Button mode';

        if (currentUI === 'buttons') {
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: 'Text Mode 📝', callback_data: 'setui_text' },
                        { text: 'Button Mode 🔘', callback_data: 'setui_buttons' }
                    ]
                ]
            };
            
            bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
        }
        return;
    }

    const mode = match[1].toLowerCase();
    if (!UI_MODES[mode]) {
        bot.sendMessage(msg.chat.id, '❌ Invalid mode. Use `text` or `buttons`', {parse_mode: 'Markdown'});
        return;
    }

    try {
        const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Changing UI mode...');
        
        const success = await storage.updateConfig('ui_mode', mode);
        if (!success) {
            throw new Error('Could not update mode');
        }

        await bot.editMessageText(
            `✅ Mode changed to *${UI_MODES[mode].name}*\n` +
            `${UI_MODES[mode].description}`,
            {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            }
        );
    } catch (error) {
        console.error('Error changing mode:', error);
        bot.sendMessage(msg.chat.id, '❌ Error changing mode');
    }
});

// Modify /setcriteria command to show menu
bot.onText(/\/setcriteria(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    // If no parameter, show available criteria
    if (!match[1]) {
        const config = await storage.getConfig('sort_criteria');
        const currentCriteria = config?.value || 'mc';
        
        let message = '📊 *Exposure Criteria*\n\n';
        message += `Current: *${SORT_CRITERIA[currentCriteria].name}*\n\n`;
        message += '*Available Criteria:*\n';
        for (const [key, value] of Object.entries(SORT_CRITERIA)) {
            message += `\`/setcriteria ${key}\` - ${value.name}\n`;
        }
        
        bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
        return;
    }

    const criteria = match[1].toLowerCase();
    if (!SORT_CRITERIA[criteria]) {
        let message = '❌ Invalid criterion\n\n';
        message += '*Available Criteria:*\n';
        for (const [key, value] of Object.entries(SORT_CRITERIA)) {
            message += `\`/setcriteria ${key}\` - ${value.name}\n`;
        }
        bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
        return;
    }

    try {
        const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Updating criterion...');
        
        const success = await storage.updateConfig('sort_criteria', criteria);
        if (!success) {
            throw new Error('Could not update criterion');
        }

        await bot.editMessageText(
            `✅ Criterion updated to *${SORT_CRITERIA[criteria].name}*\n` +
            'Tokens will be sorted according to this criterion on the first page',
            {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            }
        );
    } catch (error) {
        console.error('Error updating criterion:', error);
        bot.sendMessage(msg.chat.id, '❌ Error updating criterion. Please try again.');
    }
});

// Change update interval
bot.onText(/\/setinterval (\d+)/, async (msg, match) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    const interval = parseInt(match[1]);
    if (interval < 10) {
        bot.sendMessage(msg.chat.id, 'Minimum interval is 10 seconds');
        return;
    }

    try {
        const success = await storage.updateConfig('update_interval', interval);
        
        if (!success) {
            throw new Error('Could not update interval');
        }

        bot.sendMessage(msg.chat.id, `✅ Interval updated to ${interval} seconds`);
    } catch (error) {
        console.error('Error updating interval:', error);
        bot.sendMessage(msg.chat.id, '❌ Error updating interval');
    }
});

// View statistics
bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    try {
        // Get active tokens
        const tokens = await getTokens();
        
        // Get statistics
        const stats = await storage.getStats();
        
        if (!stats) {
            throw new Error('Could not get statistics');
        }

        // Calculate statistics
        const uniqueTokens = new Set(stats.updates?.map(u => u.pool_address) || []);
        const statsData = {
            tokens: tokens.length,
            activeTokens24h: uniqueTokens.size,
            updates24h: stats.updates?.length || 0,
            totalRecords: stats.totalRecords || 0,
            avgUpdatesPerToken: stats.updates ? Math.round(stats.updates.length / uniqueTokens.size) : 0
        };

        let message = '📊 *Bot Statistics*\n\n';
        message += `Total Tokens: ${statsData.tokens}\n`;
        message += `Active Tokens (24h): ${statsData.activeTokens24h}\n`;
        message += `Updates (24h): ${statsData.updates24h}\n`;
        message += `Average/Token: ${statsData.avgUpdatesPerToken}\n`;
        message += `\n💾 *Database*:\n`;
        message += `Total Records: ${statsData.totalRecords}`;

        bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
    } catch (error) {
        console.error('Error getting statistics:', error);
        bot.sendMessage(msg.chat.id, '❌ Error getting statistics');
    }
});

// Clear history
bot.onText(/\/clearhistory (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    const ticker = match[1].toUpperCase();
    try {
        const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Clearing history...');
        
        // Get the token
        const tokens = await getTokens();
        const token = tokens.find(t => t.ticker.toUpperCase() === ticker);
        
        if (!token) {
            await bot.editMessageText(
                `❌ Token not found: ${ticker}`,
                {
                    chat_id: msg.chat.id,
                    message_id: statusMsg.message_id
                }
            );
            return;
        }

        // Clear history using storage service
        const success = await storage.clearHistory(token.poolAddress);
        
        if (!success) {
            throw new Error('Could not clear history');
        }
        
        await bot.editMessageText(
            `✅ History cleared for ${ticker}`,
            {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id
            }
        );
    } catch (error) {
        console.error('Error clearing history:', error);
        bot.sendMessage(msg.chat.id, '❌ Error clearing history');
    }
});

// Command to change storage mode
bot.onText(/\/setmode(?:\s+(.+))?/, async (msg, match) => {
    if (!isAdmin(msg)) {
        bot.sendMessage(msg.chat.id, '❌ You do not have admin permissions');
        return;
    }

    // If no parameter, show current mode
    if (!match[1]) {
        const currentMode = storage.getStorageMode();
        let message = '🔄 *Current Storage Mode*\n\n';
        message += `${currentMode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}\n\n`;
        message += '*To change, use:*\n';
        message += '`/setmode supabase` - Change to Supabase\n';
        message += '`/setmode memory` - Change to Memory';
        
        bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
        return;
    }

    const mode = match[1].toLowerCase();
    if (mode !== 'supabase' && mode !== 'memory') {
        bot.sendMessage(msg.chat.id, '❌ Invalid mode. Use `supabase` or `memory`', {parse_mode: 'Markdown'});
        return;
    }

    try {
        const statusMsg = await bot.sendMessage(msg.chat.id, '⏳ Changing storage mode...');
        
        storage.setStorageMode(mode === 'supabase');
        
        await bot.editMessageText(
            `✅ Mode changed to *${mode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}*`,
            {
                chat_id: msg.chat.id,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
            }
        );
    } catch (error) {
        console.error('Error changing mode:', error);
        bot.sendMessage(msg.chat.id, '❌ Error changing mode');
    }
});

// Function to verify connection to Supabase
async function initializeStorage() {
    try {
        // Try to connect to Supabase
        const statusMsg = await storage.testConnection();
        if (statusMsg) {
            storage.setStorageMode(true); // Use Supabase
            console.log('✅ Connected to Supabase');
            return true;
        } else {
            storage.setStorageMode(false); // Use memory
            console.log('⚠️ Could not connect to Supabase, using memory mode');
            return false;
        }
    } catch (error) {
        console.error('Error connecting to Supabase:', error);
        storage.setStorageMode(false); // Use memory
        console.log('⚠️ Error connecting to Supabase, using memory mode');
        return false;
    }
}

// Initialize bot
async function initializeBot() {
    const supabaseAvailable = storage.isSupabaseAvailable();
    const connected = await initializeStorage();
    const mode = storage.getStorageMode() === 'supabase' ? 'Supabase 📦' : 'Memory 💾';
    console.log(`🚀 Bot started in ${mode} mode`);

    // Notify admin if Supabase is not available (only the first time)
    if (!supabaseAvailable && process.env.ADMIN_CHAT_ID) {
        const adminMessage = '⚠️ *Configuration Notice*\n\n' +
            'Supabase credentials are invalid or not configured correctly.\n\n' +
            'The bot will run in memory mode until:\n' +
            '1. Configure SUPABASE_URL and SUPABASE_KEY in the .env file\n' +
            '2. Restart the bot\n\n' +
            'Supabase-related functions will be disabled.';

        bot.sendMessage(process.env.ADMIN_CHAT_ID, adminMessage, {parse_mode: 'Markdown'});
    }
}

// Start bot
initializeBot();

// Global error handler
process.on('unhandledRejection', (error) => {
    console.error('Unhandled error:', error);
});

console.log('🚀 Bot started with Supabase');

// Callback handler
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;

    // Verify if admin for all admin commands
    if ((data.startsWith('admin_') || 
         data.startsWith('setinterval_') || 
         data.startsWith('setcriteria_') || 
         data.startsWith('setmode_') || 
         data.startsWith('setui_') || 
         data.startsWith('clear_')) && !isAdmin(callbackQuery.from)) {
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ You do not have admin permissions',
            show_alert: true
        });
        return;
    }

    try {
        // Get tokens once if needed
        let allTokens = [];
        if (data.startsWith('admin_clear') || data.startsWith('admin_stats') || data.startsWith('clear_')) {
            allTokens = await getTokens();
        }

        switch (data) {
            // Callbacks from admin panel
            case 'admin_interval':
                await bot.deleteMessage(chatId, msg.message_id);
                await bot.sendMessage(chatId, '⏳ Loading options...', { parse_mode: 'Markdown' }).then(async (loadingMsg) => {
                    const intervalKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '10 seconds ⚡', callback_data: 'setinterval_10' },
                                { text: '30 seconds ⏱️', callback_data: 'setinterval_30' },
                                { text: '60 seconds ⌛', callback_data: 'setinterval_60' }
                            ],
                            [{ text: '« Back to Panel', callback_data: 'admin_back' }]
                        ]
                    };
                    
                    setTimeout(async () => {
                        await bot.deleteMessage(chatId, loadingMsg.message_id);
                        await bot.sendMessage(chatId, 
                            '⏱️ *Update Interval*\n\n' +
                            'Select how often prices should be updated:',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: intervalKeyboard
                            }
                        );
                    }, 500);
                });
                break;

            case 'admin_stats':
                await bot.deleteMessage(chatId, msg.message_id);
                // Reuse the logic from /stats command but with back button
                const stats = await storage.getStats();
                const uniqueTokens = new Set(stats.updates?.map(u => u.pool_address) || []);
                const statsData = {
                    tokens: allTokens.length,
                    activeTokens24h: uniqueTokens.size,
                    updates24h: stats.updates?.length || 0,
                    totalRecords: stats.totalRecords || 0,
                    avgUpdatesPerToken: stats.updates ? Math.round(stats.updates.length / uniqueTokens.size) : 0
                };

                const statsKeyboard = {
                    inline_keyboard: [
                        [{ text: '« Back', callback_data: 'admin_back' }]
                    ]
                };

                await bot.sendMessage(chatId,
                    '📊 *Bot Statistics*\n\n' +
                    `Total Tokens: ${statsData.tokens}\n` +
                    `Active Tokens (24h): ${statsData.activeTokens24h}\n` +
                    `Updates (24h): ${statsData.updates24h}\n` +
                    `Average/Token: ${statsData.avgUpdatesPerToken}\n` +
                    `\n💾 *Database*:\n` +
                    `Total Records: ${statsData.totalRecords}`,
                    {
                        parse_mode: 'Markdown',
                        reply_markup: statsKeyboard
                    }
                );
                break;

            case 'admin_clear':
                await bot.deleteMessage(chatId, msg.message_id);
                const clearKeyboard = {
                    inline_keyboard: allTokens.map(t => ([
                        { text: t.ticker, callback_data: `clear_${t.ticker}` }
                    ])).concat([[
                        { text: '« Back', callback_data: 'admin_back' }
                    ]])
                };
                await bot.sendMessage(chatId,
                    '🧹 *Clear History*\n\n' +
                    'Select the token to clear its history:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: clearKeyboard
                    }
                );
                break;

            case 'admin_criteria':
                await bot.deleteMessage(chatId, msg.message_id);
                const config = await storage.getConfig('sort_criteria');
                const currentCriteria = config?.value || 'mc';
                const criteriaKeyboard = {
                    inline_keyboard: Object.entries(SORT_CRITERIA).map(([key, value]) => ([
                        { 
                            text: `${value.name} ${key === currentCriteria ? '✓' : ''}`, 
                            callback_data: `setcriteria_${key}` 
                        }
                    ])).concat([[
                        { text: '« Back', callback_data: 'admin_back' }
                    ]])
                };
                await bot.sendMessage(chatId,
                    '📈 *Exposure Criteria*\n\n' +
                    `Current: *${SORT_CRITERIA[currentCriteria].name}*\n\n` +
                    'Select new criterion:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: criteriaKeyboard
                    }
                );
                break;

            case 'admin_storage':
                await bot.deleteMessage(chatId, msg.message_id);
                await bot.sendMessage(chatId, '⏳ Loading options...', { parse_mode: 'Markdown' }).then(async (loadingMsg) => {
                    const currentMode = storage.getStorageMode();
                    const supabaseAvailable = storage.isSupabaseAvailable();
                    const storageKeyboard = {
                        inline_keyboard: [
                            [
                                { 
                                    text: `Supabase - Database ${currentMode === 'supabase' ? '✓' : ''} ${!supabaseAvailable ? '⚠️' : ''}`, 
                                    callback_data: supabaseAvailable ? 'setmode_supabase' : 'noop',
                                    disabled: !supabaseAvailable
                                }
                            ],
                            [
                                { 
                                    text: `Memory - RAM ${currentMode === 'memory' ? '✓' : ''}`, 
                                    callback_data: 'setmode_memory' 
                                }
                            ],
                            [{ text: '« Back to Panel', callback_data: 'admin_back' }]
                        ]
                    };
                    
                    setTimeout(async () => {
                        await bot.deleteMessage(chatId, loadingMsg.message_id);
                        await bot.sendMessage(chatId,
                            '💾 *Storage Mode*\n\n' +
                            `Current: *${currentMode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}*\n\n` +
                            '*Options:*\n' +
                            `• Supabase: Persistent cloud storage ${!supabaseAvailable ? '(⚠️ Not available)' : ''}\n` +
                            '• Memory: Temporary RAM storage',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: storageKeyboard
                            }
                        );
                    }, 500);
                });
                break;

            case 'admin_ui':
                await bot.deleteMessage(chatId, msg.message_id);
                await bot.sendMessage(chatId, '⏳ Loading options...', { parse_mode: 'Markdown' }).then(async (loadingMsg) => {
                    const uiConfig = await storage.getConfig('ui_mode');
                    const currentUI = uiConfig?.value || 'text';
                    const uiKeyboard = {
                        inline_keyboard: [
                            [
                                { 
                                    text: `Text Mode - Traditional Commands ${currentUI === 'text' ? '✓' : ''}`, 
                                    callback_data: 'setui_text' 
                                }
                            ],
                            [
                                { 
                                    text: `Button Mode - Interactive ${currentUI === 'buttons' ? '✓' : ''}`, 
                                    callback_data: 'setui_buttons' 
                                }
                            ],
                            [{ text: '« Back to Panel', callback_data: 'admin_back' }]
                        ]
                    };
                    
                    setTimeout(async () => {
                        await bot.deleteMessage(chatId, loadingMsg.message_id);
                        await bot.sendMessage(chatId,
                            '🔄 *UI Mode*\n\n' +
                            `Current: *${UI_MODES[currentUI].name}*\n\n` +
                            '*Options:*\n' +
                            '• Text: Traditional command-based interface\n' +
                            '• Buttons: Interactive interface with buttons and menus',
                            {
                                parse_mode: 'Markdown',
                                reply_markup: uiKeyboard
                            }
                        );
                    }, 500);
                });
                break;

            case 'admin_back':
                await bot.deleteMessage(chatId, msg.message_id);
                // Show admin panel again
                const adminStorageMode = storage.getStorageMode();
                const adminConfig = await storage.getConfig('ui_mode');
                const adminUI = adminConfig?.value || 'text';
                
                const adminMessage = '👑 *Admin Panel*\n\n' +
                    `*Storage Mode:* ${adminStorageMode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}\n` +
                    `*UI Mode:* ${UI_MODES[adminUI].name}\n\n` +
                    '*Commands:*\n' +
                    '/setinterval 30 - Change update interval\n' +
                    '/stats - View bot statistics\n' +
                    '/clearhistory ticker - Clear history of a token\n' +
                    '/setcriteria - Change exposure criteria\n' +
                    '/setmode - Change storage mode\n' +
                    '/setui - Change UI mode';

                if (adminUI === 'buttons') {
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: '⏱️ Change Update Interval', callback_data: 'admin_interval' }],
                            [{ text: '📊 View Bot Statistics', callback_data: 'admin_stats' }],
                            [{ text: '🧹 Clear Token History', callback_data: 'admin_clear' }],
                            [{ text: '📈 Change Exposure Criteria', callback_data: 'admin_criteria' }],
                            [{ text: '💾 Change Storage Mode', callback_data: 'admin_storage' }],
                            [{ text: '🔄 Change UI Mode', callback_data: 'admin_ui' }]
                        ]
                    };
                    
                    await bot.sendMessage(chatId, adminMessage, {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                } else {
                    await bot.sendMessage(chatId, adminMessage, {parse_mode: 'Markdown'});
                }
                break;

            // Configuration callbacks
            case data.match(/^setinterval_(\d+)/)?.input:
                const interval = data.split('_')[1];
                await storage.updateConfig('update_interval', interval);
                await bot.editMessageText(
                    `✅ Interval updated to *${interval} seconds*`,
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_back' }
                            ]]
                        }
                    }
                );
                break;

            case data.match(/^setcriteria_(.+)/)?.input:
                const criteria = data.split('_')[1];
                await storage.updateConfig('sort_criteria', criteria);
                await bot.editMessageText(
                    `✅ Criterion updated to *${SORT_CRITERIA[criteria].name}*`,
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_back' }
                            ]]
                        }
                    }
                );
                break;

            case data.match(/^setmode_(.+)/)?.input:
                const mode = data.split('_')[1];
                if (mode === 'supabase' && !storage.isSupabaseAvailable()) {
                    await bot.answerCallbackQuery(callbackQuery.id, {
                        text: '⚠️ Supabase not available. Verify configuration.',
                        show_alert: true
                    });
                    return;
                }
                storage.setStorageMode(mode === 'supabase');
                await bot.editMessageText(
                    `✅ Mode changed to *${mode === 'supabase' ? 'Supabase 📦' : 'Memory 💾'}*`,
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_back' }
                            ]]
                        }
                    }
                );
                break;

            case data.match(/^setui_(.+)/)?.input:
                const ui = data.split('_')[1];
                await storage.updateConfig('ui_mode', ui);
                await bot.editMessageText(
                    `✅ Mode changed to *${UI_MODES[ui].name}*\n` +
                    `${UI_MODES[ui].description}`,
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_back' }
                            ]]
                        }
                    }
                );
                break;

            case data.match(/^clear_(.+)/)?.input:
                const ticker = data.split('_')[1];
                const tokenToDelete = allTokens.find(t => t.ticker === ticker);
                if (tokenToDelete) {
                    await storage.clearHistory(tokenToDelete.poolAddress);
                    await bot.editMessageText(
                        `✅ History cleared for *${ticker}*`,
                        {
                            chat_id: chatId,
                            message_id: msg.message_id,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '« Back', callback_data: 'admin_back' }
                                ]]
                            }
                        }
                    );
                }
                break;

            // General navigation callbacks
            case 'start':
                await bot.deleteMessage(chatId, msg.message_id);
                const startConfig = await storage.getConfig('ui_mode');
                const startUI = startConfig?.value || 'text';
                
                const startMessage = '🚀 *DAOs World Bot*\n\n' +
                    '*Commands:*\n' +
                    '/tokens - List active tokens\n' +
                    '/price alch - Detailed token information\n' +
                    '/history alch - Token price history analysis';

                if (startUI === 'buttons') {
                    const keyboard = {
                        inline_keyboard: [
                            [{ text: '📊 View Tokens', callback_data: 'tokens_1' }],
                            [{ text: '💰 View Price', callback_data: 'price_select' }],
                            [{ text: '📈 View History', callback_data: 'history_select' }]
                        ]
                    };
                    
                    await bot.sendMessage(chatId, startMessage, {
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                } else {
                    await bot.sendMessage(chatId, startMessage, {parse_mode: 'Markdown'});
                }
                break;

            case 'tokens_1':
                await bot.deleteMessage(chatId, msg.message_id);
                const loadingMsg = await bot.sendMessage(chatId, '⏳ Loading tokens...');
                const tokensList = await getTokens();
                const tokensConfig = await storage.getConfig('ui_mode');
                const tokensUI = tokensConfig?.value || 'text';
                
                // Calculate pages
                const totalPages = Math.ceil(tokensList.length / TOKENS_PER_PAGE);
                const page = 1;
                const start = 0;
                const end = TOKENS_PER_PAGE;
                
                let tokensMessage = `📊 *Active Tokens* (${tokensList.length} total)\n`;
                tokensMessage += `📄 Page ${page}/${totalPages}\n\n`;
                
                // Display tokens from the current page
                const pageTokens = tokensList.slice(start, end);
                pageTokens.forEach(token => {
                    tokensMessage += `*${token.name}* (${token.ticker})\n`;
                    if (token.dex) {
                        tokensMessage += `💰 $${token.dex.price || 'N/A'}\n`;
                        tokensMessage += `💎 MC: $${formatNumber(token.dex.marketCap)}\n`;
                        tokensMessage += `💧 Liq: $${formatNumber(token.dex.liquidity)}\n`;
                    }
                    tokensMessage += '\n';
                });

                if (tokensUI === 'buttons') {
                    const keyboard = {
                        inline_keyboard: [
                            ...pageTokens.map(token => ([
                                { text: `💰 ${token.ticker}`, callback_data: `price_${token.ticker}` },
                                { text: `📈 ${token.ticker}`, callback_data: `history_${token.ticker}` }
                            ])),
                            [
                                page > 1 ? { text: '« Previous', callback_data: `tokens_${page - 1}` } : { text: ' ', callback_data: 'noop' },
                                { text: `${page}/${totalPages}`, callback_data: 'noop' },
                                page < totalPages ? { text: 'Next »', callback_data: `tokens_${page + 1}` } : { text: ' ', callback_data: 'noop' }
                            ]
                        ]
                    };

                    await bot.editMessageText(tokensMessage, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                } else {
                    if (totalPages > 1) {
                        tokensMessage += `\n📱 *Navigation*:\n`;
                        tokensMessage += `Use /tokens ${page > 1 ? page - 1 : totalPages} for previous page\n`;
                        tokensMessage += `Use /tokens ${page < totalPages ? page + 1 : 1} for next page`;
                    }

                    await bot.editMessageText(tokensMessage, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        parse_mode: 'Markdown'
                    });
                }
                break;

            case 'price_select':
            case 'history_select':
                await bot.deleteMessage(chatId, msg.message_id);
                const selectTokens = await getTokens();
                const selectKeyboard = {
                    inline_keyboard: selectTokens.map(t => ([
                        { text: t.ticker, callback_data: `${data.split('_')[0]}_${t.ticker}` }
                    ])).concat([[
                        { text: '« Back', callback_data: 'start' }
                    ]])
                };
                
                await bot.sendMessage(chatId,
                    '🔍 *Select a Token*\n\n' +
                    'Select the token to view its information:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: selectKeyboard
                    }
                );
                break;

            // Callbacks to view price of a specific token
            case data.match(/^price_([A-Z]+)/)?.input:
                const priceTokenTicker = data.split('_')[1];
                await bot.deleteMessage(chatId, msg.message_id);
                const priceStatusMsg = await bot.sendMessage(chatId, '⏳ Loading information...');
                
                try {
                    const allTokensPrice = await getTokens();
                    const token = allTokensPrice.find(t => t.ticker === priceTokenTicker);
                    
                    if (!token) {
                        await bot.editMessageText(
                            `❌ Token not found: ${priceTokenTicker}`,
                            {
                                chat_id: chatId,
                                message_id: priceStatusMsg.message_id,
                                parse_mode: 'Markdown'
                            }
                        );
                        return;
                    }

                    let message = `📊 *${token.name.replace(/[*_`]/g, '')}* (${token.ticker})\n\n`;
                    
                    if (token.dex) {
                        message += `💰 *Market Data*\n`;
                        message += `Price: $${token.dex.price || 'N/A'}\n`;
                        message += `MC: $${formatNumber(token.dex.marketCap)}\n`;
                        message += `Liquidity: $${formatNumber(token.dex.liquidity)}\n`;
                        message += `24h Volume: $${formatNumber(token.dex.volume24h)}\n`;
                        message += `DEX: ${token.dex.dexId}\n\n`;
                    }

                    message += `📝 *Information*\n`;
                    message += `Contract: \`${token.address.replace(/[`]/g, '')}\`\n`;
                    message += `Pool: \`${token.poolAddress.replace(/[`]/g, '')}\`\n`;
                    message += `Creator: @${token.creator.replace(/[*_`]/g, '')}\n`;
                    if (token.telegram) message += `Telegram: @${token.telegram.replace(/[*_`]/g, '')}`;

                    const priceKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '📈 View History', callback_data: `history_${token.ticker}` },
                                { text: '🔄 Refresh', callback_data: `price_${token.ticker}` }
                            ],
                            [{ text: '« Back', callback_data: 'tokens_1' }]
                        ]
                    };

                    await bot.editMessageText(message, {
                        chat_id: chatId,
                        message_id: priceStatusMsg.message_id,
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true,
                        reply_markup: priceKeyboard
                    });
                } catch (error) {
                    console.error('Error showing price:', error);
                    await bot.editMessageText('❌ Error getting information', {
                        chat_id: chatId,
                        message_id: priceStatusMsg.message_id
                    });
                }
                break;

            // Callbacks to view history of a specific token
            case data.match(/^history_([A-Z]+)/)?.input:
                const historyTokenTicker = data.split('_')[1];
                await bot.deleteMessage(chatId, msg.message_id);
                const historyStatusMsg = await bot.sendMessage(chatId, '⏳ Loading history...');
                
                try {
                    const allTokensHistory = await getTokens();
                    const token = allTokensHistory.find(t => t.ticker === historyTokenTicker);
                    
                    if (!token) {
                        await bot.editMessageText(
                            `❌ Token not found: ${historyTokenTicker}`,
                            {
                                chat_id: chatId,
                                message_id: historyStatusMsg.message_id,
                                parse_mode: 'Markdown'
                            }
                        );
                        return;
                    }

                    const history = await storage.getPriceHistory(token.poolAddress);
                    
                    if (history.length === 0) {
                        await bot.editMessageText(
                            '📊 No historical data available',
                            {
                                chat_id: chatId,
                                message_id: historyStatusMsg.message_id,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: '« Back', callback_data: 'tokens_1' }
                                    ]]
                                }
                            }
                        );
                        return;
                    }

                    // Price analysis
                    const currentPrice = history[0].price;
                    const prices = {
                        hour1: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 60 * 60 * 1000))?.price,
                        hour4: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 4 * 60 * 60 * 1000))?.price,
                        hour12: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 12 * 60 * 60 * 1000))?.price,
                        hour24: history.find(h => new Date(h.updated_at) <= new Date(Date.now() - 24 * 60 * 60 * 1000))?.price
                    };

                    let message = `📊 *${token.name}*\n\n`;
                    message += `💰 *Price:* $${currentPrice}\n\n`;
                    message += `📈 *Changes*:\n`;
                    
                    if (prices.hour1) {
                        const change1h = calculatePercentChange(prices.hour1, currentPrice);
                        message += `1h: ${change1h >= 0 ? '🟢' : '🔴'} ${change1h}%\n`;
                    }
                    
                    if (prices.hour4) {
                        const change4h = calculatePercentChange(prices.hour4, currentPrice);
                        message += `4h: ${change4h >= 0 ? '🟢' : '🔴'} ${change4h}%\n`;
                    }

                    if (prices.hour12) {
                        const change12h = calculatePercentChange(prices.hour12, currentPrice);
                        message += `12h: ${change12h >= 0 ? '🟢' : '🔴'} ${change12h}%\n`;
                    }
                    
                    if (prices.hour24) {
                        const change24h = calculatePercentChange(prices.hour24, currentPrice);
                        message += `24h: ${change24h >= 0 ? '🟢' : '🔴'} ${change24h}%\n`;
                    }

                    const historyKeyboard = {
                        inline_keyboard: [
                            [
                                { text: '💰 View Price', callback_data: `price_${token.ticker}` },
                                { text: '🔄 Refresh', callback_data: `history_${token.ticker}` }
                            ],
                            [{ text: '« Back', callback_data: 'tokens_1' }]
                        ]
                    };

                    await bot.editMessageText(message, {
                        chat_id: chatId,
                        message_id: historyStatusMsg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: historyKeyboard
                    });
                } catch (error) {
                    console.error('Error showing history:', error);
                    await bot.editMessageText('❌ Error getting history', {
                        chat_id: chatId,
                        message_id: historyStatusMsg.message_id
                    });
                }
                break;

            // Callbacks for admin management
            case 'admin_manage':
                if (!isMainAdmin(callbackQuery.from)) {
                    await bot.answerCallbackQuery(callbackQuery.id, {
                        text: '❌ Only the main admin can manage admins',
                        show_alert: true
                    });
                    return;
                }

                await bot.deleteMessage(chatId, msg.message_id);
                const managementAdmins = await storage.getSecondaryAdmins();
                const adminKeyboard = {
                    inline_keyboard: [
                        [
                            { 
                                text: `${ADMIN_INVITE_ENABLED ? '❌ Disable' : '✅ Enable'} Invitations`, 
                                callback_data: 'admin_toggle_invite' 
                            }
                        ],
                        [
                            { text: '🔑 Generate New Code', callback_data: 'admin_generate_code' }
                        ],
                        [
                            { text: '👥 View Secondary Admins', callback_data: 'admin_list' }
                        ],
                        [{ text: '« Back to Panel', callback_data: 'admin_back' }]
                    ]
                };

                await bot.sendMessage(chatId,
                    '👑 *Admin Management*\n\n' +
                    `Invitation Status: ${ADMIN_INVITE_ENABLED ? '✅ Enabled' : '❌ Disabled'}\n` +
                    `Secondary Admins: ${managementAdmins.size}\n\n` +
                    'Select an option:',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: adminKeyboard
                    }
                );
                break;

            case 'admin_toggle_invite':
                if (!isMainAdmin(callbackQuery.from)) return;
                ADMIN_INVITE_ENABLED = !ADMIN_INVITE_ENABLED;
                if (!ADMIN_INVITE_ENABLED) ADMIN_INVITE_CODE = null;
                await bot.editMessageText(
                    '👑 *Admin Management*\n\n' +
                    `✅ Invitation status changed to: ${ADMIN_INVITE_ENABLED ? 'Enabled' : 'Disabled'}`,
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_manage' }
                            ]]
                        }
                    }
                );
                break;

            case 'admin_generate_code':
                if (!isMainAdmin(callbackQuery.from)) return;
                if (!ADMIN_INVITE_ENABLED) {
                    await bot.answerCallbackQuery(callbackQuery.id, {
                        text: '❌ Invitations are disabled',
                        show_alert: true
                    });
                    return;
                }
                const newCode = generateInviteCode();
                await bot.editMessageText(
                    '🔑 *New Invitation Code*\n\n' +
                    `Code: \`${newCode}\`\n\n` +
                    '⚠️ *Important*:\n' +
                    '• This code is single-use\n' +
                    '• It will be invalidated when used\n' +
                    '• You can generate a new code whenever you want\n' +
                    '• Or completely disable invitations',
                    {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Back', callback_data: 'admin_manage' }
                            ]]
                        }
                    }
                );
                break;

            case 'admin_list':
                if (!isMainAdmin(callbackQuery.from)) return;
                let adminList = '👥 *Secondary Admins*\n\n';
                
                const listAdmins = await storage.getSecondaryAdmins();
                
                if (listAdmins.size === 0) {
                    adminList += 'No secondary admins';
                    const keyboard = {
                        inline_keyboard: [[
                            { text: '« Back', callback_data: 'admin_manage' }
                        ]]
                    };
                    
                    await bot.editMessageText(adminList, {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                } else {
                    const keyboard = {
                        inline_keyboard: []
                    };
                    
                    // Get information about each secondary admin
                    for (const adminId of listAdmins) {
                        try {
                            const chatInfo = await bot.getChat(adminId);
                            const adminName = chatInfo.username ? 
                                `@${chatInfo.username}` : 
                                chatInfo.first_name || `User ${adminId}`;
                            
                            adminList += `• ${adminName} (ID: ${adminId})\n`;
                            keyboard.inline_keyboard.push([
                                { text: `❌ Remove ${adminName}`, callback_data: `admin_remove_${adminId}` }
                            ]);
                        } catch (error) {
                            console.error('Error getting info of admin:', error);
                            adminList += `• ID: ${adminId}\n`;
                            keyboard.inline_keyboard.push([
                                { text: `❌ Remove Admin ${adminId}`, callback_data: `admin_remove_${adminId}` }
                            ]);
                        }
                    }
                    
                    keyboard.inline_keyboard.push([
                        { text: '« Back', callback_data: 'admin_manage' }
                    ]);
                    
                    await bot.editMessageText(adminList, {
                        chat_id: chatId,
                        message_id: msg.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: keyboard
                    });
                }
                break;

            case data.match(/^admin_remove_(\d+)/)?.input:
                if (!isMainAdmin(callbackQuery.from)) return;
                const adminToRemove = data.split('_')[2];
                await storage.removeSecondaryAdmin(adminToRemove);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: '✅ Admin removed',
                    show_alert: true
                });
                // Return to the updated list
                bot.emit('callback_query', {
                    ...callbackQuery,
                    data: 'admin_list'
                });
                break;
        }

        // Respond to callback query
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Error in callback:', error);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: '❌ Error processing action',
            show_alert: true
        });
    }
}); 

// Command to redeem invitation code
bot.onText(/\/invite (.+)/, async (msg, match) => {
    const code = match[1].toUpperCase();
    
    // If already admin, no need for code
    if (await isAdmin(msg)) {
        await bot.sendMessage(msg.chat.id, '✨ You are already an admin of the bot');
        return;
    }
    
    // Verify if invitations are active
    if (!ADMIN_INVITE_ENABLED) {
        await bot.sendMessage(msg.chat.id,
            '❌ *Invitations Disabled*\n\n' +
            'Invitations are temporarily disabled.',
            {parse_mode: 'Markdown'}
        );
        return;
    }
    
    // Verify the code
    if (code === ADMIN_INVITE_CODE) {
        await storage.addSecondaryAdmin(msg.from.id.toString());
        ADMIN_INVITE_CODE = null; // Invalidate the code after use
        
        await bot.sendMessage(msg.chat.id,
            '🎉 *Congratulations!*\n\n' +
            'You have been promoted to admin of the bot.\n\n' +
            'Use /admin to access the control panel.',
            {parse_mode: 'Markdown'}
        );

        // Notify main admin
        if (process.env.ADMIN_CHAT_ID) {
            const newAdmin = msg.from.username ? 
                `@${msg.from.username}` : 
                `${msg.from.first_name} (ID: ${msg.from.id})`;
            
            await bot.sendMessage(process.env.ADMIN_CHAT_ID,
                '👤 *New Admin*\n\n' +
                `User: ${newAdmin}\n` +
                `Code used: \`${code}\``,
                {parse_mode: 'Markdown'}
            );
        }
    } else {
        await bot.sendMessage(msg.chat.id,
            '❌ *Invalid Code*\n\n' +
            'The invitation code is invalid or has expired.\n' +
            'Contact an admin to get a valid code.',
            {parse_mode: 'Markdown'}
        );
    }
}); 

// Message handler for tokens
bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return; // Ignore commands
    
    const ticker = msg.text?.toUpperCase();
    if (!ticker) return;
    
    try {
        const tokens = await getTokens();
        const token = tokens.find(t => t.ticker === ticker);
        
        if (token) {
            const config = await storage.getConfig('ui_mode');
            const currentUI = config?.value || 'text';
            
            let message = `📊 *${token.name}*\n\n`;
            
            if (token.dex) {
                message += `💰 *Market Data*\n`;
                message += `Price: $${token.dex.price || 'N/A'}\n`;
                message += `MC: $${formatNumber(token.dex.marketCap)}\n`;
                message += `Liquidity: $${formatNumber(token.dex.liquidity)}\n`;
                message += `24h Volume: $${formatNumber(token.dex.volume24h)}\n`;
                message += `DEX: ${token.dex.dexId}\n\n`;
            }
            
            message += `📝 *Information*\n`;
            message += `Contract: \`${token.address.replace(/[`]/g, '')}\`\n`;
            message += `Pool: \`${token.poolAddress.replace(/[`]/g, '')}\`\n`;
            message += `Creator: @${token.creator.replace(/[*_`]/g, '')}\n`;
            if (token.telegram) message += `Telegram: @${token.telegram.replace(/[*_`]/g, '')}`;
            
            if (currentUI === 'buttons') {
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '📈 View History', callback_data: `history_${token.ticker}` },
                            { text: '🔄 Refresh', callback_data: `price_${token.ticker}` }
                        ],
                        [{ text: '« Back', callback_data: 'tokens_1' }]
                    ]
                };
                
                bot.sendMessage(msg.chat.id, message, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
            } else {
                bot.sendMessage(msg.chat.id, message, {parse_mode: 'Markdown'});
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
}); 