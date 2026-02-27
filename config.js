// SPDX-License-Identifier: MIT
/*
  Shared app-level config.

  ACTIVE_ADAPTER and useSandbox are optional fallback defaults.
  On first launch, the app defaults to IBKR + paper (sandbox), and user selections
  from the configuration screen are persisted and used on subsequent launches.

  Adapter-specific values (credentials, endpoints, redirect URI) belong in:
  - config/adapters/tastytrade.config.js
  - config/adapters/ibkr.config.js
*/

const ACTIVE_ADAPTER = 'tastytrade';

// Set to true for sandbox/paper environment, false for live.
let useSandbox = true;
