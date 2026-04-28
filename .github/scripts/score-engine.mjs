// score-engine.mjs — Deterministic scoring rules for quantitative inputs.
// Produces repeatable scores from the same data every time.
// The LLM handles qualitative interpretation; this handles the math.
//
// Architecture:
//   deterministic_score (this file) blends with llm_score (from Claude)
//   at per-timeframe weights — see BLEND_WEIGHTS in blendScores().
//
// Each layer (tactical/positional/strategic) gets a deterministic sub-score
// that the LLM score is blended with at the layer level.
//
// Holding-specific scoring paths:
//   - CYCLICAL archetypes: inverted P/E logic (high PE = trough = buy)
//   - BETA_SIZING (SPY): VIX+RSI combo tactical, inverted 52w positional,
//     HY OAS + yield curve + real rate strategic scoring
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
//   - EM_DIVIDEND_GROWTH (KOF): dampened RSI (consumer staples barely move),
//     mildly inverted 52w, MXN/USD as FX regime signal, narrowed PE bands (15-22x
//     normal for LatAm bottler), enhanced dividend yield scoring
//   - DIVERSIFIED_COMMODITY_TRADER (GLNCY): slightly dampened RSI (diversification
//     buffers), dampened MA/52w, COPX ratio as copper regime, GSCPI + HY OAS as
//     commodity demand proxies, PE with higher floor (trading arm), enhanced P/B
//   - EM_STATE_OIL_DIVIDEND (PBR.A): slightly dampened RSI (volatile but oil-anchored),
//     WTI as primary commodity signal, BRL/USD as FX regime, enhanced dividend yield
//     bands (8-15%+ range), PE inverted (oil producer), P/B for reserves value
//   - CYCLICAL_COMMODITY (MOS): seasonal modifier (spring/fall planting cycles),
//     CORN ratio as ag demand proxy, BRL/USD mild overlay (Brazil operations),
//     dampened MA/52w at highs, cyclical inverted PE
//   - OLIGOPOLY_QUALITY_COMPOUNDER (LIN): tightened RSI 35/70 (low-vol compounder),
//     compounder MA + inverted 52w (no penalty at highs), P/E premium vs APD/AI.PA
//     peer avg as primary valuation signal, narrowed yield band (1.1-1.7% aristocrat),
//     ROCE + op-margin durability checks, DXY FX overlay (~70% non-US rev) on
//     FRED DTWEXBGS scale (2006=100, ~120-130 typical), global PMI composite
//     positional add, growth-scare amplifier (VIX>25 + drag-down day)

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
const CYCLICAL_ARCHETYPES = new Set([
  "cyclical_commodity",          // MOS
  "diversified_commodity_trader", // GLNCY
  "cyclical_trade_bellwether",   // AMKBY
  "em_state_oil_dividend",       // PBR.A
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

// ─── FERTILIZER SEASONAL MODIFIER (MOS) ─────────────────────────────────────
// North American spring planting (Mar-May) = peak fertilizer demand.
// South American planting (Sep-Nov) = secondary demand pulse.
// Dec-Feb = weakest period (post-fall application, pre-spring orders).
// Returns a small score modifier that amplifies/dampens other signals.
function getFertilizerSeason() {
  const month = new Date().getMonth(); // 0-indexed
  if (month >= 2 && month <= 4)  return { season: "spring_planting", modifier: -3, label: "Spring planting (peak demand)" };
  if (month === 5)               return { season: "post_spring", modifier: 0, label: "Post-spring, pre-harvest" };
  if (month >= 6 && month <= 7)  return { season: "summer", modifier: 2, label: "Summer lull" };
  if (month >= 8 && month <= 10) return { season: "fall_planting", modifier: -2, label: "Fall/LatAm planting" };
  return { season: "winter", modifier: 3, label: "Winter — weakest demand" };
}

// ─── TACTICAL LAYER (short-term mean reversion) ─────────────────────────────
export function scoreTactical(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isSPY = archetype === "beta_sizing";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isMOS = archetype === "cyclical_commodity";
  const isLIN = archetype === "oligopoly_quality_compounder";
  const rsi = data.technicals?.rsi14;
  const vix = macro?.vix;

  // ─── SPY-SPECIFIC: VIX + RSI COMBO TRIGGERS ──────────────────────────────
  if (isSPY && vix != null && rsi != null) {
    if (vix > 35 && rsi < 30) {
      score += -65; notes.push(`VIX ${vix} + RSI ${rsi}: panic oversold combo — strong buy`);
    } else if (vix > 30 && rsi < 35) {
      score += -50; notes.push(`VIX ${vix} + RSI ${rsi}: elevated fear + oversold — buy`);
    } else if (vix > 25 && rsi < 30) {
      score += -55; notes.push(`VIX ${vix} + RSI ${rsi}: classic buy trigger (~75% 5d win rate)`);
    } else if (vix > 25 && rsi < 40) {
      score += -30; notes.push(`VIX ${vix} + RSI ${rsi}: fear + weakening — moderate buy`);
    }
    else if (vix < 12 && rsi > 75) {
      score += 55; notes.push(`VIX ${vix} + RSI ${rsi}: extreme complacency — strong trim`);
    } else if (vix < 14 && rsi > 70) {
      score += 40; notes.push(`VIX ${vix} + RSI ${rsi}: complacent overbought — trim`);
    } else if (vix < 15 && rsi > 75) {
      score += 35; notes.push(`VIX ${vix} + RSI ${rsi}: low vol + stretched — trim`);
    }
    else {
      if (rsi < 25)      { score += -30; notes.push(`RSI ${rsi}: SPY deeply oversold (VIX ${vix})`); }
      else if (rsi < 30) { score += -20; notes.push(`RSI ${rsi}: SPY oversold (VIX ${vix})`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: SPY mildly soft (VIX ${vix})`); }
      else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: SPY neutral (VIX ${vix})`); }
      else if (rsi < 70) { score += 8;   notes.push(`RSI ${rsi}: SPY mildly overbought (VIX ${vix})`); }
      else if (rsi < 80) { score += 20;  notes.push(`RSI ${rsi}: SPY overbought (VIX ${vix})`); }
      else               { score += 35;  notes.push(`RSI ${rsi}: SPY extremely overbought (VIX ${vix})`); }
    }

    if (vix > 20 && vix < 30) {
      score += -3; notes.push(`VIX ${vix}: moderately elevated — slight tactical buy bias`);
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -3)      { score += -12; notes.push(`SPY daily ${chg}%: significant decline`); }
      else if (chg < -2) { score += -6;  notes.push(`SPY daily ${chg}%: notable decline`); }
      else if (chg > 3)  { score += 12;  notes.push(`SPY daily +${chg}%: significant rally`); }
      else if (chg > 2)  { score += 6;   notes.push(`SPY daily +${chg}%: notable rally`); }
    }

    return { score: clamp(score), notes };
  }

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

  // ─── ETHA-SPECIFIC: WIDER BANDS THAN IBIT (1.3-1.5x BTC VOL) ────────────
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

  // ─── KOF-SPECIFIC: CONSUMER STAPLES — LOW VOL ────────────────────────────
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

  // ─── GLNCY-SPECIFIC: DIVERSIFIED COMMODITY — SLIGHTLY DAMPENED ───────────
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

  // ─── PBR.A-SPECIFIC: EM OIL — VOLATILE BUT OIL-ANCHORED ─────────────────
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

  // ─── MOS-SPECIFIC: COMMODITY CYCLICAL — SLIGHTLY DAMPENED OVERBOUGHT ─────
  if (isMOS) {
    if (rsi != null) {
      if (rsi < 20)      { score += -60; notes.push(`RSI ${rsi}: MOS severely oversold`); }
      else if (rsi < 25) { score += -45; notes.push(`RSI ${rsi}: MOS deeply oversold`); }
      else if (rsi < 30) { score += -35; notes.push(`RSI ${rsi}: MOS oversold`); }
      else if (rsi < 35) { score += -20; notes.push(`RSI ${rsi}: MOS mildly oversold`); }
      else if (rsi < 40) { score += -10; notes.push(`RSI ${rsi}: MOS approaching oversold`); }
      else if (rsi <= 62) { score += 0;  notes.push(`RSI ${rsi}: MOS neutral`); }
      else if (rsi < 68) { score += 8;   notes.push(`RSI ${rsi}: MOS mildly overbought`); }
      else if (rsi < 75) { score += 18;  notes.push(`RSI ${rsi}: MOS overbought`); }
      else if (rsi < 80) { score += 32;  notes.push(`RSI ${rsi}: MOS deeply overbought`); }
      else               { score += 50;  notes.push(`RSI ${rsi}: MOS extreme`); }
    }

    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -6)      { score += -15; notes.push(`MOS daily ${chg}%: sharp decline`); }
      else if (chg < -3) { score += -8;  notes.push(`MOS daily ${chg}%: notable decline`); }
      else if (chg > 6)  { score += 12;  notes.push(`MOS daily +${chg}%: sharp rally`); }
      else if (chg > 3)  { score += 6;   notes.push(`MOS daily +${chg}%: notable rally`); }
    }

    const season = getFertilizerSeason();
    score += season.modifier;
    notes.push(`Season: ${season.label} (${season.modifier >= 0 ? "+" : ""}${season.modifier})`);

    return { score: clamp(score), notes };
  }

  // ─── LIN-SPECIFIC: QUALITY COMPOUNDER — LOW VOL + DEFENSIVE BID ──────────
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

    // Growth-scare amplifier: VIX elevated + LIN dragged down → defensive bid setup
    if (vix != null && chg != null && vix > 25 && chg < -2) {
      score += -5;
      notes.push(`Growth-scare setup: VIX ${vix} + LIN ${chg}% — defensive quality bid will return`);
    }

    return { score: clamp(score), notes };
  }

  // ─── GENERIC TACTICAL (all other holdings) ────────────────────────────────
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
  const isSPY = archetype === "beta_sizing";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isAMKBY = archetype === "cyclical_trade_bellwether";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isMOS = archetype === "cyclical_commodity";
  const isLIN = archetype === "oligopoly_quality_compounder";
  const ma = data.technicals?.ma_signal;
  if (ma) {
    if (isSPY) {
      const spyMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -8, "above_200_below_50": 5,
        "below_both": -15, "below_both_death": -25,
      };
      if (spyMaScores[ma] != null) {
        score += spyMaScores[ma];
        notes.push(`SPY MA: ${ma} (${spyMaScores[ma] !== 0 ? (spyMaScores[ma] > 0 ? "+" : "") + spyMaScores[ma] : "neutral — normal for SPY"})`);
      }
    } else if (isIBIT) {
      const ibitMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -5, "above_200_below_50": -8,
        "below_both": -20, "below_both_death": -30,
      };
      if (ibitMaScores[ma] != null) {
        score += ibitMaScores[ma];
        notes.push(`IBIT MA: ${ma} (${ibitMaScores[ma] !== 0 ? (ibitMaScores[ma] > 0 ? "+" : "") + ibitMaScores[ma] : "bull regime — neutral"})`);
      }
    } else if (isASML) {
      const asmlMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -10, "above_200_below_50": -5,
        "below_both": -25, "below_both_death": -40,
      };
      if (asmlMaScores[ma] != null) {
        score += asmlMaScores[ma];
        notes.push(`ASML MA: ${ma} (${asmlMaScores[ma] !== 0 ? (asmlMaScores[ma] > 0 ? "+" : "") + asmlMaScores[ma] : "normal compounder trend"})`);
      }
    } else if (isENB) {
      const enbMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -8, "above_200_below_50": -3,
        "below_both": -20, "below_both_death": -30,
      };
      if (enbMaScores[ma] != null) {
        score += enbMaScores[ma];
        notes.push(`ENB MA: ${ma} (${enbMaScores[ma] !== 0 ? (enbMaScores[ma] > 0 ? "+" : "") + enbMaScores[ma] : "normal yield compounder trend"})`);
      }
    } else if (isAMKBY) {
      const amkbyMaScores = {
        "above_both_golden": 8, "above_both": 5,
        "above_50_below_200": -5, "above_200_below_50": 3,
        "below_both": -12, "below_both_death": -18,
      };
      if (amkbyMaScores[ma] != null) {
        score += amkbyMaScores[ma];
        notes.push(`AMKBY MA: ${ma} (${amkbyMaScores[ma] > 0 ? "+" : ""}${amkbyMaScores[ma]})`);
      }
    } else if (isETHA) {
      const ethaMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -5, "above_200_below_50": -8,
        "below_both": -18, "below_both_death": -28,
      };
      if (ethaMaScores[ma] != null) {
        score += ethaMaScores[ma];
        notes.push(`ETHA MA: ${ma} (${ethaMaScores[ma] !== 0 ? (ethaMaScores[ma] > 0 ? "+" : "") + ethaMaScores[ma] : "bull regime — neutral"})`);
      }
    } else if (isKOF) {
      const kofMaScores = {
        "above_both_golden": 3, "above_both": 0,
        "above_50_below_200": -5, "above_200_below_50": 3,
        "below_both": -15, "below_both_death": -22,
      };
      if (kofMaScores[ma] != null) {
        score += kofMaScores[ma];
        notes.push(`KOF MA: ${ma} (${kofMaScores[ma] !== 0 ? (kofMaScores[ma] > 0 ? "+" : "") + kofMaScores[ma] : "normal"})`);
      }
    } else if (isGLNCY) {
      const glncyMaScores = {
        "above_both_golden": 8, "above_both": 5,
        "above_50_below_200": -5, "above_200_below_50": 3,
        "below_both": -12, "below_both_death": -20,
      };
      if (glncyMaScores[ma] != null) {
        score += glncyMaScores[ma];
        notes.push(`GLNCY MA: ${ma} (${glncyMaScores[ma] > 0 ? "+" : ""}${glncyMaScores[ma]})`);
      }
    } else if (isPBRA) {
      const pbraMaScores = {
        "above_both_golden": 8, "above_both": 5,
        "above_50_below_200": -5, "above_200_below_50": 3,
        "below_both": -12, "below_both_death": -20,
      };
      if (pbraMaScores[ma] != null) {
        score += pbraMaScores[ma];
        notes.push(`PBR.A MA: ${ma} (${pbraMaScores[ma] > 0 ? "+" : ""}${pbraMaScores[ma]})`);
      }
    } else if (isMOS) {
      const mosMaScores = {
        "above_both_golden": 8, "above_both": 5,
        "above_50_below_200": -5, "above_200_below_50": 3,
        "below_both": -12, "below_both_death": -18,
      };
      if (mosMaScores[ma] != null) {
        score += mosMaScores[ma];
        notes.push(`MOS MA: ${ma} (${mosMaScores[ma] > 0 ? "+" : ""}${mosMaScores[ma]})`);
      }
    } else if (isLIN) {
      const linMaScores = {
        "above_both_golden": 0, "above_both": 0,
        "above_50_below_200": -10, "above_200_below_50": -5,
        "below_both": -25, "below_both_death": -40,
      };
      if (linMaScores[ma] != null) {
        score += linMaScores[ma];
        notes.push(`LIN MA: ${ma} (${linMaScores[ma] !== 0 ? (linMaScores[ma] > 0 ? "+" : "") + linMaScores[ma] : "normal compounder trend"})`);
      }
    } else {
      const maScores = {
        "above_both_golden": 15, "above_both": 10,
        "above_50_below_200": -5, "above_200_below_50": 5,
        "below_both": -10, "below_both_death": -15,
      };
      if (maScores[ma] != null) {
        score += maScores[ma];
        notes.push(`MA: ${ma} (${maScores[ma] > 0 ? "+" : ""}${maScores[ma]})`);
      }
    }
  }

  // 52-week position — ARCHETYPE AWARE
  const w52 = data.price?.week52_position_pct;
  if (w52 != null) {
    if (isSPY) {
      if (w52 > 95)      { score += -5;  notes.push(`SPY 52w: ${w52}% — at highs, momentum positive`); }
      else if (w52 > 85) { score += 0;   notes.push(`SPY 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += 0;   notes.push(`SPY 52w: ${w52}% — normal range`); }
      else if (w52 > 50) { score += -5;  notes.push(`SPY 52w: ${w52}% — mild pullback, slight buy`); }
      else if (w52 > 30) { score += -15; notes.push(`SPY 52w: ${w52}% — correction territory, buy`); }
      else if (w52 > 15) { score += -25; notes.push(`SPY 52w: ${w52}% — significant drawdown, strong buy`); }
      else               { score += -35; notes.push(`SPY 52w: ${w52}% — deep drawdown, max buy`); }
    } else if (isIBIT) {
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
    } else if (isMOS) {
      if (w52 > 95)      { score += 15;  notes.push(`MOS 52w: ${w52}% — near highs, possible late-cycle`); }
      else if (w52 > 85) { score += 8;   notes.push(`MOS 52w: ${w52}% — upper range`); }
      else if (w52 > 70) { score += 3;   notes.push(`MOS 52w: ${w52}% — above mid`); }
      else if (w52 > 50) { score += 0;   notes.push(`MOS 52w: ${w52}% — mid range`); }
      else if (w52 > 30) { score += -8;  notes.push(`MOS 52w: ${w52}% — below mid, ag trough opportunity`); }
      else if (w52 > 15) { score += -20; notes.push(`MOS 52w: ${w52}% — lower range, fertilizer trough buy`); }
      else if (w52 > 5)  { score += -30; notes.push(`MOS 52w: ${w52}% — near lows, deep cyclical buy`); }
      else               { score += -35; notes.push(`MOS 52w: ${w52}% — extreme low, max conviction`); }
    } else if (isLIN) {
      if (w52 > 95)      { score += 0;   notes.push(`LIN 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`LIN 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`LIN 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -10; notes.push(`LIN 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -22; notes.push(`LIN 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -38; notes.push(`LIN 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -50; notes.push(`LIN 52w: ${w52}% — catastrophic drawdown — max conviction`); }
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
      if (pctFrom200 > 10) {
        score += -3; notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — trending bull regime`);
      } else {
        notes.push(`ETH ${pctFrom200.toFixed(1)}% vs 200DMA — regime healthy`);
      }
    }
    else if (pctFrom200 < 60)  { score += 10;  notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — extended`); }
    else if (pctFrom200 < 100) { score += 22;  notes.push(`ETH ${pctFrom200.toFixed(1)}% above 200DMA — parabolic extension`); }
    else                       { score += 35;  notes.push(`ETH >2x 200DMA — extreme extension`); }
  }
  else if (price && sma50) {
    const pctFromSMA = ((price - sma50) / sma50) * 100;
    if (isSPY) {
      if (pctFromSMA < -10)      { score += -12; notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -5)  { score += -6;  notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA > 10)  { score += 8;   notes.push(`SPY ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 6)   { score += 4;   }
    } else if (isASML) {
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

      if (spreadBps > 400) {
        score += -25; notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — deep value, historically strong buy`);
      } else if (spreadBps > 300) {
        score += -15; notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — attractive`);
      } else if (spreadBps > 200) {
        score += -5;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — fair`);
      } else if (spreadBps > 150) {
        score += 0;   notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — normal`);
      } else if (spreadBps > 100) {
        score += 8;   notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — getting rich`);
      } else if (spreadBps > 50) {
        score += 15;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — expensive`);
      } else {
        score += 22;  notes.push(`ENB yield spread: ${spreadBps}bps over 10Y — historically expensive`);
      }
    }
  }

  if (isSPY && data.breadth) {
    const rspChange = data.breadth.rsp_change_pct;
    const spyChange = data.price?.change_pct;
    if (rspChange != null && spyChange != null) {
      const breadthSpread = rspChange - spyChange;
      if (breadthSpread > 0.5) {
        score += -5; notes.push(`RSP outperforming SPY by ${breadthSpread.toFixed(2)}pp — broad rally, healthy`);
      } else if (breadthSpread < -0.5) {
        score += 5; notes.push(`SPY outperforming RSP by ${(-breadthSpread).toFixed(2)}pp — narrow/top-heavy`);
      } else {
        notes.push(`RSP/SPY breadth spread: ${breadthSpread.toFixed(2)}pp — inline`);
      }
    }
  }

  if (isSPY && macro?.hy_oas != null) {
    const oas = macro.hy_oas;
    if (oas < 300)      { score += -5; notes.push(`HY OAS ${oas}bps: tight spreads, risk-on`); }
    else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
    else if (oas < 500) { score += 10; notes.push(`HY OAS ${oas}bps: widening, caution`); }
    else if (oas < 700) { score += 20; notes.push(`HY OAS ${oas}bps: stressed, defensive`); }
    else                { score += 30; notes.push(`HY OAS ${oas}bps: crisis-level spreads`); }
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
      if (spread > 3)       { score += -8; notes.push(`ETHA outperforming IBIT by ${spread}pp — strong alt-season rotation`); }
      else if (spread > 1)  { score += -4; notes.push(`ETHA outperforming IBIT by ${spread}pp — alt rotation`); }
      else if (spread > 0.3){ score += -2; notes.push(`ETHA mildly outperforming IBIT (${spread}pp)`); }
      else if (spread < -3) { score += 8;  notes.push(`IBIT outperforming ETHA by ${(-spread).toFixed(2)}pp — BTC dominance, ETH headwind`); }
      else if (spread < -1) { score += 4;  notes.push(`IBIT outperforming ETHA by ${(-spread).toFixed(2)}pp — BTC dominance`); }
      else                  { notes.push(`ETHA/IBIT spread: ${spread}pp — inline`); }
    }
  }

  if (isGLNCY && data.copper_regime) {
    const spread = data.copper_regime.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)       { score += -5; notes.push(`GLNCY outperforming COPX by ${spread}pp — diversification premium`); }
      else if (spread > 1)  { score += -2; notes.push(`GLNCY mildly outperforming COPX (${spread}pp)`); }
      else if (spread < -3) { score += -8; notes.push(`COPX outperforming GLNCY by ${(-spread).toFixed(2)}pp — copper surging, GLNCY catch-up potential`); }
      else if (spread < -1) { score += -3; notes.push(`COPX mildly outperforming GLNCY (${(-spread).toFixed(2)}pp)`); }
      else                  { notes.push(`GLNCY/COPX spread: ${spread}pp — inline`); }
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

  if (isMOS && data.ag_demand) {
    const spread = data.ag_demand.relative_spread_pp;
    if (spread != null) {
      if (spread > 3)       { score += 5;  notes.push(`MOS outperforming CORN by ${spread}pp — running ahead of ag demand`); }
      else if (spread > 1)  { score += 2;  notes.push(`MOS mildly outperforming CORN (${spread}pp)`); }
      else if (spread < -3) { score += -8; notes.push(`CORN outperforming MOS by ${(-spread).toFixed(2)}pp — ag demand strong, MOS catch-up`); }
      else if (spread < -1) { score += -3; notes.push(`CORN mildly outperforming MOS (${(-spread).toFixed(2)}pp)`); }
      else                  { notes.push(`MOS/CORN spread: ${spread}pp — inline`); }
    }
  }

  if (isMOS) {
    const season = getFertilizerSeason();
    score += season.modifier;
    notes.push(`Season: ${season.label} (${season.modifier >= 0 ? "+" : ""}${season.modifier})`);
  }

  // ─── LIN-SPECIFIC POSITIONAL ADD-ONS ─────────────────────────────────────
  // Peer relative vs APD (1-month spread)
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

  // Global PMI composite (US ISM + EU + China — gracefully handles missing fields)
  if (isLIN) {
    const pmis = [macro?.us_ism, macro?.eu_pmi, macro?.china_pmi].filter(p => p != null);
    if (pmis.length > 0) {
      const avg = pmis.reduce((a, b) => a + b, 0) / pmis.length;
      const avgFmt = avg.toFixed(1);
      if (avg > 53)      { score += -3; notes.push(`Global PMI avg ${avgFmt} (n=${pmis.length}): broad expansion — industrial gas tailwind`); }
      else if (avg > 51) { score += -1; notes.push(`Global PMI avg ${avgFmt}: mild expansion`); }
      else if (avg > 49) { score += 0;  notes.push(`Global PMI avg ${avgFmt}: neutral`); }
      else if (avg > 47) { score += 3;  notes.push(`Global PMI avg ${avgFmt}: mild contraction — modest headwind`); }
      else               { score += 6;  notes.push(`Global PMI avg ${avgFmt}: broad contraction — demand headwind`); }
    }
  }

  return { score: clamp(score), notes };
}

