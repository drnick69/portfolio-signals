// ─── rebuild-signals-csv.mjs v2.1 ────────────────────────────────────────────
// Rebuilds docs/history/signals.csv from docs/history/daily-log.jsonl under the
// CURRENT log-signals header. The repair tool for the CSV: run it (Actions →
// "Rebuild signals.csv") whenever log-signals reports a header mismatch that is
// NOT a pure append, or signal-accuracy reports skipped rows.
//
// v2.0 (October 2026): RESTORED AND MADE SELF-SYNCING.
//   • RESTORED. On 2026-07-07 (commit a80251d) this file's contents were
//     replaced by a copy of claire-summary.mjs — a paste into the wrong file.
//     From then until this version, the "Rebuild signals.csv" workflow that
//     log-signals' mismatch warning and signal-accuracy's skip warning both
//     point to would have run a Claire summary instead of a rebuild. The last
//     genuine version (ceb56a4, July 2026) is the base here.
//   • THE HEADER IS NO LONGER A COPY. v1 kept its own column list under a
//     "KEEP IN SYNC with log-signals" comment, and it had already fallen
//     behind — it stopped at the V8.2 telemetry, ~115 columns, while
//     log-signals moved on to 234 (V8.5.0) and 287 (V8.6.0). A rebuild with
//     that list would have silently thrown away every column added since.
//     v2.0 reads CSV_HEADERS out of .github/scripts/log-signals.mjs at run
//     time (the array literal is parsed as text, never evaluated), so the
//     rebuilt file always carries exactly the header log-signals will write
//     next, and migrateCsvHeader() sees a match.
//   • EXTRACTORS ARE KEYED BY COLUMN NAME. Most JSONL fields carry the same
//     name as their CSV column (true of every flat field added since V8.3), so
//     the default is the same-named key on the logged holding. EXTRACTORS
//     below lists only the columns where the JSONL path differs — nested
//     cohort/twin/duopoly blocks, the layer score objects, macro, renamed keys.
//     A future column that follows the flat-key convention needs no edit here.
//   • NOT RECOVERABLE (blank in rebuilt rows; never written to the JSONL):
//     z_tactical, z_positional, z_strategic, confidence_level,
//     confidence_score, confidence_missing. Same as v1.
//   • RECONCILIATION REPORT. Before overwriting, the old CSV is parsed (rows
//     whose width matches its own header) and compared with the rebuild cell by
//     cell on (date, symbol). Columns where they disagree are printed, so a
//     rebuild that loses data is visible in the Actions log instead of silent.
//     Rows the old file could not parse are exactly what this tool repairs, so
//     they are counted, not compared.
//   • BACKUPS. signals.csv.pre-rebuild.bak keeps the very first backup (June
//     2026) and is never overwritten, as in v1. NEW: every run also writes
//     signals.csv.last-rebuild.bak — the file as it stood just before THIS
//     rebuild — so the most recent pre-repair state is always recoverable.
//
// v2.1 (October 2026): log-signals V8.7.0 (ENB → CVX) sync — extractors for the
//   CVX columns whose JSONL path differs from the column name: the twin leg
//   (twin_valuation.xom_pe / reference_european_avg_pe), the XOM twin rotation
//   (cohort_relative.*, incl. the deliberate rename xom_dislocation_active ←
//   twin_dislocation_active), the oil_regime block (brent_spot,
//   brent_spot_stale, henry_hub_spot), and the engine's cycle gate
//   (strategic.cycle_gate_active / cycle_gate_side, as for value_trap_gate_
//   active). premium_pct_reliable and premium_unreliable_reason read the
//   cohort block first and fall back to twin_valuation — the same either-key
//   fold log-signals V8.7.0 applies, so CVX rows rebuild with their gate. Every
//   other CVX column is a same-named flat key and needs nothing here.
//
// Formatting matches log-signals exactly where the JSONL allows: z_composite to
// 3 decimals, regime_pmi to 2, booleans as "true"/"false", div_flagged joined
// with ";", every value through the same esc() quoting. Rows are emitted in
// daily-log order, one per (date, holding); the JSONL replaces same-date
// re-runs, so the rebuild also drops the duplicate rows the CSV's append-only
// writes accumulate when a day is re-run.
// ────────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";

