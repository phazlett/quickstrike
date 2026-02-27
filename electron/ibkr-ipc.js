// SPDX-License-Identifier: MIT
const ibkr = require('@stoqey/ibkr').default;
const { IBKRConnection, MarketDataManager, Portfolios, Orders, AccountSummary } = require('@stoqey/ibkr');
const { IBApiTickType, OrderType, SecType } = require('@stoqey/ib');

const IBKR_LOG_FILTER_FLAG = '__quickstrikeIbkrLogFilterInstalled';
let suppressDisconnectStateLogs = true;

function toBoolean(value, defaultValue) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }

  return defaultValue;
}

function configureIbkrLogging(settings = {}) {
  suppressDisconnectStateLogs = toBoolean(settings?.suppressDisconnectStateLogs, true);
}

function installIbkrLogFilter() {
  if (globalThis[IBKR_LOG_FILTER_FLAG]) return;
  globalThis[IBKR_LOG_FILTER_FLAG] = true;

  const originalConsoleLog = console.log.bind(console);
  console.log = (...args) => {
    const first = `${args?.[0] ?? ''}`.trim();
    const second = `${args?.[1] ?? ''}`.trim();
    const isNoisyIbkrDisconnectLog =
      first === 'ConnectionState.Disconnected'
      && (second === '0' || second.length === 0 || Number(second) === 0);

    if (isNoisyIbkrDisconnectLog && suppressDisconnectStateLogs) {
      return;
    }

    originalConsoleLog(...args);
  };
}

installIbkrLogFilter();

let handlersRegistered = false;
let mainWindowProvider = null;

