// Polymarket REST clients.
//
// Two public, unauthenticated APIs are all Phase 0 needs:
//   - Gamma  (gamma-api.polymarket.com)  — the market catalogue
//   - CLOB   (clob.polymarket.com)        — order books + historical prices
// Neither requires a key. Only *placing* orders needs a wallet signature, which
// is out of scope until the execution phase.

import type { MarketMeta } from "../types.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Top active markets by 24h volume. These are the tokens worth recording first
 * — the busiest books produce the richest tick history.
 */
export async function fetchTopMarkets(limit = 50): Promise<MarketMeta[]> {
  const url =
    `${GAMMA}/markets?limit=${limit}&active=true&closed=false` +
    `&order=volume24hr&ascending=false`;
  const raw = (await getJson(url)) as any[];
  const now = Date.now();
  return raw.map((m): MarketMeta => ({
    venue: "polymarket",
    market: m.conditionId ?? m.condition_id ?? String(m.id),
    question: m.question ?? "",
    slug: m.slug ?? "",
    category: m.category ?? null,
    tokenIds: parseTokenIds(m.clobTokenIds),
    active: m.active ?? true,
    closed: m.closed ?? false,
    volume24hr: numeric(m.volume24hr),
    updatedAt: now,
  }));
}

/** Gamma serialises clobTokenIds as a JSON string; be defensive about it. */
function parseTokenIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through */
    }
  }
  return [];
}

function numeric(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export interface PricePoint {
  ts: number;
  price: number;
}

/**
 * Historical price series for one token from the CLOB `/prices-history`
 * endpoint. This backfills time-based context on day one — but note it returns
 * *time* candles, not tick-level prints, which is exactly why we run our own
 * recorder for the fidelity that matters.
 */
export async function fetchPriceHistory(
  tokenId: string,
  interval: "1h" | "6h" | "1d" | "1w" | "max" = "1d",
): Promise<PricePoint[]> {
  const url = `${CLOB}/prices-history?market=${tokenId}&interval=${interval}&fidelity=1`;
  const data = await getJson(url);
  const history = (data?.history ?? []) as Array<{ t: number; p: number }>;
  return history.map((h) => ({ ts: h.t * 1000, price: h.p }));
}
