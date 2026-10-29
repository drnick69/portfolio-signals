#!/usr/bin/env node
// paper-trader.mjs v8.8 — Simulates portfolio performance following daily signals.
// Starting: $1M equally distributed across the holdings present on day one.
// Daily: $10,000 new capital. Buys the 3 buy signals, trims the trim signal.
//
// Trade rules:
//   - New cash ($10K) split: 40% to tactical buy, 35% to positional, 25% to strategic
//   - Confidence-weighted: high=100%, medium=70%, low=40% of allocation
//   - Score-magnitude-weighted: |composite| → 0.4 (weak BUY) to 1.0 (STRONG_BUY)
//     Final multiplier: pct × confidence × score_magnitude
//   - Trim: sell 3% of trim position, reduce cost_basis proportionally,
//     delete position when shares hit zero. Add proceeds to cash.
//   - Snapshot captures composite scores + LIN regime for forward validation
//   - Prices come from /tmp/signal-data.json + /tmp/market-data.json
//   - State persists in docs/history/paper-portfolio.json
//
// V7.6: One-time HOLDINGS SWAP migration on first run post-deployment.
//       ETHA → NOW. Cost basis transfers from ETHA to NOW; NOW shares
//       computed at the new symbol's current price. Cash position unchanged
//       → total portfolio value preserved at the swap moment. P&L for the
//       NOW position starts at 0% and tracks NOW going forward. Idempotent:
//       no-ops once ETHA is gone from holdings.
//
// V8.3: HOLDINGS ADD — MA + ISRG (12 → 14) via ORGANIC ENTRY. Unlike the
//       V7.6 swap, an add gets NO migration and NO seed position: the paper
//       book measures SIGNAL-FOLLOWING P&L, and the buy path already routes
//       cash exclusively to the day's assigned signals with no universe list
//       anywhere in the trading logic — so MA/ISRG become tradeable the
//       moment they first appear in assignments, entering at real signal
//       prices with honest cost basis and P&L from $0. This also keeps the
//       paper book point-in-time consistent with the benchmark scorecard's
//       membership convention (no retroactive positions). Consequences to
//       expect, all correct behavior: MA/ISRG start underweight vs the
//       incumbents and grow only as the system assigns them buys; a TRIM
//       assignment on a not-yet-held name no-ops (existing guard); the
//       equal-split initializer is unreachable for the live book and now
//       divides by the day-one holding count rather than a hardcoded 12.
//       If a rebalance-mirror of the real book is ever wanted instead, seed
//       positions require real fill dates/prices + funding trims — done as
//       a one-time migration block in the V7.6 pattern, deliberately NOT
//       built here.
//
// V8.4: HOLDINGS SWAP — IBIT → RDDT. A true swap (position sold, proceeds
//       redeployed), so it uses the V7.6 migration path rather than V8.3's
//       organic entry — but with one CORRECTED and one NEW mechanic:
//
//       (1) PROCEEDS ARE MARKET VALUE, NOT COST BASIS.
//           V7.6 computed new shares as old.cost_basis / newPrice. That
//           preserves total portfolio value ONLY when the retiring position
//           has exactly zero unrealized P&L; otherwise the book silently
//           discards the entire unrealized gain or loss at the swap moment
//           (value delta = cost_basis − market_value). The V7.6 comment
//           asserting value preservation was therefore true only in the
//           degenerate case. Since total_value feeds benchmark-scorecard's
//           TWR series, a silent step-change there propagates into every
//           downstream performance number. v8.4 sells at an exit price and
//           redeploys the ACTUAL proceeds, which preserves value for real.
//
//       (2) THE EXIT PRICE MUST BE SUPPLIED EXPLICITLY (see
//           MIGRATION_EXIT_PRICE below). The retiring symbol is removed from
//           SYMBOLS in fetch-market-data v4.16, so it is absent from
//           `normalized` and therefore from the `prices` map on migration
//           day — and per-holding prices are not stored in portfolio.history
//           (snapshots keep total_value / holdings_value only), so the last
//           IBIT price is not recoverable from state either. There is no way
//           to infer it; it has to be given.
//
//       FALLBACK BEHAVIOUR: if no exit price is available, the code falls back
//       to the V7.6 cost-basis mechanic so the pipeline still runs — but it
//       logs a loud warning naming the exact dollar discontinuity introduced,
//       and records basis_mode + value_delta_usd in the swap record so the
//       distortion is auditable in history rather than invisible. It does NOT
//       silently pretend value was preserved.
//
//       The ETHA → NOW entry is retained in the map: it is idempotent and
//       already no-ops (ETHA left holdings at V7.6), so it documents history
//       at zero cost. The corrected mechanic cannot retroactively alter it.
//
// v8.5: HOLDINGS SWAP — RDDT → MLM (Martin Marietta Materials). Same true-swap
//       path as V8.4: sell the position, redeploy the ACTUAL proceeds. Uses the
//       v8.4 market-value mechanic unchanged.
//
//       ★★ CHAIN RESOLUTION (new, and the reason this build is not a one-line
//       map edit). Adding "RDDT": "MLM" alongside the existing "IBIT": "RDDT"
//       creates the first MULTI-HOP lineage in this map: IBIT → RDDT → MLM.
//       The v8.4 loop reads HOLDINGS_MIGRATION[oldSym] literally, so a stranded
//       IBIT position would target RDDT — and RDDT was removed from SYMBOLS in
//       fetch-market-data v4.17, so prices["RDDT"] is undefined and the loop's
//       `if (!newPrice) continue` guard fires. The position would NOT be
//       double-counted (the concern that prompted this check); it would be
//       PERMANENTLY STUCK, retrying and logging a warning every run forever,
//       because its migration target can never again have a price.
//
//       resolveTerminalSymbol() walks the map to the end of the chain, so a
//       stranded IBIT migrates straight to MLM in ONE hop at a price that
//       actually exists. Verified against all four cases: live RDDT alone
//       (migrates at market value), stranded IBIT alone (resolves to MLM in
//       cost-basis fallback — loud but unstuck), BOTH present (each source
//       position is consumed exactly once and the two lineages MERGE into one
//       MLM position, so no double-count), and a hypothetical A→B→A cycle
//       (returns null rather than looping forever).
//
//       Keeping the map as true LINEAGE rather than collapsing it to
//       {"IBIT": "MLM"} is deliberate: IBIT did not become MLM, it became RDDT
//       which then became MLM, and the map is documentation as much as logic.
//       The swap record now carries a `via` field naming the intermediate hops
//       so a multi-hop migration is auditable in history rather than looking
//       like a direct swap that never happened.
//
//       ⚠ REALISTIC EXPOSURE: near zero. The IBIT → RDDT swap deployed at v8.4,
//       so no IBIT position should remain. This is a correctness guard for the
//       case where it does — and, more usefully, for the NEXT swap, which will
//       otherwise inherit the same latent stall against MLM.
//
//       ⚠ CHECK YOUR EXISTING HISTORY. MIGRATION_EXIT_PRICE["IBIT"] is still
//       null in the deployed file, which means the IBIT → RDDT swap ran in
//       COST-BASIS FALLBACK and discarded IBIT's unrealized P&L, stepping
//       total_value at that moment. Look for a swaps[] entry in
//       docs/history/paper-portfolio.json with basis_mode ===
//       "cost_basis_fallback". If it is there, the TWR series that
//       benchmark-scorecard reads already carries that discontinuity. It cannot
//       be repaired retroactively without IBIT's exit price, but it should be
//       KNOWN rather than discovered later as an unexplained kink.
//       Do not let the same thing happen to RDDT: set
//       MIGRATION_EXIT_PRICE["RDDT"] before the first post-deploy run.
//
// v8.6: HOLDINGS SWAP — PBR.A → UBER (Uber Technologies). Same true-swap path
//       as V8.4/v8.5: sell the position at its exit price, redeploy the ACTUAL
//       proceeds into UBER at the run's price. Mechanic unchanged; this build is
//       the map entry, the exit price, and a correction to the record.
//
//       A NEW, INDEPENDENT LINEAGE — no chain. PBR.A → UBER; UBER is not a key,
//       so resolveTerminalSymbol() returns UBER in one hop with via = [].
//
//       EXIT PRICE: 19.6 (decision 2026-10-27), SET IN THIS FILE — not as a
//       follow-up edit (see the correction below for why that matters). The
//       live book holds 10,897.8762 PBR.A shares at a 180,438.54 cost basis
//       (avg 16.5572). At 19.6 the position exits for 213,598.37, REALIZING A
//       GAIN of 33,159.83 (+18.4%) against cost. Direction is the usual one,
//       and the opposite of RDDT's: cost-basis fallback here would have
//       redeployed only 180,438.54 and silently DISCARDED that gain.
//
//       ★★ CORRECTION TO THE v8.5 RECORD. The v8.5 note at MIGRATION_EXIT_PRICE
//       said setting "RDDT": 150 "reduces recorded book value by ~22.8k". That
//       never happened. v8.5 was committed 2026-08-20 23:10 EDT with RDDT still
//       null; the pipeline run that committed at 00:12 EDT executed RDDT → MLM
//       in COST-BASIS FALLBACK (paper-portfolio.json swaps[] for 2026-08-21:
//       exit_price null, basis_mode "cost_basis_fallback", proceeds 365,238.48).
//       "RDDT": 150 was committed at 11:04 EDT, ~11 hours AFTER the one-time
//       swap had run, and has never executed. So BOTH prior true swaps ran in
//       fallback: IBIT → RDDT (2026-08-05, discarded P&L unknown) and
//       RDDT → MLM (2026-08-21, flattering the book by ~22.8k at the 150 mark).
//       MLM's 365,238.48 cost basis therefore carries RDDT's break-even fiction
//       forward. Not repairable from this file — the swaps are one-time and
//       already consumed — but it should be known, not rediscovered.
//
//       ⚠⚠ DEPLOY THIS FILE IN THE SAME COMMIT AS fetch-market-data v4.19.
//       v4.19 removes PBR.A from SYMBOLS, so from its first run PBR.A has no
//       price. The valuation loop below skips any holding without a price, so
//       under v8.5 (no PBR.A map entry) the ~$214k PBR.A position would drop
//       out of total_value on every run — a phantom drawdown in the series
//       benchmark-scorecard reads — until this file landed. This is not
//       hypothetical: on 2026-08-04 IBIT was still held but no longer priced
//       (the swap only executed on the 2026-08-05 run), and TMO also failed
//       scoring that day; both dropped out of total_value, which fell
//       2,123,851 → 1,528,114 and recovered on 2026-08-05.
//       Landing this file EARLIER than the rest is harmless: the migration
//       needs a UBER price, which does not exist until generate-signals v8.6.0
//       scores UBER, so until then it logs "UBER price unavailable" and
//       retries, and the book is otherwise untouched. Landing it LATER is not.
//
// v8.7: LAST-KNOWN-PRICE MARKS — an unpriced holding is no longer dropped from
//       total_value. Builds on v8.6 (the PBR.A → UBER swap is unchanged).
//
//       THE DEFECT. The valuation loop skipped any holding without a price in
//       today's signal data. A holding goes unpriced whenever it fails scoring
//       (a partial run) or has been retired from SYMBOLS but not yet migrated,
//       and on every such day its whole market value vanished from
//       total_value, then reappeared the next day. Through 2026-10-28 that had
//       happened on 23 days — e.g. 2026-08-04, −$595,737, and 2026-10-22,
//       −$170,230 — each a phantom drawdown in the series benchmark-scorecard
//       reads as the signal leg. (The scorecard's own equal-weight leg already
//       carries forward last known prices, so the two legs were not even
//       measured the same way on those days.)
//
//       THE FIX. Each priced run now stores last_price / last_price_date on the
//       holding. An unpriced holding is marked at, in order: its stored
//       last_price; else its most recent price in docs/history/daily-log.jsonl
//       (which seeds holdings that predate this version — log-signals runs
//       before this script, so the log is current); else, with no price
//       anywhere, it is still excluded, as before, and named in the log and in
//       the snapshot's `unpriced` list. Every carried mark is recorded in the
//       snapshot's `stale_marks` { symbol: { price, as_of, source } }, so a
//       carried day is auditable, not just smoothed. Trades never execute on a
//       carried price — buys and trims still require today's price.
//
//       THE SAME FIX FOR SWAPS. A retiring position with no MIGRATION_EXIT_PRICE
//       and no price today used to fall straight to the cost-basis fallback
//       that silently re-marked IBIT and RDDT at break-even. It now exits at its
//       last known price first (basis_mode "last_known_price", with
//       exit_price_source / exit_price_as_of on the swap record). Cost-basis
//       fallback now only happens when no price for the position exists anywhere.
//       An explicit MIGRATION_EXIT_PRICE still wins, so PBR.A still exits at 19.6.
//
//       HISTORY IS NOT REWRITTEN. The 23 recorded phantom drops stay in
//       paper-portfolio.json as they were logged; this fixes every day from
//       deploy forward. Restating them would mean reconstructing past share
//       counts from the trade log and re-pricing from daily-log.jsonl — a
//       separate, deliberate step if wanted.
//
// v8.8: HOLDINGS SWAP — ENB → CVX (Chevron). BUILT ON v8.7 (v8.6's PBR.A → UBER
//       plus v8.7's last-known-price marks): everything above lives in this
//       file, so v8.8 supersedes v8.7 — deploy this one, not both. Same
//       true-swap path and mechanic as v8.4–v8.7; this build is the map entry
//       and the exit price, nothing else.
//
//       A NEW, INDEPENDENT LINEAGE — no chain. ENB → CVX; CVX is not a key, so
//       resolveTerminalSymbol() returns CVX in one hop with via = []. If both
//       swaps run on the same first post-deploy run, each source position is
//       consumed exactly once and they land in two separate positions.
//
//       EXIT PRICE: 48.26 (decision 2026-10-27), SET IN THIS FILE, per the v8.6
//       rule; as an override it outranks the v8.7 last-known-price fallback. As
//       of the 2026-10-28 book the position is 780.7905 ENB shares at a
//       39,337.18 cost basis (avg 50.3812). At 48.26 it exits for 37,680.95,
//       REALIZING A LOSS of 1,656.23 (−4.2%) against cost. ⚠ The direction is RDDT's, not PBR.A's: cost-basis
//       fallback would have redeployed the full 39,337.18 and silently
//       FLATTERED the book by pretending ENB exited at break-even. 48.26 is
//       below ENB's last logged price (48.70 on 2026-10-28), so the swap also
//       marks the position ~0.9% under its last valuation; that is the decided
//       exit, not an error. (If a trim or buy changes the ENB position before
//       the swap runs, the swap sells whatever is held then; only the price is
//       fixed here.)
//
//       ⚠ DEPLOY THIS FILE IN THE SAME COMMIT AS fetch-market-data v4.20, which
//       supersedes v4.19 and removes BOTH PBR.A and ENB from SYMBOLS. Under the
//       v8.7 carry-forward a late landing no longer drops either position out
//       of total_value — each would be marked at its last known price — but
//       neither swap executes until this file is live, so the book would sit
//       holding two retired names at stale marks. Landing this file EARLIER
//       than the rest is harmless: each migration waits, logging "<symbol>
//       price unavailable", until generate-signals v8.7.0 scores UBER and CVX.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

