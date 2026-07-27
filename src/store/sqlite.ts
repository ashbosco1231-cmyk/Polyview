import Database from "better-sqlite3";
import type { BookSnapshot, MarketMeta, Side, Trade, Venue } from "../types.js";
import type { Store, TradeQuery } from "./store.js";

/**
 * SQLite-backed store. WAL mode keeps the live recorder writing while the API
 * reads, without either blocking the other.
 *
 * The tick table is the one thing here that grows without bound — every other
 * table is an upsert keyed by token or market, so it plateaus. At ~50 prints a
 * second across both venues that is ~4.3M rows a day, which makes the per-row
 * cost the single number that decides how much history we can afford to keep.
 * Three choices do the heavy lifting:
 *
 *  1. Tokens are interned. `venue`, `token_id` and `market` were repeated in
 *     full on every row (and again inside every index); for Kalshi `token_id`
 *     and `market` are byte-identical, so the same 31-char string was stored
 *     four times per trade. They now live once in `tokens` and each tick keeps
 *     a small integer reference.
 *  2. Prices and sizes are fixed-point integers, not REALs. Measured against
 *     live data, prices carry at most 3 decimals and sizes at most 6, so a 1e6
 *     scale is exact for both with room to spare. SQLite varint-encodes small
 *     integers in 1-3 bytes where every REAL costs a flat 8.
 *  3. The table is WITHOUT ROWID and clustered on (tok, ts, dedup). That one
 *     B-tree *is* the storage, the dedup constraint, and the index that range
 *     queries walk — so there are no secondary indexes at all. Previously the
 *     two indexes together cost more per trade than the row they pointed at.
 *
 * Together that takes a trade from ~297 bytes on disk to ~30.
 */

/**
 * Fixed-point scale for prices and sizes. Both are exact at 1e6 for the
 * precision the venues actually publish; see the class comment.
 */
const SCALE = 1_000_000;

/** Rows per transaction when migrating the legacy table. */
const MIGRATE_BATCH = 20_000;

export class SqliteStore implements Store {
  private db: Database.Database;
  // Prepared once, after the schema exists. Declared with definite-assignment
  // because they are set in prepareStatements(), called from the constructor.
  private insertTickStmt!: Database.Statement;
  private insertTokenStmt!: Database.Statement;
  private selectTokenStmt!: Database.Statement;
  private putBookStmt!: Database.Statement;
  private upsertMarketStmt!: Database.Statement;

  /** `venue\0tokenId` -> tokens.id, so the hot insert path never hits SQLite. */
  private readonly tokenRefs = new Map<string, number>();
  /** tokens.id -> identity, for turning ticks back into Trades on read. */
  private readonly tokenById = new Map<number, { venue: Venue; tokenId: string; market: string }>();

  /**
   * Running tick count. Kept in memory because both recorders logged a total
   * after every flush — a COUNT(*) every two seconds, which is a full scan of
   * the largest table in the database and gets slower as the archive grows.
   */
  private tickCount = 0;

