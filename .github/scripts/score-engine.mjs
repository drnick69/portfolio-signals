// score-engine.mjs — Deterministic scoring rules for quantitative inputs.
// Produces repeatable scores from the same data every time.
// The LLM handles qualitative interpretation; this handles the math.
//
// Architecture:
//   deterministic_score (this file) blends with llm_score (from Claude)
//   at per-timeframe weights — see BLEND_WEIGHTS / BLEND_WEIGHTS_BY_ARCHETYPE in blendScores().
//
// Each layer (tactical/positional/strategic) gets a deterministic sub-score
// that the LLM score is blended with at the layer level.
//
// Holding-specific scoring paths:
//   - CYCLICAL archetypes (GLNCY, AMKBY, PBR.A): inverted P/E (high PE = trough = buy)
//   - MOMENTUM_STORE_OF_VALUE (IBIT): softened RSI + wider daily bands,
//     inverted 52w + 200DMA-extension positional, phase-modified strategic
//   - SECULAR_GROWTH_MONOPOLY (ASML): dampened high-RSI, inverted 52w,
//     above_both_golden = 0, dampened trailing P/E, P/B and yield ignored
//   - DIVIDEND_COMPOUNDER (ENB): heavily dampened RSI (yield stock barely moves),
//     inverted 52w, yield-spread-vs-10Y as primary positional signal,
//     enhanced real yield + rate regime strategic scoring, P/B skipped
//   - CYCLICAL_TRADE_BELLWETHER (AMKBY): shipping-specific PE thresholds (more
//     extreme cycles), enhanced P/B (asset-heavy fleet), dampened MA golden cross,
//     dampened 52w at highs, GSCPI + HY OAS as strategic overlays
//   - HIGH_BETA_CRYPTO (ETHA): wider RSI/daily bands than IBIT (1.3-1.5x vol),
//     inverted 52w + 200DMA extension (no phase amplification), ETHA/IBIT alt-season
//     ratio as positional signal, all valuation skipped, enhanced macro sensitivity
//     [NOTE: archetype retained for backward compatibility — ETHA sold v4.13/v7.6]
//   - EM_DIVIDEND_GROWTH (KOF): dampened RSI (consumer staples barely move),
//     mildly inverted 52w, MXN/USD as FX regime signal, narrowed PE bands,
//     enhanced dividend yield scoring
//   - DIVERSIFIED_COMMODITY_TRADER (GLNCY): slightly dampened RSI, dampened MA/52w,
//     COPX ratio as copper regime, GSCPI + HY OAS as commodity demand proxies,
//     PE with higher floor (trading arm), enhanced P/B
//   - EM_STATE_OIL_DIVIDEND (PBR.A): slightly dampened RSI (volatile but oil-anchored),
//     WTI as primary commodity signal, BRL/USD as FX regime, enhanced dividend yield
//     bands (8-15%+ range), PE inverted (oil producer), P/B for reserves value
//   - OLIGOPOLY_QUALITY_COMPOUNDER (LIN) — V3: tightened RSI 35/70, compounder MA +
//     inverted 52w, peer P/E premium vs APD/AI.PA primary + 6M delta, narrowed yield
//     band, ROCE + op-margin durability, ASU utilization, price/mix ex-FX, BBB OAS,
//     EPS revisions, geo-weighted PMI composite, triangulated peer-relative, IV/RV,
//     QUAL factor flow, growth-scare, H2 layer concretized. Regime-conditional
//     composite weights gated by global PMI (>55 expansion / 48-55 neutral / <48 contraction).
//   - AI_INFRA_QUALITY_COMPOUNDER (MSFT) — V1: tightened RSI 40/65, compounder MA +
//     inverted 52w, drawdown-from-52w-high primary tactical (>12% setup, >20% strong),
//     cohort rotation vs GOOGL/META/AAPL avg 30d (BUY setup when MSFT lags), QUAL
//     factor flow, cohort P/E premium primary strategic, TIPS + DXY overlays.
//     V8.1: composite weights regime-conditional on real rate (fed funds − 10Y
//     TIPS): <0.5% accommodative 25/40/35 · 0.5–2% neutral 20/35/45 · >2%
//     restrictive 15/30/55.
//   - DEFENSE_PRIME_BACKLOG_COMPOUNDER (LHX) — V1: tightened RSI 40/70, compounder
//     MA + inverted 52w, drawdown-from-52w-high primary tactical (>10% setup, >18%
//     strong), cohort rotation vs LMT/NOC/RTX/GD avg 30d (BUY setup when LHX lags
//     larger primes), ITA vs SPY 30d factor flow (defense sector bid), cohort P/E
//     premium primary strategic (LHX historically -5 to -15% discount, compression
//     thesis), book-to-bill + backlog YoY + op/FCF margin + EPS revs positional
//     (null-safe — LLM sources via web search), dividend yield (aristocrat-track),
//     TIPS + VIX overlays. V8.1: composite weights regime-conditional on ITA vs
//     SPY 30d factor flow: >+1pp bid_active 25/45/30 · ±1pp neutral 20/40/40 ·
//     <−1pp bid_absent 15/35/50.
//   - LIFE_SCIENCES_QUALITY_COMPOUNDER (TMO) — V1: tightened RSI 35/70, compounder
//     MA + inverted 52w, drawdown-from-52w-high primary tactical (>15% setup, >25%
//     strong), biotech sympathy setup (TMO+XBI both down = collateral buy), DHR
//     peer relative (daily + 30d), peer P/E vs DHR primary strategic (mirrors LIN's
//     peer_valuation), XBI 90d biotech overlay positional (funding leads bookings
//     2-3Q), QUAL factor flow (reused from LIN), organic growth + bioprocessing
//     phase + op/FCF margin + EPS revs positional (null-safe — LLM sources),
//     TIPS + DXY + VIX overlays. V8.1: composite weights regime-conditional on
//     XBI 90d return: >+10% thawing 25/40/35 · ±10% neutral 20/35/45 · <−10%
//     frozen 15/30/55.
//   - AI_WORKFLOW_QUALITY_COMPOUNDER (NOW) — V1: tightened RSI 40/65, compounder MA +
//     inverted 52w, drawdown-from-52w-high primary tactical (>12% setup, >20% strong),
//     cohort rotation vs CRM/WDAY/ADBE avg 30d (BUY setup when NOW lags higher-beta
//     AI/SaaS), IGV vs SPY 30d factor flow (software sector bid), cohort P/E premium
//     primary strategic with NOW-SPECIFIC BANDS — NOW carries 80-120% premium to
//     cohort as BASELINE (higher growth + higher quality, structural), so <60% =
//     unusual discount = buy, >150% = stretched. cRPO growth (THE ops metric) +
//     subscription growth + $1M+ deals + federal contract growth + op/FCF margin
//     positional (null-safe — LLM sources). TIPS + DXY + VIX overlays.
//     V8.1: composite weights regime-conditional on real rate — see below.
//   - PAYMENTS_NETWORK_QUALITY_COMPOUNDER (MA) — V1: tightened RSI 40/65, compounder
//     MA-trend + inverted 52w, drawdown-from-52w-high primary tactical (>12% setup,
//     >20% strong), twin dislocation vs V 30d (duopoly twins rarely diverge — MA
//     lagging V by >4pp without an MA-specific break = buy setup), duopoly (MA+V avg)
//     vs SPY 30d fear-regime read (narrative-driven duopoly weakness = buy setup),
//     QUAL factor flow, twin P/E premium vs V primary strategic with MA-SPECIFIC
//     BANDS — MA carries 10-20% premium to V as BASELINE (faster grower, larger VAS
//     mix), so <5% = compressed = buy, >25% = rich. Cross-border volume growth (THE
//     ops metric) + GDV + switched txns + VAS + rebates discipline + buyback pace +
//     stablecoin/disruption/regulation categoricals positional/strategic (null-safe —
//     LLM sources). Interchange regulation "passed" and disruption evidence
//     "material" are deterministic thesis-break penalties. TIPS + DXY + VIX overlays
//     (DXY weighted heavier — ~2/3 international revenue). V8.2: composite weights
//     regime-conditional on duopoly vs SPY 30d — see below.
//   - SURGICAL_ROBOTICS_MOAT_COMPOUNDER (ISRG) — V1: RSI bands 38/68 (beta ~1.7 —
//     slightly wider than the low-vol compounders), compounder MA-trend + inverted
//     52w, drawdown-from-52w-high primary tactical (>15% setup, >25% strong, ladder
//     extended to >35%), cohort fear-rotation vs MDT/SYK/BSX avg 30d (BUY setup when
//     ISRG lags on competition/instrument headlines without procedure evidence), IHI
//     vs SPY 30d factor flow (devices sector bid), cohort P/E premium primary
//     strategic with ISRG-SPECIFIC BANDS — ISRG carries 60-120% premium to cohort as
//     BASELINE (category king, ~86% recurring annuity), so <60% = unusual discount =
//     buy, >150% = stretched; absolute PE is NEVER the signal. Procedure growth (THE
//     ops metric, guide 13.5-15.5%) + dV placements/dV5 mix + Ion + recurring % +
//     I&A + installed base + op margin positional (null-safe — LLM sources).
//     moat_status "eroding"/"breached" and instrument_transition_status
//     "quantified_material" are deterministic thesis-break penalties;
//     "quantified_manageable" is a relief-catalyst buy. TIPS + VIX + DXY overlays.
//     V8.2: composite weights regime-conditional on IHI vs SPY 30d — see below.
//
// V8.1 (June 2026): regime-conditional composite weights extended from LIN to the
// V1 compounders, mirroring the LIN V3 three-state pattern (±5pp shifts off each
// archetype's static base; missing driver data → static base + "neutral" + null):
//   - MSFT + NOW gated on real rate (fed funds − 10Y TIPS): <0.5% accommodative
//     25/40/35 · 0.5–2% neutral 20/35/45 · >2% restrictive 15/30/55.
//   - LHX gated on ITA vs SPY 30d factor flow: >+1pp bid_active 25/45/30 ·
//     ±1pp neutral 20/40/40 · <−1pp bid_absent 15/35/50.
//   - TMO gated on XBI 90d return: >+10% thawing 25/40/35 · ±10% neutral
//     20/35/45 · <−10% frozen 15/30/55.
//   Blend weights (det/llm per layer) deliberately untouched — held until accuracy
//   data justifies changes. New return fields regimeDriver (numeric) + regimeBasis
//   (string) are additive; regimePmi keeps its LIN-only meaning for contract
//   stability. Layer scoring logic unchanged.
//
// V8.2 (July 2026): HOLDINGS ADD — MA (payments_network_quality_compounder) and
// ISRG (surgical_robotics_moat_compounder). 12 → 14 scored holdings. Two new
// archetype branches per layer + two new V8.1-pattern regime gates (same
// three-state structure, same ±5pp shifts off each 20/35/45 base; missing
// driver data → static base + "neutral" + null driver):
//   - MA gated on duopoly (MA+V avg) vs SPY 30d relative strength: >+3pp
//     fear_receding 25/40/35 · −5..+3pp neutral 20/35/45 · <−5pp fear_regime
//     15/30/55 (fear regime = strategic/valuation anchor dominates — the
//     narrative-cycle drawdown IS the thesis).
//   - ISRG gated on IHI vs SPY 30d factor flow: >+1pp bid_active 25/40/35 ·
//     ±1pp neutral 20/35/45 · <−1pp bid_absent 15/30/55.
//   Neither added to CYCLICAL_ARCHETYPES (both compounders — standard/premium
//   PE logic; ISRG explicitly requires high-multiple tolerance, NOW-style).
//   Blend weights untouched (both archetypes use defaults). Existing layer
//   scoring logic unchanged — additions only.

//
// V8.3 (August 2026): HOLDINGS SWAP — sold IBIT (momentum_store_of_value),
// bought RDDT (hypergrowth_platform_monetizer). Still 14 scored holdings.
// One new archetype branch per layer + one new regime gate on the V8.1 pattern.
//   - HYPERGROWTH_PLATFORM_MONETIZER (RDDT) — V1: widest bands in the book
//     (beta 1.94) — RSI 32/72, daily-move noise floor ±4%, drawdown ladder
//     scaled to 60% (setup >25%, strong >40%) rather than the compounders' 40%.
//     Ads-cohort rotation vs META/PINS/APP at a −8pp threshold (NOT ISRG's −6pp:
//     6pp is inside this name's noise band). Positional runs on ad revenue
//     growth (THE ops metric), ARPU expansion, DAUq, EBITDA/FCF margin and SBC
//     trend. Strategic runs on ads-cohort P/E, search-referral status,
//     licensing state, NET share count and competitive threat.
//     Regime gate: XLC vs SPY 30d factor flow — >+1pp bid_active 30/35/35 ·
//     ±1pp neutral 25/35/40 · <−1pp bid_absent 20/30/50.
//   TWO CALIBRATION GUARDRAILS ARE LOAD-BEARING HERE — both would otherwise pin
//   strategic near −100 every single run:
//     (a) PEG ARTIFACT GATE. RDDT forward PEG sits near 0.09 because EPS is
//         inflecting off a near-zero base. Any forward_peg < 0.4 scores ZERO
//         and is annotated as an artifact. It is not a 10x margin of safety.
//     (b) PARTIAL-WINDOW DAMPING. RDDT listed March 2024, so own-history
//         multiple anchors span ~2.4 years across the crossing into GAAP
//         profitability. P/S-vs-own-history contributions are HALVED relative
//         to what the ISRG/NOW own-history pattern would assign, and any
//         absolute-PE fallback uses deliberately wide, humble bands.
//   Dilution is scored on NET share count change (positive = dilution), never
//   on buyback yield: RDDT repurchased $235M in Q2 2026 while share count still
//   rose ~2.8%. Not added to CYCLICAL_ARCHETYPES — high trailing P/E here does
//   NOT signal trough earnings (that inversion is for GLNCY/AMKBY/PBR.A only).
//   Blend weights untouched (archetype uses defaults). IBIT's
//   momentum_store_of_value branches are RETAINED as dead code for historical
//   re-scoring, exactly as high_beta_crypto (ETHA) was after v7.6.

// V8.4 (August 2026): HOLDINGS SWAP — sold RDDT (hypergrowth_platform_monetizer),
// bought MLM (reserve_moat_infrastructure_compounder). Still 14 scored holdings.
// One new archetype branch per layer + one new regime gate.
//   - RESERVE_MOAT_INFRASTRUCTURE_COMPOUNDER (MLM) — V1: LIN-class bands
//     (beta 1.11, NOT RDDT's 1.94) — RSI 38/70, daily-move noise floor ±2%,
//     drawdown ladder scaled to 35% (setup >15%, strong >25%). Aggregates-cohort
//     rotation vs VMC/CRH/EXP at a −5pp threshold (TIGHTER than RDDT's −8pp:
//     on a beta-1.11 name a 5pp/30d divergence is information, not noise) —
//     and this MUST stay aligned with fetch-market-data v4.17, which sets
//     peer_rotation_active on the same −5pp boundary.
//     The VMC twin spread is scored SEPARATELY from the cohort average, on the
//     MA/V duopoly-twin pattern: MLM and VMC are the two dominant US aggregates
//     franchises and rarely diverge for non-operating reasons.
//     Positional runs on MIX-ADJUSTED ORGANIC PRICING (THE moat metric),
//     organic volume, cash gross profit per ton, COGS/ton ex-freight, the
//     end-market split and a weather gate. Strategic runs on forward PE +
//     EV/EBITDA, the VMC twin premium, federal authorization status, the LNA
//     pro-forma glidepath and NET share count.
//     Regime gate: PUBLIC CONSTRUCTION FUNDING (federal surface-transportation
//     authorization status, with state DOT budget trend as secondary read) —
//     funded 25/40/35 · neutral 20/35/45 · unfunded 15/30/55. The weight triple
//     is deliberately COPIED FROM LIN rather than invented: MLM is the same
//     species of asset (capital-intensive quality industrial with oligopoly
//     pricing) and a triple with calibration history beats one without.
//     ⚠ CALIBRATION: "short_term_extension" maps to NEUTRAL, not contraction.
//     Twelve extensions followed TEA-21 and ten followed SAFETEA-LU — patches
//     are the historical rule, and mapping the single most likely outcome to a
//     contraction would print a false trim for months.
//   THREE CALIBRATION GUARDRAILS ARE LOAD-BEARING HERE:
//     (a) DIVESTITURE-GAIN PE GATE. MLM's trailing P/E sits near 12.9x against
//         a ~26.8x forward because the TTM window carries a large non-operating
//         gain from the Quikrete asset exchange (TTM profit margin 36.7%
//         EXCEEDS gross margin 28.2% — impossible from operations). Trailing
//         P/E is scored ZERO whenever trailing < 0.6 × forward, and the
//         cohort-premium branch additionally honours premium_pct_reliable from
//         fetch v4.17. Without both, strategic pins near −100 on an accounting
//         artifact. This is the structural INVERSE of RDDT's PEG gate — same
//         architectural slot, opposite mechanism.
//     (b) ACQUISITION-ACCOUNTING DAMPING. Reported aggregates ASP is
//         mix-contaminated during integration (Q2'26: −2% reported vs +3.7%
//         organic mix-adjusted) and is NEVER scored — the engine keys on
//         mix_adjusted_organic_pricing_pct only. Leverage is scored against the
//         stated 3.7x→sub-2.5x/24-month GLIDEPATH, never the level. ROIC is
//         flagged denominator-distorted rather than scored as a quality break.
//     (c) WEATHER GATE. Aggregates is the most weather-contaminated quarterly
//         print in the book. A negative organic-volume reading accompanied by
//         weather_impact_flag = "material_headwind" has its penalty REMOVED,
//         not merely reduced. Rain is not demand destruction.
//   Dilution is scored on NET share count change with the sign convention
//   INVERTED relative to RDDT: negative = buyback. MLM is down ~1.1% YoY and
//   genuinely satisfies the portfolio's buyback criterion — but $6.5B of LNA
//   stock consideration against a ~$31.6B market cap is material issuance, so
//   pro_forma_share_count_change_pct is scored alongside it.
//   Dividend yield is NOT scored at all (0.64% — this is not ENB/LIN/KOF).
//   NOT added to CYCLICAL_ARCHETYPES — aggregates have no exchange price and no
//   commodity cycle to trough against; the GLNCY/AMKBY/PBR.A P/E inversion does
//   NOT apply. Blend weights untouched (archetype uses defaults).
//   RDDT's hypergrowth_platform_monetizer branches are RETAINED as dead code
//   for historical re-scoring, exactly as momentum_store_of_value (IBIT) was
//   after V8.3 and high_beta_crypto (ETHA) after v7.6.

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
// MOS removed in v7.5 (cyclical_commodity no longer used).
const CYCLICAL_ARCHETYPES = new Set([
  "diversified_commodity_trader",
  "cyclical_trade_bellwether",
  "em_state_oil_dividend",
]);

// ─── HALVING CYCLE PHASE DETECTION (IBIT) ───────────────────────────────────
function getHalvingPhase() {
  const halvingDate = new Date("2024-04-20");
  const now = new Date();
  const monthsSince = (now.getFullYear() - halvingDate.getFullYear()) * 12
                    + (now.getMonth() - halvingDate.getMonth());

  if (monthsSince < 12) return { phase: "early_expansion", months: monthsSince };
  if (monthsSince < 18) return { phase: "mid_expansion", months: monthsSince };
  if (monthsSince < 30) return { phase: "extended_expansion", months: monthsSince };
  return { phase: "post_expansion", months: monthsSince };
}