mkdirSync("docs/history", { recursive: true });

const PORTFOLIO_PATH = "docs/history/paper-portfolio.json";
const INITIAL_CAPITAL = 1_000_000;
const DAILY_DEPOSIT = 10_000;
const TRIM_PCT = 0.03; // sell 3% of trim position each day

// ── Confidence-weighted allocation multipliers ──────────────────────────────
const CONFIDENCE_MULTIPLIER = { high: 1.0, medium: 0.7, low: 0.4 };

function getConfidenceMultiplier(signalData, symbol) {
  const holding = (signalData.normalized || []).find(s => s.symbol === symbol);
  const level = holding?.confidence?.level || "medium";
  return CONFIDENCE_MULTIPLIER[level] || 0.7;
}

// ── V3: Score-magnitude weighting — stronger signals get more capital ───────
function getScoreMagnitude(signalData, symbol) {
  const holding = (signalData.normalized || []).find(s => s.symbol === symbol);
  const score = holding?.composite?.score;
  if (score == null) return 0.7;
  return Math.max(0.4, Math.min(1.0, (Math.abs(score) - 20) / 40));
}

// ── V3: Pull composite metadata for trade-log enrichment ───────────────────
function getSignalContext(signalData, symbol) {
  const h = (signalData.normalized || []).find(s => s.symbol === symbol);
  return {
    composite_score: h?.composite?.score ?? null,
    recommendation: h?.composite?.recommendation ?? null,
    regime: h?.regime ?? null,
    regime_pmi: h?.regime_pmi ?? null,
  };
}

