#!/usr/bin/env node
// rebalance-msft.mjs — One-shot paper-portfolio rebalance: 1/12th MSFT,
// other holdings trimmed proportionally to fund the MSFT position.
// Cash position is preserved. MSFT is added if not already present.
//
// Run AFTER the daily pipeline so MSFT price is in /tmp/signal-data.json
// (or run fetch-market-data.mjs first to populate /tmp/market-data.json).
//
// Usage:
//   node .github/scripts/rebalance-msft.mjs              # dry-run (prints plan, no changes)
//   node .github/scripts/rebalance-msft.mjs --execute    # apply changes and write portfolio file
//
// Algorithm:
//   target_msft_value = total_portfolio_value × 1/12
//   trim_fraction     = (target_msft_value − current_msft_value) / non_msft_holdings_value
//   For each non-MSFT holding: sell shares × trim_fraction (cost basis reduced proportionally)
//   Sum proceeds → fund MSFT position
//
// History: appends a snapshot with type:"REBALANCE" (separate from daily trade snapshots).

import { readFileSync, writeFileSync, existsSync } from "fs";

const PORTFOLIO_PATH = "docs/history/paper-portfolio.json";
const TARGET_SYMBOL = "MSFT";
const TARGET_FRACTION = 1 / 12;

const EXECUTE = process.argv.includes("--execute");

// ─── LOAD PORTFOLIO ─────────────────────────────────────────────────────────
if (!existsSync(PORTFOLIO_PATH)) {
  console.error(`ERROR: Cannot find ${PORTFOLIO_PATH}`);
  console.error(`Run the daily pipeline at least once to initialize the paper portfolio.`);
  process.exit(1);
}
const portfolio = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));

// ─── LOAD PRICES ────────────────────────────────────────────────────────────
let prices = {};
let priceSource = null;
if (existsSync("/tmp/signal-data.json")) {
  const sig = JSON.parse(readFileSync("/tmp/signal-data.json", "utf-8"));
  for (const s of sig.normalized || []) {
    if (s.price?.current) prices[s.symbol] = s.price.current;
  }
  priceSource = "/tmp/signal-data.json";
} else if (existsSync("/tmp/market-data.json")) {
  const md = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8"));
  for (const [sym, data] of Object.entries(md)) {
    if (sym.startsWith("_")) continue;
    if (data?.price?.current) prices[sym] = data.price.current;
  }
  priceSource = "/tmp/market-data.json";
} else {
  console.error("ERROR: Cannot find /tmp/signal-data.json or /tmp/market-data.json.");
  console.error("Run the daily pipeline (or at minimum fetch-market-data.mjs) first.");
  process.exit(1);
}

console.log("MSFT REBALANCE");
console.log("==============");
console.log(`Mode:         ${EXECUTE ? "EXECUTE (will write portfolio file)" : "DRY-RUN (no changes)"}`);
console.log(`Price source: ${priceSource}`);
console.log(`Portfolio:    ${PORTFOLIO_PATH}`);
console.log("");

// ─── VALIDATE MSFT PRICE ────────────────────────────────────────────────────
const msftPrice = prices[TARGET_SYMBOL];
if (!msftPrice) {
  console.error(`ERROR: MSFT price not found in ${priceSource}.`);
  console.error(`This script requires v7.4 of the pipeline (which adds MSFT). Run the daily workflow first.`);
  process.exit(1);
}

// ─── COMPUTE CURRENT STATE ──────────────────────────────────────────────────
let holdingsValue = 0;
const holdingValues = {};
const missingPrices = [];
for (const [sym, h] of Object.entries(portfolio.holdings)) {
  const px = prices[sym];
  if (!px) {
    missingPrices.push(sym);
    continue;
  }
  const v = h.shares * px;
  holdingValues[sym] = v;
  holdingsValue += v;
}

if (missingPrices.length > 0) {
  console.error(`ERROR: missing prices for ${missingPrices.join(", ")}. Cannot rebalance safely.`);
  process.exit(1);
}

const totalValue = holdingsValue + portfolio.cash;
const msftTargetValue = totalValue * TARGET_FRACTION;
const msftCurrentValue = holdingValues[TARGET_SYMBOL] || 0;
const msftAddValue = msftTargetValue - msftCurrentValue;