const HISTORY_DIR   = process.env.HISTORY_DIR || "docs/history";
const LOG_SIGNALS   = process.env.LOG_SIGNALS_PATH || ".github/scripts/log-signals.mjs";
const JSONL_PATH    = `${HISTORY_DIR}/daily-log.jsonl`;
const CSV_PATH      = `${HISTORY_DIR}/signals.csv`;
const BAK_FIRST     = `${HISTORY_DIR}/signals.csv.pre-rebuild.bak`;
const BAK_LAST      = `${HISTORY_DIR}/signals.csv.last-rebuild.bak`;

// ─── helpers ─────────────────────────────────────────────────────────────────
const esc = (v) => {
  if (v == null || v === "") return "";
  const str = String(v);
  return str.includes(",") || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
};

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

// The header, read from log-signals.mjs and PARSED, never evaluated: the array
// body may contain only double-quoted column names, commas, whitespace and
// // comments. Anything else is a hard failure — this tool never guesses a
// schema, and never runs code from another file to find one.
function loadHeader() {
  const src = readFileSync(LOG_SIGNALS, "utf-8");
  const start = src.indexOf("const CSV_HEADERS = [");
  const end = src.indexOf('].join(",");', start);
  if (start === -1 || end === -1) throw new Error(`CSV_HEADERS not found in ${LOG_SIGNALS}`);
  const body = src.slice(start + "const CSV_HEADERS = [".length, end)
    .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");   // drop line comments
  const cols = [...body.matchAll(/"([a-z0-9_]+)"/g)].map(m => m[1]);
  const residue = body.replace(/"[a-z0-9_]+"/g, "").replace(/[\s,]/g, "");
  if (residue !== "") throw new Error(`CSV_HEADERS in ${LOG_SIGNALS} contains something other than column names: ${residue.slice(0, 60)}`);
  if (cols.length === 0) throw new Error(`CSV_HEADERS in ${LOG_SIGNALS} is empty`);
  if (new Set(cols).size !== cols.length) throw new Error(`CSV_HEADERS in ${LOG_SIGNALS} has duplicate names`);
  return cols;
}

// Tolerant getters — daily-log shapes evolved; mirror attribute-signals' defenses.
const num     = (v) => (typeof v === "number" ? v : null);
const price   = (h) => num(h.price) ?? h.price?.current ?? null;
const layer   = (h, l) => h[l] || {};
const blended = (h, l) => layer(h, l).blended ?? layer(h, l).score ?? null;
const fixed   = (v, d) => (typeof v === "number" ? v.toFixed(d) : v);
const kmName  = (h) => typeof h.key_metric === "string" ? h.key_metric.split(": ")[0] : (h.key_metric?.name ?? null);
const kmValue = (h) => typeof h.key_metric === "string"
  ? (h.key_metric.includes(": ") ? h.key_metric.slice(h.key_metric.indexOf(": ") + 2) : null)
  : (h.key_metric?.value ?? null);
const cv = (h, k) => h.cohort_valuation?.[k];
const cr = (h, k) => h.cohort_relative?.[k];
const dr = (h, k) => h.duopoly_relative?.[k];

const NOT_IN_JSONL = new Set([
  "z_tactical", "z_positional", "z_strategic",
  "confidence_level", "confidence_score", "confidence_missing",
]);

const MACRO_COLS = new Set([
  "vix", "us10y", "us2y", "tips10y", "spread_2s10s", "hy_oas", "fed_funds",
  "wti", "mxn_usd", "brl_usd", "gscpi", "dxy", "us_ism", "eu_pmi", "china_pmi",
  "bbb_oas_bps", "bbb_oas_1m_change_bps",
]);

