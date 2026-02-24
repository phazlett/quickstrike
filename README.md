# QuickStrike for TastyTrade
TastyTrade is a great options trading platform, but it's not built for daytraders that want to trade options. This project address that limitation for SPY and XSP options. QuickStrike is a lightweight browser app for fast options execution with TastyTrade OAuth authentication, live quote streaming, option-chain selection, buying-power reduction estimates, and positions management. You can enter and exit any SPY or XSP without any prompts for confirmations. A trade can be opened and closed in mere seconds which is perfect for the Tasty daytrader that is addicted to scalping the S&P 500.

![QuickStrike screenshot](screenshot.png)

## Features

- OAuth login with PKCE (TastyTrade)
- Sandbox or live environment support
- Option chain updates in real-time
- Fast call/put staging from option-chain by clicking on any bid/ask price
- One-click market order entry
- One-click to close open positions
- Open positions with real-time unrealized P/L
- Built with no external libraries or dependencies

## Important safety note

- If `useSandbox` is `false`, orders are live and can execute in your real account.
- Start in sandbox first and verify behavior before enabling live trading.

## Prerequisites

The application supports the TastyTrade live trading environment and the sandbox environment. The sandbox environment allows you to use the app without submitting real orders. Each environment requires its own credentials. The credentials for both environments will be added to the config.js file in the project root:

To create OAuth credentials for both Sandbox and Live environments, follow the official TastyTrade instructions:

- https://support.tastytrade.com/support/s/solutions/articles/43000700385

**IMPORTANT**: When setting up your credentials for both environments, you will see a setting called "Redirect URL". Use http://localhost:5500 for this.

### Setup checklist
- Python 3 installed (used by local static server scripts)
  - Windows install: download Python from https://www.python.org/downloads/windows/
  - During installation on Windows, enable **Add python.exe to PATH**
- Add your TastyTrade API credentials to config.js in
	- Sandbox: `SANDBOX_CLIENT_ID` and `SANDBOX_CLIENT_SECRET`
	- Live: `LIVE_CLIENT_ID` and `LIVE_CLIENT_SECRET`
- Ensure that your TastyTrade OAuth app is configured with a redirect URI that matches http://localhost:5500

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
