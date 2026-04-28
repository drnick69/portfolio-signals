#!/usr/bin/env node
// log-signals.mjs — Appends today's signal data to persistent history files.
// Reads /tmp/signal-data.json + /tmp/market-data.json.
// Outputs:
//   docs/history/signals.csv     — flat CSV of all signals, one row per holding per day
//   docs/history/daily-log.jsonl — one JSON object per day with full signal + assignment data
//   docs/history/summary.json    — rolling stats (streak counts, hit rates, etc.)
//
// This runs AFTER generate-signals.mjs and BEFORE the git commit step.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const HISTORY_DIR = "docs/history";
const CSV_PATH = `${HISTORY_DIR}/signals.csv`;
const JSONL_PATH = `${HISTORY_DIR}/daily-log.jsonl`;
const SUMMARY_PATH = `${HISTORY_DIR}/summary.json`;

mkdirSync(HISTORY_DIR, { recursive: true });

// ─── LOAD TODAY'S DATA ───────────────────────────────────────────────────────
let signalData, marketData;
try {
  signalData = JSON.parse(readFileSync("/tmp/signal-data.json", "utf-8"));
  marketData = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8"));
} catch (e) {
  console.error("Cannot read signal/market data:", e.message);
  process.exit(1);
}

const { normalized, assignments, timestamp } = signalData;
const date = new Date(timestamp).toISOString().split("T")[0]; // YYYY-MM-DD
const macro = marketData._macro || {};

console.log("Signal History Logger");
console.log("=====================");
console.log(`Date: ${date}`);
console.log(`Holdings: ${normalized.length}`);

// ─── 1. CSV LOG ──────────────────────────────────────────────────────────────
// One row per holding per day. Easy to analyze in Excel/Sheets/pandas.
// Every column here is EITHER an input the score engine consumed OR an output
// the engine produced — so the same row shows both what was seen and what was
// decided from it.
const CSV_HEADERS = [
  // Identity
  "date", "symbol",

  // Price inputs
  "price", "change_pct",
  "w52_high", "w52_low", "w52_pct",

  // Technical inputs
  "rsi14", "sma50", "sma200", "ma_signal",

  // Valuation inputs (engine reads data.valuation.*)
  "trailing_pe", "price_to_book", "dividend_yield",

  // Macro inputs (engine reads macro.*)
  "vix", "us10y", "us2y", "tips10y", "spread_2s10s", "hy_oas", "fed_funds",
  "wti", "mxn_usd", "brl_usd", "gscpi",

  // Cross-asset ratio inputs (engine reads data.<feed>.relative_spread_pp)
  "rsp_change_pct",           // SPY
  "alt_season_spread_pp",     // ETHA (ETHA vs IBIT)
  "copper_regime_spread_pp",  // GLNCY (GLNCY vs COPX)
  "ag_demand_spread_pp",      // MOS (MOS vs CORN)
  "dram_cycle_spread_pp",     // legacy SMH (SMH vs MU) — retained for CSV back-compat

  // Deterministic sub-scores (pre-blend)
  "det_tactical", "det_positional", "det_strategic", "det_composite",

  // LLM sub-scores (pre-blend)
  "llm_tactical", "llm_positional", "llm_strategic", "llm_composite",

  // Blended final scores (det/llm already combined)
  "tactical_score", "positional_score", "strategic_score", "composite_score",

  // Signals and recommendation
  "tactical_signal", "positional_signal", "strategic_signal", "recommendation",

  // Role assignment + z-scores (as before)
  "role", "z_tactical", "z_positional", "z_strategic", "z_composite",

  // Key metric + data quality
  "key_metric_name", "key_metric_value",
  "data_source",
  "confidence_level", "confidence_score", "confidence_missing",

  // ─── LIN-era additions (appended for CSV back-compat) ───────────────────
  // New macro fields
  "dxy", "us_ism", "eu_pmi", "china_pmi",
  // LIN-specific feeds
  "lin_peer_pe_premium_pct",   // LIN P/E premium vs APD+AI.PA peer avg
  "lin_backlog_yoy_pct",       // LIN sale-of-gas + on-site backlog YoY
  "lin_peer_relative_spread_pp", // LIN vs APD 1m spread
  "roce_pct",                  // LIN's signature metric (best-in-class >25%)
  "operating_margin_pct",      // LIN op margin (best-in-class >30%)
].join(",");

