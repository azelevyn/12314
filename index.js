// index.js

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const CoinpaymentsAPI = require('./CoinpaymentsAPI');
const EscrowState = require('./state/EscrowState');
const { startIpnServer } = require('./ipn_server');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CP_PUBLIC_KEY = process.env.CP_PUBLIC_KEY;
const CP_PRIVATE_KEY = process.env.CP_PRIVATE_KEY;
const CP_MERCHANT_ID = process.env.CP_MERCHANT_ID;
const PUBLIC_IPN_URL = process.env.PUBLIC_IPN_URL;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);

const bot = new Telegraf(BOT_TOKEN);
const cpClient = new CoinpaymentsAPI(CP_PUBLIC_KEY, CP_PRIVATE_KEY, CP_MERCHANT_ID, PUBLIC_IPN_URL);

// --- State and Context Management (Middleware) ---
const { session } = require('telegraf');
const initialSession = { step: 'IDLE', trade: {} };
bot.use(session({ initial: () => initialSession }));

// --- Feature 1: Start Command & Main Menu ---
bot.start((ctx) => {
    ctx.reply(`Welcome to the **Crypto Escrow Bot**! 🔐
This bot facilitates secure cryptocurrency payments between a buyer and a seller using Coinpayments.

**Features:**
- **Secure Deposit:** Buyer sends crypto, which is held securely by Coinpayments.
- **Auto-Notifications:** Receive instant updates via IPN when payment is confirmed.
- **Manual Release:** Seller triggers fund release, admin confirms.
- **Dispute Resolution:** (Manual, handled by admin)

Choose an option below:`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('Start New Escrow (Seller)', 'NEW_ESCROW_START')]
        ])
    });
});

// --- Feature 2: Escrow Creation (Multi-step flow) ---

// Step 1: Start button handler
bot.action('NEW_ESCROW_START', async (ctx) => {
    ctx.session.step = 'AWAITING_AMOUNT';
    ctx.session.trade = { sellerId: ctx.from.id, sellerUsername: ctx.from.username, chatId: ctx.chat.id };
    await ctx.editMessageText('✅ **New Escrow Initiated!**\n\n**Step 1/3: Enter the escrow amount** (in USD, or a fixed currency of your choice):', { parse_mode: 'Markdown' });
});

// Step 2: Receive amount & request description
bot.on('text', async (ctx, next) => {
    if (ctx.session.step === 'AWAITING_AMOUNT') {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) {
            return ctx.reply('⚠️ Please enter a valid positive number for the amount.');
        }
        ctx.session.trade.amount = amount;
        ctx.session.step = 'AWAITING_DESCRIPTION';
        await ctx.reply('**Step 2/3: Enter a brief description** of the service/product (max 100 chars):');
    } else if (ctx.session.step === 'AWAITING_DESCRIPTION') {
        const description = ctx.message.text.substring(0, 100);
        ctx.session.trade.description = description;
        ctx.session.step = 'AWAITING_SELLER_ADDRESS';
        await ctx.reply('**Step 3/3: Enter your destination crypto address** (The address where you, the seller, want to receive the final payment). **Be careful, this cannot be changed.**');
    } else if (ctx.session.step === 'AWAITING_SELLER_ADDRESS') {
        const sellerAddress = ctx.message.text.trim();
        if (sellerAddress.length < 10) { // Basic validation
             return ctx.reply('⚠️ Please enter a valid-looking crypto address.');
        }
        ctx.session.trade.seller_crypto_address = sellerAddress;

        // Finalize trade creation
        const trade = EscrowState.createTrade({
            ...ctx.session.trade,
            currency1: 'USD', // Base currency for escrow amount
            status: 'WAITING_FOR_JOIN'
        });

        const joinLink = `t.me/${ctx.botInfo.username}?start=join_${trade.tradeId}`;

        await ctx.replyWithMarkdown(`🎉 **Escrow Setup Complete!**
        
**Trade ID:** \`${trade.tradeId}\`
**Amount:** ${trade.amount} ${trade.currency1}
**Description:** ${trade.description}

**Action:** Send this link to your buyer to start the deposit:
[🔗 Click to Join Escrow: ${trade.tradeId}](${joinLink})`, 
{
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('Cancel Escrow', `cancel_${trade.tradeId}`)]
            ])
        });

        // Reset state
        ctx.session = initialSession; 
    } else {
        next(); // pass to other handlers
    }
});

