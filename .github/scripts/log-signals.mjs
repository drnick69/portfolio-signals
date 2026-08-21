#!/usr/bin/env node
// log-signals.mjs — Appends today's signal data to persistent history files.
// Reads /tmp/signal-data.json + /tmp/market-data.json.
// Outputs:
//   docs/history/signals.csv     — flat CSV of all signals, one row per holding per day
//   docs/history/daily-log.jsonl — one JSON object per day with full signal + assignment data
//   docs/history/summary.json    — rolling stats (streak counts, hit rates, etc.)
//
// V3 additions: BBB OAS macro pair, IV/RV + QUAL + SPY-drawdown tactical extras,
// ASU utilization + price/mix + EPS revisions LIN fundamentals, AI.PA peer
// triangulation, peer P/E premium 6M delta, H2 layer (contracts $ + subsidy +
// LCOE gap), and per-holding regime/regime_pmi/weights (LIN-only, propagated
// from the score-engine).
//
// V4 (V7.6 holdings sync): NOW telemetry capture — cohort valuation (vs
// CRM/WDAY/ADBE), cohort relative rotation (30d returns + rotation pressure),
// IGV factor flow, and NOW-specific fundamentals (cRPO, sub rev growth,
// $1M+ deals YoY, federal growth). Required for downstream attribution /
// calibration / accuracy to evaluate NOW signals. The ETHA-era
// alt_season_spread_pp CSV column is retained as legacy for back-compat
// (parallels the dram_cycle_spread_pp / ag_demand_spread_pp retirees).
//
// This runs AFTER generate-signals.mjs and BEFORE the git commit step.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// ── V8.0 (June 2026): telemetry wiring for generate-signals v8.0/v8.0.1 +
// score-engine v8.1 — persists the new self-improvement telemetry:
//   • divergence (per-layer |det − llm| gap + flagged list)  → CSV + JSONL
//   • regime_driver / regime_basis (V8.1 regime gates)       → CSV + JSONL
//   • hostile_review (bear/bull/falsifier per layer)         → JSONL only
//     (long prose — CSV-hostile; daily-log.jsonl is the authoritative
//     full-fidelity record and feeds attribute-signals → calibration)
// New CSV columns appended at the end per established back-compat convention.
// All fields additive; rows for pre-v8 runs simply leave them blank/null.
//
// ── V8.1.1 (July 2026): data_quality persistence for generate-signals v8.1.1.
//   The top-level completeness audit { expected, scored, missing[], complete } is now
//   recorded on each daily-log entry, so partial runs (a holding that failed scoring
//   and was dropped from the rankings — e.g. the 9/12 MSFT/NOW/LHX drop) are captured
//   historically and can be trended. JSONL only — daily-log is the authoritative
//   full-fidelity record. Additive; a legacy signal-data.json without the block falls
//   back to { complete: null } (completeness unknown, predates the audit).
//
// ── V8.2.0 (July 2026): persistence for generate-signals v8.2.0 telemetry.
//   • tz — temporal z per layer (score vs the NAME'S OWN trailing 60-session
//     baseline from calibration-v2.mjs; orthogonal to the cross-sectional
//     z_* columns) → CSV (tz_tactical..tz_composite, appended per back-compat
//     convention) + JSONL (full object).
//   • verification — verification-gate outcome { passed, violations,
//     corrective_turns } → CSV (verify_passed, verify_turns) + JSONL (full
//     object incl. violation strings). Pre-v8.2 rows leave all blank/null.
//
// ── V8.3.0 (July 2026): HOLDINGS ADD telemetry — MA + ISRG (fetch-market-data
//   v4.14 / score-engine V8.2 / generate-signals v8.3.0 sync; 12 → 14 holdings).
//   • MA columns: twin valuation vs V (v_pe, twin_premium_pct), twin daily
//     spread, 30d twin/duopoly block (ma/v 30d returns, twin_spread_30d_pp,
//     twin_dislocation_active, duopoly_vs_spy_pp — the V8.2 MA weight-gate
//     driver, disruption_fear_regime), and MA fundamentals scaffolds
//     (cross-border/GDV/switched/VAS, rebates trend, buyback pace,
//     stablecoin/disruption/regulation categoricals).
//   • ISRG columns: devices cohort PEs (mdt/syk/bsx — cohort avg + premium
//     reuse the existing shared cohort_avg_pe/cohort_premium_pct columns, same
//     as MSFT/LHX rows already do), fear-rotation block (isrg_30d,
//     cohort_rotation_pp/active), ihi_vs_spy_30d_pp (the V8.2 ISRG weight-gate
//     driver), and ISRG fundamentals scaffolds (procedures + guide, dV
//     placements/dV5 mix, Ion, recurring %, I&A, installed base, moat_status,
//     instrument_transition_status).
//   All appended at the end per the back-compat convention; the v8.2.0
//   migrateCsvHeader() pure-append migration re-writes the on-disk header once
//   (115 → new width) and pads pre-v8.3 rows blank. JSONL gains the full
//   objects (twin_valuation / twin_relative / duopoly_relative for MA; the
//   cohort_valuation / cohort_relative mappers extended with the ISRG keys —
//   additive, null on non-applicable rows). signal-accuracy's exact-width
//   contract MUST be bumped in the same deploy (v8.3 pair).

// ── V8.4.0 (August 2026): HOLDINGS SWAP telemetry — IBIT out, RDDT in
//   (fetch-market-data v4.16 / score-engine V8.3 / generate-signals v8.4.0 sync;
//   still 14 holdings).
//   • RDDT columns: ads cohort PEs (meta/pins/app — cohort avg + premium REUSE
//     the shared cohort_avg_pe / cohort_premium_pct columns, same as MSFT/LHX/
//     ISRG rows), rddt_30d_return_pct (cohort_avg_30d_return_pct,
//     cohort_rotation_pp and cohort_rotation_active are ALSO reused — the
//     fetch v4.16 payload emits those exact keys for RDDT), xlc_vs_spy_30d_pp
//     (the V8.3 RDDT weight-gate driver), and RDDT fundamentals scaffolds
//     (ad revenue + total revenue growth, the ARPU block, DAUq/WAUq, the
//     logged-in/out split, margins + TTM operating cash flow, SBC trend, guide
//     range, NET share count + gross buyback, and the search_referral /
//     licensing / competitive categoricals plus the P/S own-history pair).
//   • NO IBIT columns are removed. Nothing IBIT-specific was ever added to this
//     schema (the only trace is the legacy ETHA-era alt_season_spread_pp
//     column, retained for back-compat as always). Removal would break the
//     pure-append invariant and orphan historical IBIT rows.
//
//   ⚠ TWO SIMILARLY-NAMED COLUMNS WITH OPPOSITE SIGN CONVENTIONS — do not
//     conflate them downstream:
//       buyback_share_reduction_yoy_pct  (V8.3.0, MA)   NEGATIVE = shares shrank
//       share_count_change_yoy_pct       (V8.4.0, RDDT) POSITIVE = DILUTION
//     RDDT is scored on NET share count precisely because its gross buyback
//     ($235M in Q2 2026) does NOT offset stock comp — share count still rose
//     ~2.8%. gross_buyback_musd is carried for context only and must never be
//     read as a shareholder-return signal.
//
//   ⚠ PAIRED DEPLOY REQUIRED: signal-accuracy enforces an EXACT-width contract
//     against the on-disk header. These 31 appended columns move the width
//     155 → 186. signal-accuracy MUST be bumped in the SAME deploy or every new
//     row is skipped. migrateCsvHeader() handles the on-disk file (pure-append
//     prefix check, pads pre-v8.4 rows blank); it does NOT know about the
//     consumer's width contract.
//     [V8.5.0 CORRECTION — do not take the paragraph above at face value. The
//     same claim was repeated for the 186 → 234 migration and then tested
//     directly: it is WRONG. signal-accuracy's width contract is DYNAMIC
//     (headers.length read off disk, not a compiled-in constant), and
//     migrateCsvHeader() rewrites the header BEFORE any row is appended, so the
//     mismatched state that would cause a skip cannot arise through this code
//     path. Rows are never skipped; the real cost of an unpaired deploy is that
//     the newly appended telemetry is written but never READ into
//     accuracy.json. Left in place as a record of what was believed at v8.4.0.
//     See the V8.5.0 DEPLOY ORDERING note below for the tested version.]