// Columns whose JSONL path differs from their name. Everything else defaults to
// the same-named flat key on the logged holding.
const EXTRACTORS = {
  // Identity + price
  date:   (h, e) => e.date,
  price:  (h) => price(h),
  // Layer scores
  det_tactical:   (h) => layer(h, "tactical").det,
  det_positional: (h) => layer(h, "positional").det,
  det_strategic:  (h) => layer(h, "strategic").det,
  det_composite:  (h) => layer(h, "composite").det,
  llm_tactical:   (h) => layer(h, "tactical").llm,
  llm_positional: (h) => layer(h, "positional").llm,
  llm_strategic:  (h) => layer(h, "strategic").llm,
  llm_composite:  (h) => layer(h, "composite").llm,
  tactical_score:   (h) => blended(h, "tactical"),
  positional_score: (h) => blended(h, "positional"),
  strategic_score:  (h) => blended(h, "strategic"),
  composite_score:  (h) => blended(h, "composite"),
  tactical_signal:   (h) => layer(h, "tactical").signal,
  positional_signal: (h) => layer(h, "positional").signal,
  strategic_signal:  (h) => layer(h, "strategic").signal,
  recommendation:    (h) => layer(h, "composite").recommendation,
  z_composite:       (h) => fixed(h.z_composite, 3),
  // Key metric (JSONL stores "name: value" as one string)
  key_metric_name:  (h) => kmName(h),
  key_metric_value: (h) => kmValue(h),
  // Regime context
  regime_pmi: (h) => fixed(h.regime_pmi, 2),
  weight_t:   (h) => h.weights?.t,
  weight_p:   (h) => h.weights?.p,
  weight_s:   (h) => h.weights?.s,
  // V8.0 / V8.2 telemetry
  div_tactical:   (h) => h.divergence?.tactical,
  div_positional: (h) => h.divergence?.positional,
  div_strategic:  (h) => h.divergence?.strategic,
  div_flagged:    (h) => (h.divergence?.flagged || []).join(";"),
  tz_tactical:    (h) => h.tz?.tactical,
  tz_positional:  (h) => h.tz?.positional,
  tz_strategic:   (h) => h.tz?.strategic,
  tz_composite:   (h) => h.tz?.composite,
  verify_passed:  (h) => h.verification ? (h.verification.passed ? "true" : "false") : null,
  verify_turns:   (h) => h.verification?.corrective_turns,
  // Cohort valuation (NOW / MSFT / LHX / ISRG / RDDT / MLM / UBER)
  now_pe: (h) => cv(h, "now_pe"), crm_pe: (h) => cv(h, "crm_pe"),
  wday_pe: (h) => cv(h, "wday_pe"), adbe_pe: (h) => cv(h, "adbe_pe"),
  cohort_avg_pe:      (h) => cv(h, "cohort_avg_pe"),
  cohort_premium_pct: (h) => cv(h, "premium_pct"),
  mdt_pe: (h) => cv(h, "mdt_pe"), syk_pe: (h) => cv(h, "syk_pe"), bsx_pe: (h) => cv(h, "bsx_pe"),
  meta_pe: (h) => cv(h, "meta_pe"), pins_pe: (h) => cv(h, "pins_pe"), app_pe: (h) => cv(h, "app_pe"),
  vmc_pe: (h) => cv(h, "vmc_pe"), crh_pe: (h) => cv(h, "crh_pe"), exp_pe: (h) => cv(h, "exp_pe"),
  mlm_vs_vmc_pct: (h) => cv(h, "mlm_vs_vmc_pct"),
  // v2.1: either key, exactly as log-signals V8.7.0 folds it (CVX carries the
  // pair in its twin block, not a cohort block).
  premium_pct_reliable:                 (h) => cv(h, "premium_pct_reliable") ?? h.twin_valuation?.premium_pct_reliable,
  trailing_discount_artifact_suspected: (h) => cv(h, "trailing_discount_artifact_suspected"),
  dash_pe: (h) => cv(h, "dash_pe"), lyft_pe: (h) => cv(h, "lyft_pe"), grab_pe: (h) => cv(h, "grab_pe"),
  uber_vs_dash_pct:          (h) => cv(h, "uber_vs_dash_pct"),
  premium_unreliable_reason: (h) => cv(h, "unreliable_reason") ?? h.twin_valuation?.unreliable_reason,
  // Cohort relative
  now_30d_return_pct:        (h) => cr(h, "now_30d_return_pct"),
  cohort_avg_30d_return_pct: (h) => cr(h, "cohort_avg_30d_return_pct"),
  rotation_pressure_pp:      (h) => cr(h, "rotation_pressure_pp"),
  rotation_pressure_active:  (h) => cr(h, "rotation_pressure_active"),
  isrg_30d_return_pct:       (h) => cr(h, "isrg_30d_return_pct"),
  // Either key, exactly as log-signals V8.5.0+ folds it.
  cohort_rotation_pp:        (h) => cr(h, "cohort_rotation_pp") ?? cr(h, "peer_rotation_pp"),
  cohort_rotation_active:    (h) => cr(h, "cohort_rotation_active") ?? cr(h, "peer_rotation_active"),
  rddt_30d_return_pct:       (h) => cr(h, "rddt_30d_return_pct"),
  mlm_30d_return_pct:        (h) => cr(h, "mlm_30d_return_pct"),
  vmc_spread_30d_pp:         (h) => cr(h, "vmc_spread_30d_pp"),
  vmc_dislocation_active:    (h) => cr(h, "vmc_dislocation_active"),
  uber_30d_return_pct:       (h) => cr(h, "uber_30d_return_pct"),
  dash_spread_30d_pp:        (h) => cr(h, "dash_spread_30d_pp"),
  // MA twin / duopoly blocks
  v_pe:                    (h) => h.twin_valuation?.v_pe,
  twin_premium_pct:        (h) => h.twin_valuation?.premium_pct,
  twin_daily_spread_pp:    (h) => h.twin_relative?.relative_spread_pp,
  ma_30d_return_pct:       (h) => dr(h, "ma_30d_return_pct"),
  v_30d_return_pct:        (h) => dr(h, "v_30d_return_pct"),
  twin_spread_30d_pp:      (h) => dr(h, "twin_spread_pp"),
  twin_dislocation_active: (h) => dr(h, "twin_dislocation_active"),
  duopoly_vs_spy_pp:       (h) => dr(h, "duopoly_vs_spy_pp"),
  disruption_fear_regime:  (h) => dr(h, "disruption_fear_regime"),
  // Renamed vs payload key (see log-signals V8.5.0)
  lna_integration_state: (h) => h.ma_integration_state,
  // Engine output stored beside the blended score it clips (log-signals V8.6.0)
  value_trap_gate_active: (h) => layer(h, "strategic").value_trap_gate_active,
  // v2.1 — CVX (log-signals V8.7.0). Twin leg + structural-discount reference.
  xom_pe:              (h) => h.twin_valuation?.xom_pe,
  european_ref_avg_pe: (h) => h.twin_valuation?.reference_european_avg_pe,
  // XOM twin rotation. ⚠ Column renamed vs its payload key (see log-signals V8.7.0).
  cvx_30d_return_pct:          (h) => cr(h, "cvx_30d_return_pct"),
  xom_30d_return_pct:          (h) => cr(h, "xom_30d_return_pct"),
  xom_spread_30d_pp:           (h) => cr(h, "xom_spread_30d_pp"),
  xom_dislocation_active:      (h) => cr(h, "twin_dislocation_active"),
  european_avg_30d_return_pct: (h) => cr(h, "european_avg_30d_return_pct"),
  // Oil regime vs the $70 deck (the deviation itself is regime_driver).
  brent_spot:       (h) => h.oil_regime?.brent_spot,
  brent_spot_stale: (h) => h.oil_regime?.brent_spot_stale,
  henry_hub_spot:   (h) => h.oil_regime?.henry_hub_spot,
  // Engine output stored beside the blended score it bounds (log-signals V8.7.0)
  cycle_gate_active: (h) => layer(h, "strategic").cycle_gate_active,
  cycle_gate_side:   (h) => layer(h, "strategic").cycle_gate_side,
};

