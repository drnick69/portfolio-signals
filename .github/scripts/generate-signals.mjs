#!/usr/bin/env node
// generate-signals.mjs v8.7.0 — Hybrid scoring: 50% deterministic + 50% LLM.
// Deterministic layer handles RSI, 52w position, MAs, valuation math.
// LLM handles qualitative interpretation, catalysts, risks, rationale text.
// v8.7.0: HOLDINGS SWAP — sold ENB (Enbridge, dividend_compounder, 10/45/45),
//       bought CVX (Chevron, integrated_major_capital_returner, 20/35/45).
//       14 holdings preserved. BUILT ON v8.6.0 (PBR.A → UBER): both swaps live
//       in this file, so v8.7.0 supersedes v8.6.0 — deploy this one, not both.
//       Syncs to score-engine V8.6 + fetch-market-data v4.20.
//       CVX: an integrated oil and gas major — a CAPITAL-RETURN FRANCHISE
//       (capex + dividend breakeven < $50 Brent through 2030, $10–20B/yr of
//       buybacks at $60–80, a 39-year dividend streak) bolted to a commodity
//       that sets the level of every reported number (~$0.60B per $1 Brent,
//       ~$0.70B per $1 Henry Hub). Scored at CHEVRON'S OWN $70 BRENT PLANNING
//       DECK, never at spot.
//       (a) Per-holding prompt blocks: CVX (regime-aware drawdown line, GAAP-P/E
//         warning with the 2026-10-30 roll-off, oil regime vs the $70 deck with
//         the TTM deck adjustments pre-computed, XOM twin valuation GATED,
//         twin/cohort rotation at −4pp with SHEL/TTE as context, XLE factor
//         flow, the geopolitical AIR-POCKET screen from fetch v4.20, the live
//         cycle-gate state from the deterministic result, signal-status flags,
//         execution fundamentals and EPS revisions when sourced) in BOTH tracks.
//       (b) FIVE CALIBRATION GUARDRAILS carried into the prompt, all mirroring
//         score-engine V8.6 so the LLM cannot reintroduce on the qualitative
//         side what the engine deliberately gated:
//         - WINDFALL NORMALIZATION + CALENDAR TRAP: spot and consensus multiples
//           are never scored, and NOT via the cyclical inversion (CVX is
//           deliberately NOT added to CYCLICAL_ARCHETYPES). Q3'25 rolls out of
//           the TTM at the 2026-10-30 print — trailing P/E ~22x → ~17x
//           overnight with no change in the business.
//         - TIMING + WORKING CAPITAL: single-quarter EPS and headline CFFO are
//           null signals; TTM ex-WC and adjusted FCF only.
//         - HESS ANNIVERSARY: period-end share count scored only on a clean
//           post-2025-07-18 base; production vs the FY26 guide, never YoY.
//         - BALANCE-SHEET OPTICS: the HESM exit removes ~$3.7B of debt with no
//           cash generated — leverage read ex-deconsolidation.
//         - CYCLE-POSITION GATE: dislocated-high (Brent > $98) floors the
//           BLENDED strategic score at 0 in blendScores() (dislocated-low caps
//           it at 0). The prompt states the live gate state from the
//           deterministic result — and that the engine's normalization inputs
//           are LLM-sourced, so the engine-side gate fails closed every day
//           Brent sits above $98.
//       (c) Geopolitical headlines are classified, not reflexively scored: does
//         the news change the DURATION of the supply disruption (structural for
//         the windfall) or hit a CHEVRON ASSET (PZ, Leviathan, CPC/TCO,
//         Venezuela)? In a dislocated-high regime a de-escalation sell-off is the
//         windfall premium unwinding — information, not an oversold buy.
//       (d) EARNINGS WINDOW: Q3 prints 2026-10-30 before the open — CVX enters
//         the book inside the window, so tactical conviction is halved from day
//         one.
//       (e) TICKER_NEGATIVE_CONSTRAINTS: CVX gets a MINIMAL entry under the same
//         exception logic as MLM/UBER — see the note at the map.
//       Removals: isENB flag (both tracks), enbGuidance (full + search), the
//       ENB yield-spread-vs-10Y data line. "dividend_compounder" was never in
//       CYCLICAL_ARCHETYPES — nothing to remove there. score-engine retains its
//       ENB branches for historical re-scoring — different contract; this file
//       only runs forward.
// v8.6.0: HOLDINGS SWAP — sold PBR.A (Petrobras, em_state_oil_dividend,
//       20/35/45), bought UBER (Uber Technologies, marketplace_demand_aggregator,
//       20/35/45). 14 holdings preserved. Syncs to score-engine V8.5 +
//       fetch-market-data v4.19.
//       UBER: the largest global ride-hailing network and the second-largest US
//       food-delivery platform — a DEMAND AGGREGATOR. ~208M monthly active
//       platform consumers create trip density that supply plugs into; the moat
//       is two-sided liquidity and it is strongest where supply is FRAGMENTED.
//       The single open question is whether autonomous-vehicle supply stays
//       fragmented (lists on Uber) or concentrates and goes direct.
//       (a) Per-holding prompt blocks: UBER (drawdown ladder to 50%, GAAP-P/E
//         warning with the 2026-11-04 roll-off, marketplace-cohort valuation
//         GATED, rotation vs DASH/LYFT/GRAB weighted at −6pp, DASH spread as
//         context, XLY factor flow, the AV-headline-shock PRICE screen from
//         fetch v4.19, AV supply / Delivery Hero config line with the live
//         value-trap gate state, bookings/canary/margin fundamentals and EPS
//         revisions when sourced) in BOTH tracks.
//       (b) FIVE CALIBRATION GUARDRAILS carried into the prompt, all mirroring
//         score-engine V8.5 so the LLM cannot reintroduce on the qualitative
//         side what the engine deliberately gated:
//         - GAAP EARNINGS GATE + CALENDAR TRAP: TTM GAAP net income carries a
//           $4.9B tax valuation-allowance release (rolls off at the 2026-11-04
//           print — trailing P/E roughly doubles overnight) and ±$1.5B quarterly
//           equity revaluations that never roll off. Never scored, either way.
//         - REVENUE NULL SIGNAL + BASIS ASSERTION: business-model changes cut
//           Q2'26 revenue growth by 8pp; GAAP / Adj / Adj-less-SBC EBITDA span
//           ~5 turns on the same EV.
//         - OWNER FCF: yield after SBC (~6.1%, not the ~7.5% headline); NET
//           share count, never gross buyback dollars.
//         - DELIVERY HERO: PENDING, scored STANDALONE until closed (decision
//           2026-10-27 — the LNA known-forward-event precedent deliberately NOT
//           followed); leverage vs the stated <2x gross ceiling.
//         - VALUE-TRAP GATE: disintermediating AV regime + broken or unknown
//           Mobility canary floors the BLENDED strategic score at 0 in
//           blendScores(). The prompt tells the model so, and states the live
//           gate state from the deterministic result.
//       (c) AV headlines are classified, not reflexively scored: does the news
//         change WHERE AV supply lists (structural) or only WHEN a fleet
//         launches (timing)? Waymo going direct in Austin/Atlanta is the BASE
//         CASE (contested regime, scores zero), not a downgrade.
//       (d) EARNINGS WINDOW: Q3 prints 2026-11-04 before the open and the
//         Delivery Hero acceptance period ends 2026-11-05 — UBER enters the book
//         inside the window, so tactical conviction is halved from day one.
//       (e) TICKER_NEGATIVE_CONSTRAINTS: UBER gets a MINIMAL entry under the
//         same exception logic as MLM — see the note at the map.
//       Removals: isPBRA flag (both tracks), pbraGuidance (full + search), the
//       PBR.A-only WTI and BRL/USD data lines. "em_state_oil_dividend" removed
//       from CYCLICAL_ARCHETYPES (no longer in book). score-engine retains its
//       PBR.A branches for historical re-scoring — different contract; this
//       file only runs forward. WTI/BRL remain in the FRED feed (fetch v4.19
//       decision) for the log-signals columns; they simply no longer reach a
//       prompt.
// v8.5.0: HOLDINGS SWAP — sold RDDT (hypergrowth_platform_monetizer, 25/35/40),
//       bought MLM (Martin Marietta Materials, reserve_moat_infrastructure_compounder,
//       20/35/45). 14 holdings preserved. Syncs to score-engine V8.4 +
//       fetch-market-data v4.17.
//       MLM: the second-largest US construction aggregates producer and one of
//       only two genuine domestic pure plays alongside Vulcan. A LOCAL MONOPOLY
//       by haul radius — crushed stone is worth less than the cost of moving it
//       beyond ~25-50 miles, so each quarry owns its circle and there is no
//       exchange price for aggregates anywhere. The moat is PERMITTED RESERVES.
//       (a) Per-holding prompt blocks: MLM (aggregates-cohort valuation vs
//         VMC/CRH/EXP weighted, VMC twin spread carried separately, XLB factor
//         flow, mix-adjusted organic pricing, organic volume, cash GP/ton,
//         COGS/ton ex-freight, end-market split, LNA pro-forma block, federal
//         authorization + state DOT categoricals) in BOTH tracks.
//       (b) THREE CALIBRATION GUARDRAILS carried into the prompt, all mirroring
//         score-engine V8.4 so the LLM cannot reintroduce on the qualitative
//         side what the engine deliberately gated:
//         - DIVESTITURE-GAIN PE GATE: MLM trailing P/E ~12.9x against ~26.8x
//           forward is an ACCOUNTING ARTIFACT (TTM profit margin 36.7% exceeds
//           gross margin 28.2% — impossible from operations; the window carries
//           the Quikrete asset-exchange gain). Engine scores it ZERO whenever
//           trailing < 0.6x forward, and honours premium_pct_reliable from
//           fetch v4.17 on the cohort premium. The prompt says so explicitly.
//         - REPORTED ASP IS A NULL SIGNAL: Q2'26 printed -2% reported vs +3.7%
//           organic mix-adjusted, the gap being pure acquisition/geographic mix.
//           Engine never scores it; the prompt forbids reintroducing it.
//         - WEATHER GATE: a negative organic-volume print accompanied by
//           material weather has its penalty REMOVED, not reduced. Rain is not
//           demand destruction.
//       (c) Leverage scored on the LNA GLIDEPATH (3.7x at close → sub-2.5x
//         within 24 months), never the level. LNA is treated as a KNOWN FORWARD
//         EVENT: approvals landed 2026-08-05 and the $6.5B notes priced
//         2026-08-12, so the prompt instructs pro-forma reasoning from day one.
//       (d) NET share count sign convention INVERTS vs RDDT: negative = buyback.
//         MLM is down ~1.1% YoY and genuinely satisfies the portfolio's buyback
//         criterion, which RDDT never did.
//       (e) TICKER_NEGATIVE_CONSTRAINTS: MLM DOES get an entry — see the long
//         note at the map. This is a deliberate, reasoned exception to the
//         "documented failures only" policy that governed the RDDT non-entry.
//       Removals: isRDDT flag (both tracks), rddtGuidance (full + search), RDDT
//       drawdown/cohort-valuation/cohort-relative/factor-flow/fundamentals/
//       eps-rev data lines. "hypergrowth_platform_monetizer" no longer in book
//       (score-engine retains its branches for historical re-scoring — different
//       contract; this file only runs forward).
// v6.0-v7.4: see git history.
// v7.5: HOLDINGS SWAP — added LHX (defense_prime_backlog_compounder, 20/40/40) and
//       TMO (life_sciences_quality_compounder, 20/35/45); retired MOS and SPY.
// v7.6: HOLDINGS SWAP — replaced ETHA (high_beta_crypto, 30/35/35) with NOW
//       (ai_workflow_quality_compounder, 20/35/45). 12 holdings preserved.
//       NOW: HYBRID of LIN/MSFT-like quality compounder + ASML-like secular agentic-AI
//            workflow cycle + SPY-like long-duration rate sensitivity, tuned for
//            premium-SaaS multiple math. Tightened RSI 40/65, drawdown primary
//            (>12% setup, >20% strong, >25% rare conviction), cohort rotation vs
//            CRM/WDAY/ADBE avg 30d (NOW lagging >5pp = BUY setup), IGV software
//            factor flow vs SPY 30d, real rate overlay (Fed funds − TIPS 10Y for
//            long-duration sensitivity), DXY (~30% non-US revenue), forward PE
//            primacy (engine trailing only — <50x exceptional, 55-65x fair
//            compounder, >70x stretched), cRPO growth as THE positional metric,
//            AI commercialization phase + AI Agent Platform structural moat.
//       Removals: isETHA flag, ethaGuidance (full + search), ETHA alt-season + ETH
//       200DMA data lines. "high_beta_crypto" archetype no longer in book.
// v8.0: LLM-LAYER UPGRADE — model claude-sonnet-4-20250514 → claude-opus-4-8.
//       PROMPT RESTRUCTURE FOR CACHING: static content moved to system blocks with
//       cache_control (ephemeral): block 1 = shared role + portfolio context +
//       scoring rules + hostile-review protocol + output contract (identical across
//       holdings within a track → cache hits from the 2nd holding onward); block 2 =
//       per-ticker archetype guidance + weights (cache hits across retries). Dynamic
//       content (det scores, market data lines, confidence note, calibration block,
//       verified data) moved to the user message. Prompt TEXT preserved verbatim
//       where moved; h.weights still quoted (static), regime weights still win in
//       blending via detScores.weights as before.
//       HOSTILE-REVIEW CONTRACT: each layer must return bear_case, bull_case, and
//       falsifier alongside score + rationale (single-pass adversarial self-review).
//       Hoisted to result.hostile_review for downstream telemetry (logger wiring is
//       a separate task; additive field, no consumer contract changes).
//       STRUCTURED OUTPUT: record_scores tool (schema-validated). Qualitative mode
//       forces tool_choice; search mode keeps tool_choice auto (forcing would block
//       web_search) + legacy text-JSON extraction retained as fallback.
//       DIVERGENCE TELEMETRY: per-layer |det − llm| gap on result.divergence;
//       layers with gap >40 flagged + console warning (calibration analysis input).
//       max_tokens qualitative 1000 → 2500 (hostile-review fields). Cache usage
//       logged per call (cache r{read}/w{write}). No deterministic engine changes;
//       no holdings changes; output contract additive-only.
// v8.0.1: V8.1 SYNC — archetype guidance text updated for score-engine v8.1
//       regime-conditional weights (MSFT/NOW real-rate, LHX ITA-flow, TMO XBI
//       gates replace the stale "static weights / no regime conditioning in v1"
//       sentences in both full and search guidance). regime_driver +
//       regime_basis hoisted from detScores into each result for logger wiring.
//       Text + two additive fields only — no logic changes.
// v8.1.0: TRACK B DURABLE FIX — web-search holdings could finish a turn without
//       calling record_scores (tool_choice stays auto in search mode so web_search
//       isn't blocked). The old fallback scraped JSON from prose; when that missed,
//       fetchLLMScore threw, scoreHolding returned null, and the holding was silently
//       filtered out of the composite rankings (the 9/12 MSFT/NOW/LHX drop). Fix:
//       when a search turn ends with no record_scores tool call, echo the model's own
//       research back and FORCE record_scores in a follow-up turn (web_search stays
//       declared so the echoed web_search_tool_result blocks validate). Legacy
//       prose-scrape retained as a last resort, so this path can never do worse than
//       before. Track A (qualitative) unchanged. No engine/holdings/output changes.
// v8.1.1: COMPLETENESS AUDIT — a run short of the full book (any holding that failed
//       scoring and returned null) previously vanished silently: normalize() filtered
//       the nulls, validCount<4 was the only floor, and nothing recorded WHAT went
//       missing. Now main() computes a data_quality block { expected, scored, missing[],
//       complete } from HOLDINGS minus the scored symbols, logs a loud console error
//       naming the dropped tickers, embeds the block in signal-data.json, and renders a
//       red INCOMPLETE RUN banner at the top of the email when short. Good signals are
//       still published (no hard fail in the 4–11 band); the partial state can no longer
//       look healthy. Additive field + email banner only; no scoring/engine changes.
//       (Downstream: dashboard + Claire rendering of data_quality, and log-signals.mjs
//       persistence into daily-log, are separate follow-ups.)
// v8.1.2: FAILURE-REASON CAPTURE — the completeness audit (v8.1.1) named WHICH holdings
//       dropped but not WHY; the reason was logged to console by scoreHolding's catch and
//       then discarded, so diagnosing a drop needed the authenticated Actions log. Now the
//       catch records symbol → reason in a module-level map, and main() surfaces it as
//       data_quality.failures { SYMBOL: reason }. Because data_quality already propagates
//       to signal-data.json → the dashboard and (via log-signals) the daily-log, every
//       future drop is self-diagnosing from committed artifacts — no Actions log required.
//       data_quality.missing stays a string[] (existing consumers unchanged); failures is
//       additive. No scoring/engine/routing changes.
// v8.1.3: The email INCOMPLETE-RUN banner now lists each dropped holding with its failure
//       reason from data_quality.failures (e.g. "MSFT — Rate limited (force)") instead of a
//       bare symbol list; reasons are HTML-escaped (they carry raw API error text). Falls
//       back to bare symbols when failures is absent (legacy). The dashboard banner
//       (docs/index.html) gets the same treatment. Presentation only — no data changes.
// v8.1.4: TRUNCATION FIX — qualitative (Track A) max_tokens 2500 → 4096. The hostile-review
//       contract (bear/bull/falsifier × 3 layers + summaries + risks + catalysts) for a dense
//       holding overruns 2500 output tokens: TMO exceeded it and hit stop_reason:max_tokens
//       ("Truncated") on all 5 retries → dropped (07-07 run, 11/12). PBR.A was already
//       brushing the ceiling at 2424/2500. Not a timeout — an output-budget cap. max_tokens
//       is a ceiling not a target, so the holdings that finish at ~2000-2400 cost nothing
//       more; TMO gets headroom to complete, which also recovers the ~3 min its 5 identical
//       truncation retries were wasting. The forced-turn call (v8.1.0) bumped to match.
// v8.2.0: VERIFICATION GATE + TEMPORAL Z CONTEXT.
//       (a) IN-RUN VERIFICATION LOOP (generate → verify → corrective retry). Blind retries
//       (v8.1.x) catch structural misses; nothing caught SEMANTIC failures — the AMKBY→AmBev
//       class of identity hallucination, or hostile-review fields returned as empty husks
//       that satisfy the schema but carry no content. New verifyParsed() gate runs on every
//       accepted record_scores payload: score bounds/integrity (the prose-scrape last resort
//       bypasses schema validation, so bounds are re-checked here), non-trivial rationale +
//       bear/bull/falsifier per layer, risks/catalysts minimums, and per-ticker banned-term
//       identity checks (TICKER_NEGATIVE_CONSTRAINTS — the documented AMKBY/LIN/GLNCY
//       confusions). On violation, a corrective turn echoes the model's own output back with
//       the specific violations as a tool_result and FORCES record_scores again. HARD CAPS
//       (non-negotiable, cost control): VERIFY_MAX_TURNS=2 corrective turns per holding,
//       VERIFY_RUN_BUDGET=6 corrective turns per run (both env-tunable); corrective turns
//       reuse the cached system blocks so marginal cost is output tokens only. Exhausted
//       caps: identity violations THROW (a wrong-company analysis is worse than a recorded
//       drop — it flows into data_quality.failures and the v8.1.1 banners); all other
//       residual violations ship with a console warning. Every result now carries a
//       verification { passed, violations, corrective_turns } block for the logger.
//       (b) TEMPORAL Z CONTEXT (calibration-v2.mjs consumer). Cross-sectional z (normalize())
//       ranks a score across the book today; temporal z measures it against the NAME'S OWN
//       trailing 60-session distribution (calibration-loader v1.2: loadTemporalZ /
//       buildTemporalLine / computeTz reading docs/history/calibration-v2.json). Eligible
//       tickers (≥60 obs — 7 today, auto roll-in as names cross the threshold) get one
//       TEMPORAL CONTEXT line in both Track A and Track B prompts; every result gets a tz
//       { tactical, positional, strategic, composite } block (nulls when ineligible) computed
//       post-blend for the logger. File absent → clean no-op (first-run safe). Assignments,
//       weights, and engine parameters are UNCHANGED — temporal z informs the LLM and the
//       telemetry; it moves no thresholds.
// v8.3.0: HOLDINGS ADD — MA (Mastercard, payments_network_quality_compounder, 20/35/45)
//       and ISRG (Intuitive Surgical, surgical_robotics_moat_compounder, 20/35/45).
//       12 → 14 holdings. Matches fetch-market-data v4.14 + score-engine V8.2.
//       (a) Per-holding prompt blocks: MA (twin valuation vs V, twin dislocation +
//       duopoly-vs-SPY fear regime, volume/VAS/rebates fundamentals, disruption
//       narrative-vs-evidence + interchange regulation categoricals) and ISRG
//       (cohort valuation vs MDT/SYK/BSX with 60-120% structural-premium bands,
//       fear rotation, IHI factor flow, procedure-engine fundamentals, moat +
//       2027 instrument-transition categoricals, Jul-16 earnings-window discipline).
//       (b) VERIFY_RUN_BUDGET default 6 → 7: preserves the ~0.5 corrective-turns-
//       per-holding density at 14 names (per-holding cap stays 2; both env-tunable).
//       (c) TICKER_NEGATIVE_CONSTRAINTS: ISRG gains the Intuitive↔Intuit class
//       (turbotax/quickbooks/intuit inc). MA deliberately gets NO entry: V/Visa
//       mentions are INTENTIONAL (twin comparison is the design), the bare ticker
//       "MA" collides with "moving average" prose, and the file's stated policy is
//       documented-failure classes only — no speculative entries.
//       (d) Portfolio-count strings (PORTFOLIO_CONTEXT, shared system blocks,
//       email footer) made dynamic on HOLDINGS.length where still hardcoded.
// v8.4.0: HOLDINGS SWAP — sold IBIT (momentum_store_of_value, 30/35/35), bought
//       RDDT (Reddit, hypergrowth_platform_monetizer, 25/35/40). 14 holdings
//       preserved. Matches fetch-market-data v4.16 + score-engine V8.3.
//       RDDT: the only public pure-play on human-generated conversational content
//            at scale. Built audience (~130M DAUq) monetized through an ad engine
//            still early on its ARPU curve (global $6.18 vs US $11.85). Widest
//            bands in the book (beta 1.94): RSI 32/72, ±4% daily noise floor,
//            drawdown ladder scaled to 60%, ads-cohort rotation vs META/PINS/APP
//            at −8pp (NOT ISRG's −6pp — 6pp is inside this name's noise).
//       Removals: isIBIT flag (both tracks), ibitGuidance (full + search),
//       getIBITPhaseContext() helper, ibitExtensionLine (BTC vs 200DMA) and the
//       halving-cycle data line. "momentum_store_of_value" no longer in book.
//       (a) Per-holding prompt blocks: RDDT (ads-cohort valuation vs META/PINS/APP,
//       ads rotation, XLC factor flow, ad-revenue/ARPU/DAU/margin fundamentals,
//       search-referral + licensing + competitive categoricals, late-Oct earnings
//       window discipline).
//       (b) TWO CALIBRATION GUARDRAILS carried into the prompt text, mirroring the
//       engine V8.3 gates so the LLM half cannot reintroduce what the deterministic
//       half suppresses:
//         - PEG ARTIFACT GATE: RDDT forward PEG ~0.09 is a base effect (EPS
//           inflecting off ~zero), NOT a 10x margin of safety. Both tracks
//           instruct the model to treat sub-0.4 PEG as uninformative.
//         - PARTIAL-WINDOW WARNING: RDDT listed March 2024. Any "10-year average"
//           multiple is spurious and every "3-year average" is a partial window
//           spanning the crossing into GAAP profitability. Own-history anchors are
//           directional only — never ISRG/NOW-grade confidence.
//       (c) DILUTION: prompts require NET share count change (positive = dilution),
//       never headline buyback yield. RDDT repurchased $235M in Q2 2026 while share
//       count still rose ~2.8%. This holding does NOT satisfy the portfolio's
//       aggressive-buyback criterion and the prompt says so rather than hiding it.
//       (d) DISCLOSURE CHANGE: Reddit discontinued the logged-in/logged-out DAU
//       split from Q3 2026. Prompts forbid estimating it — null is the correct
//       value for the single most thesis-relevant metric once withdrawn.
//       (e) TICKER_NEGATIVE_CONSTRAINTS: RDDT deliberately gets NO entry, per the
//       file's documented-failure-classes-only policy (same call as MA at v8.3.0).
//       No RDDT identity confusion has been observed; speculative entries burn
//       corrective turns. Revisit if a WallStreetBets/meme-framing failure appears.

import { readFileSync, writeFileSync } from "fs";
import { computeDeterministicScores, blendScores } from "./score-engine.mjs";
import { loadCalibration, buildCalibrationBlock, computeConfidence, loadTemporalZ, buildTemporalLine, computeTz } from "./calibration-loader.mjs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

let MARKET_DATA = {};
try { MARKET_DATA = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8")); } catch {}

// v8.1.2: symbol → failure reason for holdings that fail scoring (populated in
// scoreHolding's catch, read by main() to build data_quality.failures).
const scoreFailures = {};

const CALIBRATION = loadCalibration();
console.log(`Calibration: ${CALIBRATION.available ? `${CALIBRATION.totalDays} days of history loaded` : "no history yet"}`);

// v8.2.0: temporal-z baselines from calibration-v2.mjs (nightly). Clean no-op when absent.
const TEMPORAL_Z = loadTemporalZ();

// ─── v8.2.0: VERIFICATION GATE ───────────────────────────────────────────────
// Hard caps — non-negotiable cost control on the corrective loop.
const VERIFY_MAX_TURNS = Math.max(0, parseInt(process.env.VERIFY_MAX_TURNS || "2", 10));   // per holding
const VERIFY_RUN_BUDGET = Math.max(0, parseInt(process.env.VERIFY_RUN_BUDGET || "7", 10)); // per run — v8.3.0: 6→7 with 12→14 holdings (~0.5/holding density preserved)
let verifyCorrectionsUsed = 0; // module-level run counter

// Documented identity-confusion classes only (the failure modes this book has
// actually produced), lowercase substrings. Deliberately conservative: a false
// positive here burns a corrective turn, so no speculative entries.
const TICKER_NEGATIVE_CONSTRAINTS = {
  "AMKBY": ["ambev", "brewer", "brewery", " beer", "beverage"], // AMKBY is Maersk (shipping), never AmBev
  "LIN":   ["linkedin"],                                        // LIN is Linde, never LinkedIn
  "GLNCY": ["glencoe"],                                         // GLNCY is Glencore
  "ISRG":  ["turbotax", "quickbooks", "intuit inc"],            // ISRG is Intuitive Surgical, never Intuit (INTU).
                                                                // NOTE: Medtronic/J&J/Hugo/Ottava mentions are CORRECT
                                                                // (named competitors in the archetype) — never ban them.
  // "MA" — deliberately NO entry (v8.3.0): V/Visa mentions are INTENTIONAL (the
  // twin comparison is the archetype design), the bare ticker collides with
  // "moving average" prose, and policy here is documented-failure classes only.
  // "MLM" — DOES get an entry (v8.5.0), and this is a deliberate exception to
  // the "documented failures only" policy that produced the RDDT non-entry
  // above. The reasoning, so a future reader can overturn it if it proves wrong:
  //   • The collision is EXACT and ex ante certain, not speculative. "MLM" is
  //     the standard abbreviation for multi-level marketing — the single most
  //     common expansion of those three letters in English text. This is not a
  //     guess about a plausible future failure mode (which is what the policy
  //     rightly excludes); it is a structural property of the ticker, in the
  //     same class as AMKBY→AmBev, which the book HAS produced.
  //   • The chosen terms have ZERO legitimate use in an aggregates analysis, so
  //     the false-positive risk that motivates the conservative policy is
  //     absent here. There is no correct sentence about crushed stone that
  //     contains "downline".
  // NOT banned, deliberately: "lockheed". Martin Marietta Materials is NOT
  // Lockheed Martin (the original Martin Marietta Corporation merged with
  // Lockheed in 1995; MATERIALS was separated and has no defense business), and
  // that confusion is a real risk — this portfolio separately holds LHX, so a
  // cross-contaminated analysis would be genuinely dangerous. But a CORRECT
  // output might legitimately name Lockheed while disambiguating, and a hard
  // [IDENTITY] fail on an accurate disambiguation would burn a corrective turn
  // for no reason. That risk is handled in the prompt guidance instead, where
  // it costs nothing when the model gets it right.
  "MLM":   ["multi-level marketing", "multilevel marketing", "network marketing",
            "downline", "pyramid scheme"],                      // MLM is Martin Marietta Materials (aggregates), never multi-level marketing
  // "UBER" — DOES get an entry (v8.6.0), MINIMAL by design, under the same
  // exception logic as MLM rather than the documented-failures-only rule:
  //   • The collision is structural: "uber" is an ordinary German word and an
  //     English slang prefix, so a wrong-subject generation has a distinctive,
  //     checkable fingerprint.
  //   • Only terms with ZERO legitimate use in an Uber analysis are listed.
  // NOT banned, deliberately: "waymo", "lyft", "tesla", "doordash" (named
  // AV-supply counterparties and peers — correct outputs name them constantly);
  // "german"/"germany"/"berlin" (Delivery Hero is Berlin-based and
  // Frankfurt-listed — a correct DH sentence contains them); and the "uber-"
  // prefix itself (it appears in quoted headlines). Those risks are handled in
  // the prompt guidance instead, where they cost nothing when the model is right.
  "UBER":  ["übermensch", "ubermensch", "nietzsche"],           // UBER is Uber Technologies (marketplace), never the German word or Nietzsche
  // "CVX" — DOES get an entry (v8.7.0), MINIMAL by design, under the same
  // exception logic as MLM/UBER rather than the documented-failures-only rule:
  //   • The collision is structural: "Chevron" is also the name of the
  //     best-known administrative-law doctrine in US case law (Chevron U.S.A. v.
  //     NRDC, 1984), so a wrong-subject generation has a distinctive, checkable
  //     fingerprint.
  //   • Only terms with ZERO legitimate use in a Chevron equity analysis are
  //     listed.
  // NOT banned, deliberately: "loper bright" (post-Loper Bright challenges to
  // EPA methane and emissions rules are a legitimate regulatory-risk topic for
  // an oil major); "exxon"/"xom" (the twin benchmark and Stabroek partner —
  // correct outputs name it constantly); "hess" (now part of Chevron; HESM is
  // the midstream exit); "caspian"/"cpc"/"chevron phillips" (the TCO export
  // route and the chemicals JV — the prompt demands they be NAMED); "texaco"/
  // "caltex" (Chevron brands); "enbridge" (the replaced holding — a correct
  // output may say so). Those risks are handled in the prompt guidance instead,
  // where they cost nothing when the model is right.
  "CVX":   ["chevron deference", "chevron doctrine", "chevron v. nrdc"],   // CVX is Chevron Corporation (oil major), never the administrative-law doctrine
};

// Semantic + integrity checks on an accepted record_scores payload. Returns an
// array of human-readable violation strings (empty = pass). Prefixes:
//   [IDENTITY]  hard — never ship a wrong-company analysis (throws if uncorrectable)
//   [SCORE]     hard-ish — bounds/type integrity (prose-scrape path bypasses the schema)
//   [CONTRACT]  soft — hostile-review/summary/risks content minimums (ships with warning)
function verifyParsed(symbol, parsed) {
  const violations = [];
  const layers = ["tactical", "positional", "strategic"];

  for (const l of layers) {
    const layer = parsed?.[l];
    const s = layer?.score;
    if (typeof s !== "number" || !Number.isFinite(s) || s < -100 || s > 100) {
      violations.push(`[SCORE] ${l}.score must be a number in [-100, 100]; got ${JSON.stringify(s)}`);
    }
    for (const field of ["rationale", "bear_case", "bull_case", "falsifier"]) {
      const v = layer?.[field];
      const min = field === "rationale" ? 20 : 15;
      if (typeof v !== "string" || v.trim().length < min) {
        violations.push(`[CONTRACT] ${l}.${field} must be a specific, non-trivial string (>=${min} chars)`);
      }
    }
  }
  const cs = parsed?.composite?.score;
  if (typeof cs !== "number" || !Number.isFinite(cs) || cs < -100 || cs > 100) {
    violations.push(`[SCORE] composite.score must be a number in [-100, 100]; got ${JSON.stringify(cs)}`);
  }
  if (typeof parsed?.composite?.summary !== "string" || parsed.composite.summary.trim().length < 20) {
    violations.push(`[CONTRACT] composite.summary must be a non-trivial string (>=20 chars)`);
  }
  for (const listField of ["risks", "catalysts"]) {
    const arr = parsed?.[listField];
    if (!Array.isArray(arr) || arr.filter(x => typeof x === "string" && x.trim().length >= 10).length < 2) {
      violations.push(`[CONTRACT] ${listField} must contain at least 2 specific, non-trivial entries`);
    }
  }

  // Identity: scan all prose the payload carries for this ticker's banned terms.
  const banned = TICKER_NEGATIVE_CONSTRAINTS[symbol];
  if (banned) {
    const proseParts = [];
    for (const l of layers) {
      const layer = parsed?.[l] || {};
      proseParts.push(layer.rationale, layer.bear_case, layer.bull_case, layer.falsifier);
    }
    proseParts.push(parsed?.composite?.summary, parsed?.key_metric?.name, parsed?.key_metric?.value);
    if (Array.isArray(parsed?.risks)) proseParts.push(...parsed.risks);
    if (Array.isArray(parsed?.catalysts)) proseParts.push(...parsed.catalysts);
    const prose = proseParts.filter(x => typeof x === "string").join(" \n ").toLowerCase();
    for (const term of banned) {
      if (prose.includes(term)) {
        violations.push(`[IDENTITY] output mentions "${term.trim()}" — wrong company. ${symbol} is ${HOLDINGS.find(h => h.symbol === symbol)?.name || symbol}; rewrite every affected field for the correct company.`);
      }
    }
  }
  return violations;
}

const HOLDINGS = [
  { symbol: "LHX",   name: "L3Harris",        sector: "Defense Prime",      archetype: "defense_prime_backlog_compounder", weights: { t:.20, p:.40, s:.40 } },
  { symbol: "ASML",  name: "ASML",            sector: "Semis (Litho)",      archetype: "secular_growth_monopoly",          weights: { t:.15, p:.30, s:.55 } },
  { symbol: "LIN",   name: "Linde plc",       sector: "Industrial Gas",     archetype: "oligopoly_quality_compounder",     weights: { t:.20, p:.35, s:.45 } },
  { symbol: "MSFT",  name: "Microsoft",       sector: "AI Infrastructure",  archetype: "ai_infra_quality_compounder",      weights: { t:.20, p:.35, s:.45 } },
  { symbol: "TMO",   name: "Thermo Fisher",   sector: "Life Sciences Tools",archetype: "life_sciences_quality_compounder", weights: { t:.20, p:.35, s:.45 } },
  { symbol: "NOW",   name: "ServiceNow",      sector: "AI Workflow SaaS",   archetype: "ai_workflow_quality_compounder",   weights: { t:.20, p:.35, s:.45 } },
  { symbol: "CVX",   name: "Chevron",         sector: "Integrated Oil & Gas", archetype: "integrated_major_capital_returner", weights: { t:.20, p:.35, s:.45 } }, // ← v8.7.0
  { symbol: "GLNCY", name: "Glencore",        sector: "Diversified Mining", archetype: "diversified_commodity_trader",     weights: { t:.20, p:.35, s:.45 } },
  { symbol: "MLM",   name: "Martin Marietta Materials", sector: "Construction Aggregates", archetype: "reserve_moat_infrastructure_compounder", weights: { t:.20, p:.35, s:.45 } }, // ← v8.5.0
  { symbol: "KOF",   name: "Coca-Cola FEMSA", sector: "LatAm Consumer",     archetype: "em_dividend_growth",               weights: { t:.15, p:.35, s:.50 } },
  { symbol: "UBER",  name: "Uber Technologies", sector: "Mobility & Delivery Marketplace", archetype: "marketplace_demand_aggregator", weights: { t:.20, p:.35, s:.45 } }, // ← v8.6.0
  { symbol: "AMKBY", name: "Maersk",          sector: "Global Shipping",    archetype: "cyclical_trade_bellwether",        weights: { t:.25, p:.35, s:.40 } },
  { symbol: "MA",    name: "Mastercard",      sector: "Payment Networks",   archetype: "payments_network_quality_compounder", weights: { t:.20, p:.35, s:.45 } }, // ← v8.3.0
  { symbol: "ISRG",  name: "Intuitive Surgical", sector: "Surgical Robotics", archetype: "surgical_robotics_moat_compounder", weights: { t:.20, p:.35, s:.45 } }, // ← v8.3.0
];

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
// MOS removed in v7.5 (cyclical_commodity no longer used).
// PBR.A removed in v8.6.0 (em_state_oil_dividend no longer in book).
// CVX (v8.7.0) deliberately NOT added — explicit $70-deck normalization supersedes the inverted-P/E rule.
const CYCLICAL_ARCHETYPES = new Set([
  "diversified_commodity_trader",
  "cyclical_trade_bellwether",
]);

// ─── LLM PROMPT ──────────────────────────────────────────────────────────────
// v8.0: model + structured-output contract ──────────────────────────────────
const MODEL_ID = "claude-opus-4-8";

// Raw-JSON shape — kept as the text-output fallback contract for search mode.
const JSON_TEMPLATE = `{"tactical":{"score":0,"rationale":"","bear_case":"","bull_case":"","falsifier":""},"positional":{"score":0,"rationale":"","bear_case":"","bull_case":"","falsifier":""},"strategic":{"score":0,"rationale":"","bear_case":"","bull_case":"","falsifier":""},"composite":{"score":0,"summary":""},"key_metric":{"name":"","value":""},"risks":["",""],"catalysts":["",""]}`;

const LAYER_SCORE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: -100, maximum: 100, description: "-100 max buy … +100 max sell. 0 = no edge." },
    rationale: { type: "string", description: "Qualitative reasoning with specifics. Non-empty." },
    bear_case: { type: "string", description: "Strongest honest case the stock underperforms from here (pushes score POSITIVE / trim side). Non-empty, specific to today's setup." },
    bull_case: { type: "string", description: "Strongest honest case the stock outperforms from here (pushes score NEGATIVE / buy side). Non-empty, specific to today's setup." },
    falsifier: { type: "string", description: "The specific observable development that would flip the SIGN of your score. Non-empty." },
  },
  required: ["score", "rationale", "bear_case", "bull_case", "falsifier"],
};

