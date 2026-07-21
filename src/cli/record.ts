// Start the live recorder. Runs until Ctrl-C; prints a capture summary on exit.
//
//   npm run record                 # record top 50 markets into sharpline.db
//   MARKET_LIMIT=100 npm run record
//   RECORD_SECONDS=30 npm run record   # stop automatically after N seconds

import { Recorder } from "../recorder.js";
import { SqliteStore } from "../store/sqlite.js";

const store = new SqliteStore(process.env.DB_PATH ?? "sharpline.db");
const recorder = new Recorder(store, {
  marketLimit: Number(process.env.MARKET_LIMIT ?? 50),
});

let stopping = false;
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`\n[record] stopping (${reason})…`);
  recorder.stop();
  const total = store.countTrades();
  store.close();
  console.log(`[record] done — ${total} trades in the archive`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const seconds = Number(process.env.RECORD_SECONDS ?? 0);
if (seconds > 0) {
  setTimeout(() => shutdown(`${seconds}s elapsed`), seconds * 1000);
}

await recorder.start();
