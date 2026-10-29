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

// ── V8.6.0 (October 2026): HOLDINGS SWAP telemetry — PBR.A out, UBER in
//   (fetch-market-data v4.19 / score-engine V8.5 / generate-signals v8.6.0 sync;
//   still 14 holdings).
//
//   REUSED columns (no new width — fetch v4.19's payload keys already match):
//   cohort_avg_pe + cohort_premium_pct, premium_pct_reliable (hard-gated FALSE
//   on every UBER row), cohort_avg_30d_return_pct, cohort_rotation_pp +
//   cohort_rotation_active (fetch emits peer_rotation_*, exactly as for MLM, and
//   the V8.5.0 either-key fold writes the shared columns; UBER fires at −6pp),
//   eps_revisions_30d/90d, share_count_change_yoy_pct (raw YoY change — UBER
//   prints NEGATIVE, −2.28%, a genuine net buyback), roic_pct, trailing_pe, and
//   regime / weight_* / regime_basis. score-engine V8.5 writes regime =
//   aggregating | contested | disintermediating and regime_basis =
//   "av_supply_regime_state". regime_driver stays BLANK on UBER rows: the gate
//   is categorical and has no numeric driver (MLM's is categorical too, but
//   carries days_to_authorization_expiry as a driver; UBER has no equivalent).
//
//   ★★ THREE INTERPRETIVE FLAGS — the most important columns in this append.
//   Each makes an EXISTING number readable on UBER rows. Without them the CSV
//   persists values that look like observations and are not.
//   • premium_unreliable_reason — pairs with the reused premium_pct_reliable.
//     cohort_premium_pct computes near −72% on UBER rows because BOTH legs are
//     GAAP trailing: UBER's TTM carries a $4.9B tax valuation-allowance release
//     plus ±$1.5B quarterly equity revaluations, and LYFT's ~2x P/E is a
//     tax-benefit artifact. The flag records THAT the number is invalid; the
//     reason records WHY. MLM's artifact (a divestiture gain) is a different
//     cause, and a study pooling gated rows needs to tell them apart.
//   • tax_release_in_ttm + gaap_pe_signal_status — label the trailing_pe column.
//     ⚠ CALENDAR TRAP: the tax release rolls out of the TTM window at the
//     2026-11-04 print, so UBER's trailing_pe roughly DOUBLES and
//     cohort_premium_pct jumps by tens of points overnight, with no change in
//     the business. tax_release_in_ttm flips true → false on exactly that row.
//     It is the column that tells a later reader the discontinuity is
//     accounting, not a re-rating.
//   • value_trap_gate_active — score-engine V8.5 FLOORS the blended strategic
//     score at 0 when the AV regime is disintermediating and the Mobility
//     canary is below 12% cc (or unknown). On a "true" row strategic_score is a
//     RULE OUTPUT, not a judgment, and a calibration study fitting strategic
//     scores to forward returns must be able to separate it. Written
//     "true"/"false" on every row of the av_supply_regime_state branch (keyed
//     off regime_basis, not the ticker) and BLANK elsewhere, so "gate clear" is
//     distinguishable from "gate not evaluated". This is the one new column fed
//     by an engine OUTPUT rather than the market payload.
//
//   NEW columns (53 appended: 234 → 287):
//   • Marketplace cohort PEs dash/lyft/grab_pe + uber_vs_dash_pct — all GAAP
//     trailing, record only, gated with the premium. uber_vs_dash_pct is NOT a
//     twin premium (contrast mlm_vs_vmc_pct): DASH is half the weighted cohort.
//   • uber_30d_return_pct and dash_spread_30d_pp. The DASH spread is CONTEXT
//     ONLY — the engine does not score it (contrast MLM's vmc_spread_30d_pp,
//     which it does).
//   • xly_vs_spy_30d_pp — the consumer factor overlay (GICS says Industrials;
//     the tape trades UBER as a consumer platform). Tactical, not the gate.
//   • The AV-headline-shock PRICE screen: worst_1d_return_5s_pct,
//     worst_1d_date, spy_same_day_return_pct, worst_1d_on_known_print,
//     av_shock_candidate_active. The candidate flag is the PRICE event only;
//     av_headline_shock_active (in the fundamentals block) is the LLM's
//     ATTRIBUTION. They are two columns on purpose — the gap between them is
//     what calibration needs to learn whether unattributed −4% days are AV
//     news or noise.
//     ⚠ The payload block is tactical_extras, which LIN (iv_rv_ratio,
//     spy_10d_drawdown_pct, lin_vs_spy_10d_pp) and TMO (tmo_30d_return_pct,
//     tmo_vs_dhr_30d_pp) also emit. The key sets are DISJOINT — verified
//     against fetch v4.19 output — so no existing column changes meaning: LIN's
//     columns stay blank on UBER rows and these stay blank on LIN/TMO rows.
//   • Config / regime state: av_supply_regime_state (THE regime driver,
//     human-maintained in fetch v4.19; ⚠ "leader_exiting_tail_aggregating" is
//     the BASE CASE — regime contested, scores zero, NOT a downgrade) and
//     dh_offer_state + dh_basis_scored ("standalone" until Delivery Hero
//     closes; when it flips, the multiples and leverage columns change basis
//     on that row — the same labelling job tax_release_in_ttm does).
//   • UBER fundamentals scaffolds (LLM-sourced; blank until populated): cc and
//     reported gross bookings, ★ mobility_gb_growth_cc_pct (THE canary) with
//     delivery_gb_growth_cc_pct beside it (the signature is the GAP — Mobility
//     below 12% WHILE Delivery holds), trips, MAPCs, Adj EBITDA $ and % of GB,
//     segment OI, driver incentive pressure, guide vs consensus.
//   • reported_revenue_growth_pct + business_model_drag_pp +
//     revenue_signal_status. ⚠ Deliberately NOT folded into the shared
//     revenue_growth_yoy_pct column (RDDT/MLM): UBER's reported revenue is a
//     null signal (business-model changes cut Q2'26 growth by 8pp), and
//     folding it in would hand a cross-sectional study a contaminated number
//     under a clean name.
//   • Multiples, each WITH its basis tag, and deliberately NOT folded into
//     MLM's forward_pe / ev_ebitda columns: forward_pe_non_gaap +
//     non_gaap_eps_sbc_treatment, ev_adj_ebitda + ev_adj_ebitda_basis,
//     ev_adj_ebitda_less_sbc, ev_gaap_ebitda. On the same ~$140B EV these span
//     ~13.9x / ~17.3x / ~18.7x — five turns of basis, not of valuation.
//   • Owner FCF: fcf_ttm_busd, sbc_ttm_busd, owner_fcf_yield_pct (after SBC,
//     ~6.1% — not the ~7.5% headline).
//   • AV supply detail: tier1_operators_direct_only / _on_uber (counts),
//     exclusive_pipeline_status, av_headline_shock_active.
//   • Delivery Hero: dh_acceptance_pct, gross_leverage (scored against the
//     stated <2x gross ceiling, never the level).
//   • buyback_pace (context only — UBER is scored on NET share count) and
//     insider_buying_recent.
//   • roic_gaap_inflated — pairs with the reused roic_pct. ⚠ NOT the same flag
//     as MLM's roic_denominator_distorted: MLM's DENOMINATOR is inflated by
//     acquisitions; UBER's NUMERATOR is inflated by the tax release. Both mean
//     "roic_pct on this row is not a quality read", for opposite reasons.
//   Every LLM-sourced UBER value is written through esc(), numbers and
//   booleans included. esc() is the identity on a value with no comma or
//   quote, so this costs nothing on well-typed input; it means a model that
//   returns "1,234" or a two-item list can no longer shift the row width.
//
//   • NO PBR.A columns are removed — none were ever added. PBR.A's only
//     specific inputs were the wti / brl_usd MACRO columns, which every row
//     carries and which fetch v4.19 keeps fetching (decision 2026-10-27).
//     PBR.A's historical rows remain valid closed history.
//
//   JSONL: the cohort_valuation / cohort_relative mappers gain the UBER keys,
//   unreliable_reason, and cohort_count. cohort_count was emitted by every
//   cohort holding's fetch block but never mapped, so it now populates on
//   LHX/MSFT/NOW/ISRG/MLM rows too — the one change visible on non-UBER
//   entries, and purely additive. The factor flow, the shock screen and the
//   fundamentals are flat keys. strategic.value_trap_gate_active sits beside
//   the blended score it clips. Every pre-existing key and value is unchanged.
//
//   DEPLOY ORDERING — as V8.5.0 established, and RE-TESTED at this width:
//   genuine signal-accuracy v1.6 reading a post-migration 287-wide file skips
//   ZERO rows (its width contract is headers.length off disk, and
//   migrateCsvHeader() rewrites the header before any row is appended). An
//   unpaired deploy therefore loses only the UBER context in accuracy.json's
//   yesterday-snapshot until v1.7 lands. Ship the pair together anyway.
//   ⚠ WHAT THIS FILE CANNOT SURVIVE is a NON-PREFIX header — e.g. a parallel
//   build that also appends to the 234-wide V8.5.0 base, deployed after this
//   one has run. migrateCsvHeader() then refuses (correctly), warns, and the
//   append below still runs at the code's width: signal-accuracy skips those
//   rows, or misparses them by position if the widths happen to coincide. The
//   warning's advice — run rebuild-signals-csv.mjs — is the repair, and as of
//   rebuild-signals-csv v2.0 it works again: the file on main had been a
//   misfiled copy of claire-summary since 2026-07-07 (a80251d), and v2.0 also
//   reads this file's CSV_HEADERS at run time instead of carrying its own copy,
//   so it rebuilds at exactly this width (verified cell-for-cell against this
//   file's own output; only the six never-logged columns come back blank).
//   Still: every schema change to this file should build on the CURRENT
//   deployed header, so the repair is never needed.