// ── V8.5.0 (August 2026): HOLDINGS SWAP telemetry — RDDT out, MLM in
//   (fetch-market-data v4.17 / score-engine V8.4 / generate-signals v8.5.0 sync;
//   still 14 holdings).
//
//   REUSED columns (no new width): cohort_avg_pe + cohort_premium_pct (as for
//   MSFT/LHX/ISRG/RDDT), cohort_avg_30d_return_pct, cohort_rotation_pp +
//   cohort_rotation_active, revenue_growth_yoy_pct, ebitda_margin_pct,
//   eps_revisions_30d/90d, trailing_pe.
//   ⚠ NOTE ON THE ROTATION REUSE: fetch v4.17 emits MLM's rotation under the
//   NEW key names peer_rotation_pp / peer_rotation_active (RDDT used
//   cohort_rotation_pp / _active). The row builder and JSONL mapper accept
//   EITHER key and write the shared column, so one column continues to mean
//   "this holding's rotation vs its own cohort" across MSFT/ISRG/RDDT/MLM and
//   stays comparable in attribution. Thresholds differ upstream (MLM −5pp,
//   RDDT −8pp, ISRG −6pp) and the ACTIVE flag is already threshold-applied by
//   fetch, so the column is safe to compare; the raw pp value is not.
//
//   ⚠ share_count_change_yoy_pct IS REUSED, and the V8.4.0 note above needs
//   qualifying. That column is NOT a special "positive = dilution" convention —
//   it is simply the raw YoY % change in share count. RDDT happened to print
//   POSITIVE (+2.8%, stock comp exceeding buyback); MLM prints NEGATIVE
//   (−1.11%, a genuine buyback that satisfies the portfolio's criterion). Same
//   column, same arithmetic, opposite observed sign. The genuinely distinct
//   column is MA's buyback_share_reduction_yoy_pct, which measures a different
//   quantity — that is the pair a downstream consumer must not conflate.
//
//   NEW columns (48 appended: 186 → 234):
//   • Aggregates cohort PEs vmc/crh/exp_pe + mlm_vs_vmc_pct (the TWIN premium —
//     the flagship strategic read, carried separately from the cohort average
//     because VMC is the only true like-for-like US aggregates pure play).
//   • mlm_30d_return_pct, and vmc_spread_30d_pp + vmc_dislocation_active —
//     the twin rotation read, deliberately NOT folded into the shared cohort
//     columns. Diluting the twin signal inside a 3-name average would destroy
//     the single most informative tactical input this archetype has.
//   • ★★ premium_pct_reliable + trailing_discount_artifact_suspected — THE
//     MOST IMPORTANT COLUMNS IN THIS APPEND. MLM's TTM window carries a large
//     non-operating gain from the Quikrete asset exchange, so its TRAILING P/E
//     (~12.9x vs ~26.8x forward) is an accounting artifact and the cohort
//     premium computes near −50%. fetch v4.17 gates that and score-engine V8.4
//     scores it ZERO — but the CSV would otherwise persist premium_pct = −50.7
//     with NOTHING recording that it is invalid. Any calibration pass reading
//     that column across history would learn a fabricated relationship between
//     "deep cohort discount" and forward returns. These two flags are what
//     make the stored number interpretable. Never drop them.
//   • xlb_vs_spy_30d_pp — the materials factor-flow driver.
//   • MLM fundamentals: mix-adjusted organic pricing (THE moat metric) and the
//     organic/reported ASP + volume splits, reported_asp_signal_status,
//     weather_impact_flag, cash GP/ton + COGS/ton (incl. and ex pass-through
//     freight), energy, inventory step-up, the three end-market categoricals,
//     guide actions, forward_pe + ev_ebitda + pro_forma_ev_ebitda WITH their
//     basis tags, the federal authorization + state DOT regime fields, the LNA
//     block, reserves, and ROIC/WACC with the distortion flag.
//
//   ⚠ COLUMN RENAMED VS ITS PAYLOAD KEY — the one deliberate mismatch here:
//     payload  md.fundamentals.ma_integration_state
//     column   lna_integration_state
//     "ma_" is ALREADY triply ambiguous in this schema — ma_signal is the
//     MOVING-AVERAGE signal, ma_30d_return_pct is MASTERCARD, and a third
//     meaning (M&A) would make the prefix useless to anyone grepping columns.
//     The column is named for the deal it tracks. The row builder and JSONL
//     mapper read the payload key and write the renamed column.
//
//   • NO RDDT columns are removed. The 31 V8.4.0 columns stay and go blank on
//     MLM rows, exactly as IBIT/ETHA-era columns did. Removal would break the
//     pure-append invariant and orphan every historical RDDT row.
//
//   ⚠ DEPLOY ORDERING — CORRECTED. An earlier draft of this note claimed a
//     PAIRED DEPLOY WAS REQUIRED and that every new row would be SKIPPED if
//     signal-accuracy were not bumped in the same commit. That was WRONG, and
//     the correction is recorded here rather than quietly deleted because an
//     overstated warning costs as much trust as a missing one.
//     Tested directly: genuine signal-accuracy v1.5 reading a post-migration
//     234-wide file skips ZERO rows. Its width contract is DYNAMIC — it
//     compares each row against headers.length read off disk, not against a
//     compiled-in constant. And migrateCsvHeader() below rewrites the on-disk
//     header BEFORE any row is appended, so the header and the rows always
//     agree by construction. The 186-header/234-row state that would trigger a
//     skip cannot actually occur through this code path.
//     THE REAL CONSEQUENCE of shipping this file without signal-accuracy v1.6
//     is quieter and worth knowing: rows parse fine, but none of the MLM
//     telemetry propagates into the yesterday-snapshot in accuracy.json. The
//     columns are written to signals.csv and simply never read. That is a
//     silent degradation of the calibration substrate, not a data-loss event,
//     and it self-heals the moment v1.6 lands.
//     Ship them together anyway — there is no reason not to — but if they do
//     land in separate commits, nothing breaks and nothing needs repairing.

const HISTORY_DIR = "docs/history";
const CSV_PATH = `${HISTORY_DIR}/signals.csv`;
const JSONL_PATH = `${HISTORY_DIR}/daily-log.jsonl`;
const SUMMARY_PATH = `${HISTORY_DIR}/summary.json`;

mkdirSync(HISTORY_DIR, { recursive: true });

// ── V3: Resolve regime / regime_pmi / weights from the normalized holding.
// Tolerates either shape — top-level (s.regime) if generate-signals lifts it,
// or nested in composite (s.composite.regime) if it doesn't.
function resolveRegime(s) {
  return {
    regime: s.regime ?? s.composite?.regime ?? null,
    regime_pmi: s.regime_pmi ?? s.composite?.regime_pmi ?? null,
    weights: s.weights ?? s.composite?.weights ?? null,
    // V8.0: V8.1 regime telemetry (MSFT/NOW/LHX/TMO drivers; null pre-v8)
    regime_driver: s.regime_driver ?? s.composite?.regime_driver ?? null,
    regime_basis: s.regime_basis ?? s.composite?.regime_basis ?? null,
  };
}

// ─── LOAD TODAY'S DATA ───────────────────────────────────────────────────────
let signalData, marketData;
try {
  signalData = JSON.parse(readFileSync("/tmp/signal-data.json", "utf-8"));
  marketData = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8"));
} catch (e) {
  console.error("Cannot read signal/market data:", e.message);
  process.exit(1);
}

const { normalized, assignments, timestamp, data_quality } = signalData;
const date = new Date(timestamp).toISOString().split("T")[0]; // YYYY-MM-DD
const macro = marketData._macro || {};

