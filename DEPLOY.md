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
| `UPSTASH_REDIS_REST_URL` | for Render | Upstash database URL. Enables cloud storage (needed on hosts with no persistent disk). |
| `UPSTASH_REDIS_REST_TOKEN` | for Render | Upstash database token (pairs with the URL above). |
| `DATA_FILE` | for disk hosts | File path for storage on hosts WITH a persistent disk (Fly/Railway). Use `/data/data.json`. Ignored when Upstash is set. |
| `FINNHUB_API_KEY` | optional | Your Finnhub key. If you skip it, just set the key in‑app under ⚙ Settings after logging in. |
| `PORT` | auto | The host sets this for you. Don't hardcode it. |
| `GAL_SESSION_SECRET` | optional | Extra secret for signing login cookies. Defaults to your password. |

> **Storage:** the app uses a local file by default. If `UPSTASH_REDIS_REST_URL`
> + `UPSTASH_REDIS_REST_TOKEN` are set, it stores everything in Upstash instead —
> that's how it keeps your data on hosts (like Render's free tier) that reset
> their disk. Set **either** Upstash **or** a `DATA_FILE` on a volume, not both.

---

## Option A — Render + Upstash ⭐ (free, no credit card)

Render's free web service sleeps after 15 min (a ~30–60s wake‑up delay) and has
no persistent disk — so we keep your data in **Upstash** (a free Redis database,
no card needed). Both are free.

**1. Create the free database (Upstash):**
- Sign up at **upstash.com** → **Create Database** (Redis) → pick a region near you.
- On the database page, open the **REST API** section and copy two values:
  **`UPSTASH_REDIS_REST_URL`** and **`UPSTASH_REDIS_REST_TOKEN`**.

**2. Deploy the app (Render):**
- Sign up at **render.com** → **New** → **Web Service** → connect your GitHub and
  pick the `gal_folio` repo.
- Render auto‑detects the `Dockerfile`. For **Instance Type** choose **Free**.
- Under **Environment**, add these variables:
  - `GAL_PASSWORD` = your password
  - `UPSTASH_REDIS_REST_URL` = (from step 1)
  - `UPSTASH_REDIS_REST_TOKEN` = (from step 1)
  - `FINNHUB_API_KEY` = your Finnhub key (optional — or set it in‑app later)
- Click **Create Web Service**. When it's live, Render gives you a public URL.

**3. Log in on your iPhone** (see "Put it on your iPhone home screen" below) and
**Import** your exported backup — done, and your data now survives every sleep.

> Note: the free instance sleeps when idle, so the first open after a while takes
> ~30–60 seconds to wake. After that it's snappy.

## Option B — Railway (easiest, ~$5/month)

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

## Option C — Fly.io (persistent volume, needs a card on file)

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
