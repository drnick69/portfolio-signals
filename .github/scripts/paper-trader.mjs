#!/usr/bin/env node
// paper-trader.mjs v8.5 — Simulates portfolio performance following daily signals.
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
// V8.4: IBIT → RDDT.
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
const HOLDINGS_MIGRATION = { "ETHA": "NOW", "IBIT": "RDDT", "RDDT": "MLM" };

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
// ⚠⚠ RDDT IS CURRENTLY null — SET IT BEFORE THE FIRST POST-DEPLOY RUN.
//   This matters more than the IBIT entry ever did. IBIT was already gone by
//   the time its price was needed; RDDT is a LIVE position with real unrealized
//   P&L, and leaving this null means the swap runs in COST-BASIS FALLBACK and
//   discards that P&L, stepping total_value and putting a kink into the TWR
//   series benchmark-scorecard reads. The code will warn loudly and record
//   basis_mode in history, but it cannot recover the number afterwards.
//   Set it to RDDT's market price on the swap date.
//
// ⚠ IBIT remains null. That swap has already executed (v8.4), so this value can
//   no longer change anything — but its nullness is why the historical record
//   likely shows basis_mode "cost_basis_fallback" for IBIT → RDDT. Left in
//   place as documentation of that, not as a live setting.
//
// ETHA is intentionally absent: that migration already executed at V7.6 under
// the old mechanic and no-ops now. Adding a price here could not change it.
const MIGRATION_EXIT_PRICE = {
  "IBIT": null,   // executed at v8.4 in fallback mode; no longer settable
  "RDDT": null,   // ← ⚠ SET THIS to RDDT's market price on the swap date
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
  // only if the retiring symbol somehow still scores), then no price at all.
  const exitPrice = MIGRATION_EXIT_PRICE[oldSym] ?? prices[oldSym] ?? null;

  // Proceeds = what the position is actually WORTH at exit. Falling back to
  // cost basis discards unrealized P&L and steps total_value by exactly that
  // amount — tolerated so the pipeline never blocks, but never silent.
  const marketValue = exitPrice != null ? +(old.shares * exitPrice).toFixed(2) : null;
  const proceeds = marketValue != null ? marketValue : old.cost_basis;
  const basisMode = marketValue != null ? "market_value" : "cost_basis_fallback";
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
    proceeds,
    basis_mode: basisMode,                 // "market_value" | "cost_basis_fallback"
    unrealized_pnl_discarded_usd: discardedPnl,   // null in fallback = unknown, NOT zero
    new_shares: newShares,
    new_price: newPrice,
  });
  const modeStr = basisMode === "market_value"
    ? `sold ${old.shares} @ $${exitPrice.toFixed(2)} = $${proceeds.toFixed(0)} proceeds`
    : `$${proceeds.toFixed(0)} cost basis (FALLBACK — no exit price)`;
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
for (const [sym, h] of Object.entries(portfolio.holdings)) {
  const price = prices[sym];
  if (!price) continue;
  const mktValue = +(h.shares * price).toFixed(2);
  const pnl = +(mktValue - h.cost_basis).toFixed(2);
  const pnlPct = h.cost_basis > 0 ? +((pnl / h.cost_basis) * 100).toFixed(2) : 0;
  holdingsValue += mktValue;
  holdingSummary.push({ symbol: sym, shares: h.shares, price, mktValue, costBasis: h.cost_basis, pnl, pnlPct });
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
  console.log(`    ${h.symbol.padEnd(7)} ${h.shares.toFixed(1).padStart(8)} sh @ $${h.price.toFixed(2).padStart(8)} = $${h.mktValue.toFixed(0).padStart(9)}  (${pct}%)  P&L: ${pnlSign}$${h.pnl.toFixed(0)} (${pnlSign}${h.pnlPct}%)`);
}

console.log("\n✓ Paper portfolio updated");
