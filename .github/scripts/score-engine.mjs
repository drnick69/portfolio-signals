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

// ─── TACTICAL LAYER (short-term mean reversion) ─────────────────────────────
// Inputs: RSI, daily change %, volume ratio
export function scoreTactical(data) {
  let score = 0;
  const notes = [];

  // RSI scoring — the most reliable short-term signal
  const rsi = data.technicals?.rsi14;
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
// Inputs: MA signal, 52-week position, price vs SMAs
export function scorePositional(data) {
  let score = 0;
  const notes = [];

  // Moving average signal
  const ma = data.technicals?.ma_signal;
  if (ma) {
    const maScores = {
      "above_both_golden": 15,     // strong uptrend — trim bias
      "above_both": 10,            // uptrend
      "above_50_below_200": -5,    // recovering
      "above_200_below_50": 5,     // weakening
      "below_both": -10,           // downtrend — buy bias  
      "below_both_death": -15,     // strong downtrend — contrarian buy
    };
    if (maScores[ma] != null) {
      score += maScores[ma];
      notes.push(`MA: ${ma} (${maScores[ma] > 0 ? "+" : ""}${maScores[ma]})`);
    }
  }

  // 52-week position — where in the range are we?
  const w52 = data.price?.week52_position_pct;
  if (w52 != null) {
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

  // Price distance from SMA50 — reversion signal
  const price = data.price?.current;
  const sma50 = data.technicals?.sma50;
  if (price && sma50) {
    const pctFromSMA = ((price - sma50) / sma50) * 100;
    if (pctFromSMA < -15)      { score += -10; notes.push(`${pctFromSMA.toFixed(1)}% below SMA50`); }
    else if (pctFromSMA < -8)  { score += -5;  }
    else if (pctFromSMA > 15)  { score += 10;  notes.push(`${pctFromSMA.toFixed(1)}% above SMA50`); }
    else if (pctFromSMA > 8)   { score += 5;   }
  }

  return { score: clamp(score), notes };
}

// ─── STRATEGIC LAYER (long-term valuation) ──────────────────────────────────
// Inputs: P/E, P/B, dividend yield, VIX, real yields
export function scoreStrategic(data, macro) {
  let score = 0;
  const notes = [];

  // P/E valuation
  const pe = data.valuation?.trailingPE;
  if (pe != null && pe > 0) {
    if (pe < 8)        { score += -15; notes.push(`P/E ${pe}: deep value`); }
    else if (pe < 12)  { score += -8;  notes.push(`P/E ${pe}: value`); }
    else if (pe < 18)  { score += -3;  notes.push(`P/E ${pe}: fair`); }
    else if (pe <= 25) { score += 0;   notes.push(`P/E ${pe}: moderate`); }
    else if (pe < 35)  { score += 8;   notes.push(`P/E ${pe}: rich`); }
    else if (pe < 50)  { score += 15;  notes.push(`P/E ${pe}: expensive`); }
    else               { score += 25;  notes.push(`P/E ${pe}: extreme`); }
  }

  // P/B valuation
  const pb = data.valuation?.priceToBook;
  if (pb != null && pb > 0) {
    if (pb < 0.8)      { score += -10; notes.push(`P/B ${pb}: below book`); }
    else if (pb < 1.2) { score += -3;  notes.push(`P/B ${pb}: near book`); }
    else if (pb > 5)   { score += 8;   notes.push(`P/B ${pb}: premium`); }
    else if (pb > 10)  { score += 15;  notes.push(`P/B ${pb}: extreme premium`); }
  }

  // Dividend yield — higher = more strategic support
  const dy = data.valuation?.dividendYield;
  if (dy != null && dy > 0) {
    if (dy > 8)       { score += -10; notes.push(`Yield ${dy}%: very high`); }
    else if (dy > 5)  { score += -5;  notes.push(`Yield ${dy}%: attractive`); }
    else if (dy > 3)  { score += -2;  notes.push(`Yield ${dy}%: moderate`); }
  }

  // Macro overlay — VIX regime
  const vix = macro?.vix;
  if (vix != null) {
    if (vix > 35)      { score += -8; notes.push(`VIX ${vix}: panic — contrarian buy`); }
    else if (vix > 25) { score += -3; notes.push(`VIX ${vix}: elevated fear`); }
    else if (vix < 13) { score += 5;  notes.push(`VIX ${vix}: complacency`); }
  }

  // Real yields — higher real yields = headwind for duration assets
  const tips = macro?.tips10y;
  if (tips != null) {
    if (tips > 2.5)     { score += 5;  notes.push(`TIPS ${tips}%: restrictive`); }
    else if (tips > 2)  { score += 2;  }
    else if (tips < 0)  { score += -5; notes.push(`TIPS ${tips}%: accommodative`); }
  }

  return { score: clamp(score), notes };
}

// ─── COMPOSITE ──────────────────────────────────────────────────────────────
export function computeDeterministicScores(data, macro) {
  const tactical = scoreTactical(data);
  const positional = scorePositional(data);
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
