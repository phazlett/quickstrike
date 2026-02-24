/*
    This file contains the only portions of the app that you must configure. The
    values used in this file for CLIENT_ID and CLIENT_SECRET are provided by
    TastyTrade when you create your OAuth application (See readme for more info).

    The REDIRECT_URI must match the value of the TastyTrade OAuth application
    redirect that you use when creating the OAuth app in TastyTrade. It is
    recommended to not change the REDIRECT_URI because that will require you to
    update serve.bat and serve.sh scripts to match the value in this file. Plus
    all of the docs assume this value is not changed.

    IMPORANT: TastyTrade test orders versus live orders
       useSandbox (boolean) determines if your orders will be actual live orders
       against your real TastyTrade account or if your oders will be test orders
       using the TastyTrade sandbox environment. Test orders are not real and
       provide no financial risk, live orders can cost you real money if you
       make a bad trade.
 */

// Sandbox (test) environment credentials. These are required if useSandbox is true.
const SANDBOX_CLIENT_ID = 'SANDBOX-TASTYTRADE-OAUTH-CLIENT-ID';
const SANDBOX_CLIENT_SECRET = 'SANDBOX-TASTYTRADE-OAUTH-CLIENT-SECRET';

// Live (real orders) environment credentials. These are required if useSandbox is false.
const LIVE_CLIENT_ID = 'LIVE-TASTYTRADE-OAUTH-CLIENT-ID';
const LIVE_CLIENT_SECRET = 'LIVE-TASTYTRADE-OAUTH-CLIENT-SECRET';

// This value must match the redirect URI of your TastyTrade OAuth app
const REDIRECT_URI = 'http://localhost:5500';

// Set this to true to use the TastyTrade demo (sandbox) environment.
// Set this to false to use the TastyTrade live (real orders) environment.
let useSandbox = false;