// ─── LIN REGIME-CONDITIONAL WEIGHTS (V3) ────────────────────────────────────
// Composite weights gated by global PMI composite (geo-weighted 40/30/30).
function computeLINRegimeWeights(macro) {
  const us = macro?.us_ism;
  const eu = macro?.eu_pmi;
  const cn = macro?.china_pmi;
  const pmis = [[us, 0.40], [eu, 0.30], [cn, 0.30]].filter(([v]) => v != null);
  if (pmis.length === 0) {
    return { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", pmi: null };
  }
  const totalW = pmis.reduce((a, [, w]) => a + w, 0);
  const wAvg = pmis.reduce((a, [v, w]) => a + v * w, 0) / totalW;
  if (wAvg >= 55) return { weights: { t: 0.25, p: 0.40, s: 0.35 }, regime: "expansion",   pmi: wAvg };
  if (wAvg < 48)  return { weights: { t: 0.15, p: 0.30, s: 0.55 }, regime: "contraction", pmi: wAvg };
  return            { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral",     pmi: wAvg };
}

// ─── V8.1 REGIME-CONDITIONAL WEIGHTS — MSFT/NOW/LHX/TMO ─────────────────────
// Extends the LIN V3 pattern to the V1 compounders: same three-state structure,
// same ±5pp shift magnitude off each archetype's static base. Missing driver
// data → static base + "neutral" + null driver (matches LIN fallback behavior).
// Blend weights (det/llm per layer) deliberately untouched in V8.1.

// MSFT + NOW: real-rate regime (fed funds − 10Y TIPS). Long-duration cash-flow
// sensitivity per archetype guidance: >2% restrictive = rate-driven multiple
// compression (valuation anchor dominates → strategic up), <0.5% accommodative =
// multiple-expansion tailwind (momentum/cycle layers carry more signal).
function computeRealRateRegimeWeights(macro) {
  const ff = macro?.fed_funds;
  const tips = macro?.tips10y;
  if (ff == null || tips == null) {
    return { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", driver: null };
  }
  const rr = +(ff - tips).toFixed(2);
  if (rr < 0.5) return { weights: { t: 0.25, p: 0.40, s: 0.35 }, regime: "accommodative", driver: rr };
  if (rr > 2.0) return { weights: { t: 0.15, p: 0.30, s: 0.55 }, regime: "restrictive",   driver: rr };
  return            { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral",       driver: rr };
}

// LHX: defense factor-flow regime (ITA vs SPY 30d, pp). >+1pp = defense bid
// active (flow/momentum layers carry signal), <−1pp = bid absent (sector out of
// favor — discount-compression thesis dominates → strategic anchor). Base 20/40/40.
function computeLHXRegimeWeights(data) {
  const i = data?.factor_flow?.ita_vs_spy_30d_pp;
  if (i == null) {
    return { weights: { t: 0.20, p: 0.40, s: 0.40 }, regime: "neutral", driver: null };
  }
  if (i > 1)  return { weights: { t: 0.25, p: 0.45, s: 0.30 }, regime: "bid_active", driver: i };
  if (i < -1) return { weights: { t: 0.15, p: 0.35, s: 0.50 }, regime: "bid_absent", driver: i };
  return          { weights: { t: 0.20, p: 0.40, s: 0.40 }, regime: "neutral",     driver: i };
}

// TMO: biotech funding regime (XBI 90d return — leads TMO bookings 2-3Q per
// archetype guidance). >+10% thawing = recovery underway (cycle layers carry
// signal), <−10% frozen = cycle-trough valuation thesis dominates. Base 20/35/45.
function computeTMORegimeWeights(data) {
  const x = data?.biotech_overlay?.xbi_90d_return_pct;
  if (x == null) {
    return { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", driver: null };
  }
  if (x > 10)  return { weights: { t: 0.25, p: 0.40, s: 0.35 }, regime: "thawing", driver: x };
  if (x < -10) return { weights: { t: 0.15, p: 0.30, s: 0.55 }, regime: "frozen",  driver: x };
  return           { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", driver: x };
}

// V8.2 — MA: duopoly fear-regime gate (MA+V avg 30d vs SPY, pp). <−5pp = the
// networks are being sold on disruption headlines (stablecoin/interchange) —
// valuation anchor dominates because the narrative-cycle drawdown IS the thesis
// (strategic up). >+3pp = fear receding / re-rating underway (flow/cycle layers
// carry more signal). Base 20/35/45.
function computeMARegimeWeights(data) {
  const d = data?.duopoly_relative?.duopoly_vs_spy_pp;
  if (d == null) {
    return { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", driver: null };
  }
  if (d > 3)  return { weights: { t: 0.25, p: 0.40, s: 0.35 }, regime: "fear_receding", driver: d };
  if (d < -5) return { weights: { t: 0.15, p: 0.30, s: 0.55 }, regime: "fear_regime",   driver: d };
  return          { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral",       driver: d };
}

// V8.2 — ISRG: devices factor-flow gate (IHI vs SPY 30d, pp — mirrors the LHX
// ITA gate). >+1pp = devices bid active (flow/momentum layers carry signal),
// <−1pp = sector out of favor — own-history multiple-compression thesis
// dominates (strategic anchor). Base 20/35/45.
function computeISRGRegimeWeights(data) {
  const i = data?.factor_flow?.ihi_vs_spy_30d_pp;
  if (i == null) {
    return { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral", driver: null };
  }
  if (i > 1)  return { weights: { t: 0.25, p: 0.40, s: 0.35 }, regime: "bid_active", driver: i };
  if (i < -1) return { weights: { t: 0.15, p: 0.30, s: 0.55 }, regime: "bid_absent", driver: i };
  return          { weights: { t: 0.20, p: 0.35, s: 0.45 }, regime: "neutral",     driver: i };
}

// ─── RDDT REGIME-CONDITIONAL WEIGHTS (V8.3) ─────────────────────────────────
// Gated on XLC vs SPY 30d (ads sector factor bid). Same three-state V8.1
// structure as LHX/ISRG, but off a 25/35/40 base rather than 20/35/45.
// Base rationale: tactical carries MORE than the compounders because beta 1.94
// makes dislocation genuinely tradeable; strategic carries LESS than ISRG/NOW
// because RDDT's own-history valuation anchors are a partial window (listed
// March 2024) and cannot bear a 45% weight honestly.
function computeRDDTRegimeWeights(data) {
  const x = data?.factor_flow?.xlc_vs_spy_30d_pp;
  if (x == null) {
    return { weights: { t: 0.25, p: 0.35, s: 0.40 }, regime: "neutral", driver: null };
  }
  if (x > 1)  return { weights: { t: 0.30, p: 0.35, s: 0.35 }, regime: "bid_active", driver: x };
  if (x < -1) return { weights: { t: 0.20, p: 0.30, s: 0.50 }, regime: "bid_absent", driver: x };
  return          { weights: { t: 0.25, p: 0.35, s: 0.40 }, regime: "neutral",     driver: x };
}

// ─── MLM REGIME-CONDITIONAL WEIGHTS (V8.4) ──────────────────────────────────
// Gated on the PUBLIC CONSTRUCTION FUNDING regime rather than a factor-flow
// spread — the first categorical-driven gate in this file. Roughly a third of
// MLM's aggregates demand traces to public infrastructure, so federal
// surface-transportation authorization is the dominant swing factor on tonnage.
// Weight triple is LIN's, deliberately (see V8.4 header note).
//
// ⚠ "short_term_extension" is the NEUTRAL state, not a contraction. Twelve
// extensions followed TEA-21's expiration and ten followed SAFETEA-LU's;
// patches are the rule. The base case is not a downgrade.
//
// State DOT budget trend acts only as a TIE-BREAKER on an indeterminate federal
// read. It cannot override an explicit federal signal in either direction — a
// multiyear bill below IIJA levels is not rescued by strong state budgets.
const MLM_AUTHORIZATION_REGIME = {
  multiyear_enacted_at_or_above_iija: "funded",
  multiyear_enacted_below_iija:       "unfunded",
  short_term_extension:               "neutral",
  pending_no_action:                  "neutral",
  lapsed:                             "unfunded",
};

const MLM_REGIME_TRIPLES = {
  funded:   { t: 0.25, p: 0.40, s: 0.35 },
  neutral:  { t: 0.20, p: 0.35, s: 0.45 },
  unfunded: { t: 0.15, p: 0.30, s: 0.55 },
};

// Post-close damping: LNA serves steel, environmental and agricultural end
// markets, so roughly a quarter of pro-forma EBITDA sits OUTSIDE the highway
// funding channel — and lime is structurally more defensive than aggregates
// (management's Woodville plant saw volumes fall ~7% through the financial
// crisis against a ~37% collapse in US aggregates). Once the deal closes the
// funding regime governs less of the business, so its weight swing is pulled
// 25% back toward neutral.
const MLM_REGIME_DAMPING = 0.75;

function computeMLMRegimeWeights(data) {
  // fetch-market-data v4.17 writes these under fundamentals; the LLM payload
  // carries them under strategic. Accept either so the engine works on both
  // the market-data path and a re-score from a logged signal row.
  const f = data?.fundamentals || {};
  const st = data?.strategic || {};
  const auth = f.federal_authorization_status ?? st.federal_authorization_status ?? null;
  const dot = f.state_dot_budget_trend ?? st.state_dot_budget_trend ?? null;
  const state = f.ma_integration_state ?? st.ma_integration_state ?? null;
  const driver = f.days_to_authorization_expiry ?? st.days_to_authorization_expiry ?? null;

  let key = MLM_AUTHORIZATION_REGIME[auth] ?? null;
  if (key === "neutral" || key == null) {
    if (dot === "accelerating") key = "funded";
    else if (dot === "contracting") key = "unfunded";
    else key = "neutral";
  }

  let w = MLM_REGIME_TRIPLES[key] ?? MLM_REGIME_TRIPLES.neutral;

  // Damping applies only once the transaction has actually closed. "terminated"
  // deliberately does NOT damp — a dead deal means the standalone
  // infrastructure exposure is fully intact.
  if (state === "closed" || state === "complete") {
    const n = MLM_REGIME_TRIPLES.neutral;
    const blend = (v, base) => base + (v - base) * MLM_REGIME_DAMPING;
    const t = blend(w.t, n.t), p = blend(w.p, n.p), s = blend(w.s, n.s);
    const tot = t + p + s;
    w = { t: t / tot, p: p / tot, s: s / tot };
    return { weights: w, regime: key + "_damped", driver };
  }

  return { weights: w, regime: key, driver };
}

// ─── DRAWDOWN-FROM-HIGH HELPER (MSFT/LHX/TMO/NOW compounder primary signal) ──
// Compounder drawdowns are buys, not warnings.
function computeDrawdownFromHigh(data) {
  const cur = data?.price?.current;
  const hi = data?.price?.week52_high;
  if (cur == null || hi == null || hi <= 0) return null;
  return +(((cur - hi) / hi) * 100).toFixed(2);
}

// ─── TACTICAL LAYER (short-term mean reversion) ─────────────────────────────
export function scoreTactical(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isLIN = archetype === "oligopoly_quality_compounder";
  const isMSFT = archetype === "ai_infra_quality_compounder";
  const isLHX = archetype === "defense_prime_backlog_compounder";
  const isTMO = archetype === "life_sciences_quality_compounder";
  const isNOW = archetype === "ai_workflow_quality_compounder";            // ← V7.6
  const isMA = archetype === "payments_network_quality_compounder";        // ← V8.2
  const isISRG = archetype === "surgical_robotics_moat_compounder";        // ← V8.2
  const isRDDT = archetype === "hypergrowth_platform_monetizer";           // ← V8.3 (RETAINED — dead code, historical re-scoring)
  const isMLM = archetype === "reserve_moat_infrastructure_compounder";     // ← V8.4
  const rsi = data.technicals?.rsi14;
  const vix = macro?.vix;

  // ─── IBIT-SPECIFIC: SOFTENED RSI + WIDER BANDS ───────────────────────────
  if (isIBIT) {
    if (rsi != null) {
      if (rsi < 20)      { score += -60; notes.push(`RSI ${rsi}: BTC severely oversold — high-conviction buy`); }
      else if (rsi < 25) { score += -45; notes.push(`RSI ${rsi}: BTC deeply oversold`); }
      else if (rsi < 30) { score += -35; notes.push(`RSI ${rsi}: BTC oversold`); }
      else if (rsi < 35) { score += -18; notes.push(`RSI ${rsi}: BTC mildly oversold`); }
      else if (rsi < 45) { score += -5;  notes.push(`RSI ${rsi}: BTC slightly soft`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: BTC neutral/trending`); }
      else if (rsi < 70) { score += 5;   notes.push(`RSI ${rsi}: BTC trending up — momentum healthy`); }
      else if (rsi < 75) { score += 10;  notes.push(`RSI ${rsi}: BTC strong momentum — not yet overbought`); }
      else if (rsi < 80) { score += 18;  notes.push(`RSI ${rsi}: BTC overbought — watch for exhaustion`); }
      else if (rsi < 85) { score += 30;  notes.push(`RSI ${rsi}: BTC extended — trim bias`); }
      else               { score += 45;  notes.push(`RSI ${rsi}: BTC extreme — parabolic exhaustion risk`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -8)       { score += -18; notes.push(`BTC daily ${chg}%: capitulation-style decline`); }
      else if (chg < -5)  { score += -10; notes.push(`BTC daily ${chg}%: sharp decline`); }
      else if (chg < -3)  { score += -5;  notes.push(`BTC daily ${chg}%: notable decline`); }
      else if (chg > 8)   { score += 15;  notes.push(`BTC daily +${chg}%: parabolic spike`); }
      else if (chg > 5)   { score += 8;   notes.push(`BTC daily +${chg}%: sharp rally`); }
      else if (chg > 3)   { score += 3;   notes.push(`BTC daily +${chg}%: notable rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── ASML-SPECIFIC: COMPOUNDER RSI + BIG-DROP-AS-ALPHA ───────────────────
  if (isASML) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: ASML severe oversold — rare compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: ASML deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: ASML oversold`); }
      else if (rsi < 35) { score += -12; notes.push(`RSI ${rsi}: ASML mildly oversold`); }
      else if (rsi < 45) { score += -3;  notes.push(`RSI ${rsi}: ASML slight softness`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: ASML normal trending range`); }
      else if (rsi < 70) { score += 3;   notes.push(`RSI ${rsi}: ASML normal uptrend momentum`); }
      else if (rsi < 75) { score += 8;   notes.push(`RSI ${rsi}: ASML healthy momentum — not a trim signal`); }
      else if (rsi < 80) { score += 15;  notes.push(`RSI ${rsi}: ASML extended momentum`); }
      else if (rsi < 85) { score += 25;  notes.push(`RSI ${rsi}: ASML overbought — watch for pause`); }
      else               { score += 40;  notes.push(`RSI ${rsi}: ASML extreme — trim bias`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -7)      { score += -22; notes.push(`ASML daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -5) { score += -14; notes.push(`ASML daily ${chg}%: sharp drop — buy opportunity`); }
      else if (chg < -3) { score += -7;  notes.push(`ASML daily ${chg}%: notable drop`); }
      else if (chg > 5)  { score += 8;   notes.push(`ASML daily +${chg}%: sharp rally`); }
      else if (chg > 3)  { score += 3;   notes.push(`ASML daily +${chg}%: notable rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── ENB-SPECIFIC: YIELD STOCK — BARELY MOVES ────────────────────────────
  if (isENB) {
    if (rsi != null) {
      if (rsi < 20)      { score += -40; notes.push(`RSI ${rsi}: ENB severely oversold — very rare`); }
      else if (rsi < 25) { score += -25; notes.push(`RSI ${rsi}: ENB deeply oversold`); }
      else if (rsi < 30) { score += -12; notes.push(`RSI ${rsi}: ENB oversold`); }
      else if (rsi < 35) { score += -5;  notes.push(`RSI ${rsi}: ENB mildly soft`); }
      else if (rsi <= 70) { score += 0;  notes.push(`RSI ${rsi}: ENB normal range`); }
      else if (rsi < 75) { score += 3;   notes.push(`RSI ${rsi}: ENB mildly warm`); }
      else if (rsi < 80) { score += 8;   notes.push(`RSI ${rsi}: ENB warm — rate cut rally?`); }
      else               { score += 18;  notes.push(`RSI ${rsi}: ENB overbought — unusual`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -4)      { score += -20; notes.push(`ENB daily ${chg}%: sharp drop — rate overreaction buy?`); }
      else if (chg < -2) { score += -10; notes.push(`ENB daily ${chg}%: notable decline — unusual for ENB`); }
      else if (chg < -1.5){ score += -4; notes.push(`ENB daily ${chg}%: mild softness`); }
      else if (chg > 3)  { score += 8;   notes.push(`ENB daily +${chg}%: sharp rally — unusual`); }
      else if (chg > 2)  { score += 3;   notes.push(`ENB daily +${chg}%: notable rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── ETHA-SPECIFIC: WIDER BANDS THAN IBIT ────────────────────────────────
  if (isETHA) {
    if (rsi != null) {
      if (rsi < 15)      { score += -65; notes.push(`RSI ${rsi}: ETH severely oversold — capitulation`); }
      else if (rsi < 20) { score += -55; notes.push(`RSI ${rsi}: ETH deeply oversold`); }
      else if (rsi < 25) { score += -40; notes.push(`RSI ${rsi}: ETH oversold`); }
      else if (rsi < 30) { score += -25; notes.push(`RSI ${rsi}: ETH mildly oversold`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: ETH slightly soft`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: ETH neutral/trending`); }
      else if (rsi < 70) { score += 3;   notes.push(`RSI ${rsi}: ETH trending up — healthy`); }
      else if (rsi < 75) { score += 5;   notes.push(`RSI ${rsi}: ETH strong momentum`); }
      else if (rsi < 80) { score += 10;  notes.push(`RSI ${rsi}: ETH momentum — not yet overbought`); }
      else if (rsi < 85) { score += 22;  notes.push(`RSI ${rsi}: ETH overbought — trim bias`); }
      else if (rsi < 90) { score += 35;  notes.push(`RSI ${rsi}: ETH deeply overbought`); }
      else               { score += 50;  notes.push(`RSI ${rsi}: ETH extreme — parabolic exhaustion`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -12)      { score += -22; notes.push(`ETH daily ${chg}%: capitulation-style decline`); }
      else if (chg < -8)  { score += -14; notes.push(`ETH daily ${chg}%: sharp decline`); }
      else if (chg < -5)  { score += -8;  notes.push(`ETH daily ${chg}%: notable decline`); }
      else if (chg < -3)  { score += -3;  notes.push(`ETH daily ${chg}%: mild decline`); }
      else if (chg > 12)  { score += 18;  notes.push(`ETH daily +${chg}%: parabolic spike`); }
      else if (chg > 8)   { score += 10;  notes.push(`ETH daily +${chg}%: sharp rally`); }
      else if (chg > 5)   { score += 5;   notes.push(`ETH daily +${chg}%: notable rally`); }
      else if (chg > 3)   { score += 2;   notes.push(`ETH daily +${chg}%: mild rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── KOF: CONSUMER STAPLES — LOW VOL ─────────────────────────────────────
  if (isKOF) {
    if (rsi != null) {
      if (rsi < 20)      { score += -45; notes.push(`RSI ${rsi}: KOF severely oversold — very rare`); }
      else if (rsi < 25) { score += -30; notes.push(`RSI ${rsi}: KOF deeply oversold`); }
      else if (rsi < 30) { score += -18; notes.push(`RSI ${rsi}: KOF oversold`); }
      else if (rsi < 35) { score += -8;  notes.push(`RSI ${rsi}: KOF mildly soft`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: KOF normal range`); }
      else if (rsi < 70) { score += 5;   notes.push(`RSI ${rsi}: KOF mildly warm`); }
      else if (rsi < 75) { score += 12;  notes.push(`RSI ${rsi}: KOF overbought`); }
      else if (rsi < 80) { score += 22;  notes.push(`RSI ${rsi}: KOF extended`); }
      else               { score += 35;  notes.push(`RSI ${rsi}: KOF extreme — unusual for staples`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`KOF daily ${chg}%: sharp drop — rare for consumer staples`); }
      else if (chg < -3) { score += -8;  notes.push(`KOF daily ${chg}%: notable decline`); }
      else if (chg < -2) { score += -3;  notes.push(`KOF daily ${chg}%: mild softness`); }
      else if (chg > 5)  { score += 10;  notes.push(`KOF daily +${chg}%: sharp rally — unusual`); }
      else if (chg > 3)  { score += 5;   notes.push(`KOF daily +${chg}%: notable rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── GLNCY: DIVERSIFIED COMMODITY ────────────────────────────────────────
  if (isGLNCY) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: GLNCY severely oversold`); }
      else if (rsi < 25) { score += -40; notes.push(`RSI ${rsi}: GLNCY deeply oversold`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: GLNCY oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: GLNCY mildly oversold`); }
      else if (rsi < 40) { score += -5;  notes.push(`RSI ${rsi}: GLNCY approaching oversold`); }
      else if (rsi <= 62) { score += 0;  notes.push(`RSI ${rsi}: GLNCY neutral`); }
      else if (rsi < 68) { score += 8;   notes.push(`RSI ${rsi}: GLNCY mildly overbought`); }
      else if (rsi < 75) { score += 20;  notes.push(`RSI ${rsi}: GLNCY overbought`); }
      else if (rsi < 80) { score += 35;  notes.push(`RSI ${rsi}: GLNCY deeply overbought`); }
      else               { score += 50;  notes.push(`RSI ${rsi}: GLNCY extreme`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -6)      { score += -15; notes.push(`GLNCY daily ${chg}%: sharp decline`); }
      else if (chg < -3) { score += -8;  notes.push(`GLNCY daily ${chg}%: notable decline`); }
      else if (chg > 6)  { score += 12;  notes.push(`GLNCY daily +${chg}%: sharp rally`); }
      else if (chg > 3)  { score += 6;   notes.push(`GLNCY daily +${chg}%: notable rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── PBR.A: EM OIL ───────────────────────────────────────────────────────
  if (isPBRA) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: PBR.A severely oversold`); }
      else if (rsi < 25) { score += -40; notes.push(`RSI ${rsi}: PBR.A deeply oversold`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: PBR.A oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: PBR.A mildly oversold`); }
      else if (rsi < 40) { score += -5;  notes.push(`RSI ${rsi}: PBR.A approaching oversold`); }
      else if (rsi <= 62) { score += 0;  notes.push(`RSI ${rsi}: PBR.A neutral`); }
      else if (rsi < 68) { score += 8;   notes.push(`RSI ${rsi}: PBR.A mildly overbought`); }
      else if (rsi < 75) { score += 20;  notes.push(`RSI ${rsi}: PBR.A overbought`); }
      else if (rsi < 80) { score += 35;  notes.push(`RSI ${rsi}: PBR.A deeply overbought`); }
      else               { score += 50;  notes.push(`RSI ${rsi}: PBR.A extreme`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -8)      { score += -18; notes.push(`PBR.A daily ${chg}%: capitulation (political?)`); }
      else if (chg < -5) { score += -12; notes.push(`PBR.A daily ${chg}%: sharp decline`); }
      else if (chg < -3) { score += -6;  notes.push(`PBR.A daily ${chg}%: notable decline`); }
      else if (chg > 8)  { score += 15;  notes.push(`PBR.A daily +${chg}%: sharp rally`); }
      else if (chg > 5)  { score += 8;   notes.push(`PBR.A daily +${chg}%: notable rally`); }
      else if (chg > 3)  { score += 4;   notes.push(`PBR.A daily +${chg}%: mild rally`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── LIN-SPECIFIC (V3): QUALITY COMPOUNDER ──────────────────────────────
  if (isLIN) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: LIN severe oversold — rare quality compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: LIN deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: LIN oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: LIN mildly oversold (tightened band)`); }
      else if (rsi < 45) { score += -3;  notes.push(`RSI ${rsi}: LIN slight softness`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: LIN normal trending range`); }
      else if (rsi < 70) { score += 5;   notes.push(`RSI ${rsi}: LIN healthy momentum`); }
      else if (rsi < 75) { score += 15;  notes.push(`RSI ${rsi}: LIN overbought (tightened — low vol)`); }
      else if (rsi < 80) { score += 25;  notes.push(`RSI ${rsi}: LIN deeply overbought`); }
      else if (rsi < 85) { score += 35;  notes.push(`RSI ${rsi}: LIN extreme — trim bias`); }
      else               { score += 50;  notes.push(`RSI ${rsi}: LIN parabolic — very rare`); }
    }
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`LIN daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`LIN daily ${chg}%: sharp drop — buy opportunity`); }
      else if (chg < -2) { score += -3;  notes.push(`LIN daily ${chg}%: notable for low-vol compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`LIN daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`LIN daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`LIN daily +${chg}%: notable for low-vol`); }
    }

    if (data.peer_relative_aipa) {
      const sp = data.peer_relative_aipa.relative_spread_pp;
      if (sp != null) {
        if (sp < -3)      { score += -3; notes.push(`AI.PA outperforming LIN by ${(-sp).toFixed(2)}pp (1m) — triangulation supports buy`); }
        else if (sp < -1) { score += -1; }
        else if (sp > 3)  { score += 2;  notes.push(`LIN outperforming AI.PA by ${sp}pp — quality premium`); }
      }
    }

    if (data.tactical_extras?.iv_rv_ratio != null) {
      const r = data.tactical_extras.iv_rv_ratio;
      if (r < 0.85)      { score += -4; notes.push(`IV/RV ${r.toFixed(2)}: deeply compressed — catalyst hunt setup`); }
      else if (r < 0.90) { score += -2; notes.push(`IV/RV ${r.toFixed(2)}: compressed`); }
      else if (r > 1.20) { score += 2;  notes.push(`IV/RV ${r.toFixed(2)}: elevated — vol-crush risk`); }
    }

    if (data.factor_flow?.qual_vs_spy_30d_pp != null) {
      const q = data.factor_flow.qual_vs_spy_30d_pp;
      if (q > 2)       { score += -3; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): strong quality bid — LIN benefits`); }
      else if (q > 1)  { score += -1; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): quality bid active`); }
      else if (q < -2) { score += 3;  notes.push(`QUAL ${q.toFixed(1)}pp vs SPY (30d): quality factor under pressure`); }
      else if (q < -1) { score += 1;  }
    }

    let growthScareApplied = false;
    if (data.tactical_extras?.spy_10d_drawdown_pct != null && data.tactical_extras?.lin_vs_spy_10d_pp != null) {
      const dd = data.tactical_extras.spy_10d_drawdown_pct;
      const linOver = data.tactical_extras.lin_vs_spy_10d_pp;
      if (dd < -5 && linOver > 1) {
        score += -8;
        notes.push(`Growth-scare confirmed: SPY ${dd.toFixed(1)}% / 10d + LIN +${linOver.toFixed(1)}pp — defensive bid active`);
        growthScareApplied = true;
      } else if (dd < -3 && linOver > 0.5) {
        score += -3;
        notes.push(`Mild growth-scare setup: SPY ${dd.toFixed(1)}% / 10d, LIN +${linOver.toFixed(1)}pp`);
        growthScareApplied = true;
      }
    }
    if (!growthScareApplied && vix != null && chg != null && vix > 25 && chg < -2) {
      score += -5;
      notes.push(`Growth-scare proxy: VIX ${vix} + LIN ${chg}% — defensive quality bid will return`);
    }

    return { score: clamp(score), notes };
  }

  // ─── MSFT-SPECIFIC (V1): AI INFRA QUALITY COMPOUNDER ─────────────────────
  if (isMSFT) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: MSFT severe oversold — rare quality compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: MSFT deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: MSFT oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: MSFT mildly oversold (tightened band)`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: MSFT approaching oversold`); }
      else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: MSFT normal trending range`); }
      else if (rsi < 65) { score += 3;   notes.push(`RSI ${rsi}: MSFT healthy momentum`); }
      else if (rsi < 70) { score += 12;  notes.push(`RSI ${rsi}: MSFT overbought (tightened — quality compounder)`); }
      else if (rsi < 75) { score += 22;  notes.push(`RSI ${rsi}: MSFT extended`); }
      else if (rsi < 80) { score += 32;  notes.push(`RSI ${rsi}: MSFT deeply overbought`); }
      else               { score += 45;  notes.push(`RSI ${rsi}: MSFT extreme — trim bias`); }
    }

    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 25)       { score += -25; notes.push(`MSFT drawdown ${dd.toFixed(1)}%: extreme — rare compounder buy`); }
      else if (ddMag > 20)  { score += -18; notes.push(`MSFT drawdown ${dd.toFixed(1)}%: deep — high-conviction buy setup`); }
      else if (ddMag > 15)  { score += -12; notes.push(`MSFT drawdown ${dd.toFixed(1)}%: meaningful — compounder buy interest`); }
      else if (ddMag > 12)  { score += -8;  notes.push(`MSFT drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 8)   { score += -3;  notes.push(`MSFT drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 3;   notes.push(`MSFT at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`MSFT daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`MSFT daily ${chg}%: sharp drop`); }
      else if (chg < -2) { score += -3;  notes.push(`MSFT daily ${chg}%: notable for low-vol compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`MSFT daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`MSFT daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`MSFT daily +${chg}%: notable for low-vol`); }
    }

    if (data.cohort_relative) {
      const rp = data.cohort_relative.rotation_pressure_pp;
      const active = data.cohort_relative.rotation_pressure_active;
      if (rp != null) {
        if (active && rp < -10)     { score += -12; notes.push(`Rotation pressure ACTIVE: MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d — strong buy setup (capital chasing higher-beta AI)`); }
        else if (active && rp < -7) { score += -8;  notes.push(`Rotation pressure ACTIVE: MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
        else if (active)            { score += -5;  notes.push(`Rotation pressure ACTIVE: MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d`); }
        else if (rp < -2)           { score += -2;  notes.push(`MSFT mildly lagging cohort (${rp.toFixed(1)}pp/30d)`); }
        else if (rp > 5)            { score += 4;   notes.push(`MSFT outperforming cohort by ${rp.toFixed(1)}pp/30d — quality leadership`); }
      }
    }

    if (data.factor_flow?.qual_vs_spy_30d_pp != null) {
      const q = data.factor_flow.qual_vs_spy_30d_pp;
      if (q > 2)       { score += -3; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): strong quality bid — MSFT benefits`); }
      else if (q > 1)  { score += -1; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): quality bid active`); }
      else if (q < -2) { score += 3;  notes.push(`QUAL ${q.toFixed(1)}pp vs SPY (30d): quality factor under pressure`); }
      else if (q < -1) { score += 1;  }
    }

    if (vix != null && chg != null) {
      if (vix > 35 && chg < -2) {
        score += -8; notes.push(`VIX ${vix} + MSFT ${chg}%: broad fear collateral — quality bid will return`);
      } else if (vix > 25 && chg < -1.5) {
        score += -4; notes.push(`VIX ${vix} + MSFT ${chg}%: elevated fear pressure on compounder`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── LHX-SPECIFIC (V7.5): DEFENSE PRIME BACKLOG COMPOUNDER ───────────────
  if (isLHX) {
    // RSI tightened bands 40/70 (compounder, similar to MSFT)
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: LHX severe oversold — rare defense compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: LHX deeply oversold`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: LHX oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: LHX mildly oversold (tightened band)`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: LHX approaching oversold`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: LHX normal trending range`); }
      else if (rsi < 70) { score += 5;   notes.push(`RSI ${rsi}: LHX healthy momentum`); }
      else if (rsi < 75) { score += 15;  notes.push(`RSI ${rsi}: LHX overbought (tightened — defense compounder)`); }
      else if (rsi < 80) { score += 25;  notes.push(`RSI ${rsi}: LHX deeply overbought`); }
      else               { score += 40;  notes.push(`RSI ${rsi}: LHX extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal (>10% setup, >18% strong)
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 25)       { score += -22; notes.push(`LHX drawdown ${dd.toFixed(1)}%: extreme — rare conviction buy`); }
      else if (ddMag > 18)  { score += -15; notes.push(`LHX drawdown ${dd.toFixed(1)}%: deep — high-conviction setup`); }
      else if (ddMag > 10)  { score += -8;  notes.push(`LHX drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 5)   { score += -3;  notes.push(`LHX drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 2;   notes.push(`LHX at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`LHX daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`LHX daily ${chg}%: sharp drop`); }
      else if (chg < -2) { score += -3;  notes.push(`LHX daily ${chg}%: notable for low-vol compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`LHX daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`LHX daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`LHX daily +${chg}%: notable for low-vol`); }
    }

    // Cohort rotation pressure — signature LHX tactical setup (mirrors MSFT pattern).
    // Capital flowing from LHX to larger primes (LMT/RTX/NOC/GD) is historically a BUY setup.
    if (data.cohort_relative) {
      const rp = data.cohort_relative.cohort_rotation_pp;
      const active = data.cohort_relative.cohort_rotation_active;
      if (rp != null) {
        if (active && rp < -10)     { score += -12; notes.push(`Cohort rotation ACTIVE: LHX lagging by ${(-rp).toFixed(1)}pp/30d — strong buy setup (capital flowing to larger primes)`); }
        else if (active && rp < -7) { score += -8;  notes.push(`Cohort rotation ACTIVE: LHX lagging by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
        else if (active)            { score += -5;  notes.push(`Cohort rotation ACTIVE: LHX lagging by ${(-rp).toFixed(1)}pp/30d`); }
        else if (rp < -2)           { score += -2;  notes.push(`LHX mildly lagging cohort (${rp.toFixed(1)}pp/30d)`); }
        else if (rp > 5)            { score += 4;   notes.push(`LHX outperforming cohort by ${rp.toFixed(1)}pp/30d — leadership`); }
      }
    }

    // VIX overlay — defense compounder as collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -2) {
        score += -8; notes.push(`VIX ${vix} + LHX ${chg}%: broad fear collateral — defense bid will return`);
      } else if (vix > 25 && chg < -1.5) {
        score += -4; notes.push(`VIX ${vix} + LHX ${chg}%: elevated fear pressure on compounder`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── TMO-SPECIFIC (V7.5): LIFE SCIENCES QUALITY COMPOUNDER ───────────────
  if (isTMO) {
    // RSI tightened bands 35/70 (compounder, like LIN)
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: TMO severe oversold — rare life-sciences compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: TMO deeply oversold`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: TMO oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: TMO mildly oversold (tightened band)`); }
      else if (rsi < 45) { score += -3;  notes.push(`RSI ${rsi}: TMO slight softness`); }
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: TMO normal trending range`); }
      else if (rsi < 70) { score += 5;   notes.push(`RSI ${rsi}: TMO healthy momentum`); }
      else if (rsi < 75) { score += 15;  notes.push(`RSI ${rsi}: TMO overbought (tightened — low vol)`); }
      else if (rsi < 80) { score += 25;  notes.push(`RSI ${rsi}: TMO deeply overbought`); }
      else               { score += 40;  notes.push(`RSI ${rsi}: TMO extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal (wider bands: >15% setup, >25% strong)
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 30)       { score += -25; notes.push(`TMO drawdown ${dd.toFixed(1)}%: extreme — rare conviction buy`); }
      else if (ddMag > 25)  { score += -18; notes.push(`TMO drawdown ${dd.toFixed(1)}%: deep — strong conviction setup`); }
      else if (ddMag > 15)  { score += -12; notes.push(`TMO drawdown ${dd.toFixed(1)}%: meaningful setup territory`); }
      else if (ddMag > 8)   { score += -5;  notes.push(`TMO drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 2;   notes.push(`TMO at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`TMO daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`TMO daily ${chg}%: sharp drop`); }
      else if (chg < -2) { score += -3;  notes.push(`TMO daily ${chg}%: notable for low-vol compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`TMO daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`TMO daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`TMO daily +${chg}%: notable for low-vol`); }
    }

    // Biotech sympathy setup — signature TMO tactical signal.
    // TMO + XBI both down meaningfully = capital indiscriminately selling, TMO collateral.
    if (data.biotech_overlay?.sympathy_setup_active) {
      const xbiChg = data.biotech_overlay.xbi_change_pct;
      score += -8; notes.push(`Biotech sympathy ACTIVE: TMO ${chg}% + XBI ${xbiChg}% — collateral damage, buy setup`);
    }

    // TMO vs DHR daily relative — peer sympathy read
    if (data.peer_relative?.relative_spread_pp != null) {
      const sp = data.peer_relative.relative_spread_pp;
      if (sp < -3)       { score += -4; notes.push(`DHR outperforming TMO by ${(-sp).toFixed(2)}pp (daily) — catch-up potential`); }
      else if (sp < -1)  { score += -2; }
      else if (sp > 3)   { score += 3;  notes.push(`TMO outperforming DHR by ${sp}pp — quality leadership`); }
    }

    // VIX overlay — quality compounder as collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -2) {
        score += -8; notes.push(`VIX ${vix} + TMO ${chg}%: broad fear collateral — quality bid will return`);
      } else if (vix > 25 && chg < -1.5) {
        score += -4; notes.push(`VIX ${vix} + TMO ${chg}%: elevated fear pressure on compounder`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── NOW-SPECIFIC (V7.6): AI WORKFLOW QUALITY COMPOUNDER ─────────────────
  // Tightened RSI 40/65 (compounder), drawdown-from-high primary signal,
  // SaaS cohort rotation vs CRM/WDAY/ADBE, IGV software factor flow.
  if (isNOW) {
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: NOW severe oversold — rare workflow compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: NOW deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: NOW oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: NOW mildly oversold (tightened band)`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: NOW approaching oversold`); }
      else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: NOW normal trending range`); }
      else if (rsi < 65) { score += 3;   notes.push(`RSI ${rsi}: NOW healthy momentum`); }
      else if (rsi < 70) { score += 12;  notes.push(`RSI ${rsi}: NOW overbought (tightened — quality compounder)`); }
      else if (rsi < 75) { score += 22;  notes.push(`RSI ${rsi}: NOW extended`); }
      else if (rsi < 80) { score += 32;  notes.push(`RSI ${rsi}: NOW deeply overbought`); }
      else               { score += 45;  notes.push(`RSI ${rsi}: NOW extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal (>12% setup, >20% strong)
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 25)       { score += -25; notes.push(`NOW drawdown ${dd.toFixed(1)}%: extreme — rare compounder buy`); }
      else if (ddMag > 20)  { score += -18; notes.push(`NOW drawdown ${dd.toFixed(1)}%: deep — high-conviction buy setup`); }
      else if (ddMag > 15)  { score += -12; notes.push(`NOW drawdown ${dd.toFixed(1)}%: meaningful — compounder buy interest`); }
      else if (ddMag > 12)  { score += -8;  notes.push(`NOW drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 8)   { score += -3;  notes.push(`NOW drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 3;   notes.push(`NOW at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`NOW daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`NOW daily ${chg}%: sharp drop`); }
      else if (chg < -2) { score += -3;  notes.push(`NOW daily ${chg}%: notable for premium SaaS compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`NOW daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`NOW daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`NOW daily +${chg}%: notable rally`); }
    }

    // SaaS cohort rotation pressure — signature NOW tactical setup.
    // Capital rotating to higher-beta AI/SaaS from highest-quality workflow franchise
    // = historically a buy setup, not a warning.
    if (data.cohort_relative) {
      const rp = data.cohort_relative.rotation_pressure_pp;
      const active = data.cohort_relative.rotation_pressure_active;
      if (rp != null) {
        if (active && rp < -10)     { score += -12; notes.push(`Rotation pressure ACTIVE: NOW lagging SaaS cohort by ${(-rp).toFixed(1)}pp/30d — strong buy setup (capital chasing higher-beta AI/SaaS)`); }
        else if (active && rp < -7) { score += -8;  notes.push(`Rotation pressure ACTIVE: NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
        else if (active)            { score += -5;  notes.push(`Rotation pressure ACTIVE: NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d`); }
        else if (rp < -2)           { score += -2;  notes.push(`NOW mildly lagging cohort (${rp.toFixed(1)}pp/30d)`); }
        else if (rp > 5)            { score += 4;   notes.push(`NOW outperforming cohort by ${rp.toFixed(1)}pp/30d — quality leadership`); }
      }
    }

    // VIX overlay — premium SaaS compounder as collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -2) {
        score += -8; notes.push(`VIX ${vix} + NOW ${chg}%: broad fear collateral — quality bid will return`);
      } else if (vix > 25 && chg < -1.5) {
        score += -4; notes.push(`VIX ${vix} + NOW ${chg}%: elevated fear pressure on compounder`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── MA-SPECIFIC (V8.2): PAYMENTS NETWORK QUALITY COMPOUNDER ─────────────
  if (isMA) {
    // RSI tightened bands 40/65 (low-vol compounder, MSFT-style)
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: Mastercard severe oversold — rare rails-compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: Mastercard deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: Mastercard oversold`); }
      else if (rsi < 35) { score += -15; notes.push(`RSI ${rsi}: Mastercard mildly oversold (tightened band)`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: Mastercard approaching oversold`); }
      else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: Mastercard normal trending range`); }
      else if (rsi < 65) { score += 3;   notes.push(`RSI ${rsi}: Mastercard healthy momentum`); }
      else if (rsi < 70) { score += 12;  notes.push(`RSI ${rsi}: Mastercard overbought (tightened — quality compounder)`); }
      else if (rsi < 75) { score += 22;  notes.push(`RSI ${rsi}: Mastercard extended`); }
      else if (rsi < 80) { score += 32;  notes.push(`RSI ${rsi}: Mastercard deeply overbought`); }
      else               { score += 45;  notes.push(`RSI ${rsi}: Mastercard extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal (>12% setup, >20% strong).
    // Narrative-cycle drawdowns (stablecoin/interchange fear) are the entry for a
    // beta-0.83 compounder whose volumes don't move with headlines.
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 25)       { score += -25; notes.push(`Mastercard drawdown ${dd.toFixed(1)}%: extreme — rare compounder buy`); }
      else if (ddMag > 20)  { score += -18; notes.push(`Mastercard drawdown ${dd.toFixed(1)}%: deep — high-conviction buy setup`); }
      else if (ddMag > 15)  { score += -12; notes.push(`Mastercard drawdown ${dd.toFixed(1)}%: meaningful — compounder buy interest`); }
      else if (ddMag > 12)  { score += -8;  notes.push(`Mastercard drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 8)   { score += -3;  notes.push(`Mastercard drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 3;   notes.push(`Mastercard at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -5)      { score += -15; notes.push(`Mastercard daily ${chg}%: rare big drop — aggressive buy`); }
      else if (chg < -3) { score += -8;  notes.push(`Mastercard daily ${chg}%: sharp drop`); }
      else if (chg < -2) { score += -3;  notes.push(`Mastercard daily ${chg}%: notable for low-vol compounder`); }
      else if (chg > 5)  { score += 10;  notes.push(`Mastercard daily +${chg}%: rare sharp rally`); }
      else if (chg > 3)  { score += 5;   notes.push(`Mastercard daily +${chg}%: notable rally`); }
      else if (chg > 2)  { score += 2;   notes.push(`Mastercard daily +${chg}%: notable for low-vol`); }
    }

    // Twin dislocation vs V (30d) — signature MA tactical setup #1.
    // Duopoly twins rarely diverge; MA lagging V without an MA-specific
    // fundamental break = buy setup, not a warning.
    if (data.duopoly_relative) {
      const ts = data.duopoly_relative.twin_spread_pp;
      const active = data.duopoly_relative.twin_dislocation_active;
      if (ts != null) {
        if (active && ts < -8)      { score += -12; notes.push(`Twin dislocation ACTIVE: Mastercard lagging V by ${(-ts).toFixed(1)}pp/30d — strong buy setup (twins rarely diverge)`); }
        else if (active && ts < -6) { score += -8;  notes.push(`Twin dislocation ACTIVE: Mastercard lagging V by ${(-ts).toFixed(1)}pp/30d — buy setup`); }
        else if (active)            { score += -5;  notes.push(`Twin dislocation ACTIVE: Mastercard lagging V by ${(-ts).toFixed(1)}pp/30d`); }
        else if (ts < -2)           { score += -2;  notes.push(`Mastercard mildly lagging V (${ts.toFixed(1)}pp/30d)`); }
        else if (ts > 4)            { score += 4;   notes.push(`Mastercard leading V by ${ts.toFixed(1)}pp/30d — faster-grower premium extending`); }
      }

      // Duopoly fear regime vs SPY (30d) — signature MA tactical setup #2.
      // Both networks sold on disruption headlines with volumes intact = the setup.
      const fr = data.duopoly_relative.disruption_fear_regime;
      const dv = data.duopoly_relative.duopoly_vs_spy_pp;
      if (fr === "acute")         { score += -10; notes.push(`Duopoly fear regime ACUTE (MA+V ${dv != null ? dv.toFixed(1) : "—"}pp vs SPY/30d): networks sold on headlines — buy setup`); }
      else if (fr === "elevated") { score += -6;  notes.push(`Duopoly fear regime ELEVATED (MA+V ${dv != null ? dv.toFixed(1) : "—"}pp vs SPY/30d)`); }
      else if (fr === "absent")   { score += 3;   notes.push(`Duopoly fear absent (MA+V ${dv != null ? "+" + dv.toFixed(1) : "—"}pp vs SPY/30d) — re-rating underway`); }
    }

    // QUAL factor flow — market-wide quality bid (MA benefits as a quality compounder)
    if (data.factor_flow?.qual_vs_spy_30d_pp != null) {
      const q = data.factor_flow.qual_vs_spy_30d_pp;
      if (q > 2)       { score += -3; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): strong quality bid — Mastercard benefits`); }
      else if (q > 1)  { score += -1; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): quality bid active`); }
      else if (q < -2) { score += 3;  notes.push(`QUAL ${q.toFixed(1)}pp vs SPY (30d): quality factor under pressure`); }
      else if (q < -1) { score += 1;  }
    }

    // VIX overlay — low-beta compounder as collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -2) {
        score += -8; notes.push(`VIX ${vix} + Mastercard ${chg}%: broad fear collateral — quality bid will return`);
      } else if (vix > 25 && chg < -1.5) {
        score += -4; notes.push(`VIX ${vix} + Mastercard ${chg}%: elevated fear pressure on compounder`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── ISRG-SPECIFIC (V8.2): SURGICAL ROBOTICS MOAT COMPOUNDER ─────────────
  if (isISRG) {
    // RSI bands 38/68 — beta ~1.7, slightly wider than the low-vol compounders
    if (rsi != null) {
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: ISRG severe oversold — rare category-king opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: ISRG deeply oversold — moat compounder on sale`); }
      else if (rsi < 30) { score += -30; notes.push(`RSI ${rsi}: ISRG oversold`); }
      else if (rsi < 34) { score += -18; notes.push(`RSI ${rsi}: ISRG mildly oversold`); }
      else if (rsi < 38) { score += -10; notes.push(`RSI ${rsi}: ISRG approaching oversold`); }
      else if (rsi <= 62) { score += 0;  notes.push(`RSI ${rsi}: ISRG normal trending range`); }
      else if (rsi < 68) { score += 5;   notes.push(`RSI ${rsi}: ISRG healthy momentum (wider band — beta ~1.7)`); }
      else if (rsi < 72) { score += 14;  notes.push(`RSI ${rsi}: ISRG overbought`); }
      else if (rsi < 76) { score += 24;  notes.push(`RSI ${rsi}: ISRG extended`); }
      else if (rsi < 80) { score += 34;  notes.push(`RSI ${rsi}: ISRG deeply overbought`); }
      else               { score += 45;  notes.push(`RSI ${rsi}: ISRG extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal (>15% setup, >25% strong).
    // Fear-cycle drawdowns (2027 instrument transition / Hugo-Ottava narrative)
    // on a beta-1.7 category king are where the alpha lives. Ladder extended to
    // >35% for the wider trading range.
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 35)       { score += -28; notes.push(`ISRG drawdown ${dd.toFixed(1)}%: extreme — rare category-king buy`); }
      else if (ddMag > 25)  { score += -20; notes.push(`ISRG drawdown ${dd.toFixed(1)}%: deep — high-conviction buy setup`); }
      else if (ddMag > 20)  { score += -14; notes.push(`ISRG drawdown ${dd.toFixed(1)}%: meaningful — moat compounder buy interest`); }
      else if (ddMag > 15)  { score += -10; notes.push(`ISRG drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 10)  { score += -4;  notes.push(`ISRG drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 2)   { score += 3;   notes.push(`ISRG at/near 52w highs — normal compounder`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -6)        { score += -14; notes.push(`ISRG daily ${chg}%: capitulation-style drop — aggressive buy`); }
      else if (chg < -4)   { score += -8;  notes.push(`ISRG daily ${chg}%: sharp drop`); }
      else if (chg < -2.5) { score += -3;  notes.push(`ISRG daily ${chg}%: notable decline`); }
      else if (chg > 6)    { score += 10;  notes.push(`ISRG daily +${chg}%: sharp rally`); }
      else if (chg > 4)    { score += 5;   notes.push(`ISRG daily +${chg}%: notable rally`); }
      else if (chg > 2.5)  { score += 2;   notes.push(`ISRG daily +${chg}%: notable rally`); }
    }

    // Cohort fear rotation vs MDT/SYK/BSX — signature ISRG tactical setup.
    // ISRG sold on competition/instrument headlines while the devices cohort
    // holds = fear rotation, historically a buy setup absent procedure evidence.
    if (data.cohort_relative) {
      const rp = data.cohort_relative.cohort_rotation_pp;
      const active = data.cohort_relative.cohort_rotation_active;
      if (rp != null) {
        if (active && rp < -12)     { score += -12; notes.push(`Fear rotation ACTIVE: ISRG lagging devices cohort by ${(-rp).toFixed(1)}pp/30d — strong buy setup (narrative selling, check procedure evidence)`); }
        else if (active && rp < -9) { score += -8;  notes.push(`Fear rotation ACTIVE: ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
        else if (active)            { score += -5;  notes.push(`Fear rotation ACTIVE: ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d`); }
        else if (rp < -3)           { score += -2;  notes.push(`ISRG mildly lagging devices cohort (${rp.toFixed(1)}pp/30d)`); }
        else if (rp > 6)            { score += 4;   notes.push(`ISRG outperforming cohort by ${rp.toFixed(1)}pp/30d — category-king leadership`); }
      }
    }

    // VIX overlay — high-beta quality name takes outsized collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -3) {
        score += -8; notes.push(`VIX ${vix} + ISRG ${chg}%: broad fear collateral on beta-1.7 quality — bid will return`);
      } else if (vix > 25 && chg < -2) {
        score += -4; notes.push(`VIX ${vix} + ISRG ${chg}%: elevated fear pressure`);
      }
    }

    return { score: clamp(score), notes };
  }

  if (isRDDT) {
    // RSI bands 32/72 — WIDEST IN THE BOOK. Beta 1.94, short interest ~9%.
    // RSI 29 on RDDT is not RSI 29 on LIN; equity-standard oversold logic
    // would fire constantly on this name.
    if (rsi != null) {
      if (rsi < 18)       { score += -55; notes.push(`RSI ${rsi}: RDDT extreme oversold — rare washout`); }
      else if (rsi < 22)  { score += -45; notes.push(`RSI ${rsi}: RDDT deeply oversold`); }
      else if (rsi < 26)  { score += -35; notes.push(`RSI ${rsi}: RDDT oversold`); }
      else if (rsi < 29)  { score += -25; notes.push(`RSI ${rsi}: RDDT meaningfully oversold`); }
      else if (rsi < 32)  { score += -15; notes.push(`RSI ${rsi}: RDDT approaching oversold (beta-1.94 band)`); }
      else if (rsi <= 62) { score += 0;   notes.push(`RSI ${rsi}: RDDT normal trending range`); }
      else if (rsi < 72)  { score += 5;   notes.push(`RSI ${rsi}: RDDT healthy momentum (wide band — beta 1.94)`); }
      else if (rsi < 76)  { score += 14;  notes.push(`RSI ${rsi}: RDDT overbought`); }
      else if (rsi < 80)  { score += 26;  notes.push(`RSI ${rsi}: RDDT extended`); }
      else if (rsi < 85)  { score += 38;  notes.push(`RSI ${rsi}: RDDT deeply overbought`); }
      else                { score += 48;  notes.push(`RSI ${rsi}: RDDT extreme — trim bias`); }
    }

    // Drawdown-from-52w-high — primary tactical signal, ladder scaled to 60%
    // rather than the compounders' 40%. RDDT's post-IPO range is genuinely
    // this wide (52w $119-$283), so a 25% drawdown is a setup, not an event.
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 50)      { score += -30; notes.push(`RDDT drawdown ${dd.toFixed(1)}%: extreme — max tactical conviction IF ad growth intact`); }
      else if (ddMag > 40) { score += -24; notes.push(`RDDT drawdown ${dd.toFixed(1)}%: deep — high-conviction setup`); }
      else if (ddMag > 32) { score += -16; notes.push(`RDDT drawdown ${dd.toFixed(1)}%: meaningful`); }
      else if (ddMag > 25) { score += -10; notes.push(`RDDT drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 15) { score += -4;  notes.push(`RDDT drawdown ${dd.toFixed(1)}%: mild (routine for beta 1.94)`); }
      else if (ddMag < 3)  { score += 3;   notes.push(`RDDT at/near 52w highs`); }
    }

    // Daily move — noise floor is ±4%. A 3% day on RDDT is nothing; the Q2'26
    // print moved it ~21% intraday.
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -12)       { score += -18; notes.push(`RDDT daily ${chg}%: capitulation/event-driven collapse — check whether ad growth actually broke`); }
      else if (chg < -8)   { score += -12; notes.push(`RDDT daily ${chg}%: severe drop`); }
      else if (chg < -6)   { score += -7;  notes.push(`RDDT daily ${chg}%: sharp drop`); }
      else if (chg < -4)   { score += -3;  notes.push(`RDDT daily ${chg}%: notable decline`); }
      else if (chg > 12)   { score += 14;  notes.push(`RDDT daily +${chg}%: parabolic spike`); }
      else if (chg > 8)    { score += 9;   notes.push(`RDDT daily +${chg}%: sharp rally`); }
      else if (chg > 6)    { score += 5;   notes.push(`RDDT daily +${chg}%: strong rally`); }
      else if (chg > 4)    { score += 2;   notes.push(`RDDT daily +${chg}%: notable rally`); }
      else                 { notes.push(`RDDT daily ${chg}%: inside the ±4% noise band for this beta`); }
    }

    // Ads-cohort rotation vs META/PINS/APP — the signature RDDT tactical setup.
    // RDDT sold on referral/narrative headlines while the ad complex holds =
    // rotation, historically a buy setup ABSENT an ad-revenue print confirming
    // the weakness. Threshold -8pp (fetch v4.16), wider than ISRG's -6pp.
    if (data.cohort_relative) {
      const rp = data.cohort_relative.cohort_rotation_pp;
      const active = data.cohort_relative.cohort_rotation_active;
      if (rp != null) {
        if (active && rp < -18)      { score += -12; notes.push(`Ads rotation ACTIVE: RDDT lagging META/PINS/APP by ${(-rp).toFixed(1)}pp/30d — strong buy setup (verify ad revenue growth before sizing)`); }
        else if (active && rp < -12) { score += -8;  notes.push(`Ads rotation ACTIVE: RDDT lagging cohort by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
        else if (active)             { score += -5;  notes.push(`Ads rotation ACTIVE: RDDT lagging cohort by ${(-rp).toFixed(1)}pp/30d`); }
        else if (rp < -4)            { score += -2;  notes.push(`RDDT mildly lagging ads cohort (${rp.toFixed(1)}pp/30d)`); }
        else if (rp > 8)             { score += 4;   notes.push(`RDDT outperforming ads cohort by ${rp.toFixed(1)}pp/30d`); }
      }
    }

    // VIX overlay — beta 1.94 takes amplified collateral damage in broad fear
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -5) {
        score += -8; notes.push(`VIX ${vix} + RDDT ${chg}%: broad fear amplified by beta 1.94 — dislocation, not information`);
      } else if (vix > 25 && chg < -3) {
        score += -4; notes.push(`VIX ${vix} + RDDT ${chg}%: elevated fear pressure`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── MLM TACTICAL (V8.4): LIN-CLASS BANDS + VMC TWIN + AGGREGATES ROTATION ──
  if (isMLM) {
    // RSI 38/70 — beta 1.11 puts MLM in the LIN/ISRG band, NOT RDDT's 32/72.
    // Importing the high-beta ladder here would refuse to call anything
    // oversold until the stock had already halved.
    if (rsi != null) {
      if (rsi < 22)       { score += -55; notes.push(`RSI ${rsi}: MLM extreme oversold — rare washout`); }
      else if (rsi < 27)  { score += -44; notes.push(`RSI ${rsi}: MLM deeply oversold`); }
      else if (rsi < 32)  { score += -32; notes.push(`RSI ${rsi}: MLM oversold`); }
      else if (rsi < 36)  { score += -20; notes.push(`RSI ${rsi}: MLM meaningfully oversold`); }
      else if (rsi < 38)  { score += -12; notes.push(`RSI ${rsi}: MLM approaching oversold (beta-1.11 band)`); }
      else if (rsi <= 60) { score += 0;   notes.push(`RSI ${rsi}: MLM normal trending range`); }
      else if (rsi < 70)  { score += 5;   notes.push(`RSI ${rsi}: MLM healthy momentum`); }
      else if (rsi < 75)  { score += 16;  notes.push(`RSI ${rsi}: MLM overbought`); }
      else if (rsi < 80)  { score += 28;  notes.push(`RSI ${rsi}: MLM extended`); }
      else                { score += 42;  notes.push(`RSI ${rsi}: MLM extreme — trim bias`); }
    }

    // Drawdown ladder scaled to 35% (vs RDDT's 60%). A 25% drawdown in a
    // quarry business is a genuine event; in RDDT it was a Tuesday.
    const dd = computeDrawdownFromHigh(data);
    if (dd != null) {
      const ddMag = Math.abs(dd);
      if (ddMag > 30)      { score += -30; notes.push(`MLM drawdown ${dd.toFixed(1)}%: extreme — max tactical conviction IF mix-adjusted pricing intact`); }
      else if (ddMag > 25) { score += -24; notes.push(`MLM drawdown ${dd.toFixed(1)}%: deep — high-conviction setup`); }
      else if (ddMag > 20) { score += -16; notes.push(`MLM drawdown ${dd.toFixed(1)}%: meaningful`); }
      else if (ddMag > 15) { score += -10; notes.push(`MLM drawdown ${dd.toFixed(1)}%: setup territory`); }
      else if (ddMag > 8)  { score += -4;  notes.push(`MLM drawdown ${dd.toFixed(1)}%: mild`); }
      else if (ddMag < 3)  { score += 3;   notes.push(`MLM at/near 52w highs`); }
    }

    // Daily move — noise floor ±2%. Half RDDT's, double a pure low-vol
    // compounder's: MLM carries real single-name event risk (it fell ~5% on
    // the Q2'26 print) without RDDT's baseline volatility.
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -7)        { score += -18; notes.push(`MLM daily ${chg}%: capitulation/event-driven — check whether PRICING actually broke, not just volume`); }
      else if (chg < -5)   { score += -12; notes.push(`MLM daily ${chg}%: severe drop`); }
      else if (chg < -3.5) { score += -7;  notes.push(`MLM daily ${chg}%: sharp drop`); }
      else if (chg < -2)   { score += -3;  notes.push(`MLM daily ${chg}%: notable decline`); }
      else if (chg > 7)    { score += 14;  notes.push(`MLM daily +${chg}%: parabolic spike`); }
      else if (chg > 5)    { score += 9;   notes.push(`MLM daily +${chg}%: sharp rally`); }
      else if (chg > 3.5)  { score += 5;   notes.push(`MLM daily +${chg}%: strong rally`); }
      else if (chg > 2)    { score += 2;   notes.push(`MLM daily +${chg}%: notable rally`); }
      else                 { notes.push(`MLM daily ${chg}%: inside the ±2% noise band for this beta`); }
    }

    // ★ VMC TWIN DISLOCATION — the signature MLM tactical setup, scored on the
    // MA/V duopoly-twin pattern rather than folded into the cohort average.
    // MLM and VMC are the two dominant US aggregates franchises with materially
    // identical business models. They do not diverge for non-operating reasons.
    // Scored BEFORE the 3-name cohort so the twin read carries the weight.
    if (data.cohort_relative?.vmc_spread_30d_pp != null) {
      const vs = data.cohort_relative.vmc_spread_30d_pp;
      const active = data.cohort_relative.vmc_dislocation_active;
      if (active && vs < -15)      { score += -14; notes.push(`VMC twin dislocation: MLM lagging VMC by ${(-vs).toFixed(1)}pp/30d — strong buy setup (verify mix-adjusted pricing before sizing)`); }
      else if (active && vs < -10) { score += -10; notes.push(`VMC twin dislocation: MLM lagging VMC by ${(-vs).toFixed(1)}pp/30d — buy setup`); }
      else if (active)             { score += -6;  notes.push(`VMC twin dislocation: MLM lagging VMC by ${(-vs).toFixed(1)}pp/30d`); }
      else if (vs < -2)            { score += -2;  notes.push(`MLM mildly lagging VMC (${vs.toFixed(1)}pp/30d)`); }
      else if (vs > 8)             { score += 4;   notes.push(`MLM outperforming VMC by ${vs.toFixed(1)}pp/30d`); }
    }

    // Aggregates-cohort rotation vs VMC/CRH/EXP (weighted). Threshold −5pp —
    // MUST match fetch-market-data v4.17's peer_rotation_active boundary, or
    // the engine and the fetch layer disagree about when rotation is live.
    if (data.cohort_relative?.peer_rotation_pp != null) {
      const rp = data.cohort_relative.peer_rotation_pp;
      const active = data.cohort_relative.peer_rotation_active;
      if (active && rp < -12)      { score += -10; notes.push(`Aggregates rotation ACTIVE: MLM lagging cohort by ${(-rp).toFixed(1)}pp/30d — strong buy setup`); }
      else if (active && rp < -8)  { score += -7;  notes.push(`Aggregates rotation ACTIVE: MLM lagging cohort by ${(-rp).toFixed(1)}pp/30d — buy setup`); }
      else if (active)             { score += -4;  notes.push(`Aggregates rotation ACTIVE: MLM lagging cohort by ${(-rp).toFixed(1)}pp/30d`); }
      else if (rp < -2)            { score += -2;  notes.push(`MLM mildly lagging aggregates cohort (${rp.toFixed(1)}pp/30d)`); }
      else if (rp > 6)             { score += 3;   notes.push(`MLM outperforming aggregates cohort by ${rp.toFixed(1)}pp/30d`); }
    }

    // XLB vs SPY 30d — materials sector factor bid
    if (data.factor_flow?.xlb_vs_spy_30d_pp != null) {
      const x = data.factor_flow.xlb_vs_spy_30d_pp;
      if (x > 2)       { score += -3; notes.push(`XLB +${x.toFixed(1)}pp vs SPY (30d): strong materials bid`); }
      else if (x > 1)  { score += -1; notes.push(`XLB +${x.toFixed(1)}pp vs SPY (30d): materials bid active`); }
      else if (x < -2) { score += 3;  notes.push(`XLB ${x.toFixed(1)}pp vs SPY (30d): materials complex lagging — sector pressure`); }
      else if (x < -1) { score += 1;  }
    }

    // VIX overlay — modest. Beta 1.11 does not take RDDT-scale collateral
    // damage, so the amplitudes here are roughly half.
    if (vix != null && chg != null) {
      if (vix > 35 && chg < -3) {
        score += -6; notes.push(`VIX ${vix} + MLM ${chg}%: broad fear — dislocation, not information`);
      } else if (vix > 25 && chg < -2) {
        score += -3; notes.push(`VIX ${vix} + MLM ${chg}%: elevated fear pressure`);
      }
    }

    return { score: clamp(score), notes };
  }

  // ─── GENERIC TACTICAL (fallback — currently no consumers as all archetypes have dedicated paths) ──
  if (rsi != null) {
    if (rsi < 20)      { score += -60; notes.push(`RSI ${rsi}: severely oversold`); }
    else if (rsi < 25) { score += -45; notes.push(`RSI ${rsi}: deeply oversold`); }
    else if (rsi < 30) { score += -35; notes.push(`RSI ${rsi}: oversold`); }
    else if (rsi < 35) { score += -20; notes.push(`RSI ${rsi}: mildly oversold`); }
    else if (rsi < 40) { score += -10; notes.push(`RSI ${rsi}: approaching oversold`); }
    else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: neutral`); }
    else if (rsi < 65) { score += 10;  notes.push(`RSI ${rsi}: approaching overbought`); }
    else if (rsi < 70) { score += 20;  notes.push(`RSI ${rsi}: mildly overbought`); }
    else if (rsi < 75) { score += 35;  notes.push(`RSI ${rsi}: overbought`); }
    else if (rsi < 80) { score += 45;  notes.push(`RSI ${rsi}: deeply overbought`); }
    else               { score += 60;  notes.push(`RSI ${rsi}: severely overbought`); }
  }

  const chg = data.price?.change_pct;
  if (chg != null) {
    if (chg < -5)      { score += -15; notes.push(`Daily ${chg}%: sharp decline`); }
    else if (chg < -3) { score += -8;  notes.push(`Daily ${chg}%: notable decline`); }
    else if (chg > 5)  { score += 15;  notes.push(`Daily +${chg}%: sharp rally`); }
    else if (chg > 3)  { score += 8;   notes.push(`Daily +${chg}%: notable rally`); }
  }

  return { score: clamp(score), notes };
}

// ─── POSITIONAL LAYER (intermediate trend) ──────────────────────────────────
export function scorePositional(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isAMKBY = archetype === "cyclical_trade_bellwether";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isLIN = archetype === "oligopoly_quality_compounder";
  const isMSFT = archetype === "ai_infra_quality_compounder";
  const isLHX = archetype === "defense_prime_backlog_compounder";
  const isTMO = archetype === "life_sciences_quality_compounder";
  const isNOW = archetype === "ai_workflow_quality_compounder";            // ← V7.6
  const isMA = archetype === "payments_network_quality_compounder";        // ← V8.2
  const isISRG = archetype === "surgical_robotics_moat_compounder";        // ← V8.2
  const isRDDT = archetype === "hypergrowth_platform_monetizer";           // ← V8.3 (RETAINED — dead code, historical re-scoring)
  const isMLM = archetype === "reserve_moat_infrastructure_compounder";     // ← V8.4

  const ma = data.technicals?.ma_signal;
  if (ma) {
    if (isIBIT) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -5, "above_200_below_50": -8, "below_both": -20, "below_both_death": -30 };
      if (m[ma] != null) { score += m[ma]; notes.push(`IBIT MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "bull regime — neutral"})`); }
    } else if (isASML) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`ASML MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isENB) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -8, "above_200_below_50": -3, "below_both": -20, "below_both_death": -30 };
      if (m[ma] != null) { score += m[ma]; notes.push(`ENB MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal yield compounder trend"})`); }
    } else if (isAMKBY) {
      const m = { "above_both_golden": 8, "above_both": 5, "above_50_below_200": -5, "above_200_below_50": 3, "below_both": -12, "below_both_death": -18 };
      if (m[ma] != null) { score += m[ma]; notes.push(`AMKBY MA: ${ma} (${m[ma] > 0 ? "+" : ""}${m[ma]})`); }
    } else if (isETHA) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -5, "above_200_below_50": -8, "below_both": -18, "below_both_death": -28 };
      if (m[ma] != null) { score += m[ma]; notes.push(`ETHA MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "bull regime — neutral"})`); }
    } else if (isKOF) {
      const m = { "above_both_golden": 3, "above_both": 0, "above_50_below_200": -5, "above_200_below_50": 3, "below_both": -15, "below_both_death": -22 };
      if (m[ma] != null) { score += m[ma]; notes.push(`KOF MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal"})`); }
    } else if (isGLNCY) {
      const m = { "above_both_golden": 8, "above_both": 5, "above_50_below_200": -5, "above_200_below_50": 3, "below_both": -12, "below_both_death": -20 };
      if (m[ma] != null) { score += m[ma]; notes.push(`GLNCY MA: ${ma} (${m[ma] > 0 ? "+" : ""}${m[ma]})`); }
    } else if (isPBRA) {
      const m = { "above_both_golden": 8, "above_both": 5, "above_50_below_200": -5, "above_200_below_50": 3, "below_both": -12, "below_both_death": -20 };
      if (m[ma] != null) { score += m[ma]; notes.push(`PBR.A MA: ${ma} (${m[ma] > 0 ? "+" : ""}${m[ma]})`); }
    } else if (isLIN) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`LIN MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isMSFT) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`MSFT MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isLHX) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`LHX MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isTMO) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`TMO MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isNOW) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`NOW MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isMA) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`Mastercard trend: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isISRG) {
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`ISRG MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else if (isRDDT) {
      // Dampened vs the compounder map: for RDDT, below-both may be the market
      // correctly pricing a live structural falsifier (referral decay), not a
      // fear cycle on a proven annuity. Buy the trend break less aggressively.
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -7, "above_200_below_50": -4, "below_both": -18, "below_both_death": -28 };
      if (m[ma] != null) { score += m[ma]; notes.push(`RDDT MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal trend"})`); }
    } else if (isMLM) {
      // Full compounder map. Unlike RDDT there is no live structural falsifier
      // that a trend break might be correctly pricing — a quarry's reserve base
      // does not decay because the stock fell below its 200DMA. Trend weakness
      // in a local monopoly is a fear cycle, so buy it at compounder amplitude.
      const m = { "above_both_golden": 0, "above_both": 0, "above_50_below_200": -10, "above_200_below_50": -5, "below_both": -25, "below_both_death": -40 };
      if (m[ma] != null) { score += m[ma]; notes.push(`MLM MA: ${ma} (${m[ma] !== 0 ? (m[ma] > 0 ? "+" : "") + m[ma] : "normal compounder trend"})`); }
    } else {
      const m = { "above_both_golden": 15, "above_both": 10, "above_50_below_200": -5, "above_200_below_50": 5, "below_both": -10, "below_both_death": -15 };
      if (m[ma] != null) { score += m[ma]; notes.push(`MA: ${ma} (${m[ma] > 0 ? "+" : ""}${m[ma]})`); }
    }
  }

  // 52-week position — ARCHETYPE AWARE
  const w52 = data.price?.week52_position_pct;
  if (w52 != null) {
    if (isIBIT) {
      if (w52 > 95)      { score += 0;   notes.push(`IBIT 52w: ${w52}% — at highs, mid-cycle momentum`); }
      else if (w52 > 85) { score += 0;   notes.push(`IBIT 52w: ${w52}% — near highs, healthy trend`); }
      else if (w52 > 60) { score += -3;  notes.push(`IBIT 52w: ${w52}% — upper range, neutral`); }
      else if (w52 > 40) { score += -10; notes.push(`IBIT 52w: ${w52}% — mid range, mild buy`); }
      else if (w52 > 25) { score += -20; notes.push(`IBIT 52w: ${w52}% — lower range, buy`); }
      else if (w52 > 10) { score += -35; notes.push(`IBIT 52w: ${w52}% — significant drawdown, strong buy`); }
      else               { score += -50; notes.push(`IBIT 52w: ${w52}% — deep drawdown, max conviction buy`); }
    } else if (isASML) {
      if (w52 > 95)      { score += 0;   notes.push(`ASML 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`ASML 52w: ${w52}% — normal trading range`); }
      else if (w52 > 70) { score += -3;  notes.push(`ASML 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -12; notes.push(`ASML 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -28; notes.push(`ASML 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -45; notes.push(`ASML 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -60; notes.push(`ASML 52w: ${w52}% — catastrophic drawdown — max conviction (very rare)`); }
    } else if (isENB) {
      if (w52 > 95)      { score += 0;   notes.push(`ENB 52w: ${w52}% — at highs, yield compressed — normal`); }
      else if (w52 > 85) { score += 0;   notes.push(`ENB 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`ENB 52w: ${w52}% — mild pullback, yield expanding`); }
      else if (w52 > 50) { score += -10; notes.push(`ENB 52w: ${w52}% — pullback, attractive yield territory`); }
      else if (w52 > 30) { score += -22; notes.push(`ENB 52w: ${w52}% — significant drawdown, high yield buy`); }
      else if (w52 > 15) { score += -35; notes.push(`ENB 52w: ${w52}% — major drawdown, strong buy (rare)`); }
      else               { score += -45; notes.push(`ENB 52w: ${w52}% — distressed — max conviction buy`); }
    } else if (isAMKBY) {
      if (w52 > 95)      { score += 15;  notes.push(`AMKBY 52w: ${w52}% — near highs, possible late-cycle`); }
      else if (w52 > 85) { score += 8;   notes.push(`AMKBY 52w: ${w52}% — upper range`); }
      else if (w52 > 70) { score += 3;   notes.push(`AMKBY 52w: ${w52}% — above mid`); }
      else if (w52 > 50) { score += 0;   notes.push(`AMKBY 52w: ${w52}% — mid range`); }
      else if (w52 > 30) { score += -8;  notes.push(`AMKBY 52w: ${w52}% — below mid, cyclical opportunity`); }
      else if (w52 > 15) { score += -20; notes.push(`AMKBY 52w: ${w52}% — lower range, freight trough buy`); }
      else if (w52 > 5)  { score += -30; notes.push(`AMKBY 52w: ${w52}% — near lows, deep cyclical buy`); }
      else               { score += -35; notes.push(`AMKBY 52w: ${w52}% — extreme low, max conviction`); }
    } else if (isETHA) {
      if (w52 > 95)      { score += 0;   notes.push(`ETHA 52w: ${w52}% — at highs, momentum positive`); }
      else if (w52 > 85) { score += 0;   notes.push(`ETHA 52w: ${w52}% — near highs, healthy trend`); }
      else if (w52 > 60) { score += -3;  notes.push(`ETHA 52w: ${w52}% — upper range`); }
      else if (w52 > 40) { score += -12; notes.push(`ETHA 52w: ${w52}% — mid range, buy interest`); }
      else if (w52 > 25) { score += -25; notes.push(`ETHA 52w: ${w52}% — lower range, buy`); }
      else if (w52 > 10) { score += -40; notes.push(`ETHA 52w: ${w52}% — significant drawdown, strong buy`); }
      else               { score += -55; notes.push(`ETHA 52w: ${w52}% — deep drawdown, max conviction`); }
    } else if (isKOF) {
      if (w52 > 95)      { score += 0;   notes.push(`KOF 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`KOF 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`KOF 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -8;  notes.push(`KOF 52w: ${w52}% — pullback, buy interest`); }
      else if (w52 > 30) { score += -18; notes.push(`KOF 52w: ${w52}% — significant drawdown, buy`); }
      else if (w52 > 15) { score += -28; notes.push(`KOF 52w: ${w52}% — major drawdown (rare for staples)`); }
      else               { score += -38; notes.push(`KOF 52w: ${w52}% — distressed — max conviction`); }
    } else if (isGLNCY) {
      if (w52 > 95)      { score += 12;  notes.push(`GLNCY 52w: ${w52}% — near highs, possible late-cycle`); }
      else if (w52 > 85) { score += 6;   notes.push(`GLNCY 52w: ${w52}% — upper range`); }
      else if (w52 > 70) { score += 2;   notes.push(`GLNCY 52w: ${w52}% — above mid`); }
      else if (w52 > 50) { score += 0;   notes.push(`GLNCY 52w: ${w52}% — mid range`); }
      else if (w52 > 30) { score += -8;  notes.push(`GLNCY 52w: ${w52}% — below mid, commodity opportunity`); }
      else if (w52 > 15) { score += -18; notes.push(`GLNCY 52w: ${w52}% — lower range, commodity trough buy`); }
      else if (w52 > 5)  { score += -28; notes.push(`GLNCY 52w: ${w52}% — near lows, deep commodity buy`); }
      else               { score += -35; notes.push(`GLNCY 52w: ${w52}% — extreme low, max conviction`); }
    } else if (isPBRA) {
      if (w52 > 95)      { score += 15;  notes.push(`PBR.A 52w: ${w52}% — near highs, political/cycle risk`); }
      else if (w52 > 85) { score += 8;   notes.push(`PBR.A 52w: ${w52}% — upper range`); }
      else if (w52 > 70) { score += 3;   notes.push(`PBR.A 52w: ${w52}% — above mid`); }
      else if (w52 > 50) { score += 0;   notes.push(`PBR.A 52w: ${w52}% — mid range`); }
      else if (w52 > 30) { score += -10; notes.push(`PBR.A 52w: ${w52}% — below mid, opportunity`); }
      else if (w52 > 15) { score += -22; notes.push(`PBR.A 52w: ${w52}% — lower range, oil trough buy`); }
      else if (w52 > 5)  { score += -32; notes.push(`PBR.A 52w: ${w52}% — near lows, deep buy`); }
      else               { score += -40; notes.push(`PBR.A 52w: ${w52}% — extreme low, max conviction`); }
    } else if (isLIN) {
      if (w52 > 95)      { score += 0;   notes.push(`LIN 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`LIN 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`LIN 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`LIN 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`LIN 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`LIN 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`LIN 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isMSFT) {
      if (w52 > 95)      { score += 0;   notes.push(`MSFT 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`MSFT 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`MSFT 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`MSFT 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`MSFT 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`MSFT 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`MSFT 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isLHX) {
      if (w52 > 95)      { score += 0;   notes.push(`LHX 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`LHX 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`LHX 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`LHX 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`LHX 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`LHX 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`LHX 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isTMO) {
      if (w52 > 95)      { score += 0;   notes.push(`TMO 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`TMO 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`TMO 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`TMO 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`TMO 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`TMO 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`TMO 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isNOW) {
      if (w52 > 95)      { score += 0;   notes.push(`NOW 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`NOW 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`NOW 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`NOW 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`NOW 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`NOW 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`NOW 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isMA) {
      if (w52 > 95)      { score += 0;   notes.push(`Mastercard 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`Mastercard 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`Mastercard 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`Mastercard 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`Mastercard 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`Mastercard 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`Mastercard 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isISRG) {
      if (w52 > 95)      { score += 0;   notes.push(`ISRG 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`ISRG 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`ISRG 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`ISRG 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`ISRG 52w: ${w52}% — real drawdown, category king on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`ISRG 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`ISRG 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else if (isRDDT) {
      // Deliberately SHALLOWER than the compounder ladder (floor -30 vs -50).
      // A compounder near 52w lows is almost always a fear cycle; RDDT near
      // 52w lows may be the referral falsifier landing. Do not auto-assign
      // max conviction to price weakness on a name with a live thesis risk —
      // the strategic layer checks search_referral_status before that.
      if (w52 > 95)      { score += 0;   notes.push(`RDDT 52w: ${w52}% — at highs`); }
      else if (w52 > 85) { score += 0;   notes.push(`RDDT 52w: ${w52}% — near highs`); }
      else if (w52 > 70) { score += -2;  notes.push(`RDDT 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -7;  notes.push(`RDDT 52w: ${w52}% — meaningful pullback`); }
      else if (w52 > 30) { score += -14; notes.push(`RDDT 52w: ${w52}% — real drawdown, buy interest if ad growth intact`); }
      else if (w52 > 15) { score += -22; notes.push(`RDDT 52w: ${w52}% — major drawdown — verify the thesis is not breaking`); }
      else               { score += -30; notes.push(`RDDT 52w: ${w52}% — deep drawdown — check referral status and ad growth before conviction`); }
    } else if (isMLM) {
      // FULL compounder ladder (floor -50), unlike RDDT's shallow -30. MLM near
      // 52w lows is a construction-cycle or funding-headline fear cycle, not a
      // moat breaking — the reserve position is unchanged by the news flow.
      // The one genuine falsifier (mix-adjusted pricing < 1%) is checked in the
      // fundamentals block below, so price weakness can be bought at full size.
      if (w52 > 95)      { score += 0;   notes.push(`MLM 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`MLM 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`MLM 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`MLM 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`MLM 52w: ${w52}% — real drawdown, reserve moat on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`MLM 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`MLM 52w: ${w52}% — catastrophic drawdown — max conviction`); }
    } else {
      if (w52 < 5)       { score += -30; notes.push(`52w: ${w52}% — extreme low`); }
      else if (w52 < 10) { score += -20; notes.push(`52w: ${w52}% — near lows`); }
      else if (w52 < 20) { score += -12; notes.push(`52w: ${w52}% — lower quartile`); }
      else if (w52 < 35) { score += -5;  notes.push(`52w: ${w52}% — below mid`); }
      else if (w52 <= 65) { score += 0;  notes.push(`52w: ${w52}% — mid range`); }
      else if (w52 < 80) { score += 5;   notes.push(`52w: ${w52}% — above mid`); }
      else if (w52 < 90) { score += 12;  notes.push(`52w: ${w52}% — upper quartile`); }
      else if (w52 < 95) { score += 20;  notes.push(`52w: ${w52}% — near highs`); }
      else               { score += 30;  notes.push(`52w: ${w52}% — extreme high`); }
    }
  }

  // Price distance from SMA
  const price = data.price?.current;
  const sma50 = data.technicals?.sma50;
  const sma200 = data.technicals?.sma200;

  if (isIBIT && price && sma200) {
    const pctFrom200 = ((price - sma200) / sma200) * 100;
    const phaseInfo = getHalvingPhase();
    const phase = phaseInfo.phase;

    if (pctFrom200 < -30) {
      const base = -40;
      const bonus = phase === "extended_expansion" ? -10 : phase === "post_expansion" ? -15 : 0;
      score += base + bonus;
      notes.push(`BTC ${pctFrom200.toFixed(1)}% below 200DMA — deep drawdown${bonus ? ` [${phase} amplifies: ${bonus}]` : ""}`);
    } else if (pctFrom200 < -15) {
      const base = -25;
      const bonus = phase === "extended_expansion" ? -8 : phase === "post_expansion" ? -12 : 0;
      score += base + bonus;
      notes.push(`BTC ${pctFrom200.toFixed(1)}% below 200DMA — correction${bonus ? ` [${phase}: ${bonus}]` : ""}`);
    } else if (pctFrom200 < -5) {
      score += -12; notes.push(`BTC ${pctFrom200.toFixed(1)}% below 200DMA — testing regime`);
    }
    else if (pctFrom200 < 30) {
      if (pctFrom200 > 10 && pctFrom200 < 30) {
        score += -3; notes.push(`BTC ${pctFrom200.toFixed(1)}% above 200DMA — trending bull regime`);
      } else {
        notes.push(`BTC ${pctFrom200.toFixed(1)}% above 200DMA — regime healthy`);
      }
    }
    else if (pctFrom200 < 60) {
      const base = 8;
      const bonus = phase === "extended_expansion" ? 7 : phase === "post_expansion" ? 12 : 0;
      score += base + bonus;
      notes.push(`BTC ${pctFrom200.toFixed(1)}% above 200DMA — extended${bonus ? ` [${phase} amplifies: +${bonus}]` : ""}`);
    } else if (pctFrom200 < 100) {
      const base = 20;
      const bonus = phase === "extended_expansion" ? 10 : phase === "post_expansion" ? 18 : 3;
      score += base + bonus;
      notes.push(`BTC ${pctFrom200.toFixed(1)}% above 200DMA — parabolic extension [${phase}: +${bonus}]`);
    } else {
      const base = 30;
      const bonus = phase === "extended_expansion" ? 15 : phase === "post_expansion" ? 25 : 5;
      score += base + bonus;
      notes.push(`BTC >2x 200DMA — extreme extension [${phase}: +${bonus}]`);
    }
    notes.push(`Halving cycle: month ${phaseInfo.months}, phase=${phase}`);
  }
  else if (isETHA && price && sma200) {
    const pctFrom200 = ((price - sma200) / sma200) * 100;
    if (pctFrom200 < -40)      { score += -50; notes.push(`ETH ${pctFrom200.toFixed(1)}% below 200DMA — extreme drawdown, max buy`); }
    else if (pctFrom200 < -25) { score += -35; notes.push(`ETH ${pctFrom200.toFixed(1)}% below 200DMA — deep correction, strong buy`); }
    else if (pctFrom200 < -10) { score += -18; notes.push(`ETH ${pctFrom200.toFixed(1)}% below 200DMA — correction, buy`); }
    else if (pctFrom200 < -5)  { score += -8;  notes.push(`ETH ${pctFrom200.toFixed(1)}% below 200DMA — testing regime`); }
    else if (pctFrom200 < 30)  {
      if (pctFrom200 > 10) { score += -3; notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — trending bull regime`); }
      else { notes.push(`ETH ${pctFrom200.toFixed(1)}% vs 200DMA — regime healthy`); }
    }
    else if (pctFrom200 < 60)  { score += 10;  notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — extended`); }
    else if (pctFrom200 < 100) { score += 22;  notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — parabolic extension`); }
    else                       { score += 35;  notes.push(`ETH >2x 200DMA — extreme extension`); }
  }
  else if (price && sma50) {
    const pctFromSMA = ((price - sma50) / sma50) * 100;
    if (isASML) {
      if (pctFromSMA < -12)      { score += -15; notes.push(`ASML ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -6)  { score += -8;  notes.push(`ASML ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 18)  { score += 6;   notes.push(`ASML ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 10)  { score += 2;   notes.push(`ASML ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isENB) {
      if (pctFromSMA < -8)       { score += -12; notes.push(`ENB ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -4)  { score += -5;  notes.push(`ENB ${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   notes.push(`ENB ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 5)   { score += 2;   }
    } else if (isLIN) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`LIN ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`LIN ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`LIN ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`LIN ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isMSFT) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`MSFT ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`MSFT ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`MSFT ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`MSFT ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isLHX) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`LHX ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`LHX ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`LHX ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`LHX ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isTMO) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`TMO ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`TMO ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`TMO ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`TMO ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isNOW) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`NOW ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`NOW ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`NOW ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`NOW ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isMA) {
      if (pctFromSMA < -10)      { score += -15; notes.push(`Mastercard ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -4)  { score += -8;  notes.push(`Mastercard ${pctFromSMA.toFixed(1)}% below SMA50 — pullback (low-vol compounder)`); }
      else if (pctFromSMA > 15)  { score += 6;   notes.push(`Mastercard ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`Mastercard ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isISRG) {
      if (pctFromSMA < -12)      { score += -15; notes.push(`ISRG ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -5)  { score += -8;  notes.push(`ISRG ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 18)  { score += 6;   notes.push(`ISRG ${pctFromSMA.toFixed(1)}% above SMA50 — extended (beta ~1.7 band)`); }
      else if (pctFromSMA > 10)  { score += 2;   notes.push(`ISRG ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isRDDT) {
      // Beta-1.94 bands: -20/-12/-6 down, +25/+15 up. RDDT sat ~20% below
      // SMA50 after the Q2 print without that being an extreme reading.
      if (pctFromSMA < -20)      { score += -15; notes.push(`RDDT ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -12) { score += -8;  notes.push(`RDDT ${pctFromSMA.toFixed(1)}% below SMA50 — meaningful pullback`); }
      else if (pctFromSMA < -6)  { score += -3;  notes.push(`RDDT ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 25)  { score += 6;   notes.push(`RDDT ${pctFromSMA.toFixed(1)}% above SMA50 — extended (beta-1.94 band)`); }
      else if (pctFromSMA > 15)  { score += 2;   notes.push(`RDDT ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else if (isMLM) {
      // Beta-1.11 bands: -12/-6 down, +14/+8 up. MLM sat ~7% below SMA50 after
      // the Q2'26 print, which on these bands is a genuine pullback reading.
      if (pctFromSMA < -12)      { score += -15; notes.push(`MLM ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -6)  { score += -8;  notes.push(`MLM ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 14)  { score += 6;   notes.push(`MLM ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 8)   { score += 2;   notes.push(`MLM ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else {
      if (pctFromSMA < -15)      { score += -10; notes.push(`${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA < -8)  { score += -5;  }
      else if (pctFromSMA > 15)  { score += 10;  notes.push(`${pctFromSMA.toFixed(1)}% above SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   }
    }
  }

  if (isENB && macro?.us10y != null) {
    const divYield = data.valuation?.dividendYield;
    if (divYield != null && divYield > 0) {
      const spreadPct = divYield - macro.us10y;
      const spreadBps = Math.round(spreadPct * 100);
      if (spreadBps > 400)      { score += -25; notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — deep value, historically strong buy`); }
      else if (spreadBps > 300) { score += -15; notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — attractive`); }
      else if (spreadBps > 200) { score += -5;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — fair`); }
      else if (spreadBps > 150) { score += 0;   notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — normal`); }
      else if (spreadBps > 100) { score += 8;   notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — getting rich`); }
      else if (spreadBps > 50)  { score += 15;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — expensive`); }
      else                      { score += 22;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — historically expensive`); }
    }
  }

  if (isAMKBY && macro?.gscpi != null) {
    const g = macro.gscpi;
    if (g > 2.0)       { score += 5;   notes.push(`GSCPI ${g}: crisis-level pressure — rates high but trade disrupted`); }
    else if (g > 1.0)  { score += 0;   notes.push(`GSCPI ${g}: elevated pressure — freight revenue tailwind`); }
    else if (g > 0.3)  { score += -3;  notes.push(`GSCPI ${g}: mildly above average — healthy shipping demand`); }
    else if (g > -0.3) { score += 0;   notes.push(`GSCPI ${g}: normal supply chain conditions`); }
    else if (g > -1.0) { score += 5;   notes.push(`GSCPI ${g}: below average — calm shipping, rate pressure`); }
    else               { score += 10;  notes.push(`GSCPI ${g}: very calm — freight trough territory`); }
  }

  if (isETHA && data.alt_season) {
    const spread = data.alt_season.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)        { score += -8; notes.push(`ETHA outperforming IBIT by ${spread}pp — strong alt-season rotation`); }
      else if (spread > 1)   { score += -4; notes.push(`ETHA outperforming IBIT by ${spread}pp — alt rotation`); }
      else if (spread > 0.3) { score += -2; notes.push(`ETHA mildly outperforming IBIT (${spread}pp)`); }
      else if (spread < -3)  { score += 8;  notes.push(`IBIT outperforming ETHA by ${(-spread).toFixed(2)}pp — BTC dominance, ETH headwind`); }
      else if (spread < -1)  { score += 4;  notes.push(`IBIT outperforming ETHA by ${(-spread).toFixed(2)}pp — BTC dominance`); }
      else                   { notes.push(`ETHA/IBIT spread: ${spread}pp — inline`); }
    }
  }

  if (isGLNCY && data.copper_regime) {
    const spread = data.copper_regime.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)        { score += -5; notes.push(`GLNCY outperforming COPX by ${spread}pp — diversification premium`); }
      else if (spread > 1)   { score += -2; notes.push(`GLNCY mildly outperforming COPX (${spread}pp)`); }
      else if (spread < -3)  { score += -8; notes.push(`COPX outperforming GLNCY by ${(-spread).toFixed(2)}pp — copper surging, GLNCY catch-up potential`); }
      else if (spread < -1)  { score += -3; notes.push(`COPX mildly outperforming GLNCY (${(-spread).toFixed(2)}pp)`); }
      else                   { notes.push(`GLNCY/COPX spread: ${spread}pp — inline`); }
    }
  }

  if (isGLNCY && macro?.hy_oas != null) {
    const oas = macro.hy_oas;
    if (oas < 300)      { score += -5; notes.push(`HY OAS ${oas}bps: tight — healthy commodity demand`); }
    else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
    else if (oas < 500) { score += 5;  notes.push(`HY OAS ${oas}bps: widening — commodity demand risk`); }
    else if (oas < 700) { score += 12; notes.push(`HY OAS ${oas}bps: stressed — commodity headwind`); }
    else                { score += 20; notes.push(`HY OAS ${oas}bps: crisis — industrial demand collapse`); }
  }

  if (isGLNCY && macro?.gscpi != null) {
    const g = macro.gscpi;
    if (g > 2.0)       { score += 3;   notes.push(`GSCPI ${g}: supply chain stress — commodity disruption`); }
    else if (g > 0.5)  { score += -3;  notes.push(`GSCPI ${g}: elevated — healthy industrial demand`); }
    else if (g > -0.5) { score += 0;   notes.push(`GSCPI ${g}: normal`); }
    else if (g > -1.0) { score += 3;   notes.push(`GSCPI ${g}: below average — industrial softness`); }
    else               { score += 8;   notes.push(`GSCPI ${g}: very calm — commodity demand trough`); }
  }

  if (isPBRA && macro?.wti != null) {
    const wti = macro.wti;
    if (wti > 90)       { score += -8; notes.push(`WTI $${wti}: strong oil — PBR.A revenue tailwind`); }
    else if (wti > 80)  { score += -5; notes.push(`WTI $${wti}: healthy oil price`); }
    else if (wti > 70)  { score += -2; notes.push(`WTI $${wti}: supportive`); }
    else if (wti > 60)  { score += 0;  notes.push(`WTI $${wti}: normal range`); }
    else if (wti > 50)  { score += 8;  notes.push(`WTI $${wti}: soft oil — PBR.A margin pressure`); }
    else if (wti > 40)  { score += 15; notes.push(`WTI $${wti}: weak oil — PBR.A headwind`); }
    else                { score += 22; notes.push(`WTI $${wti}: oil crisis — PBR.A under severe pressure`); }
  }

  // ─── LIN-SPECIFIC POSITIONAL ADD-ONS (V3) ────────────────────────────────
  if (isLIN && data.peer_relative) {
    const spread = data.peer_relative.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)       { score += 3;  notes.push(`LIN outperforming APD by ${spread}pp (1m) — quality premium extending`); }
      else if (spread > 1)  { score += 1;  notes.push(`LIN mildly outperforming APD (${spread}pp)`); }
      else if (spread < -3) { score += -5; notes.push(`APD outperforming LIN by ${(-spread).toFixed(2)}pp — LIN catch-up potential`); }
      else if (spread < -1) { score += -2; notes.push(`APD mildly outperforming LIN (${(-spread).toFixed(2)}pp)`); }
      else                  { notes.push(`LIN/APD spread: ${spread}pp — inline`); }
    }
  }

  if (isLIN && data.peer_relative_aipa) {
    const spread = data.peer_relative_aipa.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)       { score += 2;  notes.push(`LIN outperforming AI.PA by ${spread}pp (1m) — leading both peers`); }
      else if (spread > 1)  { score += 1;  }
      else if (spread < -3) { score += -3; notes.push(`AI.PA outperforming LIN by ${(-spread).toFixed(2)}pp — triangulation supports buy`); }
      else if (spread < -1) { score += -1; }
    }
  }

  if (isLIN && data.fundamentals?.asu_utilization_pct != null) {
    const u = data.fundamentals.asu_utilization_pct;
    if (u > 90)      { score += -8; notes.push(`ASU util ${u.toFixed(1)}%: very tight — strong pricing power`); }
    else if (u > 85) { score += -5; notes.push(`ASU util ${u.toFixed(1)}%: tight — pricing power`); }
    else if (u > 80) { score += -2; notes.push(`ASU util ${u.toFixed(1)}%: healthy utilization`); }
    else if (u > 75) { score += 0;  notes.push(`ASU util ${u.toFixed(1)}%: normal range`); }
    else if (u > 70) { score += 4;  notes.push(`ASU util ${u.toFixed(1)}%: loose — margin compression risk`); }
    else             { score += 8;  notes.push(`ASU util ${u.toFixed(1)}%: significant slack — margin pressure`); }
  }

  if (isLIN && data.fundamentals?.price_mix_ex_fx_pct != null) {
    const px = data.fundamentals.price_mix_ex_fx_pct;
    if (px > 3)       { score += -6; notes.push(`Price/mix ex-FX +${px.toFixed(1)}%: strong moat — pricing power durable`); }
    else if (px > 2)  { score += -4; notes.push(`Price/mix ex-FX +${px.toFixed(1)}%: moat working`); }
    else if (px > 1)  { score += -1; notes.push(`Price/mix ex-FX +${px.toFixed(1)}%: positive`); }
    else if (px > 0)  { score += 1;  notes.push(`Price/mix ex-FX +${px.toFixed(1)}%: weak`); }
    else if (px > -1) { score += 5;  notes.push(`Price/mix ex-FX ${px.toFixed(1)}%: flat-to-negative — moat eroding?`); }
    else              { score += 10; notes.push(`Price/mix ex-FX ${px.toFixed(1)}%: negative — moat erosion warning`); }
  }

  if (isLIN && macro?.bbb_oas_bps != null) {
    const oas = macro.bbb_oas_bps;
    if (oas < 100)      { score += -3; notes.push(`BBB OAS ${oas}bps: tight — capital allocation tailwind`); }
    else if (oas < 130) { score += -1; notes.push(`BBB OAS ${oas}bps: tight-normal`); }
    else if (oas < 160) { score += 0;  notes.push(`BBB OAS ${oas}bps: normal`); }
    else if (oas < 200) { score += 4;  notes.push(`BBB OAS ${oas}bps: widening — project sanctioning risk`); }
    else                { score += 8;  notes.push(`BBB OAS ${oas}bps: wide — backlog headwind 6-12mo`); }

    const change = macro.bbb_oas_1m_change_bps;
    if (change != null) {
      if (change > 30)       { score += 3;  notes.push(`BBB OAS +${change}bps/1m: rapidly widening — sanctioning slows`); }
      else if (change > 15)  { score += 2;  notes.push(`BBB OAS +${change}bps/1m: widening`); }
      else if (change < -20) { score += -2; notes.push(`BBB OAS ${change}bps/1m: tightening — capital cost falling`); }
    }
  }

  if (isLIN && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isLIN && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  if (isLIN) {
    const us = macro?.us_ism;
    const eu = macro?.eu_pmi;
    const cn = macro?.china_pmi;
    const pmis = [[us, 0.40], [eu, 0.30], [cn, 0.30]].filter(([v]) => v != null);
    if (pmis.length > 0) {
      const totalW = pmis.reduce((a, [, w]) => a + w, 0);
      const wAvg = pmis.reduce((a, [v, w]) => a + v * w, 0) / totalW;
      const wAvgFmt = wAvg.toFixed(1);
      if (wAvg > 53)      { score += -3; notes.push(`Geo-wgt PMI ${wAvgFmt} (n=${pmis.length}, 40/30/30): broad expansion — industrial gas tailwind`); }
      else if (wAvg > 51) { score += -1; notes.push(`Geo-wgt PMI ${wAvgFmt}: mild expansion`); }
      else if (wAvg > 49) { score += 0;  notes.push(`Geo-wgt PMI ${wAvgFmt}: neutral`); }
      else if (wAvg > 47) { score += 3;  notes.push(`Geo-wgt PMI ${wAvgFmt}: mild contraction — modest headwind`); }
      else                { score += 6;  notes.push(`Geo-wgt PMI ${wAvgFmt}: broad contraction — demand headwind`); }
    }
  }

  // ─── MSFT-SPECIFIC POSITIONAL ADD-ONS (V1) ───────────────────────────────
  if (isMSFT && data.fundamentals?.azure_growth_cc_pct != null) {
    const a = data.fundamentals.azure_growth_cc_pct;
    if (a > 30)      { score += -8; notes.push(`Azure CC growth ${a.toFixed(1)}%: accelerating — AI thesis confirmation`); }
    else if (a > 28) { score += -5; notes.push(`Azure CC growth ${a.toFixed(1)}%: strong acceleration`); }
    else if (a > 25) { score += -2; notes.push(`Azure CC growth ${a.toFixed(1)}%: healthy`); }
    else if (a > 22) { score += 0;  notes.push(`Azure CC growth ${a.toFixed(1)}%: in normal range`); }
    else if (a > 18) { score += 4;  notes.push(`Azure CC growth ${a.toFixed(1)}%: maturing — watch deceleration`); }
    else if (a > 15) { score += 8;  notes.push(`Azure CC growth ${a.toFixed(1)}%: decelerating — thesis-risk territory`); }
    else             { score += 14; notes.push(`Azure CC growth ${a.toFixed(1)}%: weak — thesis impairment`); }
  }

  if (isMSFT && data.fundamentals?.operating_margin_pct != null) {
    const om = data.fundamentals.operating_margin_pct;
    if (om > 46)      { score += -3; notes.push(`MSFT op margin ${om}%: peer-best execution`); }
    else if (om > 44) { score += -1; notes.push(`MSFT op margin ${om}%: best-in-class`); }
    else if (om > 42) { score += 0;  notes.push(`MSFT op margin ${om}%: normal`); }
    else if (om > 40) { score += 3;  notes.push(`MSFT op margin ${om}%: compressing (capex absorption?)`); }
    else              { score += 7;  notes.push(`MSFT op margin ${om}%: significant compression`); }
  }

  if (isMSFT && data.fundamentals?.fcf_margin_pct != null) {
    const fm = data.fundamentals.fcf_margin_pct;
    if (fm > 30)      { score += -3; notes.push(`MSFT FCF margin ${fm.toFixed(1)}%: pre-AI-capex normal`); }
    else if (fm > 28) { score += -1; notes.push(`MSFT FCF margin ${fm.toFixed(1)}%: healthy`); }
    else if (fm > 25) { score += 0;  notes.push(`MSFT FCF margin ${fm.toFixed(1)}%: capex absorbing`); }
    else if (fm > 22) { score += 3;  notes.push(`MSFT FCF margin ${fm.toFixed(1)}%: compressing — capex pressure`); }
    else              { score += 7;  notes.push(`MSFT FCF margin ${fm.toFixed(1)}%: sharp compression — watch`); }
  }

  if (isMSFT && data.fundamentals?.capex_yoy_growth_pct != null) {
    const cx = data.fundamentals.capex_yoy_growth_pct;
    if (cx > 80)      { score += 3;  notes.push(`Capex +${cx.toFixed(0)}% YoY: peak intensity — margin pressure but moat building`); }
    else if (cx > 50) { score += 1;  notes.push(`Capex +${cx.toFixed(0)}% YoY: high — AI cycle peak`); }
    else if (cx > 25) { score += 0;  notes.push(`Capex +${cx.toFixed(0)}% YoY: expansion phase`); }
    else if (cx > 10) { score += -1; notes.push(`Capex +${cx.toFixed(0)}% YoY: moderating — FCF recovery`); }
    else if (cx > 0)  { score += -3; notes.push(`Capex +${cx.toFixed(0)}% YoY: peak passing — FCF normalizing`); }
    else              { score += -5; notes.push(`Capex ${cx.toFixed(0)}% YoY: contracting — thesis impairment OR efficient build`); }
  }

  if (isMSFT && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isMSFT && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  // ─── LHX-SPECIFIC POSITIONAL ADD-ONS (V7.5) ──────────────────────────────
  // ITA defense sector factor flow — defense bid mechanical
  if (isLHX && data.factor_flow?.ita_vs_spy_30d_pp != null) {
    const i = data.factor_flow.ita_vs_spy_30d_pp;
    if (i > 2)       { score += -5; notes.push(`ITA +${i.toFixed(1)}pp vs SPY (30d): strong defense bid — LHX tailwind`); }
    else if (i > 1)  { score += -2; notes.push(`ITA +${i.toFixed(1)}pp vs SPY (30d): defense bid active`); }
    else if (i < -2) { score += 3;  notes.push(`ITA ${i.toFixed(1)}pp vs SPY (30d): defense sector lagging`); }
    else if (i < -1) { score += 1;  }
  }

  // Book-to-bill (fundamentals null-safe — LLM sources via web search)
  if (isLHX && data.fundamentals?.book_to_bill != null) {
    const bb = data.fundamentals.book_to_bill;
    if (bb > 1.15)      { score += -10; notes.push(`LHX B/B ${bb.toFixed(2)}: strongly accelerating — backlog expanding`); }
    else if (bb > 1.10) { score += -7;  notes.push(`LHX B/B ${bb.toFixed(2)}: accelerating — positional buy`); }
    else if (bb > 1.00) { score += -3;  notes.push(`LHX B/B ${bb.toFixed(2)}: healthy — replacing revenue`); }
    else if (bb > 0.95) { score += 3;   notes.push(`LHX B/B ${bb.toFixed(2)}: stable but no growth`); }
    else if (bb > 0.90) { score += 8;   notes.push(`LHX B/B ${bb.toFixed(2)}: backlog shrinking — thesis risk`); }
    else                { score += 15;  notes.push(`LHX B/B ${bb.toFixed(2)}: backlog erosion — caution`); }
  }

  // Backlog YoY growth
  if (isLHX && data.fundamentals?.backlog_growth_yoy_pct != null) {
    const bg = data.fundamentals.backlog_growth_yoy_pct;
    if (bg > 12)      { score += -8; notes.push(`Backlog YoY +${bg.toFixed(1)}%: strong expansion`); }
    else if (bg > 8)  { score += -5; notes.push(`Backlog YoY +${bg.toFixed(1)}%: expansion`); }
    else if (bg > 3)  { score += -2; notes.push(`Backlog YoY +${bg.toFixed(1)}%: healthy`); }
    else if (bg > 0)  { score += 0;  notes.push(`Backlog YoY +${bg.toFixed(1)}%: stable`); }
    else if (bg > -5) { score += 5;  notes.push(`Backlog YoY ${bg.toFixed(1)}%: erosion`); }
    else              { score += 10; notes.push(`Backlog YoY ${bg.toFixed(1)}%: significant decline`); }
  }

  // Op margin (defense prime norm 14-17%)
  if (isLHX && data.fundamentals?.op_margin_pct != null) {
    const om = data.fundamentals.op_margin_pct;
    if (om > 17)      { score += -3; notes.push(`LHX op margin ${om.toFixed(1)}%: strong execution`); }
    else if (om > 15) { score += -1; notes.push(`LHX op margin ${om.toFixed(1)}%: healthy`); }
    else if (om > 13) { score += 2;  notes.push(`LHX op margin ${om.toFixed(1)}%: compressing`); }
    else              { score += 6;  notes.push(`LHX op margin ${om.toFixed(1)}%: under pressure`); }
  }

  // FCF margin
  if (isLHX && data.fundamentals?.fcf_margin_pct != null) {
    const fcf = data.fundamentals.fcf_margin_pct;
    if (fcf > 13)      { score += -3; notes.push(`LHX FCF margin ${fcf.toFixed(1)}%: strong`); }
    else if (fcf > 10) { score += -1; notes.push(`LHX FCF margin ${fcf.toFixed(1)}%: healthy`); }
    else if (fcf > 8)  { score += 2;  notes.push(`LHX FCF margin ${fcf.toFixed(1)}%: working capital absorbing`); }
    else               { score += 6;  notes.push(`LHX FCF margin ${fcf.toFixed(1)}%: compressed`); }
  }

  // EPS revisions
  if (isLHX && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isLHX && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  // ─── TMO-SPECIFIC POSITIONAL ADD-ONS (V7.5) ──────────────────────────────
  // QUAL factor flow — quality bid mechanical (same data as LIN/MSFT)
  if (isTMO && data.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = data.factor_flow.qual_vs_spy_30d_pp;
    if (q > 2)       { score += -3; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): strong quality bid — TMO benefits`); }
    else if (q > 1)  { score += -1; notes.push(`QUAL +${q.toFixed(1)}pp vs SPY (30d): quality bid active`); }
    else if (q < -2) { score += 3;  notes.push(`QUAL ${q.toFixed(1)}pp vs SPY (30d): quality factor under pressure`); }
    else if (q < -1) { score += 1;  }
  }

  // XBI 90d biotech funding lead indicator (leads TMO bookings 2-3Q)
  if (isTMO && data.biotech_overlay?.xbi_90d_return_pct != null) {
    const x = data.biotech_overlay.xbi_90d_return_pct;
    if (x > 20)       { score += -10; notes.push(`XBI 90d +${x.toFixed(1)}%: strong biotech funding thaw — TMO bookings tailwind ahead`); }
    else if (x > 10)  { score += -6;  notes.push(`XBI 90d +${x.toFixed(1)}%: biotech thawing — tailwind ahead`); }
    else if (x > 0)   { score += -2;  notes.push(`XBI 90d +${x.toFixed(1)}%: mild biotech recovery`); }
    else if (x > -10) { score += 3;   notes.push(`XBI 90d ${x.toFixed(1)}%: biotech soft — bookings headwind ahead`); }
    else if (x > -20) { score += 7;   notes.push(`XBI 90d ${x.toFixed(1)}%: biotech funding frozen — significant headwind`); }
    else              { score += 12;  notes.push(`XBI 90d ${x.toFixed(1)}%: severe biotech retrenchment`); }
  }

  // TMO vs DHR 30d spread (peer triangulation)
  if (isTMO && data.tactical_extras?.tmo_vs_dhr_30d_pp != null) {
    const sp = data.tactical_extras.tmo_vs_dhr_30d_pp;
    if (sp > 3)       { score += 2;  notes.push(`TMO outperforming DHR by ${sp}pp (30d) — quality leadership`); }
    else if (sp > 1)  { score += 1;  }
    else if (sp < -3) { score += -4; notes.push(`DHR outperforming TMO by ${(-sp).toFixed(2)}pp (30d) — catch-up potential`); }
    else if (sp < -1) { score += -2; }
  }

  // Organic growth (THE central operational metric — null-safe, LLM sources)
  if (isTMO && data.fundamentals?.organic_growth_pct != null) {
    const og = data.fundamentals.organic_growth_pct;
    if (og > 8)       { score += -8; notes.push(`Organic growth +${og.toFixed(1)}%: strong acceleration — cycle confirmation`); }
    else if (og > 5)  { score += -5; notes.push(`Organic growth +${og.toFixed(1)}%: healthy expansion`); }
    else if (og > 3)  { score += -2; notes.push(`Organic growth +${og.toFixed(1)}%: early recovery`); }
    else if (og > 1)  { score += 0;  notes.push(`Organic growth +${og.toFixed(1)}%: trough/bottoming`); }
    else if (og > -2) { score += 3;  notes.push(`Organic growth ${og.toFixed(1)}%: flat-to-contracting`); }
    else              { score += 6;  notes.push(`Organic growth ${og.toFixed(1)}%: contraction`); }
  }

  // Bioprocessing phase (categorical — late-trough buy bias, peak trim bias)
  if (isTMO && data.fundamentals?.bioprocessing_phase) {
    const bp = String(data.fundamentals.bioprocessing_phase).toLowerCase();
    if (bp === "early_recovery")  { score += -8; notes.push(`Bioproc phase: EARLY_RECOVERY — cycle confirmation buy`); }
    else if (bp === "bottoming")  { score += -5; notes.push(`Bioproc phase: BOTTOMING — late-trough setup`); }
    else if (bp === "destocking") { score += -3; notes.push(`Bioproc phase: DESTOCKING — late-trough contrarian`); }
    else if (bp === "expansion")  { score += 2;  notes.push(`Bioproc phase: EXPANSION — mid-cycle`); }
    else if (bp === "peak")       { score += 8;  notes.push(`Bioproc phase: PEAK — trim bias`); }
  }

  // Op margin (TMO peak ~24-26%)
  if (isTMO && data.fundamentals?.op_margin_pct != null) {
    const om = data.fundamentals.op_margin_pct;
    if (om > 25)      { score += -3; notes.push(`TMO op margin ${om.toFixed(1)}%: peak execution`); }
    else if (om > 23) { score += -1; notes.push(`TMO op margin ${om.toFixed(1)}%: healthy`); }
    else if (om > 21) { score += 2;  notes.push(`TMO op margin ${om.toFixed(1)}%: compressing`); }
    else              { score += 6;  notes.push(`TMO op margin ${om.toFixed(1)}%: significant compression`); }
  }

  // FCF margin
  if (isTMO && data.fundamentals?.fcf_margin_pct != null) {
    const fcf = data.fundamentals.fcf_margin_pct;
    if (fcf > 19)      { score += -3; notes.push(`TMO FCF margin ${fcf.toFixed(1)}%: strong`); }
    else if (fcf > 16) { score += -1; notes.push(`TMO FCF margin ${fcf.toFixed(1)}%: pre-cycle healthy`); }
    else if (fcf > 13) { score += 2;  notes.push(`TMO FCF margin ${fcf.toFixed(1)}%: working capital absorbing`); }
    else               { score += 6;  notes.push(`TMO FCF margin ${fcf.toFixed(1)}%: significant compression`); }
  }

  // EPS revisions
  if (isTMO && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isTMO && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  // ─── NOW-SPECIFIC POSITIONAL ADD-ONS (V7.6) ──────────────────────────────
  // IGV software sector factor flow — software bid mechanical
  if (isNOW && data.factor_flow?.igv_vs_spy_30d_pp != null) {
    const i = data.factor_flow.igv_vs_spy_30d_pp;
    if (i > 2)       { score += -5; notes.push(`IGV +${i.toFixed(1)}pp vs SPY (30d): strong software bid — NOW tailwind`); }
    else if (i > 1)  { score += -2; notes.push(`IGV +${i.toFixed(1)}pp vs SPY (30d): software bid active`); }
    else if (i < -2) { score += 3;  notes.push(`IGV ${i.toFixed(1)}pp vs SPY (30d): software sector lagging`); }
    else if (i < -1) { score += 1;  }
  }

  // cRPO growth — THE central operational metric for SaaS subscription health.
  // Leading indicator of next 12 months subscription revenue.
  if (isNOW && data.fundamentals?.crpo_growth_pct != null) {
    const c = data.fundamentals.crpo_growth_pct;
    if (c > 25)      { score += -10; notes.push(`cRPO growth +${c.toFixed(1)}%: strong acceleration — subscription thesis confirmation`); }
    else if (c > 22) { score += -7;  notes.push(`cRPO growth +${c.toFixed(1)}%: accelerating`); }
    else if (c > 20) { score += -4;  notes.push(`cRPO growth +${c.toFixed(1)}%: healthy expansion`); }
    else if (c > 18) { score += 0;   notes.push(`cRPO growth +${c.toFixed(1)}%: in healthy range`); }
    else if (c > 16) { score += 3;   notes.push(`cRPO growth +${c.toFixed(1)}%: maturing — watch deceleration`); }
    else if (c > 14) { score += 6;   notes.push(`cRPO growth +${c.toFixed(1)}%: decelerating — caution`); }
    else             { score += 12;  notes.push(`cRPO growth +${c.toFixed(1)}%: thesis-risk territory`); }
  }

  // Subscription revenue growth
  if (isNOW && data.fundamentals?.subscription_growth_pct != null) {
    const s = data.fundamentals.subscription_growth_pct;
    if (s > 24)      { score += -5; notes.push(`Subs growth +${s.toFixed(1)}%: strong acceleration`); }
    else if (s > 22) { score += -3; notes.push(`Subs growth +${s.toFixed(1)}%: healthy expansion`); }
    else if (s > 20) { score += -1; notes.push(`Subs growth +${s.toFixed(1)}%: healthy`); }
    else if (s > 18) { score += 0;  notes.push(`Subs growth +${s.toFixed(1)}%: normal range`); }
    else if (s > 16) { score += 3;  notes.push(`Subs growth +${s.toFixed(1)}%: decelerating`); }
    else             { score += 7;  notes.push(`Subs growth +${s.toFixed(1)}%: weak`); }
  }

  // $1M+ ACV deal count YoY growth — enterprise traction read
  if (isNOW && data.fundamentals?.large_deals_growth_pct != null) {
    const ld = data.fundamentals.large_deals_growth_pct;
    if (ld > 40)      { score += -6; notes.push(`$1M+ deals +${ld.toFixed(0)}% YoY: enterprise traction strong`); }
    else if (ld > 30) { score += -3; notes.push(`$1M+ deals +${ld.toFixed(0)}% YoY: accelerating`); }
    else if (ld > 20) { score += -1; notes.push(`$1M+ deals +${ld.toFixed(0)}% YoY: healthy`); }
    else if (ld > 10) { score += 2;  notes.push(`$1M+ deals +${ld.toFixed(0)}% YoY: slowing`); }
    else if (ld > 0)  { score += 5;  notes.push(`$1M+ deals +${ld.toFixed(0)}% YoY: enterprise softness`); }
    else              { score += 10; notes.push(`$1M+ deals ${ld.toFixed(0)}% YoY: contraction — enterprise budget cuts`); }
  }

  // Federal/Government revenue growth — structural secular tailwind
  if (isNOW && data.fundamentals?.federal_growth_pct != null) {
    const fg = data.fundamentals.federal_growth_pct;
    if (fg > 30)      { score += -5; notes.push(`Federal growth +${fg.toFixed(1)}%: secular tailwind active`); }
    else if (fg > 25) { score += -3; notes.push(`Federal growth +${fg.toFixed(1)}%: strong tailwind`); }
    else if (fg > 15) { score += -1; notes.push(`Federal growth +${fg.toFixed(1)}%: healthy`); }
    else if (fg > 10) { score += 0;  notes.push(`Federal growth +${fg.toFixed(1)}%: normal`); }
    else if (fg > 0)  { score += 3;  notes.push(`Federal growth +${fg.toFixed(1)}%: budget/political overhang`); }
    else              { score += 7;  notes.push(`Federal growth ${fg.toFixed(1)}%: significant overhang`); }
  }

  // Op margin (NOW non-GAAP target ~30%)
  if (isNOW && data.fundamentals?.op_margin_pct != null) {
    const om = data.fundamentals.op_margin_pct;
    if (om > 32)      { score += -3; notes.push(`NOW op margin ${om.toFixed(1)}%: peak execution`); }
    else if (om > 30) { score += -1; notes.push(`NOW op margin ${om.toFixed(1)}%: healthy`); }
    else if (om > 28) { score += 0;  notes.push(`NOW op margin ${om.toFixed(1)}%: normal`); }
    else if (om > 26) { score += 3;  notes.push(`NOW op margin ${om.toFixed(1)}%: compressing (AI cost absorption?)`); }
    else              { score += 7;  notes.push(`NOW op margin ${om.toFixed(1)}%: significant compression`); }
  }

  // FCF margin (NOW historically 32%+)
  if (isNOW && data.fundamentals?.fcf_margin_pct != null) {
    const fcf = data.fundamentals.fcf_margin_pct;
    if (fcf > 34)      { score += -3; notes.push(`NOW FCF margin ${fcf.toFixed(1)}%: strong`); }
    else if (fcf > 32) { score += -1; notes.push(`NOW FCF margin ${fcf.toFixed(1)}%: healthy`); }
    else if (fcf > 30) { score += 0;  notes.push(`NOW FCF margin ${fcf.toFixed(1)}%: normal`); }
    else if (fcf > 28) { score += 2;  notes.push(`NOW FCF margin ${fcf.toFixed(1)}%: compressing`); }
    else               { score += 5;  notes.push(`NOW FCF margin ${fcf.toFixed(1)}%: significant compression`); }
  }

  // Now Assist traction (categorical — AI monetization read)
  if (isNOW && data.fundamentals?.now_assist_traction) {
    const na = String(data.fundamentals.now_assist_traction).toLowerCase();
    if (na === "strong")        { score += -5; notes.push(`Now Assist traction: STRONG — Pro Plus AI monetization confirming`); }
    else if (na === "moderate") { score += -2; notes.push(`Now Assist traction: moderate`); }
    else if (na === "early")    { score += 1;  notes.push(`Now Assist traction: early stages`); }
    else if (na === "unclear")  { score += 4;  notes.push(`Now Assist traction: unclear — AI monetization watch`); }
  }

  // AI Agent Platform status (categorical — thesis-level structural variable)
  if (isNOW && data.fundamentals?.ai_agent_platform_status) {
    const ap = String(data.fundamentals.ai_agent_platform_status).toLowerCase();
    if (ap === "structural_moat") { score += -3; notes.push(`AI Agent Platform: STRUCTURAL MOAT — workflow agentic AI thesis intact`); }
    else if (ap === "stable")     { score += 0;  notes.push(`AI Agent Platform: stable`); }
    else if (ap === "uncertain")  { score += 4;  notes.push(`AI Agent Platform: uncertain — watch`); }
    else if (ap === "deteriorating") { score += 15; notes.push(`AI Agent Platform: DETERIORATING — thesis impairment risk`); }
  }

  // EPS revisions
  if (isNOW && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isNOW && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  // ─── MA POSITIONAL (V8.2): VOLUMES + VAS + REBATES + BUYBACK ──────────────
  // Cross-border volume growth — THE central operational metric for MA.
  // Highest-yield volume, cleanest read on travel/consumer health, and the
  // fundamental truth the disruption narrative must eventually answer to.
  if (isMA && data.fundamentals?.cross_border_growth_pct != null) {
    const cb = data.fundamentals.cross_border_growth_pct;
    if (cb > 15)      { score += -10; notes.push(`Cross-border +${cb.toFixed(1)}%: accelerating — volumes refute the disruption narrative`); }
    else if (cb > 12) { score += -7;  notes.push(`Cross-border +${cb.toFixed(1)}%: strong`); }
    else if (cb > 10) { score += -4;  notes.push(`Cross-border +${cb.toFixed(1)}%: healthy`); }
    else if (cb > 8)  { score += 0;   notes.push(`Cross-border +${cb.toFixed(1)}%: normal range`); }
    else if (cb > 6)  { score += 4;   notes.push(`Cross-border +${cb.toFixed(1)}%: moderating — watch travel/spend cycle`); }
    else              { score += 10;  notes.push(`Cross-border +${cb.toFixed(1)}%: weak — spend cycle rolling, thesis-risk (a REAL warning, unlike headlines)`); }
  }

  // Gross dollar volume growth — consumer health confirmation
  if (isMA && data.fundamentals?.gdv_growth_pct != null) {
    const g = data.fundamentals.gdv_growth_pct;
    if (g > 10)      { score += -4; notes.push(`GDV +${g.toFixed(1)}%: strong consumer`); }
    else if (g > 8)  { score += -2; notes.push(`GDV +${g.toFixed(1)}%: healthy`); }
    else if (g > 6)  { score += 0;  notes.push(`GDV +${g.toFixed(1)}%: normal`); }
    else if (g > 5)  { score += 2;  notes.push(`GDV +${g.toFixed(1)}%: softening`); }
    else             { score += 6;  notes.push(`GDV +${g.toFixed(1)}%: consumer weakening`); }
  }

  // Switched transactions growth — network share read (actual erosion vs narrative)
  if (isMA && data.fundamentals?.switched_txn_growth_pct != null) {
    const st = data.fundamentals.switched_txn_growth_pct;
    if (st > 10)     { score += -3; notes.push(`Switched txns +${st.toFixed(1)}%: network share intact`); }
    else if (st > 8) { score += -1; notes.push(`Switched txns +${st.toFixed(1)}%: healthy`); }
    else if (st > 6) { score += 0;  notes.push(`Switched txns +${st.toFixed(1)}%: normal`); }
    else             { score += 6;  notes.push(`Switched txns +${st.toFixed(1)}%: share/volume warning — check for actual displacement`); }
  }

  // Value-added services growth — the ~38%-of-revenue leg the disruption bears ignore
  if (isMA && data.fundamentals?.vas_growth_pct != null) {
    const v = data.fundamentals.vas_growth_pct;
    if (v > 22)      { score += -6; notes.push(`VAS +${v.toFixed(1)}%: compounding leg firing — diversification thesis confirming`); }
    else if (v > 20) { score += -4; notes.push(`VAS +${v.toFixed(1)}%: strong`); }
    else if (v > 15) { score += -1; notes.push(`VAS +${v.toFixed(1)}%: healthy`); }
    else if (v > 12) { score += 0;  notes.push(`VAS +${v.toFixed(1)}%: normal`); }
    else             { score += 5;  notes.push(`VAS +${v.toFixed(1)}%: diversification thesis stalling`); }
  }

  // Rebates & incentives discipline — pricing power read
  if (isMA && data.fundamentals?.rebates_incentives_trend) {
    const rt = String(data.fundamentals.rebates_incentives_trend).toLowerCase();
    if (rt === "lagging_gross")        { score += -3; notes.push(`Rebates lagging gross revenue: pricing power intact`); }
    else if (rt === "in_line")         { score += 0;  notes.push(`Rebates in line with gross revenue: normal`); }
    else if (rt === "outpacing_gross") { score += 6;  notes.push(`Rebates OUTPACING gross revenue: pricing pressure — issuer bargaining power rising`); }
  }

  // Adjusted op margin (MA ~58-60% peer-best baseline)
  if (isMA && data.fundamentals?.op_margin_pct != null) {
    const om = data.fundamentals.op_margin_pct;
    if (om > 60)      { score += -3; notes.push(`Mastercard op margin ${om.toFixed(1)}%: peak execution`); }
    else if (om > 58) { score += -1; notes.push(`Mastercard op margin ${om.toFixed(1)}%: peer-best`); }
    else if (om > 56) { score += 0;  notes.push(`Mastercard op margin ${om.toFixed(1)}%: normal`); }
    else if (om > 54) { score += 2;  notes.push(`Mastercard op margin ${om.toFixed(1)}%: compressing (rebate/investment pressure)`); }
    else              { score += 6;  notes.push(`Mastercard op margin ${om.toFixed(1)}%: significant compression`); }
  }

  // Buyback pace — ~2.3%/yr share retirement is the compounding baseline
  if (isMA && data.fundamentals?.buyback_share_reduction_yoy_pct != null) {
    const bb = data.fundamentals.buyback_share_reduction_yoy_pct;
    if (bb <= -2.5)     { score += -3; notes.push(`Buyback ${bb.toFixed(1)}% shares YoY: aggressive retirement`); }
    else if (bb <= -2)  { score += -2; notes.push(`Buyback ${bb.toFixed(1)}% shares YoY: on pace`); }
    else if (bb <= -1)  { score += 0;  notes.push(`Buyback ${bb.toFixed(1)}% shares YoY: steady`); }
    else                { score += 2;  notes.push(`Buyback ${bb.toFixed(1)}% shares YoY: pace slowing — watch`); }
  }

  // Stablecoin strategy execution (categorical — offense vs defense read)
  if (isMA && data.fundamentals?.stablecoin_strategy_execution) {
    const se = String(data.fundamentals.stablecoin_strategy_execution).toLowerCase();
    if (se === "leading")       { score += -4; notes.push(`Stablecoin execution: LEADING — BVNK/consortium/MTN playing offense`); }
    else if (se === "active")   { score += -2; notes.push(`Stablecoin execution: active`); }
    else if (se === "reactive") { score += 3;  notes.push(`Stablecoin execution: reactive — playing defense`); }
    else if (se === "absent")   { score += 7;  notes.push(`Stablecoin execution: ABSENT — disruption response missing`); }
  }

  // EPS revisions
  if (isMA && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -1) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -3) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isMA && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)       { score += -2; }
    else if (r30 < -1.5) { score += 2;  }
  }

  // ─── ISRG POSITIONAL (V8.2): PROCEDURES + DV5 + ION + ANNUITY ─────────────
  // IHI vs SPY 30d — devices sector factor bid
  if (isISRG && data.factor_flow?.ihi_vs_spy_30d_pp != null) {
    const i = data.factor_flow.ihi_vs_spy_30d_pp;
    if (i > 2)       { score += -5; notes.push(`IHI +${i.toFixed(1)}pp vs SPY (30d): strong devices bid — ISRG tailwind`); }
    else if (i > 1)  { score += -2; notes.push(`IHI +${i.toFixed(1)}pp vs SPY (30d): devices bid active`); }
    else if (i < -2) { score += 3;  notes.push(`IHI ${i.toFixed(1)}pp vs SPY (30d): devices sector lagging`); }
    else if (i < -1) { score += 1;  }
  }

  // Total procedure growth — THE central operational metric for ISRG.
  // The annuity's heartbeat and the cleanest competitive-erosion read.
  // 2026 dV guide 13.5-15.5%; <12% is the erosion tripwire (pair with
  // moat_status in strategic before treating as genuine erosion).
  if (isISRG && data.fundamentals?.procedure_growth_pct != null) {
    const pg = data.fundamentals.procedure_growth_pct;
    if (pg > 17)        { score += -10; notes.push(`Procedures +${pg.toFixed(1)}%: beating guide — annuity thesis confirmation, competition narrative refuted`); }
    else if (pg > 16)   { score += -7;  notes.push(`Procedures +${pg.toFixed(1)}%: above guide`); }
    else if (pg > 15)   { score += -4;  notes.push(`Procedures +${pg.toFixed(1)}%: upper guide range`); }
    else if (pg >= 13.5) { score += 0;  notes.push(`Procedures +${pg.toFixed(1)}%: in guide (13.5-15.5%)`); }
    else if (pg >= 12.5) { score += 4;  notes.push(`Procedures +${pg.toFixed(1)}%: below guide low — watch`); }
    else if (pg >= 12)   { score += 7;  notes.push(`Procedures +${pg.toFixed(1)}%: approaching erosion tripwire`); }
    else                 { score += 14; notes.push(`Procedures +${pg.toFixed(1)}%: EROSION TRIPWIRE (<12%) — check moat_status for competitor share evidence before concluding`); }
  }

  // dV system placements + dV5 upgrade-cycle mix
  if (isISRG && data.fundamentals?.dv_placements_qtr != null) {
    const dp = data.fundamentals.dv_placements_qtr;
    if (dp > 430)      { score += -3; notes.push(`dV placements ${dp}/qtr: capital cycle firing`); }
    else if (dp > 400) { score += -2; notes.push(`dV placements ${dp}/qtr: strong`); }
    else if (dp > 350) { score += 0;  notes.push(`dV placements ${dp}/qtr: normal`); }
    else if (dp > 300) { score += 2;  notes.push(`dV placements ${dp}/qtr: softening`); }
    else               { score += 5;  notes.push(`dV placements ${dp}/qtr: weak capital cycle`); }
  }
  if (isISRG && data.fundamentals?.dv5_mix_pct != null) {
    const dm = data.fundamentals.dv5_mix_pct;
    if (dm > 55)      { score += -3; notes.push(`dV5 mix ${dm.toFixed(0)}%: upgrade cycle firing`); }
    else if (dm > 50) { score += -2; notes.push(`dV5 mix ${dm.toFixed(0)}%: healthy upgrade demand`); }
    else if (dm > 40) { score += 0;  notes.push(`dV5 mix ${dm.toFixed(0)}%: normal`); }
    else              { score += 2;  notes.push(`dV5 mix ${dm.toFixed(0)}%: upgrade cycle slow`); }
  }

  // Ion — the second growth leg
  if (isISRG && data.fundamentals?.ion_procedure_growth_pct != null) {
    const ig = data.fundamentals.ion_procedure_growth_pct;
    if (ig > 35)      { score += -4; notes.push(`Ion procedures +${ig.toFixed(1)}%: second leg compounding`); }
    else if (ig > 30) { score += -3; notes.push(`Ion procedures +${ig.toFixed(1)}%: strong`); }
    else if (ig > 20) { score += -1; notes.push(`Ion procedures +${ig.toFixed(1)}%: healthy`); }
    else if (ig > 15) { score += 0;  notes.push(`Ion procedures +${ig.toFixed(1)}%: normal`); }
    else              { score += 3;  notes.push(`Ion procedures +${ig.toFixed(1)}%: second leg slowing`); }
  }

  // Recurring revenue share — the razor/blade annuity mix (~86% baseline)
  if (isISRG && data.fundamentals?.recurring_revenue_pct != null) {
    const rr = data.fundamentals.recurring_revenue_pct;
    if (rr >= 87)      { score += -3; notes.push(`Recurring ${rr.toFixed(0)}% of revenue: annuity mix strengthening`); }
    else if (rr >= 86) { score += -2; notes.push(`Recurring ${rr.toFixed(0)}% of revenue: baseline annuity intact`); }
    else if (rr >= 85) { score += 0;  notes.push(`Recurring ${rr.toFixed(0)}% of revenue: normal`); }
    else if (rr >= 84) { score += 2;  notes.push(`Recurring ${rr.toFixed(0)}% of revenue: mix softening`); }
    else               { score += 6;  notes.push(`Recurring ${rr.toFixed(0)}% of revenue: MIX WARNING (<84%) — annuity deteriorating`); }
  }

  // Instruments & accessories revenue growth — annuity health confirmation
  if (isISRG && data.fundamentals?.ia_revenue_growth_pct != null) {
    const ia = data.fundamentals.ia_revenue_growth_pct;
    if (ia > 18)      { score += -4; notes.push(`I&A revenue +${ia.toFixed(1)}%: annuity compounding`); }
    else if (ia > 15) { score += -2; notes.push(`I&A revenue +${ia.toFixed(1)}%: healthy`); }
    else if (ia > 12) { score += 0;  notes.push(`I&A revenue +${ia.toFixed(1)}%: normal`); }
    else if (ia > 10) { score += 2;  notes.push(`I&A revenue +${ia.toFixed(1)}%: slowing — early instrument-transition read?`); }
    else              { score += 5;  notes.push(`I&A revenue +${ia.toFixed(1)}%: weak — annuity pressure`); }
  }

  // Installed base growth — footprint compounding (~11,400 systems baseline)
  if (isISRG && data.fundamentals?.installed_base_yoy_pct != null) {
    const ib = data.fundamentals.installed_base_yoy_pct;
    if (ib > 12)      { score += -2; notes.push(`Installed base +${ib.toFixed(1)}% YoY: footprint compounding`); }
    else if (ib > 10) { score += -1; notes.push(`Installed base +${ib.toFixed(1)}% YoY: strong`); }
    else if (ib > 7)  { score += 0;  notes.push(`Installed base +${ib.toFixed(1)}% YoY: normal`); }
    else              { score += 2;  notes.push(`Installed base +${ib.toFixed(1)}% YoY: slowing`); }
  }

  // Non-GAAP op margin (ISRG ~37% baseline)
  if (isISRG && data.fundamentals?.op_margin_pct != null) {
    const om = data.fundamentals.op_margin_pct;
    if (om > 38)      { score += -3; notes.push(`ISRG op margin ${om.toFixed(1)}%: peak execution`); }
    else if (om > 36) { score += -1; notes.push(`ISRG op margin ${om.toFixed(1)}%: peer-best`); }
    else if (om > 34) { score += 0;  notes.push(`ISRG op margin ${om.toFixed(1)}%: normal`); }
    else if (om > 32) { score += 2;  notes.push(`ISRG op margin ${om.toFixed(1)}%: compressing (pricing/mix/tariff pressure)`); }
    else              { score += 6;  notes.push(`ISRG op margin ${om.toFixed(1)}%: significant compression`); }
  }

  // EPS revisions (ISRG trim threshold −2 per archetype config)
  if (isISRG && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -2) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -4) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isISRG && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 1.5)     { score += -2; }
    else if (r30 < -2) { score += 2;  }
  }

  // ─── RDDT POSITIONAL (V8.3): AD GROWTH + ARPU + AUDIENCE + LEVERAGE ───────
  // XLC vs SPY 30d — ads sector factor bid
  if (isRDDT && data.factor_flow?.xlc_vs_spy_30d_pp != null) {
    const x = data.factor_flow.xlc_vs_spy_30d_pp;
    if (x > 2)       { score += -5; notes.push(`XLC +${x.toFixed(1)}pp vs SPY (30d): strong ads bid — RDDT tailwind`); }
    else if (x > 1)  { score += -2; notes.push(`XLC +${x.toFixed(1)}pp vs SPY (30d): ads bid active`); }
    else if (x < -2) { score += 3;  notes.push(`XLC ${x.toFixed(1)}pp vs SPY (30d): ads complex lagging`); }
    else if (x < -1) { score += 1;  }
  }

  // Advertising revenue growth — THE central operational metric for RDDT.
  // Eight consecutive quarters above 60% through Q2'26 (64% ad growth).
  // Deceleration off a larger base is EXPECTED; below 35% is the tripwire
  // where the referral bear case is actually landing rather than merely feared.
  if (isRDDT && data.fundamentals?.ad_revenue_growth_yoy_pct != null) {
    const ag = data.fundamentals.ad_revenue_growth_yoy_pct;
    if (ag > 65)       { score += -10; notes.push(`Ad revenue +${ag.toFixed(1)}%: accelerating — referral narrative refuted by the print`); }
    else if (ag > 55)  { score += -7;  notes.push(`Ad revenue +${ag.toFixed(1)}%: strong — engine intact`); }
    else if (ag > 45)  { score += -3;  notes.push(`Ad revenue +${ag.toFixed(1)}%: healthy deceleration off a larger base`); }
    else if (ag >= 35) { score += 0;   notes.push(`Ad revenue +${ag.toFixed(1)}%: moderating — expected, not alarming`); }
    else if (ag >= 30) { score += 5;   notes.push(`Ad revenue +${ag.toFixed(1)}%: approaching the deceleration tripwire`); }
    else               { score += 14;  notes.push(`Ad revenue +${ag.toFixed(1)}%: DECELERATION TRIPWIRE (<35%) — the bear case is landing, not merely feared`); }
  }

  // ARPU expansion — monetization density is the growth engine, since the
  // audience is already built. Stalling ARPU breaks the thesis faster than
  // stalling users would.
  if (isRDDT && data.fundamentals?.arpu_growth_yoy_pct != null) {
    const ar = data.fundamentals.arpu_growth_yoy_pct;
    if (ar > 35)       { score += -6; notes.push(`ARPU +${ar.toFixed(1)}%: monetization ramp firing`); }
    else if (ar > 30)  { score += -4; notes.push(`ARPU +${ar.toFixed(1)}%: strong ramp`); }
    else if (ar > 20)  { score += -1; notes.push(`ARPU +${ar.toFixed(1)}%: healthy`); }
    else if (ar >= 15) { score += 0;  notes.push(`ARPU +${ar.toFixed(1)}%: normal`); }
    else               { score += 8;  notes.push(`ARPU +${ar.toFixed(1)}%: RAMP STALLING (<15%) — the monetization thesis is the thesis`); }
  }

  // International ARPU gap — US vs RoW. A WIDE gap is runway, not weakness.
  if (isRDDT && data.fundamentals?.arpu_us != null && data.fundamentals?.arpu_row != null && data.fundamentals.arpu_row > 0) {
    const gap = data.fundamentals.arpu_us / data.fundamentals.arpu_row;
    if (gap > 4.5)      { score += -3; notes.push(`Intl ARPU gap ${gap.toFixed(1)}x (US $${data.fundamentals.arpu_us} vs RoW $${data.fundamentals.arpu_row}): long monetization runway intact`); }
    else if (gap > 3.5) { score += -1; notes.push(`Intl ARPU gap ${gap.toFixed(1)}x: runway intact`); }
    else                { score += 0;  notes.push(`Intl ARPU gap ${gap.toFixed(1)}x: narrowing — runway partly harvested`); }
  }

  // DAUq growth — audience. Contested variable: logged-out DAU is SEO-driven.
  if (isRDDT && data.fundamentals?.dauq_growth_yoy_pct != null) {
    const dg = data.fundamentals.dauq_growth_yoy_pct;
    if (dg > 18)      { score += -3; notes.push(`DAUq +${dg.toFixed(1)}%: audience compounding`); }
    else if (dg > 15) { score += -2; notes.push(`DAUq +${dg.toFixed(1)}%: strong`); }
    else if (dg > 10) { score += 0;  notes.push(`DAUq +${dg.toFixed(1)}%: normal`); }
    else if (dg >= 8) { score += 2;  notes.push(`DAUq +${dg.toFixed(1)}%: slowing`); }
    else              { score += 6;  notes.push(`DAUq +${dg.toFixed(1)}%: weak (<8%) — audience problem, check referral status`); }
  }

  // ⚠ Logged-out DAU: Reddit DISCONTINUED the logged-in/logged-out split from
  // Q3 2026. This block only fires on historical rows that still carry it, and
  // is deliberately NOT backfilled — the pipeline emits null rather than an
  // estimate. Reduced observability on the single most thesis-relevant metric
  // is itself information, surfaced as a note when the split is unavailable.
  if (isRDDT) {
    if (data.fundamentals?.logged_out_dau_growth_pct != null) {
      const lo = data.fundamentals.logged_out_dau_growth_pct;
      if (lo > 20)      { score += -3; notes.push(`Logged-out DAU +${lo.toFixed(1)}%: SEO funnel healthy`); }
      else if (lo > 10) { score += -1; notes.push(`Logged-out DAU +${lo.toFixed(1)}%: funnel intact`); }
      else if (lo >= 0) { score += 3;  notes.push(`Logged-out DAU +${lo.toFixed(1)}%: funnel flattening — referral pressure visible`); }
      else              { score += 10; notes.push(`Logged-out DAU ${lo.toFixed(1)}%: DECLINING — the Google-referral falsifier in the data`); }
    } else if (data.fundamentals?.dau_disclosure_status === "aggregate_only") {
      notes.push(`Logged-in/out DAU split: DISCONTINUED by the company (Q3 2026+) — cleanest referral read withdrawn; not estimated`);
    }
  }

  // Adjusted EBITDA margin — operating leverage landing (43% in Q2'26)
  if (isRDDT && data.fundamentals?.ebitda_margin_pct != null) {
    const em = data.fundamentals.ebitda_margin_pct;
    if (em > 45)      { score += -4; notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: leverage compounding`); }
    else if (em > 42) { score += -2; notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: strong`); }
    else if (em > 36) { score += 0;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: normal`); }
    else if (em > 32) { score += 2;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: compressing`); }
    else              { score += 6;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: leverage reversing`); }
  }

  // FCF margin — cash conversion on a 90%+ gross margin, near-zero-capex model
  if (isRDDT && data.fundamentals?.fcf_margin_pct != null) {
    const fm = data.fundamentals.fcf_margin_pct;
    if (fm > 32)      { score += -3; notes.push(`FCF margin ${fm.toFixed(1)}%: cash conversion excellent`); }
    else if (fm > 28) { score += -2; notes.push(`FCF margin ${fm.toFixed(1)}%: strong`); }
    else if (fm > 20) { score += 0;  notes.push(`FCF margin ${fm.toFixed(1)}%: normal`); }
    else              { score += 3;  notes.push(`FCF margin ${fm.toFixed(1)}%: soft cash conversion`); }
  }

  // Next-quarter guide implied growth
  if (isRDDT && data.fundamentals?.guide_implied_growth_pct != null) {
    const gg = data.fundamentals.guide_implied_growth_pct;
    if (gg > 50)       { score += -4; notes.push(`Guide implies +${gg.toFixed(1)}% YoY: raise territory`); }
    else if (gg > 45)  { score += -2; notes.push(`Guide implies +${gg.toFixed(1)}% YoY: strong`); }
    else if (gg >= 40) { score += 0;  notes.push(`Guide implies +${gg.toFixed(1)}% YoY: in line`); }
    else if (gg >= 35) { score += 3;  notes.push(`Guide implies +${gg.toFixed(1)}% YoY: soft`); }
    else               { score += 6;  notes.push(`Guide implies +${gg.toFixed(1)}% YoY: guide-down territory`); }
  }

  // Stock-based comp trend — this is the DILUTION SOURCE for RDDT, tracked
  // positionally so the strategic dilution score has a leading indicator.
  if (isRDDT && data.fundamentals?.sbc_trend) {
    const sb = String(data.fundamentals.sbc_trend).toLowerCase();
    if (sb === "falling")     { score += -2; notes.push(`SBC trend falling — dilution pressure easing`); }
    else if (sb === "rising") { score += 2;  notes.push(`SBC trend rising — dilution pressure building (guided higher for Q3'26)`); }
  }

  // EPS revisions (RDDT thresholds +2 / -4 per archetype config — wider than
  // the compounders because consensus swings hard on a 60%-growth name)
  if (isRDDT && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 6)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 2)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -4) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -8) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isRDDT && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 3)       { score += -2; }
    else if (r30 < -4) { score += 2;  }
  }

  // ─── MLM POSITIONAL (V8.4): PRICING + VOLUME + UNIT MARGIN + END MARKETS ───
  // ★ ARCHITECTURAL RULE FOR THIS ARCHETYPE: pricing and volume are SEPARATE
  //   signals with separate drivers and are never conflated. Pricing is
  //   structural, near-unconditional, and historically RISES in recessions
  //   because a local monopoly does not evaporate when demand softens. Volume
  //   is cyclical and policy-driven. A quarter with weak volume and intact
  //   pricing is a CYCLE datapoint. A quarter with intact volume and broken
  //   pricing is a THESIS datapoint. The score weights them accordingly.

  // XLB vs SPY 30d — materials sector factor bid
  if (isMLM && data.factor_flow?.xlb_vs_spy_30d_pp != null) {
    const x = data.factor_flow.xlb_vs_spy_30d_pp;
    if (x > 2)       { score += -5; notes.push(`XLB +${x.toFixed(1)}pp vs SPY (30d): strong materials bid — MLM tailwind`); }
    else if (x > 1)  { score += -2; notes.push(`XLB +${x.toFixed(1)}pp vs SPY (30d): materials bid active`); }
    else if (x < -2) { score += 3;  notes.push(`XLB ${x.toFixed(1)}pp vs SPY (30d): materials complex lagging`); }
    else if (x < -1) { score += 1;  }
  }

  // ★★ MIX-ADJUSTED ORGANIC PRICING — THE moat, measured directly, and the
  // single highest-weighted operational input in this archetype. Aggregates
  // have no exchange price anywhere in the world, so the ability to raise
  // mix-adjusted organic price IS the local-monopoly test. Below 1% is the
  // cleanest falsifier in the whole model and carries a thesis-level penalty.
  if (isMLM && data.fundamentals?.mix_adjusted_organic_pricing_pct != null) {
    const px = data.fundamentals.mix_adjusted_organic_pricing_pct;
    if (px > 5)        { score += -12; notes.push(`Mix-adjusted organic pricing +${px.toFixed(1)}%: moat compounding above trend`); }
    else if (px > 4)   { score += -9;  notes.push(`Mix-adjusted organic pricing +${px.toFixed(1)}%: strong — moat fully intact`); }
    else if (px > 2.5) { score += -4;  notes.push(`Mix-adjusted organic pricing +${px.toFixed(1)}%: healthy structural pricing`); }
    else if (px >= 1)  { score += 4;   notes.push(`Mix-adjusted organic pricing +${px.toFixed(1)}%: softening — below the mid-single-digit structural norm`); }
    else if (px >= 0)  { score += 18;  notes.push(`Mix-adjusted organic pricing +${px.toFixed(1)}%: PRICING POWER BREAK (<1%) — the moat is the pricing. THESIS-LEVEL.`); }
    else               { score += 28;  notes.push(`Mix-adjusted organic pricing ${px.toFixed(1)}%: NEGATIVE REAL PRICING — a local monopoly cutting price is a broken thesis, not a cycle`); }
  }

  // ⚠ REPORTED ASP IS DELIBERATELY NOT SCORED — Guardrail (b). It is
  // mix-contaminated during integration: Q2'26 printed -2% reported against
  // +3.7% organic mix-adjusted, the entire gap being acquisition and geographic
  // mix from the Quikrete and New Frontier assets. Scoring it manufactures a
  // pricing-power break that did not happen. Surfaced as a NOTE only.
  if (isMLM && data.fundamentals?.reported_asp_signal_status === "null_signal_mix_contaminated") {
    const rasp = data.fundamentals?.reported_asp_growth_pct;
    notes.push(`Reported ASP${rasp != null ? ` ${rasp >= 0 ? "+" : ""}${rasp.toFixed(1)}%` : ""}: NOT SCORED — mix-contaminated during M&A integration; mix-adjusted organic pricing is the signal`);
  }

  // ORGANIC VOLUME — the cycle read. ★ WEATHER GATE (Guardrail c) applies:
  // aggregates is the most weather-contaminated quarterly print in this book,
  // and a rain-suppressed quarter is not demand destruction. When
  // weather_impact_flag is "material_headwind" the penalty on a negative
  // reading is REMOVED entirely rather than merely reduced — a half-penalty
  // would still leak a false trim into the composite every wet quarter.
  if (isMLM && data.fundamentals?.organic_volume_growth_pct != null) {
    const ov = data.fundamentals.organic_volume_growth_pct;
    const weatherHit = data.fundamentals?.weather_impact_flag === "material_headwind";
    if (ov > 5)        { score += -8; notes.push(`Organic volume +${ov.toFixed(1)}%: cycle firing`); }
    else if (ov > 3)   { score += -5; notes.push(`Organic volume +${ov.toFixed(1)}%: strong`); }
    else if (ov > 1)   { score += -2; notes.push(`Organic volume +${ov.toFixed(1)}%: steady`); }
    else if (ov >= -2) { score += 0;  notes.push(`Organic volume ${ov >= 0 ? "+" : ""}${ov.toFixed(1)}%: flat — inside the normal band`); }
    else if (weatherHit) {
      score += 0;
      notes.push(`Organic volume ${ov.toFixed(1)}%: NEGATIVE but WEATHER-GATED (material headwind) — penalty removed. Rain is not demand destruction; check pricing instead.`);
    }
    else if (ov >= -5) { score += 6;  notes.push(`Organic volume ${ov.toFixed(1)}%: contracting with no weather explanation — cycle rolling`); }
    else               { score += 12; notes.push(`Organic volume ${ov.toFixed(1)}%: sharply contracting with no weather explanation`); }
  }

  // Aggregates cash gross profit per ton — the industry's cleanest unit-economics
  // measure, and the number that proves price is outrunning cost.
  if (isMLM && data.fundamentals?.cash_gross_profit_per_ton != null) {
    const gp = data.fundamentals.cash_gross_profit_per_ton;
    if (gp > 13)      { score += -7; notes.push(`Cash gross profit $${gp.toFixed(2)}/ton: unit economics compounding`); }
    else if (gp > 11) { score += -4; notes.push(`Cash gross profit $${gp.toFixed(2)}/ton: strong`); }
    else if (gp > 9)  { score += 0;  notes.push(`Cash gross profit $${gp.toFixed(2)}/ton: normal`); }
    else if (gp > 7)  { score += 5;  notes.push(`Cash gross profit $${gp.toFixed(2)}/ton: cost side winning`); }
    else              { score += 10; notes.push(`Cash gross profit $${gp.toFixed(2)}/ton: unit margin impaired`); }
  }

  // COGS per ton EX pass-through freight — the real cost read. Including
  // freight muddies it, since freight is a pass-through that inflates both
  // sides of the ledger.
  // ★ The price-minus-cost SPREAD is the margin read, not either leg alone. On a
  // per-ton basis ANY positive spread expands gross margin, so the bands must
  // credit sub-2pp spreads: Q2'26 printed +3.7% price against +2.1% cost — a
  // 1.6pp spread — and adjusted cash gross profit still rose 15%. An earlier
  // draft gated "margin expanding" at >2pp and refused to credit exactly that
  // quarter. Absolute COGS is the FALLBACK only, used when pricing is null.
  if (isMLM && data.fundamentals?.cogs_per_ton_growth_ex_freight_pct != null) {
    const cg = data.fundamentals.cogs_per_ton_growth_ex_freight_pct;
    const px = data.fundamentals?.mix_adjusted_organic_pricing_pct;
    if (px != null) {
      const sp = px - cg;
      if (sp > 2.5)     { score += -7; notes.push(`Pricing +${px.toFixed(1)}% vs COGS/ton ex-freight +${cg.toFixed(1)}%: price outrunning cost by ${sp.toFixed(1)}pp — margin expanding hard`); }
      else if (sp > 1)  { score += -5; notes.push(`Pricing +${px.toFixed(1)}% vs COGS/ton ex-freight +${cg.toFixed(1)}%: price outrunning cost by ${sp.toFixed(1)}pp — margin expanding`); }
      else if (sp > 0)  { score += -2; notes.push(`Pricing +${px.toFixed(1)}% vs COGS/ton ex-freight +${cg.toFixed(1)}%: price marginally ahead by ${sp.toFixed(1)}pp — margin stable to slightly up`); }
      else if (sp > -1) { score += 2;  notes.push(`Pricing +${px.toFixed(1)}% vs COGS/ton ex-freight +${cg.toFixed(1)}%: cost matching price (${sp.toFixed(1)}pp) — margin flat to slightly down`); }
      else              { score += 6;  notes.push(`Pricing +${px.toFixed(1)}% vs COGS/ton ex-freight +${cg.toFixed(1)}%: cost outrunning price by ${(-sp).toFixed(1)}pp — margin compressing`); }
    }
    else if (cg < 3)    { score += -2; notes.push(`COGS/ton ex-freight +${cg.toFixed(1)}%: cost discipline holding (pricing unavailable — spread not computable)`); }
    else if (cg > 5)    { score += 4;  notes.push(`COGS/ton ex-freight +${cg.toFixed(1)}%: cost inflation elevated (pricing unavailable — spread not computable)`); }
  }

  // Energy — the current margin culprit. Diesel is the swing input.
  if (isMLM && data.fundamentals?.energy_headwind) {
    const eh = String(data.fundamentals.energy_headwind).toLowerCase();
    if (eh === "tailwind")       { score += -4; notes.push(`Energy: TAILWIND — cost relief flowing to unit margin`); }
    else if (eh === "neutral")   { score += 0;  notes.push(`Energy: neutral`); }
    else if (eh === "moderate")  { score += 3;  notes.push(`Energy: moderate headwind — transitory input cost, not a moat issue`); }
    else if (eh === "severe")    { score += 6;  notes.push(`Energy: SEVERE headwind — margin pressure, but check whether pricing is still compounding`); }
  }

  // Adjusted EBITDA margin. The inventory step-up is a non-cash purchase-
  // accounting artifact and is annotated so the margin is not read as
  // operational deterioration.
  if (isMLM && data.fundamentals?.ebitda_margin_pct != null) {
    const em = data.fundamentals.ebitda_margin_pct;
    if (em > 35)      { score += -5; notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: leverage compounding`); }
    else if (em > 33) { score += -3; notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: strong`); }
    else if (em > 30) { score += 0;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: normal`); }
    else if (em > 28) { score += 3;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: compressing`); }
    else              { score += 7;  notes.push(`Adj EBITDA margin ${em.toFixed(1)}%: leverage reversing`); }
    const st = data.fundamentals?.inventory_step_up_charge_musd;
    if (st != null && st > 0) {
      notes.push(`⚠ Margin includes a $${st}M NON-CASH inventory step-up (purchase accounting) — strip before comparing to prior-year`);
    }
  }

  // End markets, scored separately. Infrastructure and heavy nonres (data
  // centers, power gen, warehouses) are the strong legs; residential is the
  // weak one and is weighted lightly — it is the smallest share of demand.
  if (isMLM && data.fundamentals?.infrastructure_demand) {
    const d = String(data.fundamentals.infrastructure_demand).toLowerCase();
    if (d === "strong")         { score += -5; notes.push(`Infrastructure demand: STRONG — the largest end market pulling`); }
    else if (d === "softening") { score += 5;  notes.push(`Infrastructure demand: SOFTENING — check federal authorization status`); }
  }
  if (isMLM && data.fundamentals?.heavy_nonres_demand) {
    const d = String(data.fundamentals.heavy_nonres_demand).toLowerCase();
    if (d === "strong")         { score += -4; notes.push(`Heavy nonres demand: STRONG — data centers/power gen/warehouses pulling`); }
    else if (d === "softening") { score += 4;  notes.push(`Heavy nonres demand: SOFTENING`); }
  }
  if (isMLM && data.fundamentals?.residential_demand) {
    const d = String(data.fundamentals.residential_demand).toLowerCase();
    if (d === "strong")         { score += -2; notes.push(`Residential demand: STRONG`); }
    else if (d === "softening") { score += 2;  notes.push(`Residential demand: SOFTENING — smallest of the three legs, weighted lightly`); }
  }

  // Guidance actions
  if (isMLM && data.fundamentals?.fy_revenue_guide_action) {
    const g = String(data.fundamentals.fy_revenue_guide_action).toLowerCase();
    if (g === "raised")   { score += -4; notes.push(`FY revenue guide: RAISED`); }
    else if (g === "cut") { score += 6;  notes.push(`FY revenue guide: CUT`); }
  }
  if (isMLM && data.fundamentals?.fy_ebitda_guide_action) {
    const g = String(data.fundamentals.fy_ebitda_guide_action).toLowerCase();
    if (g === "raised")        { score += -5; notes.push(`FY adj EBITDA guide: RAISED`); }
    else if (g === "reaffirmed") { score += 0; notes.push(`FY adj EBITDA guide: reaffirmed (conservative energy assumptions can hold this flat while revenue rises)`); }
    else if (g === "cut")      { score += 8;  notes.push(`FY adj EBITDA guide: CUT`); }
  }

  // EPS revisions — LIN-class thresholds (+1 / -2), tighter than RDDT's
  // +2/-4: consensus does not swing as hard on a 10%-growth industrial.
  if (isMLM && data.fundamentals?.eps_revisions_90d_pct != null) {
    const rev = data.fundamentals.eps_revisions_90d_pct;
    if (rev > 3)       { score += -6; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): strong upward — positional tailwind`); }
    else if (rev > 1)  { score += -3; notes.push(`EPS revs +${rev.toFixed(1)}% (90d): upward`); }
    else if (rev > -2) { score += 0;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): stable`); }
    else if (rev > -5) { score += 4;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): downward — positional headwind`); }
    else               { score += 8;  notes.push(`EPS revs ${rev.toFixed(1)}% (90d): sharply downward — caution`); }
  }
  if (isMLM && data.fundamentals?.eps_revisions_30d_pct != null) {
    const r30 = data.fundamentals.eps_revisions_30d_pct;
    if (r30 > 2)       { score += -2; }
    else if (r30 < -2) { score += 2;  }
  }

  return { score: clamp(score), notes };
}

// ─── STRATEGIC LAYER (long-term valuation) ──────────────────────────────────
export function scoreStrategic(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isCyclical = CYCLICAL_ARCHETYPES.has(archetype);
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isAMKBY = archetype === "cyclical_trade_bellwether";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isLIN = archetype === "oligopoly_quality_compounder";
  const isMSFT = archetype === "ai_infra_quality_compounder";
  const isLHX = archetype === "defense_prime_backlog_compounder";
  const isTMO = archetype === "life_sciences_quality_compounder";
  const isNOW = archetype === "ai_workflow_quality_compounder";            // ← V7.6
  const isMA = archetype === "payments_network_quality_compounder";        // ← V8.2
  const isISRG = archetype === "surgical_robotics_moat_compounder";        // ← V8.2
  const isRDDT = archetype === "hypergrowth_platform_monetizer";           // ← V8.3 (RETAINED — dead code, historical re-scoring)
  const isMLM = archetype === "reserve_moat_infrastructure_compounder";     // ← V8.4

  if (isIBIT) {
    const phaseInfo = getHalvingPhase();
    const phase = phaseInfo.phase;
    if (phase === "early_expansion")        { score += 0; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — no phase bias`); }
    else if (phase === "mid_expansion")     { score += 0; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — no phase bias`); }
    else if (phase === "extended_expansion") { score += 3; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — mild maturity tilt`); }
    else                                    { score += 5; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — maturity tilt`); }

    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 40)      { score += -10; notes.push(`VIX ${vix}: macro panic — BTC contrarian buy`); }
      else if (vix > 30) { score += -5;  notes.push(`VIX ${vix}: macro fear — BTC buy bias`); }
      else if (vix < 12) { score += 3;   notes.push(`VIX ${vix}: extreme complacency — marginal caution`); }
    }
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips < 0)        { score += -5; notes.push(`TIPS ${tips}%: accommodative — BTC tailwind`); }
      else if (tips > 2.5) { score += 3;  notes.push(`TIPS ${tips}%: restrictive — mild BTC headwind`); }
    }
    return { score: clamp(score), notes };
  }

  if (isENB) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe < 14)       { score += -10; notes.push(`ENB P/E ${pe.toFixed(1)}x: cheap for infrastructure`); }
      else if (pe < 18)  { score += -5;  notes.push(`ENB P/E ${pe.toFixed(1)}x: below normal`); }
      else if (pe <= 24) { score += 0;   notes.push(`ENB P/E ${pe.toFixed(1)}x: normal range`); }
      else if (pe < 28)  { score += 3;   notes.push(`ENB P/E ${pe.toFixed(1)}x: slightly rich`); }
      else               { score += 8;   notes.push(`ENB P/E ${pe.toFixed(1)}x: rich for infrastructure`); }
    }
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 8)        { score += -15; notes.push(`ENB yield ${dy}%: very high — deeply discounted`); }
      else if (dy > 7.5) { score += -10; notes.push(`ENB yield ${dy}%: high — historically attractive`); }
      else if (dy > 7)   { score += -5;  notes.push(`ENB yield ${dy}%: above average`); }
      else if (dy > 6)   { score += 0;   notes.push(`ENB yield ${dy}%: normal range`); }
      else if (dy > 5.5) { score += 3;   notes.push(`ENB yield ${dy}%: below average — getting rich`); }
      else if (dy > 5)   { score += 8;   notes.push(`ENB yield ${dy}%: low — yield compression`); }
      else               { score += 12;  notes.push(`ENB yield ${dy}%: historically low — expensive`); }
    }
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 10;  notes.push(`TIPS ${tips}%: very restrictive — strong headwind for yield stocks`); }
      else if (tips > 2.5) { score += 6;   notes.push(`TIPS ${tips}%: restrictive — yield stock headwind`); }
      else if (tips > 2)   { score += 3;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -10; notes.push(`TIPS ${tips}%: accommodative — yield stocks shine`); }
      else if (tips < 0.5) { score += -5;  notes.push(`TIPS ${tips}%: very low real rates — ENB yield attractive`); }
      else if (tips < 1)   { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    }
    if (macro?.spread_2s10s != null) {
      const spread = macro.spread_2s10s;
      if (spread > 100)      { score += -5; notes.push(`2s10s +${spread}bps: steep curve — rate cut regime, ENB tailwind`); }
      else if (spread > 50)  { score += -3; notes.push(`2s10s +${spread}bps: steepening — mildly positive for ENB`); }
      else if (spread > -30) { score += 0;  notes.push(`2s10s ${spread}bps: normal range`); }
      else if (spread > -75) { score += 5;  notes.push(`2s10s ${spread}bps: inverted — rate risk headwind`); }
      else                   { score += 8;  notes.push(`2s10s ${spread}bps: deeply inverted — yield stocks under pressure`); }
    }
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — ENB defensive quality, mild buy`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — ENB as safe haven`); }
    }
    return { score: clamp(score), notes };
  }

  if (isAMKBY) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe > 100)     { score += -25; notes.push(`AMKBY P/E ${pe.toFixed(0)}x: deep trough — shipping buy`); }
      else if (pe > 50) { score += -18; notes.push(`AMKBY P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 25) { score += -8;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: below-trend — recovery territory`); }
      else if (pe > 12) { score += 0;   notes.push(`AMKBY P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 6)  { score += 10;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)  { score += 18;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: peak earnings — shipping trim`); }
      else              { score += 25;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
    }
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.5)      { score += -20; notes.push(`AMKBY P/B ${pb.toFixed(2)}: near scrap value — strong buy`); }
      else if (pb < 0.7) { score += -15; notes.push(`AMKBY P/B ${pb.toFixed(2)}: below replacement cost — buy`); }
      else if (pb < 0.9) { score += -8;  notes.push(`AMKBY P/B ${pb.toFixed(2)}: below book — value territory`); }
      else if (pb < 1.2) { score += -3;  notes.push(`AMKBY P/B ${pb.toFixed(2)}: near book`); }
      else if (pb < 1.8) { score += 0;   notes.push(`AMKBY P/B ${pb.toFixed(2)}: normal`); }
      else if (pb < 2.5) { score += 5;   notes.push(`AMKBY P/B ${pb.toFixed(2)}: above book — cycle pricing in`); }
      else               { score += 10;  notes.push(`AMKBY P/B ${pb.toFixed(2)}: premium — late cycle risk`); }
    }
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 8)      { score += -8; notes.push(`AMKBY yield ${dy}%: very high — cyclical trough?`); }
      else if (dy > 5) { score += -4; notes.push(`AMKBY yield ${dy}%: attractive`); }
      else if (dy > 3) { score += -2; notes.push(`AMKBY yield ${dy}%: moderate`); }
    }
    if (macro?.hy_oas != null) {
      const oas = macro.hy_oas;
      if (oas < 300)      { score += -3; notes.push(`HY OAS ${oas}bps: tight — healthy trade environment`); }
      else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
      else if (oas < 500) { score += 5;  notes.push(`HY OAS ${oas}bps: widening — trade contraction risk`); }
      else if (oas < 700) { score += 10; notes.push(`HY OAS ${oas}bps: stressed — trade headwind`); }
      else                { score += 15; notes.push(`HY OAS ${oas}bps: crisis — shipping demand at risk`); }
    }
    if (macro?.gscpi != null) {
      const g = macro.gscpi;
      if (g > 2.5)       { score += 5;   notes.push(`GSCPI ${g}: extreme disruption — rate surge unsustainable?`); }
      else if (g > 1.5)  { score += 3;   notes.push(`GSCPI ${g}: stressed — high rates but disruption risk`); }
      else if (g > 0.5)  { score += 0;   notes.push(`GSCPI ${g}: above average — healthy freight demand`); }
      else if (g > -0.5) { score += 0;   notes.push(`GSCPI ${g}: normal`); }
      else if (g > -1.0) { score += -3;  notes.push(`GSCPI ${g}: below average — freight weakness`); }
      else               { score += -8;  notes.push(`GSCPI ${g}: deeply negative — freight trough, contrarian buy?`); }
    }
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — global trade fear, contrarian buy`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency`); }
    }
    return { score: clamp(score), notes };
  }

  if (isETHA) {
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 40)      { score += -12; notes.push(`VIX ${vix}: panic — ETH contrarian buy (high-beta)`); }
      else if (vix > 30) { score += -8;  notes.push(`VIX ${vix}: high fear — ETH buy bias`); }
      else if (vix > 25) { score += -3;  notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 5;   notes.push(`VIX ${vix}: extreme complacency — ETH vulnerable`); }
      else if (vix < 14) { score += 3;   notes.push(`VIX ${vix}: low vol complacency`); }
    }
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 2.5)      { score += 6;  notes.push(`TIPS ${tips}%: restrictive — ETH headwind`); }
      else if (tips > 2)   { score += 3;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -8; notes.push(`TIPS ${tips}%: accommodative — ETH tailwind`); }
      else if (tips < 0.5) { score += -4; notes.push(`TIPS ${tips}%: low real rates — risk assets favored`); }
    }
    if (macro?.hy_oas != null) {
      const oas = macro.hy_oas;
      if (oas < 300)      { score += -5; notes.push(`HY OAS ${oas}bps: tight — risk-on, ETH tailwind`); }
      else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
      else if (oas < 500) { score += 8;  notes.push(`HY OAS ${oas}bps: widening — ETH headwind`); }
      else if (oas < 700) { score += 15; notes.push(`HY OAS ${oas}bps: stressed — ETH at risk`); }
      else                { score += 22; notes.push(`HY OAS ${oas}bps: crisis — ETH high-beta pain`); }
    }
    return { score: clamp(score), notes };
  }

  if (isKOF) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe < 10)       { score += -15; notes.push(`KOF P/E ${pe.toFixed(1)}x: deep value — rare for staples`); }
      else if (pe < 13)  { score += -8;  notes.push(`KOF P/E ${pe.toFixed(1)}x: value territory`); }
      else if (pe < 15)  { score += -3;  notes.push(`KOF P/E ${pe.toFixed(1)}x: below normal`); }
      else if (pe <= 22) { score += 0;   notes.push(`KOF P/E ${pe.toFixed(1)}x: normal LatAm bottler range`); }
      else if (pe < 26)  { score += 5;   notes.push(`KOF P/E ${pe.toFixed(1)}x: slightly rich`); }
      else if (pe < 30)  { score += 10;  notes.push(`KOF P/E ${pe.toFixed(1)}x: rich`); }
      else               { score += 15;  notes.push(`KOF P/E ${pe.toFixed(1)}x: expensive for staples`); }
    }
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 1.5)      { score += -5;  notes.push(`KOF P/B ${pb.toFixed(2)}: below book — unusual for staples`); }
      else if (pb < 2.5) { score += -2;  notes.push(`KOF P/B ${pb.toFixed(2)}: reasonable`); }
      else if (pb < 4)   { score += 0;   notes.push(`KOF P/B ${pb.toFixed(2)}: normal`); }
      else if (pb < 6)   { score += 3;   notes.push(`KOF P/B ${pb.toFixed(2)}: above average`); }
      else               { score += 6;   notes.push(`KOF P/B ${pb.toFixed(2)}: premium`); }
    }
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 5)        { score += -8;  notes.push(`KOF yield ${dy}%: very high — stock is cheap`); }
      else if (dy > 4)   { score += -5;  notes.push(`KOF yield ${dy}%: above average — attractive`); }
      else if (dy > 3)   { score += -2;  notes.push(`KOF yield ${dy}%: normal range`); }
      else if (dy > 2)   { score += 0;   notes.push(`KOF yield ${dy}%: normal`); }
      else if (dy > 1.5) { score += 3;   notes.push(`KOF yield ${dy}%: compressed — stock is rich`); }
      else               { score += 6;   notes.push(`KOF yield ${dy}%: very low — expensive`); }
    }
    if (macro?.mxn_usd != null) {
      const mxn = macro.mxn_usd;
      if (mxn < 16)        { score += -10; notes.push(`MXN/USD ${mxn}: very strong peso — KOF tailwind`); }
      else if (mxn < 17)   { score += -5;  notes.push(`MXN/USD ${mxn}: strong peso — KOF positive`); }
      else if (mxn < 18.5) { score += 0;   notes.push(`MXN/USD ${mxn}: normal range`); }
      else if (mxn < 20)   { score += 5;   notes.push(`MXN/USD ${mxn}: weakening peso — KOF headwind`); }
      else if (mxn < 22)   { score += 10;  notes.push(`MXN/USD ${mxn}: weak peso — KOF FX drag`); }
      else                 { score += 15;  notes.push(`MXN/USD ${mxn}: peso crisis — severe KOF headwind`); }
    }
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — KOF defensive quality`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated — staples as safe haven`); }
      else if (vix < 12) { score += 2;  notes.push(`VIX ${vix}: complacency`); }
    }
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 2.5)    { score += 3;  notes.push(`TIPS ${tips}%: restrictive — mild headwind`); }
      else if (tips < 0) { score += -3; notes.push(`TIPS ${tips}%: accommodative`); }
    }
    return { score: clamp(score), notes };
  }

  if (isGLNCY) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe > 80)      { score += -22; notes.push(`GLNCY P/E ${pe.toFixed(0)}x: deep trough — commodity buy`); }
      else if (pe > 40) { score += -15; notes.push(`GLNCY P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 20) { score += -5;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: below-trend`); }
      else if (pe > 10) { score += 0;   notes.push(`GLNCY P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 6)  { score += 10;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)  { score += 18;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: peak earnings — trim`); }
      else              { score += 22;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
    }
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.6)      { score += -15; notes.push(`GLNCY P/B ${pb.toFixed(2)}: well below replacement — strong buy`); }
      else if (pb < 0.8) { score += -10; notes.push(`GLNCY P/B ${pb.toFixed(2)}: below replacement cost — buy`); }
      else if (pb < 1.0) { score += -5;  notes.push(`GLNCY P/B ${pb.toFixed(2)}: below book`); }
      else if (pb < 1.5) { score += 0;   notes.push(`GLNCY P/B ${pb.toFixed(2)}: near book — normal`); }
      else if (pb < 2.5) { score += 3;   notes.push(`GLNCY P/B ${pb.toFixed(2)}: above book`); }
      else               { score += 8;   notes.push(`GLNCY P/B ${pb.toFixed(2)}: premium — late cycle`); }
    }
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 8)      { score += -8; notes.push(`GLNCY yield ${dy}%: very high — trough pricing?`); }
      else if (dy > 5) { score += -4; notes.push(`GLNCY yield ${dy}%: attractive`); }
      else if (dy > 3) { score += -2; notes.push(`GLNCY yield ${dy}%: moderate`); }
    }
    if (macro?.hy_oas != null) {
      const oas = macro.hy_oas;
      if (oas < 300)      { score += -3; notes.push(`HY OAS ${oas}bps: tight — healthy industrial demand`); }
      else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
      else if (oas < 500) { score += 5;  notes.push(`HY OAS ${oas}bps: widening — demand risk`); }
      else if (oas < 700) { score += 10; notes.push(`HY OAS ${oas}bps: stressed — commodity headwind`); }
      else                { score += 15; notes.push(`HY OAS ${oas}bps: crisis — industrial collapse`); }
    }
    if (macro?.gscpi != null) {
      const g = macro.gscpi;
      if (g > 2.0)       { score += 3;   notes.push(`GSCPI ${g}: extreme disruption — mixed for diversified miner`); }
      else if (g > 0.5)  { score += 0;   notes.push(`GSCPI ${g}: above average — healthy commodity demand`); }
      else if (g > -0.5) { score += 0;   notes.push(`GSCPI ${g}: normal`); }
      else if (g > -1.0) { score += -3;  notes.push(`GSCPI ${g}: below average — commodity softness`); }
      else               { score += -6;  notes.push(`GSCPI ${g}: deeply negative — commodity trough`); }
    }
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — commodity contrarian buy`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency`); }
    }
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 2.5)    { score += 3;  notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips < 0) { score += -3; notes.push(`TIPS ${tips}%: accommodative — commodity tailwind`); }
    }
    return { score: clamp(score), notes };
  }

  if (isPBRA) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe > 50)      { score += -20; notes.push(`PBR.A P/E ${pe.toFixed(0)}x: trough — oil cycle buy`); }
      else if (pe > 30) { score += -12; notes.push(`PBR.A P/E ${pe.toFixed(0)}x: depressed earnings`); }
      else if (pe > 15) { score += -3;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: below-trend`); }
      else if (pe > 8)  { score += 0;   notes.push(`PBR.A P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 5)  { score += 8;   notes.push(`PBR.A P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)  { score += 15;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: peak earnings — trim`); }
      else              { score += 22;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
    }
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.6)      { score += -12; notes.push(`PBR.A P/B ${pb.toFixed(2)}: well below book — reserves undervalued`); }
      else if (pb < 0.8) { score += -8;  notes.push(`PBR.A P/B ${pb.toFixed(2)}: below book — value`); }
      else if (pb < 1.2) { score += -3;  notes.push(`PBR.A P/B ${pb.toFixed(2)}: near book`); }
      else if (pb < 2.0) { score += 0;   notes.push(`PBR.A P/B ${pb.toFixed(2)}: normal`); }
      else if (pb < 3.0) { score += 3;   notes.push(`PBR.A P/B ${pb.toFixed(2)}: above book`); }
      else               { score += 8;   notes.push(`PBR.A P/B ${pb.toFixed(2)}: premium — late cycle`); }
    }
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 18)      { score += -15; notes.push(`PBR.A yield ${dy}%: extreme — cut priced in or deeply cheap`); }
      else if (dy > 14) { score += -10; notes.push(`PBR.A yield ${dy}%: very high — historically attractive`); }
      else if (dy > 10) { score += -5;  notes.push(`PBR.A yield ${dy}%: above normal — attractive`); }
      else if (dy > 7)  { score += 0;   notes.push(`PBR.A yield ${dy}%: normal range`); }
      else if (dy > 5)  { score += 5;   notes.push(`PBR.A yield ${dy}%: below normal — getting rich`); }
      else              { score += 10;  notes.push(`PBR.A yield ${dy}%: low — stock is expensive`); }
    }
    if (macro?.wti != null) {
      const wti = macro.wti;
      if (wti > 90)      { score += -8; notes.push(`WTI $${wti}: strong oil — PBR.A tailwind`); }
      else if (wti > 75) { score += -3; notes.push(`WTI $${wti}: supportive`); }
      else if (wti > 60) { score += 0;  notes.push(`WTI $${wti}: normal`); }
      else if (wti > 50) { score += 5;  notes.push(`WTI $${wti}: soft — margin compression`); }
      else if (wti > 40) { score += 12; notes.push(`WTI $${wti}: weak — PBR.A earnings at risk`); }
      else               { score += 20; notes.push(`WTI $${wti}: oil crash — PBR.A under pressure`); }
    }
    if (macro?.brl_usd != null) {
      const brl = macro.brl_usd;
      if (brl < 4.5)      { score += -5; notes.push(`BRL/USD ${brl}: strong real — PBR.A ADR positive`); }
      else if (brl < 5.0) { score += -2; notes.push(`BRL/USD ${brl}: reasonably strong`); }
      else if (brl < 5.5) { score += 0;  notes.push(`BRL/USD ${brl}: normal range`); }
      else if (brl < 6.0) { score += 3;  notes.push(`BRL/USD ${brl}: weakening — mild headwind`); }
      else if (brl < 7.0) { score += 8;  notes.push(`BRL/USD ${brl}: weak real — FX drag`); }
      else                { score += 12; notes.push(`BRL/USD ${brl}: BRL crisis — significant headwind`); }
    }
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — PBR.A contrarian buy`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency`); }
    }
    return { score: clamp(score), notes };
  }

  // ─── LIN STRATEGIC (V3) ──────────────────────────────────────────────────
  if (isLIN) {
    if (data.peer_valuation && data.peer_valuation.premium_pct != null) {
      const prem = data.peer_valuation.premium_pct;
      if (prem < -5)       { score += -30; notes.push(`LIN P/E ${prem.toFixed(1)}% vs peers: discount — exceptional quality buy (very rare)`); }
      else if (prem < 0)   { score += -22; notes.push(`LIN P/E ${prem.toFixed(1)}% vs peers: at parity — rare opportunity`); }
      else if (prem < 5)   { score += -15; notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: tight premium — buy`); }
      else if (prem < 10)  { score += -7;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: below normal premium`); }
      else if (prem <= 15) { score += 0;   notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: deserved premium (normal)`); }
      else if (prem < 18)  { score += 3;   notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: stretched`); }
      else if (prem < 22)  { score += 10;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: rich premium — trim bias`); }
      else                 { score += 18;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: extreme premium — trim`); }
    } else {
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 22)       { score += -10; notes.push(`LIN P/E ${pe.toFixed(1)}x: cheap (peer data unavailable)`); }
        else if (pe < 26)  { score += -5;  notes.push(`LIN P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 32) { score += 0;   notes.push(`LIN P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 36)  { score += 5;   notes.push(`LIN P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 12;  notes.push(`LIN P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    if (data.peer_valuation?.premium_6m_delta_pp != null) {
      const d = data.peer_valuation.premium_6m_delta_pp;
      if (d < -5)      { score += -10; notes.push(`Premium 6M Δ ${d.toFixed(1)}pp: rapidly compressing — strong buy bias (direction wins)`); }
      else if (d < -3) { score += -6;  notes.push(`Premium 6M Δ ${d.toFixed(1)}pp: compressing — buy bias`); }
      else if (d < -1) { score += -2;  notes.push(`Premium 6M Δ ${d.toFixed(1)}pp: mildly compressing`); }
      else if (d <= 1) { score += 0;   notes.push(`Premium 6M Δ ${d.toFixed(1)}pp: stable`); }
      else if (d <= 3) { score += 2;   notes.push(`Premium 6M Δ +${d.toFixed(1)}pp: mildly expanding`); }
      else if (d <= 5) { score += 6;   notes.push(`Premium 6M Δ +${d.toFixed(1)}pp: expanding — trim bias`); }
      else             { score += 10;  notes.push(`Premium 6M Δ +${d.toFixed(1)}pp: rapidly expanding — strong trim bias`); }
    }

    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 1.9)      { score += -10; notes.push(`LIN yield ${dy}%: top of historical range — aristocrat-grade buy`); }
      else if (dy > 1.7) { score += -5;  notes.push(`LIN yield ${dy}%: above normal — attractive`); }
      else if (dy > 1.3) { score += 0;   notes.push(`LIN yield ${dy}%: normal range`); }
      else if (dy > 1.1) { score += 3;   notes.push(`LIN yield ${dy}%: slightly stretched`); }
      else               { score += 8;   notes.push(`LIN yield ${dy}%: stretched — yield compression`); }
    }

    if (data.fundamentals?.roce_pct != null) {
      const roce = data.fundamentals.roce_pct;
      if (roce > 28)      { score += -5; notes.push(`LIN ROCE ${roce}%: exceptional — moat strengthening`); }
      else if (roce > 25) { score += 0;  notes.push(`LIN ROCE ${roce}%: best-in-class normal`); }
      else if (roce > 22) { score += 3;  notes.push(`LIN ROCE ${roce}%: slipping below historical`); }
      else if (roce > 20) { score += 6;  notes.push(`LIN ROCE ${roce}%: concerning for LIN`); }
      else                { score += 12; notes.push(`LIN ROCE ${roce}%: moat erosion risk`); }
    }

    if (data.fundamentals?.operating_margin_pct != null) {
      const om = data.fundamentals.operating_margin_pct;
      if (om > 32)      { score += -2; notes.push(`LIN op margin ${om}%: peak pricing power`); }
      else if (om > 30) { score += 0;  notes.push(`LIN op margin ${om}%: best-in-class`); }
      else if (om > 28) { score += 3;  notes.push(`LIN op margin ${om}%: compressing`); }
      else              { score += 8;  notes.push(`LIN op margin ${om}%: significant compression`); }
    }

    if (data.h2_layer?.contracts_90d_usd_m != null) {
      const c = data.h2_layer.contracts_90d_usd_m;
      if (c > 1000)     { score += -8; notes.push(`H2 contracts $${c.toFixed(0)}M (90d): exceptional — H2 thesis activating`); }
      else if (c > 500) { score += -5; notes.push(`H2 contracts $${c.toFixed(0)}M (90d): strong pipeline`); }
      else if (c > 250) { score += -2; notes.push(`H2 contracts $${c.toFixed(0)}M (90d): healthy`); }
      else if (c > 100) { score += 0;  notes.push(`H2 contracts $${c.toFixed(0)}M (90d): normal`); }
      else if (c > 50)  { score += 3;  notes.push(`H2 contracts $${c.toFixed(0)}M (90d): slow pipeline`); }
      else              { score += 6;  notes.push(`H2 contracts $${c.toFixed(0)}M (90d): pipeline weakening`); }
    }

    if (data.h2_layer?.subsidy_regime) {
      const r = data.h2_layer.subsidy_regime;
      if (r === "strengthening")  { score += -4; notes.push(`H2 subsidy regime: strengthening — 45V/EU H2 Bank/JP-KR supportive`); }
      else if (r === "weakening") { score += 5;  notes.push(`H2 subsidy regime: weakening — policy headwind`); }
      else                        { notes.push(`H2 subsidy regime: stable`); }
    }

    if (data.h2_layer?.lcoe_gap_6m_delta != null) {
      const d = data.h2_layer.lcoe_gap_6m_delta;
      if (d < -1.0)      { score += -6; notes.push(`Green/grey LCOE Δ ${d.toFixed(2)}/kg (6m): rapidly closing — green H2 commercial`); }
      else if (d < -0.5) { score += -3; notes.push(`Green/grey LCOE Δ ${d.toFixed(2)}/kg (6m): closing — H2 thesis activating`); }
      else if (d < 0.5)  { score += 0;  notes.push(`Green/grey LCOE Δ ${d.toFixed(2)}/kg (6m): stable`); }
      else if (d < 1.0)  { score += 2;  notes.push(`Green/grey LCOE Δ +${d.toFixed(2)}/kg (6m): widening — H2 thesis stalled`); }
      else               { score += 5;  notes.push(`Green/grey LCOE Δ +${d.toFixed(2)}/kg (6m): rapidly widening — H2 thesis broken`); }
    }

    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 5;  notes.push(`DXY ${dxy}: very strong USD — significant FX headwind`); }
      else if (dxy > 125) { score += 2;  notes.push(`DXY ${dxy}: strong USD — FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -2; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -5; notes.push(`DXY ${dxy}: weak USD — strong FX tailwind`); }
    }

    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — LIN defensive quality bid`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — LIN as safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — LIN vulnerable to rotation`); }
    }

    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 2.5)      { score += 3;  notes.push(`TIPS ${tips}%: restrictive — quality compounder headwind`); }
      else if (tips > 2)   { score += 1;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -3; notes.push(`TIPS ${tips}%: accommodative — compounder tailwind`); }
      else if (tips < 0.5) { score += -1; notes.push(`TIPS ${tips}%: low real rates`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── MSFT STRATEGIC (V1) ─────────────────────────────────────────────────
  if (isMSFT) {
    if (data.cohort_valuation && data.cohort_valuation.premium_pct != null) {
      const prem = data.cohort_valuation.premium_pct;
      if (prem < -15)      { score += -25; notes.push(`MSFT P/E ${prem.toFixed(1)}% vs cohort: deep discount — exceptional buy (very rare)`); }
      else if (prem < -8)  { score += -18; notes.push(`MSFT P/E ${prem.toFixed(1)}% vs cohort: discount — strong buy`); }
      else if (prem < 0)   { score += -10; notes.push(`MSFT P/E ${prem.toFixed(1)}% vs cohort: below cohort — buy bias`); }
      else if (prem < 5)   { score += -3;  notes.push(`MSFT P/E +${prem.toFixed(1)}% vs cohort: in-line — fair value`); }
      else if (prem <= 15) { score += 0;   notes.push(`MSFT P/E +${prem.toFixed(1)}% vs cohort: deserved premium (normal)`); }
      else if (prem < 20)  { score += 5;   notes.push(`MSFT P/E +${prem.toFixed(1)}% vs cohort: stretched`); }
      else if (prem < 25)  { score += 12;  notes.push(`MSFT P/E +${prem.toFixed(1)}% vs cohort: rich premium — trim bias`); }
      else                 { score += 18;  notes.push(`MSFT P/E +${prem.toFixed(1)}% vs cohort: extreme premium — trim`); }
    } else {
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 22)       { score += -10; notes.push(`MSFT P/E ${pe.toFixed(1)}x: cheap (cohort data unavailable)`); }
        else if (pe < 27)  { score += -5;  notes.push(`MSFT P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 33) { score += 0;   notes.push(`MSFT P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 38)  { score += 5;   notes.push(`MSFT P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 12;  notes.push(`MSFT P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 1.2)      { score += -3; notes.push(`MSFT yield ${dy}%: above normal — modestly attractive`); }
      else if (dy > 0.9) { score += -1; notes.push(`MSFT yield ${dy}%: above baseline`); }
      else if (dy > 0.7) { score += 0;  notes.push(`MSFT yield ${dy}%: normal baseline`); }
      else if (dy > 0.5) { score += 1;  notes.push(`MSFT yield ${dy}%: compressed — stock is rich`); }
      else               { score += 3;  notes.push(`MSFT yield ${dy}%: very low — yield compression`); }
    }

    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 8;   notes.push(`TIPS ${tips}%: very restrictive — long-duration MSFT headwind`); }
      else if (tips > 2.5) { score += 4;   notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips > 2)   { score += 2;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -8;  notes.push(`TIPS ${tips}%: accommodative — long-duration tailwind`); }
      else if (tips < 1)   { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    }

    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — MSFT defensive quality bid`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — MSFT as safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — MSFT vulnerable to rotation`); }
    }

    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 3;  notes.push(`DXY ${dxy}: very strong USD — MSFT FX headwind`); }
      else if (dxy > 125) { score += 1;  notes.push(`DXY ${dxy}: strong USD — mild FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -1; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -3; notes.push(`DXY ${dxy}: weak USD — FX tailwind`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── LHX STRATEGIC (V7.5) ────────────────────────────────────────────────
  // Cohort P/E premium primary signal vs LMT/NOC/RTX/GD.
  // LHX historically discounted -5 to -15% — compression is the central re-rating thesis.
  if (isLHX) {
    if (data.cohort_valuation && data.cohort_valuation.premium_pct != null) {
      const prem = data.cohort_valuation.premium_pct;
      if (prem < -15)      { score += -25; notes.push(`LHX P/E ${prem.toFixed(1)}% vs cohort: deep discount — exceptional buy (above historical norm)`); }
      else if (prem < -10) { score += -18; notes.push(`LHX P/E ${prem.toFixed(1)}% vs cohort: wide discount — buy (above norm)`); }
      else if (prem < -5)  { score += -8;  notes.push(`LHX P/E ${prem.toFixed(1)}% vs cohort: normal discount range`); }
      else if (prem < 0)   { score += -3;  notes.push(`LHX P/E ${prem.toFixed(1)}% vs cohort: mild discount`); }
      else if (prem < 5)   { score += 5;   notes.push(`LHX P/E +${prem.toFixed(1)}% vs cohort: in-line (rare for LHX) — mean reversion ahead`); }
      else                 { score += 12;  notes.push(`LHX P/E +${prem.toFixed(1)}% vs cohort: premium — trim bias (rare)`); }
    } else {
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 18)       { score += -10; notes.push(`LHX P/E ${pe.toFixed(1)}x: cheap (cohort data unavailable)`); }
        else if (pe < 22)  { score += -5;  notes.push(`LHX P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 28) { score += 0;   notes.push(`LHX P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 32)  { score += 5;   notes.push(`LHX P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 12;  notes.push(`LHX P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Dividend yield — Aristocrat-track defense prime (typical 1.5-2.5%)
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 2.5)      { score += -10; notes.push(`LHX yield ${dy}%: top of historical range — aristocrat-grade buy`); }
      else if (dy > 2.2) { score += -6;  notes.push(`LHX yield ${dy}%: above normal — attractive`); }
      else if (dy > 1.7) { score += 0;   notes.push(`LHX yield ${dy}%: normal range`); }
      else if (dy > 1.4) { score += 3;   notes.push(`LHX yield ${dy}%: slightly stretched`); }
      else               { score += 8;   notes.push(`LHX yield ${dy}%: stretched — yield compression`); }
    }

    // Op margin durability (defense prime norm 14-17%)
    if (data.fundamentals?.operating_margin_pct != null) {
      const om = data.fundamentals.operating_margin_pct;
      if (om > 17)      { score += -2; notes.push(`LHX op margin ${om}%: strong execution`); }
      else if (om > 15) { score += 0;  notes.push(`LHX op margin ${om}%: normal`); }
      else if (om > 13) { score += 3;  notes.push(`LHX op margin ${om}%: compressing`); }
      else              { score += 8;  notes.push(`LHX op margin ${om}%: under pressure`); }
    }

    // TIPS overlay — long-duration compounder rate sensitivity
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 5;   notes.push(`TIPS ${tips}%: very restrictive — long-duration headwind`); }
      else if (tips > 2.5) { score += 2;   notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips < 0)   { score += -5;  notes.push(`TIPS ${tips}%: accommodative — compounder tailwind`); }
      else if (tips < 1)   { score += -2;  notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // VIX overlay — defense compounder catches defensive bid
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — LHX defensive quality bid`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — LHX as safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — LHX vulnerable to rotation`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── TMO STRATEGIC (V7.5) ────────────────────────────────────────────────
  // Peer P/E premium vs DHR primary signal (mirrors LIN's peer_valuation architecture).
  if (isTMO) {
    if (data.peer_valuation && data.peer_valuation.premium_pct != null) {
      const prem = data.peer_valuation.premium_pct;
      if (prem < -15)      { score += -22; notes.push(`TMO P/E ${prem.toFixed(1)}% vs DHR: deep discount — exceptional buy`); }
      else if (prem < -8)  { score += -15; notes.push(`TMO P/E ${prem.toFixed(1)}% vs DHR: discount — buy`); }
      else if (prem < 0)   { score += -7;  notes.push(`TMO P/E ${prem.toFixed(1)}% vs DHR: below peer`); }
      else if (prem <= 10) { score += 0;   notes.push(`TMO P/E +${prem.toFixed(1)}% vs DHR: in-line — fair value`); }
      else if (prem < 15)  { score += 5;   notes.push(`TMO P/E +${prem.toFixed(1)}% vs DHR: premium — trim bias`); }
      else                 { score += 12;  notes.push(`TMO P/E +${prem.toFixed(1)}% vs DHR: rich premium — trim`); }
    } else {
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 18)       { score += -12; notes.push(`TMO P/E ${pe.toFixed(1)}x: cheap (peer data unavailable)`); }
        else if (pe < 22)  { score += -5;  notes.push(`TMO P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 28) { score += 0;   notes.push(`TMO P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 32)  { score += 5;   notes.push(`TMO P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 12;  notes.push(`TMO P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Dividend yield — TMO yields ~0.3% (very low, buyback-heavy profile)
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 0.6)      { score += -3; notes.push(`TMO yield ${dy}%: above normal — modestly attractive`); }
      else if (dy > 0.4) { score += -1; notes.push(`TMO yield ${dy}%: above baseline`); }
      else if (dy > 0.3) { score += 0;  notes.push(`TMO yield ${dy}%: normal baseline`); }
      else               { score += 2;  notes.push(`TMO yield ${dy}%: compressed`); }
    }

    // Op margin durability (TMO peak ~24-26%)
    if (data.fundamentals?.operating_margin_pct != null) {
      const om = data.fundamentals.operating_margin_pct;
      if (om > 25)      { score += -2; notes.push(`TMO op margin ${om}%: peak execution`); }
      else if (om > 23) { score += 0;  notes.push(`TMO op margin ${om}%: normal`); }
      else if (om > 21) { score += 3;  notes.push(`TMO op margin ${om}%: compressing`); }
      else              { score += 7;  notes.push(`TMO op margin ${om}%: significant compression`); }
    }

    // TIPS overlay — long-duration cash flow rate sensitivity
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 8;   notes.push(`TIPS ${tips}%: very restrictive — long-duration TMO headwind`); }
      else if (tips > 2.5) { score += 4;   notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips > 2)   { score += 2;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -8;  notes.push(`TIPS ${tips}%: accommodative — long-duration tailwind`); }
      else if (tips < 1)   { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // VIX overlay — quality compounder catches defensive bid in fear regimes
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — TMO defensive quality bid`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — TMO as safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — TMO vulnerable to rotation`); }
    }

    // DXY overlay — ~40% non-US revenue
    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 3;  notes.push(`DXY ${dxy}: very strong USD — TMO FX headwind`); }
      else if (dxy > 125) { score += 1;  notes.push(`DXY ${dxy}: strong USD — mild FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -1; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -3; notes.push(`DXY ${dxy}: weak USD — FX tailwind`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── NOW STRATEGIC (V7.6) ────────────────────────────────────────────────
  // Cohort P/E premium primary signal vs CRM/WDAY/ADBE.
  // CRITICAL: NOW carries an 80-120% premium to cohort as BASELINE (higher growth +
  // higher quality, structural). Bands reflect this — <60% premium = unusual discount
  // = buy, >150% = stretched. Direction of change matters more than absolute level.
  if (isNOW) {
    if (data.cohort_valuation && data.cohort_valuation.premium_pct != null) {
      const prem = data.cohort_valuation.premium_pct;
      if (prem < 60)        { score += -25; notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: UNUSUAL DISCOUNT (well below 80-120% baseline) — exceptional buy`); }
      else if (prem < 80)   { score += -15; notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: below normal premium range — buy bias`); }
      else if (prem < 100)  { score += -8;  notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: mild discount to normal — buy lean`); }
      else if (prem <= 120) { score += 0;   notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: NORMAL deserved premium`); }
      else if (prem < 150)  { score += 5;   notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: above normal — mild trim`); }
      else if (prem < 180)  { score += 12;  notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: stretched premium — trim`); }
      else                  { score += 20;  notes.push(`NOW P/E +${prem.toFixed(1)}% vs cohort: extreme premium — strong trim`); }
    } else {
      // Fallback to absolute P/E if cohort data unavailable (NOW typical 50-70x forward)
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 50)       { score += -12; notes.push(`NOW P/E ${pe.toFixed(1)}x: cheap (cohort data unavailable)`); }
        else if (pe < 55)  { score += -5;  notes.push(`NOW P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 65) { score += 0;   notes.push(`NOW P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 70)  { score += 5;   notes.push(`NOW P/E ${pe.toFixed(1)}x: rich`); }
        else if (pe < 80)  { score += 12;  notes.push(`NOW P/E ${pe.toFixed(1)}x: stretched`); }
        else               { score += 18;  notes.push(`NOW P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Forward PEG (growth-adjusted) — if available from LLM-sourced fundamentals
    if (data.fundamentals?.forward_peg != null) {
      const peg = data.fundamentals.forward_peg;
      if (peg < 2.0)      { score += -8; notes.push(`Forward PEG ${peg.toFixed(2)}: cheap on growth — strong buy`); }
      else if (peg < 2.5) { score += -4; notes.push(`Forward PEG ${peg.toFixed(2)}: reasonable on growth`); }
      else if (peg < 3.0) { score += 0;  notes.push(`Forward PEG ${peg.toFixed(2)}: normal for premium SaaS`); }
      else if (peg < 3.5) { score += 4;  notes.push(`Forward PEG ${peg.toFixed(2)}: rich on growth`); }
      else                { score += 10; notes.push(`Forward PEG ${peg.toFixed(2)}: expensive on growth — trim bias`); }
    }

    // TIPS overlay — long-duration cash flow rate sensitivity (premium SaaS most rate-sensitive)
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 10;  notes.push(`TIPS ${tips}%: very restrictive — severe long-duration NOW headwind`); }
      else if (tips > 2.5) { score += 5;   notes.push(`TIPS ${tips}%: restrictive — long-duration headwind`); }
      else if (tips > 2)   { score += 2;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -10; notes.push(`TIPS ${tips}%: accommodative — long-duration tailwind`); }
      else if (tips < 1)   { score += -4;  notes.push(`TIPS ${tips}%: low real rates — SaaS multiples expand`); }
    }

    // VIX overlay — premium SaaS catches defensive bid in fear regimes
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — NOW quality bid in fear regime`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — NOW as quality safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — NOW vulnerable to rotation`); }
    }

    // DXY overlay — NOW has ~30% non-US revenue
    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 3;  notes.push(`DXY ${dxy}: very strong USD — NOW FX headwind`); }
      else if (dxy > 125) { score += 1;  notes.push(`DXY ${dxy}: strong USD — mild FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -1; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -3; notes.push(`DXY ${dxy}: weak USD — FX tailwind`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── MA STRATEGIC (V8.2): TWIN PREMIUM + DISRUPTION MATRIX ────────────────
  if (isMA) {
    // Twin P/E premium vs V — primary strategic lens with MA-SPECIFIC BANDS.
    // MA carries a 10-20% premium to V as BASELINE (faster grower, larger VAS
    // mix). Compression toward parity = buy; direction of change > level.
    if (data.twin_valuation && data.twin_valuation.premium_pct != null) {
      const prem = data.twin_valuation.premium_pct;
      if (prem < 0)         { score += -20; notes.push(`Mastercard P/E ${prem.toFixed(1)}% vs V: DISCOUNT to twin (rare) — exceptional buy`); }
      else if (prem < 5)    { score += -14; notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: COMPRESSED (below 10-20% baseline) — buy`); }
      else if (prem < 10)   { score += -8;  notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: below normal premium — buy lean`); }
      else if (prem <= 20)  { score += 0;   notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: NORMAL faster-grower premium`); }
      else if (prem < 25)   { score += 5;   notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: above normal — mild trim`); }
      else if (prem < 30)   { score += 12;  notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: rich premium — trim`); }
      else                  { score += 18;  notes.push(`Mastercard P/E +${prem.toFixed(1)}% vs V: extreme premium — strong trim`); }
    } else {
      // Fallback to absolute P/E if twin data unavailable (MA 3y avg ~35.7x, 10y ~37.8x)
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 26)       { score += -12; notes.push(`Mastercard P/E ${pe.toFixed(1)}x: deep own-history discount (twin data unavailable)`); }
        else if (pe < 29)  { score += -6;  notes.push(`Mastercard P/E ${pe.toFixed(1)}x: below own-history norm`); }
        else if (pe <= 36) { score += 0;   notes.push(`Mastercard P/E ${pe.toFixed(1)}x: normal own-history range (3y avg ~35.7x)`); }
        else if (pe < 40)  { score += 5;   notes.push(`Mastercard P/E ${pe.toFixed(1)}x: above own-history norm`); }
        else if (pe < 45)  { score += 12;  notes.push(`Mastercard P/E ${pe.toFixed(1)}x: stretched`); }
        else               { score += 18;  notes.push(`Mastercard P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Forward PEG (growth-adjusted) — if available from LLM-sourced fundamentals
    if (data.fundamentals?.forward_peg != null) {
      const peg = data.fundamentals.forward_peg;
      if (peg < 1.4)      { score += -8; notes.push(`Forward PEG ${peg.toFixed(2)}: cheap on growth — strong buy`); }
      else if (peg < 2.0) { score += -4; notes.push(`Forward PEG ${peg.toFixed(2)}: reasonable compounder pricing`); }
      else if (peg < 2.2) { score += 0;  notes.push(`Forward PEG ${peg.toFixed(2)}: normal`); }
      else if (peg < 2.5) { score += 4;  notes.push(`Forward PEG ${peg.toFixed(2)}: rich on growth`); }
      else                { score += 10; notes.push(`Forward PEG ${peg.toFixed(2)}: expensive on growth — trim bias`); }
    }

    // Disruption matrix — narrative phase vs fundamental evidence (categoricals,
    // LLM-sourced, null-safe). The narrative-evidence GAP is the alpha.
    if (data.fundamentals?.disruption_fundamental_evidence) {
      const ev = String(data.fundamentals.disruption_fundamental_evidence).toLowerCase();
      if (ev === "none")            { score += -3; notes.push(`Disruption evidence: NONE — real-economy merchant displacement not observed`); }
      else if (ev === "anecdotal")  { score += 0;  notes.push(`Disruption evidence: anecdotal only`); }
      else if (ev === "measurable") { score += 12; notes.push(`Disruption evidence: MEASURABLE real-economy displacement — thesis pressure`); }
      else if (ev === "material")   { score += 25; notes.push(`Disruption evidence: MATERIAL — THESIS-BREAK territory`); }
    }
    if (data.fundamentals?.disruption_narrative_phase) {
      const ph = String(data.fundamentals.disruption_narrative_phase).toLowerCase();
      if (ph === "narrative_peak")        { score += -8; notes.push(`Disruption narrative: PEAK fear — maximum narrative-evidence gap (the alpha)`); }
      else if (ph === "narrative_active") { score += -4; notes.push(`Disruption narrative: active — elevated fear discount persists`); }
      else if (ph === "narrative_fading") { score += 0;  notes.push(`Disruption narrative: fading`); }
      else if (ph === "resolved")         { score += 4;  notes.push(`Disruption narrative: resolved — re-rating complete, entry edge gone`); }
    }

    // Interchange / network-fee regulation — the binary thesis variable
    if (data.fundamentals?.interchange_regulation_status) {
      const reg = String(data.fundamentals.interchange_regulation_status).toLowerCase();
      if (reg === "dormant")               { score += -2; notes.push(`Interchange regulation: dormant`); }
      else if (reg === "proposed_stalled") { score += 0;  notes.push(`Interchange regulation: proposed but stalled — status quo`); }
      else if (reg === "advancing")        { score += 10; notes.push(`Interchange regulation: ADVANCING — strategic caution, size by proximity to passage`); }
      else if (reg === "passed")           { score += 30; notes.push(`Interchange regulation: PASSED — THESIS BREAK`); }
    }

    // TIPS overlay — mild (MA is less rate-sensitive than the long-duration names)
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 4;  notes.push(`TIPS ${tips}%: very restrictive — consumer-spend headwind`); }
      else if (tips > 2.5) { score += 2;  notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips < 0)   { score += -4; notes.push(`TIPS ${tips}%: accommodative — spend tailwind`); }
      else if (tips < 1)   { score += -2; notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // VIX overlay — beta-0.83 quality compounder catches defensive bid in fear
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — Mastercard quality bid in fear regime`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — quality safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — vulnerable to rotation`); }
    }

    // DXY overlay — weighted heavier than NOW (~2/3 of MA revenue is international)
    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 4;  notes.push(`DXY ${dxy}: very strong USD — significant FX headwind (~2/3 international revenue)`); }
      else if (dxy > 125) { score += 2;  notes.push(`DXY ${dxy}: strong USD — FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -2; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -4; notes.push(`DXY ${dxy}: weak USD — FX tailwind`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── ISRG STRATEGIC (V8.2): COHORT PREMIUM + MOAT MONITOR ─────────────────
  if (isISRG) {
    // Cohort P/E premium vs MDT/SYK/BSX — primary strategic lens with
    // ISRG-SPECIFIC BANDS. ISRG carries 60-120% premium as BASELINE (category
    // king, ~86% recurring annuity). Absolute PE is NEVER the signal.
    if (data.cohort_valuation && data.cohort_valuation.premium_pct != null) {
      const prem = data.cohort_valuation.premium_pct;
      if (prem < 60)        { score += -25; notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: UNUSUAL DISCOUNT (well below 60-120% baseline) — exceptional buy`); }
      else if (prem < 90)   { score += -14; notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: below mid-premium — buy bias`); }
      else if (prem < 105)  { score += -6;  notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: lower-normal — buy lean`); }
      else if (prem <= 120) { score += 0;   notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: NORMAL category-king premium`); }
      else if (prem < 150)  { score += 6;   notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: above normal — mild trim`); }
      else if (prem < 180)  { score += 14;  notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: stretched premium — trim`); }
      else                  { score += 22;  notes.push(`ISRG P/E +${prem.toFixed(1)}% vs cohort: extreme premium — strong trim`); }
    } else {
      // Fallback to absolute P/E with ISRG's own-history bands (3y avg ~72x,
      // 5y ~69x, 10y ~61x — NEVER generic bands; 50-70x trailing is NORMAL here)
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 45)       { score += -14; notes.push(`ISRG P/E ${pe.toFixed(1)}x: deep own-history discount (cohort data unavailable; 3y avg ~72x)`); }
        else if (pe < 52)  { score += -8;  notes.push(`ISRG P/E ${pe.toFixed(1)}x: well below own-history norm`); }
        else if (pe < 58)  { score += -3;  notes.push(`ISRG P/E ${pe.toFixed(1)}x: below own-history norm`); }
        else if (pe <= 72) { score += 0;   notes.push(`ISRG P/E ${pe.toFixed(1)}x: normal own-history range (premium franchise)`); }
        else if (pe < 80)  { score += 6;   notes.push(`ISRG P/E ${pe.toFixed(1)}x: above own-history norm`); }
        else if (pe < 90)  { score += 14;  notes.push(`ISRG P/E ${pe.toFixed(1)}x: stretched`); }
        else               { score += 20;  notes.push(`ISRG P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Forward PEG (premium-franchise bands) — if available from LLM-sourced fundamentals
    if (data.fundamentals?.forward_peg != null) {
      const peg = data.fundamentals.forward_peg;
      if (peg < 2.0)      { score += -8; notes.push(`Forward PEG ${peg.toFixed(2)}: cheap on growth — strong buy`); }
      else if (peg < 2.8) { score += -3; notes.push(`Forward PEG ${peg.toFixed(2)}: reasonable for premium franchise`); }
      else if (peg < 3.0) { score += 0;  notes.push(`Forward PEG ${peg.toFixed(2)}: normal`); }
      else if (peg < 3.5) { score += 4;  notes.push(`Forward PEG ${peg.toFixed(2)}: rich on growth`); }
      else                { score += 10; notes.push(`Forward PEG ${peg.toFixed(2)}: expensive on growth — trim bias`); }
    }

    // Moat status — the structural binary #1 (categorical, LLM-sourced from
    // Hugo installed-base/procedure evidence + Ottava timeline). "Probing" is
    // the EXPECTED state with two entrants — neutral, not a warning.
    if (data.fundamentals?.moat_status) {
      const ms = String(data.fundamentals.moat_status).toLowerCase();
      if (ms === "intact")        { score += -4; notes.push(`Moat status: INTACT — no measurable procedure-share erosion`); }
      else if (ms === "probing")  { score += 0;  notes.push(`Moat status: probing — competitor placements growing, no procedure-share loss (expected state)`); }
      else if (ms === "eroding")  { score += 18; notes.push(`Moat status: ERODING — measurable procedure-share loss — thesis pressure`); }
      else if (ms === "breached") { score += 35; notes.push(`Moat status: BREACHED — structural share loss — THESIS BREAK`); }
    }

    // 2027 instrument-lifespan transition — the structural binary #2.
    // Unquantified fear while fundamentals beat = the narrative-evidence gap
    // (buy). Quantified-manageable = relief re-rating catalyst (stronger buy).
    // Quantified-material = thesis-level annuity impairment.
    if (data.fundamentals?.instrument_transition_status) {
      const it = String(data.fundamentals.instrument_transition_status).toLowerCase();
      if (it === "unquantified_fear")          { score += -5; notes.push(`2027 instrument transition: UNQUANTIFIED FEAR — market can't size it while fundamentals beat (the alpha)`); }
      else if (it === "quantified_manageable") { score += -8; notes.push(`2027 instrument transition: QUANTIFIED MANAGEABLE — relief re-rating catalyst`); }
      else if (it === "quantified_material")   { score += 25; notes.push(`2027 instrument transition: QUANTIFIED MATERIAL — annuity impairment, THESIS-LEVEL event`); }
    }

    // TIPS overlay — premium multiple = long-duration rate sensitivity
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 8;  notes.push(`TIPS ${tips}%: very restrictive — severe premium-multiple headwind`); }
      else if (tips > 2.5) { score += 4;  notes.push(`TIPS ${tips}%: restrictive — premium-multiple headwind`); }
      else if (tips > 2)   { score += 2;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -8; notes.push(`TIPS ${tips}%: accommodative — premium multiples expand`); }
      else if (tips < 1)   { score += -3; notes.push(`TIPS ${tips}%: low real rates — multiple tailwind`); }
    }

    // VIX overlay
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — category-king quality bid in fear regime`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — premium multiple vulnerable`); }
    }

    // DXY overlay — ~1/3 international revenue, mild FX sensitivity
    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 2;  notes.push(`DXY ${dxy}: very strong USD — mild FX headwind`); }
      else if (dxy > 125) { score += 1;  notes.push(`DXY ${dxy}: strong USD`); }
      else if (dxy < 115) { score += -2; notes.push(`DXY ${dxy}: weak USD — FX tailwind`); }
    }

    return { score: clamp(score), notes };
  }

  if (isRDDT) {
    // Ads-cohort P/E vs META/PINS/APP. Unlike ISRG/NOW there is NO structural
    // premium baseline — RDDT sits INSIDE the cohort band. NOTE the basis is
    // TRAILING (all Finnhub aux metrics are); the LLM layer reasons on forward.
    if (data.cohort_valuation && data.cohort_valuation.premium_pct != null) {
      const prem = data.cohort_valuation.premium_pct;
      if (prem < -25)      { score += -18; notes.push(`RDDT P/E ${prem.toFixed(1)}% vs ads cohort: deeply compressed — buy`); }
      else if (prem < -15) { score += -12; notes.push(`RDDT P/E ${prem.toFixed(1)}% vs ads cohort: compressed — buy bias`); }
      else if (prem < 0)   { score += -5;  notes.push(`RDDT P/E ${prem.toFixed(1)}% vs ads cohort: below cohort — buy lean`); }
      else if (prem <= 20) { score += 0;   notes.push(`RDDT P/E +${prem.toFixed(1)}% vs ads cohort: inside normal band`); }
      else if (prem < 40)  { score += 4;   notes.push(`RDDT P/E +${prem.toFixed(1)}% vs ads cohort: upper-normal band`); }
      else if (prem < 80)  { score += 12;  notes.push(`RDDT P/E +${prem.toFixed(1)}% vs ads cohort: above normal — trim bias`); }
      else                 { score += 20;  notes.push(`RDDT P/E +${prem.toFixed(1)}% vs ads cohort: rich even on this growth — trim`); }
    } else {
      // Absolute trailing-P/E fallback with DELIBERATELY WIDE, HUMBLE BANDS.
      // RDDT listed March 2024 — there is no trustworthy own-history P/E norm
      // to anchor tight bands against, and the earnings denominator is still
      // inflecting. Wide bands are the honest representation of that ignorance.
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 20)       { score += -12; notes.push(`RDDT P/E ${pe.toFixed(1)}x: low for the growth rate (cohort data unavailable; bands wide — short listing history)`); }
        else if (pe < 28)  { score += -6;  notes.push(`RDDT P/E ${pe.toFixed(1)}x: below the growth-adjusted norm`); }
        else if (pe <= 40) { score += 0;   notes.push(`RDDT P/E ${pe.toFixed(1)}x: unremarkable for 50%+ growth`); }
        else if (pe < 55)  { score += 6;   notes.push(`RDDT P/E ${pe.toFixed(1)}x: elevated`); }
        else if (pe < 75)  { score += 12;  notes.push(`RDDT P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 18;  notes.push(`RDDT P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // ★ GUARDRAIL (a) — PEG ARTIFACT GATE. RDDT forward PEG sits near 0.09
    // because EPS is inflecting off a near-zero prior-year base, NOT because
    // the stock offers a 10x margin of safety. Anything below 0.4 scores ZERO
    // and is annotated. Without this gate the strategic layer pins near -100
    // on every run and the whole blend becomes uninformative.
    if (data.fundamentals?.forward_peg != null) {
      const peg = data.fundamentals.forward_peg;
      if (peg < 0.4)      { score += 0;  notes.push(`Forward PEG ${peg.toFixed(2)}: ARTIFACT (base effect — EPS inflecting off ~zero). Deliberately scored ZERO, not treated as a buy signal.`); }
      else if (peg < 0.8) { score += -8; notes.push(`Forward PEG ${peg.toFixed(2)}: genuinely attractive on growth`); }
      else if (peg < 1.4) { score += -3; notes.push(`Forward PEG ${peg.toFixed(2)}: fair`); }
      else if (peg < 2.0) { score += 0;  notes.push(`Forward PEG ${peg.toFixed(2)}: normal`); }
      else                { score += 8;  notes.push(`Forward PEG ${peg.toFixed(2)}: stretched on growth — trim bias`); }
    }

    // ★ GUARDRAIL (b) — PARTIAL-WINDOW DAMPING. P/S vs own history is the
    // flagship lens (P/S rather than P/E because margins are still inflecting),
    // but RDDT's "3-year" average covers ~2.4 years spanning the crossing into
    // GAAP profitability. Contributions are HALVED relative to the ISRG/NOW
    // own-history pattern. The signal is real; the precision is not.
    if (data.fundamentals?.ps_pct_of_3y_avg != null) {
      const ps = data.fundamentals.ps_pct_of_3y_avg;
      const partial = data.fundamentals?.own_history_window_partial === true;
      const tag = partial ? " [partial window — contribution halved]" : "";
      if (ps < 70)        { score += -8; notes.push(`P/S ${ps.toFixed(0)}% of own-history avg: well below${tag}`); }
      else if (ps < 80)   { score += -5; notes.push(`P/S ${ps.toFixed(0)}% of own-history avg: below${tag}`); }
      else if (ps <= 105) { score += 0;  notes.push(`P/S ${ps.toFixed(0)}% of own-history avg: in line${tag}`); }
      else if (ps < 120)  { score += 4;  notes.push(`P/S ${ps.toFixed(0)}% of own-history avg: above${tag}`); }
      else                { score += 8;  notes.push(`P/S ${ps.toFixed(0)}% of own-history avg: well above${tag}`); }
    }

    // Search-referral status — the structural binary #1. Logged-out user
    // acquisition runs through Google. "Choppy" is the CURRENT state and is
    // scored neutral on its own; it only becomes a buy when ad revenue is
    // simultaneously compounding, which is the fear-vs-evidence gap.
    if (data.fundamentals?.search_referral_status) {
      const sr = String(data.fundamentals.search_referral_status).toLowerCase();
      const adg = data.fundamentals?.ad_revenue_growth_yoy_pct;
      if (sr === "stable")                   { score += -8;  notes.push(`Search referral: STABLE — dependency quiet; structurally the lowest-risk non-catalyst state`); }
      else if (sr === "decoupling_progress") { score += -12; notes.push(`Search referral: DECOUPLING PROGRESS — the structural re-rating catalyst`); }
      else if (sr === "choppy") {
        if (adg != null && adg > 45)         { score += -5;  notes.push(`Search referral: CHOPPY while ad revenue +${adg.toFixed(1)}% — fear-vs-evidence gap is the alpha`); }
        else                                 { score += 0;   notes.push(`Search referral: CHOPPY — expected state; neutral without an ad-growth print to argue against it`); }
      }
      else if (sr === "deteriorating")       { score += 22;  notes.push(`Search referral: DETERIORATING — THESIS-LEVEL event, the falsifier landing`); }
    }

    // Data licensing — structural binary #2. Google + OpenAI >$200M/yr combined,
    // renewals unresolved with no stated timeline. Unresolved scores ZERO on
    // purpose: it is an unpriced option, not a base case.
    if (data.fundamentals?.licensing_status) {
      const ls = String(data.fundamentals.licensing_status).toLowerCase();
      if (ls === "renewed_up")        { score += -10; notes.push(`Data licensing: RENEWED UP — option struck in the money`); }
      else if (ls === "renewed_flat") { score += -4;  notes.push(`Data licensing: RENEWED FLAT — overhang cleared`); }
      else if (ls === "unresolved")   { score += 0;   notes.push(`Data licensing: UNRESOLVED — unpriced option, deliberately not in the base case`); }
      else if (ls === "renewed_down") { score += 10;  notes.push(`Data licensing: RENEWED DOWN — terms worsened`); }
      else if (ls === "lost")         { score += 20;  notes.push(`Data licensing: LOST — revenue line and the AI-corpus thesis both impaired`); }
    }

    // ★ NET share count change (POSITIVE = dilution). This is the shareholder-
    // return read for RDDT — NEVER buyback yield. RDDT repurchased $235M in
    // Q2'26 and share count still rose ~2.8%: stock comp exceeds repurchase.
    // This holding does not satisfy the portfolio's aggressive-buyback
    // criterion and the engine says so rather than scoring a gross figure.
    if (data.fundamentals?.share_count_change_yoy_pct != null) {
      const sc = data.fundamentals.share_count_change_yoy_pct;
      if (sc <= -2)      { score += -5; notes.push(`Net share count ${sc.toFixed(1)}% YoY: genuine buyback — per-share compounding`); }
      else if (sc <= 0)  { score += -2; notes.push(`Net share count ${sc.toFixed(1)}% YoY: flat to shrinking`); }
      else if (sc < 1.5) { score += 1;  notes.push(`Net share count +${sc.toFixed(1)}% YoY: mild dilution`); }
      else if (sc < 3)   { score += 3;  notes.push(`Net share count +${sc.toFixed(1)}% YoY: DILUTIVE — buyback does not offset stock comp (fails the portfolio's buyback criterion)`); }
      else if (sc < 5)   { score += 7;  notes.push(`Net share count +${sc.toFixed(1)}% YoY: materially dilutive — per-share compounding impaired`); }
      else               { score += 12; notes.push(`Net share count +${sc.toFixed(1)}% YoY: severe dilution`); }
    }

    // Competitive engagement threat — placements/launches are NOT evidence;
    // measurable engagement share is.
    if (data.fundamentals?.competitive_threat) {
      const ct = String(data.fundamentals.competitive_threat).toLowerCase();
      if (ct === "negligible")        { score += -2; notes.push(`Competitive threat: negligible`); }
      else if (ct === "emerging")     { score += 0;  notes.push(`Competitive threat: emerging — entrants present, no measured engagement loss (expected state)`); }
      else if (ct === "taking_share") { score += 20; notes.push(`Competitive threat: TAKING SHARE — measurable engagement loss, THESIS-LEVEL event`); }
    }

    // TIPS overlay — a 50%-growth name is long-duration regardless of a modest
    // forward multiple; real rates move the discount rate on the ARPU runway.
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 8;  notes.push(`TIPS ${tips}%: very restrictive — growth-duration headwind`); }
      else if (tips > 2.5) { score += 4;  notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips > 2)   { score += 2;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -8; notes.push(`TIPS ${tips}%: accommodative — growth-duration tailwind`); }
      else if (tips < 1)   { score += -3; notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // VIX overlay — beta 1.94 means broad fear overshoots on this name
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -6; notes.push(`VIX ${vix}: panic — beta-1.94 overshoot creates the entry`); }
      else if (vix > 25) { score += -3; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — high-beta growth vulnerable`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── MLM STRATEGIC (V8.4): FWD PE + EV/EBITDA + VMC TWIN + FUNDING + LNA ──
  if (isMLM) {
    // ★★ GUARDRAIL (a) — DIVESTITURE-GAIN PE GATE, part 1: the cohort premium.
    // fetch-market-data v4.17 computes the aggregates-cohort premium off
    // Finnhub TRAILING P/E and sets premium_pct_reliable = false when the
    // discount is steeper than -35% versus a same-industry cohort. MLM's TTM
    // window carries a large non-operating gain from the Quikrete asset
    // exchange, which drives that premium near -50%. Honouring the flag is what
    // stops a fabricated deep-discount BUY from entering the composite.
    const cv = data.cohort_valuation;
    if (cv && cv.premium_pct != null && cv.premium_pct_reliable === false) {
      score += 0;
      notes.push(`MLM P/E ${cv.premium_pct.toFixed(1)}% vs aggregates cohort: ARTIFACT (trailing basis contaminated by the Quikrete divestiture gain). Deliberately scored ZERO — routed to forward PE / EV/EBITDA instead.`);
    } else if (cv && cv.premium_pct != null) {
      // Tighter bands than RDDT's ads cohort: two aggregates franchises with
      // materially identical business models should track closely.
      const prem = cv.premium_pct;
      if (prem < -20)      { score += -16; notes.push(`MLM P/E ${prem.toFixed(1)}% vs aggregates cohort: deeply discounted — buy`); }
      else if (prem < -8)  { score += -10; notes.push(`MLM P/E ${prem.toFixed(1)}% vs aggregates cohort: discounted — buy bias`); }
      else if (prem <= 10) { score += 0;   notes.push(`MLM P/E ${prem >= 0 ? "+" : ""}${prem.toFixed(1)}% vs aggregates cohort: inside normal band`); }
      else if (prem <= 18) { score += 5;   notes.push(`MLM P/E +${prem.toFixed(1)}% vs aggregates cohort: upper-normal band`); }
      else                 { score += 14;  notes.push(`MLM P/E +${prem.toFixed(1)}% vs aggregates cohort: rich vs the complex — trim`); }
    }

    // ★ VMC TWIN PREMIUM — the flagship strategic read, on the MA/V twin
    // pattern. Same artifact gate applies: if the trailing basis is
    // contaminated, the twin comparison is equally meaningless.
    if (cv && cv.mlm_vs_vmc_pct != null && cv.premium_pct_reliable !== false) {
      const tw = cv.mlm_vs_vmc_pct;
      if (tw < -15)      { score += -12; notes.push(`MLM ${tw.toFixed(1)}% vs VMC: the twin is trading at a wide premium — dislocation`); }
      else if (tw < -8)  { score += -7;  notes.push(`MLM ${tw.toFixed(1)}% vs VMC: discounted to its own twin`); }
      else if (tw <= 10) { score += 0;   notes.push(`MLM ${tw >= 0 ? "+" : ""}${tw.toFixed(1)}% vs VMC: parity band — normal`); }
      else               { score += 8;   notes.push(`MLM +${tw.toFixed(1)}% vs VMC: premium to its own twin — trim bias`); }
    }

    // ★★ GUARDRAIL (a) part 2 — ABSOLUTE trailing P/E is scored ZERO whenever
    // trailing < 0.6 x forward. Identical predicate to isTrailingPeArtifact()
    // in mlm-strategy.jsx v1; keep the two in sync if either moves.
    const pe = data.valuation?.trailingPE;
    const fpe = data.fundamentals?.forward_pe;
    const peArtifact = (pe != null && fpe != null && pe > 0 && fpe > 0 && pe < 0.6 * fpe);
    if (peArtifact) {
      score += 0;
      notes.push(`Trailing P/E ${pe.toFixed(1)}x vs forward ${fpe.toFixed(1)}x: DIVESTITURE-GAIN ARTIFACT (trailing < 0.6x forward). Scored ZERO — a TTM profit margin above gross margin cannot come from operations.`);
    }

    // FORWARD P/E — the load-bearing multiple precisely because trailing is
    // contaminated. Only scored when the consensus basis is established: a
    // standalone forward EPS compared against a pro-forma context is the
    // mixed-basis error Guardrail (b') exists to prevent.
    if (fpe != null && fpe > 0) {
      const basis = data.fundamentals?.forward_pe_consensus_basis;
      if (basis === "mixed_or_unknown") {
        notes.push(`Forward P/E ${fpe.toFixed(1)}x: consensus basis UNKNOWN (standalone vs LNA pro-forma) — not scored; EV/EBITDA carries the valuation read instead`);
      } else {
        const tag = basis ? ` [${basis}]` : "";
        if (fpe < 22)      { score += -14; notes.push(`Forward P/E ${fpe.toFixed(1)}x: cheap for a reserve-moat franchise${tag}`); }
        else if (fpe < 24) { score += -9;  notes.push(`Forward P/E ${fpe.toFixed(1)}x: buy zone${tag}`); }
        else if (fpe < 26) { score += -4;  notes.push(`Forward P/E ${fpe.toFixed(1)}x: lower end of fair${tag}`); }
        else if (fpe <= 32){ score += 0;   notes.push(`Forward P/E ${fpe.toFixed(1)}x: fair for the growth + moat profile${tag}`); }
        else if (fpe <= 36){ score += 7;   notes.push(`Forward P/E ${fpe.toFixed(1)}x: elevated${tag}`); }
        else               { score += 14;  notes.push(`Forward P/E ${fpe.toFixed(1)}x: stretched${tag}`); }
      }
    }

    // EV/EBITDA — the cleaner lens whenever the forward-PE basis is murky,
    // because both legs are controlled here rather than by sell-side consensus.
    if (data.fundamentals?.ev_ebitda != null) {
      const ev = data.fundamentals.ev_ebitda;
      const evb = data.fundamentals?.ev_ebitda_basis;
      const tag = evb ? ` [${evb}]` : "";
      if (ev < 14)      { score += -12; notes.push(`EV/EBITDA ${ev.toFixed(1)}x: cheap vs the franchise's own history${tag}`); }
      else if (ev < 15) { score += -8;  notes.push(`EV/EBITDA ${ev.toFixed(1)}x: buy zone${tag}`); }
      else if (ev <= 19){ score += 0;   notes.push(`EV/EBITDA ${ev.toFixed(1)}x: fair${tag}`); }
      else if (ev <= 21){ score += 5;   notes.push(`EV/EBITDA ${ev.toFixed(1)}x: upper end of fair${tag}`); }
      else              { score += 12;  notes.push(`EV/EBITDA ${ev.toFixed(1)}x: rich${tag}`); }
    }

    // ★★ GUARDRAIL (b') — BASIS-CONSISTENCY ASSERTION. The pro-forma multiple
    // is scored ONLY when both legs are confirmed on the same basis. The error
    // this blocks: spot EV/EBITDA (~17.8x, TRAILING EBITDA) against a pro-forma
    // ~15.6x (2026 EBITDA) reads as a two-turn re-rating. Like-for-like FORWARD
    // it is ~15.8x standalone vs ~15.6x pro-forma — modestly accretive, roughly
    // neutral. A mixed-basis multiple is a lie that looks like data.
    if (data.fundamentals?.pro_forma_ev_ebitda != null) {
      const pf = data.fundamentals.pro_forma_ev_ebitda;
      if (data.fundamentals?.pro_forma_basis_consistent === true) {
        if (pf < 14)      { score += -8; notes.push(`Pro-forma EV/EBITDA ${pf.toFixed(1)}x: LNA bought below MLM's own multiple — accretive`); }
        else if (pf < 16) { score += -4; notes.push(`Pro-forma EV/EBITDA ${pf.toFixed(1)}x: modestly accretive`); }
        else if (pf <= 19){ score += 0;  notes.push(`Pro-forma EV/EBITDA ${pf.toFixed(1)}x: neutral to the standalone multiple`); }
        else              { score += 8;  notes.push(`Pro-forma EV/EBITDA ${pf.toFixed(1)}x: the deal makes the multiple worse — dilutive on valuation`); }
      } else {
        notes.push(`Pro-forma EV/EBITDA ${pf.toFixed(1)}x: BASIS NOT CONFIRMED CONSISTENT — not scored (mixed trailing/forward legs produce a spurious re-rating)`);
      }
    }

    // ── FEDERAL AUTHORIZATION — the dominant structural binary. IIJA expires
    // 2026-09-30; without reauthorization formula programs revert to pre-IIJA
    // baseline in FY2027 (~$28B/yr cut). ⚠ A short-term extension is the BASE
    // CASE and scores ZERO, not negative — patches are the historical rule.
    if (data.fundamentals?.federal_authorization_status) {
      const fa = String(data.fundamentals.federal_authorization_status).toLowerCase();
      if (fa === "multiyear_enacted_at_or_above_iija") { score += -18; notes.push(`Federal authorization: MULTIYEAR AT/ABOVE IIJA — multi-year volume visibility restored, the re-rating catalyst`); }
      else if (fa === "short_term_extension")          { score += 0;   notes.push(`Federal authorization: SHORT-TERM EXTENSION — the base case and the historical norm (12 extensions after TEA-21, 10 after SAFETEA-LU). Scored ZERO, not as a downgrade.`); }
      else if (fa === "pending_no_action")             { score += 3;   notes.push(`Federal authorization: PENDING, no action — mild uncertainty premium as the deadline approaches`); }
      else if (fa === "multiyear_enacted_below_iija")  { score += 20;  notes.push(`Federal authorization: MULTIYEAR BELOW IIJA — the volume cycle is structurally impaired. THESIS-LEVEL.`); }
      else if (fa === "lapsed")                        { score += 16;  notes.push(`Federal authorization: LAPSED — formula funding reverting to pre-IIJA baseline`); }
    }

    // State DOT budgets — the partial buffer against federal uncertainty.
    if (data.fundamentals?.state_dot_budget_trend) {
      const dt = String(data.fundamentals.state_dot_budget_trend).toLowerCase();
      if (dt === "accelerating")     { score += -6; notes.push(`State DOT budgets: ACCELERATING — buffers federal uncertainty`); }
      else if (dt === "contracting") { score += 6;  notes.push(`State DOT budgets: CONTRACTING — the buffer is gone`); }
    }

    // ── LNA (Lhoist) — TREATED AS A KNOWN FORWARD EVENT. Approvals landed
    // 2026-08-05 and the $6.5B notes priced 2026-08-12, so the model scores
    // pro-forma rather than waiting for close.
    // ★★ GUARDRAIL (b) — LEVERAGE IS SCORED ON THE GLIDEPATH, NOT THE LEVEL.
    // 3.7x at close is the plan working exactly as announced. Penalising the
    // level would trim on a deal that is already approved and financed.
    if (data.fundamentals?.delever_glidepath_status) {
      const gp = String(data.fundamentals.delever_glidepath_status).toLowerCase();
      const lev = data.fundamentals?.pro_forma_net_leverage;
      const levStr = lev != null ? ` (${lev.toFixed(2)}x)` : "";
      if (gp === "ahead")                   { score += -8; notes.push(`LNA delever glidepath: AHEAD${levStr} — integration outperforming`); }
      else if (gp === "on_track")           { score += -3; notes.push(`LNA delever glidepath: ON TRACK${levStr} — leverage is a non-event while the path holds`); }
      else if (gp === "not_yet_measurable") { score += 0;  notes.push(`LNA delever glidepath: not yet measurable${levStr} — pre-close, scored neutral`); }
      else if (gp === "behind")             { score += 14; notes.push(`LNA delever glidepath: BEHIND${levStr} — the deal is not working as underwritten`); }
    }
    if (data.fundamentals?.ma_integration_state) {
      const st = String(data.fundamentals.ma_integration_state).toLowerCase();
      if (st === "terminated") {
        score += 6;
        notes.push(`LNA state: TERMINATED — the pro-forma frame is void; every multiple above must be re-read on a standalone basis and the lime diversification thesis is gone`);
      } else if (st === "complete") {
        notes.push(`LNA state: COMPLETE — integration finished; pro-forma is now actual`);
      }
    }

    // ★ NET share count change — sign convention INVERTED relative to RDDT:
    // NEGATIVE = buyback. MLM is down ~1.1% YoY and genuinely satisfies the
    // portfolio's aggressive-buyback criterion, which RDDT never did.
    if (data.fundamentals?.share_count_change_yoy_pct != null) {
      const sc = data.fundamentals.share_count_change_yoy_pct;
      if (sc <= -2)      { score += -6; notes.push(`Net share count ${sc.toFixed(1)}% YoY: strong buyback — per-share compounding, satisfies the portfolio's buyback criterion`); }
      else if (sc <= -0.5){ score += -3; notes.push(`Net share count ${sc.toFixed(1)}% YoY: genuine buyback — meets the criterion`); }
      else if (sc <= 0.5){ score += 0;  notes.push(`Net share count ${sc >= 0 ? "+" : ""}${sc.toFixed(1)}% YoY: flat`); }
      else if (sc < 3)   { score += 3;  notes.push(`Net share count +${sc.toFixed(1)}% YoY: dilutive`); }
      else               { score += 7;  notes.push(`Net share count +${sc.toFixed(1)}% YoY: materially dilutive`); }
    }
    // Pro-forma share count books the LNA stock consideration NOW rather than
    // being surprised at close. Deliberately scored LIGHTER than the realised
    // figure: issuing equity to buy EBITDA at ~15x is not the same event as
    // diluting to fund stock comp.
    if (data.fundamentals?.pro_forma_share_count_change_pct != null) {
      const pfs = data.fundamentals.pro_forma_share_count_change_pct;
      if (pfs > 15)      { score += 5; notes.push(`Pro-forma share count +${pfs.toFixed(1)}% (incl. LNA stock consideration): large issuance — but purchasing EBITDA at ~15x, not funding stock comp`); }
      else if (pfs > 5)  { score += 3; notes.push(`Pro-forma share count +${pfs.toFixed(1)}% (incl. LNA stock consideration): material issuance`); }
    }

    // Reserve life — the actual moat. A slow-moving structural constant, so it
    // is scored gently: it does not change quarter to quarter and should not
    // swing the composite.
    if (data.fundamentals?.reserve_life_years != null) {
      const rl = data.fundamentals.reserve_life_years;
      if (rl > 75)      { score += -5; notes.push(`Reserve life ${rl}y: multi-generational permitted position — the moat, quantified`); }
      else if (rl > 50) { score += -3; notes.push(`Reserve life ${rl}y: long permitted position`); }
      else if (rl < 25) { score += 5;  notes.push(`Reserve life ${rl}y: short for this industry — permitting risk is the moat risk`); }
    }

    // ROIC — flagged, not scored, while acquisitions inflate the denominator.
    if (data.fundamentals?.roic_pct != null) {
      const ro = data.fundamentals.roic_pct;
      const wc = data.fundamentals?.wacc_pct;
      if (data.fundamentals?.roic_denominator_distorted === true) {
        notes.push(`ROIC ${ro.toFixed(1)}%${wc != null ? ` vs WACC ${wc.toFixed(1)}%` : ""}: DENOMINATOR DISTORTED by fresh M&A (capital base inflated ahead of the earnings) — flagged, not scored as a quality break`);
      } else if (wc != null) {
        if (ro - wc > 3)      { score += -6; notes.push(`ROIC ${ro.toFixed(1)}% vs WACC ${wc.toFixed(1)}%: creating value`); }
        else if (ro - wc < -2){ score += 6;  notes.push(`ROIC ${ro.toFixed(1)}% vs WACC ${wc.toFixed(1)}%: destroying value on clean capital — genuine quality concern`); }
      }
    }

    // ⚠ DIVIDEND YIELD IS DELIBERATELY NOT SCORED. At ~0.64% MLM is not a yield
    // vehicle — this is not ENB, LIN or KOF. Scoring it in either direction
    // would import a signal the security does not carry.

    // TIPS overlay — lighter than RDDT's. MLM has real near-term earnings and
    // is far less duration-sensitive than a 50%-growth name, but construction
    // demand IS rate-sensitive through housing and project financing.
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)        { score += 5;  notes.push(`TIPS ${tips}%: restrictive — pressures residential and project financing`); }
      else if (tips > 2.5) { score += 3;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)   { score += -5; notes.push(`TIPS ${tips}%: accommodative — construction financing tailwind`); }
      else if (tips < 1)   { score += -2; notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // VIX overlay — modest amplitudes for beta 1.11.
    const vixS = macro?.vix;
    if (vixS != null) {
      if (vixS > 35)      { score += -4; notes.push(`VIX ${vixS}: panic — quality industrial on sale`); }
      else if (vixS > 25) { score += -2; notes.push(`VIX ${vixS}: elevated fear`); }
      else if (vixS < 12) { score += 2;  notes.push(`VIX ${vixS}: complacency`); }
    }

    return { score: clamp(score), notes };
  }

  // ─── GENERIC STRATEGIC (fallback — currently only consumed by ASML) ──────
  const pe = data.valuation?.trailingPE;
  if (pe != null && pe > 0) {
    if (isCyclical) {
      if (pe > 100)     { score += -20; notes.push(`P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 50) { score += -12; notes.push(`P/E ${pe.toFixed(0)}x: depressed earnings — cyclical buy`); }
      else if (pe > 25) { score += -5;  notes.push(`P/E ${pe.toFixed(0)}x: below-trend earnings`); }
      else if (pe > 15) { score += 0;   notes.push(`P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 8)  { score += 10;  notes.push(`P/E ${pe.toFixed(0)}x: peak earnings — cyclical caution`); }
      else              { score += 20;  notes.push(`P/E ${pe.toFixed(0)}x: super-peak — cyclical trim`); }
    } else if (isASML) {
      if (pe < 18)       { score += -15; notes.push(`ASML P/E ${pe.toFixed(1)}x: deep value — very rare`); }
      else if (pe < 25)  { score += -10; notes.push(`ASML P/E ${pe.toFixed(1)}x: cheap for ASML`); }
      else if (pe < 32)  { score += -3;  notes.push(`ASML P/E ${pe.toFixed(1)}x: below normal compounder range`); }
      else if (pe <= 42) { score += 0;   notes.push(`ASML P/E ${pe.toFixed(1)}x: normal compounder range`); }
      else if (pe < 50)  { score += 5;   notes.push(`ASML P/E ${pe.toFixed(1)}x: rich`); }
      else               { score += 12;  notes.push(`ASML P/E ${pe.toFixed(1)}x: extreme — peak hype`); }
    } else {
      if (pe < 8)        { score += -15; notes.push(`P/E ${pe}: deep value`); }
      else if (pe < 12)  { score += -8;  notes.push(`P/E ${pe}: value`); }
      else if (pe < 18)  { score += -3;  notes.push(`P/E ${pe}: fair`); }
      else if (pe <= 25) { score += 0;   notes.push(`P/E ${pe}: moderate`); }
      else if (pe < 35)  { score += 8;   notes.push(`P/E ${pe}: rich`); }
      else if (pe < 50)  { score += 15;  notes.push(`P/E ${pe}: expensive`); }
      else               { score += 25;  notes.push(`P/E ${pe}: extreme`); }
    }
  }

  if (!isASML && !isENB) {
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
      else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
      else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
      else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
    }
  }

  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0 && !isENB && !isASML) {
    if (dy > 8)      { score += -10; notes.push(`Yield ${dy}%: very high`); }
    else if (dy > 5) { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
    else if (dy > 3) { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
  }

  const vix = macro?.vix;
  if (vix != null && !isENB) {
    if (isASML) {
      if (vix > 35)      { score += -10; notes.push(`VIX ${vix}: panic — ASML contrarian buy`); }
      else if (vix > 25) { score += -4;  notes.push(`VIX ${vix}: elevated fear — mild ASML buy bias`); }
      else if (vix < 12) { score += 3;   notes.push(`VIX ${vix}: complacency — marginal caution`); }
    } else {
      if (vix > 35)      { score += -8; notes.push(`VIX ${vix}: panic — contrarian buy`); }
      else if (vix > 25) { score += -3; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 13) { score += 5;  notes.push(`VIX ${vix}: complacency`); }
    }
  }

  const tips = macro?.tips10y;
  if (tips != null && !isENB) {
    if (isASML) {
      if (tips > 3)        { score += 8;   notes.push(`TIPS ${tips}%: very restrictive — long-duration headwind`); }
      else if (tips > 2.5) { score += 4;   notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips < 0)   { score += -8;  notes.push(`TIPS ${tips}%: accommodative — long-duration tailwind`); }
      else if (tips < 1)   { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    } else {
      if (tips > 2.5)     { score += 5;  notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips > 2)  { score += 2;  }
      else if (tips < 0)  { score += -5; notes.push(`TIPS ${tips}%: accommodative`); }
    }
  }

  return { score: clamp(score), notes };
}

// ─── COMPOSITE ──────────────────────────────────────────────────────────────
export function computeDeterministicScores(data, macro) {
  const tactical = scoreTactical(data, macro);
  const positional = scorePositional(data, macro);
  const strategic = scoreStrategic(data, macro);

  // V3: LIN regime-conditional weights override based on global PMI.
  // V8.1: regime conditioning extended to MSFT/NOW (real rate), LHX (ITA vs SPY
  // 30d factor flow), TMO (XBI 90d funding) — LIN V3 pattern, ±5pp shifts off
  // each static base. Other archetypes use their pre-set _weights, or the
  // default 25/35/40.
  let weights = data._weights || { t: 0.25, p: 0.35, s: 0.40 };
  let regime = null;
  let regimePmi = null;     // LIN only — numeric geo-weighted PMI (name kept for contract stability)
  let regimeDriver = null;  // V8.1 — numeric driver behind the regime choice
  let regimeBasis = null;   // V8.1 — "pmi" | "real_rate" | "ita_vs_spy_30d_pp" | "xbi_90d_return_pct"
  if (data._archetype === "oligopoly_quality_compounder") {
    const r = computeLINRegimeWeights(macro);
    weights = r.weights; regime = r.regime; regimePmi = r.pmi;
    regimeDriver = r.pmi; regimeBasis = "pmi";
  } else if (data._archetype === "ai_infra_quality_compounder" || data._archetype === "ai_workflow_quality_compounder") {
    const r = computeRealRateRegimeWeights(macro);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "real_rate";
  } else if (data._archetype === "defense_prime_backlog_compounder") {
    const r = computeLHXRegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "ita_vs_spy_30d_pp";
  } else if (data._archetype === "life_sciences_quality_compounder") {
    const r = computeTMORegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "xbi_90d_return_pct";
  } else if (data._archetype === "payments_network_quality_compounder") {
    const r = computeMARegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "duopoly_vs_spy_pp";
  } else if (data._archetype === "surgical_robotics_moat_compounder") {
    const r = computeISRGRegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "ihi_vs_spy_30d_pp";
  } else if (data._archetype === "hypergrowth_platform_monetizer") {
    const r = computeRDDTRegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "xlc_vs_spy_30d_pp";
  } else if (data._archetype === "reserve_moat_infrastructure_compounder") {
    const r = computeMLMRegimeWeights(data);
    weights = r.weights; regime = r.regime; regimeDriver = r.driver; regimeBasis = "federal_authorization_status";
  }

  const composite = Math.round(
    tactical.score * weights.t +
    positional.score * weights.p +
    strategic.score * weights.s
  );

  return {
    tactical,
    positional,
    strategic,
    composite: { score: clamp(composite) },
    weights,
    regime,       // null for non-regime archetypes. LIN: expansion|neutral|contraction.
                  // MSFT/NOW: accommodative|neutral|restrictive. LHX: bid_active|neutral|bid_absent.
                  // TMO: thawing|neutral|frozen. MA: fear_receding|neutral|fear_regime (V8.2).
                  // ISRG: bid_active|neutral|bid_absent (V8.2).
                  // RDDT: bid_active|neutral|bid_absent (V8.3, off a 25/35/40 base).
                  // MLM: funded|neutral|unfunded, each optionally "_damped" post-LNA-close
                  // (V8.4, off a 20/35/45 base — LIN's triple, deliberately reused).
    regimePmi,    // numeric geo-weighted PMI used to choose regime (LIN only — kept for contract stability)
    regimeDriver, // V8.1 — numeric driver behind the regime choice (PMI / real rate / pp / %)
    regimeBasis,  // V8.1/V8.2/V8.4 — "pmi" | "real_rate" | "ita_vs_spy_30d_pp" | "xbi_90d_return_pct" | "duopoly_vs_spy_pp" | "ihi_vs_spy_30d_pp" | "xlc_vs_spy_30d_pp" | "federal_authorization_status"
    allNotes: [...tactical.notes, ...positional.notes, ...strategic.notes],
  };
}

// ─── BLEND deterministic + LLM scores ───────────────────────────────────────
// Per-timeframe weights reflect where each component earns its keep:
//   Tactical:   numerical signals dominate → lean deterministic (70/30)
//   Positional: mixed → 50/50
//   Strategic:  narrative/catalyst-heavy → lean LLM (30/70)
const BLEND_WEIGHTS = {
  tactical:   { det: 0.70, llm: 0.30 },
  positional: { det: 0.50, llm: 0.50 },
  strategic:  { det: 0.30, llm: 0.70 },
};

// V3: Per-archetype blend overrides.
// LIN's positional and strategic now have many more deterministic inputs
// (ASU util, price/mix, BBB OAS, EPS revisions, premium delta, H2 layer),
// so we lean a bit more on deterministic for those layers.
// MSFT/LHX/TMO/NOW V1: use defaults — most strategic content (forward PE, PE-vs-history,
// cycle phase, regime narrative) is qualitative and best-handled by the LLM layer.
const BLEND_WEIGHTS_BY_ARCHETYPE = {
  oligopoly_quality_compounder: {
    tactical:   { det: 0.65, llm: 0.35 }, // slightly more LLM for narrative tactical inputs
    positional: { det: 0.60, llm: 0.40 }, // ASU/price-mix/credit/revisions are all numeric
    strategic:  { det: 0.40, llm: 0.60 }, // peer P/E premium with delta is highly deterministic
  },
};

export function blendScores(deterministic, llm, weights, archetype) {
  const archBlend = archetype ? BLEND_WEIGHTS_BY_ARCHETYPE[archetype] : null;
  const blend = (detScore, llmScore, tf) => {
    const w = (archBlend && archBlend[tf]) || BLEND_WEIGHTS[tf];
    return Math.round(detScore * w.det + llmScore * w.llm);
  };

  const tactical   = blend(deterministic.tactical.score,   llm.tactical?.score   ?? 0, "tactical");
  const positional = blend(deterministic.positional.score, llm.positional?.score ?? 0, "positional");
  const strategic  = blend(deterministic.strategic.score,  llm.strategic?.score  ?? 0, "strategic");

  // Use deterministic.weights if provided (for LIN regime-conditional weights)
  const w = weights || deterministic.weights || { t: 0.25, p: 0.35, s: 0.40 };
  const composite = Math.round(tactical * w.t + positional * w.p + strategic * w.s);

  const toSignal = (s) =>
    s <= -60 ? "STRONG_BUY" : s <= -25 ? "BUY" : s <= 24 ? "NEUTRAL" : s <= 59 ? "SELL" : "STRONG_SELL";
  const toRec = (s) =>
    s <= -60 ? "STRONG_BUY" : s <= -25 ? "BUY" : s <= 24 ? "HOLD" : s <= 59 ? "TRIM" : "STRONG_SELL";

  return {
    tactical:   { score: tactical,   signal: toSignal(tactical),   rationale: llm.tactical?.rationale || "",   det_score: deterministic.tactical.score,   llm_score: llm.tactical?.score   ?? 0, det_notes: deterministic.tactical.notes },
    positional: { score: positional, signal: toSignal(positional), rationale: llm.positional?.rationale || "", det_score: deterministic.positional.score, llm_score: llm.positional?.score ?? 0, det_notes: deterministic.positional.notes },
    strategic:  { score: strategic,  signal: toSignal(strategic),  rationale: llm.strategic?.rationale || "",  det_score: deterministic.strategic.score,  llm_score: llm.strategic?.score  ?? 0, det_notes: deterministic.strategic.notes },
    composite:  { score: composite,  recommendation: toRec(composite), summary: llm.composite?.summary || "", det_score: deterministic.composite.score, llm_score: llm.composite?.score ?? 0, weights: w, regime: deterministic.regime ?? null },
  };
}

function clamp(v) { return Math.max(-100, Math.min(100, Math.round(v))); }
