#!/usr/bin/env node
// calibration-v2.mjs v1.0 — Temporal z-scoring + v8 telemetry audits.
//
// REPORTING ONLY. This script changes NO scoring parameters, weights, thresholds,
// or gates. It reads committed telemetry and writes docs/history/calibration-v2.json —
// the evidence substrate for the Level-2 propose-approve-apply loop. Any parameter
// change remains a manual, explicitly approved edit.
//
// Runs nightly from calibration-summary.yml (after attribute-signals has updated
// forward returns), alongside calibration-summary.mjs. Reads:
//   docs/history/daily-log.jsonl            (blended/det/llm scores, divergence,
//                                            hostile_review, regime telemetry)
//   docs/history/signals_with_returns.jsonl (realized forward returns per layer)
//
// FOUR SECTIONS:
//
// 1. TEMPORAL Z-SCORING v1 (the consumer-facing output).
//    Cross-sectional z (normalize() in generate-signals) answers "how does this
//    score rank across the book today." Temporal z answers "how unusual is this
//    score for THIS NAME against its own history" — the two are orthogonal and
//    the second has never existed. Per ticker, per layer (tactical / positional /
//    strategic / composite), over the ticker's own BLENDED score series:
//      eligibility: >= TEMPORAL_MIN_OBS total observations (60 — the threshold
//        settled in the June planning session; tickers roll in automatically as
//        they cross it, no code change needed);
//      baseline: mean/std over the trailing TEMPORAL_WINDOW observations
//        EXCLUDING the most recent one (so the latest score never contaminates
//        the baseline it is measured against); std floored at 1.0 (same floor
//        as cross-sectional normalize()) so a flat series can't explode z;
//      latest.z: yesterday's logged score against that baseline.
//    generate-signals v8.2.0 reads the stored baseline next morning (via
//    calibration-loader.loadTemporalZ) to (a) inject a one-line temporal-context
//    note into the LLM prompt and (b) stamp tz onto each result for the logger.
//    The one-day staleness of the baseline is immaterial at window 60.
//
// 2. DIVERGENCE ATTRIBUTION. For layer-days where |det − llm| > DIVERGENCE_GATE
//    (40, matching generate-signals' flag threshold), join realized forward
//    returns at each layer's native horizon (tactical 5d, positional 20d,
//    strategic 60d) and score who was right. Direction convention: score <= -10
//    calls UP, score >= +10 calls DOWN, in between is no-call. Aggregated per
//    ticker+layer and per layer. This is the evidence base for future blend-
//    weight proposals — deliberately NOT applied here.
//
// 3. FALSIFIER COVERAGE. Catalog of hostile_review falsifiers: per ticker, how
//    many logged days carry non-empty falsifiers per layer, plus the latest
//    falsifier text. v1 is a coverage catalog only — mechanically auditing
//    whether a prose falsifier "triggered" is Level-2 work.
//
// 4. REGIME GATE TALLY. For tickers with regime telemetry (regime_basis
//    non-null): distribution of observed regime states, and composite-layer
//    5d directional hit rate split by state where n >= REGIME_MIN_N (10);
//    smaller cells report "insufficient". Descriptive only.
//
// STATISTICAL HONESTY (stamped into output.notes): forward returns at 5/20/60d
// horizons overlap heavily across consecutive daily signals, so effective
// independent sample sizes are far below nominal n. Directional evidence, not
// grounds for mechanical parameter rewrites. v8 telemetry (divergence,
// hostile_review, regime driver/basis) only began accruing mid-June 2026, so
// sections 2–4 start thin and deepen with time.
//
// Output: docs/history/calibration-v2.json (additive; no existing consumer
// contracts change). Loud console report. Exits 0 even when sections are thin —
// thin data is a reported state, not a failure.

import { readFileSync, writeFileSync, existsSync } from "fs";

const HISTORY_DIR = "docs/history";
const DAILY_LOG_PATH = `${HISTORY_DIR}/daily-log.jsonl`;
const RETURNS_PATH = `${HISTORY_DIR}/signals_with_returns.jsonl`;
const OUTPUT_PATH = `${HISTORY_DIR}/calibration-v2.json`;

