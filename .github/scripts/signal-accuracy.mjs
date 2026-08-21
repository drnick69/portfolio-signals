#!/usr/bin/env node
// signal-accuracy.mjs v1.6 — Forward-looking signal accuracy tracker.
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
//
// v1.4 — MA + ISRG v8.3 context propagation (12 → 14 holdings sync with
// log-signals V8.3.0, which appends the columns and migrates the header
// 115 → 155; this script's EXACT-width contract is DYNAMIC against the
// on-disk header, so no width constant changes here — the contract simply
// follows the migrated header). Yesterday-snapshot additionally propagates:
//   • MA: twin_premium_pct (vs V), twin_spread_30d_pp, duopoly_vs_spy_pp
//     (the V8.2 MA weight-gate driver), disruption_fear_regime, and
//     cross_border_growth_pct (MA's signature operational metric).
//   • ISRG: cohort_rotation_pp, ihi_vs_spy_30d_pp (the V8.2 ISRG weight-gate
//     driver), procedure_growth_pct (ISRG's signature operational metric),
//     moat_status, and instrument_transition_status. ISRG's cohort P/E
//     premium needs nothing new — it reuses the shared cohort_premium_pct
//     column the v1.2 block already propagates (as MSFT/LHX rows do).
// Same forward-compatibility pattern: blanks/absent columns no-op; fields
// only attach when populated, so other holdings and pre-v8.3 history stay
// clean. Aggregation logic remains symbol-agnostic — MA/ISRG stats simply
// accumulate from their first logged date forward (no other changes).
//
// v1.5 — RDDT v8.4 context propagation (IBIT → RDDT holdings swap; sync with
// log-signals V8.4.0, which appends 31 columns and migrates the header
// 155 → 186). As at v1.4, the EXACT-width contract is DYNAMIC against the
// on-disk header (headers.length), so NO width constant changes here — the
// contract follows the migrated header automatically. Pipeline order makes
// this self-consistent: this script runs BEFORE generate-signals, log-signals
// runs after and migrates the header in the same run it appends wider rows,
// so the file is never left with a header/row width disagreement between runs.
// Yesterday-snapshot additionally propagates:
//   • xlc_vs_spy_30d_pp — the V8.3 RDDT weight-gate driver (peer of
//     duopoly_vs_spy_pp for MA and ihi_vs_spy_30d_pp for ISRG)
//   • ad_revenue_growth_yoy_pct — RDDT's signature operational metric (peer of
//     procedure_growth_pct / cross_border_growth_pct / crpo_growth_pct)
//   • arpu_growth_yoy_pct — the monetization ramp; the second operational
//     metric, because on this name a stalling ARPU breaks the thesis faster
//     than slowing users would
//   • search_referral_status / licensing_status / competitive_threat — the
//     three categoricals that carry deterministic thesis-break weight in
//     engine V8.3 (peers of moat_status / instrument_transition_status)
//   • share_count_change_yoy_pct — the NET share count change. RDDT prints
//     POSITIVE here because its gross buyback does not offset stock comp.
//     [v1.6 CORRECTION: this is not a special convention — it is the raw YoY
//     % change, and MLM prints NEGATIVE on the same column. The column that
//     genuinely differs is MA's buyback_share_reduction_yoy_pct, which
//     measures a different quantity. Do not compare THOSE two as one measure.]
//   • ps_pct_of_3y_avg + own_history_window_partial — propagated as a PAIR and
//     meaningless apart: RDDT listed March 2024, so the own-history anchor
//     spans a partial window and the flag is what tells a downstream consumer
//     how much to trust the number. A calibration study that reads the ratio
//     without the flag would treat a ~2.4-year sample like ISRG's decade.
// RDDT's ads-cohort rotation needs nothing new — it reuses the shared
// cohort_rotation_pp column the v1.4 block already propagates (thresholds
// differ upstream: RDDT fires at -8pp, ISRG at -6pp, but the CSV carries the
// already-applied value). Same forward-compatibility pattern throughout:
// blanks/absent columns no-op, fields attach only when populated, so other
// holdings and pre-v8.4 history stay clean. Aggregation logic remains
// symbol-agnostic — RDDT stats accumulate from its first logged date forward,
// and IBIT's historical rows keep aggregating unchanged as closed history.