  constructor(path = "sharpline.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.migrate();
    this.prepareStatements();
    this.tickCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM ticks`).get() as any).c;
    this.loadTokens();
  }

  private migrate(): void {
    this.db.exec(`
      -- Interned token identities. Small and bounded: one row per outcome token
      -- either venue has ever printed a trade on (low thousands).
      CREATE TABLE IF NOT EXISTS tokens (
        id       INTEGER PRIMARY KEY,
        venue    TEXT NOT NULL,
        token_id TEXT NOT NULL,
        market   TEXT NOT NULL,
        UNIQUE (venue, token_id)
      );
      -- Reads arrive as a bare token id (no venue), which the UNIQUE index above
      -- can't serve as a prefix.
      CREATE INDEX IF NOT EXISTS idx_tokens_token ON tokens (token_id);

      -- The tick archive. Clustered on (tok, ts, dedup): chart range queries walk
      -- it directly, and the primary key doubles as the de-duplication constraint
      -- for fills that get re-broadcast on a websocket reconnect or an
      -- overlapping poll.
      CREATE TABLE IF NOT EXISTS ticks (
        tok   INTEGER NOT NULL,
        ts    INTEGER NOT NULL,
        dedup INTEGER NOT NULL,
        px    INTEGER NOT NULL,
        sz    INTEGER NOT NULL,
        side  INTEGER NOT NULL,
        PRIMARY KEY (tok, ts, dedup)
      ) WITHOUT ROWID;

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
        last_price  REAL,
        updated_at  INTEGER NOT NULL
      );
    `);
    // Additive migration for databases created before last_price existed.
    const cols = this.db.prepare(`PRAGMA table_info(markets)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "last_price")) {
      this.db.exec(`ALTER TABLE markets ADD COLUMN last_price REAL`);
    }
  }

  private prepareStatements(): void {
    this.insertTickStmt = this.db.prepare(`
      INSERT OR IGNORE INTO ticks (tok, ts, dedup, px, sz, side)
      VALUES (@tok, @ts, @dedup, @px, @sz, @side)
    `);
    this.insertTokenStmt = this.db.prepare(`
      INSERT OR IGNORE INTO tokens (venue, token_id, market) VALUES (@venue, @tokenId, @market)
    `);
    this.selectTokenStmt = this.db.prepare(`
      SELECT id FROM tokens WHERE venue = @venue AND token_id = @tokenId
    `);
    this.putBookStmt = this.db.prepare(`
      INSERT INTO books (token_id, venue, market, ts, snapshot)
      VALUES (@tokenId, @venue, @market, @ts, @snapshot)
      ON CONFLICT(token_id) DO UPDATE SET
        venue = excluded.venue, market = excluded.market,
        ts = excluded.ts, snapshot = excluded.snapshot
    `);
    this.upsertMarketStmt = this.db.prepare(`
      INSERT INTO markets (market, venue, question, slug, category, token_ids, active, closed, volume24hr, last_price, updated_at)
      VALUES (@market, @venue, @question, @slug, @category, @tokenIds, @active, @closed, @volume24hr, @lastPrice, @updatedAt)
      ON CONFLICT(market) DO UPDATE SET
        question = excluded.question, slug = excluded.slug, category = excluded.category,
        token_ids = excluded.token_ids, active = excluded.active, closed = excluded.closed,
        volume24hr = excluded.volume24hr, last_price = excluded.last_price, updated_at = excluded.updated_at
    `);
  }

  /** Warm both token maps once, so neither read nor write path needs a lookup. */
  private loadTokens(): void {
    const rows = this.db.prepare(`SELECT id, venue, token_id, market FROM tokens`).all() as any[];
    for (const r of rows) {
      this.tokenRefs.set(tokenKey(r.venue, r.token_id), r.id);
      this.tokenById.set(r.id, { venue: r.venue, tokenId: r.token_id, market: r.market });
    }
  }

  /** Intern a token identity, returning its small integer reference. */
  private tokenRef(venue: Venue, tokenId: string, market: string): number {
    const key = tokenKey(venue, tokenId);
    const hit = this.tokenRefs.get(key);
    if (hit !== undefined) return hit;
    this.insertTokenStmt.run({ venue, tokenId, market });
    const id = (this.selectTokenStmt.get({ venue, tokenId }) as any).id as number;
    this.tokenRefs.set(key, id);
    this.tokenById.set(id, { venue, tokenId, market });
    return id;
  }

  insertTrades(trades: Trade[]): number {
    if (trades.length === 0) return 0;
    let written = 0;
    const tx = this.db.transaction((batch: Trade[]) => {
      for (const t of batch) {
        const info = this.insertTickStmt.run({
          tok: this.tokenRef(t.venue, t.tokenId, t.market),
          ts: t.ts,
          dedup: dedupHash(t.txHash, t.price, t.size, t.side),
          px: Math.round(t.price * SCALE),
          sz: Math.round(t.size * SCALE),
          side: t.side === "BUY" ? 1 : 0,
        });
        written += info.changes;
      }
    });
    tx(trades);
    this.tickCount += written;
    return written;
  }

  getTrades(q: TradeQuery): Trade[] {
    const tok = this.refForTokenId(q.tokenId);
    if (tok === null) return [];
    const ident = this.tokenById.get(tok)!;

    const clauses = ["tok = @tok"];
    if (q.from !== undefined) clauses.push("ts >= @from");
    if (q.to !== undefined) clauses.push("ts < @to");
    const where = clauses.join(" AND ");
    const limit = q.limit ?? 5000;
    // Take the most recent `limit`, then hand them back oldest-first.
    const rows = this.db
      .prepare(
        `SELECT ts, px, sz, side FROM (
           SELECT ts, px, sz, side FROM ticks WHERE ${where} ORDER BY ts DESC LIMIT @limit
         ) ORDER BY ts ASC`,
      )
      .all({ tok, from: q.from, to: q.to, limit }) as any[];

    return rows.map((r) => ({
      venue: ident.venue,
      tokenId: ident.tokenId,
      market: ident.market,
      price: r.px / SCALE,
      size: r.sz / SCALE,
      side: (r.side === 1 ? "BUY" : "SELL") as Side,
      ts: r.ts,
      // Not retained: the raw venue hash existed only to de-duplicate, and it
      // cost more per row than the trade itself. `dedup` carries that duty now.
      txHash: "",
    }));
  }

  /** Resolve a bare token id (either venue) to its interned reference. */
  private refForTokenId(tokenId: string): number | null {
    for (const venue of ["polymarket", "kalshi"] as const) {
      const hit = this.tokenRefs.get(tokenKey(venue, tokenId));
      if (hit !== undefined) return hit;
    }
    const row = this.db.prepare(`SELECT id FROM tokens WHERE token_id = ? LIMIT 1`).get(tokenId) as any;
    return row ? (row.id as number) : null;
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
          lastPrice: m.lastPrice,
          updatedAt: m.updatedAt,
        });
      }
    });
    tx(markets);
  }

  listMarkets(opts: { limit?: number; activeOnly?: boolean; venue?: Venue } = {}): MarketMeta[] {
    const clauses: string[] = [];
    if (opts.activeOnly) clauses.push("active = 1 AND closed = 0");
    if (opts.venue) clauses.push("venue = @venue");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM markets ${where}
         ORDER BY volume24hr DESC NULLS LAST, updated_at DESC LIMIT @limit`,
      )
      .all({ venue: opts.venue, limit: opts.limit ?? 100 }) as any[];
    return rows.map(rowToMarket);
  }

  findMarketByToken(tokenId: string): MarketMeta | null {
    // token_ids is a JSON array string like ["123","456"]; match the quoted id.
    const row = this.db
      .prepare(`SELECT * FROM markets WHERE token_ids LIKE ? LIMIT 1`)
      .get(`%"${tokenId}"%`) as any;
    return row ? rowToMarket(row) : null;
  }

  countTrades(): number {
    return this.tickCount;
  }

  /** Bytes the database currently occupies, for capacity reporting. */
  sizeOnDisk(): number {
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;
    const pageCount = this.db.pragma("page_count", { simple: true }) as number;
    return pageSize * pageCount;
  }

  /**
   * Fold a pre-existing `trades` table into the tick archive and reclaim the
   * space. Safe to call on every boot: it no-ops once the legacy table is gone.
   *
   * Deliberately NOT called from the constructor. On the deployed database this
   * walks millions of rows and then VACUUMs, which takes far longer than a
   * platform health check will wait — so it runs in the background after the
   * HTTP port is already open.
   */
  migrateLegacyTrades(log: (msg: string) => void = () => {}): void {
    const legacy = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trades'`)
      .get();
    if (!legacy) return;

    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM trades`).get() as any).c as number;
    if (total === 0) {
      this.db.exec(`DROP TABLE trades`);
      log("legacy trades table was empty; dropped");
      return;
    }

    const before = this.sizeOnDisk();
    log(`migrating ${total.toLocaleString()} legacy trades into the tick archive…`);

    const read = this.db.prepare(
      `SELECT venue, token_id, market, price, size, side, ts, tx_hash
         FROM trades ORDER BY rowid LIMIT @limit OFFSET @offset`,
    );
    let moved = 0;
    for (let offset = 0; offset < total; offset += MIGRATE_BATCH) {
      const rows = read.all({ limit: MIGRATE_BATCH, offset }) as any[];
      if (rows.length === 0) break;
      const tx = this.db.transaction((batch: any[]) => {
        for (const r of batch) {
          this.insertTickStmt.run({
            tok: this.tokenRef(r.venue, r.token_id, r.market),
            ts: r.ts,
            dedup: dedupHash(r.tx_hash, r.price, r.size, r.side),
            px: Math.round(r.price * SCALE),
            sz: Math.round(r.size * SCALE),
            side: r.side === "BUY" ? 1 : 0,
          });
        }
      });
      tx(rows);
      moved += rows.length;
      log(`  migrated ${moved.toLocaleString()} / ${total.toLocaleString()}`);
    }

    this.db.exec(`DROP TABLE trades`);
    // Dropping a table frees pages inside the file but does not shrink it, and
    // shrinking is the entire point here.
    log("compacting database (VACUUM)…");
    this.db.exec(`VACUUM`);

    this.tickCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM ticks`).get() as any).c;
    const after = this.sizeOnDisk();
    log(
      `migration complete: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB ` +
        `(${(before / Math.max(after, 1)).toFixed(1)}x smaller), ${this.tickCount.toLocaleString()} ticks`,
    );
  }

  checkpoint(): void {
    // Fold the WAL back into the main db file so a crash/restart loses nothing.
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}

function tokenKey(venue: string, tokenId: string): string {
  return `${venue} ${tokenId}`;
}

/**
 * 32-bit hash of a trade's venue-native identity, used to reject re-broadcasts.
 *
 * Width is chosen against what this actually has to separate. Because the key is
 * (tok, ts, dedup), two hashes are only ever compared when their trades share a
 * token *and* land in the same millisecond — a population of a handful of fills,
 * not the whole archive. At 32 bits any given such pair collides with
 * probability ~2.3e-10, so even a billion same-millisecond pairs over the life
 * of the archive expect ~0.2 collisions. Going wider costs 4 bytes on every row
 * (a tenth of the record) to buy precision that rounds to the same zero.
 */
function dedupHash(txHash: string, price: number, size: number, side: string): number {
  const s = `${txHash}|${price}|${size}|${side}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
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
    lastPrice: r.last_price ?? null,
    updatedAt: r.updated_at,
  };
}