console.log("Signal History Logger");
console.log("=====================");
console.log(`Date: ${date}`);
console.log(`Holdings: ${normalized.length}`);
if (data_quality && data_quality.complete === false) {
  console.log(`⚠ Partial run recorded: ${data_quality.scored}/${data_quality.expected} scored — missing ${(data_quality.missing || []).join(", ")}`);
}

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
  "alt_season_spread_pp",     // legacy ETHA (ETHA vs IBIT) — retired V7.6, kept for back-compat
  "copper_regime_spread_pp",  // GLNCY (GLNCY vs COPX)
  "ag_demand_spread_pp",      // legacy MOS (MOS vs CORN) — retired, kept for back-compat
  "dram_cycle_spread_pp",     // legacy SMH (SMH vs MU) — retired, kept for back-compat

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
  "operating_margin_pct",      // shared: LIN / TMO / NOW op margin

  // ─── V3 additions (appended for CSV back-compat) ────────────────────────
  // V3 macro pair — BBB credit spread (leads LIN backlog 6-12mo)
  "bbb_oas_bps", "bbb_oas_1m_change_bps",
  // V3 tactical extras — catalyst hunt + growth-scare
  "iv_rv_ratio",               // 30d implied / 30d realized vol
  "qual_vs_spy_30d_pp",        // QUAL ETF return - SPY return over 30d
  "spy_10d_drawdown_pct",      // SPY total return / 10 trading days
  "lin_vs_spy_10d_pp",         // LIN total return - SPY total return / 10 trading days
  // V3 LIN fundamentals (some shared by TMO / NOW)
  "asu_utilization_pct",       // air separation unit capacity utilization (LIN)
  "price_mix_ex_fx_pct",       // like-for-like price/mix delta ex-FX (LIN)
  "eps_revisions_30d_pct",     // shared: FactSet/Refinitiv consensus EPS delta 30d
  "eps_revisions_90d_pct",     // shared: 90d
  // V3 LIN peer triangulation + P/E delta
  "lin_peer_aipa_spread_pp",   // LIN vs AI.PA 1m spread (mirrors APD)
  "peer_pe_premium_6m_delta_pp", // 6M change in LIN's peer P/E premium
  // V3 H2 layer (concretized from prior categorical "expanding/steady/weakening")
  "h2_contracts_90d_usd_m",    // USD millions of new H2 contracts trailing 90d
  "h2_subsidy_regime",         // strengthening | stable | weakening
  "h2_lcoe_gap_usd_kg",        // green H2 LCOE - grey H2 LCOE (USD/kg)
  "h2_lcoe_gap_6m_delta",      // 6M change in LCOE gap (negative = closing)
  // V3 per-holding regime context (LIN only — null elsewhere)
  "regime", "regime_pmi", "weight_t", "weight_p", "weight_s",

  // ─── V4 / V7.6 NOW additions (appended for CSV back-compat) ─────────────
  // NOW cohort valuation (vs CRM / WDAY / ADBE)
  "now_pe", "crm_pe", "wday_pe", "adbe_pe", "cohort_avg_pe", "cohort_premium_pct",
  // NOW cohort relative — 30d returns + rotation pressure
  "now_30d_return_pct", "cohort_avg_30d_return_pct",
  "rotation_pressure_pp", "rotation_pressure_active",
  // NOW factor flow — software cohort vs SPY
  "igv_vs_spy_30d_pp",
  // NOW shared fundamentals (FCF margin shared with TMO; cRPO+sub-rev+deals+federal NOW-specific)
  "fcf_margin_pct",
  "crpo_growth_pct",
  "subscription_revenue_growth_pct",
  "deals_1m_plus_yoy_pct",
  "federal_growth_pct",

  // ─── V8.0 telemetry additions (appended for CSV back-compat) ────────────
  // Divergence: per-layer |det − llm| gap; flagged = layers with gap >40
  "div_tactical", "div_positional", "div_strategic", "div_flagged",
  // V8.1 regime gate telemetry (numeric driver + basis string)
  "regime_driver", "regime_basis",
  // ─── V8.2.0 telemetry additions (appended for CSV back-compat) ──────────
  // Temporal z: layer score vs this name's own trailing baseline (calibration-v2)
  "tz_tactical", "tz_positional", "tz_strategic", "tz_composite",
  // Verification gate outcome (violation strings live in the JSONL only)
  "verify_passed", "verify_turns",

  // ─── V8.3.0 MA additions (appended for CSV back-compat; MA row only) ─────
  // Twin valuation vs V (MA's own PE is the existing trailing_pe column)
  "v_pe", "twin_premium_pct",
  // Twin daily spread (MA − V, pp)
  "twin_daily_spread_pp",
  // 30d twin/duopoly block — duopoly_vs_spy_pp is the V8.2 MA weight-gate driver
  "ma_30d_return_pct", "v_30d_return_pct", "twin_spread_30d_pp",
  "twin_dislocation_active", "duopoly_vs_spy_pp", "disruption_fear_regime",
  // MA fundamentals scaffolds (LLM-sourced; blank until populated)
  "cross_border_growth_pct", "gdv_growth_pct", "switched_txn_growth_pct",
  "vas_growth_pct", "vas_share_of_revenue_pct", "rebates_incentives_trend",
  "buyback_share_reduction_yoy_pct", "stablecoin_strategy_execution",
  "disruption_narrative_phase", "disruption_fundamental_evidence",
  "interchange_regulation_status",

  // ─── V8.3.0 ISRG additions (appended for CSV back-compat; ISRG row only) ──
  // Devices cohort PEs (cohort avg + premium reuse cohort_avg_pe / cohort_premium_pct)
  "mdt_pe", "syk_pe", "bsx_pe",
  // Fear-rotation block (cohort avg 30d reuses cohort_avg_30d_return_pct)
  "isrg_30d_return_pct", "cohort_rotation_pp", "cohort_rotation_active",
  // Devices factor flow — the V8.2 ISRG weight-gate driver
  "ihi_vs_spy_30d_pp",
  // ISRG fundamentals scaffolds (LLM-sourced; blank until populated)
  "procedure_growth_pct", "procedure_guide_low_pct", "procedure_guide_high_pct",
  "dv_placements_qtr", "dv5_mix_pct", "ion_procedure_growth_pct", "ion_installed_base",
  "recurring_revenue_pct", "ia_revenue_growth_pct",
  "installed_base_total", "installed_base_yoy_pct",
  "moat_status", "instrument_transition_status",

  // ─── V8.4.0 RDDT additions (appended for CSV back-compat; RDDT row only) ──
  // Ads cohort PEs. cohort avg + premium REUSE cohort_avg_pe / cohort_premium_pct.
  "meta_pe", "pins_pe", "app_pe",
  // Ads rotation. cohort_avg_30d_return_pct + cohort_rotation_pp +
  // cohort_rotation_active are REUSED (fetch v4.16 emits those exact keys for
  // RDDT), so only RDDT's own leg is new here.
  "rddt_30d_return_pct",
  // Ads factor flow — the V8.3 RDDT weight-gate driver
  "xlc_vs_spy_30d_pp",
  // RDDT fundamentals scaffolds (LLM-sourced; blank until populated)
  "ad_revenue_growth_yoy_pct", "revenue_growth_yoy_pct",
  "arpu_global", "arpu_growth_yoy_pct", "arpu_us", "arpu_row",
  "dauq_millions", "dauq_growth_yoy_pct", "wauq_growth_yoy_pct",
  // ⚠ The logged-in/out split was DISCONTINUED by the company from Q3 2026.
  // Columns retained: historical rows carry real values, and a permanently
  // blank column that records "this was withdrawn" is more honest than
  // deleting the field. dau_disclosure_status says which regime a row is in.
  "logged_in_dau_growth_pct", "logged_out_dau_growth_pct", "dau_disclosure_status",
  "ebitda_margin_pct", "ttm_operating_cash_flow_musd", "sbc_trend",
  "next_qtr_guide_low_musd", "next_qtr_guide_high_musd", "guide_implied_growth_pct",
  // ⚠ share_count_change_yoy_pct: POSITIVE = DILUTION. Opposite convention to
  // buyback_share_reduction_yoy_pct (MA, negative = shares shrank). This is the
  // shareholder-return read for RDDT; gross_buyback_musd is context ONLY.
  "share_count_change_yoy_pct", "gross_buyback_musd",
  "search_referral_status", "licensing_status", "licensing_annual_musd",
  "competitive_threat",
  // P/S vs own history + the partial-window flag that governs how much the
  // downstream model is allowed to trust it (RDDT listed March 2024).
  "ps_pct_of_3y_avg", "own_history_window_partial",

  // ─── V8.5.0 MLM additions (appended for CSV back-compat; MLM row only) ────
  // Aggregates cohort PEs. cohort avg + premium REUSE cohort_avg_pe /
  // cohort_premium_pct. mlm_vs_vmc_pct is the TWIN premium — the flagship
  // strategic read, carried separately because VMC is the only true
  // like-for-like US aggregates pure play and must not be averaged away.
  "vmc_pe", "crh_pe", "exp_pe", "mlm_vs_vmc_pct",
  // ★★ ARTIFACT GATE — the two most important columns in this append.
  // MLM's trailing P/E (~12.9x vs ~26.8x forward) is contaminated by the
  // Quikrete divestiture gain, so cohort_premium_pct computes near −50%.
  // WITHOUT these flags the CSV persists a fabricated deep discount and any
  // calibration pass reading history would learn a relationship that does not
  // exist. premium_pct_reliable=false means cohort_premium_pct on that row is
  // NOT a valuation observation. Never drop these two columns.
  "premium_pct_reliable", "trailing_discount_artifact_suspected",
  // Aggregates rotation. cohort_avg_30d_return_pct + cohort_rotation_pp +
  // cohort_rotation_active are REUSED (fetch v4.17 emits peer_rotation_pp /
  // peer_rotation_active — the row builder accepts either key), so only MLM's
  // own leg plus the TWIN read are new here.
  "mlm_30d_return_pct", "vmc_spread_30d_pp", "vmc_dislocation_active",
  // Materials factor flow — the tactical overlay driver
  "xlb_vs_spy_30d_pp",
  // ── MLM fundamentals scaffolds (LLM-sourced; blank until populated) ──
  // ★ mix_adjusted_organic_pricing_pct is THE moat metric: aggregates have no
  // exchange price, so mix-adjusted organic pricing IS the local-monopoly test.
  // Below 1% is the cleanest falsifier in this model.
  "mix_adjusted_organic_pricing_pct", "organic_asp_growth_pct",
  // ⚠ reported_asp_* are CONTEXT ONLY. reported_asp_signal_status carries
  // "null_signal_mix_contaminated" during M&A integration, when the reported
  // figure is mix-poisoned (Q2'26: −2% reported vs +3.7% organic mix-adjusted).
  // Nothing downstream may score reported ASP while that flag is set.
  "reported_asp_usd", "reported_asp_growth_pct", "reported_asp_signal_status",
  "organic_volume_growth_pct", "reported_volume_growth_pct", "total_tons_millions",
  // ⚠ weather_impact_flag governs whether a NEGATIVE organic-volume reading is
  // real. Aggregates is the most weather-contaminated print in the book; the
  // engine REMOVES (not reduces) the volume penalty when this is
  // "material_headwind". Persisted so calibration can separate rain from demand.
  "weather_impact_flag",
  "cash_gross_profit_per_ton", "cogs_per_ton_growth_pct",
  "cogs_per_ton_growth_ex_freight_pct", "energy_headwind",
  "inventory_step_up_charge_musd",
  "infrastructure_demand", "heavy_nonres_demand", "residential_demand",
  "fy_revenue_guide_action", "fy_ebitda_guide_action",
  // ⚠ Every multiple carries its BASIS tag. A forward multiple compared against
  // a trailing one produces a spurious re-rating; the basis columns are what
  // let a later reader tell which comparison a stored number supports.
  "forward_pe", "forward_pe_consensus_basis", "ev_ebitda", "ev_ebitda_basis",
  "pro_forma_ev_ebitda", "pro_forma_basis_consistent",
  // Public construction funding regime — the V8.4 MLM weight-gate driver.
  // ⚠ "short_term_extension" is the BASE CASE, not a downgrade.
  "federal_authorization_status", "days_to_authorization_expiry",
  "state_dot_budget_trend",
  // ⚠ lna_integration_state is RENAMED from its payload key
  // (md.fundamentals.ma_integration_state) — "ma_" already means MOVING AVERAGE
  // (ma_signal) and MASTERCARD (ma_30d_return_pct) in this schema. Named for
  // the deal it tracks. Leverage is scored on the GLIDEPATH, never the level.
  "lna_integration_state", "pro_forma_net_leverage", "delever_glidepath_status",
  "lna_synergies_credited_musd",
  // Pro-forma share count books the $6.5B LNA stock consideration NOW.
  // Pairs with the reused share_count_change_yoy_pct (raw YoY change).
  "pro_forma_share_count_change_pct",
  "reserve_tons_millions", "reserve_life_years",
  // ⚠ roic_denominator_distorted=true means roic_pct is NOT a quality read on
  // that row — the capital base was inflated by acquisitions ahead of their
  // earnings. Same interpretive role as premium_pct_reliable above.
  "roic_pct", "wacc_pct", "roic_denominator_distorted",
].join(",");

