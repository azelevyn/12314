// state/EscrowState.js

const activeTrades = new Map();

const EscrowState = {
    createTrade: (tradeData) => {
        const tradeId = `${tradeData.sellerId}-${Date.now()}`;
        const newTrade = {
            tradeId,
            ...tradeData,
            status: 'WAITING_FOR_JOIN',
        };
        activeTrades.set(tradeId, newTrade);
        return newTrade;
    },
    getTrade: (tradeId) => activeTrades.get(tradeId),
    updateTrade: (tradeId, updates) => {
        const trade = activeTrades.get(tradeId);
        if (trade) {
            const updatedTrade = { ...trade, ...updates };
            activeTrades.set(tradeId, updatedTrade);
            return updatedTrade;
        }
        return null;
    },
    deleteTrade: (tradeId) => activeTrades.delete(tradeId),
    getTradeByCPTxnId: (txnId) => {
        for (const trade of activeTrades.values()) {
            if (trade.coinpayments_txn_id === txnId) {
                return trade;
            }
        }
        return null;
    }
};

module.exports = EscrowState;
