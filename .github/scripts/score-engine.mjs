// score-engine.mjs — Deterministic scoring rules for quantitative inputs.
// Produces repeatable scores from the same data every time.
// The LLM handles qualitative interpretation; this handles the math.
//
// Architecture:
//   deterministic_score (this file) = 50% of final composite
//   llm_score (from Claude)         = 50% of final composite
//   final_score = (deterministic * 0.5) + (llm * 0.5)
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

// ─── TACTICAL LAYER (short-term mean reversion) ─────────────────────────────
export function scoreTactical(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isSPY = archetype === "beta_sizing";
  const isIBIT = archetype === "momentum_store_of_value";
  const isASML = archetype === "secular_growth_monopoly";
  const isENB = archetype === "dividend_compounder";  // ← NEW
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

  // ─── ENB-SPECIFIC: YIELD STOCK — BARELY MOVES ────────────────────────────  ← NEW
  // ENB's daily moves are typically 0.3-0.8%. RSI for a yield stock is almost
  // always between 40-65. The generic RSI bands are way too aggressive.
  // Only extreme RSI readings (<25 or >80) are meaningful.
  // The one real tactical setup: 10Y yield spike → ENB drops sympathetically →
  // rate overreaction buy. This shows up as a -2%+ daily drop (which is big for ENB).
  if (isENB) {
    if (rsi != null) {
      // Buy zones — rare for a yield stock
      if (rsi < 20)      { score += -40; notes.push(`RSI ${rsi}: ENB severely oversold — very rare`); }
      else if (rsi < 25) { score += -25; notes.push(`RSI ${rsi}: ENB deeply oversold`); }
      else if (rsi < 30) { score += -12; notes.push(`RSI ${rsi}: ENB oversold`); }
      else if (rsi < 35) { score += -5;  notes.push(`RSI ${rsi}: ENB mildly soft`); }
      // Massive neutral zone — 35-75 is normal for a yield stock
      else if (rsi <= 70) { score += 0;  notes.push(`RSI ${rsi}: ENB normal range`); }
      // Overbought — very dampened. Yield stocks can run warm for months on rate cuts.
      else if (rsi < 75) { score += 3;   notes.push(`RSI ${rsi}: ENB mildly warm`); }
      else if (rsi < 80) { score += 8;   notes.push(`RSI ${rsi}: ENB warm — rate cut rally?`); }
      else               { score += 18;  notes.push(`RSI ${rsi}: ENB overbought — unusual`); }
    }

    // Daily change — ENB-specific bands (moves <1% are routine, -2% is notable)
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
  const isENB = archetype === "dividend_compounder";  // ← NEW

  // Moving average signal — archetype-aware
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
      // ── ENB: above_both is NORMAL for a dividend compounder ────────  ← NEW
      // ENB in a healthy uptrend with golden cross is the default state.
      // Below both MAs is a genuine distress signal (rare for ENB) — strong buy.
      const enbMaScores = {
        "above_both_golden": 0,       // normal yield compounder state
        "above_both": 0,              // normal
        "above_50_below_200": -8,     // pullback through long MA — buy signal
        "above_200_below_50": -3,     // weakening but long trend intact — mild buy
        "below_both": -20,            // distress — rare for a pipeline company, buy
        "below_both_death": -30,      // severe distress — max buy (2020, 2022 type event)
      };
      if (enbMaScores[ma] != null) {
        score += enbMaScores[ma];
        notes.push(`ENB MA: ${ma} (${enbMaScores[ma] !== 0 ? (enbMaScores[ma] > 0 ? "+" : "") + enbMaScores[ma] : "normal yield compounder trend"})`);
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
      // ── ENB: INVERTED 52-WEEK (yield compounder) ──────────────────  ← NEW
      // ENB near highs = yield compressed = less attractive but normal.
      // ENB deep in drawdown = yield expanded = better income buy.
      // Magnitude is moderate (not as extreme as ASML) because ENB's upside
      // is bounded by yield — you're buying for income + 3-5% dividend growth,
      // not for 3-5x capital appreciation.
      if (w52 > 95)      { score += 0;   notes.push(`ENB 52w: ${w52}% — at highs, yield compressed — normal`); }
      else if (w52 > 85) { score += 0;   notes.push(`ENB 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += -3;  notes.push(`ENB 52w: ${w52}% — mild pullback, yield expanding`); }
      else if (w52 > 50) { score += -10; notes.push(`ENB 52w: ${w52}% — pullback, attractive yield territory`); }
      else if (w52 > 30) { score += -22; notes.push(`ENB 52w: ${w52}% — significant drawdown, high yield buy`); }
      else if (w52 > 15) { score += -35; notes.push(`ENB 52w: ${w52}% — major drawdown, strong buy (rare)`); }
      else               { score += -45; notes.push(`ENB 52w: ${w52}% — distressed — max conviction buy`); }
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

  // IBIT: distance from 200DMA is the core positional signal (phase-amplified)
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
  // Non-IBIT SMA distance
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
      // ── ENB: narrow SMA bands (yield stocks move slowly) ───────────  ← NEW
      if (pctFromSMA < -8)       { score += -12; notes.push(`ENB ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -4)  { score += -5;  notes.push(`ENB ${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   notes.push(`ENB ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 5)   { score += 2;   }
    } else {
      if (pctFromSMA < -15)      { score += -10; notes.push(`${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA < -8)  { score += -5;  }
      else if (pctFromSMA > 15)  { score += 10;  notes.push(`${pctFromSMA.toFixed(1)}% above SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   }
    }
  }

  // ── ENB ONLY: Yield spread vs US 10Y — THE primary positional signal ─────  ← NEW
  // This is computed from data we already have: ENB's dividend yield (Finnhub)
  // and the US 10Y yield (FRED). The spread tells you how much premium ENB
  // pays over risk-free income. Wider = more attractive. Narrower = rich.
  if (isENB && macro?.us10y != null) {
    const divYield = data.valuation?.dividendYield;
    if (divYield != null && divYield > 0) {
      const spreadPct = divYield - macro.us10y; // in percentage points
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

  // SPY ONLY: RSP/SPY breadth ratio
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

  // SPY ONLY: HY OAS credit spread
  if (isSPY && macro?.hy_oas != null) {
    const oas = macro.hy_oas;
    if (oas < 300)      { score += -5; notes.push(`HY OAS ${oas}bps: tight spreads, risk-on`); }
    else if (oas < 400) { score += 0;  notes.push(`HY OAS ${oas}bps: normal`); }
    else if (oas < 500) { score += 10; notes.push(`HY OAS ${oas}bps: widening, caution`); }
    else if (oas < 700) { score += 20; notes.push(`HY OAS ${oas}bps: stressed, defensive`); }
    else                { score += 30; notes.push(`HY OAS ${oas}bps: crisis-level spreads`); }
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
  const isENB = archetype === "dividend_compounder";  // ← NEW

  // ─── IBIT STRATEGIC ──────────────────────────────────────────────────────
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

  // ─── ENB STRATEGIC ────────────────────────────────────────────────────────  ← NEW
  // Three pillars: (1) rate regime, (2) dividend sustainability, (3) real yields.
  // Gas volumes and LNG buildout are handled qualitatively by the LLM layer
  // since we don't have Henry Hub or pipeline utilization data deterministically.
  if (isENB) {
    // P/E — dampened for a utility/infrastructure company
    // ENB normally trades 18-24x. Only score extremes.
    const pe = data.valuation?.trailingPE;
    if (pe != null && pe > 0) {
      if (pe < 14)       { score += -10; notes.push(`ENB P/E ${pe.toFixed(1)}x: cheap for infrastructure`); }
      else if (pe < 18)  { score += -5;  notes.push(`ENB P/E ${pe.toFixed(1)}x: below normal`); }
      else if (pe <= 24) { score += 0;   notes.push(`ENB P/E ${pe.toFixed(1)}x: normal range`); }
      else if (pe < 28)  { score += 3;   notes.push(`ENB P/E ${pe.toFixed(1)}x: slightly rich`); }
      else               { score += 8;   notes.push(`ENB P/E ${pe.toFixed(1)}x: rich for infrastructure`); }
    }

    // Dividend yield — the core strategic anchor for ENB
    // Higher yield = stock is cheaper (price down, same dividend) = buy signal
    // Lower yield = stock is expensive = trim territory
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

    // Real yields (TIPS) — ENHANCED weight for ENB vs generic
    // ENB is a long-duration income asset that directly competes with bonds.
    // Higher real rates = genuine headwind (capital flows to risk-free income).
    // Lower real rates = ENB's 6%+ yield is very attractive on relative basis.
    const tips = macro?.tips10y;
    if (tips != null) {
      if (tips > 3)       { score += 10;  notes.push(`TIPS ${tips}%: very restrictive — strong headwind for yield stocks`); }
      else if (tips > 2.5){ score += 6;   notes.push(`TIPS ${tips}%: restrictive — yield stock headwind`); }
      else if (tips > 2)  { score += 3;   notes.push(`TIPS ${tips}%: mildly restrictive`); }
      else if (tips < 0)  { score += -10; notes.push(`TIPS ${tips}%: accommodative — yield stocks shine`); }
      else if (tips < 0.5){ score += -5;  notes.push(`TIPS ${tips}%: very low real rates — ENB yield attractive`); }
      else if (tips < 1)  { score += -3;  notes.push(`TIPS ${tips}%: low real rates`); }
    }

    // 2s10s yield curve — rate regime matters for bond proxies
    // Steepening / rate cuts = tailwind (ENB yield more attractive vs falling 10Y)
    // Inverting / rate hikes = headwind (bonds compete harder)
    if (macro?.spread_2s10s != null) {
      const spread = macro.spread_2s10s;
      if (spread > 100)       { score += -5; notes.push(`2s10s +${spread}bps: steep curve — rate cut regime, ENB tailwind`); }
      else if (spread > 50)   { score += -3; notes.push(`2s10s +${spread}bps: steepening — mildly positive for ENB`); }
      else if (spread > -30)  { score += 0;  notes.push(`2s10s ${spread}bps: normal range`); }
      else if (spread > -75)  { score += 5;  notes.push(`2s10s ${spread}bps: inverted — rate risk headwind`); }
      else                    { score += 8;  notes.push(`2s10s ${spread}bps: deeply inverted — yield stocks under pressure`); }
    }

    // VIX — mild overlay (ENB is defensive, less affected by equity vol)
    const vix = macro?.vix;
    if (vix != null) {
      if (vix > 35)      { score += -5; notes.push(`VIX ${vix}: panic — ENB defensive quality, mild buy`); }
      else if (vix > 25) { score += -2; notes.push(`VIX ${vix}: elevated fear — ENB as safe haven`); }
    }

    return { score: clamp(score), notes };
  }

  // P/E valuation — ARCHETYPE AWARE
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

  // P/B — skip for SPY, ASML, and ENB
  if (!isSPY && !isASML && !isENB) {  // ← CHANGED: added isENB
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
      else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
      else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
      else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
    }
  }

  // Dividend yield (handled inside ENB branch above, skip here for ENB)
  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0 && !isENB) {  // ← CHANGED: added !isENB
    if (isSPY) {
      if (dy > 2.5)     { score += -5; notes.push(`S&P yield ${dy}%: elevated — market is cheap`); }
      else if (dy < 1)  { score += 3;  notes.push(`S&P yield ${dy}%: compressed — market is rich`); }
    } else if (isASML) {
      // ASML yield ~1% — skip
    } else {
      if (dy > 8)       { score += -10; notes.push(`Yield ${dy}%: very high`); }
      else if (dy > 5)  { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
    }
  }

  // VIX (handled inside ENB branch above, skip here for ENB)
  const vix = macro?.vix;
  if (vix != null && !isENB) {  // ← CHANGED: added !isENB
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

  // Real yields (handled inside ENB branch above, skip here for ENB)
  const tips = macro?.tips10y;
  if (tips != null && !isENB) {  // ← CHANGED: added !isENB
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

  // SPY ONLY: yield curve (ENB has its own 2s10s logic inside its branch above)
  if (isSPY && macro?.spread_2s10s != null) {
    const spread = macro.spread_2s10s;
    if (spread > 100)       { score += -8; notes.push(`2s10s +${spread}bps: steep curve — bullish macro`); }
    else if (spread > 50)   { score += -5; notes.push(`2s10s +${spread}bps: healthy steepening`); }
    else if (spread > 0)    { score += -2; notes.push(`2s10s +${spread}bps: mildly positive`); }
    else if (spread > -30)  { score += 3;  notes.push(`2s10s ${spread}bps: flat/mildly inverted`); }
    else if (spread > -75)  { score += 8;  notes.push(`2s10s ${spread}bps: inverted — recession signal`); }
    else                    { score += 15; notes.push(`2s10s ${spread}bps: deeply inverted — max caution`); }
  }

  // SPY ONLY: real rate stance
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
export function blendScores(deterministic, llm, weights) {
  const blend = (detScore, llmScore) => Math.round(detScore * 0.5 + llmScore * 0.5);

  const tactical  = blend(deterministic.tactical.score, llm.tactical?.score ?? 0);
  const positional = blend(deterministic.positional.score, llm.positional?.score ?? 0);
  const strategic = blend(deterministic.strategic.score, llm.strategic?.score ?? 0);

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