const TEMPORAL_MIN_OBS = parseInt(process.env.TEMPORAL_MIN_OBS || "60", 10);
const TEMPORAL_WINDOW = parseInt(process.env.TEMPORAL_WINDOW || "60", 10);
const DIVERGENCE_GATE = parseInt(process.env.DIVERGENCE_GATE || "40", 10);
const DIRECTION_DEADBAND = 10; // |score| < 10 = no directional call (matches attribution convention)
const REGIME_MIN_N = parseInt(process.env.REGIME_MIN_N || "10", 10);

const LAYERS = ["tactical", "positional", "strategic", "composite"];
const NATIVE_HORIZON = { tactical: "5d", positional: "20d", strategic: "60d" };

// ─── LOAD ────────────────────────────────────────────────────────────────────

function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], skipped: 0, missing: true };
  const lines = readFileSync(path, "utf-8").split("\n").filter(l => l.trim());
  const rows = [];
  let skipped = 0;
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch { skipped++; }
  }
  return { rows, skipped, missing: false };
}

// Blended layer score from a daily-log holding, tolerant of both shapes:
// modern { det, llm, blended, ... } objects and legacy plain numbers.
function blendedScore(h, layer) {
  const v = h?.[layer];
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.blended === "number") return v.blended;
  if (typeof v.score === "number") return v.score;
  return null;
}
function detScore(h, layer) {
  const v = h?.[layer];
  return v && typeof v === "object" && typeof v.det === "number" ? v.det : null;
}
function llmScore(h, layer) {
  const v = h?.[layer];
  return v && typeof v === "object" && typeof v.llm === "number" ? v.llm : null;
}

// ─── SECTION 1: TEMPORAL Z ───────────────────────────────────────────────────

function meanStd(arr) {
  const n = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.max(Math.sqrt(variance), 1.0) }; // floor 1.0, same as normalize()
}

function computeTemporalZ(dailyRows) {
  // Per-ticker, per-layer blended score series in date order.
  const series = {}; // sym -> layer -> [{date, score}]
  for (const entry of dailyRows) {
    for (const h of entry.holdings || []) {
      if (!h.symbol) continue;
      series[h.symbol] = series[h.symbol] || {};
      for (const layer of LAYERS) {
        const s = blendedScore(h, layer);
        if (s == null) continue;
        (series[h.symbol][layer] = series[h.symbol][layer] || []).push({ date: entry.date, score: s });
      }
    }
  }

  const out = {};
  for (const [sym, layers] of Object.entries(series)) {
    const obs = layers.composite?.length || 0;
    const eligible = obs >= TEMPORAL_MIN_OBS;
    const rec = { eligible, observations: obs, min_obs: TEMPORAL_MIN_OBS, layers: {} };
    if (eligible) {
      for (const layer of LAYERS) {
        const pts = layers[layer] || [];
        if (pts.length < TEMPORAL_MIN_OBS) { rec.layers[layer] = { eligible: false, observations: pts.length }; continue; }
        const latest = pts[pts.length - 1];
        // Baseline: trailing window EXCLUDING the latest observation.
        const window = pts.slice(Math.max(0, pts.length - 1 - TEMPORAL_WINDOW), pts.length - 1).map(p => p.score);
        const { mean, std } = meanStd(window);
        rec.layers[layer] = {
          eligible: true,
          window_n: window.length,
          mean: +mean.toFixed(2),
          std: +std.toFixed(2),
          latest: { date: latest.date, score: latest.score, z: +((latest.score - mean) / std).toFixed(2) },
        };
      }
    }
    out[sym] = rec;
  }
  return out;
}

// ─── SECTION 2: DIVERGENCE ATTRIBUTION ───────────────────────────────────────

function directionCall(score) {
  if (score == null) return null;
  if (score <= -DIRECTION_DEADBAND) return "up";   // negative score = buy = expect positive fwd return
  if (score >= DIRECTION_DEADBAND) return "down";
  return null;
}