// ── V8.2.0: CSV HEADER MIGRATION (pure-append schema evolution) ──────────────
// signal-accuracy v1.3 enforces an EXACT-width contract against the on-disk
// header: any row whose field count ≠ header width is skipped, loudly. That
// contract is what ended the June misparse era — but it also means appending
// columns HERE without migrating the on-disk header would get every NEW row
// skipped (the same failure class, inverted; the V8.0 column additions only
// worked because the June rebuild wrote them into the unified header).
// So: when the on-disk header is a strict PREFIX of CSV_HEADERS (pure append —
// the only schema change the back-compat convention permits), rewrite the file
// once: new header + every existing data row padded with empty trailing fields
// to the new width. Rows keep their original values at their original named
// columns (signal-accuracy keys by header name), new columns read blank for
// pre-migration history — exactly the semantics the convention promises.
// Idempotent (no-op when the header already matches); REFUSES to touch the
// file on any non-prefix mismatch and warns loudly instead — this script never
// silently rewrites a schema it doesn't recognize (that's rebuild-signals-csv's
// job, run deliberately).
function migrateCsvHeader() {
  const raw = readFileSync(CSV_PATH, "utf-8");
  const nlIdx = raw.indexOf("\n");
  const diskHeader = (nlIdx === -1 ? raw : raw.slice(0, nlIdx)).replace(/\r$/, "");
  if (diskHeader === CSV_HEADERS) return;
  const diskCols = diskHeader.split(",");
  const newCols = CSV_HEADERS.split(",");
  const isPrefix = diskCols.length < newCols.length && diskCols.every((c, i) => c === newCols[i]);
  if (!isPrefix) {
    console.warn(`⚠ CSV header mismatch that is NOT a pure append (disk ${diskCols.length} cols vs code ${newCols.length}). File left untouched — run rebuild-signals-csv.mjs (rebuild-csv.yml) to reconcile.`);
    return;
  }
  const pad = ",".repeat(newCols.length - diskCols.length);
  const lines = raw.split("\n");
  const migrated = [
    CSV_HEADERS,
    ...lines.slice(1).map(l => {
      if (l.trim() === "") return l; // preserve trailing/blank lines untouched
      return l.endsWith("\r") ? l.slice(0, -1) + pad + "\r" : l + pad;
    }),
  ].join("\n");
  writeFileSync(CSV_PATH, migrated);
  console.log(`✓ CSV schema migrated: header ${diskCols.length} → ${newCols.length} cols; existing rows padded with ${newCols.length - diskCols.length} blank field(s).`);
}

const csvExists = existsSync(CSV_PATH);
let csvContent = "";

