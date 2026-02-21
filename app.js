let tokenResponse = null;
let stagedCall = null;
let stagedPut = null;

const getConfig = () => CONFIG[useSandbox ? 'sandbox' : 'production'];

// ── DOM refs ─────────────────────────────────────────────────────────────────
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
const expiryTabs = document.getElementById('expiry-tabs');
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

// ── On page load: check if returning from OAuth redirect ──────────────────────

window.addEventListener('load', async () => {

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');

  if (code) {
    await handleOAuthCallback(code, state);
  }
});

// ── On page refresh: check if returning from OAuth redirect ──────────────────────

window.addEventListener('load', async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');

  if (code) {
    await handleOAuthCallback(code, state);
    return;
  }

  tokenResponse = JSON.parse(localStorage.getItem('token_response'));
  if (!tokenResponse) {
    return;
  }

  await loadAccounts();
  await showAuthenticated();
});

// ── PKCE Helpers ──────────────────────────────────────────────────────────────
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

// ── Step 1: Redirect to TastyTrade login ──────────────────────────────────────
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

// ── Step 2: Exchange authorization code for access token ──────────────────────
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

    tokenResponse = data;

    localStorage.setItem('token_response', JSON.stringify(tokenResponse));

    await loadAccounts();
    showAuthenticated();

  } catch (err) {
    setStatus(authStatus, `Error: ${err.message}`, 'error');
  }
}

async function refreshAccessToken() {
  const { tokenEndpoint } = getConfig();

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenResponse.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    })
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data.error_description || data.error || 'Token refresh failed');
  }

  // Update all three values — server may rotate the refresh token
  tokenResponse = data;
}

// Proactively refresh if within 60 seconds of expiry
async function ensureValidToken() {
  if (!tokenResponse?.refresh_token) throw new Error('Not authenticated');
  const tokenExpiry = Date.now() + (tokenResponse.expires_in * 1000);
  if (tokenExpiry && Date.now() < tokenExpiry - 60_000) return;

  try {
    await refreshAccessToken();
  } catch (err) {
    // Refresh token itself has expired — force re-login
    btnLogout.click();
    throw new Error('Session expired, please log in again');
  }
}

async function showAuthenticated() {
  configSection.classList.add('hidden');
  appHeader.classList.remove('hidden');
  tradingSection.classList.remove('hidden');

  envBadge.textContent = useSandbox ? 'Sandbox' : 'Live';
  envBadge.className = useSandbox ? 'badge-sandbox' : 'badge-production';

  await loadChain(currentSymbol);
}

btnLogout.addEventListener('click', () => {
  // Clear auth state
  tokenResponse = null;

  // Clear any leftover PKCE values
  ['pkce_verifier', 'pkce_state', 'token_response'].forEach(key => {
    localStorage.removeItem(key);
  });

  // Restore UI
  appHeader.classList.add('hidden');
  tradingSection.classList.add('hidden');
  configSection.classList.remove('hidden');
  setStatus(authStatus, '', '');
  accountSelect.innerHTML = '';
  orderResponse.textContent = '';
});

// ── Load accounts ─────────────────────────────────────────────────────────────
async function loadAccounts() {
  const resp = await apiGet('/customers/me/accounts');
  const accounts = resp?.data?.items ?? [];

  accountSelect.innerHTML = '';
  accounts.forEach(item => {
    const acct = item['account'];
    const opt = document.createElement('option');
    opt.value = acct['account-number'];
    opt.textContent = `${acct['account-number']} — ${acct['nickname'] ?? acct['account-type-name']}`;
    accountSelect.appendChild(opt);
  });
}