// ─── STRATEGIC LAYER (long-term valuation) ──────────────────────────────────
export function scoreStrategic(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isCyclical = CYCLICAL_ARCHETYPES.has(archetype);
  const isSPY = archetype === "beta_sizing";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";
  const isAMKBY = archetype === "cyclical_trade_bellwether";
  const isETHA = archetype === "high_beta_crypto";
  const isKOF = archetype === "em_dividend_growth";
  const isGLNCY = archetype === "diversified_commodity_trader";
  const isPBRA = archetype === "em_state_oil_dividend";
  const isMOS = archetype === "cyclical_commodity";
  const isLIN = archetype === "oligopoly_quality_compounder";

  if (isIBIT) {
    const phaseInfo = getHalvingPhase();
    const phase = phaseInfo.phase;

    if (phase === "early_expansion") {
      score += 0; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — no phase bias`);
    } else if (phase === "mid_expansion") {
      score += 0; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — no phase bias`);
    } else if (phase === "extended_expansion") {
      score += 3; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — mild maturity tilt`);
    } else {
      score += 5; notes.push(`Cycle: month ${phaseInfo.months} (${phase}) — maturity tilt`);
    }

    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 40)      { score += -10; notes.push(`VIX ${vix}: macro panic — BTC contrarian buy`); }
      else if (vix > 30) { score += -5;  notes.push(`VIX ${vix}: macro fear — BTC buy bias`); }
      else if (vix < 12) { score += 3;   notes.push(`VIX ${vix}: extreme complacency — marginal caution`); }
    }

    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips < 0)      { score += -5; notes.push(`TIPS ${tips}%: accommodative — BTC tailwind`); }
      else if (tips > 2.5) { score += 3; notes.push(`TIPS ${tips}%: restrictive — mild BTC headwind`); }
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
      if (dy > 8)       { score += -15; notes.push(`ENB yield ${dy}%: very high — deeply discounted`); }
      else if (dy > 7.5) { score += -10; notes.push(`ENB yield ${dy}%: high — historically attractive`); }
      else if (dy > 7)  { score += -5;  notes.push(`ENB yield ${dy}%: above average`); }
      else if (dy > 6)  { score += 0;   notes.push(`ENB yield ${dy}%: normal range`); }
      else if (dy > 5.5) { score += 3;  notes.push(`ENB yield ${dy}%: below average — getting rich`); }
      else if (dy > 5)  { score += 8;   notes.push(`ENB yield ${dy}%: low — yield compression`); }
      else              { score += 12;  notes.push(`ENB yield ${dy}%: historically low — expensive`); }
    }

    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)       { score += 10;  notes.push(`TIPS ${tips}%: very restrictive — strong headwind for yield stocks`); }
      else if (tips > 2.5){ score += 6;   notes.push(`TIPS ${tips}%: restrictive — yield stock headwind`); }
      else if (tips > 2)  { score += 3;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)  { score += -10; notes.push(`TIPS ${tips}%: accommodative — yield stocks shine`); }
      else if (tips < 0.5){ score += -5;  notes.push(`TIPS ${tips}%: very low real rates — ENB yield attractive`); }
      else if (tips < 1)  { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    }

    if (macro?.spread_2s10s != null) {
      const spread = macro.spread_2s10s;
      if (spread > 100)       { score += -5; notes.push(`2s10s +${spread}bps: steep curve — rate cut regime, ENB tailwind`); }
      else if (spread > 50)   { score += -3; notes.push(`2s10s +${spread}bps: steepening — mildly positive for ENB`); }
      else if (spread > -30)  { score += 0;  notes.push(`2s10s ${spread}bps: normal range`); }
      else if (spread > -75)  { score += 5;  notes.push(`2s10s ${spread}bps: inverted — rate risk headwind`); }
      else                    { score += 8;  notes.push(`2s10s ${spread}bps: deeply inverted — yield stocks under pressure`); }
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
      if (pe > 100)      { score += -25; notes.push(`AMKBY P/E ${pe.toFixed(0)}x: deep trough — shipping buy`); }
      else if (pe > 50)  { score += -18; notes.push(`AMKBY P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 25)  { score += -8;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: below-trend — recovery territory`); }
      else if (pe > 12)  { score += 0;   notes.push(`AMKBY P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 6)   { score += 10;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)   { score += 18;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: peak earnings — shipping trim`); }
      else               { score += 25;  notes.push(`AMKBY P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
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
      if (dy > 8)       { score += -8; notes.push(`AMKBY yield ${dy}%: very high — cyclical trough?`); }
      else if (dy > 5)  { score += -4; notes.push(`AMKBY yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2; notes.push(`AMKBY yield ${dy}%: moderate`); }
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
      if (tips > 2.5)    { score += 6;   notes.push(`TIPS ${tips}%: restrictive — ETH headwind`); }
      else if (tips > 2) { score += 3;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0) { score += -8;  notes.push(`TIPS ${tips}%: accommodative — ETH tailwind`); }
      else if (tips < 0.5){ score += -4; notes.push(`TIPS ${tips}%: low real rates — risk assets favored`); }
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
      if (mxn < 16)       { score += -10; notes.push(`MXN/USD ${mxn}: very strong peso — KOF tailwind`); }
      else if (mxn < 17)  { score += -5;  notes.push(`MXN/USD ${mxn}: strong peso — KOF positive`); }
      else if (mxn < 18.5){ score += 0;   notes.push(`MXN/USD ${mxn}: normal range`); }
      else if (mxn < 20)  { score += 5;   notes.push(`MXN/USD ${mxn}: weakening peso — KOF headwind`); }
      else if (mxn < 22)  { score += 10;  notes.push(`MXN/USD ${mxn}: weak peso — KOF FX drag`); }
      else                { score += 15;  notes.push(`MXN/USD ${mxn}: peso crisis — severe KOF headwind`); }
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
      if (pe > 80)       { score += -22; notes.push(`GLNCY P/E ${pe.toFixed(0)}x: deep trough — commodity buy`); }
      else if (pe > 40)  { score += -15; notes.push(`GLNCY P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 20)  { score += -5;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: below-trend`); }
      else if (pe > 10)  { score += 0;   notes.push(`GLNCY P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 6)   { score += 10;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)   { score += 18;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: peak earnings — trim`); }
      else               { score += 22;  notes.push(`GLNCY P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
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
      if (dy > 8)       { score += -8; notes.push(`GLNCY yield ${dy}%: very high — trough pricing?`); }
      else if (dy > 5)  { score += -4; notes.push(`GLNCY yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2; notes.push(`GLNCY yield ${dy}%: moderate`); }
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
      if (pe > 50)       { score += -20; notes.push(`PBR.A P/E ${pe.toFixed(0)}x: trough — oil cycle buy`); }
      else if (pe > 30)  { score += -12; notes.push(`PBR.A P/E ${pe.toFixed(0)}x: depressed earnings`); }
      else if (pe > 15)  { score += -3;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: below-trend`); }
      else if (pe > 8)   { score += 0;   notes.push(`PBR.A P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 5)   { score += 8;   notes.push(`PBR.A P/E ${pe.toFixed(0)}x: above-trend — peak risk`); }
      else if (pe > 3)   { score += 15;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: peak earnings — trim`); }
      else               { score += 22;  notes.push(`PBR.A P/E ${pe.toFixed(0)}x: super-peak — max trim`); }
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
      if (wti > 90)       { score += -8; notes.push(`WTI $${wti}: strong oil — PBR.A tailwind`); }
      else if (wti > 75)  { score += -3; notes.push(`WTI $${wti}: supportive`); }
      else if (wti > 60)  { score += 0;  notes.push(`WTI $${wti}: normal`); }
      else if (wti > 50)  { score += 5;  notes.push(`WTI $${wti}: soft — margin compression`); }
      else if (wti > 40)  { score += 12; notes.push(`WTI $${wti}: weak — PBR.A earnings at risk`); }
      else                { score += 20; notes.push(`WTI $${wti}: oil crash — PBR.A under pressure`); }
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

  if (isMOS) {
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe > 100)      { score += -20; notes.push(`MOS P/E ${pe.toFixed(0)}x: trough earnings — fertilizer buy`); }
      else if (pe > 50)  { score += -12; notes.push(`MOS P/E ${pe.toFixed(0)}x: depressed earnings — cyclical buy`); }
      else if (pe > 25)  { score += -5;  notes.push(`MOS P/E ${pe.toFixed(0)}x: below-trend`); }
      else if (pe > 15)  { score += 0;   notes.push(`MOS P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 8)   { score += 10;  notes.push(`MOS P/E ${pe.toFixed(0)}x: peak earnings — cyclical caution`); }
      else               { score += 20;  notes.push(`MOS P/E ${pe.toFixed(0)}x: super-peak — cyclical trim`); }
    }

    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.7)      { score += -10; notes.push(`MOS P/B ${pb.toFixed(2)}: well below book — asset value`); }
      else if (pb < 1.0) { score += -5;  notes.push(`MOS P/B ${pb.toFixed(2)}: below book`); }
      else if (pb < 1.5) { score += -2;  notes.push(`MOS P/B ${pb.toFixed(2)}: near book`); }
      else if (pb < 2.5) { score += 0;   notes.push(`MOS P/B ${pb.toFixed(2)}: normal`); }
      else if (pb < 4)   { score += 5;   notes.push(`MOS P/B ${pb.toFixed(2)}: above book`); }
      else               { score += 10;  notes.push(`MOS P/B ${pb.toFixed(2)}: premium — late cycle`); }
    }

    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 6)       { score += -8; notes.push(`MOS yield ${dy}%: very high — trough pricing?`); }
      else if (dy > 4)  { score += -4; notes.push(`MOS yield ${dy}%: attractive`); }
      else if (dy > 2)  { score += -1; notes.push(`MOS yield ${dy}%: moderate`); }
    }

    if (macro?.brl_usd != null) {
      const brl = macro.brl_usd;
      if (brl < 4.5)      { score += -3; notes.push(`BRL/USD ${brl}: strong real — MOS Brazil ops positive`); }
      else if (brl < 5.5) { score += 0;  notes.push(`BRL/USD ${brl}: normal range`); }
      else if (brl < 6.5) { score += 2;  notes.push(`BRL/USD ${brl}: weakening — mild headwind`); }
      else                { score += 5;  notes.push(`BRL/USD ${brl}: weak real — MOS Brazil cost pressure`); }
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
      else if (tips < 0) { score += -3; notes.push(`TIPS ${tips}%: accommodative`); }
    }

    const season = getFertilizerSeason();
    score += season.modifier;
    notes.push(`Season: ${season.label} (${season.modifier >= 0 ? "+" : ""}${season.modifier})`);

    return { score: clamp(score), notes };
  }

  if (isLIN) {
    // Peer P/E premium is the cleanest valuation signal for LIN
    // data.peer_valuation = { lin_pe, apd_pe, ai_pa_pe, peer_avg_pe, premium_pct }
    if (data.peer_valuation && data.peer_valuation.premium_pct != null) {
      const prem = data.peer_valuation.premium_pct;
      if (prem < -5)      { score += -30; notes.push(`LIN P/E ${prem.toFixed(1)}% vs peers: discount — exceptional quality buy (very rare)`); }
      else if (prem < 0)  { score += -22; notes.push(`LIN P/E ${prem.toFixed(1)}% vs peers: at parity — rare opportunity`); }
      else if (prem < 5)  { score += -15; notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: tight premium — buy`); }
      else if (prem < 10) { score += -7;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: below normal premium`); }
      else if (prem <= 15){ score += 0;   notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: deserved premium (normal)`); }
      else if (prem < 18) { score += 3;   notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: stretched`); }
      else if (prem < 22) { score += 10;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: rich premium — trim bias`); }
      else                { score += 18;  notes.push(`LIN P/E +${prem.toFixed(1)}% vs peers: extreme premium — trim`); }
    } else {
      // Fallback to absolute P/E if peer data unavailable
      const pe = data.valuation?.trailingPE;
      if (pe != null && pe > 0) {
        if (pe < 22)       { score += -10; notes.push(`LIN P/E ${pe.toFixed(1)}x: cheap (peer data unavailable)`); }
        else if (pe < 26)  { score += -5;  notes.push(`LIN P/E ${pe.toFixed(1)}x: below normal compounder range`); }
        else if (pe <= 32) { score += 0;   notes.push(`LIN P/E ${pe.toFixed(1)}x: normal compounder range`); }
        else if (pe < 36)  { score += 5;   notes.push(`LIN P/E ${pe.toFixed(1)}x: rich`); }
        else               { score += 12;  notes.push(`LIN P/E ${pe.toFixed(1)}x: extreme`); }
      }
    }

    // Dividend yield aristocrat band (1.1-1.7% normal, narrow)
    const dy = data.valuation?.dividendYield;
    if (dy != null && dy > 0) {
      if (dy > 1.9)       { score += -10; notes.push(`LIN yield ${dy}%: top of historical range — aristocrat-grade buy`); }
      else if (dy > 1.7)  { score += -5;  notes.push(`LIN yield ${dy}%: above normal — attractive`); }
      else if (dy > 1.3)  { score += 0;   notes.push(`LIN yield ${dy}%: normal range`); }
      else if (dy > 1.1)  { score += 3;   notes.push(`LIN yield ${dy}%: slightly stretched`); }
      else                { score += 8;   notes.push(`LIN yield ${dy}%: stretched — yield compression`); }
    }

    // ROCE durability check (best-in-class >25% — LIN's signature metric)
    if (data.fundamentals && data.fundamentals.roce_pct != null) {
      const roce = data.fundamentals.roce_pct;
      if (roce > 28)      { score += -5; notes.push(`LIN ROCE ${roce}%: exceptional — moat strengthening`); }
      else if (roce > 25) { score += 0;  notes.push(`LIN ROCE ${roce}%: best-in-class normal`); }
      else if (roce > 22) { score += 3;  notes.push(`LIN ROCE ${roce}%: slipping below historical`); }
      else if (roce > 20) { score += 6;  notes.push(`LIN ROCE ${roce}%: concerning for LIN`); }
      else                { score += 12; notes.push(`LIN ROCE ${roce}%: moat erosion risk`); }
    }

    // Operating margin durability (best-in-class >30%)
    if (data.fundamentals && data.fundamentals.operating_margin_pct != null) {
      const om = data.fundamentals.operating_margin_pct;
      if (om > 32)       { score += -2; notes.push(`LIN op margin ${om}%: peak pricing power`); }
      else if (om > 30)  { score += 0;  notes.push(`LIN op margin ${om}%: best-in-class`); }
      else if (om > 28)  { score += 3;  notes.push(`LIN op margin ${om}%: compressing`); }
      else               { score += 8;  notes.push(`LIN op margin ${om}%: significant compression`); }
    }

    // DXY / FX overlay (~70% non-US revenue)
    // Note: macro.dxy is FRED DTWEXBGS (trade-weighted broad USD, 2006=100 base, ~120-130 typical)
    if (macro?.dxy != null) {
      const dxy = macro.dxy;
      if (dxy > 130)      { score += 5;  notes.push(`DXY ${dxy}: very strong USD — significant FX headwind`); }
      else if (dxy > 125) { score += 2;  notes.push(`DXY ${dxy}: strong USD — FX headwind`); }
      else if (dxy > 120) { score += 0;  notes.push(`DXY ${dxy}: normal USD range`); }
      else if (dxy > 115) { score += -2; notes.push(`DXY ${dxy}: mild USD weakness — FX tailwind`); }
      else                { score += -5; notes.push(`DXY ${dxy}: weak USD — strong FX tailwind`); }
    }

    // VIX overlay — quality compounder catches defensive bid
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — LIN defensive quality bid`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — LIN as safe haven`); }
      else if (vix < 12) { score += 3;  notes.push(`VIX ${vix}: complacency — LIN vulnerable to rotation`); }
    }

    // TIPS overlay — long-duration compounder rate sensitivity
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 2.5)    { score += 3;  notes.push(`TIPS ${tips}%: restrictive — quality compounder headwind`); }
      else if (tips > 2) { score += 1;  notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0) { score += -3; notes.push(`TIPS ${tips}%: accommodative — compounder tailwind`); }
      else if (tips < 0.5){ score += -1; notes.push(`TIPS ${tips}%: low real rates`); }
    }

    return { score: clamp(score), notes };
  }

  const pe = data.valuation?.trailingPE;
  if (pe != null && pe > 0) {
    if (isCyclical) {
      if (pe > 100)      { score += -20; notes.push(`P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 50)  { score += -12; notes.push(`P/E ${pe.toFixed(0)}x: depressed earnings — cyclical buy`); }
      else if (pe > 25)  { score += -5;  notes.push(`P/E ${pe.toFixed(0)}x: below-trend earnings`); }
      else if (pe > 15)  { score += 0;   notes.push(`P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 8)   { score += 10;  notes.push(`P/E ${pe.toFixed(0)}x: peak earnings — cyclical caution`); }
      else               { score += 20;  notes.push(`P/E ${pe.toFixed(0)}x: super-peak — cyclical trim`); }
    } else if (isSPY) {
      if (pe < 14)       { score += -12; notes.push(`S&P P/E ${pe.toFixed(1)}x: historically cheap`); }
      else if (pe < 18)  { score += -5;  notes.push(`S&P P/E ${pe.toFixed(1)}x: below-average value`); }
      else if (pe <= 25) { score += 0;   notes.push(`S&P P/E ${pe.toFixed(1)}x: normal range`); }
      else if (pe < 30)  { score += 5;   notes.push(`S&P P/E ${pe.toFixed(1)}x: above average`); }
      else if (pe < 35)  { score += 10;  notes.push(`S&P P/E ${pe.toFixed(1)}x: rich`); }
      else               { score += 18;  notes.push(`S&P P/E ${pe.toFixed(1)}x: extreme — late cycle`); }
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

  if (!isSPY && !isASML && !isENB) {
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
      else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
      else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
      else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
    }
  }

  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0 && !isENB) {
    if (isSPY) {
      if (dy > 2.5)     { score += -5; notes.push(`S&P yield ${dy}%: elevated — market is cheap`); }
      else if (dy < 1)  { score += 3;  notes.push(`S&P yield ${dy}%: compressed — market is rich`); }
    } else if (isASML) {
      // skip
    } else {
      if (dy > 8)       { score += -10; notes.push(`Yield ${dy}%: very high`); }
      else if (dy > 5)  { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
    }
  }

  const vix = macro?.vix;
  if (vix != null && !isENB) {
    if (isSPY) {
      if (vix > 40)      { score += -15; notes.push(`VIX ${vix}: panic — strong contrarian buy`); }
      else if (vix > 30) { score += -10; notes.push(`VIX ${vix}: high fear — contrarian buy`); }
      else if (vix > 25) { score += -5;  notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 8;   notes.push(`VIX ${vix}: extreme complacency — risk elevated`); }
      else if (vix < 14) { score += 4;   notes.push(`VIX ${vix}: low vol complacency`); }
    } else if (isASML) {
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
      if (tips > 3)       { score += 8;   notes.push(`TIPS ${tips}%: very restrictive — long-duration headwind`); }
      else if (tips > 2.5){ score += 4;   notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips < 0)  { score += -8;  notes.push(`TIPS ${tips}%: accommodative — long-duration tailwind`); }
      else if (tips < 1)  { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    } else {
      if (tips > 2.5)     { score += 5;  notes.push(`TIPS ${tips}%: restrictive`); }
      else if (tips > 2)  { score += 2;  }
      else if (tips < 0)  { score += -5; notes.push(`TIPS ${tips}%: accommodative`); }
    }
  }

  if (isSPY && macro?.spread_2s10s != null) {
    const spread = macro.spread_2s10s;
    if (spread > 100)       { score += -8; notes.push(`2s10s +${spread}bps: steep curve — bullish macro`); }
    else if (spread > 50)   { score += -5; notes.push(`2s10s +${spread}bps: healthy steepening`); }
    else if (spread > 0)    { score += -2; notes.push(`2s10s +${spread}bps: mildly positive`); }
    else if (spread > -30)  { score += 3;  notes.push(`2s10s ${spread}bps: flat/mildly inverted`); }
    else if (spread > -75)  { score += 8;  notes.push(`2s10s ${spread}bps: inverted — recession signal`); }
    else                    { score += 15; notes.push(`2s10s ${spread}bps: deeply inverted — max caution`); }
  }

  if (isSPY && macro?.fed_funds != null && tips != null) {
    const realRate = macro.fed_funds - tips;
    if (realRate > 3)       { score += 5;  notes.push(`Real rate ${realRate.toFixed(1)}%: very restrictive`); }
    else if (realRate > 2)  { score += 3;  notes.push(`Real rate ${realRate.toFixed(1)}%: restrictive`); }
    else if (realRate > 0)  { score += 0;  notes.push(`Real rate ${realRate.toFixed(1)}%: neutral`); }
    else                    { score += -5; notes.push(`Real rate ${realRate.toFixed(1)}%: accommodative`); }
  }

  return { score: clamp(score), notes };
}

// ─── COMPOSITE ──────────────────────────────────────────────────────────────
export function computeDeterministicScores(data, macro) {
  const tactical = scoreTactical(data, macro);
  const positional = scorePositional(data, macro);
  const strategic = scoreStrategic(data, macro);

  const weights = data._weights || { t: 0.25, p: 0.35, s: 0.40 };
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

export function blendScores(deterministic, llm, weights) {
  const blend = (detScore, llmScore, tf) => {
    const w = BLEND_WEIGHTS[tf];
    return Math.round(detScore * w.det + llmScore * w.llm);
  };

  const tactical   = blend(deterministic.tactical.score,   llm.tactical?.score   ?? 0, "tactical");
  const positional = blend(deterministic.positional.score, llm.positional?.score ?? 0, "positional");
  const strategic  = blend(deterministic.strategic.score,  llm.strategic?.score  ?? 0, "strategic");

  const w = weights || { t: 0.25, p: 0.35, s: 0.40 };
  const composite = Math.round(tactical * w.t + positional * w.p + strategic * w.s);

  const toSignal = (s) =>
    s <= -60 ? "STRONG_BUY" : s <= -25 ? "BUY" : s <= 24 ? "NEUTRAL" : s <= 59 ? "SELL" : "STRONG_SELL";
  const toRec = (s) =>
    s <= -60 ? "STRONG_BUY" : s <= -25 ? "BUY" : s <= 24 ? "HOLD" : s <= 59 ? "TRIM" : "STRONG_SELL";

  return {
    tactical:   { score: tactical,   signal: toSignal(tactical),   rationale: llm.tactical?.rationale || "", det_score: deterministic.tactical.score, llm_score: llm.tactical?.score ?? 0, det_notes: deterministic.tactical.notes },
    positional: { score: positional, signal: toSignal(positional), rationale: llm.positional?.rationale || "", det_score: deterministic.positional.score, llm_score: llm.positional?.score ?? 0, det_notes: deterministic.positional.notes },
    strategic:  { score: strategic,  signal: toSignal(strategic),  rationale: llm.strategic?.rationale || "", det_score: deterministic.strategic.score, llm_score: llm.strategic?.score ?? 0, det_notes: deterministic.strategic.notes },
    composite:  { score: composite,  recommendation: toRec(composite), summary: llm.composite?.summary || "", det_score: deterministic.composite.score, llm_score: llm.composite?.score ?? 0 },
  };
}

function clamp(v) { return Math.max(-100, Math.min(100, Math.round(v))); }