// v1.6 — MLM v8.5 context propagation (RDDT → MLM holdings swap; sync with
// log-signals V8.5.0, which appends 48 columns and migrates the header
// 186 → 234). As at v1.4/v1.5, the EXACT-width contract is DYNAMIC against the
// on-disk header (headers.length), so NO width constant changes here — the
// contract follows the migrated header automatically. Verified, not assumed:
// the only width references in this file are headers.length comparisons.
//
// ★★ THE IMPORTANT CHANGE IN v1.6 IS NOT A NEW FIELD — IT IS A PAIRED FLAG.
// The v1.2 block propagates cohort_premium_pct UNCONDITIONALLY for any holding
// whose row carries it. On MLM rows that value is roughly −50%, and it is an
// ACCOUNTING ARTIFACT: MLM's TTM window carries a large non-operating gain from
// the Quikrete asset exchange, so its trailing P/E (~12.9x against a ~26.8x
// forward) is meaningless and the cohort premium computed from it is a mirage.
// fetch v4.17 gates it, score-engine V8.4 scores it ZERO, and log-signals
// V8.5.0 persists the gate — but THIS file was still about to hand the raw
// number to accuracy.json with nothing recording that it is invalid.
//   Scope of the risk, stated precisely rather than overstated: calibration-
//   loader v1.3 renders only regime / regime_pmi / weights / scores / price /
//   role into the LLM prompt, so the artifact does NOT reach today's prompt.
//   The exposure is FUTURE — accuracy.json is the substrate for the calibration
//   curve, the proposal engine, and the telemetry-to-active-learning loop, and
//   a study reading cohort_premium_pct across history without the flag would
//   learn a relationship between "deep cohort discount" and forward returns
//   that does not exist. So v1.6 propagates premium_pct_reliable and
//   trailing_discount_artifact_suspected alongside it, on the same
//   travel-together principle already established for the
//   ps_pct_of_3y_avg / own_history_window_partial pair in v1.5.
//
// Yesterday-snapshot additionally propagates:
//   • federal_authorization_status + days_to_authorization_expiry +
//     state_dot_budget_trend — the V8.4 MLM weight-gate driver. NOTE this is
//     the first CATEGORICAL regime driver in this file: MA/ISRG/RDDT all gate
//     on a numeric factor spread (duopoly_vs_spy_pp / ihi_vs_spy_30d_pp /
//     xlc_vs_spy_30d_pp), whereas MLM gates on federal surface-transportation
//     authorization status. ⚠ "short_term_extension" is the BASE CASE, not a
//     downgrade — twelve extensions followed TEA-21 and ten followed
//     SAFETEA-LU. A calibration study must not read it as a negative regime.
//   • xlb_vs_spy_30d_pp — the materials factor overlay (tactical, not the gate)
//   • mix_adjusted_organic_pricing_pct — MLM's signature operational metric
//     (peer of crpo_growth_pct / cross_border_growth_pct / procedure_growth_pct
//     / ad_revenue_growth_yoy_pct). Aggregates have no exchange price, so
//     mix-adjusted organic pricing IS the local-monopoly test; below 1% is the
//     cleanest falsifier in the model.
//   • organic_volume_growth_pct + weather_impact_flag — propagated as a PAIR
//     and misleading apart, exactly like the ps_pct/own_history pair. Aggregates
//     is the most weather-contaminated quarterly print in the book; a negative
//     organic-volume reading with weather_impact_flag = "material_headwind" is
//     rain, not demand destruction, and the engine removes the penalty entirely.
//     A study that reads the volume number without the flag would attribute
//     weather to demand.
//   • reported_asp_signal_status — records WHY reported ASP is absent from
//     scoring during M&A integration (mix-contaminated: Q2'26 printed −2%
//     reported against +3.7% organic mix-adjusted).
//   • mlm_vs_vmc_pct + vmc_spread_30d_pp + vmc_dislocation_active — the TWIN
//     read (peer of MA's twin_premium_pct / twin_spread_30d_pp). Carried
//     separately from the cohort average because VMC is the only true
//     like-for-like US aggregates pure play.
//   • cash_gross_profit_per_ton — the industry's cleanest unit-economics measure
//   • forward_pe + forward_pe_consensus_basis, ev_ebitda + ev_ebitda_basis,
//     pro_forma_ev_ebitda + pro_forma_basis_consistent — each multiple travels
//     WITH its basis tag. A forward multiple compared against a trailing one
//     fabricates a re-rating; the basis is what tells a consumer which
//     comparison the stored number actually supports.
//   • lna_integration_state + pro_forma_net_leverage + delever_glidepath_status
//     — ⚠ leverage is scored on the GLIDEPATH, never the level. 3.7x at close
//     is the plan working as announced. Reading pro_forma_net_leverage without
//     delever_glidepath_status would score a successful deal as a risk event.
//   • roic_pct + roic_denominator_distorted — another travel-together pair.
//     TRUE means the capital base was inflated by acquisitions ahead of their
//     earnings, so roic_pct is not a quality read on that row.
//
// ⚠ CORRECTION TO THE v1.5 NOTE BELOW on share_count_change_yoy_pct. That
// column is NOT a special "positive = dilution" convention — it is simply the
// raw YoY % change in share count. RDDT happened to print POSITIVE (+2.8%,
// stock comp exceeding buyback); MLM prints NEGATIVE (−1.11%, a genuine
// buyback that satisfies the portfolio's criterion). Same column, same
// arithmetic, opposite observed sign — and it needs no new propagation code,
// since v1.5 already reads it. The genuinely distinct column is MA's
// buyback_share_reduction_yoy_pct, which measures a different quantity; THAT
// is the pair a consumer must not conflate.
//
// MLM's aggregates-cohort rotation needs nothing new — it reuses the shared
// cohort_rotation_pp column the v1.4 block already propagates (log-signals
// V8.5.0 folds fetch v4.17's peer_rotation_pp into that column). Thresholds
// differ upstream (MLM −5pp, RDDT −8pp, ISRG −6pp) and the CSV carries the
// already-applied value, so the ACTIVE flag compares cleanly across archetypes
// while the raw pp value does not. Same forward-compatibility pattern
// throughout: blanks/absent columns no-op, fields attach only when populated,
// so other holdings and pre-v8.5 history stay clean. Aggregation logic remains
// symbol-agnostic — MLM stats accumulate from its first logged date forward,
// and RDDT's historical rows keep aggregating unchanged as closed history.

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
//
// v1.4: Also propagates MA + ISRG v8.3 context (MA: twin_premium_pct,
// twin_spread_30d_pp, duopoly_vs_spy_pp, disruption_fear_regime,
// cross_border_growth_pct; ISRG: cohort_rotation_pp, ihi_vs_spy_30d_pp,
// procedure_growth_pct, moat_status, instrument_transition_status) when the
// CSV row carries those columns. Added by log-signals V8.3.0. Same pattern.
//
// v1.6: Also propagates MLM v8.5 context (the federal authorization regime
// triple, xlb_vs_spy_30d_pp, mix_adjusted_organic_pricing_pct, the
// organic_volume/weather PAIR, reported_asp_signal_status, the VMC twin read,
// cash_gross_profit_per_ton, each multiple WITH its basis tag, the LNA
// glidepath block, the roic/distortion PAIR, and — most importantly — the
// premium_pct_reliable / trailing_discount_artifact_suspected flags that make
// the already-propagated cohort_premium_pct interpretable on MLM rows).
// v1.5: Also propagates RDDT v8.4 context (xlc_vs_spy_30d_pp,
// ad_revenue_growth_yoy_pct, arpu_growth_yoy_pct, search_referral_status,
// licensing_status, competitive_threat, share_count_change_yoy_pct, and the
// ps_pct_of_3y_avg / own_history_window_partial pair) when the CSV row
// carries those columns. Added by log-signals V8.4.0. Same pattern. RDDT's
// rotation reuses the shared cohort_rotation_pp read above.
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
  // v1.5: booleans arrive from the CSV as the strings "true"/"false" (the
  // parser's isNaN guard leaves them alone), so neither numOrNull nor
  // strOrNull gives a usable value — strOrNull would hand downstream the
  // string "false", which is truthy. Anything unrecognized returns null
  // rather than guessing, so a malformed cell cannot silently read as false.
  const boolOrNull = (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
    return null;
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

    // v1.4: MA + ISRG v8.3 context — only attached when CSV cells are
    // populated (MA-only / ISRG-only in current builds). Pre-v8.3 CSV history
    // leaves these columns undefined, helpers no-op, other holdings stay
    // clean. ISRG's cohort premium arrives via the shared cohort_premium_pct
    // read above — nothing ISRG-specific needed for it.
    const twinPremium = numOrNull(row.twin_premium_pct);
    const twinSpread30d = numOrNull(row.twin_spread_30d_pp);
    const duopolyVsSpy = numOrNull(row.duopoly_vs_spy_pp);
    const fearRegime = strOrNull(row.disruption_fear_regime);
    const crossBorder = numOrNull(row.cross_border_growth_pct);

    if (twinPremium != null) holding.twin_premium_pct = twinPremium;
    if (twinSpread30d != null) holding.twin_spread_30d_pp = twinSpread30d;
    if (duopolyVsSpy != null) holding.duopoly_vs_spy_pp = duopolyVsSpy;
    if (fearRegime != null) holding.disruption_fear_regime = fearRegime;
    if (crossBorder != null) holding.cross_border_growth_pct = crossBorder;

    const cohortRotation = numOrNull(row.cohort_rotation_pp);
    const ihiVsSpy = numOrNull(row.ihi_vs_spy_30d_pp);
    const procedureGrowth = numOrNull(row.procedure_growth_pct);
    const moatStatus = strOrNull(row.moat_status);
    const transitionStatus = strOrNull(row.instrument_transition_status);

    if (cohortRotation != null) holding.cohort_rotation_pp = cohortRotation;
    if (ihiVsSpy != null) holding.ihi_vs_spy_30d_pp = ihiVsSpy;
    if (procedureGrowth != null) holding.procedure_growth_pct = procedureGrowth;
    if (moatStatus != null) holding.moat_status = moatStatus;
    if (transitionStatus != null) holding.instrument_transition_status = transitionStatus;

    // v1.5: RDDT v8.4 context — only attached when CSV cells are populated
    // (RDDT-only in current builds). Pre-v8.4 CSV history leaves these columns
    // undefined, helpers no-op, other holdings stay clean. RDDT's ads-cohort
    // rotation arrives via the shared cohort_rotation_pp read above — nothing
    // RDDT-specific needed for it.
    const xlcVsSpy = numOrNull(row.xlc_vs_spy_30d_pp);
    const adRevGrowth = numOrNull(row.ad_revenue_growth_yoy_pct);
    const arpuGrowth = numOrNull(row.arpu_growth_yoy_pct);
    const referralStatus = strOrNull(row.search_referral_status);
    const licensingStatus = strOrNull(row.licensing_status);
    const competitiveThreat = strOrNull(row.competitive_threat);
    const shareCountChange = numOrNull(row.share_count_change_yoy_pct);
    const psPctOfAvg = numOrNull(row.ps_pct_of_3y_avg);
    const ownHistPartial = boolOrNull(row.own_history_window_partial);

    if (xlcVsSpy != null) holding.xlc_vs_spy_30d_pp = xlcVsSpy;
    if (adRevGrowth != null) holding.ad_revenue_growth_yoy_pct = adRevGrowth;
    if (arpuGrowth != null) holding.arpu_growth_yoy_pct = arpuGrowth;
    if (referralStatus != null) holding.search_referral_status = referralStatus;
    if (licensingStatus != null) holding.licensing_status = licensingStatus;
    if (competitiveThreat != null) holding.competitive_threat = competitiveThreat;
    // ⚠ POSITIVE = DILUTION here. MA's buyback_share_reduction_yoy_pct uses the
    // opposite convention (negative = shares shrank). Never compare the two.
    if (shareCountChange != null) holding.share_count_change_yoy_pct = shareCountChange;
    // ps_pct_of_3y_avg and own_history_window_partial travel TOGETHER. The
    // ratio without the flag invites a consumer to treat RDDT's ~2.4-year
    // sample (listed March 2024) like ISRG's decade of multiple history.
    if (psPctOfAvg != null) holding.ps_pct_of_3y_avg = psPctOfAvg;
    if (ownHistPartial != null) holding.own_history_window_partial = ownHistPartial;

    // v1.6: MLM v8.5 context — only attached when CSV cells are populated
    // (MLM-only in current builds). Pre-v8.5 CSV history leaves these columns
    // undefined, helpers no-op, other holdings stay clean. MLM's aggregates
    // rotation arrives via the shared cohort_rotation_pp read above — nothing
    // MLM-specific needed for it.

    // ★★ THE PAIRED FLAGS FOR cohort_premium_pct. The v1.2 block above attaches
    // cohort_premium_pct unconditionally. On MLM rows that number is roughly
    // −50% and is an ACCOUNTING ARTIFACT (Quikrete divestiture gain inflating
    // TTM earnings, so the trailing P/E the premium is computed from is
    // meaningless). These two flags are what make the stored value
    // interpretable to any future calibration study. Without them accuracy.json
    // would teach a relationship between "deep cohort discount" and forward
    // returns that does not exist. Attach them BEFORE anything else MLM-ish so
    // the pairing is impossible to miss when reading this block.
    const premiumReliable = boolOrNull(row.premium_pct_reliable);
    const trailingArtifact = boolOrNull(row.trailing_discount_artifact_suspected);
    if (premiumReliable != null) holding.premium_pct_reliable = premiumReliable;
    if (trailingArtifact != null) holding.trailing_discount_artifact_suspected = trailingArtifact;

    // Public construction funding regime — the V8.4 MLM weight-gate driver, and
    // the first CATEGORICAL regime driver in this file (MA/ISRG/RDDT all gate on
    // a numeric factor spread). ⚠ "short_term_extension" is the BASE CASE, not
    // a downgrade: twelve extensions followed TEA-21 and ten followed
    // SAFETEA-LU. A study must not read it as a negative regime.
    const fedAuth = strOrNull(row.federal_authorization_status);
    const daysToExpiry = numOrNull(row.days_to_authorization_expiry);
    const dotTrend = strOrNull(row.state_dot_budget_trend);
    const xlbVsSpy = numOrNull(row.xlb_vs_spy_30d_pp);

    if (fedAuth != null) holding.federal_authorization_status = fedAuth;
    if (daysToExpiry != null) holding.days_to_authorization_expiry = daysToExpiry;
    if (dotTrend != null) holding.state_dot_budget_trend = dotTrend;
    if (xlbVsSpy != null) holding.xlb_vs_spy_30d_pp = xlbVsSpy;

    // MLM's signature operational metric. Aggregates have no exchange price, so
    // mix-adjusted organic pricing IS the local-monopoly test; below 1% is the
    // cleanest falsifier in the model.
    const mixAdjPricing = numOrNull(row.mix_adjusted_organic_pricing_pct);
    if (mixAdjPricing != null) holding.mix_adjusted_organic_pricing_pct = mixAdjPricing;

    // organic_volume_growth_pct and weather_impact_flag travel TOGETHER and are
    // misleading apart — the same pairing logic as ps_pct/own_history above.
    // Aggregates is the most weather-contaminated quarterly print in the book:
    // a negative organic-volume reading carrying "material_headwind" is RAIN,
    // not demand destruction, and the engine removes the penalty entirely. A
    // study reading the volume number alone would attribute weather to demand.
    const organicVolume = numOrNull(row.organic_volume_growth_pct);
    const weatherFlag = strOrNull(row.weather_impact_flag);
    if (organicVolume != null) holding.organic_volume_growth_pct = organicVolume;
    if (weatherFlag != null) holding.weather_impact_flag = weatherFlag;

    // Records WHY reported ASP is absent from scoring during M&A integration
    // (mix-contaminated: Q2'26 printed −2% reported vs +3.7% organic
    // mix-adjusted). The absence of a scored value is itself information.
    const reportedAspStatus = strOrNull(row.reported_asp_signal_status);
    if (reportedAspStatus != null) holding.reported_asp_signal_status = reportedAspStatus;

    // The TWIN read — peer of MA's twin_premium_pct / twin_spread_30d_pp.
    // Carried separately from the cohort average because VMC is the only true
    // like-for-like US aggregates pure play; averaging it away would destroy
    // this archetype's single most informative tactical input.
    // ⚠ mlm_vs_vmc_pct is computed from the SAME contaminated trailing basis as
    // cohort_premium_pct, so premium_pct_reliable gates this too.
    const mlmVsVmc = numOrNull(row.mlm_vs_vmc_pct);
    const vmcSpread30d = numOrNull(row.vmc_spread_30d_pp);
    const vmcDislocation = boolOrNull(row.vmc_dislocation_active);
    if (mlmVsVmc != null) holding.mlm_vs_vmc_pct = mlmVsVmc;
    if (vmcSpread30d != null) holding.vmc_spread_30d_pp = vmcSpread30d;
    if (vmcDislocation != null) holding.vmc_dislocation_active = vmcDislocation;

    const cashGpPerTon = numOrNull(row.cash_gross_profit_per_ton);
    if (cashGpPerTon != null) holding.cash_gross_profit_per_ton = cashGpPerTon;

    // Each multiple travels WITH its basis tag. Comparing a forward multiple
    // against a trailing one fabricates a re-rating; the basis is what tells a
    // consumer which comparison the stored number actually supports.
    const forwardPe = numOrNull(row.forward_pe);
    const forwardPeBasis = strOrNull(row.forward_pe_consensus_basis);
    const evEbitda = numOrNull(row.ev_ebitda);
    const evEbitdaBasis = strOrNull(row.ev_ebitda_basis);
    const proFormaEvEbitda = numOrNull(row.pro_forma_ev_ebitda);
    const proFormaBasisOk = boolOrNull(row.pro_forma_basis_consistent);

    if (forwardPe != null) holding.forward_pe = forwardPe;
    if (forwardPeBasis != null) holding.forward_pe_consensus_basis = forwardPeBasis;
    if (evEbitda != null) holding.ev_ebitda = evEbitda;
    if (evEbitdaBasis != null) holding.ev_ebitda_basis = evEbitdaBasis;
    if (proFormaEvEbitda != null) holding.pro_forma_ev_ebitda = proFormaEvEbitda;
    if (proFormaBasisOk != null) holding.pro_forma_basis_consistent = proFormaBasisOk;

    // ⚠ Leverage is scored on the GLIDEPATH, never the level — 3.7x at close is
    // the plan working as announced (target sub-2.5x within 24 months). Reading
    // pro_forma_net_leverage without delever_glidepath_status would score a
    // successful deal as a risk event.
    const lnaState = strOrNull(row.lna_integration_state);
    const proFormaLeverage = numOrNull(row.pro_forma_net_leverage);
    const glidepath = strOrNull(row.delever_glidepath_status);
    if (lnaState != null) holding.lna_integration_state = lnaState;
    if (proFormaLeverage != null) holding.pro_forma_net_leverage = proFormaLeverage;
    if (glidepath != null) holding.delever_glidepath_status = glidepath;

    // roic_pct and roic_denominator_distorted travel TOGETHER. TRUE means the
    // capital base was inflated by acquisitions ahead of their earnings, so
    // roic_pct is NOT a quality read on that row.
    const roic = numOrNull(row.roic_pct);
    const roicDistorted = boolOrNull(row.roic_denominator_distorted);
    if (roic != null) holding.roic_pct = roic;
    if (roicDistorted != null) holding.roic_denominator_distorted = roicDistorted;

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
