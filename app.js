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

let tokenResponse = null;
let stagedCall = null;
let stagedPut = null;
let authHealthy = false;
let authRefreshInFlight = null;
let authRefreshTimer = null;
let authLastRefreshAt = null;
let authLastError = null;
const AUTH_DEBUG = true;
const REFRESH_TOKEN_BACKUP_KEY = 'token_refresh_backup';

const getConfig = () => CONFIG[useSandbox ? 'sandbox' : 'production'];

function authDebug(message, details = null) {
  if (!AUTH_DEBUG) return;

  const timestamp = new Date().toISOString();
  if (details === null) {
    console.log(`[AUTH DEBUG ${timestamp}] ${message}`);
    return;
  }

  console.log(`[AUTH DEBUG ${timestamp}] ${message}`, details);
}

function getRefreshTokenBackup() {
  const value = localStorage.getItem(REFRESH_TOKEN_BACKUP_KEY);
  return value && value.trim().length > 0 ? value : null;
}

function setRefreshTokenBackup(refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) return;
  localStorage.setItem(REFRESH_TOKEN_BACKUP_KEY, refreshToken);
  authDebug('setRefreshTokenBackup: backup updated', {
    hasRefreshToken: true,
    refreshTokenLength: refreshToken.length,
  });
}

function restoreRefreshTokenIfMissing(source = 'unknown') {
  if (!tokenResponse || tokenResponse.refresh_token) return false;

  const backupRefreshToken = getRefreshTokenBackup();
  if (!backupRefreshToken) return false;

  tokenResponse = {
    ...tokenResponse,
    refresh_token: backupRefreshToken,
  };

  authDebug('restoreRefreshTokenIfMissing: restored refresh token from backup', {
    source,
  });
  return true;
}

// DOM refs ---------------------------------------------------------------
const appHeader = document.getElementById('app-header');
const envBadge = document.getElementById('env-badge');
const btnLogout = document.getElementById('btn-logout');
const configSection = document.getElementById('config-section');
const btnConnect = document.getElementById('btn-connect');
const authStatus = document.getElementById('auth-status');
const tradingSection = document.getElementById('trading-section');
const accountSelect = document.getElementById('account-select');
const btnDryRun = document.getElementById('btn-dry-run');
const btnSubmit = document.getElementById('btn-submit');
const orderStatus = document.getElementById('order-status');
const orderResponse = document.getElementById('order-response');
const tickerInput = document.getElementById('ticker-input');
const chainStatus = document.getElementById('chain-status');
const chainSection = document.getElementById('chain-section');
const chainRows = document.getElementById('chain-rows');
const selectedSymbolEl = document.getElementById('selected-symbol');
const orderSection = document.getElementById('order-section');
const callSymbolEl = document.getElementById('call-symbol');
const putSymbolEl = document.getElementById('put-symbol');
const btnDryRunCall = document.getElementById('btn-dry-run-call');
const btnSubmitCall = document.getElementById('btn-submit-call');
const btnDryRunPut = document.getElementById('btn-dry-run-put');
const btnSubmitPut = document.getElementById('btn-submit-put');
const callOrderStatus = document.getElementById('call-order-status');
const putOrderStatus = document.getElementById('put-order-status');
const callOrderResponse = document.getElementById('call-order-response');
const putOrderResponse = document.getElementById('put-order-response');
const callActionEl = document.getElementById('call-action');
const putActionEl = document.getElementById('put-action');
const callBpReductionEl = document.getElementById('call-bp-reduction');
const putBpReductionEl = document.getElementById('put-bp-reduction');
const livePriceEl = document.getElementById('live-price');
const liveConnectionEl = document.getElementById('live-connection');

// Market data (DxLink) state -------------------------------------------------
const DXLINK_CONTROL_CHANNEL = 0;
const DXLINK_FEED_CHANNEL = 3;
let marketSocket = null;
let marketSocketOpen = false;
let marketAuthorized = false;
let marketFeedReady = false;
let marketKeepaliveTimer = null;
let marketReconnectInFlight = null;
let marketQuoteToken = null;
let marketDxlinkUrl = null;
let marketAutoReconnectTimer = null;
let marketAutoReconnectAttempts = 0;
let selectedStreamerSymbol = null;
let symbolMapCache = new Map();
let currentLiveQuotePrice = null;
let hasAutoScrolledToLiveStrike = false;
let optionStreamerByOptionSymbol = new Map();
let optionQuoteByStreamerSymbol = new Map();
let optionQuoteSubscriptions = new Set();
let optionQuoteCellsByStreamerSymbol = new Map();
let optionQuoteRenderCycle = 0;
const bpEstimateInFlight = {
  call: false,
  put: false,
};
const bpEstimateNeedsRefresh = {
  call: false,
  put: false,
};

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