// ── Submit order ──────────────────────────────────────────────────────────────
async function submitOrder(staged, side, dryRun = false) {
  const quantity = parseInt(document.getElementById('quantity').value);
  const accountNumber = accountSelect.value;
  const statusEl = side === 'call' ? callOrderStatus : putOrderStatus;
  const responseEl = side === 'call' ? callOrderResponse : putOrderResponse;

  if (!staged || isNaN(quantity)) {
    setStatus(statusEl, 'Missing symbol or quantity.', 'error');
    return;
  }

  responseEl.textContent = '';
  responseEl.classList.add('hidden');

  const order = {
    'order-type': 'Market',
    'time-in-force': 'Day',
    'price-effect': staged.action.startsWith('Buy') ? 'Debit' : 'Credit',
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

  setStatus(statusEl, dryRun ? 'Running dry run...' : 'Submitting order...', 'info');

  try {
    const result = await apiPost(endpoint, order);
    setStatus(statusEl, dryRun ? '✓ Dry run complete' : '✓ Order submitted', 'success');
    responseEl.textContent = JSON.stringify(result, null, 2);
    responseEl.classList.remove('hidden');
  } catch (err) {
    setStatus(statusEl, `Error: ${err.message}`, 'error');
  }
}

// ── Option Chain ──────────────────────────────────────────────────────────────
// ── Add this function (replaces the btnLoadChain click handler body) ──────────
async function loadChain(ticker) {
  if (!ticker) return;

  // Clear staged orders
  stagedCall = null;
  stagedPut = null;

  callActionEl.textContent = null;
  putActionEl.textContent = null;

  callSymbolEl.textContent = 'No call selected';
  callSymbolEl.classList.add('empty');
  btnDryRunCall.disabled = true;
  btnDryRunCall.className = 'btn-disabled';
  btnSubmitCall.disabled = true;
  btnSubmitCall.className = 'btn-disabled';
  setStatus(callOrderStatus, '', '');
  callOrderResponse.textContent = '';
  callOrderResponse.classList.add('hidden');

  putSymbolEl.textContent = 'No put selected';
  putSymbolEl.classList.add('empty');
  btnDryRunPut.disabled = true;
  btnDryRunPut.className = 'btn-disabled';
  btnSubmitPut.disabled = true;
  btnSubmitPut.className = 'btn-disabled';
  setStatus(putOrderStatus, '', '');
  putOrderResponse.textContent = '';
  putOrderResponse.classList.add('hidden');

  // Also clear any highlighted selections in the chain
  document.querySelectorAll('.direction-btn.call-selected, .direction-btn.put-selected')
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

// ── Auto-load triggers ────────────────────────────────────────────────────────
let chainLoading = false;

let currentSymbol = 'SPY';

document.querySelectorAll('.symbol-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.symbol === currentSymbol) return; // already active

    document.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSymbol = btn.dataset.symbol;
    loadChain(currentSymbol);
  });
});