function extract(col, h, entry) {
  if (NOT_IN_JSONL.has(col)) return null;
  if (MACRO_COLS.has(col)) return (entry.macro || {})[col];
  if (EXTRACTORS[col]) return EXTRACTORS[col](h, entry);
  const v = h[col];
  // Arrays stringify exactly as log-signals' esc() did ("a,b", quoted); a plain
  // object never belonged in a cell, so it is left blank rather than written
  // as "[object Object]".
  return v !== null && typeof v === "object" && !Array.isArray(v) ? null : v;
}

// Parse a CSV against its own header; rows of the wrong width are counted, not read.
function parseOwn(text) {
  const lines = text.trim().split("\n").map(l => l.replace(/\r$/, ""));
  const header = splitCSVLine(lines[0]);
  const rows = new Map();
  let unparsed = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = splitCSVLine(line);
    if (vals.length !== header.length) { unparsed++; continue; }
    const r = {};
    header.forEach((c, i) => { r[c] = vals[i]; });
    rows.set(`${r.date}|${r.symbol}`, r);   // last write wins, as in the JSONL
  }
  return { header, rows, unparsed, total: lines.length - 1 };
}

// ─── main ────────────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(JSONL_PATH)) {
    console.error(`ERROR: ${JSONL_PATH} not found — nothing to rebuild from.`);
    process.exit(1);
  }
  const COLS = loadHeader();
  console.log(`Header: ${COLS.length} columns, read from ${LOG_SIGNALS}`);

  // 1. Backups
  let oldText = null;
  if (existsSync(CSV_PATH)) {
    oldText = readFileSync(CSV_PATH, "utf-8");
    if (!existsSync(BAK_FIRST)) {
      copyFileSync(CSV_PATH, BAK_FIRST);
      console.log(`✓ First-ever backup → ${BAK_FIRST}`);
    } else {
      console.log(`  ${BAK_FIRST} exists — kept (the original pre-rebuild state is never overwritten)`);
    }
    copyFileSync(CSV_PATH, BAK_LAST);
    console.log(`✓ Pre-rebuild copy → ${BAK_LAST}`);
  }

  // 2. Load daily-log entries
  const entries = readFileSync(JSONL_PATH, "utf-8")
    .split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.date && Array.isArray(e.holdings));
  entries.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Loaded ${entries.length} daily-log entries (${entries[0]?.date} → ${entries[entries.length - 1]?.date})`);

  // 3. Emit rows under the current header
  const out = [COLS.join(",")];
  const perSymbol = {};
  const filled = Object.fromEntries(COLS.map(c => [c, 0]));
  for (const entry of entries) {
    for (const h of entry.holdings) {
      if (!h?.symbol) continue;
      const cells = COLS.map(c => {
        const v = extract(c, h, entry);
        if (v != null && v !== "") filled[c]++;
        return esc(v ?? "");
      });
      out.push(cells.join(","));
      perSymbol[h.symbol] = (perSymbol[h.symbol] || 0) + 1;
    }
  }
  const newText = out.join("\n") + "\n";

  // 4. Self-validation BEFORE anything is overwritten
  const widths = new Set(out.map(l => splitCSVLine(l).length));
  if (widths.size !== 1 || !widths.has(COLS.length)) {
    console.error(`✗ VALIDATION FAILED: widths seen = ${[...widths].join(", ")} (expected uniform ${COLS.length}). signals.csv NOT written.`);
    process.exit(1);
  }
  writeFileSync(CSV_PATH, newText);
  console.log(`✓ Wrote ${out.length - 1} rows × ${COLS.length} columns → ${CSV_PATH} (uniform width verified)`);

  // 5. Reconciliation against the file being replaced
  if (oldText) {
    const old = parseOwn(oldText);
    const neu = parseOwn(newText);
    const shared = COLS.filter(c => old.header.includes(c) && !NOT_IN_JSONL.has(c));
    // Two numbers that agree to the precision of the shorter one are the same
    // value written at different precision (e.g. v1 rebuilt rows kept full
    // z_composite precision; log-signals writes 3 dp). Counted, not flagged.
    const decimals = (t) => (t.split(".")[1] || "").length;
    const sameNumber = (a, b) => {
      if (a === "" || b === "" || isNaN(a) || isNaN(b)) return false;
      const d = Math.min(decimals(a), decimals(b));
      return Math.abs(Number(a) - Number(b)) <= 0.5 * 10 ** -d + 1e-12;
    };
    const disagree = {}, precisionOnly = {};
    let compared = 0;
    const droppedKeys = [];
    for (const [key, o] of old.rows) {
      const n = neu.rows.get(key);
      if (!n) { droppedKeys.push(key); continue; }
      compared++;
      for (const c of shared) {
        const a = o[c] ?? "", b = n[c] ?? "";
        if (a === b) continue;
        if (sameNumber(a, b)) precisionOnly[c] = (precisionOnly[c] || 0) + 1;
        else disagree[c] = (disagree[c] || 0) + 1;
      }
    }
    console.log(`\nReconciliation: old CSV ${old.total} rows (${old.rows.size} unique date|symbol parsed at its own ${old.header.length}-column width, ${old.unparsed} unparseable) → rebuilt ${neu.rows.size} rows.`);
    console.log(`  Compared ${compared} shared (date, symbol) rows across ${shared.length} shared columns.`);
    const bad = Object.entries(disagree).sort((a, b) => b[1] - a[1]);
    if (bad.length === 0) console.log("  ✓ Every shared cell matches in value.");
    else {
      console.log(`  ⚠ ${bad.length} column(s) differ in VALUE — check before trusting the rebuild:`);
      for (const [c, k] of bad.slice(0, 25)) console.log(`    ${c.padEnd(40)} ${k} row(s)`);
    }
    for (const [c, k] of Object.entries(precisionOnly)) console.log(`  · ${c}: ${k} row(s) differ only in decimal places written (same value).`);
    if (droppedKeys.length) console.log(`  ⚠ ${droppedKeys.length} (date, symbol) row(s) in the old CSV have no daily-log source and are not carried over: ${droppedKeys.slice(0, 10).join(", ")}${droppedKeys.length > 10 ? " …" : ""}`);
    const onlyOld = old.header.filter(c => !COLS.includes(c));
    if (onlyOld.length) console.log(`  ⚠ Columns in the old file but not in the current header (dropped): ${onlyOld.join(", ")}`);
  }

  // 6. Coverage
  console.log("\nPer-symbol row counts:");
  for (const [sym, n] of Object.entries(perSymbol).sort()) console.log(`  ${sym.padEnd(8)} ${n}`);
  const never = COLS.filter(c => filled[c] === 0 && !NOT_IN_JSONL.has(c));
  console.log(`\nBlank by design (never written to the JSONL): ${[...NOT_IN_JSONL].join(", ")}`);
  if (never.length) console.log(`Blank in every rebuilt row (no data logged yet, or no JSONL source): ${never.join(", ")}`);
  console.log("\nDONE.");
}

try {
  main();
} catch (e) {
  console.error(`✗ ${e.message}`);
  console.error("signals.csv was NOT modified.");
  process.exit(1);
}