// On page refresh: check if returning from OAuth redirect ---------------------

window.addEventListener('load', async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');

  if (code) {
    await handleOAuthCallback(code, state);
    return;
  }

  try {
    tokenResponse = JSON.parse(localStorage.getItem('token_response'));
  } catch {
    tokenResponse = null;
    localStorage.removeItem('token_response');
  }

  if (!tokenResponse) {
    return;
  }

  try {
    restoreRefreshTokenIfMissing('startup');
    tokenResponse = normalizeTokenResponse(tokenResponse);
    authDebug('startup: writing normalized token_response', {
      hasAccessToken: !!tokenResponse?.access_token,
      hasRefreshToken: !!tokenResponse?.refresh_token,
      expiresAt: tokenResponse?.expires_at ?? null,
    });
    localStorage.setItem('token_response', JSON.stringify(tokenResponse));
    setRefreshTokenBackup(tokenResponse.refresh_token);
    await ensureValidToken();
    await loadAccounts();
    await showAuthenticated();
  } catch (err) {
    clearAuthState();
    setStatus(authStatus, `Session restore failed: ${err.message}`, 'error');
  }
});

// PKCE Helpers ---------------------------------------------------------------
function generateRandomString(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array).map(b => chars[b % chars.length]).join('');
}

async function generateCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function normalizeTokenResponse(data) {
  const expiresInSeconds = Number.parseInt(data?.expires_in, 10);
  const expiresIn = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0;

  if (Number.isFinite(data?.expires_at)) {
    return {
      ...data,
      expires_in: expiresIn,
    };
  }

  const issuedAt = Number.isFinite(data?.issued_at) ? data.issued_at : Date.now();

  return {
    ...data,
    expires_in: expiresIn,
    issued_at: issuedAt,
    expires_at: issuedAt + (expiresIn * 1000),
  };
}

function persistTokenResponse(nextData, previousData = tokenResponse) {
  const merged = {
    ...(previousData ?? {}),
    ...(nextData ?? {}),
    refresh_token: nextData?.refresh_token ?? previousData?.refresh_token ?? null,
  };

  tokenResponse = normalizeTokenResponse(merged);
  authDebug('persistTokenResponse: writing token_response', {
    nextHasAccessToken: !!nextData?.access_token,
    nextHasRefreshToken: !!nextData?.refresh_token,
    previousHasRefreshToken: !!previousData?.refresh_token,
    mergedHasAccessToken: !!tokenResponse?.access_token,
    mergedHasRefreshToken: !!tokenResponse?.refresh_token,
    expiresAt: tokenResponse?.expires_at ?? null,
  });
  localStorage.setItem('token_response', JSON.stringify(tokenResponse));
  setRefreshTokenBackup(tokenResponse.refresh_token);
  return tokenResponse;
}

// Step 1: Redirect to TastyTrade login --------------------------------------
btnConnect.addEventListener('click', async () => {

  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateRandomString(16);

  // Persist across the redirect
  localStorage.setItem('pkce_verifier', codeVerifier);
  localStorage.setItem('pkce_state', state);

  const { authorizeUrl } = getConfig();
  const authUrl = new URL(authorizeUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  window.location.href = authUrl.toString();
});

// Step 2: Exchange authorization code for access token ----------------------
async function handleOAuthCallback(code, returnedState) {

  const codeVerifier = localStorage.getItem('pkce_verifier');
  const expectedState = localStorage.getItem('pkce_state');

  // Clean up both stores
  ['pkce_verifier', 'pkce_state', 'token_response'].forEach(key => {
    localStorage.removeItem(key);
  });

  // Clear the ?code=...&state=... from the URL bar
  window.history.replaceState({}, document.title, window.location.pathname);

  if (returnedState !== expectedState) {
    setStatus(authStatus, 'Auth failed: state mismatch (possible CSRF attack)', 'error');
    return;
  }

  try {
    const { tokenEndpoint } = getConfig();

    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code,
        code_verifier: codeVerifier,
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error_description || data.error || 'Token exchange failed');
    }

    persistTokenResponse(data, null);

    await loadAccounts();
    await showAuthenticated();

  } catch (err) {
    setStatus(authStatus, `Error: ${err.message}`, 'error');
  }
}

