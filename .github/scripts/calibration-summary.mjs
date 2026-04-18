// ─── calibration-summary.mjs ──────────────────────────────────────────────────
// Rolls signals_with_returns.jsonl up into a single pre-computed JSON that the
// dashboard's Calibration tab can fetch and render directly. No client-side
// aggregation over thousands of rows.
//
// Output: docs/history/calibration.json
//
// Structure:
//   {
//     generated_at, signal_count, date_range,
//     per_ticker: {
//       MOS: {
//         n, data_through,
//         layers: {
//           tactical:   { native_horizon, buckets: [...], scatter: [...], hit_rate, mean_return, n_scored },
//           positional: { ... },
//           strategic:  { ... }
//         },
//         rolling: [ { date, tac_hit_rate_20d, pos_hit_rate_20d, str_hit_rate_20d }, ... ],
//         composite: { hit_rate, mean_return, n_scored }
//       },
//       ... (per ticker)
//     },
//     portfolio: { hit_rate, mean_return, n_scored }  // aggregated across all tickers
//   }
//
// Runs nightly after attribute-signals.mjs.
// ────────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";

const HISTORY_DIR   = process.env.HISTORY_DIR   || "docs/history";
const INPUT_FILE    = process.env.INPUT_FILE    || path.join(HISTORY_DIR, "signals_with_returns.jsonl");
const OUTPUT_FILE   = process.env.OUTPUT_FILE   || path.join(HISTORY_DIR, "calibration.json");

// Score buckets — symmetric around zero, covering the full -100 to +100 range
const BUCKETS = [
  { label: "≤-60",      min: -101, max: -60 },
  { label: "-60 to -30", min: -60,  max: -30 },
  { label: "-30 to -10", min: -30,  max: -10 },
  { label: "-10 to +10", min: -10,  max: 10  },
  { label: "+10 to +30", min: 10,   max: 30  },
  { label: "+30 to +60", min: 30,   max: 60  },
  { label: "≥+60",      min: 60,   max: 101 },
];

const LAYER_NATIVE_HORIZON = {
  tactical:   "5d",
  positional: "20d",
  strategic:  "60d",
};

const NEUTRAL_BAND = 5;
const ROLLING_WINDOW = 20; // trading days for rolling hit rate

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function loadJsonl(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split("\n").filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const hitRate = arr => arr.length ? arr.filter(Boolean).length / arr.length : null;

function directionCorrect(score, ret) {
  if (score == null || ret == null) return null;
  if (Math.abs(score) < NEUTRAL_BAND) return null;
  if (score < 0 && ret > 0) return true;
  if (score > 0 && ret < 0) return true;
  return false;
}

function bucketFor(score) {
  if (score == null) return null;
  for (const b of BUCKETS) {
    if (score >= b.min && score < b.max) return b.label;
  }
  return null;
}

// ─── PER-LAYER CALIBRATION ────────────────────────────────────────────────────
function computeLayerCalibration(records, layer) {
  const horizon = LAYER_NATIVE_HORIZON[layer];
  const scored = records
    .map(r => ({
      date:    r.date,
      score:   r.scores?.[layer],
      return_: r.forward_returns?.[horizon],
      correct: r.layer_attribution?.[layer]?.direction_correct,
    }))
    .filter(x => x.score != null);

  // Bucket table
  const bucketMap = {};
  for (const b of BUCKETS) bucketMap[b.label] = { label: b.label, n: 0, returns: [], corrects: [] };

  for (const x of scored) {
    const b = bucketFor(x.score);
    if (!b) continue;
    bucketMap[b].n++;
    if (x.return_ != null) bucketMap[b].returns.push(x.return_);
    if (x.correct != null) bucketMap[b].corrects.push(x.correct);
  }

  const buckets = BUCKETS.map(b => {
    const m = bucketMap[b.label];
    return {
      label:         b.label,
      n:             m.n,
      n_with_return: m.returns.length,
      mean_return:   mean(m.returns),
      hit_rate:      hitRate(m.corrects),
    };
  });

  // Scatter data — (score, return) pairs only where return is known
  const scatter = scored
    .filter(x => x.return_ != null)
    .map(x => ({ date: x.date, score: x.score, return_: x.return_ }));

  // Aggregates across the whole layer
  const withReturn = scored.filter(x => x.return_ != null);
  const withCorrect = scored.filter(x => x.correct != null);

  return {
    native_horizon: horizon,
    n_total:        scored.length,
    n_scored:       withReturn.length,   // how many have a forward return filled in
    n_conviction:   withCorrect.length,  // how many are outside the neutral band AND have a return
    hit_rate:       hitRate(withCorrect.map(x => x.correct)),
    mean_return:    mean(withReturn.map(x => x.return_)),
    buckets,
    scatter,
  };
}

// ─── COMPOSITE CALIBRATION ────────────────────────────────────────────────────
// Uses the 20d horizon as the canonical composite view.
function computeCompositeCalibration(records) {
  const horizon = "20d";
  const scored = records.map(r => ({
    score:   r.scores?.composite,
    return_: r.forward_returns?.[horizon],
  })).filter(x => x.score != null);

  const withReturn = scored.filter(x => x.return_ != null);
  const corrects = withReturn
    .map(x => directionCorrect(x.score, x.return_))
    .filter(v => v != null);

  return {
    horizon,
    n_total:    scored.length,
    n_scored:   withReturn.length,
    hit_rate:   hitRate(corrects),
    mean_return: mean(withReturn.map(x => x.return_)),
  };
}

// ─── ROLLING SERIES ───────────────────────────────────────────────────────────
// For each (ticker, date), compute trailing-N hit rate per layer.
function computeRollingHitRates(records) {
  // Sort chronologically
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));

  const series = [];
  const windows = { tactical: [], positional: [], strategic: [] };

  for (const r of sorted) {
    for (const layer of ["tactical", "positional", "strategic"]) {
      const correct = r.layer_attribution?.[layer]?.direction_correct;
      if (correct != null) {
        windows[layer].push(correct);
        if (windows[layer].length > ROLLING_WINDOW) windows[layer].shift();
      }
    }
    series.push({
      date:             r.date,
      tac_hit_rate:     hitRate(windows.tactical),
      pos_hit_rate:     hitRate(windows.positional),
      str_hit_rate:     hitRate(windows.strategic),
      tac_n_in_window:  windows.tactical.length,
      pos_n_in_window:  windows.positional.length,
      str_n_in_window:  windows.strategic.length,
    });
  }
  return series;
}