// ─── LOAD DATA ──────────────────────────────────────────────────────────────
let signalData, marketData;
try {
  signalData = JSON.parse(readFileSync("/tmp/signal-data.json", "utf-8"));
  marketData = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8"));
} catch (e) {
  console.error("Cannot read signal/market data:", e.message);
  process.exit(1);
}

const { normalized, assignments, timestamp } = signalData;
const date = new Date(timestamp).toISOString().split("T")[0];
const dayOfWeek = new Date(timestamp).getUTCDay();

// ─── MARKET CALENDAR CHECK ──────────────────────────────────────────────────
const HOLIDAYS_2026 = [
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
];
const HOLIDAYS_2027 = [
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26",
  "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
  "2027-11-25", "2027-12-24",
];
const ALL_HOLIDAYS = new Set([...HOLIDAYS_2026, ...HOLIDAYS_2027]);

const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
const isHoliday = ALL_HOLIDAYS.has(date);

if (isWeekend || isHoliday) {
  console.log(`Paper Trader: ${date} is ${isWeekend ? "a weekend" : "a market holiday"} — skipping trades.`);
  if (existsSync(PORTFOLIO_PATH)) {
    const portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));
    writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));
    console.log(`Portfolio preserved at $${portfolio.total_value?.toLocaleString() || "?"}`);
  }
  process.exit(0);
}

