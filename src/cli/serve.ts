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
import { SqliteStore } from "../store/sqlite.js";

const store = new SqliteStore(process.env.DB_PATH ?? "polyview.db");
const port = Number(process.env.PORT ?? 3000);

const app = createServer(store);

// Static frontend (../../web relative to this file at runtime).
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, "../../web")));

const http = createHttpServer(app);
const hub = new LiveHub(http);

let recorder: Recorder | null = null;
if (process.env.RECORD !== "0") {
  recorder = new Recorder(store, { marketLimit: Number(process.env.MARKET_LIMIT ?? 50) });
  recorder.onLive((ev) => hub.broadcast(ev));
  await recorder.start();
}

http.listen(port, () => {
  console.log(`[serve] Polyview terminal on http://localhost:${port}`);
  console.log(`[serve] API under /api, live push at ws://localhost:${port}/live`);
});

function shutdown(): void {
  recorder?.stop();
  http.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