async function refreshAccessToken() {
  if (authRefreshInFlight) {
    authDebug('refreshAccessToken: reusing in-flight refresh promise');
    return authRefreshInFlight;
  }

  const currentRefreshToken = tokenResponse?.refresh_token;
  if (!currentRefreshToken) {
    throw new Error('Missing refresh token');
  }

  const { tokenEndpoint } = getConfig();
  authDebug('refreshAccessToken: starting refresh request', {
    hasAccessToken: !!tokenResponse?.access_token,
    hasRefreshToken: !!currentRefreshToken,
    expiresAt: tokenResponse?.expires_at ?? null,
  });

  authRefreshInFlight = (async () => {
    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      })
    });

    const data = await resp.json();
    authDebug('refreshAccessToken: refresh response received', {
      status: resp.status,
      ok: resp.ok,
      hasAccessToken: !!data?.access_token,
      hasRefreshToken: !!data?.refresh_token,
      expiresIn: data?.expires_in ?? null,
      oauthError: data?.error ?? null,
      oauthErrorDescription: data?.error_description ?? null,
    });

    if (!resp.ok) {
      const error = new Error(data.error_description || data.error || 'Token refresh failed');
      error.oauthError = data.error ?? null;
      throw error;
    }

    persistTokenResponse(data);
    authLastRefreshAt = Date.now();
    authLastError = null;
    authDebug('refreshAccessToken: refresh succeeded', {
      expiresAt: tokenResponse?.expires_at ?? null,
      hasRefreshToken: !!tokenResponse?.refresh_token,
    });
  })();

  try {
    await authRefreshInFlight;
  } finally {
    authRefreshInFlight = null;
  }
}

// Proactively refresh if within 60 seconds of expiry
async function ensureValidToken({ forceRefresh = false } = {}) {
  if (!tokenResponse?.access_token) {
    authDebug('ensureValidToken: missing access token');
    throw new Error('Not authenticated');
  }

  if (!Number.isFinite(tokenResponse.expires_at)) {
    tokenResponse = normalizeTokenResponse(tokenResponse);
  }

  const shouldRefreshByTime = Date.now() >= tokenResponse.expires_at - 60_000;
  const shouldRefresh = forceRefresh || shouldRefreshByTime;
  authDebug('ensureValidToken: token check', {
    forceRefresh,
    shouldRefreshByTime,
    shouldRefresh,
    expiresAt: tokenResponse.expires_at,
    now: Date.now(),
  });

  if (!shouldRefresh) {
    setAuthHealthyState(true);
    return;
  }

  if (restoreRefreshTokenIfMissing('ensureValidToken')) {
    tokenResponse = normalizeTokenResponse(tokenResponse);
    localStorage.setItem('token_response', JSON.stringify(tokenResponse));
  }

  if (!tokenResponse?.refresh_token) {
    setAuthHealthyState(false);
    authDebug('ensureValidToken: refresh required but missing refresh token');
    throw new Error('Session refresh unavailable, please log in again');
  }

  try {
    await refreshAccessToken();
    setAuthHealthyState(true);
  } catch (err) {
    authLastError = err.message;
    setAuthHealthyState(false);

    const isExpiredSession = ['invalid_grant', 'invalid_token'].includes(err.oauthError);
    if (isExpiredSession) {
      btnLogout.click();
      throw new Error('Session expired, please log in again');
    }

    throw new Error(`Token refresh failed: ${err.message}`);
  }
}

async function showAuthenticated() {
  configSection.classList.add('hidden');
  appHeader.classList.remove('hidden');
  tradingSection.classList.remove('hidden');

  envBadge.textContent = useSandbox ? 'Sandbox' : 'Production';
  envBadge.className = useSandbox ? 'badge-sandbox' : 'badge-production';
  startAuthMonitoring();
  setAuthHealthyState(true);
  applyTradeButtonState();

  setLivePriceText(currentSymbol, null, true);
  await subscribeSymbolPrice(currentSymbol);
  await loadChain(currentSymbol);
}