function formatExpiry(dateStr) {
  // dateStr is "2026-02-20" — parse as local time
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderChain(expirations) {
  chainRows.innerHTML = '';
  expiryTabs.innerHTML = '';
  expiryTabs.classList.add('hidden');

  // Sort by expiration date
  expirations.sort((a, b) => a['expiration-date'].localeCompare(b['expiration-date']));

  expirations.forEach((exp, i) => {
    const dte = parseInt(exp['days-to-expiration'], 10);
    const dteLabel = dte === 0 ? '0 DTE' : dte === 1 ? '1 DTE' : `${dte} DTE`;
    const strikes = exp['strikes'] ?? [];

    // ── Collapsible header ──
    const header = document.createElement('div');
    header.className = 'expiry-header';
    header.innerHTML = `
      <div class="expiry-header-left">
        <span class="expiry-chevron">▶</span>
        <span class="expiry-date">${formatExpiry(exp['expiration-date'])}</span>
      </div>
      <span class="expiry-dte">${dteLabel}</span>
    `;

    // ── Collapsible body ──
    const body = document.createElement('div');
    body.className = 'expiry-body';

    // Column headers
    const colHeader = document.createElement('div');
    colHeader.className = 'chain-header';
    colHeader.innerHTML = `<span>Call</span><span>Strike</span><span>Put</span>`;
    body.appendChild(colHeader);

    // Strike rows — data is already paired, no need to build a map
    strikes.forEach(strike => {
      const strikePrice = parseFloat(strike['strike-price']);
      const callSymbol = strike['call'];
      const putSymbol = strike['put'];

      const row = document.createElement('div');
      row.className = 'chain-row-item';

      // Call side — Long / Short
      const callCell = document.createElement('div');
      callCell.className = 'option-cell';
      if (callSymbol) {
        const longBtn = document.createElement('span');
        longBtn.className = 'direction-btn long';
        longBtn.textContent = 'Long';
        longBtn.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'long', strikePrice, longBtn));

        const shortBtn = document.createElement('span');
        shortBtn.className = 'direction-btn short';
        shortBtn.textContent = 'Short';
        shortBtn.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'short', strikePrice, shortBtn));

        callCell.appendChild(longBtn);
        callCell.appendChild(shortBtn);
      }

      const strikeEl = document.createElement('span');
      strikeEl.className = 'strike-cell';
      strikeEl.textContent = strikePrice.toFixed(0);

      // Put side — Long / Short
      const putCell = document.createElement('div');
      putCell.className = 'option-cell put-option-cell';
      if (putSymbol) {
        const longBtn = document.createElement('span');
        longBtn.className = 'direction-btn long';
        longBtn.textContent = 'Long';
        longBtn.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'long', strikePrice, longBtn));

        const shortBtn = document.createElement('span');
        shortBtn.className = 'direction-btn short';
        shortBtn.textContent = 'Short';
        shortBtn.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'short', strikePrice, shortBtn));

        putCell.appendChild(longBtn);
        putCell.appendChild(shortBtn);
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
    });

    // First group open by default
    if (i === 0) {
      body.classList.add('open');
      header.querySelector('.expiry-chevron').textContent = '▼';
    }

    chainRows.appendChild(header);
    chainRows.appendChild(body);
  });

  // Scroll the first open expiry body to 50%
  const firstBody = chainRows.querySelector('.expiry-body.open');
  if (firstBody) {
    requestAnimationFrame(() => {
      firstBody.scrollTop = (firstBody.scrollHeight - firstBody.clientHeight) / 2;
    });
  }

  chainSection.classList.remove('hidden');
}

// Remove parseSymbol and filterByDTE — no longer needed

function renderStrikes(expiryData, container) {
  const { calls, puts } = expiryData;

  const strikeMap = {};
  calls.forEach(c => {
    if (!strikeMap[c.strike]) strikeMap[c.strike] = {};
    strikeMap[c.strike].call = c;
  });
  puts.forEach(p => {
    if (!strikeMap[p.strike]) strikeMap[p.strike] = {};
    strikeMap[p.strike].put = p;
  });

  const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);

  strikes.forEach(strike => {
    const strikePrice = parseFloat(strike['strike-price']);
    const callSymbol = strike['call'];
    const putSymbol = strike['put'];

    const row = document.createElement('div');
    row.className = 'chain-row-item';

    // Call side — Long / Short
    const callCell = document.createElement('div');
    callCell.className = 'option-cell';
    if (callSymbol) {
      const longBtn = document.createElement('span');
      longBtn.className = 'direction-btn long';
      longBtn.textContent = 'Long';
      longBtn.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'long', strikePrice, longBtn));

      const shortBtn = document.createElement('span');
      shortBtn.className = 'direction-btn short';
      shortBtn.textContent = 'Short';
      shortBtn.addEventListener('click', () => selectSymbol(callSymbol, 'call', 'short', strikePrice, shortBtn));

      callCell.appendChild(longBtn);
      callCell.appendChild(shortBtn);
    }

    const strikeEl = document.createElement('span');
    strikeEl.className = 'strike-cell';
    strikeEl.textContent = strikePrice.toFixed(0);

    // Put side — Long / Short
    const putCell = document.createElement('div');
    putCell.className = 'option-cell put-option-cell';
    if (putSymbol) {
      const longBtn = document.createElement('span');
      longBtn.className = 'direction-btn long';
      longBtn.textContent = 'Long';
      longBtn.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'long', strikePrice, longBtn));

      const shortBtn = document.createElement('span');
      shortBtn.className = 'direction-btn short';
      shortBtn.textContent = 'Short';
      shortBtn.addEventListener('click', () => selectSymbol(putSymbol, 'put', 'short', strikePrice, shortBtn));

      putCell.appendChild(longBtn);
      putCell.appendChild(shortBtn);
    }

    row.appendChild(callCell);
    row.appendChild(strikeEl);
    row.appendChild(putCell);
    body.appendChild(row);
  });
}

