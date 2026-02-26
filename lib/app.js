/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

const APP_SETTINGS_STORAGE_KEY = 'quickstrike.appSettings';

function readStoredAppSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(APP_SETTINGS_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistAppSettings(nextSettings) {
  storedAppSettings = nextSettings;
  localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings));
}

let storedAppSettings = readStoredAppSettings();
const HAS_ACTIVE_ADAPTER_CONFIG = typeof ACTIVE_ADAPTER === 'string' && ACTIVE_ADAPTER.trim().length > 0;
const HAS_SANDBOX_CONFIG = typeof useSandbox === 'boolean';
const HAS_STORED_ADAPTER = typeof storedAppSettings?.activeAdapter === 'string' && storedAppSettings.activeAdapter.trim().length > 0;
const HAS_STORED_SANDBOX = typeof storedAppSettings?.useSandbox === 'boolean';
const ROOT_CONFIG_ERRORS = [];

if (!HAS_ACTIVE_ADAPTER_CONFIG && !HAS_STORED_ADAPTER) {
  ROOT_CONFIG_ERRORS.push('Missing ACTIVE_ADAPTER in config.js.');
}

if (!HAS_SANDBOX_CONFIG && !HAS_STORED_SANDBOX) {
  ROOT_CONFIG_ERRORS.push('Missing useSandbox boolean in config.js.');
}

const ACTIVE_ADAPTER_ID = HAS_STORED_ADAPTER
  ? storedAppSettings.activeAdapter.trim().toLowerCase()
  : HAS_ACTIVE_ADAPTER_CONFIG
    ? ACTIVE_ADAPTER.trim().toLowerCase()
  : 'tastytrade';
const APP_USE_SANDBOX = HAS_STORED_SANDBOX ? storedAppSettings.useSandbox : (HAS_SANDBOX_CONFIG ? useSandbox : true);
const IS_OAUTH_ADAPTER = ACTIVE_ADAPTER_ID === 'tastytrade';

const ADAPTER_FACTORIES = {
  tastytrade: () => window.createTastyTradeAdapter,
  ibkr: () => window.createIbkrAdapter,
};

let stagedCall = null;
let stagedPut = null;
let authHealthy = false;
let authManager = null;

function getActiveAdapterConfig() {
  return window.ADAPTER_CONFIGS?.[ACTIVE_ADAPTER_ID] ?? null;
}

function resolveEnvironmentConfigKey(adapterId, useSandboxMode) {
  const adapterConfig = window.ADAPTER_CONFIGS?.[adapterId] ?? {};

  if (useSandboxMode) {
    if (adapterConfig.sandbox) return 'sandbox';
    if (adapterConfig.paper) return 'paper';
    return 'sandbox';
  }

  if (adapterConfig.live) return 'live';
  if (adapterConfig.production) return 'production';
  return 'live';
}

function getStoredCredentialOverrides(adapterId, useSandboxMode) {
  const envKey = resolveEnvironmentConfigKey(adapterId, useSandboxMode);
  return storedAppSettings?.credentials?.[adapterId]?.[envKey] ?? null;
}

function getConfig() {
  const adapterConfig = getActiveAdapterConfig() ?? {};
  const envKey = resolveEnvironmentConfigKey(ACTIVE_ADAPTER_ID, APP_USE_SANDBOX);
  const envConfig = adapterConfig?.[envKey] ?? null;
  if (!envConfig) return null;

  const credentialOverrides = getStoredCredentialOverrides(ACTIVE_ADAPTER_ID, APP_USE_SANDBOX) ?? {};
  const nextClientId = `${credentialOverrides?.clientId ?? ''}`.trim();
  const nextClientSecret = `${credentialOverrides?.clientSecret ?? ''}`.trim();

  return {
    ...envConfig,
    clientId: nextClientId.length > 0 ? nextClientId : envConfig.clientId,
    clientSecret: nextClientSecret.length > 0 ? nextClientSecret : envConfig.clientSecret,
  };
}

function getAdapterFactory(adapterId) {
  const resolver = ADAPTER_FACTORIES[adapterId];
  if (!resolver) return null;
  return resolver();
}

function getClientId() {
  return getConfig()?.clientId ?? '';
}

function getClientSecret() {
  return getConfig()?.clientSecret ?? '';
}

