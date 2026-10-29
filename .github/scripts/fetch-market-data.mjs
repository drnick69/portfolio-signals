#!/usr/bin/env node
// fetch-market-data.mjs v4.20 — Finnhub (quotes) + TwelveData (technicals) + FRED (macro) + NY Fed (GSCPI) + Alpaca (bars)
//
// v4.20 (October 2026): HOLDINGS SWAP — sold ENB (Enbridge / dividend_compounder),
// bought CVX (Chevron / integrated_major_capital_returner). Still 14 scored
// holdings. BUILT ON v4.19 (PBR.A → UBER): both swaps live in this file, so
// v4.20 supersedes v4.19 — deploy this one, not both.
//   Removals:
//     - ENB removed from SYMBOLS. That is the whole removal: ENB never had an
//       aux symbol, an Alpaca stage or an attachment block here. Its yield-
//       spread-vs-10Y line is computed in generate-signals and retires there.
//       DGS10 stays — every rate-sensitive branch still reads it.
//     - WTI (DCOILWTICO) regains a consumer: CVX's oil_regime reports the
//       Brent–WTI spread as context. BRL/USD stays orphaned, kept for the CSV
//       width per the v4.19 decision.
//   Additions for CVX (TWIN pattern, same as MA/V and MLM/VMC):
//     - XOM aux quote WITH metrics — the twin. The only other US super-major
//       and Chevron's Stabroek partner.
//     - SHEL, TTE aux quotes WITH metrics — a STRUCTURAL-DISCOUNT REFERENCE,
//       not a cohort. European majors carry a persistent multiple gap (~7–8x
//       forward against ~12x for the US pair); CVX's premium to them is
//       reported for the record and never scored.
//     - XLE aux quote (Energy Select Sector SPDR — sector factor proxy).
//     - twin_valuation (CVX vs XOM trailing P/E) — ★ PERMANENTLY GATED:
//       premium_pct_reliable is hard FALSE. Both legs are trailing GAAP on
//       windfall-oil earnings with the same Q3'25 roll-off, and CVX's leg is
//       further depressed by the Hess purchase-accounting DD&A step-up (DD&A
//       guided $23–24B against $18–19B organic capex), which biases CVX's
//       trailing premium UP for reasons unrelated to value. The model scores
//       the FORWARD twin premium, LLM-sourced downstream, and only as a
//       secondary read.
//     - twin_relative (daily CVX − XOM spread) and cohort_relative (30d:
//       xom_spread_30d_pp, twin_dislocation_active = TRUE if < -4pp — the
//       signature tactical setup, oil-neutral by construction; SHEL/TTE 30d
//       carried as reference only)
//     - factor_flow.xle_vs_spy_30d_pp (energy sector bid: active >+2pp |
//       neutral ±2pp | absent <-2pp — wider than the ±1pp used for consumer
//       and materials factors because sector beta to oil swamps 1pp)
//     - tactical_extras: GEOPOLITICAL AIR-POCKET PRICE SCREEN — largest
//       single-session move in the last 5 sessions in EITHER direction, XLE on
//       that same date, the idiosyncratic residual, and a candidate flag at
//       |move| ≥ 4% off the Q3 print date. Classification (de-escalation /
//       escalation / Chevron asset) is LLM territory and lands in the strategy
//       model; in a dislocated-high regime a de-escalation drop is NOT a buy.
//     - New fetchCVXHistoricalReturns() (6 Alpaca calls: CVX, XOM, SHEL, TTE,
//       XLE, SPY — same budget as the MLM and UBER functions)
//   ★ OIL-PRICE REGIME — NUMERIC AND SELF-UPDATING. No human-maintained
//     constant. New fetchCVXCommodityDeck() pulls FRED Brent (DCOILBRENTEU)
//     and Henry Hub (DHHNGSP) daily history (2 FRED calls) and emits:
//       • oil_regime: spot Brent vs Chevron's $70 planning deck → anchored
//         (|dev| ≤ 20%) / transitional (≤ 40%) / dislocated (> 40%), plus
//         direction. Identical bands and boundary handling to
//         cvx-strategy.jsx v1 resolveOilRegime(). Missing Brent → transitional
//         with driver_missing TRUE (the house "missing driver → base triple"
//         convention), logged loudly. EIA's daily series lags about a week;
//         a reading older than 14 days is flagged stale.
//       • Normalization inputs: TTM average Brent and Henry Hub over the four
//         most recently REPORTED quarters, aligned to the window Chevron's
//         reported TTM free cash flow covers. A quarter counts as reported 31
//         days after it ends, which switches on 2026-10-31 for the 2026-10-30
//         print (the Finnhub-lags-the-filing convention v4.19 used for UBER).
//         Equal-weighted quarterly means, each needing 40+ daily observations,
//         or the TTM is null and the normalization downstream is partial.
//       • Henry Hub basis: FRED's daily SPOT, a proxy for the bid-week index
//         Chevron's sensitivity is struck on. Labelled in the output.
//     The normalization itself (adjusted FCF at the $70 / $3.50 deck) needs
//     LLM-sourced TTM adjusted FCF and downstream earnings, so it is computed
//     in score-engine, not here.
//   ★ STRUCTURAL CATEGORICALS emitted non-null (the MLM / UBER precedent):
//     gaap_pe_signal_status is always "null_signal_cycle_contaminated";
//     forward_pe_signal_status, revisions_signal_status and roce_spot_inflated
//     derive from the regime; q3_2025_in_ttm and share_count_base_clean derive
//     from the date via the same reported-quarter window — so the Hess
//     anniversary (shares issued 2025-07-18) and the Q3'25 roll-off clear on
//     their own, with nothing to maintain.
//
// v4.19 (October 2026): HOLDINGS SWAP — sold PBR.A (Petrobras preferred ADR /
// em_state_oil_dividend), bought UBER (Uber Technologies /
// marketplace_demand_aggregator). Still 14 scored holdings.
//   Removals:
//     - PBR.A removed from SYMBOLS. This also retires the open Alpaca 400: the
//       Stage 2b/2c fallbacks sent the class-share symbol (Finnhub form
//       "PBR-A") to Alpaca, which rejected it. UBER is a plain ticker on all
//       four vendors, so nothing inherits the error.
//     - ⚠ WTI (DCOILWTICO) and BRL/USD (DEXBZUS) are NOT removed from the FRED
//       stage, although PBR.A was their only scoring consumer. log-signals
//       writes both as CSV columns, and under signal-accuracy's exact-width
//       contract a column that silently empties is a worse outcome than two
//       extra FRED calls. Decision recorded 2026-10-27. score-engine keeps its
//       PBR.A branches for historical re-scoring; they stop receiving a row.
//   Additions for UBER (WEIGHTED cohort pattern, same as MLM):
//     - DASH, LYFT, GRAB aux quotes WITH metrics (consumer-marketplace cohort).
//       No true twin exists. DASH carries 50% as the only other scaled,
//       profitable US marketplace; LYFT (US mobility pure play) and GRAB
//       (mobility + delivery super-app, the closest business-model analog)
//       carry 25% each. Renormalized over whichever peers resolved.
//     - XLY aux quote (Consumer Discretionary SPDR — consumer factor proxy).
//       GICS puts UBER in Industrials (~2.6% of XLI), but it trades as a
//       consumer platform; XLI is CAT/GE/RTX-dominated and reads the wrong
//       factor for this name.
//     - cohort_valuation (UBER vs DASH/LYFT/GRAB weighted TRAILING P/E) —
//       ★ PERMANENTLY GATED: premium_pct_reliable is hard FALSE. Unlike MLM's
//       gate it does not key on the size of the discount, because legs on BOTH
//       sides are GAAP-contaminated by construction. See the UBER block.
//     - cohort_relative (peer_rotation_pp = UBER 30d − weighted cohort 30d;
//       peer_rotation_active = TRUE if < -6pp — between MLM's -5 and RDDT's
//       -8, matching beta 1.26; dash_spread_30d_pp carried separately)
//     - factor_flow.xly_vs_spy_30d_pp (consumer factor bid)
//     - tactical_extras: AV-headline-shock PRICE SCREEN — worst 1-day return in
//       the last 5 sessions, SPY on that session, and av_shock_candidate_active
//       (≤ -4%, not on a known Uber print date). Attribution to an AV headline
//       is LLM territory and lands in fundamentals.av_headline_shock_active.
//     - New fetchUBERHistoricalReturns() (6 Alpaca calls: UBER, DASH, LYFT,
//       GRAB, XLY, SPY — same budget as the MLM function)
//     - fundamentals v1 explicit-null fields matching the uber-strategy.jsx v1
//       contract: constant-currency bookings, the MOBILITY canary, trips and
//       MAPCs, Adj EBITDA % GB, segment OI, the owner-FCF block, basis-tagged
//       EV/EBITDA, AV pipeline, Delivery Hero acceptance, gross leverage, NET
//       share count.
//   ★ CONFIG SHIPS POPULATED — the v4.17 → v4.18 lesson applied up front.
//     UBER's regime driver is a categorical no API publishes: whether AV supply
//     is listing on Uber or routing around it. It is a human-maintained
//     constant from day one, logged loudly every run, with a staleness warning
//     after 90 days unreviewed. Same treatment for the Delivery Hero offer
//     state, which warns once the acceptance period (ends 2026-11-05) has
//     passed while the constant still reads "acceptance_period".
//     dh_basis_scored derives from it: "pro_forma_dh" only once the state is
//     "closed" (decision recorded 2026-10-27 — score standalone until
//     settlement; the LNA known-forward-event precedent deliberately NOT
//     followed, because DH has neither its clearances nor its financing).
//   ★ STRUCTURAL CATEGORICALS emitted non-null (the MLM reported_asp
//     precedent): gaap_pe_signal_status, revenue_signal_status and
//     roic_gaap_inflated are known properties of the current reporting period,
//     not missing fetches. tax_release_in_ttm is computed from the date: TRUE
//     through the Q3'26 print day (2026-11-04 — Finnhub's TTM lags the filing,
//     so the print-day run still carries the $4.9B release), FALSE after, with
//     no maintenance needed once it flips.
//
// v4.18 (August 2026): MLM FUNDING-REGIME CONFIG — closes a gap left by v4.17.
//   score-engine V8.4's computeMLMRegimeWeights() gates MLM's composite weights
//   on federal_authorization_status and state_dot_budget_trend, but v4.17
//   emitted both as null. The engine falls back to NEUTRAL on null, so the
//   scores were never wrong — but the gate was INERT: funded (25/40/35) and
//   unfunded (15/30/55) could never activate, no matter what Congress did.
//   Unlike every other regime gate in this file, MLM's driver is a CATEGORICAL
//   that no API publishes. MA/ISRG/RDDT all gate on numeric factor spreads this
//   file computes from Alpaca bars; there is no endpoint that returns "has the
//   surface transportation bill been reauthorized". So it is a human-set
//   constant, reviewed when the statute changes — roughly twice a year — which
//   is exactly what was proposed when the archetype was designed and then not
//   built. It is built now.
//   ⚠ THIS IS THE ONE VALUE IN THIS FILE THAT A HUMAN MUST MAINTAIN. Everything
//   else self-updates from an API. If IIJA lapses or is reauthorized and nobody
//   edits the constant below, MLM keeps scoring against a stale regime and
//   nothing will complain — so the file logs the current setting loudly on
//   every run, and warns when the expiry date has passed while the status still
//   reads short_term_extension or pending_no_action.
//
// v4.17 (August 2026): HOLDINGS SWAP — sold RDDT (Reddit), bought MLM
// (Martin Marietta Materials / reserve_moat_infrastructure_compounder).
// Still 14 scored holdings.
//   Removals:
//     - RDDT removed from SYMBOLS
//     - PINS, APP, XLC aux entries removed (RDDT-only; no other consumer)
//     - ⚠ META is NOT removed. It carries purpose "msft_cohort+rddt_cohort"
//       and is LOAD-BEARING for the MSFT mega-cap cohort. Deleting it with the
//       ads cohort would silently break MSFT cohort_valuation and
//       cohort_relative. Its purpose tag is narrowed back to "msft_cohort".
//   Additions for MLM (cohort pattern analogous to ISRG/RDDT):
//     - VMC, CRH, EXP aux quotes WITH metrics (US aggregates cohort P/E).
//       VMC is the only true like-for-like pure play and carries 50% of the
//       cohort weight; CRH and EXP carry 25% each as the breadth check.
//       ★ The cohort average here is WEIGHTED, unlike every prior cohort in
//         this file (which use simple means). Weights renormalize over
//         whichever peers actually resolved.
//     - XLB aux quote (Materials Select Sector SPDR — materials factor proxy)
//     - cohort_valuation (MLM vs VMC/CRH/EXP weighted TRAILING P/E)
//     - cohort_relative (peer_rotation_pp = MLM 30d − weighted cohort 30d;
//       rotation_active = TRUE if < -5pp. Threshold is TIGHTER than RDDT's -8
//       because MLM beta is 1.11, not 1.94 — a 5pp spread is real information
//       on this name. vmc_spread_30d_pp is carried SEPARATELY: the twin
//       comparison is the flagship tactical read, the 3-name cohort is breadth.)
//     - factor_flow.xlb_vs_spy_30d_pp (materials sector bid signal)
//     - New fetchMLMHistoricalReturns() (6 Alpaca calls: MLM, VMC, CRH, EXP,
//       XLB, SPY — same call budget as the RDDT function it replaces)
//     - fundamentals v1 explicit-null fields: the mix-adjusted organic pricing
//       block (THE moat metric), organic vs reported volume, cash gross profit
//       per ton, COGS/ton, end-market split, weather flag, the LNA pro-forma
//       block, federal authorization + state DOT categoricals, and NET share
//       count change (negative = buyback — MLM genuinely satisfies the
//       criterion, the inverse of RDDT's position)
//
//   ★★ NEW GATE — trailing_discount_artifact_suspected ★★
//   MLM's TTM window contains a large non-operating gain from the Quikrete
//   asset exchange: trailing P/E ~12.9x against a ~26.8x forward, and a TTM
//   profit margin (36.7%) that EXCEEDS gross margin (28.2%) — impossible from
//   operations. Finnhub aux metrics are trailing-basis, so the cohort premium
//   computed here reads roughly -50% versus the aggregates cohort and the
//   inherited RDDT zone logic would label that "COMPRESSED (BUY)". That is a
//   fabricated buy signal sourced entirely from an accounting gain.
//   Score-engine Guardrail A cannot help at this layer because it needs a
//   FORWARD P/E, which is LLM-sourced downstream and unavailable here.
//   So this file gates it itself: two aggregates producers with materially
//   identical business models do not trade at half each other's multiple, so a
//   trailing discount steeper than 35% vs a same-industry cohort is an artifact,
//   not an opportunity. When it fires, premium_pct is still emitted for the
//   record but premium_pct_reliable goes FALSE and the zone label becomes
//   ARTIFACT_SUSPECTED so nothing downstream can read it as a buy.
//
// v4.16 (August 2026): HOLDINGS SWAP — sold IBIT (spot BTC ETF), bought
// RDDT (Reddit / hypergrowth_platform_monetizer). Still 14 scored holdings.
//   Removals:
//     - IBIT removed from SYMBOLS (supersedes the v4.13 note below, which
//       recorded that IBIT remained as a standalone holding at that time)
//   Additions for RDDT (cohort pattern analogous to NOW/ISRG):
//     - PINS, APP aux quotes WITH metrics (digital-ads cohort P/E).
//       META was ALREADY in AUX_SYMBOLS for the MSFT mega-cap cohort and is
//       reused here — do not add a duplicate entry.
//     - XLC aux quote (Communication Services SPDR — ads factor proxy;
//       the regime-gate input for RDDT)
//     - cohort_valuation (RDDT vs META/PINS/APP avg TRAILING P/E)
//       * NOTE: unlike ISRG/NOW there is NO structural premium baseline here.
//         RDDT sits inside the cohort band. <-15% = compressed = buy;
//         -15% to +40% = normal; >+80% = rich.
//       * CAVEAT: this field is TRAILING P/E (all Finnhub aux metrics are).
//         The RDDT model reasons on FORWARD P/E, which the LLM sources
//         separately. Do not conflate the two.
//     - cohort_relative (cohort_rotation_pp = RDDT 30d - cohort avg 30d;
//       rotation_active = TRUE if < -8pp. Threshold is WIDER than ISRG's -6
//       because RDDT beta is 1.94 — a 6pp spread is noise on this name.)
//     - factor_flow.xlc_vs_spy_30d_pp (ads sector bid signal)
//     - fundamentals v1 explicit-null fields: ad_revenue_growth_yoy_pct (THE
//       ops metric), ARPU block (global/US/RoW/growth), DAUq/WAUq, the
//       logged-in/logged-out split (DISCONTINUED by the company from Q3 2026
//       — see dau_disclosure_status), margin/FCF block, guide range, EPS
//       revisions, NET share count change (never buyback yield), and the
//       search_referral / licensing / competitive_threat categoricals
//     - New fetchRDDTHistoricalReturns() (6 Alpaca calls: RDDT, META, PINS,
//       APP, XLC, SPY)
//   NOTE: RDDT listed March 2024. Own-history multiple averages cover a
//   PARTIAL WINDOW and own_history_window_partial is emitted as TRUE so the
//   downstream model discounts them. This is deliberate, not a data gap.
//
// v4.15 (July 2026): ALPACA FEED FALLBACK — keys without a SIP data
// entitlement return 403 on every feed=sip bars request (observed in prod
// 2026-07-08: all Stage 2b/2c/3c–3i calls failed). All bars calls now route
// through alpacaBarsFetch(): try feed=sip first (better closes when
// entitled), and on 403 retry the identical URL with feed=iex (free tier).
// One extra request on the failure path only; the downgrade is logged once
// per run. Self-healing: restoring the SIP entitlement silently restores
// sip-quality data with no code change.
// No npm dependencies beyond xlsx (for GSCPI parsing). Direct fetch() calls only.
// v4.1: RSP/SPY breadth data fetch for SPY positional layer
// v4.2: GSCPI (NY Fed Global Supply Chain Pressure Index) for AMKBY strategic layer
// v4.3: ETHA/IBIT alt-season ratio for ETHA positional layer
// v4.4: MXN/USD (FRED DEXMXUS) for KOF FX regime scoring
// v4.5: COPX auxiliary quote for GLNCY copper regime scoring
// v4.6: WTI crude (DCOILWTICO) + BRL/USD (DEXBZUS) for PBR.A oil/FX regime
// v4.7: CORN auxiliary quote for MOS agricultural demand regime
// v4.8: MU auxiliary quote for SMH DRAM cycle regime
// v4.9: LIN oligopoly_quality_compounder additions (APD/AIQUY peers, BBB OAS, ISM, fundamentals)
// v4.10: LIN v3 deep-upgrade fields (BBB OAS delta, QUAL factor flow, tactical extras, H2 layer scaffolding)
// v4.11: MSFT ai_infra_quality_compounder additions (GOOGL/META/AAPL cohort, rotation pressure)
// v4.12: HOLDINGS SWAP — added LHX (defense_prime_backlog_compounder) and TMO (life_sciences_quality_compounder);
//        retired MOS (cyclical fertilizer) and SPY (broad market core).
// v4.13: HOLDINGS SWAP — sold ETHA (ETH spot ETF), bought NOW (ServiceNow / ai_workflow_quality_compounder).
//        Removals:
//          - ETHA removed from SYMBOLS
//          - ETHA/IBIT alt-season attachment block removed (was ETHA positional only)
//          - ETHA/IBIT summary line removed
//          NOTE: IBIT remains in SYMBOLS (still scored as a standalone holding).
//        Additions for NOW (analogous to MSFT cohort pattern + premium-SaaS multiple math):
//          - CRM, WDAY, ADBE aux quotes WITH metrics (enterprise SaaS cohort P/E)
//          - IGV aux quote (iShares Expanded Tech-Software — software sector factor proxy)
//          - cohort_valuation (NOW vs CRM/WDAY/ADBE avg trailing P/E)
//            ★ NOTE: NOW carries 80-120% premium to CRM/WDAY/ADBE as the BASELINE
//              (higher growth + higher quality). Premium <60% = unusual discount = buy;
//              >150% = stretched. Direction of change > absolute level.
//          - cohort_relative (rotation_pressure_pp = NOW 30d − cohort avg 30d;
//            rotation_active = TRUE if < -5pp — capital rotating to higher-beta AI/SaaS
//            names = historically a buy setup, not a warning)
//          - factor_flow.igv_vs_spy_30d_pp (software sector bid signal — IGV outperforming
//            SPY by >1pp/30d = SaaS factor bid active)
//          - fundamentals v1 explicit-null fields: crpo_growth_pct, subscription_growth_pct,
//            op_margin_pct, fcf_margin_pct, large_deals_growth_pct, federal_growth_pct,
//            eps_revisions_30d_pct, eps_revisions_90d_pct, ev_sales_current,
//            now_assist_traction, ai_agent_platform_status
//          - New fetchNOWHistoricalReturns() (6 Alpaca calls: NOW, CRM, WDAY, ADBE, IGV, SPY)
// v4.14: HOLDINGS ADD — MA (payments_network_quality_compounder) and
//        ISRG (surgical_robotics_moat_compounder). 12 → 14 scored holdings.
//        Additions for MA (twin/duopoly pattern — V is the ONLY comparator):
//          - V aux quote WITH metrics (duopoly twin trailing P/E)
//          - twin_valuation (MA vs V trailing P/E premium)
//            ★ NOTE: MA normally carries a 10-20% premium to V (faster grower).
//              Premium <5% = compressed = buy; >25% = rich. Direction > level.
//          - twin_relative (daily MA−V return spread) + duopoly_relative
//            (30d: twin_spread_pp, dislocation flag, MA+V avg vs SPY →
//            disruption_fear_regime categorical — the V8.1 weight-gate input)
//          - fundamentals v1 explicit-null fields: cross_border_growth_pct (THE
//            ops metric), gdv_growth_pct, switched_txn_growth_pct, vas fields,
//            rebates_incentives_trend, op_margin_pct, eps_revisions, buyback,
//            stablecoin/disruption/regulation categoricals
//          - New fetchMAHistoricalReturns() (3 Alpaca calls: MA, V, SPY)
//        Additions for ISRG (cohort pattern analogous to NOW premium-multiple math):
//          - MDT, SYK, BSX aux quotes WITH metrics (devices cohort P/E)
//          - IHI aux quote (iShares U.S. Medical Devices — devices factor proxy;
//            the V8.1 weight-gate input for ISRG)
//          - cohort_valuation (ISRG vs MDT/SYK/BSX avg trailing P/E)
//            ★ NOTE: ISRG carries 60-120% premium to the cohort as the BASELINE
//              (category king, ~86% recurring annuity). Premium <60% = unusual
//              discount = buy; >150% = stretched. Absolute PE is never the signal.
//          - cohort_relative (cohort_rotation_pp = ISRG 30d − cohort avg 30d;
//            rotation_active = TRUE if < -6pp — fear rotation without procedure
//            evidence = historically a buy setup, not a warning)
//          - factor_flow.ihi_vs_spy_30d_pp (devices sector bid signal)
//          - fundamentals v1 explicit-null fields: procedure_growth_pct (THE ops
//            metric) + guide range, dv_placements/dv5_mix, ion fields, recurring
//            %, I&A growth, installed base, op_margin_pct, eps_revisions,
//            moat_status / instrument_transition_status categoricals
//          - New fetchISRGHistoricalReturns() (6 Alpaca calls: ISRG, MDT, SYK, BSX, IHI, SPY)

import { writeFileSync } from "fs";

const FK      = process.env.FK;         // Finnhub
const TD_KEY  = process.env.TD_KEY;     // TwelveData
const FRED_KEY = process.env.FRED_KEY;  // FRED

if (!FK)       console.warn("⚠ Missing FK — quote data unavailable");
if (!TD_KEY)   console.warn("⚠ Missing TD_KEY — technicals unavailable");
if (!FRED_KEY) console.warn("⚠ Missing FRED_KEY — macro data unavailable");

const SYMBOLS = [
  { symbol: "LHX",   finnhub: "LHX",   td: "LHX" },
  { symbol: "ASML",  finnhub: "ASML",  td: "ASML" },
  { symbol: "LIN",   finnhub: "LIN",   td: "LIN" },
  { symbol: "MSFT",  finnhub: "MSFT",  td: "MSFT" },
  { symbol: "NOW",   finnhub: "NOW",   td: "NOW" },
  { symbol: "TMO",   finnhub: "TMO",   td: "TMO" },
  { symbol: "CVX",   finnhub: "CVX",   td: "CVX" },
  { symbol: "GLNCY", finnhub: "GLNCY", td: "GLNCY" },
  { symbol: "MLM",   finnhub: "MLM",   td: "MLM" },
  { symbol: "KOF",   finnhub: "KOF",   td: "KOF" },
  { symbol: "UBER",  finnhub: "UBER",  td: "UBER" },
  { symbol: "AMKBY", finnhub: "AMKBY", td: "AMKBY" },
  { symbol: "MA",    finnhub: "MA",    td: "MA" },
  { symbol: "ISRG",  finnhub: "ISRG",  td: "ISRG" },
];