const RECORD_SCORES_TOOL = {
  name: "record_scores",
  description: "Record the final structured analysis for this holding. Must be called exactly once, after the hostile review, with the complete scores.",
  input_schema: {
    type: "object",
    properties: {
      tactical: LAYER_SCORE_SCHEMA,
      positional: LAYER_SCORE_SCHEMA,
      strategic: LAYER_SCORE_SCHEMA,
      composite: {
        type: "object",
        properties: {
          score: { type: "integer", minimum: -100, maximum: 100 },
          summary: { type: "string", description: "1-2 sentences on overall thesis including both quant and your judgment. Non-empty." },
        },
        required: ["score", "summary"],
      },
      key_metric: {
        type: "object",
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
        description: "The single most telling data point for this holding right now.",
      },
      risks: { type: "array", items: { type: "string" }, minItems: 2, description: "At least 2 real, current risks." },
      catalysts: { type: "array", items: { type: "string" }, minItems: 2, description: "At least 2 real, upcoming catalysts." },
      price: {
        type: "object",
        properties: { current: { type: "number" }, change_pct: { type: "number" } },
        description: "ONLY in web-search mode when no verified API price was provided: the current price found via search. Omit otherwise.",
      },
    },
    required: ["tactical", "positional", "strategic", "composite", "key_metric", "risks", "catalysts"],
  },
};

// v8.0: hostile-review protocol — single-pass adversarial self-review, shared by both modes.
const HOSTILE_REVIEW_PROTOCOL = `HOSTILE REVIEW PROTOCOL (mandatory, per layer, BEFORE finalizing each score):
1. Draft the score.
2. Attack it. Construct the strongest honest opposing cases: bear_case (case the stock underperforms — pushes score positive/trim side) and bull_case (case it outperforms — pushes score negative/buy side). Both must be specific to today's setup, not generic boilerplate.
3. State the falsifier: the specific, observable development that would flip the sign of your score.
4. Re-test the draft against both cases. If the opposing case survives contact with the data, move the score toward zero.
A layer whose bear_case/bull_case/falsifier could have been written on any day for any stock is a failed analysis.`;

// v8.0: static portfolio map — shared system-block context (also keeps the shared
// prefix above the prompt-caching minimum length so cross-holding cache hits land).
const PORTFOLIO_CONTEXT = `PORTFOLIO CONTEXT — ${HOLDINGS.length} holdings, best-in-class name per fixed category. Category membership is an upstream decision: signals adjust weight WITHIN the book, never entry/exit on membership. Scores are ranked cross-sectionally across holdings each day, so calibration consistency matters more than absolute levels.
${HOLDINGS.map(hh => `• ${hh.symbol} — ${hh.name} (${hh.sector}) | ${hh.archetype} | weights t${Math.round(hh.weights.t*100)}/p${Math.round(hh.weights.p*100)}/s${Math.round(hh.weights.s*100)}`).join("\n")}`;

const SHARED_SYSTEM_QUALITATIVE = `You are a qualitative analyst providing the JUDGMENT half of a hybrid scoring system for one holding in a ${HOLDINGS.length}-name portfolio.

${PORTFOLIO_CONTEXT}

Your job: provide YOUR OWN independent scores for the assigned holding, considering what numbers CANNOT capture:
• Sector trends, competitive dynamics, catalysts, management quality
• Macro regime interpretation (is VIX elevated for good reason?)
• Whether the technical signals are "right" in current context
• News, geopolitical factors, earnings trajectory

SCORING RULES:
• Scores: -100 (max buy) to +100 (max sell). ZERO = no edge.
• Your scores will be BLENDED 50/50 with the deterministic scores provided in the task message.
• If you agree with the quant score, return a similar number. If you disagree, explain why.
• NEUTRAL (0) is correct when you have no qualitative edge to add.
• Signals: ≤-60 STRONG_BUY, -59 to -25 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.

${HOSTILE_REVIEW_PROTOCOL}

OUTPUT CONTRACT:
MANDATORY: Every string field must have substantive text. No empty strings.
• rationale: explain your qualitative reasoning with specifics.
• summary: 1-2 sentences on overall thesis including both quant and your judgment.
• key_metric: the single most telling data point for this holding right now.
• risks/catalysts: at least 2 real items each.
Record your analysis by calling the record_scores tool exactly once.`;

const SHARED_SYSTEM_SEARCH = `You are a SKEPTICAL quantitative analyst scoring one holding in a ${HOLDINGS.length}-name portfolio. Pre-fetched API data for this holding was insufficient, so research it with web search before scoring.

${PORTFOLIO_CONTEXT}

Search for MISSING data: RSI(14), 52-week range, moving averages, recent news/catalysts.
CRITICAL: Do NOT override VERIFIED prices (provided in the task message) with search results.

SCORING: -100 (buy) to +100 (sell). ZERO = no edge. NEUTRAL most days.
Signals: ≤-60 STRONG_BUY, -25 to -59 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.

${HOSTILE_REVIEW_PROTOCOL}

OUTPUT CONTRACT:
Every string field must be non-empty.
When research is complete, you MUST finish by calling the record_scores tool exactly once with your final analysis. If no verified API price was provided, include the price object with the current price found via search.
Fallback ONLY if the tool is unavailable: return ONLY raw JSON in this exact shape (no markdown): ${JSON_TEMPLATE}`;

