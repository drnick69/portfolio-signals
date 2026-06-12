#!/usr/bin/env node
// signal-accuracy.mjs v1.3 — Forward-looking signal accuracy tracker.
//
// v1.3 (June 2026) — CSV PARSE HARDENING:
//   The naive split(",") parser accepted rows WIDER than the header and read
//   them by header position — so when signals.csv accumulated appended-column
//   schemas under the original 30-column header, every post-change row was
//   silently misparsed (scores read from valuation columns, regime/cohort
//   snapshot propagation dead). v1.3:
//   • Quote-aware line splitting (handles esc()-quoted fields with commas).
//   • EXACT width contract: rows whose field count ≠ header width are
//     SKIPPED, never misparsed — counted per width and reported loudly with
//     instructions to run rebuild-signals-csv.mjs.
//   • accuracy.json gains a top-level data_quality block so corruption is
//     visible downstream instead of silent.
//   Run .github/scripts/rebuild-signals-csv.mjs once (Rebuild signals.csv
//   workflow) to unify the historical file; v1.3 then parses full history.
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
//
// Symbol handling: this script is symbol-agnostic — it processes whatever
// tickers appear in the CSV. Holdings swaps (e.g. V7.6 ETHA → NOW) require
// no changes to the aggregation logic; per-symbol stats simply begin
// accumulating for new tickers from their first logged date forward.
//
// v1.1 — LIN v3 regime propagation:
// Yesterday-snapshot propagates regime / regime_pmi / weights from the
// CSV (columns added in log-signals v3 — currently LIN-only, blank elsewhere)
// into accuracy.json so calibration-loader v1.1 can surface them in the
// LLM prompt's CALIBRATION FEEDBACK block. Forward-compatible: if the CSV
// header doesn't include those columns yet (older history mid-upgrade),
// every check no-ops and behavior matches v1.0.
//
// v1.2 — NOW v7.6 cohort context propagation:
// Yesterday-snapshot also propagates NOW-specific context fields from the
// CSV (columns added in log-signals v4 — currently NOW-only, blank elsewhere)
// into accuracy.json: cohort P/E premium vs CRM/WDAY/ADBE, rotation pressure
// pp vs cohort 30d, IGV-vs-SPY factor flow, and cRPO YoY growth (NOW's
// signature operational metric). Same forward-compatibility pattern as v1.1:
// if those CSV columns aren't present yet, all checks no-op cleanly.

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
// v1.3: quote-aware CSV line splitter — esc() in log-signals quotes fields
// containing commas; naive split(",") miscounts those rows.
function splitCSVLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// v1.3: parse stats surfaced into accuracy.json (data_quality) + console.
const csvDataQuality = {
  header_width: null,
  rows_total: 0,
  rows_parsed: 0,
  rows_skipped: 0,
  skipped_by_width: {},   // { "30": n, "87": n, ... }
};

