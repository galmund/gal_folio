# 📈 gal_folio

A private, personal stock portfolio tracker that runs on your own machine.
Live prices, gain/loss tracking, and your data stored in a plain file on disk.
No accounts, nothing public, no packages to install.

## Run it

From this folder:

```powershell
node server.js
```

Then open **http://localhost:5178** (on Windows it opens automatically).
To stop it, press `Ctrl+C` in the terminal.

> Tip: double-click **start.bat** to launch without opening a terminal yourself.

## One-time setup: your free price key

Live prices come from [Finnhub](https://finnhub.io) (free tier = 60 requests/min).

1. Sign up at **https://finnhub.io/register** (takes ~1 minute).
2. Copy your API key from the Finnhub dashboard.
3. In gal_folio, click **⚙ Settings**, paste the key, and Save.

The key is stored only in `data.json` on your machine and is sent straight to
Finnhub by your local server — it never goes anywhere else.

## Using it

- **Add a holding** — type a ticker (e.g. `AAPL`); pick from the search
  suggestions, enter your shares and average cost per share, then **Add**.
- **Edit / delete** — click the ✎ on any row.
- **Refresh** — prices auto-refresh every 60 seconds; the ↻ button forces it.

The summary cards show your total value, today's move, total gain/loss, and how
much you've invested.

## Your data

Everything lives in **`data.json`** in this folder — your holdings, settings,
and API key. Back it up by copying that one file. Deleting it resets the app.

## Use it on your phone / in the cloud

To reach the app from your iPhone (even when this PC is off), deploy it to a
host — see **[DEPLOY.md](DEPLOY.md)**. Set a `GAL_PASSWORD` env var to turn on
the login screen (required before putting it on the internet); leave it unset for
password‑free local use.

## Notes

- Prices are returned in each stock's native currency (usually USD for US
  listings). The currency setting only changes the symbol used for formatting,
  it does not convert between currencies.
- Free Finnhub covers US stocks and many global tickers. Some exchanges need a
  paid plan; if a symbol shows `error`, it may not be on the free tier.