const csvExists = existsSync(CSV_PATH);
let csvContent = "";

if (!csvExists) {
  csvContent = CSV_HEADERS + "\n";
}

for (const s of normalized) {
  const md = marketData[s.symbol] || {};
  const role =
    s.symbol === assignments.tacticalBuy   ? "TACTICAL_BUY" :
    s.symbol === assignments.positionalBuy  ? "POSITIONAL_BUY" :
    s.symbol === assignments.strategicBuy   ? "STRATEGIC_BUY" :
    s.symbol === assignments.trim           ? "TRIM" : "HOLD";

  const esc = (v) => {
    if (v == null) return "";
    const str = String(v);
    return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const row = [
    // Identity
    date,
    s.symbol,

    // Price inputs
    s.price?.current ?? "",
    s.price?.change_pct ?? "",
    s.price?.week52_high ?? "",
    s.price?.week52_low ?? "",
    s.price?.week52_position_pct ?? "",

    // Technical inputs
    md.technicals?.rsi14 ?? "",
    md.technicals?.sma50 ?? "",
    md.technicals?.sma200 ?? "",
    md.technicals?.ma_signal ?? "",

    // Valuation inputs
    md.valuation?.trailingPE ?? "",
    md.valuation?.priceToBook ?? "",
    md.valuation?.dividendYield ?? "",

    // Macro inputs
    macro.vix ?? "",
    macro.us10y ?? "",
    macro.us2y ?? "",
    macro.tips10y ?? "",
    macro.spread_2s10s ?? "",
    macro.hy_oas ?? "",
    macro.fed_funds ?? "",
    macro.wti ?? "",
    macro.mxn_usd ?? "",
    macro.brl_usd ?? "",
    macro.gscpi ?? "",

    // Cross-asset spreads
    md.breadth?.rsp_change_pct ?? "",
    md.alt_season?.relative_spread_pp ?? "",
    md.copper_regime?.relative_spread_pp ?? "",
    md.ag_demand?.relative_spread_pp ?? "",
    md.dram_cycle?.relative_spread_pp ?? "",

    // Deterministic sub-scores
    s.tactical?.det_score ?? "",
    s.positional?.det_score ?? "",
    s.strategic?.det_score ?? "",
    s.composite?.det_score ?? "",

    // LLM sub-scores
    s.tactical?.llm_score ?? "",
    s.positional?.llm_score ?? "",
    s.strategic?.llm_score ?? "",
    s.composite?.llm_score ?? "",

    // Blended final scores
    s.tactical?.score ?? "",
    s.positional?.score ?? "",
    s.strategic?.score ?? "",
    s.composite?.score ?? "",

    // Signals
    s.tactical?.signal ?? "",
    s.positional?.signal ?? "",
    s.strategic?.signal ?? "",
    s.composite?.recommendation ?? "",

    // Role + z-scores
    role,
    s.z?.tactical?.toFixed(3) ?? "",
    s.z?.positional?.toFixed(3) ?? "",
    s.z?.strategic?.toFixed(3) ?? "",
    s.z?.composite?.toFixed(3) ?? "",

    // Key metric + data quality
    esc(s.key_metric?.name ?? ""),
    esc(s.key_metric?.value ?? ""),
    md.completeness ?? "unknown",
    s.confidence?.level ?? "",
    s.confidence?.score ?? "",
    esc((s.confidence?.missing || []).join(";")),

    // ─── LIN-era additions ────────────────────────────────────────────────
    // New macro fields (populated for every row — same macro applies to all)
    macro.dxy ?? "",
    macro.us_ism ?? "",
    macro.eu_pmi ?? "",
    macro.china_pmi ?? "",
    // LIN-specific feeds (only populated on LIN row, blank for others)
    md.peer_valuation?.premium_pct ?? "",
    md.backlog?.yoy_growth_pct ?? "",
    md.peer_relative?.relative_spread_pp ?? "",
    md.fundamentals?.roce_pct ?? "",
    md.fundamentals?.operating_margin_pct ?? "",
  ].join(",");

  csvContent += row + "\n";
}

// Append (or create)
if (csvExists) {
  const existing = readFileSync(CSV_PATH, "utf-8");
  writeFileSync(CSV_PATH, existing + csvContent);
} else {
  writeFileSync(CSV_PATH, csvContent);
}
console.log(`✓ CSV: ${normalized.length} rows appended to ${CSV_PATH}`);

// ─── 2. JSONL LOG ────────────────────────────────────────────────────────────
// One complete JSON object per day — machine-readable, full fidelity.
// Also expanded to include every input the engine consumed + det/llm split.
const dailyEntry = {
  date,
  timestamp,
  assignments,
  macro: {
    vix: macro.vix ?? null,
    us10y: macro.us10y ?? null,
    us2y: macro.us2y ?? null,
    tips10y: macro.tips10y ?? null,
    spread_2s10s: macro.spread_2s10s ?? null,
    hy_oas: macro.hy_oas ?? null,
    fed_funds: macro.fed_funds ?? null,
    wti: macro.wti ?? null,
    mxn_usd: macro.mxn_usd ?? null,
    brl_usd: macro.brl_usd ?? null,
    gscpi: macro.gscpi ?? null,
    // LIN-era macro additions
    dxy: macro.dxy ?? null,
    us_ism: macro.us_ism ?? null,
    eu_pmi: macro.eu_pmi ?? null,
    china_pmi: macro.china_pmi ?? null,
  },
  holdings: normalized.map(s => {
    const md = marketData[s.symbol] || {};
    return {
      symbol: s.symbol,

      // Price
      price: s.price?.current ?? null,
      change_pct: s.price?.change_pct ?? null,
      w52_pct: s.price?.week52_position_pct ?? null,
      w52_high: s.price?.week52_high ?? null,
      w52_low: s.price?.week52_low ?? null,

      // Technical
      rsi14: md.technicals?.rsi14 ?? null,
      sma50: md.technicals?.sma50 ?? null,
      sma200: md.technicals?.sma200 ?? null,
      ma_signal: md.technicals?.ma_signal ?? null,

      // Valuation
      trailing_pe: md.valuation?.trailingPE ?? null,
      price_to_book: md.valuation?.priceToBook ?? null,
      dividend_yield: md.valuation?.dividendYield ?? null,

      // Cross-asset spreads
      rsp_change_pct: md.breadth?.rsp_change_pct ?? null,
      alt_season_spread_pp: md.alt_season?.relative_spread_pp ?? null,
      copper_regime_spread_pp: md.copper_regime?.relative_spread_pp ?? null,
      ag_demand_spread_pp: md.ag_demand?.relative_spread_pp ?? null,
      dram_cycle_spread_pp: md.dram_cycle?.relative_spread_pp ?? null,

      // LIN-specific feeds
      lin_peer_pe_premium_pct: md.peer_valuation?.premium_pct ?? null,
      lin_backlog_yoy_pct: md.backlog?.yoy_growth_pct ?? null,
      lin_peer_relative_spread_pp: md.peer_relative?.relative_spread_pp ?? null,
      roce_pct: md.fundamentals?.roce_pct ?? null,
      operating_margin_pct: md.fundamentals?.operating_margin_pct ?? null,

      // Det/LLM/blended scores per timeframe
      tactical: {
        det: s.tactical?.det_score ?? null,
        llm: s.tactical?.llm_score ?? null,
        blended: s.tactical?.score ?? null,
        signal: s.tactical?.signal ?? null,
      },
      positional: {
        det: s.positional?.det_score ?? null,
        llm: s.positional?.llm_score ?? null,
        blended: s.positional?.score ?? null,
        signal: s.positional?.signal ?? null,
      },
      strategic: {
        det: s.strategic?.det_score ?? null,
        llm: s.strategic?.llm_score ?? null,
        blended: s.strategic?.score ?? null,
        signal: s.strategic?.signal ?? null,
      },
      composite: {
        det: s.composite?.det_score ?? null,
        llm: s.composite?.llm_score ?? null,
        blended: s.composite?.score ?? null,
        recommendation: s.composite?.recommendation ?? null,
      },

      z_composite: s.z?.composite ?? null,
      role:
        s.symbol === assignments.tacticalBuy   ? "TACTICAL_BUY" :
        s.symbol === assignments.positionalBuy  ? "POSITIONAL_BUY" :
        s.symbol === assignments.strategicBuy   ? "STRATEGIC_BUY" :
        s.symbol === assignments.trim           ? "TRIM" : "HOLD",
      data_source: md.completeness ?? "unknown",
      key_metric: s.key_metric?.name ? `${s.key_metric.name}: ${s.key_metric.value}` : null,
    };
  }),
};

// Append as a single line
const jsonlLine = JSON.stringify(dailyEntry) + "\n";
if (existsSync(JSONL_PATH)) {
  const existing = readFileSync(JSONL_PATH, "utf-8");
  // Check if today already logged (idempotent re-runs)
  if (existing.includes(`"date":"${date}"`)) {
    // Replace today's entry
    const lines = existing.trim().split("\n").filter(l => !l.includes(`"date":"${date}"`));
    lines.push(jsonlLine.trim());
    writeFileSync(JSONL_PATH, lines.join("\n") + "\n");
    console.log(`✓ JSONL: Updated existing entry for ${date}`);
  } else {
    writeFileSync(JSONL_PATH, existing + jsonlLine);
    console.log(`✓ JSONL: Appended ${date}`);
  }
} else {
  writeFileSync(JSONL_PATH, jsonlLine);
  console.log(`✓ JSONL: Created with ${date}`);
}

// ─── 3. ROLLING SUMMARY ─────────────────────────────────────────────────────
// Tracks assignment history for streak/consistency analysis. Unchanged.
let summary = { version: 1, firstDate: date, lastDate: date, totalDays: 0, assignments: {}, holdingStats: {} };
if (existsSync(SUMMARY_PATH)) {
  try { summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf-8")); } catch {}
}

summary.lastDate = date;
summary.totalDays = (summary.totalDays || 0) + 1;

// Track today's assignments
if (!summary.assignments.tactical) summary.assignments = { tactical: [], positional: [], strategic: [], trim: [] };
const pushMax = (arr, val) => { arr.push(val); if (arr.length > 90) arr.shift(); }; // keep last 90 days
pushMax(summary.assignments.tactical, { date, symbol: assignments.tacticalBuy });
pushMax(summary.assignments.positional, { date, symbol: assignments.positionalBuy });
pushMax(summary.assignments.strategic, { date, symbol: assignments.strategicBuy });
pushMax(summary.assignments.trim, { date, symbol: assignments.trim });

// Per-holding running stats
for (const s of normalized) {
  if (!summary.holdingStats[s.symbol]) {
    summary.holdingStats[s.symbol] = {
      appearances: 0,
      tacticalBuyCount: 0, positionalBuyCount: 0, strategicBuyCount: 0, trimCount: 0, holdCount: 0,
      compositeScores: [],
      avgComposite: 0,
    };
  }
  const hs = summary.holdingStats[s.symbol];
  hs.appearances++;
  if (s.symbol === assignments.tacticalBuy)   hs.tacticalBuyCount++;
  if (s.symbol === assignments.positionalBuy) hs.positionalBuyCount++;
  if (s.symbol === assignments.strategicBuy)  hs.strategicBuyCount++;
  if (s.symbol === assignments.trim)          hs.trimCount++;
  if (s.symbol !== assignments.tacticalBuy && s.symbol !== assignments.positionalBuy &&
      s.symbol !== assignments.strategicBuy && s.symbol !== assignments.trim) hs.holdCount++;
  pushMax(hs.compositeScores, s.composite?.score ?? 0);
  hs.avgComposite = +(hs.compositeScores.reduce((a, b) => a + b, 0) / hs.compositeScores.length).toFixed(2);
}

writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
console.log(`✓ Summary: ${summary.totalDays} days tracked`);

// ─── CONSOLE STATS ───────────────────────────────────────────────────────────
console.log(`\n─── HOLDING STATS ───`);
for (const [sym, hs] of Object.entries(summary.holdingStats)) {
  const buyTotal = hs.tacticalBuyCount + hs.positionalBuyCount + hs.strategicBuyCount;
  console.log(`  ${sym.padEnd(7)} ${hs.appearances}d tracked | Buy:${buyTotal} Trim:${hs.trimCount} Hold:${hs.holdCount} | AvgComp:${hs.avgComposite}`);
}

console.log("\n✓ History logging complete");