function resolveIbkrPortFromConfig({ platform, useSandboxMode }) {
  const ibkrConfig = window.ADAPTER_CONFIGS?.ibkr ?? {};
  const ibGatewayLivePort = Number.parseInt(ibkrConfig.ibGatewayLivePort, 10);
  const ibGatewayPaperPort = Number.parseInt(ibkrConfig.ibGatewayPaperPort, 10);
  const twsLivePort = Number.parseInt(ibkrConfig.twsLivePort, 10);
  const twsPaperPort = Number.parseInt(ibkrConfig.twsPaperPort, 10);

  const normalizedPlatform = `${platform ?? ''}`.trim().toLowerCase();
  if (normalizedPlatform === 'gateway') {
    if (useSandboxMode) {
      return Number.isFinite(ibGatewayPaperPort) ? ibGatewayPaperPort : 4002;
    }

    return Number.isFinite(ibGatewayLivePort) ? ibGatewayLivePort : 4001;
  }

  if (useSandboxMode) {
    return Number.isFinite(twsPaperPort) ? twsPaperPort : 7496;
  }

  return Number.isFinite(twsLivePort) ? twsLivePort : 7497;
}

function getIbkrConnectionSettings() {
  const envKey = resolveEnvironmentConfigKey('ibkr', APP_USE_SANDBOX);
  const ibkrSettings = storedAppSettings?.ibkr?.[envKey] ?? {};
  const ibkrConfig = window.ADAPTER_CONFIGS?.ibkr ?? {};
  const platform = `${ibkrSettings?.platform ?? 'tws'}`.trim().toLowerCase();
  const host = `${ibkrSettings?.host ?? '127.0.0.1'}`.trim() || '127.0.0.1';
  const port = resolveIbkrPortFromConfig({
    platform,
    useSandboxMode: APP_USE_SANDBOX,
  });

  return {
    host,
    port,
    platform,
    clientId: 0,
    suppressDisconnectStateLogs: `${ibkrConfig?.suppressDisconnectStateLogs ?? true}`.trim().toLowerCase() !== 'false',
  };
}

// DOM refs ---------------------------------------------------------------
const appHeader = document.getElementById('app-header');
const loadingSection = document.getElementById('loading-section');
const loadingMessage = document.getElementById('loading-message');
const loadingError = document.getElementById('loading-error');
const btnLoadingRetry = document.getElementById('btn-loading-retry');
const toastContainer = document.getElementById('toast-container');
const envBadge = document.getElementById('env-badge');
const btnLogout = document.getElementById('btn-logout');
const configSection = document.getElementById('config-section');
const configVersion = document.getElementById('config-version');
const btnConnect = document.getElementById('btn-connect');
const configAdapterSelect = document.getElementById('config-adapter-select');
const configEnvSelect = document.getElementById('config-env-select');
const configTastyTradeFields = document.getElementById('config-tastytrade-fields');
const configClientIdInput = document.getElementById('config-client-id-input');
const configClientSecretInput = document.getElementById('config-client-secret-input');
const configIbkrFields = document.getElementById('config-ibkr-fields');
const configIbkrPlatformSelect = document.getElementById('config-ibkr-platform-select');
const configIbkrIpInput = document.getElementById('config-ibkr-ip-input');
const configIbkrTwsPrereq = document.getElementById('config-ibkr-tws-prereq');
const configIbkrApiSettingsPath = document.getElementById('config-ibkr-api-settings-path');
const configIbkrActiveXItem = document.getElementById('config-ibkr-activex-item');
const configIbkrSocketPort = document.getElementById('config-ibkr-socket-port');
const consolidatedStatus = document.getElementById('status-message');
const tradingSection = document.getElementById('trading-section');
const accountSelect = document.getElementById('account-select');
const chainStatus = document.getElementById('chain-status');
const positionsSection = document.getElementById('positions-section');
const positionsRows = document.getElementById('positions-rows');
const chainSection = document.getElementById('chain-section');
const chainRows = document.getElementById('chain-rows');
const callSymbolEl = document.getElementById('call-symbol');
const putSymbolEl = document.getElementById('put-symbol');
const btnSubmitCall = document.getElementById('btn-submit-call');
const btnSubmitPut = document.getElementById('btn-submit-put');
const callActionEl = document.getElementById('call-action');
const putActionEl = document.getElementById('put-action');
const callBpReductionEl = document.getElementById('call-bp-reduction');
const putBpReductionEl = document.getElementById('put-bp-reduction');
const livePriceEl = document.getElementById('live-price');
const liveConnectionEl = document.getElementById('live-connection');