// Build price map
const prices = {};
for (const s of normalized) {
  if (s.price?.current) prices[s.symbol] = s.price.current;
}

console.log("Paper Trader");
console.log("============");
console.log(`Date: ${date}`);
console.log(`Prices: ${Object.keys(prices).length}/${normalized.length}`);

// ─── LAST-KNOWN PRICES (v8.7) ───────────────────────────────────────────────
// Used ONLY to mark an unpriced holding (valuation) or a retiring position
// with no exit price (swaps). Never used to trade.
const DAILY_LOG_PATH = "docs/history/daily-log.jsonl";
let loggedPriceCache = null;
function lastLoggedPrices() {
  if (loggedPriceCache) return loggedPriceCache;
  loggedPriceCache = {};
  if (!existsSync(DAILY_LOG_PATH)) return loggedPriceCache;
  for (const line of readFileSync(DAILY_LOG_PATH, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e?.date || !Array.isArray(e.holdings)) continue;
    for (const lh of e.holdings) {
      const p = typeof lh?.price === "number" ? lh.price : lh?.price?.current;
      // Later entries overwrite earlier ones, so each symbol ends on its most
      // recent logged price — the log is appended in date order.
      if (lh?.symbol && typeof p === "number" && p > 0) loggedPriceCache[lh.symbol] = { price: p, as_of: e.date, source: "daily_log" };
    }
  }
  return loggedPriceCache;
}
function lastKnownMark(sym, h) {
  if (h?.last_price > 0) return { price: h.last_price, as_of: h.last_price_date ?? null, source: "last_price" };
  return lastLoggedPrices()[sym] ?? null;
}

// ─── LOAD OR INITIALIZE PORTFOLIO ───────────────────────────────────────────
let portfolio;
if (existsSync(PORTFOLIO_PATH)) {
  portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));
  console.log(`Portfolio loaded: day ${portfolio.day_count + 1}, $${portfolio.total_value?.toFixed(0) || "?"}`);
} else {
  // V8.3: divide by the day-one holding count (was a hardcoded 12) — this
  // branch only runs when no portfolio file exists, so it is unreachable for
  // the live book; corrected for a hypothetical re-initialization at 14.
  const perHolding = INITIAL_CAPITAL / normalized.length;
  const holdings = {};
  for (const s of normalized) {
    const price = prices[s.symbol];
    if (!price) continue;
    const shares = perHolding / price;
    holdings[s.symbol] = {
      shares: +shares.toFixed(4),
      cost_basis: perHolding,
      avg_price: price,
    };
  }
  portfolio = {
    start_date: date,
    day_count: 0,
    cash: 0,
    total_deposited: INITIAL_CAPITAL,
    holdings,
    history: [],
  };
  console.log(`Portfolio initialized: $${INITIAL_CAPITAL.toLocaleString()} across ${Object.keys(holdings).length} holdings`);
}

