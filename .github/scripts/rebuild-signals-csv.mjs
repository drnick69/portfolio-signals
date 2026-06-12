// ─── rebuild-signals-csv.mjs ─────────────────────────────────────────────────
// ONE-SHOT FIX (June 2026): rebuilds docs/history/signals.csv from
// docs/history/daily-log.jsonl under the unified log-signals v8.0 header.
//
// WHY: signals.csv accumulated six row schemas (30/33/57/66/87/103 fields)
// under the original 30-column header as columns were appended across
// versions. Header-positional consumers (signal-accuracy.mjs) misparsed every
// row written after the first schema change. daily-log.jsonl is keyed by
// field name and full-fidelity, so it is the authoritative source to rebuild
// from.
//
// WHAT IT DOES:
//   1. Backs up the existing signals.csv to signals.csv.pre-rebuild.bak
//      (first run only — an existing backup is never overwritten).
//   2. Re-emits one row per (day, holding) from daily-log.jsonl in entry
//      order, under the exact v8.0 109-column header.
//   3. Self-validates: re-parses the output quote-aware and asserts every
//      row has exactly header width; prints a reconciliation summary.
//
// FIELDS NOT RECOVERABLE FROM daily-log.jsonl (blank by design in rebuilt
// rows; logged normally for all rows going forward):
//   z_tactical, z_positional, z_strategic   (JSONL stores z_composite only)
//   confidence_level / _score / _missing    (never persisted to JSONL)
//
// KEEP IN SYNC: the COLUMNS list below mirrors CSV_HEADERS in
// log-signals.mjs v8.0 exactly (109 columns). If log-signals appends
// columns, append matching extractors here before any future re-run.
//
// Safe to re-run: output is regenerated from JSONL each time; the .bak from
// the first run is preserved.
// ────────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";

const HISTORY_DIR = process.env.HISTORY_DIR || "docs/history";
const JSONL_PATH  = `${HISTORY_DIR}/daily-log.jsonl`;
const CSV_PATH    = `${HISTORY_DIR}/signals.csv`;
const BAK_PATH    = `${HISTORY_DIR}/signals.csv.pre-rebuild.bak`;

// ─── helpers ─────────────────────────────────────────────────────────────────
const esc = (v) => {
  if (v == null || v === "") return "";
  const str = String(v);
  return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
};

// Tolerant getters — daily-log shapes evolved; mirror attribute-signals' defenses.
const num = (v) => (typeof v === "number" ? v : null);
const price = (h) => num(h.price) ?? h.price?.current ?? null;
const layer = (h, l) => h[l] || {};
const blended = (h, l) => layer(h, l).blended ?? layer(h, l).score ?? null;
const kmName  = (h) => typeof h.key_metric === "string" ? h.key_metric.split(": ")[0] : (h.key_metric?.name ?? null);
const kmValue = (h) => typeof h.key_metric === "string"
  ? (h.key_metric.includes(": ") ? h.key_metric.slice(h.key_metric.indexOf(": ") + 2) : null)
  : (h.key_metric?.value ?? null);