function buildPrompt(h, detScores) {
  const md = MARKET_DATA[h.symbol] || {};
  const macro = MARKET_DATA._macro || {};
  const isCyclical = CYCLICAL_ARCHETYPES.has(h.archetype);
  const isASML = h.archetype === "secular_growth_monopoly";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";
  const isLIN = h.archetype === "oligopoly_quality_compounder";
  const isMSFT = h.archetype === "ai_infra_quality_compounder";
  const isLHX = h.archetype === "defense_prime_backlog_compounder";
  const isTMO = h.archetype === "life_sciences_quality_compounder";
  const isNOW = h.archetype === "ai_workflow_quality_compounder";  // ← V7.6
  const isMA = h.archetype === "payments_network_quality_compounder";   // ← v8.3.0
  const isISRG = h.archetype === "surgical_robotics_moat_compounder";   // ← v8.3.0
  const isMLM = h.archetype === "reserve_moat_infrastructure_compounder";  // ← v8.5.0
  const isUBER = h.archetype === "marketplace_demand_aggregator";          // ← v8.6.0
  const isCVX = h.archetype === "integrated_major_capital_returner";       // ← v8.7.0

  const curveStr = macro.spread_2s10s != null
    ? `${macro.spread_2s10s >= 0 ? "+" : ""}${macro.spread_2s10s}bps`
    : null;
  const realRate = (macro.fed_funds != null && macro.tips10y != null)
    ? +(macro.fed_funds - macro.tips10y).toFixed(2)
    : null;

  // AMKBY GSCPI line
  let amkbyGscpiLine = null;
  if (isAMKBY && macro.gscpi != null) {
    const g = macro.gscpi;
    const regime = g > 1.5 ? "STRESSED" : g > 0.5 ? "ELEVATED" : g > -0.5 ? "NORMAL" : g > -1.0 ? "CALM" : "VERY CALM";
    amkbyGscpiLine = `GSCPI (supply chain pressure): ${g} (${regime}) — date: ${macro.gscpi_date || "latest"}`;
  }

  // KOF MXN/USD line
  let kofMxnLine = null;
  if (isKOF && macro.mxn_usd != null) {
    const mxn = macro.mxn_usd;
    const regime = mxn < 16 ? "VERY STRONG PESO" : mxn < 17 ? "STRONG PESO" : mxn < 18.5 ? "NORMAL" : mxn < 20 ? "WEAKENING" : "WEAK PESO";
    kofMxnLine = `MXN/USD: ${mxn} (${regime}) — KOF earns ~60% in MXN`;
  }

  // GLNCY COPX line
  let glncyCopxLine = null;
  if (isGLNCY && md.copper_regime) {
    const cr = md.copper_regime;
    const dir = cr.relative_spread_pp > 0.5 ? "GLNCY OUTPERFORMING (diversification premium)" :
                cr.relative_spread_pp < -0.5 ? "COPX LEADING (copper surging, GLNCY catch-up?)" : "INLINE";
    glncyCopxLine = `GLNCY/COPX: ratio ${cr.glncy_copx_ratio ?? "—"} | COPX $${cr.copx_price ?? "—"} (${cr.copx_change_pct >= 0 ? "+" : ""}${cr.copx_change_pct}%) | Spread: ${cr.relative_spread_pp != null ? (cr.relative_spread_pp >= 0 ? "+" : "") + cr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }

  // ── LIN-specific data lines ──────────────────────────────────────────────
  let linPeerValuationLine = null;
  if (isLIN && md.peer_valuation) {
    const pv = md.peer_valuation;
    const prem = pv.premium_pct;
    const regime = prem == null ? "" : prem < 5 ? " — TIGHT (BUY)" : prem < 15 ? " — DESERVED PREMIUM" : prem < 18 ? " — STRETCHED" : " — RICH (TRIM)";
    linPeerValuationLine = `LIN P/E: ${pv.lin_pe ?? "—"}x | APD: ${pv.apd_pe ?? "—"}x | AI.PA: ${pv.ai_pa_pe ?? "—"}x | Peer avg: ${pv.peer_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime}`;
  }
  let linBacklogLine = null;
  if (isLIN && md.backlog) {
    const b = md.backlog;
    const yoy = b.yoy_growth_pct;
    const zone = yoy == null ? "" : yoy > 8 ? " (ACCELERATING)" : yoy > 3 ? " (HEALTHY)" : yoy > 0 ? " (STABLE)" : " (DECELERATING)";
    linBacklogLine = `LIN backlog YoY: ${yoy != null ? (yoy >= 0 ? "+" : "") + yoy + "%" : "—"}${zone} | Last reported: ${b.last_reported_quarter ?? "—"} (leading indicator — earnings lag 2-4Q)`;
  }
  let linFundamentalsLine = null;
  if (isLIN && md.fundamentals) {
    const f = md.fundamentals;
    const roceZone = f.roce_pct == null ? "" : f.roce_pct > 25 ? " (best-in-class)" : f.roce_pct > 22 ? " (slipping)" : " (concerning)";
    linFundamentalsLine = `LIN ROCE: ${f.roce_pct ?? "—"}%${roceZone} | Op margin: ${f.operating_margin_pct ?? "—"}% | Margin trend: ${f.margin_trend ?? "—"}`;
  }
  let linPeerRelativeLine = null;
  if (isLIN && md.peer_relative) {
    const pr = md.peer_relative;
    const dir = pr.relative_spread_pp > 1 ? "LIN OUTPERFORMING APD (quality premium extending)" :
                pr.relative_spread_pp < -1 ? "APD OUTPERFORMING LIN (catch-up potential)" : "INLINE";
    linPeerRelativeLine = `LIN/APD 1m spread: ${pr.relative_spread_pp != null ? (pr.relative_spread_pp >= 0 ? "+" : "") + pr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }
  let linDxyLine = null;
  if (isLIN && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 110 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 105 ? "STRONG USD (HEADWIND)" : dxy > 100 ? "NORMAL" : dxy > 95 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    linDxyLine = `DXY: ${dxy} (${regime}) — LIN ~70% non-US revenue`;
  }
  let linPmiLine = null;
  if (isLIN && (macro.us_ism != null || macro.eu_pmi != null || macro.china_pmi != null)) {
    const pmis = [macro.us_ism, macro.eu_pmi, macro.china_pmi].filter(p => p != null);
    const avg = pmis.length > 0 ? (pmis.reduce((a, b) => a + b, 0) / pmis.length).toFixed(1) : null;
    const regime = avg == null ? "" : avg > 51 ? "EXPANSION" : avg > 49 ? "NEUTRAL" : "CONTRACTION";
    linPmiLine = `Global Mfg PMI: US ISM ${macro.us_ism ?? "—"} | EU ${macro.eu_pmi ?? "—"} | China ${macro.china_pmi ?? "—"} | Avg: ${avg ?? "—"} (${regime})`;
  }
  let linBbbOasLine = null;
  if (isLIN && macro.bbb_oas_bps != null) {
    const oas = macro.bbb_oas_bps;
    const change = macro.bbb_oas_1m_change_bps;
    const regime = oas < 130 ? "TIGHT" : oas < 160 ? "NORMAL" : oas < 200 ? "WIDENING" : "WIDE";
    const trend = change != null ? ` | 1m: ${change >= 0 ? "+" : ""}${change}bps` : "";
    linBbbOasLine = `BBB OAS: ${oas}bps (${regime})${trend} — leads LIN backlog 6-12mo via capex-IRR math`;
  }
  let linOpsLine = null;
  if (isLIN && md.fundamentals && (md.fundamentals.asu_utilization_pct != null || md.fundamentals.price_mix_ex_fx_pct != null)) {
    const u = md.fundamentals.asu_utilization_pct;
    const px = md.fundamentals.price_mix_ex_fx_pct;
    const uZone = u == null ? "" : u > 85 ? " (TIGHT — pricing power)" : u > 80 ? " (HEALTHY)" : u > 75 ? " (NORMAL)" : " (LOOSE — margin pressure)";
    const pxZone = px == null ? "" : px > 2 ? " (MOAT WORKING)" : px > 0 ? " (POSITIVE)" : " (EROSION RISK)";
    linOpsLine = `ASU util: ${u != null ? u.toFixed(1) + "%" + uZone : "—"} | Price/mix ex-FX: ${px != null ? (px >= 0 ? "+" : "") + px.toFixed(1) + "%" + pxZone : "—"}`;
  }
  let linEpsRevLine = null;
  if (isLIN && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    linEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }
  let linPeerAipaLine = null;
  if (isLIN && md.peer_relative_aipa) {
    const sp = md.peer_relative_aipa.relative_spread_pp;
    const dir = sp == null ? "" : sp > 1 ? " (LIN leading)" : sp < -1 ? " (AI.PA leading — triangulation supports buy)" : " (inline)";
    linPeerAipaLine = `LIN/AI.PA 1m spread: ${sp != null ? (sp >= 0 ? "+" : "") + sp + "pp" : "—"}${dir}`;
  }
  let linPremiumDeltaLine = null;
  if (isLIN && md.peer_valuation?.premium_6m_delta_pp != null) {
    const d = md.peer_valuation.premium_6m_delta_pp;
    const dir = d < -3 ? " (COMPRESSING — buy bias)" : d > 3 ? " (EXPANDING — trim bias)" : " (STABLE)";
    linPremiumDeltaLine = `Peer P/E premium 6M Δ: ${d >= 0 ? "+" : ""}${d.toFixed(1)}pp${dir}`;
  }
  let linH2Line = null;
  if (isLIN && md.h2_layer) {
    const h2 = md.h2_layer;
    const c = h2.contracts_90d_usd_m;
    const cZone = c == null ? "" : c > 500 ? " (STRONG)" : c > 100 ? " (NORMAL)" : " (SLOW)";
    const reg = h2.subsidy_regime || "—";
    const gap = h2.lcoe_gap_usd_kg;
    const gapDelta = h2.lcoe_gap_6m_delta;
    const gapDir = gapDelta == null ? "" : gapDelta < -0.5 ? " (CLOSING — H2 thesis activating)" : gapDelta > 0.5 ? " (WIDENING — H2 thesis stalled)" : "";
    linH2Line = `H2 layer: contracts ${c != null ? "$" + c.toFixed(0) + "M/90d" + cZone : "—"} | Subsidy: ${reg} | Green/grey LCOE: ${gap != null ? "$" + gap.toFixed(2) + "/kg" : "—"}${gapDelta != null ? " (6m Δ " + (gapDelta >= 0 ? "+" : "") + gapDelta.toFixed(2) + ")" + gapDir : ""}`;
  }
  let linTacticalExtrasLine = null;
  if (isLIN && (md.tactical_extras || md.factor_flow)) {
    const iv = md.tactical_extras?.iv_rv_ratio;
    const q = md.factor_flow?.qual_vs_spy_30d_pp;
    const dd = md.tactical_extras?.spy_10d_drawdown_pct;
    const lo = md.tactical_extras?.lin_vs_spy_10d_pp;
    const ivLabel = iv != null ? `IV/RV ${iv.toFixed(2)}${iv < 0.9 ? " (compressed — catalyst hunt)" : iv > 1.2 ? " (elevated)" : ""}` : null;
    const qLabel = q != null ? `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp${q > 1 ? " (quality bid active)" : q < -1 ? " (quality under pressure)" : ""}` : null;
    const ddLabel = (dd != null && lo != null) ? `SPY 10d ${dd.toFixed(1)}% / LIN over SPY ${lo >= 0 ? "+" : ""}${lo.toFixed(1)}pp${dd < -3 && lo > 0.5 ? " (growth-scare setup)" : ""}` : null;
    const parts = [ivLabel, qLabel, ddLabel].filter(Boolean);
    if (parts.length > 0) linTacticalExtrasLine = parts.join(" | ");
  }
  let linRegimeLine = null;
  if (isLIN && detScores.regime) {
    const w = detScores.weights;
    const wStr = w ? `T=${Math.round(w.t * 100)}% / P=${Math.round(w.p * 100)}% / S=${Math.round(w.s * 100)}%` : "—";
    const pmi = detScores.regimePmi != null ? detScores.regimePmi.toFixed(1) : "—";
    linRegimeLine = `Active regime: ${detScores.regime.toUpperCase()} (geo-wgt PMI ${pmi}) → composite weights: ${wStr}`;
  }

  // ── MSFT-specific data lines ─────────────────────────────────────────────
  let msftCohortValuationLine = null;
  if (isMSFT && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < -8 ? " — DEEP DISCOUNT (BUY)" : prem < 0 ? " — BELOW COHORT" : prem <= 15 ? " — DESERVED PREMIUM" : prem < 20 ? " — STRETCHED" : " — RICH (TRIM)";
    msftCohortValuationLine = `MSFT P/E: ${cv.msft_pe ?? "—"}x | GOOGL: ${cv.googl_pe ?? "—"}x | META: ${cv.meta_pe ?? "—"}x | AAPL: ${cv.aapl_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let msftCohortRelativeLine = null;
  if (isMSFT && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.rotation_pressure_pp;
    const status = cr.rotation_pressure_active
      ? (rp != null && rp < -10 ? "ACTIVE/STRONG (capital chasing higher-beta AI — buy setup)" : "ACTIVE (mild buy setup)")
      : (rp != null && rp > 5 ? "MSFT LEADING COHORT (quality leadership)" : "INLINE");
    msftCohortRelativeLine = `MSFT 30d: ${cr.msft_30d_return_pct != null ? (cr.msft_30d_return_pct >= 0 ? "+" : "") + cr.msft_30d_return_pct + "%" : "—"} | Cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation pressure: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let msftDrawdownLine = null;
  if (isMSFT && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction buy)" : ddMag > 20 ? "DEEP (high-conviction setup)" : ddMag > 15 ? "MEANINGFUL (compounder buy interest)" : ddMag > 12 ? "SETUP territory" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    msftDrawdownLine = `MSFT drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for AI infra compounder`;
  }
  let msftFactorFlowLine = null;
  if (isMSFT && md.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = md.factor_flow.qual_vs_spy_30d_pp;
    const dir = q > 1 ? "QUALITY BID ACTIVE (MSFT benefits)" : q < -1 ? "QUALITY UNDER PRESSURE" : "INLINE";
    msftFactorFlowLine = `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp (${dir})`;
  }
  let msftDxyLine = null;
  if (isMSFT && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    msftDxyLine = `DXY: ${dxy} (${regime}) — MSFT ~50% non-US revenue`;
  }
  let msftFundamentalsLine = null;
  if (isMSFT && md.fundamentals && (md.fundamentals.azure_growth_cc_pct != null || md.fundamentals.capex_yoy_growth_pct != null || md.fundamentals.fcf_margin_pct != null || md.fundamentals.operating_margin_pct != null)) {
    const f = md.fundamentals;
    const azure = f.azure_growth_cc_pct != null ? `Azure CC: ${f.azure_growth_cc_pct.toFixed(1)}%` : null;
    const om = f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null;
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const cx = f.capex_yoy_growth_pct != null ? `Capex YoY: ${f.capex_yoy_growth_pct >= 0 ? "+" : ""}${f.capex_yoy_growth_pct.toFixed(0)}%` : null;
    const parts = [azure, om, fcf, cx].filter(Boolean);
    if (parts.length > 0) msftFundamentalsLine = `MSFT fundamentals: ${parts.join(" | ")}`;
  }
  let msftEpsRevLine = null;
  if (isMSFT && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    msftEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── LHX-specific data lines ────────────────────────────────────────────
  let lhxDrawdownLine = null;
  if (isLHX && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction)" : ddMag > 18 ? "DEEP (high-conviction setup)" : ddMag > 10 ? "SETUP territory" : ddMag > 5 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    lhxDrawdownLine = `LHX drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for defense prime compounder`;
  }
  let lhxCohortValuationLine = null;
  if (isLHX && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < -10 ? " — WIDE DISCOUNT (BUY — above-norm)" : prem < -5 ? " — NORMAL DISCOUNT range" : prem < 0 ? " — MILD DISCOUNT" : prem < 5 ? " — IN-LINE (rare for LHX)" : " — PREMIUM (TRIM — rare)";
    lhxCohortValuationLine = `LHX P/E: ${cv.lhx_pe ?? "—"}x | LMT: ${cv.lmt_pe ?? "—"}x | NOC: ${cv.noc_pe ?? "—"}x | RTX: ${cv.rtx_pe ?? "—"}x | GD: ${cv.gd_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let lhxCohortRelativeLine = null;
  if (isLHX && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.cohort_rotation_pp;
    const status = cr.cohort_rotation_active
      ? (rp != null && rp < -10 ? "ACTIVE/STRONG (capital flowing to larger primes — buy setup)" : "ACTIVE (mild buy setup)")
      : (rp != null && rp > 5 ? "LHX LEADING COHORT (leadership)" : "INLINE");
    lhxCohortRelativeLine = `LHX 30d: ${cr.lhx_30d_return_pct != null ? (cr.lhx_30d_return_pct >= 0 ? "+" : "") + cr.lhx_30d_return_pct + "%" : "—"} | Cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation Δ: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let lhxFactorFlowLine = null;
  if (isLHX && md.factor_flow?.ita_vs_spy_30d_pp != null) {
    const i = md.factor_flow.ita_vs_spy_30d_pp;
    const dir = i > 1 ? "DEFENSE BID ACTIVE (positional positive)" : i < -1 ? "DEFENSE LAGGING" : "INLINE";
    lhxFactorFlowLine = `ITA vs SPY (30d): ${i >= 0 ? "+" : ""}${i.toFixed(1)}pp (${dir})`;
  }
  let lhxFundamentalsLine = null;
  if (isLHX && md.fundamentals && (md.fundamentals.book_to_bill != null || md.fundamentals.backlog_growth_yoy_pct != null || md.fundamentals.op_margin_pct != null || md.fundamentals.fcf_margin_pct != null)) {
    const f = md.fundamentals;
    const bb = f.book_to_bill != null ? `B/B: ${f.book_to_bill.toFixed(2)}` : null;
    const bl = f.backlog_growth_yoy_pct != null ? `Backlog YoY: ${f.backlog_growth_yoy_pct >= 0 ? "+" : ""}${f.backlog_growth_yoy_pct.toFixed(1)}%` : null;
    const om = f.op_margin_pct != null ? `Op margin: ${f.op_margin_pct.toFixed(1)}%` : (f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null);
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const parts = [bb, bl, om, fcf].filter(Boolean);
    if (parts.length > 0) lhxFundamentalsLine = `LHX fundamentals: ${parts.join(" | ")}`;
  }
  let lhxEpsRevLine = null;
  if (isLHX && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    lhxEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── TMO-specific data lines ────────────────────────────────────────────
  let tmoDrawdownLine = null;
  if (isTMO && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 30 ? "EXTREME (rare conviction)" : ddMag > 25 ? "DEEP (strong conviction setup)" : ddMag > 15 ? "MEANINGFUL SETUP (compounder buy zone)" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    tmoDrawdownLine = `TMO drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for life-sciences compounder`;
  }
  let tmoPeerValuationLine = null;
  if (isTMO && md.peer_valuation) {
    const pv = md.peer_valuation;
    const prem = pv.premium_pct;
    const regime = prem == null ? "" : prem < -10 ? " — DISCOUNT TO DHR (BUY)" : prem < 0 ? " — BELOW DHR" : prem < 10 ? " — IN-LINE" : " — PREMIUM (TRIM)";
    tmoPeerValuationLine = `TMO P/E: ${pv.tmo_pe ?? "—"}x | DHR: ${pv.dhr_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let tmoPeerRelativeLine = null;
  if (isTMO && md.peer_relative) {
    const pr = md.peer_relative;
    const dir = pr.relative_spread_pp > 0.5 ? "TMO OUTPERFORMING DHR" : pr.relative_spread_pp < -0.5 ? "DHR OUTPERFORMING TMO (catch-up potential)" : "INLINE";
    tmoPeerRelativeLine = `TMO/DHR 1d spread: ${pr.relative_spread_pp != null ? (pr.relative_spread_pp >= 0 ? "+" : "") + pr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }
  let tmoBiotechLine = null;
  if (isTMO && md.biotech_overlay) {
    const bo = md.biotech_overlay;
    const x30 = bo.xbi_30d_return_pct;
    const x90 = bo.xbi_90d_return_pct;
    const fund = x90 == null ? "" : x90 > 10 ? " (FUNDING THAWING — TMO bookings tailwind ahead)" : x90 < -10 ? " (FUNDING FROZEN — TMO bookings headwind)" : " (mixed funding signal)";
    const sympathy = bo.sympathy_setup_active ? " | SYMPATHY SETUP ACTIVE (TMO+XBI both down — collateral buy)" : "";
    tmoBiotechLine = `XBI: $${bo.xbi_price ?? "—"} (${bo.xbi_change_pct != null ? (bo.xbi_change_pct >= 0 ? "+" : "") + bo.xbi_change_pct + "%" : "—"}) | 30d: ${x30 != null ? (x30 >= 0 ? "+" : "") + x30 + "%" : "—"} | 90d: ${x90 != null ? (x90 >= 0 ? "+" : "") + x90 + "%" : "—"}${fund}${sympathy}`;
  }
  let tmoTacticalExtrasLine = null;
  if (isTMO && md.tactical_extras) {
    const te = md.tactical_extras;
    const tdSpread = te.tmo_vs_dhr_30d_pp;
    const dir = tdSpread == null ? "" : tdSpread > 1 ? " (TMO leading DHR — quality bid)" : tdSpread < -1 ? " (DHR leading TMO — catch-up potential)" : " (inline)";
    tmoTacticalExtrasLine = `TMO 30d: ${te.tmo_30d_return_pct != null ? (te.tmo_30d_return_pct >= 0 ? "+" : "") + te.tmo_30d_return_pct + "%" : "—"} | TMO-DHR 30d Δ: ${tdSpread != null ? (tdSpread >= 0 ? "+" : "") + tdSpread + "pp" : "—"}${dir}`;
  }
  let tmoFactorFlowLine = null;
  if (isTMO && md.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = md.factor_flow.qual_vs_spy_30d_pp;
    const dir = q > 1 ? "QUALITY BID ACTIVE (TMO benefits)" : q < -1 ? "QUALITY UNDER PRESSURE" : "INLINE";
    tmoFactorFlowLine = `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp (${dir})`;
  }
  let tmoDxyLine = null;
  if (isTMO && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    tmoDxyLine = `DXY: ${dxy} (${regime}) — TMO ~40% non-US revenue`;
  }
  let tmoFundamentalsLine = null;
  if (isTMO && md.fundamentals && (md.fundamentals.organic_growth_pct != null || md.fundamentals.bioprocessing_phase != null || md.fundamentals.op_margin_pct != null || md.fundamentals.operating_margin_pct != null || md.fundamentals.fcf_margin_pct != null)) {
    const f = md.fundamentals;
    const og = f.organic_growth_pct != null ? `Organic growth: ${f.organic_growth_pct >= 0 ? "+" : ""}${f.organic_growth_pct.toFixed(1)}%` : null;
    const bp = f.bioprocessing_phase != null ? `Bioproc phase: ${String(f.bioprocessing_phase).toUpperCase()}` : null;
    const om = f.op_margin_pct != null ? `Op margin: ${f.op_margin_pct.toFixed(1)}%` : (f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null);
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const parts = [og, bp, om, fcf].filter(Boolean);
    if (parts.length > 0) tmoFundamentalsLine = `TMO fundamentals: ${parts.join(" | ")}`;
  }
  let tmoEpsRevLine = null;
  if (isTMO && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    tmoEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── V7.6: NOW-specific data lines ────────────────────────────────────────
  let nowDrawdownLine = null;
  if (isNOW && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction buy)" : ddMag > 20 ? "DEEP (high-conviction setup)" : ddMag > 15 ? "MEANINGFUL (compounder buy interest)" : ddMag > 12 ? "SETUP territory" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    nowDrawdownLine = `NOW drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for AI workflow compounder`;
  }
  let nowCohortValuationLine = null;
  if (isNOW && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < -8 ? " — DISCOUNT TO COHORT (BUY)" : prem < 0 ? " — BELOW COHORT" : prem <= 20 ? " — DESERVED QUALITY PREMIUM" : " — RICH (TRIM — rare)";
    nowCohortValuationLine = `NOW P/E: ${cv.now_pe ?? "—"}x | CRM: ${cv.crm_pe ?? "—"}x | WDAY: ${cv.wday_pe ?? "—"}x | ADBE: ${cv.adbe_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E + EV/Sales)`;
  }
  let nowCohortRelativeLine = null;
  if (isNOW && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.rotation_pressure_pp;
    const status = cr.rotation_pressure_active
      ? (rp != null && rp < -10 ? "ACTIVE/STRONG (capital chasing higher-beta AI/SaaS — buy setup)" : "ACTIVE (mild buy setup)")
      : (rp != null && rp > 5 ? "NOW LEADING COHORT (quality leadership)" : "INLINE");
    nowCohortRelativeLine = `NOW 30d: ${cr.now_30d_return_pct != null ? (cr.now_30d_return_pct >= 0 ? "+" : "") + cr.now_30d_return_pct + "%" : "—"} | Cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation pressure: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let nowFactorFlowLine = null;
  if (isNOW && md.factor_flow?.igv_vs_spy_30d_pp != null) {
    const i = md.factor_flow.igv_vs_spy_30d_pp;
    const dir = i > 1 ? "SOFTWARE BID ACTIVE (NOW benefits)" : i < -1 ? "SOFTWARE UNDER PRESSURE" : "INLINE";
    nowFactorFlowLine = `IGV vs SPY (30d): ${i >= 0 ? "+" : ""}${i.toFixed(1)}pp (${dir})`;
  }
  let nowRealRateLine = null;
  if (isNOW && macro.fed_funds != null && macro.tips10y != null) {
    const rr = +(macro.fed_funds - macro.tips10y).toFixed(2);
    const regime = rr > 2 ? "RESTRICTIVE (long-duration HEADWIND)" : rr > 1 ? "TIGHT" : rr > 0.5 ? "NEUTRAL" : "ACCOMMODATIVE (TAILWIND)";
    nowRealRateLine = `Real rate (Fed funds − TIPS 10Y): ${rr >= 0 ? "+" : ""}${rr}% (${regime}) — NOW long-duration cash-flow sensitivity`;
  }
  let nowDxyLine = null;
  if (isNOW && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    nowDxyLine = `DXY: ${dxy} (${regime}) — NOW ~30% non-US revenue`;
  }
  let nowFundamentalsLine = null;
  if (isNOW && md.fundamentals && (md.fundamentals.crpo_growth_pct != null || md.fundamentals.subscription_revenue_growth_pct != null || md.fundamentals.operating_margin_pct != null || md.fundamentals.fcf_margin_pct != null || md.fundamentals.deals_1m_plus_yoy_pct != null || md.fundamentals.federal_growth_pct != null)) {
    const f = md.fundamentals;
    const cRpo = f.crpo_growth_pct != null ? `cRPO YoY: ${f.crpo_growth_pct.toFixed(1)}%` : null;
    const sub = f.subscription_revenue_growth_pct != null ? `Sub rev YoY: ${f.subscription_revenue_growth_pct.toFixed(1)}%` : null;
    const om = f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct.toFixed(1)}%` : null;
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const deals = f.deals_1m_plus_yoy_pct != null ? `$1M+ deals YoY: ${f.deals_1m_plus_yoy_pct >= 0 ? "+" : ""}${f.deals_1m_plus_yoy_pct.toFixed(0)}%` : null;
    const fed = f.federal_growth_pct != null ? `Federal YoY: ${f.federal_growth_pct >= 0 ? "+" : ""}${f.federal_growth_pct.toFixed(0)}%` : null;
    const parts = [cRpo, sub, om, fcf, deals, fed].filter(Boolean);
    if (parts.length > 0) nowFundamentalsLine = `NOW fundamentals: ${parts.join(" | ")}`;
  }
  let nowEpsRevLine = null;
  if (isNOW && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    nowEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── MA-specific data lines (v8.3.0) ────────────────────────────────────
  let maDrawdownLine = null;
  if (isMA && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction buy)" : ddMag > 20 ? "DEEP (high-conviction setup)" : ddMag > 15 ? "MEANINGFUL (compounder buy interest)" : ddMag > 12 ? "SETUP territory" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    maDrawdownLine = `Mastercard drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for payments-rails compounder`;
  }
  let maTwinValuationLine = null;
  if (isMA && md.twin_valuation) {
    const tv = md.twin_valuation;
    const prem = tv.premium_pct;
    const regime = prem == null ? "" : prem < 0 ? " — DISCOUNT TO V (BUY — rare)" : prem < 5 ? " — COMPRESSED (BUY)" : prem < 10 ? " — BELOW NORMAL PREMIUM" : prem <= 20 ? " — NORMAL faster-grower premium" : prem < 25 ? " — ABOVE NORMAL" : " — RICH (TRIM)";
    maTwinValuationLine = `Mastercard P/E: ${tv.ma_pe ?? "—"}x | Visa: ${tv.v_pe ?? "—"}x | Twin premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E; 10-20% is the BASELINE premium)`;
  }
  let maTwinRelativeLine = null;
  if (isMA && md.twin_relative?.relative_spread_pp != null) {
    const s = md.twin_relative.relative_spread_pp;
    const dir = s > 0.5 ? "MA outperforming V today" : s < -0.5 ? "V outperforming MA today (twin-divergence watch)" : "INLINE";
    maTwinRelativeLine = `Twin daily spread (MA − V): ${s >= 0 ? "+" : ""}${s.toFixed(2)}pp (${dir})`;
  }
  let maDuopolyRelativeLine = null;
  if (isMA && md.duopoly_relative) {
    const dr = md.duopoly_relative;
    const ts = dr.twin_spread_pp;
    const tsStatus = dr.twin_dislocation_active
      ? (ts != null && ts < -8 ? "DISLOCATION ACTIVE/STRONG (twins rarely diverge — buy setup if no MA-specific break)" : "DISLOCATION ACTIVE (mild buy setup)")
      : (ts != null && ts > 4 ? "MA LEADING TWIN" : "INLINE");
    const fr = dr.disruption_fear_regime;
    const frStr = fr == null ? "—" : fr === "acute" ? "ACUTE (networks sold on headlines — buy setup)" : fr === "elevated" ? "ELEVATED" : fr === "absent" ? "ABSENT (re-rating underway)" : "NEUTRAL";
    maDuopolyRelativeLine = `MA 30d: ${dr.ma_30d_return_pct != null ? (dr.ma_30d_return_pct >= 0 ? "+" : "") + dr.ma_30d_return_pct + "%" : "—"} | V 30d: ${dr.v_30d_return_pct != null ? (dr.v_30d_return_pct >= 0 ? "+" : "") + dr.v_30d_return_pct + "%" : "—"} | Twin spread: ${ts != null ? (ts >= 0 ? "+" : "") + ts.toFixed(1) + "pp" : "—"} (${tsStatus}) | Duopoly vs SPY 30d: ${dr.duopoly_vs_spy_pp != null ? (dr.duopoly_vs_spy_pp >= 0 ? "+" : "") + dr.duopoly_vs_spy_pp.toFixed(1) + "pp" : "—"} — fear regime: ${frStr}`;
  }
  let maFactorFlowLine = null;
  if (isMA && md.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = md.factor_flow.qual_vs_spy_30d_pp;
    const dir = q > 1 ? "QUALITY BID ACTIVE (Mastercard benefits)" : q < -1 ? "QUALITY UNDER PRESSURE" : "INLINE";
    maFactorFlowLine = `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp (${dir})`;
  }
  let maDxyLine = null;
  if (isMA && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    maDxyLine = `DXY: ${dxy} (${regime}) — Mastercard ~2/3 international revenue (heavier FX sensitivity than most US compounders)`;
  }
  let maFundamentalsLine = null;
  if (isMA && md.fundamentals && (md.fundamentals.cross_border_growth_pct != null || md.fundamentals.gdv_growth_pct != null || md.fundamentals.switched_txn_growth_pct != null || md.fundamentals.vas_growth_pct != null || md.fundamentals.op_margin_pct != null || md.fundamentals.buyback_share_reduction_yoy_pct != null || md.fundamentals.rebates_incentives_trend != null || md.fundamentals.stablecoin_strategy_execution != null)) {
    const f = md.fundamentals;
    const cb = f.cross_border_growth_pct != null ? `Cross-border YoY: ${f.cross_border_growth_pct.toFixed(1)}%` : null;
    const gdv = f.gdv_growth_pct != null ? `GDV YoY: ${f.gdv_growth_pct.toFixed(1)}%` : null;
    const st = f.switched_txn_growth_pct != null ? `Switched txns YoY: ${f.switched_txn_growth_pct.toFixed(1)}%` : null;
    const vas = f.vas_growth_pct != null ? `VAS YoY: ${f.vas_growth_pct.toFixed(1)}%${f.vas_share_of_revenue_pct != null ? ` (${f.vas_share_of_revenue_pct.toFixed(0)}% of rev)` : ""}` : null;
    const reb = f.rebates_incentives_trend ? `Rebates: ${f.rebates_incentives_trend}` : null;
    const om = f.op_margin_pct != null ? `Adj op margin: ${f.op_margin_pct.toFixed(1)}%` : null;
    const bb = f.buyback_share_reduction_yoy_pct != null ? `Shares YoY: ${f.buyback_share_reduction_yoy_pct.toFixed(1)}%` : null;
    const sc = f.stablecoin_strategy_execution ? `Stablecoin exec: ${f.stablecoin_strategy_execution}` : null;
    const parts = [cb, gdv, st, vas, reb, om, bb, sc].filter(Boolean);
    if (parts.length > 0) maFundamentalsLine = `Mastercard fundamentals: ${parts.join(" | ")}`;
  }
  let maEpsRevLine = null;
  if (isMA && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    maEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── ISRG-specific data lines (v8.3.0) ──────────────────────────────────
  let isrgDrawdownLine = null;
  if (isISRG && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 35 ? "EXTREME (rare category-king buy)" : ddMag > 25 ? "DEEP (high-conviction setup)" : ddMag > 20 ? "MEANINGFUL (moat compounder buy interest)" : ddMag > 15 ? "SETUP territory" : ddMag > 10 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    isrgDrawdownLine = `ISRG drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for surgical-robotics moat compounder (beta ~1.7 — ladder wider than the low-vol names)`;
  }
  let isrgCohortValuationLine = null;
  if (isISRG && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < 60 ? " — UNUSUAL DISCOUNT (BUY — below 60-120% baseline)" : prem < 90 ? " — BELOW MID-PREMIUM (BUY-leaning)" : prem <= 120 ? " — NORMAL category-king premium" : prem < 150 ? " — ABOVE NORMAL" : " — STRETCHED (TRIM)";
    isrgCohortValuationLine = `ISRG P/E: ${cv.isrg_pe ?? "—"}x | MDT: ${cv.mdt_pe ?? "—"}x | SYK: ${cv.syk_pe ?? "—"}x | BSX: ${cv.bsx_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — 60-120% premium is the STRUCTURAL BASELINE; see your search for forward P/E + own-history percentile)`;
  }
  let isrgCohortRelativeLine = null;
  if (isISRG && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.cohort_rotation_pp;
    const status = cr.cohort_rotation_active
      ? (rp != null && rp < -12 ? "FEAR ROTATION ACTIVE/STRONG (narrative selling — buy setup absent procedure evidence)" : "FEAR ROTATION ACTIVE (mild buy setup)")
      : (rp != null && rp > 6 ? "ISRG LEADING COHORT (category-king leadership)" : "INLINE");
    isrgCohortRelativeLine = `ISRG 30d: ${cr.isrg_30d_return_pct != null ? (cr.isrg_30d_return_pct >= 0 ? "+" : "") + cr.isrg_30d_return_pct + "%" : "—"} | Devices cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let isrgFactorFlowLine = null;
  if (isISRG && md.factor_flow?.ihi_vs_spy_30d_pp != null) {
    const i = md.factor_flow.ihi_vs_spy_30d_pp;
    const dir = i > 1 ? "DEVICES BID ACTIVE (ISRG benefits)" : i < -1 ? "DEVICES SECTOR UNDER PRESSURE" : "INLINE";
    isrgFactorFlowLine = `IHI vs SPY (30d): ${i >= 0 ? "+" : ""}${i.toFixed(1)}pp (${dir})`;
  }
  let isrgFundamentalsLine = null;
  if (isISRG && md.fundamentals && (md.fundamentals.procedure_growth_pct != null || md.fundamentals.dv_placements_qtr != null || md.fundamentals.recurring_revenue_pct != null || md.fundamentals.ia_revenue_growth_pct != null || md.fundamentals.op_margin_pct != null || md.fundamentals.moat_status != null || md.fundamentals.instrument_transition_status != null)) {
    const f = md.fundamentals;
    const pg = f.procedure_growth_pct != null ? `Procedures YoY: ${f.procedure_growth_pct.toFixed(1)}%${f.procedure_guide_low_pct != null && f.procedure_guide_high_pct != null ? ` (guide ${f.procedure_guide_low_pct}-${f.procedure_guide_high_pct}%)` : ""}` : null;
    const dv = f.dv_placements_qtr != null ? `dV placements: ${f.dv_placements_qtr}/qtr${f.dv5_mix_pct != null ? ` (dV5 ${f.dv5_mix_pct.toFixed(0)}%)` : ""}` : null;
    const ion = f.ion_procedure_growth_pct != null ? `Ion procedures YoY: ${f.ion_procedure_growth_pct.toFixed(1)}%` : null;
    const rr = f.recurring_revenue_pct != null ? `Recurring: ${f.recurring_revenue_pct.toFixed(0)}% of rev` : null;
    const ia = f.ia_revenue_growth_pct != null ? `I&A YoY: ${f.ia_revenue_growth_pct.toFixed(1)}%` : null;
    const ib = f.installed_base_total != null ? `Installed base: ${f.installed_base_total}${f.installed_base_yoy_pct != null ? ` (+${f.installed_base_yoy_pct.toFixed(1)}% YoY)` : ""}` : null;
    const om = f.op_margin_pct != null ? `Op margin: ${f.op_margin_pct.toFixed(1)}%` : null;
    const ms = f.moat_status ? `Moat: ${f.moat_status}` : null;
    const it = f.instrument_transition_status ? `2027 instrument transition: ${f.instrument_transition_status}` : null;
    const parts = [pg, dv, ion, rr, ia, ib, om, ms, it].filter(Boolean);
    if (parts.length > 0) isrgFundamentalsLine = `ISRG fundamentals: ${parts.join(" | ")}`;
  }
  let isrgEpsRevLine = null;
  if (isISRG && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    isrgEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── MLM-specific data lines (v8.5.0) ───────────────────────────────────
  let mlmDrawdownLine = null;
  if (isMLM && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 30 ? "EXTREME (max tactical conviction IF mix-adjusted pricing intact)" : ddMag > 25 ? "DEEP (high-conviction setup)" : ddMag > 20 ? "MEANINGFUL" : ddMag > 15 ? "SETUP territory" : ddMag > 8 ? "MILD" : ddMag < 3 ? "AT/NEAR HIGHS" : "MODEST";
    mlmDrawdownLine = `MLM drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal; ladder scaled to 35% (beta 1.11), TIGHTER than the high-beta names`;
  }
  // ★ Cohort valuation carries the fetch v4.17 ARTIFACT GATE. When
  // premium_pct_reliable is false the premium is emitted for the record but must
  // NOT be read as a valuation signal — MLM's trailing P/E is contaminated by
  // the Quikrete divestiture gain and the raw premium reads near -50%.
  let mlmCohortValuationLine = null;
  if (isMLM && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const artifact = cv.premium_pct_reliable === false || cv.trailing_discount_artifact_suspected === true;
    const regime = artifact
      ? " — ⚠⚠ ARTIFACT GATED: NOT A BUY. Trailing basis contaminated by the Quikrete divestiture gain. Engine scores this ZERO. Route to FORWARD PE / EV/EBITDA."
      : prem == null ? ""
      : prem < -8 ? " — DISCOUNT (BUY)" : prem <= 10 ? " — NORMAL BAND" : prem <= 18 ? " — ABOVE NORMAL BAND" : " — RICH (TRIM)";
    const twin = cv.mlm_vs_vmc_pct != null ? ` | vs VMC (the twin): ${cv.mlm_vs_vmc_pct >= 0 ? "+" : ""}${cv.mlm_vs_vmc_pct.toFixed(1)}%` : "";
    mlmCohortValuationLine = `MLM P/E: ${cv.mlm_pe ?? "—"}x | VMC: ${cv.vmc_pe ?? "—"}x | CRH: ${cv.crh_pe ?? "—"}x | EXP: ${cv.exp_pe ?? "—"}x | Weighted aggregates cohort avg: ${cv.cohort_avg_pe ?? "—"}x (VMC .50 / CRH .25 / EXP .25) | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${twin}${regime} (TRAILING basis — you source forward P/E separately)`;
  }
  // ★ VMC twin spread is carried SEPARATELY from the 3-name cohort. VMC is the
  // only true like-for-like US aggregates pure play; the twin read is the
  // flagship tactical signal and must not be diluted inside an average.
  let mlmCohortRelativeLine = null;
  if (isMLM && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.peer_rotation_pp;
    const status = cr.peer_rotation_active
      ? (rp != null && rp < -12 ? "AGGREGATES ROTATION ACTIVE/STRONG (buy setup UNLESS an organic-volume or mix-adjusted-pricing print confirms the weakness)" : "AGGREGATES ROTATION ACTIVE (buy setup)")
      : (rp != null && rp > 6 ? "MLM LEADING AGGREGATES COHORT" : "INLINE");
    mlmCohortRelativeLine = `MLM 30d: ${cr.mlm_30d_return_pct != null ? (cr.mlm_30d_return_pct >= 0 ? "+" : "") + cr.mlm_30d_return_pct + "%" : "—"} | Weighted cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status}; threshold −5pp, TIGHTER than RDDT's −8pp because beta is 1.11)`;
  }
  let mlmTwinLine = null;
  if (isMLM && md.cohort_relative?.vmc_spread_30d_pp != null) {
    const cr = md.cohort_relative;
    const vs = cr.vmc_spread_30d_pp;
    const st = cr.vmc_dislocation_active
      ? "TWIN DISLOCATION ACTIVE — the signature MLM setup. Two aggregates franchises with materially identical business models do not diverge for non-operating reasons; verify mix-adjusted pricing before sizing."
      : vs > 5 ? "MLM leading its twin" : "inline";
    mlmTwinLine = `MLM vs VMC (30d, the TWIN read — scored separately from the cohort): ${vs >= 0 ? "+" : ""}${vs.toFixed(1)}pp (${st})`;
  }
  let mlmFactorFlowLine = null;
  if (isMLM && md.factor_flow?.xlb_vs_spy_30d_pp != null) {
    const x = md.factor_flow.xlb_vs_spy_30d_pp;
    const dir = x > 1 ? "MATERIALS BID ACTIVE (MLM benefits)" : x < -1 ? "MATERIALS COMPLEX UNDER PRESSURE" : "INLINE";
    mlmFactorFlowLine = `XLB vs SPY (30d): ${x >= 0 ? "+" : ""}${x.toFixed(1)}pp (${dir})`;
  }
  let mlmFundamentalsLine = null;
  if (isMLM && md.fundamentals && (md.fundamentals.mix_adjusted_organic_pricing_pct != null || md.fundamentals.organic_volume_growth_pct != null || md.fundamentals.cash_gross_profit_per_ton != null || md.fundamentals.federal_authorization_status != null || md.fundamentals.ma_integration_state != null)) {
    const f = md.fundamentals;
    const px = f.mix_adjusted_organic_pricing_pct != null ? `Mix-adjusted ORGANIC pricing: ${f.mix_adjusted_organic_pricing_pct >= 0 ? "+" : ""}${f.mix_adjusted_organic_pricing_pct.toFixed(1)}% ★ THE MOAT METRIC — below 1% is the cleanest falsifier in this model` : null;
    // ⚠ Reported ASP is emitted for CONTEXT ONLY and explicitly marked unscored.
    const rasp = f.reported_asp_signal_status === "null_signal_mix_contaminated"
      ? `Reported ASP${f.reported_asp_usd != null ? ` $${f.reported_asp_usd.toFixed(2)}` : ""}${f.reported_asp_growth_pct != null ? ` (${f.reported_asp_growth_pct >= 0 ? "+" : ""}${f.reported_asp_growth_pct.toFixed(1)}%)` : ""}: ⚠ NULL SIGNAL — mix-contaminated by acquisitions; engine does NOT score it and neither should you`
      : null;
    const ov = f.organic_volume_growth_pct != null ? `Organic volume YoY: ${f.organic_volume_growth_pct >= 0 ? "+" : ""}${f.organic_volume_growth_pct.toFixed(1)}%` : null;
    const rv = f.reported_volume_growth_pct != null ? `Reported volume YoY: ${f.reported_volume_growth_pct >= 0 ? "+" : ""}${f.reported_volume_growth_pct.toFixed(1)}% (incl. acquisitions)` : null;
    const wx = f.weather_impact_flag ? `Weather: ${f.weather_impact_flag}${f.weather_impact_flag === "material_headwind" ? " ⚠ VOLUME PENALTY REMOVED — rain is not demand destruction" : ""}` : null;
    const gp = f.cash_gross_profit_per_ton != null ? `Cash gross profit: $${f.cash_gross_profit_per_ton.toFixed(2)}/ton` : null;
    const cg = f.cogs_per_ton_growth_ex_freight_pct != null ? `COGS/ton ex pass-through freight: ${f.cogs_per_ton_growth_ex_freight_pct >= 0 ? "+" : ""}${f.cogs_per_ton_growth_ex_freight_pct.toFixed(1)}%` : null;
    const en = f.energy_headwind ? `Energy: ${f.energy_headwind}` : null;
    const em = f.ebitda_margin_pct != null ? `Adj EBITDA margin: ${f.ebitda_margin_pct.toFixed(1)}%${f.inventory_step_up_charge_musd ? ` (includes a $${f.inventory_step_up_charge_musd}M NON-CASH inventory step-up — strip before comparing)` : ""}` : null;
    const ends = (f.infrastructure_demand || f.heavy_nonres_demand || f.residential_demand)
      ? `End markets — infrastructure: ${f.infrastructure_demand ?? "—"} | heavy nonres: ${f.heavy_nonres_demand ?? "—"} | residential: ${f.residential_demand ?? "—"}` : null;
    const fa = f.federal_authorization_status ? `Federal authorization: ${f.federal_authorization_status}${f.days_to_authorization_expiry != null ? ` (${f.days_to_authorization_expiry}d to expiry)` : ""} ⚠ short_term_extension is the BASE CASE and scores ZERO, not a downgrade` : null;
    const dot = f.state_dot_budget_trend ? `State DOT budgets: ${f.state_dot_budget_trend}` : null;
    const lna = f.ma_integration_state ? `LNA state: ${f.ma_integration_state}${f.pro_forma_net_leverage != null ? ` | pro-forma net leverage ${f.pro_forma_net_leverage.toFixed(2)}x` : ""}${f.delever_glidepath_status ? ` | glidepath ${f.delever_glidepath_status}` : ""} — leverage scored on the GLIDEPATH (3.7x → sub-2.5x / 24mo), never the level` : null;
    const sc = f.share_count_change_yoy_pct != null ? `NET share count YoY: ${f.share_count_change_yoy_pct >= 0 ? "+" : ""}${f.share_count_change_yoy_pct.toFixed(1)}% (NEGATIVE = BUYBACK — MLM satisfies the portfolio's buyback criterion)` : null;
    const pfs = f.pro_forma_share_count_change_pct != null ? `Pro-forma share count: ${f.pro_forma_share_count_change_pct >= 0 ? "+" : ""}${f.pro_forma_share_count_change_pct.toFixed(1)}% (incl. $6.5B LNA stock consideration)` : null;
    const roic = f.roic_pct != null ? `ROIC: ${f.roic_pct.toFixed(1)}%${f.wacc_pct != null ? ` vs WACC ${f.wacc_pct.toFixed(1)}%` : ""}${f.roic_denominator_distorted ? " ⚠ DENOMINATOR DISTORTED by fresh M&A — flagged, not scored as a quality break" : ""}` : null;
    const res = f.reserve_life_years != null ? `Reserve life: ${f.reserve_life_years}y${f.reserve_tons_millions != null ? ` (${f.reserve_tons_millions}M tons permitted)` : ""} — the moat, quantified` : null;
    const parts = [px, rasp, ov, rv, wx, gp, cg, en, em, ends, fa, dot, lna, sc, pfs, roic, res].filter(Boolean);
    if (parts.length > 0) mlmFundamentalsLine = `MLM fundamentals: ${parts.join(" | ")}`;
  }
  let mlmEpsRevLine = null;
  if (isMLM && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -2 ? " (DOWNWARD)" : " (STABLE)";
    mlmEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── UBER-specific data lines (v8.6.0) ──────────────────────────────────
  let uberDrawdownLine = null;
  if (isUBER && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 40 ? "EXTREME (max tactical conviction IF the Mobility canary holds)" : ddMag > 30 ? "DEEP (high-conviction setup)" : ddMag > 25 ? "MEANINGFUL" : ddMag > 18 ? "SETUP territory" : ddMag > 10 ? "MILD" : ddMag < 3 ? "AT/NEAR HIGHS" : "MODEST";
    uberDrawdownLine = `UBER drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal; ladder scaled to 50% (beta 1.26), between MLM's 35% and RDDT's 60%`;
  }
  // ★ GAAP trailing P/E is printed above in the generic block — this line says
  // why it must not be read. tax_release_in_ttm comes from fetch v4.19's date
  // logic (TRUE through the 2026-11-04 print day).
  let uberGaapPeLine = null;
  if (isUBER && md.valuation?.trailingPE) {
    const tr = md.fundamentals?.tax_release_in_ttm;
    uberGaapPeLine = `UBER GAAP trailing P/E ${md.valuation.trailingPE}x: ⚠⚠ NOT A SIGNAL — ${tr === true ? "TTM carries the $4.9B Q3'25 tax valuation-allowance release (rolls off at the 2026-11-04 print: expect trailing P/E to roughly DOUBLE with no change in the business) plus" : tr === false ? "the tax release has rolled off, but TTM still carries" : "TTM carries"} ±$1.5B quarterly equity-stake revaluations. Engine never scores it; neither should you. Route to owner FCF yield, non-GAAP forward P/E, EV/Adj EBITDA.`;
  }
  // ★ Cohort valuation is PERMANENTLY GATED by fetch v4.19 (premium_pct_reliable
  // hard false — GAAP trailing on both sides, incl. LYFT's tax-benefit P/E).
  let uberCohortValuationLine = null;
  if (isUBER && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    uberCohortValuationLine = `UBER P/E: ${cv.uber_pe ?? "—"}x | DASH: ${cv.dash_pe ?? "—"}x | LYFT: ${cv.lyft_pe ?? "—"}x | GRAB: ${cv.grab_pe ?? "—"}x | Weighted marketplace cohort avg: ${cv.cohort_avg_pe ?? "—"}x (DASH .50 / LYFT .25 / GRAB .25) | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"} — ⚠⚠ GATED, RECORD ONLY: GAAP trailing on BOTH sides (UBER tax release + revaluations; LYFT's ~2x P/E is a tax-benefit artifact). Engine scores this ZERO. Your forward-basis peer read is SECONDARY — it can confirm a strategic score, never carry one.`;
  }
  let uberCohortRelativeLine = null;
  if (isUBER && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.peer_rotation_pp;
    const status = cr.peer_rotation_active
      ? (rp != null && rp < -14 ? "MARKETPLACE ROTATION ACTIVE/STRONG (buy setup UNLESS an Uber operating print confirms the weakness)" : "MARKETPLACE ROTATION ACTIVE (buy setup)")
      : (rp != null && rp > 8 ? "UBER LEADING MARKETPLACE COHORT" : "INLINE");
    uberCohortRelativeLine = `UBER 30d: ${cr.uber_30d_return_pct != null ? (cr.uber_30d_return_pct >= 0 ? "+" : "") + cr.uber_30d_return_pct + "%" : "—"} | Weighted cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status}; threshold −6pp, between MLM's −5 and RDDT's −8 for beta 1.26)${cr.dash_spread_30d_pp != null ? ` | vs DASH ${cr.dash_spread_30d_pp >= 0 ? "+" : ""}${cr.dash_spread_30d_pp.toFixed(1)}pp (context only — DASH is already 50% of the cohort, not a twin; engine does not score it)` : ""}`;
  }
  let uberFactorFlowLine = null;
  if (isUBER && md.factor_flow?.xly_vs_spy_30d_pp != null) {
    const x = md.factor_flow.xly_vs_spy_30d_pp;
    const dir = x > 1 ? "CONSUMER BID ACTIVE (UBER benefits)" : x < -1 ? "CONSUMER COMPLEX UNDER PRESSURE" : "INLINE";
    uberFactorFlowLine = `XLY vs SPY (30d): ${x >= 0 ? "+" : ""}${x.toFixed(1)}pp (${dir}) — GICS says Industrials (~2.6% of XLI); the tape trades UBER as a consumer platform`;
  }
  // ★ AV-HEADLINE-SHOCK PRICE SCREEN (fetch v4.19). The price event is
  // established upstream; ATTRIBUTION is the model's job and lands in its
  // tactical score — the engine scores an unattributed candidate lightly (−6).
  let uberShockLine = null;
  if (isUBER && md.tactical_extras?.worst_1d_return_5s_pct != null) {
    const tx = md.tactical_extras;
    const spy = tx.spy_same_day_return_pct != null ? `, SPY ${tx.spy_same_day_return_pct}% that session` : "";
    const st = tx.av_shock_candidate_active
      ? "SHOCK CANDIDATE — YOU attribute it: a competitor's or partner's AV-supply headline with no Uber operating print = the signature buy setup; an operating print, a broad-tape day or non-AV news = not the setup"
      : tx.worst_1d_on_known_print ? "an Uber print day — operating information, excluded from the screen" : "below the −4% screen threshold";
    uberShockLine = `AV-shock screen: worst session in the last 5 = ${tx.worst_1d_return_5s_pct}% on ${tx.worst_1d_date ?? "—"}${spy} (${st})`;
  }
  // ★ Config + gate state. AV supply and Delivery Hero states are HUMAN-
  // MAINTAINED constants in fetch v4.19; the value-trap gate state comes from
  // the deterministic result so the model sees exactly what blendScores() will do.
  let uberConfigLine = null;
  if (isUBER && md.fundamentals && (md.fundamentals.av_supply_regime_state != null || md.fundamentals.dh_offer_state != null)) {
    const f = md.fundamentals;
    const regimeOf = { partners_adding_uber_supply: "aggregating", leader_exiting_tail_aggregating: "contested", pending_unknown: "contested", second_tier1_exiting: "disintermediating", exclusive_pipeline_slipping: "disintermediating" };
    const reg = regimeOf[f.av_supply_regime_state] ?? "contested";
    const gate = detScores?.strategic?.value_trap_gate_active === true;
    const av = f.av_supply_regime_state ? `AV supply state: ${f.av_supply_regime_state} → regime ${reg.toUpperCase()}${reg === "contested" ? " (the BASE CASE — scores ZERO, not a downgrade)" : ""}` : null;
    const dh = f.dh_offer_state ? `Delivery Hero: ${f.dh_offer_state} — scored ${f.dh_basis_scored ?? "standalone"}, no synergies credited` : null;
    const vt = gate
      ? "⛔ VALUE-TRAP GATE ACTIVE — your strategic score will be FLOORED AT 0 after blending; do not score a strategic BUY"
      : "value-trap gate clear";
    uberConfigLine = `UBER config: ${[av, dh, vt].filter(Boolean).join(" | ")}`;
  }
  let uberFundamentalsLine = null;
  if (isUBER && md.fundamentals && (md.fundamentals.gross_bookings_growth_cc_pct != null || md.fundamentals.mobility_gb_growth_cc_pct != null || md.fundamentals.adj_ebitda_pct_gb != null || md.fundamentals.owner_fcf_yield_pct != null || md.fundamentals.share_count_change_yoy_pct != null)) {
    const f = md.fundamentals;
    const pct = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const gb = f.gross_bookings_growth_cc_pct != null ? `Gross bookings cc: ${pct(f.gross_bookings_growth_cc_pct)}` : null;
    const mob = f.mobility_gb_growth_cc_pct != null ? `Mobility GB cc: ${pct(f.mobility_gb_growth_cc_pct)} ★ THE CANARY — below 12% while Delivery holds is the AV-disintermediation signature` : null;
    const del = f.delivery_gb_growth_cc_pct != null ? `Delivery GB cc: ${pct(f.delivery_gb_growth_cc_pct)}` : null;
    const tr = f.trips_growth_pct != null ? `Trips: ${pct(f.trips_growth_pct)}` : null;
    const mg = f.adj_ebitda_pct_gb != null ? `Adj EBITDA ${f.adj_ebitda_pct_gb.toFixed(1)}% of GB` : null;
    const rev = f.revenue_signal_status === "null_signal_business_model_contaminated" && f.reported_revenue_growth_pct != null ? `Reported revenue ${pct(f.reported_revenue_growth_pct)}: ⚠ NULL SIGNAL — business-model contaminated` : null;
    const ofy = f.owner_fcf_yield_pct != null ? `Owner FCF yield (after SBC): ${f.owner_fcf_yield_pct.toFixed(2)}%` : null;
    const sc = f.share_count_change_yoy_pct != null ? `NET share count YoY: ${pct(f.share_count_change_yoy_pct)} (NEGATIVE = BUYBACK)` : null;
    const parts = [gb, mob, del, tr, mg, rev, ofy, sc].filter(Boolean);
    if (parts.length > 0) uberFundamentalsLine = `UBER fundamentals: ${parts.join(" | ")}`;
  }
  let uberEpsRevLine = null;
  if (isUBER && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 2 ? " (UPWARD)" : r90 < -2 ? " (DOWNWARD)" : " (STABLE)";
    uberEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── CVX-specific data lines (v8.7.0) ───────────────────────────────────
  // Oil regime recomputed from the number — bands IDENTICAL to score-engine
  // V8.6 resolveCVXRegime(), fetch v4.20 cvxOilRegime() and cvx-strategy.jsx v1
  // (|dev| ≤ 20% anchored · ≤ 40% transitional · beyond dislocated; missing
  // Brent → transitional). Keep all four in sync.
  const cvxBrent = isCVX ? (md.oil_regime?.brent_spot ?? md.fundamentals?.brent_spot ?? null) : null;
  const cvxDevRaw = cvxBrent != null && cvxBrent > 0 ? (cvxBrent / 70 - 1) * 100 : null;
  const cvxDev = cvxDevRaw != null ? +cvxDevRaw.toFixed(1) : null;
  const cvxRegKey = cvxDevRaw == null ? "transitional" : Math.abs(cvxDevRaw) <= 20 ? "anchored" : Math.abs(cvxDevRaw) <= 40 ? "transitional" : "dislocated";
  const cvxDir = cvxDevRaw == null ? "none" : cvxDevRaw > 0 ? "high" : cvxDevRaw < 0 ? "low" : "none";
  const cvxWindfall = cvxRegKey === "dislocated" && cvxDir === "high";
  const cvxRegTag = cvxRegKey === "anchored" || cvxDir === "none" ? cvxRegKey.toUpperCase() : `${cvxRegKey.toUpperCase()}-${cvxDir.toUpperCase()}`;

  let cvxOilRegimeLine = null;
  if (isCVX) {
    const o = md.oil_regime || {};
    const w = { anchored: "25/40/35", transitional: "20/35/45", dislocated: "15/30/55" }[cvxRegKey];
    if (cvxBrent == null) {
      cvxOilRegimeLine = `CVX oil regime: Brent UNAVAILABLE (driver missing) → TRANSITIONAL by default, composite weights 20/35/45 (engine V8.6) — source Brent spot yourself and say which regime it implies`;
    } else {
      const extras = [
        o.wti_spot != null ? `WTI $${o.wti_spot}${o.brent_wti_spread != null ? ` (Brent–WTI $${o.brent_wti_spread})` : ""}` : null,
        o.henry_hub_spot != null ? `Henry Hub $${o.henry_hub_spot}` : null,
      ].filter(Boolean).join(" | ");
      cvxOilRegimeLine = `CVX oil regime: Brent $${cvxBrent}${o.brent_spot_date ? ` (${o.brent_spot_date}${o.brent_spot_stale ? " — ⚠ STALE >14d" : ""}; FRED/EIA daily spot, ~1-week lag)` : ""} = ${cvxDev >= 0 ? "+" : ""}${cvxDev}% vs Chevron's $70 planning deck → ${cvxRegTag} | composite weights ${w} (engine V8.6, regime-conditional)${extras ? ` | ${extras}` : ""}`;
    }
  }
  // ★ Deck normalization — the TTM commodity adjustments are pre-computed from
  // fetch v4.20's FRED averages; TTM adjusted FCF and TTM downstream earnings
  // are LLM-sourced (null in the engine's data), so the model completes the sum.
  let cvxNormLine = null;
  if (isCVX && md.fundamentals?.brent_ttm_avg != null) {
    const f = md.fundamentals;
    const eff = v => `${v <= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}B`;   // effect on normalized FCF (an adjustment is SUBTRACTED)
    const bAdj = +((f.brent_ttm_avg - 70) * 0.60).toFixed(2);
    const hAdj = f.henry_hub_ttm_avg != null ? +((f.henry_hub_ttm_avg - 3.50) * 0.70).toFixed(2) : null;
    const win = Array.isArray(f.ttm_window) && f.ttm_window.length ? ` (quarters ending ${f.ttm_window[0]} → ${f.ttm_window[f.ttm_window.length - 1]})` : "";
    const mc = f.market_cap_busd;
    const hhStr = hAdj != null
      ? `TTM Henry Hub $${f.henry_hub_ttm_avg}${f.henry_hub_basis ? " (daily spot, proxy for bid week)" : ""} → ${eff(hAdj)}`
      : `TTM Henry Hub UNAVAILABLE — source it or the normalization is PARTIAL`;
    const formula = `normalized FCF = TTM adj FCF ${eff(bAdj)}${hAdj != null ? ` ${eff(hAdj)}` : " − (TTM HH − 3.50) × 0.70"} − (TTM downstream − 3.0)`;
    const tail = mc != null && mc > 0 ? `; yield = normalized FCF / $${mc}B; price-implied Brent = 70 + (0.06 × ${mc} − normalized FCF) / 0.60` : "";
    cvxNormLine = `CVX deck normalization${win}: TTM Brent $${f.brent_ttm_avg} → ${eff(bAdj)} | ${hhStr}${mc != null ? ` | market cap $${mc}B` : ""}. YOU source TTM adjusted FCF and TTM downstream earnings: ${formula}${tail}. Missing Henry Hub or downstream = normalization_partial — a CEILING while cracks are elevated.`;
  }
  // ★ Cycle-gate state comes from the deterministic result so the model sees
  // exactly what blendScores() will do.
  let cvxGateLine = null;
  if (isCVX) {
    const side = detScores?.strategic?.cycle_gate_active === true ? detScores.strategic.cycle_gate_side : null;
    const normAvail = md.fundamentals?.adj_fcf_ttm_busd != null && md.fundamentals?.brent_ttm_avg != null;
    const st = side === "no_buy"
      ? `⛔ CYCLE-POSITION GATE ACTIVE (no_buy) — your strategic score will be FLOORED AT 0 after blending; do not score a strategic BUY. ${normAvail ? "The engine's normalized yield is below 6% or rests on a PARTIAL normalization (see its strategic notes)" : "The engine's normalization inputs are LLM-sourced and null in its data, so the engine-side gate fails CLOSED while Brent sits above $98 — the floor applies this run whatever normalized yield you establish. Report the normalization honestly anyway; it is the record"}`
      : side === "no_trim"
      ? `⛔ CYCLE-POSITION GATE ACTIVE (no_trim) — Brent more than 40% BELOW the deck: your strategic score will be CAPPED AT 0 after blending; do not score a strategic TRIM. Trough entries are the framework's buy signal${normAvail ? "" : " (the engine's normalization is unavailable, so the cap holds this run regardless)"}`
      : cvxWindfall ? "cycle gate clear — the engine established a normalized yield ≥6% on a full normalization"
      : `cycle gate inactive [${cvxRegTag}] — it binds only beyond ±40% of the deck`;
    cvxGateLine = `CVX cycle gate: ${st}`;
  }
  let cvxDrawdownLine = null;
  if (isCVX && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    if (cvxWindfall) {
      cvxDrawdownLine = `CVX drawdown from 52w high: ${dd.toFixed(1)}% [${cvxRegTag}] — ${ddMag < 3 ? "AT/NEAR HIGHS on windfall oil (mild trim lean)" : "the windfall premium UNWINDING, not oversold — engine scores it ZERO (precedent: buying the 2026-04-01 de-escalation air pocket bought the top of a −21.5% unwind)"}`;
    } else {
      const zone = ddMag > 30 ? "EXTREME (max tactical conviction IF the TCO canary holds)" : ddMag > 20 ? "DEEP (high-conviction setup)" : ddMag > 15 ? "MEANINGFUL" : ddMag > 12 ? "SETUP territory" : ddMag > 6 ? "MILD" : ddMag < 3 ? "AT/NEAR HIGHS" : "MODEST";
      cvxDrawdownLine = `CVX drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) [${cvxRegTag}] — primary tactical signal; ladder scaled to 35% (setup >12%, strong >20%)`;
    }
  }
  // ★ GAAP trailing P/E is printed above in the generic block — this line says
  // why it must not be read. q3_2025_in_ttm comes from fetch v4.20's date logic.
  let cvxGaapPeLine = null;
  if (isCVX && md.valuation?.trailingPE) {
    const q3 = md.fundamentals?.q3_2025_in_ttm;
    cvxGaapPeLine = `CVX GAAP trailing P/E ${md.valuation.trailingPE}x: ⚠⚠ NOT A SIGNAL — windfall- and cycle-contaminated${q3 === true ? "; Q3'25 ($1.82 GAAP EPS on $69 Brent) is still in the TTM and rolls OUT at the 2026-10-30 print — expect trailing P/E to fall from ~22x toward ~17x with NO change in the business" : q3 === false ? "; Q3'25 has rolled off — the TTM is now dominated by war-premium quarters" : ""}; the HESM exit later books a one-time $3–4B loss that distorts it the other way. NOT inverted either (CVX is deliberately not in the cyclical set). Engine never scores it; neither should you — route to normalized FCF at the $70 deck.`;
  }
  // ★ Twin valuation is PERMANENTLY GATED by fetch v4.20 (premium_pct_reliable
  // hard false — windfall on both legs plus CVX's Hess DD&A step-up).
  let cvxTwinValuationLine = null;
  if (isCVX && md.twin_valuation) {
    const tv = md.twin_valuation;
    const prem = tv.premium_pct;
    cvxTwinValuationLine = `CVX P/E: ${tv.cvx_pe ?? "—"}x | XOM (twin): ${tv.xom_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"} [${tv.basis ?? "trailing_gaap"}] — ⚠⚠ GATED, RECORD ONLY: windfall earnings on BOTH legs plus CVX's Hess DD&A step-up. Engine scores this ZERO; your forward-basis twin read (±10%) is SECONDARY${tv.reference_european_avg_pe != null ? ` | SHEL ${tv.reference_shel_pe ?? "—"}x / TTE ${tv.reference_tte_pe ?? "—"}x (avg ${tv.reference_european_avg_pe}x): STRUCTURAL-DISCOUNT reference only — never score CVX's premium to the European majors` : ""}`;
  }
  let cvxCohortRelativeLine = null;
  if (isCVX && md.cohort_relative) {
    const cr = md.cohort_relative;
    const ts = cr.xom_spread_30d_pp;
    const p = v => v != null ? `${v >= 0 ? "+" : ""}${(+v).toFixed(1)}%` : "—";
    const status = cr.twin_dislocation_active
      ? (ts != null && ts < -10 ? "XOM TWIN DISLOCATION ACTIVE/STRONG (buy setup UNLESS a Chevron-specific event explains it — Partitioned Zone, Leviathan, CPC/TCO, Venezuela)" : "XOM TWIN DISLOCATION ACTIVE (buy setup absent a Chevron-specific event)")
      : (ts != null && ts > 6 ? "CVX OUTRUNNING XOM (twin stretched the other way)" : "INLINE");
    const tr = md.twin_relative;
    const today = tr?.relative_spread_pp != null ? ` | Today: CVX ${p(tr.cvx_change_pct)} vs XOM ${p(tr.xom_change_pct)}` : "";
    cvxCohortRelativeLine = `CVX 30d: ${p(cr.cvx_30d_return_pct)} | XOM 30d: ${p(cr.xom_30d_return_pct)} | Twin spread: ${ts != null ? (ts >= 0 ? "+" : "") + ts.toFixed(1) + "pp" : "—"} (${status}; threshold −4pp — same commodity, same calendar, close to oil-neutral, live in every regime)${today}${cr.european_avg_30d_return_pct != null ? ` | SHEL ${p(cr.shel_30d_return_pct)} / TTE ${p(cr.tte_30d_return_pct)} (European avg ${p(cr.european_avg_30d_return_pct)} — context only, engine does not score it)` : ""}`;
  }
  let cvxFactorFlowLine = null;
  if (isCVX && md.factor_flow?.xle_vs_spy_30d_pp != null) {
    const x = md.factor_flow.xle_vs_spy_30d_pp;
    const dir = x > 2
      ? (cvxWindfall ? "ENERGY BID — but in a DISLOCATED-HIGH regime this IS the windfall trade, not a tailwind" : "ENERGY BID ACTIVE (CVX tailwind)")
      : x < -2 ? "ENERGY COMPLEX LAGGING (sector pressure)" : "INLINE";
    cvxFactorFlowLine = `XLE vs SPY (30d): ${x >= 0 ? "+" : ""}${x.toFixed(1)}pp (${dir}; ±2pp threshold) — XLE is the sector factor`;
  }
  // ★ GEOPOLITICAL AIR-POCKET SCREEN (fetch v4.20). The price event is
  // established upstream; CLASSIFICATION of the headline is the model's job —
  // the engine scores only the cases price alone can classify.
  let cvxAirPocketLine = null;
  if (isCVX && md.tactical_extras?.largest_1d_move_5s_pct != null) {
    const tx = md.tactical_extras;
    const mv = tx.largest_1d_move_5s_pct;
    const idio = tx.idiosyncratic_pp;
    const xle = tx.xle_same_day_return_pct != null ? `, XLE ${tx.xle_same_day_return_pct}% that session` : "";
    let st;
    if (tx.air_pocket_candidate_active) {
      if (mv < 0 && idio != null && idio <= -3) st = "CANDIDATE — CHEVRON-SPECIFIC (≥3pp worse than XLE): possible asset event (Partitioned Zone, Leviathan, CPC/TCO, Venezuela) — NOT bought blind; YOU identify it";
      else if (mv < 0 && cvxWindfall) st = `CANDIDATE — sector-wide down session [${cvxRegTag}]: the windfall premium unwinding — information, not oversold (engine scores ZERO)`;
      else if (mv < 0) st = "CANDIDATE — YOU classify it: a sector-wide oil/macro air pocket with no Chevron operating print is a light sympathy buy; a Chevron asset event is not";
      else if (cvxWindfall) st = `CANDIDATE — up spike [${cvxRegTag}]: an escalation spike extends the windfall — mild trim lean`;
      else st = "CANDIDATE — up spike: noted (engine does not score it outside a windfall regime)";
      st += ". Classify the headline: DURATION of the supply disruption (Hormuz, Gulf infrastructure, blockade terms) vs a hit to a CHEVRON ASSET";
    } else {
      st = tx.largest_1d_on_known_print ? "the Q3 print day — operating information, excluded from the screen" : "below the ±4% screen threshold";
    }
    cvxAirPocketLine = `Air-pocket screen: largest session in the last 5 = ${mv >= 0 ? "+" : ""}${mv}% on ${tx.largest_1d_date ?? "—"}${xle}${idio != null ? ` (${idio >= 0 ? "+" : ""}${idio}pp vs XLE)` : ""} — ${st}`;
  }
  let cvxStatusLine = null;
  if (isCVX && md.fundamentals) {
    const f = md.fundamentals;
    const parts = [
      f.forward_pe_signal_status ? `forward P/E: ${f.forward_pe_signal_status}${f.forward_pe_signal_status === "spot_contaminated" ? " (report, never score)" : ""}` : null,
      f.revisions_signal_status ? `EPS revisions: ${f.revisions_signal_status}${f.revisions_signal_status === "commodity_driven" ? " (track the strip — not execution, not scored)" : ""}` : null,
      f.roce_spot_inflated === true ? `ROCE${f.roce_pct != null ? ` ${f.roce_pct}%` : ""}: SPOT-INFLATED (flagged, not scored)` : null,
      f.share_count_base_clean != null ? `share-count base: ${f.share_count_base_clean ? "CLEAN (both period ends after the 2025-07-18 Hess close — the NET change scores)" : "HESS-CONTAMINATED (YoY crosses the 2025-07-18 close — reported, not scored; first clean base 2,013.5M at 2025-09-30)"}` : null,
    ].filter(Boolean);
    if (parts.length > 0) cvxStatusLine = `CVX signal status (fetch v4.20): ${parts.join(" | ")}`;
  }
  let cvxFundamentalsLine = null;
  if (isCVX && md.fundamentals) {
    const f = md.fundamentals;
    const parts = [
      f.production_mboed != null ? `Production ${f.production_mboed} MBOED${f.production_vs_guide ? ` (${String(f.production_vs_guide).toUpperCase()} the FY26 3,980–4,100 guide)` : ""}`
        : f.production_vs_guide ? `Production ${String(f.production_vs_guide).toUpperCase()} the FY26 3,980–4,100 guide` : null,
      f.tco_canary_status ? `TCO canary: ${String(f.tco_canary_status).toUpperCase()}${f.cpc_export_status ? ` (CPC exports ${f.cpc_export_status})` : ""}` : null,
      f.guyana_status ? `Guyana: ${f.guyana_status}` : null,
      f.adj_fcf_ttm_busd != null ? `TTM adj FCF $${f.adj_fcf_ttm_busd}B` : null,
      f.downstream_earnings_ttm_busd != null ? `TTM downstream $${f.downstream_earnings_ttm_busd}B (mid-cycle $3.0B)` : null,
      f.capex_vs_guide ? `Capex: ${f.capex_vs_guide} of the $18–19B guide` : null,
      f.buyback_guide_trend ? `Buyback guide: ${String(f.buyback_guide_trend).toUpperCase()}${f.next_q_buyback_guide_low_busd != null ? ` ($${f.next_q_buyback_guide_low_busd}–${f.next_q_buyback_guide_high_busd ?? "?"}B next quarter)` : ""}` : null,
      f.share_count_change_yoy_pct != null ? `NET share count YoY: ${f.share_count_change_yoy_pct >= 0 ? "+" : ""}${f.share_count_change_yoy_pct.toFixed(1)}%${f.share_count_base_clean === true ? " (NEGATIVE = BUYBACK)" : " (Hess-contaminated — not scored)"}` : null,
      f.net_debt_ratio_ex_deconsolidation_pct != null ? `Net debt ratio ex-HESM: ${f.net_debt_ratio_ex_deconsolidation_pct}%` : null,
      f.breakeven_status ? `Breakeven vs $50: ${f.breakeven_status}` : null,
    ].filter(Boolean);
    if (parts.length > 0) cvxFundamentalsLine = `CVX fundamentals: ${parts.join(" | ")}`;
  }
  let cvxEpsRevLine = null;
  if (isCVX && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 2 ? " (UPWARD)" : r90 < -2 ? " (DOWNWARD)" : " (STABLE)";
    const exec = md.fundamentals.revisions_signal_status === "execution";
    cvxEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}${exec ? " — ANCHORED regime: execution-driven, scored" : " — COMMODITY-DRIVEN: tracks the strip, not scored"}`;
  }

  const dataLines = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.price?.week52_high ? `52-Week: High $${md.price.week52_high} | Low $${md.price.week52_low} | Position: ${md.price.week52_position_pct}%` : null,
    md.technicals?.rsi14 != null ? `RSI(14): ${md.technicals.rsi14}` : null,
    md.technicals?.sma50 ? `SMA 50: $${md.technicals.sma50} | SMA 200: $${md.technicals.sma200 ?? "N/A"} | Signal: ${md.technicals.ma_signal}` : null,
    md.valuation?.trailingPE ? `P/E (trailing): ${md.valuation.trailingPE}` : null,
    md.valuation?.priceToBook ? `P/B: ${md.valuation.priceToBook}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
    amkbyGscpiLine, kofMxnLine, glncyCopxLine,
    linPeerValuationLine, linBacklogLine, linFundamentalsLine, linPeerRelativeLine, linDxyLine, linPmiLine,
    linBbbOasLine, linOpsLine, linEpsRevLine, linPeerAipaLine, linPremiumDeltaLine, linH2Line, linTacticalExtrasLine, linRegimeLine,
    msftDrawdownLine, msftCohortValuationLine, msftCohortRelativeLine, msftFactorFlowLine, msftDxyLine, msftFundamentalsLine, msftEpsRevLine,
    lhxDrawdownLine, lhxCohortValuationLine, lhxCohortRelativeLine, lhxFactorFlowLine, lhxFundamentalsLine, lhxEpsRevLine,
    tmoDrawdownLine, tmoPeerValuationLine, tmoPeerRelativeLine, tmoBiotechLine, tmoTacticalExtrasLine, tmoFactorFlowLine, tmoDxyLine, tmoFundamentalsLine, tmoEpsRevLine,
    nowDrawdownLine, nowCohortValuationLine, nowCohortRelativeLine, nowFactorFlowLine, nowRealRateLine, nowDxyLine, nowFundamentalsLine, nowEpsRevLine,   // ← V7.6
    maDrawdownLine, maTwinValuationLine, maTwinRelativeLine, maDuopolyRelativeLine, maFactorFlowLine, maDxyLine, maFundamentalsLine, maEpsRevLine,        // ← v8.3.0
    isrgDrawdownLine, isrgCohortValuationLine, isrgCohortRelativeLine, isrgFactorFlowLine, isrgFundamentalsLine, isrgEpsRevLine,                          // ← v8.3.0
    mlmDrawdownLine, mlmCohortValuationLine, mlmCohortRelativeLine, mlmTwinLine, mlmFactorFlowLine, mlmFundamentalsLine, mlmEpsRevLine,                   // ← v8.5.0
    uberDrawdownLine, uberGaapPeLine, uberCohortValuationLine, uberCohortRelativeLine, uberFactorFlowLine, uberShockLine, uberConfigLine, uberFundamentalsLine, uberEpsRevLine,  // ← v8.6.0
    cvxOilRegimeLine, cvxNormLine, cvxGateLine, cvxDrawdownLine, cvxGaapPeLine, cvxTwinValuationLine, cvxCohortRelativeLine, cvxFactorFlowLine, cvxAirPocketLine, cvxStatusLine, cvxFundamentalsLine, cvxEpsRevLine,  // ← v8.7.0
    macro.vix ? `VIX: ${macro.vix}` : null,
    macro.us10y ? `10Y: ${macro.us10y}% | 2Y: ${macro.us2y}%${curveStr ? ` | 2s10s curve: ${curveStr}` : ""}` : null,
    macro.tips10y ? `TIPS 10Y (real): ${macro.tips10y}%${realRate != null ? ` | Fed Funds real rate: ${realRate}%` : ""}` : null,
    macro.hy_oas ? `HY OAS credit spread: ${macro.hy_oas}bps` : null,
  ].filter(Boolean).join("\n");

  const cyclicalWarning = isCyclical ? `
CRITICAL — CYCLICAL VALUATION RULES FOR ${h.symbol}:
${h.symbol} is a CYCLICAL business (archetype: ${h.archetype}). Trailing P/E must be interpreted INVERSELY:
• HIGH trailing P/E (>50x) = earnings are at TROUGH = this is a BUY signal, NOT expensive
• LOW trailing P/E (<10x) = earnings are at PEAK = cycle rollover risk = TRIM signal
• "Buy cyclicals when the P/E looks terrible, sell when it looks cheap." — Peter Lynch
• The deterministic engine has already applied inverted PE scoring. Your qualitative score should NOT penalize high trailing P/E for this holding. Instead, consider whether the earnings trough is deepening or recovering.
` : "";

  const asmlGuidance = isASML ? `
CRITICAL — ASML-SPECIFIC SCORING GUIDANCE:
ASML is a SECULAR GROWTH MONOPOLY — sole EUV supplier. Compounds up-and-to-the-right.
DO NOT PENALIZE: 52w proximity (normal for compounder), RSI 65-75 (normal momentum), trailing P/E 30-42x (normal range), P/B (irrelevant), golden cross MA (default state).
TRIM BIAS (rare): Forward P/E >45x, book-to-bill <1.0, TSMC+Samsung+Intel ALL cutting capex, China revenue collapse.
BUY BIAS (rare but powerful): Drawdown >15% from highs, forward P/E <25x, TSMC rev accelerating + backlog growing, big single-day drops on non-fundamental news.
STRUCTURAL: ~3-5% annual buybacks ("sneaky buyback monster"), High-NA EUV ramp ($350M+/tool), 2-3yr backlog visibility.
YOUR VALUE-ADD: Forward P/E (#1 contribution), TSMC/Samsung/Intel capex commentary, China export controls, WFE cycle position.
MOST DAYS = NEUTRAL (±10). Scores beyond ±15 only on genuine drawdowns or valuation extremes.
` : "";

  const amkbyGuidance = isAMKBY ? `
CRITICAL — AMKBY-SPECIFIC SCORING GUIDANCE:
Maersk is a CYCLICAL TRADE BELLWETHER. INVERTED P/E. Shipping cycles MORE EXTREME than commodities: PE 2-5x = peak (trim), PE 6-12x = mid, PE 15-25x = below-trend, PE 50+ = trough buy. P/B matters (asset-heavy fleet): <0.7 = below replacement = strong buy. Engine scores both with enhanced weights.

YOUR PRIMARY VALUE-ADD — FREIGHT RATES AND TRADE VOLUMES:
Engine has NO freight rate data (WCI, SCFI, BDI paywalled). Search for: Drewry WCI / SCFI rates and trend, BDI, CPB World Trade Monitor, Red Sea/Suez disruptions, tariff/trade war impacts, sustainability of rate levels.

SUM-OF-PARTS:
Market often prices logistics segment at ZERO during freight troughs. Logistics implied EV/EBITDA vs DSV (~20x), Kuehne+Nagel (~15-20x). <5x peer = structural undervaluation.

GSCPI CONTEXT: >1.5 = supply chain stress, <-0.5 = calm markets.
SCORES MORE VOLATILE: ±15-25 during active freight markets.
` : "";

  const kofGuidance = isKOF ? `
CRITICAL — KOF-SPECIFIC SCORING GUIDANCE:
KOF is Coca-Cola FEMSA, largest Coke bottler in LatAm, ~60% Mexico revenue. Consumer staples compounder. Trades as USD ADR but earns in MXN/BRL/COP.

#1 DRIVER: MXN/USD (engine scores level). Strong peso = ADR rises. Weak peso = falls. Your job: assess direction.
DO NOT PENALIZE: 52w proximity, RSI 50-65, P/E 15-22x.
YOUR VALUE-ADD: Mexican consumer trends, Banxico rate decisions, nearshoring impact, sugar/PET costs, geographic volume mix, KO parent guidance, vs Arca Continental, dividend growth.
MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on MXN regime shifts, EM selloffs, margin surprises, Banxico pivots.
` : "";

  const glncyGuidance = isGLNCY ? `
CRITICAL — GLNCY-SPECIFIC SCORING GUIDANCE:
Glencore is DIVERSIFIED COMMODITY TRADER (mining copper 30% / coal 25% / zinc-nickel-cobalt + trading arm). INVERTED P/E with trading-arm floor ($2-4B EBITDA in troughs). PE 6-20x mid, PE 40+ trough buy, PE 3-6x peak trim. P/B <0.8 = below replacement = strong buy.

YOUR VALUE-ADD — COPPER + COMMODITIES:
Engine has COPX proxy, no direct LME copper. Search for: LME copper price/trend (~30% of mining EBITDA lead indicator), LME copper inventories, Chinese PMI/property, zinc/nickel/cobalt prices, coal price + ESG dynamics, DXY direction.

SUM-OF-PARTS: Trading arm should trade 8-12x ($2-4B EBITDA on minimal capital). Market often prices at zero in troughs.
COPX RATIO: COPX leading = pure copper leading, GLNCY may catch up. GLNCY leading = trading arm getting credit.
SCORES: ±10-20 during active commodity markets.
` : "";


  const linGuidance = isLIN ? `
CRITICAL — LIN-SPECIFIC SCORING GUIDANCE (V3):
LIN is Linde plc — world's #1 industrial gas company in a 3-player oligopoly with Air Products (APD) and Air Liquide (AI.PA). Quality compounder, 30+ year Dividend Aristocrat, ~30% on-site take-or-pay contracts with inflation pass-through. Best-in-class operator: ROCE >25%, operating margin >30%.

V3 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
The deterministic engine now scores all of the following quantitatively. If you agree with the quant's score on a layer, return a similar number — your job is what numbers can't capture, not to repeat them.
• Peer P/E premium vs APD/AI.PA + 6M delta direction (engine treats compression as buy bias)
• ROCE durability + operating margin trend
• ASU capacity utilization (THE core operational metric for industrial gas — high util = pricing power)
• Like-for-like price/mix ex-FX (replaces categorical moat checks — actual moat measurement)
• EPS estimate revisions trend (30d / 90d, FactSet/Refinitiv consensus delta)
• BBB OAS credit spread + 1m change (leads backlog 6-12mo via project-sanctioning IRR math)
• IV/RV compression (catalyst-hunt setup) and QUAL factor flow vs SPY
• Deterministic growth-scare amplifier (SPY 10d drawdown + LIN outperformance)
• H2 layer concrete metrics: contract dollar value 90d trailing, subsidy regime, green/grey LCOE gap + 6m direction
• Triangulated peer-relative — LIN vs APD AND AI.PA spreads both scored
• DXY FX overlay (LIN ~70% non-US revenue)
• Geo-weighted PMI composite (40/30/30 Americas/EMEA/APAC) drives REGIME-CONDITIONAL composite weights:
  - Expansion (PMI >55): 25/40/35 — tilt toward operating leverage
  - Neutral (PMI 48-55): 20/35/45 — default compounder weights
  - Contraction (PMI <48): 15/30/55 — tilt toward valuation re-rating
  See "Active regime" line in market data above — interpret in line with the live regime.

WHAT DRIVES LIN (in order of importance):
1. PEER VALUATION DISCIPLINE: LIN trades at a premium to APD/AI.PA because it deserves one (highest ROCE, best margins, most contracted revenue). The cleanest valuation signal is the premium spread + its 6M direction. Engine scores both. If you agree, return similar.
2. STRUCTURAL TAILWINDS — multi-year compounding drivers (THIS IS YOUR PRIMARY VALUE-ADD):
   • Hydrogen economy buildout: LIN is the global #1 H2 producer (blue + green). Mega-project announcements (>$1B) are major catalysts. Watch IRA 45V tax credit guidance, EU H2 Bank auctions, customer offtake agreements (steel, ammonia, refining). Engine sees the contract $ — you assess offtake quality and policy momentum.
   • Decarbonization capex: CCUS deployments, customer Net Zero commitments driving demand for industrial gas in carbon capture chains.
   • Semi fab buildouts: Specialty gases (neon, helium, ultra-high-purity nitrogen, argon) for TSMC Arizona, Samsung Texas, Intel Ohio, Micron New York. Each fab = multi-year on-site contract.
3. BACKLOG GROWTH: Sale-of-gas + on-site project pipeline, reported quarterly. Leading indicator — earnings lag 2-4 quarters. Engine scores YoY growth.

WHAT NOT TO PENALIZE:
• Proximity to 52-week highs — normal state for a compounder
• RSI 60-70 — normal range for low-volatility quality stock (LIN daily moves typically 0.5-1.5%, engine has tightened band 35/70)
• Trailing P/E 26-32x — normal compounder range
• P/B (high due to Praxair merger goodwill — the metric is uninformative for LIN)
• Premium to APD/AI.PA in the 5-15% range — that IS the quality moat being priced
• Active regime context: don't fight the regime weights. If engine is in CONTRACTION mode (defensive bid), structural strategic signals matter more than tactical noise.

WHAT EARNS BUY BIAS (in addition to engine signals):
• Mega-scale hydrogen project announcement (LNG-equivalent industrial gas project win — engine sees the contract $ but not the strategic significance)
• Semi capex super-cycle confirmation (multiple fab announcements in same quarter)
• IRA 45V or EU H2 Bank tightening interpretation that broadens green H2 economics
• Earnings beat with backlog acceleration vs consensus (the engine sees the metric, not the surprise)
• Defensive bid setup confirmation: engine flags growth-scare via SPY/LIN 10D math; you confirm it's macro-driven not LIN-specific

WHAT EARNS TRIM BIAS (in addition to engine signals):
• Mega-cap rotation away from quality (engine sees QUAL flow direction; you confirm narrative)
• Capital misallocation news: large value-destroying M&A
• Backlog growth turning negative + margins compressing simultaneously (multi-engine signals confirming)
• ROCE slipping below 22% with structural cause (moat erosion, not just timing)
• Price/mix ex-FX going negative (engine flags moat erosion risk; you assess durability)

YOUR VALUE-ADD FOR LIN (REFOCUSED):
With the engine scoring 30+ data points, your job is qualitative interpretation of what numbers can't capture:
• Mega-project announcements: H2 plant wins >$1B (each is a multi-day move catalyst), LNG ammonia offtake commitments, semi fab on-site contracts (e.g., TSMC Arizona, Samsung Texas, Intel Ohio, Micron NY)
• Regulatory implementation specifics: IRA 45V tax credit guidance evolution, EU H2 Bank auction outcomes, JP/KR Contracts-for-Difference structure
• Customer offtake quality: who is signing? Steel? Ammonia? Refining? Government-backed or private? Take-or-pay vs spot?
• Capital allocation pivots: special dividend signals, large M&A (cylinder business in EM, healthcare gases), buyback acceleration beyond ~3-4% baseline
• Earnings beats/misses with backlog inflection — the engine sees the metric, not the surprise vs consensus
• Specialty gas dynamics: helium scarcity pricing, neon supply (Ukraine pre-war was 50% global), rare-gas margins
• Competitive moves: APD's reset under new CEO, AI.PA's regional strategy
• China export-control impact on global semi capex flow (and thus on-site contract pipeline)

MOST DAYS SHOULD BE NEUTRAL:
LIN is a quality compounder with low daily vol. Composite scores between -5 and +5 roughly 80% of trading days. Meaningful scores appear during: peer premium dislocations (engine flags), H2 mega-project announcements (you flag), regulatory pivots (you flag), or earnings beats/misses with backlog inflection.
` : "";

  const msftGuidance = isMSFT ? `
CRITICAL — MSFT-SPECIFIC SCORING GUIDANCE (V1):
MSFT is Microsoft — AI infrastructure quality compounder. HYBRID archetype: LIN-like quality compounder + ASML-like secular growth + SPY-like rate sensitivity. Best-in-class operating margins (~44%), Azure as primary AI infrastructure beneficiary, OpenAI partnership as proprietary distribution moat, ~10% buyback yield baseline.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/65 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>12% setup, >20% strong, >25% rare conviction)
• Cohort rotation pressure vs GOOGL/META/AAPL avg 30d (capital flowing to higher-beta AI is a BUY setup, not a warning)
• QUAL factor flow vs SPY (mechanical quality bid)
• Compounder MA + 52w (no penalty at golden cross or near highs)
• Cohort P/E premium vs GOOGL/META/AAPL (TRAILING P/E via Finnhub free tier)
• TIPS + DXY overlays (long-duration rate sensitivity + ~50% non-US revenue)
• Composite weights regime-conditional on real rate (fed funds − 10Y TIPS), engine V8.1: <0.5% accommodative 25/40/35 · 0.5–2% neutral 20/35/45 · >2% restrictive 15/30/55

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E and PE-vs-3Y/5Y-history. If forward P/E tells a different story than trailing (trailing 25x looks cheap but forward 32x is rich on decelerating growth), call that out clearly.

WHAT DRIVES MSFT:
1. AZURE CC GROWTH TRAJECTORY (central operational metric). Acceleration (>30%) confirms AI thesis; deceleration (<22%) is headwind. LLM sources via web search.
2. AI CYCLE PHASE — secular growth at risk of expectation reset:
   • Hyperscaler peer capex discipline (GOOGL/META/AMZN). MSFT alone holds while peers raise = discipline signal. MSFT raises while peers hold = commitment risk.
   • OpenAI partnership status: governance, IP/access, AGI clauses, exclusivity. Single headlines = 3-5% moves.
   • Copilot monetization: revenue/seat × adoption. Slow seat growth = AI thesis air-pocket.
3. COHORT ROTATION DYNAMIC: When engine flags rotation_pressure_active = TRUE (capital rotating MSFT→NVDA/PLTR/AMD), historically a BUY setup, not a warning. Don't fight engine; reinforce buy bias.
4. FX: ~50% non-US revenue. Engine scores DXY.

DO NOT PENALIZE: 52w proximity, RSI 60-70, P/E 27-33x, P/B (Activision goodwill), cohort premium 0-15% (deserved quality moat), capex YoY 25-50% (AI infrastructure investment cycle).

BUY BIAS (in addition to engine signals): Azure CC re-acceleration (you flag broad vs single-deal), hyperscaler capex discipline confirmation (peers cutting / MSFT holding), OpenAI deal favorable renegotiation, Copilot adoption inflection (>50% seat YoY at >$30/seat ASP), forward P/E compressing toward 25x with Azure intact, cohort discount to GOOGL/META, defensive rotation setup (VIX elevated + MSFT lagging cohort).

TRIM BIAS: Azure CC decel to <22% with no catalyst, capex blowout with ROI questions (80%+ YoY + margin compression + no Azure accel = thesis impairment), OpenAI partnership unwind risk, forward P/E >35x with cohort premium >20%, Copilot monetization stalling.

YOUR VALUE-ADD: Forward P/E vs trailing + PE-vs-3Y/5Y/10Y, Azure CC narrative (broad vs concentrated, AI-driven vs core IaaS), hyperscaler peer capex direction, OpenAI partnership status (exclusivity/governance/IP/AGI), Copilot enterprise traction (seats/ASP/retention/verticals), earnings surprise on Azure CC specifically, AI cycle phase, FTC/EU regulatory, BUILD conference / FY guidance / large enterprise deals.

MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on cohort rotation extremes (engine flags), drawdown setups (engine flags), Azure quarterly (you flag), OpenAI/regulatory (you flag), AI cycle inflection (you flag).
` : "";

  const lhxGuidance = isLHX ? `
CRITICAL — LHX-SPECIFIC SCORING GUIDANCE (V1):
LHX is L3Harris Technologies — defense prime backlog compounder. HYBRID archetype: LIN-like quality compounder + ASML-like secular DoD capex cycle + geopolitical regime overlay. Smallest of the "Big 5" US defense primes (LMT/RTX/NOC/GD/LHX), historically discounted 5-15% to cohort — cohort compression is the central re-rating thesis. Aerojet Rocketdyne SRM-duopoly position post-2023 acquisition.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/70 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>10% setup, >18% strong)
• Cohort rotation pressure vs LMT/NOC/RTX/GD avg 30d (LHX lagging by >5pp = capital flowing to larger primes = BUY setup, not warning)
• ITA factor flow vs SPY (>1pp/30d = defense bid active = positional positive)
• Compounder MA + 52w (no penalty at golden cross or near highs)
• Cohort P/E premium vs LMT/NOC/RTX/GD (TRAILING P/E via Finnhub free tier)
• Composite weights regime-conditional on ITA vs SPY 30d flow, engine V8.1: >+1pp bid_active 25/45/30 · ±1pp neutral 20/40/40 · <−1pp bid_absent 15/35/50; neutral base keeps positional+strategic co-equal (backlog forward visibility + DoD budget structural drivers)

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E and PE-vs-3Y-history. Defense-prime cohort: forward PE 18-22x typical, LHX -5 to -15% discount historically. Cohort discount widening past -10% = above-norm buy. Positive premium = rare = trim.

WHAT DRIVES LHX:
1. BOOK-TO-BILL + BACKLOG: THE operational metric (equivalent to Azure CC for MSFT, ASU util for LIN). B/B >1.10 = accelerating (strong positional buy), 1.00-1.10 = healthy, <0.95 = backlog shrinking (thesis risk). Backlog YoY >8% = expansion, <0% = erosion. Search for: latest LHX earnings call B/B disclosure, backlog dollar value YoY delta.
2. DOD BUDGET CYCLE PHASE: Categorical (expansion / flat / cr_uncertainty / sequester_risk). FY27 NDAA progress, continuing resolution risk, supplemental funding flow (Ukraine/Israel/Taiwan packages), budget caps, sequester triggers. Real expansion = multi-year tailwind. Sequester risk = headwind.
3. GEOPOLITICAL REGIME PHASE: Categorical (great_power_competition / regional_conflict / transition / peace_dividend). Sustained great-power competition + regional conflicts = multi-year tailwind. Peace dividend = structural drawdown phase.
4. AEROJET ROCKETDYNE INTEGRATION: SRM duopoly with NOC. Track integration progress, margin contribution, propellant supply chain. Catalyst/risk only — not a scored field.
5. DEFENSE-INDUSTRIAL SUPPLY CHAIN: Titanium, semis, propellant — gating constraints on margin expansion.
6. EPS REVISIONS: 30d/60d/90d trend is cleanest positional factor. >+1% 90d = tailwind. <-1% = headwind.

DO NOT PENALIZE: 52w proximity, RSI 50-70 (low-vol prime), trailing P/E 22-28x, cohort DISCOUNT in -5 to -15% range (historical norm — smallest prime trades at discount), op margin 14-16%, ITA leading SPY by 1-2pp (defense sector outperformance is structural tailwind environment).

BUY BIAS: B/B re-accelerating off a low, major program win (F-35 mission systems, NGAD/6th-gen, Golden Dome, ISR, Aerojet propellant — single multi-billion award = multi-day move), DoD budget moving to real expansion (NDAA passage, supplemental approval, lifted caps), geopolitical regime sustained at great_power_competition / regional_conflict, cohort discount widening past -10% without thesis break, EPS revisions turning upward, ITA leading SPY by >2pp/30d, drawdown >10% on macro noise + cohort rotation active.

TRIM BIAS: B/B <0.95 with backlog YoY negative, DoD budget to sequester_risk / cr_uncertainty, regime shifting to peace_dividend / transition, op margin <13% with supply-chain root cause, LHX premium to cohort (rare — mean-reversion ahead), forward P/E >23x or PE >115% of 3y avg, Aerojet integration faltering.

YOUR VALUE-ADD: Forward P/E + PE-vs-3Y (engine trailing only), B/B + backlog YoY (engine null — earnings call), op/FCF margin trend + EPS revs (engine null), DoD budget reading (NDAA progress, CR risk, supplemental, sequester probability, BCA dynamics), geopolitical regime reading (great power durability, conflict escalation/de-escalation, NATO 2%+), major program awards, Aerojet integration + propellant supply chain, supply chain constraints (titanium/semis/energetics/rare earths), Dividend Aristocrat-track growth.

MOST DAYS NEUTRAL: ±5 roughly 75% of days. Meaningful scores on cohort rotation extremes (engine flags), drawdown setups (engine flags), DoD budget moments (you flag), geopolitical shifts (you flag), program/earnings catalysts (you flag).
` : "";

  const tmoGuidance = isTMO ? `
CRITICAL — TMO-SPECIFIC SCORING GUIDANCE (V1):
TMO is Thermo Fisher Scientific — life-sciences picks-and-shovels supplier ("ASML of life sciences"). HYBRID archetype: LIN-like quality compounder + ASML-like secular monopoly + cyclical end-market exposure (bioprocessing, biotech funding, China capex). Currently in cycle-inflection territory: bioprocessing destocking ending, biotech funding thawing, COVID comps fully lapped. Strategic dominates (45%) because the thesis right now is multiple reset + cycle bottoming.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (35/70 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>15% setup, >25% strong conviction)
• Peer valuation: TMO vs DHR trailing P/E (TRAILING via Finnhub free tier)
• Peer relative: TMO vs DHR daily return spread (sympathy read)
• Biotech overlay: XBI 30d/90d (90d leads TMO bookings 2-3 quarters)
• Biotech sympathy detection: TMO + XBI both down meaningfully (tactical buy setup)
• QUAL factor flow vs SPY (same data signal as LIN/MSFT)
• Compounder MA + 52w, DXY overlay (~40% non-US revenue)
• Composite weights regime-conditional on XBI 90d return, engine V8.1: >+10% thawing 25/40/35 · ±10% neutral 20/35/45 · <−10% frozen 15/30/55

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary contribution is FORWARD P/E and PE-vs-5Y-history. TMO forward PE: <20x exceptional, 22-25x fair, >28x stretched. PE <85% of 5y avg = own-history buy zone.

WHAT DRIVES TMO:
1. BIOPROCESSING CYCLE PHASE (THE operational metric, categorical): destocking → bottoming → early_recovery → expansion → peak. Q1 2026 print at ~1% organic growth is the trough. Watch re-acceleration to 5%+ for cycle confirmation.
2. PEER TRIANGULATION — DHR, SARTORIUS, REPLIGEN: All three commentary same direction = high-conviction cycle read. All destocking = contrarian late-trough buy. All recovering = cycle confirmation buy.
3. XBI 90D RETURN: Biotech funding sentiment leads TMO bookings 2-3Q. >+10% = thawing (tailwind). <-10% = frozen (headwind). IPO activity, M&A deals, GLP-1 disruption narrative impact on biotech sentiment.
4. CHINA LIFE SCIENCES CAPEX + NIH FUNDING: Policy overlays. China stabilizing/expanding + NIH growing = positive. China collapse / NIH cuts = headwind.
5. WAVE 4 AI LIFE SCIENCES: Bioproduction for AI-discovered biologics, mass spec/sequencers for AI research, lab automation. Categorical v1 — qualitative read on activation.

DO NOT PENALIZE: 52w proximity (not relevant near-term given ~15-25% drawdown), RSI 50-65, trailing P/E 22-30x, P/B (PPD goodwill), bioprocessing destocking by itself (late-trough setup), organic growth at 1% trough (cycle bottom you're buying ahead of).

BUY BIAS: Biotech sympathy ACTIVE (engine flags TMO+XBI both down — collateral damage), cycle phase destocking→bottoming or bottoming→early_recovery, DHR+Sartorius+Repligen all destocking simultaneously (late-trough — engine null, you source from earnings), organic growth re-acceleration off 1% trough toward 5%+, XBI 90d turning positive after extended freeze, forward P/E compressing toward 20x with growth re-accel, Wave 4 AI activation (major AI biologics bioproduction wins), defensive setup (QUAL leading SPY + TMO catches quality bid).

TRIM BIAS: Cycle moving toward peak (expansion→peak), organic growth at peak (>10%) with multiple already expanded, forward P/E >28x with growth decel, China capex collapse + NIH cuts simultaneously, major PPD competitive loss, generic profit-taking when other names flash deeper buy signals.

YOUR VALUE-ADD: Forward P/E + PE-vs-5Y, bioprocessing cycle phase (engine null — TMO earnings + DHR/Sartorius/Repligen triangulation), organic growth trajectory off trough (engine null — latest quarter print), peer commentary, op/FCF margin + EPS revs (engine null), China direction + NIH outlook, PPD competitive position, Wave 4 activation status, GLP-1 disruption to diagnostics/lab volumes, catalysts (earnings, peer reads, M&A, regulatory, China policy).

MOST DAYS NEUTRAL — BUT CURRENT DRAWDOWN TILTS BUY: ±5 roughly 75% of days under normal conditions. CURRENT context (~15-25% drawdown + bioprocessing trough) = high-conviction buy SETUP zone — expect scores tilted negative (buy) until cycle confirmation drives multiple expansion.
` : "";

  const nowGuidance = isNOW ? `
CRITICAL — NOW-SPECIFIC SCORING GUIDANCE (V1):
NOW is ServiceNow — AI workflow quality compounder. HYBRID archetype: LIN/MSFT-like quality compounder + ASML-like secular agentic-AI workflow cycle + SPY-like long-duration rate sensitivity. Best-in-class non-GAAP operating margins (~30%), gross margins ~80%+, FCF margin ~32%, durable 20%+ subscription revenue growth. Now Assist Pro Plus SKU monetizes GenAI across IT/HR/Customer workflows; AI Agent Studio platforms the next wave of agentic automation. Tuned for premium-SaaS multiple math — lives at forward PE 55-65x, EV/Sales 14-17x as the normal compounder zone.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/65 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>12% setup, >20% strong, >25% rare conviction)
• Cohort rotation pressure vs CRM/WDAY/ADBE avg 30d (NOW lagging by >5pp = capital chasing higher-beta AI/SaaS = BUY setup, not warning)
• IGV (software ETF) factor flow vs SPY (>1pp/30d = software bid active = positional positive)
• Compounder MA + 52w (no penalty at golden cross or near highs)
• Cohort P/E premium vs CRM/WDAY/ADBE (TRAILING P/E via Finnhub free tier)
• Real rate overlay (Fed funds − TIPS 10Y) — long-duration cash-flow sensitivity (>2% restrictive = headwind, <0.5% accommodative = tailwind)
• DXY overlay (~30% non-US revenue)
• Composite weights regime-conditional on real rate (fed funds − 10Y TIPS), engine V8.1: <0.5% accommodative 25/40/35 · 0.5–2% neutral 20/35/45 · >2% restrictive 15/30/55

IMPORTANT — TRAILING vs FORWARD P/E AND EV/SALES:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E, EV/Sales, forward PEG, and own-history percentiles (PE % of 3Y/5Y avg). Premium SaaS multiple math:
• Forward PE: <50x exceptional buy (rare), 55-65x fair compounder zone, >70x stretched
• EV/Sales: <12x deep value (rare), 14-17x fair compounder zone, >19x stretched
• Forward PEG: <1.5 exceptional, 1.5-2.5 fair, >3.5 stretched
• PE < 80% of 3Y avg = own-history buy zone
• PE > 110% of 3Y avg = own-history trim zone
If forward PE tells a different story than trailing (engine sees the trailing — you see the forward + own-history), call it out clearly.

WHAT DRIVES NOW:
1. cRPO GROWTH (THE operational metric — equivalent to Azure CC for MSFT, ASU util for LIN, B/B for LHX). Current Remaining Performance Obligations YoY is THE leading indicator of subscription cohort health. Acceleration = thesis intact; deceleration to <18% = thesis air-pocket. Search for latest earnings disclosure.
2. AGENTIC AI COMMERCIALIZATION PHASE: Categorical (early_commercialization / mid_commercialization / saturation). Now Assist Pro Plus revenue contribution, AI Agent Studio adoption, $1M+ deals YoY growth, federal contract wins. Early phase = thesis still pricing in (buy bias). Saturation = thesis fully priced (trim bias).
3. COHORT ROTATION DYNAMIC: When engine flags rotation_pressure_active = TRUE (capital rotating NOW → higher-beta AI/SaaS names), historically a BUY setup, not a warning. Quality workflow-automation franchise catches the rotation back. Don't fight engine; reinforce buy bias.
4. REAL RATE SENSITIVITY (SPY-style overlay): NOW is a long-duration cash flow story. Real rate >2% = multiple compression headwind. Falling real rates / Fed pivot = multiple expansion tailwind. Engine scores the regime.
5. FEDERAL CONTRACTS: ServiceNow has built a meaningful federal vertical (FedRAMP High, DoD, civilian). Federal YoY growth + major contract announcements = structural positional tailwind. Government shutdown risk = transient headwind.
6. EPS REVISIONS: 30d/60d/90d trend is cleanest positional factor.

DO NOT PENALIZE: 52w proximity, RSI 50-65 (low-vol compounder), trailing P/E 55-70x (NORMAL premium SaaS — not "expensive"), P/B (high due to capitalized R&D / acquired tech goodwill — uninformative for SaaS), cohort premium 0-20% (NOW carries a deserved quality premium over CRM/WDAY/ADBE), EV/Sales 14-17x (fair compounder zone).

BUY BIAS (in addition to engine signals): cRPO re-acceleration off a low (you flag), Now Assist Pro Plus attach-rate or ASP inflection (you flag — engine null), AI Agent Studio enterprise win at scale (single multi-hundred-million deal = multi-day move), major federal contract win (CACI / Booz Allen-style displacement, DoD enterprise rollout), forward PE compressing toward 50x with cRPO intact, real rate falling toward 0.5% (multiple expansion tailwind), cohort discount to CRM/WDAY/ADBE (rare — engine flags), drawdown >12% on macro noise + cohort rotation active.

TRIM BIAS: cRPO decel to <18% with no catalyst, Now Assist Pro Plus monetization stalling (slow ASP growth despite seat expansion), AI cycle hitting saturation phase, forward PE >70x with cohort premium >20% AND cRPO decelerating simultaneously, real rate >2% sustained (multiple compression headwind), major federal contract loss, op margin compression with AI-cost root cause that doesn't show absorption.

YOUR VALUE-ADD: Forward PE + own-history PE percentile + EV/Sales (engine trailing only), cRPO YoY trajectory (engine null — earnings call), Now Assist Pro Plus revenue/ASP/attach-rate (engine null), AI Agent Studio adoption pace, $1M+ deals YoY (engine null — earnings disclosure), federal contract pipeline + wins, EPS revisions (engine null), AI commercialization phase reading, op + FCF margin trend (signals AI-cost absorption — engine null), Fed/real-rate trajectory interpretation, GenAI competitive landscape (CRM Agentforce, MSFT Copilot Studio displacement risk), CEO commentary at Knowledge / FY guidance.

MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on cohort rotation extremes (engine flags), drawdown setups (engine flags), cRPO inflection (you flag), agentic-AI commercialization milestones (you flag), real-rate regime shifts (engine flags + you interpret), AI cycle phase pivots (you flag).
` : "";

  const maGuidance = isMA ? `
CRITICAL — MA-SPECIFIC SCORING GUIDANCE (V1):
MA is MASTERCARD (the payments network) — payments-rails quality compounder. The twin comparison with VISA (V) throughout your data is INTENTIONAL: V is the duopoly twin and the ONLY valuation comparator (never PayPal/fintechs/AXP — a closed-loop lender is a different business). Your analysis subject is always Mastercard. Tollbooth on global electronic payments: ~58-60% adjusted op margins, ~2.3%/yr share retirement, beta ~0.83, ~2/3 international revenue, Value-Added Services ~38% of revenue growing ~20%+. The archetype thesis: disruption NARRATIVES (stablecoins, interchange caps) recur every few years, compress the multiple, volumes never notice, multiple re-rates — the narrative-vs-evidence GAP is the alpha.

V8.2 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/65 — low-vol compounder)
• Drawdown-from-52w-high primary tactical (>12% setup, >20% strong, >25% rare conviction)
• Twin dislocation vs V 30d (MA lagging V >4pp = buy setup absent an MA-specific fundamental break)
• Duopoly (MA+V avg) vs SPY 30d fear regime (acute <−8pp / elevated −8..−5 / neutral / absent >+3)
• QUAL factor flow, compounder MA-trend + 52w (no penalty near highs)
• Twin P/E premium vs V (TRAILING via Finnhub) — 10-20% is the BASELINE, <5% compressed = buy, >25% rich
• Volume/VAS/rebates/buyback/margin fundamentals when sourced (they arrive null — YOU source them)
• Disruption narrative-vs-evidence matrix + interchange regulation categoricals (deterministic thesis-break penalties on "material" evidence / "passed" regulation)
• Composite weights regime-conditional on duopoly vs SPY 30d, engine V8.2: >+3pp fear_receding 25/40/35 · −5..+3 neutral 20/35/45 · <−5pp fear_regime 15/30/55

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E, own-history percentiles, and forward PEG:
• Forward PE: <25x exceptional buy, 28-32x fair compounder zone, >34x stretched
• PE % of 3Y avg (~35.7x trailing): <85% = own-history buy zone, >110% = trim zone
• Forward PEG: <1.4 exceptional, 1.6-2.2 fair, >2.5 stretched
If forward tells a different story than trailing, call it out clearly.

WHAT DRIVES MA:
1. CROSS-BORDER VOLUME GROWTH (THE operational metric — equivalent to cRPO for NOW, Azure CC for MSFT). Highest-yield volume, cleanest consumer/travel health read, and the number the disruption narrative must eventually answer to. >12% = thesis confirmation; <6% = a REAL warning (unlike headlines). Search latest quarterly disclosure.
2. DISRUPTION NARRATIVE vs EVIDENCE: Categoricals. Narrative phase (peak/active/fading/resolved) vs fundamental evidence (none/anecdotal/measurable/material). Peak narrative + no evidence = maximum alpha (buy). Measurable real-economy merchant displacement = genuine thesis pressure. Assess stablecoin adoption AT REAL-ECONOMY MERCHANTS specifically — B2B/remittance pilots and crypto-native flows are not displacement.
3. STABLECOIN STRATEGY EXECUTION: leading/active/reactive/absent. BVNK acquisition (Mar 2026), the V-MA-Coinbase settlement consortium (Jun 2026), Multi-Token Network progress. Owning the disruption = the historical playbook.
4. INTERCHANGE/NETWORK-FEE REGULATION: dormant/proposed_stalled/advancing/passed. The genuine binary. "Advancing" through committee = real strategic caution; "passed" = thesis break (engine +30).
5. VAS GROWTH: The ~38%-of-revenue compounding leg the disruption bears ignore. >20% = diversification thesis confirming.
6. REBATES & INCENTIVES DISCIPLINE: outpacing gross revenue = issuer bargaining power rising = pricing pressure.
7. EPS REVISIONS: 30d/90d cleanest positional factor.

DO NOT PENALIZE: 52w proximity, RSI 55-65, trailing P/E 30-36x (normal own-history range), P/B (meaningless — massive buybacks shrink book equity), twin premium 10-20% (deserved faster-grower premium), the 0.7% dividend (irrelevant — buybacks are the return mechanism).

BUY BIAS (in addition to engine signals): peak disruption narrative + volumes intact (you flag the gap), twin premium compressed <5% (engine flags — you confirm no MA-specific break), forward PE <28x with cross-border >10%, interchange proposal stalling/dying, stablecoin consortium wins, VAS acceleration, fear regime active with GDV/switched-txn growth steady.

TRIM BIAS: measurable real-economy stablecoin displacement (you flag — the ONLY genuine disruption evidence), interchange legislation advancing to floor votes, cross-border <6% sustained (spend cycle rolling), rebates outpacing gross revenue for 2+ quarters, twin premium >25%, forward PE >34x with decelerating volumes, narrative resolved + full re-rating (edge gone; drift to neutral-mild-trim).

YOUR VALUE-ADD: Forward PE + own-history percentile + forward PEG (engine trailing only), cross-border/GDV/switched-txn/VAS growth (engine null — earnings disclosure), rebates trend (engine null), buyback pace (engine null), stablecoin execution + disruption narrative-vs-evidence + regulation categoricals (engine consumes YOUR reads — set them carefully, they carry deterministic weight), litigation/regulatory developments, EPS revisions.

MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on drawdown setups (engine flags), twin dislocation extremes (engine flags), fear-regime shifts (engine flags + you interpret), narrative-evidence gap extremes (you flag), regulation status changes (you flag), cross-border inflections (you flag).
` : "";

  const isrgGuidance = isISRG ? `
CRITICAL — ISRG-SPECIFIC SCORING GUIDANCE (V1):
ISRG is INTUITIVE SURGICAL (the da Vinci robotics company — NOT Intuit the software company). Surgical-robotics moat compounder: category king with ~60% robotic-surgery share, ~11,400-system installed base, ~86% RECURRING revenue (instruments/accessories/services — a razor-blade annuity attached to every procedure), non-GAAP op margins ~37%, no dividend, beta ~1.7. Mentions of Medtronic (Hugo), Johnson & Johnson (Ottava), Stryker, and Boston Scientific are CORRECT AND EXPECTED — they are the named competitors and cohort comparators in this archetype. The archetype thesis: two-decade moat (installed base + surgeon training + 40M-procedure data) being probed for the first time while a 2027 instrument-lifespan transition creates an unquantifiable-but-bounded revenue headwind — fear compresses the multiple to its deepest own-history discount in years while procedures/placements/EPS all beat.

V8.2 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI bands 38/68 (beta ~1.7 — wider than the low-vol compounders)
• Drawdown-from-52w-high primary tactical (>15% setup, >25% strong, >35% extreme — ladder wider than MSFT/NOW)
• Cohort fear rotation vs MDT/SYK/BSX avg 30d (ISRG lagging >6pp on headlines = buy setup absent procedure evidence)
• IHI (devices ETF) factor flow vs SPY (>1pp/30d = devices bid active)
• Compounder MA-trend + 52w (no penalty near highs)
• Cohort P/E premium vs MDT/SYK/BSX (TRAILING) — 60-120% is the STRUCTURAL BASELINE, <60% unusual discount = buy, >150% stretched
• Procedure/placement/recurring/I&A/margin fundamentals when sourced (they arrive null — YOU source them)
• moat_status + instrument_transition_status categoricals (deterministic: "eroding" +18 / "breached" +35 / "quantified_material" +25 thesis-break penalties; "quantified_manageable" −8 relief catalyst)
• Composite weights regime-conditional on IHI vs SPY 30d, engine V8.2: >+1pp bid_active 25/40/35 · ±1pp neutral 20/35/45 · <−1pp bid_absent 15/30/55

IMPORTANT — TRAILING vs FORWARD P/E (ABSOLUTE PE IS NEVER THE SIGNAL):
ISRG has commanded 50-80x trailing for a decade because ~86% recurring revenue growing high-teens deserves it. Engine uses TRAILING with own-history bands (3y avg ~72x). YOUR contribution:
• Forward PE: <40x exceptional (rare), 45-55x fair franchise zone, >60x stretched
• PE % of 3Y avg (~72x): <80% = own-history buy zone (deepest discounts cluster here), >105% = trim zone
• Forward PEG: <2.0 exceptional, 2.2-3.0 fair for the quality, >3.5 stretched
The own-history percentile is the single most useful valuation lens for this name.

WHAT DRIVES ISRG:
1. PROCEDURE GROWTH (THE operational metric). Total procedures YoY is the annuity heartbeat AND the cleanest competitive-erosion read. 2026 dV guide 13.5-15.5%. Beating guide with Hugo in market = moat holding = fear-evidence gap widens (buy). <12% = erosion tripwire — but ONLY treat as genuine erosion if paired with competitor procedure-share evidence; macro softness in elective procedures is cyclical, not structural.
2. 2027 INSTRUMENT-LIFESPAN TRANSITION: unquantified_fear / quantified_manageable / quantified_material. Five of six force-feedback instrument lives extended → fewer replacement cycles → unquantified I&A headwind. Unquantified fear while fundamentals beat = the current alpha. Management quantifying it as manageable = relief re-rating catalyst. Quantified material (>mid-single-digit % of revenue) = thesis-level. Search every earnings call for quantification language.
3. MOAT STATUS vs HUGO/OTTAVA: intact/probing/eroding/breached. "Probing" is the EXPECTED state with two entrants — score it neutral, not as deterioration. The evidence bar for "eroding" is measurable US procedure-share loss or existing-account displacement — Hugo placements in greenfield/international accounts are NOT erosion. Ottava's rollout pace (broad launch ~2027) sets the clock.
4. EARNINGS WINDOW DISCIPLINE: Q2 2026 report lands JULY 16, 2026 (consensus ~$2.48 adj EPS / ~$2.81B rev). Within ±10 days of a report, procedure/guide/transition information is about to reset — HALVE the size of any tactical conviction and say so in the tactical rationale. Post-print, score the print (procedures vs guide, transition quantification, Hugo commentary), not the pre-print fear.
5. DV5 UPGRADE CYCLE + ION: dV5 mix of placements (upgrade demand), Ion procedure growth (second leg, ~40%+), Ion international expansion.
6. RECURRING MIX: <84% of revenue = annuity mix warning (engine flags when sourced).
7. EPS REVISIONS: 30d/90d cleanest positional factor.

DO NOT PENALIZE: trailing P/E 50-70x (NORMAL for this franchise — never apply generic-stock PE intuitions), 52w proximity, RSI 55-68, cohort premium 60-120% (the structural baseline), P/B ~9-10x (meaningless for an IP/installed-base moat), absence of dividend (reinvestment + buyback is the model), competitor PRODUCT LAUNCHES per se (launches are known; only procedure-share evidence matters).

BUY BIAS (in addition to engine signals): procedures beating guide while the stock sits >20% off highs (the fear-evidence gap — you flag), management quantifying the 2027 transition as manageable (relief catalyst), Hugo/Ottava delays or weak US traction, forward PE <45x / PE <80% of 3y avg with procedures in guide, dV5 mix + Ion accelerating, fear rotation active (engine flags) without share-loss evidence (you confirm), post-earnings overreaction to a guide reaffirm.

TRIM BIAS: measurable US procedure-share loss to Hugo/Ottava (you flag — the ONLY genuine moat evidence), procedures <12% without macro excuse, transition quantified as material, recurring <84% sustained, forward PE >60x with decelerating procedures, cohort premium >150%, I&A growth decoupling below procedure growth for 2+ quarters (transition arriving early).

YOUR VALUE-ADD: Forward PE + own-history percentile + forward PEG (engine trailing only), procedure growth + guide trajectory (engine null — earnings disclosure), dV placements/dV5 mix/Ion (engine null), recurring % + I&A growth (engine null), moat_status + instrument_transition_status categoricals (engine consumes YOUR reads — set them carefully, they carry deterministic thesis-break weight), Hugo installed-base and procedure-share evidence, Ottava timeline, earnings-window discipline (Jul 16), EPS revisions.

MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on drawdown setups (engine flags), fear-rotation extremes (engine flags), procedure prints vs guide (you flag), transition quantification events (you flag), moat-evidence changes (you flag), earnings-window resets (you flag).
` : "";

  const mlmGuidance = isMLM ? `
CRITICAL — MLM-SPECIFIC SCORING GUIDANCE (V1):

IDENTITY — READ THIS FIRST. MLM is MARTIN MARIETTA MATERIALS, INC. (NYSE: MLM, CIK 916076, Raleigh NC) — a construction aggregates producer: crushed stone, sand and gravel. It is NOT multi-level marketing, network marketing, direct sales, or any distributor or downline structure; that expansion of the acronym is the most common one in English text and it is WRONG here. It is NOT Lockheed Martin — the original Martin Marietta Corporation merged with Lockheed in 1995, and Martin Marietta MATERIALS was separated as an independent building-materials company with no defense, aerospace or government-contracting business. This portfolio separately holds LHX (L3Harris) for defense exposure; do not cross-contaminate the two. It is NOT Vulcan Materials — VMC is the peer benchmark in this model, not the subject.

MLM is the second-largest US construction aggregates producer and one of only two genuine domestic pure plays alongside Vulcan. Three structural attributes at once: (1) a LOCAL MONOPOLY — crushed stone is worth less than the cost of hauling it beyond roughly 25 to 50 miles, so each quarry effectively owns its radius and there is no exchange price for aggregates anywhere in the world; (2) a PERMITTING moat — you cannot practically get a new quarry approved near a growing metro, so permitted reserve life rather than brand or technology is the durable asset; (3) a POLICY-DRIVEN volume cycle — roughly a third of demand traces to public infrastructure, making federal highway authorization and state DOT budgets the dominant swing factor on tonnage.

THE ARCHITECTURAL RULE FOR THIS NAME — INTERNALIZE IT BEFORE SCORING:
PRICING and VOLUME are SEPARATE signals with separate drivers and must never be conflated. Pricing is structural, near-unconditional, mid-single-digit through cycles, and historically RISES during recessions because a local monopoly does not evaporate when demand softens. Volume is cyclical and policy-driven. A quarter with weak volume and intact pricing is a CYCLE datapoint. A quarter with intact volume and broken pricing is a THESIS datapoint. Weight them accordingly.

V8.4 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI bands 38/70 — LIN-class, NOT the high-beta ladder (beta 1.11, short interest ~4%)
• Daily-move noise floor of ±2%
• Drawdown-from-52w-high primary tactical, ladder scaled to 35% (>15% setup, >25% strong, >30% extreme)
• VMC TWIN dislocation scored SEPARATELY from the cohort (the signature setup)
• Aggregates-cohort rotation vs VMC/CRH/EXP weighted 30d at a −5pp threshold (TIGHTER than RDDT's −8pp: on a beta-1.11 name a 5pp/30d divergence is information, not noise)
• XLB (Materials) factor flow vs SPY (>1pp/30d = materials bid active)
• Mix-adjusted organic pricing, organic volume, cash GP/ton, COGS/ton ex-freight, end-market split, EPS revisions when sourced (they arrive null — YOU source them)
• federal_authorization_status + state_dot_budget_trend + delever_glidepath_status + ma_integration_state categoricals (deterministic: "multiyear_enacted_below_iija" +20 / "lapsed" +16 / glidepath "behind" +14 thesis-break penalties; "multiyear_enacted_at_or_above_iija" −18 re-rating catalyst)
• NET share count change (NEGATIVE = buyback) — engine scores this
• Composite weights regime-conditional on the PUBLIC CONSTRUCTION FUNDING regime, engine V8.4: funded 25/40/35 · neutral 20/35/45 · unfunded 15/30/55 (LIN's triple, deliberately reused)

THREE CALIBRATION TRAPS — ALL LOAD-BEARING. GET THESE WRONG AND THE SIGNAL IS NOISE:
1. THE TRAILING P/E IS AN ACCOUNTING ARTIFACT. MLM's trailing P/E sits near 12.9x against a forward P/E near 26.8x. TTM revenue of about $6.69B carries gross profit of roughly $1.89B — a 28.2% gross margin — while reported profit margin is 36.7% on about $2.46B of net income. A profit margin ABOVE the gross margin is arithmetically impossible from operations: the window contains a large non-operating gain from the Quikrete asset exchange. The engine scores trailing P/E as ZERO whenever trailing is below 0.6× forward, and honours the fetch layer's premium_pct_reliable flag on the aggregates-cohort premium (which otherwise reads near −50% and would look like a screaming discount). Do NOT reintroduce either on the qualitative side. Say plainly in your rationale that the trailing multiple is uninformative here and lean on forward PE and EV/EBITDA. Note this is the MIRROR IMAGE of a cheap stock — not the cyclical P/E inversion used for GLNCY / PBR.A / AMKBY, which does NOT apply because aggregates have no commodity price to trough against.
2. REPORTED AGGREGATES ASP IS A NULL SIGNAL DURING INTEGRATION. Q2 2026 reported ASP FELL 2% to $22.74 per ton while ORGANIC mix-adjusted pricing ROSE 3.7% — the entire gap is acquisition and geographic mix from the Quikrete and New Frontier assets. Scoring the reported figure manufactures a pricing-power break that did not happen. The engine never scores it. Report it for context, mark it explicitly as mix-contaminated, and key every pricing judgement on mix_adjusted_organic_pricing_pct.
3. WEATHER IS NOISE, NOT SIGNAL. Aggregates is the most weather-contaminated quarterly print in this portfolio. Heavy rain in Texas and the Southeast suppressed Q2 2026 volumes and continued into July. When a negative organic-volume reading is accompanied by a material weather headwind, the engine REMOVES the penalty entirely rather than reducing it — a half-penalty would still leak a false trim into the composite every wet quarter. Do not read a rain-driven volume miss as demand destruction. Check pricing instead.

IMPORTANT — TRAILING vs FORWARD, AND BASIS CONSISTENCY:
Engine has TRAILING P/E only, and for this name that number is contaminated. YOUR contribution: forward PE (<24x buy zone, 26-32x fair for the growth + moat profile, >36x stretched) and EV/EBITDA (<15x buy, 16-19x fair, >21x rich — the CLEANER read here because you control both legs rather than depending on sell-side consensus). ★ EVERY MULTIPLE MUST CARRY NUMERATOR AND DENOMINATOR ON THE SAME BASIS — both standalone or both pro-forma, both trailing or both forward. If you cannot establish that they match, return null rather than a number. Worked example of the error to avoid: comparing spot EV/EBITDA of about 17.8x (which uses TRAILING EBITDA) against a pro-forma roughly $51.4B enterprise value over about $3.3B of 2026 combined EBITDA (≈15.6x) makes the Lhoist deal look like a two-turn re-rating. It is not. Like-for-like FORWARD, standalone is about $37.9B over roughly $2.4B (≈15.8x) versus pro-forma ≈15.6x — modestly accretive, roughly neutral. Also establish whether sell-side forward EPS consensus is on a standalone or LNA pro-forma basis; if it cannot be established, say so and route the VMC comparison through EV/EBITDA instead.

WHAT DRIVES MLM:
1. MIX-ADJUSTED ORGANIC PRICING (THE moat metric). Aggregates have no exchange price, so the ability to raise mix-adjusted organic price IS the local-monopoly test. Above 4% the moat is fully intact; 2.5-4% is normal structural pricing (Q2'26 printed +3.7%); below 1% is a PRICING POWER BREAK and the single cleanest falsifier in this model — thesis-level, regardless of volume. Negative real pricing means a local monopoly is cutting price, which is a broken thesis, not a cycle.
2. ORGANIC VOLUME (the cycle read). Q2 2026 printed +2.3%, the fourth consecutive quarter of organic growth. Distinguish organic from reported: reported shipments rose 17% on acquisitions. Apply the weather gate above.
3. UNIT ECONOMICS. Aggregates cash gross profit per ton is the industry's cleanest margin measure. The PRICE-MINUS-COST SPREAD is the margin read, not either leg alone: on a per-ton basis any positive spread expands gross margin. Q2'26 printed +3.7% pricing against +2.1% COGS/ton ex pass-through freight — a 1.6pp spread — and adjusted cash gross profit still rose 15%. Always use COGS ex-freight; including pass-through freight inflates both sides of the ledger.
4. FEDERAL AUTHORIZATION — the dominant structural binary, and the clock is running. IIJA authorizations expire SEPTEMBER 30, 2026. Without reauthorization, formula programs for highways, bridges and transit revert to pre-IIJA baseline levels in FY2027 — roughly a $28B per year reduction. H.R. 8870 was ordered reported by the House Transportation and Infrastructure Committee in May 2026, and MLM management indicated on the Q2 call that a short-term extension appears likely. ★ CALIBRATION: twelve extensions followed TEA-21's expiration and ten followed SAFETEA-LU's — short-term patches are the historical RULE, not the exception. A "short_term_extension" is the BASE CASE and scores ZERO, not as a downgrade. Only a multiyear bill enacted materially BELOW IIJA levels, or an outright lapse, is a genuine negative. State transportation budgets in MLM's markets are separately at historically elevated levels and partially buffer federal uncertainty.
5. LHOIST NORTH AMERICA — TREAT AS A KNOWN FORWARD EVENT AND REASON PRO-FORMA. Announced June 2026 at approximately $13.5B enterprise value: $7.0B cash plus $6.5B stock. LNA generated $1.8B gross sales and $786M adjusted EBITDA for the twelve months ended December 31, 2025, implying roughly 15x including run-rate synergies — BELOW MLM's own trading multiple, which is why the deal is accretive rather than dilutive on valuation. Approximately $85M of annual run-rate cost synergies projected; credit them at ZERO until disclosed as realized. LNA brings 20 quarries and production facilities, 45 distribution terminals, and more than 2 billion tons of limestone reserves with over 200 years of useful life, much of it in Sun Belt metros. All regulatory approvals were received August 5, 2026 and MLM priced a $6.5B debt offering August 12, 2026, so the transaction is approved AND financed — reason pro-forma from today rather than waiting for close. ★ LEVERAGE IS SCORED ON THE GLIDEPATH, NEVER THE LEVEL: combined net leverage is expected near 3.7x at closing with a stated target below 2.5x within 24 months. 3.7x at close is the plan working exactly as announced. A quarter that fails to delever on schedule is the signal. If the deal TERMINATES, the pro-forma frame is void and every multiple must be re-read standalone.
6. END MARKETS, SCORED SEPARATELY. Infrastructure and heavy nonresidential (data centers, power generation, warehouses) are the strong legs; residential is the weak one and is the smallest share of demand, so weight it lightly. Note that LNA's lime business serves domestic steel manufacturing, environmental and agricultural applications and reindustrialization — end markets OUTSIDE the highway-funding channel, which is why roughly a quarter of pro-forma EBITDA is insulated from the federal authorization question.
7. SHAREHOLDER RETURN — THE CLEAN CASE. Shares outstanding are DOWN about 1.11% year over year (down 0.33% quarter over quarter), buyback yield 1.11%, dividend raised to $0.84 quarterly on August 16 2026, ten consecutive years of dividend growth on an 8.26% payout ratio. NEGATIVE share count change = buyback. MLM genuinely SATISFIES the portfolio's aggressive-buyback criterion — note the sign convention is the INVERSE of a dilutive name. But $6.5B of stock consideration for LNA against a roughly $31.6B market cap is material issuance, so book the pro-forma dilution now rather than being surprised at close.
8. RESERVE LIFE is the actual moat and a slow-moving structural constant. Report it; do not let it swing a quarterly score.
9. ROIC (~6.7%) sits below WACC (~9.1%), but the denominator was just inflated by acquisitions whose earnings are not yet in the numerator. Flag it as denominator-distorted; do not score it as a quality break while integration is in progress.
10. EARNINGS WINDOW DISCIPLINE: Q2 2026 printed JULY 30, 2026 (revenue $1.95B +21%, adjusted EPS $5.00, FY revenue guide raised to ~$7.3B midpoint while FY adjusted EBITDA guidance was REAFFIRMED but not raised on conservative energy assumptions) — so Q3 lands in late October 2026. SEARCH for the confirmed date rather than assuming one. Within ±10 days of a report, HALVE the size of any tactical conviction and say so. Post-print, score the print.

DO NOT PENALIZE: RSI 40-68 (normal for beta 1.11), daily moves under 2%, drawdowns under 15%, the LOW trailing P/E (it is an artifact — see trap 1), reported ASP declines during integration (trap 2), weather-driven volume misses (trap 3), 3.7x pro-forma leverage while the glidepath holds, a short-term IIJA extension, the 0.64% dividend yield (this is NOT a yield vehicle — do not score yield in either direction), or a temporarily depressed ROIC during M&A integration.

BUY BIAS (in addition to engine signals): mix-adjusted organic pricing above 4% with organic volumes positive, forward PE below 24x, MLM at more than an 8% forward-PE discount to VMC, drawdown beyond 15% from highs with pricing intact, EV/EBITDA below 15x on a consistent basis, a multiyear reauthorization enacted at or above IIJA levels, LNA integration tracking or beating the delever glidepath, a VMC twin dislocation without an operating print behind it.

TRIM BIAS: mix-adjusted organic pricing below 1% (the cleanest falsifier), cash gross profit per ton below $9, forward PE above 36x, MLM at more than an 18% premium to VMC, leverage failing to track the glidepath two consecutive quarters, a reauthorization enacted materially below IIJA levels, organic volumes negative for two consecutive quarters with NO weather explanation.

YOUR VALUE-ADD: Forward PE + EV/EBITDA + pro-forma EV/EBITDA WITH explicit basis tags on both legs (engine trailing only, and contaminated), mix-adjusted organic pricing and the organic/reported volume split (engine null — earnings disclosure), cash GP/ton and COGS/ton ex-freight, end-market split, weather flag, federal_authorization_status + state_dot_budget_trend + ma_integration_state + delever_glidepath_status categoricals (engine consumes YOUR reads — set them carefully, they carry deterministic thesis-break weight), NET share count and pro-forma share count, reserve life, earnings-window discipline, EPS revisions.

MOST DAYS NEUTRAL: ±6 roughly 80% of days — a TIGHTER neutral band than the high-beta names because beta is 1.11 and a quarry business rarely produces weekly information. Meaningful scores on drawdown setups (engine flags), VMC twin dislocations (engine flags), pricing and volume prints (you flag), authorization-status changes (you flag), LNA glidepath updates (you flag), earnings-window resets (you flag).
` : "";

  const uberGuidance = isUBER ? `
CRITICAL — UBER-SPECIFIC SCORING GUIDANCE (V1):

IDENTITY — READ THIS FIRST. UBER is UBER TECHNOLOGIES, INC. (NYSE: UBER, CIK 1543151, San Francisco) — the mobility and delivery marketplace; Uber Eats, Postmates and Uber Freight are segments or brands of the SAME company. It is NOT the German word "über" or the English slang prefix "uber-", and it has nothing to do with Nietzsche. It is NOT Lyft — LYFT is a peer benchmark here. It is NOT Waymo — Waymo is an Alphabet subsidiary and an AV-supply COUNTERPARTY (partner in a few cities, direct competitor in most); Waymo's rides, fleet and economics are not Uber's. It is NOT Delivery Hero — the Berlin-based, Frankfurt-listed acquisition target, whose figures belong here only on an explicitly pro-forma basis. This slot previously held Petrobras: nothing about oil, Brent, BRL/USD, Brazilian politics or dividend yield belongs in this analysis.

UBER is a DEMAND AGGREGATOR — the largest global ride-hailing network and the second-largest US food-delivery platform, across Mobility, Delivery and Freight in roughly 70 countries. Three structural attributes at once: (1) a TWO-SIDED LIQUIDITY moat — about 208 million monthly active platform consumers create trip density that lowers wait times, which attracts supply, which deepens density; the moat is strongest when supply is FRAGMENTED; (2) an AV SUPPLY QUESTION — a human driver multi-homes because no single driver can generate demand, but a 20,000-car robotaxi fleet can, so the defining long-run variable is whether the best autonomous fleets list on Uber or go direct; (3) a CASH-YIELD valuation — roughly a 6% owner FCF yield after stock comp while bookings grow above 20%, which is a margin of safety ONLY if the Mobility cash flow being discounted is not the cash flow at risk.

THE ARCHITECTURAL RULE FOR THIS NAME — INTERNALIZE IT BEFORE SCORING:
OPERATING MOMENTUM and AV SUPPLY STRUCTURE are SEPARATE signals on separate clocks and must never be conflated. Bookings, trips and margin print quarterly and are currently strong. AV supply structure changes on announcements — partnership exits, own-app launches, exclusivity deals — that may not touch reported numbers for years. A strong bookings print does not answer the AV question, and an AV headline about 2028 does not change 2026 cash flow. The one place the two clocks meet is the MOBILITY CANARY: Mobility bookings decelerating while Delivery holds is the specific fingerprint of supply routing around the network.

V8.5 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI bands 35/70 (beta 1.26 — between MLM's 38/70 and RDDT's 32/72), daily-move noise floor ±2.5%
• Drawdown-from-52w-high primary tactical, ladder scaled to 50% (>18% setup, >30% strong, >40% extreme)
• AV-headline-shock PRICE screen (≤ −4% session in the last 5, not an Uber print day): scored −6 as an UNATTRIBUTED candidate, −3 on a broad-tape day. Attribution is YOURS — express it in your tactical score
• Marketplace-cohort rotation vs DASH/LYFT/GRAB weighted .50/.25/.25 at a −6pp threshold; the DASH spread is context only (DASH is half the cohort and not a twin)
• XLY (Consumer Discretionary) factor flow vs SPY
• DAMPENED trend scoring — MA map at RDDT amplitude and a −35 floor on the 52w ladder: below-both on this name may be the market pricing a live structural falsifier, not a fear cycle
• Bookings, the Mobility canary, trips, Adj EBITDA % of GB, Mobility segment OI, incentive pressure, guide vs consensus, EPS revisions, owner FCF yield, forward P/E, EV/Adj EBITDA, NET share count — when sourced (they arrive null — YOU source them)
• AV supply state (human-maintained in fetch v4.19): partners_adding_uber_supply −14 · leader_exiting_tail_aggregating 0 (the BASE CASE) · pending_unknown +2 · second_tier1_exiting +16 · exclusive_pipeline_slipping +12. Delivery Hero lapsed −3; gross leverage above the 2x ceiling +10
• ⛔ VALUE-TRAP GATE: AV regime disintermediating AND the Mobility canary below 12% cc (or unknown) → the BLENDED strategic score is floored at 0 in blendScores(). Your strategic number cannot buy through it; the MARKET DATA config line states the live gate state
• Composite weights regime-conditional on the AV SUPPLY regime, engine V8.5: aggregating 25/40/35 · contested 20/35/45 · disintermediating 15/30/55 (LIN/MLM's triple, deliberately reused)

FIVE CALIBRATION TRAPS — ALL LOAD-BEARING. GET THESE WRONG AND THE SIGNAL IS NOISE:
1. THE GAAP TRAILING P/E IS NOT A SIGNAL, IN EITHER DIRECTION. TTM GAAP net income of about $9.58B contains a $4.9B tax valuation-allowance release from Q3 2025 plus equity-stake revaluation swings of roughly +$1.5B, −$1.6B, −$1.5B and +$1.6B across the last four quarters. A trailing P/E near 14.4x BELOW a forward P/E near 16.4x on a business with ~30%+ consensus EPS growth is arithmetically impossible from operations. The engine never scores it and the cohort P/E premium is permanently gated upstream. ★ CALENDAR TRAP: when Q3 2026 is reported on November 4, 2026, Q3 2025 and its tax release roll OUT of the trailing window and the trailing P/E should roughly DOUBLE toward the high-20s overnight with NO change in the business. Do NOT read that jump as a re-rating to rich, and do NOT read it as a cyclical trough signal (the PBR.A inversion this slot used to carry does not apply). The revaluations never roll off — GAAP EPS stays noisy permanently.
2. REPORTED REVENUE IS A NULL SIGNAL. Business-model changes cut Q2 2026 revenue growth by 8 percentage points; Mobility revenue rose 1% on Mobility gross bookings up 22%. Score constant-currency gross bookings, trips, MAPCs, Adj EBITDA as a % of gross bookings and segment operating income. ★ BASIS CONSISTENCY: every multiple must carry numerator and denominator on the SAME basis — GAAP with GAAP, adjusted with adjusted, SBC excluded with SBC excluded, standalone with standalone; if you cannot establish it, treat it as missing. On the same ~$140B EV, GAAP EBITDA (~$7.47B TTM) gives ~18.7x, Adjusted EBITDA (~$10.04B, SBC EXCLUDED) gives ~13.9x, and Adjusted EBITDA less SBC (~$8.10B) gives ~17.3x — five turns of apparent cheapness from basis alone. DoorDash's EV/EBITDA near 49x is GAAP; never compare it against Uber's adjusted figure.
3. OWNER FCF, NOT HEADLINE FCF. TTM free cash flow of about $10.12B excludes about $1.94B of stock-based compensation. Owner FCF is about $8.18B — roughly a 6.1% yield on a market cap near $135B, NOT the ~7.5% headline. Shareholder return is scored on NET share count (down about 2.28% YoY — the portfolio's buyback criterion IS met), never on gross repurchase dollars. Repurchase PACE slowed sharply ($518M in Q2 2026 vs $1,363M a year earlier) as capital went to the Delivery Hero stake; say so honestly, but the net count decides the criterion.
4. DELIVERY HERO IS PENDING — SCORE STANDALONE. €41.50 per share in cash (~108% premium to the unaffected May 8 close), about $14.8B for 100% of the equity or $13.7B net of prior stake purchases; Uber held ~24.77% of voting capital plus ~11.74% via derivatives, Prosus irrevocably committed ~17%. Acceptance period runs to November 5, 2026 (the day after the Q3 print); merger-control clearances outstanding; settlement expected H2 2027; committed bridge ~€14B; Uber targets gross leverage below 2x and an investment-grade rating; expected accretive to non-GAAP EPS on close, high-single-digit by year three. No synergies are quantified — credit ZERO. Score leverage against the stated <2x gross ceiling, not the level. Unlike MLM's Lhoist deal (approvals and financing done before pro-forma scoring began), DH has neither — do NOT reason pro-forma.
5. AV HEADLINES ARE CLASSIFIED, NOT REFLEXIVELY SCORED. For every AV headline ask: does it change WHERE AV supply lists (structural) or only WHEN a fleet launches (timing)? Waymo choosing its own app is structural; a partner's launch slipping a quarter is timing. ★ CALIBRATION: Waymo going direct is the BASE CASE and is already in the price — it was on Uber in only three of its ~15 metros (Phoenix ended mid-2026; Austin and Atlanta move to Waymo's own app in January 2028, with the current fleet on Uber through at least May 2028). That state maps to CONTESTED and scores ZERO. What flips the regime is a SECOND tier-1 operator (fully driverless, open-to-public, at scale) withdrawing or declining Uber supply where it runs at scale, or Uber's own exclusive pipeline (Rivian, Lucid/Nuro) missing a disclosed milestone.

WHAT DRIVES UBER:
1. THE MOBILITY CANARY (THE structural metric). Mobility gross bookings growth in constant currency: above 18% = intact, no visible AV leakage (Q2 2026 printed +20%); 12-18% = softening, watch; below 12% while Delivery holds = BROKEN — the AV-disintermediation signature and the cleanest falsifier in this model, thesis-level regardless of total bookings. Both segments below 12% is a broad demand slowdown — a cycle read, not the AV signature.
2. THE DEMAND ENGINE. Q2 2026 (reported August 5): gross bookings $58.02B, +24% reported / +22% cc; Mobility $28.99B (+20% cc), Delivery $27.46B (+25% cc), Freight $1.57B; trips 3.867B (+18%); MAPCs 208M (+16%); Adj EBITDA $2.82B (+33%) at 4.9% of GB vs 4.5%; segment OI Mobility $2.22B (+28%), Delivery $1.06B (+38%); non-GAAP EPS $0.81 (+35%); FCF $2.79B; SBC $550M. Q3 2026 guide: GB $58.25-60.25B (18-22% cc), non-GAAP EPS $0.84-0.88, Adj EBITDA $2.86-2.96B — the guide landed below consensus when issued.
3. MARGIN ON BOOKINGS, NOT REVENUE. Adj EBITDA as a % of gross bookings is the operating-leverage read: above 5.0% compounding; below 4.3% a reversal (incentives, AV economics or mix). Driver and courier incentive intensity into the holiday quarter is the near-term swing factor — elevated is a modest headwind, structural only if it persists two quarters.
4. AV SUPPLY — the long-run binary. Against Waymo (~4,000 vehicles, >500,000 paid rides a week, overwhelmingly on its own app) and Tesla (own Robotaxi app only, 7 metros, partially unsupervised): Uber committed more than $10B to AVs (April 30, 2026 — >$2.5B equity stakes, >$7.5B earmarked for fleet purchases, with Hertz's Oro Mobility, institutional investors and private credit expected to finance deployment). Rivian (March 19, 2026): 10,000 R2 robotaxis committed, an option to negotiate up to 40,000 more from 2030, EXCLUSIVE to Uber, up to $1.25B of investment through 2031 tied to autonomy milestones, San Francisco and Miami in 2028, 25 cities by 2031. Lucid/Nuro: at least 35,000 vehicles, Uber stake above 11% of Lucid, SF first and Houston in 2027. Zoox planned on Uber in Las Vegas (not yet live as of late October) and Los Angeles (2027); WeRide live in Abu Dhabi; also Baidu, Pony.ai, Momenta, Wayve, VW/MOIA, Nvidia (28 cities by 2028), Stellantis, Motional, Avride. Fleet ownership turns asset-light into capex-heavy at the margin; the edge is utilization from demand density. A tail of partners is not the same as a second leader — weigh accordingly.
5. VALUATION. Owner FCF yield is the FLAGSHIP lens (>7% deep value / 5.5-7% value / 4-5.5% fair / <3.5% rich) — an absolute anchor, which matters because Uber's GAAP-profitable history is short and own-history multiples cannot bear much weight. Non-GAAP forward P/E (<18x buy, 18-26x fair, >32x stretched; establish whether the non-GAAP EPS deducts SBC) and EV / Adj EBITDA (<14x buy, 14-20x fair, >24x rich; SBC-excluded trailing, tagged) are secondary. As of October 26: price $66.13, ~35% below the 52-week high near $101.99 and within a dollar of the low; market cap ~$135B, EV ~$140B; forward P/E ~16.4.
6. PEERS — SECONDARY. No true twin exists. DASH (~25x forward, fell 6.1% on October 26 on reports of Instacart talks), LYFT (~8.7x forward; its ~2.3x trailing is a tax-benefit artifact), GRAB (~15.6x forward). Cohort forward P/E ≈ 18.5x weighted; UBER ≈ −12% vs cohort and ≈ −34% vs DASH. A peer read can confirm a strategic score, never carry one.
7. SHAREHOLDER RETURN AND INSIDERS. Net share count −2.28% YoY (−1.02% QoQ). CEO Dara Khosrowshahi bought 141,000 shares at ~$70.96 (~$10M) on September 10, 2026 — his first open-market purchase since May 2022; COO Andrew Macdonald bought 70,000 at ~$75.83 (~$5.3M) in early September. Small positive, never decisive.
8. EARNINGS WINDOW DISCIPLINE: Q3 2026 is reported WEDNESDAY NOVEMBER 4, 2026 before the open, and the Delivery Hero acceptance period closes November 5. UBER enters the book INSIDE the window. Within ±10 days of a report, HALVE the size of any tactical conviction and say so. Post-print, score the print — the Mobility canary first, then the Q4 guide, then any AV-partner commentary.

DO NOT PENALIZE: RSI 38-62 (normal for beta 1.26), daily moves under 2.5%, drawdowns under 18%, the GAAP trailing P/E in either direction or its mechanical jump after November 4 (trap 1), reported revenue growth below bookings growth (trap 2), the slowed buyback PACE while the net count falls (trap 3), Delivery Hero leverage inside the 2x ceiling (trap 4), Waymo's Austin/Atlanta own-app launch (trap 5 — the base case), the absence of a dividend (there is none; yield is a non-field), or a GAAP-inflated ROIC (flagged, not scored).

BUY BIAS (in addition to engine signals): owner FCF yield above 5.5% with the Mobility canary intact; non-GAAP forward P/E below 18x; EV / Adj EBITDA below 14x on a tagged basis; drawdown beyond 18% from highs with bookings intact; an AV-headline shock you can attribute to a competitor's or partner's AV news with no Uber operating print behind it; a new tier-1 operator going live on Uber in a major US metro; Rivian or Lucid/Nuro hitting a disclosed milestone early; net share count falling faster than 2% a year.

TRIM BIAS: Mobility GB cc growth below 12% while Delivery holds (the cleanest falsifier); a SECOND tier-1 operator withdrawing or declining Uber supply where it runs driverless at scale; Uber's exclusive pipeline missing a disclosed milestone; Adj EBITDA below 4.3% of GB; owner FCF yield below 3.5%; gross leverage breaching the stated 2x ceiling; net share count rising year over year.

YOUR VALUE-ADD: the Mobility canary and the cc bookings split (engine null — earnings disclosure), Adj EBITDA % of GB, segment OI, incentive pressure, owner FCF yield after SBC, non-GAAP forward P/E with its SBC treatment, EV / Adj EBITDA with an explicit basis tag, ATTRIBUTION of any AV-shock candidate in the MARKET DATA, AV-headline classification (structural vs timing), tier-1 operator status, Rivian and Lucid/Nuro milestone status, the Delivery Hero acceptance result, earnings-window discipline, EPS revisions.

MOST DAYS NEUTRAL: ±8 roughly 80% of days — between MLM's ±6 and the high-beta names; most AV headlines are timing, not structure. Meaningful scores on drawdown setups (engine flags), attributed AV-headline shocks (you attribute), Mobility-canary prints (you flag), tier-1 supply decisions (you flag), Delivery Hero milestones (you flag), earnings-window resets (you flag).
` : "";

  const cvxGuidance = isCVX ? `
CRITICAL — CVX-SPECIFIC SCORING GUIDANCE (V1):

IDENTITY — READ THIS FIRST. CVX is CHEVRON CORPORATION (NYSE: CVX, CIK 93410, Houston) — the integrated oil and gas major; Texaco and Caltex are Chevron brands, and Hess Corporation is now part of Chevron (closed July 18, 2025). It is NOT "Chevron deference" — the administrative-law doctrine from Chevron v. NRDC (1984), overruled by Loper Bright in 2024; an analysis about agency interpretation or administrative law has the wrong subject entirely. It is NOT ExxonMobil — XOM is the twin benchmark and Chevron's Stabroek partner. It is NOT Hess Midstream (HESM, separately listed, being exited) and NOT Tengizchevroil (TCO, a 50%-owned affiliate that reaches Chevron's results only through equity income and distributions). "CPC" is ambiguous here: the Caspian Pipeline Consortium (TCO's export route) is NOT Chevron Phillips Chemical (the 50% chemicals joint venture) — name which one every time. This slot previously held Enbridge: nothing about Mainline tolls, Canadian pipeline tariffs or dividend yield spread versus the 10-year belongs in this analysis.

CVX is an INTEGRATED MAJOR — upstream (Permian above 1 million boe/d, TCO in Kazakhstan, 30% of Guyana's Stabroek block via Hess, Australian LNG, Eastern Mediterranean gas, Venezuela joint ventures), downstream refining and marketing, and chemicals. Three structural attributes at once: (1) a CAPITAL-RETURN FRANCHISE — capex plus dividend breakeven below $50 Brent through 2030, $10–20B a year of buybacks across a $60–80 deck, a 39-year dividend growth streak; (2) a COMMODITY that sets the level of every reported number — about $0.60B of after-tax earnings and cash flow per $1 Brent and about $0.70B per $1 Henry Hub; (3) a TWO-SIDED GEOPOLITICAL EXPOSURE — price-long the Iran war, disruption-short through the Partitioned Zone, Israeli gas, and Tengiz barrels that exit via the CPC pipeline to a Black Sea terminal near Novorossiysk.

THE ARCHITECTURAL RULE FOR THIS NAME — INTERNALIZE IT BEFORE SCORING:
Chevron is valued at ITS OWN $70 BRENT PLANNING DECK, never at spot. EXECUTION and the COMMODITY are separate signals: production vs guide, cost-out, capex discipline and the buyback guide are Chevron's; realized prices, refining cracks, consensus revisions and every spot multiple are the strip's. With Brent near $115 on a war that began February 28, 2026, every spot multiple — trailing P/E, forward P/E on consensus, headline FCF yield — is computed on windfall earnings and looks cheaper than the business is. The honest strategic anchor is normalized adjusted FCF at the deck. The one place the two clocks meet is the TCO CANARY: roughly a quarter of normalized FCF exits through one pipeline.

V8.6 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI bands 35/70, daily-move noise floor ±2%
• Drawdown-from-52w-high primary tactical, ladder scaled to 35% (>12% setup, >20% strong, >30% extreme). ★ REGIME-AWARE: in a DISLOCATED-HIGH regime drawdowns, down days and down air pockets are the windfall premium unwinding and score ZERO; RSI above 70 with price more than 10% over SMA50 on windfall oil is a trim lean
• XOM TWIN DISLOCATION (CVX lagging XOM by more than 4pp over 30 days) — the signature tactical setup, close to oil-neutral, live in every regime. SHEL/TTE are context only
• Geopolitical AIR-POCKET screen (|move| ≥ 4% in the last 5 sessions, not the print day), scored only where price alone classifies it: a Chevron-specific drop (≥3pp worse than XLE) is NOT bought blind; a sector-wide down session is zero in a windfall regime and a light sympathy buy elsewhere. CLASSIFICATION of the headline is YOURS — express it in your tactical score
• XLE (Energy Select) factor flow vs SPY at ±2pp — in a windfall regime an energy bid IS the windfall trade, not a tailwind
• DAMPENED trend scoring — MA map and a −30 floor on the 52w ladder: a trend break in an oil major usually IS the commodity, which the normalization owns
• Production vs the FY26 guide, the TCO/CPC canary (intact −3 · degraded +6 · broken +18), Guyana timing, capex vs guide, the next-quarter buyback guide, EPS revisions (ANCHORED regime only), normalized FCF yield, price-implied Brent, the forward twin premium vs XOM, breakeven vs $50, NET share count on a clean base, net debt ex-HESM — when sourced (they arrive null — YOU source them)
• ⛔ CYCLE-POSITION GATE: Brent more than 40% above the deck (above $98) → the BLENDED strategic score is floored at 0 in blendScores() unless normalized FCF yield is at least 6% on a FULL normalization; more than 40% below (below $42) → capped at 0 unless that yield is below 4%. The engine's normalization inputs are LLM-sourced and null in its data, so the engine-side gate fails CLOSED whenever Brent is above $98 — your strategic number cannot buy through it. The MARKET DATA gate line states the live state
• Composite weights regime-conditional on the OIL PRICE regime — spot Brent vs the $70 deck, engine V8.6: anchored (≤20%) 25/40/35 · transitional (≤40%) 20/35/45 · dislocated 15/30/55 (the LIN/MLM/UBER triple, deliberately reused)

FIVE CALIBRATION GUARDRAILS — ALL LOAD-BEARING. GET THESE WRONG AND THE SIGNAL IS NOISE:
1. WINDFALL NORMALIZATION. Score NORMALIZED adjusted FCF at the deck: normalized FCF = TTM adjusted FCF − (TTM average Brent − $70) × $0.60B − (TTM average Henry Hub − $3.50) × $0.70B − (TTM downstream earnings − $3.0B mid-cycle). A TTM below the deck ADDS back. The commodity adjustments are pre-computed in the MARKET DATA; you source TTM adjusted FCF and TTM downstream earnings and report every input. If Henry Hub or downstream cannot be established the normalization is PARTIAL — a crude-only figure OVERSTATES normalized FCF while cracks are elevated. NEVER score the GAAP trailing P/E or the consensus forward P/E, in EITHER direction — and do NOT invert them the way the cyclical names are read (CVX is deliberately not in the cyclical set). ★ CALENDAR TRAP: when Q3 2026 is reported on October 30, 2026, Q3 2025 (GAAP EPS $1.82 on $69 Brent) rolls OUT of the trailing window and a quarter consensus puts near $4.86 rolls IN; the trailing P/E falls from about 22x toward about 17x overnight with NO change in the business. Then the Hess Midstream exit books a one-time $3–4B after-tax loss that distorts GAAP the other way. The TTM averages roll too — recompute the normalization, never carry it.
2. TIMING AND WORKING CAPITAL. Single-quarter EPS and headline operating cash flow are NULL SIGNALS: Q1 2026 carried about $2.9B of unfavorable timing effects (derivative marks and LIFO) and a $4.6B working-capital outflow — operating cash flow $2.5B against $7.1B excluding working capital; Q2 2026 released $2.9B of working capital and timing reversed. Score TTM CFFO ex-WC and adjusted FCF only. ★ EARNINGS UNDERSTATE CASH: DD&A is guided at $23–24B against organic capex of $18–19B (the Hess purchase-accounting step-up), so any normalized P/E is secondary and inflated; the normalized FCF yield is the anchor.
3. HESS ANNIVERSARY. Hess closed July 18, 2025 with about 301 million shares issued: any YoY share count crossing that date shows about +14% mechanical "dilution". Use PERIOD-END counts; the first clean base is 2,013.5M at September 30, 2025 (1,975.8M at June 30, 2026 — −1.9% in nine months). Weighted-average diluted Q3 2026 vs Q3 2025 is STILL contaminated (Hess shares for about 74 of 92 days). Production: Q3 2026 is measured against a post-Hess Q3 2025 (4,086 MBOED), so YoY growth collapses to low single digits mechanically after Q2's +20% — score against the FY26 guide of 3,980–4,100 MBOED, never YoY.
4. BALANCE-SHEET OPTICS. The Hess Midstream exit (announced October 6, 2026; close expected by year-end) deconsolidates about $3.7B of HESM debt with no cash generated — that is not deleveraging. TCO loan repayments ($1B in Q1 2026, $1B guided for Q3) flatter adjusted FCF. Read leverage ex-deconsolidation.
5. CYCLE-POSITION GATE. Beyond ±40% of the deck the strategic layer may not sit on the side the spot price flatters: DISLOCATED-HIGH (Brent above $98) — no strategic BUY unless normalized FCF yield is at least 6% on a FULL normalization; DISLOCATED-LOW (Brent below $42) — no strategic TRIM unless that yield is below 4%, the framework's trough-entry rule made mechanical. It fails closed on a null or partial normalization. Score your strategic number honestly inside it — do not compensate by leaning tactical or positional toward a buy.

WHAT DRIVES CVX:
1. NORMALIZED FCF AT THE DECK (THE strategic anchor). Bands on the NORMALIZED yield: above 7% deep value / 6-7% value / 4.5-6% fair / 4-4.5% lower end of fair / below 4% rich. PRICE-IMPLIED BRENT at a 6% yield = 70 + (0.06 × market cap − normalized FCF) / 0.60: below $65 the stock discounts sub-deck oil (buy bias); $65-80 fair; above $85 it discounts a durable war premium (rich). As of the Q2 print (crude-only, a CEILING): TTM adjusted FCF about $30.7B − ($79.5 − $70) × $0.60B ≈ $25.0B ≈ 5.5% on a market cap near $455B, price-implied Brent about $74. Downstream ran far above mid-cycle in Q2 and Henry Hub averaged $4.66 in Q1, so the FULL normalization is LOWER.
2. THE TCO / CPC CANARY (THE operational metric). TCO is about $6B of Chevron-share FCF at $70 Brent — roughly a quarter of normalized FCF — and it exits through one pipeline. Intact = CPC flowing and TCO at or near capacity; degraded = intermittent CPC suspensions or TCO downtime; broken = CPC suspended more than two weeks or TCO output materially curtailed — THESIS-LEVEL. Status: third-generation plant nameplate raised from 260,000 to 320,000 bpd; total processing slightly above 1 million bpd; two of three single-point moorings in service, the third expected back from refurbishment in Q3 per the Q2 call — confirm. CPC loadings were suspended repeatedly in 2026 after drone strikes on tankers near the terminal; CPC throughput about 1.59 million bpd in September. Wirth on the Q2 call: a prolonged shutdown is not a highly likely scenario.
3. WHETHER THE WINDFALL REACHES SHAREHOLDERS. The next-quarter buyback guide is the read: the prior guide was $2.5-3.0B a quarter; above $3.0B means the windfall has started reaching shareholders rather than the balance sheet; a cut below $2.5B with Brent above $80 means the franchise is not converting. Q2 2026: buybacks $3.1B, dividends $3.5B, total debt cut a record $8.4B to $37.1B, net debt ratio 13.1%. Score the NET period-end share count on a clean base, never gross buyback dollars (option exercises returned about $1B in Q1 2026 and largely offset that quarter's buybacks).
4. EXECUTION. Q2 2026 (reported July 31): adjusted EPS $6.06 on Brent averaging $104 vs $68 a year earlier; production 4,070 MBOED, second-highest ever; CFFO ex-WC $19.7B; capex $4.5B; adjusted FCF $15.4B; downstream earnings $4.87B vs $737M a year earlier — cracks, not just crude; structural cost savings at a $3B run-rate (target $3-4B by year-end, reached early); Hess synergies $1.5B. FY26 guide: production 3,980-4,100 MBOED, organic capex $18-19B (tracking the low end) against the $21B Investor Day ceiling. Four Guyana FPSOs producing, a fifth expected before year-end 2026; Permian above 1 million boe/d for five quarters.
5. THE OIL TAPE — CONTEXT, CLASSIFIED, NOT REFLEXIVELY SCORED. Brent peaked near $126, fell to $71.57 on July 1 after an April ceasefire, averaged about $91 in August and about $114 in September, and settled at $115.81 on October 26 — about 64% above the deck: DISLOCATED-HIGH, weights 15/30/55, the gate live on the buy side. Hormuz transits a small fraction of pre-war levels; US blockade of Iranian ports; the US SPR at its lowest since 1982. EIA's October STEO has Q4 2026 Brent at $105 and 2027 at $84 — the strip itself expects normalization. For every headline ask: does it change the DURATION of the supply disruption (Hormuz access, Gulf infrastructure, blockade terms — structural for the windfall), or does it hit a CHEVRON ASSET (Partitioned Zone, Leviathan, CPC/TCO, Venezuela — asset-specific)? ★ CALIBRATION: in a DISLOCATED-HIGH regime a de-escalation sell-off is the windfall premium unwinding — information, not an oversold buy. Precedent: April 1, 2026, CVX fell 4.6% on reports Iran's president was prepared to end the conflict — the worst day of a 21.5% drawdown from March 27 to July 1 as Brent fell from about $118 to about $72. Buying that air pocket bought the top of the unwind. An escalation spike extends the windfall — a mild trim lean, never a re-rating.
6. VALUATION — SECONDARY LENSES. Forward P/E about 12.2 on consensus (SPOT — reported only); trailing GAAP about 22.3 (ARTIFACT). XOM is the twin (forward about 12.4; CVX about 2% below — normal); a forward-basis gap beyond ±10% is a secondary read that can confirm a strategic score, never carry one. SHEL (about 8.4x forward) and TTE (about 7.2x) are a structural-discount reference only. Dividend $1.78 quarterly, yield about 3.1%, 39 consecutive annual increases — judged on coverage by normalized FCF, never as a yield spread. As of October 26: price $232.01, about 1% below the 52-week high of $234.08, about 10.5% above the 50-day and 19.5% above the 200-day, up about 55% year to date (XLE about +58%); market cap about $455B; five-year beta 0.52.
7. INSIDERS. All sales and no open-market buying in the last 90 days: CEO Mike Wirth about $63.6M (August 14), director John B. Hess about $137.9M (August 3), a Rule 10b5-1 sale on October 20. Establish whether sales were option-related before reading intent into them; never decisive.
8. EARNINGS WINDOW DISCIPLINE: Q3 2026 is reported FRIDAY OCTOBER 30, 2026 before the open (consensus EPS about $4.86). CVX enters the book INSIDE the window. Within ±10 days of a report, HALVE the size of any tactical conviction and say so. Post-print, score the print — the Q4 buyback guide first, then production vs guide and the TCO commentary, then recompute the normalization on the rolled TTM.

DO NOT PENALIZE OR REWARD: RSI 38-62, daily moves under 2%, a DISLOCATED-HIGH drawdown as if it were oversold (the premium unwinding scores zero), the GAAP trailing P/E in either direction or its mechanical drop after October 30 (guardrail 1), a single quarter's EPS or headline CFFO (guardrail 2), the ~+14% "dilution" or the YoY production collapse across the Hess anniversary (guardrail 3), the HESM debt removal as deleveraging (guardrail 4), a spot-inflated ROCE (flagged, not scored), CVX's premium to SHEL/TTE (structural), or the dividend yield against the 10-year (not a bond proxy — this is not Enbridge).

BUY BIAS (in addition to engine signals): normalized FCF yield above 6% at the deck on a full normalization; price-implied Brent below $65; CVX lagging XOM by more than 4pp over 30 days with no Chevron-specific event; a drawdown beyond 12% from the 52-week high with the TCO canary intact and Brent at or below the anchored band; a sector-wide oil air pocket outside the windfall regime; the next-quarter buyback guide raised above $3.0B; capex tracking the low end of guide while production meets guide; net period-end share count falling faster than 2% a year on a clean base; a trough regime (Brent below $42) with the balance sheet intact.

TRIM BIAS: normalized FCF yield below 4%; price-implied Brent above $85 (the stock discounting a durable war premium); the TCO canary broken; production tracking below 3,980 MBOED ex-disruptions; capex above the $21B ceiling; capex-plus-dividend breakeven drifting above $50 Brent; the buyback guide cut below $2.5B a quarter with Brent above $80; net share count rising on a clean base; a Hormuz settlement that resets Brent toward the anchored band while the stock holds a price-implied Brent above $85; RSI above 70 with price more than 10% over SMA50 on windfall oil.

YOUR VALUE-ADD: TTM adjusted FCF and TTM downstream earnings to complete the normalization (the engine cannot), the normalized yield and price-implied Brent with every input reported, CLASSIFICATION of any air-pocket candidate in the MARKET DATA (disruption duration vs Chevron asset), TCO/CPC status, the next-quarter buyback guide, production vs guide, capex vs guide, Guyana fifth-FPSO timing, HESM deconsolidation state and net debt ex-deconsolidation, period-end share count on a clean base, the XOM forward P/E, earnings-window discipline.

MOST DAYS NEUTRAL: most days the stock is doing nothing remarkable and most signals should sit near zero — scores beyond ±20 on a normal day mean something is miscalibrated (five-year beta 0.52; 2026 realized volatility is the oil war, not the business). Meaningful scores on XOM twin dislocations (engine flags), classified air pockets (you classify), TCO canary changes (you flag), buyback-guide changes (you flag), normalization prints (you compute), earnings-window resets (you flag).
` : "";

  const calibrationBlock = buildCalibrationBlock(h.symbol, CALIBRATION, md.price?.current);
  const temporalLine = buildTemporalLine(h.symbol, TEMPORAL_Z); // v8.2.0: own-history context (empty when ineligible)
  const confidence = computeConfidence(MARKET_DATA, h.symbol);
  const confidenceNote = confidence.level === "low"
    ? `\n⚠️ DATA CONFIDENCE: LOW (${confidence.score}%). Missing: ${confidence.missing.join(", ")}. Lean toward NEUTRAL when data is incomplete.\n`
    : confidence.level === "medium"
    ? `\nDATA CONFIDENCE: MEDIUM (${confidence.score}%). Missing: ${confidence.missing.join(", ")}. Exercise caution in extreme scores.\n`
    : "";

  // v8.0: static (cacheable) blocks in system; dynamic data in the user message.
  const perTickerSystem = `HOLDING: ${h.symbol} (${h.name} — ${h.sector}) | Archetype: ${h.archetype}
Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
${cyclicalWarning}${asmlGuidance}${amkbyGuidance}${kofGuidance}${glncyGuidance}${linGuidance}${msftGuidance}${lhxGuidance}${tmoGuidance}${nowGuidance}${maGuidance}${isrgGuidance}${mlmGuidance}${uberGuidance}${cvxGuidance}`;

  const user = `A deterministic engine has already scored the quantitative data:
  Tactical (quant): ${detScores.tactical.score} — ${detScores.tactical.notes.join(", ")}
  Positional (quant): ${detScores.positional.score} — ${detScores.positional.notes.join(", ")}
  Strategic (quant): ${detScores.strategic.score} — ${detScores.strategic.notes.join(", ")}
${confidenceNote}${calibrationBlock}${temporalLine}
MARKET DATA:
${dataLines}

Apply the HOSTILE REVIEW PROTOCOL to each layer, then call record_scores exactly once.`;

  return {
    system: [
      { type: "text", text: SHARED_SYSTEM_QUALITATIVE, cache_control: { type: "ephemeral" } },
      { type: "text", text: perTickerSystem, cache_control: { type: "ephemeral" } },
    ],
    user,
  };
}

// Web search prompt for symbols with insufficient data
function buildSearchPrompt(h) {
  const isCyclical = CYCLICAL_ARCHETYPES.has(h.archetype);
  const isASML = h.archetype === "secular_growth_monopoly";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";
  const isLIN = h.archetype === "oligopoly_quality_compounder";
  const isMSFT = h.archetype === "ai_infra_quality_compounder";
  const isLHX = h.archetype === "defense_prime_backlog_compounder";
  const isTMO = h.archetype === "life_sciences_quality_compounder";
  const isNOW = h.archetype === "ai_workflow_quality_compounder";       // ← V7.6
  const isMA = h.archetype === "payments_network_quality_compounder";   // ← v8.3.0
  const isISRG = h.archetype === "surgical_robotics_moat_compounder";   // ← v8.3.0
  const isMLM = h.archetype === "reserve_moat_infrastructure_compounder";  // ← v8.5.0
  const isUBER = h.archetype === "marketplace_demand_aggregator";          // ← v8.6.0
  const isCVX = h.archetype === "integrated_major_capital_returner";       // ← v8.7.0
  const md = MARKET_DATA[h.symbol] || {};

  const cyclicalWarning = isCyclical ? `\nCRITICAL — CYCLICAL VALUATION: ${h.symbol} is a cyclical business. High trailing P/E means earnings are at TROUGH — this is a BUY signal, not a sell signal. Low P/E means peak earnings and cycle rollover risk. Do NOT penalize high trailing P/E for cyclicals.\n` : "";

  const asmlGuidance = isASML ? `\nCRITICAL — ASML SCORING: Secular growth monopoly (sole EUV supplier). Do NOT penalize 52w proximity or RSI 65-75. Trailing P/E 30-42x is NORMAL. Buy signals: drawdowns >15%. Trim signals: forward P/E >45x, book-to-bill <1.0. Buybacks ~3-5% annual. Most days = NEUTRAL.\n` : "";

  const amkbyGuidance = isAMKBY ? `\nCRITICAL — AMKBY SCORING: Cyclical trade bellwether (world's largest container shipping). INVERTED P/E applies — high PE = trough = BUY, low PE = peak = TRIM. Shipping cycles are more extreme than commodities: PE 2-5x = peak, PE 50+ = trough. P/B matters (asset-heavy fleet): P/B <0.7 = below replacement cost = strong buy. Search for: WCI/SCFI container freight rates (THE primary signal), BDI, global trade volumes, Red Sea/Suez disruptions, Maersk logistics vs DSV/Kuehne+Nagel valuation gap, tariff/trade war impacts. Scores can be ±15 to ±25 during active freight markets.\n` : "";

  const kofGuidance = isKOF ? `\nCRITICAL — KOF SCORING: Coca-Cola FEMSA, largest Coke bottler in LatAm. Consumer staples compounder. Do NOT penalize 52w proximity or RSI 50-65 (normal for staples). P/E 15-22x is NORMAL. The #1 non-fundamental driver is MXN/USD — KOF earns ~60% in MXN. Strong peso = ADR tailwind, weak peso = headwind. Search for: MXN/USD direction, Banxico rate decisions, Mexican consumer spending, retail sales, nearshoring impact on peso, sugar/PET resin costs, volume growth by geography, dividend growth trajectory. Most days = NEUTRAL.\n` : "";

  const glncyGuidance = isGLNCY ? `\nCRITICAL — GLNCY SCORING: Diversified commodity trader (mining: copper 30%, coal 25%, zinc/nickel/cobalt + trading/marketing arm). INVERTED P/E applies but with higher floor than pure cyclicals (trading arm generates $2-4B EBITDA even in troughs). P/B matters (mining assets = replacement cost): P/B <0.8 = strong buy. Search for: LME copper price and trend (THE lead indicator), copper inventories, Chinese PMI/property, zinc/nickel/cobalt prices, coal price + ESG pressure, DXY direction, Glencore trading arm valuation (market often prices at zero). Scores ±10-20 during active commodity markets.\n` : "";

  const linGuidance = isLIN ? `\nCRITICAL — LIN SCORING (V3): Linde plc, world's #1 industrial gas company in 3-player oligopoly (LIN/APD/AI.PA). Quality compounder, 30+ year Dividend Aristocrat, ROCE >25%, op margin >30%. Do NOT penalize 52w proximity, RSI 60-70, P/E 26-32x, or peer premium 5-15% — all normal for low-vol best-in-class compounder. Composite weights are regime-conditional on geo-weighted PMI (>55: 25/40/35 expansion · 48-55: 20/35/45 neutral · <48: 15/30/55 contraction). Cleanest valuation signal is P/E premium vs APD+AI.PA peer avg with 6M direction (compressing = buy bias even if level is normal). Search for: LIN P/E vs APD and Air Liquide (current + 6mo ago), ASU capacity utilization disclosed in earnings, like-for-like price/mix ex-FX from segment reporting, BBB OAS credit spread (FRED BAMLC0A4CBBB), EPS revisions from FactSet/Refinitiv, hydrogen project pipeline (LIN is global H2 leader, IRA 45V tax credits, EU H2 Bank auctions, contracts $ trailing 90d), green/grey LCOE gap (current + 6mo ago), semi fab capex (TSMC Arizona, Samsung Texas, Intel Ohio, Micron NY drive on-site contracts), decarbonization/CCUS deployments, backlog growth (sale-of-gas + on-site, leading indicator), DXY direction (~70% non-US revenue), QUAL ETF performance vs SPY (30d). Most days = NEUTRAL. Meaningful scores: peer premium dislocations, growth-scare drag-downs, mega-project wins, regulatory pivots.\n` : "";

  const msftGuidance = isMSFT ? `\nCRITICAL — MSFT SCORING (V1): Microsoft, AI infrastructure quality compounder. HYBRID archetype: LIN-like quality + ASML-like secular growth + SPY-like rate sensitivity. Best-in-class op margins (~44%), Azure as primary AI infrastructure beneficiary, OpenAI partnership as proprietary distribution moat. Do NOT penalize 52w proximity, RSI 60-70, P/E 27-33x, or cohort premium 0-15% (vs GOOGL/META/AAPL — that's the deserved quality premium). Composite weights regime-conditional on real rate (fed funds − 10Y TIPS), engine V8.1: <0.5% accommodative 25/40/35, 0.5–2% neutral 20/35/45, >2% restrictive 15/30/55. PRIMARY SIGNALS: cohort P/E premium vs mega-cap quality peers + drawdown-from-52w-high (>12% setup, >20% strong, >25% rare conviction). Cohort rotation pressure (MSFT lagging GOOGL/META/AAPL avg 30d) is a BUY setup, not a warning — quality compounder catches the rotation back. Engine has TRAILING P/E only (Finnhub free tier); your forward P/E + PE-vs-history is critical. Search for: MSFT forward P/E vs trailing, MSFT P/E percentile vs 3y/5y/10y average, Azure constant-currency growth (latest quarter and trend — central operational metric, acceleration >28% confirms AI thesis, deceleration <22% is headwind), hyperscaler peer capex direction (GOOGL/META/AMZN), OpenAI partnership status (governance, IP, exclusivity, AGI clauses), Copilot enterprise adoption (seat count, ASP, retention), capex YoY growth + FCF margin compression, EPS revisions trend (FactSet/Refinitiv), DXY direction (~50% non-US revenue), QUAL ETF performance vs SPY (30d). Most days = NEUTRAL. Meaningful scores: drawdown-from-high setups, cohort rotation extremes, Azure inflection, OpenAI/regulatory headlines.\n` : "";

  const lhxGuidance = isLHX ? `\nCRITICAL — LHX SCORING (V1): L3Harris Technologies, defense prime backlog compounder. HYBRID: LIN-like quality + ASML-like DoD capex cycle + geopolitical regime overlay. Smallest of Big 5 primes (LMT/RTX/NOC/GD/LHX), historically -5 to -15% PE discount to cohort — compression is the central re-rating thesis. Aerojet SRM duopoly with NOC. Do NOT penalize 52w proximity, RSI 50-70, trailing P/E 22-28x, cohort discount -5 to -15% (normal). Composite weights regime-conditional on ITA vs SPY 30d flow, engine V8.1: >+1pp bid_active 25/45/30, ±1pp neutral 20/40/40, <−1pp bid_absent 15/35/50; neutral base keeps positional+strategic co-equal. PRIMARY SIGNALS: book-to-bill (>1.10 strong, <0.95 thesis risk), backlog YoY (>8% expansion, <0% erosion), cohort PE compression vs LMT/NOC/RTX/GD, drawdown from 52w high (>10% setup, >18% strong), cohort rotation pressure (LHX lagging cohort >5pp/30d = BUY setup, capital flowing to larger primes), ITA vs SPY 30d (>1pp = defense bid active). Engine has TRAILING P/E only; your forward P/E + PE-vs-3Y is critical. Search for: LHX forward P/E + PE-vs-3Y-history, latest book-to-bill ratio (from earnings call disclosure), backlog YoY (dollar value delta), op margin + FCF margin trend, EPS revisions 30d/60d/90d (FactSet/Refinitiv), LMT/NOC/RTX/GD forward PE (defense cohort average), DoD budget cycle phase (FY27 NDAA progress, CR risk, supplemental funding flow Ukraine/Israel/Taiwan, sequester probability, BCA dynamics), geopolitical regime phase (great_power_competition / regional_conflict / transition / peace_dividend), Aerojet Rocketdyne integration progress + propellant supply chain, major program awards (F-35 mission systems, NGAD/6th-gen, Golden Dome / homeland missile defense, ISR programs, tactical radios, space C4ISR), defense-industrial supply chain (titanium, semiconductors, energetics, rare earths), dividend growth trajectory. Most days = NEUTRAL. Meaningful scores: cohort rotation extremes, drawdown setups, B/B inflection, DoD budget moments, geopolitical regime shifts, major program/earnings catalysts.\n` : "";

  const tmoGuidance = isTMO ? `\nCRITICAL — TMO SCORING (V1): Thermo Fisher Scientific, "ASML of life sciences" — picks-and-shovels supplier. HYBRID: LIN-like quality + ASML-like secular monopoly + cyclical end-market exposure (bioprocessing, biotech funding, China capex). Strategic dominates (45%) — cycle inflection thesis: bioprocessing destocking ending, biotech funding thawing, COVID comps lapped. Do NOT penalize 52w proximity, RSI 50-65, trailing P/E 22-30x, bioprocessing destocking by itself (late-trough setup), organic growth at 1% trough (cycle bottom). Composite weights regime-conditional on XBI 90d return, engine V8.1: >+10% thawing 25/40/35, ±10% neutral 20/35/45, <−10% frozen 15/30/55. PRIMARY SIGNALS: bioprocessing cycle phase (destocking/bottoming/early_recovery/expansion/peak), organic growth trajectory off the 1% Q1 2026 trough, peer triangulation DHR+Sartorius+Repligen, XBI 90d return (leads TMO bookings 2-3Q — >+10% thawing, <-10% frozen), biotech sympathy setup (TMO+XBI both down = collateral buy), drawdown from 52w high (>15% setup, >25% strong), DHR peer P/E + daily spread, QUAL vs SPY 30d (quality bid), forward PE vs 5Y avg. Engine has TRAILING P/E only; your forward P/E + PE-vs-5Y is critical. Search for: TMO forward P/E + PE-vs-5Y-history, current bioprocessing cycle phase (TMO + DHR + Sartorius + Repligen commentary triangulation), organic growth YoY (latest quarter print), op margin + FCF margin + EPS revisions (FactSet/Refinitiv), XBI 30d / 90d performance, China life sciences capex direction, NIH funding outlook, Wave 4 AI life sciences activation (AI biologics bioproduction, mass spec for AI research, lab automation), GLP-1 disruption to diagnostics narrative, PPD clinical research competitive position, dividend growth. CURRENT context: ~15-25% drawdown + organic growth trough = high-conviction buy SETUP zone. Most days = NEUTRAL but current setup tilts buy bias until cycle confirmation drives multiple expansion.\n` : "";

  const nowGuidance = isNOW ? `\nCRITICAL — NOW SCORING (V1): ServiceNow, AI workflow quality compounder. HYBRID: LIN/MSFT-like quality compounder + ASML-like secular agentic-AI workflow cycle + SPY-like long-duration rate sensitivity. Best-in-class non-GAAP op margins (~30%), gross margins ~80%+, FCF margin ~32%, durable 20%+ subscription revenue growth. Now Assist Pro Plus + AI Agent Studio drive agentic-AI monetization. Premium SaaS multiple math: forward PE 55-65x and EV/Sales 14-17x are the NORMAL compounder zone — do NOT score those levels as expensive. Do NOT penalize 52w proximity, RSI 50-65, trailing P/E 55-70x, cohort premium 0-20% vs CRM/WDAY/ADBE (deserved quality premium), EV/Sales 14-17x. Composite weights regime-conditional on real rate (fed funds − 10Y TIPS), engine V8.1: <0.5% accommodative 25/40/35, 0.5–2% neutral 20/35/45, >2% restrictive 15/30/55. PRIMARY SIGNALS: cRPO YoY growth (THE operational metric — acceleration confirms thesis, decel <18% = thesis air-pocket), drawdown from 52w high (>12% setup, >20% strong, >25% rare conviction), cohort PE compression vs CRM/WDAY/ADBE, cohort rotation pressure (NOW lagging cohort >5pp/30d = capital chasing higher-beta AI/SaaS = BUY setup, not warning), IGV (software ETF) vs SPY 30d (>1pp = software bid active), real rate overlay (Fed funds − TIPS 10Y; >2% restrictive = headwind, <0.5% accommodative = tailwind for long-duration cash flows). Engine has TRAILING P/E only; your forward PE + EV/Sales + PE-vs-3Y/5Y own-history + forward PEG are critical. Search for: NOW forward PE + PE % of 3y/5y avg, EV/Sales current + 3y avg + 5y avg, forward PEG, latest cRPO YoY growth (from earnings call disclosure), subscription revenue YoY growth, Now Assist Pro Plus revenue contribution + attach rate + ASP (CEO commentary at earnings / Knowledge conference / FY guidance), AI Agent Studio adoption / enterprise wins, $1M+ deals YoY growth, federal contract growth (FedRAMP High wins, DoD enterprise rollouts, civilian agency contracts), op + FCF margin trend (signals AI-cost absorption), EPS revisions 30d/60d/90d (FactSet/Refinitiv), CRM / WDAY / ADBE forward PE (enterprise SaaS quality cohort average), real rate trajectory (Fed funds − TIPS 10Y), Fed pivot expectations, agentic AI commercialization phase (early / mid / saturation), GenAI competitive landscape (CRM Agentforce displacement risk, MSFT Copilot Studio overlap), dividend (NOW does not pay one — buyback discipline only). Most days = NEUTRAL. Meaningful scores: cohort rotation extremes, drawdown setups, cRPO inflection, agentic-AI monetization milestones, real-rate regime shifts, AI cycle phase pivots.\n` : "";

  const maGuidance = isMA ? `\nCRITICAL — MA SCORING (V1): MA is MASTERCARD (payments network — the twin comparison with Visa is INTENTIONAL; V is the duopoly twin and only comparator, and your analysis subject is always Mastercard). Payments-rails quality compounder: ~58-60% adjusted op margins, ~2.3%/yr share retirement, beta ~0.83, ~2/3 international revenue, VAS ~38% of revenue growing 20%+. Thesis: disruption narratives (stablecoins, interchange caps) recur, compress the multiple, volumes never notice, multiple re-rates — the narrative-vs-evidence gap is the alpha. Do NOT penalize 52w proximity, RSI 55-65, trailing P/E 30-36x (own-history norm), P/B (buybacks shrink book equity), twin premium 10-20% vs V (the deserved baseline), the 0.7% dividend. Composite weights regime-conditional on duopoly (MA+V) vs SPY 30d, engine V8.2: >+3pp fear_receding 25/40/35 · −5..+3 neutral 20/35/45 · <−5pp fear_regime 15/30/55. PRIMARY SIGNALS: cross-border volume growth (THE operational metric — >12% refutes disruption narrative, <6% is a REAL warning), twin P/E premium vs V (<5% compressed = buy, >25% rich), twin dislocation (MA lagging V >4pp/30d = buy setup absent MA-specific break), duopoly fear regime, disruption narrative-vs-evidence categoricals, interchange regulation status (passed = thesis break). Engine has TRAILING P/E only; your forward PE (<25x exceptional / 28-32x fair / >34x stretched) + PE % of 3y avg (~35.7x; <85% buy zone / >110% trim) + forward PEG (<1.4 exceptional / >2.5 stretched) are critical. Search for: MA forward P/E + PE vs 3y/5y/10y averages, latest cross-border volume growth + GDV + switched transactions (quarterly earnings), VAS net revenue growth + share of revenue, rebates/incentives vs gross revenue trend, adjusted op margin, share count YoY, stablecoin real-economy merchant adoption evidence (displacement vs pilots — BVNK integration, V-MA-Coinbase consortium, Multi-Token Network), interchange/network-fee legislation status (committee vs floor), Visa forward PE (twin comparator), EPS revisions 30d/90d, DXY direction (~2/3 international revenue). Most days = NEUTRAL. Meaningful scores: drawdown setups, twin dislocation extremes, fear-regime shifts, narrative-evidence gap extremes, regulation status changes, cross-border inflections.\n` : "";

  const isrgGuidance = isISRG ? `\nCRITICAL — ISRG SCORING (V1): ISRG is INTUITIVE SURGICAL (da Vinci surgical robotics — NOT Intuit the software company). Medtronic (Hugo), J&J (Ottava), Stryker, Boston Scientific mentions are CORRECT — named competitors/cohort in this archetype. Surgical-robotics moat compounder: ~60% share category king, ~11,400-system installed base, ~86% RECURRING revenue (razor-blade annuity), non-GAAP op margin ~37%, no dividend, beta ~1.7. Thesis: two-decade moat probed for the first time while the 2027 instrument-lifespan transition (five of six force-feedback instrument lives extended → I&A headwind, unquantified) compresses the multiple to its deepest own-history discount in years while procedures/placements/EPS beat. ABSOLUTE PE IS NEVER THE SIGNAL: 50-70x trailing is NORMAL for this franchise. Do NOT penalize trailing P/E 50-70x, 52w proximity, RSI 55-68, cohort premium 60-120% vs MDT/SYK/BSX (structural baseline), P/B ~9-10x, no dividend, competitor product launches per se (only procedure-share evidence matters). Composite weights regime-conditional on IHI vs SPY 30d, engine V8.2: >+1pp bid_active 25/40/35 · ±1pp neutral 20/35/45 · <−1pp bid_absent 15/30/55. EARNINGS WINDOW: Q2 report JULY 16, 2026 (consensus ~$2.48 / ~$2.81B) — within ±10 days of a report, HALVE tactical conviction and say so; post-print, score the print. PRIMARY SIGNALS: total procedure growth (THE operational metric — 2026 dV guide 13.5-15.5%; beating guide with Hugo in market = moat holding; <12% = erosion tripwire ONLY with competitor share evidence), cohort P/E premium (<60% unusual discount = buy, >150% stretched), fear rotation vs cohort (lagging >6pp on headlines = buy setup absent procedure evidence), moat_status (intact/probing/eroding/breached — probing is the EXPECTED state, score neutral), instrument_transition_status (unquantified_fear = current alpha / quantified_manageable = relief catalyst / quantified_material = thesis-level). Engine has TRAILING P/E only; your forward PE (<40x exceptional / 45-55x fair / >60x stretched) + PE % of 3y avg (~72x; <80% buy zone / >105% trim) + forward PEG (<2.0 exceptional / >3.5 stretched) are critical. Search for: ISRG forward P/E + PE vs 3y/5y/10y averages, latest total procedure growth vs guide, dV placements + dV5 mix, Ion procedure growth + installed base, recurring revenue % + I&A growth, installed base total/YoY, non-GAAP op margin, 2027 instrument transition quantification language (every earnings call), Hugo US procedure-share/installed-base evidence, Ottava rollout timeline, MDT/SYK/BSX forward PE (cohort), EPS revisions 30d/90d, elective-procedure macro trends. Most days = NEUTRAL. Meaningful scores: drawdown setups, fear-rotation extremes, procedure prints vs guide, transition quantification events, moat-evidence changes, earnings-window resets.\n` : "";


  const mlmGuidance = isMLM ? `\nCRITICAL — MLM SCORING (V1): MLM is MARTIN MARIETTA MATERIALS, INC. (NYSE: MLM, CIK 916076) — construction aggregates: crushed stone, sand and gravel. NOT multi-level/network marketing or any downline structure (that acronym expansion is WRONG here). NOT Lockheed Martin — the original Martin Marietta Corporation merged with Lockheed in 1995 and MATERIALS was separated with no defense business; this portfolio holds LHX separately, do not cross-contaminate. NOT Vulcan Materials — VMC is the PEER BENCHMARK, not the subject. A LOCAL MONOPOLY by haul radius: crushed stone is worth less than the cost of moving it beyond ~25-50 miles, so each quarry owns its circle and there is NO exchange price for aggregates. The moat is PERMITTED RESERVES. ★ ARCHITECTURAL RULE: pricing and volume are SEPARATE signals — pricing is structural and near-unconditional (it RISES in recessions), volume is cyclical and policy-driven. Weak volume + intact pricing = a CYCLE datapoint. Intact volume + broken pricing = a THESIS datapoint. Q2 2026 (printed Jul 30): revenue $1.95B +21% (record), adjusted EPS $5.00 +3.3%, aggregates revenue $1.53B +16%, shipments 61.6M tons +17% of which +2.3% ORGANIC (fourth consecutive positive quarter), reported ASP $22.74 -2% BUT organic mix-adjusted pricing +3.7%, organic COGS/ton +2.1% ex pass-through freight, a $52M non-cash inventory step-up charge, FY revenue guide RAISED to ~$7.3B midpoint while FY adj EBITDA guidance was REAFFIRMED not raised (conservative energy assumptions). The stock FELL from ~$569.66 to ~$539.93 on the print, on operating margin compression from energy and acquisition mix. Beta 1.11, short interest ~4.0% — LIN-CLASS bands, NOT high-beta. Do NOT penalize RSI 40-68, daily moves under 2%, drawdowns under 15%, the LOW trailing P/E, reported ASP declines during integration, weather-driven volume misses, 3.7x pro-forma leverage while the glidepath holds, a short-term IIJA extension, the 0.64% dividend yield, or a temporarily depressed ROIC. Do NOT apply the cyclical PE inversion (GLNCY/PBR.A/AMKBY only) — aggregates have no commodity price to trough against. THREE CALIBRATION TRAPS, ALL LOAD-BEARING: (1) THE TRAILING P/E IS AN ACCOUNTING ARTIFACT — ~12.9x trailing against ~26.8x forward, because TTM profit margin (36.7%) EXCEEDS gross margin (28.2%), impossible from operations: the window carries a large non-operating gain from the Quikrete asset exchange. Engine scores trailing as ZERO when trailing < 0.6x forward and honours the fetch layer's premium_pct_reliable flag on the cohort premium (which otherwise reads near -50% and looks like a screaming discount). Do NOT reintroduce either qualitatively; say plainly the trailing multiple is uninformative and lean on forward PE / EV/EBITDA. (2) REPORTED ASP IS A NULL SIGNAL during integration — -2% reported vs +3.7% organic mix-adjusted is pure acquisition/geographic mix; engine never scores it, key every pricing judgement on mix-adjusted organic pricing. (3) WEATHER IS NOISE — heavy Texas/Southeast rain suppressed Q2 volumes into July; when a negative organic-volume print carries a material weather headwind the engine REMOVES the penalty entirely, so do not read rain as demand destruction. ★ BASIS CONSISTENCY: every multiple must carry numerator and denominator on the SAME basis (both standalone or both pro-forma, both trailing or both forward) — if you cannot establish it, return null. Spot EV/EBITDA ~17.8x uses TRAILING EBITDA; comparing it to a pro-forma ~15.6x (2026 EBITDA) fakes a two-turn re-rating. Like-for-like FORWARD it is ~15.8x standalone vs ~15.6x pro-forma — modestly accretive, roughly neutral. Composite weights regime-conditional on the PUBLIC CONSTRUCTION FUNDING regime, engine V8.4: funded 25/40/35 · neutral 20/35/45 · unfunded 15/30/55. EARNINGS WINDOW: Q2 printed Jul 30 2026, so Q3 lands late October 2026 — SEARCH for the confirmed date; within ±10 days HALVE tactical conviction and say so; post-print, score the print. PRIMARY SIGNALS: mix-adjusted ORGANIC pricing (THE moat metric — above 4% intact, 2.5-4% normal structural, BELOW 1% is a PRICING POWER BREAK and the cleanest falsifier in this model, thesis-level regardless of volume), organic volume growth (the cycle read, weather-gated), aggregates cash gross profit per ton and the PRICE-MINUS-COST SPREAD (any positive spread expands margin — Q2'26's 1.6pp spread still produced +15% adjusted cash gross profit; always use COGS EX pass-through freight), federal_authorization_status (IIJA expires SEPTEMBER 30 2026; without reauthorization formula programs revert to pre-IIJA baseline in FY2027, ~$28B/yr cut; H.R. 8870 was ordered reported by House T&I in May 2026 and management flagged a short-term extension as likely — ★ CALIBRATION: twelve extensions followed TEA-21 and ten followed SAFETEA-LU, so patches are the historical RULE and "short_term_extension" is the BASE CASE scoring ZERO, not a downgrade; only a multiyear bill materially BELOW IIJA levels or an outright lapse is a real negative), state_dot_budget_trend (historically elevated in MLM's markets — a partial buffer), LNA/Lhoist (TREAT AS A KNOWN FORWARD EVENT and reason PRO-FORMA: ~$13.5B EV, $7.0B cash + $6.5B stock, LNA did $1.8B gross sales and $786M adj EBITDA for TTM ended Dec 31 2025 at roughly 15x incl. synergies — BELOW MLM's own multiple, which is why it is accretive; ~$85M run-rate synergies credited at ZERO until realized; >2 billion tons of limestone reserves with 200+ years of life; ALL approvals received Aug 5 2026 and the $6.5B notes priced Aug 12 2026 so it is approved AND financed; ★ LEVERAGE IS SCORED ON THE GLIDEPATH NOT THE LEVEL — ~3.7x at close targeting sub-2.5x within 24 months, so 3.7x is the plan working as announced and only a missed schedule is a signal; if the deal TERMINATES the pro-forma frame is void), end markets scored separately (infrastructure and heavy nonres — data centers/power gen/warehouses — are the strong legs, residential the weak and smallest so weight it lightly; LNA's lime serves steel/environmental/agricultural end markets OUTSIDE the highway-funding channel, insulating ~a quarter of pro-forma EBITDA), NET share count change (★ NEGATIVE = BUYBACK, the INVERSE sign convention of a dilutive name: shares are down ~1.11% YoY with a 1.11% buyback yield and ten straight years of dividend growth, so MLM genuinely SATISFIES the portfolio's buyback criterion — but book the pro-forma dilution from $6.5B of LNA stock consideration against a ~$31.6B market cap now), VMC twin dislocation (the signature setup — MLM and VMC are the two dominant US aggregates franchises and rarely diverge for non-operating reasons; scored SEPARATELY from the 3-name cohort, which uses a WEIGHTED average VMC .50 / CRH .25 / EXP .25 at a −5pp rotation threshold, TIGHTER than RDDT's −8pp because beta is 1.11). Engine has TRAILING P/E only and for this name it is contaminated; your forward PE (<24x buy / 26-32x fair / >36x stretched) and EV/EBITDA (<15x buy / 16-19x fair / >21x rich — the CLEANER read because you control both legs) are critical. Search for: MLM forward P/E and whether consensus is standalone or LNA pro-forma basis, EV/EBITDA and pro-forma EV/EBITDA, latest mix-adjusted organic aggregates pricing and organic shipment growth, aggregates cash gross profit per ton, organic COGS per ton ex-freight, energy cost commentary, adjusted EBITDA margin and any inventory step-up charges, infrastructure/heavy nonres/residential demand commentary, weather impact on the quarter, surface transportation reauthorization status and days to expiry, state DOT budget trend, LNA closing status and pro-forma net leverage and delever progress, NET share count change YoY, permitted reserve tons and reserve life, ROIC and WACC, VMC/CRH/EXP forward PE, EPS revisions 30d/90d, confirmed next earnings date. Most days = NEUTRAL (±6 — a TIGHTER band than the high-beta names; a quarry business rarely produces weekly information). Meaningful scores: drawdown setups, VMC twin dislocations, pricing and volume prints, authorization-status changes, LNA glidepath updates, earnings-window resets.\n` : "";

  const uberGuidance = isUBER ? `\nCRITICAL — UBER SCORING (V1): UBER is UBER TECHNOLOGIES, INC. (NYSE: UBER, CIK 1543151) — the mobility and delivery marketplace (Uber Eats, Postmates, Uber Freight are the same company). NOT the German word "über" or the "uber-" prefix; NOT Lyft (peer benchmark); NOT Waymo (an Alphabet subsidiary and AV-supply counterparty — its rides and fleet are not Uber's); NOT Delivery Hero (the pending acquisition target — pro-forma basis only). This slot previously held Petrobras: no oil, BRL or dividend logic belongs here. A DEMAND AGGREGATOR: ~208M monthly active platform consumers create trip density that supply plugs into; the moat is two-sided liquidity, strongest where supply is FRAGMENTED, and the single open question is whether autonomous-vehicle supply lists on Uber or goes direct. ★ ARCHITECTURAL RULE: operating momentum (bookings, trips, margin — quarterly) and AV supply structure (announcements — years) are SEPARATE signals; they meet only at the MOBILITY CANARY. Q2 2026 (reported Aug 5): gross bookings $58.02B +22% cc (Mobility +20% cc, Delivery +25% cc), trips +18%, MAPCs 208M, Adj EBITDA $2.82B at 4.9% of GB (vs 4.5%), segment OI Mobility +28% / Delivery +38%, FCF $2.79B; Q3 guide GB $58.25-60.25B (18-22% cc), Adj EBITDA $2.86-2.96B, below consensus when issued. Beta 1.26: RSI 35/70, daily noise ±2.5%, drawdown ladder to 50% (>18% setup, >30% strong) — price ~35% below the 52w high on Oct 26. FIVE CALIBRATION TRAPS, ALL LOAD-BEARING: (1) GAAP TRAILING P/E IS NOT A SIGNAL in either direction — TTM GAAP net income (~$9.58B) carries a $4.9B tax valuation-allowance release plus ±$1.5B quarterly equity revaluations; trailing ~14.4x below forward ~16.4x on ~30% EPS growth is impossible from operations. ★ CALENDAR TRAP: at the Nov 4 2026 print the tax release rolls out and trailing P/E roughly DOUBLES with no change in the business — not a re-rating, not a cyclical trough. (2) REPORTED REVENUE IS A NULL SIGNAL — business-model changes cut Q2 growth by 8pp (Mobility revenue +1% on bookings +22%); score cc bookings. ★ BASIS: GAAP EBITDA ~18.7x, Adj EBITDA (SBC excluded) ~13.9x, Adj less SBC ~17.3x on the same ~$140B EV — never mix; DASH's ~49x EV/EBITDA is GAAP. (3) OWNER FCF — TTM FCF ~$10.12B less ~$1.94B SBC = ~$8.18B, ~6.1% on ~$135B, NOT the ~7.5% headline; score NET share count (−2.28% YoY — criterion met), never gross buyback dollars (pace slowed to $518M in Q2 as capital went to the DH stake). (4) DELIVERY HERO IS PENDING — €41.50 cash, ~$14.8B equity ($13.7B net of prior stake), acceptance period to Nov 5 2026, merger-control clearances outstanding, settlement H2 2027, ~€14B bridge, gross leverage target <2x; score STANDALONE, no synergies credited, leverage vs the 2x ceiling not the level. (5) AV HEADLINES ARE CLASSIFIED — does the news change WHERE supply lists (structural) or only WHEN a fleet launches (timing)? Waymo going direct (Phoenix ended mid-2026; Austin/Atlanta own app Jan 2028, fleet on Uber through at least May 2028) is the BASE CASE — CONTESTED regime, scores ZERO. Only a SECOND tier-1 exit or Uber's exclusive pipeline (Rivian 10,000 R2s exclusive, SF/Miami 2028; Lucid/Nuro 35,000+) missing a milestone flips the regime. ⛔ VALUE-TRAP GATE: disintermediating regime + Mobility GB cc below 12% (or unknown) → the BLENDED strategic score is floored at 0 — no strategic buy. Composite weights regime-conditional on the AV SUPPLY regime, engine V8.5: aggregating 25/40/35 · contested 20/35/45 · disintermediating 15/30/55. EARNINGS WINDOW: Q3 prints WEDNESDAY NOV 4 2026 before the open — within ±10 days HALVE tactical conviction and say so; post-print, score the canary first. PRIMARY SIGNALS: Mobility GB cc growth (THE canary — >18% intact, 12-18% softening, <12% while Delivery holds = BROKEN, thesis-level), cc gross bookings, Adj EBITDA % of GB (>5.0% compounding, <4.3% reversal), owner FCF yield (>7% deep value / 5.5-7% value / 4-5.5% fair / <3.5% rich), non-GAAP forward P/E (<18x buy / 18-26x fair / >32x stretched), EV/Adj EBITDA tagged (<14x buy / >24x rich), AV supply state, marketplace rotation vs DASH/LYFT/GRAB (weighted .50/.25/.25, −6pp threshold; peer read is SECONDARY — no true twin; LYFT's ~2x trailing P/E is a tax artifact). Insiders: CEO bought ~$10M at ~$70.96 on Sep 10 2026 (first since May 2022), COO ~$5.3M — small positive, never decisive. No dividend — yield is a non-field. Search for: latest Mobility and Delivery gross bookings growth in constant currency, trips and MAPCs, Adj EBITDA as % of gross bookings, segment operating income, driver incentive commentary, Q4 guide vs consensus, TTM FCF and SBC, non-GAAP forward P/E and whether non-GAAP EPS deducts SBC, EV/Adj EBITDA, NET share count YoY, Delivery Hero acceptance level and regulatory status, gross leverage, Waymo/Tesla/Zoox own-app vs Uber listing news, Rivian and Lucid/Nuro milestone status, any AV headline behind a ≥4% Uber down day, DASH/LYFT/GRAB forward P/E, EPS revisions 30d/90d, confirmed earnings date. Most days = NEUTRAL (±8). Meaningful scores: drawdown setups, attributed AV-headline shocks, Mobility-canary prints, tier-1 supply decisions, Delivery Hero milestones, earnings-window resets.\n` : "";

  const cvxGuidance = isCVX ? `\nCRITICAL — CVX SCORING (V1): CVX is CHEVRON CORPORATION (NYSE: CVX, CIK 93410, Houston) — the integrated oil and gas major (Texaco and Caltex are Chevron brands; Hess Corporation is part of Chevron since July 18, 2025). NOT "Chevron deference" (the administrative-law doctrine from Chevron v. NRDC, overruled by Loper Bright in 2024 — an analysis about agency interpretation has the wrong subject); NOT ExxonMobil (XOM is the twin benchmark and Stabroek partner); NOT Hess Midstream (HESM, being exited); NOT Tengizchevroil (TCO, a 50% affiliate). "CPC" is ambiguous — the Caspian Pipeline Consortium (TCO's export route) is NOT Chevron Phillips Chemical (the chemicals JV); name which one every time. This slot previously held Enbridge: no toll-road, Canadian tariff or yield-spread-vs-10Y logic belongs here. A CAPITAL-RETURN FRANCHISE (capex + dividend breakeven < $50 Brent through 2030, $10-20B/yr buybacks at $60-80, 39-year dividend streak) bolted to a commodity that sets every reported number (~$0.60B per $1 Brent, ~$0.70B per $1 Henry Hub). ★ ARCHITECTURAL RULE: value CVX at ITS OWN $70 BRENT DECK, never at spot — execution (production vs guide, cost-out, capex, the buyback guide) and the commodity (realized prices, cracks, revisions, every spot multiple) are SEPARATE signals; they meet at the TCO CANARY. Brent ~$115.81 on Oct 26 is ~64% above the deck → DISLOCATED-HIGH. FIVE CALIBRATION GUARDRAILS, ALL LOAD-BEARING: (1) WINDFALL NORMALIZATION — normalized FCF = TTM adj FCF − (TTM Brent − 70) × 0.60 − (TTM Henry Hub − 3.50) × 0.70 − (TTM downstream − 3.0), in $B; a TTM below the deck adds back; missing HH or downstream = PARTIAL (a ceiling while cracks are elevated). As of the Q2 print, crude-only: ~$30.7B − ~$5.7B ≈ $25.0B ≈ 5.5% on ~$455B, price-implied Brent ~$74; the full normalization is LOWER. NEVER score GAAP trailing P/E (~22.3) or consensus forward P/E (~12.2) in either direction, and do NOT invert them (CVX is not in the cyclical set). ★ CALENDAR TRAP: at the Oct 30 2026 print Q3'25 ($1.82 GAAP on $69 Brent) rolls out and trailing P/E falls ~22x → ~17x with no change in the business; the HESM exit later books a one-time $3-4B loss. (2) TIMING + WORKING CAPITAL — single-quarter EPS and headline CFFO are null signals (Q1'26 CFFO $2.5B vs $7.1B ex-WC); DD&A $23-24B above capex $18-19B means earnings understate cash. (3) HESS ANNIVERSARY — YoY share count across Jul 18 2025 shows ~+14% mechanical dilution: use period-end counts on a clean base (2,013.5M at Sep 30 2025; 1,975.8M at Jun 30 2026); production vs the FY26 3,980-4,100 MBOED guide, never YoY. (4) BALANCE-SHEET OPTICS — the HESM exit removes ~$3.7B of debt with no cash generated; TCO loan repayments flatter adj FCF; read leverage ex-deconsolidation. (5) ⛔ CYCLE-POSITION GATE — Brent above $98: the BLENDED strategic score is floored at 0 unless normalized FCF yield ≥6% on a FULL normalization; below $42: capped at 0 unless yield <4%. Fails closed on a null or partial normalization. Composite weights regime-conditional on spot Brent vs the $70 deck, engine V8.6: anchored (≤20%) 25/40/35 · transitional (≤40%) 20/35/45 · dislocated 15/30/55. ★ GEOPOLITICAL HEADLINES ARE CLASSIFIED: does the news change the DURATION of the supply disruption (Hormuz, Gulf infrastructure, blockade terms) or hit a CHEVRON ASSET (Partitioned Zone, Leviathan, CPC/TCO, Venezuela)? In a dislocated-high regime a de-escalation sell-off is the windfall premium unwinding — not an oversold buy (Apr 1 2026: −4.6%, the worst day of a −21.5% unwind as Brent fell ~$118 → ~$72). EARNINGS WINDOW: Q3 prints FRIDAY OCT 30 2026 before the open (consensus EPS ~$4.86) — within ±10 days HALVE tactical conviction and say so; post-print, the Q4 buyback guide first (prior $2.5-3.0B/quarter; above $3.0B = the windfall reaching shareholders). PRIMARY SIGNALS: normalized FCF yield (>7% deep value / 6-7% value / 4.5-6% fair / <4% rich), price-implied Brent (<$65 buy / $65-80 fair / >$85 rich), the TCO/CPC canary (intact / degraded / broken = CPC suspended >2 weeks or TCO materially curtailed — THESIS-LEVEL; TCO ≈ $6B Chevron-share FCF at $70), production vs guide, capex vs the $18-19B guide and the $21B ceiling, the next-quarter buyback guide, XOM twin dislocation (CVX lagging XOM >4pp/30d with no Chevron-specific event — oil-neutral, live in every regime), breakeven vs $50, net share count on a clean base. RSI 35/70, daily noise ±2%, drawdown ladder to 35% (setup >12%) — in a dislocated-high regime drawdowns score ZERO. SHEL/TTE are a structural-discount reference only. EPS revisions are commodity-driven unless the regime is anchored. Dividend ($1.78/quarter, ~3.1%) judged on coverage by normalized FCF, never as a yield spread. Insiders: all sales in 90 days (CEO Wirth ~$63.6M Aug 14; director John B. Hess ~$137.9M Aug 3) — establish whether option-related; never decisive. Search for: Brent spot and its 5-day change, TTM average Brent and Henry Hub, TTM adjusted FCF, TTM CFFO ex-WC, TTM capex, TTM downstream earnings and the crack environment, last quarter's timing effects and working capital, production vs the FY26 guide, CPC export status and TCO output (any loadings suspensions in the last 30 days), Guyana fifth-FPSO timing, the next-quarter buyback guide, period-end share count, net debt and HESM deconsolidation state, XOM/SHEL/TTE forward P/E, XLE vs SPY 30d, any Iran/Hormuz/CPC/Partitioned Zone/Leviathan headline behind a ≥4% CVX session, EPS revisions 30d/90d, confirmed earnings date. Most days = NEUTRAL — scores beyond ±20 on a normal day mean something is miscalibrated. Meaningful scores: XOM twin dislocations, classified air pockets, TCO canary changes, buyback-guide changes, normalization prints, earnings-window resets.\n` : "";


  const calibrationBlock = buildCalibrationBlock(h.symbol, CALIBRATION, md.price?.current);
  const temporalLine = buildTemporalLine(h.symbol, TEMPORAL_Z); // v8.2.0: own-history context (empty when ineligible)

  // v8.0: static (cacheable) blocks in system; dynamic data in the user message.
  const perTickerSystem = `HOLDING: ${h.symbol} (${h.name} — ${h.sector}) | Archetype: ${h.archetype}
Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
${cyclicalWarning}${asmlGuidance}${amkbyGuidance}${kofGuidance}${glncyGuidance}${linGuidance}${msftGuidance}${lhxGuidance}${tmoGuidance}${nowGuidance}${maGuidance}${isrgGuidance}${mlmGuidance}${uberGuidance}${cvxGuidance}`;

  const user = `VERIFIED DATA (from APIs — do NOT override these):
${(() => {
  return [
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.valuation?.trailingPE ? `P/E: ${md.valuation.trailingPE}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
  ].filter(Boolean).join("\n") || "No verified data available.";
})()}
${calibrationBlock}${temporalLine}
Research this holding now. Apply the HOSTILE REVIEW PROTOCOL to each layer, then call record_scores exactly once.`;

  return {
    system: [
      { type: "text", text: SHARED_SYSTEM_SEARCH, cache_control: { type: "ephemeral" } },
      { type: "text", text: perTickerSystem, cache_control: { type: "ephemeral" } },
    ],
    user,
  };
}

// ─── FETCH LLM SCORE ────────────────────────────────────────────────────────
async function fetchLLMScore(holding, promptParts, useWebSearch) {
  const MAX_RETRIES = 5;
  const mode = useWebSearch ? "WEB SEARCH" : "qualitative";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      // v8.0: static system blocks carry cache_control (ephemeral, 5-min TTL).
      // Shared block is identical across holdings within a track → cache hits from
      // the 2nd holding onward; per-ticker block additionally caches across retries.
      const body = {
        model: MODEL_ID,
        max_tokens: useWebSearch ? 16000 : 4096,
        system: promptParts.system,
        messages: [{ role: "user", content: promptParts.user }],
        tools: useWebSearch
          ? [{ type: "web_search_20250305", name: "web_search" }, RECORD_SCORES_TOOL]
          : [RECORD_SCORES_TOOL],
      };
      // Qualitative mode: force the schema-validated tool call (deterministic structure).
      // Search mode: tool_choice stays auto on this first turn — forcing it would block
      // web_search. If the model ends without record_scores, a forced follow-up turn
      // below (v8.1.0) guarantees a structured result.
      if (!useWebSearch) body.tool_choice = { type: "tool", name: "record_scores" };

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });

      if (resp.status === 429) {
        const waitSec = useWebSearch ? 60 : 30;
        console.log(`    ⚠ rate limited. Waiting ${waitSec}s...`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitSec * 1000)); continue; }
        throw new Error("Rate limited");
      }
      if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 150)}`);

      const result = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (result.stop_reason === "max_tokens") { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("Truncated"); }

      // v8.0: prefer the schema-validated record_scores tool call.
      // v8.2.0: track the conversation and the accepted tool_use id so the
      // verification gate below can run corrective turns against the model's
      // own output (a tool_use in an echoed assistant turn must be answered
      // with a tool_result, so the id is required for a valid follow-up).
      let parsed = null;
      let verifyConvo = null;      // messages array up to and including the assistant turn that produced `parsed`
      let verifyToolUseId = null;  // id of the accepted record_scores block (null on the prose-scrape path)
      const toolBlocks = (result.content || []).filter(b => b.type === "tool_use" && b.name === "record_scores");
      if (toolBlocks.length > 0) {
        parsed = toolBlocks[toolBlocks.length - 1].input;
        verifyToolUseId = toolBlocks[toolBlocks.length - 1].id;
        verifyConvo = [
          { role: "user", content: promptParts.user },
          { role: "assistant", content: result.content },
        ];
      } else if (useWebSearch) {
        // v8.1.0: Track B durable fix. The search turn ended without record_scores
        // (tool_choice is auto in search mode so web_search isn't blocked). Instead of
        // scraping JSON out of prose, echo the assistant's research back and FORCE
        // record_scores in a follow-up turn so a web-search holding can never finish
        // unscored → null → silent drop from the composite rankings. Legacy prose-scrape
        // is kept only as a last resort, so this path can never do worse than before.
        console.log("    ↻ search turn ended without record_scores — forcing structured call...");
        // v8.2.0: hoisted so the verification gate can extend this exact history.
        const forcedMessages = [
          { role: "user", content: promptParts.user },
          { role: "assistant", content: result.content },
          { role: "user", content: "You completed your research but did not call record_scores. Call record_scores exactly once now, using ONLY the research and verified data above. Do not search again." },
        ];
        const forceResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL_ID,
            max_tokens: 4096,
            system: promptParts.system,
            messages: forcedMessages,
            // web_search stays declared so the echoed web_search_tool_result blocks
            // validate; tool_choice forces the structured call so the turn cannot end
            // in prose again.
            tools: [{ type: "web_search_20250305", name: "web_search" }, RECORD_SCORES_TOOL],
            tool_choice: { type: "tool", name: "record_scores" },
          }),
        });
        if (forceResp.status === 429) { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 60000)); continue; } throw new Error("Rate limited (force)"); }
        if (!forceResp.ok) throw new Error(`API ${forceResp.status} (force): ${(await forceResp.text()).slice(0, 150)}`);
        const forceResult = await forceResp.json();
        const forceTool = (forceResult.content || []).filter(b => b.type === "tool_use" && b.name === "record_scores");
        if (forceTool.length > 0) {
          parsed = forceTool[forceTool.length - 1].input;
          verifyToolUseId = forceTool[forceTool.length - 1].id;
          verifyConvo = [...forcedMessages, { role: "assistant", content: forceResult.content }];
        } else {
          // last resort: scrape JSON from the original search prose (legacy behavior).
          const text = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
          const sanitized = text.replace(/:\s*\+(\d)/g, ': $1');
          const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
          if (!jsonMatch) { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("No JSON after forced turn"); }
          const cleaned = jsonMatch[0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
          parsed = JSON.parse(cleaned);
          // Prose-scrape: no tool_use to answer — corrective turns (if any) use a
          // plain-text user message against the original assistant turn.
          verifyToolUseId = null;
          verifyConvo = [
            { role: "user", content: promptParts.user },
            { role: "assistant", content: result.content },
          ];
        }
      } else {
        // Qualitative mode already forces record_scores upstream; a miss here means a
        // malformed response. Retry, then fail loudly (never a silent null).
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("No record_scores (qualitative)");
      }

      const valid = ["tactical","positional","strategic"].every(l => typeof parsed[l]?.score === "number");
      if (!valid) { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("Invalid structure"); }

      // ── v8.2.0: VERIFICATION GATE (generate → verify → corrective retry) ──
      // Semantic checks the schema can't express: identity, content minimums,
      // bounds on the schema-bypassing prose-scrape path. Violations go back to
      // the model as a tool_result on its own record_scores call, with
      // record_scores forced again. Hard caps: VERIFY_MAX_TURNS per holding,
      // VERIFY_RUN_BUDGET per run — both non-negotiable cost controls.
      const verification = { passed: true, violations: [], corrective_turns: 0 };
      let violations = verifyParsed(holding.symbol, parsed);
      while (violations.length > 0 && verification.corrective_turns < VERIFY_MAX_TURNS) {
        if (verifyCorrectionsUsed >= VERIFY_RUN_BUDGET) {
          console.log(`    ⚠ verify: run budget exhausted (${VERIFY_RUN_BUDGET}) — accepting with ${violations.length} violation(s).`);
          break;
        }
        verification.corrective_turns++;
        verifyCorrectionsUsed++;
        console.log(`    ↻ verify: ${violations.length} violation(s) — corrective turn ${verification.corrective_turns}/${VERIFY_MAX_TURNS} (run ${verifyCorrectionsUsed}/${VERIFY_RUN_BUDGET})`);
        for (const v of violations) console.log(`        • ${v.slice(0, 140)}`);

        const correctionText = `Your record_scores call failed the verification gate. Violations:\n${violations.map(v => `- ${v}`).join("\n")}\nCall record_scores exactly once now with a fully corrected payload. Fix ONLY what the violations require; keep every field that was not flagged identical. Do not search again.`;
        const correctiveUser = verifyToolUseId
          ? { role: "user", content: [
              { type: "tool_result", tool_use_id: verifyToolUseId, content: "Rejected by verification gate — corrections required (see next message content)." },
              { type: "text", text: correctionText },
            ] }
          : { role: "user", content: correctionText };
        const correctiveMessages = [...verifyConvo, correctiveUser];

        const vResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL_ID,
            max_tokens: 4096,
            system: promptParts.system, // cached blocks — corrective input cost is ~all cache reads
            messages: correctiveMessages,
            // web_search stays declared in search mode so echoed web_search_tool_result
            // blocks validate (same constraint as the v8.1.0 forced turn).
            tools: useWebSearch
              ? [{ type: "web_search_20250305", name: "web_search" }, RECORD_SCORES_TOOL]
              : [RECORD_SCORES_TOOL],
            tool_choice: { type: "tool", name: "record_scores" },
          }),
        });
        if (vResp.status === 429) { console.log("    ⚠ verify: rate limited — accepting current payload."); break; }
        if (!vResp.ok) { console.log(`    ⚠ verify: API ${vResp.status} on corrective turn — accepting current payload.`); break; }
        const vResult = await vResp.json();
        const vTool = (vResult.content || []).filter(b => b.type === "tool_use" && b.name === "record_scores");
        if (vTool.length === 0) { console.log("    ⚠ verify: corrective turn returned no record_scores — accepting current payload."); break; }

        const corrected = vTool[vTool.length - 1].input;
        // Corrected payload must still be structurally sound before it replaces the original.
        const correctedValid = ["tactical","positional","strategic"].every(l => typeof corrected[l]?.score === "number");
        if (!correctedValid) { console.log("    ⚠ verify: corrected payload structurally invalid — keeping previous payload."); break; }
        parsed = corrected;
        verifyToolUseId = vTool[vTool.length - 1].id;
        verifyConvo = [...correctiveMessages, { role: "assistant", content: vResult.content }];
        violations = verifyParsed(holding.symbol, parsed);
      }
      verification.violations = violations;
      verification.passed = violations.length === 0;
      if (!verification.passed) {
        const identity = violations.filter(v => v.startsWith("[IDENTITY]"));
        if (identity.length > 0) {
          // A wrong-company analysis must never ship. Throwing routes this into
          // scoreHolding's catch → data_quality.failures → the v8.1.1 banners.
          throw new Error(`Verification failed (identity): ${identity[0].slice(0, 120)}`);
        }
        console.log(`    ⚠ verify: shipping with ${violations.length} residual non-identity violation(s).`);
      }

      const tokIn = result.usage?.input_tokens || "?";
      const tokOut = result.usage?.output_tokens || "?";
      const cacheRead = result.usage?.cache_read_input_tokens || 0;
      const cacheWrite = result.usage?.cache_creation_input_tokens || 0;
      return { parsed, elapsed, tokIn, tokOut, cacheRead, cacheWrite, mode, verification };
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      console.log(`    ⚠ ${e.message.slice(0, 80)}. Retry ${attempt+1}...`);
      await new Promise(r => setTimeout(r, (useWebSearch ? 2000 : 1500) * attempt));
    }
  }
}