btnLogout.addEventListener('click', () => {
  clearAuthState();

  // Restore UI
  appHeader.classList.add('hidden');
  tradingSection.classList.add('hidden');
  configSection.classList.remove('hidden');
  setStatus(authStatus, '', '');
  accountSelect.innerHTML = '';
  orderResponse.textContent = '';

  clearMarketDataConnection();
  setLivePriceText(currentSymbol, null, false);
});

function clearAuthState() {
  tokenResponse = null;
  authLastRefreshAt = null;
  authLastError = null;
  stopAuthMonitoring();
  setAuthHealthyState(false);

  ['pkce_verifier', 'pkce_state', 'token_response'].forEach(key => {
    localStorage.removeItem(key);
  });
  localStorage.removeItem(REFRESH_TOKEN_BACKUP_KEY);
}

function startAuthMonitoring() {
  stopAuthMonitoring();

  authRefreshTimer = setInterval(async () => {
    if (!tokenResponse) return;
    try {
      await ensureValidToken();
    } catch {
      // Auth health state is already updated in ensureValidToken
    }
  }, 30_000);
}

function stopAuthMonitoring() {
  if (authRefreshTimer) {
    clearInterval(authRefreshTimer);
    authRefreshTimer = null;
  }
}

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

  btnDryRunCall.disabled = !callReady;
  btnDryRunCall.className = callReady ? 'btn-dry-run-call' : 'btn-disabled';
  btnSubmitCall.disabled = !callReady;
  btnSubmitCall.className = callReady ? getSubmitButtonClass(stagedCall) : 'btn-disabled';

  btnDryRunPut.disabled = !putReady;
  btnDryRunPut.className = putReady ? 'btn-dry-run-put' : 'btn-disabled';
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

// Submit order ---------------------------------------------------------------
async function submitOrder(staged, side, dryRun = false) {
  const quantity = Number.parseInt(document.getElementById('quantity').value, 10);
  const accountNumber = accountSelect.value;
  const statusEl = side === 'call' ? callOrderStatus : putOrderStatus;
  const responseEl = side === 'call' ? callOrderResponse : putOrderResponse;

  if (!staged || Number.isNaN(quantity) || quantity <= 0) {
    setStatus(statusEl, 'Missing symbol or quantity.', 'error');
    return;
  }

  if (!authHealthy) {
    setStatus(statusEl, 'Authentication is not healthy. Wait for auto-refresh or log in again.', 'error');
    return;
  }

  responseEl.textContent = '';
  responseEl.classList.add('hidden');

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

  const endpoint = dryRun
    ? `/accounts/${accountNumber}/orders/dry-run`
    : `/accounts/${accountNumber}/orders`;

  setStatus(statusEl, dryRun ? 'Running dry run' : 'Submitting order', 'info');

  try {
    const result = await apiPost(endpoint, marketOrder);

    if (dryRun) {
      const dryRunMessage = getDryRunApiMessage(result);
      const statusMessage = dryRunMessage
        ? dryRunMessage
        : 'Dry run complete';
      const statusType = dryRunMessage ? 'info' : 'success';
      setStatus(statusEl, statusMessage, statusType);
    } else {
      setStatus(statusEl, 'Order submitted', 'success');
    }

    responseEl.textContent = '';
    responseEl.classList.add('hidden');
  } catch (err) {
    setStatus(statusEl, `Error: ${err.message}`, 'error');
  }
}

