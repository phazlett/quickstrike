// SPDX-License-Identifier: MIT
/*
  Shared app-level config.

  Adapter-specific values (credentials, endpoints, redirect URI) belong in:
  - config/adapters/tastytrade.config.js
  - config/adapters/ibkr.config.js
*/

const ACTIVE_ADAPTER = 'tastytrade';

// Set to true for sandbox/paper environment, false for live.
let useSandbox = true;
