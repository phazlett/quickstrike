/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createDxlinkManager({
  controlChannel,
  feedChannel,
  aggregationPeriodSeconds,
  apiGet,
  hasAccessToken,
  onConnectionState,
  onUnderlyingTrade,
  onQuote,
  onFeedReady,
  onError,
}) {
  let socket = null;
  let feedReady = false;
  let keepaliveTimer = null;
  let reconnectInFlight = null;
  let quoteToken = null;
  let dxlinkUrl = null;
  let autoReconnectTimer = null;
  let autoReconnectAttempts = 0;
  let selectedStreamerSymbol = null;
  const symbolMapCache = new Map();

  function sendMessage(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function normalizeCompactEvents(eventType, payload) {
    if (!Array.isArray(payload) || payload.length === 0) return [];
    if (Array.isArray(payload[0])) return payload;

    const fieldCountByType = {
      Trade: 3,
      Quote: 4,
    };

    const fieldCount = fieldCountByType[eventType];
    if (!fieldCount) return [payload];

    const events = [];
    for (let index = 0; index + fieldCount - 1 < payload.length; index += fieldCount) {
      events.push(payload.slice(index, index + fieldCount));
    }

    return events;
  }

  function extractFeedEvents(rawData) {
    if (!Array.isArray(rawData) || rawData.length === 0) return [];

    const extracted = [];
    const appendEvent = entry => {
      if (!Array.isArray(entry) || entry.length === 0) return;

      const eventType = entry[0];
      if (typeof eventType !== 'string') return;

      if (entry.length >= 3 && !Array.isArray(entry[1])) {
        extracted.push({ eventType, eventRow: entry });
        return;
      }

      const payload = entry[1];
      const events = normalizeCompactEvents(eventType, payload);
      events.forEach(eventRow => {
        extracted.push({ eventType, eventRow });
      });
    };

    if (typeof rawData[0] === 'string') {
      appendEvent(rawData);
      return extracted;
    }

    rawData.forEach(appendEvent);
    return extracted;
  }

  function handleFeedData(rawData) {
    const events = extractFeedEvents(rawData);
    if (events.length === 0) return;

    events.forEach(({ eventType, eventRow }) => {
      if (!Array.isArray(eventRow) || eventRow.length < 3) return;

      const eventSymbol = eventRow[1];

      if (eventType === 'Trade') {
        if (eventSymbol !== selectedStreamerSymbol) return;

        const price = Number(eventRow[2]);
        if (Number.isFinite(price)) {
          onUnderlyingTrade?.(price);
        }
        return;
      }

      if (eventType === 'Quote') {
        const bidPrice = Number(eventRow[2]);
        const askPrice = Number(eventRow[3]);

        onQuote?.({
          eventSymbol,
          bidPrice,
          askPrice,
          isUnderlying: eventSymbol === selectedStreamerSymbol,
        });
      }
    });
  }

  function startKeepalive() {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }

    keepaliveTimer = setInterval(() => {
      sendMessage({ type: 'KEEPALIVE', channel: controlChannel });
    }, 30_000);
  }

  async function getQuoteToken() {
    const quote = await apiGet('/api-quote-tokens');
    const token = quote?.data?.token;
    const url = quote?.data?.['dxlink-url'];

    if (!token || !url) {
      throw new Error('Unable to get market data token');
    }

    quoteToken = token;
    dxlinkUrl = url;
  }

  async function resolveStreamerSymbol(symbol) {
    if (symbolMapCache.has(symbol)) {
      return symbolMapCache.get(symbol);
    }

    const instrument = await apiGet(`/instruments/equities/${symbol}`);
    const streamerSymbol = instrument?.data?.['streamer-symbol'] || symbol;
    symbolMapCache.set(symbol, streamerSymbol);
    return streamerSymbol;
  }

  function scheduleReconnect() {
    if (!hasAccessToken?.()) return;
    if (autoReconnectTimer) return;

    const delayMs = Math.min(30_000, 1_000 * (2 ** autoReconnectAttempts));
    autoReconnectAttempts += 1;

    autoReconnectTimer = setTimeout(async () => {
      autoReconnectTimer = null;

      try {
        await ensureReady();
        autoReconnectAttempts = 0;
      } catch {
        scheduleReconnect();
      }
    }, delayMs);
  }

  async function ensureReady() {
    if (feedReady && socket?.readyState === WebSocket.OPEN) return;
    if (reconnectInFlight) return reconnectInFlight;

    reconnectInFlight = new Promise(async (resolve, reject) => {
      let settled = false;
      let timeoutId = null;

      const finishResolve = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        reconnectInFlight = null;
        resolve();
      };

      const finishReject = error => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        reconnectInFlight = null;
        reject(error);
      };

      try {
        await getQuoteToken();
        socket = new WebSocket(dxlinkUrl);

        socket.onopen = () => {
          sendMessage({
            type: 'SETUP',
            channel: controlChannel,
            version: '0.1-DXF-JS/0.3.0',
            keepaliveTimeout: 60,
            acceptKeepaliveTimeout: 60,
          });
        };

        socket.onmessage = event => {
          let message = null;

          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }

          if (!message?.type) return;

          if (message.type === 'AUTH_STATE') {
            if (message.state === 'UNAUTHORIZED') {
              sendMessage({
                type: 'AUTH',
                channel: controlChannel,
                token: quoteToken,
              });
            }

            if (message.state === 'AUTHORIZED') {
              sendMessage({
                type: 'CHANNEL_REQUEST',
                channel: feedChannel,
                service: 'FEED',
                parameters: { contract: 'AUTO' },
              });
            }
            return;
          }

          if (message.type === 'CHANNEL_OPENED' && message.channel === feedChannel) {
            sendMessage({
              type: 'FEED_SETUP',
              channel: feedChannel,
              acceptAggregationPeriod: aggregationPeriodSeconds,
              acceptDataFormat: 'COMPACT',
              acceptEventFields: {
                Trade: ['eventType', 'eventSymbol', 'price'],
                Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
              },
            });
            return;
          }

          if (message.type === 'FEED_CONFIG' && message.channel === feedChannel) {
            feedReady = true;
            startKeepalive();
            onConnectionState?.(true);

            if (autoReconnectTimer) {
              clearTimeout(autoReconnectTimer);
              autoReconnectTimer = null;
            }
            autoReconnectAttempts = 0;

            if (selectedStreamerSymbol) {
              sendMessage({
                type: 'FEED_SUBSCRIPTION',
                channel: feedChannel,
                reset: true,
                add: [
                  { type: 'Trade', symbol: selectedStreamerSymbol },
                  { type: 'Quote', symbol: selectedStreamerSymbol },
                ],
              });
            }

            onFeedReady?.();
            finishResolve();
            return;
          }

          if (message.type === 'FEED_DATA' && message.channel === feedChannel) {
            handleFeedData(message.data);
          }
        };

        socket.onerror = () => {
          onConnectionState?.(false);
          onError?.('Market data stream disconnected. Reconnecting...');
          scheduleReconnect();
        };

        socket.onclose = () => {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }

          feedReady = false;
          socket = null;
          reconnectInFlight = null;
          onConnectionState?.(false);
          scheduleReconnect();
        };

        timeoutId = setTimeout(() => {
          if (!feedReady) {
            finishReject(new Error('Market data connection timeout'));
          }
        }, 10_000);
      } catch (error) {
        scheduleReconnect();
        finishReject(error);
      }
    });

    return reconnectInFlight;
  }

  async function subscribeUnderlyingSymbol(symbol) {
    if (!hasAccessToken?.()) return;

    const streamerSymbol = await resolveStreamerSymbol(symbol);
    selectedStreamerSymbol = streamerSymbol;

    await ensureReady();

    sendMessage({
      type: 'FEED_SUBSCRIPTION',
      channel: feedChannel,
      reset: true,
      add: [
        { type: 'Trade', symbol: streamerSymbol },
        { type: 'Quote', symbol: streamerSymbol },
      ],
    });
  }

  function clearConnection() {
    if (autoReconnectTimer) {
      clearTimeout(autoReconnectTimer);
      autoReconnectTimer = null;
    }

    autoReconnectAttempts = 0;

    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
    }

    socket = null;
    feedReady = false;
    reconnectInFlight = null;
    quoteToken = null;
    dxlinkUrl = null;
    selectedStreamerSymbol = null;
    onConnectionState?.(false);
  }

  return {
    ensureReady,
    sendMessage,
    subscribeUnderlyingSymbol,
    clearConnection,
  };
}

window.createDxlinkManager = createDxlinkManager;
