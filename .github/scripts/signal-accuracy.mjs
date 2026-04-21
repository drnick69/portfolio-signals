#!/usr/bin/env node
// signal-accuracy.mjs — Forward-looking signal accuracy tracker.
//
// Reads the signal history CSV, computes N-day forward returns for each
// past signal, and generates accuracy statistics per holding, per layer,
// per signal bucket. This is the feedback loop that tells you whether
// the system's recommendations actually predicted price movement.
//
// Outputs:
//   docs/history/accuracy.json — per-holding, per-layer hit rates and avg returns
//   (consumed by calibration-loader.mjs → injected into LLM prompts)
//
// Runs BEFORE generate-signals.mjs in the daily pipeline.
// On the first run (no history), outputs empty stats gracefully.
//
// Forward return windows:
//   Tactical:   1-day, 3-day, 5-day
//   Positional:  5-day, 10-day, 20-day
//   Strategic:  20-day, 40-day, 60-day

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const HISTORY_DIR = "docs/history";
const CSV_PATH = `${HISTORY_DIR}/signals.csv`;
const ACCURACY_PATH = `${HISTORY_DIR}/accuracy.json`;

mkdirSync(HISTORY_DIR, { recursive: true });

// ─── SIGNAL BUCKETS ──────────────────────────────────────────────────────────
// Map raw scores into discrete buckets for analysis.
// A "hit" for a buy signal = positive forward return.
// A "hit" for a sell signal = negative forward return.
function scoreToBucket(score) {
  if (score <= -60) return "STRONG_BUY";
  if (score <= -25) return "BUY";
  if (score <= 24)  return "NEUTRAL";
  if (score <= 59)  return "SELL";
  return "STRONG_SELL";
}

function isBuyBucket(bucket) {
  return bucket === "STRONG_BUY" || bucket === "BUY";
}

function isSellBucket(bucket) {
  return bucket === "SELL" || bucket === "STRONG_SELL";
}

// ─── NORMALIZE ROLE ──────────────────────────────────────────────────────────
// CSV parser auto-converts numeric-looking cells to floats, so row.role
// may come through as a number. Coerce to uppercase string so downstream
// .includes() / === comparisons are always safe.
function normalizeRole(v) {
  if (v === null || v === undefined || v === "") return "HOLD";
  return String(v).trim().toUpperCase();
}

// ─── PARSE CSV ───────────────────────────────────────────────────────────────
function parseCSV(path) {
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",");
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(",");
    if (vals.length < headers.length) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j].trim();
      let val = (vals[j] || "").trim().replace(/^"|"$/g, "");
      // Try to parse numbers
      if (val !== "" && !isNaN(val)) val = parseFloat(val);
      row[key] = val;
    }
    rows.push(row);
  }

  return rows;
}

// ─── BUILD PRICE LOOKUP ──────────────────────────────────────────────────────
// From CSV rows, build a map: symbol → date → price
// This lets us compute forward returns by looking up price N days later.
function buildPriceLookup(rows) {
  const lookup = {}; // { symbol: { "2026-03-01": 42.50, ... } }

  for (const row of rows) {
    const sym = row.symbol;
    const date = row.date;
    const price = row.price;

    if (!sym || !date || !price || price === "") continue;

    if (!lookup[sym]) lookup[sym] = {};
    lookup[sym][date] = typeof price === "number" ? price : parseFloat(price);
  }

  return lookup;
}

// ─── GET TRADING DATES ───────────────────────────────────────────────────────
// Extract sorted unique dates from the CSV to map "N trading days later"
function getTradingDates(rows) {
  const dates = [...new Set(rows.map(r => r.date).filter(Boolean))];
  dates.sort();
  return dates;
}