// ─── SCORE ONE HOLDING ──────────────────────────────────────────────────────
async function scoreHolding(holding, useWebSearch) {
  const md = MARKET_DATA[holding.symbol] || {};
  const macro = MARKET_DATA._macro || {};

  const dataForEngine = { ...md, _weights: holding.weights, _archetype: holding.archetype };
  const detScores = computeDeterministicScores(dataForEngine, macro);

  console.log(`  [DET] tac=${detScores.tactical.score} pos=${detScores.positional.score} str=${detScores.strategic.score} comp=${detScores.composite.score}`);

  const promptParts = useWebSearch ? buildSearchPrompt(holding) : buildPrompt(holding, detScores);
  console.log(`  [LLM] scoring [${useWebSearch ? "web search" : "qualitative"}]...`);

  try {
    const { parsed: llm, elapsed, tokIn, tokOut, cacheRead, cacheWrite, verification } = await fetchLLMScore(holding, promptParts, useWebSearch);
    console.log(`  [LLM] tac=${llm.tactical?.score} pos=${llm.positional?.score} str=${llm.strategic?.score} comp=${llm.composite?.score} (${elapsed}s, ${tokIn}+${tokOut} tok, cache r${cacheRead}/w${cacheWrite})`);

    // V3: pass archetype so blendScores activates per-archetype overrides (LIN gets 65/60/40 vs default 70/50/30).
    // V7.4-V7.6: MSFT/LHX/TMO/NOW use defaults (no per-archetype override) — strategic 30/70 lean-LLM matches qualitative density.
    // Use detScores.weights so LIN's regime-conditional composite weights win over upstream holding.weights.
    const blended = blendScores(detScores, llm, detScores.weights || holding.weights, holding.archetype);

    // v8.0: divergence telemetry — per-layer |det − llm| gap; >40 flagged for calibration analysis.
    const DIVERGENCE_FLAG_THRESHOLD = 40;
    const divergence = { tactical: 0, positional: 0, strategic: 0, flagged: [] };
    for (const tf of ["tactical", "positional", "strategic"]) {
      const gap = Math.abs((detScores[tf]?.score ?? 0) - (llm[tf]?.score ?? 0));
      divergence[tf] = gap;
      if (gap > DIVERGENCE_FLAG_THRESHOLD) divergence.flagged.push(tf);
    }

    // v8.0: hostile-review fields hoisted for downstream telemetry (logger wiring is a separate task).
    const hr = (tf) => ({ bear_case: llm[tf]?.bear_case || "", bull_case: llm[tf]?.bull_case || "", falsifier: llm[tf]?.falsifier || "" });

    const price = {};
    if (md.price?.current) price.current = md.price.current;
    if (md.price?.change_pct != null) price.change_pct = md.price.change_pct;
    if (md.price?.week52_high) price.week52_high = md.price.week52_high;
    if (md.price?.week52_low) price.week52_low = md.price.week52_low;
    if (md.price?.week52_position_pct != null) price.week52_position_pct = md.price.week52_position_pct;

    const confidence = computeConfidence(MARKET_DATA, holding.symbol);

    const result = {
      symbol: holding.symbol,
      price: { ...price, ...(llm.price || {}) },
      ...blended,
      // V3: hoist regime context to top level for clean downstream consumption
      // (log-signals, paper-trader, dashboard all look here first; null for non-LIN)
      regime: detScores.regime,
      regime_pmi: detScores.regimePmi,
      regime_driver: detScores.regimeDriver ?? null,   // v8.0.1: numeric regime driver (engine V8.1)
      regime_basis: detScores.regimeBasis ?? null,     // v8.0.1: "pmi" | "real_rate" | "ita_vs_spy_30d_pp" | "xbi_90d_return_pct"
      weights: detScores.weights,
      confidence,
      divergence,
      // v8.2.0: verification gate outcome (logger persists to JSONL for telemetry).
      verification: verification || { passed: true, violations: [], corrective_turns: 0 },
      // v8.2.0: temporal z per layer vs this name's own trailing baseline
      // (calibration-v2.mjs nightly); nulls when ineligible or file absent.
      tz: computeTz(holding.symbol, TEMPORAL_Z, blended),
      hostile_review: { tactical: hr("tactical"), positional: hr("positional"), strategic: hr("strategic") },
      key_metric: llm.key_metric || { name: "", value: "" },
      risks: llm.risks || [],
      catalysts: llm.catalysts || [],
      _scoring: { deterministic: detScores.composite.score, llm: llm.composite?.score ?? 0, blend: "50/50" },
    };

    if (md.price?.current) result.price.current = md.price.current;
    if (md.price?.change_pct != null) result.price.change_pct = md.price.change_pct;

    if (divergence.flagged.length > 0) {
      console.log(`  ⚠ DIVERGENCE >${DIVERGENCE_FLAG_THRESHOLD}: ${divergence.flagged.map(tf => `${tf} (det ${detScores[tf].score} vs llm ${llm[tf]?.score})`).join(", ")}`);
    }

    const regimeStr = detScores.regime ? ` [regime: ${detScores.regime}]` : "";
    console.log(`  ✓ ${holding.symbol}: DET=${detScores.composite.score} + LLM=${llm.composite?.score ?? 0} → BLENDED=${blended.composite.score} [confidence: ${confidence.level}]${regimeStr}`);
    return result;
  } catch (e) {
    console.error(`  ✗ ${holding.symbol}: ${e.message}`);
    scoreFailures[holding.symbol] = e.message;   // v8.1.2: capture reason for data_quality.failures
    return null;
  }
}

