// ipn_server.js

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const EscrowState = require('./state/EscrowState');
// This line links back to index.js to get the bot instance for messaging
const Bot = require('./index').bot; 
const config = {
    ipnSecret: process.env.CP_IPN_SECRET,
    merchantId: process.env.CP_MERCHANT_ID,
    adminId: process.env.ADMIN_ID,
};

const app = express();
const port = process.env.IPN_SERVER_PORT || 3000;

// Coinpayments sends application/x-www-form-urlencoded data
// We need the raw body for HMAC validation
app.use(bodyParser.urlencoded({ extended: true, verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Store raw body for HMAC
}}));

/**
 * SECURE COINPAYMENTS IPN HANDLER (CRITICAL SECURITY)
 */
app.post('/coinpayments/ipn', async (req, res) => {
    const ipnData = req.body;
    const hmacHeader = req.get('HMAC');

    // --- 1. Security Validation (CRITICAL) ---
    if (!hmacHeader || !ipnData.merchant || ipnData.merchant !== config.merchantId) {
        console.error('IPN Security Check Failed: No HMAC or invalid Merchant ID');
        return res.status(401).end('Unauthorized - Invalid Merchant ID or No HMAC');
    }

    // Hash the raw POST data with your IPN Secret
    const hmac = crypto.createHmac('sha512', config.ipnSecret)
                       .update(req.rawBody)
                       .digest('hex');

    if (hmac !== hmacHeader) {
        console.error('IPN Security Check Failed: HMAC mismatch');
        return res.status(401).end('Unauthorized - HMAC mismatch');
    }

    // --- 2. IPN Data Processing ---
    const txnId = ipnData.txn_id;
    const status = parseInt(ipnData.status);
    const customTradeId = ipnData.custom; // Our internal trade ID

    if (ipnData.ipn_type === 'api') {
        const trade = EscrowState.getTrade(customTradeId) || EscrowState.getTradeByCPTxnId(txnId);

        if (!trade) {
            console.warn(`IPN received for unknown trade ID: ${customTradeId} / TXN ID: ${txnId}`);
            return res.status(200).end('IPN OK - Unknown trade');
        }

        const buyerChatId = trade.buyerId;
        const sellerChatId = trade.sellerId;

        if (status >= 100) {
            // Payment Complete (funds are now in your Coinpayments wallet/escrow)
            if (trade.status === 'PENDING_BUYER_DEPOSIT') {
                EscrowState.updateTrade(trade.tradeId, { 
                    status: 'FUNDS_RECEIVED_IN_ESCROW',
                    buyer_crypto_address: ipnData.address,
                });
                
                // Notify Buyer and Seller
                Bot.telegram.sendMessage(buyerChatId, `✅ **Payment Confirmed!** The funds are now securely held in escrow. Please inform the seller to deliver the service/goods.`, { parse_mode: 'Markdown' });
                Bot.telegram.sendMessage(sellerChatId, `💰 **Escrow Funded!** Payment for trade \`${trade.tradeId}\` has been received. You can now deliver the service/product.`, { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Release Funds (Completion)', callback_data: `release_${trade.tradeId}` }]
                        ]
                    }
                });
                console.log(`Trade ${trade.tradeId}: Funds received in escrow.`);

            } else {
                console.warn(`IPN Status 100 received for trade ${trade.tradeId} but trade status is not PENDING_BUYER_DEPOSIT.`);
            }
        } else if (status < 0) {
            // Payment Error/Refund
            EscrowState.updateTrade(trade.tradeId, { status: 'PAYMENT_FAILED' });
            Bot.telegram.sendMessage(buyerChatId, `❌ **Payment Failed/Refunded:** The payment for trade \`${trade.tradeId}\` failed. Reason: ${ipnData.status_text}.`, { parse_mode: 'Markdown' });
            Bot.telegram.sendMessage(sellerChatId, `❌ **Trade Failed:** The buyer's payment for trade \`${trade.tradeId}\` failed. Reason: ${ipnData.status_text}.`, { parse_mode: 'Markdown' });
            console.log(`Trade ${trade.tradeId}: Payment failed.`);
        } else {
            // Pending Status (e.g., waiting for confirmations)
            console.log(`Trade ${trade.tradeId}: Payment is still pending (Status: ${status}).`);
        }
    } else if (ipnData.ipn_type === 'withdrawal') {
        // Handle withdrawal IPNs here (e.g., when releasing funds to the seller)
        if (status >= 100) {
            // Withdrawal Complete
            console.log(`Withdrawal complete for TXN ${txnId}.`);
            Bot.telegram.sendMessage(config.adminId, `✅ **Withdrawal Complete!** TXN: ${txnId}. Amount: ${ipnData.amount}. To Address: ${ipnData.address}.`, { parse_mode: 'Markdown' });
        }
    }
    
    // Always return a 200 OK to stop Coinpayments from sending more IPNs
    res.status(200).end('IPN OK');
});


app.get('/', (req, res) => {
    res.send('Escrow Bot IPN Server is running.');
});

// Function to start the server
const startIpnServer = () => {
    app.listen(port, () => {
        console.log(`🚀 IPN Server running on port ${port}`);
        console.log(`⚠️ Make sure your PUBLIC_IPN_URL is set to a public address that forwards to this port!`);
    });
};

module.exports = { startIpnServer };