// Market data state -------------------------------------------------
const LIVE_PRICE_DISPLAY_MIN_INTERVAL_MS = 1_000;
let currentLiveQuotePrice = null;
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
const POSITIONS_PRUNE_POLL_INTERVAL_MS = 10_000;
let marketDataClient = null;
let positionsManager = null;
let apiClient = null;
let brokerAdapter = null;
let bootstrapManager = null;
let optionChainController = null;
let lastLivePriceDisplayAt = 0;
let pendingLivePriceValue = null;
let pendingLivePriceTimer = null;
let hasActiveMarketDataError = false;
let activeMarketDataErrorText = '';
let lastMarketDataErrorAt = 0;
let positionsPrunePollTimer = null;
let positionsPrunePollInFlight = false;
const sharedQuoteSubscriptionRefCounts = new Map();
const toastManager = window.createToastManager?.({
  container: toastContainer,
  dedupeWindowMs: 4_000,
  autoHideMs: 3_500,
}) ?? null;

function showToastMessage(message, type = 'info') {
  toastManager?.show(message, type);
}

function initializeConfigControls() {
  const settingsController = window.createSettingsController?.({
    controls: {
      btnConnect,
      configAdapterSelect,
      configEnvSelect,
      configTastyTradeFields,
      configClientIdInput,
      configClientSecretInput,
      configIbkrFields,
      configIbkrPlatformSelect,
      configIbkrIpInput,
      configIbkrTwsPrereq,
      configIbkrApiSettingsPath,
      configIbkrActiveXItem,
      configIbkrSocketPort,
    },
    getStoredSettings: () => storedAppSettings,
    persistSettings: persistAppSettings,
    activeAdapterId: ACTIVE_ADAPTER_ID,
    appUseSandbox: APP_USE_SANDBOX,
    resolveEnvironmentConfigKey,
    getAdapterFactory,
    getAdapterConfigs: () => window.ADAPTER_CONFIGS,
    showToast: showToastMessage,
  });

  settingsController?.initialize();
}

async function renderAppVersion() {
  if (!configVersion) return;

  try {
    const version = await window.electronIBKR?.getAppVersion?.();
    if (!version) return;

    configVersion.textContent = `Version ${version}`;
    configVersion.classList.remove('hidden');
  } catch {
    // no-op
  }
}

function getOrderStatusEl(side) {
  return consolidatedStatus;
}

function setOrderStatus(side, message, type) {
  if (!message) return;

  showToastMessage(message, type || 'info');
}

function hideOrderStatuses() {
  return;
}

function isShowingActiveMarketDataError() {
  if (!hasActiveMarketDataError) return false;
  return true;
}

function clearMarketDataErrorStatus({ clearUi = false } = {}) {
  hasActiveMarketDataError = false;
  activeMarketDataErrorText = '';
  lastMarketDataErrorAt = 0;
}

function setMarketDataErrorStatus(message) {
  const normalizedMessage = `${message ?? ''}`.trim();
  const now = Date.now();
  if (
    normalizedMessage
    && normalizedMessage === activeMarketDataErrorText
    && now - lastMarketDataErrorAt < 8_000
  ) {
    return;
  }

  hasActiveMarketDataError = true;
  activeMarketDataErrorText = normalizedMessage;
  lastMarketDataErrorAt = now;
  showToastMessage(normalizedMessage, 'error');
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
  if (sharedQuoteSubscriptionRefCounts.size === 0) return;

  const quoteSymbols = Array.from(sharedQuoteSubscriptionRefCounts.keys());
  marketDataClient?.reapplyQuoteSubscriptions(quoteSymbols);
}