// ── Auxiliary symbols (not scored, used as inputs to other holdings) ──
// needsMetrics: true → also fetch /stock/metric for P/E (used by peer/cohort valuation).
const AUX_SYMBOLS = [
  { symbol: "COPX",  finnhub: "COPX",  purpose: "glncy_copper" },
  { symbol: "APD",   finnhub: "APD",   purpose: "lin_peer",          needsMetrics: true },  // Air Products
  { symbol: "AIQUY", finnhub: "AIQUY", purpose: "lin_peer",          needsMetrics: true },  // Air Liquide ADR
  { symbol: "GOOGL", finnhub: "GOOGL", purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort
  { symbol: "META",  finnhub: "META",  purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort. ⚠ DO NOT REMOVE — was dual-use with the retired RDDT ads cohort; MSFT still depends on it.
  { symbol: "AAPL",  finnhub: "AAPL",  purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort
  { symbol: "LMT",   finnhub: "LMT",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "NOC",   finnhub: "NOC",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "RTX",   finnhub: "RTX",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "GD",    finnhub: "GD",    purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "ITA",   finnhub: "ITA",   purpose: "lhx_defense_factor" },                     // iShares Aero & Defense ETF
  { symbol: "XBI",   finnhub: "XBI",   purpose: "tmo_biotech" },                            // SPDR Biotech (funding proxy)
  { symbol: "DHR",   finnhub: "DHR",   purpose: "tmo_peer",          needsMetrics: true },  // Danaher (bioprocessing peer)
  { symbol: "CRM",   finnhub: "CRM",   purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Salesforce)
  { symbol: "WDAY",  finnhub: "WDAY",  purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Workday)
  { symbol: "ADBE",  finnhub: "ADBE",  purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Adobe)
  { symbol: "IGV",   finnhub: "IGV",   purpose: "now_software_factor" },                    // iShares Expanded Tech-Software ETF
  { symbol: "V",     finnhub: "V",     purpose: "ma_twin",           needsMetrics: true },  // Visa — MA duopoly twin (the ONLY comparator)
  { symbol: "MDT",   finnhub: "MDT",   purpose: "isrg_cohort",       needsMetrics: true },  // Medtronic (Hugo) — devices cohort
  { symbol: "SYK",   finnhub: "SYK",   purpose: "isrg_cohort",       needsMetrics: true },  // Stryker — devices cohort
  { symbol: "BSX",   finnhub: "BSX",   purpose: "isrg_cohort",       needsMetrics: true },  // Boston Scientific — devices cohort
  { symbol: "IHI",   finnhub: "IHI",   purpose: "isrg_devices_factor" },                    // iShares U.S. Medical Devices ETF
  { symbol: "VMC",   finnhub: "VMC",   purpose: "mlm_cohort",        needsMetrics: true },  // Vulcan Materials — the ONLY true like-for-like US aggregates pure play (50% cohort weight)
  { symbol: "CRH",   finnhub: "CRH",   purpose: "mlm_cohort",        needsMetrics: true },  // CRH plc — building materials breadth check (25%)
  { symbol: "EXP",   finnhub: "EXP",   purpose: "mlm_cohort",        needsMetrics: true },  // Eagle Materials — aggregates/cement breadth check (25%)
  { symbol: "XLB",   finnhub: "XLB",   purpose: "mlm_materials_factor" },                   // Materials Select Sector SPDR — materials factor proxy
  { symbol: "DASH",  finnhub: "DASH",  purpose: "uber_cohort",       needsMetrics: true },  // DoorDash — the only other scaled, profitable US marketplace (50% cohort weight)
  { symbol: "LYFT",  finnhub: "LYFT",  purpose: "uber_cohort",       needsMetrics: true },  // Lyft — US mobility pure play (25%)
  { symbol: "GRAB",  finnhub: "GRAB",  purpose: "uber_cohort",       needsMetrics: true },  // Grab — mobility + delivery super-app, closest business-model analog (25%)
  { symbol: "XLY",   finnhub: "XLY",   purpose: "uber_consumer_factor" },                   // Consumer Discretionary Select Sector SPDR — consumer factor proxy
  { symbol: "XOM",   finnhub: "XOM",   purpose: "cvx_twin",          needsMetrics: true },  // ExxonMobil — CVX twin (the only other US super-major; Stabroek partner)
  { symbol: "SHEL",  finnhub: "SHEL",  purpose: "cvx_reference",     needsMetrics: true },  // Shell ADR — structural-discount REFERENCE only, never scored
  { symbol: "TTE",   finnhub: "TTE",   purpose: "cvx_reference",     needsMetrics: true },  // TotalEnergies ADR — structural-discount REFERENCE only, never scored
  { symbol: "XLE",   finnhub: "XLE",   purpose: "cvx_energy_factor" },                      // Energy Select Sector SPDR — energy factor proxy
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJSON(url, label) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return await resp.json();
  } catch (e) {
    console.error(`    [${label}] ${e.message}`);
    return null;
  }
}

// ─── STAGE 1: FINNHUB QUOTES (60 calls/min — plenty for 14 symbols) ────────
// Each call returns: c (current), d (change $), dp (change %), h (high), l (low), o (open), pc (prev close)
// Plus we get basic financials from /stock/metric for PE, PB, div yield, 52w range, ROI, op margin.
async function fetchQuotes() {
  if (!FK) return {};
  const result = {};

  for (const sym of SYMBOLS) {
    console.log(`  [FH] ${sym.symbol}: quote + metrics...`);

    const q = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${sym.finnhub}&token=${FK}`,
      `FH quote ${sym.symbol}`
    );

    const m = await fetchJSON(
      `https://finnhub.io/api/v1/stock/metric?symbol=${sym.finnhub}&metric=all&token=${FK}`,
      `FH metrics ${sym.symbol}`
    );

    const metrics = m?.metric || {};
    const price = q?.c ?? null;
    const w52h = metrics["52WeekHigh"] ?? null;
    const w52l = metrics["52WeekLow"] ?? null;

    result[sym.symbol] = {
      price: price,
      change_pct: q?.dp != null ? +q.dp.toFixed(2) : 0,
      change_dollar: q?.d ?? 0,
      open: q?.o ?? null,
      high: q?.h ?? null,
      low: q?.l ?? null,
      previous_close: q?.pc ?? null,
      week52_high: w52h,
      week52_low: w52l,
      week52_position_pct: (w52h && w52l && price)
        ? +((price - w52l) / (w52h - w52l) * 100).toFixed(1) : null,
      pe: metrics["peBasicExclExtraTTM"] ?? metrics["peTTM"] ?? null,
      pb: metrics["pbQuarterly"] ?? metrics["pbAnnual"] ?? null,
      dividend_yield: metrics["dividendYieldIndicatedAnnual"] ?? null,
      beta: metrics["beta"] ?? null,
      market_cap: metrics["marketCapitalization"] ?? null,
      // Fundamentals (used primarily by LIN/LHX/TMO/MSFT/NOW strategic layers).
      // ROI is closest Finnhub proxy for ROCE (no direct ROCE field).
      roi: metrics["roiTTM"] ?? metrics["roiAnnual"] ?? null,
      operating_margin: metrics["operatingMarginTTM"] ?? metrics["operatingMarginAnnual"] ?? null,
    };

    const p = result[sym.symbol];
    console.log(`  [FH] ✓ ${sym.symbol}: $${p.price ?? "—"} (${p.change_pct >= 0 ? "+" : ""}${p.change_pct}%) 52w:${p.week52_position_pct ?? "—"}%`);

    await sleep(1100); // Finnhub free = 60/min, so ~1 call/sec is safe
  }

  return result;
}

// ─── STAGE 1b: AUXILIARY QUOTES ─────────────────────────────────────────────
// Quote-only by default. Symbols with needsMetrics: true also fetch P/E
// (used by LIN peer valuation, MSFT cohort valuation, LHX cohort valuation,
// TMO peer valuation, NOW cohort valuation).
async function fetchAuxQuotes() {
  if (!FK) return {};
  const result = {};

  for (const sym of AUX_SYMBOLS) {
    const wantMetrics = sym.needsMetrics === true;
    console.log(`  [FH-AUX] ${sym.symbol} (${sym.purpose}): quote${wantMetrics ? " + metrics" : ""}...`);

    const q = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${sym.finnhub}&token=${FK}`,
      `FH aux ${sym.symbol}`
    );

    if (q?.c) {
      result[sym.symbol] = {
        price: q.c,
        change_pct: q.dp != null ? +q.dp.toFixed(2) : 0,
        previous_close: q.pc ?? null,
      };

      if (wantMetrics) {
        await sleep(1100);
        const m = await fetchJSON(
          `https://finnhub.io/api/v1/stock/metric?symbol=${sym.finnhub}&metric=all&token=${FK}`,
          `FH aux-metrics ${sym.symbol}`
        );
        const metrics = m?.metric || {};
        result[sym.symbol].pe = metrics["peBasicExclExtraTTM"] ?? metrics["peTTM"] ?? null;
      }

      const peStr = result[sym.symbol].pe ? ` PE=${result[sym.symbol].pe}x` : "";
      console.log(`  [FH-AUX] ✓ ${sym.symbol}: $${q.c} (${q.dp >= 0 ? "+" : ""}${q.dp?.toFixed(2)}%)${peStr}`);
    } else {
      console.log(`  [FH-AUX] ✗ ${sym.symbol}: no quote returned`);
    }

    await sleep(1100);
  }

  return result;
}

// ─── STAGE 2: TWELVEDATA TECHNICALS ─────────────────────────────────────────
// Free tier: 8 calls/min. 3 calls per symbol (RSI + SMA50 + SMA200) = 42 total.
// Pacing: 8s between each set of 3, so ~8 calls/min.
async function fetchTechnicals(quotes) {
  if (!TD_KEY) return {};
  const result = {};

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    console.log(`  [TD] ${sym.symbol} (${i+1}/${SYMBOLS.length}): RSI + SMA...`);
    const t = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };

    // RSI(14)
    const rsiData = await fetchJSON(
      `https://api.twelvedata.com/rsi?symbol=${sym.td}&interval=1day&time_period=14&outputsize=1&apikey=${TD_KEY}`,
      `TD RSI ${sym.symbol}`
    );
    if (rsiData?.values?.[0]?.rsi) {
      t.rsi14 = +parseFloat(rsiData.values[0].rsi).toFixed(2);
    }

    await sleep(8000);

    // SMA(50)
    const sma50Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=50&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA50 ${sym.symbol}`
    );
    if (sma50Data?.values?.[0]?.sma) {
      t.sma50 = +parseFloat(sma50Data.values[0].sma).toFixed(2);
    }

    await sleep(8000);

    // SMA(200)
    const sma200Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=200&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA200 ${sym.symbol}`
    );
    if (sma200Data?.values?.[0]?.sma) {
      t.sma200 = +parseFloat(sma200Data.values[0].sma).toFixed(2);
    }

    // Compute MA signal using Finnhub price
    const price = quotes[sym.symbol]?.price;
    if (price && t.sma50 && t.sma200) {
      if (price > t.sma50 && price > t.sma200 && t.sma50 > t.sma200) t.ma_signal = "above_both_golden";
      else if (price > t.sma50 && price > t.sma200) t.ma_signal = "above_both";
      else if (price > t.sma50) t.ma_signal = "above_50_below_200";
      else if (price > t.sma200) t.ma_signal = "above_200_below_50";
      else if (t.sma50 < t.sma200) t.ma_signal = "below_both_death";
      else t.ma_signal = "below_both";
    }

    console.log(`  [TD] ✓ ${sym.symbol}: RSI=${t.rsi14 ?? "—"}, SMA50=${t.sma50 ?? "—"}, SMA200=${t.sma200 ?? "—"}, MA=${t.ma_signal}`);
    result[sym.symbol] = t;

    if (i < SYMBOLS.length - 1) await sleep(8000);
  }

  return result;
}

// ─── STAGE 2b: ALPACA CANDLE FALLBACK ────────────────────────────────────────
// For symbols TwelveData can't handle, get historical bars from Alpaca and compute locally.
// Alpaca covers ALL US-exchange-listed securities including ADRs.
const ALPACA_KEY    = process.env.ALPK;
const ALPACA_SECRET = process.env.ALPS;

// v4.15: sip → iex fallback (see header). All Alpaca bars calls go through here.
let alpacaIexNoticeShown = false;
async function alpacaBarsFetch(url) {
  const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };
  let resp = await fetch(url, { headers });
  if (resp.status === 403 && url.includes("feed=sip")) {
    if (!alpacaIexNoticeShown) {
      console.log("    [ALPACA] 403 on feed=sip — retrying with feed=iex (key has no SIP entitlement).");
      alpacaIexNoticeShown = true;
    }
    resp = await fetch(url.replace("feed=sip", "feed=iex"), { headers });
  }
  return resp;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return +(slice.reduce((a, b) => a + b, 0) / period).toFixed(2);
}

async function fillTechnicalsFromAlpaca(technicals, quotes) {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA] No keys — skipping candle fallback");
    return;
  }

  const gaps = SYMBOLS.filter(s => technicals[s.symbol]?.rsi14 == null);
  if (gaps.length === 0) { console.log("  [ALPACA] No gaps — all symbols have RSI"); return; }

  console.log(`  [ALPACA] Filling ${gaps.length} gaps: ${gaps.map(s => s.symbol).join(", ")}`);

  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 365).toISOString().split("T")[0];

  for (const sym of gaps) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`
      );

      if (!resp.ok) {
        console.log(`    ✗ ${sym.symbol}: Alpaca ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data = await resp.json();
      const bars = data.bars || [];

      if (bars.length < 15) {
        console.log(`    ✗ ${sym.symbol}: only ${bars.length} bars (need 15+)`);
        continue;
      }

      const closes = bars.map(b => b.c);
      const rsi = computeRSI(closes);
      const sma50 = computeSMA(closes, 50);
      const sma200 = computeSMA(closes, 200);

      if (!technicals[sym.symbol]) technicals[sym.symbol] = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };
      const t = technicals[sym.symbol];

      if (rsi != null) t.rsi14 = rsi;
      if (sma50 != null && t.sma50 == null) t.sma50 = sma50;
      if (sma200 != null && t.sma200 == null) t.sma200 = sma200;

      const price = quotes[sym.symbol]?.price;
      if (price && t.sma50 && t.sma200) {
        if (price > t.sma50 && price > t.sma200 && t.sma50 > t.sma200) t.ma_signal = "above_both_golden";
        else if (price > t.sma50 && price > t.sma200) t.ma_signal = "above_both";
        else if (price > t.sma50) t.ma_signal = "above_50_below_200";
        else if (price > t.sma200) t.ma_signal = "above_200_below_50";
        else if (t.sma50 < t.sma200) t.ma_signal = "below_both_death";
        else t.ma_signal = "below_both";
      }

      console.log(`    ✓ ${sym.symbol}: RSI=${t.rsi14 ?? "—"}, SMA50=${t.sma50 ?? "—"}, SMA200=${t.sma200 ?? "—"}, MA=${t.ma_signal} [${bars.length} bars]`);
    } catch (e) {
      console.log(`    ✗ ${sym.symbol}: ${e.message}`);
    }

    await sleep(500);
  }
}

