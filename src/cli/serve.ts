// Serve the terminal: the read API, the static frontend, the live push hub, and
// (by default) the recorder itself — one process that both captures and serves.
//
//   npm run serve            # record + API + UI + live push on :3000
//   RECORD=0 npm run serve   # serve whatever is already in the db, no capture

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createServer } from "../server.js";
import { LiveHub } from "../live.js";
import { Recorder } from "../recorder.js";
import { KalshiSource } from "../kalshi/source.js";
import type { MarketDataSource } from "../source.js";
import { SqliteStore } from "../store/sqlite.js";

const store = new SqliteStore(process.env.DB_PATH ?? "sharpline.db");
const port = Number(process.env.PORT ?? 3000);

const app = createServer(store);

// Static frontend (../../web relative to this file at runtime).
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, "../../web")));

const http = createHttpServer(app);
const hub = new LiveHub(http);

// Both venues feed the same store and the same live hub. Toggle each with an
// env flag; default is both on.
const sources: MarketDataSource[] = [];
if (process.env.RECORD !== "0") {
  if (process.env.POLYMARKET !== "0") {
    sources.push(new Recorder(store, { marketLimit: Number(process.env.MARKET_LIMIT ?? 50) }));
  }
  if (process.env.KALSHI !== "0") {
    sources.push(new KalshiSource(store));
  }
}
for (const src of sources) {
  src.onLive((ev) => hub.broadcast(ev));
  await src.start();
}

http.listen(port, () => {
  console.log(`[serve] Sharpline terminal on http://localhost:${port}`);
  console.log(`[serve] venues: ${sources.map((s) => s.name).join(", ") || "none (RECORD=0)"}`);
  console.log(`[serve] API under /api, live push at ws://localhost:${port}/live`);
});

// Periodically fold the WAL into the main db file so an unexpected kill (a
// deploy, an OOM, a host reboot) loses at most a few minutes of trades.
const checkpointTimer = setInterval(() => store.checkpoint(), 60_000);

function shutdown(): void {
  clearInterval(checkpointTimer);
  for (const src of sources) src.stop();
  http.close();
  store.close(); // checkpoints then closes
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
