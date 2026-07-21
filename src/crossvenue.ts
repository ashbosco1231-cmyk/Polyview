// Cross-venue matching + pricing — the feature no single-venue tool can offer.
//
// The hard part is that Polymarket and Kalshi describe the same real-world event
// with completely different tickers and wording, so we can't just join on an id.
// We score candidate pairs by title similarity and only ever present them as
// *candidates* with a confidence, never as confirmed arbitrage — the honest way
// to handle a fuzzy match. Once a pair is confirmed, the pricing math is exact.
//
// All pure functions, unit-tested without a network.

import type { MarketMeta } from "./types.js";

// Prediction-market boilerplate that carries no matching signal.
const STOPWORDS = new Set([
  "will", "the", "be", "a", "an", "in", "on", "of", "to", "after", "before",
  "next", "by", "win", "vs", "match", "round", "group", "stage", "game", "set",
  "at", "for", "and", "or", "above", "below", "over", "under", "than", "is",
  "are", "this", "that", "no", "yes", "who", "what", "which", "have", "has",
  "market", "markets", "price", "up", "down", "his", "her", "their", "it",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens. */
export function tokenize(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Numbers and 4-digit years are strong disambiguators across venues. */
function sharedNumbers(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (/^\d+$/.test(t) && b.has(t)) shared++;
  return shared;
}

export interface MatchScore {
  confidence: number; // 0..1
  sharedTokens: string[];
}

/** Similarity between two market titles, with a bonus for shared numbers. */
export function scoreMatch(a: MarketMeta, b: MarketMeta): MatchScore {
  const ta = tokenize(a.question);
  const tb = tokenize(b.question);
  const shared = [...ta].filter((t) => tb.has(t));
  const base = jaccard(ta, tb);
  const numBonus = Math.min(0.2, sharedNumbers(ta, tb) * 0.1);
  const catBonus = a.category && a.category === b.category ? 0.05 : 0;
  return { confidence: Math.min(1, base + numBonus + catBonus), sharedTokens: shared };
}

export type ArbDirection = "buy-yes-polymarket" | "buy-yes-kalshi" | "none";

export interface CrossMatch {
  /** Best available human label (Polymarket's question). */
  label: string;
  confidence: number;
  sharedTokens: string[];
  polymarket: { market: string; tokenId: string; question: string; yes: number | null; volume24hr: number | null };
  kalshi: { market: string; tokenId: string; question: string; yes: number | null; volume24hr: number | null };
  /** kalshiYes − polymarketYes, in probability terms (null if a price is missing). */
  spread: number | null;
  /** Blended fair value (volume-weighted when volumes known, else midpoint). */
  consensus: number | null;
  /** Gross theoretical edge per contract, before fees/slippage (= |spread|). */
  arbEdge: number | null;
  arbDirection: ArbDirection;
}

export interface FindOptions {
  /** Minimum confidence to surface a candidate. */
  minConfidence?: number;
  /** Minimum shared significant tokens (guards against 1-word coincidences). */
  minSharedTokens?: number;
  /** Flag arbitrage only when the gross edge clears this (covers fees/slippage). */
  arbThreshold?: number;
  limit?: number;
}

/**
 * Greedy best-match: for each Polymarket market, find its most similar Kalshi
 * market. Each Kalshi market is claimed at most once, best pair first.
 */
export function findMatches(
  polymarket: MarketMeta[],
  kalshi: MarketMeta[],
  opts: FindOptions = {},
): CrossMatch[] {
  const minConfidence = opts.minConfidence ?? 0.3;
  const minShared = opts.minSharedTokens ?? 2;
  const arbThreshold = opts.arbThreshold ?? 0.02;

  const candidates: Array<{ pm: MarketMeta; k: MarketMeta; score: MatchScore }> = [];
  for (const pm of polymarket) {
    for (const k of kalshi) {
      const score = scoreMatch(pm, k);
      if (score.confidence >= minConfidence && score.sharedTokens.length >= minShared) {
        candidates.push({ pm, k, score });
      }
    }
  }
  candidates.sort((a, b) => b.score.confidence - a.score.confidence);

  const usedPm = new Set<string>();
  const usedK = new Set<string>();
  const out: CrossMatch[] = [];
  for (const c of candidates) {
    if (usedPm.has(c.pm.market) || usedK.has(c.k.market)) continue;
    usedPm.add(c.pm.market);
    usedK.add(c.k.market);
    out.push(buildMatch(c.pm, c.k, c.score, arbThreshold));
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

function buildMatch(pm: MarketMeta, k: MarketMeta, score: MatchScore, arbThreshold: number): CrossMatch {
  const pmYes = pm.lastPrice;
  const kYes = k.lastPrice;
  const havePrices = pmYes != null && kYes != null;
  const spread = havePrices ? round(kYes! - pmYes!, 4) : null;
  const arbEdge = spread == null ? null : round(Math.abs(spread), 4);

  let arbDirection: ArbDirection = "none";
  if (spread != null && Math.abs(spread) >= arbThreshold) {
    // YES is cheaper where its price is lower: buy YES there, sell YES (buy NO)
    // on the richer venue. Profit at resolution ≈ |spread| minus fees.
    arbDirection = pmYes! < kYes! ? "buy-yes-polymarket" : "buy-yes-kalshi";
  }

  return {
    label: pm.question,
    confidence: round(score.confidence, 3),
    sharedTokens: score.sharedTokens,
    polymarket: { market: pm.market, tokenId: pm.tokenIds[0] ?? pm.market, question: pm.question, yes: pmYes, volume24hr: pm.volume24hr },
    kalshi: { market: k.market, tokenId: k.tokenIds[0] ?? k.market, question: k.question, yes: kYes, volume24hr: k.volume24hr },
    spread,
    consensus: havePrices ? round(consensus(pmYes!, kYes!, pm.volume24hr, k.volume24hr), 4) : null,
    arbEdge,
    arbDirection,
  };
}

/** Volume-weighted fair value when both volumes are known, else midpoint. */
function consensus(pmYes: number, kYes: number, pmVol: number | null, kVol: number | null): number {
  if (pmVol != null && kVol != null && pmVol + kVol > 0) {
    return (pmYes * pmVol + kYes * kVol) / (pmVol + kVol);
  }
  return (pmYes + kYes) / 2;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