console.log("CURRENT STATE");
console.log(`  Holdings value:  $${holdingsValue.toFixed(2).padStart(14)}`);
console.log(`  Cash:            $${portfolio.cash.toFixed(2).padStart(14)}`);
console.log(`  Total value:     $${totalValue.toFixed(2).padStart(14)}`);
console.log(`  Current MSFT:    $${msftCurrentValue.toFixed(2).padStart(14)}  (${(msftCurrentValue / totalValue * 100).toFixed(3)}%)`);
console.log("");
console.log("TARGET");
console.log(`  MSFT target:     $${msftTargetValue.toFixed(2).padStart(14)}  (${(TARGET_FRACTION * 100).toFixed(3)}% of total)`);
console.log(`  MSFT to add:     $${msftAddValue.toFixed(2).padStart(14)}`);
console.log(`  MSFT price:      $${msftPrice.toFixed(2).padStart(14)}`);
console.log(`  MSFT shares buy:  ${(msftAddValue / msftPrice).toFixed(4).padStart(14)}`);
console.log("");

if (msftAddValue <= 0) {
  console.log(`MSFT is already at or above target weight (${(msftCurrentValue / totalValue * 100).toFixed(3)}%).`);
  console.log("No rebalance needed. Exiting.");
  process.exit(0);
}

// ─── COMPUTE TRIM PLAN ──────────────────────────────────────────────────────
const nonMsftValue = holdingsValue - msftCurrentValue;
const trimFraction = msftAddValue / nonMsftValue;

console.log(`TRIM PLAN — each non-MSFT holding sells ${(trimFraction * 100).toFixed(4)}% of its shares`);
console.log("");
console.log(`  ${"SYMBOL".padEnd(7)}  ${"OLD SHARES".padStart(12)}  ${"PRICE".padStart(9)}  ${"SELL SHARES".padStart(12)}  ${"PROCEEDS".padStart(11)}  ${"NEW SHARES".padStart(12)}`);
console.log(`  ${"-".repeat(80)}`);

const planned = [];
let totalProceeds = 0;
for (const [sym, h] of Object.entries(portfolio.holdings)) {
  if (sym === TARGET_SYMBOL) continue;
  const px = prices[sym];
  const sellShares = h.shares * trimFraction;
  const proceeds = sellShares * px;
  const cbReduction = h.cost_basis * trimFraction;
  const newShares = h.shares - sellShares;
  totalProceeds += proceeds;
  planned.push({ sym, sellShares, proceeds, cbReduction, px, oldShares: h.shares, oldCost: h.cost_basis, newShares });
  console.log(`  ${sym.padEnd(7)}  ${h.shares.toFixed(4).padStart(12)}  $${px.toFixed(2).padStart(8)}  ${sellShares.toFixed(4).padStart(12)}  $${proceeds.toFixed(2).padStart(10)}  ${newShares.toFixed(4).padStart(12)}`);
}

console.log("");
console.log(`  Total proceeds:  $${totalProceeds.toFixed(2)}`);
console.log(`  MSFT buy cost:   $${msftAddValue.toFixed(2)}`);
console.log(`  Difference:      $${(totalProceeds - msftAddValue).toFixed(4)}  (rounding)`);
console.log("");

// ─── DRY-RUN EXIT ───────────────────────────────────────────────────────────
if (!EXECUTE) {
  console.log("DRY-RUN complete. Re-run with --execute to apply changes.");
  process.exit(0);
}

// ─── EXECUTE ────────────────────────────────────────────────────────────────
const today = new Date().toISOString().split("T")[0];
const trades = [];

// Apply trims
for (const p of planned) {
  const h = portfolio.holdings[p.sym];
  h.shares = +(h.shares - p.sellShares).toFixed(4);
  h.cost_basis = +(h.cost_basis - p.cbReduction).toFixed(2);
  h.avg_price = h.shares > 0 ? +(h.cost_basis / h.shares).toFixed(4) : 0;
  trades.push({
    type: "REBALANCE_TRIM",
    symbol: p.sym,
    shares: -(+p.sellShares.toFixed(4)),
    price: p.px,
    value: +p.proceeds.toFixed(2),
  });
  // Defensive: drop position if rounding drove it to ~zero (won't happen with ~8% trim)
  if (h.shares <= 0.0001 || h.cost_basis <= 0.01) {
    delete portfolio.holdings[p.sym];
  }
}