// ─── NORMALIZATION ───────────────────────────────────────────────────────────
function normalize(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length < 3) return { normalized: valid, assignments: null };
  const layers = ["tactical", "positional", "strategic", "composite"];
  const stats = {};
  for (const layer of layers) {
    const scores = valid.map(s => (layer === "composite" ? s.composite : s[layer])?.score ?? 0);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    stats[layer] = { mean, stddev: Math.sqrt(variance) || 1, scores };
  }
  const normalized = valid.map(s => {
    const z = {};
    for (const layer of layers) {
      const raw = (layer === "composite" ? s.composite : s[layer])?.score ?? 0;
      z[layer] = (raw - stats[layer].mean) / stats[layer].stddev;
    }
    return { ...s, z };
  });
  const used = new Set();
  const assignments = { tacticalBuy: null, positionalBuy: null, strategicBuy: null, trim: null };
  for (const s of [...normalized].sort((a, b) => b.z.composite - a.z.composite)) { if (!used.has(s.symbol)) { assignments.trim = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.tactical - b.z.tactical)) { if (!used.has(s.symbol)) { assignments.tacticalBuy = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.positional - b.z.positional)) { if (!used.has(s.symbol)) { assignments.positionalBuy = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.strategic - b.z.strategic)) { if (!used.has(s.symbol)) { assignments.strategicBuy = s.symbol; used.add(s.symbol); break; } }
  return { normalized, assignments };
}

