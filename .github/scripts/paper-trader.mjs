#!/usr/bin/env node
// paper-trader.mjs — Simulates portfolio performance following daily signals.
// Starting: $1M equally distributed across 11 holdings.
// Daily: $10,000 new capital. Buys the 3 buy signals, trims the trim signal.
//
// Trade rules:
//   - New cash ($10K) split: 40% to tactical buy, 35% to positional, 25% to strategic
//   - Trim: sell 3% of trim position and add proceeds to cash
//   - Prices come from /tmp/signal-data.json + /tmp/market-data.json
//   - State persists in docs/history/paper-portfolio.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

mkdirSync("docs/history", { recursive: true });

const PORTFOLIO_PATH = "docs/history/paper-portfolio.json";
const INITIAL_CAPITAL = 1_000_000;
const DAILY_DEPOSIT = 10_000;
const TRIM_PCT = 0.03; // sell 3% of trim position each day

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

// Build price map
const prices = {};
for (const s of normalized) {
  if (s.price?.current) prices[s.symbol] = s.price.current;
}

console.log("Paper Trader");
console.log("============");
console.log(`Date: ${date}`);
console.log(`Prices: ${Object.keys(prices).length}/11`);

// ─── LOAD OR INITIALIZE PORTFOLIO ───────────────────────────────────────────
let portfolio;
if (existsSync(PORTFOLIO_PATH)) {
  portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));
  console.log(`Portfolio loaded: day ${portfolio.day_count + 1}, $${portfolio.total_value?.toFixed(0) || "?"}`);
} else {
  // Initialize: $1M equally distributed
  const perHolding = INITIAL_CAPITAL / 11;
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
    h.shares = +(h.shares - sellShares).toFixed(4);
    portfolio.cash += proceeds;
    trades.push({ type: "TRIM", symbol: sym, shares: -sellShares, price, value: proceeds });
    console.log(`  ✂️ TRIM ${sym}: sold ${sellShares} shares @ $${price.toFixed(2)} = $${proceeds.toFixed(0)}`);
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

  const amount = +(availableCash * pct).toFixed(2);
  const price = prices[sym];
  const shares = +(amount / price).toFixed(4);

  if (!portfolio.holdings[sym]) {
    portfolio.holdings[sym] = { shares: 0, cost_basis: 0, avg_price: 0 };
  }
  const h = portfolio.holdings[sym];
  const oldCost = h.cost_basis;
  const oldShares = h.shares;
  h.shares = +(h.shares + shares).toFixed(4);
  h.cost_basis = +(h.cost_basis + amount).toFixed(2);
  h.avg_price = h.shares > 0 ? +(h.cost_basis / h.shares).toFixed(4) : 0;
  portfolio.cash = +(portfolio.cash - amount).toFixed(2);

  trades.push({ type: "BUY", signal: label, symbol: sym, shares, price, value: amount });
  console.log(`  ${label} BUY ${sym}: ${shares} shares @ $${price.toFixed(2)} = $${amount.toFixed(0)}`);
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

// Sort by value
holdingSummary.sort((a, b) => b.mktValue - a.mktValue);
console.log("  POSITION BREAKDOWN:");
for (const h of holdingSummary) {
  const pnlSign = h.pnl >= 0 ? "+" : "";
  const pct = ((h.mktValue / holdingsValue) * 100).toFixed(1);
  console.log(`    ${h.symbol.padEnd(7)} ${h.shares.toFixed(1).padStart(8)} sh @ $${h.price.toFixed(2).padStart(8)} = $${h.mktValue.toFixed(0).padStart(9)}  (${pct}%)  P&L: ${pnlSign}$${h.pnl.toFixed(0)} (${pnlSign}${h.pnlPct}%)`);
}

console.log("\n✓ Paper portfolio updated");
