/*
  TastyTrade adapter credentials.
  Keep sandbox and live credentials here.
*/

window.ADAPTER_CONFIGS = window.ADAPTER_CONFIGS || {};

window.ADAPTER_CONFIGS.tastytrade = {
  sandbox: {
    redirectUri: 'http://localhost:5500',
    baseUrl: 'https://api.cert.tastyworks.com',
    tokenEndpoint: 'https://api.cert.tastyworks.com/oauth/token',
    authorizeUrl: 'https://cert-my.staging-tasty.works/auth.html'
  },
  live: {
    redirectUri: 'http://localhost:5500',
    baseUrl: 'https://api.tastyworks.com',
    tokenEndpoint: 'https://api.tastyworks.com/oauth/token',
    authorizeUrl: 'https://my.tastytrade.com/auth.html'
  }
};