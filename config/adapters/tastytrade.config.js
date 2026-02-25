/*
  TastyTrade adapter credentials.
  Keep sandbox and live credentials here.
*/

window.ADAPTER_CONFIGS = window.ADAPTER_CONFIGS || {};

window.ADAPTER_CONFIGS.tastytrade = {
  sandbox: {
    // Do not change these URLs
    redirectUri: 'http://localhost:5500',
    baseUrl: 'https://api.cert.tastyworks.com',
    tokenEndpoint: 'https://api.cert.tastyworks.com/oauth/token',
    authorizeUrl: 'https://cert-my.staging-tasty.works/auth.html',

    // You must set these values to use the sandbox environment
    clientId: 'SANDBOX-TASTYTRADE-OAUTH-CLIENT-ID',
    clientSecret: 'SANDBOX-TASTYTRADE-OAUTH-CLIENT-SECRET',
  },
  live: {
    redirectUri: 'http://localhost:5500',
    baseUrl: 'https://api.tastyworks.com',
    tokenEndpoint: 'https://api.tastyworks.com/oauth/token',
    authorizeUrl: 'https://my.tastytrade.com/auth.html',

    // You must set these values to use the live environment
    clientId: 'LIVE-TASTYTRADE-OAUTH-CLIENT-ID',
    clientSecret: 'LIVE-TASTYTRADE-OAUTH-CLIENT-SECRET',
  },
};