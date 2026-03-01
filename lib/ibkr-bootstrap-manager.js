// SPDX-License-Identifier: MIT
/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createIbkrBootstrapManager({
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
  getCurrentSymbol,
  connect,
  disconnect,
  onPostAuthenticatedUiShown,
}) {
  const AUTO_CONNECT_AFTER_RELOAD_KEY = 'quickstrike.autoConnectAfterReload';
  let initialized = false;

  function consumeAutoConnectAfterReload() {
    try {
      const shouldAutoConnect = sessionStorage.getItem(AUTO_CONNECT_AFTER_RELOAD_KEY) === '1';
      if (shouldAutoConnect) {
        sessionStorage.removeItem(AUTO_CONNECT_AFTER_RELOAD_KEY);
      }

      return shouldAutoConnect;
    } catch {
      return false;
    }
  }

  function setLoadingError(message) {
    if (!loadingError) return;
    if (!message) {
      loadingError.textContent = '';
      loadingError.classList.add('hidden');
      loadingError.className = 'status hidden';
      return;
    }

    setStatus(loadingError, message, 'error');
    loadingError.classList.remove('hidden');
  }

  function setRetryVisible(isVisible) {
    if (!btnLoadingRetry) return;
    btnLoadingRetry.classList.toggle('hidden', !isVisible);
  }

  function showLoading(message = 'Loading') {
    loadingMessage.textContent = message;
    loadingSection.classList.remove('hidden');
    configSection.classList.add('hidden');
    appHeader.classList.add('hidden');
    tradingSection.classList.add('hidden');
    setLoadingError('');
    setRetryVisible(false);
  }

  function hideLoading() {
    loadingSection.classList.add('hidden');
    setLoadingError('');
    setRetryVisible(false);
  }

  function showLoadingError(message) {
    loadingMessage.textContent = 'Unable to load';
    setLoadingError(message);
    setRetryVisible(true);
  }

  function showLoggedOutUi() {
    hideLoading();
    setAuthHealthyState(false);
    applyTradeButtonState();
    appHeader.classList.add('hidden');
    tradingSection.classList.add('hidden');
    configSection.classList.remove('hidden');
  }

  async function showAuthenticated() {
    envBadge.textContent = useSandbox ? 'PAPER' : 'LIVE';
    envBadge.className = useSandbox
      ? 'live-connection env badge-sandbox'
      : 'live-connection env badge-production';

    setAuthHealthyState(true);
    applyTradeButtonState();

    const symbol = getCurrentSymbol();
    setLivePriceText(null, true);
    await subscribeSymbolPrice(symbol);
    await loadChain(symbol);
    await loadPositions();

    hideLoading();
    configSection.classList.add('hidden');
    appHeader.classList.remove('hidden');
    tradingSection.classList.remove('hidden');
    onPostAuthenticatedUiShown?.();
  }

  async function connectAndLoad() {
    showLoading('Connecting to IBKR');

    try {
      await connect?.();
      await loadAccounts();
      await showAuthenticated();
    } catch (err) {
      clearMarketDataConnection();
      setAuthHealthyState(false);
      applyTradeButtonState();
      showLoggedOutUi();
      setStatus(authStatus, err?.message || 'Unable to connect to IBKR.', 'error');
    }
  }

  async function handleLogout() {
    await disconnect?.();

    appHeader.classList.add('hidden');
    tradingSection.classList.add('hidden');
    configSection.classList.remove('hidden');
    setStatus(authStatus, '', '');
    accountSelect.innerHTML = '';
    positionsManager?.handleLogout();

    clearMarketDataConnection();
    setLivePriceText(null, false);
    setAuthHealthyState(false);
    applyTradeButtonState();
  }

  function initialize() {
    if (initialized) return;
    initialized = true;

    btnConnect.addEventListener('click', connectAndLoad);
    btnLogout.addEventListener('click', handleLogout);
    btnLoadingRetry?.addEventListener('click', connectAndLoad);

    showLoggedOutUi();
    if (consumeAutoConnectAfterReload()) {
      setTimeout(() => {
        btnConnect.click();
      }, 0);
    }
  }

  return {
    initialize,
    showAuthenticated,
  };
}

window.createIbkrBootstrapManager = createIbkrBootstrapManager;