if (!csvExists) {
  csvContent = CSV_HEADERS + "\n";
} else {
  migrateCsvHeader(); // v8.2.0: runs before the append below reads the file back
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

    // ─── V3 additions ────────────────────────────────────────────────────
    // V3 macro pair (populated for every row)
    macro.bbb_oas_bps ?? "",
    macro.bbb_oas_1m_change_bps ?? "",
    // V3 tactical extras (LIN row only, blank for others)
    md.tactical_extras?.iv_rv_ratio ?? "",
    md.factor_flow?.qual_vs_spy_30d_pp ?? "",
    md.tactical_extras?.spy_10d_drawdown_pct ?? "",
    md.tactical_extras?.lin_vs_spy_10d_pp ?? "",
    // V3 LIN fundamentals additions
    md.fundamentals?.asu_utilization_pct ?? "",
    md.fundamentals?.price_mix_ex_fx_pct ?? "",
    md.fundamentals?.eps_revisions_30d_pct ?? "",
    md.fundamentals?.eps_revisions_90d_pct ?? "",
    // V3 LIN peer triangulation + P/E delta
    md.peer_relative_aipa?.relative_spread_pp ?? "",
    md.peer_valuation?.premium_6m_delta_pp ?? "",
    // V3 H2 layer
    md.h2_layer?.contracts_90d_usd_m ?? "",
    esc(md.h2_layer?.subsidy_regime ?? ""),
    md.h2_layer?.lcoe_gap_usd_kg ?? "",
    md.h2_layer?.lcoe_gap_6m_delta ?? "",
    // V3 per-holding regime context (LIN only)
    (() => { const r = resolveRegime(s); return [
      r.regime ?? "",
      r.regime_pmi != null ? r.regime_pmi.toFixed(2) : "",
      r.weights?.t ?? "",
      r.weights?.p ?? "",
      r.weights?.s ?? "",
    ].join(","); })(),

    // ─── V4 / V7.6 NOW additions ─────────────────────────────────────────
    // NOW cohort valuation (only NOW row populates these)
    md.cohort_valuation?.now_pe ?? "",
    md.cohort_valuation?.crm_pe ?? "",
    md.cohort_valuation?.wday_pe ?? "",
    md.cohort_valuation?.adbe_pe ?? "",
    md.cohort_valuation?.cohort_avg_pe ?? "",
    md.cohort_valuation?.premium_pct ?? "",
    // NOW cohort relative — 30d returns + rotation pressure
    md.cohort_relative?.now_30d_return_pct ?? "",
    md.cohort_relative?.cohort_avg_30d_return_pct ?? "",
    md.cohort_relative?.rotation_pressure_pp ?? "",
    md.cohort_relative?.rotation_pressure_active ?? "",
    // NOW factor flow — software cohort vs SPY (only NOW row populates)
    md.factor_flow?.igv_vs_spy_30d_pp ?? "",
    // NOW shared fundamentals
    md.fundamentals?.fcf_margin_pct ?? "",
    md.fundamentals?.crpo_growth_pct ?? "",
    md.fundamentals?.subscription_revenue_growth_pct ?? "",
    md.fundamentals?.deals_1m_plus_yoy_pct ?? "",
    md.fundamentals?.federal_growth_pct ?? "",

    // ─── V8.0 telemetry additions ────────────────────────────────────────
    s.divergence?.tactical ?? "",
    s.divergence?.positional ?? "",
    s.divergence?.strategic ?? "",
    esc((s.divergence?.flagged || []).join(";")),
    (() => { const r = resolveRegime(s); return [
      r.regime_driver ?? "",
      esc(r.regime_basis ?? ""),
    ].join(","); })(),

    // ─── V8.2.0 telemetry additions ──────────────────────────────────────
    s.tz?.tactical ?? "",
    s.tz?.positional ?? "",
    s.tz?.strategic ?? "",
    s.tz?.composite ?? "",
    s.verification ? (s.verification.passed ? "true" : "false") : "",
    s.verification?.corrective_turns ?? "",

    // ─── V8.3.0 MA additions (only MA row populates these) ────────────────
    md.twin_valuation?.v_pe ?? "",
    md.twin_valuation?.premium_pct ?? "",
    md.twin_relative?.relative_spread_pp ?? "",
    md.duopoly_relative?.ma_30d_return_pct ?? "",
    md.duopoly_relative?.v_30d_return_pct ?? "",
    md.duopoly_relative?.twin_spread_pp ?? "",
    md.duopoly_relative?.twin_dislocation_active ?? "",
    md.duopoly_relative?.duopoly_vs_spy_pp ?? "",
    esc(md.duopoly_relative?.disruption_fear_regime ?? ""),
    md.fundamentals?.cross_border_growth_pct ?? "",
    md.fundamentals?.gdv_growth_pct ?? "",
    md.fundamentals?.switched_txn_growth_pct ?? "",
    md.fundamentals?.vas_growth_pct ?? "",
    md.fundamentals?.vas_share_of_revenue_pct ?? "",
    esc(md.fundamentals?.rebates_incentives_trend ?? ""),
    md.fundamentals?.buyback_share_reduction_yoy_pct ?? "",
    esc(md.fundamentals?.stablecoin_strategy_execution ?? ""),
    esc(md.fundamentals?.disruption_narrative_phase ?? ""),
    esc(md.fundamentals?.disruption_fundamental_evidence ?? ""),
    esc(md.fundamentals?.interchange_regulation_status ?? ""),

    // ─── V8.3.0 ISRG additions (only ISRG row populates these) ────────────
    md.cohort_valuation?.mdt_pe ?? "",
    md.cohort_valuation?.syk_pe ?? "",
    md.cohort_valuation?.bsx_pe ?? "",
    md.cohort_relative?.isrg_30d_return_pct ?? "",
    // V8.5.0: accept EITHER key — fetch v4.17 emits MLM's rotation as
    // peer_rotation_pp / peer_rotation_active; ISRG and RDDT use
    // cohort_rotation_pp / _active. One shared column keeps "this holding's
    // rotation vs its own cohort" comparable across archetypes in attribution.
    // Thresholds differ upstream (MLM −5pp / RDDT −8pp / ISRG −6pp) and the
    // ACTIVE flag is already threshold-applied by fetch, so the flag compares
    // cleanly even though the raw pp values are not directly comparable.
    md.cohort_relative?.cohort_rotation_pp ?? md.cohort_relative?.peer_rotation_pp ?? "",
    md.cohort_relative?.cohort_rotation_active ?? md.cohort_relative?.peer_rotation_active ?? "",
    md.factor_flow?.ihi_vs_spy_30d_pp ?? "",
    md.fundamentals?.procedure_growth_pct ?? "",
    md.fundamentals?.procedure_guide_low_pct ?? "",
    md.fundamentals?.procedure_guide_high_pct ?? "",
    md.fundamentals?.dv_placements_qtr ?? "",
    md.fundamentals?.dv5_mix_pct ?? "",
    md.fundamentals?.ion_procedure_growth_pct ?? "",
    md.fundamentals?.ion_installed_base ?? "",
    md.fundamentals?.recurring_revenue_pct ?? "",
    md.fundamentals?.ia_revenue_growth_pct ?? "",
    md.fundamentals?.installed_base_total ?? "",
    md.fundamentals?.installed_base_yoy_pct ?? "",
    esc(md.fundamentals?.moat_status ?? ""),
    esc(md.fundamentals?.instrument_transition_status ?? ""),

    // ─── V8.4.0 RDDT additions (only RDDT row populates these) ────────────
    md.cohort_valuation?.meta_pe ?? "",
    md.cohort_valuation?.pins_pe ?? "",
    md.cohort_valuation?.app_pe ?? "",
    md.cohort_relative?.rddt_30d_return_pct ?? "",
    md.factor_flow?.xlc_vs_spy_30d_pp ?? "",
    md.fundamentals?.ad_revenue_growth_yoy_pct ?? "",
    md.fundamentals?.revenue_growth_yoy_pct ?? "",
    md.fundamentals?.arpu_global ?? "",
    md.fundamentals?.arpu_growth_yoy_pct ?? "",
    md.fundamentals?.arpu_us ?? "",
    md.fundamentals?.arpu_row ?? "",
    md.fundamentals?.dauq_millions ?? "",
    md.fundamentals?.dauq_growth_yoy_pct ?? "",
    md.fundamentals?.wauq_growth_yoy_pct ?? "",
    md.fundamentals?.logged_in_dau_growth_pct ?? "",
    md.fundamentals?.logged_out_dau_growth_pct ?? "",
    esc(md.fundamentals?.dau_disclosure_status ?? ""),
    md.fundamentals?.ebitda_margin_pct ?? "",
    md.fundamentals?.ttm_operating_cash_flow_musd ?? "",
    esc(md.fundamentals?.sbc_trend ?? ""),
    md.fundamentals?.next_qtr_guide_low_musd ?? "",
    md.fundamentals?.next_qtr_guide_high_musd ?? "",
    md.fundamentals?.guide_implied_growth_pct ?? "",
    md.fundamentals?.share_count_change_yoy_pct ?? "",
    md.fundamentals?.gross_buyback_musd ?? "",
    esc(md.fundamentals?.search_referral_status ?? ""),
    esc(md.fundamentals?.licensing_status ?? ""),
    md.fundamentals?.licensing_annual_musd ?? "",
    esc(md.fundamentals?.competitive_threat ?? ""),
    md.fundamentals?.ps_pct_of_3y_avg ?? "",
    md.fundamentals?.own_history_window_partial ?? "",

    // ─── V8.5.0 MLM additions (only MLM row populates these) ──────────────
    md.cohort_valuation?.vmc_pe ?? "",
    md.cohort_valuation?.crh_pe ?? "",
    md.cohort_valuation?.exp_pe ?? "",
    md.cohort_valuation?.mlm_vs_vmc_pct ?? "",
    // ★★ The two flags that make cohort_premium_pct interpretable on MLM rows.
    // premium_pct_reliable === false means the premium on this row is an
    // accounting artifact (Quikrete divestiture gain in the TTM window), NOT a
    // valuation observation. Written explicitly rather than left blank so a
    // later reader can distinguish "gated" from "never populated".
    md.cohort_valuation?.premium_pct_reliable ?? "",
    md.cohort_valuation?.trailing_discount_artifact_suspected ?? "",
    md.cohort_relative?.mlm_30d_return_pct ?? "",
    md.cohort_relative?.vmc_spread_30d_pp ?? "",
    md.cohort_relative?.vmc_dislocation_active ?? "",
    md.factor_flow?.xlb_vs_spy_30d_pp ?? "",
    md.fundamentals?.mix_adjusted_organic_pricing_pct ?? "",
    md.fundamentals?.organic_asp_growth_pct ?? "",
    md.fundamentals?.reported_asp_usd ?? "",
    md.fundamentals?.reported_asp_growth_pct ?? "",
    esc(md.fundamentals?.reported_asp_signal_status ?? ""),
    md.fundamentals?.organic_volume_growth_pct ?? "",
    md.fundamentals?.reported_volume_growth_pct ?? "",
    md.fundamentals?.total_tons_millions ?? "",
    esc(md.fundamentals?.weather_impact_flag ?? ""),
    md.fundamentals?.cash_gross_profit_per_ton ?? "",
    md.fundamentals?.cogs_per_ton_growth_pct ?? "",
    md.fundamentals?.cogs_per_ton_growth_ex_freight_pct ?? "",
    esc(md.fundamentals?.energy_headwind ?? ""),
    md.fundamentals?.inventory_step_up_charge_musd ?? "",
    esc(md.fundamentals?.infrastructure_demand ?? ""),
    esc(md.fundamentals?.heavy_nonres_demand ?? ""),
    esc(md.fundamentals?.residential_demand ?? ""),
    esc(md.fundamentals?.fy_revenue_guide_action ?? ""),
    esc(md.fundamentals?.fy_ebitda_guide_action ?? ""),
    md.fundamentals?.forward_pe ?? "",
    esc(md.fundamentals?.forward_pe_consensus_basis ?? ""),
    md.fundamentals?.ev_ebitda ?? "",
    esc(md.fundamentals?.ev_ebitda_basis ?? ""),
    md.fundamentals?.pro_forma_ev_ebitda ?? "",
    md.fundamentals?.pro_forma_basis_consistent ?? "",
    esc(md.fundamentals?.federal_authorization_status ?? ""),
    md.fundamentals?.days_to_authorization_expiry ?? "",
    esc(md.fundamentals?.state_dot_budget_trend ?? ""),
    // ⚠ Column lna_integration_state is fed from the PAYLOAD key
    // ma_integration_state — deliberate rename, see the schema note above.
    esc(md.fundamentals?.ma_integration_state ?? ""),
    md.fundamentals?.pro_forma_net_leverage ?? "",
    esc(md.fundamentals?.delever_glidepath_status ?? ""),
    md.fundamentals?.lna_synergies_credited_musd ?? "",
    md.fundamentals?.pro_forma_share_count_change_pct ?? "",
    md.fundamentals?.reserve_tons_millions ?? "",
    md.fundamentals?.reserve_life_years ?? "",
    md.fundamentals?.roic_pct ?? "",
    md.fundamentals?.wacc_pct ?? "",
    md.fundamentals?.roic_denominator_distorted ?? "",
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
  // v8.1.1: run-level completeness audit (present from generate-signals v8.1.1 on).
  // Legacy inputs without the block record complete:null (completeness unknown).
  data_quality: data_quality ?? { expected: null, scored: normalized.length, missing: [], complete: null },
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
    // V3 macro additions — BBB credit spread (leads LIN backlog 6-12mo)
    bbb_oas_bps: macro.bbb_oas_bps ?? null,
    bbb_oas_1m_change_bps: macro.bbb_oas_1m_change_bps ?? null,
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

      // ─── V3 additions ─────────────────────────────────────────────────
      // V3 LIN tactical extras (catalyst hunt + growth-scare)
      iv_rv_ratio:           md.tactical_extras?.iv_rv_ratio ?? null,
      qual_vs_spy_30d_pp:    md.factor_flow?.qual_vs_spy_30d_pp ?? null,
      spy_10d_drawdown_pct:  md.tactical_extras?.spy_10d_drawdown_pct ?? null,
      lin_vs_spy_10d_pp:     md.tactical_extras?.lin_vs_spy_10d_pp ?? null,
      // V3 LIN fundamentals additions
      asu_utilization_pct:    md.fundamentals?.asu_utilization_pct ?? null,
      price_mix_ex_fx_pct:    md.fundamentals?.price_mix_ex_fx_pct ?? null,
      eps_revisions_30d_pct:  md.fundamentals?.eps_revisions_30d_pct ?? null,
      eps_revisions_90d_pct:  md.fundamentals?.eps_revisions_90d_pct ?? null,
      // V3 LIN peer triangulation + P/E delta
      lin_peer_aipa_spread_pp:     md.peer_relative_aipa?.relative_spread_pp ?? null,
      peer_pe_premium_6m_delta_pp: md.peer_valuation?.premium_6m_delta_pp ?? null,
      // V3 LIN H2 layer (concretized)
      h2_contracts_90d_usd_m: md.h2_layer?.contracts_90d_usd_m ?? null,
      h2_subsidy_regime:      md.h2_layer?.subsidy_regime ?? null,
      h2_lcoe_gap_usd_kg:     md.h2_layer?.lcoe_gap_usd_kg ?? null,
      h2_lcoe_gap_6m_delta:   md.h2_layer?.lcoe_gap_6m_delta ?? null,

      // ─── V4 / V7.6 NOW additions ───────────────────────────────────────
      // Cohort valuation — NOW keys (V7.6) + ISRG keys (V8.3.0); the mapper is
      // shared and additive: non-applicable keys are null on each row.
      cohort_valuation: md.cohort_valuation ? {
        now_pe:         md.cohort_valuation.now_pe ?? null,
        crm_pe:         md.cohort_valuation.crm_pe ?? null,
        wday_pe:        md.cohort_valuation.wday_pe ?? null,
        adbe_pe:        md.cohort_valuation.adbe_pe ?? null,
        // V8.3.0: ISRG devices cohort
        isrg_pe:        md.cohort_valuation.isrg_pe ?? null,
        mdt_pe:         md.cohort_valuation.mdt_pe ?? null,
        syk_pe:         md.cohort_valuation.syk_pe ?? null,
        bsx_pe:         md.cohort_valuation.bsx_pe ?? null,
        // V8.4.0: RDDT ads cohort. NOTE basis — fetch v4.16 tags this block
        // "trailing"; the RDDT model reasons on FORWARD P/E, sourced by the
        // LLM and living in the hostile-review prose, not here.
        rddt_pe:        md.cohort_valuation.rddt_pe ?? null,
        meta_pe:        md.cohort_valuation.meta_pe ?? null,
        pins_pe:        md.cohort_valuation.pins_pe ?? null,
        app_pe:         md.cohort_valuation.app_pe ?? null,
        // V8.5.0: MLM aggregates cohort (weighted VMC .50 / CRH .25 / EXP .25).
        mlm_pe:         md.cohort_valuation.mlm_pe ?? null,
        vmc_pe:         md.cohort_valuation.vmc_pe ?? null,
        crh_pe:         md.cohort_valuation.crh_pe ?? null,
        exp_pe:         md.cohort_valuation.exp_pe ?? null,
        mlm_vs_vmc_pct: md.cohort_valuation.mlm_vs_vmc_pct ?? null,
        cohort_weighting: md.cohort_valuation.cohort_weighting ?? null,
        basis:          md.cohort_valuation.basis ?? null,
        cohort_avg_pe:  md.cohort_valuation.cohort_avg_pe ?? null,
        premium_pct:    md.cohort_valuation.premium_pct ?? null,
        // ★★ Interpretive flags for premium_pct. FALSE means the premium above
        // is an accounting artifact, not a valuation read. daily-log.jsonl is
        // the authoritative record that feeds attribution → calibration, so
        // storing the number without these would teach a false relationship.
        premium_pct_reliable: md.cohort_valuation.premium_pct_reliable ?? null,
        trailing_discount_artifact_suspected: md.cohort_valuation.trailing_discount_artifact_suspected ?? null,
      } : null,
      // Cohort relative — 30d returns + rotation (NOW keys + V8.3.0 ISRG keys)
      cohort_relative: md.cohort_relative ? {
        now_30d_return_pct:          md.cohort_relative.now_30d_return_pct ?? null,
        cohort_avg_30d_return_pct:   md.cohort_relative.cohort_avg_30d_return_pct ?? null,
        rotation_pressure_pp:        md.cohort_relative.rotation_pressure_pp ?? null,
        rotation_pressure_active:    md.cohort_relative.rotation_pressure_active ?? null,
        // V8.3.0: ISRG fear rotation
        isrg_30d_return_pct:         md.cohort_relative.isrg_30d_return_pct ?? null,
        cohort_rotation_pp:          md.cohort_relative.cohort_rotation_pp ?? null,
        cohort_rotation_active:      md.cohort_relative.cohort_rotation_active ?? null,
        // V8.4.0: RDDT ads rotation. Shares cohort_rotation_pp/_active with
        // ISRG (different thresholds upstream: RDDT fires at -8pp, ISRG at
        // -6pp) — the ACTIVE flag is already threshold-applied by fetch.
        rddt_30d_return_pct:         md.cohort_relative.rddt_30d_return_pct ?? null,
        meta_30d_return_pct:         md.cohort_relative.meta_30d_return_pct ?? null,
        pins_30d_return_pct:         md.cohort_relative.pins_30d_return_pct ?? null,
        app_30d_return_pct:          md.cohort_relative.app_30d_return_pct ?? null,
        // V8.5.0: MLM aggregates rotation. peer_rotation_* are the NEW key
        // names from fetch v4.17; both are recorded raw here and ALSO folded
        // into the shared cohort_rotation_* CSV columns by the row builder.
        mlm_30d_return_pct:          md.cohort_relative.mlm_30d_return_pct ?? null,
        vmc_30d_return_pct:          md.cohort_relative.vmc_30d_return_pct ?? null,
        crh_30d_return_pct:          md.cohort_relative.crh_30d_return_pct ?? null,
        exp_30d_return_pct:          md.cohort_relative.exp_30d_return_pct ?? null,
        cohort_weighting:            md.cohort_relative.cohort_weighting ?? null,
        peer_rotation_pp:            md.cohort_relative.peer_rotation_pp ?? null,
        peer_rotation_active:        md.cohort_relative.peer_rotation_active ?? null,
        // ★ The TWIN read — deliberately NOT folded into the cohort average.
        // MLM and VMC are the two dominant US aggregates franchises; diluting
        // this inside a 3-name mean destroys the archetype's best tactical signal.
        vmc_spread_30d_pp:           md.cohort_relative.vmc_spread_30d_pp ?? null,
        vmc_dislocation_active:      md.cohort_relative.vmc_dislocation_active ?? null,
      } : null,
      // Factor flow — software cohort vs SPY (NOW row primarily)
      igv_vs_spy_30d_pp:    md.factor_flow?.igv_vs_spy_30d_pp ?? null,
      // NOW shared fundamentals
      fcf_margin_pct:                  md.fundamentals?.fcf_margin_pct ?? null,
      crpo_growth_pct:                 md.fundamentals?.crpo_growth_pct ?? null,
      subscription_revenue_growth_pct: md.fundamentals?.subscription_revenue_growth_pct ?? null,
      deals_1m_plus_yoy_pct:           md.fundamentals?.deals_1m_plus_yoy_pct ?? null,
      federal_growth_pct:              md.fundamentals?.federal_growth_pct ?? null,

      // ─── V8.3.0 MA additions (MA row only; null elsewhere) ─────────────
      twin_valuation: md.twin_valuation ? {
        ma_pe:       md.twin_valuation.ma_pe ?? null,
        v_pe:        md.twin_valuation.v_pe ?? null,
        premium_pct: md.twin_valuation.premium_pct ?? null,
      } : null,
      twin_relative: md.twin_relative ? {
        ma_change_pct:      md.twin_relative.ma_change_pct ?? null,
        v_change_pct:       md.twin_relative.v_change_pct ?? null,
        relative_spread_pp: md.twin_relative.relative_spread_pp ?? null,
      } : null,
      duopoly_relative: md.duopoly_relative ? {
        ma_30d_return_pct:          md.duopoly_relative.ma_30d_return_pct ?? null,
        v_30d_return_pct:           md.duopoly_relative.v_30d_return_pct ?? null,
        spy_30d_return_pct:         md.duopoly_relative.spy_30d_return_pct ?? null,
        twin_spread_pp:             md.duopoly_relative.twin_spread_pp ?? null,
        twin_dislocation_active:    md.duopoly_relative.twin_dislocation_active ?? null,
        duopoly_avg_30d_return_pct: md.duopoly_relative.duopoly_avg_30d_return_pct ?? null,
        duopoly_vs_spy_pp:          md.duopoly_relative.duopoly_vs_spy_pp ?? null,
        disruption_fear_regime:     md.duopoly_relative.disruption_fear_regime ?? null,
      } : null,
      cross_border_growth_pct:         md.fundamentals?.cross_border_growth_pct ?? null,
      gdv_growth_pct:                  md.fundamentals?.gdv_growth_pct ?? null,
      switched_txn_growth_pct:         md.fundamentals?.switched_txn_growth_pct ?? null,
      vas_growth_pct:                  md.fundamentals?.vas_growth_pct ?? null,
      vas_share_of_revenue_pct:        md.fundamentals?.vas_share_of_revenue_pct ?? null,
      rebates_incentives_trend:        md.fundamentals?.rebates_incentives_trend ?? null,
      buyback_share_reduction_yoy_pct: md.fundamentals?.buyback_share_reduction_yoy_pct ?? null,
      stablecoin_strategy_execution:   md.fundamentals?.stablecoin_strategy_execution ?? null,
      disruption_narrative_phase:      md.fundamentals?.disruption_narrative_phase ?? null,
      disruption_fundamental_evidence: md.fundamentals?.disruption_fundamental_evidence ?? null,
      interchange_regulation_status:   md.fundamentals?.interchange_regulation_status ?? null,

      // ─── V8.3.0 ISRG additions (ISRG row only; null elsewhere) ─────────
      ihi_vs_spy_30d_pp:               md.factor_flow?.ihi_vs_spy_30d_pp ?? null,
      procedure_growth_pct:            md.fundamentals?.procedure_growth_pct ?? null,
      procedure_guide_low_pct:         md.fundamentals?.procedure_guide_low_pct ?? null,
      procedure_guide_high_pct:        md.fundamentals?.procedure_guide_high_pct ?? null,
      dv_placements_qtr:               md.fundamentals?.dv_placements_qtr ?? null,
      dv5_mix_pct:                     md.fundamentals?.dv5_mix_pct ?? null,
      ion_procedure_growth_pct:        md.fundamentals?.ion_procedure_growth_pct ?? null,
      ion_installed_base:              md.fundamentals?.ion_installed_base ?? null,
      recurring_revenue_pct:           md.fundamentals?.recurring_revenue_pct ?? null,
      ia_revenue_growth_pct:           md.fundamentals?.ia_revenue_growth_pct ?? null,
      installed_base_total:            md.fundamentals?.installed_base_total ?? null,
      installed_base_yoy_pct:          md.fundamentals?.installed_base_yoy_pct ?? null,
      moat_status:                     md.fundamentals?.moat_status ?? null,
      instrument_transition_status:    md.fundamentals?.instrument_transition_status ?? null,

      // ─── V8.4.0 RDDT additions (RDDT row only; null elsewhere) ─────────
      xlc_vs_spy_30d_pp:               md.factor_flow?.xlc_vs_spy_30d_pp ?? null,
      ad_revenue_growth_yoy_pct:       md.fundamentals?.ad_revenue_growth_yoy_pct ?? null,
      revenue_growth_yoy_pct:          md.fundamentals?.revenue_growth_yoy_pct ?? null,
      arpu_global:                     md.fundamentals?.arpu_global ?? null,
      arpu_growth_yoy_pct:             md.fundamentals?.arpu_growth_yoy_pct ?? null,
      arpu_us:                         md.fundamentals?.arpu_us ?? null,
      arpu_row:                        md.fundamentals?.arpu_row ?? null,
      dauq_millions:                   md.fundamentals?.dauq_millions ?? null,
      dauq_growth_yoy_pct:             md.fundamentals?.dauq_growth_yoy_pct ?? null,
      wauq_growth_yoy_pct:             md.fundamentals?.wauq_growth_yoy_pct ?? null,
      // ⚠ Discontinued by the company from Q3 2026. NULL here means "withdrawn
      // disclosure", not "not fetched" — dau_disclosure_status disambiguates.
      // Nothing downstream may impute these.
      logged_in_dau_growth_pct:        md.fundamentals?.logged_in_dau_growth_pct ?? null,
      logged_out_dau_growth_pct:       md.fundamentals?.logged_out_dau_growth_pct ?? null,
      dau_disclosure_status:           md.fundamentals?.dau_disclosure_status ?? null,
      ebitda_margin_pct:               md.fundamentals?.ebitda_margin_pct ?? null,
      ttm_operating_cash_flow_musd:    md.fundamentals?.ttm_operating_cash_flow_musd ?? null,
      sbc_trend:                       md.fundamentals?.sbc_trend ?? null,
      next_qtr_guide_low_musd:         md.fundamentals?.next_qtr_guide_low_musd ?? null,
      next_qtr_guide_high_musd:        md.fundamentals?.next_qtr_guide_high_musd ?? null,
      guide_implied_growth_pct:        md.fundamentals?.guide_implied_growth_pct ?? null,
      // ⚠ POSITIVE = DILUTION. Opposite sign convention to MA's
      // buyback_share_reduction_yoy_pct above. gross_buyback_musd is context
      // only and is NOT a shareholder-return signal for this holding.
      share_count_change_yoy_pct:      md.fundamentals?.share_count_change_yoy_pct ?? null,
      gross_buyback_musd:              md.fundamentals?.gross_buyback_musd ?? null,
      search_referral_status:          md.fundamentals?.search_referral_status ?? null,
      licensing_status:                md.fundamentals?.licensing_status ?? null,
      licensing_annual_musd:           md.fundamentals?.licensing_annual_musd ?? null,
      competitive_threat:              md.fundamentals?.competitive_threat ?? null,
      ps_pct_of_3y_avg:                md.fundamentals?.ps_pct_of_3y_avg ?? null,
      own_history_window_partial:      md.fundamentals?.own_history_window_partial ?? null,

      // ─── V8.5.0 MLM additions (MLM row only; null elsewhere) ───────────
      xlb_vs_spy_30d_pp:               md.factor_flow?.xlb_vs_spy_30d_pp ?? null,
      // ★ THE moat metric. Aggregates have no exchange price, so mix-adjusted
      // organic pricing IS the local-monopoly test. Below 1% is the cleanest
      // falsifier in this model — thesis-level regardless of volume.
      mix_adjusted_organic_pricing_pct: md.fundamentals?.mix_adjusted_organic_pricing_pct ?? null,
      organic_asp_growth_pct:          md.fundamentals?.organic_asp_growth_pct ?? null,
      // ⚠ reported_asp_* are CONTEXT ONLY while reported_asp_signal_status is
      // "null_signal_mix_contaminated" — the figure is mix-poisoned by M&A
      // (Q2'26: −2% reported vs +3.7% organic mix-adjusted). Never score it.
      reported_asp_usd:                md.fundamentals?.reported_asp_usd ?? null,
      reported_asp_growth_pct:         md.fundamentals?.reported_asp_growth_pct ?? null,
      reported_asp_signal_status:      md.fundamentals?.reported_asp_signal_status ?? null,
      organic_volume_growth_pct:       md.fundamentals?.organic_volume_growth_pct ?? null,
      reported_volume_growth_pct:      md.fundamentals?.reported_volume_growth_pct ?? null,
      total_tons_millions:             md.fundamentals?.total_tons_millions ?? null,
      // ⚠ Governs whether a negative organic-volume reading is real demand
      // weakness. The engine REMOVES (not reduces) the penalty when this is
      // "material_headwind". Persisted so calibration can separate rain from demand.
      weather_impact_flag:             md.fundamentals?.weather_impact_flag ?? null,
      cash_gross_profit_per_ton:       md.fundamentals?.cash_gross_profit_per_ton ?? null,
      cogs_per_ton_growth_pct:         md.fundamentals?.cogs_per_ton_growth_pct ?? null,
      cogs_per_ton_growth_ex_freight_pct: md.fundamentals?.cogs_per_ton_growth_ex_freight_pct ?? null,
      energy_headwind:                 md.fundamentals?.energy_headwind ?? null,
      inventory_step_up_charge_musd:   md.fundamentals?.inventory_step_up_charge_musd ?? null,
      infrastructure_demand:           md.fundamentals?.infrastructure_demand ?? null,
      heavy_nonres_demand:             md.fundamentals?.heavy_nonres_demand ?? null,
      residential_demand:              md.fundamentals?.residential_demand ?? null,
      fy_revenue_guide_action:         md.fundamentals?.fy_revenue_guide_action ?? null,
      fy_ebitda_guide_action:          md.fundamentals?.fy_ebitda_guide_action ?? null,
      // ⚠ Every multiple carries its BASIS tag. Comparing a forward multiple
      // against a trailing one fabricates a re-rating; the basis fields are
      // what let a later reader tell which comparison a number supports.
      forward_pe:                      md.fundamentals?.forward_pe ?? null,
      forward_pe_consensus_basis:      md.fundamentals?.forward_pe_consensus_basis ?? null,
      ev_ebitda:                       md.fundamentals?.ev_ebitda ?? null,
      ev_ebitda_basis:                 md.fundamentals?.ev_ebitda_basis ?? null,
      pro_forma_ev_ebitda:             md.fundamentals?.pro_forma_ev_ebitda ?? null,
      pro_forma_basis_consistent:      md.fundamentals?.pro_forma_basis_consistent ?? null,
      // Public construction funding regime — the V8.4 MLM weight-gate driver.
      // ⚠ "short_term_extension" is the BASE CASE, not a downgrade.
      federal_authorization_status:    md.fundamentals?.federal_authorization_status ?? null,
      days_to_authorization_expiry:    md.fundamentals?.days_to_authorization_expiry ?? null,
      state_dot_budget_trend:          md.fundamentals?.state_dot_budget_trend ?? null,
      // ⚠ Payload key ma_integration_state; the CSV column is renamed
      // lna_integration_state to escape the ma_ prefix collision. JSONL keeps
      // the payload key so the two artifacts stay traceable to each other.
      ma_integration_state:            md.fundamentals?.ma_integration_state ?? null,
      // ⚠ Leverage is scored on the GLIDEPATH, never the level. 3.7x at close
      // is the plan working as announced; a missed schedule is the signal.
      pro_forma_net_leverage:          md.fundamentals?.pro_forma_net_leverage ?? null,
      delever_glidepath_status:        md.fundamentals?.delever_glidepath_status ?? null,
      lna_synergies_credited_musd:     md.fundamentals?.lna_synergies_credited_musd ?? null,
      pro_forma_share_count_change_pct: md.fundamentals?.pro_forma_share_count_change_pct ?? null,
      reserve_tons_millions:           md.fundamentals?.reserve_tons_millions ?? null,
      reserve_life_years:              md.fundamentals?.reserve_life_years ?? null,
      // ⚠ roic_denominator_distorted=true means roic_pct is NOT a quality read
      // on that row — the capital base was inflated by acquisitions ahead of
      // their earnings. Same interpretive role as premium_pct_reliable.
      roic_pct:                        md.fundamentals?.roic_pct ?? null,
      wacc_pct:                        md.fundamentals?.wacc_pct ?? null,
      roic_denominator_distorted:      md.fundamentals?.roic_denominator_distorted ?? null,

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

      // V3: regime context (propagated from score-engine; V8.1 extends beyond LIN)
      ...(() => { const r = resolveRegime(s); return {
        regime:        r.regime,
        regime_pmi:    r.regime_pmi,
        weights:       r.weights,
        // V8.0: V8.1 regime gate telemetry
        regime_driver: r.regime_driver,
        regime_basis:  r.regime_basis,
      }; })(),

      // V8.0: self-improvement telemetry (full fidelity — calibration v2 inputs)
      divergence:     s.divergence ?? null,
      hostile_review: s.hostile_review ?? null,

      // V8.2.0: temporal z (vs own trailing baseline) + verification-gate outcome
      tz:             s.tz ?? null,
      verification:   s.verification ?? null,

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
