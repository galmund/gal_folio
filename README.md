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

## Prices, including pre-market and after hours

Prices work out of the box — no signup, no API key. They come from CNBC's public
quote service, which reports the **pre-market** and **after-hours** print
alongside the regular session, so your portfolio keeps moving outside 9:30–16:00 ET.

The top bar shows which session you're looking at — *Pre-market*, *Market open*,
*After hours* or *Market closed* — and any row priced off an extended-hours trade
gets a small `Pre` / `Aft` line under the price showing how far it has moved since
the regular close.

### Optional: a free Finnhub key

A [Finnhub](https://finnhub.io) key is only needed for **ticker search and company
names** in the add-holding box, plus as a price fallback for anything the main
source doesn't recognise.

1. Sign up at **https://finnhub.io/register** (takes ~1 minute).
2. Copy your API key from the Finnhub dashboard.
3. In gal_folio, click **⚙ Settings**, paste the key, and Save.

The key is stored only in `data.json` on your machine and is sent straight to
Finnhub by your local server — it never goes anywhere else.

## Using it

- **Add a holding** — type a ticker (e.g. `AAPL`); pick from the search
  suggestions, enter your shares and average cost per share, then **Add**.
- **Edit / delete** — click the ✎ on any row.
- **Refresh** — prices auto-refresh every 60 seconds through pre-market, regular
  hours and after hours; once the market is fully closed it eases off to every 5
  minutes. Re-opening the app refreshes immediately, and ↻ forces it any time.

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
- Extended-hours prints exist for US-listed stocks and ETFs. Other listings still
  price fine, they just show the regular close outside their own trading hours.
- If a symbol shows `error`, neither price source recognised it — check the ticker.