function parseCSV(path) {
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8").trim();
  const lines = raw.split("\n");
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  csvDataQuality.header_width = headers.length;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    csvDataQuality.rows_total++;

    // v1.3 EXACT width contract: a row that doesn't match the header width
    // cannot be safely read by position — skip it rather than misparse it.
    if (vals.length !== headers.length) {
      csvDataQuality.rows_skipped++;
      const w = String(vals.length);
      csvDataQuality.skipped_by_width[w] = (csvDataQuality.skipped_by_width[w] || 0) + 1;
      continue;
    }

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j].trim();
      let val = (vals[j] || "").trim();
      // Try to parse numbers
      if (val !== "" && !isNaN(val)) val = parseFloat(val);
      row[key] = val;
    }
    rows.push(row);
    csvDataQuality.rows_parsed++;
  }

  if (csvDataQuality.rows_skipped > 0) {
    console.warn("");
    console.warn("⚠".repeat(34));
    console.warn(`⚠ CSV SCHEMA MISMATCH: skipped ${csvDataQuality.rows_skipped}/${csvDataQuality.rows_total} rows whose width ≠ header (${headers.length} cols).`);
    console.warn(`⚠ Skipped widths: ${Object.entries(csvDataQuality.skipped_by_width).map(([w, n]) => `${w}-field × ${n}`).join(", ")}`);
    console.warn("⚠ These rows were NOT misparsed — they were excluded from accuracy stats.");
    console.warn("⚠ FIX: run the 'Rebuild signals.csv' workflow (rebuild-signals-csv.mjs) once");
    console.warn("⚠ to unify the historical file under the current header.");
    console.warn("⚠".repeat(34));
    console.warn("");
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
//
// v1.1: Also propagates v3 regime context (regime, regime_pmi, weights{t,p,s})
// when the CSV row carries those columns. They were added by log-signals v3
// and are LIN-only in current builds — blank cells elsewhere produce empty
// strings from the CSV parser, which the helpers below convert to null and
// then omit from the output object so non-LIN holdings stay clean.
//
// v1.2: Also propagates NOW v7.6 cohort context (cohort_premium_pct,
// rotation_pressure_pp, igv_vs_spy_30d_pp, crpo_growth_pct) when the CSV
// row carries those columns. Added by log-signals v4 and currently NOW-only.
// Same forward-compatibility pattern: helpers coerce blanks to null and
// fields only attach when populated, so non-NOW holdings stay clean and
// pre-v4 CSV history is a no-op.
function getYesterdaySnapshot(rows, tradingDates) {
  if (tradingDates.length < 2) return null;

  const yesterday = tradingDates[tradingDates.length - 1];
  const yesterdayRows = rows.filter(r => r.date === yesterday);

  if (yesterdayRows.length === 0) return null;

  const numOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : parseFloat(v);
    return isNaN(n) ? null : n;
  };
  const strOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const s = String(v).trim();
    return s ? s : null;
  };

  const snapshot = { date: yesterday, holdings: {} };

  for (const row of yesterdayRows) {
    const holding = {
      price: typeof row.price === "number" ? row.price : parseFloat(row.price),
      tactical_score: typeof row.tactical_score === "number" ? row.tactical_score : parseFloat(row.tactical_score),
      positional_score: typeof row.positional_score === "number" ? row.positional_score : parseFloat(row.positional_score),
      strategic_score: typeof row.strategic_score === "number" ? row.strategic_score : parseFloat(row.strategic_score),
      composite_score: typeof row.composite_score === "number" ? row.composite_score : parseFloat(row.composite_score),
      recommendation: row.recommendation,
      role: normalizeRole(row.role),
    };

    // v1.1: v3 regime context — only attached when CSV cells are populated.
    // Older CSV rows (pre-v3 log-signals) don't have these columns; the
    // parser leaves row.regime / row.regime_pmi / row.weight_* undefined,
    // and the helpers + conditional attachments make this a no-op.
    const regime = strOrNull(row.regime);
    const regimePmi = numOrNull(row.regime_pmi);
    const wt = numOrNull(row.weight_t);
    const wp = numOrNull(row.weight_p);
    const ws = numOrNull(row.weight_s);

    if (regime != null) holding.regime = regime;
    if (regimePmi != null) holding.regime_pmi = regimePmi;
    if (wt != null && wp != null && ws != null) {
      holding.weights = { t: wt, p: wp, s: ws };
    }

    // v1.2: NOW v7.6 cohort context — only attached when CSV cells are
    // populated (NOW-only in current builds). Pre-v4 log-signals CSV history
    // leaves these columns undefined, helpers no-op, non-NOW rows stay clean.
    const cohortPremium = numOrNull(row.cohort_premium_pct);
    const rotationPressure = numOrNull(row.rotation_pressure_pp);
    const igvVsSpy = numOrNull(row.igv_vs_spy_30d_pp);
    const crpoGrowth = numOrNull(row.crpo_growth_pct);

    if (cohortPremium != null) holding.cohort_premium_pct = cohortPremium;
    if (rotationPressure != null) holding.rotation_pressure_pp = rotationPressure;
    if (igvVsSpy != null) holding.igv_vs_spy_30d_pp = igvVsSpy;
    if (crpoGrowth != null) holding.crpo_growth_pct = crpoGrowth;

    snapshot.holdings[row.symbol] = holding;
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
  data_quality: csvDataQuality,   // v1.3: parse integrity — nonzero rows_skipped means run the rebuild
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