function getDryRunApiMessage(result) {
  const warningCandidates = [
    result?.warnings,
    result?.data?.warnings,
    result?.['warnings'],
  ];

  for (const warnings of warningCandidates) {
    if (!Array.isArray(warnings) || warnings.length === 0) continue;

    const messages = warnings
      .map(warning => {
        if (typeof warning === 'string') return warning;
        return warning?.message ?? warning?.code ?? null;
      })
      .filter(Boolean);

    if (messages.length > 0) {
      return messages.join(' | ');
    }
  }

  const messageCandidates = [
    result?.message,
    result?.data?.message,
    result?.data?.order?.status,
    result?.order?.status,
    result?.context,
  ];

  return messageCandidates.find(value => typeof value === 'string' && value.trim().length > 0) ?? null;
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
  btnDryRunCall.disabled = true;
  btnSubmitCall.disabled = true;
  applyTradeButtonState();
  setStatus(callOrderStatus, '', '');
  callOrderResponse.textContent = '';
  callOrderResponse.classList.add('hidden');
  setBpDisplay('call', '--');

  putSymbolEl.textContent = 'No put selected';
  putSymbolEl.classList.add('empty');
  btnDryRunPut.disabled = true;
  btnSubmitPut.disabled = true;
  applyTradeButtonState();
  setStatus(putOrderStatus, '', '');
  putOrderResponse.textContent = '';
  putOrderResponse.classList.add('hidden');
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
  });
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

function updateAtmMarkers() {
  document.querySelectorAll('.chain-row-item.atm-row').forEach(row => {
    row.classList.remove('atm-row');
  });

  document.querySelectorAll('.chain-row-item .atm-marker-label').forEach(label => {
    label.remove();
  });

  if (!Number.isFinite(currentLiveQuotePrice)) return;

  document.querySelectorAll('.expiry-body').forEach(body => {
    const nearestRow = getNearestStrikeRow(body, currentLiveQuotePrice);
    if (nearestRow) {
      nearestRow.classList.add('atm-row');
      addAtmLabels(nearestRow);
    }
  });
}

function addAtmLabels(row) {
  const createLabel = (text, className) => {
    const label = document.createElement('span');
    label.className = `atm-marker-label ${className}`;
    label.textContent = text;
    return label;
  };

  row.appendChild(createLabel('ITM ▲', 'itm-call-label'));
  row.appendChild(createLabel('▼ ITM', 'itm-put-label'));
}

