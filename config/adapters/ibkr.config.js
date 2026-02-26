/*
  Interactive Brokers adapter credentials/settings scaffold.
  Populate this when IBKR adapter support is enabled.
*/

window.ADAPTER_CONFIGS = window.ADAPTER_CONFIGS || {};

window.ADAPTER_CONFIGS.ibkr = {
    ibGatewayLivePort: 4001,
    ibGatewayPaperPort: 4002,
    twsLivePort: 7497,
    twsPaperPort: 7496,
  suppressDisconnectStateLogs: true,
};