# QuickStrike for TastyTrade
QuickStrike is a lightweight browser app for fast options execution with TastyTrade OAuth authentication, live quote streaming, option-chain selection, buying-power reduction estimates, and positions management.

## Features

- OAuth login with PKCE (TastyTrade)
- Sandbox or live environment support
- Fast call/put staging from option-chain bid/ask clicks
- Market order submission for selected call/put leg
- Real-time underlying price and chain ATM marker behavior
- Positions table with real-time unrealized P/L updates
- One-click close action for open positions
- Startup loading screen with retry on initialization errors

## Important safety note

- If `useSandbox` is `false`, orders are live and can execute in your real account.
- Start in sandbox first and verify behavior before enabling live trading.

## Prerequisites

The application supports the TastyTrade live trading environment and the sandbox environment. The sandbox environment allows you to use the app without submitting real orders. Each environment requires its own credentials. The credentials for both environments will be added to the config.js file in the project root:

To create OAuth credentials for both Sandbox and Live environments, follow the official TastyTrade instructions:

- https://support.tastytrade.com/support/s/solutions/articles/43000700385

**IMPORTANT**: When setting up your credentials for both environments, you will see a setting called "Redirect URL". Use http://localhost:550 for this.

### Setup checklist
- Python 3 installed (used by local static server scripts)
- Add your TastyTrade API credentials to config.js in
	- Sandbox: `SANDBOX_CLIENT_ID` and `SANDBOX_CLIENT_SECRET`
	- Live: `LIVE_CLIENT_ID` and `LIVE_CLIENT_SECRET`
- A redirect URI configured in your OAuth app to match your local URL (default in this project: `http://localhost:5500`)

## Configure the app

Only edit `config.js` in the project root.

Set these values:

- `SANDBOX_CLIENT_ID`
- `SANDBOX_CLIENT_SECRET`
- `LIVE_CLIENT_ID`
- `LIVE_CLIENT_SECRET`
- `REDIRECT_URI` (must match your OAuth app redirect URI)
- `useSandbox` (`true` for sandbox, `false` for live)

## Run locally

From the project root:

### macOS / Linux

```bash
bash serve.sh
```

### Windows

```bat
serve.bat
```

Then navigate to:

- `http://localhost:5500`

## Typical workflow

1. Click **Login with TastyTrade** to sign-in into your TastyTrade account.
2. Select symbol (`SPY` / `XSP`), quantity, and account.
3. Click chain bid/ask values to stage call/put orders.
4. Review staged order.
5. Submit order. **IMPORTANT: there are no confirmation prompts. Clicking 'Submit' sends the order to your broker.**
6. Monitor positions and use **Close** when needed.

## Project structure

- `config.js` (root): **user-editable configuration only**
- `index.html` (root): user interface
- `serve.sh`, `serve.bat` (root): start scripts for Windows, Mac, and Linux
- `lib/` (root): runtime files
	- `app.js`
	- `bootstrap-manager.js`
	- `auth-manager.js`
	- `api-client.js`
	- `dxlink-manager.js`
	- `positions-manager.js`
	- `style.css`

When distributing this project, treat `lib/` as internal runtime code and direct users to edit only `config.js`.

## Troubleshooting

### Port 5500 already in use

- Stop the process using port `5500`, then re-run `serve.sh` / `serve.bat`.

### OAuth redirect mismatch

- Ensure `REDIRECT_URI` in `config.js` exactly matches the redirect URI in your TastyTrade OAuth app settings.

### Stuck on loading / startup error

- Use the **Retry** button on the loading screen.
- Re-check credentials and environment toggle in `config.js`.
- Confirm network access to TastyTrade endpoints.

### No positions shown

- Positions are filtered by selected underlying symbol and open quantity.
- Change symbol (`SPY` / `XSP`) and account to verify expected matches.

## License

See `LICENSE`.