// ─── COMPUTE FORWARD RETURNS ─────────────────────────────────────────────────
function computeForwardReturns(rows, priceLookup, tradingDates) {
  const results = []; // Array of { symbol, date, layer, score, bucket, fwd_1d, fwd_3d, fwd_5d, fwd_10d, fwd_20d, fwd_40d, fwd_60d }

  const dateIndex = {};
  tradingDates.forEach((d, i) => { dateIndex[d] = i; });

  const WINDOWS = [1, 3, 5, 10, 20, 40, 60];

  for (const row of rows) {
    const sym = row.symbol;
    const date = row.date;
    const entryPrice = typeof row.price === "number" ? row.price : parseFloat(row.price);

    if (!sym || !date || !entryPrice || isNaN(entryPrice)) continue;

    const idx = dateIndex[date];
    if (idx == null) continue;

    const prices = priceLookup[sym];
    if (!prices) continue;

    // Compute forward returns for each window
    const fwdReturns = {};
    for (const n of WINDOWS) {
      const fwdIdx = idx + n;
      if (fwdIdx < tradingDates.length) {
        const fwdDate = tradingDates[fwdIdx];
        const fwdPrice = prices[fwdDate];
        if (fwdPrice && !isNaN(fwdPrice)) {
          fwdReturns[`fwd_${n}d`] = +((fwdPrice - entryPrice) / entryPrice * 100).toFixed(4);
        }
      }
    }

    // Skip if no forward returns available (too recent)
    if (Object.keys(fwdReturns).length === 0) continue;

    // One entry per layer
    const layers = [
      { layer: "tactical",   score: row.tactical_score },
      { layer: "positional", score: row.positional_score },
      { layer: "strategic",  score: row.strategic_score },
      { layer: "composite",  score: row.composite_score },
    ];

    for (const { layer, score } of layers) {
      const s = typeof score === "number" ? score : parseFloat(score);
      if (isNaN(s)) continue;

      results.push({
        symbol: sym,
        date,
        layer,
        score: s,
        bucket: scoreToBucket(s),
        ...fwdReturns,
      });
    }
  }

  return results;
}

// ─── AGGREGATE STATS ─────────────────────────────────────────────────────────
function aggregateStats(forwardReturns) {
  // Structure: { symbol: { layer: { bucket: { count, hits_Nd, avg_return_Nd, ... } } } }
  // Also compute portfolio-wide stats.

  const stats = {};
  const portfolioStats = {};

  // Relevant windows per layer
  const LAYER_WINDOWS = {
    tactical:   ["fwd_1d", "fwd_3d", "fwd_5d"],
    positional: ["fwd_5d", "fwd_10d", "fwd_20d"],
    strategic:  ["fwd_20d", "fwd_40d", "fwd_60d"],
    composite:  ["fwd_5d", "fwd_20d", "fwd_60d"],
  };

  for (const r of forwardReturns) {
    const { symbol, layer, bucket } = r;

    // Per-symbol stats
    if (!stats[symbol]) stats[symbol] = {};
    if (!stats[symbol][layer]) stats[symbol][layer] = {};
    if (!stats[symbol][layer][bucket]) {
      stats[symbol][layer][bucket] = { count: 0 };
    }
    const b = stats[symbol][layer][bucket];
    b.count++;

    // Portfolio-wide stats
    if (!portfolioStats[layer]) portfolioStats[layer] = {};
    if (!portfolioStats[layer][bucket]) {
      portfolioStats[layer][bucket] = { count: 0 };
    }
    const pb = portfolioStats[layer][bucket];
    pb.count++;

    // Compute per-window stats
    const windows = LAYER_WINDOWS[layer] || [];
    for (const w of windows) {
      const ret = r[w];
      if (ret == null) continue;

      // Per-symbol
      if (!b[w]) b[w] = { returns: [], hits: 0, misses: 0 };
      b[w].returns.push(ret);
      // "Hit" = return matches signal direction
      if (isBuyBucket(bucket) && ret > 0) b[w].hits++;
      else if (isSellBucket(bucket) && ret < 0) b[w].hits++;
      else if (bucket === "NEUTRAL") b[w].hits++; // Neutral is always "right" if small move
      else b[w].misses++;

      // Portfolio-wide
      if (!pb[w]) pb[w] = { returns: [], hits: 0, misses: 0 };
      pb[w].returns.push(ret);
      if (isBuyBucket(bucket) && ret > 0) pb[w].hits++;
      else if (isSellBucket(bucket) && ret < 0) pb[w].hits++;
      else if (bucket === "NEUTRAL") pb[w].hits++;
      else pb[w].misses++;
    }
  }

  // Compute summary stats (hit rate, avg return, median return)
  const summarize = (obj) => {
    for (const layer of Object.keys(obj)) {
      for (const bucket of Object.keys(obj[layer])) {
        const b = obj[layer][bucket];
        for (const key of Object.keys(b)) {
          if (key === "count") continue;
          const data = b[key];
          if (!data || !data.returns) continue;

          const n = data.returns.length;
          data.n = n;
          data.hit_rate = n > 0 ? +(data.hits / n * 100).toFixed(1) : null;
          data.avg_return = n > 0 ? +(data.returns.reduce((a, b) => a + b, 0) / n).toFixed(4) : null;

          // Median
          const sorted = [...data.returns].sort((a, b) => a - b);
          data.median_return = n > 0 ? +(sorted[Math.floor(n / 2)]).toFixed(4) : null;

          // Remove raw returns array to keep JSON compact
          delete data.returns;
        }
      }
    }
  };

  // bySymbol has one extra nesting level: stats[symbol][layer][bucket]
  for (const sym of Object.keys(stats)) {
    summarize(stats[sym]);
  }
  summarize(portfolioStats);

  return { bySymbol: stats, portfolio: portfolioStats };
}

