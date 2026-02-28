// SPDX-License-Identifier: MIT
/*
  Runtime file: do not modify for normal setup.
  Configure the application via root config.js.
*/

function createPositionsManager({
  positionsSection,
  positionsStatus,
  positionsRows,
  accountSelect,
  getCurrentSymbol,
  listPositions,
  listLiveOrders,
  cancelOrder,
  submitOrder,
  ensureMarketDataReady,
  addQuoteSubscriptions,
  removeQuoteSubscriptions,
  showToast,
  setStatus,
}) {
  const quoteByStreamerSymbol = new Map();
  const quoteSubscriptions = new Set();
  const plRowsByStreamerSymbol = new Map();

  function clearStatusMessage() {
    if (!positionsStatus) return;
    setStatus(positionsStatus, '', '');
  }

  function setErrorMessage(message) {
    if (typeof showToast === 'function') {
      showToast(message, 'error');
      return;
    }

    if (!positionsStatus) return;
    setStatus(positionsStatus, message, 'error');
  }

  function setSectionVisible(isVisible) {
    if (!positionsSection) return;
    positionsSection.classList.remove('hidden');
  }

  function renderEmptyPositionsRow() {
    if (!positionsRows) return;

    const hasEmptyRow = positionsRows.querySelector('.positions-empty-row');
    if (hasEmptyRow) return;

    const row = document.createElement('tr');
    row.className = 'positions-empty-row';

    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'positions-empty-cell';
    cell.textContent = 'No open positions';

    row.appendChild(cell);
    positionsRows.appendChild(row);
  }

  function parseDecimal(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function normalizePositiveQuotePrice(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  function resolvePositionMultiplier(position) {
    const explicitMultiplier = parseDecimal(
      position?.multiplier
      ?? position?.['multiplier']
      ?? position?.['contract-multiplier']
      ?? position?.['price-effect-multiplier']
    );
    if (explicitMultiplier !== null && explicitMultiplier > 0) return explicitMultiplier;

    const instrumentType = `${position?.instrumentType ?? position?.['instrument-type'] ?? ''}`.toLowerCase();
    if (instrumentType.includes('option')) return 100;

    return 1;
  }

  function parseOptionSymbolDetails(optionSymbol) {
    if (typeof optionSymbol !== 'string') {
      return { formattedDate: '--', optionCode: '--', strikePrice: '--' };
    }

    const compactSymbol = optionSymbol.replace(/\s+/g, '');
    const match = compactSymbol.match(/(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
    if (!match) {
      return { formattedDate: '--', optionCode: '--', strikePrice: '--' };
    }

    const year = 2000 + Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    const optionCode = match[4].toUpperCase();
    const strikeNumeric = Number.parseInt(match[5], 10) / 1000;

    const expiryDate = new Date(year, month - 1, day);
    const isValidDate = Number.isFinite(expiryDate.getTime())
      && expiryDate.getFullYear() === year
      && expiryDate.getMonth() === month - 1
      && expiryDate.getDate() === day;
    const formattedDate = isValidDate
      ? expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '--';

    if (!Number.isFinite(strikeNumeric)) {
      return { formattedDate, optionCode, strikePrice: '--' };
    }

    const strikePrice = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    }).format(strikeNumeric);

    return { formattedDate, optionCode, strikePrice };
  }

  function formatCurrencySigned(value) {
    if (!Number.isFinite(value)) return '--';

    const sign = value > 0 ? '+' : '';
    return `${sign}${new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`;
  }

  function setPositionPlCellState(plEl, value) {
    if (!plEl) return;

    plEl.classList.remove('positions-pl-positive', 'positions-pl-negative', 'positions-pl-neutral');

    if (!Number.isFinite(value)) {
      plEl.classList.add('positions-pl-neutral');
      return;
    }

    if (value > 0) {
      plEl.classList.add('positions-pl-positive');
      return;
    }

    if (value < 0) {
      plEl.classList.add('positions-pl-negative');
      return;
    }

    plEl.classList.add('positions-pl-neutral');
  }

  function resolvePositionEntryPrice(position) {
    return parseDecimal(
      position?.averageOpenPrice
      ?? position?.['average-open-price']
      ?? position?.['average_open_price']
      ?? position?.['average-price']
      ?? position?.averagePrice
    );
  }

  function computeUnrealizedPositionPl(position, quote) {
    const quantityDirection = `${position?.quantityDirection ?? ''}`.toLowerCase();
    const direction = quantityDirection === 'long'
      ? 1
      : quantityDirection === 'short'
        ? -1
        : null;
    if (direction === null) return null;

    const quantity = parseDecimal(position?.quantity);
    const contractCount = quantity === null ? null : Math.abs(quantity);
    const multiplier = resolvePositionMultiplier(position);
    const entryPrice = resolvePositionEntryPrice(position);
    if (contractCount === null || contractCount <= 0) return null;
    if (entryPrice === null || !Number.isFinite(entryPrice)) return null;

    const bidPrice = parseDecimal(quote?.bidPrice);
    const askPrice = parseDecimal(quote?.askPrice);
    const hasBid = bidPrice !== null && bidPrice > 0;
    const hasAsk = askPrice !== null && askPrice > 0;
    const quoteMid = hasBid || hasAsk
      ? ((bidPrice ?? askPrice) + (askPrice ?? bidPrice)) / 2
      : null;
    const lastPrice = parseDecimal(
      quote?.lastPrice
      ?? position?.lastPrice
      ?? position?.closePrice
    );

    const mark = direction > 0
      ? (hasBid ? bidPrice : (quoteMid ?? lastPrice))
      : (hasAsk ? askPrice : (quoteMid ?? lastPrice));
    if (mark === null || !Number.isFinite(mark)) return null;

    return (mark - entryPrice) * contractCount * multiplier * direction;
  }

  function updatePositionPlForStreamer(streamerSymbol) {
    const rows = plRowsByStreamerSymbol.get(streamerSymbol);
    if (!rows || rows.length === 0) return;

    const quote = quoteByStreamerSymbol.get(streamerSymbol);
    rows.forEach(rowRef => {
      const unrealizedPl = computeUnrealizedPositionPl(rowRef.position, quote);
      rowRef.plEl.textContent = formatCurrencySigned(unrealizedPl);
      setPositionPlCellState(rowRef.plEl, unrealizedPl);
    });
  }

  function resetPositionQuoteState() {
    plRowsByStreamerSymbol.clear();
    quoteByStreamerSymbol.clear();
  }

  function getPositionDomKey(item) {
    const symbol = `${item?.symbol ?? ''}`.trim().toUpperCase();
    const quantityDirection = `${item?.['quantity-direction'] ?? ''}`.trim().toUpperCase();
    if (!symbol || !quantityDirection) return '';
    return `${symbol}::${quantityDirection}`;
  }

  function isMatchingOpenPosition(targetPosition, candidatePosition) {
    const targetKey = getPositionDomKey(targetPosition);
    if (!targetKey) return false;
    return getPositionDomKey(candidatePosition) === targetKey;
  }

  function filterOpenPositionsForCurrentSymbol(items) {
    const symbolKey = (getCurrentSymbol() ?? '').toUpperCase();

    return (items ?? []).filter(item => {
      const underlyingSymbol = (item?.['underlying-symbol'] ?? '').toUpperCase();
      const quantity = parseDecimal(item?.quantity);

      if (underlyingSymbol !== symbolKey) return false;
      if (quantity === null || Math.abs(quantity) <= 0) return false;

      return true;
    });
  }

  async function fetchFilteredOpenPositions(accountNumber) {
    const response = await listPositions(accountNumber);
    const items = response?.data?.items ?? [];
    return filterOpenPositionsForCurrentSymbol(items);
  }

  function pruneDisconnectedPlRows() {
    plRowsByStreamerSymbol.forEach((rows, streamerSymbol) => {
      const connectedRows = rows.filter(rowRef => rowRef?.plEl?.isConnected);
      if (connectedRows.length === 0) {
        plRowsByStreamerSymbol.delete(streamerSymbol);
        return;
      }

      plRowsByStreamerSymbol.set(streamerSymbol, connectedRows);
    });
  }

  async function syncQuoteSubscriptions() {
    const desiredSymbols = new Set(plRowsByStreamerSymbol.keys());
    const symbolsToRemove = Array.from(quoteSubscriptions).filter(symbol => !desiredSymbols.has(symbol));
    const symbolsToAdd = Array.from(desiredSymbols).filter(symbol => !quoteSubscriptions.has(symbol));

    if (symbolsToRemove.length === 0 && symbolsToAdd.length === 0) return;

    try {
      await ensureMarketDataReady();

      if (symbolsToRemove.length > 0) {
        removeQuoteSubscriptions?.(symbolsToRemove);

        symbolsToRemove.forEach(symbol => {
          quoteSubscriptions.delete(symbol);
          quoteByStreamerSymbol.delete(symbol);
        });
      }

      if (symbolsToAdd.length > 0) {
        await addQuoteSubscriptions?.(symbolsToAdd);

        symbolsToAdd.forEach(symbol => {
          quoteSubscriptions.add(symbol);
        });
      }
    } catch {
      // Keep positions rendering; quote subscriptions will retry on next refresh/reconnect.
    }
  }

  function getCloseActionForPosition(position) {
    const quantityDirection = `${position?.['quantity-direction'] ?? ''}`.toLowerCase();

    if (quantityDirection === 'long') return 'Sell to Close';
    if (quantityDirection === 'short') return 'Buy to Close';
    return null;
  }

  function getCloseButtonClass(closeAction) {
    return closeAction === 'Sell to Close' ? 'btn-short' : 'btn-long';
  }

  function buildCloseOrderLeg(position) {
    const closeAction = getCloseActionForPosition(position);
    const symbol = position?.symbol;
    const instrumentType = position?.['instrument-type'];
    const rawQuantity = parseDecimal(position?.quantity);
    const quantity = rawQuantity === null ? null : Math.abs(rawQuantity);

    if (!closeAction || typeof symbol !== 'string' || symbol.trim().length === 0) return null;
    if (typeof instrumentType !== 'string' || instrumentType.trim().length === 0) return null;
    if (quantity === null || quantity <= 0) return null;

    return {
      'instrument-type': instrumentType,
      'symbol': symbol,
      'quantity': quantity,
      'action': closeAction,
    };
  }

  function isOrderCancellable(order) {
    if (order?.cancellable === true) return true;
    if (`${order?.cancellable ?? ''}`.toLowerCase() === 'true') return true;
    return false;
  }

  function getOrderId(order) {
    return `${order?.id ?? order?.['id'] ?? ''}`.trim();
  }

  function getOrderLegs(order) {
    if (Array.isArray(order?.legs)) return order.legs;
    if (Array.isArray(order?.['legs'])) return order['legs'];
    return [];
  }

  function doesOrderConflictWithPosition(order, positionSymbol) {
    const symbolKey = `${positionSymbol ?? ''}`.trim();
    if (!symbolKey) return false;

    const orderSymbol = `${order?.symbol ?? order?.['symbol'] ?? ''}`.trim();
    if (orderSymbol && orderSymbol === symbolKey) return true;

    const legs = getOrderLegs(order);
    return legs.some(leg => `${leg?.symbol ?? leg?.['symbol'] ?? ''}`.trim() === symbolKey);
  }

  async function cancelConflictingLiveOrders(accountNumber, position) {
    if (typeof listLiveOrders !== 'function' || typeof cancelOrder !== 'function') return;

    const positionSymbol = `${position?.symbol ?? ''}`.trim();
    if (!positionSymbol) return;

    const liveOrdersResponse = await listLiveOrders(accountNumber);
    const liveOrders = liveOrdersResponse?.data?.items ?? [];
    const conflictingOrders = liveOrders
      .filter(order => doesOrderConflictWithPosition(order, positionSymbol))
      .filter(isOrderCancellable);

    for (const order of conflictingOrders) {
      const orderId = getOrderId(order);
      if (!orderId) continue;
      await cancelOrder(accountNumber, orderId);
    }
  }

  async function closePosition(position, buttonEl = null) {
    const accountNumber = accountSelect.value;
    const closeLeg = buildCloseOrderLeg(position);

    if (!accountNumber || !closeLeg) {
      setErrorMessage('Error: Unable to close this position.');
      return;
    }

    const originalText = buttonEl?.textContent ?? 'Close';
    const closeAction = closeLeg['action'];

    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.className = 'btn-disabled positions-cancel-btn';
      buttonEl.textContent = 'Closing';
    }

    const order = {
      'order-type': 'Market',
      'time-in-force': 'Day',
      'legs': [closeLeg],
    };

    const waitForPositionClose = async ({ timeoutMs = 12_000, pollIntervalMs = 1_000 } = {}) => {
      const startedAt = Date.now();

      while (Date.now() - startedAt <= timeoutMs) {
        const openPositions = await fetchFilteredOpenPositions(accountNumber);
        const isStillOpen = openPositions.some(item => isMatchingOpenPosition(position, item));
        if (!isStillOpen) {
          return true;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }

      return false;
    };

    try {
      await cancelConflictingLiveOrders(accountNumber, position);
      await submitOrder(accountNumber, order);

      const didClose = await waitForPositionClose();
      if (!didClose) {
        setErrorMessage('Close order submitted but position is still open. Market may be closed or order not filled yet.');

        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.className = `${getCloseButtonClass(closeAction)} positions-cancel-btn`;
          buttonEl.textContent = originalText;
        }
        return;
      }

      clearStatusMessage();
      await loadPositions();
    } catch (err) {
      setErrorMessage(`Error: ${err.message}`);

      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.className = `${getCloseButtonClass(closeAction)} positions-cancel-btn`;
        buttonEl.textContent = originalText;
      }
    }
  }

  function renderPositions(items) {
    if (!positionsRows) return;

    positionsRows.innerHTML = '';
    resetPositionQuoteState();

    if (!Array.isArray(items) || items.length === 0) {
      renderEmptyPositionsRow();
      return;
    }

    items.forEach(item => {
      const row = document.createElement('tr');
      row.dataset.positionKey = getPositionDomKey(item);
      const { formattedDate, optionCode, strikePrice } = parseOptionSymbolDetails(item?.symbol);
      const strikeWithType = strikePrice === '--' || optionCode === '--'
        ? strikePrice
        : `${strikePrice}${optionCode}`;

      const cells = [
        item?.['underlying-symbol'] ?? '--',
        String(item?.quantity ?? '--'),
        formattedDate,
        strikeWithType,
        '--',
      ];

      cells.forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });

      const plEl = row.children[4];
      const streamerSymbol = item?.['streamer-symbol'];
      if (streamerSymbol && plEl) {
        const existingRows = plRowsByStreamerSymbol.get(streamerSymbol) ?? [];
        existingRows.push({
          plEl,
          position: {
            averageOpenPrice: item?.['average-open-price']
              ?? item?.averageOpenPrice
              ?? item?.['average_open_price']
              ?? item?.['average-price']
              ?? item?.averagePrice,
            closePrice: item?.['close-price'],
            quantity: item?.['quantity'],
            multiplier: item?.['multiplier'],
            instrumentType: item?.['instrument-type'],
            quantityDirection: item?.['quantity-direction'],
          },
        });
        plRowsByStreamerSymbol.set(streamerSymbol, existingRows);
      }

      const cancelCell = document.createElement('td');
      const cancelButton = document.createElement('button');
      const closeAction = getCloseActionForPosition(item);
      const closeLeg = buildCloseOrderLeg(item);
      const isClosable = !!closeAction && !!closeLeg;

      cancelButton.type = 'button';
      cancelButton.className = isClosable
        ? `${getCloseButtonClass(closeAction)} positions-cancel-btn`
        : 'btn-disabled positions-cancel-btn';
      cancelButton.disabled = !isClosable;
      cancelButton.textContent = 'Close';

      if (isClosable) {
        cancelButton.addEventListener('click', () => {
          closePosition(item, cancelButton);
        });
      }

      cancelCell.appendChild(cancelButton);
      row.appendChild(cancelCell);

      positionsRows.appendChild(row);
    });
  }

  async function loadPositions() {
    if (!positionsRows || !positionsStatus) return;

    const accountNumber = accountSelect.value;
    if (!accountNumber) {
      positionsRows.innerHTML = '';
      renderEmptyPositionsRow();
      resetPositionQuoteState();
      await syncQuoteSubscriptions();
      setSectionVisible(false);
      clearStatusMessage();
      return;
    }

    try {
      const filtered = await fetchFilteredOpenPositions(accountNumber);

      renderPositions(filtered);
      await syncQuoteSubscriptions();
      plRowsByStreamerSymbol.forEach((_, streamerSymbol) => {
        updatePositionPlForStreamer(streamerSymbol);
      });
      setSectionVisible(filtered.length > 0);
      clearStatusMessage();
    } catch (err) {
      positionsRows.innerHTML = '';
      resetPositionQuoteState();
      await syncQuoteSubscriptions();
      setSectionVisible(true);
      setErrorMessage(`Error: ${err.message}`);
    }
  }

  async function pruneClosedPositions() {
    if (!positionsRows || !positionsStatus) return;

    const accountNumber = accountSelect.value;
    if (!accountNumber) {
      positionsRows.innerHTML = '';
      renderEmptyPositionsRow();
      resetPositionQuoteState();
      await syncQuoteSubscriptions();
      setSectionVisible(false);
      clearStatusMessage();
      return;
    }

    try {
      const filtered = await fetchFilteredOpenPositions(accountNumber);
      const openPositionKeys = new Set(filtered.map(getPositionDomKey).filter(Boolean));

      Array.from(positionsRows.querySelectorAll('tr[data-position-key]')).forEach(row => {
        const rowKey = `${row?.dataset?.positionKey ?? ''}`;
        if (!rowKey || !openPositionKeys.has(rowKey)) {
          row.remove();
        }
      });

      if (openPositionKeys.size === 0) {
        renderEmptyPositionsRow();
      } else {
        Array.from(positionsRows.querySelectorAll('.positions-empty-row')).forEach(row => row.remove());
      }

      pruneDisconnectedPlRows();
      await syncQuoteSubscriptions();
      plRowsByStreamerSymbol.forEach((_, streamerSymbol) => {
        updatePositionPlForStreamer(streamerSymbol);
      });
      setSectionVisible(positionsRows.children.length > 0);
      clearStatusMessage();
    } catch (err) {
      setErrorMessage(`Error: ${err.message}`);
    }
  }

  function handleQuote(eventSymbol, bidPrice, askPrice, lastPrice = null) {
    if (!quoteSubscriptions.has(eventSymbol)) return;

    const previousQuote = quoteByStreamerSymbol.get(eventSymbol) ?? {};
    const normalizedBidPrice = normalizePositiveQuotePrice(bidPrice);
    const normalizedAskPrice = normalizePositiveQuotePrice(askPrice);
    const normalizedLastPrice = normalizePositiveQuotePrice(lastPrice);
    const nextBidPrice = normalizedBidPrice ?? previousQuote?.bidPrice ?? null;
    const nextAskPrice = normalizedAskPrice ?? previousQuote?.askPrice ?? null;
    const nextLastPrice = normalizedLastPrice ?? previousQuote?.lastPrice ?? null;

    quoteByStreamerSymbol.set(eventSymbol, {
      bidPrice: nextBidPrice,
      askPrice: nextAskPrice,
      lastPrice: nextLastPrice,
      updatedAt: Date.now(),
    });
    updatePositionPlForStreamer(eventSymbol);
  }

  function clearMarketDataState() {
    quoteByStreamerSymbol.clear();
    quoteSubscriptions.clear();
    plRowsByStreamerSymbol.clear();
  }

  function handleLogout() {
    if (positionsRows) positionsRows.innerHTML = '';
    renderEmptyPositionsRow();
    setSectionVisible(false);
    clearStatusMessage();
    clearMarketDataState();
  }

  return {
    loadPositions,
    pruneClosedPositions,
    handleQuote,
    clearMarketDataState,
    handleLogout,
  };
}

window.createPositionsManager = createPositionsManager;