function selectSymbol(symbol, side, direction, strikePrice, el) {
  const quantity = parseInt(document.getElementById('quantity').value);
  const units = quantity === 1 ? '' : 's';
  const action = direction === 'long' ? 'Buy to Open' : 'Sell to Open';
  const sideLabel = side === 'call' ? 'call' : 'put';
  const actionLabel = `${action} ${currentSymbol} ${quantity} ${sideLabel}${units}`;
  const label = `${direction === 'long' ? 'Long' : 'Short'} ${sideLabel} — $${strikePrice.toFixed(0)}`;

  // Clear previous highlights for this side
  const sideClass = side === 'call' ? '.call-selected' : '.put-selected';
  document.querySelectorAll(sideClass).forEach(e => e.classList.remove('call-selected', 'put-selected'));
  el.classList.add(side === 'call' ? 'call-selected' : 'put-selected');

  if (side === 'call') {
    stagedCall = { symbol, action, label, strikePrice };
    callSymbolEl.textContent = label;
    callSymbolEl.classList.remove('empty');
    callActionEl.textContent = actionLabel;
    btnSubmitCall.className = direction === 'long' ? 'btn-long' : 'btn-short';
    btnDryRunCall.disabled = false;
    btnDryRunCall.className = 'btn-dry-run-call';
    btnSubmitCall.disabled = false;
    setStatus(callOrderStatus, '', '');
    callOrderResponse.textContent = '';
    callOrderResponse.classList.add('hidden');
  } else {
    stagedPut = { symbol, action, label, strikePrice };
    putSymbolEl.textContent = label;
    putSymbolEl.classList.remove('empty');
    putActionEl.textContent = actionLabel;
    btnSubmitPut.className = direction === 'long' ? 'btn-long' : 'btn-short';
    btnDryRunPut.disabled = false;
    btnDryRunPut.className = 'btn-dry-run-put';
    btnSubmitPut.disabled = false;
    setStatus(putOrderStatus, '', '');
    putOrderResponse.textContent = '';
    putOrderResponse.classList.add('hidden');
  }
}

// ── Order quantity listeners ──────────────────────────────────────────────────
document.getElementById('quantity').addEventListener('change', () => {
  if (stagedCall) {
    const el = document.querySelector('.direction-btn.call-selected');
    if (el) {
      const direction = el.textContent.toLowerCase() === 'long' ? 'long' : 'short';
      selectSymbol(stagedCall.symbol, 'call', direction, stagedCall.strikePrice, el);
    }
  }
  if (stagedPut) {
    const el = document.querySelector('.direction-btn.put-selected');
    if (el) {
      const direction = el.textContent.toLowerCase() === 'long' ? 'long' : 'short';
      selectSymbol(stagedPut.symbol, 'put', direction, stagedPut.strikePrice, el);
    }
  }
});

// ── Order button listeners ────────────────────────────────────────────────────
btnDryRunCall.addEventListener('click', () => submitOrder(stagedCall, 'call', true));
btnSubmitCall.addEventListener('click', () => submitOrder(stagedCall, 'call', false));
btnDryRunPut.addEventListener('click', () => submitOrder(stagedPut, 'put', true));
btnSubmitPut.addEventListener('click', () => submitOrder(stagedPut, 'put', false));

// ── API Helpers ───────────────────────────────────────────────────────────────
async function apiGet(path) {
  await ensureValidToken();
  const resp = await fetch(`${getConfig().baseUrl}${path}`, {
    headers: {
      'Authorization': `Bearer ${tokenResponse.access_token}`,
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
  await ensureValidToken();
  const resp = await fetch(`${getConfig().baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokenResponse.access_token}`,
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

    throw new Error(message);
  }

  return resp.json();
}

// ── Utility ───────────────────────────────────────────────────────────────────
function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `status ${type}`;
}