// ─── GENERATE YESTERDAY'S SNAPSHOT ───────────────────────────────────────────
// For calibration injection: what did each holding score yesterday, and what
// happened to the price since?
function getYesterdaySnapshot(rows, tradingDates) {
  if (tradingDates.length < 2) return null;

  const yesterday = tradingDates[tradingDates.length - 1];
  const yesterdayRows = rows.filter(r => r.date === yesterday);

  if (yesterdayRows.length === 0) return null;

  const snapshot = { date: yesterday, holdings: {} };

  for (const row of yesterdayRows) {
    snapshot.holdings[row.symbol] = {
      price: typeof row.price === "number" ? row.price : parseFloat(row.price),
      tactical_score: typeof row.tactical_score === "number" ? row.tactical_score : parseFloat(row.tactical_score),
      positional_score: typeof row.positional_score === "number" ? row.positional_score : parseFloat(row.positional_score),
      strategic_score: typeof row.strategic_score === "number" ? row.strategic_score : parseFloat(row.strategic_score),
      composite_score: typeof row.composite_score === "number" ? row.composite_score : parseFloat(row.composite_score),
      recommendation: row.recommendation,
      role: normalizeRole(row.role),
    };
  }

  return snapshot;
}

// ─── GENERATE HOLDING STREAKS ────────────────────────────────────────────────
// Track consecutive days a holding has been in each role (buy/trim/hold)
function computeStreaks(rows, tradingDates) {
  const streaks = {}; // { symbol: { current_role, streak_days, longest_buy_streak, longest_trim_streak } }

  for (const sym of [...new Set(rows.map(r => r.symbol))]) {
    const symRows = rows
      .filter(r => r.symbol === sym)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (symRows.length === 0) continue;

    let currentRole = normalizeRole(symRows[symRows.length - 1].role);
    let streak = 0;
    let longestBuy = 0;
    let longestTrim = 0;

    for (let i = symRows.length - 1; i >= 0; i--) {
      const role = normalizeRole(symRows[i].role);
      if (i === symRows.length - 1 || role === currentRole) {
        streak++;
      } else {
        break;
      }
    }

    // Count longest streaks
    let prevRole = null;
    let runLen = 0;
    for (const r of symRows) {
      const role = normalizeRole(r.role);
      if (role === prevRole) {
        runLen++;
      } else {
        if (prevRole && prevRole.includes("BUY")) longestBuy = Math.max(longestBuy, runLen);
        if (prevRole === "TRIM") longestTrim = Math.max(longestTrim, runLen);
        runLen = 1;
        prevRole = role;
      }
    }
    if (prevRole && prevRole.includes("BUY")) longestBuy = Math.max(longestBuy, runLen);
    if (prevRole === "TRIM") longestTrim = Math.max(longestTrim, runLen);

    streaks[sym] = {
      current_role: currentRole,
      streak_days: streak,
      longest_buy_streak: longestBuy,
      longest_trim_streak: longestTrim,
    };
  }

  return streaks;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
console.log("Signal Accuracy Tracker");
console.log("=======================");

const rows = parseCSV(CSV_PATH);

if (rows.length === 0) {
  console.log("No signal history found. Writing empty accuracy file.");
  writeFileSync(ACCURACY_PATH, JSON.stringify({
    generated: new Date().toISOString(),
    totalSignalDays: 0,
    message: "No history yet — accuracy tracking starts after first signal day.",
    bySymbol: {},
    portfolio: {},
    yesterday: null,
    streaks: {},
  }, null, 2));
  process.exit(0);
}

const priceLookup = buildPriceLookup(rows);
const tradingDates = getTradingDates(rows);
const forwardReturns = computeForwardReturns(rows, priceLookup, tradingDates);
const { bySymbol, portfolio } = aggregateStats(forwardReturns);
const yesterday = getYesterdaySnapshot(rows, tradingDates);
const streaks = computeStreaks(rows, tradingDates);

// ─── COMPUTE LAYER RELIABILITY SCORES ────────────────────────────────────────
// A single number per layer: how reliable are its signals overall?
// Based on buy-signal hit rate at the layer's primary window.
function layerReliability(portfolioStats) {
  const reliability = {};

  const PRIMARY_WINDOW = {
    tactical: "fwd_5d",
    positional: "fwd_20d",
    strategic: "fwd_60d",
    composite: "fwd_20d",
  };

  for (const [layer, buckets] of Object.entries(portfolioStats)) {
    const window = PRIMARY_WINDOW[layer];
    let totalHits = 0;
    let totalN = 0;
    let avgReturn = 0;
    let returnN = 0;

    for (const [bucket, data] of Object.entries(buckets)) {
      if (!isBuyBucket(bucket) && !isSellBucket(bucket)) continue;
      const windowData = data[window];
      if (!windowData) continue;

      totalHits += windowData.hits || 0;
      totalN += windowData.n || 0;
      if (windowData.avg_return != null) {
        avgReturn += windowData.avg_return * windowData.n;
        returnN += windowData.n;
      }
    }

    reliability[layer] = {
      primary_window: window,
      total_signals: totalN,
      hit_rate: totalN > 0 ? +(totalHits / totalN * 100).toFixed(1) : null,
      avg_return: returnN > 0 ? +(avgReturn / returnN).toFixed(4) : null,
      grade: totalN < 5 ? "INSUFFICIENT_DATA" :
             (totalHits / totalN) >= 0.65 ? "STRONG" :
             (totalHits / totalN) >= 0.55 ? "MODERATE" :
             (totalHits / totalN) >= 0.45 ? "WEAK" : "POOR",
    };
  }

  return reliability;
}

const reliability = layerReliability(portfolio);

// ─── OUTPUT ──────────────────────────────────────────────────────────────────
const accuracy = {
  generated: new Date().toISOString(),
  totalSignalDays: tradingDates.length,
  dateRange: {
    first: tradingDates[0],
    last: tradingDates[tradingDates.length - 1],
  },
  forwardReturnsSampled: forwardReturns.length,
  reliability,
  bySymbol,
  portfolio,
  yesterday,
  streaks,
};

writeFileSync(ACCURACY_PATH, JSON.stringify(accuracy, null, 2));

// ─── CONSOLE REPORT ──────────────────────────────────────────────────────────
console.log(`\nTracking Period: ${tradingDates[0]} → ${tradingDates[tradingDates.length - 1]} (${tradingDates.length} trading days)`);
console.log(`Forward returns computed: ${forwardReturns.length} data points\n`);

console.log("─── LAYER RELIABILITY ───");
for (const [layer, r] of Object.entries(reliability)) {
  const hitStr = r.hit_rate != null ? `${r.hit_rate}%` : "N/A";
  const retStr = r.avg_return != null ? `${r.avg_return > 0 ? "+" : ""}${r.avg_return}%` : "N/A";
  console.log(`  ${layer.padEnd(12)} ${r.grade.padEnd(20)} Hit:${hitStr.padStart(7)} Avg:${retStr.padStart(8)} (n=${r.total_signals}, window=${r.primary_window})`);
}

console.log("\n─── HOLDING STREAKS ───");
for (const [sym, s] of Object.entries(streaks)) {
  console.log(`  ${sym.padEnd(7)} Currently: ${s.current_role.padEnd(16)} (${s.streak_days}d streak) | Longest buy: ${s.longest_buy_streak}d | Longest trim: ${s.longest_trim_streak}d`);
}

if (yesterday) {
  console.log(`\n─── YESTERDAY (${yesterday.date}) ───`);
  for (const [sym, d] of Object.entries(yesterday.holdings)) {
    const scoreStr = `T:${d.tactical_score ?? "?"} P:${d.positional_score ?? "?"} S:${d.strategic_score ?? "?"} C:${d.composite_score ?? "?"}`;
    console.log(`  ${sym.padEnd(7)} $${d.price ?? "?"} | ${scoreStr} | ${d.role}`);
  }
}

console.log("\n✓ Accuracy tracking complete → " + ACCURACY_PATH);