// ─── CHECK FOR DUPLICATE DAY ────────────────────────────────────────────────
if (portfolio.history.some(h => h.date === date)) {
  console.log(`Already traded on ${date} — skipping.`);
  writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));
  process.exit(0);
}

// ─── HOLDINGS SWAP (one-time migrations) ────────────────────────────────────
// V7.6: ETHA → NOW (already executed; entry retained, no-ops).
// V8.4: IBIT → RDDT (executed 2026-08-05, cost-basis fallback).
// v8.5: RDDT → MLM (executed 2026-08-21, cost-basis fallback — see v8.6 note).
// v8.6: PBR.A → UBER.
// v8.8: ENB → CVX.
//
// Mechanic (v8.4, corrected): the retiring position is SOLD at its exit price
// and the proceeds are redeployed into the new symbol at today's price. Cash
// is untouched, so total portfolio value is genuinely preserved across the
// swap. The new position's cost basis IS the proceeds, so its P&L starts at 0%
// and tracks the new symbol forward — same intent as V7.6, but now actually
// value-neutral rather than value-neutral-only-if-unrealized-P&L-is-zero.
//
// Why an exit price must be supplied: the retiring symbol is gone from
// fetch-market-data's SYMBOLS by the time this runs, so it is absent from
// `prices`, and portfolio.history snapshots never stored per-holding prices.
// The price is unrecoverable from state and cannot be inferred.
//
// Idempotent: each entry no-ops once the old symbol is out of portfolio.holdings.
// Safe to leave in indefinitely — removable after one successful run.
// Entries are LINEAGE, not shortcuts: each records what a symbol actually
// became at the time. Chains are resolved at run time by
// resolveTerminalSymbol(), so IBIT → RDDT → MLM lands on MLM in one hop.
const HOLDINGS_MIGRATION = { "ETHA": "NOW", "IBIT": "RDDT", "RDDT": "MLM", "PBR.A": "UBER", "ENB": "CVX" };

// ── CHAIN RESOLUTION (v8.5) ─────────────────────────────────────────────────
// Follow a migration chain to its terminal symbol. Necessary because a
// multi-hop lineage points intermediate symbols at targets that have since been
// retired from SYMBOLS and therefore have no price — which would strand the
// position rather than migrate it. Returns null on a cycle.
function resolveTerminalSymbol(sym) {
  let cur = sym;
  const seen = new Set();
  const hops = [];
  while (HOLDINGS_MIGRATION[cur] != null) {
    if (seen.has(cur)) {
      console.log(`  ⚠ Migration cycle detected starting at ${sym} (${[...seen].join(" → ")}) — refusing to migrate.`);
      return { terminal: null, hops };
    }
    seen.add(cur);
    cur = HOLDINGS_MIGRATION[cur];
    hops.push(cur);
  }
  return { terminal: cur, hops };
}

// ── EXIT PRICES FOR RETIRING SYMBOLS (v8.4) ─────────────────────────────────
// The price at which the retiring position is sold. REQUIRED for value-neutral
// migration; see the note above for why it cannot be derived automatically.
// Set to the retiring symbol's market price on the swap date.
//
// ⚠⚠ THE EXIT PRICE MUST BE IN THE DEPLOY COMMIT, NEVER A FOLLOW-UP EDIT.
//   The swap is ONE-TIME: it runs on the first pipeline run after deploy and
//   then no-ops forever. An exit price committed after that run changes
//   nothing. That is exactly how RDDT → MLM ran in cost-basis fallback on
//   2026-08-21 despite "RDDT": 150 below (see the v8.6 header note).
//   PBR.A's price (v8.6) and ENB's (v8.8) are set below, each in the same file
//   that adds its map entry.
//
// Settled entries — documentation of what ran, not live settings:
//   • IBIT: null — IBIT → RDDT executed 2026-08-05 in cost-basis fallback.
//   • RDDT: 150 — NEVER EXECUTED. Committed ~11h after RDDT → MLM had already
//     run in fallback; the swaps[] record shows exit_price null. Kept so the
//     intended mark (and the ~22.8k it would have taken off the book) stays
//     on record.
//   • ETHA is intentionally absent: that migration executed at V7.6 under the
//     old mechanic and no-ops now. Adding a price here could not change it.
const MIGRATION_EXIT_PRICE = {
  "IBIT": null,   // executed at v8.4 in fallback mode; no longer settable
  // ⚠ NOTE THE DIRECTION HERE — it is the opposite of the usual case. The live
  // book holds 2283.1686 RDDT shares at a 365,238.48 cost basis (avg 159.97).
  // At 150 the position exits for 342,475.29, which REALIZES A LOSS OF
  // 22,763.19 against cost. Cost-basis fallback would have redeployed the full
  // 365,238.48 — i.e. it would have silently FLATTERED the book by pretending
  // RDDT exited at break-even. Setting a real exit price here reduces recorded
  // book value by ~22.8k, and that is the correct, honest mark.
  "RDDT": 150,    // NEVER EXECUTED — swap ran in fallback before this was committed
  // v8.6: the live book holds 10,897.8762 PBR.A shares at a 180,438.54 cost
  // basis (avg 16.5572). At 19.6 the position exits for 213,598.37, REALIZING A
  // GAIN of 33,159.83 (+18.4%) against cost — the gain cost-basis fallback
  // would have silently discarded.
  "PBR.A": 19.6,  // exit price, decision 2026-10-27 — live, executes on the first post-deploy run
  // v8.8: as of the 2026-10-28 book, 780.7905 ENB shares at a 39,337.18 cost
  // basis (avg 50.3812). At 48.26 the position exits for 37,680.95, REALIZING A
  // LOSS of 1,656.23 (−4.2%) against cost — the loss cost-basis fallback would
  // have silently hidden.
  "ENB": 48.26,   // exit price, decision 2026-10-27 — live, executes on the first post-deploy run
};