function computeDivergenceAttribution(dailyRows, returnRows) {
  // Index forward returns by date|symbol.
  const fwdIndex = new Map();
  for (const r of returnRows) {
    if (r.date && r.symbol) fwdIndex.set(`${r.date}|${r.symbol}`, r.forward_returns || {});
  }

  const perKey = {}; // "SYM|layer" -> tallies
  const perLayer = {}; // layer -> tallies
  const bump = (obj, key, field) => { obj[key] = obj[key] || { n: 0, det_wins: 0, llm_wins: 0, both_right: 0, both_wrong: 0, no_call: 0 }; obj[key][field]++; if (field !== "n") obj[key].n++; };

  let joined = 0, unresolved = 0;
  for (const entry of dailyRows) {
    for (const h of entry.holdings || []) {
      const div = h.divergence;
      if (!div) continue; // pre-v8 rows carry no divergence telemetry
      const fwd = fwdIndex.get(`${entry.date}|${h.symbol}`);
      for (const layer of ["tactical", "positional", "strategic"]) {
        const gap = typeof div[layer] === "number" ? div[layer] : null;
        if (gap == null || gap <= DIVERGENCE_GATE) continue;
        const det = detScore(h, layer), llm = llmScore(h, layer);
        const ret = fwd?.[NATIVE_HORIZON[layer]];
        if (det == null || llm == null || ret == null) { unresolved++; continue; }
        joined++;
        const actual = ret > 0 ? "up" : ret < 0 ? "down" : null;
        const detCall = directionCall(det), llmCall = directionCall(llm);
        const key = `${h.symbol}|${layer}`;
        let field;
        if (!actual || (!detCall && !llmCall)) field = "no_call";
        else if (detCall === actual && llmCall === actual) field = "both_right";
        else if (detCall === actual) field = "det_wins";
        else if (llmCall === actual) field = "llm_wins";
        else field = "both_wrong";
        bump(perKey, key, field);
        bump(perLayer, layer, field);
      }
    }
  }

  const byTickerLayer = {};
  for (const [key, t] of Object.entries(perKey)) {
    const [sym, layer] = key.split("|");
    byTickerLayer[sym] = byTickerLayer[sym] || {};
    byTickerLayer[sym][layer] = t;
  }
  return { gate: DIVERGENCE_GATE, deadband: DIRECTION_DEADBAND, joined, unresolved_pending_returns: unresolved, by_layer: perLayer, by_ticker_layer: byTickerLayer };
}

// ─── SECTION 3: FALSIFIER COVERAGE ───────────────────────────────────────────

function computeFalsifierCoverage(dailyRows) {
  const out = {};
  for (const entry of dailyRows) {
    for (const h of entry.holdings || []) {
      const hr = h.hostile_review;
      if (!hr) continue;
      const rec = (out[h.symbol] = out[h.symbol] || { days_with_hostile_review: 0, falsifier_days: { tactical: 0, positional: 0, strategic: 0 }, latest: {} });
      rec.days_with_hostile_review++;
      for (const layer of ["tactical", "positional", "strategic"]) {
        const f = hr[layer]?.falsifier;
        if (typeof f === "string" && f.trim().length > 0) {
          rec.falsifier_days[layer]++;
          rec.latest[layer] = { date: entry.date, falsifier: f.trim().slice(0, 400) };
        }
      }
    }
  }
  return out;
}

// ─── SECTION 4: REGIME GATE TALLY ────────────────────────────────────────────

