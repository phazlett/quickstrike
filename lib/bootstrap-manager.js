/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createBootstrapManager({
  getConfig,
  clientId,
  clientSecret,
  redirectUri,
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
  getCurrentSymbol,
  onPostAuthenticatedUiShown,
}) {
  let initialized = false;

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
    appHeader.classList.add('hidden');
    tradingSection.classList.add('hidden');
    configSection.classList.remove('hidden');
  }

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

  async function redirectToOAuthLogin() {
    showLoading('Redirecting to login');

    const codeVerifier = generateRandomString(64);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateRandomString(16);

    localStorage.setItem('pkce_verifier', codeVerifier);
    localStorage.setItem('pkce_state', state);

    const { authorizeUrl } = getConfig();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'read trade openid',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    window.location.href = `${authorizeUrl}?${params.toString()}`;
  }

  async function handleOAuthCallback(code, returnedState) {
    const codeVerifier = localStorage.getItem('pkce_verifier');
    const expectedState = localStorage.getItem('pkce_state');

    ['pkce_verifier', 'pkce_state', 'token_response'].forEach(key => {
      localStorage.removeItem(key);
    });

    window.history.replaceState({}, document.title, window.location.pathname);

    if (returnedState !== expectedState) {
      throw new Error('Auth failed: state mismatch (possible CSRF attack)');
    }

    const { tokenEndpoint } = getConfig();
    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error_description || data.error || 'Token exchange failed');
    }

    authManager.persistTokenResponse(data, null);
    await loadAccounts();
    await showAuthenticated();
  }

  async function showAuthenticated() {
    envBadge.textContent = useSandbox ? 'Sandbox' : 'Production';
    envBadge.className = useSandbox ? 'badge-sandbox' : 'badge-production';

    authManager.startMonitoring({ clientId, clientSecret });
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

  function handleLogout() {
    authManager.clearAuthState();

    appHeader.classList.add('hidden');
    tradingSection.classList.add('hidden');
    configSection.classList.remove('hidden');
    setStatus(authStatus, '', '');
    accountSelect.innerHTML = '';
    positionsManager?.handleLogout();

    clearMarketDataConnection();
    setLivePriceText(null, false);
  }

  async function handleStartupLoad() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const hasStoredToken = !!localStorage.getItem('token_response');

    if (!code && !hasStoredToken) {
      showLoggedOutUi();
      return;
    }

    showLoading(code ? 'Signing in' : 'Loading streamers');

    if (code) {
      await handleOAuthCallback(code, state);
      return;
    }

    if (!authManager.restoreFromStorage()) {
      showLoggedOutUi();
      return;
    }

    await authManager.ensureValidToken({ clientId, clientSecret });
    await loadAccounts();
    await showAuthenticated();
  }

  async function runStartupLoad() {
    try {
      await handleStartupLoad();
    } catch (err) {
      authManager.clearAuthState();
      showLoading('Loading failed');
      showLoadingError(err?.message || 'Unexpected startup error');
    }
  }

  function initialize() {
    if (initialized) return;
    initialized = true;

    btnConnect.addEventListener('click', redirectToOAuthLogin);
    btnLogout.addEventListener('click', handleLogout);
    btnLoadingRetry?.addEventListener('click', () => {
      runStartupLoad();
    });

    runStartupLoad();
  }

  return {
    initialize,
    showAuthenticated,
  };
}

window.createBootstrapManager = createBootstrapManager;