// Apply MSFT buy
const msftShares = +(msftAddValue / msftPrice).toFixed(4);
const msftCost = +msftAddValue.toFixed(2);
if (!portfolio.holdings[TARGET_SYMBOL]) {
  portfolio.holdings[TARGET_SYMBOL] = { shares: 0, cost_basis: 0, avg_price: 0 };
}
const msftHolding = portfolio.holdings[TARGET_SYMBOL];
msftHolding.shares = +(msftHolding.shares + msftShares).toFixed(4);
msftHolding.cost_basis = +(msftHolding.cost_basis + msftCost).toFixed(2);
msftHolding.avg_price = msftHolding.shares > 0 ? +(msftHolding.cost_basis / msftHolding.shares).toFixed(4) : 0;

trades.push({
  type: "REBALANCE_BUY",
  symbol: TARGET_SYMBOL,
  shares: msftShares,
  price: msftPrice,
  value: msftCost,
});

// Recompute total_value
let newHoldingsValue = 0;
for (const [sym, h] of Object.entries(portfolio.holdings)) {
  const px = prices[sym];
  if (px) newHoldingsValue += h.shares * px;
}
portfolio.total_value = +(newHoldingsValue + portfolio.cash).toFixed(2);

const totalPnl = +(portfolio.total_value - portfolio.total_deposited).toFixed(2);
const totalPnlPct = +((totalPnl / portfolio.total_deposited) * 100).toFixed(2);

// Append rebalance snapshot to history (distinct from daily snapshots via type field)
portfolio.history.push({
  date: today,
  day: portfolio.day_count,
  type: "REBALANCE",
  notes: "One-shot rebalance: 1/12th MSFT, other holdings trimmed proportionally",
  total_value: portfolio.total_value,
  total_deposited: portfolio.total_deposited,
  cash: portfolio.cash,
  holdings_value: +newHoldingsValue.toFixed(2),
  pnl: totalPnl,
  pnl_pct: totalPnlPct,
  trades,
  rebalance_meta: {
    target_symbol: TARGET_SYMBOL,
    target_fraction: TARGET_FRACTION,
    trim_fraction: +trimFraction.toFixed(6),
    msft_price: msftPrice,
    total_proceeds: +totalProceeds.toFixed(2),
  },
});

writeFileSync(PORTFOLIO_PATH, JSON.stringify(portfolio, null, 2));

// ─── REPORT ─────────────────────────────────────────────────────────────────
console.log("✓ EXECUTED");
console.log(`Portfolio written to ${PORTFOLIO_PATH}`);
console.log("");
console.log("FINAL STATE");
console.log(`  Total value:     $${portfolio.total_value.toFixed(2).padStart(14)}`);
console.log(`  Holdings value:  $${newHoldingsValue.toFixed(2).padStart(14)}`);
console.log(`  Cash:            $${portfolio.cash.toFixed(2).padStart(14)}  (unchanged)`);
console.log(`  P&L:             $${totalPnl.toFixed(2).padStart(14)}  (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct}%)`);
console.log("");
console.log("POSITION BREAKDOWN");
const finalHoldings = Object.entries(portfolio.holdings)
  .map(([sym, h]) => ({ sym, shares: h.shares, value: h.shares * prices[sym], pct: (h.shares * prices[sym]) / portfolio.total_value * 100 }))
  .sort((a, b) => b.value - a.value);
for (const h of finalHoldings) {
  const flag = h.sym === TARGET_SYMBOL ? " ← target" : "";
  console.log(`  ${h.sym.padEnd(7)}  ${h.shares.toFixed(4).padStart(12)} sh  $${h.value.toFixed(2).padStart(11)}  ${h.pct.toFixed(2).padStart(6)}%${flag}`);
}
console.log("");
console.log(`MSFT now: ${msftHolding.shares} shares @ avg $${msftHolding.avg_price} = $${(msftHolding.shares * msftPrice).toFixed(2)} (${((msftHolding.shares * msftPrice) / portfolio.total_value * 100).toFixed(3)}% of total)`);