// ─── STAGE 2c: ALPACA 52-WEEK FIX ───────────────────────────────────────────
// Finnhub's 52w data is wrong for ADRs. Compute actual 52w high/low from Alpaca bars.
async function fix52WeekFromAlpaca(quotes) {
  if (!ALPACA_KEY || !ALPACA_SECRET) { console.log("  [ALPACA] No keys — skipping 52w fix"); return; }

  const suspects = SYMBOLS.filter(sym => {
    const q = quotes[sym.symbol];
    if (!q?.price || !q.week52_high || !q.week52_low) return true;
    const pct = ((q.price - q.week52_low) / (q.week52_high - q.week52_low)) * 100;
    return pct < -10 || pct > 110 || q.week52_low <= 0;
  });

  if (suspects.length === 0) { console.log("  [ALPACA 52W] All 52w data looks valid"); return; }
  console.log(`  [ALPACA 52W] Fixing ${suspects.length} symbols: ${suspects.map(s => s.symbol).join(", ")}`);

  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 365).toISOString().split("T")[0];

  for (const sym of suspects) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym.symbol}: Alpaca ${resp.status}`); continue; }

      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 20) { console.log(`    ✗ ${sym.symbol}: only ${bars.length} bars`); continue; }

      const highs = bars.map(b => b.h);
      const lows = bars.map(b => b.l);
      const w52High = Math.max(...highs);
      const w52Low = Math.min(...lows);
      const price = quotes[sym.symbol]?.price;

      if (w52High > 0 && w52Low > 0 && price) {
        const pct = +((price - w52Low) / (w52High - w52Low) * 100).toFixed(1);
        quotes[sym.symbol].week52_high = +w52High.toFixed(2);
        quotes[sym.symbol].week52_low = +w52Low.toFixed(2);
        quotes[sym.symbol].week52_position_pct = pct;
        console.log(`    ✓ ${sym.symbol}: 52w H=$${w52High.toFixed(2)} L=$${w52Low.toFixed(2)} Position=${pct}% [${bars.length} bars]`);
      }
    } catch (e) {
      console.log(`    ✗ ${sym.symbol}: ${e.message}`);
    }
    await sleep(500);
  }
}

// ─── STAGE 3c: ALPACA HISTORICAL RETURNS (LIN v3 tactical extras + factor flow) ──
// Pulls daily closes for LIN, SPY, QUAL and computes:
//   - SPY 10-trading-day return → tactical_extras.spy_10d_drawdown_pct (negative if drawdown)
//   - LIN 10d return - SPY 10d return → tactical_extras.lin_vs_spy_10d_pp
//   - QUAL 30d return - SPY 30d return → factor_flow.qual_vs_spy_30d_pp
// 60 calendar days back gives ~42 trading days, comfortably above the 30+ needed.
// Note: SPY is no longer a scored holding as of v4.12, but it remains the market
// benchmark for factor-flow spreads and is still fetched directly from Alpaca here.
async function fetchLINHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-LIN] No keys — skipping LIN historical returns");
    return null;
  }

  console.log("  [ALPACA-LIN] Fetching LIN/SPY/QUAL bars for v3 spreads...");
  const symbols = ["LIN", "SPY", "QUAL"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  // Return over the last N trading days
  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const linRet10 = retNDays(closes.LIN, 10);
  const spyRet10 = retNDays(closes.SPY, 10);
  const qualRet30 = retNDays(closes.QUAL, 30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const result = {
    spy_10d_drawdown_pct: spyRet10,
    lin_vs_spy_10d_pp: (linRet10 != null && spyRet10 != null) ? +(linRet10 - spyRet10).toFixed(3) : null,
    qual_vs_spy_30d_pp: (qualRet30 != null && spyRet30 != null) ? +(qualRet30 - spyRet30).toFixed(3) : null,
    // For console / debug:
    _debug: { linRet10, spyRet10, qualRet30, spyRet30 },
  };

  console.log(`  [ALPACA-LIN] ✓ SPY 10d=${spyRet10 != null ? (spyRet10 >= 0 ? "+" : "") + spyRet10 + "%" : "—"} | LIN-SPY 10d=${result.lin_vs_spy_10d_pp != null ? (result.lin_vs_spy_10d_pp >= 0 ? "+" : "") + result.lin_vs_spy_10d_pp + "pp" : "—"} | QUAL-SPY 30d=${result.qual_vs_spy_30d_pp != null ? (result.qual_vs_spy_30d_pp >= 0 ? "+" : "") + result.qual_vs_spy_30d_pp + "pp" : "—"}`);
  return result;
}

// ─── STAGE 3d: ALPACA HISTORICAL RETURNS (MSFT cohort rotation pressure) ─────
// Pulls daily closes for MSFT + cohort (GOOGL, META, AAPL) and computes:
//   - MSFT 30d return
//   - Cohort avg 30d return (avg of GOOGL/META/AAPL where available)
//   - rotation_pressure_pp = MSFT 30d - cohort avg 30d
//   - rotation_pressure_active = TRUE if rotation_pressure_pp < -5
// This is the SIGNATURE MSFT tactical setup — capital rotating away from the
// highest-quality AI infra name into higher-beta AI names (NVDA/PLTR/AMD)
// historically a buy setup, not a warning.
async function fetchMSFTHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-MSFT] No keys — skipping MSFT cohort returns");
    return null;
  }

  console.log("  [ALPACA-MSFT] Fetching MSFT/GOOGL/META/AAPL bars for cohort rotation...");
  const symbols = ["MSFT", "GOOGL", "META", "AAPL"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const msftRet30  = retNDays(closes.MSFT, 30);
  const googlRet30 = retNDays(closes.GOOGL, 30);
  const metaRet30  = retNDays(closes.META, 30);
  const aaplRet30  = retNDays(closes.AAPL, 30);

  const cohortRets = [googlRet30, metaRet30, aaplRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (msftRet30 != null && cohortAvg != null)
    ? +(msftRet30 - cohortAvg).toFixed(3)
    : null;

  const result = {
    msft_30d_return_pct:        msftRet30,
    googl_30d_return_pct:       googlRet30,
    meta_30d_return_pct:        metaRet30,
    aapl_30d_return_pct:        aaplRet30,
    cohort_avg_30d_return_pct:  cohortAvg,
    rotation_pressure_pp:       rotationPp,
    rotation_pressure_active:   rotationPp != null && rotationPp < -5,
    cohort_count:               cohortRets.length,
  };

  const activeStr = result.rotation_pressure_active ? " [ACTIVE — buy setup]" : "";
  console.log(`  [ALPACA-MSFT] ✓ MSFT 30d=${msftRet30 != null ? (msftRet30 >= 0 ? "+" : "") + msftRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr}`);
  return result;
}

// ─── STAGE 3e: ALPACA HISTORICAL RETURNS (LHX defense-cohort rotation + ITA factor) ──
// Pulls daily closes for LHX + cohort (LMT, NOC, RTX, GD) + ITA + SPY and computes:
//   - LHX 30d return
//   - Cohort avg 30d return (avg of LMT/NOC/RTX/GD where available)
//   - cohort_rotation_pp = LHX 30d - cohort avg 30d
//   - cohort_rotation_active = TRUE if cohort_rotation_pp < -5 (LHX lagging primes)
//   - ita_vs_spy_30d_pp = ITA 30d - SPY 30d (defense sector factor flow)
// LHX is the smallest of the Big 5 primes; rotation INTO larger primes (out of LHX)
// historically a setup, not a warning. ITA > SPY = defense bid active = positional positive.
async function fetchLHXHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-LHX] No keys — skipping LHX historical returns");
    return null;
  }

  console.log("  [ALPACA-LHX] Fetching LHX/LMT/NOC/RTX/GD/ITA/SPY bars for cohort rotation + defense factor...");
  const symbols = ["LHX", "LMT", "NOC", "RTX", "GD", "ITA", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const lhxRet30 = retNDays(closes.LHX, 30);
  const lmtRet30 = retNDays(closes.LMT, 30);
  const nocRet30 = retNDays(closes.NOC, 30);
  const rtxRet30 = retNDays(closes.RTX, 30);
  const gdRet30  = retNDays(closes.GD,  30);
  const itaRet30 = retNDays(closes.ITA, 30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const cohortRets = [lmtRet30, nocRet30, rtxRet30, gdRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (lhxRet30 != null && cohortAvg != null)
    ? +(lhxRet30 - cohortAvg).toFixed(3)
    : null;

  const itaVsSpyPp = (itaRet30 != null && spyRet30 != null)
    ? +(itaRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    lhx_30d_return_pct:        lhxRet30,
    lmt_30d_return_pct:        lmtRet30,
    noc_30d_return_pct:        nocRet30,
    rtx_30d_return_pct:        rtxRet30,
    gd_30d_return_pct:         gdRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_rotation_pp:        rotationPp,
    cohort_rotation_active:    rotationPp != null && rotationPp < -5,
    cohort_count:              cohortRets.length,
    ita_30d_return_pct:        itaRet30,
    spy_30d_return_pct:        spyRet30,
    ita_vs_spy_30d_pp:         itaVsSpyPp,
  };

  const activeStr = result.cohort_rotation_active ? " [ACTIVE — buy setup]" : "";
  const itaStr = itaVsSpyPp == null ? "—"
    : itaVsSpyPp > 1 ? `defense bid active (+${itaVsSpyPp}pp)`
    : itaVsSpyPp < -1 ? `defense lagging (${itaVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-LHX] ✓ LHX 30d=${lhxRet30 != null ? (lhxRet30 >= 0 ? "+" : "") + lhxRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | ITA-SPY 30d: ${itaStr}`);
  return result;
}

// ─── STAGE 3f: ALPACA HISTORICAL RETURNS (TMO biotech overlay + DHR peer) ────
// Pulls daily closes for TMO, XBI, DHR over a 150-day window (covers 90d return).
// Computes:
//   - TMO 30d return
//   - XBI 30d return + 90d return (biotech funding sentiment, leads TMO bookings 2-3Q)
//   - DHR 30d return (bioprocessing peer sympathy)
//   - tmo_vs_dhr_30d_pp = TMO 30d - DHR 30d (peer rotation read)
async function fetchTMOHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-TMO] No keys — skipping TMO historical returns");
    return null;
  }

  console.log("  [ALPACA-TMO] Fetching TMO/XBI/DHR bars (150d window for XBI 90d return)...");
  const symbols = ["TMO", "XBI", "DHR"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 150).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=150&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const tmoRet30 = retNDays(closes.TMO, 30);
  const xbiRet30 = retNDays(closes.XBI, 30);
  const xbiRet90 = retNDays(closes.XBI, 90);
  const dhrRet30 = retNDays(closes.DHR, 30);

  const tmoVsDhrPp = (tmoRet30 != null && dhrRet30 != null)
    ? +(tmoRet30 - dhrRet30).toFixed(3)
    : null;

  const result = {
    tmo_30d_return_pct: tmoRet30,
    xbi_30d_return_pct: xbiRet30,
    xbi_90d_return_pct: xbiRet90,
    dhr_30d_return_pct: dhrRet30,
    tmo_vs_dhr_30d_pp:  tmoVsDhrPp,
  };

  const xbi90Str = xbiRet90 == null ? "—"
    : xbiRet90 > 10 ? `biotech thawing (+${xbiRet90}%)`
    : xbiRet90 < -10 ? `funding frozen (${xbiRet90}%)`
    : `mixed (${xbiRet90 >= 0 ? "+" : ""}${xbiRet90}%)`;
  console.log(`  [ALPACA-TMO] ✓ TMO 30d=${tmoRet30 != null ? (tmoRet30 >= 0 ? "+" : "") + tmoRet30 + "%" : "—"} | XBI 30d=${xbiRet30 != null ? (xbiRet30 >= 0 ? "+" : "") + xbiRet30 + "%" : "—"} | XBI 90d: ${xbi90Str} | DHR 30d=${dhrRet30 != null ? (dhrRet30 >= 0 ? "+" : "") + dhrRet30 + "%" : "—"} | TMO-DHR Δ=${tmoVsDhrPp != null ? (tmoVsDhrPp >= 0 ? "+" : "") + tmoVsDhrPp + "pp" : "—"}`);
  return result;
}

// ─── STAGE 3g: ALPACA HISTORICAL RETURNS (NOW SaaS-cohort rotation + IGV factor) ──
// Pulls daily closes for NOW + cohort (CRM, WDAY, ADBE) + IGV + SPY and computes:
//   - NOW 30d return
//   - Cohort avg 30d return (avg of CRM/WDAY/ADBE where available)
//   - rotation_pressure_pp = NOW 30d - cohort avg 30d
//   - rotation_pressure_active = TRUE if rotation_pressure_pp < -5 (NOW lagging SaaS cohort)
//   - igv_vs_spy_30d_pp = IGV 30d - SPY 30d (software sector factor flow)
// NOW is the highest-quality enterprise-SaaS compounder; rotation INTO higher-beta
// AI/SaaS names (out of NOW) historically a buy setup, not a warning.
// IGV > SPY = software bid active = positional positive.
async function fetchNOWHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-NOW] No keys — skipping NOW historical returns");
    return null;
  }

  console.log("  [ALPACA-NOW] Fetching NOW/CRM/WDAY/ADBE/IGV/SPY bars for cohort rotation + software factor...");
  const symbols = ["NOW", "CRM", "WDAY", "ADBE", "IGV", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const nowRet30  = retNDays(closes.NOW,  30);
  const crmRet30  = retNDays(closes.CRM,  30);
  const wdayRet30 = retNDays(closes.WDAY, 30);
  const adbeRet30 = retNDays(closes.ADBE, 30);
  const igvRet30  = retNDays(closes.IGV,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const cohortRets = [crmRet30, wdayRet30, adbeRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (nowRet30 != null && cohortAvg != null)
    ? +(nowRet30 - cohortAvg).toFixed(3)
    : null;

  const igvVsSpyPp = (igvRet30 != null && spyRet30 != null)
    ? +(igvRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    now_30d_return_pct:        nowRet30,
    crm_30d_return_pct:        crmRet30,
    wday_30d_return_pct:       wdayRet30,
    adbe_30d_return_pct:       adbeRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    rotation_pressure_pp:      rotationPp,
    rotation_pressure_active:  rotationPp != null && rotationPp < -5,
    cohort_count:              cohortRets.length,
    igv_30d_return_pct:        igvRet30,
    spy_30d_return_pct:        spyRet30,
    igv_vs_spy_30d_pp:         igvVsSpyPp,
  };

  const activeStr = result.rotation_pressure_active ? " [ACTIVE — buy setup]" : "";
  const igvStr = igvVsSpyPp == null ? "—"
    : igvVsSpyPp > 1 ? `software bid active (+${igvVsSpyPp}pp)`
    : igvVsSpyPp < -1 ? `software lagging (${igvVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-NOW] ✓ NOW 30d=${nowRet30 != null ? (nowRet30 >= 0 ? "+" : "") + nowRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | IGV-SPY 30d: ${igvStr}`);
  return result;
}

// ─── STAGE 3h: MA TWIN/DUOPOLY HISTORICAL RETURNS (v4.14) ────────────────────
// Pulls daily closes for MA, V, SPY and computes:
//   • twin_spread_pp        = MA 30d − V 30d (twin dislocation read — duopoly
//                             twins rarely diverge; <-4pp without an MA-specific
//                             fundamental break = buy setup)
//   • duopoly_vs_spy_pp     = (MA+V avg 30d) − SPY 30d (disruption-fear gauge)
//   • disruption_fear_regime categorical — the V8.1 regime-gate input for MA:
//       acute <-8pp | elevated -8..-5pp | neutral -5..+3pp | absent >+3pp
async function fetchMAHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-MA] No keys — skipping MA historical returns");
    return null;
  }

  console.log("  [ALPACA-MA] Fetching MA/V/SPY bars for twin spread + duopoly fear regime...");
  const symbols = ["MA", "V", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const maRet30  = retNDays(closes.MA,  30);
  const vRet30   = retNDays(closes.V,   30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const twinSpreadPp = (maRet30 != null && vRet30 != null)
    ? +(maRet30 - vRet30).toFixed(3)
    : null;

  const duopolyAvg = (maRet30 != null && vRet30 != null)
    ? +((maRet30 + vRet30) / 2).toFixed(3)
    : null;

  const duopolyVsSpyPp = (duopolyAvg != null && spyRet30 != null)
    ? +(duopolyAvg - spyRet30).toFixed(3)
    : null;

  const fearRegime = duopolyVsSpyPp == null ? null
    : duopolyVsSpyPp < -8 ? "acute"
    : duopolyVsSpyPp < -5 ? "elevated"
    : duopolyVsSpyPp <= 3 ? "neutral"
    : "absent";

  const result = {
    ma_30d_return_pct:          maRet30,
    v_30d_return_pct:           vRet30,
    spy_30d_return_pct:         spyRet30,
    twin_spread_pp:             twinSpreadPp,
    twin_dislocation_active:    twinSpreadPp != null && twinSpreadPp < -4,
    duopoly_avg_30d_return_pct: duopolyAvg,
    duopoly_vs_spy_pp:          duopolyVsSpyPp,
    disruption_fear_regime:     fearRegime,
  };

  const dislocStr = result.twin_dislocation_active ? " [DISLOCATION — buy setup]" : "";
  const regimeStr = fearRegime == null ? "—"
    : fearRegime === "acute" ? `ACUTE fear regime (${duopolyVsSpyPp}pp — buy setup)`
    : fearRegime === "elevated" ? `elevated fear (${duopolyVsSpyPp}pp)`
    : fearRegime === "absent" ? `fear absent (+${duopolyVsSpyPp}pp)`
    : "neutral";
  console.log(`  [ALPACA-MA] ✓ MA 30d=${maRet30 != null ? (maRet30 >= 0 ? "+" : "") + maRet30 + "%" : "—"} | V 30d=${vRet30 != null ? (vRet30 >= 0 ? "+" : "") + vRet30 + "%" : "—"} | twin Δ=${twinSpreadPp != null ? (twinSpreadPp >= 0 ? "+" : "") + twinSpreadPp + "pp" : "—"}${dislocStr} | duopoly-SPY: ${regimeStr}`);
  return result;
}

// ─── STAGE 3i: ISRG COHORT HISTORICAL RETURNS (v4.14) ────────────────────────
// Pulls daily closes for ISRG, MDT, SYK, BSX, IHI, SPY and computes:
//   • cohort_rotation_pp = ISRG 30d − MDT/SYK/BSX avg 30d (fear rotation read —
//     <-6pp without procedure-share evidence = historically a buy setup)
//   • ihi_vs_spy_30d_pp  = devices sector factor bid — the V8.1 regime-gate
//     input for ISRG (bid_active >+1pp | neutral ±1pp | bid_absent <-1pp)
async function fetchISRGHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-ISRG] No keys — skipping ISRG historical returns");
    return null;
  }

  console.log("  [ALPACA-ISRG] Fetching ISRG/MDT/SYK/BSX/IHI/SPY bars for cohort rotation + devices factor...");
  const symbols = ["ISRG", "MDT", "SYK", "BSX", "IHI", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const isrgRet30 = retNDays(closes.ISRG, 30);
  const mdtRet30  = retNDays(closes.MDT,  30);
  const sykRet30  = retNDays(closes.SYK,  30);
  const bsxRet30  = retNDays(closes.BSX,  30);
  const ihiRet30  = retNDays(closes.IHI,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const cohortRets = [mdtRet30, sykRet30, bsxRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (isrgRet30 != null && cohortAvg != null)
    ? +(isrgRet30 - cohortAvg).toFixed(3)
    : null;

  const ihiVsSpyPp = (ihiRet30 != null && spyRet30 != null)
    ? +(ihiRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    isrg_30d_return_pct:       isrgRet30,
    mdt_30d_return_pct:        mdtRet30,
    syk_30d_return_pct:        sykRet30,
    bsx_30d_return_pct:        bsxRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_rotation_pp:        rotationPp,
    cohort_rotation_active:    rotationPp != null && rotationPp < -6,
    cohort_count:              cohortRets.length,
    ihi_30d_return_pct:        ihiRet30,
    spy_30d_return_pct:        spyRet30,
    ihi_vs_spy_30d_pp:         ihiVsSpyPp,
  };

  const activeStr = result.cohort_rotation_active ? " [ACTIVE — buy setup]" : "";
  const ihiStr = ihiVsSpyPp == null ? "—"
    : ihiVsSpyPp > 1 ? `devices bid active (+${ihiVsSpyPp}pp)`
    : ihiVsSpyPp < -1 ? `devices lagging (${ihiVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-ISRG] ✓ ISRG 30d=${isrgRet30 != null ? (isrgRet30 >= 0 ? "+" : "") + isrgRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | IHI-SPY 30d: ${ihiStr}`);
  return result;
}

// ─── MLM PUBLIC-CONSTRUCTION-FUNDING REGIME (v4.18) ─────────────────────────
// Human-maintained. No API publishes this; review when the statute changes.
//
// MLM_FEDERAL_AUTHORIZATION_STATUS — one of:
//   "multiyear_enacted_at_or_above_iija"  -> engine regime "funded"   (25/40/35)
//   "multiyear_enacted_below_iija"        -> engine regime "unfunded" (15/30/55)
//   "short_term_extension"                -> engine regime "neutral"  (20/35/45)
//   "pending_no_action"                   -> engine regime "neutral"  (20/35/45)
//   "lapsed"                              -> engine regime "unfunded" (15/30/55)
//
// CALIBRATION: "short_term_extension" is the BASE CASE and maps to NEUTRAL, NOT
// to a contraction. Twelve extensions followed TEA-21's expiration and ten
// followed SAFETEA-LU's - short-term patches are the historical rule. Mapping
// the single most likely outcome to a downgrade would print a false trim for
// months. Only a multiyear bill enacted materially BELOW IIJA levels, or an
// outright lapse with no extension, is a genuine negative.
//
// Current setting rationale (August 2026): IIJA authorizations expire
// 2026-09-30. H.R. 8870 was ordered reported by House T&I in May 2026 but has
// not been enacted, and MLM management indicated on the Q2 call that a
// short-term extension appears likely. State DOT budgets in MLM's core markets
// are at historically elevated levels but are not accelerating further, so the
// secondary read is "stable" and does not move the regime off neutral.
const MLM_FEDERAL_AUTHORIZATION_STATUS = "short_term_extension";
const MLM_STATE_DOT_BUDGET_TREND       = "stable";   // accelerating | stable | contracting
const MLM_AUTHORIZATION_EXPIRY         = "2026-09-30";

function mlmFundingRegime() {
  const days = Math.round(
    (new Date(MLM_AUTHORIZATION_EXPIRY + "T00:00:00Z") - new Date()) / 86400000
  );
  const status = MLM_FEDERAL_AUTHORIZATION_STATUS;
  const trend = MLM_STATE_DOT_BUDGET_TREND;

  // Staleness guard. A human-maintained constant that nobody reviews is worse
  // than no constant at all, because it looks authoritative. If the expiry has
  // passed and the status still reads as an unresolved state, say so loudly.
  const unresolved = status === "short_term_extension" || status === "pending_no_action";
  if (days < 0 && unresolved) {
    console.log(`  [MLM-REGIME] STALE CONFIG: MLM_AUTHORIZATION_EXPIRY (${MLM_AUTHORIZATION_EXPIRY}) passed ${-days}d ago`);
    console.log(`  [MLM-REGIME]    but MLM_FEDERAL_AUTHORIZATION_STATUS still reads "${status}". Congress has acted or the`);
    console.log(`  [MLM-REGIME]    extension has been renewed - either way this constant needs a human review NOW.`);
    console.log(`  [MLM-REGIME]    MLM is scoring against a regime that may no longer exist.`);
  } else if (days >= 0 && days <= 30 && unresolved) {
    console.log(`  [MLM-REGIME] Authorization expires in ${days}d and status is still "${status}" - review shortly.`);
  }
  return { status, trend, days };
}

// ─── STAGE 3j: MLM AGGREGATES-COHORT HISTORICAL RETURNS (v4.17) ─────────────
// Pulls daily closes for MLM, VMC, CRH, EXP, XLB, SPY and computes:
//   • peer_rotation_pp   = MLM 30d − WEIGHTED cohort 30d (VMC .50 / CRH .25 /
//     EXP .25). <-5pp WITHOUT an organic-volume or mix-adjusted-pricing print
//     confirming weakness = buy setup.
//   • vmc_spread_30d_pp  = MLM 30d − VMC 30d, carried SEPARATELY. VMC is the
//     twin; the 3-name cohort is the breadth check. The twin read is the
//     flagship tactical signal and must not be diluted inside an average.
//   • xlb_vs_spy_30d_pp  = materials sector factor bid — the tactical overlay
//     for MLM (bid_active >+1pp | neutral ±1pp | bid_absent <-1pp)
// Threshold note: -5pp here vs RDDT's -8pp. MLM beta is 1.11, not 1.94, so a
// 5pp/30d divergence between the two dominant US aggregates franchises is real
// information rather than noise.
// ★ WEIGHTED average — unlike every other cohort in this file, which use simple
//   means. Weights renormalize over whichever peers actually resolved, so a
//   missing CRH leg does not silently reweight VMC to 67%.
const MLM_PEER_WEIGHTS = { VMC: 0.50, CRH: 0.25, EXP: 0.25 };

function mlmWeightedCohort(rets) {
  const avail = Object.keys(MLM_PEER_WEIGHTS).filter(
    k => rets[k] != null && Number.isFinite(rets[k])
  );
  if (avail.length === 0) return { avg: null, count: 0 };
  const wsum = avail.reduce((a, k) => a + MLM_PEER_WEIGHTS[k], 0);
  const acc = avail.reduce((a, k) => a + rets[k] * MLM_PEER_WEIGHTS[k], 0);
  return { avg: +(acc / wsum).toFixed(3), count: avail.length };
}

async function fetchMLMHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-MLM] No keys — skipping MLM historical returns");
    return null;
  }

  console.log("  [ALPACA-MLM] Fetching MLM/VMC/CRH/EXP/XLB/SPY bars for aggregates-cohort rotation + materials factor...");
  const symbols = ["MLM", "VMC", "CRH", "EXP", "XLB", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const mlmRet30 = retNDays(closes.MLM, 30);
  const vmcRet30 = retNDays(closes.VMC, 30);
  const crhRet30 = retNDays(closes.CRH, 30);
  const expRet30 = retNDays(closes.EXP, 30);
  const xlbRet30 = retNDays(closes.XLB, 30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const { avg: cohortAvg, count: cohortCount } = mlmWeightedCohort({
    VMC: vmcRet30, CRH: crhRet30, EXP: expRet30,
  });

  const rotationPp = (mlmRet30 != null && cohortAvg != null)
    ? +(mlmRet30 - cohortAvg).toFixed(3)
    : null;

  // The twin read — deliberately NOT folded into the cohort average.
  const vmcSpreadPp = (mlmRet30 != null && vmcRet30 != null)
    ? +(mlmRet30 - vmcRet30).toFixed(3)
    : null;

  const xlbVsSpyPp = (xlbRet30 != null && spyRet30 != null)
    ? +(xlbRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    mlm_30d_return_pct:        mlmRet30,
    vmc_30d_return_pct:        vmcRet30,
    crh_30d_return_pct:        crhRet30,
    exp_30d_return_pct:        expRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_weighting:          "VMC .50 / CRH .25 / EXP .25 (renormalized over available)",
    peer_rotation_pp:          rotationPp,
    peer_rotation_active:      rotationPp != null && rotationPp < -5,
    vmc_spread_30d_pp:         vmcSpreadPp,
    vmc_dislocation_active:    vmcSpreadPp != null && vmcSpreadPp < -5,
    cohort_count:              cohortCount,
    xlb_30d_return_pct:        xlbRet30,
    spy_30d_return_pct:        spyRet30,
    xlb_vs_spy_30d_pp:         xlbVsSpyPp,
  };

  const activeStr = result.peer_rotation_active ? " [ACTIVE — buy setup absent an organic-volume/pricing print]" : "";
  const twinStr = vmcSpreadPp == null ? "—"
    : `${vmcSpreadPp >= 0 ? "+" : ""}${vmcSpreadPp}pp${result.vmc_dislocation_active ? " [TWIN DISLOCATION]" : ""}`;
  const xlbStr = xlbVsSpyPp == null ? "—"
    : xlbVsSpyPp > 1 ? `materials bid active (+${xlbVsSpyPp}pp)`
    : xlbVsSpyPp < -1 ? `materials lagging (${xlbVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-MLM] ✓ MLM 30d=${mlmRet30 != null ? (mlmRet30 >= 0 ? "+" : "") + mlmRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} (weighted, ${cohortCount}/3) | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | vs VMC: ${twinStr} | XLB-SPY 30d: ${xlbStr}`);
  return result;
}

// ─── UBER AV-SUPPLY REGIME + DELIVERY HERO STATE (v4.19) ────────────────────
// Human-maintained. No API publishes either value; review on announcements.
//
// UBER_AV_SUPPLY_REGIME_STATE — one of:
//   "partners_adding_uber_supply"      -> engine regime "aggregating"       (25/40/35)
//   "leader_exiting_tail_aggregating"  -> engine regime "contested"         (20/35/45)
//   "pending_unknown"                  -> engine regime "contested"         (20/35/45)
//   "second_tier1_exiting"             -> engine regime "disintermediating" (15/30/55)
//   "exclusive_pipeline_slipping"      -> engine regime "disintermediating" (15/30/55)
// "Tier-1" = an operator running fully driverless, open-to-public service at
// scale (today: Waymo; Tesla partially; Zoox in Las Vegas; Baidu / WeRide /
// Pony.ai outside the US).
//
// CALIBRATION: the current state maps to CONTESTED, NOT to disintermediating.
// Waymo was on Uber in only three of its 15 metros — Phoenix (ended mid-2026),
// Austin and Atlanta (own app from January 2028; the current fleet stays on
// Uber through at least May 2028). The leader going direct was already the base
// case and is in the price, while Zoox, WeRide, Baidu, Nuro/Lucid, Rivian,
// VW/MOIA, Motional and Avride are adding or contracting Uber supply. What
// flips the regime is a SECOND tier-1 operator withdrawing or declining Uber
// supply in a metro where it runs driverless at scale, or Rivian / Lucid-Nuro
// missing a disclosed autonomy milestone.
//
// Review triggers — edit the state AND bump the reviewed date: any tier-1
// own-app launch or partnership exit; a new tier-1 operator going live on Uber
// in a major US metro (candidate: Zoox Las Vegas — announced, not live as of
// 2026-10-25); a Rivian or Lucid/Nuro milestone date; each Uber earnings call
// (next: 2026-11-04).
const UBER_AV_SUPPLY_REGIME_STATE  = "leader_exiting_tail_aggregating";
const UBER_AV_SUPPLY_LAST_REVIEWED = "2026-10-27";
const UBER_AV_SUPPLY_STALE_DAYS    = 90;

// UBER_DH_OFFER_STATE — one of:
//   "acceptance_period" | "threshold_met" | "regulatory_review" | "closed" | "lapsed"
// Scored STANDALONE until "closed" (decision 2026-10-27). Offer: EUR 41.50 cash;
// acceptance period 2026-08-27 → 2026-11-05 24:00 Frankfurt; minimum 50% + 1
// share including Uber's ~24.77% held stake; settlement expected H2 2027 after
// merger-control clearances. Update when the acceptance result is published.
const UBER_DH_OFFER_STATE    = "acceptance_period";
const UBER_DH_ACCEPTANCE_END = "2026-11-05";

// The Q3 2026 print removes Q3 2025 — and its $4.9B tax valuation-allowance
// release — from the trailing window. It is also the one print date the shock
// screen below excludes. Nothing to maintain after it passes: tax_release_in_ttm
// goes FALSE for good.
const UBER_Q3_2026_PRINT_DATE = "2026-11-04";

const UBER_AV_STATE_TO_REGIME = {
  partners_adding_uber_supply:     "aggregating",
  leader_exiting_tail_aggregating: "contested",
  pending_unknown:                 "contested",
  second_tier1_exiting:            "disintermediating",
  exclusive_pipeline_slipping:     "disintermediating",
};
const UBER_DH_STATES = ["acceptance_period", "threshold_met", "regulatory_review", "closed", "lapsed"];

function uberConfigRegime(now = new Date()) {
  const todayISO = now.toISOString().split("T")[0];
  const daysSince = d => Math.round(
    (new Date(todayISO + "T00:00:00Z") - new Date(d + "T00:00:00Z")) / 86400000
  );

  // A typo in a human-maintained constant would otherwise map silently to the
  // engine's CONTESTED fallback and look deliberate. Emit null and say so.
  let avState = UBER_AV_SUPPLY_REGIME_STATE;
  if (!Object.prototype.hasOwnProperty.call(UBER_AV_STATE_TO_REGIME, avState)) {
    console.log(`  [UBER-REGIME] ✗ INVALID CONFIG: UBER_AV_SUPPLY_REGIME_STATE = "${avState}" is not a recognized state — emitting null (engine falls back to CONTESTED). Fix the constant.`);
    avState = null;
  }
  const reviewedDaysAgo = daysSince(UBER_AV_SUPPLY_LAST_REVIEWED);
  if (reviewedDaysAgo > UBER_AV_SUPPLY_STALE_DAYS) {
    console.log(`  [UBER-REGIME] STALE CONFIG: AV supply state last reviewed ${UBER_AV_SUPPLY_LAST_REVIEWED} (${reviewedDaysAgo}d ago, limit ${UBER_AV_SUPPLY_STALE_DAYS}d).`);
    console.log(`  [UBER-REGIME]    UBER is scoring against an AV supply read nobody has checked in a quarter.`);
    console.log(`  [UBER-REGIME]    Review it and bump UBER_AV_SUPPLY_LAST_REVIEWED.`);
  }

  let dhState = UBER_DH_OFFER_STATE;
  if (!UBER_DH_STATES.includes(dhState)) {
    console.log(`  [UBER-DH] ✗ INVALID CONFIG: UBER_DH_OFFER_STATE = "${dhState}" is not a recognized state — emitting null. Fix the constant.`);
    dhState = null;
  }
  const daysPastAcceptance = daysSince(UBER_DH_ACCEPTANCE_END);
  if (dhState === "acceptance_period" && daysPastAcceptance > 0) {
    console.log(`  [UBER-DH] STALE CONFIG: the acceptance period ended ${UBER_DH_ACCEPTANCE_END} (${daysPastAcceptance}d ago) but UBER_DH_OFFER_STATE still reads "acceptance_period".`);
    console.log(`  [UBER-DH]    The result has been published — set threshold_met / regulatory_review / lapsed.`);
  }

  return {
    avState,
    regime: avState ? UBER_AV_STATE_TO_REGIME[avState] : "contested",
    reviewedDaysAgo,
    dhState,
    dhBasisScored: dhState === "closed" ? "pro_forma_dh" : "standalone",
    taxReleaseInTtm: todayISO <= UBER_Q3_2026_PRINT_DATE,
    daysToQ3Print: -daysSince(UBER_Q3_2026_PRINT_DATE),
  };
}

// ─── STAGE 3k: UBER MARKETPLACE-COHORT HISTORICAL RETURNS (v4.19) ───────────
// Pulls daily closes for UBER, DASH, LYFT, GRAB, XLY, SPY and computes:
//   • peer_rotation_pp   = UBER 30d − WEIGHTED cohort 30d (DASH .50 / LYFT .25
//     / GRAB .25). <-6pp WITHOUT an Uber operating print behind it = buy setup.
//   • dash_spread_30d_pp = UBER 30d − DASH 30d, carried SEPARATELY. DASH is the
//     heaviest-weighted peer, not a twin, so no dislocation flag rides on it.
//   • xly_vs_spy_30d_pp  = consumer factor bid (active >+1pp | neutral ±1pp |
//     absent <-1pp)
//   • AV-headline-shock PRICE SCREEN — worst single-session return in the last
//     5 sessions, SPY's return on that same session (aligned by DATE, not index),
//     and a candidate flag (≤ -4%, not on a known Uber print date). The screen
//     only establishes that the price event happened; whether it was an
//     AV-supply headline is attributed downstream by the LLM.
// Threshold note: -6pp sits between MLM's -5 (beta 1.11) and RDDT's -8 (beta
// 1.94), matching UBER's beta of 1.26.
// ★ WEIGHTED average, renormalized over available peers — same as MLM.
const UBER_PEER_WEIGHTS          = { DASH: 0.50, LYFT: 0.25, GRAB: 0.25 };
const UBER_SHOCK_MOVE_PCT        = -4;
const UBER_SHOCK_WINDOW_SESSIONS = 5;

function uberWeightedCohort(vals) {
  const avail = Object.keys(UBER_PEER_WEIGHTS).filter(
    k => vals[k] != null && Number.isFinite(vals[k])
  );
  if (avail.length === 0) return { avg: null, count: 0 };
  const wsum = avail.reduce((a, k) => a + UBER_PEER_WEIGHTS[k], 0);
  const acc = avail.reduce((a, k) => a + vals[k] * UBER_PEER_WEIGHTS[k], 0);
  return { avg: +(acc / wsum).toFixed(3), count: avail.length };
}

// Worst single-session return over the last `sessions` bars, plus SPY's return
// on the same calendar date. Pure function — kept separate so it can be tested.
function uberShockScreen(uberCloses, uberDates, spyCloses, spyDates, sessions = UBER_SHOCK_WINDOW_SESSIONS) {
  let worst = null, worstDate = null, spySameDay = null;
  if (uberCloses && uberDates && uberCloses.length > sessions) {
    for (let i = uberCloses.length - sessions; i < uberCloses.length; i++) {
      const prev = uberCloses[i - 1], cur = uberCloses[i];
      if (!prev || !cur) continue;
      const r = +(((cur - prev) / prev) * 100).toFixed(3);
      if (worst == null || r < worst) { worst = r; worstDate = uberDates[i] ?? null; }
    }
  }
  if (worstDate && spyCloses && spyDates) {
    const j = spyDates.indexOf(worstDate);
    if (j > 0 && spyCloses[j - 1] && spyCloses[j]) {
      spySameDay = +(((spyCloses[j] - spyCloses[j - 1]) / spyCloses[j - 1]) * 100).toFixed(3);
    }
  }
  const onKnownPrint = worstDate === UBER_Q3_2026_PRINT_DATE;
  return {
    worst_1d_return_5s_pct:    worst,
    worst_1d_date:             worstDate,
    spy_same_day_return_pct:   spySameDay,
    worst_1d_on_known_print:   onKnownPrint,
    av_shock_candidate_active: worst != null ? (worst <= UBER_SHOCK_MOVE_PCT && !onKnownPrint) : null,
  };
}

async function fetchUBERHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-UBER] No keys — skipping UBER historical returns");
    return null;
  }

  console.log("  [ALPACA-UBER] Fetching UBER/DASH/LYFT/GRAB/XLY/SPY bars for marketplace-cohort rotation + consumer factor + AV-shock screen...");
  const symbols = ["UBER", "DASH", "LYFT", "GRAB", "XLY", "SPY"];
  const closes = {};
  const dates = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      dates[sym] = bars.map(b => (b.t || "").slice(0, 10));
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const uberRet30 = retNDays(closes.UBER, 30);
  const dashRet30 = retNDays(closes.DASH, 30);
  const lyftRet30 = retNDays(closes.LYFT, 30);
  const grabRet30 = retNDays(closes.GRAB, 30);
  const xlyRet30  = retNDays(closes.XLY,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const { avg: cohortAvg, count: cohortCount } = uberWeightedCohort({
    DASH: dashRet30, LYFT: lyftRet30, GRAB: grabRet30,
  });

  const rotationPp = (uberRet30 != null && cohortAvg != null)
    ? +(uberRet30 - cohortAvg).toFixed(3)
    : null;

  const dashSpreadPp = (uberRet30 != null && dashRet30 != null)
    ? +(uberRet30 - dashRet30).toFixed(3)
    : null;

  const xlyVsSpyPp = (xlyRet30 != null && spyRet30 != null)
    ? +(xlyRet30 - spyRet30).toFixed(3)
    : null;

  const shock = uberShockScreen(closes.UBER, dates.UBER, closes.SPY, dates.SPY);

  const result = {
    uber_30d_return_pct:       uberRet30,
    dash_30d_return_pct:       dashRet30,
    lyft_30d_return_pct:       lyftRet30,
    grab_30d_return_pct:       grabRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_weighting:          "DASH .50 / LYFT .25 / GRAB .25 (renormalized over available)",
    peer_rotation_pp:          rotationPp,
    peer_rotation_active:      rotationPp != null && rotationPp < -6,
    dash_spread_30d_pp:        dashSpreadPp,
    cohort_count:              cohortCount,
    xly_30d_return_pct:        xlyRet30,
    spy_30d_return_pct:        spyRet30,
    xly_vs_spy_30d_pp:         xlyVsSpyPp,
    ...shock,
  };

  const activeStr = result.peer_rotation_active ? " [ACTIVE — buy setup absent an Uber operating print]" : "";
  const dashStr = dashSpreadPp == null ? "—" : `${dashSpreadPp >= 0 ? "+" : ""}${dashSpreadPp}pp`;
  const xlyStr = xlyVsSpyPp == null ? "—"
    : xlyVsSpyPp > 1 ? `consumer bid active (+${xlyVsSpyPp}pp)`
    : xlyVsSpyPp < -1 ? `consumer lagging (${xlyVsSpyPp}pp)`
    : "inline";
  const shockStr = shock.worst_1d_return_5s_pct == null ? "—"
    : `worst 5s ${shock.worst_1d_return_5s_pct}% on ${shock.worst_1d_date} (SPY ${shock.spy_same_day_return_pct ?? "—"}%)${shock.av_shock_candidate_active ? " [SHOCK CANDIDATE — LLM to attribute]" : ""}${shock.worst_1d_on_known_print ? " [print day — excluded]" : ""}`;
  console.log(`  [ALPACA-UBER] ✓ UBER 30d=${uberRet30 != null ? (uberRet30 >= 0 ? "+" : "") + uberRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} (weighted, ${cohortCount}/3) | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | vs DASH: ${dashStr} | XLY-SPY 30d: ${xlyStr} | ${shockStr}`);
  return result;
}

// ─── CVX OIL-PRICE REGIME + DECK NORMALIZATION INPUTS (v4.20) ───────────────
// Nothing here is human-maintained. The regime driver is FRED Brent; the
// reported-quarter window is computed from the date.
//
// Regime bands — identical to cvx-strategy.jsx v1 resolveOilRegime() and to the
// score-engine gate. Symmetric around Chevron's own $70 planning deck:
//   |deviation| ≤ 20%  ($56–$84)            → "anchored"     (25/40/35)
//   |deviation| ≤ 40%  ($42–$56 / $84–$98)  → "transitional" (20/35/45)
//   beyond ±40%        (<$42 / >$98)        → "dislocated"   (15/30/55)
// Missing Brent → "transitional" (the base triple) with driver_missing TRUE.
const CVX_DECK_BRENT              = 70;     // Chevron's planning price (Investor Day targets struck at $70)
const CVX_DECK_HENRY_HUB          = 3.50;   // v1 assumption — decision recorded 2026-10-27
const CVX_REGIME_ANCHORED_MAX     = 20;     // %
const CVX_REGIME_TRANSITIONAL_MAX = 40;     // %
const CVX_COMMODITY_STALE_DAYS    = 14;     // EIA daily spot lags ~1 week; >14d = flag
const CVX_REPORT_LAG_DAYS         = 31;     // a quarter counts as reported this many days after it ends
const CVX_MIN_OBS_PER_QUARTER     = 40;     // daily obs needed for a usable quarterly mean
const CVX_Q3_2026_PRINT_DATE      = "2026-10-30";  // excluded from the air-pocket screen
const CVX_HESS_CLOSE_DATE         = "2025-07-18";  // ~301M CVX shares issued

const cvxAddDaysISO = (iso, d) =>
  new Date(Date.parse(iso + "T00:00:00Z") + d * 86400000).toISOString().slice(0, 10);

function cvxOilRegime(brentSpot) {
  if (brentSpot == null || !(brentSpot > 0)) {
    return { oil_price_regime: "transitional", regime_direction: "none", deck_deviation_pct: null, driver_missing: true };
  }
  const dev = (brentSpot / CVX_DECK_BRENT - 1) * 100;
  const mag = Math.abs(dev);
  const key = mag <= CVX_REGIME_ANCHORED_MAX ? "anchored"
    : mag <= CVX_REGIME_TRANSITIONAL_MAX ? "transitional"
    : "dislocated";
  return {
    oil_price_regime:   key,
    regime_direction:   dev > 0 ? "high" : dev < 0 ? "low" : "none",
    deck_deviation_pct: +dev.toFixed(1),
    driver_missing:     false,
  };
}

// Calendar quarter-end dates strictly before the quarter containing todayISO,
// newest first.
function cvxQuarterEnds(todayISO, count) {
  const out = [];
  let y = +todayISO.slice(0, 4);
  let q = Math.floor((+todayISO.slice(5, 7) - 1) / 3);
  while (out.length < count) {
    q -= 1;
    if (q < 0) { q = 3; y -= 1; }
    const m = (q + 1) * 3;
    out.push(`${y}-${String(m).padStart(2, "0")}-${m === 3 || m === 12 ? 31 : 30}`);
  }
  return out;
}

const cvxQuarterStart = (qe) => `${qe.slice(0, 4)}-${String(+qe.slice(5, 7) - 2).padStart(2, "0")}-01`;

// Latest quarter whose results are treated as public: quarter end + 31 days.
// Chevron prints on the last business days of the following month (2026:
// Jan 30, May 1, Jul 31, Oct 30), so this switches on or one day after each
// print — immaterial for a four-quarter average, and it keeps the print-day
// run on the old window, matching Finnhub's lag behind the filing.
function cvxLastReportedQuarterEnd(todayISO) {
  for (const qe of cvxQuarterEnds(todayISO, 3)) {
    if (todayISO >= cvxAddDaysISO(qe, CVX_REPORT_LAG_DAYS)) return qe;
  }
  return null;
}

// The four reported quarters, oldest first.
function cvxTtmWindow(todayISO) {
  const last = cvxLastReportedQuarterEnd(todayISO);
  if (!last) return [];
  return cvxQuarterEnds(cvxAddDaysISO(last, 1), 4).reverse();
}

// Equal-weighted mean of quarterly means over the window. Pure — tested.
// obs: [{ date: "YYYY-MM-DD", value: number }] in any order.
function cvxTtmAverage(obs, window) {
  const quarters = window.map(qe => {
    const start = cvxQuarterStart(qe);
    const vals = obs.filter(o => o.date >= start && o.date <= qe).map(o => o.value);
    const avg = vals.length >= CVX_MIN_OBS_PER_QUARTER
      ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)
      : null;
    return { quarter_end: qe, avg, n: vals.length };
  });
  const complete = quarters.length === 4 && quarters.every(q => q.avg != null);
  const ttm = complete ? +(quarters.reduce((a, q) => a + q.avg, 0) / 4).toFixed(2) : null;
  return { ttm_avg: ttm, complete, quarters };
}

// Share-count YoY is clean only when BOTH period ends follow the Hess close
// (Guardrail C). The current period end is the last reported quarter.
function cvxShareBaseClean(todayISO) {
  const last = cvxLastReportedQuarterEnd(todayISO);
  if (!last) return false;
  const prior = `${+last.slice(0, 4) - 1}${last.slice(4)}`;
  return prior > CVX_HESS_CLOSE_DATE && last > CVX_HESS_CLOSE_DATE;
}

// ─── STAGE 3l: CVX COMMODITY DECK (FRED Brent + Henry Hub history) ──────────
async function fetchCVXCommodityDeck(now = new Date()) {
  if (!FRED_KEY) {
    console.log("  [CVX-DECK] No FRED key — oil regime falls back to TRANSITIONAL (driver missing)");
    return null;
  }
  const todayISO = now.toISOString().split("T")[0];
  const start = cvxAddDaysISO(todayISO, -480);
  const window = cvxTtmWindow(todayISO);
  const out = {};

  for (const [key, seriesId] of [["brent", "DCOILBRENTEU"], ["henry_hub", "DHHNGSP"]]) {
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&observation_start=${start}&api_key=${FRED_KEY}&file_type=json`,
      `FRED ${key} history`
    );
    const obs = (data?.observations || [])
      .filter(o => o.value && o.value !== ".")
      .map(o => ({ date: o.date, value: +parseFloat(o.value) }))
      .filter(o => Number.isFinite(o.value))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const last = obs.length ? obs[obs.length - 1] : null;
    const ageDays = last
      ? Math.round((Date.parse(todayISO + "T00:00:00Z") - Date.parse(last.date + "T00:00:00Z")) / 86400000)
      : null;
    const ttm = cvxTtmAverage(obs, window);
    out[key] = {
      series_id: seriesId,
      spot: last ? +last.value.toFixed(2) : null,
      spot_date: last ? last.date : null,
      spot_age_days: ageDays,
      stale: ageDays != null && ageDays > CVX_COMMODITY_STALE_DAYS,
      ttm_avg: ttm.ttm_avg,
      ttm_complete: ttm.complete,
      ttm_quarters: ttm.quarters,
    };
    const qStr = ttm.quarters.map(q => `${q.quarter_end.slice(0, 7)}=${q.avg ?? "—"}(${q.n})`).join(" ");
    console.log(`  [CVX-DECK] ${key}: spot ${out[key].spot ?? "—"} (${out[key].spot_date ?? "—"}, ${ageDays ?? "—"}d old${out[key].stale ? " — STALE" : ""}) | TTM ${ttm.ttm_avg ?? "—"}${ttm.complete ? "" : " [INCOMPLETE]"} | ${qStr}`);
    await sleep(200);
  }

  out.window = window;
  out.last_reported_quarter_end = window.length ? window[window.length - 1] : null;
  if (out.brent?.spot == null) {
    console.log("  [CVX-DECK] ✗ No Brent reading — CVX regime falls back to TRANSITIONAL (base 20/35/45) with driver_missing TRUE");
  }
  return out;
}

// ─── STAGE 3m: CVX TWIN / REFERENCE HISTORICAL RETURNS (v4.20) ──────────────
// Pulls daily closes for CVX, XOM, SHEL, TTE, XLE, SPY and computes:
//   • xom_spread_30d_pp = CVX 30d − XOM 30d. XOM is the TWIN: same commodity,
//     same calendar, same US listing — so the spread is close to oil-neutral.
//     < -4pp with no Chevron-specific event = the signature tactical setup.
//   • european_avg_30d_return_pct (SHEL/TTE simple mean) — reference only.
//   • xle_vs_spy_30d_pp = energy sector factor bid (±2pp bands).
//   • GEOPOLITICAL AIR-POCKET PRICE SCREEN — largest single-session move in
//     EITHER direction over the last 5 sessions, XLE's return on that same date
//     (aligned by DATE, not index), the idiosyncratic residual, and a candidate
//     flag at |move| ≥ 4% off the known print date. The screen establishes that
//     a price event happened; its classification is downstream LLM work.
const CVX_TWIN_DISLOCATION_PP    = -4;
const CVX_AIR_POCKET_MOVE_PCT    = 4;
const CVX_AIR_POCKET_SESSIONS    = 5;

// Pure — tested.
function cvxAirPocketScreen(cvxCloses, cvxDates, xleCloses, xleDates, sessions = CVX_AIR_POCKET_SESSIONS) {
  let move = null, moveDate = null, xleSameDay = null;
  if (cvxCloses && cvxDates && cvxCloses.length > sessions) {
    for (let i = cvxCloses.length - sessions; i < cvxCloses.length; i++) {
      const prev = cvxCloses[i - 1], cur = cvxCloses[i];
      if (!prev || !cur) continue;
      const r = +(((cur - prev) / prev) * 100).toFixed(3);
      if (move == null || Math.abs(r) > Math.abs(move)) { move = r; moveDate = cvxDates[i] ?? null; }
    }
  }
  if (moveDate && xleCloses && xleDates) {
    const j = xleDates.indexOf(moveDate);
    if (j > 0 && xleCloses[j - 1] && xleCloses[j]) {
      xleSameDay = +(((xleCloses[j] - xleCloses[j - 1]) / xleCloses[j - 1]) * 100).toFixed(3);
    }
  }
  const onKnownPrint = moveDate === CVX_Q3_2026_PRINT_DATE;
  return {
    largest_1d_move_5s_pct:     move,
    largest_1d_date:            moveDate,
    largest_1d_direction:       move == null ? null : move < 0 ? "down" : "up",
    xle_same_day_return_pct:    xleSameDay,
    idiosyncratic_pp:           move != null && xleSameDay != null ? +(move - xleSameDay).toFixed(3) : null,
    largest_1d_on_known_print:  onKnownPrint,
    air_pocket_candidate_active: move != null ? (Math.abs(move) >= CVX_AIR_POCKET_MOVE_PCT && !onKnownPrint) : null,
  };
}

async function fetchCVXHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-CVX] No keys — skipping CVX historical returns");
    return null;
  }

  console.log("  [ALPACA-CVX] Fetching CVX/XOM/SHEL/TTE/XLE/SPY bars for twin spread + energy factor + air-pocket screen...");
  const symbols = ["CVX", "XOM", "SHEL", "TTE", "XLE", "SPY"];
  const closes = {};
  const dates = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      dates[sym] = bars.map(b => (b.t || "").slice(0, 10));
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const cvxRet30  = retNDays(closes.CVX,  30);
  const xomRet30  = retNDays(closes.XOM,  30);
  const shelRet30 = retNDays(closes.SHEL, 30);
  const tteRet30  = retNDays(closes.TTE,  30);
  const xleRet30  = retNDays(closes.XLE,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const xomSpreadPp = (cvxRet30 != null && xomRet30 != null)
    ? +(cvxRet30 - xomRet30).toFixed(3)
    : null;

  const euVals = [shelRet30, tteRet30].filter(v => v != null);
  const euAvg = euVals.length ? +(euVals.reduce((a, b) => a + b, 0) / euVals.length).toFixed(3) : null;

  const xleVsSpyPp = (xleRet30 != null && spyRet30 != null)
    ? +(xleRet30 - spyRet30).toFixed(3)
    : null;

  const pocket = cvxAirPocketScreen(closes.CVX, dates.CVX, closes.XLE, dates.XLE);

  const result = {
    cvx_30d_return_pct:          cvxRet30,
    xom_30d_return_pct:          xomRet30,
    shel_30d_return_pct:         shelRet30,
    tte_30d_return_pct:          tteRet30,
    xom_spread_30d_pp:           xomSpreadPp,
    twin_dislocation_active:     xomSpreadPp != null && xomSpreadPp < CVX_TWIN_DISLOCATION_PP,
    european_avg_30d_return_pct: euAvg,
    european_count:              euVals.length,
    xle_30d_return_pct:          xleRet30,
    spy_30d_return_pct:          spyRet30,
    xle_vs_spy_30d_pp:           xleVsSpyPp,
    energy_factor_bid:           xleVsSpyPp == null ? null : xleVsSpyPp > 2 ? "active" : xleVsSpyPp < -2 ? "absent" : "neutral",
    ...pocket,
  };

  const twinStr = xomSpreadPp == null ? "—"
    : `${xomSpreadPp >= 0 ? "+" : ""}${xomSpreadPp}pp${result.twin_dislocation_active ? " [TWIN DISLOCATION — buy setup absent a Chevron-specific event]" : ""}`;
  const xleStr = xleVsSpyPp == null ? "—" : `${xleVsSpyPp >= 0 ? "+" : ""}${xleVsSpyPp}pp (${result.energy_factor_bid})`;
  const pocketStr = pocket.largest_1d_move_5s_pct == null ? "—"
    : `largest 5s ${pocket.largest_1d_move_5s_pct}% on ${pocket.largest_1d_date} (XLE ${pocket.xle_same_day_return_pct ?? "—"}%)${pocket.air_pocket_candidate_active ? " [AIR-POCKET CANDIDATE — LLM to classify]" : ""}${pocket.largest_1d_on_known_print ? " [print day — excluded]" : ""}`;
  console.log(`  [ALPACA-CVX] ✓ CVX 30d=${cvxRet30 != null ? (cvxRet30 >= 0 ? "+" : "") + cvxRet30 + "%" : "—"} | vs XOM: ${twinStr} | Europe ref avg=${euAvg != null ? (euAvg >= 0 ? "+" : "") + euAvg + "%" : "—"} (${euVals.length}/2) | XLE-SPY 30d: ${xleStr} | ${pocketStr}`);
  return result;
}

// ─── STAGE 3: FRED MACRO ────────────────────────────────────────────────────
async function fetchMacro() {
  if (!FRED_KEY) return {};
  console.log("  [FRED] Fetching macro indicators...");

  const series = {
    dxy:      "DTWEXBGS",      // Trade-weighted broad USD index (renamed from dxy_proxy in v4.9)
    us10y:    "DGS10",
    us2y:     "DGS2",
    tips10y:  "DFII10",
    fed_funds: "FEDFUNDS",
    vix:      "VIXCLS",
    hy_oas:   "BAMLH0A0HYM2",
    mxn_usd:  "DEXMXUS",
    wti:      "DCOILWTICO",
    brl_usd:  "DEXBZUS",
    us_ism:   "NAPM",          // ISM Manufacturing PMI Composite — LIN global PMI
  };

  const result = {};
  for (const [key, seriesId] of Object.entries(series)) {
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&api_key=${FRED_KEY}&file_type=json`,
      `FRED ${key}`
    );
    const obs = data?.observations?.find(o => o.value && o.value !== ".");
    if (obs) result[key] = +parseFloat(obs.value).toFixed(4);
    await sleep(200);
  }

  if (result.us10y != null && result.us2y != null) {
    result.spread_2s10s = +((result.us10y - result.us2y) * 100).toFixed(0);
  }

  // ── V3: BBB OAS (BAMLC0A4CBBB) + 1m delta — leads LIN backlog 6-12mo ──
  // FRED returns percent (e.g. 1.45 = 145 bps); we store in bps to match field name.
  // limit=25 gets ~22 trading days = ~1 calendar month for delta computation.
  const bbbHist = await fetchJSON(
    `https://api.stlouisfed.org/fred/series/observations?series_id=BAMLC0A4CBBB&sort_order=desc&limit=25&api_key=${FRED_KEY}&file_type=json`,
    `FRED bbb_oas history`
  );
  const bbbObs = (bbbHist?.observations || []).filter(o => o.value && o.value !== ".");
  if (bbbObs.length >= 1) {
    const latestBps = Math.round(parseFloat(bbbObs[0].value) * 100);
    result.bbb_oas_bps = latestBps;
    if (bbbObs.length >= 22) {
      const monthAgoBps = Math.round(parseFloat(bbbObs[21].value) * 100);
      result.bbb_oas_1m_change_bps = latestBps - monthAgoBps;
    } else {
      result.bbb_oas_1m_change_bps = null;
    }
  }
  await sleep(200);

  console.log(`  [FRED] ✓ ${Object.keys(result).length} indicators: VIX=${result.vix ?? "—"}, 10Y=${result.us10y ?? "—"}, HY OAS=${result.hy_oas ?? "—"}, BBB OAS=${result.bbb_oas_bps ?? "—"}bps (1m Δ ${result.bbb_oas_1m_change_bps != null ? (result.bbb_oas_1m_change_bps >= 0 ? "+" : "") + result.bbb_oas_1m_change_bps : "—"}bps), MXN=${result.mxn_usd ?? "—"}, WTI=${result.wti ?? "—"}, BRL=${result.brl_usd ?? "—"}, DXY=${result.dxy ?? "—"}, ISM=${result.us_ism ?? "—"}`);
  return result;
}

// ─── STAGE 3b: NY FED GSCPI (Global Supply Chain Pressure Index) ────────────
// Monthly composite for AMKBY positional + strategic layers.
async function fetchGSCPI() {
  console.log("  [GSCPI] Fetching NY Fed Global Supply Chain Pressure Index...");
  try {
    const resp = await fetch(
      "https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx"
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    if (!rows || rows.length === 0) throw new Error("Empty spreadsheet");

    const lastRow = rows[rows.length - 1];
    const keys = Object.keys(lastRow);
    const gscpiKey = keys.find(k => /gscpi/i.test(k)) || keys[keys.length - 1];
    const dateKey = keys.find(k => /date/i.test(k)) || keys[0];

    const value = parseFloat(lastRow[gscpiKey]);
    const dateRaw = lastRow[dateKey];

    if (isNaN(value)) throw new Error(`Could not parse GSCPI value from column "${gscpiKey}"`);

    let dateStr;
    if (typeof dateRaw === "number") {
      const excelEpoch = new Date(1899, 11, 30);
      const jsDate = new Date(excelEpoch.getTime() + dateRaw * 86400000);
      dateStr = jsDate.toISOString().split("T")[0];
    } else {
      dateStr = String(dateRaw);
    }

    const rounded = +value.toFixed(2);
    const regime = rounded > 1.5 ? "STRESSED" :
      rounded > 0.5 ? "ELEVATED" :
      rounded > -0.5 ? "NORMAL" :
      rounded > -1 ? "CALM" : "VERY CALM";

    console.log(`  [GSCPI] ✓ Latest: ${rounded} (${dateStr}) — ${regime}`);
    return { gscpi: rounded, gscpi_date: dateStr };
  } catch (e) {
    console.log(`  [GSCPI] ✗ Failed: ${e.message} — continuing without GSCPI`);
    return {};
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Market Data Pre-Fetch v4.14");
  console.log("===========================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`APIs: Finnhub=${!!FK} TwelveData=${!!TD_KEY} FRED=${!!FRED_KEY} Alpaca=${!!ALPACA_KEY}\n`);

  // Stage 1: Quotes (Finnhub — ~15s)
  console.log("─── STAGE 1: QUOTES (Finnhub) ───");
  const quotes = await fetchQuotes();

  // Stage 1b: Auxiliary quotes
  console.log("\n─── STAGE 1b: AUXILIARY QUOTES (Finnhub) ───");
  const auxQuotes = await fetchAuxQuotes();

  // Stage 2: Technicals (TwelveData — ~6 min with rate limit pacing)
  console.log("\n─── STAGE 2: TECHNICALS (TwelveData) ───");
  const technicals = await fetchTechnicals(quotes);

  // Stage 2b: Fill gaps from Alpaca candles (for ADRs that TwelveData doesn't cover)
  console.log("\n─── STAGE 2b: ALPACA CANDLE FALLBACK ───");
  await fillTechnicalsFromAlpaca(technicals, quotes);

  // Stage 2c: Fix 52-week data from Alpaca (Finnhub gives garbage for ADRs)
  console.log("\n─── STAGE 2c: ALPACA 52-WEEK FIX ───");
  await fix52WeekFromAlpaca(quotes);

  // Stage 3: Macro (FRED — ~3s)
  console.log("\n─── STAGE 3: MACRO (FRED) ───");
  const macro = await fetchMacro();

  // Stage 3b: GSCPI (NY Fed — supply chain pressure for AMKBY)
  console.log("\n─── STAGE 3b: GSCPI (NY Fed) ───");
  const gscpiData = await fetchGSCPI();
  Object.assign(macro, gscpiData);

  // Stage 3c: LIN historical returns (Alpaca — v3 tactical extras + factor flow)
  console.log("\n─── STAGE 3c: LIN HISTORICAL RETURNS (Alpaca) ───");
  const linHistReturns = await fetchLINHistoricalReturns();

  // Stage 3d: MSFT cohort historical returns (Alpaca — rotation pressure)
  console.log("\n─── STAGE 3d: MSFT COHORT HISTORICAL RETURNS (Alpaca) ───");
  const msftHistReturns = await fetchMSFTHistoricalReturns();

  // Stage 3e: LHX cohort historical returns (Alpaca — defense rotation + ITA factor)
  console.log("\n─── STAGE 3e: LHX COHORT HISTORICAL RETURNS (Alpaca) ───");
  const lhxHistReturns = await fetchLHXHistoricalReturns();

  // Stage 3f: TMO historical returns (Alpaca — biotech overlay + DHR peer)
  console.log("\n─── STAGE 3f: TMO HISTORICAL RETURNS (Alpaca) ───");
  const tmoHistReturns = await fetchTMOHistoricalReturns();

  // Stage 3g: NOW cohort historical returns (Alpaca — SaaS rotation + IGV factor)
  console.log("\n─── STAGE 3g: NOW COHORT HISTORICAL RETURNS (Alpaca) ───");
  const nowHistReturns = await fetchNOWHistoricalReturns();

  // Stage 3h: MA twin/duopoly historical returns (Alpaca — twin spread + fear regime)
  console.log("\n─── STAGE 3h: MA TWIN/DUOPOLY HISTORICAL RETURNS (Alpaca) ───");
  const maHistReturns = await fetchMAHistoricalReturns();

  // Stage 3i: ISRG cohort historical returns (Alpaca — devices rotation + IHI factor)
  console.log("\n─── STAGE 3i: ISRG COHORT HISTORICAL RETURNS (Alpaca) ───");
  const isrgHistReturns = await fetchISRGHistoricalReturns();

  // Stage 3j: MLM aggregates-cohort historical returns (Alpaca — peer rotation + VMC twin + XLB factor)
  console.log("\n─── STAGE 3j: MLM AGGREGATES-COHORT HISTORICAL RETURNS (Alpaca) ───");
  const mlmHistReturns = await fetchMLMHistoricalReturns();

  // Stage 3k: UBER marketplace-cohort historical returns (Alpaca — peer rotation + DASH spread + XLY factor + AV-shock screen)
  console.log("\n─── STAGE 3k: UBER MARKETPLACE-COHORT HISTORICAL RETURNS (Alpaca) ───");
  const uberHistReturns = await fetchUBERHistoricalReturns();

  // Stage 3l: CVX commodity deck (FRED — Brent + Henry Hub history: oil regime + TTM normalization inputs)
  console.log("\n─── STAGE 3l: CVX COMMODITY DECK (FRED Brent + Henry Hub) ───");
  const cvxDeck = await fetchCVXCommodityDeck();

  // Stage 3m: CVX twin/reference historical returns (Alpaca — XOM twin spread + XLE factor + air-pocket screen)
  console.log("\n─── STAGE 3m: CVX TWIN / REFERENCE HISTORICAL RETURNS (Alpaca) ───");
  const cvxHistReturns = await fetchCVXHistoricalReturns();

  // ─── ASSEMBLE + VALIDATE ────────────────────────────────────────────────────
  const output = {};
  const needsWebSearch = [];

  console.log("\n─── DATA QUALITY AUDIT ───");

  for (const sym of SYMBOLS) {
    const q = quotes[sym.symbol] || {};
    const t = technicals[sym.symbol] || {};
    const issues = [];

    // ── Price check ──
    const hasPrice = q.price != null && q.price > 0;
    if (!hasPrice) issues.push("NO PRICE");

    // ── 52-week validation ──
    let w52High = q.week52_high ?? null;
    let w52Low = q.week52_low ?? null;
    let w52Pct = null;
    let w52Valid = false;

    if (w52High && w52Low && hasPrice) {
      const rangePositive = w52Low > 0 && w52High > 0;
      const lowUnderHigh = w52Low < w52High;
      const priceReasonable = q.price >= w52Low * 0.85 && q.price <= w52High * 1.15;

      if (rangePositive && lowUnderHigh && priceReasonable) {
        w52Pct = +((q.price - w52Low) / (w52High - w52Low) * 100).toFixed(1);
        if (w52Pct >= -10 && w52Pct <= 110) {
          w52Valid = true;
        } else {
          issues.push(`52w%=${w52Pct} out of bounds`);
          w52High = null; w52Low = null; w52Pct = null;
        }
      } else {
        issues.push(`bad 52w: L=$${w52Low} H=$${w52High} P=$${q.price}`);
        w52High = null; w52Low = null;
      }
    } else if (hasPrice) {
      issues.push("no 52w data");
    }

    // ── RSI check ──
    const hasRSI = t.rsi14 != null && t.rsi14 >= 0 && t.rsi14 <= 100;
    if (!hasRSI) issues.push("no RSI");

    // ── SMA check ──
    let sma50 = t.sma50, sma200 = t.sma200, maSignal = t.ma_signal;
    if (sma50 && hasPrice) {
      if (sma50 > q.price * 5 || sma50 < q.price * 0.1) {
        issues.push(`SMA50=$${sma50} vs price=$${q.price} suspicious`);
        sma50 = null; maSignal = "unknown";
      }
    }
    if (sma200 && hasPrice) {
      if (sma200 > q.price * 5 || sma200 < q.price * 0.1) {
        issues.push(`SMA200=$${sma200} vs price=$${q.price} suspicious`);
        sma200 = null; maSignal = "unknown";
      }
    }
    const hasSMA = sma50 != null || sma200 != null;
    if (!hasSMA) issues.push("no SMA");

    // ── Route decision ──
    const insufficient = !hasPrice || (!w52Valid && !hasRSI) || (issues.length >= 4);
    if (insufficient) needsWebSearch.push(sym.symbol);

    const grade = issues.length === 0 ? "✓ FULL" : insufficient ? "✗ → WEB SEARCH" : `⚠ PARTIAL (${issues.length} issues)`;
    console.log(`  ${sym.symbol.padEnd(6)} ${grade}`);
    if (issues.length > 0) console.log(`         ${issues.join(" | ")}`);

    output[sym.symbol] = {
      symbol: sym.symbol,
      completeness: issues.length === 0 ? "full" : insufficient ? "insufficient" : "partial",
      issues,
      price: {
        current: hasPrice ? q.price : null,
        change_pct: q.change_pct ?? 0,
        previous_close: q.previous_close ?? null,
        week52_high: w52Valid ? w52High : null,
        week52_low: w52Valid ? w52Low : null,
        week52_position_pct: w52Valid ? w52Pct : null,
      },
      technicals: {
        rsi14: hasRSI ? t.rsi14 : null,
        sma50: sma50 ?? null,
        sma200: sma200 ?? null,
        ma_signal: maSignal ?? "unknown",
      },
      valuation: {
        trailingPE: q.pe ?? null,
        priceToBook: q.pb ?? null,
        dividendYield: q.dividend_yield ?? null,
        beta: q.beta ?? null,
        marketCap: q.market_cap ?? null,
      },
      // Fundamentals (per-symbol). ROI is closest Finnhub proxy for ROCE.
      // Score-engine branches that don't consume these ignore them.
      fundamentals: {
        roce_pct: q.roi ?? null,
        operating_margin_pct: q.operating_margin ?? null,
      },
      volume: {},
      type: sym.type || "equity",
    };
  }

  // ── Attach GLNCY/COPX ratio for copper regime detection ────────────────
  if (output.GLNCY && auxQuotes.COPX) {
    const glncyPrice = output.GLNCY.price?.current;
    const copxPrice = auxQuotes.COPX.price;
    const glncyChange = output.GLNCY.price?.change_pct;
    const copxChange = auxQuotes.COPX.change_pct;

    if (glncyPrice && copxPrice) {
      const ratio = +(glncyPrice / copxPrice).toFixed(6);
      const spread = (glncyChange != null && copxChange != null)
        ? +(glncyChange - copxChange).toFixed(3) : null;

      output.GLNCY.copper_regime = {
        glncy_copx_ratio: ratio,
        glncy_change_pct: glncyChange,
        copx_change_pct: copxChange,
        copx_price: copxPrice,
        relative_spread_pp: spread,
      };

      const copperStr = spread == null ? "—"
        : spread > 0.5 ? `GLNCY outperforming COPX by ${spread}pp (diversification premium)`
        : spread < -0.5 ? `COPX outperforming GLNCY by ${(-spread).toFixed(2)}pp (pure copper leading)`
        : "inline";
      console.log(`  GLNCY copper: GLNCY/COPX=${ratio} | COPX $${copxPrice} (${copxChange >= 0 ? "+" : ""}${copxChange}%) | ${copperStr}`);
    } else {
      console.log(`  GLNCY copper: skipped (missing price data)`);
    }
  }

  // ── LIN peer valuation (vs APD + AIQUY) ───────────────────────────────
  if (output.LIN) {
    const linPE = output.LIN.valuation?.trailingPE;
    const apdPE = auxQuotes.APD?.pe;
    const aiquyPE = auxQuotes.AIQUY?.pe;
    const peerPEs = [apdPE, aiquyPE].filter(p => p != null && p > 0);

    if (linPE && peerPEs.length > 0) {
      const peerAvg = peerPEs.reduce((a, b) => a + b, 0) / peerPEs.length;
      const premiumPct = +(((linPE - peerAvg) / peerAvg) * 100).toFixed(2);

      output.LIN.peer_valuation = {
        lin_pe: linPE,
        apd_pe: apdPE ?? null,
        ai_pa_pe: aiquyPE ?? null,
        peer_avg_pe: +peerAvg.toFixed(2),
        premium_pct: premiumPct,
        peer_count: peerPEs.length,
      };

      const zone = premiumPct < 5 ? "TIGHT (BUY)" : premiumPct < 15 ? "DESERVED PREMIUM" : premiumPct < 18 ? "STRETCHED" : "RICH (TRIM)";
      console.log(`  LIN peer-valuation: LIN ${linPE}x | APD ${apdPE ?? "—"}x | AIQUY ${aiquyPE ?? "—"}x | peer avg ${peerAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !linPE ? "no LIN P/E" : "no peer P/E (APD/AIQUY unavailable)";
      console.log(`  LIN peer-valuation: skipped (${reason})`);
    }

    // ── LIN peer relative (daily return spread vs APD) ─────────────────
    const linChange = output.LIN.price?.change_pct;
    const apdChange = auxQuotes.APD?.change_pct;
    const apdPrice = auxQuotes.APD?.price;

    if (linChange != null && apdChange != null) {
      const spread = +(linChange - apdChange).toFixed(3);

      output.LIN.peer_relative = {
        lin_change_pct: linChange,
        apd_change_pct: apdChange,
        apd_price: apdPrice ?? null,
        relative_spread_pp: spread,
      };

      const peerStr = spread > 0.5 ? `LIN outperforming APD by ${spread}pp (quality premium extending)`
        : spread < -0.5 ? `APD outperforming LIN by ${(-spread).toFixed(2)}pp (LIN catch-up potential)`
        : "inline";
      console.log(`  LIN peer-relative: ${peerStr}`);
    } else {
      console.log(`  LIN peer-relative: skipped (no APD daily change)`);
    }

    const f = output.LIN.fundamentals;
    if (f.roce_pct != null || f.operating_margin_pct != null) {
      console.log(`  LIN fundamentals: ROCE(proxy/ROI)=${f.roce_pct ?? "—"}% | Op margin=${f.operating_margin_pct ?? "—"}%`);
    } else {
      console.log(`  LIN fundamentals: unavailable from Finnhub metrics`);
    }

    // ─── V3 LIN ATTACHMENTS ───────────────────────────────────────────────
    const aiquyChange = auxQuotes.AIQUY?.change_pct;
    const aiquyPrice = auxQuotes.AIQUY?.price;
    if (linChange != null && aiquyChange != null) {
      const spread = +(linChange - aiquyChange).toFixed(3);
      output.LIN.peer_relative_aipa = {
        lin_change_pct: linChange,
        aipa_change_pct: aiquyChange,
        aipa_price: aiquyPrice ?? null,
        relative_spread_pp: spread,
      };
      const dir = spread > 0.5 ? `LIN outperforming AI.PA by ${spread}pp`
        : spread < -0.5 ? `AI.PA outperforming LIN by ${(-spread).toFixed(2)}pp`
        : "inline";
      console.log(`  LIN peer-relative-aipa: ${dir}`);
    } else {
      console.log(`  LIN peer-relative-aipa: skipped (no AIQUY daily change)`);
    }

    output.LIN.tactical_extras = {
      iv_rv_ratio: null,
      spy_10d_drawdown_pct: linHistReturns?.spy_10d_drawdown_pct ?? null,
      lin_vs_spy_10d_pp:    linHistReturns?.lin_vs_spy_10d_pp ?? null,
    };

    output.LIN.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    output.LIN.fundamentals.asu_utilization_pct   = null;
    output.LIN.fundamentals.price_mix_ex_fx_pct   = null;
    output.LIN.fundamentals.eps_revisions_30d_pct = null;
    output.LIN.fundamentals.eps_revisions_90d_pct = null;

    if (output.LIN.peer_valuation) {
      output.LIN.peer_valuation.premium_6m_delta_pp = null;
    }

    output.LIN.h2_layer = {
      contracts_90d_usd_m: null,
      subsidy_regime:      null,
      lcoe_gap_usd_kg:     null,
      lcoe_gap_6m_delta:   null,
    };

    const v3Coverage = [
      output.LIN.peer_relative_aipa ? "AIPA" : null,
      output.LIN.tactical_extras?.spy_10d_drawdown_pct != null ? "tac" : null,
      output.LIN.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
      macro.bbb_oas_bps != null ? "BBB" : null,
    ].filter(Boolean);
    console.log(`  LIN v3 sourced: ${v3Coverage.length > 0 ? v3Coverage.join(", ") : "(none)"} | pending external data: ASU util, price/mix ex-FX, EPS revs, peer P/E 6m Δ, H2 layer`);
  }

  // ── MSFT cohort valuation (vs GOOGL + META + AAPL) ────────────────────
  if (output.MSFT) {
    const msftPE = output.MSFT.valuation?.trailingPE;
    const googlPE = auxQuotes.GOOGL?.pe;
    const metaPE = auxQuotes.META?.pe;
    const aaplPE = auxQuotes.AAPL?.pe;
    const cohortPEs = [googlPE, metaPE, aaplPE].filter(p => p != null && p > 0);

    if (msftPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((msftPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.MSFT.cohort_valuation = {
        msft_pe: msftPE,
        googl_pe: googlPE ?? null,
        meta_pe: metaPE ?? null,
        aapl_pe: aaplPE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < -8 ? "DISCOUNT (BUY)" : premiumPct < 0 ? "BELOW COHORT" : premiumPct < 5 ? "IN-LINE" : premiumPct < 15 ? "DESERVED PREMIUM" : "RICH (TRIM)";
      console.log(`  MSFT cohort-valuation: MSFT ${msftPE}x | GOOGL ${googlPE ?? "—"}x | META ${metaPE ?? "—"}x | AAPL ${aaplPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !msftPE ? "no MSFT P/E" : "no cohort P/E (GOOGL/META/AAPL unavailable)";
      console.log(`  MSFT cohort-valuation: skipped (${reason})`);
    }

    if (msftHistReturns) {
      output.MSFT.cohort_relative = {
        msft_30d_return_pct:        msftHistReturns.msft_30d_return_pct,
        googl_30d_return_pct:       msftHistReturns.googl_30d_return_pct,
        meta_30d_return_pct:        msftHistReturns.meta_30d_return_pct,
        aapl_30d_return_pct:        msftHistReturns.aapl_30d_return_pct,
        cohort_avg_30d_return_pct:  msftHistReturns.cohort_avg_30d_return_pct,
        rotation_pressure_pp:       msftHistReturns.rotation_pressure_pp,
        rotation_pressure_active:   msftHistReturns.rotation_pressure_active,
        cohort_count:               msftHistReturns.cohort_count,
      };

      const rp = msftHistReturns.rotation_pressure_pp;
      const rpStr = rp == null ? "—"
        : msftHistReturns.rotation_pressure_active ? `MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION PRESSURE ACTIVE — buy setup)`
        : rp < 0 ? `MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `MSFT leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  MSFT cohort-relative: ${rpStr}`);
    } else {
      console.log(`  MSFT cohort-relative: skipped (no historical returns)`);
    }

    output.MSFT.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    output.MSFT.fundamentals.azure_growth_cc_pct    = null;
    output.MSFT.fundamentals.capex_ttm_usd_b        = null;
    output.MSFT.fundamentals.fcf_margin_pct         = null;
    output.MSFT.fundamentals.eps_revisions_30d_pct  = null;
    output.MSFT.fundamentals.eps_revisions_90d_pct  = null;

    const msftCoverage = [
      output.MSFT.cohort_valuation ? "cohort-PE" : null,
      output.MSFT.cohort_relative?.rotation_pressure_pp != null ? "rotation" : null,
      output.MSFT.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  MSFT v1 sourced: ${msftCoverage.length > 0 ? msftCoverage.join(", ") : "(none)"} | pending external data: Azure CC growth, capex TTM, FCF margin, EPS revs, forward PE`);
  }

  // ── v4.12: LHX cohort valuation (vs LMT + NOC + RTX + GD) ─────────────
  // Defense-prime quality compounder, analogous to MSFT's mega-cap cohort pattern.
  // Trailing P/E here from Finnhub free tier; forward PE surfaced by LLM via web search.
  // LHX historically trades at -5 to -15% discount to LMT/NOC/RTX/GD avg —
  // cohort compression is the central re-rating thesis.
  if (output.LHX) {
    const lhxPE = output.LHX.valuation?.trailingPE;
    const lmtPE = auxQuotes.LMT?.pe;
    const nocPE = auxQuotes.NOC?.pe;
    const rtxPE = auxQuotes.RTX?.pe;
    const gdPE  = auxQuotes.GD?.pe;
    const cohortPEs = [lmtPE, nocPE, rtxPE, gdPE].filter(p => p != null && p > 0);

    if (lhxPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((lhxPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.LHX.cohort_valuation = {
        lhx_pe: lhxPE,
        lmt_pe: lmtPE ?? null,
        noc_pe: nocPE ?? null,
        rtx_pe: rtxPE ?? null,
        gd_pe:  gdPE  ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < -10 ? "WIDE DISCOUNT (BUY — above-norm)"
        : premiumPct < -5 ? "DISCOUNT (normal range)"
        : premiumPct < 0 ? "MILD DISCOUNT"
        : premiumPct < 5 ? "IN-LINE (rare for LHX)"
        : "PREMIUM (TRIM — rare)";
      console.log(`  LHX cohort-valuation: LHX ${lhxPE}x | LMT ${lmtPE ?? "—"}x | NOC ${nocPE ?? "—"}x | RTX ${rtxPE ?? "—"}x | GD ${gdPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !lhxPE ? "no LHX P/E" : "no cohort P/E (LMT/NOC/RTX/GD unavailable)";
      console.log(`  LHX cohort-valuation: skipped (${reason})`);
    }

    // ── LHX cohort-relative (rotation pressure: 30d return spread) ─────
    if (lhxHistReturns) {
      output.LHX.cohort_relative = {
        lhx_30d_return_pct:        lhxHistReturns.lhx_30d_return_pct,
        lmt_30d_return_pct:        lhxHistReturns.lmt_30d_return_pct,
        noc_30d_return_pct:        lhxHistReturns.noc_30d_return_pct,
        rtx_30d_return_pct:        lhxHistReturns.rtx_30d_return_pct,
        gd_30d_return_pct:         lhxHistReturns.gd_30d_return_pct,
        cohort_avg_30d_return_pct: lhxHistReturns.cohort_avg_30d_return_pct,
        cohort_rotation_pp:        lhxHistReturns.cohort_rotation_pp,
        cohort_rotation_active:    lhxHistReturns.cohort_rotation_active,
        cohort_count:              lhxHistReturns.cohort_count,
      };

      const rp = lhxHistReturns.cohort_rotation_pp;
      const rpStr = rp == null ? "—"
        : lhxHistReturns.cohort_rotation_active ? `LHX lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION ACTIVE — buy setup, capital flowing to larger primes)`
        : rp < 0 ? `LHX lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `LHX leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  LHX cohort-relative: ${rpStr}`);

      // factor_flow: ITA vs SPY 30d (defense sector bid)
      output.LHX.factor_flow = {
        ita_vs_spy_30d_pp: lhxHistReturns.ita_vs_spy_30d_pp,
        ita_30d_return_pct: lhxHistReturns.ita_30d_return_pct,
        spy_30d_return_pct: lhxHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  LHX cohort-relative: skipped (no historical returns)`);
      output.LHX.factor_flow = { ita_vs_spy_30d_pp: null, ita_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // LHX fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.LHX.fundamentals.book_to_bill           = null;  // earnings release / backlog disclosure
    output.LHX.fundamentals.backlog_growth_yoy_pct = null;  // earnings release / backlog disclosure
    output.LHX.fundamentals.op_margin_pct          = null;  // overrides the generic ROI/op-margin fields for LHX-specific scoring
    output.LHX.fundamentals.fcf_margin_pct         = null;  // 10-Q cash flow statement
    output.LHX.fundamentals.eps_revisions_30d_pct  = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.LHX.fundamentals.eps_revisions_90d_pct  = null;  // FactSet/Refinitiv consensus EPS delta 90d

    const lhxCoverage = [
      output.LHX.cohort_valuation ? "cohort-PE" : null,
      output.LHX.cohort_relative?.cohort_rotation_pp != null ? "rotation" : null,
      output.LHX.factor_flow?.ita_vs_spy_30d_pp != null ? "ITA" : null,
    ].filter(Boolean);
    console.log(`  LHX v1 sourced: ${lhxCoverage.length > 0 ? lhxCoverage.join(", ") : "(none)"} | pending external data: book-to-bill, backlog YoY, op margin, FCF margin, EPS revs, forward PE`);
  }

  // ── v4.12: TMO peer valuation + biotech overlay ─────────────────────
  // Life-sciences quality compounder, analogous to LIN's peer pattern (vs DHR)
  // overlaid with a biotech-funding sentiment proxy (XBI 30d/90d leads bookings 2-3Q).
  if (output.TMO) {
    const tmoPE = output.TMO.valuation?.trailingPE;
    const dhrPE = auxQuotes.DHR?.pe;

    if (tmoPE && dhrPE) {
      const premiumPct = +(((tmoPE - dhrPE) / dhrPE) * 100).toFixed(2);

      output.TMO.peer_valuation = {
        tmo_pe: tmoPE,
        dhr_pe: dhrPE,
        premium_pct: premiumPct,
      };

      const zone = premiumPct < -10 ? "DISCOUNT TO DHR (BUY)"
        : premiumPct < 0 ? "BELOW DHR"
        : premiumPct < 10 ? "IN-LINE WITH DHR"
        : "PREMIUM (TRIM)";
      console.log(`  TMO peer-valuation: TMO ${tmoPE}x | DHR ${dhrPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !tmoPE ? "no TMO P/E" : "no DHR P/E";
      console.log(`  TMO peer-valuation: skipped (${reason})`);
    }

    // ── TMO peer relative (daily return spread vs DHR) ──────────────
    const tmoChange = output.TMO.price?.change_pct;
    const dhrChange = auxQuotes.DHR?.change_pct;
    const dhrPrice = auxQuotes.DHR?.price;

    if (tmoChange != null && dhrChange != null) {
      const spread = +(tmoChange - dhrChange).toFixed(3);

      output.TMO.peer_relative = {
        tmo_change_pct: tmoChange,
        dhr_change_pct: dhrChange,
        dhr_price: dhrPrice ?? null,
        relative_spread_pp: spread,
      };

      const peerStr = spread > 0.5 ? `TMO outperforming DHR by ${spread}pp`
        : spread < -0.5 ? `DHR outperforming TMO by ${(-spread).toFixed(2)}pp (TMO catch-up potential)`
        : "inline";
      console.log(`  TMO peer-relative: ${peerStr}`);
    } else {
      console.log(`  TMO peer-relative: skipped (no DHR daily change)`);
    }

    // ── TMO biotech overlay (XBI 30d/90d + daily change) ────────────
    const xbiPrice = auxQuotes.XBI?.price;
    const xbiChange = auxQuotes.XBI?.change_pct;

    if (xbiPrice != null) {
      output.TMO.biotech_overlay = {
        xbi_price:          xbiPrice,
        xbi_change_pct:     xbiChange ?? null,
        xbi_30d_return_pct: tmoHistReturns?.xbi_30d_return_pct ?? null,
        xbi_90d_return_pct: tmoHistReturns?.xbi_90d_return_pct ?? null,
        // Sympathy detection: TMO and XBI both down meaningfully on the day
        // (score-engine uses this for tactical biotech-sympathy buy signal)
        sympathy_setup_active: (tmoChange != null && xbiChange != null && tmoChange < -1.5 && xbiChange < -1.5),
      };

      const fund = tmoHistReturns?.xbi_90d_return_pct;
      const fundStr = fund == null ? "—"
        : fund > 10 ? `funding thawing (+${fund}%)`
        : fund < -10 ? `funding frozen (${fund}%)`
        : `mixed (${fund >= 0 ? "+" : ""}${fund}%)`;
      console.log(`  TMO biotech-overlay: XBI $${xbiPrice} (${xbiChange >= 0 ? "+" : ""}${xbiChange}%) | 90d: ${fundStr}${output.TMO.biotech_overlay.sympathy_setup_active ? " | SYMPATHY SETUP ACTIVE" : ""}`);
    } else {
      console.log(`  TMO biotech-overlay: skipped (no XBI quote)`);
    }

    // ── TMO 30d return tactical extras + reused QUAL/SPY factor flow ──
    output.TMO.tactical_extras = {
      tmo_30d_return_pct: tmoHistReturns?.tmo_30d_return_pct ?? null,
      tmo_vs_dhr_30d_pp:  tmoHistReturns?.tmo_vs_dhr_30d_pp ?? null,
    };

    // factor_flow: QUAL vs SPY 30d — reused from LIN's fetch (market-wide quality bid)
    output.TMO.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    // TMO fundamentals — explicit nulls for fields needing earnings disclosure.
    output.TMO.fundamentals.organic_growth_pct      = null;  // earnings release (TMO segment)
    output.TMO.fundamentals.op_margin_pct           = null;  // overrides generic for TMO-specific scoring
    output.TMO.fundamentals.fcf_margin_pct          = null;  // 10-Q cash flow statement
    output.TMO.fundamentals.eps_revisions_30d_pct   = null;  // FactSet/Refinitiv 30d
    output.TMO.fundamentals.eps_revisions_90d_pct   = null;  // FactSet/Refinitiv 90d
    output.TMO.fundamentals.bioprocessing_phase     = null;  // categorical: destocking/bottoming/early_recovery/expansion/peak (LLM)

    const tmoCoverage = [
      output.TMO.peer_valuation ? "peer-PE" : null,
      output.TMO.biotech_overlay?.xbi_90d_return_pct != null ? "XBI-90d" : null,
      output.TMO.tactical_extras?.tmo_vs_dhr_30d_pp != null ? "DHR-30d" : null,
      output.TMO.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  TMO v1 sourced: ${tmoCoverage.length > 0 ? tmoCoverage.join(", ") : "(none)"} | pending external data: organic growth, bioprocessing phase, op/FCF margin, EPS revs, forward PE, peer commentary (Sartorius/Repligen)`);
  }

  // ── NEW v4.13: NOW cohort valuation (vs CRM + WDAY + ADBE) ───────────
  // AI workflow quality compounder, analogous to MSFT's mega-cap cohort pattern,
  // tuned for premium-SaaS multiple math.
  // ★ CRITICAL: NOW carries 80-120% premium to CRM/WDAY/ADBE as the BASELINE
  //   (higher growth + higher quality). This is structural, not a warning.
  //   The flag is direction of change, not absolute level.
  //   Premium <60% = unusual discount = buy; >150% = stretched.
  if (output.NOW) {
    const nowPE = output.NOW.valuation?.trailingPE;
    const crmPE = auxQuotes.CRM?.pe;
    const wdayPE = auxQuotes.WDAY?.pe;
    const adbePE = auxQuotes.ADBE?.pe;
    const cohortPEs = [crmPE, wdayPE, adbePE].filter(p => p != null && p > 0);

    if (nowPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((nowPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.NOW.cohort_valuation = {
        now_pe: nowPE,
        crm_pe: crmPE ?? null,
        wday_pe: wdayPE ?? null,
        adbe_pe: adbePE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < 60 ? "UNUSUAL DISCOUNT (BUY)"
        : premiumPct < 80 ? "BELOW NORMAL PREMIUM (BUY-leaning)"
        : premiumPct < 120 ? "NORMAL PREMIUM"
        : premiumPct < 150 ? "ABOVE NORMAL PREMIUM"
        : "STRETCHED (TRIM)";
      console.log(`  NOW cohort-valuation: NOW ${nowPE}x | CRM ${crmPE ?? "—"}x | WDAY ${wdayPE ?? "—"}x | ADBE ${adbePE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !nowPE ? "no NOW P/E" : "no cohort P/E (CRM/WDAY/ADBE unavailable)";
      console.log(`  NOW cohort-valuation: skipped (${reason})`);
    }

    // ── NOW cohort-relative (rotation pressure: 30d return spread) ─────
    if (nowHistReturns) {
      output.NOW.cohort_relative = {
        now_30d_return_pct:        nowHistReturns.now_30d_return_pct,
        crm_30d_return_pct:        nowHistReturns.crm_30d_return_pct,
        wday_30d_return_pct:       nowHistReturns.wday_30d_return_pct,
        adbe_30d_return_pct:       nowHistReturns.adbe_30d_return_pct,
        cohort_avg_30d_return_pct: nowHistReturns.cohort_avg_30d_return_pct,
        rotation_pressure_pp:      nowHistReturns.rotation_pressure_pp,
        rotation_pressure_active:  nowHistReturns.rotation_pressure_active,
        cohort_count:              nowHistReturns.cohort_count,
      };

      const rp = nowHistReturns.rotation_pressure_pp;
      const rpStr = rp == null ? "—"
        : nowHistReturns.rotation_pressure_active ? `NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION PRESSURE ACTIVE — buy setup, capital flowing to higher-beta AI/SaaS)`
        : rp < 0 ? `NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `NOW leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  NOW cohort-relative: ${rpStr}`);

      // factor_flow: IGV vs SPY 30d (software sector bid)
      output.NOW.factor_flow = {
        igv_vs_spy_30d_pp:  nowHistReturns.igv_vs_spy_30d_pp,
        igv_30d_return_pct: nowHistReturns.igv_30d_return_pct,
        spy_30d_return_pct: nowHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  NOW cohort-relative: skipped (no historical returns)`);
      output.NOW.factor_flow = { igv_vs_spy_30d_pp: null, igv_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // NOW fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.NOW.fundamentals.crpo_growth_pct          = null;  // current Remaining Performance Obligations YoY (THE ops metric)
    output.NOW.fundamentals.subscription_growth_pct  = null;  // total subscription revenue YoY
    output.NOW.fundamentals.op_margin_pct            = null;  // non-GAAP op margin (overrides generic Finnhub op margin)
    output.NOW.fundamentals.fcf_margin_pct           = null;  // 10-Q cash flow statement (~32% historical)
    output.NOW.fundamentals.large_deals_growth_pct   = null;  // $1M+ ACV deal count YoY (enterprise traction read)
    output.NOW.fundamentals.federal_growth_pct       = null;  // US Federal/Government revenue YoY (secular tailwind)
    output.NOW.fundamentals.eps_revisions_30d_pct    = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.NOW.fundamentals.eps_revisions_90d_pct    = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.NOW.fundamentals.ev_sales_current         = null;  // EV/Sales (premium SaaS primary valuation lens)
    output.NOW.fundamentals.now_assist_traction      = null;  // categorical: strong/moderate/early/unclear (LLM)
    output.NOW.fundamentals.ai_agent_platform_status = null;  // categorical: structural_moat/stable/uncertain/deteriorating (LLM)

    const nowCoverage = [
      output.NOW.cohort_valuation ? "cohort-PE" : null,
      output.NOW.cohort_relative?.rotation_pressure_pp != null ? "rotation" : null,
      output.NOW.factor_flow?.igv_vs_spy_30d_pp != null ? "IGV" : null,
    ].filter(Boolean);
    console.log(`  NOW v1 sourced: ${nowCoverage.length > 0 ? nowCoverage.join(", ") : "(none)"} | pending external data: cRPO growth, subs growth, op/FCF margin, $1M+ deals, federal growth, EV/Sales, forward PE, Now Assist traction, AI Agent Platform status`);
  }

  // ── NEW v4.14: MA twin valuation + duopoly fear regime (vs V) ─────────
  // Payments-network quality compounder. The twin comparison is V ONLY —
  // the duopoly partner, NOT PayPal/fintech/AXP (closed-loop lender).
  // ★ NOTE: MA normally carries a 10-20% trailing-P/E premium to V (faster
  //   grower, larger VAS mix). Premium <5% = compressed = buy; >25% = rich.
  //   Direction of change > absolute level.
  if (output.MA) {
    const maPE = output.MA.valuation?.trailingPE;
    const vPE = auxQuotes.V?.pe;

    if (maPE && vPE) {
      const premiumPct = +(((maPE - vPE) / vPE) * 100).toFixed(2);

      output.MA.twin_valuation = {
        ma_pe: maPE,
        v_pe: vPE,
        premium_pct: premiumPct,
      };

      const zone = premiumPct < 0 ? "DISCOUNT TO V (BUY — rare)"
        : premiumPct < 5 ? "COMPRESSED (BUY)"
        : premiumPct < 10 ? "BELOW NORMAL PREMIUM (BUY-leaning)"
        : premiumPct < 20 ? "NORMAL PREMIUM"
        : premiumPct < 25 ? "ABOVE NORMAL PREMIUM"
        : "RICH (TRIM)";
      console.log(`  MA twin-valuation: MA ${maPE}x | V ${vPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !maPE ? "no MA P/E" : "no V P/E";
      console.log(`  MA twin-valuation: skipped (${reason})`);
    }

    // ── MA twin relative (daily return spread vs V) ────────────────────
    const maChange = output.MA.price?.change_pct;
    const vChange = auxQuotes.V?.change_pct;
    const vPrice = auxQuotes.V?.price;

    if (maChange != null && vChange != null) {
      const spread = +(maChange - vChange).toFixed(3);

      output.MA.twin_relative = {
        ma_change_pct: maChange,
        v_change_pct: vChange,
        v_price: vPrice ?? null,
        relative_spread_pp: spread,
      };

      const twinStr = spread > 0.5 ? `MA outperforming V by ${spread}pp`
        : spread < -0.5 ? `V outperforming MA by ${(-spread).toFixed(2)}pp (twin-divergence watch)`
        : "inline";
      console.log(`  MA twin-relative: ${twinStr}`);
    } else {
      console.log(`  MA twin-relative: skipped (no V daily change)`);
    }

    // ── MA duopoly relative (30d twin spread + fear regime — V8.1 gate input) ──
    if (maHistReturns) {
      output.MA.duopoly_relative = {
        ma_30d_return_pct:          maHistReturns.ma_30d_return_pct,
        v_30d_return_pct:           maHistReturns.v_30d_return_pct,
        spy_30d_return_pct:         maHistReturns.spy_30d_return_pct,
        twin_spread_pp:             maHistReturns.twin_spread_pp,
        twin_dislocation_active:    maHistReturns.twin_dislocation_active,
        duopoly_avg_30d_return_pct: maHistReturns.duopoly_avg_30d_return_pct,
        duopoly_vs_spy_pp:          maHistReturns.duopoly_vs_spy_pp,
        disruption_fear_regime:     maHistReturns.disruption_fear_regime,
      };

      const ts = maHistReturns.twin_spread_pp;
      const tsStr = ts == null ? "—"
        : maHistReturns.twin_dislocation_active ? `MA lagging V by ${(-ts).toFixed(1)}pp/30d (TWIN DISLOCATION ACTIVE — buy setup if no MA-specific break)`
        : ts < 0 ? `MA lagging V by ${(-ts).toFixed(1)}pp/30d (mild)`
        : `MA leading V by ${ts.toFixed(1)}pp/30d`;
      console.log(`  MA duopoly-relative: ${tsStr} | fear regime: ${(maHistReturns.disruption_fear_regime || "—").toUpperCase()}`);
    } else {
      console.log(`  MA duopoly-relative: skipped (no historical returns)`);
      output.MA.duopoly_relative = { ma_30d_return_pct: null, v_30d_return_pct: null, spy_30d_return_pct: null, twin_spread_pp: null, twin_dislocation_active: false, duopoly_avg_30d_return_pct: null, duopoly_vs_spy_pp: null, disruption_fear_regime: null };
    }

    // factor_flow: QUAL vs SPY 30d — reused from LIN's fetch (market-wide quality bid)
    output.MA.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    // MA fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.MA.fundamentals.cross_border_growth_pct        = null;  // earnings release — THE ops metric
    output.MA.fundamentals.gdv_growth_pct                 = null;  // earnings release (gross dollar volume)
    output.MA.fundamentals.switched_txn_growth_pct        = null;  // earnings release (network share read)
    output.MA.fundamentals.vas_growth_pct                 = null;  // earnings release (value-added services net revenue)
    output.MA.fundamentals.vas_share_of_revenue_pct       = null;  // earnings release (~38% baseline)
    output.MA.fundamentals.rebates_incentives_trend       = null;  // categorical: outpacing_gross/in_line/lagging_gross (LLM)
    output.MA.fundamentals.op_margin_pct                  = null;  // adjusted op margin — overrides generic Finnhub field for MA scoring
    output.MA.fundamentals.eps_revisions_30d_pct          = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.MA.fundamentals.eps_revisions_90d_pct          = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.MA.fundamentals.buyback_share_reduction_yoy_pct = null; // 10-Q share count YoY (~-2.3% baseline)
    output.MA.fundamentals.stablecoin_strategy_execution  = null;  // categorical: leading/active/reactive/absent (LLM — BVNK, consortium, MTN)
    output.MA.fundamentals.disruption_narrative_phase     = null;  // categorical: narrative_peak/narrative_active/narrative_fading/resolved (LLM)
    output.MA.fundamentals.disruption_fundamental_evidence = null; // categorical: none/anecdotal/measurable/material (LLM)
    output.MA.fundamentals.interchange_regulation_status  = null;  // categorical: dormant/proposed_stalled/advancing/passed (LLM)

    const maCoverage = [
      output.MA.twin_valuation ? "twin-PE" : null,
      output.MA.duopoly_relative?.twin_spread_pp != null ? "twin-30d" : null,
      output.MA.duopoly_relative?.disruption_fear_regime != null ? "fear-regime" : null,
      output.MA.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  MA v1 sourced: ${maCoverage.length > 0 ? maCoverage.join(", ") : "(none)"} | pending external data: cross-border growth, GDV, switched txns, VAS, rebates trend, op margin, EPS revs, buyback, forward PE, stablecoin/disruption/regulation categoricals`);
  }

  // ── NEW v4.14: ISRG cohort valuation + devices factor (vs MDT/SYK/BSX) ──
  // Surgical-robotics moat compounder, analogous to NOW's premium-multiple
  // cohort pattern. Cohort is large-cap devices — NOT life-science tools
  // (TMO/DHR are a different category in this portfolio).
  // ★ CRITICAL: ISRG carries 60-120% premium to MDT/SYK/BSX as the BASELINE
  //   (category king, ~86% recurring annuity, two-decade moat). This is
  //   structural, not a warning. Absolute PE is never the signal.
  //   Premium <60% = unusual discount = buy; >150% = stretched.
  if (output.ISRG) {
    const isrgPE = output.ISRG.valuation?.trailingPE;
    const mdtPE = auxQuotes.MDT?.pe;
    const sykPE = auxQuotes.SYK?.pe;
    const bsxPE = auxQuotes.BSX?.pe;
    const cohortPEs = [mdtPE, sykPE, bsxPE].filter(p => p != null && p > 0);

    if (isrgPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((isrgPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.ISRG.cohort_valuation = {
        isrg_pe: isrgPE,
        mdt_pe: mdtPE ?? null,
        syk_pe: sykPE ?? null,
        bsx_pe: bsxPE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < 60 ? "UNUSUAL DISCOUNT (BUY)"
        : premiumPct < 90 ? "BELOW MID-PREMIUM (BUY-leaning)"
        : premiumPct < 120 ? "NORMAL PREMIUM"
        : premiumPct < 150 ? "ABOVE NORMAL PREMIUM"
        : "STRETCHED (TRIM)";
      console.log(`  ISRG cohort-valuation: ISRG ${isrgPE}x | MDT ${mdtPE ?? "—"}x | SYK ${sykPE ?? "—"}x | BSX ${bsxPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !isrgPE ? "no ISRG P/E" : "no cohort P/E (MDT/SYK/BSX unavailable)";
      console.log(`  ISRG cohort-valuation: skipped (${reason})`);
    }

    // ── ISRG cohort-relative (fear rotation: 30d return spread) ────────
    if (isrgHistReturns) {
      output.ISRG.cohort_relative = {
        isrg_30d_return_pct:       isrgHistReturns.isrg_30d_return_pct,
        mdt_30d_return_pct:        isrgHistReturns.mdt_30d_return_pct,
        syk_30d_return_pct:        isrgHistReturns.syk_30d_return_pct,
        bsx_30d_return_pct:        isrgHistReturns.bsx_30d_return_pct,
        cohort_avg_30d_return_pct: isrgHistReturns.cohort_avg_30d_return_pct,
        cohort_rotation_pp:        isrgHistReturns.cohort_rotation_pp,
        cohort_rotation_active:    isrgHistReturns.cohort_rotation_active,
        cohort_count:              isrgHistReturns.cohort_count,
      };

      const rp = isrgHistReturns.cohort_rotation_pp;
      const rpStr = rp == null ? "—"
        : isrgHistReturns.cohort_rotation_active ? `ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d (FEAR ROTATION ACTIVE — buy setup if no procedure-share evidence)`
        : rp < 0 ? `ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `ISRG leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  ISRG cohort-relative: ${rpStr}`);

      // factor_flow: IHI vs SPY 30d (devices sector bid — V8.1 gate input)
      output.ISRG.factor_flow = {
        ihi_vs_spy_30d_pp:  isrgHistReturns.ihi_vs_spy_30d_pp,
        ihi_30d_return_pct: isrgHistReturns.ihi_30d_return_pct,
        spy_30d_return_pct: isrgHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  ISRG cohort-relative: skipped (no historical returns)`);
      output.ISRG.factor_flow = { ihi_vs_spy_30d_pp: null, ihi_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // ISRG fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.ISRG.fundamentals.procedure_growth_pct       = null;  // earnings release — THE ops metric (total procedures YoY)
    output.ISRG.fundamentals.procedure_guide_low_pct    = null;  // current-year dV procedure guide low (2026: 13.5)
    output.ISRG.fundamentals.procedure_guide_high_pct   = null;  // current-year dV procedure guide high (2026: 15.5)
    output.ISRG.fundamentals.dv_placements_qtr          = null;  // earnings release (quarterly dV system placements)
    output.ISRG.fundamentals.dv5_mix_pct                = null;  // earnings release (dV5 share of placements)
    output.ISRG.fundamentals.ion_procedure_growth_pct   = null;  // earnings release (Ion second leg)
    output.ISRG.fundamentals.ion_installed_base         = null;  // earnings release
    output.ISRG.fundamentals.recurring_revenue_pct      = null;  // earnings release (~86% baseline; <84% = mix warning)
    output.ISRG.fundamentals.ia_revenue_growth_pct      = null;  // earnings release (instruments & accessories)
    output.ISRG.fundamentals.installed_base_total       = null;  // earnings release (~11,400 baseline)
    output.ISRG.fundamentals.installed_base_yoy_pct     = null;  // earnings release
    output.ISRG.fundamentals.op_margin_pct              = null;  // non-GAAP op margin — overrides generic Finnhub field for ISRG scoring
    output.ISRG.fundamentals.eps_revisions_30d_pct      = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.ISRG.fundamentals.eps_revisions_90d_pct      = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.ISRG.fundamentals.moat_status                = null;  // categorical: intact/probing/eroding/breached (LLM — Hugo/Ottava evidence)
    output.ISRG.fundamentals.instrument_transition_status = null; // categorical: unquantified_fear/quantified_manageable/quantified_material (LLM — 2027 lifespan change)

    const isrgCoverage = [
      output.ISRG.cohort_valuation ? "cohort-PE" : null,
      output.ISRG.cohort_relative?.cohort_rotation_pp != null ? "rotation" : null,
      output.ISRG.factor_flow?.ihi_vs_spy_30d_pp != null ? "IHI" : null,
    ].filter(Boolean);
    console.log(`  ISRG v1 sourced: ${isrgCoverage.length > 0 ? isrgCoverage.join(", ") : "(none)"} | pending external data: procedure growth + guide, dV placements/dV5 mix, Ion, recurring %, I&A growth, installed base, op margin, EPS revs, forward PE, moat/instrument-transition categoricals`);
  }

  // ─── MLM (v4.17) — aggregates-cohort valuation + rotation + materials factor ──
  // Cohort is US CONSTRUCTION AGGREGATES (VMC, CRH, EXP). NOT industrial gases
  // (LIN/APD/AIQUY are a different category in this portfolio).
  // ★ WEIGHTED cohort: VMC .50 / CRH .25 / EXP .25. VMC is the only true
  //   like-for-like pure play; the other two are the breadth check. Weights
  //   renormalize over whichever peers resolved.
  // ★ Zone band is TIGHTER than RDDT's: <-8% = discount; -8% to +10% = normal;
  //   >+18% = rich. Two aggregates franchises should track closely.
  //
  // ★★ CRITICAL — TRAILING-BASIS ARTIFACT GATE ★★
  //   All Finnhub aux metrics are TRAILING P/E. MLM's TTM window carries a
  //   large non-operating gain from the Quikrete asset exchange (trailing ~12.9x
  //   against a ~26.8x forward; TTM profit margin 36.7% EXCEEDS gross margin
  //   28.2%, which operations cannot produce). Left ungated, the premium below
  //   computes near -50% versus the cohort and the inherited zone logic would
  //   stamp it "COMPRESSED (BUY)" — a fabricated signal made of accounting.
  //   Score-engine Guardrail A cannot reach this layer: it keys on FORWARD P/E,
  //   which is LLM-sourced downstream. So the gate lives here. Two aggregates
  //   producers with materially identical business models do not trade at half
  //   each other's multiple; a trailing discount steeper than 35% against a
  //   same-industry cohort is an artifact, not an opportunity.
  if (output.MLM) {
    const mlmPE = output.MLM.valuation?.trailingPE;
    const vmcPE = auxQuotes.VMC?.pe;
    const crhPE = auxQuotes.CRH?.pe;
    const expPE = auxQuotes.EXP?.pe;
    const peerPEs = { VMC: vmcPE, CRH: crhPE, EXP: expPE };
    const { avg: cohortAvgPE, count: peCount } = mlmWeightedCohort(peerPEs);

    if (mlmPE && cohortAvgPE) {
      const premiumPct = +(((mlmPE - cohortAvgPE) / cohortAvgPE) * 100).toFixed(2);
      const artifactSuspected = premiumPct < -35;
      const vmcPremiumPct = (vmcPE && vmcPE > 0)
        ? +(((mlmPE - vmcPE) / vmcPE) * 100).toFixed(2)
        : null;

      output.MLM.cohort_valuation = {
        mlm_pe: mlmPE,
        vmc_pe: vmcPE ?? null,
        crh_pe: crhPE ?? null,
        exp_pe: expPE ?? null,
        cohort_avg_pe: cohortAvgPE,
        cohort_weighting: "VMC .50 / CRH .25 / EXP .25 (renormalized over available)",
        premium_pct: premiumPct,
        mlm_vs_vmc_pct: vmcPremiumPct,
        cohort_count: peCount,
        basis: "trailing",
        // ↓ The gate. FALSE means nothing downstream may read premium_pct as a
        //   valuation signal — the number is emitted for the record only.
        premium_pct_reliable: !artifactSuspected,
        trailing_discount_artifact_suspected: artifactSuspected,
      };

      const zone = artifactSuspected ? "ARTIFACT_SUSPECTED (NOT A BUY — trailing basis contaminated)"
        : premiumPct < -8 ? "DISCOUNT (BUY)"
        : premiumPct <= 10 ? "NORMAL BAND"
        : premiumPct <= 18 ? "ABOVE NORMAL BAND"
        : "RICH (TRIM)";
      console.log(`  MLM cohort-valuation: MLM ${mlmPE}x | VMC ${vmcPE ?? "—"}x | CRH ${crhPE ?? "—"}x | EXP ${expPE ?? "—"}x | weighted cohort ${cohortAvgPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone}) [trailing basis]`);
      if (artifactSuspected) {
        console.log(`  MLM ⚠⚠ TRAILING-DISCOUNT ARTIFACT GATE FIRED — premium ${premiumPct}% vs same-industry cohort is not credible as valuation.`);
        console.log(`  MLM     Cause: TTM window carries the Quikrete divestiture gain. premium_pct_reliable=false; downstream MUST route to forward PE / EV/EBITDA.`);
      }
    } else {
      const reason = !mlmPE ? "no MLM P/E" : "no cohort P/E (VMC/CRH/EXP unavailable)";
      console.log(`  MLM cohort-valuation: skipped (${reason})`);
    }

    // ── MLM cohort-relative (aggregates rotation: 30d return spread) ────
    if (mlmHistReturns) {
      output.MLM.cohort_relative = {
        mlm_30d_return_pct:        mlmHistReturns.mlm_30d_return_pct,
        vmc_30d_return_pct:        mlmHistReturns.vmc_30d_return_pct,
        crh_30d_return_pct:        mlmHistReturns.crh_30d_return_pct,
        exp_30d_return_pct:        mlmHistReturns.exp_30d_return_pct,
        cohort_avg_30d_return_pct: mlmHistReturns.cohort_avg_30d_return_pct,
        cohort_weighting:          mlmHistReturns.cohort_weighting,
        peer_rotation_pp:          mlmHistReturns.peer_rotation_pp,
        peer_rotation_active:      mlmHistReturns.peer_rotation_active,
        vmc_spread_30d_pp:         mlmHistReturns.vmc_spread_30d_pp,
        vmc_dislocation_active:    mlmHistReturns.vmc_dislocation_active,
        cohort_count:              mlmHistReturns.cohort_count,
      };

      const rp = mlmHistReturns.peer_rotation_pp;
      const rpStr = rp == null ? "—"
        : mlmHistReturns.peer_rotation_active ? `MLM lagging aggregates cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION ACTIVE — buy setup if no organic-volume/pricing print confirms it)`
        : rp < 0 ? `MLM lagging aggregates cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `MLM leading aggregates cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  MLM cohort-relative: ${rpStr}`);

      const vs = mlmHistReturns.vmc_spread_30d_pp;
      if (vs != null) {
        console.log(`  MLM twin read: MLM vs VMC ${vs >= 0 ? "+" : ""}${vs}pp/30d${mlmHistReturns.vmc_dislocation_active ? " [TWIN DISLOCATION — the signature MLM setup]" : ""}`);
      }

      // factor_flow: XLB vs SPY 30d (materials sector bid)
      output.MLM.factor_flow = {
        xlb_vs_spy_30d_pp:  mlmHistReturns.xlb_vs_spy_30d_pp,
        xlb_30d_return_pct: mlmHistReturns.xlb_30d_return_pct,
        spy_30d_return_pct: mlmHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  MLM cohort-relative: skipped (no historical returns)`);
      output.MLM.factor_flow = { xlb_vs_spy_30d_pp: null, xlb_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // MLM fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    // Key names match the mlm-strategy.jsx v1 JSON contract exactly.

    // ⚠ PRICING — the moat, measured directly. mix_adjusted_organic_pricing_pct
    // is THE metric: aggregates have no exchange price, so the ability to raise
    // mix-adjusted organic price IS the local-monopoly test. Below 1% is the
    // cleanest single falsifier in this model.
    output.MLM.fundamentals.mix_adjusted_organic_pricing_pct = null;  // earnings release — THE moat metric
    output.MLM.fundamentals.organic_asp_growth_pct           = null;  // earnings release (organic ASP, mix NOT adjusted)
    output.MLM.fundamentals.reported_asp_usd                 = null;  // earnings release ($/ton) — CONTEXT ONLY
    output.MLM.fundamentals.reported_asp_growth_pct          = null;  // earnings release — CONTEXT ONLY
    // ⚠ REPORTED ASP IS A NULL SIGNAL during M&A integration. Q2 2026 printed
    // -2% reported against +3.7% organic mix-adjusted — the entire gap is
    // acquisition and geographic mix from the Quikrete and New Frontier assets.
    // Scoring the reported figure manufactures a pricing-power break that did
    // not happen. Emitted as a categorical, not null, because this is a known
    // structural property of the current period, not a missing fetch.
    output.MLM.fundamentals.reported_asp_signal_status       = "null_signal_mix_contaminated";

    // VOLUME — the cycle read. Separate from pricing and never conflated with it.
    output.MLM.fundamentals.organic_volume_growth_pct        = null;  // earnings release (organic shipments YoY)
    output.MLM.fundamentals.reported_volume_growth_pct       = null;  // earnings release (incl. acquisitions)
    output.MLM.fundamentals.total_tons_millions              = null;  // earnings release (aggregates shipments)

    // UNIT ECONOMICS — the industry's cleanest margin measure.
    output.MLM.fundamentals.cash_gross_profit_per_ton        = null;  // earnings release ($/ton)
    output.MLM.fundamentals.cogs_per_ton_growth_pct          = null;  // earnings release (incl. pass-through freight)
    output.MLM.fundamentals.cogs_per_ton_growth_ex_freight_pct = null; // earnings release (ex pass-through freight — the real cost read)
    output.MLM.fundamentals.energy_headwind                  = null;  // categorical: severe/moderate/neutral/tailwind
    output.MLM.fundamentals.ebitda_margin_pct                = null;  // earnings release (adjusted EBITDA margin)
    output.MLM.fundamentals.inventory_step_up_charge_musd    = null;  // non-cash purchase-accounting charge ($M) — strip before comparing

    // END MARKETS — scored separately; residential is the weak leg, heavy
    // nonres (data centers, power gen, warehouses) the strong one.
    output.MLM.fundamentals.infrastructure_demand            = null;  // categorical: strong/steady/softening
    output.MLM.fundamentals.heavy_nonres_demand              = null;  // categorical: strong/steady/softening
    output.MLM.fundamentals.residential_demand               = null;  // categorical: strong/steady/softening
    // ⚠ WEATHER IS NOISE, NOT SIGNAL. Aggregates is the most weather-contaminated
    // quarterly print in this book. Heavy Texas/Southeast rain suppressed Q2 2026
    // volumes and ran into July. The downstream prompt forbids reading a
    // weather-driven volume miss as demand destruction.
    output.MLM.fundamentals.weather_impact_flag              = null;  // categorical: material_headwind/modest/none/tailwind

    output.MLM.fundamentals.eps_revisions_30d_pct            = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.MLM.fundamentals.eps_revisions_90d_pct            = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.MLM.fundamentals.fy_revenue_guide_action          = null;  // categorical: raised/reaffirmed/cut
    output.MLM.fundamentals.fy_ebitda_guide_action           = null;  // categorical: raised/reaffirmed/cut

    // ── VALUATION (LLM-sourced; forward basis is NOT available from Finnhub) ──
    // ⚠ forward_pe is the load-bearing multiple for this name precisely because
    // trailing is contaminated. forward_pe_consensus_basis records whether
    // sell-side consensus includes LNA — if it cannot be established, the VMC
    // forward-PE comparison must route through EV/EBITDA instead.
    output.MLM.fundamentals.forward_pe                       = null;  // LLM-sourced (Finnhub aux metrics are trailing only)
    output.MLM.fundamentals.forward_pe_consensus_basis       = null;  // categorical: standalone/pro_forma/mixed_or_unknown
    output.MLM.fundamentals.ev_ebitda                        = null;  // LLM-sourced
    output.MLM.fundamentals.ev_ebitda_basis                  = null;  // categorical: standalone_trailing/standalone_forward/pro_forma_forward
    output.MLM.fundamentals.pro_forma_ev_ebitda              = null;  // LLM-sourced — BOTH legs forward or null
    output.MLM.fundamentals.pro_forma_basis_consistent       = null;  // boolean — mixed-basis multiples return null, never a number

    // ── FEDERAL FUNDING REGIME — the dominant macro binary for this name ──────
    // IIJA authorizations expire 2026-09-30. Without reauthorization, formula
    // programs revert to pre-IIJA baseline in FY2027 (~$28B/yr cut).
    // ⚠ CALIBRATION: "short_term_extension" is the NEUTRAL regime, not a
    // contraction. Twelve extensions followed TEA-21 and ten followed
    // SAFETEA-LU — patches are the historical rule, and the base case is not a
    // downgrade. This is a config-level categorical, not an API field.
    // v4.18: POPULATED from the human-maintained config above, not null.
    // These are the only MLM fields this file sets from a constant rather than
    // an API — see the MLM_FEDERAL_AUTHORIZATION_STATUS block for why, and for
    // the calibration note that short_term_extension is the BASE CASE.
    const mlmRegime = mlmFundingRegime();
    output.MLM.fundamentals.federal_authorization_status     = mlmRegime.status;
    output.MLM.fundamentals.days_to_authorization_expiry     = mlmRegime.days;
    output.MLM.fundamentals.state_dot_budget_trend           = mlmRegime.trend;
    const regimeLabel = mlmRegime.status === "multiyear_enacted_at_or_above_iija" ? "funded"
      : (mlmRegime.status === "multiyear_enacted_below_iija" || mlmRegime.status === "lapsed") ? "unfunded"
      : mlmRegime.trend === "accelerating" ? "funded"
      : mlmRegime.trend === "contracting" ? "unfunded"
      : "neutral";
    console.log(`  MLM funding regime: ${mlmRegime.status} + state DOT ${mlmRegime.trend} → engine regime "${regimeLabel}" | ${mlmRegime.days}d to authorization expiry (HUMAN-MAINTAINED CONSTANT — review when the statute changes)`);

    // ── LNA (Lhoist North America) — TREATED AS A KNOWN FORWARD EVENT ─────────
    // All regulatory approvals received 2026-08-05; $6.5B notes priced
    // 2026-08-12. The model scores PRO-FORMA from day one rather than waiting
    // for close. $13.5B EV ($7.0B cash + $6.5B stock), $786M LNA adj EBITDA for
    // TTM ended 2025-12-31, ~$85M run-rate synergies, ~3.7x combined net
    // leverage at close targeting sub-2.5x within 24 months.
    // ⚠ Leverage is scored against the GLIDEPATH, never the level.
    // ⚠ Synergies are credited at ZERO until disclosed as realized.
    // ⚠ If ma_integration_state becomes "terminated", every field above reverts
    //    to standalone basis and the model re-scores from scratch.
    output.MLM.fundamentals.ma_integration_state             = null;  // categorical: announced/approved_financed/integrating/closed/complete/terminated
    output.MLM.fundamentals.pro_forma_net_leverage           = null;  // x (combined net debt / combined adj EBITDA)
    output.MLM.fundamentals.delever_glidepath_status         = null;  // categorical: ahead/on_track/behind/not_yet_measurable
    output.MLM.fundamentals.lna_synergies_credited_musd      = null;  // $M — 0 until disclosed as realized

    // ⚠ NET share count change, NEGATIVE = buyback. This is the INVERSE of
    // RDDT's position: MLM is down ~1.1% YoY and genuinely satisfies the
    // portfolio's aggressive-buyback criterion. But $6.5B of stock
    // consideration against a ~$31.6B market cap is material issuance, so
    // pro_forma_share_count_change_pct books that now rather than being
    // surprised at close.
    output.MLM.fundamentals.share_count_change_yoy_pct       = null;  // NEGATIVE = buyback
    output.MLM.fundamentals.pro_forma_share_count_change_pct = null;  // includes LNA stock consideration

    output.MLM.fundamentals.reserve_tons_millions            = null;  // permitted reserves — the actual moat, slow-moving
    output.MLM.fundamentals.reserve_life_years               = null;  // years at current extraction rate
    output.MLM.fundamentals.roic_pct                         = null;  // see distortion flag below
    output.MLM.fundamentals.wacc_pct                         = null;
    // ⚠ ROIC (~6.7%) sits below WACC (~9.1%), but the denominator was just
    // inflated by acquisitions whose earnings are not yet in the numerator.
    // Emitted as TRUE (not null) because this is a known structural property of
    // the current period, not a missing fetch. Flag it; do not score it as a
    // quality break while integration is in progress.
    output.MLM.fundamentals.roic_denominator_distorted       = true;

    const mlmCoverage = [
      output.MLM.cohort_valuation ? (output.MLM.cohort_valuation.premium_pct_reliable ? "cohort-PE(trailing)" : "cohort-PE(trailing, GATED)") : null,
      output.MLM.cohort_relative?.peer_rotation_pp != null ? "rotation" : null,
      output.MLM.cohort_relative?.vmc_spread_30d_pp != null ? "VMC-twin" : null,
      output.MLM.factor_flow?.xlb_vs_spy_30d_pp != null ? "XLB" : null,
    ].filter(Boolean);
    console.log(`  MLM v1 sourced: ${mlmCoverage.length > 0 ? mlmCoverage.join(", ") : "(none)"} | pending external data: mix-adjusted organic pricing, organic/reported volume, cash GP per ton, COGS/ton, end-market split, weather flag, forward PE + EV/EBITDA (+ basis tags), federal authorization + state DOT, LNA pro-forma + glidepath, NET share count`);
    console.log(`  MLM ⚠ trailing P/E is DIVESTITURE-GAIN CONTAMINATED (Quikrete exchange in TTM) — downstream must score on forward PE / EV/EBITDA`);
    console.log(`  MLM ⚠ reported ASP is MIX-CONTAMINATED during integration — score mix-adjusted organic pricing only`);
  }

  // ─── UBER (v4.19) — marketplace-cohort valuation + rotation + consumer factor ──
  // Cohort is CONSUMER MARKETPLACES (DASH, LYFT, GRAB). NOT Waymo or Tesla —
  // those are AV-supply counterparties in this model, not peers — and NOT the
  // industrials UBER shares XLI with.
  // ★ WEIGHTED cohort: DASH .50 / LYFT .25 / GRAB .25, renormalized over
  //   whichever peers resolved. Non-positive P/Es are excluded before weighting.
  //
  // ★★ CRITICAL — TRAILING COHORT P/E IS PERMANENTLY GATED ★★
  //   Every leg is a GAAP trailing multiple, and legs on both sides are
  //   contaminated by construction:
  //     • UBER: TTM GAAP net income (~$9.58B) carries a $4.9B tax valuation-
  //       allowance release (rolls off at the 2026-11-04 print) AND equity-stake
  //       revaluation swings of roughly ±$1.5B every quarter (+1.5, -1.6, -1.5,
  //       +1.6 across the last four). The revaluations never roll off — they
  //       are permanent noise in GAAP EPS.
  //     • LYFT: trailing P/E ~2.3x on a tax-benefit artifact (net income far
  //       above negative operating income) — the same species.
  //   MLM's gate keys on the SIZE of the discount. This one cannot: the
  //   contamination runs in both directions, so no threshold separates signal
  //   from noise. premium_pct is emitted for the record only and
  //   premium_pct_reliable is hard FALSE. The forward-basis peer read is
  //   LLM-sourced downstream and is SECONDARY even there — it can confirm a
  //   strategic score, never carry one.
  if (output.UBER) {
    const uberPE = output.UBER.valuation?.trailingPE;
    const dashPE = auxQuotes.DASH?.pe;
    const lyftPE = auxQuotes.LYFT?.pe;
    const grabPE = auxQuotes.GRAB?.pe;
    const pos = v => (v != null && v > 0 ? v : null);
    const { avg: cohortAvgPE, count: peCount } = uberWeightedCohort({
      DASH: pos(dashPE), LYFT: pos(lyftPE), GRAB: pos(grabPE),
    });

    if (uberPE && uberPE > 0 && cohortAvgPE) {
      const premiumPct = +(((uberPE - cohortAvgPE) / cohortAvgPE) * 100).toFixed(2);
      const dashPremiumPct = pos(dashPE)
        ? +(((uberPE - dashPE) / dashPE) * 100).toFixed(2)
        : null;

      output.UBER.cohort_valuation = {
        uber_pe: uberPE,
        dash_pe: dashPE ?? null,
        lyft_pe: lyftPE ?? null,
        grab_pe: grabPE ?? null,
        cohort_avg_pe: cohortAvgPE,
        cohort_weighting: "DASH .50 / LYFT .25 / GRAB .25 (renormalized over available)",
        premium_pct: premiumPct,
        uber_vs_dash_pct: dashPremiumPct,
        cohort_count: peCount,
        basis: "trailing_gaap",
        // ↓ The gate. Hard FALSE: nothing downstream may read premium_pct as a
        //   valuation signal for this name — the number is the record only.
        premium_pct_reliable: false,
        unreliable_reason: "gaap_trailing_contaminated_both_legs",
      };

      console.log(`  UBER cohort-valuation: UBER ${uberPE}x | DASH ${dashPE ?? "—"}x | LYFT ${lyftPE ?? "—"}x | GRAB ${grabPE ?? "—"}x | weighted cohort ${cohortAvgPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (GATED — record only, GAAP trailing on both sides) [trailing basis]`);
    } else {
      const reason = !(uberPE && uberPE > 0) ? "no usable UBER P/E" : "no cohort P/E (DASH/LYFT/GRAB unavailable)";
      console.log(`  UBER cohort-valuation: skipped (${reason})`);
    }

    // ── UBER cohort-relative (marketplace rotation: 30d return spread) ──────
    if (uberHistReturns) {
      output.UBER.cohort_relative = {
        uber_30d_return_pct:       uberHistReturns.uber_30d_return_pct,
        dash_30d_return_pct:       uberHistReturns.dash_30d_return_pct,
        lyft_30d_return_pct:       uberHistReturns.lyft_30d_return_pct,
        grab_30d_return_pct:       uberHistReturns.grab_30d_return_pct,
        cohort_avg_30d_return_pct: uberHistReturns.cohort_avg_30d_return_pct,
        cohort_weighting:          uberHistReturns.cohort_weighting,
        peer_rotation_pp:          uberHistReturns.peer_rotation_pp,
        peer_rotation_active:      uberHistReturns.peer_rotation_active,
        dash_spread_30d_pp:        uberHistReturns.dash_spread_30d_pp,
        cohort_count:              uberHistReturns.cohort_count,
      };

      const rp = uberHistReturns.peer_rotation_pp;
      const rpStr = rp == null ? "—"
        : uberHistReturns.peer_rotation_active ? `UBER lagging marketplace cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION ACTIVE — buy setup if no Uber operating print confirms it)`
        : rp < 0 ? `UBER lagging marketplace cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `UBER leading marketplace cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  UBER cohort-relative: ${rpStr}`);

      // factor_flow: XLY vs SPY 30d (consumer factor bid)
      output.UBER.factor_flow = {
        xly_vs_spy_30d_pp:  uberHistReturns.xly_vs_spy_30d_pp,
        xly_30d_return_pct: uberHistReturns.xly_30d_return_pct,
        spy_30d_return_pct: uberHistReturns.spy_30d_return_pct,
      };

      // tactical_extras: the AV-headline-shock PRICE screen (attribution is LLM)
      output.UBER.tactical_extras = {
        worst_1d_return_5s_pct:    uberHistReturns.worst_1d_return_5s_pct,
        worst_1d_date:             uberHistReturns.worst_1d_date,
        spy_same_day_return_pct:   uberHistReturns.spy_same_day_return_pct,
        worst_1d_on_known_print:   uberHistReturns.worst_1d_on_known_print,
        av_shock_candidate_active: uberHistReturns.av_shock_candidate_active,
      };
      if (uberHistReturns.av_shock_candidate_active) {
        console.log(`  UBER AV-shock screen: ${uberHistReturns.worst_1d_return_5s_pct}% on ${uberHistReturns.worst_1d_date} (SPY ${uberHistReturns.spy_same_day_return_pct ?? "—"}%) — CANDIDATE; downstream must attribute it before it counts as the signature setup`);
      }
    } else {
      console.log(`  UBER cohort-relative: skipped (no historical returns)`);
      output.UBER.factor_flow = { xly_vs_spy_30d_pp: null, xly_30d_return_pct: null, spy_30d_return_pct: null };
      output.UBER.tactical_extras = {
        worst_1d_return_5s_pct: null, worst_1d_date: null, spy_same_day_return_pct: null,
        worst_1d_on_known_print: null, av_shock_candidate_active: null,
      };
    }

    // UBER fundamentals — explicit nulls for fields needing earnings disclosure
    // or consensus data. LLM web-search prompt sources these as fallback fetch
    // targets. Key names match the uber-strategy.jsx v1 JSON contract exactly.
    const uberCfg = uberConfigRegime();

    // ── DEMAND ENGINE — constant currency is the operating truth ─────────────
    output.UBER.fundamentals.gross_bookings_growth_cc_pct       = null;  // earnings release (Q2'26: +22%)
    output.UBER.fundamentals.gross_bookings_growth_reported_pct = null;  // earnings release — context (Q2'26: +24%)
    // ⚠ THE CANARY. Mobility GB cc growth below 12% while Delivery holds is the
    // AV-disintermediation signature and the cleanest falsifier in this model.
    output.UBER.fundamentals.mobility_gb_growth_cc_pct          = null;  // earnings release (Q2'26: +20%)
    output.UBER.fundamentals.delivery_gb_growth_cc_pct          = null;  // earnings release (Q2'26: +25%)
    output.UBER.fundamentals.trips_growth_pct                   = null;  // earnings release (Q2'26: +18%)
    output.UBER.fundamentals.mapcs_millions                     = null;  // earnings release (Q2'26: 208)
    output.UBER.fundamentals.mapcs_growth_pct                   = null;  // earnings release (Q2'26: +16%)

    // ── MARGIN — Adj EBITDA on BOOKINGS, not on revenue ──────────────────────
    output.UBER.fundamentals.adj_ebitda_musd                    = null;  // earnings release (Q2'26: 2,819)
    output.UBER.fundamentals.adj_ebitda_pct_gb                  = null;  // earnings release (Q2'26: 4.9 vs 4.5)
    output.UBER.fundamentals.mobility_segment_oi_growth_pct     = null;  // earnings release (Q2'26: +28%)
    output.UBER.fundamentals.delivery_segment_oi_growth_pct     = null;  // earnings release (Q2'26: +38%)
    output.UBER.fundamentals.driver_incentive_pressure          = null;  // categorical: elevated/normal/easing (LLM)

    // ── REVENUE — CONTEXT ONLY ───────────────────────────────────────────────
    output.UBER.fundamentals.reported_revenue_growth_pct        = null;  // earnings release — NOT scored
    output.UBER.fundamentals.business_model_drag_pp             = null;  // earnings release (Q2'26: 8pp)
    // ⚠ REPORTED REVENUE IS A NULL SIGNAL while business-model changes are
    // disclosed: Q2'26 revenue growth lost 8pp to them, and Mobility revenue
    // rose 1% on Mobility bookings up 22%. Emitted as a categorical, not null —
    // a known property of the period (the MLM reported_asp precedent).
    output.UBER.fundamentals.revenue_signal_status              = "null_signal_business_model_contaminated";

    output.UBER.fundamentals.eps_revisions_30d_pct              = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.UBER.fundamentals.eps_revisions_90d_pct              = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.UBER.fundamentals.guide_vs_consensus                 = null;  // categorical: above/inline/below

    // ── VALUATION (LLM-sourced; forward and adjusted bases are not available
    // from Finnhub, whose aux metrics are GAAP trailing only) ─────────────────
    // ⚠ GAAP trailing P/E is NEVER scored for this name (Guardrail A) — tax
    // release plus permanent equity-revaluation noise. Structural, non-null.
    output.UBER.fundamentals.gaap_pe_signal_status              = "null_signal_gaap_contaminated";
    output.UBER.fundamentals.tax_release_in_ttm                 = uberCfg.taxReleaseInTtm;  // computed from the date (see config)
    output.UBER.fundamentals.forward_pe_non_gaap                = null;  // LLM-sourced
    output.UBER.fundamentals.non_gaap_eps_sbc_treatment         = null;  // categorical: sbc_deducted/sbc_excluded/unknown
    output.UBER.fundamentals.ev_adj_ebitda                      = null;  // LLM-sourced — Adj EBITDA EXCLUDES SBC
    output.UBER.fundamentals.ev_adj_ebitda_basis                = null;  // categorical: adjusted_sbc_excluded_trailing/_forward
    output.UBER.fundamentals.ev_adj_ebitda_less_sbc             = null;  // LLM-sourced — same EV over (Adj EBITDA − SBC)
    output.UBER.fundamentals.ev_gaap_ebitda                     = null;  // LLM-sourced — NEVER compared against an adjusted figure
    // ⚠ OWNER FCF — the flagship strategic lens. Headline FCF excludes SBC
    // (~$1.94B TTM); owner FCF = FCF − SBC, yield on market cap.
    output.UBER.fundamentals.fcf_ttm_busd                       = null;  // $B
    output.UBER.fundamentals.sbc_ttm_busd                       = null;  // $B
    output.UBER.fundamentals.owner_fcf_yield_pct                = null;  // %

    // ── AV SUPPLY REGIME — the structural driver. v4.19: POPULATED from the
    // human-maintained config above, not null. ──────────────────────────────────
    output.UBER.fundamentals.av_supply_regime_state             = uberCfg.avState;
    output.UBER.fundamentals.tier1_operators_direct_only        = null;  // LLM — count
    output.UBER.fundamentals.tier1_operators_on_uber            = null;  // LLM — count
    output.UBER.fundamentals.exclusive_pipeline_status          = null;  // categorical: on_track/slipping/not_yet_measurable (Rivian, Lucid/Nuro)
    output.UBER.fundamentals.av_headline_shock_active           = null;  // LLM attribution of tactical_extras.av_shock_candidate_active

    // ── DELIVERY HERO — PENDING, scored STANDALONE until closed ──────────────
    // ⚠ Leverage is scored against the stated <2x gross ceiling, not the level.
    // ⚠ No synergies credited — none are quantified in the offer materials.
    output.UBER.fundamentals.dh_offer_state                     = uberCfg.dhState;
    output.UBER.fundamentals.dh_basis_scored                    = uberCfg.dhBasisScored;
    output.UBER.fundamentals.dh_acceptance_pct                  = null;  // published acceptance level
    output.UBER.fundamentals.gross_leverage                     = null;  // x — gross debt / Adj EBITDA

    // ⚠ NET share count change, NEGATIVE = buyback. Scored on the count, never
    // on gross dollars — repurchase pace slowed sharply as capital went to the
    // Delivery Hero stake while the count kept falling.
    output.UBER.fundamentals.share_count_change_yoy_pct         = null;  // NEGATIVE = buyback (2026-10: -2.28%)
    output.UBER.fundamentals.buyback_pace                       = null;  // categorical: accelerating/steady/slowing
    output.UBER.fundamentals.insider_buying_recent              = null;  // boolean — open-market buys, last 90 days
    output.UBER.fundamentals.roic_pct                           = null;
    // ⚠ ROIC (~19% GAAP) inherits Guardrail A's contamination in the numerator.
    // Emitted TRUE (not null): the revaluation noise is structural, not a gap.
    output.UBER.fundamentals.roic_gaap_inflated                 = true;

    console.log(`  UBER AV supply regime: ${uberCfg.avState ?? "INVALID"} → engine regime "${uberCfg.regime}" | last reviewed ${UBER_AV_SUPPLY_LAST_REVIEWED} (${uberCfg.reviewedDaysAgo}d ago) (HUMAN-MAINTAINED CONSTANT — review on AV announcements and each print)`);
    console.log(`  UBER Delivery Hero: ${uberCfg.dhState ?? "INVALID"} → scored ${uberCfg.dhBasisScored} | acceptance period ends ${UBER_DH_ACCEPTANCE_END} (HUMAN-MAINTAINED CONSTANT)`);

    const uberCoverage = [
      output.UBER.cohort_valuation ? "cohort-PE(trailing, GATED)" : null,
      output.UBER.cohort_relative?.peer_rotation_pp != null ? "rotation" : null,
      output.UBER.cohort_relative?.dash_spread_30d_pp != null ? "DASH-spread" : null,
      output.UBER.factor_flow?.xly_vs_spy_30d_pp != null ? "XLY" : null,
      output.UBER.tactical_extras?.worst_1d_return_5s_pct != null ? "AV-shock-screen" : null,
    ].filter(Boolean);
    console.log(`  UBER v1 sourced: ${uberCoverage.length > 0 ? uberCoverage.join(", ") : "(none)"} | pending external data: constant-currency bookings + Mobility canary, trips/MAPCs, Adj EBITDA % GB, segment OI, incentive pressure, forward PE + EV/Adj EBITDA (+ basis tags), owner FCF, AV pipeline + shock attribution, DH acceptance, gross leverage, NET share count`);
    console.log(`  UBER ⚠ GAAP trailing P/E is TAX-RELEASE + REVALUATION CONTAMINATED — never scored; downstream routes to owner FCF / non-GAAP forward PE / EV/Adj EBITDA`);
    if (uberCfg.taxReleaseInTtm) {
      console.log(`  UBER ⚠ CALENDAR TRAP: the $4.9B tax release leaves the TTM at the ${UBER_Q3_2026_PRINT_DATE} print (${uberCfg.daysToQ3Print}d) — trailing P/E will roughly double with no change in the business`);
    }
    console.log(`  UBER ⚠ reported revenue is BUSINESS-MODEL CONTAMINATED — score constant-currency bookings only`);
  }

  // ─── CVX (v4.20) — oil regime + twin valuation + twin/energy relative ─────
  // TWIN is XOM. SHEL/TTE are a structural-discount REFERENCE, never a cohort
  // average CVX is scored against. XLE is the sector factor.
  //
  // ★★ CRITICAL — TRAILING TWIN P/E IS PERMANENTLY GATED ★★
  //   Both legs are trailing GAAP on windfall-oil earnings with the same Q3'25
  //   roll-off on the same date, and CVX's leg is further depressed by the Hess
  //   purchase-accounting DD&A step-up, which biases its trailing premium UP
  //   for reasons unrelated to value. premium_pct is emitted for the record and
  //   premium_pct_reliable is hard FALSE. The model's twin read is FORWARD P/E,
  //   LLM-sourced, and secondary even there.
  if (output.CVX) {
    const todayISO = new Date().toISOString().split("T")[0];

    // ── Oil-price regime (the composite-weight driver) ──────────────────────
    const brentSpot = cvxDeck?.brent?.spot ?? null;
    const regime = cvxOilRegime(brentSpot);
    const wti = macro.wti ?? null;
    output.CVX.oil_regime = {
      brent_spot:          brentSpot,
      brent_spot_date:     cvxDeck?.brent?.spot_date ?? null,
      brent_spot_stale:    cvxDeck?.brent?.stale ?? null,
      brent_source:        "FRED DCOILBRENTEU (EIA daily spot, ~1 week lag)",
      deck_brent:          CVX_DECK_BRENT,
      deck_deviation_pct:  regime.deck_deviation_pct,
      oil_price_regime:    regime.oil_price_regime,
      regime_direction:    regime.regime_direction,
      driver_missing:      regime.driver_missing,
      wti_spot:            wti,
      brent_wti_spread:    brentSpot != null && wti != null ? +(brentSpot - wti).toFixed(2) : null,
      henry_hub_spot:      cvxDeck?.henry_hub?.spot ?? null,
      henry_hub_spot_date: cvxDeck?.henry_hub?.spot_date ?? null,
    };
    if (regime.driver_missing) {
      console.log(`  CVX oil regime: ✗ NO BRENT — TRANSITIONAL fallback (base 20/35/45), driver_missing TRUE`);
    } else {
      console.log(`  CVX oil regime: Brent $${brentSpot} (${output.CVX.oil_regime.brent_spot_date}${output.CVX.oil_regime.brent_spot_stale ? ", STALE" : ""}) vs $${CVX_DECK_BRENT} deck = ${regime.deck_deviation_pct >= 0 ? "+" : ""}${regime.deck_deviation_pct}% → ${regime.oil_price_regime.toUpperCase()}${regime.oil_price_regime !== "anchored" ? `-${regime.regime_direction.toUpperCase()}` : ""} | Brent–WTI ${output.CVX.oil_regime.brent_wti_spread ?? "—"}`);
    }

    // ── Twin valuation (trailing — GATED, record only) ──────────────────────
    const cvxPE = output.CVX.valuation?.trailingPE;
    const xomPE = auxQuotes.XOM?.pe;
    const shelPE = auxQuotes.SHEL?.pe;
    const ttePE = auxQuotes.TTE?.pe;
    const pos = v => (v != null && v > 0 ? v : null);
    if (pos(cvxPE) && pos(xomPE)) {
      const premiumPct = +(((cvxPE - xomPE) / xomPE) * 100).toFixed(2);
      const euVals = [pos(shelPE), pos(ttePE)].filter(v => v != null);
      const euAvg = euVals.length ? +(euVals.reduce((a, b) => a + b, 0) / euVals.length).toFixed(2) : null;
      output.CVX.twin_valuation = {
        cvx_pe: cvxPE,
        xom_pe: xomPE,
        premium_pct: premiumPct,
        basis: "trailing_gaap",
        // ↓ The gate. Hard FALSE: nothing downstream may read premium_pct as a
        //   valuation signal for this name — the number is the record only.
        premium_pct_reliable: false,
        unreliable_reason: "trailing_gaap_windfall_and_hess_dda_step_up",
        reference_shel_pe: shelPE ?? null,
        reference_tte_pe: ttePE ?? null,
        reference_european_avg_pe: euAvg,
        reference_note: "structural-discount reference only — never scored",
      };
      console.log(`  CVX twin-valuation: CVX ${cvxPE}x | XOM ${xomPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (GATED — record only, trailing GAAP) | Europe ref ${euAvg ?? "—"}x [trailing basis]`);
    } else {
      const reason = !pos(cvxPE) ? "no usable CVX P/E" : "no usable XOM P/E";
      console.log(`  CVX twin-valuation: skipped (${reason})`);
    }

    // ── Twin relative (daily CVX − XOM spread) ──────────────────────────────
    const cvxChange = output.CVX.price?.change_pct;
    const xomChange = auxQuotes.XOM?.change_pct;
    if (cvxChange != null && xomChange != null) {
      const spread = +(cvxChange - xomChange).toFixed(3);
      output.CVX.twin_relative = {
        cvx_change_pct: cvxChange,
        xom_change_pct: xomChange,
        xom_price: auxQuotes.XOM?.price ?? null,
        relative_spread_pp: spread,
      };
      const twinStr = spread > 0.5 ? `CVX outperforming XOM by ${spread}pp`
        : spread < -0.5 ? `XOM outperforming CVX by ${(-spread).toFixed(2)}pp (twin-divergence watch)`
        : "inline";
      console.log(`  CVX twin-relative: ${twinStr}`);
    } else {
      console.log(`  CVX twin-relative: skipped (no XOM daily change)`);
    }

    // ── 30d twin spread, European reference, energy factor, air-pocket screen ──
    if (cvxHistReturns) {
      output.CVX.cohort_relative = {
        cvx_30d_return_pct:          cvxHistReturns.cvx_30d_return_pct,
        xom_30d_return_pct:          cvxHistReturns.xom_30d_return_pct,
        shel_30d_return_pct:         cvxHistReturns.shel_30d_return_pct,
        tte_30d_return_pct:          cvxHistReturns.tte_30d_return_pct,
        xom_spread_30d_pp:           cvxHistReturns.xom_spread_30d_pp,
        twin_dislocation_active:     cvxHistReturns.twin_dislocation_active,
        european_avg_30d_return_pct: cvxHistReturns.european_avg_30d_return_pct,
        european_count:              cvxHistReturns.european_count,
      };
      output.CVX.factor_flow = {
        xle_vs_spy_30d_pp:  cvxHistReturns.xle_vs_spy_30d_pp,
        xle_30d_return_pct: cvxHistReturns.xle_30d_return_pct,
        spy_30d_return_pct: cvxHistReturns.spy_30d_return_pct,
        energy_factor_bid:  cvxHistReturns.energy_factor_bid,
      };
      output.CVX.tactical_extras = {
        largest_1d_move_5s_pct:      cvxHistReturns.largest_1d_move_5s_pct,
        largest_1d_date:             cvxHistReturns.largest_1d_date,
        largest_1d_direction:        cvxHistReturns.largest_1d_direction,
        xle_same_day_return_pct:     cvxHistReturns.xle_same_day_return_pct,
        idiosyncratic_pp:            cvxHistReturns.idiosyncratic_pp,
        largest_1d_on_known_print:   cvxHistReturns.largest_1d_on_known_print,
        air_pocket_candidate_active: cvxHistReturns.air_pocket_candidate_active,
      };

      const ts = cvxHistReturns.xom_spread_30d_pp;
      const tsStr = ts == null ? "—"
        : cvxHistReturns.twin_dislocation_active ? `CVX lagging XOM by ${(-ts).toFixed(1)}pp/30d (TWIN DISLOCATION ACTIVE — buy setup if no Chevron-specific event)`
        : ts < 0 ? `CVX lagging XOM by ${(-ts).toFixed(1)}pp/30d (mild)`
        : `CVX leading XOM by ${ts.toFixed(1)}pp/30d`;
      console.log(`  CVX twin 30d: ${tsStr}`);
      if (cvxHistReturns.air_pocket_candidate_active) {
        console.log(`  CVX air-pocket screen: ${cvxHistReturns.largest_1d_move_5s_pct}% on ${cvxHistReturns.largest_1d_date} (XLE ${cvxHistReturns.xle_same_day_return_pct ?? "—"}%) — CANDIDATE; downstream must classify it, and a de-escalation drop in a dislocated-high regime is NOT a buy`);
      }
    } else {
      console.log(`  CVX twin 30d: skipped (no historical returns)`);
      output.CVX.cohort_relative = {
        cvx_30d_return_pct: null, xom_30d_return_pct: null, shel_30d_return_pct: null, tte_30d_return_pct: null,
        xom_spread_30d_pp: null, twin_dislocation_active: false, european_avg_30d_return_pct: null, european_count: 0,
      };
      output.CVX.factor_flow = { xle_vs_spy_30d_pp: null, xle_30d_return_pct: null, spy_30d_return_pct: null, energy_factor_bid: null };
      output.CVX.tactical_extras = {
        largest_1d_move_5s_pct: null, largest_1d_date: null, largest_1d_direction: null, xle_same_day_return_pct: null,
        idiosyncratic_pp: null, largest_1d_on_known_print: null, air_pocket_candidate_active: null,
      };
    }

    // CVX fundamentals — explicit nulls for fields needing earnings disclosure
    // or consensus data. LLM web-search prompt sources these as fallback fetch
    // targets. Key names match the cvx-strategy.jsx v1 JSON contract exactly.
    const ttmWindow = cvxDeck?.window ?? cvxTtmWindow(todayISO);
    const anchored = regime.oil_price_regime === "anchored";
    const mcapM = output.CVX.valuation?.marketCap;

    // ── OIL REGIME + NORMALIZATION INPUTS (computed, non-null when FRED answers) ──
    output.CVX.fundamentals.brent_spot                    = brentSpot;
    output.CVX.fundamentals.deck_deviation_pct            = regime.deck_deviation_pct;
    output.CVX.fundamentals.oil_price_regime              = regime.oil_price_regime;
    output.CVX.fundamentals.regime_direction              = regime.regime_direction;
    output.CVX.fundamentals.brent_ttm_avg                 = cvxDeck?.brent?.ttm_avg ?? null;
    output.CVX.fundamentals.henry_hub_ttm_avg             = cvxDeck?.henry_hub?.ttm_avg ?? null;
    output.CVX.fundamentals.henry_hub_basis               = "fred_daily_spot_proxy_for_bid_week";
    output.CVX.fundamentals.ttm_window                    = ttmWindow;
    output.CVX.fundamentals.market_cap_busd               = mcapM != null ? +(mcapM / 1000).toFixed(1) : null;  // Finnhub reports $M
    // ⚠ The deck normalization (adjusted FCF at $70 Brent / $3.50 Henry Hub,
    // downstream vs mid-cycle) needs the two LLM-sourced inputs below and is
    // computed in score-engine, not here.
    output.CVX.fundamentals.adj_fcf_ttm_busd              = null;  // earnings releases — TTM adjusted FCF (Q2'26 TTM ≈ 30.7)
    output.CVX.fundamentals.downstream_earnings_ttm_busd  = null;  // earnings releases — TTM downstream earnings

    // ── POSITIONAL — production vs guide, TCO canary, cash, capital discipline ──
    output.CVX.fundamentals.production_mboed              = null;  // earnings release (Q2'26: 4,070)
    output.CVX.fundamentals.production_vs_guide           = null;  // categorical: above/within/below FY26 3,980–4,100
    output.CVX.fundamentals.production_growth_yoy_pct     = null;  // CONTEXT ONLY — Hess anniversary
    // ⚠ THE CANARY. TCO is ~$6B of Chevron-share FCF at $70 and exits via CPC.
    output.CVX.fundamentals.tco_canary_status             = null;  // categorical: intact/degraded/broken (LLM)
    output.CVX.fundamentals.cpc_export_status             = null;  // categorical: flowing/intermittent/suspended (LLM)
    output.CVX.fundamentals.guyana_status                 = null;  // categorical: on_track/slipping
    output.CVX.fundamentals.cffo_ex_wc_ttm_busd           = null;  // earnings releases (Q2'26 TTM ≈ 45.8)
    output.CVX.fundamentals.capex_ttm_busd                = null;  // earnings releases (Q2'26 TTM ≈ 18.3)
    output.CVX.fundamentals.capex_vs_guide                = null;  // categorical: low_end/mid/high_end/above ($18–19B)
    output.CVX.fundamentals.timing_effects_last_q_busd    = null;  // earnings release / interim 8-K
    output.CVX.fundamentals.working_capital_last_q_busd   = null;  // earnings release
    output.CVX.fundamentals.quarterly_eps_signal_status   = null;  // categorical — LLM, per quarter (material timing/WC → null signal)
    output.CVX.fundamentals.crack_environment             = null;  // categorical: windfall/normal/weak
    output.CVX.fundamentals.next_q_buyback_guide_low_busd = null;  // earnings call (prior guide 2.5)
    output.CVX.fundamentals.next_q_buyback_guide_high_busd = null; // earnings call (prior guide 3.0)
    output.CVX.fundamentals.buyback_guide_trend           = null;  // categorical: raised/held/cut
    output.CVX.fundamentals.eps_revisions_30d_pct         = null;
    output.CVX.fundamentals.eps_revisions_90d_pct         = null;
    // ⚠ Revisions track the strip in a commodity name. Structural, regime-derived.
    output.CVX.fundamentals.revisions_signal_status       = anchored ? "execution" : "commodity_driven";

    // ── STRATEGIC — spot multiples gated; structural categoricals non-null ──
    // ⚠ GAAP trailing P/E is NEVER scored (Guardrail A). Structural, non-null.
    output.CVX.fundamentals.gaap_pe_signal_status         = "null_signal_cycle_contaminated";
    output.CVX.fundamentals.q3_2025_in_ttm                = ttmWindow.includes("2025-09-30");  // computed from the date
    output.CVX.fundamentals.forward_pe_consensus          = null;  // LLM-sourced
    output.CVX.fundamentals.forward_pe_signal_status      = anchored ? "clean" : "spot_contaminated";
    output.CVX.fundamentals.xom_fwd_pe                    = null;  // LLM-sourced — the forward twin read
    output.CVX.fundamentals.breakeven_status              = null;  // categorical: inside/drifting/breach vs <$50
    output.CVX.fundamentals.net_debt_ratio_pct            = null;  // earnings release (Q2'26: 13.1)
    output.CVX.fundamentals.hesm_deconsolidation_state    = null;  // categorical: pending/closed/closed_in_ttm
    output.CVX.fundamentals.net_debt_ratio_ex_deconsolidation_pct = null;
    // ⚠ NET period-end share count, NEGATIVE = buyback (Guardrail C). Clean
    // only when both period ends follow the 2025-07-18 Hess close.
    output.CVX.fundamentals.share_count_change_yoy_pct    = null;  // LLM — period-end counts only
    output.CVX.fundamentals.share_count_base_clean        = cvxShareBaseClean(todayISO);  // computed from the date
    output.CVX.fundamentals.buyback_ttm_busd              = null;  // (Q2'26 TTM ≈ 11.2)
    output.CVX.fundamentals.buyback_vs_range              = null;  // categorical: below/within/above $10–20B
    output.CVX.fundamentals.insider_net_selling_90d       = null;  // boolean
    // ⚠ ROCE (Finnhub ROI proxy above, and Chevron's own 21.4% Q2'26) is
    // spot-inflated while Brent sits far above the deck. Structural.
    output.CVX.fundamentals.roce_spot_inflated            = !anchored && regime.regime_direction === "high";

    const q3In = output.CVX.fundamentals.q3_2025_in_ttm;
    console.log(`  CVX deck inputs: TTM window ${ttmWindow.length ? `${ttmWindow[0]} → ${ttmWindow[ttmWindow.length - 1]}` : "—"} | Brent TTM ${output.CVX.fundamentals.brent_ttm_avg ?? "—"} | Henry Hub TTM ${output.CVX.fundamentals.henry_hub_ttm_avg ?? "—"} (spot proxy) | mcap $${output.CVX.fundamentals.market_cap_busd ?? "—"}B`);
    const cvxCoverage = [
      !regime.driver_missing ? "oil-regime" : null,
      output.CVX.fundamentals.brent_ttm_avg != null ? "Brent-TTM" : null,
      output.CVX.fundamentals.henry_hub_ttm_avg != null ? "HH-TTM" : null,
      output.CVX.twin_valuation ? "twin-PE(trailing, GATED)" : null,
      output.CVX.cohort_relative?.xom_spread_30d_pp != null ? "XOM-spread" : null,
      output.CVX.factor_flow?.xle_vs_spy_30d_pp != null ? "XLE" : null,
      output.CVX.tactical_extras?.largest_1d_move_5s_pct != null ? "air-pocket-screen" : null,
    ].filter(Boolean);
    console.log(`  CVX v1 sourced: ${cvxCoverage.length > 0 ? cvxCoverage.join(", ") : "(none)"} | pending external data: TTM adjusted FCF + downstream earnings (normalization), production vs guide, TCO/CPC canary, CFFO ex-WC, capex vs guide, timing + working capital, buyback guide, forward twin PE, breakeven, net debt ex-HESM, period-end share count`);
    console.log(`  CVX ⚠ GAAP trailing P/E and consensus forward P/E are WINDFALL-CONTAMINATED — never scored; downstream routes to normalized FCF at the $${CVX_DECK_BRENT} / $${CVX_DECK_HENRY_HUB.toFixed(2)} deck`);
    if (q3In) {
      console.log(`  CVX ⚠ CALENDAR TRAP: Q3'25 ($1.82 GAAP on $69 Brent) leaves the TTM after the ${CVX_Q3_2026_PRINT_DATE} print — trailing P/E falls from ~22x toward ~17x with no change in the business`);
    }
    if (!output.CVX.fundamentals.share_count_base_clean) {
      console.log(`  CVX ⚠ HESS ANNIVERSARY: latest period-end share count YoY crosses the ${CVX_HESS_CLOSE_DATE} close (~301M shares issued) — base NOT clean; report, do not score`);
    }
  }

  output._macro = macro;
  output._meta = {
    needsWebSearch,
    timestamp: new Date().toISOString(),
    sources: { quotes: "finnhub", technicals: "twelvedata", macro: "fred", gscpi: "nyfed", aux: "finnhub" },
    aux_symbols: Object.keys(auxQuotes),
  };

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  const fullCount = SYMBOLS.filter(s => (output[s.symbol].issues || []).length === 0).length;
  const partialCount = SYMBOLS.filter(s => (output[s.symbol].issues || []).length > 0 && !needsWebSearch.includes(s.symbol)).length;

  console.log(`\n═══════════════════════════════════`);
  console.log(`  Full data:      ${fullCount}/${SYMBOLS.length}`);
  console.log(`  Partial (ok):   ${partialCount}/${SYMBOLS.length}`);
  console.log(`  → Web search:   ${needsWebSearch.length}/${SYMBOLS.length}`);
  if (needsWebSearch.length > 0) {
    console.log(`    Symbols: ${needsWebSearch.join(", ")}`);
  }
  console.log(`  Macro:          ${Object.keys(macro).length} indicators`);
  console.log(`  GSCPI:          ${macro.gscpi != null ? `${macro.gscpi} (${macro.gscpi_date})` : "unavailable"}`);
  console.log(`  GLNCY/COPX:     ${output.GLNCY?.copper_regime ? `ratio=${output.GLNCY.copper_regime.glncy_copx_ratio}, COPX $${output.GLNCY.copper_regime.copx_price}` : "unavailable"}`);
  console.log(`  LIN peer P/E:   ${output.LIN?.peer_valuation ? `LIN ${output.LIN.peer_valuation.lin_pe}x vs ${output.LIN.peer_valuation.peer_count}-peer avg ${output.LIN.peer_valuation.peer_avg_pe}x = ${output.LIN.peer_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  LIN v3 BBB OAS: ${macro.bbb_oas_bps != null ? `${macro.bbb_oas_bps}bps (1m Δ ${macro.bbb_oas_1m_change_bps != null ? (macro.bbb_oas_1m_change_bps >= 0 ? "+" : "") + macro.bbb_oas_1m_change_bps + "bps" : "—"})` : "unavailable"}`);
  console.log(`  LIN v3 returns: ${linHistReturns ? `SPY 10d=${linHistReturns.spy_10d_drawdown_pct}%, LIN-SPY 10d=${linHistReturns.lin_vs_spy_10d_pp}pp, QUAL-SPY 30d=${linHistReturns.qual_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  LIN AI.PA:      ${output.LIN?.peer_relative_aipa ? `spread=${output.LIN.peer_relative_aipa.relative_spread_pp}pp` : "unavailable"}`);
  console.log(`  MSFT cohort PE: ${output.MSFT?.cohort_valuation ? `MSFT ${output.MSFT.cohort_valuation.msft_pe}x vs ${output.MSFT.cohort_valuation.cohort_count}-name cohort avg ${output.MSFT.cohort_valuation.cohort_avg_pe}x = ${output.MSFT.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  MSFT rotation:  ${output.MSFT?.cohort_relative ? `MSFT 30d=${output.MSFT.cohort_relative.msft_30d_return_pct}%, cohort=${output.MSFT.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.MSFT.cohort_relative.rotation_pressure_pp}pp${output.MSFT.cohort_relative.rotation_pressure_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  LHX cohort PE:  ${output.LHX?.cohort_valuation ? `LHX ${output.LHX.cohort_valuation.lhx_pe}x vs ${output.LHX.cohort_valuation.cohort_count}-name cohort avg ${output.LHX.cohort_valuation.cohort_avg_pe}x = ${output.LHX.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  LHX rotation:   ${output.LHX?.cohort_relative ? `LHX 30d=${output.LHX.cohort_relative.lhx_30d_return_pct}%, cohort=${output.LHX.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.LHX.cohort_relative.cohort_rotation_pp}pp${output.LHX.cohort_relative.cohort_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  LHX ITA-SPY:    ${output.LHX?.factor_flow?.ita_vs_spy_30d_pp != null ? `${output.LHX.factor_flow.ita_vs_spy_30d_pp >= 0 ? "+" : ""}${output.LHX.factor_flow.ita_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  TMO peer P/E:   ${output.TMO?.peer_valuation ? `TMO ${output.TMO.peer_valuation.tmo_pe}x vs DHR ${output.TMO.peer_valuation.dhr_pe}x = ${output.TMO.peer_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  TMO biotech:    ${output.TMO?.biotech_overlay ? `XBI 30d=${output.TMO.biotech_overlay.xbi_30d_return_pct}%, 90d=${output.TMO.biotech_overlay.xbi_90d_return_pct}%${output.TMO.biotech_overlay.sympathy_setup_active ? " [SYMPATHY ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  TMO-DHR 30d:    ${output.TMO?.tactical_extras?.tmo_vs_dhr_30d_pp != null ? `${output.TMO.tactical_extras.tmo_vs_dhr_30d_pp >= 0 ? "+" : ""}${output.TMO.tactical_extras.tmo_vs_dhr_30d_pp}pp` : "unavailable"}`);
  console.log(`  NOW cohort PE:  ${output.NOW?.cohort_valuation ? `NOW ${output.NOW.cohort_valuation.now_pe}x vs ${output.NOW.cohort_valuation.cohort_count}-name cohort avg ${output.NOW.cohort_valuation.cohort_avg_pe}x = ${output.NOW.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  NOW rotation:   ${output.NOW?.cohort_relative ? `NOW 30d=${output.NOW.cohort_relative.now_30d_return_pct}%, cohort=${output.NOW.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.NOW.cohort_relative.rotation_pressure_pp}pp${output.NOW.cohort_relative.rotation_pressure_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  NOW IGV-SPY:    ${output.NOW?.factor_flow?.igv_vs_spy_30d_pp != null ? `${output.NOW.factor_flow.igv_vs_spy_30d_pp >= 0 ? "+" : ""}${output.NOW.factor_flow.igv_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  MA twin PE:     ${output.MA?.twin_valuation ? `MA ${output.MA.twin_valuation.ma_pe}x vs V ${output.MA.twin_valuation.v_pe}x = ${output.MA.twin_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  MA duopoly:     ${output.MA?.duopoly_relative?.duopoly_vs_spy_pp != null ? `twin Δ=${output.MA.duopoly_relative.twin_spread_pp}pp${output.MA.duopoly_relative.twin_dislocation_active ? " [DISLOCATION]" : ""}, duopoly-SPY=${output.MA.duopoly_relative.duopoly_vs_spy_pp}pp (${output.MA.duopoly_relative.disruption_fear_regime})` : "unavailable"}`);
  console.log(`  ISRG cohort PE: ${output.ISRG?.cohort_valuation ? `ISRG ${output.ISRG.cohort_valuation.isrg_pe}x vs ${output.ISRG.cohort_valuation.cohort_count}-name cohort avg ${output.ISRG.cohort_valuation.cohort_avg_pe}x = ${output.ISRG.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  ISRG rotation:  ${output.ISRG?.cohort_relative ? `ISRG 30d=${output.ISRG.cohort_relative.isrg_30d_return_pct}%, cohort=${output.ISRG.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.ISRG.cohort_relative.cohort_rotation_pp}pp${output.ISRG.cohort_relative.cohort_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  ISRG IHI-SPY:   ${output.ISRG?.factor_flow?.ihi_vs_spy_30d_pp != null ? `${output.ISRG.factor_flow.ihi_vs_spy_30d_pp >= 0 ? "+" : ""}${output.ISRG.factor_flow.ihi_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  MLM cohort PE:  ${output.MLM?.cohort_valuation ? `MLM ${output.MLM.cohort_valuation.mlm_pe}x vs ${output.MLM.cohort_valuation.cohort_count}-name weighted aggregates cohort avg ${output.MLM.cohort_valuation.cohort_avg_pe}x = ${output.MLM.cohort_valuation.premium_pct}% premium [trailing]${output.MLM.cohort_valuation.trailing_discount_artifact_suspected ? " ⚠ ARTIFACT GATED — NOT A BUY" : ""}` : "unavailable"}`);
  console.log(`  MLM rotation:   ${output.MLM?.cohort_relative ? `MLM 30d=${output.MLM.cohort_relative.mlm_30d_return_pct}%, cohort=${output.MLM.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.MLM.cohort_relative.peer_rotation_pp}pp${output.MLM.cohort_relative.peer_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  MLM vs VMC:     ${output.MLM?.cohort_relative?.vmc_spread_30d_pp != null ? `${output.MLM.cohort_relative.vmc_spread_30d_pp >= 0 ? "+" : ""}${output.MLM.cohort_relative.vmc_spread_30d_pp}pp/30d${output.MLM.cohort_relative.vmc_dislocation_active ? " [TWIN DISLOCATION]" : ""}` : "unavailable"}`);
  console.log(`  MLM XLB-SPY:    ${output.MLM?.factor_flow?.xlb_vs_spy_30d_pp != null ? `${output.MLM.factor_flow.xlb_vs_spy_30d_pp >= 0 ? "+" : ""}${output.MLM.factor_flow.xlb_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  UBER cohort PE: ${output.UBER?.cohort_valuation ? `UBER ${output.UBER.cohort_valuation.uber_pe}x vs ${output.UBER.cohort_valuation.cohort_count}-name weighted marketplace cohort avg ${output.UBER.cohort_valuation.cohort_avg_pe}x = ${output.UBER.cohort_valuation.premium_pct}% premium [trailing GAAP] ⚠ GATED — record only` : "unavailable"}`);
  console.log(`  UBER rotation:  ${output.UBER?.cohort_relative ? `UBER 30d=${output.UBER.cohort_relative.uber_30d_return_pct}%, cohort=${output.UBER.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.UBER.cohort_relative.peer_rotation_pp}pp${output.UBER.cohort_relative.peer_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  UBER vs DASH:   ${output.UBER?.cohort_relative?.dash_spread_30d_pp != null ? `${output.UBER.cohort_relative.dash_spread_30d_pp >= 0 ? "+" : ""}${output.UBER.cohort_relative.dash_spread_30d_pp}pp/30d` : "unavailable"}`);
  console.log(`  UBER XLY-SPY:   ${output.UBER?.factor_flow?.xly_vs_spy_30d_pp != null ? `${output.UBER.factor_flow.xly_vs_spy_30d_pp >= 0 ? "+" : ""}${output.UBER.factor_flow.xly_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  UBER AV shock:  ${output.UBER?.tactical_extras?.worst_1d_return_5s_pct != null ? `worst 5s ${output.UBER.tactical_extras.worst_1d_return_5s_pct}% on ${output.UBER.tactical_extras.worst_1d_date}${output.UBER.tactical_extras.av_shock_candidate_active ? " [CANDIDATE]" : ""}` : "unavailable"}`);
  console.log(`  UBER config:    AV ${output.UBER?.fundamentals?.av_supply_regime_state ?? "—"} → ${UBER_AV_STATE_TO_REGIME[output.UBER?.fundamentals?.av_supply_regime_state] ?? "contested"} | DH ${output.UBER?.fundamentals?.dh_offer_state ?? "—"} (scored ${output.UBER?.fundamentals?.dh_basis_scored ?? "—"}) | tax release in TTM: ${output.UBER?.fundamentals?.tax_release_in_ttm ?? "—"}`);
  console.log(`  CVX oil regime: ${output.CVX?.oil_regime ? (output.CVX.oil_regime.driver_missing ? "NO BRENT — transitional fallback" : `Brent $${output.CVX.oil_regime.brent_spot} vs $${output.CVX.oil_regime.deck_brent} deck = ${output.CVX.oil_regime.deck_deviation_pct >= 0 ? "+" : ""}${output.CVX.oil_regime.deck_deviation_pct}% → ${output.CVX.oil_regime.oil_price_regime}${output.CVX.oil_regime.oil_price_regime !== "anchored" ? `-${output.CVX.oil_regime.regime_direction}` : ""}${output.CVX.oil_regime.brent_spot_stale ? " (STALE)" : ""}`) : "unavailable"}`);
  console.log(`  CVX deck TTM:   ${output.CVX?.fundamentals ? `Brent ${output.CVX.fundamentals.brent_ttm_avg ?? "—"} | HH ${output.CVX.fundamentals.henry_hub_ttm_avg ?? "—"} | window ends ${(output.CVX.fundamentals.ttm_window || []).slice(-1)[0] ?? "—"} | Q3'25 in TTM: ${output.CVX.fundamentals.q3_2025_in_ttm} | share base clean: ${output.CVX.fundamentals.share_count_base_clean}` : "unavailable"}`);
  console.log(`  CVX twin PE:    ${output.CVX?.twin_valuation ? `CVX ${output.CVX.twin_valuation.cvx_pe}x vs XOM ${output.CVX.twin_valuation.xom_pe}x = ${output.CVX.twin_valuation.premium_pct}% premium [trailing GAAP] ⚠ GATED — record only` : "unavailable"}`);
  console.log(`  CVX vs XOM:     ${output.CVX?.cohort_relative?.xom_spread_30d_pp != null ? `${output.CVX.cohort_relative.xom_spread_30d_pp >= 0 ? "+" : ""}${output.CVX.cohort_relative.xom_spread_30d_pp}pp/30d${output.CVX.cohort_relative.twin_dislocation_active ? " [TWIN DISLOCATION]" : ""}` : "unavailable"}`);
  console.log(`  CVX XLE-SPY:    ${output.CVX?.factor_flow?.xle_vs_spy_30d_pp != null ? `${output.CVX.factor_flow.xle_vs_spy_30d_pp >= 0 ? "+" : ""}${output.CVX.factor_flow.xle_vs_spy_30d_pp}pp (${output.CVX.factor_flow.energy_factor_bid})` : "unavailable"}`);
  console.log(`  CVX air pocket: ${output.CVX?.tactical_extras?.largest_1d_move_5s_pct != null ? `largest 5s ${output.CVX.tactical_extras.largest_1d_move_5s_pct}% on ${output.CVX.tactical_extras.largest_1d_date}${output.CVX.tactical_extras.air_pocket_candidate_active ? " [CANDIDATE]" : ""}` : "unavailable"}`);
  console.log(`  Aux quotes:     ${Object.keys(auxQuotes).length} symbols (${Object.keys(auxQuotes).join(", ")})`);
  console.log(`═══════════════════════════════════`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(output, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