// --- Feature 3: Buyer Join (/start=join_TRADEID) ---
bot.command('start', async (ctx) => {
    const payload = ctx.message.text.split(' ')[1];
    if (payload && payload.startsWith('join_')) {
        const tradeId = payload.substring(5);
        const trade = EscrowState.getTrade(tradeId);

        if (!trade) {
            return ctx.reply(`❌ Trade \`${tradeId}\` not found or has expired.`, { parse_mode: 'Markdown' });
        }

        if (trade.status !== 'WAITING_FOR_JOIN' || trade.sellerId === ctx.from.id) {
            return ctx.reply('❌ This trade is no longer available or you are the seller.', { parse_mode: 'Markdown' });
        }

        // Buyer is joining
        const updatedTrade = EscrowState.updateTrade(tradeId, { 
            buyerId: ctx.from.id, 
            buyerUsername: ctx.from.username, 
            status: 'AWAITING_PAYMENT_CHOICE' 
        });

        await ctx.reply(`🤝 **You joined trade \`${tradeId}\`!**
**Amount:** ${updatedTrade.amount} ${updatedTrade.currency1}
**Description:** ${updatedTrade.description}

**Action:** Select the cryptocurrency you want to pay with:`, {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('Bitcoin (BTC)', `pay_${tradeId}_BTC`)],
                [Markup.button.callback('Ethereum (ETH)', `pay_${tradeId}_ETH`)],
                [Markup.button.callback('Litecoin (LTC)', `pay_${tradeId}_LTC`)],
            ])
        });

        // Notify Seller
        bot.telegram.sendMessage(updatedTrade.sellerId, `👤 **Buyer Joined:** Trade \`${tradeId}\` is now active. Buyer: @${ctx.from.username}. Waiting for payment.`, { parse_mode: 'Markdown' });

    } else {
        // Regular /start, defer to the start handler
        ctx.start(); 
    }
});

// --- Feature 4: Payment Gateway Integration (Coinpayments) ---
bot.action(/pay_(\w+)_(\w+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    const currency2 = ctx.match[2]; // Crypto coin (e.g., BTC)
    const trade = EscrowState.getTrade(tradeId);

    if (!trade || trade.buyerId !== ctx.from.id || trade.status !== 'AWAITING_PAYMENT_CHOICE') {
        return ctx.editMessageText('❌ Invalid trade or action.');
    }

    await ctx.editMessageText(`⌛ Generating **${currency2}** payment details via Coinpayments...`);

    try {
        const paymentDetails = await cpClient.createEscrowDeposit(
            trade.amount,
            trade.currency1,
            currency2,
            `${ctx.from.id}@telegram.user`, // Dummy email, replace with real if collected
            tradeId
        );

        if (paymentDetails && paymentDetails.txn_id) {
            EscrowState.updateTrade(tradeId, {
                status: 'PENDING_BUYER_DEPOSIT',
                coinpayments_txn_id: paymentDetails.txn_id
            });

            const countdownTime = Math.round(paymentDetails.timeout / 60); // timeout in minutes
            
            await ctx.editMessageText(`💰 **Deposit Instructions**
**Trade ID:** \`${tradeId}\`
**Amount to Send:** \`${paymentDetails.amount}\` **${currency2}**
**Payment Address:** \`${paymentDetails.address}\`
${paymentDetails.dest_tag ? `**Destination Tag:** \`${paymentDetails.dest_tag}\`` : ''}

**Countdown:** You have **${countdownTime} minutes** to send the payment.

*Funds will be secured in escrow upon confirmation. Do NOT send less than the required amount.*`, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.url('View Payment Status', paymentDetails.status_url)]
                ])
            });

        } else {
            throw new Error('Coinpayments did not return a valid transaction ID.');
        }

    } catch (error) {
        console.error('Coinpayments Deposit Error:', error);
        ctx.editMessageText('❌ **Payment Gateway Error:** Could not generate payment details. Please try again later or contact support.');
    }
});


// --- Feature 5: Fund Release (Seller Action) & Admin Approval ---
bot.action(/release_(\w+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    const trade = EscrowState.getTrade(tradeId);

    if (!trade || trade.sellerId !== ctx.from.id) {
        return ctx.reply('❌ Invalid trade or you are not the seller.');
    }

    if (trade.status !== 'FUNDS_RECEIVED_IN_ESCROW') {
        return ctx.reply('⚠️ Funds are not yet in escrow or trade is complete.');
    }

    EscrowState.updateTrade(tradeId, { status: 'AWAITING_RELEASE_APPROVAL' });

    // Notify Admin for manual approval (to be secure)
    bot.telegram.sendMessage(ADMIN_ID, `🚨 **ADMIN ACTION REQUIRED: FUND RELEASE**
Trade ID: \`${tradeId}\`
Seller: @${trade.sellerUsername}
Buyer: @${trade.buyerUsername}
Amount: ${trade.amount} ${trade.currency1}
Seller Address: \`${trade.seller_crypto_address}\` (Verify this is correct!)

**Action:** Verify the service/goods were delivered, then approve the release.`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Approve Payout', `admin_approve_${tradeId}`),
                Markup.button.callback('❌ Open Dispute', `admin_dispute_${tradeId}`)
            ]
        ])
    });

    await ctx.editMessageText('👍 **Release Requested!** An administrator has been notified to verify completion and approve the payout.', { parse_mode: 'Markdown' });
});