async function addSharedQuoteSubscriptions(streamerSymbols) {
  const uniqueSymbols = Array.from(new Set((streamerSymbols ?? []).filter(Boolean)));
  if (uniqueSymbols.length === 0) return;

  const symbolsToAdd = [];
  uniqueSymbols.forEach(symbol => {
    const currentCount = sharedQuoteSubscriptionRefCounts.get(symbol) ?? 0;
    if (currentCount === 0) {
      symbolsToAdd.push(symbol);
    }
    sharedQuoteSubscriptionRefCounts.set(symbol, currentCount + 1);
  });

  if (symbolsToAdd.length === 0) return;

  await ensureMarketDataReady();
  await marketDataClient?.addQuoteSubscriptions(symbolsToAdd);
}

function removeSharedQuoteSubscriptions(streamerSymbols) {
  const uniqueSymbols = Array.from(new Set((streamerSymbols ?? []).filter(Boolean)));
  if (uniqueSymbols.length === 0) return;

  const symbolsToRemove = [];
  uniqueSymbols.forEach(symbol => {
    const currentCount = sharedQuoteSubscriptionRefCounts.get(symbol) ?? 0;
    if (currentCount <= 1) {
      if (currentCount === 1) {
        symbolsToRemove.push(symbol);
      }
      sharedQuoteSubscriptionRefCounts.delete(symbol);
      return;
    }

    sharedQuoteSubscriptionRefCounts.set(symbol, currentCount - 1);
  });

  if (symbolsToRemove.length === 0) return;

  marketDataClient?.removeQuoteSubscriptions(symbolsToRemove);
}

function handleUnderlyingTrade(price) {
  currentLiveQuotePrice = price;
  setLivePriceText(price, false);
  optionChainController?.maybeAutoScrollChainToLivePrice();
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
    optionChainController?.maybeAutoScrollChainToLivePrice();
    refreshBpEstimates();
  }
}

function initializeManagers() {
  const adapterConfig = getConfig();

  if (IS_OAUTH_ADAPTER) {
    if (!adapterConfig?.baseUrl) {
      throw new Error(`Missing baseUrl for adapter '${ACTIVE_ADAPTER_ID}' in current environment config.`);
    }

    if (!adapterConfig?.tokenEndpoint || !adapterConfig?.authorizeUrl) {
      throw new Error(`Missing OAuth endpoints for adapter '${ACTIVE_ADAPTER_ID}' in current environment config.`);
    }

    if (!adapterConfig?.redirectUri) {
      throw new Error(`Missing redirectUri for adapter '${ACTIVE_ADAPTER_ID}' in current environment config.`);
    }
  }

  const adapterFactory = getAdapterFactory(ACTIVE_ADAPTER_ID);
  if (typeof adapterFactory !== 'function') {
    throw new Error(`Adapter '${ACTIVE_ADAPTER_ID}' is configured but its runtime factory is not loaded.`);
  }

  if (IS_OAUTH_ADAPTER) {
    authManager = window.createAuthManager({
      getConfig,
      setAuthHealthyState,
      onSessionExpired: () => btnLogout.click(),
      authDebugEnabled: true,
    });

    apiClient = window.createApiClient({
      ensureValidToken: () => authManager.ensureValidToken({ clientId: getClientId(), clientSecret: getClientSecret() }),
      forceRefreshToken: () => authManager.ensureValidToken({ forceRefresh: true, clientId: getClientId(), clientSecret: getClientSecret() }),
      hasRefreshToken: () => authManager.hasRefreshToken(),
      getAccessToken: () => authManager.getAccessToken(),
      getBaseUrl: () => getConfig().baseUrl,
      authDebug: authManager.authDebug,
    });

    brokerAdapter = adapterFactory({
      apiClient,
    });
  } else {
    authManager = null;
    apiClient = null;

    brokerAdapter = adapterFactory({
      getConnectionSettings: getIbkrConnectionSettings,
    });
  }

  marketDataClient = brokerAdapter.createMarketDataClient?.({
    hasAccessToken: () => (IS_OAUTH_ADAPTER ? authManager?.hasAccessToken() : true),
    onConnectionState: setConnectionState,
    onUnderlyingTrade: handleUnderlyingTrade,
    onQuote: handleQuoteEvent,
    onError: setMarketDataErrorStatus,
    onFeedReady: () => {
      reapplyOptionQuoteSubscriptions();
    },
  }) ?? null;

  positionsManager = window.createPositionsManager({
    positionsSection,
    positionsStatus: consolidatedStatus,
    positionsRows,
    useSandbox: APP_USE_SANDBOX,
    accountSelect,
    getCurrentSymbol: () => currentSymbol,
    listPositions: accountNumber => brokerAdapter.listPositions(accountNumber),
    submitOrder: (accountNumber, order) => brokerAdapter.submitOrder(accountNumber, order),
    ensureMarketDataReady,
    addQuoteSubscriptions: addSharedQuoteSubscriptions,
    removeQuoteSubscriptions: removeSharedQuoteSubscriptions,
    showToast: showToastMessage,
    setStatus,
  });

  optionChainController = window.createOptionChainController?.({
    chainRows,
    chainSection,
    formatExpiry,
    createQuotePriceEl,
    selectSymbol,
    primeOptionQuoteCells,
    getOptionQuoteRenderCycle: () => optionQuoteRenderCycle,
    getCurrentLiveQuotePrice: () => currentLiveQuotePrice,
    atmMarkerUpdateMinIntervalMs: 1_000,
    atmSwitchHysteresisDollars: 0.35,
  }) ?? null;

  if (IS_OAUTH_ADAPTER) {
    bootstrapManager = window.createBootstrapManager({
      getConfig,
      clientId: getClientId(),
      clientSecret: getClientSecret(),
      redirectUri: adapterConfig.redirectUri,
      useSandbox: APP_USE_SANDBOX,
      loadingSection,
      loadingMessage,
      loadingError,
      btnLoadingRetry,
      btnConnect,
      btnLogout,
      authStatus: consolidatedStatus,
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
        startPositionsPrunePolling();
        requestAnimationFrame(() => {
          optionChainController?.maybeAutoScrollChainToLivePrice();
          optionChainController?.scheduleAtmMarkerUpdate();
        });
      },
    });
  } else {
    bootstrapManager = window.createIbkrBootstrapManager({
      useSandbox: APP_USE_SANDBOX,
      loadingSection,
      loadingMessage,
      loadingError,
      btnLoadingRetry,
      btnConnect,
      btnLogout,
      authStatus: consolidatedStatus,
      configSection,
      appHeader,
      tradingSection,
      envBadge,
      accountSelect,
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
      connect: () => brokerAdapter.connect?.(),
      disconnect: () => brokerAdapter.disconnect?.(),
      onPostAuthenticatedUiShown: () => {
        startPositionsPrunePolling();
        requestAnimationFrame(() => {
          optionChainController?.maybeAutoScrollChainToLivePrice();
          optionChainController?.scheduleAtmMarkerUpdate();
        });
      },
    });
  }
}