// ── V8.7.0 (October 2026): HOLDINGS SWAP telemetry — ENB out, CVX in
//   (fetch-market-data v4.20 / score-engine V8.6 / generate-signals v8.7.0 sync;
//   still 14 holdings). BUILT ON V8.6.0 (PBR.A → UBER) — both swaps live in this
//   file, and the CVX columns append AFTER the 287 V8.6.0 columns, so the header
//   stays a strict prefix chain 234 → 287 → 341. Deploy this file INSTEAD of
//   V8.6.0; whichever of the two has already run, migrateCsvHeader() takes the
//   on-disk header forward as a pure append.
//
//   REUSED columns (no new width — fetch v4.20's payload keys already match):
//   trailing_pe, dividend_yield, roce_pct + operating_margin_pct (Finnhub
//   generic), eps_revisions_30d/90d, share_count_change_yoy_pct (raw YoY change
//   in period-end count), gaap_pe_signal_status (UBER's column; CVX writes
//   "null_signal_cycle_contaminated"), twin_premium_pct + twin_daily_spread_pp
//   (MA's columns, fed from twin_valuation.premium_pct / twin_relative.
//   relative_spread_pp — on CVX rows they read CVX vs XOM), and regime /
//   weight_* / regime_driver / regime_basis. score-engine V8.6 writes regime =
//   anchored | transitional_high|low | dislocated_high|low, regime_driver = the
//   NUMERIC deviation of spot Brent from the $70 deck (%), and regime_basis =
//   "brent_vs_70_deck_pct" — the first price-level driver in this schema.
//
//   ⚠ TWO EXISTING ROW EXPRESSIONS GAIN A FALLBACK KEY — the V8.5.0 either-key
//   fold pattern, not a new column:
//     premium_pct_reliable       ← cohort_valuation.premium_pct_reliable
//                                  ?? twin_valuation.premium_pct_reliable
//     premium_unreliable_reason  ← cohort_valuation.unreliable_reason
//                                  ?? twin_valuation.unreliable_reason
//   CVX has a TWIN block, not a cohort block, and fetch v4.20 hard-gates the
//   twin premium (premium_pct_reliable = false, reason
//   "trailing_gaap_windfall_and_hess_dda_step_up"). Without the fold the CVX row
//   would persist twin_premium_pct ≈ −5% with NOTHING recording that it is
//   invalid — the exact failure the V8.5.0 flags exist to prevent. On a CVX row
//   the pair therefore qualifies twin_premium_pct (cohort_premium_pct is blank);
//   on MLM/UBER rows it still qualifies cohort_premium_pct. Read whichever
//   premium is populated. No other holding carries either key in a twin block
//   (MA's twin_valuation is ma_pe / v_pe / premium_pct only), so every non-CVX
//   row is byte-identical — verified.
//
//   ★★ FIVE INTERPRETIVE FLAGS — as at V8.5.0/V8.6.0, the most important
//   columns in this append. Each makes an EXISTING number readable on CVX rows.
//   • cycle_gate_active + cycle_gate_side — score-engine V8.6 Guardrail (e). With
//     Brent more than 40% above the deck (> $98) the BLENDED strategic score is
//     FLOORED at 0 ("no_buy") unless normalized FCF yield is ≥ 6% on a FULL
//     normalization; more than 40% below (< $42) it is CAPPED at 0 ("no_trim")
//     unless that yield is < 4%. On a "true" row strategic_score is
//     RULE-BOUNDED, not a judgment. ⚠ The engine's normalization inputs are
//     LLM-sourced and null in its data, so the gate FAILS CLOSED — while Brent
//     sits above $98 EVERY CVX row reads true / no_buy. That is the designed
//     behaviour, and exactly why a calibration study must be able to see it.
//     Written "true"/"false" on every row of the brent_vs_70_deck_pct branch
//     (keyed off regime_basis, not the ticker) and BLANK elsewhere, so "gate
//     clear" ≠ "gate not evaluated". Second engine-OUTPUT column after UBER's
//     value_trap_gate_active.
//   • q3_2025_in_ttm — labels trailing_pe. ⚠ CALENDAR TRAP: Q3'25 ($1.82 GAAP
//     EPS on $69 Brent) rolls out of the TTM at the 2026-10-30 print and
//     trailing_pe falls ~22x → ~17x overnight with no change in the business.
//     fetch v4.20 flips it true → false once Q3'26 counts as reported. Same
//     labelling job as UBER's tax_release_in_ttm, for a different event.
//   • revisions_signal_status — labels eps_revisions_*. "commodity_driven"
//     whenever the oil regime is not ANCHORED: the revisions track the strip,
//     not execution, and the engine does not score them.
//   • roce_spot_inflated — labels the reused roce_pct (windfall oil).
//   • share_count_base_clean — labels the reused share_count_change_yoy_pct.
//     ⚠ HESS ANNIVERSARY: any YoY window crossing the 2025-07-18 close shows
//     ~+14% mechanical "dilution" (~301M shares issued). FALSE = do not read
//     the number as dilution or buyback. Date-derived upstream.
//
//   NEW columns (54 appended: 287 → 341):
//   • xom_pe + european_ref_avg_pe — the twin leg (GATED with the premium) and
//     the SHEL/TTE structural-discount REFERENCE (never a premium to score).
//   • cvx_30d_return_pct, xom_30d_return_pct, xom_spread_30d_pp and
//     xom_dislocation_active — THE signature tactical setup (CVX lagging XOM by
//     more than 4pp over 30 days). Deliberately NOT folded into MA's
//     twin_spread_30d_pp / twin_dislocation_active (MLM's VMC precedent).
//     european_avg_30d_return_pct is context only.
//   ⚠ COLUMN RENAMED VS ITS PAYLOAD KEY — the second deliberate mismatch here
//     (after MLM's lna_integration_state):
//       payload  md.cohort_relative.twin_dislocation_active
//       column   xom_dislocation_active
//     twin_dislocation_active is ALREADY MA's column (fed from
//     duopoly_relative), so the CVX column is named for the twin it tracks. The
//     JSONL keeps the payload key so the two artifacts stay traceable.
//   • xle_vs_spy_30d_pp — the energy factor overlay (spread only, as for
//     xlb/xly/ihi/igv).
//   • The geopolitical AIR-POCKET screen (payload block tactical_extras — the
//     key set is DISJOINT from LIN's, TMO's and UBER's, verified against fetch
//     v4.20 output): largest_1d_move_5s_pct, largest_1d_date,
//     xle_same_day_return_pct, idiosyncratic_pp, largest_1d_on_known_print,
//     air_pocket_candidate_active. The candidate flag is the PRICE event only;
//     classifying the headline (disruption duration vs a Chevron asset) is the
//     LLM's job and is not in the market payload.
//   • The oil regime itself: brent_spot + brent_spot_stale (FRED/EIA, ~1-week
//     lag), henry_hub_spot. The deviation is already regime_driver.
//   • Deck-normalization inputs fetch v4.20 computes: brent_ttm_avg and
//     henry_hub_ttm_avg (equal-weighted quarterly means over 4 REPORTED
//     quarters; Henry Hub is the daily spot as a bid-week proxy) and
//     market_cap_busd. With adj_fcf_ttm_busd and downstream_earnings_ttm_busd
//     below, these are the five numbers the normalized FCF yield is computed
//     from — kept so it can be recomputed for any row:
//       normalized FCF = adj FCF − (Brent TTM − 70)×0.60 − (HH TTM − 3.50)×0.70
//                        − (downstream TTM − 3.0)
//   • The four labels above plus forward_pe_signal_status ("spot_contaminated"
//     unless anchored).
//   • CVX fundamentals scaffolds (LLM-sourced; blank until populated): TTM
//     adjusted FCF, TTM downstream earnings + crack_environment, TTM CFFO ex-WC,
//     TTM capex + capex_vs_guide, last-quarter timing effects and working
//     capital + quarterly_eps_signal_status, production + production_vs_guide
//     (⚠ production_growth_yoy_pct is CONTEXT ONLY — Hess anniversary), ★
//     tco_canary_status (THE operational canary) with cpc_export_status beside
//     it (⚠ "CPC" = the Caspian Pipeline Consortium, never Chevron Phillips
//     Chemical), guyana_status, the next-quarter buyback guide range + trend,
//     TTM buybacks + buyback_vs_range, forward_pe_consensus (⚠ SPOT — never
//     scored; deliberately NOT folded into MLM's forward_pe), xom_fwd_pe,
//     breakeven_status, net_debt_ratio_pct and
//     net_debt_ratio_ex_deconsolidation_pct with hesm_deconsolidation_state
//     between them (⚠ the HESM exit removes ~$3.7B of debt with no cash
//     generated — the ex-deconsolidation figure is the read), and
//     insider_net_selling_90d.
//   Every LLM-sourced CVX value is written through esc(), numbers and booleans
//   included — the V8.6.0 rule.
//
//   • NO ENB columns are removed — none were ever added. ENB's only specific
//     inputs were dividend_yield and us10y, which every row carries. ENB's
//     historical rows remain valid closed history.
//
//   JSONL: twin_valuation gains the CVX keys incl. premium_pct_reliable +
//   unreliable_reason (the mapper previously kept only ma_pe / v_pe /
//   premium_pct — without this the CVX premium would land in daily-log with no
//   gate beside it); twin_relative gains cvx/xom_change_pct + xom_price;
//   cohort_relative gains the CVX twin/European keys (payload names); a new
//   oil_regime object carries fetch v4.20's block whole; the factor flow, the
//   air-pocket screen and the fundamentals are flat keys; and
//   strategic.cycle_gate_active / cycle_gate_side sit beside the blended score
//   they bound. Every pre-existing key and value is unchanged — the additions
//   read null on non-CVX entries.
//
//   DEPLOY ORDERING — unchanged from V8.6.0, re-tested at this width: genuine
//   signal-accuracy v1.7 (and v1.6) reading a post-migration 341-wide file skips
//   ZERO rows. An unpaired deploy loses only the CVX context in accuracy.json's
//   yesterday-snapshot until v1.8 lands. Ship the pair together anyway. The
//   V8.6.0 warning stands: never deploy a log-signals built on the 234-wide base
//   after this one runs. If a non-prefix header ever does land, the repair is
//   rebuild-signals-csv v2.1, which knows the CVX columns' JSONL paths.

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