const swaps = [];
for (const oldSym of Object.keys(HOLDINGS_MIGRATION)) {
  const old = portfolio.holdings[oldSym];
  if (!old || old.shares <= 0) continue;

  // v8.5: resolve to the END of the chain, not the next hop. An intermediate
  // hop's symbol may have been retired from SYMBOLS and therefore have no
  // price, which would strand the position instead of migrating it.
  const { terminal: newSym, hops } = resolveTerminalSymbol(oldSym);
  if (!newSym || newSym === oldSym) continue;
  const viaHops = hops.slice(0, -1);   // intermediate symbols, terminal excluded

  const newPrice = prices[newSym];
  if (!newPrice) {
    console.log(`  ⚠ Cannot migrate ${oldSym} → ${newSym}: ${newSym} price unavailable today; will retry next run.`);
    continue;
  }
  if (viaHops.length > 0) {
    console.log(`  ↳ ${oldSym} is a MULTI-HOP lineage (${oldSym} → ${viaHops.join(" → ")} → ${newSym}); migrating direct to ${newSym}.`);
  }

  // Exit price precedence: explicit override, then today's price map (present
  // only if the retiring symbol somehow still scores), then — v8.7 — the
  // position's last known price, and only then no price at all.
  const override  = MIGRATION_EXIT_PRICE[oldSym] ?? null;
  const lastMark  = override == null && prices[oldSym] == null ? lastKnownMark(oldSym, old) : null;
  const exitPrice = override ?? prices[oldSym] ?? lastMark?.price ?? null;
  const exitPriceSource = override != null ? "override" : prices[oldSym] != null ? "today" : lastMark ? lastMark.source : null;
  const exitPriceAsOf   = override != null ? null : prices[oldSym] != null ? date : (lastMark?.as_of ?? null);

  // Proceeds = what the position is actually WORTH at exit. Falling back to
  // cost basis discards unrealized P&L and steps total_value by exactly that
  // amount — tolerated so the pipeline never blocks, but never silent.
  const marketValue = exitPrice != null ? +(old.shares * exitPrice).toFixed(2) : null;
  const proceeds = marketValue != null ? marketValue : old.cost_basis;
  const basisMode = marketValue == null ? "cost_basis_fallback" : lastMark ? "last_known_price" : "market_value";
  if (basisMode === "last_known_price") {
    console.log(`  ⚠ ${oldSym} → ${newSym}: no MIGRATION_EXIT_PRICE and no price today — exiting at last known $${exitPrice} (${exitPriceAsOf}, ${exitPriceSource}).`);
    console.log(`  ⚠ Value-preserving at that mark; set MIGRATION_EXIT_PRICE["${oldSym}"] if the real exit differed.`);
  }
  // In fallback mode the discarded P&L is UNKNOWABLE — computing it requires
  // the exit price, whose absence is the reason we are in fallback at all.
  // Record null, never 0: a zero here would assert "nothing was lost", which
  // is exactly the false reassurance this whole branch exists to avoid.
  const discardedPnl = marketValue != null ? 0 : null;

  if (basisMode === "cost_basis_fallback") {
    console.log(`  ⚠ ${oldSym} → ${newSym}: NO EXIT PRICE SUPPLIED.`);
    console.log(`  ⚠ Falling back to the V7.6 cost-basis mechanic: redeploying $${old.cost_basis.toFixed(2)} of cost basis`);
    console.log(`  ⚠ rather than ${old.shares} ${oldSym} shares valued at market. Any unrealized P&L on the`);
    console.log(`  ⚠ ${oldSym} position is DISCARDED — by an amount that cannot be computed here, since`);
    console.log(`  ⚠ doing so needs the very exit price that is missing — stepping total_value and putting a`);
    console.log(`  ⚠ discontinuity into the TWR series benchmark-scorecard reads.`);
    console.log(`  ⚠ FIX: set MIGRATION_EXIT_PRICE["${oldSym}"] to its market price on the swap date and re-run.`);
  }

  const newShares = +(proceeds / newPrice).toFixed(4);
  const existing = portfolio.holdings[newSym];
  if (existing) {
    // Already a position in the new symbol — merge proceeds into cost basis.
    existing.shares = +(existing.shares + newShares).toFixed(4);
    existing.cost_basis = +(existing.cost_basis + proceeds).toFixed(2);
    existing.avg_price = existing.shares > 0 ? +(existing.cost_basis / existing.shares).toFixed(4) : 0;
  } else {
    portfolio.holdings[newSym] = {
      shares: newShares,
      cost_basis: proceeds,
      avg_price: newPrice,
    };
  }
  delete portfolio.holdings[oldSym];
  swaps.push({
    from: oldSym,
    to: newSym,
    // v8.5: intermediate hops for a multi-hop lineage (empty for a direct
    // swap). Without this a chained migration would look in history like a
    // direct IBIT → MLM swap, which never happened.
    via: viaHops,
    old_shares: old.shares,
    old_cost_basis: old.cost_basis,
    old_avg_price: old.avg_price ?? null,
    exit_price: exitPrice,
    exit_price_source: exitPriceSource,    // v8.7: "override" | "today" | "last_price" | "daily_log" | null
    exit_price_as_of: exitPriceAsOf,       // v8.7
    proceeds,
    basis_mode: basisMode,                 // "market_value" | "last_known_price" (v8.7) | "cost_basis_fallback"
    unrealized_pnl_discarded_usd: discardedPnl,   // null in fallback = unknown, NOT zero
    new_shares: newShares,
    new_price: newPrice,
  });
  const modeStr = basisMode !== "cost_basis_fallback"
    ? `sold ${old.shares} @ $${exitPrice.toFixed(2)} = $${proceeds.toFixed(0)} proceeds${basisMode === "last_known_price" ? ` (last known, ${exitPriceAsOf})` : ""}`
    : `$${proceeds.toFixed(0)} cost basis (FALLBACK — no price anywhere)`;
  console.log(`  🔄 SWAP ${oldSym} → ${newSym}: ${modeStr} → ${newShares} ${newSym} shares @ $${newPrice.toFixed(2)}`);
}