function showFatalStartupError(message) {
  if (loadingMessage) {
    loadingMessage.textContent = 'Configuration error';
  }

  if (loadingError) {
    loadingError.textContent = message;
    loadingError.className = 'status error';
    loadingError.classList.remove('hidden');
  }

  loadingSection?.classList.add('hidden');
  configSection?.classList.remove('hidden');
  appHeader?.classList.add('hidden');
  tradingSection?.classList.add('hidden');
  btnLoadingRetry?.classList.add('hidden');

  setStatus(consolidatedStatus, message, 'error');
}

function startApplication() {
  renderAppVersion();
  initializeConfigControls();

  if (ROOT_CONFIG_ERRORS.length > 0) {
    showFatalStartupError(`Startup halted: ${ROOT_CONFIG_ERRORS.join(' ')}`);
    return;
  }

  try {
    initializeManagers();
    bootstrapManager.initialize();
  } catch (err) {
    showFatalStartupError(`Startup halted: ${err?.message || 'Unknown startup error.'}`);
  }
}

startApplication();

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
  const resp = await brokerAdapter.listAccounts();
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

async function pruneClosedPositions() {
  if (!positionsManager?.pruneClosedPositions) return;
  if (positionsPrunePollInFlight) return;

  positionsPrunePollInFlight = true;
  try {
    await positionsManager.pruneClosedPositions();
  } finally {
    positionsPrunePollInFlight = false;
  }
}

function startPositionsPrunePolling() {
  if (positionsPrunePollTimer) return;

  positionsPrunePollTimer = setInterval(() => {
    pruneClosedPositions();
  }, POSITIONS_PRUNE_POLL_INTERVAL_MS);
}

function stopPositionsPrunePolling() {
  if (!positionsPrunePollTimer) return;

  clearInterval(positionsPrunePollTimer);
  positionsPrunePollTimer = null;
  positionsPrunePollInFlight = false;
}

