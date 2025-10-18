// CoinpaymentsAPI.js

const coinpayments = require('coinpayments-apiv2');

class CoinpaymentsAPI {
    constructor(publicKey, privateKey, merchantId, ipnUrl) {
        this.client = new coinpayments({
            key: publicKey,
            secret: privateKey
        });
        this.merchantId = merchantId;
        this.ipnUrl = ipnUrl;
    }

    /**
     * Creates a Coinpayments transaction (deposit for escrow)
     */
    async createEscrowDeposit(amount, currency1, currency2, buyerEmail, customTradeId) {
        const options = {
            currency1: currency1,
            currency2: currency2,
            amount: amount,
            buyer_email: buyerEmail,
            ipn_url: this.ipnUrl, // The public URL of your IPN server
            custom: customTradeId,
            item_name: `Escrow Trade #${customTradeId}`,
            auto_confirm: 1 
        };

        return this.client.createTransaction(options);
    }

    /**
     * Creates a withdrawal (payout from escrow)
     */
    async createWithdrawal(amount, currency, address) {
        const options = {
            amount: amount,
            currency: currency,
            address: address,
            auto_confirm: 1, // Automatically confirm the withdrawal
            ipn_url: this.ipnUrl, // IPN for withdrawal status
        };
        return this.client.createWithdrawal(options);
    }
}

module.exports = CoinpaymentsAPI;
