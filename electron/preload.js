// SPDX-License-Identifier: MIT
const { contextBridge, ipcRenderer } = require('electron');

function createListener(channel) {
  return callback => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const handler = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

contextBridge.exposeInMainWorld('electronIBKR', {
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  connect: settings => ipcRenderer.invoke('ibkr:connect', settings),
  disconnect: () => ipcRenderer.invoke('ibkr:disconnect'),
  listAccounts: () => ipcRenderer.invoke('ibkr:listAccounts'),
  listPositions: accountNumber => ipcRenderer.invoke('ibkr:listPositions', accountNumber),
  submitOrder: (accountNumber, order) => ipcRenderer.invoke('ibkr:submitOrder', accountNumber, order),
  getOptionChain: symbol => ipcRenderer.invoke('ibkr:getOptionChain', symbol),
  getEquityOptionsBySymbols: symbols => ipcRenderer.invoke('ibkr:getEquityOptionsBySymbols', symbols),
  addQuoteSubscriptions: symbols => ipcRenderer.invoke('ibkr:addQuoteSubscriptions', symbols),
  removeQuoteSubscriptions: symbols => ipcRenderer.invoke('ibkr:removeQuoteSubscriptions', symbols),
  subscribeUnderlyingSymbol: symbol => ipcRenderer.invoke('ibkr:subscribeUnderlyingSymbol', symbol),
  clearMarketData: () => ipcRenderer.invoke('ibkr:clearMarketData'),
  onConnectionState: createListener('ibkr:connectionState'),
  onQuote: createListener('ibkr:quote'),
  onError: createListener('ibkr:error'),
  onFeedReady: createListener('ibkr:feedReady'),
});