// ─── EXECUTE TRADES ─────────────────────────────────────────────────────────
portfolio.day_count++;
portfolio.cash += DAILY_DEPOSIT;
portfolio.total_deposited += DAILY_DEPOSIT;

const trades = [];

// 1. TRIM: sell 3% of the weakest position
if (assignments.trim && portfolio.holdings[assignments.trim]) {
  const sym = assignments.trim;
  const h = portfolio.holdings[sym];
  const price = prices[sym];
  if (price && h.shares > 0) {
    const sellShares = +(h.shares * TRIM_PCT).toFixed(4);
    const proceeds = +(sellShares * price).toFixed(2);
    const fraction = sellShares / h.shares;
    const cbReduction = +(h.cost_basis * fraction).toFixed(2);

    h.shares = +(h.shares - sellShares).toFixed(4);
    h.cost_basis = +(h.cost_basis - cbReduction).toFixed(2);
    portfolio.cash += proceeds;

    const ctx = getSignalContext(signalData, sym);
    trades.push({ type: "TRIM", symbol: sym, shares: -sellShares, price, value: proceeds, ...ctx });

    if (h.shares <= 0.0001 || h.cost_basis <= 0.01) {
      delete portfolio.holdings[sym];
      console.log(`  ✂️ TRIM ${sym}: sold ${sellShares} shares @ $${price.toFixed(2)} = $${proceeds.toFixed(0)} → POSITION CLOSED${ctx.composite_score != null ? ` [score: ${ctx.composite_score}]` : ""}`);
    } else {
      h.avg_price = +(h.cost_basis / h.shares).toFixed(4);
      console.log(`  ✂️ TRIM ${sym}: sold ${sellShares} shares @ $${price.toFixed(2)} = $${proceeds.toFixed(0)}${ctx.composite_score != null ? ` [score: ${ctx.composite_score}]` : ""}`);
    }
  }
}

// 2. BUY: allocate new cash to the 3 buy signals
const buyAllocations = [
  { key: "tacticalBuy",   pct: 0.40, label: "⚡ TAC" },
  { key: "positionalBuy", pct: 0.35, label: "📐 POS" },
  { key: "strategicBuy",  pct: 0.25, label: "🏗️ STR" },
];

const availableCash = portfolio.cash;
for (const { key, pct, label } of buyAllocations) {
  const sym = assignments[key];
  if (!sym || !prices[sym]) continue;

  const confMult  = getConfidenceMultiplier(signalData, sym);
  const scoreMult = getScoreMagnitude(signalData, sym);
  const amount = +(availableCash * pct * confMult * scoreMult).toFixed(2);
  const price = prices[sym];
  const shares = +(amount / price).toFixed(4);

  if (!portfolio.holdings[sym]) {
    portfolio.holdings[sym] = { shares: 0, cost_basis: 0, avg_price: 0 };
  }
  const h = portfolio.holdings[sym];
  h.shares = +(h.shares + shares).toFixed(4);
  h.cost_basis = +(h.cost_basis + amount).toFixed(2);
  h.avg_price = h.shares > 0 ? +(h.cost_basis / h.shares).toFixed(4) : 0;
  portfolio.cash = +(portfolio.cash - amount).toFixed(2);

  const ctx = getSignalContext(signalData, sym);
  trades.push({
    type: "BUY", signal: label, symbol: sym, shares, price, value: amount,
    confidence: confMult, score_magnitude: scoreMult,
    ...ctx,
  });
  console.log(`  ${label} BUY ${sym}: ${shares} shares @ $${price.toFixed(2)} = $${amount.toFixed(0)} [conf: ${confMult}, score_mag: ${scoreMult.toFixed(2)}${ctx.composite_score != null ? `, composite: ${ctx.composite_score}` : ""}${ctx.regime ? `, regime: ${ctx.regime}` : ""}]`);
}

