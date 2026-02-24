/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createAuthManager({
  getConfig,
  setAuthHealthyState,
  onSessionExpired,
  authDebugEnabled = true,
}) {
  const REFRESH_TOKEN_BACKUP_KEY = 'token_refresh_backup';

  let tokenResponse = null;
  let authRefreshInFlight = null;
  let authRefreshTimer = null;

  function authDebug(message, details = null) {
    if (!authDebugEnabled) return;

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

  async function refreshAccessToken(clientId, clientSecret) {
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
          client_id: clientId,
          client_secret: clientSecret,
        }),
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

  async function ensureValidToken({ forceRefresh = false, clientId, clientSecret } = {}) {
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
      await refreshAccessToken(clientId, clientSecret);
      setAuthHealthyState(true);
    } catch (err) {
      setAuthHealthyState(false);

      const isExpiredSession = ['invalid_grant', 'invalid_token'].includes(err.oauthError);
      if (isExpiredSession) {
        onSessionExpired?.();
        throw new Error('Session expired, please log in again');
      }

      throw new Error(`Token refresh failed: ${err.message}`);
    }
  }

  function restoreFromStorage() {
    try {
      tokenResponse = JSON.parse(localStorage.getItem('token_response'));
    } catch {
      tokenResponse = null;
      localStorage.removeItem('token_response');
    }

    if (!tokenResponse) return false;

    restoreRefreshTokenIfMissing('startup');
    tokenResponse = normalizeTokenResponse(tokenResponse);
    authDebug('startup: writing normalized token_response', {
      hasAccessToken: !!tokenResponse?.access_token,
      hasRefreshToken: !!tokenResponse?.refresh_token,
      expiresAt: tokenResponse?.expires_at ?? null,
    });
    localStorage.setItem('token_response', JSON.stringify(tokenResponse));
    setRefreshTokenBackup(tokenResponse.refresh_token);
    return true;
  }

  function stopMonitoring() {
    if (authRefreshTimer) {
      clearInterval(authRefreshTimer);
      authRefreshTimer = null;
    }
  }

  function startMonitoring({ clientId, clientSecret }) {
    stopMonitoring();

    authRefreshTimer = setInterval(async () => {
      if (!tokenResponse) return;
      try {
        await ensureValidToken({ clientId, clientSecret });
      } catch {
        // Auth health state is already updated in ensureValidToken
      }
    }, 30_000);
  }

  function clearAuthState() {
    tokenResponse = null;
    stopMonitoring();
    setAuthHealthyState(false);

    ['pkce_verifier', 'pkce_state', 'token_response'].forEach(key => {
      localStorage.removeItem(key);
    });
    localStorage.removeItem(REFRESH_TOKEN_BACKUP_KEY);
  }

  function hasAccessToken() {
    return !!tokenResponse?.access_token;
  }

  function hasRefreshToken() {
    return !!tokenResponse?.refresh_token;
  }

  function getAccessToken() {
    return tokenResponse?.access_token;
  }

  return {
    authDebug,
    persistTokenResponse,
    restoreFromStorage,
    ensureValidToken,
    startMonitoring,
    stopMonitoring,
    clearAuthState,
    hasAccessToken,
    hasRefreshToken,
    getAccessToken,
  };
}

window.createAuthManager = createAuthManager;
