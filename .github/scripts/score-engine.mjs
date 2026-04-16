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

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
const CYCLICAL_ARCHETYPES = new Set([
  "cyclical_commodity",          // MOS
  "diversified_commodity_trader", // GLNCY
  "cyclical_trade_bellwether",   // AMKBY
  "em_state_oil_dividend",       // PBR.A
]);

// ─── TACTICAL LAYER (short-term mean reversion) ─────────────────────────────
// Inputs: RSI, daily change %, VIX (for SPY combo trigger)
export function scoreTactical(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isSPY = archetype === "beta_sizing";
  const rsi = data.technicals?.rsi14;
  const vix = macro?.vix;

  // ─── SPY-SPECIFIC: VIX + RSI COMBO TRIGGERS ──────────────────────────────
  // These override generic RSI scoring when both VIX and RSI are available.
  // The VIX+RSI combo is far more predictive for SPY than RSI alone because
  // SPY mean-reverts less aggressively than individual stocks.
  // Historical win rate: VIX>25 & RSI<30 → ~75% positive 5-day forward return.
  if (isSPY && vix != null && rsi != null) {
    // ── Buy combos (fear + oversold) ──
    if (vix > 35 && rsi < 30) {
      score += -65; notes.push(`VIX ${vix} + RSI ${rsi}: panic oversold combo — strong buy`);
    } else if (vix > 30 && rsi < 35) {
      score += -50; notes.push(`VIX ${vix} + RSI ${rsi}: elevated fear + oversold — buy`);
    } else if (vix > 25 && rsi < 30) {
      score += -55; notes.push(`VIX ${vix} + RSI ${rsi}: classic buy trigger (~75% 5d win rate)`);
    } else if (vix > 25 && rsi < 40) {
      score += -30; notes.push(`VIX ${vix} + RSI ${rsi}: fear + weakening — moderate buy`);
    }
    // ── Trim combos (complacency + overbought) ──
    else if (vix < 12 && rsi > 75) {
      score += 55; notes.push(`VIX ${vix} + RSI ${rsi}: extreme complacency — strong trim`);
    } else if (vix < 14 && rsi > 70) {
      score += 40; notes.push(`VIX ${vix} + RSI ${rsi}: complacent overbought — trim`);
    } else if (vix < 15 && rsi > 75) {
      score += 35; notes.push(`VIX ${vix} + RSI ${rsi}: low vol + stretched — trim`);
    }
    // ── No combo triggered — use softened RSI-only for SPY ──
    // SPY's RSI is less mean-reverting than single stocks, so we dampen
    else {
      if (rsi < 25)      { score += -30; notes.push(`RSI ${rsi}: SPY deeply oversold (VIX ${vix})`); }
      else if (rsi < 30) { score += -20; notes.push(`RSI ${rsi}: SPY oversold (VIX ${vix})`); }
      else if (rsi < 40) { score += -8;  notes.push(`RSI ${rsi}: SPY mildly soft (VIX ${vix})`); }
      else if (rsi <= 60) { score += 0;  notes.push(`RSI ${rsi}: SPY neutral (VIX ${vix})`); }
      else if (rsi < 70) { score += 8;   notes.push(`RSI ${rsi}: SPY mildly overbought (VIX ${vix})`); }
      else if (rsi < 80) { score += 20;  notes.push(`RSI ${rsi}: SPY overbought (VIX ${vix})`); }
      else               { score += 35;  notes.push(`RSI ${rsi}: SPY extremely overbought (VIX ${vix})`); }
    }

    // ── VIX direction bonus (applicable even without RSI combo) ──
    // VIX falling from elevated = fear subsiding = tactical positive
    // This is captured separately from the combo triggers
    if (vix > 20 && vix < 30) {
      score += -3; notes.push(`VIX ${vix}: moderately elevated — slight tactical buy bias`);
    }

    // Daily change — same for SPY but with narrower bands (SPY moves less)
    const chg = data.price?.change_pct;
    if (chg != null) {
      if (chg < -3)      { score += -12; notes.push(`SPY daily ${chg}%: significant decline`); }
      else if (chg < -2) { score += -6;  notes.push(`SPY daily ${chg}%: notable decline`); }
      else if (chg > 3)  { score += 12;  notes.push(`SPY daily +${chg}%: significant rally`); }
      else if (chg > 2)  { score += 6;   notes.push(`SPY daily +${chg}%: notable rally`); }
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

  // Daily change — large moves suggest mean reversion
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
// Inputs: MA signal, 52-week position, price vs SMAs, RSP breadth (SPY only)
export function scorePositional(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isSPY = archetype === "beta_sizing";

  // Moving average signal — same logic for all, but SPY interpretation differs
  const ma = data.technicals?.ma_signal;
  if (ma) {
    if (isSPY) {
      // SPY above both MAs is NORMAL and healthy, not a trim signal.
      // Only below_both and death crosses are meaningful for SPY.
      const spyMaScores = {
        "above_both_golden": 0,       // strong uptrend — neutral for SPY (this is normal)
        "above_both": 0,              // uptrend — neutral
        "above_50_below_200": -8,     // pulled back to support — mild buy
        "above_200_below_50": 5,      // weakening — mild caution
        "below_both": -15,            // correction — buy the dip
        "below_both_death": -25,      // bear market — strong contrarian buy
      };
      if (spyMaScores[ma] != null) {
        score += spyMaScores[ma];
        notes.push(`SPY MA: ${ma} (${spyMaScores[ma] !== 0 ? (spyMaScores[ma] > 0 ? "+" : "") + spyMaScores[ma] : "neutral — normal for SPY"})`);
      }
    } else {
      const maScores = {
        "above_both_golden": 15,
        "above_both": 10,
        "above_50_below_200": -5,
        "above_200_below_50": 5,
        "below_both": -10,
        "below_both_death": -15,
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
      // ── SPY: INVERTED 52-WEEK LOGIC ───────────────────────────────
      // SPY makes new 52w highs ~7% of trading days. When within 2% of
      // highs, forward 20-day returns average +1.2%. New highs are
      // momentum-positive, not overbought.
      // The real buy signal is significant drawdowns from highs.
      if (w52 > 95)      { score += -5;  notes.push(`SPY 52w: ${w52}% — at highs, momentum positive`); }
      else if (w52 > 85) { score += 0;   notes.push(`SPY 52w: ${w52}% — near highs, healthy`); }
      else if (w52 > 70) { score += 0;   notes.push(`SPY 52w: ${w52}% — normal range`); }
      else if (w52 > 50) { score += -5;  notes.push(`SPY 52w: ${w52}% — mild pullback, slight buy`); }
      else if (w52 > 30) { score += -15; notes.push(`SPY 52w: ${w52}% — correction territory, buy`); }
      else if (w52 > 15) { score += -25; notes.push(`SPY 52w: ${w52}% — significant drawdown, strong buy`); }
      else               { score += -35; notes.push(`SPY 52w: ${w52}% — deep drawdown, max buy`); }
    } else {
      // ── Generic 52-week scoring (all other holdings) ──────────────
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

  // Price distance from SMA50 — reversion signal
  const price = data.price?.current;
  const sma50 = data.technicals?.sma50;
  if (price && sma50) {
    const pctFromSMA = ((price - sma50) / sma50) * 100;
    if (isSPY) {
      // SPY deviations from SMA50 are narrower and more meaningful
      if (pctFromSMA < -10)      { score += -12; notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50 — stretched down`); }
      else if (pctFromSMA < -5)  { score += -6;  notes.push(`SPY ${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA > 10)  { score += 8;   notes.push(`SPY ${pctFromSMA.toFixed(1)}% above SMA50 — extended`); }
      else if (pctFromSMA > 6)   { score += 4;   }
    } else {
      if (pctFromSMA < -15)      { score += -10; notes.push(`${pctFromSMA.toFixed(1)}% below SMA50`); }
      else if (pctFromSMA < -8)  { score += -5;  }
      else if (pctFromSMA > 15)  { score += 10;  notes.push(`${pctFromSMA.toFixed(1)}% above SMA50`); }
      else if (pctFromSMA > 8)   { score += 5;   }
    }
  }

  // ── SPY ONLY: RSP/SPY breadth ratio ───────────────────────────────────────
  // If fetch-market-data provides breadth data, use it.
  // RSP outperforming SPY = broad rally = healthy.
  // SPY outperforming RSP = narrow/top-heavy = fragile.
  if (isSPY && data.breadth) {
    const ratio = data.breadth.rsp_spy_ratio;
    const rspChange = data.breadth.rsp_change_pct;
    const spyChange = data.price?.change_pct;

    if (rspChange != null && spyChange != null) {
      const breadthSpread = rspChange - spyChange; // positive = RSP outperforming = healthy
      if (breadthSpread > 0.5) {
        score += -5; notes.push(`RSP outperforming SPY by ${breadthSpread.toFixed(2)}pp — broad rally, healthy`);
      } else if (breadthSpread < -0.5) {
        score += 5; notes.push(`SPY outperforming RSP by ${(-breadthSpread).toFixed(2)}pp — narrow/top-heavy`);
      } else {
        notes.push(`RSP/SPY breadth spread: ${breadthSpread.toFixed(2)}pp — inline`);
      }
    }
  }

  // ── SPY ONLY: HY OAS credit spread as positional signal ──────────────────
  // Credit spreads tightening = risk appetite healthy = SPY support.
  // Widening above 400bps historically precedes SPY drawdowns.
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
// Inputs: P/E, P/B, dividend yield, VIX, real yields, yield curve, credit
// NOTE: archetype-aware — cyclical names get INVERTED P/E scoring
//       SPY gets macro regime overlay (2s10s, real rates, HY OAS)
export function scoreStrategic(data, macro) {
  let score = 0;
  const notes = [];

  const archetype = data._archetype || "";
  const isCyclical = CYCLICAL_ARCHETYPES.has(archetype);
  const isSPY = archetype === "beta_sizing";

  // P/E valuation — ARCHETYPE AWARE
  const pe = data.valuation?.trailingPE;
  if (pe != null && pe > 0) {
    if (isCyclical) {
      // ─── CYCLICAL PE LOGIC (INVERTED) ─────────────────────────────
      if (pe > 100)      { score += -20; notes.push(`P/E ${pe.toFixed(0)}x: trough earnings — cyclical buy`); }
      else if (pe > 50)  { score += -12; notes.push(`P/E ${pe.toFixed(0)}x: depressed earnings — cyclical buy`); }
      else if (pe > 25)  { score += -5;  notes.push(`P/E ${pe.toFixed(0)}x: below-trend earnings`); }
      else if (pe > 15)  { score += 0;   notes.push(`P/E ${pe.toFixed(0)}x: mid-cycle`); }
      else if (pe > 8)   { score += 10;  notes.push(`P/E ${pe.toFixed(0)}x: peak earnings — cyclical caution`); }
      else               { score += 20;  notes.push(`P/E ${pe.toFixed(0)}x: super-peak — cyclical trim`); }
    } else if (isSPY) {
      // ─── SPY PE LOGIC ─────────────────────────────────────────────
      // S&P 500 trailing P/E operates in a different range than single stocks.
      // 20-25x is "normal" for the modern S&P. Only extremes matter.
      if (pe < 14)       { score += -12; notes.push(`S&P P/E ${pe.toFixed(1)}x: historically cheap`); }
      else if (pe < 18)  { score += -5;  notes.push(`S&P P/E ${pe.toFixed(1)}x: below-average value`); }
      else if (pe <= 25) { score += 0;   notes.push(`S&P P/E ${pe.toFixed(1)}x: normal range`); }
      else if (pe < 30)  { score += 5;   notes.push(`S&P P/E ${pe.toFixed(1)}x: above average`); }
      else if (pe < 35)  { score += 10;  notes.push(`S&P P/E ${pe.toFixed(1)}x: rich`); }
      else               { score += 18;  notes.push(`S&P P/E ${pe.toFixed(1)}x: extreme — late cycle`); }
    } else {
      // ─── SECULAR / GROWTH PE LOGIC (STANDARD) ─────────────────────
      if (pe < 8)        { score += -15; notes.push(`P/E ${pe}: deep value`); }
      else if (pe < 12)  { score += -8;  notes.push(`P/E ${pe}: value`); }
      else if (pe < 18)  { score += -3;  notes.push(`P/E ${pe}: fair`); }
      else if (pe <= 25) { score += 0;   notes.push(`P/E ${pe}: moderate`); }
      else if (pe < 35)  { score += 8;   notes.push(`P/E ${pe}: rich`); }
      else if (pe < 50)  { score += 15;  notes.push(`P/E ${pe}: expensive`); }
      else               { score += 25;  notes.push(`P/E ${pe}: extreme`); }
    }
  }

  // P/B valuation (skip for SPY — P/B is less meaningful for an index)
  if (!isSPY) {
    const pb = data.valuation?.priceToBook;
    if (pb != null && pb > 0) {
      if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
      else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
      else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
      else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
    }
  }

  // Dividend yield — higher = more strategic support
  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0) {
    if (isSPY) {
      // SPY yield is structurally lower (~1.2-1.8%). Only flag extremes.
      if (dy > 2.5)     { score += -5; notes.push(`S&P yield ${dy}%: elevated — market is cheap`); }
      else if (dy < 1)  { score += 3;  notes.push(`S&P yield ${dy}%: compressed — market is rich`); }
    } else {
      if (dy > 8)       { score += -10; notes.push(`Yield ${dy}%: very high`); }
      else if (dy > 5)  { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
      else if (dy > 3)  { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
    }
  }

  // Macro overlay — VIX regime (applies to all, but different weight for SPY)
  const vix = macro?.vix;
  if (vix != null) {
    if (isSPY) {
      // VIX is a primary strategic input for SPY, not just an overlay
      if (vix > 40)      { score += -15; notes.push(`VIX ${vix}: panic — strong contrarian buy`); }
      else if (vix > 30) { score += -10; notes.push(`VIX ${vix}: high fear — contrarian buy`); }
      else if (vix > 25) { score += -5;  notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 12) { score += 8;   notes.push(`VIX ${vix}: extreme complacency — risk elevated`); }
      else if (vix < 14) { score += 4;   notes.push(`VIX ${vix}: low vol complacency`); }
    } else {
      if (vix > 35)      { score += -8; notes.push(`VIX ${vix}: panic — contrarian buy`); }
      else if (vix > 25) { score += -3; notes.push(`VIX ${vix}: elevated fear`); }
      else if (vix < 13) { score += 5;  notes.push(`VIX ${vix}: complacency`); }
    }
  }

  // Real yields — higher real yields = headwind for duration assets
  const tips = macro?.tips10y;
  if (tips != null) {
    if (tips > 2.5)     { score += 5;  notes.push(`TIPS ${tips}%: restrictive`); }
    else if (tips > 2)  { score += 2;  }
    else if (tips < 0)  { score += -5; notes.push(`TIPS ${tips}%: accommodative`); }
  }

  // ── SPY ONLY: Yield curve regime (2s10s spread) ───────────────────────────
  // Steepening from inversion = "all clear" for equities.
  // Inverting = recession risk ahead.
  if (isSPY && macro?.spread_2s10s != null) {
    const spread = macro.spread_2s10s; // in bps, positive = normal curve
    if (spread > 100)       { score += -8; notes.push(`2s10s +${spread}bps: steep curve — bullish macro`); }
    else if (spread > 50)   { score += -5; notes.push(`2s10s +${spread}bps: healthy steepening`); }
    else if (spread > 0)    { score += -2; notes.push(`2s10s +${spread}bps: mildly positive`); }
    else if (spread > -30)  { score += 3;  notes.push(`2s10s ${spread}bps: flat/mildly inverted`); }
    else if (spread > -75)  { score += 8;  notes.push(`2s10s ${spread}bps: inverted — recession signal`); }
    else                    { score += 15; notes.push(`2s10s ${spread}bps: deeply inverted — max caution`); }
  }

  // ── SPY ONLY: Real rate stance (fed funds - TIPS) ─────────────────────────
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
  const tactical = scoreTactical(data, macro);       // macro passed for SPY VIX combo
  const positional = scorePositional(data, macro);   // macro passed for SPY HY OAS
  const strategic = scoreStrategic(data, macro);

  // Weighted composite using holding-specific weights
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
// 50/50 blend at the layer level
export function blendScores(deterministic, llm, weights) {
  const blend = (detScore, llmScore) => Math.round(detScore * 0.5 + llmScore * 0.5);

  const tactical  = blend(deterministic.tactical.score, llm.tactical?.score ?? 0);
  const positional = blend(deterministic.positional.score, llm.positional?.score ?? 0);
  const strategic = blend(deterministic.strategic.score, llm.strategic?.score ?? 0);

  const w = weights || { t: 0.25, p: 0.35, s: 0.40 };
  const composite = Math.round(tactical * w.t + positional * w.p + strategic * w.s);

  // Determine signal from score
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