// ── V8.6.0: UBER value-trap gate state (score-engine V8.5, Guardrail E).
// The gate is an engine OUTPUT, so it is read from the scored holding, not the
// market payload: blendScores() sets strategic.value_trap_gate_active = true
// ONLY when it floored the blended strategic score at 0, and omits the key
// otherwise. Absence therefore means "clear" — but only on a holding the
// gate is evaluated for. Returns:
//   true  — gate active; strategic_score on this row is a RULE OUTPUT
//   false — gate evaluated and clear
//   null  — gate not evaluated for this holding (every non-UBER archetype)
// Keyed off regime_basis rather than the ticker, so it follows the engine
// branch if the symbol ever changes and needs no edit on a future swap.
function valueTrapGateState(s) {
  if (resolveRegime(s).regime_basis !== "av_supply_regime_state") return null;
  return s.strategic?.value_trap_gate_active === true;
}

// ── V8.7.0: CVX cycle-position gate state (score-engine V8.6, Guardrail E).
// An engine OUTPUT, read from the scored holding like valueTrapGateState():
// blendScores() sets strategic.cycle_gate_active = true and cycle_gate_side =
// "no_buy" | "no_trim" ONLY when the gate bounded the blended strategic score,
// and omits both keys otherwise. Returns { active, side }:
//   active true  — gate in force; strategic_score on this row is RULE-BOUNDED
//                  (floored at 0 for no_buy, capped at 0 for no_trim)
//   active false — gate evaluated and clear (side null)
//   active null  — not evaluated for this holding (every non-CVX archetype)
// Keyed off regime_basis rather than the ticker, as valueTrapGateState() is.
function cycleGateState(s) {
  if (resolveRegime(s).regime_basis !== "brent_vs_70_deck_pct") return { active: null, side: null };
  const active = s.strategic?.cycle_gate_active === true;
  return { active, side: active ? (s.strategic.cycle_gate_side ?? null) : null };
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

  // ─── V8.6.0 UBER additions (appended for CSV back-compat; UBER row only) ───
  // Marketplace cohort PEs. cohort avg + premium REUSE cohort_avg_pe /
  // cohort_premium_pct, and the gate REUSES premium_pct_reliable (fetch v4.19
  // hard-gates it FALSE on every UBER row). All four are GAAP trailing — record
  // only. uber_vs_dash_pct is NOT a twin premium (contrast mlm_vs_vmc_pct):
  // DASH is half the weighted cohort, not a like-for-like twin.
  "dash_pe", "lyft_pe", "grab_pe", "uber_vs_dash_pct",
  // ★★ WHY premium_pct_reliable is false on this row. MLM's artifact was a
  // divestiture gain; UBER's is a tax valuation-allowance release plus equity
  // revaluations on its own leg AND LYFT's tax-benefit P/E on the peer leg.
  // A study pooling gated rows across holdings needs to tell the causes apart.
  "premium_unreliable_reason",
  // Marketplace rotation. cohort_avg_30d_return_pct + cohort_rotation_pp +
  // cohort_rotation_active are REUSED (fetch v4.19 emits peer_rotation_* — the
  // V8.5.0 either-key fold writes the shared columns; UBER fires at −6pp).
  // ⚠ dash_spread_30d_pp is CONTEXT ONLY — the engine does not score it.
  "uber_30d_return_pct", "dash_spread_30d_pp",
  // Consumer factor overlay (GICS says Industrials; the tape trades UBER as a
  // consumer platform). Tactical overlay, NOT the regime gate.
  "xly_vs_spy_30d_pp",
  // ── AV-headline-shock PRICE screen (payload block tactical_extras) ──
  // ⚠ tactical_extras is shared with LIN and TMO; the key sets are DISJOINT,
  // so LIN's iv_rv_ratio / spy_10d_drawdown_pct / lin_vs_spy_10d_pp columns
  // stay blank on UBER rows and these stay blank on LIN/TMO rows.
  // av_shock_candidate_active is the PRICE event only (worst session in 5,
  // ≤ −4%, Uber print day excluded). ATTRIBUTION is av_headline_shock_active,
  // further down — keep the two apart; the gap between them is the lesson.
  "worst_1d_return_5s_pct", "worst_1d_date", "spy_same_day_return_pct",
  "worst_1d_on_known_print", "av_shock_candidate_active",
  // ── Config / regime state (fetch v4.19 human-maintained constants) ──
  // av_supply_regime_state is THE regime driver (V8.5 UBER weight gate; maps
  // to the reused regime column). ⚠ "leader_exiting_tail_aggregating" is the
  // BASE CASE — regime contested, scores zero, NOT a downgrade.
  // dh_basis_scored reads "standalone" until Delivery Hero closes; when it
  // flips, the multiples and leverage columns change basis ON THAT ROW.
  "av_supply_regime_state", "dh_offer_state", "dh_basis_scored",
  // ★★ The trailing_pe column's interpretive pair on UBER rows.
  // ⚠ CALENDAR TRAP: the $4.9B tax release rolls out of the TTM window at the
  // 2026-11-04 print — trailing_pe roughly DOUBLES and cohort_premium_pct jumps
  // with no change in the business. tax_release_in_ttm flips true → false on
  // exactly that row: it is what labels the discontinuity as accounting.
  "tax_release_in_ttm", "gaap_pe_signal_status",
  // ★★ score-engine V8.5 FLOORS the blended strategic score at 0 when the AV
  // regime is disintermediating and the Mobility canary is <12% cc (or
  // unknown). On a "true" row, strategic_score is a RULE OUTPUT, not a
  // judgment — calibration must be able to separate it. "true"/"false" on the
  // av_supply_regime_state branch (keyed off regime_basis, not the ticker);
  // BLANK elsewhere, so "gate clear" ≠ "gate not evaluated".
  "value_trap_gate_active",
  // ── UBER fundamentals scaffolds (LLM-sourced; blank until populated) ──
  // ★ mobility_gb_growth_cc_pct is THE canary. It travels with
  // delivery_gb_growth_cc_pct because the signature is the GAP: Mobility below
  // 12% WHILE Delivery holds = AV disintermediation; both slowing = cycle.
  "gross_bookings_growth_cc_pct", "gross_bookings_growth_reported_pct",
  "mobility_gb_growth_cc_pct", "delivery_gb_growth_cc_pct",
  "trips_growth_pct", "mapcs_millions", "mapcs_growth_pct",
  "adj_ebitda_musd", "adj_ebitda_pct_gb",
  "mobility_segment_oi_growth_pct", "delivery_segment_oi_growth_pct",
  "driver_incentive_pressure",
  // ⚠ reported_revenue_* are CONTEXT ONLY while revenue_signal_status reads
  // "null_signal_business_model_contaminated" (Q2'26: business-model changes
  // cut growth by 8pp). Deliberately NOT folded into the shared
  // revenue_growth_yoy_pct column — that would hand a cross-sectional study a
  // contaminated number under a clean name.
  "reported_revenue_growth_pct", "business_model_drag_pp", "revenue_signal_status",
  "guide_vs_consensus",
  // ⚠ Every multiple carries its BASIS tag, and none is folded into MLM's
  // forward_pe / ev_ebitda columns. On the same ~$140B EV: Adj EBITDA (SBC
  // excluded) ~13.9x, Adj less SBC ~17.3x, GAAP ~18.7x — five turns of basis.
  "forward_pe_non_gaap", "non_gaap_eps_sbc_treatment",
  "ev_adj_ebitda", "ev_adj_ebitda_basis", "ev_adj_ebitda_less_sbc", "ev_gaap_ebitda",
  // Owner FCF — the flagship strategic lens: FCF less SBC (~6.1%, not ~7.5%).
  "fcf_ttm_busd", "sbc_ttm_busd", "owner_fcf_yield_pct",
  // AV supply detail (counts + categoricals) and the LLM's shock attribution.
  "tier1_operators_direct_only", "tier1_operators_on_uber",
  "exclusive_pipeline_status", "av_headline_shock_active",
  // Delivery Hero — PENDING. Leverage is scored against the stated <2x gross
  // ceiling, never the level.
  "dh_acceptance_pct", "gross_leverage",
  // buyback_pace is CONTEXT ONLY — UBER is scored on the reused NET
  // share_count_change_yoy_pct, never gross dollars.
  "buyback_pace", "insider_buying_recent",
  // ⚠ Pairs with the reused roic_pct — and is NOT MLM's
  // roic_denominator_distorted. MLM's DENOMINATOR is inflated by acquisitions;
  // UBER's NUMERATOR is inflated by the tax release. Both mean "roic_pct on
  // this row is not a quality read", for opposite reasons.
  "roic_gaap_inflated",
  // ─── V8.7.0 CVX additions (appended for CSV back-compat; CVX row only) ───
  // The twin leg (GATED — the reused premium_pct_reliable / premium_unreliable_
  // reason pair now folds twin_valuation's keys, so on CVX rows it qualifies
  // the reused twin_premium_pct) and the SHEL/TTE structural-discount
  // REFERENCE — never a premium to score.
  "xom_pe", "european_ref_avg_pe",
  // ★ THE signature tactical setup — CVX lagging XOM by >4pp over 30d. NOT
  // folded into MA's twin columns (MLM/VMC precedent).
  // ⚠ xom_dislocation_active is fed from payload key
  // cohort_relative.twin_dislocation_active — renamed because
  // twin_dislocation_active is already MA's column.
  "cvx_30d_return_pct", "xom_30d_return_pct", "xom_spread_30d_pp", "xom_dislocation_active",
  "european_avg_30d_return_pct",
  // Energy factor overlay — spread only, as for xlb/xly/ihi/igv.
  "xle_vs_spy_30d_pp",
  // ── Geopolitical AIR-POCKET screen (payload block tactical_extras) ──
  // ⚠ Key set DISJOINT from LIN's, TMO's and UBER's. The candidate flag is the
  // PRICE event only (|move| ≥ 4% in 5 sessions, the 2026-10-30 print day
  // excluded); classifying the headline is the LLM's job.
  "largest_1d_move_5s_pct", "largest_1d_date", "xle_same_day_return_pct",
  "idiosyncratic_pp", "largest_1d_on_known_print", "air_pocket_candidate_active",
  // ── The oil regime vs Chevron's $70 deck. The deviation itself is the reused
  // regime_driver; regime_basis reads "brent_vs_70_deck_pct".
  "brent_spot", "brent_spot_stale", "henry_hub_spot",
  // Deck-normalization inputs fetch v4.20 computes (4 REPORTED quarters).
  // With adj_fcf_ttm_busd + downstream_earnings_ttm_busd below, these five
  // numbers recompute the normalized FCF yield for any row.
  "brent_ttm_avg", "henry_hub_ttm_avg", "market_cap_busd",
  // ★★ Labels for REUSED columns on CVX rows:
  //   q3_2025_in_ttm          → trailing_pe (⚠ CALENDAR TRAP: flips at the
  //                             2026-10-30 print, trailing P/E ~22x → ~17x)
  //   forward_pe_signal_status → forward_pe_consensus below ("spot_contaminated")
  //   revisions_signal_status → eps_revisions_* ("commodity_driven" = not scored)
  //   roce_spot_inflated      → roce_pct (windfall oil)
  //   share_count_base_clean  → share_count_change_yoy_pct (⚠ HESS ANNIVERSARY:
  //                             FALSE = the YoY window crosses 2025-07-18)
  "q3_2025_in_ttm", "forward_pe_signal_status", "revisions_signal_status",
  "roce_spot_inflated", "share_count_base_clean",
  // ★★ score-engine V8.6 Guardrail (e). "true" = the BLENDED strategic score was
  // bounded by rule — floored at 0 (side no_buy, Brent > $98) or capped at 0
  // (side no_trim, Brent < $42). ⚠ Fails CLOSED: the engine's normalization
  // inputs are LLM-sourced, so every CVX row reads true/no_buy while Brent sits
  // above $98. "true"/"false" on the brent_vs_70_deck_pct branch (keyed off
  // regime_basis, not the ticker); BLANK elsewhere.
  "cycle_gate_active", "cycle_gate_side",
  // ── CVX fundamentals scaffolds (LLM-sourced; blank until populated) ──
  // Normalization numerator inputs + the crack read behind the downstream leg.
  "adj_fcf_ttm_busd", "downstream_earnings_ttm_busd", "crack_environment",
  // ⚠ Guardrail (b): single-quarter EPS and headline CFFO are NULL SIGNALS while
  // timing effects / working capital are material — TTM ex-WC is the read.
  "cffo_ex_wc_ttm_busd", "capex_ttm_busd", "capex_vs_guide",
  "timing_effects_last_q_busd", "working_capital_last_q_busd", "quarterly_eps_signal_status",
  // Scored vs the FY26 3,980–4,100 MBOED guide. ⚠ production_growth_yoy_pct is
  // CONTEXT ONLY — the Hess anniversary collapses it mechanically at Q3'26.
  "production_mboed", "production_vs_guide", "production_growth_yoy_pct",
  // ★ THE operational canary (TCO ≈ $6B Chevron-share FCF at $70, one export
  // pipeline). ⚠ CPC = the Caspian Pipeline Consortium, NOT Chevron Phillips
  // Chemical.
  "tco_canary_status", "cpc_export_status", "guyana_status",
  // Whether the windfall reaches shareholders — the post-print read.
  "next_q_buyback_guide_low_busd", "next_q_buyback_guide_high_busd", "buyback_guide_trend",
  "buyback_ttm_busd", "buyback_vs_range",
  // ⚠ forward_pe_consensus is SPOT-contaminated (reported, never scored) and
  // deliberately NOT folded into MLM's forward_pe.
  "forward_pe_consensus", "xom_fwd_pe", "breakeven_status",
  // ⚠ Guardrail (d): the HESM exit removes ~$3.7B of debt with no cash
  // generated — the ex-deconsolidation ratio is the read.
  "net_debt_ratio_pct", "hesm_deconsolidation_state", "net_debt_ratio_ex_deconsolidation_pct",
  "insider_net_selling_90d",
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
    // V8.7.0: either-key fold — CVX carries the flag in its TWIN block (no
    // cohort block), so on CVX rows this qualifies twin_premium_pct.
    md.cohort_valuation?.premium_pct_reliable ?? md.twin_valuation?.premium_pct_reliable ?? "",
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

    // ─── V8.6.0 UBER additions (only UBER row populates these) ────────────
    md.cohort_valuation?.dash_pe ?? "",
    md.cohort_valuation?.lyft_pe ?? "",
    md.cohort_valuation?.grab_pe ?? "",
    md.cohort_valuation?.uber_vs_dash_pct ?? "",
    // Pairs with premium_pct_reliable above (already written for UBER rows by
    // the V8.5.0 column — fetch v4.19 emits the same key).
    // V8.7.0: same either-key fold as premium_pct_reliable (CVX: twin block).
    esc(md.cohort_valuation?.unreliable_reason ?? md.twin_valuation?.unreliable_reason ?? ""),
    md.cohort_relative?.uber_30d_return_pct ?? "",
    md.cohort_relative?.dash_spread_30d_pp ?? "",
    md.factor_flow?.xly_vs_spy_30d_pp ?? "",
    md.tactical_extras?.worst_1d_return_5s_pct ?? "",
    esc(md.tactical_extras?.worst_1d_date ?? ""),
    md.tactical_extras?.spy_same_day_return_pct ?? "",
    md.tactical_extras?.worst_1d_on_known_print ?? "",
    md.tactical_extras?.av_shock_candidate_active ?? "",
    esc(md.fundamentals?.av_supply_regime_state ?? ""),
    esc(md.fundamentals?.dh_offer_state ?? ""),
    esc(md.fundamentals?.dh_basis_scored ?? ""),
    md.fundamentals?.tax_release_in_ttm ?? "",
    esc(md.fundamentals?.gaap_pe_signal_status ?? ""),
    // Engine OUTPUT, not a payload field — read from the blended strategic
    // object generate-signals v8.6.0 passes through from blendScores().
    valueTrapGateState(s) ?? "",
    // ── LLM-sourced scaffolds: EVERY value goes through esc(), numbers and
    // booleans included. esc() is the identity on a value with no comma or
    // quote, so this costs nothing on well-typed input — and a model that
    // writes "1,234" or "yes, CEO ~$10M" can no longer shift the row width.
    esc(md.fundamentals?.gross_bookings_growth_cc_pct ?? ""),
    esc(md.fundamentals?.gross_bookings_growth_reported_pct ?? ""),
    esc(md.fundamentals?.mobility_gb_growth_cc_pct ?? ""),
    esc(md.fundamentals?.delivery_gb_growth_cc_pct ?? ""),
    esc(md.fundamentals?.trips_growth_pct ?? ""),
    esc(md.fundamentals?.mapcs_millions ?? ""),
    esc(md.fundamentals?.mapcs_growth_pct ?? ""),
    esc(md.fundamentals?.adj_ebitda_musd ?? ""),
    esc(md.fundamentals?.adj_ebitda_pct_gb ?? ""),
    esc(md.fundamentals?.mobility_segment_oi_growth_pct ?? ""),
    esc(md.fundamentals?.delivery_segment_oi_growth_pct ?? ""),
    esc(md.fundamentals?.driver_incentive_pressure ?? ""),
    esc(md.fundamentals?.reported_revenue_growth_pct ?? ""),
    esc(md.fundamentals?.business_model_drag_pp ?? ""),
    esc(md.fundamentals?.revenue_signal_status ?? ""),
    esc(md.fundamentals?.guide_vs_consensus ?? ""),
    esc(md.fundamentals?.forward_pe_non_gaap ?? ""),
    esc(md.fundamentals?.non_gaap_eps_sbc_treatment ?? ""),
    esc(md.fundamentals?.ev_adj_ebitda ?? ""),
    esc(md.fundamentals?.ev_adj_ebitda_basis ?? ""),
    esc(md.fundamentals?.ev_adj_ebitda_less_sbc ?? ""),
    esc(md.fundamentals?.ev_gaap_ebitda ?? ""),
    esc(md.fundamentals?.fcf_ttm_busd ?? ""),
    esc(md.fundamentals?.sbc_ttm_busd ?? ""),
    esc(md.fundamentals?.owner_fcf_yield_pct ?? ""),
    esc(md.fundamentals?.tier1_operators_direct_only ?? ""),
    esc(md.fundamentals?.tier1_operators_on_uber ?? ""),
    esc(md.fundamentals?.exclusive_pipeline_status ?? ""),
    esc(md.fundamentals?.av_headline_shock_active ?? ""),
    esc(md.fundamentals?.dh_acceptance_pct ?? ""),
    esc(md.fundamentals?.gross_leverage ?? ""),
    esc(md.fundamentals?.buyback_pace ?? ""),
    esc(md.fundamentals?.insider_buying_recent ?? ""),
    esc(md.fundamentals?.roic_gaap_inflated ?? ""),
    // ─── V8.7.0 CVX additions (only CVX row populates these) ─────────────
    md.twin_valuation?.xom_pe ?? "",
    md.twin_valuation?.reference_european_avg_pe ?? "",
    md.cohort_relative?.cvx_30d_return_pct ?? "",
    md.cohort_relative?.xom_30d_return_pct ?? "",
    md.cohort_relative?.xom_spread_30d_pp ?? "",
    // ⚠ Column xom_dislocation_active is fed from the PAYLOAD key
    // twin_dislocation_active — deliberate rename, see the schema note above.
    md.cohort_relative?.twin_dislocation_active ?? "",
    md.cohort_relative?.european_avg_30d_return_pct ?? "",
    md.factor_flow?.xle_vs_spy_30d_pp ?? "",
    md.tactical_extras?.largest_1d_move_5s_pct ?? "",
    esc(md.tactical_extras?.largest_1d_date ?? ""),
    md.tactical_extras?.xle_same_day_return_pct ?? "",
    md.tactical_extras?.idiosyncratic_pp ?? "",
    md.tactical_extras?.largest_1d_on_known_print ?? "",
    md.tactical_extras?.air_pocket_candidate_active ?? "",
    md.oil_regime?.brent_spot ?? "",
    md.oil_regime?.brent_spot_stale ?? "",
    md.oil_regime?.henry_hub_spot ?? "",
    md.fundamentals?.brent_ttm_avg ?? "",
    md.fundamentals?.henry_hub_ttm_avg ?? "",
    md.fundamentals?.market_cap_busd ?? "",
    md.fundamentals?.q3_2025_in_ttm ?? "",
    esc(md.fundamentals?.forward_pe_signal_status ?? ""),
    esc(md.fundamentals?.revisions_signal_status ?? ""),
    md.fundamentals?.roce_spot_inflated ?? "",
    md.fundamentals?.share_count_base_clean ?? "",
    // Engine OUTPUT, not a payload field — read from the blended strategic
    // object generate-signals v8.7.0 passes through from blendScores().
    cycleGateState(s).active ?? "",
    esc(cycleGateState(s).side ?? ""),
    // ── LLM-sourced scaffolds: EVERY value goes through esc() (V8.6.0 rule).
    esc(md.fundamentals?.adj_fcf_ttm_busd ?? ""),
    esc(md.fundamentals?.downstream_earnings_ttm_busd ?? ""),
    esc(md.fundamentals?.crack_environment ?? ""),
    esc(md.fundamentals?.cffo_ex_wc_ttm_busd ?? ""),
    esc(md.fundamentals?.capex_ttm_busd ?? ""),
    esc(md.fundamentals?.capex_vs_guide ?? ""),
    esc(md.fundamentals?.timing_effects_last_q_busd ?? ""),
    esc(md.fundamentals?.working_capital_last_q_busd ?? ""),
    esc(md.fundamentals?.quarterly_eps_signal_status ?? ""),
    esc(md.fundamentals?.production_mboed ?? ""),
    esc(md.fundamentals?.production_vs_guide ?? ""),
    esc(md.fundamentals?.production_growth_yoy_pct ?? ""),
    esc(md.fundamentals?.tco_canary_status ?? ""),
    esc(md.fundamentals?.cpc_export_status ?? ""),
    esc(md.fundamentals?.guyana_status ?? ""),
    esc(md.fundamentals?.next_q_buyback_guide_low_busd ?? ""),
    esc(md.fundamentals?.next_q_buyback_guide_high_busd ?? ""),
    esc(md.fundamentals?.buyback_guide_trend ?? ""),
    esc(md.fundamentals?.buyback_ttm_busd ?? ""),
    esc(md.fundamentals?.buyback_vs_range ?? ""),
    esc(md.fundamentals?.forward_pe_consensus ?? ""),
    esc(md.fundamentals?.xom_fwd_pe ?? ""),
    esc(md.fundamentals?.breakeven_status ?? ""),
    esc(md.fundamentals?.net_debt_ratio_pct ?? ""),
    esc(md.fundamentals?.hesm_deconsolidation_state ?? ""),
    esc(md.fundamentals?.net_debt_ratio_ex_deconsolidation_pct ?? ""),
    esc(md.fundamentals?.insider_net_selling_90d ?? ""),
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
        // V8.6.0: UBER marketplace cohort (weighted DASH .50 / LYFT .25 /
        // GRAB .25, renormalized over the peers available). ⚠ basis
        // "trailing_gaap" on BOTH legs — gated by premium_pct_reliable below.
        uber_pe:        md.cohort_valuation.uber_pe ?? null,
        dash_pe:        md.cohort_valuation.dash_pe ?? null,
        lyft_pe:        md.cohort_valuation.lyft_pe ?? null,
        grab_pe:        md.cohort_valuation.grab_pe ?? null,
        uber_vs_dash_pct: md.cohort_valuation.uber_vs_dash_pct ?? null,
        // V8.6.0: cohort_count — how many peers cohort_avg_pe actually averaged
        // over. Emitted by EVERY cohort holding's fetch block (LHX, MSFT, NOW,
        // ISRG, MLM, UBER) but never mapped until now, so it populates on all
        // of those rows from V8.6.0 — additive. It matters most for weighted
        // cohorts (MLM, UBER), whose weights renormalize when a peer is
        // missing: the mean is unreadable without the count behind it.
        cohort_count:   md.cohort_valuation.cohort_count ?? null,
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
        // V8.6.0: WHY premium_pct_reliable is false. Travels with the flag —
        // MLM's cause (divestiture gain) and UBER's (tax release + equity
        // revaluations on its own leg, LYFT's tax-benefit P/E on the peer leg)
        // are different artifacts and a pooled study must tell them apart.
        unreliable_reason: md.cohort_valuation.unreliable_reason ?? null,
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
        // V8.6.0: UBER marketplace rotation. Like MLM, fetch v4.19 emits
        // peer_rotation_pp / _active (recorded raw above, and folded into the
        // shared cohort_rotation_* CSV columns by the row builder). UBER fires
        // at −6pp.
        uber_30d_return_pct:         md.cohort_relative.uber_30d_return_pct ?? null,
        dash_30d_return_pct:         md.cohort_relative.dash_30d_return_pct ?? null,
        lyft_30d_return_pct:         md.cohort_relative.lyft_30d_return_pct ?? null,
        grab_30d_return_pct:         md.cohort_relative.grab_30d_return_pct ?? null,
        // ⚠ CONTEXT ONLY — not a twin read. DASH is already half the weighted
        // cohort; contrast vmc_spread_30d_pp above, which IS scored.
        dash_spread_30d_pp:          md.cohort_relative.dash_spread_30d_pp ?? null,
        // V8.6.0: cohort_count — mapped for every cohort holding (see the
        // cohort_valuation note); the 30d mean is unreadable without it.
        cohort_count:                md.cohort_relative.cohort_count ?? null,
        // V8.7.0: CVX twin rotation vs XOM — THE signature tactical setup (fires
        // below −4pp). Payload key names kept here (twin_dislocation_active);
        // the CSV renames that one to xom_dislocation_active. SHEL/TTE and the
        // European average are context only — the engine does not score them.
        cvx_30d_return_pct:          md.cohort_relative.cvx_30d_return_pct ?? null,
        xom_30d_return_pct:          md.cohort_relative.xom_30d_return_pct ?? null,
        shel_30d_return_pct:         md.cohort_relative.shel_30d_return_pct ?? null,
        tte_30d_return_pct:          md.cohort_relative.tte_30d_return_pct ?? null,
        xom_spread_30d_pp:           md.cohort_relative.xom_spread_30d_pp ?? null,
        twin_dislocation_active:     md.cohort_relative.twin_dislocation_active ?? null,
        european_avg_30d_return_pct: md.cohort_relative.european_avg_30d_return_pct ?? null,
        european_count:              md.cohort_relative.european_count ?? null,
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
        // V8.7.0: CVX vs XOM — the twin. ⚠ basis "trailing_gaap" on BOTH legs
        // (windfall earnings plus CVX's Hess DD&A step-up): fetch v4.20 hard-
        // gates premium_pct_reliable FALSE. The flag and its reason travel with
        // premium_pct above — without them this object would store a twin
        // premium with nothing recording that it is invalid. SHEL/TTE are a
        // structural-discount REFERENCE only, never a premium to score.
        cvx_pe:                    md.twin_valuation.cvx_pe ?? null,
        xom_pe:                    md.twin_valuation.xom_pe ?? null,
        basis:                     md.twin_valuation.basis ?? null,
        premium_pct_reliable:      md.twin_valuation.premium_pct_reliable ?? null,
        unreliable_reason:         md.twin_valuation.unreliable_reason ?? null,
        reference_shel_pe:         md.twin_valuation.reference_shel_pe ?? null,
        reference_tte_pe:          md.twin_valuation.reference_tte_pe ?? null,
        reference_european_avg_pe: md.twin_valuation.reference_european_avg_pe ?? null,
      } : null,
      twin_relative: md.twin_relative ? {
        ma_change_pct:      md.twin_relative.ma_change_pct ?? null,
        v_change_pct:       md.twin_relative.v_change_pct ?? null,
        relative_spread_pp: md.twin_relative.relative_spread_pp ?? null,
        // V8.7.0: CVX vs XOM, today's session.
        cvx_change_pct:     md.twin_relative.cvx_change_pct ?? null,
        xom_change_pct:     md.twin_relative.xom_change_pct ?? null,
        xom_price:          md.twin_relative.xom_price ?? null,
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
      // ─── V8.6.0 UBER additions (UBER row only; null elsewhere) ─────────
      // Consumer factor overlay. Spread only, as for xlb/ihi/igv: the raw legs
      // are not logged for any holding — and a flat spy_30d_return_pct key
      // would NOT be UBER-only (LHX/NOW/ISRG/MLM factor_flow blocks emit it too).
      xly_vs_spy_30d_pp:               md.factor_flow?.xly_vs_spy_30d_pp ?? null,
      // AV-headline-shock PRICE screen — flattened under the payload key names,
      // as LIN's tactical_extras fields are above (the key sets are disjoint).
      // ⚠ av_shock_candidate_active is the PRICE event only; the LLM's
      // attribution is av_headline_shock_active, further down.
      worst_1d_return_5s_pct:          md.tactical_extras?.worst_1d_return_5s_pct ?? null,
      worst_1d_date:                   md.tactical_extras?.worst_1d_date ?? null,
      spy_same_day_return_pct:         md.tactical_extras?.spy_same_day_return_pct ?? null,
      worst_1d_on_known_print:         md.tactical_extras?.worst_1d_on_known_print ?? null,
      av_shock_candidate_active:       md.tactical_extras?.av_shock_candidate_active ?? null,
      // Config / regime state. ⚠ "leader_exiting_tail_aggregating" is the BASE
      // CASE (contested regime, scores zero), not a downgrade.
      av_supply_regime_state:          md.fundamentals?.av_supply_regime_state ?? null,
      dh_offer_state:                  md.fundamentals?.dh_offer_state ?? null,
      dh_basis_scored:                 md.fundamentals?.dh_basis_scored ?? null,
      // ★★ Labels the trailing_pe field on this row. Flips true → false at the
      // 2026-11-04 print, when trailing P/E roughly doubles on accounting alone.
      tax_release_in_ttm:              md.fundamentals?.tax_release_in_ttm ?? null,
      gaap_pe_signal_status:           md.fundamentals?.gaap_pe_signal_status ?? null,
      // ★ THE canary, with Delivery beside it — the signature is the GAP
      // (Mobility below 12% WHILE Delivery holds), not either number alone.
      gross_bookings_growth_cc_pct:    md.fundamentals?.gross_bookings_growth_cc_pct ?? null,
      gross_bookings_growth_reported_pct: md.fundamentals?.gross_bookings_growth_reported_pct ?? null,
      mobility_gb_growth_cc_pct:       md.fundamentals?.mobility_gb_growth_cc_pct ?? null,
      delivery_gb_growth_cc_pct:       md.fundamentals?.delivery_gb_growth_cc_pct ?? null,
      trips_growth_pct:                md.fundamentals?.trips_growth_pct ?? null,
      mapcs_millions:                  md.fundamentals?.mapcs_millions ?? null,
      mapcs_growth_pct:                md.fundamentals?.mapcs_growth_pct ?? null,
      adj_ebitda_musd:                 md.fundamentals?.adj_ebitda_musd ?? null,
      adj_ebitda_pct_gb:               md.fundamentals?.adj_ebitda_pct_gb ?? null,
      mobility_segment_oi_growth_pct:  md.fundamentals?.mobility_segment_oi_growth_pct ?? null,
      delivery_segment_oi_growth_pct:  md.fundamentals?.delivery_segment_oi_growth_pct ?? null,
      driver_incentive_pressure:       md.fundamentals?.driver_incentive_pressure ?? null,
      // ⚠ CONTEXT ONLY while revenue_signal_status is
      // "null_signal_business_model_contaminated". Kept apart from the shared
      // revenue_growth_yoy_pct field on purpose.
      reported_revenue_growth_pct:     md.fundamentals?.reported_revenue_growth_pct ?? null,
      business_model_drag_pp:          md.fundamentals?.business_model_drag_pp ?? null,
      revenue_signal_status:           md.fundamentals?.revenue_signal_status ?? null,
      guide_vs_consensus:              md.fundamentals?.guide_vs_consensus ?? null,
      // ⚠ Each multiple WITH its basis tag; none shares MLM's forward_pe /
      // ev_ebitda fields. ~13.9x / ~17.3x / ~18.7x on one EV is basis, not value.
      forward_pe_non_gaap:             md.fundamentals?.forward_pe_non_gaap ?? null,
      non_gaap_eps_sbc_treatment:      md.fundamentals?.non_gaap_eps_sbc_treatment ?? null,
      ev_adj_ebitda:                   md.fundamentals?.ev_adj_ebitda ?? null,
      ev_adj_ebitda_basis:             md.fundamentals?.ev_adj_ebitda_basis ?? null,
      ev_adj_ebitda_less_sbc:          md.fundamentals?.ev_adj_ebitda_less_sbc ?? null,
      ev_gaap_ebitda:                  md.fundamentals?.ev_gaap_ebitda ?? null,
      // Owner FCF — FCF less SBC; the flagship strategic lens.
      fcf_ttm_busd:                    md.fundamentals?.fcf_ttm_busd ?? null,
      sbc_ttm_busd:                    md.fundamentals?.sbc_ttm_busd ?? null,
      owner_fcf_yield_pct:             md.fundamentals?.owner_fcf_yield_pct ?? null,
      tier1_operators_direct_only:     md.fundamentals?.tier1_operators_direct_only ?? null,
      tier1_operators_on_uber:         md.fundamentals?.tier1_operators_on_uber ?? null,
      exclusive_pipeline_status:       md.fundamentals?.exclusive_pipeline_status ?? null,
      av_headline_shock_active:        md.fundamentals?.av_headline_shock_active ?? null,
      // ⚠ Leverage vs the stated <2x gross ceiling, never the level.
      dh_acceptance_pct:               md.fundamentals?.dh_acceptance_pct ?? null,
      gross_leverage:                  md.fundamentals?.gross_leverage ?? null,
      // buyback_pace is context only — scored on the NET share count above.
      buyback_pace:                    md.fundamentals?.buyback_pace ?? null,
      insider_buying_recent:           md.fundamentals?.insider_buying_recent ?? null,
      // ⚠ Pairs with roic_pct above. NOT roic_denominator_distorted: UBER's
      // NUMERATOR is tax-inflated; MLM's DENOMINATOR is acquisition-inflated.
      roic_gaap_inflated:              md.fundamentals?.roic_gaap_inflated ?? null,
      // ─── V8.7.0 CVX additions (CVX row only; null elsewhere) ──────────
      // The oil regime vs Chevron's $70 planning deck — fetch v4.20's block
      // whole (spot Brent is FRED/EIA daily, ~1-week lag; brent_spot_stale
      // flags > 14 days). score-engine V8.6 recomputes the band from the
      // number; its result is regime / regime_driver below.
      oil_regime: md.oil_regime ? {
        brent_spot:          md.oil_regime.brent_spot ?? null,
        brent_spot_date:     md.oil_regime.brent_spot_date ?? null,
        brent_spot_stale:    md.oil_regime.brent_spot_stale ?? null,
        brent_source:        md.oil_regime.brent_source ?? null,
        deck_brent:          md.oil_regime.deck_brent ?? null,
        deck_deviation_pct:  md.oil_regime.deck_deviation_pct ?? null,
        oil_price_regime:    md.oil_regime.oil_price_regime ?? null,
        regime_direction:    md.oil_regime.regime_direction ?? null,
        driver_missing:      md.oil_regime.driver_missing ?? null,
        wti_spot:            md.oil_regime.wti_spot ?? null,
        brent_wti_spread:    md.oil_regime.brent_wti_spread ?? null,
        henry_hub_spot:      md.oil_regime.henry_hub_spot ?? null,
        henry_hub_spot_date: md.oil_regime.henry_hub_spot_date ?? null,
      } : null,
      // Energy factor overlay. Spread only, as for xlb/xly/ihi/igv.
      xle_vs_spy_30d_pp:               md.factor_flow?.xle_vs_spy_30d_pp ?? null,
      // Geopolitical AIR-POCKET screen — flattened under the payload key names,
      // as LIN's and UBER's tactical_extras fields are above (the key sets are
      // disjoint). The candidate flag is the PRICE event only.
      largest_1d_move_5s_pct:          md.tactical_extras?.largest_1d_move_5s_pct ?? null,
      largest_1d_date:                 md.tactical_extras?.largest_1d_date ?? null,
      largest_1d_direction:            md.tactical_extras?.largest_1d_direction ?? null,
      xle_same_day_return_pct:         md.tactical_extras?.xle_same_day_return_pct ?? null,
      idiosyncratic_pp:                md.tactical_extras?.idiosyncratic_pp ?? null,
      largest_1d_on_known_print:       md.tactical_extras?.largest_1d_on_known_print ?? null,
      air_pocket_candidate_active:     md.tactical_extras?.air_pocket_candidate_active ?? null,
      // Deck-normalization inputs computed by fetch v4.20 (4 REPORTED quarters;
      // Henry Hub is the daily spot as a bid-week proxy — henry_hub_basis says so).
      brent_ttm_avg:                   md.fundamentals?.brent_ttm_avg ?? null,
      henry_hub_ttm_avg:               md.fundamentals?.henry_hub_ttm_avg ?? null,
      henry_hub_basis:                 md.fundamentals?.henry_hub_basis ?? null,
      ttm_window:                      md.fundamentals?.ttm_window ?? null,
      market_cap_busd:                 md.fundamentals?.market_cap_busd ?? null,
      // ★★ Labels for reused fields on this row. q3_2025_in_ttm flips true →
      // false once Q3'26 is reported (2026-10-30 print): trailing_pe falls
      // ~22x → ~17x on accounting alone. share_count_base_clean = false means
      // the YoY window crosses the 2025-07-18 Hess close (~+14% mechanical).
      q3_2025_in_ttm:                  md.fundamentals?.q3_2025_in_ttm ?? null,
      forward_pe_signal_status:        md.fundamentals?.forward_pe_signal_status ?? null,
      revisions_signal_status:         md.fundamentals?.revisions_signal_status ?? null,
      roce_spot_inflated:              md.fundamentals?.roce_spot_inflated ?? null,
      share_count_base_clean:          md.fundamentals?.share_count_base_clean ?? null,
      // LLM-sourced scaffolds (null until populated).
      adj_fcf_ttm_busd:                md.fundamentals?.adj_fcf_ttm_busd ?? null,
      downstream_earnings_ttm_busd:    md.fundamentals?.downstream_earnings_ttm_busd ?? null,
      crack_environment:               md.fundamentals?.crack_environment ?? null,
      cffo_ex_wc_ttm_busd:             md.fundamentals?.cffo_ex_wc_ttm_busd ?? null,
      capex_ttm_busd:                  md.fundamentals?.capex_ttm_busd ?? null,
      capex_vs_guide:                  md.fundamentals?.capex_vs_guide ?? null,
      timing_effects_last_q_busd:      md.fundamentals?.timing_effects_last_q_busd ?? null,
      working_capital_last_q_busd:     md.fundamentals?.working_capital_last_q_busd ?? null,
      quarterly_eps_signal_status:     md.fundamentals?.quarterly_eps_signal_status ?? null,
      // ⚠ Scored vs the FY26 guide; production_growth_yoy_pct is CONTEXT ONLY.
      production_mboed:                md.fundamentals?.production_mboed ?? null,
      production_vs_guide:             md.fundamentals?.production_vs_guide ?? null,
      production_growth_yoy_pct:       md.fundamentals?.production_growth_yoy_pct ?? null,
      // ★ THE operational canary. CPC = Caspian Pipeline Consortium.
      tco_canary_status:               md.fundamentals?.tco_canary_status ?? null,
      cpc_export_status:               md.fundamentals?.cpc_export_status ?? null,
      guyana_status:                   md.fundamentals?.guyana_status ?? null,
      next_q_buyback_guide_low_busd:   md.fundamentals?.next_q_buyback_guide_low_busd ?? null,
      next_q_buyback_guide_high_busd:  md.fundamentals?.next_q_buyback_guide_high_busd ?? null,
      buyback_guide_trend:             md.fundamentals?.buyback_guide_trend ?? null,
      buyback_ttm_busd:                md.fundamentals?.buyback_ttm_busd ?? null,
      buyback_vs_range:                md.fundamentals?.buyback_vs_range ?? null,
      // ⚠ SPOT-contaminated — reported, never scored; not MLM's forward_pe.
      forward_pe_consensus:            md.fundamentals?.forward_pe_consensus ?? null,
      xom_fwd_pe:                      md.fundamentals?.xom_fwd_pe ?? null,
      breakeven_status:                md.fundamentals?.breakeven_status ?? null,
      // ⚠ Read leverage EX-deconsolidation (HESM exit: ~$3.7B debt, no cash).
      net_debt_ratio_pct:              md.fundamentals?.net_debt_ratio_pct ?? null,
      hesm_deconsolidation_state:      md.fundamentals?.hesm_deconsolidation_state ?? null,
      net_debt_ratio_ex_deconsolidation_pct: md.fundamentals?.net_debt_ratio_ex_deconsolidation_pct ?? null,
      insider_net_selling_90d:         md.fundamentals?.insider_net_selling_90d ?? null,

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
        // V8.6.0: true = blended was FLOORED at 0 by the UBER value-trap gate
        // (a rule output, not a judgment); false = evaluated and clear; null =
        // not evaluated for this holding. Lives beside the number it clips.
        value_trap_gate_active: valueTrapGateState(s),
        // V8.7.0: CVX cycle-position gate (score-engine V8.6, Guardrail E).
        // true = blended was BOUNDED by rule — floored at 0 (side "no_buy") or
        // capped at 0 (side "no_trim"); false = evaluated and clear; null = not
        // evaluated for this holding.
        cycle_gate_active: cycleGateState(s).active,
        cycle_gate_side:   cycleGateState(s).side,
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
