// Serve the read API (and, by default, keep the recorder running alongside it so
// a single process both captures and serves).
//
//   npm run serve            # record + API on :3000
//   RECORD=0 npm run serve   # API only, over whatever is already in the db

import { Recorder } from "../recorder.js";
import { createServer } from "../server.js";
import { SqliteStore } from "../store/sqlite.js";

const store = new SqliteStore(process.env.DB_PATH ?? "polyview.db");
const port = Number(process.env.PORT ?? 3000);

let recorder: Recorder | null = null;
if (process.env.RECORD !== "0") {
  recorder = new Recorder(store, { marketLimit: Number(process.env.MARKET_LIMIT ?? 50) });
  await recorder.start();
}

const app = createServer(store);
const server = app.listen(port, () => {
  console.log(`[serve] Polyview API on http://localhost:${port}`);
  console.log(`[serve] try GET /api/health, /api/markets, /api/candles/:tokenId?type=tick&ticks=50`);
});

function shutdown(): void {
  recorder?.stop();
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