let isConnected = false;
let activeUnderlyingSymbol = null;
const marketDataSubscriptionsBySymbol = new Map();
const optionContractCache = new Map();
const ibErrorLastSentAtByKey = new Map();
const IB_ERROR_DEDUPE_WINDOW_MS = 8_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out while ${label}.`));
    }, ms);

    Promise.resolve(promise)
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function getMainWindow() {
  return mainWindowProvider?.() ?? null;
}

function emitToRenderer(channel, payload) {
  if (channel === 'ibkr:error' && shouldSuppressIbError(payload)) {
    return;
  }

  if (channel === 'ibkr:error' && shouldDedupeIbError(payload)) {
    return;
  }

  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function normalizeIbErrorMessage(message) {
  return `${message ?? ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldDedupeIbError(payload) {
  const message = normalizeIbErrorMessage(payload?.message);
  const code = `${payload?.code ?? ''}`.trim().toLowerCase();
  if (!message && !code) return false;

  const key = `${code}::${message}`;
  const now = Date.now();
  const lastSentAt = ibErrorLastSentAtByKey.get(key) ?? 0;

  if (now - lastSentAt < IB_ERROR_DEDUPE_WINDOW_MS) {
    return true;
  }

  ibErrorLastSentAtByKey.forEach((seenAt, existingKey) => {
    if (now - seenAt > IB_ERROR_DEDUPE_WINDOW_MS * 6) {
      ibErrorLastSentAtByKey.delete(existingKey);
    }
  });
  ibErrorLastSentAtByKey.set(key, now);

  return false;
}

function shouldSuppressIbError(payload) {
  const code = Number(payload?.code);
  const message = `${payload?.message ?? ''}`.toLowerCase();

  if (code === 321) return true;
  if (message.includes('only the default client') && message.includes('auto bind orders')) return true;

  return false;
}

function normalizeOptionSymbol(raw) {
  return `${raw ?? ''}`.replace(/\s+/g, '').trim().toUpperCase();
}

function toIsoDateFromIb(yyyymmdd) {
  const value = `${yyyymmdd ?? ''}`.trim();
  if (!/^\d{8}$/.test(value)) return null;
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  return `${year}-${month}-${day}`;
}

function toOccDateFromIso(yyyyMmDd) {
  const value = `${yyyyMmDd ?? ''}`.trim();
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[1].slice(2)}${match[2]}${match[3]}`;
}

function formatStrikeForOcc(strike) {
  const numeric = Number(strike);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 1000).toString().padStart(8, '0');
}

function buildOptionSymbol({ underlyingSymbol, expirationDateIso, right, strikePrice }) {
  const occDate = toOccDateFromIso(expirationDateIso);
  const formattedStrike = formatStrikeForOcc(strikePrice);
  if (!occDate || !formattedStrike) return null;

  return normalizeOptionSymbol(`${underlyingSymbol}${occDate}${right}${formattedStrike}`);
}

function parseOptionSymbol(optionSymbol) {
  const compactSymbol = normalizeOptionSymbol(optionSymbol);
  const match = compactSymbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) return null;

  const underlyingSymbol = match[1];
  const expirationDate = `20${match[2]}-${match[3]}-${match[4]}`;
  const right = match[5];
  const strikePrice = Number.parseInt(match[6], 10) / 1000;

  if (!Number.isFinite(strikePrice)) return null;

  return {
    underlyingSymbol,
    expirationDate,
    right,
    strikePrice,
  };
}

function toIbOptionContract(optionSymbol) {
  const parsed = parseOptionSymbol(optionSymbol);
  if (!parsed) return null;

  return {
    symbol: parsed.underlyingSymbol,
    secType: SecType.OPT,
    currency: 'USD',
    exchange: 'SMART',
    multiplier: '100',
    lastTradeDateOrContractMonth: parsed.expirationDate.replace(/-/g, ''),
    strike: parsed.strikePrice,
    right: parsed.right,
  };
}

function toIbUnderlyingContract(symbol) {
  return {
    symbol,
    secType: SecType.STK,
    currency: 'USD',
    exchange: 'SMART',
  };
}

function scoreUnderlyingMatch(contract, symbol) {
  if (!contract) return Number.NEGATIVE_INFINITY;

  const normalizedSymbol = `${symbol ?? ''}`.trim().toUpperCase();
  const contractSymbol = `${contract.symbol ?? ''}`.trim().toUpperCase();
  const secType = `${contract.secType ?? ''}`.trim().toUpperCase();
  const currency = `${contract.currency ?? ''}`.trim().toUpperCase();
  const exchange = `${contract.exchange ?? ''}`.trim().toUpperCase();
  const primaryExchange = `${contract.primaryExchange ?? ''}`.trim().toUpperCase();

  if (contractSymbol !== normalizedSymbol) return Number.NEGATIVE_INFINITY;
  if (secType !== SecType.STK) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (Number.isFinite(Number(contract.conId)) && Number(contract.conId) > 0) score += 100;
  if (currency === 'USD') score += 80;
  if (primaryExchange === 'ARCA') score += 40;
  if (exchange === 'ARCA') score += 30;
  if (exchange === 'SMART') score += 20;

  return score;
}

function pickPreferredUnderlyingContract(symbol, matches) {
  const contracts = (Array.isArray(matches) ? matches : [])
    .map(item => item?.contract ?? item)
    .filter(Boolean);

  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  contracts.forEach(contract => {
    const score = scoreUnderlyingMatch(contract, symbol);
    if (score > bestScore) {
      best = contract;
      bestScore = score;
    }
  });

  return best;
}

function pickTickValue(tickMap, tickTypeIds) {
  if (!tickMap || typeof tickMap.get !== 'function') return null;

  for (const tickTypeId of tickTypeIds) {
    const tick = tickMap.get(tickTypeId);
    const numericValue = Number(tick?.value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue;
    }
  }

  return null;
}

function toQuotePayload({ eventSymbol, tickMap, isUnderlying }) {
  const bidPrice = pickTickValue(tickMap, [IBApiTickType.BID, IBApiTickType.DELAYED_BID]);
  const askPrice = pickTickValue(tickMap, [IBApiTickType.ASK, IBApiTickType.DELAYED_ASK]);
  const lastPrice = pickTickValue(tickMap, [IBApiTickType.LAST, IBApiTickType.DELAYED_LAST]);
  const mark = lastPrice ?? bidPrice ?? askPrice;

  return {
    eventSymbol,
    bidPrice: bidPrice ?? mark,
    askPrice: askPrice ?? mark,
    isUnderlying,
  };
}

async function connectIbkr(settings = {}) {
  const host = `${settings?.host ?? '127.0.0.1'}`.trim() || '127.0.0.1';
  const port = Number.parseInt(settings?.port, 10);
  const clientId = Number.parseInt(settings?.clientId, 10);

  configureIbkrLogging(settings);

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('IBKR connection requires a valid port.');
  }

  process.env.IBKR_HOST = host;
  process.env.IBKR_PORT = `${port}`;
  process.env.IBKR_CLIENT_ID = Number.isFinite(clientId) ? `${clientId}` : '0';

  try {
    await withTimeout(ibkr(), 15000, 'initializing IBKR bridge');

    const connected = await withTimeout(
      IBKRConnection.Instance.init({
        host,
        port,
        reconnectInterval: 1000,
        connectionWatchdogInterval: 1,
      }),
      15000,
      `connecting to IBKR at ${host}:${port}`,
    );

    if (!connected) {
      throw new Error(`Unable to connect to IBKR at ${host}:${port}.`);
    }

    AccountSummary.Instance.init();
    await withTimeout(AccountSummary.Instance.getAccountSummaryUpdates(), 15000, 'loading account summary');
    Portfolios.Instance.init();
    await withTimeout(Portfolios.Instance.asyncPortfolios(), 15000, 'loading positions');
    try {
      await withTimeout(Orders.Instance.init(), 15000, 'initializing orders');
      await withTimeout(Orders.Instance.asyncOpenOrders(), 15000, 'loading open orders');
    } catch (err) {
      console.warn(`[IBKR] Startup warning: ${err?.message || 'unable to initialize order preload'}. Continuing without preloaded open orders.`);
    }

    isConnected = true;
    emitToRenderer('ibkr:connectionState', { isLive: true });
    emitToRenderer('ibkr:feedReady', { ready: true });
    return { ok: true };
  } catch (error) {
    disconnectIbkr();
    throw error;
  }
}

function disposeSubscription(symbol) {
  const subscription = marketDataSubscriptionsBySymbol.get(symbol);
  if (!subscription) return;

  try {
    subscription.unsubscribe();
  } catch {
    // no-op
  }

  marketDataSubscriptionsBySymbol.delete(symbol);
}

function clearMarketDataSubscriptions() {
  Array.from(marketDataSubscriptionsBySymbol.keys()).forEach(symbol => {
    disposeSubscription(symbol);
  });
  activeUnderlyingSymbol = null;
}

function disconnectIbkr() {
  clearMarketDataSubscriptions();
  optionContractCache.clear();
  ibErrorLastSentAtByKey.clear();

  try {
    IBKRConnection.Instance.disconnect();
  } catch {
    // no-op
  }

  isConnected = false;
  emitToRenderer('ibkr:connectionState', { isLive: false });
  return { ok: true };
}

function assertConnected() {
  if (!isConnected) {
    throw new Error('IBKR is not connected.');
  }
}

async function listAccounts() {
  assertConnected();

  const accountSummary = AccountSummary.Instance.getAccountSummary;
  const summaryAccountId = `${accountSummary?.accountId ?? ''}`.trim();

  const accountIds = new Set();
  if (summaryAccountId) accountIds.add(summaryAccountId);

  const positions = Portfolios.Instance.positions ?? [];
  positions.forEach(position => {
    const account = `${position?.account ?? ''}`.trim();
    if (account) accountIds.add(account);
  });

  if (accountIds.size === 0) {
    try {
      const managedAccounts = await withTimeout(
        IBKRConnection.Instance.ib.getManagedAccounts(),
        8000,
        'loading managed accounts',
      );

      (Array.isArray(managedAccounts) ? managedAccounts : []).forEach(account => {
        const normalized = `${account ?? ''}`.trim();
        if (normalized) accountIds.add(normalized);
      });
    } catch {
      // keep empty set and return empty list below
    }
  }

  const items = Array.from(accountIds).map(accountNumber => ({
    account: {
      'account-number': accountNumber,
      'nickname': 'IBKR',
      'account-type-name': 'Interactive Brokers',
    },
  }));

  return { data: { items } };
}

function toQuantityDirection(pos) {
  if (pos > 0) return 'Long';
  if (pos < 0) return 'Short';
  return 'Zero';
}

function toAverageOpenPrice(avgCost, secType) {
  const numeric = Number(avgCost);
  if (!Number.isFinite(numeric)) return null;
  if (secType === SecType.OPT) {
    return numeric / 100;
  }
  return numeric;
}

async function listPositions(accountNumber) {
  assertConnected();

  const positions = await Portfolios.Instance.asyncPortfolios();
  const filtered = (positions ?? [])
    .filter(position => `${position?.account ?? ''}` === `${accountNumber ?? ''}`)
    .filter(position => `${position?.contract?.secType ?? ''}` === SecType.OPT)
    .map(position => {
      const contract = position.contract ?? {};
      const optionSymbol = normalizeOptionSymbol(contract.localSymbol || contract.symbol || '');

      return {
        symbol: optionSymbol,
        'instrument-type': 'Equity Option',
        'underlying-symbol': `${contract.symbol ?? ''}`.toUpperCase(),
        'streamer-symbol': optionSymbol,
        quantity: Math.abs(Number(position?.pos ?? 0)),
        'quantity-direction': toQuantityDirection(Number(position?.pos ?? 0)),
        'average-open-price': toAverageOpenPrice(position?.avgCost, contract?.secType),
        'mark-price': Number(position?.marketPrice ?? null),
      };
    });

  return { data: { items: filtered } };
}

function mapOrderAction(action) {
  const normalized = `${action ?? ''}`.trim().toLowerCase();
  if (normalized.startsWith('buy')) return 'BUY';
  if (normalized.startsWith('sell')) return 'SELL';
  return null;
}

async function submitOrder(_accountNumber, order) {
  assertConnected();

  const leg = Array.isArray(order?.legs) ? order.legs[0] : null;
  if (!leg) {
    throw new Error('IBKR order requires at least one leg.');
  }

  const optionSymbol = normalizeOptionSymbol(leg.symbol);
  const action = mapOrderAction(leg.action);
  const quantity = Number(leg.quantity);

  if (!optionSymbol) throw new Error('IBKR order is missing option symbol.');
  if (!action) throw new Error('IBKR order action is invalid.');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('IBKR order quantity is invalid.');

  const contractTemplate = toIbOptionContract(optionSymbol);
  if (!contractTemplate) throw new Error(`Unable to parse option symbol '${optionSymbol}'.`);

  const contractDetails = await MarketDataManager.Instance.getContract(contractTemplate);
  if (!contractDetails) throw new Error(`Unable to resolve IBKR contract for '${optionSymbol}'.`);

  const didPlace = await Orders.Instance.placeOrder(contractDetails, {
    action,
    totalQuantity: quantity,
    orderType: OrderType.MKT,
    tif: 'DAY',
    transmit: true,
    outsideRth: false,
  });

  if (!didPlace) {
    throw new Error('IBKR rejected the order.');
  }

  return { data: { ok: true } };
}

async function resolveUnderlyingContract(symbol) {
  try {
    const matches = await IBKRConnection.Instance.ib.getMatchingSymbols(symbol);
    const preferredContract = pickPreferredUnderlyingContract(symbol, matches);
    if (preferredContract && Number.isFinite(Number(preferredContract.conId))) {
      return {
        conId: Number(preferredContract.conId),
        contract: {
          symbol,
          secType: SecType.STK,
          currency: `${preferredContract.currency ?? 'USD'}`.trim().toUpperCase() || 'USD',
          exchange: 'SMART',
          primaryExchange: `${preferredContract.primaryExchange ?? preferredContract.exchange ?? ''}`.trim().toUpperCase() || undefined,
          conId: Number(preferredContract.conId),
        },
      };
    }
  } catch {
    // fallback below
  }

  const details = await MarketDataManager.Instance.getContract(toIbUnderlyingContract(symbol));
  if (!details || !Number.isFinite(Number(details?.conId))) {
    throw new Error(`Unable to resolve underlying contract for '${symbol}'.`);
  }

  return details;
}

async function getUnderlyingReferencePrice(contractDetails) {
  try {
    const marketData = await IBKRConnection.Instance.ib.getMarketDataSnapshot(contractDetails.contract, '', false);
    const bid = pickTickValue(marketData, [IBApiTickType.BID, IBApiTickType.DELAYED_BID]);
    const ask = pickTickValue(marketData, [IBApiTickType.ASK, IBApiTickType.DELAYED_ASK]);
    const last = pickTickValue(marketData, [IBApiTickType.LAST, IBApiTickType.DELAYED_LAST]);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      return (bid + ask) / 2;
    }
    return last;
  } catch {
    return null;
  }
}

function pickOptionParam(params) {
  if (!Array.isArray(params) || params.length === 0) return null;

  const withData = params.filter(item => Array.isArray(item?.expirations) && Array.isArray(item?.strikes) && item.expirations.length > 0 && item.strikes.length > 0);
  if (withData.length === 0) return null;

  return withData.find(item => `${item.exchange ?? ''}`.toUpperCase() === 'SMART')
    ?? withData[0];
}

function trimStrikesToReference(strikes, referencePrice, maxCount = 80) {
  if (!Array.isArray(strikes)) return [];

  const numeric = strikes
    .map(strike => Number(strike))
    .filter(strike => Number.isFinite(strike) && strike > 0)
    .sort((a, b) => a - b);

  if (numeric.length <= maxCount || !Number.isFinite(referencePrice)) {
    return numeric;
  }

  return numeric
    .sort((a, b) => Math.abs(a - referencePrice) - Math.abs(b - referencePrice))
    .slice(0, maxCount)
    .sort((a, b) => a - b);
}

async function getOptionChain(symbol) {
  assertConnected();

  const normalizedSymbol = `${symbol ?? ''}`.trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error('IBKR option chain requires a symbol.');
  }

  const underlying = await resolveUnderlyingContract(normalizedSymbol);

  const params = await IBKRConnection.Instance.ib.getSecDefOptParams(
    normalizedSymbol,
    '',
    SecType.STK,
    Number(underlying.conId),
  );

  const chainParam = pickOptionParam(params);
  if (!chainParam) {
    return { data: { items: [] } };
  }

  const referencePrice = await getUnderlyingReferencePrice(underlying);
  const strikes = trimStrikesToReference(chainParam.strikes, referencePrice, 80);

  const expirations = Array.from(new Set(chainParam.expirations))
    .map(exp => `${exp ?? ''}`.trim())
    .filter(exp => /^\d{8}$/.test(exp))
    .sort((a, b) => a.localeCompare(b))
    .map(exp => {
      const expirationDateIso = toIsoDateFromIb(exp);
      const strikeItems = strikes.map(strikePrice => {
        const callSymbol = buildOptionSymbol({
          underlyingSymbol: normalizedSymbol,
          expirationDateIso,
          right: 'C',
          strikePrice,
        });
        const putSymbol = buildOptionSymbol({
          underlyingSymbol: normalizedSymbol,
          expirationDateIso,
          right: 'P',
          strikePrice,
        });

        if (callSymbol) optionContractCache.set(callSymbol, toIbOptionContract(callSymbol));
        if (putSymbol) optionContractCache.set(putSymbol, toIbOptionContract(putSymbol));

        return {
          'strike-price': strikePrice,
          call: callSymbol,
          put: putSymbol,
        };
      });

      return {
        'expiration-date': expirationDateIso,
        'days-to-expiration': Math.max(0, Math.round((new Date(expirationDateIso).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
        strikes: strikeItems,
      };
    });

  return {
    data: {
      items: [
        {
          expirations,
        },
      ],
    },
  };
}

async function getEquityOptionsBySymbols(symbols) {
  assertConnected();

  const validSymbols = Array.isArray(symbols)
    ? symbols.map(symbol => normalizeOptionSymbol(symbol)).filter(Boolean)
    : [];

  return {
    data: {
      items: validSymbols.map(symbol => ({
        symbol,
        'streamer-symbol': symbol,
      })),
    },
  };
}

function subscribeQuoteStream(streamerSymbol, contract, isUnderlying) {
  if (marketDataSubscriptionsBySymbol.has(streamerSymbol)) {
    return;
  }

  const subscription = IBKRConnection.Instance.ib
    .getMarketData(contract, '', false, false)
    .subscribe({
      next: update => {
        const quote = toQuotePayload({
          eventSymbol: streamerSymbol,
          tickMap: update?.all,
          isUnderlying,
        });

        if (!Number.isFinite(quote.bidPrice) && !Number.isFinite(quote.askPrice)) return;
        emitToRenderer('ibkr:quote', quote);
      },
      error: err => {
        emitToRenderer('ibkr:error', { message: err?.message || 'IBKR market data subscription failed.' });
      },
    });

  marketDataSubscriptionsBySymbol.set(streamerSymbol, subscription);
}

async function addQuoteSubscriptions(symbols) {
  assertConnected();

  const validSymbols = Array.isArray(symbols)
    ? symbols.map(symbol => normalizeOptionSymbol(symbol)).filter(Boolean)
    : [];

  let invalidSymbolCount = 0;
  let noSecurityDefinitionCount = 0;
  let validationFailureCount = 0;
  const noSecurityDefinitionSamples = [];

  for (const optionSymbol of validSymbols) {
    try {
      const contractTemplate = optionContractCache.get(optionSymbol) ?? toIbOptionContract(optionSymbol);
      if (!contractTemplate) {
        invalidSymbolCount += 1;
        continue;
      }

      const resolved = await withTimeout(
        MarketDataManager.Instance.getContract(contractTemplate),
        8000,
        `resolving option contract ${optionSymbol}`,
      );

      const contract = resolved?.contract ?? resolved;
      const hasConId = Number.isFinite(Number(contract?.conId)) && Number(contract.conId) > 0;
      if (!contract || !hasConId) {
        noSecurityDefinitionCount += 1;
        if (noSecurityDefinitionSamples.length < 3) {
          noSecurityDefinitionSamples.push(optionSymbol);
        }
        continue;
      }

      optionContractCache.set(optionSymbol, contract);
      subscribeQuoteStream(optionSymbol, contract, false);
    } catch (err) {
      validationFailureCount += 1;
    }
  }

  if (invalidSymbolCount > 0) {
    emitToRenderer('ibkr:error', {
      message: `Skipped ${invalidSymbolCount} invalid option symbol${invalidSymbolCount === 1 ? '' : 's'}.`,
      code: 'INVALID_OPTION_SYMBOL',
    });
  }

  if (noSecurityDefinitionCount > 0) {
    const suffix = noSecurityDefinitionSamples.length > 0
      ? ` Sample: ${noSecurityDefinitionSamples.join(', ')}`
      : '';
    emitToRenderer('ibkr:error', {
      message: `Skipped ${noSecurityDefinitionCount} option symbol${noSecurityDefinitionCount === 1 ? '' : 's'} with no security definition.${suffix}`,
      code: 200,
    });
  }

  if (validationFailureCount > 0) {
    emitToRenderer('ibkr:error', {
      message: `Skipped ${validationFailureCount} option symbol${validationFailureCount === 1 ? '' : 's'} due to contract validation failures.`,
      code: 'CONTRACT_VALIDATION_FAILED',
    });
  }

  return { ok: true };
}

function removeQuoteSubscriptions(symbols) {
  const validSymbols = Array.isArray(symbols)
    ? symbols.map(symbol => normalizeOptionSymbol(symbol)).filter(Boolean)
    : [];

  validSymbols.forEach(symbol => {
    disposeSubscription(symbol);
  });

  return { ok: true };
}

async function subscribeUnderlyingSymbol(symbol) {
  assertConnected();

  const normalizedSymbol = `${symbol ?? ''}`.trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error('IBKR underlying subscription requires a symbol.');
  }

  if (activeUnderlyingSymbol && activeUnderlyingSymbol !== normalizedSymbol) {
    disposeSubscription(activeUnderlyingSymbol);
  }

  activeUnderlyingSymbol = normalizedSymbol;

  const contractDetails = await resolveUnderlyingContract(normalizedSymbol);
  subscribeQuoteStream(normalizedSymbol, contractDetails.contract, true);

  emitToRenderer('ibkr:connectionState', { isLive: true });
  emitToRenderer('ibkr:feedReady', { ready: true });

  return { ok: true };
}

function clearMarketData() {
  clearMarketDataSubscriptions();
  return { ok: true };
}

function registerIbkrIpcHandlers({ ipcMain, getMainWindowProvider }) {
  if (handlersRegistered) return;

  mainWindowProvider = getMainWindowProvider;

  ipcMain.handle('ibkr:connect', async (_event, settings) => connectIbkr(settings));
  ipcMain.handle('ibkr:disconnect', async () => disconnectIbkr());
  ipcMain.handle('ibkr:listAccounts', async () => listAccounts());
  ipcMain.handle('ibkr:listPositions', async (_event, accountNumber) => listPositions(accountNumber));
  ipcMain.handle('ibkr:submitOrder', async (_event, accountNumber, order) => submitOrder(accountNumber, order));
  ipcMain.handle('ibkr:getOptionChain', async (_event, symbol) => getOptionChain(symbol));
  ipcMain.handle('ibkr:getEquityOptionsBySymbols', async (_event, symbols) => getEquityOptionsBySymbols(symbols));
  ipcMain.handle('ibkr:addQuoteSubscriptions', async (_event, symbols) => addQuoteSubscriptions(symbols));
  ipcMain.handle('ibkr:removeQuoteSubscriptions', async (_event, symbols) => removeQuoteSubscriptions(symbols));
  ipcMain.handle('ibkr:subscribeUnderlyingSymbol', async (_event, symbol) => subscribeUnderlyingSymbol(symbol));
  ipcMain.handle('ibkr:clearMarketData', async () => clearMarketData());

  handlersRegistered = true;
}

module.exports = {
  registerIbkrIpcHandlers,
};
