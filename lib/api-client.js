// SPDX-License-Identifier: MIT
/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createApiClient({
  ensureValidToken,
  forceRefreshToken,
  hasRefreshToken,
  getAccessToken,
  getBaseUrl,
  authDebug,
}) {
  function buildApiError(payload, fallbackStatus = null) {
    const preflightErrors = payload?.error?.errors ?? payload?.errors;
    const message = Array.isArray(preflightErrors) && preflightErrors.length > 0
      ? preflightErrors.map(item => item?.message).filter(Boolean).join(', ')
      : payload?.error?.message ?? payload?.message ?? (fallbackStatus ? `HTTP ${fallbackStatus}` : 'API request failed');

    const apiError = new Error(message);
    apiError.status = fallbackStatus;
    apiError.code = payload?.error?.code ?? payload?.code ?? null;
    apiError.preflightCodes = Array.isArray(preflightErrors)
      ? preflightErrors.map(item => item?.code).filter(Boolean)
      : [];
    return apiError;
  }

  function hasEmbeddedApiError(payload) {
    if (!payload || typeof payload !== 'object') return false;

    const payloadData = payload?.data && typeof payload.data === 'object' ? payload.data : null;

    const hasErrorMessage = typeof payload?.error?.message === 'string' && payload.error.message.trim().length > 0;
    const hasErrorItems = Array.isArray(payload?.error?.errors) && payload.error.errors.length > 0;
    const hasTopLevelErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;
    const hasDataErrorMessage = typeof payloadData?.error?.message === 'string' && payloadData.error.message.trim().length > 0;
    const hasDataErrorItems = Array.isArray(payloadData?.error?.errors) && payloadData.error.errors.length > 0;
    const hasDataErrors = Array.isArray(payloadData?.errors) && payloadData.errors.length > 0;

    return hasErrorMessage
      || hasErrorItems
      || hasTopLevelErrors
      || hasDataErrorMessage
      || hasDataErrorItems
      || hasDataErrors;
  }

  async function requestWithAuth(path, init, retryOnUnauthorized = true) {
    await ensureValidToken();

    const requestInit = {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        'Authorization': `Bearer ${getAccessToken()}`,
      },
    };

    const response = await fetch(`${getBaseUrl()}${path}`, requestInit);
    authDebug('fetchWithAuth: API response received', {
      path,
      method: requestInit?.method ?? 'GET',
      status: response.status,
      retryOnUnauthorized,
    });

    if (response.status === 401 && retryOnUnauthorized && hasRefreshToken()) {
      authDebug('fetchWithAuth: got 401, forcing refresh and retry', {
        path,
        method: requestInit?.method ?? 'GET',
      });
      await forceRefreshToken();

      const retryInit = {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          'Authorization': `Bearer ${getAccessToken()}`,
        },
      };

      const retryResponse = await fetch(`${getBaseUrl()}${path}`, retryInit);
      authDebug('fetchWithAuth: retry response received', {
        path,
        method: retryInit?.method ?? 'GET',
        status: retryResponse.status,
      });
      return retryResponse;
    }

    return response;
  }

  async function get(path) {
    const resp = await requestWithAuth(path, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? `HTTP ${resp.status}`);
    }

    return resp.json();
  }

  async function post(path, body) {
    const resp = await requestWithAuth(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      console.log('API error response:', JSON.stringify(payload, null, 2));
      throw buildApiError(payload, resp.status);
    }

    if (hasEmbeddedApiError(payload)) {
      throw buildApiError(payload, resp.status);
    }

    return payload;
  }

  async function del(path) {
    const resp = await requestWithAuth(path, {
      method: 'DELETE',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));

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

    if (resp.status === 204) {
      return null;
    }

    return resp.json().catch(() => null);
  }

  return {
    get,
    post,
    del,
  };
}

window.createApiClient = createApiClient;
