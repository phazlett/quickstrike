/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

const CONFIG = {
  sandbox: {
    baseUrl: 'https://api.cert.tastyworks.com',
    tokenEndpoint: 'https://api.cert.tastyworks.com/oauth/token',
    authorizeUrl: 'https://cert-my.staging-tasty.works/auth.html',
  },
  production: {
    baseUrl: 'https://api.tastyworks.com',
    tokenEndpoint: 'https://api.tastyworks.com/oauth/token',
    authorizeUrl: 'https://my.tastytrade.com/auth.html',
  }
};

let stagedCall = null;
let stagedPut = null;
let authHealthy = false;
let authManager = null;

const getConfig = () => CONFIG[useSandbox ? 'sandbox' : 'production'];
const CLIENT_ID = useSandbox ? SANDBOX_CLIENT_ID : LIVE_CLIENT_ID;
const CLIENT_SECRET = useSandbox ? SANDBOX_CLIENT_SECRET : LIVE_CLIENT_SECRET;

// DOM refs ---------------------------------------------------------------
const appHeader = document.getElementById('app-header');
const loadingSection = document.getElementById('loading-section');
const loadingMessage = document.getElementById('loading-message');
const loadingError = document.getElementById('loading-error');
const btnLoadingRetry = document.getElementById('btn-loading-retry');
const envBadge = document.getElementById('env-badge');
const btnLogout = document.getElementById('btn-logout');
const configSection = document.getElementById('config-section');
const btnConnect = document.getElementById('btn-connect');
const authStatus = document.getElementById('auth-status');
const tradingSection = document.getElementById('trading-section');
const accountSelect = document.getElementById('account-select');
const chainStatus = document.getElementById('chain-status');
const positionsSection = document.getElementById('positions-section');
const positionsStatus = document.getElementById('positions-status');
const positionsRows = document.getElementById('positions-rows');
const chainSection = document.getElementById('chain-section');
const chainRows = document.getElementById('chain-rows');
const callSymbolEl = document.getElementById('call-symbol');
const putSymbolEl = document.getElementById('put-symbol');
const btnSubmitCall = document.getElementById('btn-submit-call');
const btnSubmitPut = document.getElementById('btn-submit-put');
const callOrderStatus = document.getElementById('call-order-status');
const putOrderStatus = document.getElementById('put-order-status');
const callActionEl = document.getElementById('call-action');
const putActionEl = document.getElementById('put-action');
const callBpReductionEl = document.getElementById('call-bp-reduction');
const putBpReductionEl = document.getElementById('put-bp-reduction');
const livePriceEl = document.getElementById('live-price');
const liveConnectionEl = document.getElementById('live-connection');

// Market data (DxLink) state -------------------------------------------------
const DXLINK_CONTROL_CHANNEL = 0;
const DXLINK_FEED_CHANNEL = 3;
const DXLINK_AGGREGATION_PERIOD_SECONDS = 1;
const LIVE_PRICE_DISPLAY_MIN_INTERVAL_MS = 1_000;
const ATM_SWITCH_HYSTERESIS_DOLLARS = 0.35;
let currentLiveQuotePrice = null;
let hasAutoScrolledToLiveStrike = false;
let optionStreamerByOptionSymbol = new Map();
let optionQuoteByStreamerSymbol = new Map();
let optionQuoteSubscriptions = new Set();
let optionQuoteCellsByStreamerSymbol = new Map();
let optionQuoteRenderCycle = 0;
let atmMarkedRowsByBody = new WeakMap();
const bpEstimateInFlight = {
  call: false,
  put: false,
};
const bpEstimateNeedsRefresh = {
  call: false,
  put: false,
};
const ORDER_STATUS_AUTO_HIDE_MS = 5_000;
const orderStatusHideTimers = {
  call: null,
  put: null,
};
let dxlinkManager = null;
let positionsManager = null;
let apiClient = null;
let bootstrapManager = null;
let lastLivePriceDisplayAt = 0;
let pendingLivePriceValue = null;
let pendingLivePriceTimer = null;

function getOrderStatusEl(side) {
  return side === 'call' ? callOrderStatus : putOrderStatus;
}

function clearOrderStatusHideTimer(side) {
  const timer = orderStatusHideTimers[side];
  if (!timer) return;

  clearTimeout(timer);
  orderStatusHideTimers[side] = null;
}

function setOrderStatus(side, message, type) {
  const statusEl = getOrderStatusEl(side);
  if (!statusEl) return;

  clearOrderStatusHideTimer(side);
  setStatus(statusEl, message, type);

  if (!message) return;

  orderStatusHideTimers[side] = setTimeout(() => {
    setStatus(statusEl, '', '');
    orderStatusHideTimers[side] = null;
  }, ORDER_STATUS_AUTO_HIDE_MS);
}

function hideOrderStatuses() {
  setOrderStatus('call', '', '');
  setOrderStatus('put', '', '');
}

