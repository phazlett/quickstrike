/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createIbkrAdapter({ getConnectionSettings }) {
  const bridge = window.electronIBKR;
  const recentErrorAtByMessage = new Map();
  const ERROR_DEDUPE_WINDOW_MS = 6_000;

  if (!bridge) {
    throw new Error('IBKR bridge is unavailable. Run QuickStrike via Electron with preload enabled.');
  }

  async function connect() {
    const settings = getConnectionSettings?.() ?? {};
    return bridge.connect(settings);
  }

  async function disconnect() {
    return bridge.disconnect();
  }

  async function listAccounts() {
    return bridge.listAccounts();
  }

  async function listPositions(accountNumber) {
    return bridge.listPositions(accountNumber);
  }

  async function submitOrder(accountNumber, order) {
    return bridge.submitOrder(accountNumber, order);
  }

  async function getOptionChain(symbol) {
    return bridge.getOptionChain(symbol);
  }

  async function getEquityOptionsBySymbols(symbols) {
    return bridge.getEquityOptionsBySymbols(symbols);
  }

  function createMarketDataClient({
    onConnectionState,
    onQuote,
    onError,
    onFeedReady,
  }) {
    const removeListeners = [];

    const removeConnectionState = bridge.onConnectionState?.(payload => {
      const isLive = !!payload?.isLive;
      onConnectionState?.(isLive);
    });
    if (typeof removeConnectionState === 'function') {
      removeListeners.push(removeConnectionState);
    }

    const removeQuote = bridge.onQuote?.(payload => {
      onQuote?.(payload);
    });
    if (typeof removeQuote === 'function') {
      removeListeners.push(removeQuote);
    }

    const removeError = bridge.onError?.(payload => {
      const message = `${payload?.message ?? 'IBKR market data error.'}`;

      const now = Date.now();
      const key = message.trim().toLowerCase();
      const lastSeenAt = recentErrorAtByMessage.get(key) ?? 0;
      if (now - lastSeenAt < ERROR_DEDUPE_WINDOW_MS) {
        return;
      }

      recentErrorAtByMessage.forEach((seenAt, existingKey) => {
        if (now - seenAt > ERROR_DEDUPE_WINDOW_MS * 5) {
          recentErrorAtByMessage.delete(existingKey);
        }
      });
      recentErrorAtByMessage.set(key, now);

      onError?.(message);
    });
    if (typeof removeError === 'function') {
      removeListeners.push(removeError);
    }

    const removeFeedReady = bridge.onFeedReady?.(() => {
      onFeedReady?.();
    });
    if (typeof removeFeedReady === 'function') {
      removeListeners.push(removeFeedReady);
    }

    async function ensureReady() {
      return;
    }

    async function addQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;
      await bridge.addQuoteSubscriptions(symbols);
    }

    async function removeQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;
      await bridge.removeQuoteSubscriptions(symbols);
    }

    async function reapplyQuoteSubscriptions(streamerSymbols) {
      const symbols = Array.isArray(streamerSymbols) ? streamerSymbols.filter(Boolean) : [];
      if (symbols.length === 0) return;
      await bridge.addQuoteSubscriptions(symbols);
    }

    async function subscribeUnderlyingSymbol(symbol) {
      await bridge.subscribeUnderlyingSymbol(symbol);
    }

    async function clearConnection() {
      await bridge.clearMarketData();
      removeListeners.forEach(remove => {
        try {
          remove();
        } catch {
          // no-op
        }
      });
      removeListeners.length = 0;
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
    connect,
    disconnect,
    listAccounts,
    listPositions,
    submitOrder,
    getOptionChain,
    getEquityOptionsBySymbols,
    createMarketDataClient,
  };
}

window.createIbkrAdapter = createIbkrAdapter;