// ─── PORTFOLIO-LEVEL AGGREGATE ────────────────────────────────────────────────
function computePortfolioAggregate(allRecords) {
  const corrects = { tactical: [], positional: [], strategic: [] };
  const returns  = { tactical: [], positional: [], strategic: [] };

  for (const r of allRecords) {
    for (const layer of ["tactical", "positional", "strategic"]) {
      const c = r.layer_attribution?.[layer]?.direction_correct;
      const h = LAYER_NATIVE_HORIZON[layer];
      const ret = r.forward_returns?.[h];
      if (c != null) corrects[layer].push(c);
      if (ret != null && r.scores?.[layer] != null) returns[layer].push(ret);
    }
  }

  return {
    tactical:   { hit_rate: hitRate(corrects.tactical),   mean_return: mean(returns.tactical),   n: corrects.tactical.length },
    positional: { hit_rate: hitRate(corrects.positional), mean_return: mean(returns.positional), n: corrects.positional.length },
    strategic:  { hit_rate: hitRate(corrects.strategic),  mean_return: mean(returns.strategic),  n: corrects.strategic.length },
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("[calibration-summary] loading enriched signals...");
  const records = await loadJsonl(INPUT_FILE);
  console.log(`  loaded ${records.length} records from ${INPUT_FILE}`);

  if (records.length === 0) {
    console.log("  no records to summarize; writing empty file");
    const empty = {
      generated_at: new Date().toISOString(),
      signal_count: 0,
      date_range:   { start: null, end: null },
      per_ticker:   {},
      portfolio:    {},
      note:         "No enriched signals found. Run attribute-signals.mjs first.",
    };
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(empty, null, 2) + "\n");
    return;
  }

  // Group by ticker
  const byTicker = {};
  for (const r of records) {
    if (!byTicker[r.symbol]) byTicker[r.symbol] = [];
    byTicker[r.symbol].push(r);
  }

  // Per-ticker rollup
  const perTicker = {};
  for (const [symbol, recs] of Object.entries(byTicker)) {
    const dates = recs.map(r => r.date).sort();
    perTicker[symbol] = {
      n:            recs.length,
      data_through: dates[dates.length - 1],
      data_from:    dates[0],
      layers: {
        tactical:   computeLayerCalibration(recs, "tactical"),
        positional: computeLayerCalibration(recs, "positional"),
        strategic:  computeLayerCalibration(recs, "strategic"),
      },
      composite:    computeCompositeCalibration(recs),
      rolling:      computeRollingHitRates(recs),
    };
  }

  const allDates = records.map(r => r.date).sort();
  const output = {
    generated_at: new Date().toISOString(),
    signal_count: records.length,
    date_range:   { start: allDates[0], end: allDates[allDates.length - 1] },
    rolling_window_days: ROLLING_WINDOW,
    neutral_band:        NEUTRAL_BAND,
    per_ticker:          perTicker,
    portfolio:           computePortfolioAggregate(records),
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(`[calibration-summary] wrote ${OUTPUT_FILE}`);

  // Console summary
  console.log("\n  per-ticker hit rates (tactical / positional / strategic):");
  for (const [sym, t] of Object.entries(perTicker).sort()) {
    const fmt = v => v == null ? "  -" : (v * 100).toFixed(0).padStart(3) + "%";
    console.log(`    ${sym.padEnd(8)} n=${t.n.toString().padStart(3)}   ${fmt(t.layers.tactical.hit_rate)}  ${fmt(t.layers.positional.hit_rate)}  ${fmt(t.layers.strategic.hit_rate)}`);
  }

  console.log("\n  portfolio-level:");
  const p = output.portfolio;
  for (const layer of ["tactical", "positional", "strategic"]) {
    const hr = p[layer].hit_rate;
    const mr = p[layer].mean_return;
    console.log(`    ${layer.padEnd(11)} n=${p[layer].n.toString().padStart(3)}  hit=${hr == null ? "-" : (hr * 100).toFixed(0) + "%"}  mean_ret=${mr == null ? "-" : (mr * 100).toFixed(2) + "%"}`);
  }
}

main().catch(e => {
  console.error("[calibration-summary] FATAL:", e);
  process.exit(1);
});
