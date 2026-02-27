// SPDX-License-Identifier: MIT
/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createOptionChainController({
  chainRows,
  chainSection,
  formatExpiry,
  createQuotePriceEl,
  selectSymbol,
  primeOptionQuoteCells,
  getOptionQuoteRenderCycle,
  getCurrentLiveQuotePrice,
  atmMarkerUpdateMinIntervalMs = 1_000,
  atmSwitchHysteresisDollars = 0.35,
} = {}) {
  let hasAutoScrolledToLiveStrike = false;
  let pendingAtmMarkerUpdateTimer = null;
  let lastAtmMarkerUpdateAt = 0;
  let atmMarkedRowsByBody = new WeakMap();

  function renderChain(expirations) {
    if (!chainRows || !chainSection) return;

    chainRows.innerHTML = '';

    const quoteBindings = [];
    const renderCycleAtStart = getOptionQuoteRenderCycle?.() ?? 0;

    expirations.sort((a, b) => a['expiration-date'].localeCompare(b['expiration-date']));

    expirations.forEach((exp, i) => {
      const dte = parseInt(exp['days-to-expiration'], 10);
      const dteLabel = dte === 0 ? '0 DTE' : dte === 1 ? '1 DTE' : `${dte} DTE`;
      const strikes = exp['strikes'] ?? [];

      const header = document.createElement('div');
      header.className = 'expiry-header';
      header.innerHTML = `
      <div class="expiry-header-left">
        <span class="expiry-chevron">▶</span>
        <span class="expiry-date">${formatExpiry(exp['expiration-date'])}</span>
      </div>
      <span class="expiry-dte">${dteLabel}</span>
    `;

      const body = document.createElement('div');
      body.className = 'expiry-body';

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

      strikes.forEach(strike => {
        const strikePrice = parseFloat(strike['strike-price']);
        const callSymbol = strike['call'];
        const putSymbol = strike['put'];

        const row = document.createElement('div');
        row.className = 'chain-row-item';
        row.dataset.strikePrice = String(strikePrice);

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

      header.addEventListener('click', () => {
        const isOpen = body.classList.toggle('open');
        header.querySelector('.expiry-chevron').textContent = isOpen ? '▼' : '▶';
        scheduleAtmMarkerUpdate();
      });

      if (i === 0) {
        body.classList.add('open');
        header.querySelector('.expiry-chevron').textContent = '▼';
      }

      chainRows.appendChild(header);
      chainRows.appendChild(body);
    });

    chainSection.classList.remove('hidden');

    primeOptionQuoteCells?.(quoteBindings, renderCycleAtStart);

    requestAnimationFrame(() => {
      maybeAutoScrollChainToLivePrice();
      scheduleAtmMarkerUpdate();
    });
  }

  function clearPendingAtmMarkerUpdate() {
    if (!pendingAtmMarkerUpdateTimer) return;

    clearTimeout(pendingAtmMarkerUpdateTimer);
    pendingAtmMarkerUpdateTimer = null;
  }

  function runAtmMarkerUpdateNow() {
    updateAtmMarkers();
    lastAtmMarkerUpdateAt = Date.now();
  }

  function scheduleAtmMarkerUpdate() {
    const elapsedMs = Date.now() - lastAtmMarkerUpdateAt;
    if (elapsedMs >= atmMarkerUpdateMinIntervalMs) {
      clearPendingAtmMarkerUpdate();
      runAtmMarkerUpdateNow();
      return;
    }

    if (pendingAtmMarkerUpdateTimer) return;

    pendingAtmMarkerUpdateTimer = setTimeout(() => {
      pendingAtmMarkerUpdateTimer = null;
      runAtmMarkerUpdateNow();
    }, atmMarkerUpdateMinIntervalMs - elapsedMs);
  }

  function getNearestStrikeRow(container, referencePrice) {
    if (!container || !Number.isFinite(referencePrice)) return null;

    const rows = Array.from(container.querySelectorAll('.chain-row-item[data-strike-price]'));
    if (rows.length === 0) return null;

    let nearestRow = null;
    let nearestDiff = Number.POSITIVE_INFINITY;

    rows.forEach(row => {
      if (row.style.display === 'none') return;

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
    const currentLiveQuotePrice = getCurrentLiveQuotePrice?.();

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
        if (previousDiff < atmSwitchHysteresisDollars) {
          nearestRow = previousRow;
        }
      }

      if (!nearestRow) {
        body.querySelectorAll('.chain-row-item.atm-row').forEach(row => {
          row.classList.remove('atm-row');
          row.querySelectorAll('.atm-marker-label').forEach(label => label.remove());
        });

        if (previousRow) {
          previousRow.classList.remove('atm-row');
          previousRow.querySelectorAll('.atm-marker-label').forEach(label => label.remove());
        }
        return;
      }

      body.querySelectorAll('.chain-row-item.atm-row').forEach(row => {
        if (row === nearestRow) return;
        row.classList.remove('atm-row');
        row.querySelectorAll('.atm-marker-label').forEach(label => label.remove());
      });

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
    if (!chainRows) return false;

    const openBody = chainRows.querySelector('.expiry-body.open');
    if (!openBody) return false;
    if (chainRows.clientHeight <= 0) return false;

    const currentLiveQuotePrice = getCurrentLiveQuotePrice?.();

    if (!Number.isFinite(currentLiveQuotePrice)) {
      chainRows.scrollTop = (chainRows.scrollHeight - chainRows.clientHeight) / 2;
      return false;
    }

    const rows = Array.from(openBody.querySelectorAll('.chain-row-item[data-strike-price]'));
    if (rows.length === 0) return false;

    let nearestRow = null;
    let nearestDiff = Number.POSITIVE_INFINITY;

    rows.forEach(row => {
      if (row.style.display === 'none') return;

      const strikePrice = Number.parseFloat(row.dataset.strikePrice);
      if (!Number.isFinite(strikePrice)) return;

      const diff = Math.abs(strikePrice - currentLiveQuotePrice + 1);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestRow = row;
      }
    });

    if (!nearestRow) return false;

    const containerRect = chainRows.getBoundingClientRect();
    const rowRect = nearestRow.getBoundingClientRect();
    const rowMid = rowRect.top + (rowRect.height / 2);
    const containerMid = containerRect.top + (chainRows.clientHeight / 2);
    const delta = rowMid - containerMid;

    chainRows.scrollTop = Math.max(0, chainRows.scrollTop + delta);
    return true;
  }

  function maybeAutoScrollChainToLivePrice() {
    if (hasAutoScrolledToLiveStrike) return;
    if (chainSection?.classList.contains('hidden')) return;

    const didScrollToLiveStrike = scrollOpenChainBodyToNearestStrike();
    if (didScrollToLiveStrike) {
      hasAutoScrolledToLiveStrike = true;
    }
  }

  function resetForNewChain() {
    hasAutoScrolledToLiveStrike = false;
  }

  function resetForDisconnect() {
    clearPendingAtmMarkerUpdate();
    lastAtmMarkerUpdateAt = 0;
    hasAutoScrolledToLiveStrike = false;
    atmMarkedRowsByBody = new WeakMap();
  }

  return {
    renderChain,
    scheduleAtmMarkerUpdate,
    maybeAutoScrollChainToLivePrice,
    resetForNewChain,
    resetForDisconnect,
  };
}

window.createOptionChainController = createOptionChainController;