// ─── COMPUTE PORTFOLIO VALUE ────────────────────────────────────────────────
let holdingsValue = 0;
const holdingSummary = [];
const staleMarks = {};   // v8.7: holdings marked at a carried (not today's) price
const unpriced = [];     // v8.7: holdings with no price anywhere — still excluded
for (const [sym, h] of Object.entries(portfolio.holdings)) {
  let price = prices[sym];
  if (price) {
    h.last_price = price;            // v8.7: remembered for any later unpriced day
    h.last_price_date = date;
  } else {
    const mark = lastKnownMark(sym, h);
    if (!mark) {
      unpriced.push(sym);
      console.log(`  ⚠ ${sym}: no price today and none on record — EXCLUDED from total_value.`);
      continue;
    }
    price = mark.price;
    staleMarks[sym] = { price: mark.price, as_of: mark.as_of, source: mark.source };
    console.log(`  ⚠ ${sym}: not priced today — marked at last known $${mark.price} (${mark.as_of}, ${mark.source}).`);
  }
  const mktValue = +(h.shares * price).toFixed(2);
  const pnl = +(mktValue - h.cost_basis).toFixed(2);
  const pnlPct = h.cost_basis > 0 ? +((pnl / h.cost_basis) * 100).toFixed(2) : 0;
  holdingsValue += mktValue;
  holdingSummary.push({ symbol: sym, shares: h.shares, price, mktValue, costBasis: h.cost_basis, pnl, pnlPct, stale: !!staleMarks[sym] });
}

const totalValue = +(holdingsValue + portfolio.cash).toFixed(2);
const totalPnl = +(totalValue - portfolio.total_deposited).toFixed(2);
const totalPnlPct = +((totalPnl / portfolio.total_deposited) * 100).toFixed(2);

portfolio.total_value = totalValue;

// Daily snapshot for history
const composite_scores = {};
const regimes = {};
for (const h of (normalized || [])) {
  if (h?.composite?.score != null) composite_scores[h.symbol] = h.composite.score;
  if (h?.regime) regimes[h.symbol] = h.regime;
}

const snapshot = {
  date,
  day: portfolio.day_count,
  total_value: totalValue,
  total_deposited: portfolio.total_deposited,
  cash: portfolio.cash,
  holdings_value: +holdingsValue.toFixed(2),
  pnl: totalPnl,
  pnl_pct: totalPnlPct,
  trades,
  assignments: { ...assignments },
  composite_scores,
  ...(Object.keys(regimes).length > 0 ? { regimes } : {}),
  ...(swaps.length > 0 ? { swaps } : {}),                  // ← V7.6: only present on migration day
  ...(Object.keys(staleMarks).length > 0 ? { stale_marks: staleMarks } : {}),   // ← v8.7: only on carried-mark days
  ...(unpriced.length > 0 ? { unpriced } : {}),                                // ← v8.7: only if something had no price anywhere
};
portfolio.history.push(snapshot);

// ─── SAVE ───────────────────────────────────────────────────────────────────
writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));

// ─── REPORT ─────────────────────────────────────────────────────────────────
console.log(`\n─── PORTFOLIO SUMMARY (Day ${portfolio.day_count}) ───`);
console.log(`  Total Value:    $${totalValue.toLocaleString()}`);
console.log(`  Total Deposited: $${portfolio.total_deposited.toLocaleString()}`);
console.log(`  P&L:            $${totalPnl.toLocaleString()} (${totalPnlPct}%)`);
console.log(`  Cash:           $${portfolio.cash.toFixed(0)}`);
console.log(`  Holdings:       $${holdingsValue.toFixed(0)} across ${holdingSummary.length} positions`);
console.log("");

holdingSummary.sort((a, b) => b.mktValue - a.mktValue);
console.log("  POSITION BREAKDOWN:");
for (const h of holdingSummary) {
  const pnlSign = h.pnl >= 0 ? "+" : "";
  const pct = ((h.mktValue / holdingsValue) * 100).toFixed(1);
  console.log(`    ${h.symbol.padEnd(7)} ${h.shares.toFixed(1).padStart(8)} sh @ $${h.price.toFixed(2).padStart(8)}${h.stale ? "*" : " "}= $${h.mktValue.toFixed(0).padStart(9)}  (${pct}%)  P&L: ${pnlSign}$${h.pnl.toFixed(0)} (${pnlSign}${h.pnlPct}%)`);
}

if (Object.keys(staleMarks).length > 0) console.log("    * marked at last known price (not priced today) — see stale_marks in today's snapshot");
console.log("\n✓ Paper portfolio updated");
