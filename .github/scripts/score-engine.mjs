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
//   - MOMENTUM_STORE_OF_VALUE (IBIT): softened RSI + wider daily bands tactical,
//     inverted 52w + 200DMA-extension positional, phase-modified (not phase-triggered)
//     strategic. Cycle phase is a MODIFIER on extension signals, not a standalone
//     trim trigger. Deeper into cycle → more aggressive buying of weakness.
//   - SECULAR_GROWTH_MONOPOLY (ASML): dampened high-RSI (compounders sustain
//     momentum), inverted 52w (drawdowns are rare alpha), above_both_golden = 0
//     (normal state for compounder), dampened trailing P/E (cycle-lagging),
//     P/B and yield ignored (asset-light / non-income asset).

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
  const isASML = archetype === "secular_growth_monopoly";  // ← NEW
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

  // ─── ASML-SPECIFIC: COMPOUNDER RSI + BIG-DROP-AS-ALPHA ───────────────────  ← NEW
  // Secular compounders sustain high RSI for extended periods during uptrends.
  // RSI 65-75 is normal momentum for ASML, not a reversal signal. Only RSI >85
  // meaningfully suggests exhaustion. Conversely, oversold conditions are rarer
  // and more powerful — a compounder at RSI <30 is a meaningful opportunity.
  // Big intraday drops (5%+) are often the real tactical alpha (China headlines,
  // earnings reactions) — these are BUY signals, not noise.
  if (isASML) {
    if (rsi != null) {
      // Buy zones — oversold in a compounder is rare and valuable
      if (rsi < 20)      { score += -55; notes.push(`RSI ${rsi}: ASML severe oversold — rare compounder opportunity`); }
      else if (rsi < 25) { score += -42; notes.push(`RSI ${rsi}: ASML deeply oversold — compounder on sale`); }
      else if (rsi < 30) { score += -28; notes.push(`RSI ${rsi}: ASML oversold`); }
      else if (rsi < 35) { score += -12; notes.push(`RSI ${rsi}: ASML mildly oversold`); }
      else if (rsi < 45) { score += -3;  notes.push(`RSI ${rsi}: ASML slight softness`); }
      // Neutral — compounders trend. 45-70 is the normal range, NOT overbought.
      else if (rsi <= 65) { score += 0;  notes.push(`RSI ${rsi}: ASML normal trending range`); }
      // Overbought zones — DAMPENED. Compounders sustain momentum for weeks.
      else if (rsi < 70) { score += 3;   notes.push(`RSI ${rsi}: ASML normal uptrend momentum`); }
      else if (rsi < 75) { score += 8;   notes.push(`RSI ${rsi}: ASML healthy momentum — not a trim signal`); }
      else if (rsi < 80) { score += 15;  notes.push(`RSI ${rsi}: ASML extended momentum`); }
      else if (rsi < 85) { score += 25;  notes.push(`RSI ${rsi}: ASML overbought — watch for pause`); }
      else               { score += 40;  notes.push(`RSI ${rsi}: ASML extreme — trim bias`); }
    }

    // Daily change — big drops on a compounder are the real alpha
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
  const isASML = archetype === "secular_growth_monopoly";  // ← NEW

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
      // ── ASML: above_both_golden is NORMAL for a compounder ─────────  ← NEW
      // A secular compounder in an uptrend with 50>200 is the default state.
      // It's not an "overextended" signal. Only breaks below 200DMA matter
      // (these are rare and typically high-conviction buy opportunities).
      const asmlMaScores = {
        "above_both_golden": 0,       // default compounder state — NEUTRAL
        "above_both": 0,              // default — NEUTRAL
        "above_50_below_200": -10,    // meaningful pullback through long MA — buy
        "above_200_below_50": -5,     // soft momentum, long trend intact — mild buy
        "below_both": -25,            // real drawdown — rare, high-conviction buy
        "below_both_death": -40,      // catastrophic break — very rare, max buy
      };
      if (asmlMaScores[ma] != null) {
        score += asmlMaScores[ma];
        notes.push(`ASML MA: ${ma} (${asmlMaScores[ma] !== 0 ? (asmlMaScores[ma] > 0 ? "+" : "") + asmlMaScores[ma] : "normal compounder trend"})`);
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
      // ── ASML: INVERTED 52-WEEK ─────────────────────────────────────  ← NEW
      // Secular compounders spend ~70% of days in the upper third of their
      // 52-week range. That's normal, not overbought. Real buy signals come
      // from meaningful drawdowns (spring 2019, COVID, late 2022, spring 2025).
      // These are RARE and the score should reflect their quality.
      if (w52 > 95)      { score += 0;   notes.push(`ASML 52w: ${w52}% — at highs, normal for compounder`); }
      else if (w52 > 85) { score += 0;   notes.push(`ASML 52w: ${w52}% — normal trading range`); }
      else if (w52 > 70) { score += -3;  notes.push(`ASML 52w: ${w52}% — mild pullback`); }
      else if (w52 > 50) { score += -12; notes.push(`ASML 52w: ${w52}% — meaningful pullback, buy interest`); }
      else if (w52 > 30) { score += -28; notes.push(`ASML 52w: ${w52}% — real drawdown, compounder on sale`); }
      else if (w52 > 15) { score += -45; notes.push(`ASML 52w: ${w52}% — major drawdown, high-conviction buy (rare)`); }
      else               { score += -60; notes.push(`ASML 52w: ${w52}% — catastrophic drawdown — max conviction (very rare)`); }
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
  // Non-IBIT: standard SMA50 distance
  else if (price && sma50) {
    const pctFromSMA = ((price - sma50) / sma50) * 100;
    if (isSPY) {
      if (pctFromSMA < -10)      { score += -12; notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -5)  { score += -6;  notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA > 10)  { score += 8;   notes.push(`SPY ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 6)   { score += 4;   }
    } else if (isASML) {
      // ── ASML: compounders can run above SMA50 for extended periods ──  ← NEW
      // Don't punish moderate extension. Big deviations in either direction matter.
      if (pctFromSMA < -12)      { score += -15; notes.push(`ASML ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down, strong buy`); }
      else if (pctFromSMA < -6)  { score += -8;  notes.push(`ASML ${pctFromSMA.toFixed(1)}% below SMA50 — pullback`); }
      else if (pctFromSMA > 18)  { score += 6;   notes.push(`ASML ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 10)  { score += 2;   notes.push(`ASML ${pctFromSMA.toFixed(1)}% above SMA50 — trending up`); }
    } else {
      if (pctFromSMA < -15)      { score += -10; notes.push(`${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA < -8)  { score += -5;  }
      else if (pctFromSMA > 15)  { score += 10;  notes.push(`${pctFromSMA.toFixed(1)}% above SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   }
    }
  }

  // ── SPY ONLY: RSP/SPY breadth ratio ───────────────────────────────────────
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

  // ── SPY ONLY: HY OAS credit spread ───────────────────────────────────────
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
  const isASML = archetype === "secular_growth_monopoly";  // ← NEW

  // ─── IBIT STRATEGIC (phase as context, not trigger) ──────────────────────
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
      // ── ASML: DAMPENED TRAILING P/E ─────────────────────────────────  ← NEW
      // ASML's trailing P/E lags the semi cycle significantly. The stock normally
      // trades 30-42x trailing during healthy cycle expansions — that's the
      // base case, not "expensive." Forward P/E would be more informative
      // (LLM layer should fetch it) but trailing is what we have deterministically.
      // Cheap = <25x (rare), extreme = >50x (peak hype).
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

  // P/B valuation — skip for SPY (index) and ASML (asset-light compounder)  ← CHANGED
  if (!isSPY && !isASML) {
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
      else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
      else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
      else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
    }
  }

  // Dividend yield — ASML yield (~1%) doesn't trigger any bonus band anyway
  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0) {
    if (isSPY) {
      if (dy > 2.5)     { score += -5; notes.push(`S&P yield ${dy}%: elevated — market is cheap`); }
      else if (dy < 1)  { score += 3;  notes.push(`S&P yield ${dy}%: compressed — market is rich`); }
    } else if (isASML) {
      // ASML yield around 1% — not a primary signal. Skip. (~NEW, explicit)
    } else {
      if (dy > 8)       { score += -10; notes.push(`Yield ${dy}%: very high`); }
      else if (dy > 5)  { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
    }
  }

  // VIX overlay
  const vix = macro?.vix;
  if (vix != null) {
    if (isSPY) {
      if (vix > 40)      { score += -15; notes.push(`VIX ${vix}: panic — strong contrarian buy`); }
      else if (vix > 30) { score += -10; notes.push(`VIX ${vix}: high fear — contrarian buy`); }
      else if (vix > 25) { score += -5;  notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 8;   notes.push(`VIX ${vix}: extreme complacency — risk elevated`); }
      else if (vix < 14) { score += 4;   notes.push(`VIX ${vix}: low vol complacency`); }
    } else if (isASML) {
      // ── ASML: VIX matters (high-multiple stock, compression risk) ──  ← NEW
      // But less than SPY since compounders ride through vol better.
      if (vix > 35)      { score += -10; notes.push(`VIX ${vix}: panic — ASML contrarian buy`); }
      else if (vix > 25) { score += -4;  notes.push(`VIX ${vix}: elevated fear — mild ASML buy bias`); }
      else if (vix < 12) { score += 3;   notes.push(`VIX ${vix}: complacency — marginal caution`); }
    } else {
      if (vix > 35)      { score += -8; notes.push(`VIX ${vix}: panic — contrarian buy`); }
      else if (vix > 25) { score += -3; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 13) { score += 5;  notes.push(`VIX ${vix}: complacency`); }
    }
  }

  // Real yields — ASML is long-duration, so real rates matter
  const tips = macro?.tips10y;
  if (tips != null) {
    if (isASML) {
      // ── ASML: real rates directly impact discount rate on long-duration cash flows ──  ← NEW
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

  // SPY ONLY: yield curve
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