function scrollOpenChainBodyToNearestStrike() {
  const openBody = chainRows.querySelector('.expiry-body.open');
  if (!openBody) return false;

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

  if (side === 'call') {
    stagedCall = { symbol, action, label, strikePrice };
    callSymbolEl.textContent = label;
    callSymbolEl.classList.remove('empty');
    callActionEl.textContent = actionLabel;
    applyTradeButtonState();
    setStatus(callOrderStatus, '', '');
    callOrderResponse.textContent = '';
    callOrderResponse.classList.add('hidden');
    setBpDisplay('call', '--');
    queueBpEstimateRefreshForSide('call');
  } else {
    stagedPut = { symbol, action, label, strikePrice };
    putSymbolEl.textContent = label;
    putSymbolEl.classList.remove('empty');
    putActionEl.textContent = actionLabel;
    applyTradeButtonState();
    setStatus(putOrderStatus, '', '');
    putOrderResponse.textContent = '';
    putOrderResponse.classList.add('hidden');
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

function toNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,]/g, '');
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function extractBuyingPowerReduction(result) {
  const bpEffect = result?.data?.['buying-power-effect']
    ?? result?.['buying-power-effect']
    ?? null;

  if (!bpEffect || typeof bpEffect !== 'object') {
    return null;
  }

  const directCandidates = [
    bpEffect['change-in-buying-power'],
    bpEffect['buying-power-change'],
    bpEffect['change'],
    bpEffect['effect'],
    bpEffect['impact'],
  ];

  for (const candidate of directCandidates) {
    const numeric = toNumeric(candidate);
    if (numeric !== null) {
      return Math.abs(numeric);
    }
  }

  const numericValues = [];
  Object.values(bpEffect).forEach(value => {
    const numeric = toNumeric(value);
    if (numeric !== null) {
      numericValues.push(numeric);
    }
  });

  if (numericValues.length === 0) {
    return null;
  }

  const negativeValues = numericValues.filter(value => value < 0);
  if (negativeValues.length > 0) {
    return Math.abs(Math.min(...negativeValues));
  }

  return Math.max(...numericValues);
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
function setLivePriceText(symbol, price, connecting = false) {
  if (!livePriceEl) return;

  if (connecting) {
    return;
  }

  if (typeof price === 'number' && Number.isFinite(price)) {
    livePriceEl.textContent = `$${price.toFixed(2)}`;
    updateAtmMarkers();
    return;
  }

  livePriceEl.textContent = null;
  updateAtmMarkers();
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
  if (marketAutoReconnectTimer) {
    clearTimeout(marketAutoReconnectTimer);
    marketAutoReconnectTimer = null;
  }

  marketAutoReconnectAttempts = 0;

  if (marketKeepaliveTimer) {
    clearInterval(marketKeepaliveTimer);
    marketKeepaliveTimer = null;
  }

  if (marketSocket) {
    marketSocket.onopen = null;
    marketSocket.onmessage = null;
    marketSocket.onerror = null;
    marketSocket.onclose = null;
    try {
      marketSocket.close();
    } catch {
      // ignore close errors
    }
  }

  marketSocket = null;
  marketSocketOpen = false;
  marketAuthorized = false;
  marketFeedReady = false;
  marketReconnectInFlight = null;
  marketQuoteToken = null;
  marketDxlinkUrl = null;
  selectedStreamerSymbol = null;
  currentLiveQuotePrice = null;
  hasAutoScrolledToLiveStrike = false;
  optionQuoteByStreamerSymbol.clear();
  optionQuoteSubscriptions.clear();
  optionQuoteCellsByStreamerSymbol.clear();
  setConnectionState(false);
}

function sendDxLinkMessage(message) {
  if (!marketSocket || marketSocket.readyState !== WebSocket.OPEN) return;
  marketSocket.send(JSON.stringify(message));
}

function scheduleDxLinkReconnect() {
  if (!tokenResponse?.access_token) return;
  if (marketAutoReconnectTimer) return;

  const delayMs = Math.min(30_000, 1_000 * (2 ** marketAutoReconnectAttempts));
  marketAutoReconnectAttempts += 1;

  marketAutoReconnectTimer = setTimeout(async () => {
    marketAutoReconnectTimer = null;

    try {
      await reconnectDxLinkStreams();
      marketAutoReconnectAttempts = 0;
    } catch {
      scheduleDxLinkReconnect();
    }
  }, delayMs);
}

async function reconnectDxLinkStreams() {
  if (!tokenResponse?.access_token) return;

  await ensureDxLinkReady();

  if (selectedStreamerSymbol) {
    sendDxLinkMessage({
      type: 'FEED_SUBSCRIPTION',
      channel: DXLINK_FEED_CHANNEL,
      reset: true,
      add: [
        { type: 'Trade', symbol: selectedStreamerSymbol },
        { type: 'Quote', symbol: selectedStreamerSymbol },
      ],
    });
  }

  if (optionQuoteSubscriptions.size > 0) {
    const optionSymbols = Array.from(optionQuoteSubscriptions).map(symbol => ({ type: 'Quote', symbol }));
    sendDxLinkMessage({
      type: 'FEED_SUBSCRIPTION',
      channel: DXLINK_FEED_CHANNEL,
      add: optionSymbols,
    });
  }
}

function normalizeCompactEvents(rawData) {
  if (!Array.isArray(rawData) || rawData.length < 2) return { eventType: null, events: [] };

  const eventType = rawData[0];
  const payload = rawData[1];
  if (!Array.isArray(payload) || payload.length === 0) {
    return { eventType, events: [] };
  }

  if (Array.isArray(payload[0])) {
    return { eventType, events: payload };
  }

  const fieldCountByType = {
    Trade: 3,
    Quote: 4,
  };

  const fieldCount = fieldCountByType[eventType];
  if (!fieldCount) {
    return { eventType, events: [payload] };
  }

  const events = [];
  for (let index = 0; index + fieldCount - 1 < payload.length; index += fieldCount) {
    events.push(payload.slice(index, index + fieldCount));
  }

  return { eventType, events };
}

function handleDxLinkFeedData(rawData) {
  const { eventType, events } = normalizeCompactEvents(rawData);

  if (!eventType || events.length === 0) return;

  events.forEach(eventRow => {
    if (!Array.isArray(eventRow) || eventRow.length < 3) return;

    const eventSymbol = eventRow[1];

    if (eventType === 'Trade') {
      if (eventSymbol !== selectedStreamerSymbol) return;

      const price = Number(eventRow[2]);
      if (Number.isFinite(price)) {
        currentLiveQuotePrice = price;
        setLivePriceText(currentSymbol, price, false);
        maybeAutoScrollChainToLivePrice();
        refreshBpEstimates();
      }
      return;
    }

    if (eventType === 'Quote') {
      const bidPrice = Number(eventRow[2]);
      const askPrice = Number(eventRow[3]);

      if (optionQuoteSubscriptions.has(eventSymbol)) {
        optionQuoteByStreamerSymbol.set(eventSymbol, {
          bidPrice,
          askPrice,
          updatedAt: Date.now(),
        });
        updateOptionQuoteCellsForStreamer(eventSymbol);
      }

      if (eventSymbol !== selectedStreamerSymbol) return;

      if (Number.isFinite(bidPrice) && Number.isFinite(askPrice) && bidPrice > 0 && askPrice > 0) {
        const mid = (bidPrice + askPrice) / 2;
        currentLiveQuotePrice = mid;
        setLivePriceText(currentSymbol, mid, false);
        maybeAutoScrollChainToLivePrice();
        refreshBpEstimates();
      }
    }
  });
}

function startDxLinkKeepalive() {
  if (marketKeepaliveTimer) {
    clearInterval(marketKeepaliveTimer);
  }

  marketKeepaliveTimer = setInterval(() => {
    sendDxLinkMessage({ type: 'KEEPALIVE', channel: DXLINK_CONTROL_CHANNEL });
  }, 30_000);
}

async function getQuoteToken() {
  const quote = await apiGet('/api-quote-tokens');
  const token = quote?.data?.token;
  const dxlinkUrl = quote?.data?.['dxlink-url'];

  if (!token || !dxlinkUrl) {
    throw new Error('Unable to get market data token');
  }

  marketQuoteToken = token;
  marketDxlinkUrl = dxlinkUrl;
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

async function ensureDxLinkReady() {
  if (marketFeedReady && marketSocket?.readyState === WebSocket.OPEN) {
    return;
  }

  if (marketReconnectInFlight) {
    return marketReconnectInFlight;
  }

  marketReconnectInFlight = new Promise(async (resolve, reject) => {
    let settled = false;
    let timeoutId = null;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      marketReconnectInFlight = null;
      resolve();
    };

    const finishReject = error => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      marketReconnectInFlight = null;
      reject(error);
    };

    try {
      await getQuoteToken();

      marketSocket = new WebSocket(marketDxlinkUrl);

      marketSocket.onopen = () => {
        marketSocketOpen = true;
        sendDxLinkMessage({
          type: 'SETUP',
          channel: DXLINK_CONTROL_CHANNEL,
          version: '0.1-DXF-JS/0.3.0',
          keepaliveTimeout: 60,
          acceptKeepaliveTimeout: 60,
        });
      };

      marketSocket.onmessage = event => {
        let message = null;

        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!message?.type) return;

        if (message.type === 'AUTH_STATE') {
          if (message.state === 'UNAUTHORIZED') {
            sendDxLinkMessage({
              type: 'AUTH',
              channel: DXLINK_CONTROL_CHANNEL,
              token: marketQuoteToken,
            });
          }

          if (message.state === 'AUTHORIZED') {
            marketAuthorized = true;
            sendDxLinkMessage({
              type: 'CHANNEL_REQUEST',
              channel: DXLINK_FEED_CHANNEL,
              service: 'FEED',
              parameters: { contract: 'AUTO' },
            });
          }

          return;
        }

        if (message.type === 'CHANNEL_OPENED' && message.channel === DXLINK_FEED_CHANNEL) {
          sendDxLinkMessage({
            type: 'FEED_SETUP',
            channel: DXLINK_FEED_CHANNEL,
            acceptAggregationPeriod: 0.1,
            acceptDataFormat: 'COMPACT',
            acceptEventFields: {
              Trade: ['eventType', 'eventSymbol', 'price'],
              Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
            },
          });
          return;
        }

        if (message.type === 'FEED_CONFIG' && message.channel === DXLINK_FEED_CHANNEL) {
          marketFeedReady = true;
          startDxLinkKeepalive();
          setConnectionState(true);
          if (marketAutoReconnectTimer) {
            clearTimeout(marketAutoReconnectTimer);
            marketAutoReconnectTimer = null;
          }
          marketAutoReconnectAttempts = 0;
          finishResolve();
          return;
        }

        if (message.type === 'FEED_DATA' && message.channel === DXLINK_FEED_CHANNEL) {
          handleDxLinkFeedData(message.data);
        }
      };

      marketSocket.onerror = () => {
        setConnectionState(false);
        scheduleDxLinkReconnect();
      };

      marketSocket.onclose = () => {
        if (marketKeepaliveTimer) {
          clearInterval(marketKeepaliveTimer);
          marketKeepaliveTimer = null;
        }

        marketSocketOpen = false;
        marketAuthorized = false;
        marketFeedReady = false;
        marketSocket = null;
        marketReconnectInFlight = null;
        setConnectionState(false);
        scheduleDxLinkReconnect();
      };

      timeoutId = setTimeout(() => {
        if (!marketFeedReady) {
          finishReject(new Error('Market data connection timeout'));
        }
      }, 10_000);
    } catch (error) {
      scheduleDxLinkReconnect();
      finishReject(error);
    }
  });

  return marketReconnectInFlight;
}