function setBpDisplay(side, text) {
  const bpEl = side === 'call' ? callBpReductionEl : putBpReductionEl;
  if (!bpEl) return;

  bpEl.textContent = text;
}

async function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout: ${label}`)), timeoutMs);
    }),
  ]);
}

function reapplyOptionQuoteSubscriptions() {
  if (optionQuoteSubscriptions.size === 0) return;

  const optionSymbols = Array.from(optionQuoteSubscriptions).map(symbol => ({ type: 'Quote', symbol }));
  sendDxLinkMessage({
    type: 'FEED_SUBSCRIPTION',
    channel: DXLINK_FEED_CHANNEL,
    add: optionSymbols,
  });
}

function handleUnderlyingTrade(price) {
  currentLiveQuotePrice = price;
  setLivePriceText(price, false);
  maybeAutoScrollChainToLivePrice();
  refreshBpEstimates();
}

function handleQuoteEvent({ eventSymbol, bidPrice, askPrice, isUnderlying }) {
  positionsManager?.handleQuote(eventSymbol, bidPrice, askPrice);

  if (optionQuoteSubscriptions.has(eventSymbol)) {
    optionQuoteByStreamerSymbol.set(eventSymbol, {
      bidPrice,
      askPrice,
      updatedAt: Date.now(),
    });
    updateOptionQuoteCellsForStreamer(eventSymbol);
  }

  if (!isUnderlying) return;

  if (Number.isFinite(bidPrice) && Number.isFinite(askPrice) && bidPrice > 0 && askPrice > 0) {
    const mid = (bidPrice + askPrice) / 2;
    currentLiveQuotePrice = mid;
    setLivePriceText(mid, false);
    maybeAutoScrollChainToLivePrice();
    refreshBpEstimates();
  }
}

function initializeManagers() {
  authManager = window.createAuthManager({
    getConfig,
    setAuthHealthyState,
    onSessionExpired: () => btnLogout.click(),
    authDebugEnabled: true,
  });

  apiClient = window.createApiClient({
    ensureValidToken: () => authManager.ensureValidToken({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    forceRefreshToken: () => authManager.ensureValidToken({ forceRefresh: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    hasRefreshToken: () => authManager.hasRefreshToken(),
    getAccessToken: () => authManager.getAccessToken(),
    getBaseUrl: () => getConfig().baseUrl,
    authDebug: authManager.authDebug,
  });

  dxlinkManager = window.createDxlinkManager({
    controlChannel: DXLINK_CONTROL_CHANNEL,
    feedChannel: DXLINK_FEED_CHANNEL,
    aggregationPeriodSeconds: DXLINK_AGGREGATION_PERIOD_SECONDS,
    apiGet,
    hasAccessToken: () => authManager?.hasAccessToken(),
    onConnectionState: setConnectionState,
    onUnderlyingTrade: handleUnderlyingTrade,
    onQuote: handleQuoteEvent,
    onFeedReady: () => {
      reapplyOptionQuoteSubscriptions();
      positionsManager?.reapplySubscriptions();
    },
  });

  positionsManager = window.createPositionsManager({
    positionsSection,
    positionsStatus,
    positionsRows,
    accountSelect,
    getCurrentSymbol: () => currentSymbol,
    apiGet,
    apiPost,
    ensureDxLinkReady,
    sendDxLinkMessage,
    feedChannel: DXLINK_FEED_CHANNEL,
    setStatus,
  });

  bootstrapManager = window.createBootstrapManager({
    getConfig,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    useSandbox,
    loadingSection,
    loadingMessage,
    loadingError,
    btnLoadingRetry,
    btnConnect,
    btnLogout,
    authStatus,
    configSection,
    appHeader,
    tradingSection,
    envBadge,
    accountSelect,
    authManager,
    positionsManager,
    setStatus,
    setAuthHealthyState,
    applyTradeButtonState,
    setLivePriceText,
    subscribeSymbolPrice,
    loadChain,
    loadAccounts,
    loadPositions,
    clearMarketDataConnection,
    getCurrentSymbol: () => currentSymbol,
    onPostAuthenticatedUiShown: () => {
      requestAnimationFrame(() => {
        maybeAutoScrollChainToLivePrice();
        updateAtmMarkers();
      });
    },
  });
}

initializeManagers();
bootstrapManager.initialize();

function setAuthHealthyState(nextState) {
  authHealthy = nextState;
  applyTradeButtonState();
}

function getSubmitButtonClass(staged) {
  return staged?.action === 'Buy to Open' ? 'btn-long' : 'btn-short';
}

function applyTradeButtonState() {
  const callReady = authHealthy && !!stagedCall;
  const putReady = authHealthy && !!stagedPut;

  btnSubmitCall.disabled = !callReady;
  btnSubmitCall.className = callReady ? getSubmitButtonClass(stagedCall) : 'btn-disabled';

  btnSubmitPut.disabled = !putReady;
  btnSubmitPut.className = putReady ? getSubmitButtonClass(stagedPut) : 'btn-disabled';
}

// Load accounts ---------------------------------------------------------------
async function loadAccounts() {
  const resp = await apiGet('/customers/me/accounts');
  const accounts = resp?.data?.items ?? [];

  accountSelect.innerHTML = '';
  accounts.forEach(item => {
    const acct = item?.account;
    if (!acct?.['account-number']) return;

    const opt = document.createElement('option');
    opt.value = acct['account-number'];
    opt.textContent = `${acct['account-number']} — ${acct['nickname'] ?? acct['account-type-name']}`;
    accountSelect.appendChild(opt);
  });
}

async function loadPositions() {
  if (!positionsManager) return;
  await positionsManager.loadPositions();
}

// Submit order ---------------------------------------------------------------
async function submitOrder(staged, side) {
  const quantity = Number.parseInt(document.getElementById('quantity').value, 10);
  const accountNumber = accountSelect.value;

  if (!staged || Number.isNaN(quantity) || quantity <= 0) {
    setOrderStatus(side, 'Missing symbol or quantity.', 'error');
    return;
  }

  if (!authHealthy) {
    setOrderStatus(side, 'Authentication is not healthy. Wait for auto-refresh or log in again.', 'error');
    return;
  }

  const marketOrder = {
    'order-type': 'Market',
    'time-in-force': 'Day',
    'legs': [
      {
        'instrument-type': 'Equity Option',
        'symbol': staged.symbol,
        'quantity': quantity,
        'action': staged.action,
      }
    ]
  };

  const endpoint = `/accounts/${accountNumber}/orders`;

  setOrderStatus(side, 'Submitting order', 'info');

  try {
    await apiPost(endpoint, marketOrder);

    setOrderStatus(side, '', '');
    await loadPositions();
  } catch (err) {
    setOrderStatus(side, `Error: ${err.message}`, 'error');
  }
}

// Option Chain ---------------------------------------------------------------
async function loadChain(ticker) {
  if (!ticker) return;

  hasAutoScrolledToLiveStrike = false;
  optionQuoteRenderCycle += 1;
  optionQuoteCellsByStreamerSymbol.clear();
  optionQuoteSubscriptions.clear();
  optionQuoteByStreamerSymbol.clear();

  // Clear staged orders
  stagedCall = null;
  stagedPut = null;

  callActionEl.textContent = null;
  putActionEl.textContent = null;

  callSymbolEl.textContent = 'No call selected';
  callSymbolEl.classList.add('empty');
  btnSubmitCall.disabled = true;
  applyTradeButtonState();
  setOrderStatus('call', '', '');
  setBpDisplay('call', '--');

  putSymbolEl.textContent = 'No put selected';
  putSymbolEl.classList.add('empty');
  btnSubmitPut.disabled = true;
  applyTradeButtonState();
  setOrderStatus('put', '', '');
  setBpDisplay('put', '--');

  // Also clear any highlighted selections in the chain
  document.querySelectorAll('.quote-price.call-selected, .quote-price.put-selected')
    .forEach(el => el.classList.remove('call-selected', 'put-selected'));

  chainSection.classList.add('hidden');

  try {
    const resp = await apiGet(`/option-chains/${ticker}/nested`);
    const items = resp?.data?.items ?? [];
    const expirations = items.flatMap(item => item.expirations ?? []);

    if (expirations.length === 0) {
      setStatus(chainStatus, `No options found for ${ticker}.`, 'error');
      return;
    }

    const minDTE = Math.min(...expirations.map(exp => parseInt(exp['days-to-expiration'], 10)));
    const filtered = expirations.filter(exp => parseInt(exp['days-to-expiration'], 10) === minDTE);

    setStatus(chainStatus, '', '');
    renderChain(filtered);

  } catch (err) {
    setStatus(chainStatus, `Error: ${err.message}`, 'error');
  }
}

// Auto-load triggers ---------------------------------------------------------
let currentSymbol = 'SPY';

document.querySelectorAll('.symbol-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.symbol === currentSymbol) return; // already active

    document.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSymbol = btn.dataset.symbol;
    subscribeSymbolPrice(currentSymbol);
    loadChain(currentSymbol);
    loadPositions();
  });
});

accountSelect.addEventListener('change', () => {
  loadPositions();
});

function formatExpiry(dateStr) {
  // dateStr is "2026-02-20" — parse as local time
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatOptionPrice(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return '--';
  return numericValue.toFixed(2);
}

function createQuotePriceEl(side, type) {
  const quoteEl = document.createElement('span');
  quoteEl.className = `quote-price ${side}-${type}`;
  quoteEl.textContent = '--';
  return quoteEl;
}

function updateQuoteCellValue(quoteEl, value) {
  if (!quoteEl) return;
  quoteEl.textContent = formatOptionPrice(value);
}

function updateOptionQuoteCellsForStreamer(streamerSymbol) {
  const refs = optionQuoteCellsByStreamerSymbol.get(streamerSymbol);
  if (!refs || refs.size === 0) return;

  const quote = optionQuoteByStreamerSymbol.get(streamerSymbol);
  const bidPrice = quote?.bidPrice;
  const askPrice = quote?.askPrice;

  refs.forEach(ref => {
    updateQuoteCellValue(ref.bidEl, bidPrice);
    updateQuoteCellValue(ref.askEl, askPrice);
  });
}

function bindOptionQuoteCell(streamerSymbol, bidEl, askEl) {
  if (!streamerSymbol || (!bidEl && !askEl)) return;

  const existing = optionQuoteCellsByStreamerSymbol.get(streamerSymbol) ?? new Set();
  existing.add({ bidEl, askEl });
  optionQuoteCellsByStreamerSymbol.set(streamerSymbol, existing);
  updateOptionQuoteCellsForStreamer(streamerSymbol);
}

async function resolveOptionStreamerSymbols(optionSymbols) {
  const resolvedMap = new Map();
  const uniqueSymbols = Array.from(new Set(optionSymbols.filter(Boolean)));
  if (uniqueSymbols.length === 0) return resolvedMap;

  const unresolved = [];
  uniqueSymbols.forEach(symbol => {
    if (optionStreamerByOptionSymbol.has(symbol)) {
      resolvedMap.set(symbol, optionStreamerByOptionSymbol.get(symbol));
      return;
    }
    unresolved.push(symbol);
  });

  const chunkSize = 50;
  for (let index = 0; index < unresolved.length; index += chunkSize) {
    const chunk = unresolved.slice(index, index + chunkSize);
    const query = chunk.map(symbol => `symbol[]=${encodeURIComponent(symbol)}`).join('&');
    const response = await apiGet(`/instruments/equity-options?${query}`);
    const items = response?.data?.items ?? [];

    items.forEach(item => {
      const optionSymbol = item?.symbol;
      const streamerSymbol = item?.['streamer-symbol'];
      if (!optionSymbol || !streamerSymbol) return;

      optionStreamerByOptionSymbol.set(optionSymbol, streamerSymbol);
      resolvedMap.set(optionSymbol, streamerSymbol);
    });
  }

  uniqueSymbols.forEach(symbol => {
    const streamerSymbol = resolvedMap.get(symbol) ?? optionStreamerByOptionSymbol.get(symbol) ?? symbol;
    optionStreamerByOptionSymbol.set(symbol, streamerSymbol);
    resolvedMap.set(symbol, streamerSymbol);
  });

  return resolvedMap;
}

async function ensureOptionQuoteSubscriptions(streamerSymbols) {
  const uniqueSymbols = Array.from(new Set(streamerSymbols.filter(Boolean)));
  if (uniqueSymbols.length === 0) return;

  await ensureDxLinkReady();

  const pending = uniqueSymbols.filter(symbol => !optionQuoteSubscriptions.has(symbol));
  if (pending.length === 0) return;

  sendDxLinkMessage({
    type: 'FEED_SUBSCRIPTION',
    channel: DXLINK_FEED_CHANNEL,
    add: pending.map(symbol => ({ type: 'Quote', symbol })),
  });

  pending.forEach(symbol => {
    optionQuoteSubscriptions.add(symbol);
  });
}

async function primeOptionQuoteCells(bindings, renderCycleAtStart) {
  if (!Array.isArray(bindings) || bindings.length === 0) return;

  const optionSymbols = bindings.map(binding => binding.optionSymbol).filter(Boolean);
  if (optionSymbols.length === 0) return;

  try {
    const streamerByOption = await resolveOptionStreamerSymbols(optionSymbols);
    if (renderCycleAtStart !== optionQuoteRenderCycle) return;

    const streamerSymbols = [];
    bindings.forEach(binding => {
      const streamerSymbol = streamerByOption.get(binding.optionSymbol);
      if (!streamerSymbol) return;
      streamerSymbols.push(streamerSymbol);
      bindOptionQuoteCell(streamerSymbol, binding.bidEl, binding.askEl);
    });

    await ensureOptionQuoteSubscriptions(streamerSymbols);
  } catch {
    // Ignore quote priming errors and keep chain interactive.
  }
}

function renderChain(expirations) {
  chainRows.innerHTML = '';
  optionQuoteCellsByStreamerSymbol.clear();

  const quoteBindings = [];
  const renderCycleAtStart = optionQuoteRenderCycle;

  // Sort by expiration date
  expirations.sort((a, b) => a['expiration-date'].localeCompare(b['expiration-date']));

  expirations.forEach((exp, i) => {
    const dte = parseInt(exp['days-to-expiration'], 10);
    const dteLabel = dte === 0 ? '0 DTE' : dte === 1 ? '1 DTE' : `${dte} DTE`;
    const strikes = exp['strikes'] ?? [];

    // Collapsible header ---------------------------------------------------
    const header = document.createElement('div');
    header.className = 'expiry-header';
    header.innerHTML = `
      <div class="expiry-header-left">
        <span class="expiry-chevron">▶</span>
        <span class="expiry-date">${formatExpiry(exp['expiration-date'])}</span>
      </div>
      <span class="expiry-dte">${dteLabel}</span>
    `;

    // Collapsible body ---------------------------------------------------
    const body = document.createElement('div');
    body.className = 'expiry-body';

    // Column headers
    const colHeader = document.createElement('div');
    colHeader.className = 'chain-header chain-header-global chain-row-item';
    colHeader.innerHTML = `
      <div class="option-cell call-option-cell chain-header-option-cell">
        <span class="chain-header-quote-label">Bid</span>
        <span class="chain-header-quote-label">Ask</span>
      </div>
      <span class="strike-cell chain-header-strike-label">Strike</span>
      <div class="option-cell put-option-cell chain-header-option-cell">
        <span class="chain-header-quote-label">Bid</span>
        <span class="chain-header-quote-label">Ask</span>
      </div>
    `;
    body.appendChild(colHeader);

    // Strike rows — data is already paired, no need to build a map
    strikes.forEach(strike => {
      const strikePrice = parseFloat(strike['strike-price']);
      const callSymbol = strike['call'];
      const putSymbol = strike['put'];

      const row = document.createElement('div');
      row.className = 'chain-row-item';
      row.dataset.strikePrice = String(strikePrice);

      // Call side — Bid / Ask (clickable)
      const callCell = document.createElement('div');
      callCell.className = 'option-cell call-option-cell';
      const callBidEl = createQuotePriceEl('call', 'bid');
      const callAskEl = createQuotePriceEl('call', 'ask');
      if (callSymbol) {
        callBidEl.dataset.direction = 'short';
        callAskEl.dataset.direction = 'long';
        callBidEl.classList.add('quote-action');
        callAskEl.classList.add('quote-action');
        callBidEl.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'short', strikePrice, callBidEl));
        callAskEl.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'long', strikePrice, callAskEl));

        callCell.appendChild(callBidEl);
        callCell.appendChild(callAskEl);

        quoteBindings.push({
          optionSymbol: callSymbol,
          bidEl: callBidEl,
          askEl: callAskEl,
        });
      } else {
        callCell.appendChild(callBidEl);
        callCell.appendChild(callAskEl);
      }

      const strikeEl = document.createElement('span');
      strikeEl.className = 'strike-cell';
      strikeEl.textContent = strikePrice.toFixed(0);

      // Put side — Bid / Ask (clickable)
      const putCell = document.createElement('div');
      putCell.className = 'option-cell put-option-cell';
      const putBidEl = createQuotePriceEl('put', 'bid');
      const putAskEl = createQuotePriceEl('put', 'ask');
      if (putSymbol) {
        putBidEl.dataset.direction = 'short';
        putAskEl.dataset.direction = 'long';
        putBidEl.classList.add('quote-action');
        putAskEl.classList.add('quote-action');
        putBidEl.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'short', strikePrice, putBidEl));
        putAskEl.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'long', strikePrice, putAskEl));

        putCell.appendChild(putBidEl);
        putCell.appendChild(putAskEl);

        quoteBindings.push({
          optionSymbol: putSymbol,
          bidEl: putBidEl,
          askEl: putAskEl,
        });
      } else {
        putCell.appendChild(putBidEl);
        putCell.appendChild(putAskEl);
      }

      row.appendChild(callCell);
      row.appendChild(strikeEl);
      row.appendChild(putCell);
      body.appendChild(row);
    });

    // Toggle on header click
    header.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open');
      header.querySelector('.expiry-chevron').textContent = isOpen ? '▼' : '▶';
      updateAtmMarkers();
    });

    // First group open by default
    if (i === 0) {
      body.classList.add('open');
      header.querySelector('.expiry-chevron').textContent = '▼';
    }

    chainRows.appendChild(header);
    chainRows.appendChild(body);
  });

  chainSection.classList.remove('hidden');

  primeOptionQuoteCells(quoteBindings, renderCycleAtStart);

  requestAnimationFrame(() => {
    maybeAutoScrollChainToLivePrice();
    updateAtmMarkers();
  });
}

function getNearestStrikeRow(container, referencePrice) {
  if (!container || !Number.isFinite(referencePrice)) return null;

  const rows = Array.from(container.querySelectorAll('.chain-row-item'));
  if (rows.length === 0) return null;

  let nearestRow = null;
  let nearestDiff = Number.POSITIVE_INFINITY;

  rows.forEach(row => {
    const strikePrice = Number.parseFloat(row.dataset.strikePrice);
    if (!Number.isFinite(strikePrice)) return;

    const diff = Math.abs(strikePrice - referencePrice);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearestRow = row;
    }
  });

  return nearestRow;
}

function getRowStrikePrice(row) {
  if (!row) return null;

  const strikePrice = Number.parseFloat(row.dataset.strikePrice);
  if (!Number.isFinite(strikePrice)) return null;
  return strikePrice;
}

function updateAtmMarkers() {
  if (!Number.isFinite(currentLiveQuotePrice)) {
    document.querySelectorAll('.chain-row-item.atm-row').forEach(row => {
      row.classList.remove('atm-row');
    });

    document.querySelectorAll('.chain-row-item .atm-marker-label').forEach(label => {
      label.remove();
    });

    atmMarkedRowsByBody = new WeakMap();
    return;
  }

  document.querySelectorAll('.expiry-body').forEach(body => {
    const previousRow = atmMarkedRowsByBody.get(body) ?? null;
    const candidateRow = getNearestStrikeRow(body, currentLiveQuotePrice);
    const previousStrike = getRowStrikePrice(previousRow);
    const candidateStrike = getRowStrikePrice(candidateRow);

    let nearestRow = candidateRow;
    if (previousRow && previousStrike !== null && candidateRow && candidateStrike !== null && candidateRow !== previousRow) {
      const previousDiff = Math.abs(currentLiveQuotePrice - previousStrike);
      if (previousDiff < ATM_SWITCH_HYSTERESIS_DOLLARS) {
        nearestRow = previousRow;
      }
    }

    if (!nearestRow) {
      if (previousRow) {
        previousRow.classList.remove('atm-row');
        previousRow.querySelectorAll('.atm-marker-label').forEach(label => label.remove());
      }
      return;
    }

    if (previousRow && previousRow !== nearestRow) {
      previousRow.classList.remove('atm-row');
      previousRow.querySelectorAll('.atm-marker-label').forEach(label => label.remove());
    }

    nearestRow.classList.add('atm-row');
    addAtmLabels(nearestRow);
    atmMarkedRowsByBody.set(body, nearestRow);
  });
}

function addAtmLabels(row) {
  if (!row) return;

  const createLabel = (text, className) => {
    const label = document.createElement('span');
    label.className = `atm-marker-label ${className}`;
    label.textContent = text;
    return label;
  };

  if (!row.querySelector('.itm-call-label')) {
    row.appendChild(createLabel('ITM ▲', 'itm-call-label'));
  }

  if (!row.querySelector('.itm-put-label')) {
    row.appendChild(createLabel('▼ ITM', 'itm-put-label'));
  }
}

function scrollOpenChainBodyToNearestStrike() {
  const openBody = chainRows.querySelector('.expiry-body.open');
  if (!openBody) return false;
  if (openBody.clientHeight <= 0) return false;

  if (!Number.isFinite(currentLiveQuotePrice)) {
    openBody.scrollTop = (openBody.scrollHeight - openBody.clientHeight) / 2;
    return false;
  }

  const rows = Array.from(openBody.querySelectorAll('.chain-row-item'));
  if (rows.length === 0) return false;

  let nearestRow = null;
  let nearestDiff = Number.POSITIVE_INFINITY;

  rows.forEach(row => {
    const strikePrice = Number.parseFloat(row.dataset.strikePrice);
    if (!Number.isFinite(strikePrice)) return;

    // Adding 8 allows the scroll to account for the difference in row height
    const diff = Math.abs(strikePrice - currentLiveQuotePrice + 6);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearestRow = row;
    }
  });

  if (!nearestRow) return false;

  const targetTop = nearestRow.offsetTop - (openBody.clientHeight / 2) + (nearestRow.clientHeight / 2);
  openBody.scrollTop = Math.max(0, targetTop);
  return true;
}

function maybeAutoScrollChainToLivePrice() {
  if (hasAutoScrolledToLiveStrike) return;
  if (chainSection.classList.contains('hidden')) return;

  const didScrollToLiveStrike = scrollOpenChainBodyToNearestStrike();
  if (didScrollToLiveStrike) {
    hasAutoScrolledToLiveStrike = true;
  }
}

function selectSymbol(symbol, side, direction, strikePrice, el) {
  const quantity = Number.parseInt(document.getElementById('quantity').value, 10) || 1;
  const units = quantity === 1 ? '' : 's';
  const action = direction === 'long' ? 'Buy to Open' : 'Sell to Open';
  const sideLabel = side === 'call' ? 'call' : 'put';
  const actionLabel = `${action} ${currentSymbol} ${quantity} ${sideLabel}${units}`;
  const label = `${direction === 'long' ? 'Long' : 'Short'} ${sideLabel} $${strikePrice.toFixed(0)}`;

  // Clear previous highlights for this side
  const sideClass = side === 'call' ? '.call-selected' : '.put-selected';
  document.querySelectorAll(sideClass).forEach(e => e.classList.remove('call-selected', 'put-selected'));
  el.classList.add(side === 'call' ? 'call-selected' : 'put-selected');
  hideOrderStatuses();

  if (side === 'call') {
    stagedCall = { symbol, action, label, strikePrice };
    callSymbolEl.textContent = label;
    callSymbolEl.classList.remove('empty');
    callActionEl.textContent = actionLabel;
    applyTradeButtonState();
    setBpDisplay('call', '--');
    queueBpEstimateRefreshForSide('call');
  } else {
    stagedPut = { symbol, action, label, strikePrice };
    putSymbolEl.textContent = label;
    putSymbolEl.classList.remove('empty');
    putActionEl.textContent = actionLabel;
    applyTradeButtonState();
    setBpDisplay('put', '--');
    queueBpEstimateRefreshForSide('put');
  }
}

function parseQuantity() {
  return Number.parseInt(document.getElementById('quantity').value, 10) || 1;
}

function buildActionLabel(action, side, quantity) {
  const units = quantity === 1 ? '' : 's';
  const sideLabel = side === 'call' ? 'call' : 'put';
  return `${action} ${currentSymbol} ${quantity} ${sideLabel}${units}`;
}

async function resolveOptionStreamerSymbol(optionSymbol) {
  if (!optionSymbol) return null;

  if (optionStreamerByOptionSymbol.has(optionSymbol)) {
    return optionStreamerByOptionSymbol.get(optionSymbol);
  }

  const querySymbol = encodeURIComponent(optionSymbol);
  const resp = await apiGet(`/instruments/equity-options?symbol[]=${querySymbol}`);
  const instrument = resp?.data?.items?.[0] ?? null;
  const streamerSymbol = instrument?.['streamer-symbol'] ?? optionSymbol;

  optionStreamerByOptionSymbol.set(optionSymbol, streamerSymbol);
  return streamerSymbol;
}

async function ensureOptionQuoteSubscription(streamerSymbol) {
  await ensureOptionQuoteSubscriptions([streamerSymbol]);
}

function getOptionQuoteFromCache(streamerSymbol) {
  const quote = optionQuoteByStreamerSymbol.get(streamerSymbol);
  if (!quote) return null;

  const bidPrice = Number(quote.bidPrice);
  const askPrice = Number(quote.askPrice);
  return {
    bidPrice: Number.isFinite(bidPrice) ? bidPrice : null,
    askPrice: Number.isFinite(askPrice) ? askPrice : null,
  };
}

async function waitForOptionQuote(streamerSymbol, timeoutMs = 2_000) {
  const cached = getOptionQuoteFromCache(streamerSymbol);
  if (cached) return cached;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const quote = getOptionQuoteFromCache(streamerSymbol);
    if (quote) {
      return quote;
    }
  }

  return null;
}

function computeEstimatedBpReduction(staged, quantity, quote, underlyingPrice) {
  const multiplier = 100;
  const strikePrice = Number(staged?.strikePrice);
  const isShort = staged?.action?.startsWith('Sell');
  const underlyingSymbol = currentSymbol;
  const usesElevatedIndexRates = underlyingSymbol === 'XSP';
  const highRate = usesElevatedIndexRates ? 0.25 : 0.2;
  const lowRate = usesElevatedIndexRates ? 0.15 : 0.1;

  if (!isShort) {
    const ask = Number(quote?.askPrice);
    if (!Number.isFinite(ask) || ask <= 0) return null;
    return ask * quantity * multiplier;
  }

  const bid = Number(quote?.bidPrice);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) return null;
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return null;

  const sideLabel = staged?.label?.toLowerCase().includes('put') ? 'put' : 'call';
  const outOfMoneyAmount = sideLabel === 'put'
    ? Math.max(0, underlyingPrice - strikePrice)
    : Math.max(0, strikePrice - underlyingPrice);

  const calcOne = (highRate * underlyingPrice) - outOfMoneyAmount + bid;
  const calcTwo = sideLabel === 'put'
    ? (lowRate * strikePrice) + bid
    : (lowRate * underlyingPrice) + bid;
  const calcThree = 2.5;

  const initialRequirementPerShare = Math.max(calcOne, calcTwo, calcThree);
  const initialRequirement = initialRequirementPerShare * quantity * multiplier;
  const premiumCredit = bid * quantity * multiplier;

  return Math.max(0, initialRequirement - premiumCredit);
}

async function updateBpEstimateForSide(side) {
  const staged = side === 'call' ? stagedCall : stagedPut;
  const bpEl = side === 'call' ? callBpReductionEl : putBpReductionEl;

  if (!staged || !bpEl) return;

  const quantity = parseQuantity();

  try {
    const streamerSymbol = await withTimeout(
      resolveOptionStreamerSymbol(staged.symbol),
      4_000,
      `resolveOptionStreamerSymbol:${side}`,
    );
    if (!streamerSymbol) {
      setBpDisplay(side, '--');
      return;
    }

    await withTimeout(
      ensureOptionQuoteSubscription(streamerSymbol),
      4_000,
      `ensureOptionQuoteSubscription:${side}`,
    );
    let quote = getOptionQuoteFromCache(streamerSymbol);
    if (!quote) {
      setBpDisplay(side, 'Estimating');
      quote = await waitForOptionQuote(streamerSymbol, 2_000);
    }

    const estimatedBp = computeEstimatedBpReduction(staged, quantity, quote, currentLiveQuotePrice);
    setBpDisplay(side, estimatedBp === null ? '--' : formatCurrency(estimatedBp));
  } catch {
    setBpDisplay(side, '--');
  }
}

function queueBpEstimateRefreshForSide(side) {
  if (bpEstimateInFlight[side]) {
    bpEstimateNeedsRefresh[side] = true;
    return;
  }

  bpEstimateInFlight[side] = true;

  (async () => {
    try {
      do {
        bpEstimateNeedsRefresh[side] = false;
        await updateBpEstimateForSide(side);
      } while (bpEstimateNeedsRefresh[side]);
    } finally {
      bpEstimateInFlight[side] = false;
    }
  })();
}

function refreshBpEstimates() {
  if (stagedCall) queueBpEstimateRefreshForSide('call');
  if (stagedPut) queueBpEstimateRefreshForSide('put');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

// Order quantity listeners ---------------------------------------------------
document.getElementById('quantity').addEventListener('change', () => {
  const quantity = parseQuantity();

  if (stagedCall) {
    callActionEl.textContent = buildActionLabel(stagedCall.action, 'call', quantity);
  }

  if (stagedPut) {
    putActionEl.textContent = buildActionLabel(stagedPut.action, 'put', quantity);
  }

  refreshBpEstimates();
});

// DxLink market data ---------------------------------------------------------
function cancelPendingLivePriceRender() {
  if (!pendingLivePriceTimer) return;
  clearTimeout(pendingLivePriceTimer);
  pendingLivePriceTimer = null;
}

function renderLivePriceTextNow(price) {
  if (!livePriceEl) return;

  if (typeof price === 'number' && Number.isFinite(price)) {
    livePriceEl.textContent = `$${price.toFixed(2)}`;
  } else {
    livePriceEl.textContent = null;
  }

  lastLivePriceDisplayAt = Date.now();
  updateAtmMarkers();
}

function renderLivePriceTextThrottled(price) {
  pendingLivePriceValue = price;

  const elapsedMs = Date.now() - lastLivePriceDisplayAt;
  if (elapsedMs >= LIVE_PRICE_DISPLAY_MIN_INTERVAL_MS) {
    const nextPrice = pendingLivePriceValue;
    pendingLivePriceValue = null;
    cancelPendingLivePriceRender();
    renderLivePriceTextNow(nextPrice);
    return;
  }

  if (pendingLivePriceTimer) return;

  pendingLivePriceTimer = setTimeout(() => {
    pendingLivePriceTimer = null;
    const nextPrice = pendingLivePriceValue;
    pendingLivePriceValue = null;
    renderLivePriceTextNow(nextPrice);
  }, LIVE_PRICE_DISPLAY_MIN_INTERVAL_MS - elapsedMs);
}

function setLivePriceText(price, connecting = false) {
  if (!livePriceEl) return;

  if (connecting) {
    pendingLivePriceValue = null;
    cancelPendingLivePriceRender();
    return;
  }

  if (typeof price === 'number' && Number.isFinite(price)) {
    renderLivePriceTextThrottled(price);
    return;
  }

  pendingLivePriceValue = null;
  cancelPendingLivePriceRender();
  renderLivePriceTextNow(null);
}

function setConnectionState(isLive) {
  if (!liveConnectionEl) return;

  if (isLive) {
    liveConnectionEl.textContent = 'CONNECTED';
    liveConnectionEl.classList.remove('disconnected');
    liveConnectionEl.classList.add('live');
    return;
  }

  liveConnectionEl.textContent = 'DISCONNECTED';
  liveConnectionEl.classList.remove('live');
  liveConnectionEl.classList.add('disconnected');
}

function clearMarketDataConnection() {
  dxlinkManager?.clearConnection();
  pendingLivePriceValue = null;
  cancelPendingLivePriceRender();
  currentLiveQuotePrice = null;
  hasAutoScrolledToLiveStrike = false;
  optionQuoteByStreamerSymbol.clear();
  optionQuoteSubscriptions.clear();
  optionQuoteCellsByStreamerSymbol.clear();
  positionsManager?.clearMarketDataState();
  setConnectionState(false);
}

function sendDxLinkMessage(message) {
  dxlinkManager?.sendMessage(message);
}

async function ensureDxLinkReady() {
  if (!dxlinkManager) return;
  await dxlinkManager.ensureReady();
}

async function subscribeSymbolPrice(symbol) {
  if (!authManager?.hasAccessToken()) return;

  try {
    currentLiveQuotePrice = null;
    setLivePriceText(null, true);

    await dxlinkManager?.subscribeUnderlyingSymbol(symbol);
  } catch (err) {
    setLivePriceText(null, false);
    setConnectionState(false);
    setStatus(chainStatus, `Market data error: ${err.message}`, 'error');
  }
}

// Order button listeners ---------------------------------------------------
btnSubmitCall.addEventListener('click', () => submitOrder(stagedCall, 'call'));
btnSubmitPut.addEventListener('click', () => submitOrder(stagedPut, 'put'));

// API Helpers ---------------------------------------------------------------
async function apiGet(path) {
  return apiClient.get(path);
}

async function apiPost(path, body) {
  return apiClient.post(path, body);
}

// Utility -------------------------------------------------------------------
function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;

  if (!message) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
  }
}
