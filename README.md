# quickstrike
One-click order submission for TastyTrade

## Project layout

- `config.js` (root): the only file you should edit for setup and environment options.
- `index.html` (root): app entrypoint used by the OAuth redirect callback.
- `lib/`: application runtime code and styles (`app.js`, managers, API client, and `style.css`).

When distributing this project, treat `lib/` as implementation files and keep user customization in `config.js` only.
