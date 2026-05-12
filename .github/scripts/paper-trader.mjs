#!/usr/bin/env node
// paper-trader.mjs v7.5 — Simulates portfolio performance following daily signals.
// Starting: $1M equally distributed across 12 holdings.
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
// V7.5: One-time HOLDINGS SWAP migration on first run post-deployment.
//       MOS → LHX and SPY → TMO. Cost basis transfers to the new symbol;
//       shares recomputed at the new symbol's current price. Cash position
//       unchanged → total portfolio value preserved at the swap moment.
//       P&L for the new positions starts at 0% and tracks LHX/TMO going
//       forward. Idempotent: no-ops once MOS/SPY are gone from holdings.

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
console.log(`Prices: ${Object.keys(prices).length}/12`);

// ─── LOAD OR INITIALIZE PORTFOLIO ───────────────────────────────────────────
let portfolio;
if (existsSync(PORTFOLIO_PATH)) {
  portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));
  console.log(`Portfolio loaded: day ${portfolio.day_count + 1}, $${portfolio.total_value?.toFixed(0) || "?"}`);
} else {
  const perHolding = INITIAL_CAPITAL / 12;
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

// ─── V7.5 HOLDINGS SWAP (one-time migration) ────────────────────────────────
// MOS → LHX, SPY → TMO. Cost basis transfers; shares recomputed at the new
// symbol's current price. Cash unchanged, so total portfolio value is preserved
// at the swap moment. P&L resets to 0% for the new positions and tracks the
// new tickers going forward.
// Idempotent: no-ops once MOS/SPY are no longer present in portfolio.holdings.
// Safe to leave in indefinitely — can be removed after one successful run.
const HOLDINGS_MIGRATION = { "MOS": "LHX", "SPY": "TMO" };
const swaps = [];
for (const [oldSym, newSym] of Object.entries(HOLDINGS_MIGRATION)) {
  const old = portfolio.holdings[oldSym];
  if (!old || old.shares <= 0) continue;
  const newPrice = prices[newSym];
  if (!newPrice) {
    console.log(`  ⚠ Cannot migrate ${oldSym} → ${newSym}: ${newSym} price unavailable today; will retry next run.`);
    continue;
  }
  const newShares = +(old.cost_basis / newPrice).toFixed(4);
  const existing = portfolio.holdings[newSym];
  if (existing) {
    // Already a position in the new symbol — merge cost basis.
    existing.shares = +(existing.shares + newShares).toFixed(4);
    existing.cost_basis = +(existing.cost_basis + old.cost_basis).toFixed(2);
    existing.avg_price = existing.shares > 0 ? +(existing.cost_basis / existing.shares).toFixed(4) : 0;
  } else {
    portfolio.holdings[newSym] = {
      shares: newShares,
      cost_basis: old.cost_basis,
      avg_price: newPrice,
    };
  }
  delete portfolio.holdings[oldSym];
  swaps.push({
    from: oldSym,
    to: newSym,
    old_shares: old.shares,
    old_cost_basis: old.cost_basis,
    new_shares: newShares,
    new_price: newPrice,
  });
  console.log(`  🔄 SWAP ${oldSym} → ${newSym}: $${old.cost_basis.toFixed(0)} cost basis → ${newShares} ${newSym} shares @ $${newPrice.toFixed(2)}`);
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
  ...(swaps.length > 0 ? { swaps } : {}),                  // ← V7.5: only present on migration day
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
