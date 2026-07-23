# Deploying the Sharpline recorder

The recorder has to run on an **always-on host** to accumulate history — it is a
long-lived process, not a cron job. The data lives in a SQLite file on a
**persistent volume** so restarts and redeploys never lose it.

Pick one of the options below. Fly.io is the quickest path to a true 24/7
recorder with a volume; Docker Compose is best if you have your own VPS.

The market data itself is **free and public** — there are no API keys to set.

---

## Option A — Fly.io (recommended for always-on)

One-time setup:

```bash
# 1. Install flyctl and log in (creates/uses your Fly account)
curl -L https://fly.io/install.sh | sh
fly auth login

# 2. From the repo root — create the app from fly.toml (edit `app` to a unique name first)
fly apps create sharpline-recorder      # or `fly launch --no-deploy` to generate config

# 3. Create the persistent volume the DB writes to (3 GB is plenty to start)
fly volumes create sharpline_data --size 3 --region iad

# 4. Deploy
fly deploy
```

It's now recording 24/7. Useful commands:

```bash
fly logs                 # watch "+N trades (total …)" stream by
fly status               # machine health
fly open                 # open the live terminal in your browser
```

**Important:** keep `auto_stop_machines = false` and `min_machines_running = 1`
in `fly.toml` (already set). If the machine scales to zero, recording stops.

Grow the volume later if needed: `fly volumes extend <id> --size 10`.

---

## Option B — Docker Compose (your own VPS / box)

On any host with Docker:

```bash
docker compose up -d --build     # start detached, keep running
docker compose logs -f           # watch it record
```

The `sharpline-data` named volume persists the database across `down`/`up` and
rebuilds. `restart: unless-stopped` brings it back after crashes and reboots.

To move the data off the container onto a host path instead of a named volume,
change the volume line in `docker-compose.yml` to `- ./data:/data`.

---

## Option C — Railway / Render (git-push deploy)

Both can build from the `Dockerfile`:

1. Create a new service from this repo; it auto-detects the Dockerfile.
2. Add a **persistent disk / volume** mounted at `/data` (Railway: "Volumes";
   Render: "Disks"). Without this, data is wiped on every redeploy.
3. Set env `DB_PATH=/data/sharpline.db` (and optionally `MARKET_LIMIT`).
4. Ensure the service type is a **always-on web service**, not a cron/one-off.

---

## Sizing & operations

- **Memory:** 512 MB is comfortable. The recorder buffers briefly and flushes
  every 2s; the WAL is checkpointed every 60s and on shutdown.
- **Disk growth:** roughly a few hundred MB per day of trades at
  `MARKET_LIMIT=80` plus all of Kalshi's public trade feed. Start at 3–5 GB and
  extend as needed; prune or roll the DB later if it gets large.
- **What it records:** every executed trade from both venues (the tick archive)
  plus latest order books. Polymarket is a live WebSocket; Kalshi is polled from
  its public REST feed. The market list refreshes every ~20 min so it keeps
  following live markets as old ones resolve.
- **Backups:** copy the DB file off the volume periodically, e.g.
  `fly ssh console -C "sqlite3 /data/sharpline.db '.backup /data/backup.db'"`
  then `fly ssh sftp get /data/backup.db`.

## Verify it's actually stacking

Hit the health endpoint (or `fly open` → `/api/health`):

```bash
curl https://<your-app>/api/health
# {"ok":true,"tradesRecorded":123456}
```

`tradesRecorded` should climb every time you check.