// --- Feature 6: Admin Actions ---
bot.action(/admin_approve_(\w+)/, async (ctx) => {
    const tradeId = ctx.match[1];
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.answerCbQuery('❌ You are not the administrator.');
    }
    const trade = EscrowState.getTrade(tradeId);

    if (!trade || trade.status !== 'AWAITING_RELEASE_APPROVAL') {
        return ctx.answerCbQuery('❌ Trade is not in the correct state for approval.');
    }

    await ctx.editMessageText('🚀 **Admin Approved.** Initiating crypto withdrawal to seller...');

    // SIMULATION NOTE: In a production bot, you MUST check the Coinpayments balance 
    // and convert/withdraw the held crypto amount to the seller's desired coin.
    // For this boilerplate, we'll use a placeholder withdrawal amount.
    try {
        const withdrawalAmount = 0.005; // Placeholder: Replace with actual balance lookup
        const withdrawalCurrency = 'BTC'; // Placeholder: Replace with actual coin

        const withdrawal = await cpClient.createWithdrawal(
            withdrawalAmount, 
            withdrawalCurrency, 
            trade.seller_crypto_address
        );

        if (withdrawal && withdrawal.id) {
            EscrowState.updateTrade(tradeId, { 
                status: 'FUNDS_WITHDRAWING', 
                withdrawal_id: withdrawal.id 
            });

            await ctx.editMessageText(`✅ **Funds Sent!** The payment has been initiated to the seller's address.
Withdrawal ID: \`${withdrawal.id}\`
Amount: ${withdrawalAmount} ${withdrawalCurrency}.
Final status will be confirmed by a subsequent IPN.`, { parse_mode: 'Markdown' });

            bot.telegram.sendMessage(trade.sellerId, '🎉 **ESCROW COMPLETE!** Your payment has been sent.', { parse_mode: 'Markdown' });
            bot.telegram.sendMessage(trade.buyerId, '👍 **Trade Complete!** Funds have been released to the seller.', { parse_mode: 'Markdown' });

        } else {
             throw new Error('Coinpayments did not return a valid withdrawal ID.');
        }
    } catch (error) {
        console.error('Coinpayments Withdrawal Error:', error);
        ctx.editMessageText('❌ **Payout Error:** Could not initiate withdrawal. Check API logs.', { parse_mode: 'Markdown' });
    }
});


bot.action(/admin_dispute_(\w+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ You are not the administrator.');
    const tradeId = ctx.match[1];
    EscrowState.updateTrade(tradeId, { status: 'DISPUTE' });
    await ctx.editMessageText(`⚠️ **Dispute Opened** for trade \`${tradeId}\`. Admin will manually review and contact parties.`, { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(EscrowState.getTrade(tradeId).sellerId, '⚠️ **DISPUTE ALERT!** An admin has opened a dispute on your trade.', { parse_mode: 'Markdown' });
    bot.telegram.sendMessage(EscrowState.getTrade(tradeId).buyerId, '⚠️ **DISPUTE ALERT!** An admin has opened a dispute on your trade.', { parse_mode: 'Markdown' });
});


// Fallback for unhandled text/commands
bot.on('text', (ctx) => {
    if (ctx.session.step === 'IDLE') {
        ctx.reply('I don\'t understand that command. Use /start to begin a new escrow.');
    }
    // All other steps are handled above
});

// Launch Bot and IPN Server
bot.launch()
    .then(() => {
        console.log('🤖 Telegram Bot launched!');
        startIpnServer();
    })
    .catch(err => console.error('Error launching bot/server:', err));

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Export bot for IPN server to use
module.exports = { bot };