async function subscribeSymbolPrice(symbol) {
  if (!tokenResponse?.access_token) return;

  try {
    currentLiveQuotePrice = null;
    setLivePriceText(symbol, null, true);

    const streamerSymbol = await resolveStreamerSymbol(symbol);
    selectedStreamerSymbol = streamerSymbol;

    await ensureDxLinkReady();

    sendDxLinkMessage({
      type: 'FEED_SUBSCRIPTION',
      channel: DXLINK_FEED_CHANNEL,
      reset: true,
      add: [
        { type: 'Trade', symbol: streamerSymbol },
        { type: 'Quote', symbol: streamerSymbol },
      ],
    });
  } catch (err) {
    setLivePriceText(symbol, null, false);
    setConnectionState(false);
    setStatus(chainStatus, `Market data error: ${err.message}`, 'error');
  }
}

// Order button listeners ---------------------------------------------------
btnDryRunCall.addEventListener('click', () => submitOrder(stagedCall, 'call', true));
btnSubmitCall.addEventListener('click', () => submitOrder(stagedCall, 'call', false));
btnDryRunPut.addEventListener('click', () => submitOrder(stagedPut, 'put', true));
btnSubmitPut.addEventListener('click', () => submitOrder(stagedPut, 'put', false));

// API Helpers ---------------------------------------------------------------
async function apiGet(path) {
  const resp = await fetchWithAuth(path, {
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${resp.status}`);
  }

  return resp.json();
}

async function apiPost(path, body) {
  const resp = await fetchWithAuth(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.log('API error response:', JSON.stringify(err, null, 2));

    // Extract preflight errors if present, otherwise fall back to top-level message
    const preflightErrors = err?.error?.errors;
    const message = preflightErrors
      ? preflightErrors.map(e => e.message).join(', ')
      : err?.error?.message ?? `HTTP ${resp.status}`;

    const apiError = new Error(message);
    apiError.status = resp.status;
    apiError.code = err?.error?.code ?? null;
    apiError.preflightCodes = Array.isArray(preflightErrors)
      ? preflightErrors.map(item => item?.code).filter(Boolean)
      : [];
    throw apiError;
  }

  return resp.json();
}

async function fetchWithAuth(path, init, retryOnUnauthorized = true) {
  await ensureValidToken();

  const requestInit = {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'Authorization': `Bearer ${tokenResponse.access_token}`,
    },
  };

  const response = await fetch(`${getConfig().baseUrl}${path}`, requestInit);
  authDebug('fetchWithAuth: API response received', {
    path,
    method: requestInit?.method ?? 'GET',
    status: response.status,
    retryOnUnauthorized,
  });

  if (response.status === 401 && retryOnUnauthorized && tokenResponse?.refresh_token) {
    authDebug('fetchWithAuth: got 401, forcing refresh and retry', {
      path,
      method: requestInit?.method ?? 'GET',
    });
    await ensureValidToken({ forceRefresh: true });

    const retryInit = {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        'Authorization': `Bearer ${tokenResponse.access_token}`,
      },
    };

    const retryResponse = await fetch(`${getConfig().baseUrl}${path}`, retryInit);
    authDebug('fetchWithAuth: retry response received', {
      path,
      method: retryInit?.method ?? 'GET',
      status: retryResponse.status,
    });
    return retryResponse;
  }

  return response;
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
