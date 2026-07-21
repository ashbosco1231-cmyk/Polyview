import Database from "better-sqlite3";
import type { BookSnapshot, MarketMeta, Trade, Venue } from "../types.js";
import type { Store, TradeQuery } from "./store.js";

/**
 * SQLite-backed store. WAL mode keeps the live recorder writing while the API
 * reads, without either blocking the other.
 */
export class SqliteStore implements Store {
  private db: Database.Database;
  // Prepared once, after the schema exists. Declared with definite-assignment
  // because they are set in prepareStatements(), called from the constructor.
  private insertTradeStmt!: Database.Statement;
  private putBookStmt!: Database.Statement;
  private upsertMarketStmt!: Database.Statement;

  constructor(path = "polyview.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.prepareStatements();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        venue    TEXT NOT NULL,
        token_id TEXT NOT NULL,
        market   TEXT NOT NULL,
        price    REAL NOT NULL,
        size     REAL NOT NULL,
        side     TEXT NOT NULL,
        ts       INTEGER NOT NULL,
        tx_hash  TEXT NOT NULL
      );
      -- Dedup: the same fill can be re-broadcast on reconnect.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_unique
        ON trades (tx_hash, token_id, price, size, ts);
      CREATE INDEX IF NOT EXISTS idx_trades_token_ts
        ON trades (token_id, ts);

      CREATE TABLE IF NOT EXISTS books (
        token_id TEXT PRIMARY KEY,
        venue    TEXT NOT NULL,
        market   TEXT NOT NULL,
        ts       INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS markets (
        market      TEXT PRIMARY KEY,
        venue       TEXT NOT NULL,
        question    TEXT NOT NULL,
        slug        TEXT NOT NULL,
        category    TEXT,
        token_ids   TEXT NOT NULL,
        active      INTEGER NOT NULL,
        closed      INTEGER NOT NULL,
        volume24hr  REAL,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  private prepareStatements(): void {
    this.insertTradeStmt = this.db.prepare(`
      INSERT OR IGNORE INTO trades (venue, token_id, market, price, size, side, ts, tx_hash)
      VALUES (@venue, @tokenId, @market, @price, @size, @side, @ts, @txHash)
    `);
    this.putBookStmt = this.db.prepare(`
      INSERT INTO books (token_id, venue, market, ts, snapshot)
      VALUES (@tokenId, @venue, @market, @ts, @snapshot)
      ON CONFLICT(token_id) DO UPDATE SET
        venue = excluded.venue, market = excluded.market,
        ts = excluded.ts, snapshot = excluded.snapshot
    `);
    this.upsertMarketStmt = this.db.prepare(`
      INSERT INTO markets (market, venue, question, slug, category, token_ids, active, closed, volume24hr, updated_at)
      VALUES (@market, @venue, @question, @slug, @category, @tokenIds, @active, @closed, @volume24hr, @updatedAt)
      ON CONFLICT(market) DO UPDATE SET
        question = excluded.question, slug = excluded.slug, category = excluded.category,
        token_ids = excluded.token_ids, active = excluded.active, closed = excluded.closed,
        volume24hr = excluded.volume24hr, updated_at = excluded.updated_at
    `);
  }

  insertTrades(trades: Trade[]): number {
    if (trades.length === 0) return 0;
    let written = 0;
    const tx = this.db.transaction((batch: Trade[]) => {
      for (const t of batch) {
        const info = this.insertTradeStmt.run(t);
        written += info.changes;
      }
    });
    tx(trades);
    return written;
  }

  getTrades(q: TradeQuery): Trade[] {
    const clauses = ["token_id = @tokenId"];
    if (q.from !== undefined) clauses.push("ts >= @from");
    if (q.to !== undefined) clauses.push("ts < @to");
    const where = clauses.join(" AND ");
    const limit = q.limit ?? 5000;
    // Take the most recent `limit`, then hand them back oldest-first.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM trades WHERE ${where} ORDER BY ts DESC LIMIT @limit
         ) ORDER BY ts ASC`,
      )
      .all({ tokenId: q.tokenId, from: q.from, to: q.to, limit }) as any[];
    return rows.map(rowToTrade);
  }

  putBook(book: BookSnapshot): void {
    this.putBookStmt.run({
      tokenId: book.tokenId,
      venue: book.venue,
      market: book.market,
      ts: book.ts,
      snapshot: JSON.stringify({ bids: book.bids, asks: book.asks }),
    });
  }

  getBook(tokenId: string): BookSnapshot | null {
    const row = this.db.prepare(`SELECT * FROM books WHERE token_id = ?`).get(tokenId) as any;
    if (!row) return null;
    const snap = JSON.parse(row.snapshot);
    return {
      venue: row.venue as Venue,
      tokenId: row.token_id,
      market: row.market,
      ts: row.ts,
      bids: snap.bids,
      asks: snap.asks,
    };
  }

  upsertMarkets(markets: MarketMeta[]): void {
    const tx = this.db.transaction((batch: MarketMeta[]) => {
      for (const m of batch) {
        this.upsertMarketStmt.run({
          market: m.market,
          venue: m.venue,
          question: m.question,
          slug: m.slug,
          category: m.category,
          tokenIds: JSON.stringify(m.tokenIds),
          active: m.active ? 1 : 0,
          closed: m.closed ? 1 : 0,
          volume24hr: m.volume24hr,
          updatedAt: m.updatedAt,
        });
      }
    });
    tx(markets);
  }

  listMarkets(opts: { limit?: number; activeOnly?: boolean } = {}): MarketMeta[] {
    const where = opts.activeOnly ? "WHERE active = 1 AND closed = 0" : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM markets ${where}
         ORDER BY volume24hr DESC NULLS LAST LIMIT ?`,
      )
      .all(opts.limit ?? 100) as any[];
    return rows.map(rowToMarket);
  }

  countTrades(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM trades`).get() as any;
    return row.c as number;
  }

  close(): void {
    this.db.close();
  }
}

function rowToTrade(r: any): Trade {
  return {
    venue: r.venue,
    tokenId: r.token_id,
    market: r.market,
    price: r.price,
    size: r.size,
    side: r.side,
    ts: r.ts,
    txHash: r.tx_hash,
  };
}

function rowToMarket(r: any): MarketMeta {
  return {
    venue: r.venue,
    market: r.market,
    question: r.question,
    slug: r.slug,
    category: r.category,
    tokenIds: JSON.parse(r.token_ids),
    active: !!r.active,
    closed: !!r.closed,
    volume24hr: r.volume24hr,
    updatedAt: r.updated_at,
  };
}