async function refreshPositionsAfterOrderFill() {
  const retryDelaysMs = [0, 1_000, 2_000, 4_000, 6_000];

  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    const delayMs = retryDelaysMs[index];
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    await loadPositions();
  }
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

  setOrderStatus(side, 'Submitting order', 'info');

  try {
    await brokerAdapter.submitOrder(accountNumber, marketOrder);

    setOrderStatus(side, '', '');
    await refreshPositionsAfterOrderFill();
  } catch (err) {
    setOrderStatus(side, `Error: ${err.message}`, 'error');
  }
}

// Option Chain ---------------------------------------------------------------
async function loadChain(ticker) {
  if (!ticker) return;

  removeSharedQuoteSubscriptions(Array.from(optionQuoteSubscriptions));
  optionChainController?.resetForNewChain();
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
    const resp = await brokerAdapter.getOptionChain(ticker);
    const items = resp?.data?.items ?? [];
    const expirations = items.flatMap(item => item.expirations ?? []);

    if (expirations.length === 0) {
      setStatus(chainStatus, `No options found for ${ticker}.`, 'error');
      return;
    }

    const sortedUniqueExpirationDates = Array.from(new Set(
      expirations
        .map(exp => exp?.['expiration-date'])
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));

    const selectedExpirationDates = new Set(sortedUniqueExpirationDates.slice(0, 2));
    const filtered = expirations.filter(exp => selectedExpirationDates.has(exp?.['expiration-date']));

    setStatus(chainStatus, '', '');
    optionChainController?.renderChain(filtered);

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
    const response = await brokerAdapter.getEquityOptionsBySymbols(chunk);
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

  const pending = uniqueSymbols.filter(symbol => !optionQuoteSubscriptions.has(symbol));
  if (pending.length === 0) return;

  await addSharedQuoteSubscriptions(pending);

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

  const resp = await brokerAdapter.getEquityOptionsBySymbols([optionSymbol]);
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
  optionChainController?.scheduleAtmMarkerUpdate();
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
    clearMarketDataErrorStatus({ clearUi: true });
    return;
  }

  liveConnectionEl.textContent = 'DISCONNECTED';
  liveConnectionEl.classList.remove('live');
  liveConnectionEl.classList.add('disconnected');
}

function clearMarketDataConnection() {
  stopPositionsPrunePolling();
  marketDataClient?.clearConnection();
  clearMarketDataErrorStatus();
  optionChainController?.resetForDisconnect();
  pendingLivePriceValue = null;
  cancelPendingLivePriceRender();
  currentLiveQuotePrice = null;
  sharedQuoteSubscriptionRefCounts.clear();
  optionQuoteByStreamerSymbol.clear();
  optionQuoteSubscriptions.clear();
  optionQuoteCellsByStreamerSymbol.clear();
  positionsManager?.clearMarketDataState();
  setConnectionState(false);
}

async function ensureMarketDataReady() {
  if (!marketDataClient) return;
  await marketDataClient.ensureReady();
}

async function subscribeSymbolPrice(symbol) {
  if (IS_OAUTH_ADAPTER && !authManager?.hasAccessToken()) return;

  try {
    currentLiveQuotePrice = null;
    setLivePriceText(null, true);

    await marketDataClient?.subscribeUnderlyingSymbol(symbol);
  } catch (err) {
    setLivePriceText(null, false);
    setConnectionState(false);
    setMarketDataErrorStatus(`Market data error: ${err.message}`);
  }
}

// Order button listeners ---------------------------------------------------
btnSubmitCall.addEventListener('click', () => submitOrder(stagedCall, 'call'));
btnSubmitPut.addEventListener('click', () => submitOrder(stagedPut, 'put'));

// Utility -------------------------------------------------------------------
function setStatus(el, message, type) {
  const isError = type === 'error' && !!message;
  if (isError) {
    showToastMessage(message, 'error');

    if (el !== loadingError) {
      el.textContent = '';
      el.className = 'status';
      el.style.display = 'none';
      return;
    }
  }

  el.textContent = message;
  el.className = `status ${type}`;

  if (!message) {
    el.style.display = 'none';
  } else {
    el.style.display = 'block';
  }
}
