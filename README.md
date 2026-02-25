# QuickStrike
Allows you to trade SPY and XSP options using streamlined interfaces. No prompts. No complexity. Just fast trade executions. QuickStrike is a lightweight browser app for fast options execution. The application leverages a data abstraction layer, allowing more broker API to be integrated. The application features OAuth authentication, live quote streaming, option-chain selection, buying-power reduction estimates, and positions management. You can enter and exit any SPY or XSP option position without any prompts for confirmations. A trade can be opened and closed in mere seconds.

Currently supported trading plaform APIs are
- TastyTrade
- Interactive Brokers (planned)

![QuickStrike screenshot](screenshot.png)

## Features

- OAuth login with PKCE
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

## Using with Interactive Brokers
[Copy to come]

## Using with TastyTrade

> The application supports the TastyTrade live trading environment and the sandbox environment. The sandbox environment allows you to use the app without submitting real orders. Each environment requires its own credentials. Put TastyTrade credentials in `config/adapters/tastytrade.config.js`.
>
>To create OAuth credentials for both Sandbox and Live environments, follow the official TastyTrade instructions:
>
>- https://support.tastytrade.com/support/s/solutions/articles/43000700385
>
>**IMPORTANT**: When setting up your credentials for both environments, you will see a setting called "Redirect URL". Use http://localhost:5500 for this.
>
>### Setup checklist
>- Python 3 installed (used by local static server scripts)
>  - Windows install: download Python from https://www.python.org/downloads/windows/
>  - During installation on Windows, enable **Add python.exe to PATH**
>- Add your TastyTrade API credentials in `config/adapters/tastytrade.config.js` under
>	- Sandbox: `sandbox.clientId` and `sandbox.clientSecret`
>	- Live: `live.clientId` and `live.clientSecret`
>- Ensure that your TastyTrade OAuth app is configured with a redirect URI that matches http://localhost:5500

## Configure the app

Edit these config files:

- `config.js` (shared runtime settings such as `activeAdapter` and `useSandbox`)
- `config/adapters/<adapter>.config.js` (adapter-specific endpoints and credentials)

Set these values:

- `activeAdapter` (currently `tastytrade`)
- `useSandbox` (`true` for sandbox, `false` for live)
- `config/adapters/<adapter>.config.js` (for your platform)

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

1. Click **Login** to sign in with the broker configured by `activeAdapter`.
2. Select symbol (`SPY` / `XSP`), quantity, and account.
3. Click chain bid/ask values to stage call/put orders.
4. Review staged order.
5. Submit order. **IMPORTANT: there are no confirmation prompts. Clicking 'Submit' sends the order to your broker.**
6. Monitor positions and use **Close** when needed.

## Project structure

- `config.js` (root): shared runtime config (active adapter, environment)
- `config/adapters/` (root): adapter-specific config files
	- `tastytrade.config.js`
	- `ibkr.config.js`
- `index.html` (root): user interface
- `serve.sh`, `serve.bat` (root): start scripts for Windows, Mac, and Linux
- `lib/` (root): runtime files
	- `app.js`
	- `bootstrap-manager.js`
	- `auth-manager.js`
	- `api-client.js`
	- `tastytrade-market-data-manager.js`
	- `positions-manager.js`
	- `style.css`

When distributing this project, treat `lib/` as internal runtime code and direct users to edit only files in the `config/` area.

## Troubleshooting

### Port 5500 already in use

- Stop the process using port `5500`, then re-run `serve.sh` / `serve.bat`.

### OAuth redirect mismatch

- Ensure `redirectUri` in your active adapter config file (`config/adapters/<adapter>.config.js`) exactly matches the redirect URI in your broker OAuth app settings.

### Stuck on loading / startup error

- Use the **Retry** button on the loading screen.
- Re-check credentials/endpoints in your active adapter config file and environment toggle in `config.js`.
- Confirm network access to your broker endpoints.

### No positions shown

- Positions are filtered by selected underlying symbol and open quantity.
- Change symbol (`SPY` / `XSP`) and account to verify expected matches.

## License

See `LICENSE`.