function computeRegimeGates(dailyRows, returnRows) {
  const fwdIndex = new Map();
  for (const r of returnRows) {
    if (r.date && r.symbol) fwdIndex.set(`${r.date}|${r.symbol}`, r.forward_returns || {});
  }
  const out = {};
  for (const entry of dailyRows) {
    for (const h of entry.holdings || []) {
      if (!h.regime_basis && !h.regime) continue;
      const state = h.regime ?? "unknown";
      const rec = (out[h.symbol] = out[h.symbol] || { basis: h.regime_basis ?? null, states: {} });
      if (h.regime_basis) rec.basis = h.regime_basis;
      const st = (rec.states[state] = rec.states[state] || { days: 0, composite_calls: 0, composite_hits: 0 });
      st.days++;
      const comp = blendedScore(h, "composite");
      const call = directionCall(comp);
      const ret = fwdIndex.get(`${entry.date}|${h.symbol}`)?.["5d"];
      if (call && ret != null && ret !== 0) {
        st.composite_calls++;
        const actual = ret > 0 ? "up" : "down";
        if (call === actual) st.composite_hits++;
      }
    }
  }
  for (const rec of Object.values(out)) {
    for (const st of Object.values(rec.states)) {
      st.hit_rate = st.composite_calls >= REGIME_MIN_N ? +(st.composite_hits / st.composite_calls).toFixed(3) : null;
      st.sample = st.composite_calls >= REGIME_MIN_N ? "ok" : "insufficient";
    }
  }
  return out;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main() {
  console.log("calibration-v2 v1.0 — temporal z + telemetry audits (REPORTING ONLY — no parameters changed)");

  const daily = readJsonl(DAILY_LOG_PATH);
  const returns = readJsonl(RETURNS_PATH);
  if (daily.missing) { console.error(`✗ ${DAILY_LOG_PATH} not found — nothing to do.`); process.exit(1); }
  if (daily.skipped > 0) console.warn(`⚠ ${daily.skipped} malformed line(s) skipped in daily-log.jsonl`);
  if (returns.missing) console.warn(`⚠ ${RETURNS_PATH} not found — divergence attribution and regime hit rates will be empty.`);
  if (returns.skipped > 0) console.warn(`⚠ ${returns.skipped} malformed line(s) skipped in signals_with_returns.jsonl`);
  console.log(`  daily-log: ${daily.rows.length} entries | returns: ${returns.rows.length} rows`);

  const temporalZ = computeTemporalZ(daily.rows);
  const divergence = computeDivergenceAttribution(daily.rows, returns.rows);
  const falsifiers = computeFalsifierCoverage(daily.rows);
  const regimes = computeRegimeGates(daily.rows, returns.rows);

  // Console report — temporal z.
  const eligible = Object.entries(temporalZ).filter(([, v]) => v.eligible);
  const pending = Object.entries(temporalZ).filter(([, v]) => !v.eligible)
    .sort((a, b) => b[1].observations - a[1].observations);
  console.log(`\n── TEMPORAL Z (window ${TEMPORAL_WINDOW}, min obs ${TEMPORAL_MIN_OBS}) ──`);
  console.log(`  eligible: ${eligible.length} ticker(s)`);
  for (const [sym, v] of eligible.sort()) {
    const c = v.layers.composite;
    if (c?.eligible) console.log(`    ${sym.padEnd(6)} composite ${String(c.latest.score).padStart(4)} vs own μ ${c.mean} σ ${c.std} → z ${c.latest.z >= 0 ? "+" : ""}${c.latest.z}`);
  }
  if (pending.length) console.log(`  pending: ${pending.map(([s, v]) => `${s} (${v.observations})`).join(", ")}`);

  // Console report — divergence.
  console.log(`\n── DIVERGENCE ATTRIBUTION (gap > ${DIVERGENCE_GATE}) ──`);
  console.log(`  resolved layer-days: ${divergence.joined} | awaiting forward returns: ${divergence.unresolved_pending_returns}`);
  for (const [layer, t] of Object.entries(divergence.by_layer)) {
    console.log(`    ${layer.padEnd(10)} n=${t.n} det_wins=${t.det_wins} llm_wins=${t.llm_wins} both_right=${t.both_right} both_wrong=${t.both_wrong} no_call=${t.no_call}`);
  }
  if (divergence.joined === 0) console.log("    (thin — v8 telemetry began mid-June 2026; deepens as returns mature)");

  // Console report — falsifiers + regimes (one-liners).
  const fCount = Object.keys(falsifiers).length;
  console.log(`\n── FALSIFIER COVERAGE ── ${fCount} ticker(s) with hostile_review telemetry`);
  const rCount = Object.keys(regimes).length;
  console.log(`── REGIME GATES ── ${rCount} ticker(s) with regime telemetry`);

  const output = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    stance: "reporting_only_no_parameters_changed",
    params: { temporal_min_obs: TEMPORAL_MIN_OBS, temporal_window: TEMPORAL_WINDOW, divergence_gate: DIVERGENCE_GATE, direction_deadband: DIRECTION_DEADBAND, regime_min_n: REGIME_MIN_N },
    data_quality: {
      daily_log_entries: daily.rows.length,
      daily_log_skipped: daily.skipped,
      returns_rows: returns.rows.length,
      returns_skipped: returns.skipped,
      returns_missing: returns.missing,
    },
    notes: [
      "Forward returns at 5/20/60d horizons overlap across consecutive daily signals; effective independent sample is far below nominal n. Directional evidence only — not grounds for mechanical parameter changes.",
      "v8 telemetry (divergence, hostile_review, regime driver/basis) began accruing mid-June 2026; sections 2-4 deepen with time.",
      "Temporal z baseline excludes the most recent observation; generate-signals consumes the stored baseline next morning (one-day staleness, immaterial at window 60).",
    ],
    temporal_z: temporalZ,
    divergence_attribution: divergence,
    falsifier_coverage: falsifiers,
    regime_gates: regimes,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`);
}

main();
