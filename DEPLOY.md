# Deploying gal_folio to the cloud (use it on your iPhone, always on)

This puts your app online so your **PC and iPhone share one live portfolio**, and
it stays up even when your PC is off. You do this once, from a normal network
(home Wi‑Fi / cellular — not a locked‑down office network).

## Before you start

- **A password is required.** The app is only safe on the internet with the
  `GAL_PASSWORD` env var set (see below). Without it, anyone with the URL could
  see your holdings. The app enforces this automatically — set a strong password.
- **Your data needs a persistent disk.** Cloud apps get a fresh filesystem on
  every restart, so you must attach a **persistent volume** and point
  `DATA_FILE` at it (the included `Dockerfile` already sets `DATA_FILE=/data/data.json`
  — you just mount a volume at `/data`).
- **Getting the code up** is easiest via a **GitHub repo**. From this folder:
  ```
  git init && git add . && git commit -m "gal_folio"
  ```
  Then create an empty repo on github.com and follow its "push an existing repo"
  lines. (`data.json` and `data.json.bak` are gitignored, so your holdings + key
  are NOT uploaded — good.)

## Environment variables

| Variable | Required | What it does |
|---|---|---|
| `GAL_PASSWORD` | **yes** | The login password for the app. Pick a strong one. |
| `DATA_FILE` | yes | Where data is stored. Use `/data/data.json` (on your volume). The Dockerfile sets this. |
| `FINNHUB_API_KEY` | optional | Your Finnhub key. If you skip it, just set the key in‑app under ⚙ Settings after logging in. |
| `PORT` | auto | The host sets this for you. Don't hardcode it. |
| `GAL_SESSION_SECRET` | optional | Extra secret for signing login cookies. Defaults to your password. |

---

## Option A — Railway (easiest, ~$5/month)

1. Push the code to GitHub (above).
2. Sign up at **railway.app** → **New Project** → **Deploy from GitHub repo** →
   pick your repo. It builds from the `Dockerfile` automatically.
3. In the service, open **Variables** and add: `GAL_PASSWORD` (your password) and,
   optionally, `FINNHUB_API_KEY`.
4. Open **Data** → **Add Volume**, mount path **`/data`**. (This is what keeps
   your holdings between restarts.)
5. Open **Settings → Networking → Generate Domain** to get your public URL.
6. Visit the URL, log in, and set your API key in ⚙ Settings if you didn't add it
   as a variable.

## Option B — Fly.io (has a small free allowance)

1. Install the CLI: **flyctl** (fly.io/docs/hands-on/install-flyctl).
2. In this folder: `fly launch` — accept the Dockerfile, **don't** deploy yet.
3. Create a disk: `fly volumes create gal_data --size 1`
4. In the generated `fly.toml`, add a mount:
   ```toml
   [mounts]
     source = "gal_data"
     destination = "/data"
   ```
5. Set secrets: `fly secrets set GAL_PASSWORD=your-strong-password`
   (and optionally `fly secrets set FINNHUB_API_KEY=your-key`)
6. `fly deploy`, then open the URL it prints.

## Any Docker host / VPS

`docker build -t gal_folio .` then run with a mounted volume and env:
```
docker run -d -p 8080:8080 \
  -e GAL_PASSWORD=your-strong-password \
  -e FINNHUB_API_KEY=your-key \
  -v gal_data:/data \
  gal_folio
```

---

## Put it on your iPhone home screen

1. Open your app's URL in **Safari** and log in.
2. Tap the **Share** button → **Add to Home Screen**.
3. It installs with the 📈 icon and opens full‑screen, like a native app.

## Moving your current holdings over

Your existing holdings live in `data.json` on your PC; the cloud starts empty.
Quickest path: after logging in to the cloud app, **re‑add your holdings** (there
are only a handful, and same‑symbol adds auto‑merge). Your value/gain charts will
begin fresh and fill in day by day.

> Want a one‑click **export/import** instead so nothing is retyped? Ask and I'll
> add an "Export data" / "Import data" button.