// ─── column map: [header, extractor(holding, macro, entry)] ─────────────────
// Order mirrors log-signals.mjs v8.0 CSV_HEADERS exactly.
const COLUMNS = [
  // Identity
  ["date",   (h, m, e) => e.date],
  ["symbol", (h) => h.symbol],
  // Price inputs
  ["price",      (h) => price(h)],
  ["change_pct", (h) => h.change_pct],
  ["w52_high",   (h) => h.w52_high],
  ["w52_low",    (h) => h.w52_low],
  ["w52_pct",    (h) => h.w52_pct],
  // Technical inputs
  ["rsi14",     (h) => h.rsi14],
  ["sma50",     (h) => h.sma50],
  ["sma200",    (h) => h.sma200],
  ["ma_signal", (h) => h.ma_signal],
  // Valuation inputs
  ["trailing_pe",    (h) => h.trailing_pe],
  ["price_to_book",  (h) => h.price_to_book],
  ["dividend_yield", (h) => h.dividend_yield],
  // Macro inputs
  ["vix",          (h, m) => m.vix],
  ["us10y",        (h, m) => m.us10y],
  ["us2y",         (h, m) => m.us2y],
  ["tips10y",      (h, m) => m.tips10y],
  ["spread_2s10s", (h, m) => m.spread_2s10s],
  ["hy_oas",       (h, m) => m.hy_oas],
  ["fed_funds",    (h, m) => m.fed_funds],
  ["wti",          (h, m) => m.wti],
  ["mxn_usd",      (h, m) => m.mxn_usd],
  ["brl_usd",      (h, m) => m.brl_usd],
  ["gscpi",        (h, m) => m.gscpi],
  // Cross-asset ratio inputs
  ["rsp_change_pct",          (h) => h.rsp_change_pct],
  ["alt_season_spread_pp",    (h) => h.alt_season_spread_pp],
  ["copper_regime_spread_pp", (h) => h.copper_regime_spread_pp],
  ["ag_demand_spread_pp",     (h) => h.ag_demand_spread_pp],
  ["dram_cycle_spread_pp",    (h) => h.dram_cycle_spread_pp],
  // Deterministic sub-scores
  ["det_tactical",   (h) => layer(h, "tactical").det],
  ["det_positional", (h) => layer(h, "positional").det],
  ["det_strategic",  (h) => layer(h, "strategic").det],
  ["det_composite",  (h) => layer(h, "composite").det],
  // LLM sub-scores
  ["llm_tactical",   (h) => layer(h, "tactical").llm],
  ["llm_positional", (h) => layer(h, "positional").llm],
  ["llm_strategic",  (h) => layer(h, "strategic").llm],
  ["llm_composite",  (h) => layer(h, "composite").llm],
  // Blended final scores
  ["tactical_score",   (h) => blended(h, "tactical")],
  ["positional_score", (h) => blended(h, "positional")],
  ["strategic_score",  (h) => blended(h, "strategic")],
  ["composite_score",  (h) => blended(h, "composite")],
  // Signals and recommendation
  ["tactical_signal",   (h) => layer(h, "tactical").signal],
  ["positional_signal", (h) => layer(h, "positional").signal],
  ["strategic_signal",  (h) => layer(h, "strategic").signal],
  ["recommendation",    (h) => layer(h, "composite").recommendation],
  // Role assignment + z-scores
  ["role",         (h) => h.role],
  ["z_tactical",   () => null],   // not in JSONL — blank by design
  ["z_positional", () => null],   // not in JSONL — blank by design
  ["z_strategic",  () => null],   // not in JSONL — blank by design
  ["z_composite",  (h) => h.z_composite],
  // Key metric + data quality
  ["key_metric_name",    (h) => kmName(h)],
  ["key_metric_value",   (h) => kmValue(h)],
  ["data_source",        (h) => h.data_source],
  ["confidence_level",   () => null],  // not in JSONL — blank by design
  ["confidence_score",   () => null],  // not in JSONL — blank by design
  ["confidence_missing", () => null],  // not in JSONL — blank by design
  // LIN-era additions
  ["dxy",       (h, m) => m.dxy],
  ["us_ism",    (h, m) => m.us_ism],
  ["eu_pmi",    (h, m) => m.eu_pmi],
  ["china_pmi", (h, m) => m.china_pmi],
  ["lin_peer_pe_premium_pct",     (h) => h.lin_peer_pe_premium_pct],
  ["lin_backlog_yoy_pct",         (h) => h.lin_backlog_yoy_pct],
  ["lin_peer_relative_spread_pp", (h) => h.lin_peer_relative_spread_pp],
  ["roce_pct",                    (h) => h.roce_pct],
  ["operating_margin_pct",        (h) => h.operating_margin_pct],
  // V3 additions
  ["bbb_oas_bps",           (h, m) => m.bbb_oas_bps],
  ["bbb_oas_1m_change_bps", (h, m) => m.bbb_oas_1m_change_bps],
  ["iv_rv_ratio",           (h) => h.iv_rv_ratio],
  ["qual_vs_spy_30d_pp",    (h) => h.qual_vs_spy_30d_pp],
  ["spy_10d_drawdown_pct",  (h) => h.spy_10d_drawdown_pct],
  ["lin_vs_spy_10d_pp",     (h) => h.lin_vs_spy_10d_pp],
  ["asu_utilization_pct",   (h) => h.asu_utilization_pct],
  ["price_mix_ex_fx_pct",   (h) => h.price_mix_ex_fx_pct],
  ["eps_revisions_30d_pct", (h) => h.eps_revisions_30d_pct],
  ["eps_revisions_90d_pct", (h) => h.eps_revisions_90d_pct],
  ["lin_peer_aipa_spread_pp",     (h) => h.lin_peer_aipa_spread_pp],
  ["peer_pe_premium_6m_delta_pp", (h) => h.peer_pe_premium_6m_delta_pp],
  ["h2_contracts_90d_usd_m", (h) => h.h2_contracts_90d_usd_m],
  ["h2_subsidy_regime",      (h) => h.h2_subsidy_regime],
  ["h2_lcoe_gap_usd_kg",     (h) => h.h2_lcoe_gap_usd_kg],
  ["h2_lcoe_gap_6m_delta",   (h) => h.h2_lcoe_gap_6m_delta],
  ["regime",     (h) => h.regime],
  ["regime_pmi", (h) => h.regime_pmi],
  ["weight_t",   (h) => h.weights?.t],
  ["weight_p",   (h) => h.weights?.p],
  ["weight_s",   (h) => h.weights?.s],
  // V4 / V7.6 NOW additions
  ["now_pe",             (h) => h.cohort_valuation?.now_pe],
  ["crm_pe",             (h) => h.cohort_valuation?.crm_pe],
  ["wday_pe",            (h) => h.cohort_valuation?.wday_pe],
  ["adbe_pe",            (h) => h.cohort_valuation?.adbe_pe],
  ["cohort_avg_pe",      (h) => h.cohort_valuation?.cohort_avg_pe],
  ["cohort_premium_pct", (h) => h.cohort_valuation?.premium_pct],
  ["now_30d_return_pct",        (h) => h.cohort_relative?.now_30d_return_pct],
  ["cohort_avg_30d_return_pct", (h) => h.cohort_relative?.cohort_avg_30d_return_pct],
  ["rotation_pressure_pp",      (h) => h.cohort_relative?.rotation_pressure_pp],
  ["rotation_pressure_active",  (h) => h.cohort_relative?.rotation_pressure_active],
  ["igv_vs_spy_30d_pp", (h) => h.igv_vs_spy_30d_pp],
  ["fcf_margin_pct",                  (h) => h.fcf_margin_pct],
  ["crpo_growth_pct",                 (h) => h.crpo_growth_pct],
  ["subscription_revenue_growth_pct", (h) => h.subscription_revenue_growth_pct],
  ["deals_1m_plus_yoy_pct",           (h) => h.deals_1m_plus_yoy_pct],
  ["federal_growth_pct",              (h) => h.federal_growth_pct],
  // V8.0 telemetry additions
  ["div_tactical",   (h) => h.divergence?.tactical],
  ["div_positional", (h) => h.divergence?.positional],
  ["div_strategic",  (h) => h.divergence?.strategic],
  ["div_flagged",    (h) => (h.divergence?.flagged || []).join(";")],
  ["regime_driver",  (h) => h.regime_driver],
  ["regime_basis",   (h) => h.regime_basis],
];

