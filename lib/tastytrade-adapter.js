// SPDX-License-Identifier: MIT
/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createTastyTradeAdapter({ apiClient }) {
  const MARKET_DATA_CONTROL_CHANNEL = 0;
  const MARKET_DATA_FEED_CHANNEL = 3;
  const MARKET_DATA_AGGREGATION_PERIOD_SECONDS = 1;

  async function get(path) {
    return apiClient.get(path);
  }

  async function post(path, body) {
    return apiClient.post(path, body);
  }

  async function listAccounts() {
    return apiClient.get('/customers/me/accounts');
  }

  async function listPositions(accountNumber) {
    return apiClient.get(`/accounts/${accountNumber}/positions`);
  }

  async function submitOrder(accountNumber, order) {
    return apiClient.post(`/accounts/${accountNumber}/orders`, order);
  }

  async function listLiveOrders(accountNumber) {
    return apiClient.get(`/accounts/${accountNumber}/orders/live`);
  }

  async function cancelOrder(accountNumber, orderId) {
    const encodedOrderId = encodeURIComponent(orderId);
    return apiClient.del(`/accounts/${accountNumber}/orders/${encodedOrderId}`);
  }

  async function getOptionChain(symbol) {
    return apiClient.get(`/option-chains/${symbol}/nested`);
  }

  async function getEquityInstrument(symbol) {
    return apiClient.get(`/instruments/equities/${symbol}`);
  }

  async function getEquityOptionsBySymbols(symbols) {
    const validSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
    const query = validSymbols.map(symbol => `symbol[]=${encodeURIComponent(symbol)}`).join('&');
    return apiClient.get(`/instruments/equity-options?${query}`);
  }

  async function getQuoteToken() {
    return apiClient.get('/api-quote-tokens');
  }

  function createMarketDataClient({
    hasAccessToken,
    onConnectionState,
    onUnderlyingTrade,
    onQuote,
    onError,
    onFeedReady,
  }) {
    // These channel and aggregation values align with TastyTrade's DXLink protocol.
    const marketDataManager = window.createTastyTradeMarketDataManager({
      controlChannel: MARKET_DATA_CONTROL_CHANNEL,
      feedChannel: MARKET_DATA_FEED_CHANNEL,
      aggregationPeriodSeconds: MARKET_DATA_AGGREGATION_PERIOD_SECONDS,
      getQuoteToken: () => getQuoteToken(),
      getEquityInstrument: symbol => getEquityInstrument(symbol),
      hasAccessToken,
      onConnectionState,
      onUnderlyingTrade,
      onQuote,
      onError,
      onFeedReady,
    });

    async function ensureReady() {
      await marketDataManager.ensureReady();
    }

    async function addQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;

      await ensureReady();
      marketDataManager.sendMessage({
        type: 'FEED_SUBSCRIPTION',
        channel: MARKET_DATA_FEED_CHANNEL,
        add: symbols.map(symbol => ({ type: 'Quote', symbol })),
      });
    }

    function removeQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;

      marketDataManager.sendMessage({
        type: 'FEED_SUBSCRIPTION',
        channel: MARKET_DATA_FEED_CHANNEL,
        remove: symbols.map(symbol => ({ type: 'Quote', symbol })),
      });
    }

    function reapplyQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;

      marketDataManager.sendMessage({
        type: 'FEED_SUBSCRIPTION',
        channel: MARKET_DATA_FEED_CHANNEL,
        add: symbols.map(symbol => ({ type: 'Quote', symbol })),
      });
    }

    async function subscribeUnderlyingSymbol(symbol) {
      await marketDataManager.subscribeUnderlyingSymbol(symbol);
    }

    function clearConnection() {
      marketDataManager.clearConnection();
    }

    return {
      ensureReady,
      addQuoteSubscriptions,
      removeQuoteSubscriptions,
      reapplyQuoteSubscriptions,
      subscribeUnderlyingSymbol,
      clearConnection,
    };
  }

  return {
    get,
    post,
    listAccounts,
    listPositions,
    submitOrder,
    listLiveOrders,
    cancelOrder,
    getOptionChain,
    getEquityInstrument,
    getEquityOptionsBySymbols,
    getQuoteToken,
    createMarketDataClient,
  };
}

window.createTastyTradeAdapter = createTastyTradeAdapter;