// ─── EMAIL HTML ──────────────────────────────────────────────────────────────
function buildEmailHTML(normalized, assignments, dataQuality = null) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const find = sym => normalized.find(s => s.symbol === sym);
  const scoreClr = v => v<=-60?"#00ff88":v<=-25?"#4ecdc4":v<=24?"#8899aa":v<=59?"#f4a261":"#ff6b6b";
  const chgClr = v => (v||0)>=0?"#4ecdc4":"#ff6b6b";
  const chgFmt = v => `${(v||0)>=0?"+":""}${(v||0).toFixed(2)}%`;

  const signalRow = (label, icon, color, sym) => {
    const s = find(sym); if (!s) return "";
    const h = HOLDINGS.find(h => h.symbol === sym);
    const det = s._scoring?.deterministic ?? "?";
    const llm = s._scoring?.llm ?? "?";
    return `<tr style="border-bottom:1px solid #1a2332;"><td style="padding:14px 16px;font-size:13px;color:${color};font-weight:700;white-space:nowrap;">${icon} ${label}</td><td style="padding:14px 16px;font-size:18px;font-weight:800;color:#e0e8f0;">${sym}</td><td style="padding:14px 16px;font-size:12px;color:#889aaa;">${h?.name||""}</td><td style="padding:14px 16px;font-size:14px;font-weight:600;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</td><td style="padding:14px 16px;font-size:12px;color:${chgClr(s.price?.change_pct)};">${chgFmt(s.price?.change_pct)}</td><td style="padding:14px 16px;font-size:11px;color:#667788;max-width:320px;">${s.composite?.summary||"—"}<br><span style="color:#445566;font-size:9px;">DET:${det} LLM:${llm}</span></td></tr>`;
  };

  const confBadge = (level) => {
    const colors = { high: "#4ecdc4", medium: "#f4a261", low: "#ff6b6b" };
    const color = colors[level] || "#556677";
    return `<span style="font-size:8px;letter-spacing:0.06em;color:${color};border:1px solid ${color}40;padding:1px 4px;margin-left:4px;">${(level||"?").toUpperCase()}</span>`;
  };

  const rankingRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map((s,i) => {
    const role = s.symbol===assignments.tacticalBuy?"⚡ TAC BUY":s.symbol===assignments.positionalBuy?"📐 POS BUY":s.symbol===assignments.strategicBuy?"🏗️ STR BUY":s.symbol===assignments.trim?"✂️ TRIM":"━ HOLD";
    const roleColor = s.symbol===assignments.trim?"#ff6b6b":role.includes("BUY")?"#4ecdc4":"#556677";
    const h=HOLDINGS.find(h=>h.symbol===s.symbol); const km=s.key_metric;
    const cs=s.composite?.score??0; const ts=s.tactical?.score??0; const ps=s.positional?.score??0; const ss=s.strategic?.score??0;
    const det = s._scoring?.deterministic ?? ""; const llm = s._scoring?.llm ?? "";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:10px 10px;color:#445566;font-size:11px;text-align:center;">${i+1}</td><td style="padding:10px 8px;"><div style="font-weight:800;font-size:14px;color:#e0e8f0;">${s.symbol}${confBadge(s.confidence?.level)}</div><div style="font-size:10px;color:#556677;">${h?.name||""}</div></td><td style="padding:10px 8px;text-align:right;"><div style="font-size:14px;font-weight:700;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</div><div style="font-size:10px;color:${chgClr(s.price?.change_pct)};">${chgFmt(s.price?.change_pct)}</div></td><td style="padding:10px 8px;text-align:center;"><div style="font-size:16px;font-weight:800;color:${scoreClr(cs)};">${cs}</div><div style="font-size:9px;color:#334455;">D:${det} L:${llm}</div></td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ts)};">${ts}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ps)};">${ps}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ss)};">${ss}</td><td style="padding:10px 8px;"><div style="font-size:10px;color:${roleColor};font-weight:700;">${role}</div></td><td style="padding:10px 8px;font-size:10px;color:#889aaa;">${km?.name?`${km.name}: ${km.value}`:"—"}</td></tr>`;
  }).join("");

  const rationaleRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map(s => {
    const icon = s.symbol===assignments.tacticalBuy?"⚡":s.symbol===assignments.positionalBuy?"📐":s.symbol===assignments.strategicBuy?"🏗️":s.symbol===assignments.trim?"✂️":"";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:12px 14px;vertical-align:top;width:80px;"><div style="font-weight:800;font-size:13px;color:#e0e8f0;">${icon} ${s.symbol}</div></td><td style="padding:12px 14px;"><div style="font-size:11px;color:#889aaa;line-height:1.6;margin-bottom:4px;">${s.composite?.summary||"—"}</div><div style="font-size:10px;color:#556677;">Tactical: ${s.tactical?.rationale||"—"}</div></td></tr>`;
  }).join("");

  let accuracySection = "";
  if (CALIBRATION.available && CALIBRATION.totalDays >= 3) {
    const rel = CALIBRATION.reliability || {};
    const gradeColor = (g) => ({ STRONG:"#00ff88", MODERATE:"#f4a261", WEAK:"#ff6b6b", POOR:"#ff3355" }[g] || "#556677");
    const relRow = (layer, d) => {
      if (!d) return "";
      return `<tr><td style="padding:4px 8px;color:#7a8a9a;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">${layer}</td><td style="padding:4px 8px;color:${gradeColor(d.grade)};font-size:11px;font-weight:600;">${d.grade}</td><td style="padding:4px 8px;color:#c8d0e5;font-size:11px;">${d.hit_rate!=null?d.hit_rate+"%":"—"}</td><td style="padding:4px 8px;color:${(d.avg_return||0)>=0?"#4ecdc4":"#ff6b6b"};font-size:11px;">${d.avg_return!=null?(d.avg_return>=0?"+":"")+d.avg_return+"%":"—"}</td><td style="padding:4px 8px;color:#445566;font-size:10px;">${d.total_signals||0}</td></tr>`;
    };

    let streakWarning = "";
    if (CALIBRATION.streaks) {
      const long = Object.entries(CALIBRATION.streaks).filter(([_,s]) => s.streak_days >= 5).map(([sym,s]) => `${sym}: ${s.current_role} ${s.streak_days}d`);
      if (long.length > 0) streakWarning = `<div style="margin-top:10px;padding:6px 10px;background:#1a1000;border:1px solid #3a2a00;font-size:10px;color:#c8a050;">⚠️ Extended streaks: ${long.join(" · ")}</div>`;
    }

    accuracySection = `<div style="margin-bottom:28px;padding:16px 20px;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;"><div style="font-size:11px;letter-spacing:0.1em;color:#667788;margin-bottom:10px;">SIGNAL ACCURACY — ${CALIBRATION.totalDays} TRADING DAYS</div><table style="width:100%;border-collapse:collapse;"><tr style="border-bottom:1px solid #1a2332;"><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">LAYER</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">GRADE</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">HIT RATE</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">AVG RET</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">N</th></tr>${relRow("tactical",rel.tactical)}${relRow("positional",rel.positional)}${relRow("strategic",rel.strategic)}${relRow("composite",rel.composite)}</table>${streakWarning}</div>`;
  } else if (CALIBRATION.totalDays > 0) {
    accuracySection = `<div style="margin-bottom:28px;padding:12px 16px;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;font-size:11px;color:#556677;">Signal accuracy tracking: ${CALIBRATION.totalDays} day(s) logged. Grades appear after 3+ days.</div>`;
  }

  // v8.1.3: loud partial-run banner — lists each dropped holding with its failure reason
  // (data_quality.failures). Falls back to bare symbols when failures is absent (legacy).
  const escHtml = t => String(t).replace(/[&<>]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[c]));
  const dqBanner = (dataQuality && !dataQuality.complete)
    ? `<div style="margin-bottom:28px;padding:14px 18px;background:#1a0808;border:1px solid #5a1a1a;border-radius:8px;"><div style="font-size:13px;font-weight:800;color:#ff6b6b;letter-spacing:0.04em;">⚠️ INCOMPLETE RUN — ${dataQuality.scored}/${dataQuality.expected} HOLDINGS SCORED</div><div style="font-size:11px;color:#cc8888;margin-top:6px;line-height:1.7;">The tables below are partial — these holdings failed scoring and were dropped:</div>${(dataQuality.missing||[]).map(sym => `<div style="font-size:11px;color:#cc8888;line-height:1.7;"><span style="font-weight:700;color:#ff8888;">${escHtml(sym)}</span>${dataQuality.failures && dataQuality.failures[sym] ? ` — ${escHtml(dataQuality.failures[sym])}` : ""}</div>`).join("")}</div>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#05080e;font-family:'SF Mono','Fira Code','Consolas',monospace;">
<div style="max-width:800px;margin:0 auto;padding:32px 24px;">
<div style="border-bottom:2px solid #1a2332;padding-bottom:20px;margin-bottom:28px;"><h1 style="margin:0;font-size:20px;color:#e0e8f0;">PORTFOLIO STRATEGY SIGNAL</h1><p style="margin:6px 0 0;font-size:12px;color:#556677;">${date} • ${HOLDINGS.length} Holdings • Hybrid Scoring (50% Quant + 50% LLM) • Z-Score Normalized</p></div>
${dqBanner}
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">SIGNAL</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">TICKER</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">NAME</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">PRICE</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">CHG</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">THESIS</th></tr></thead>
<tbody>${signalRow("TACTICAL BUY","⚡","#00ff88",assignments.tacticalBuy)}${signalRow("POSITIONAL BUY","📐","#4ecdc4",assignments.positionalBuy)}${signalRow("STRATEGIC BUY","🏗️","#5b8dee",assignments.strategicBuy)}${signalRow("TRIM","✂️","#ff6b6b",assignments.trim)}</tbody></table>
${accuracySection}
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 4px;">COMPOSITE RANKINGS</h2><p style="font-size:10px;color:#334455;margin:0 0 12px;">D = deterministic score, L = LLM score, Blended 50/50</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:10px 10px;text-align:center;font-size:9px;color:#445566;">#</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">HOLDING</th><th style="padding:10px 8px;text-align:right;font-size:9px;color:#445566;">PRICE</th><th style="padding:10px 8px;text-align:center;font-size:9px;color:#445566;">COMP</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">TAC</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">POS</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">STR</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">ROLE</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">KEY METRIC</th></tr></thead><tbody>${rankingRows}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 12px;">RATIONALE</h2></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><tbody>${rationaleRows}</tbody></table>
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #141e2e;font-size:10px;color:#334455;line-height:1.6;"><p>Hybrid scoring: 50% deterministic (RSI, 52w, MAs, valuation) + 50% LLM qualitative judgment. Z-score normalized across portfolio.</p><p>Portfolio Strategy Hub v8.3 — ${HOLDINGS.length} holdings. MA added (payments_network_quality_compounder: twin valuation vs V, duopoly fear-regime weight gate, cross-border volume as THE positional metric, disruption narrative-vs-evidence matrix). ISRG added (surgical_robotics_moat_compounder: cohort premium vs MDT/SYK/BSX with 60-120% structural baseline, IHI factor weight gate, procedure growth as THE positional metric, moat + 2027 instrument-transition monitors). All prior archetypes retained.</p></div>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v8.3.0");
  console.log("========================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}`);
  console.log(`Scoring: 50% deterministic + 50% LLM (archetype-aware, ${MODEL_ID})\n`);

  const meta = MARKET_DATA._meta || {};
  const needsSearch = new Set(meta.needsWebSearch || []);
  const dataHoldings = HOLDINGS.filter(h => !needsSearch.has(h.symbol));
  const searchHoldings = HOLDINGS.filter(h => needsSearch.has(h.symbol));
  console.log(`Pre-fetched: ${dataHoldings.length} | Web search: ${searchHoldings.length}`);
  if (searchHoldings.length > 0) console.log(`  → ${searchHoldings.map(h=>h.symbol).join(", ")}`);
  console.log("");

  const allSignals = [];

  if (dataHoldings.length > 0) {
    console.log(`── TRACK A: ${dataHoldings.length} holdings (hybrid scoring) ──`);
    for (let i = 0; i < dataHoldings.length; i++) {
      console.log(`[${i+1}/${dataHoldings.length}] ${dataHoldings[i].symbol}`);
      allSignals.push(await scoreHolding(dataHoldings[i], false));
      if (i < dataHoldings.length - 1) await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (searchHoldings.length > 0) {
    console.log(`\n── TRACK B: ${searchHoldings.length} holdings (web search) ──`);
    for (let i = 0; i < searchHoldings.length; i++) {
      console.log(`[${i+1}/${searchHoldings.length}] ${searchHoldings[i].symbol}`);
      allSignals.push(await scoreHolding(searchHoldings[i], true));
      if (i < searchHoldings.length - 1) {
        console.log("  (60s cooldown)");
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  const validCount = allSignals.filter(Boolean).length;
  console.log(`\n✓ Scored ${validCount}/${HOLDINGS.length}`);
  if (validCount < 4) { console.error("Too few signals."); process.exit(1); }

  // v8.1.1: completeness audit. A run short of the full book keeps its good signals
  // but records exactly which holdings were dropped, so a partial run can never look
  // healthy on the dashboard, in the email, or in signal-data.json.
  const scoredSymbols = new Set(allSignals.filter(Boolean).map(s => s.symbol));
  const missing = HOLDINGS.filter(h => !scoredSymbols.has(h.symbol)).map(h => h.symbol);
  // v8.1.2: pair each dropped symbol with its captured failure reason so the drop is
  // self-diagnosing downstream (signal-data.json → dashboard, daily-log).
  const failures = {};
  for (const sym of missing) failures[sym] = scoreFailures[sym] || "unknown (no error captured)";
  const dataQuality = { expected: HOLDINGS.length, scored: scoredSymbols.size, missing, failures, complete: missing.length === 0 };
  if (!dataQuality.complete) {
    console.error(`\n⚠️  INCOMPLETE RUN: ${dataQuality.scored}/${dataQuality.expected} holdings scored. MISSING: ${missing.join(", ")}`);
    for (const sym of missing) console.error(`     • ${sym}: ${failures[sym]}`);
    console.error("   These holdings failed scoring and are absent from the rankings.");
  } else {
    console.log(`✓ Complete book: all ${dataQuality.expected} holdings scored.`);
  }

  const { normalized, assignments } = normalize(allSignals);

  console.log("\n─── DAILY SIGNAL ───────────────────────");
  console.log(`  TACTICAL BUY:   ${assignments.tacticalBuy}`);
  console.log(`  POSITIONAL BUY: ${assignments.positionalBuy}`);
  console.log(`  STRATEGIC BUY:  ${assignments.strategicBuy}`);
  console.log(`  TRIM:           ${assignments.trim}`);
  console.log("────────────────────────────────────────\n");

  writeFileSync("/tmp/signal-email.html", buildEmailHTML(normalized, assignments, dataQuality));
  writeFileSync("/tmp/signal-data.json", JSON.stringify({ normalized, assignments, data_quality: dataQuality, timestamp: new Date().toISOString() }, null, 2));
  console.log("✓ Email + data written");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