// ─── quote-aware CSV line splitter (validation pass) ────────────────────────
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

// ─── main ────────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(JSONL_PATH)) {
    console.error(`ERROR: ${JSONL_PATH} not found — nothing to rebuild from.`);
    process.exit(1);
  }

  // 1. Backup (first run only — never clobber an existing backup)
  if (existsSync(CSV_PATH)) {
    if (existsSync(BAK_PATH)) {
      console.log(`Backup already exists at ${BAK_PATH} — keeping the original backup.`);
    } else {
      copyFileSync(CSV_PATH, BAK_PATH);
      console.log(`✓ Backed up existing CSV → ${BAK_PATH}`);
    }
  }

  // 2. Load daily-log entries
  const entries = readFileSync(JSONL_PATH, "utf-8")
    .split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.date && Array.isArray(e.holdings));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Loaded ${entries.length} daily-log entries (${entries[0]?.date} → ${entries[entries.length - 1]?.date})`);

  // 3. Emit rows under the unified header
  const header = COLUMNS.map(c => c[0]).join(",");
  const out = [header];
  const perSymbol = {};
  for (const entry of entries) {
    const m = entry.macro || {};
    for (const h of entry.holdings) {
      if (!h?.symbol) continue;
      out.push(COLUMNS.map(([, f]) => esc(f(h, m, entry) ?? "")).join(","));
      perSymbol[h.symbol] = (perSymbol[h.symbol] || 0) + 1;
    }
  }
  writeFileSync(CSV_PATH, out.join("\n") + "\n");
  console.log(`✓ Wrote ${out.length - 1} rows × ${COLUMNS.length} columns → ${CSV_PATH}`);

  // 4. Self-validation: every line must parse to exactly header width
  const lines = readFileSync(CSV_PATH, "utf-8").trim().split("\n");
  const widths = new Set(lines.map(l => splitCSVLine(l).length));
  if (widths.size !== 1 || !widths.has(COLUMNS.length)) {
    console.error(`✗ VALIDATION FAILED: widths seen = ${[...widths].join(", ")} (expected uniform ${COLUMNS.length})`);
    process.exit(1);
  }
  console.log(`✓ Validation: all ${lines.length - 1} rows uniform at ${COLUMNS.length} columns`);

  // 5. Reconciliation summary
  if (existsSync(BAK_PATH)) {
    const oldRows = readFileSync(BAK_PATH, "utf-8").trim().split("\n").length - 1;
    console.log(`Reconciliation: old CSV ${oldRows} rows → rebuilt ${out.length - 1} rows`);
  }
  console.log("Per-symbol row counts:");
  for (const [sym, n] of Object.entries(perSymbol).sort()) {
    console.log(`  ${sym.padEnd(8)} ${n}`);
  }
  console.log("\nBlank-by-design in rebuilt rows (not persisted in JSONL):");
  console.log("  z_tactical, z_positional, z_strategic, confidence_level/score/missing");
  console.log("\nDONE. signal-accuracy v1.3 will now parse the full history correctly.");
}

main();
