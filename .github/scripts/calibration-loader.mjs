#!/usr/bin/env node
// calibration-loader.mjs — Loads signal accuracy data and yesterday's snapshot
// for injection into the LLM qualitative prompt.
//
// Imported by generate-signals.mjs:
//   import { loadCalibration, buildCalibrationBlock } from "./calibration-loader.mjs";
//
// Provides two things:
// 1. Yesterday's scores + what happened (price change since yesterday)
// 2. Per-holding, per-layer hit rates from accuracy.json
//
// This breaks the LLM's "always moderately bullish" tendency by giving it
// concrete feedback on whether its previous calls were right or wrong.

import { readFileSync, existsSync } from "fs";

const ACCURACY_PATH = "docs/history/accuracy.json";

// ─── LOAD CALIBRATION DATA ──────────────────────────────────────────────────
export function loadCalibration() {
  const result = {
    available: false,
    totalDays: 0,
    yesterday: null,       // { date, holdings: { SYM: { price, scores... } } }
    reliability: null,     // { tactical: { grade, hit_rate }, ... }
    bySymbol: null,        // { SYM: { tactical: { BUY: { fwd_5d: { hit_rate } } } } }
    streaks: null,         // { SYM: { current_role, streak_days } }
  };

  if (!existsSync(ACCURACY_PATH)) {
    console.log("  [calibration] No accuracy.json found — first run, skipping calibration.");
    return result;
  }

  try {
    const data = JSON.parse(readFileSync(ACCURACY_PATH, "utf-8"));

    result.available = data.totalSignalDays > 0;
    result.totalDays = data.totalSignalDays || 0;
    result.yesterday = data.yesterday || null;
    result.reliability = data.reliability || null;
    result.bySymbol = data.bySymbol || null;
    result.streaks = data.streaks || null;

    console.log(`  [calibration] Loaded: ${result.totalDays} days of history, yesterday=${result.yesterday?.date || "none"}`);
    return result;
  } catch (e) {
    console.error(`  [calibration] Error loading accuracy.json: ${e.message}`);
    return result;
  }
}

// ─── BUILD CALIBRATION BLOCK FOR A SPECIFIC HOLDING ─────────────────────────
// Returns a string to inject into the LLM prompt, or empty string if no data.
export function buildCalibrationBlock(symbol, calibration, currentPrice) {
  if (!calibration.available) return "";

  const parts = [];

  // ── Yesterday's scores + price movement ──
  const yest = calibration.yesterday?.holdings?.[symbol];
  if (yest && currentPrice && yest.price) {
    const priceChange = ((currentPrice - yest.price) / yest.price * 100).toFixed(2);
    const direction = priceChange > 0 ? "UP" : priceChange < 0 ? "DOWN" : "FLAT";

    parts.push(`YESTERDAY'S SCORES (${calibration.yesterday.date}):
  Price was $${yest.price.toFixed(2)} → now $${currentPrice.toFixed(2)} (${direction} ${priceChange}%)
  Your scores: Tactical=${yest.tactical_score ?? "?"}, Positional=${yest.positional_score ?? "?"}, Strategic=${yest.strategic_score ?? "?"}, Composite=${yest.composite_score ?? "?"}
  Role assigned: ${yest.role || "HOLD"}
  ${parseFloat(priceChange) > 0 && (yest.composite_score ?? 0) < -10
    ? "→ Yesterday's BUY signal was CORRECT (price rose)."
    : parseFloat(priceChange) < 0 && (yest.composite_score ?? 0) > 10
    ? "→ Yesterday's SELL/TRIM signal was CORRECT (price fell)."
    : parseFloat(priceChange) < 0 && (yest.composite_score ?? 0) < -10
    ? "→ Yesterday's BUY signal was INCORRECT (price fell). Consider whether your conviction was justified."
    : parseFloat(priceChange) > 0 && (yest.composite_score ?? 0) > 10
    ? "→ Yesterday's SELL/TRIM signal was INCORRECT (price rose). Re-examine your bearish thesis."
    : "→ Signal was NEUTRAL or move was small. No strong calibration signal."
  }`);
  }

  // ── Streak info ──
  const streak = calibration.streaks?.[symbol];
  if (streak) {
    parts.push(`SIGNAL STREAK: ${symbol} has been ${streak.current_role} for ${streak.streak_days} consecutive day(s).
  ${streak.streak_days >= 5 ? "⚠️ Extended streak — verify the thesis hasn't gone stale." : ""}`);
  }

  // ── Hit rate history ──
  const symAccuracy = calibration.bySymbol?.[symbol];
  if (symAccuracy) {
    const layerSummaries = [];

    for (const [layer, buckets] of Object.entries(symAccuracy)) {
      // Find the buy-signal hit rate at the primary window
      const primaryWindow = layer === "tactical" ? "fwd_5d" :
                           layer === "positional" ? "fwd_20d" :
                           layer === "strategic" ? "fwd_60d" : "fwd_20d";

      let buyHitRate = null;
      let buyN = 0;
      let buyAvg = null;

      for (const [bucket, data] of Object.entries(buckets)) {
        if (bucket === "BUY" || bucket === "STRONG_BUY") {
          const wd = data[primaryWindow];
          if (wd && wd.n > 0) {
            buyN += wd.n;
            buyHitRate = wd.hit_rate;
            buyAvg = wd.avg_return;
          }
        }
      }

      if (buyN > 0) {
        layerSummaries.push(`  ${layer}: BUY signals hit ${buyHitRate}% of the time (avg ${buyAvg > 0 ? "+" : ""}${buyAvg}%, n=${buyN}, window=${primaryWindow})`);
      }
    }

    if (layerSummaries.length > 0) {
      parts.push(`YOUR HISTORICAL ACCURACY FOR ${symbol}:\n${layerSummaries.join("\n")}`);
    }
  }

  // ── Portfolio-wide reliability ──
  if (calibration.reliability) {
    const grades = [];
    for (const [layer, r] of Object.entries(calibration.reliability)) {
      if (r.grade && r.grade !== "INSUFFICIENT_DATA") {
        grades.push(`${layer}=${r.grade}(${r.hit_rate}%)`);
      }
    }
    if (grades.length > 0) {
      parts.push(`PORTFOLIO-WIDE LAYER RELIABILITY: ${grades.join(", ")}
  ${Object.values(calibration.reliability).some(r => r.grade === "POOR")
    ? "⚠️ Some layers are grading POOR — consider whether those layers are adding signal or noise."
    : ""}`);
    }
  }

  if (parts.length === 0) return "";

  return `\n─── CALIBRATION FEEDBACK (${calibration.totalDays} days of history) ───
${parts.join("\n\n")}
─── END CALIBRATION ───\n`;
}

// ─── COMPUTE DATA CONFIDENCE ─────────────────────────────────────────────────
// Returns "high", "medium", or "low" based on data completeness for a holding.
// Used by score-engine and generate-signals to weight signal reliability.
export function computeConfidence(marketData, symbol) {
  const md = marketData[symbol];
  if (!md) return { level: "low", score: 0, missing: ["all data"] };

  const checks = [];
  const missing = [];

  // Price (critical)
  if (md.price?.current && md.price.current > 0) {
    checks.push(3); // weight 3 — most important
  } else {
    missing.push("price");
  }

  // RSI (important for tactical)
  if (md.technicals?.rsi14 != null && md.technicals.rsi14 > 0) {
    checks.push(2);
  } else {
    missing.push("RSI");
  }

  // Moving averages (important for positional)
  if (md.technicals?.sma50 && md.technicals?.sma200) {
    checks.push(2);
  } else if (md.technicals?.sma50 || md.technicals?.sma200) {
    checks.push(1);
    missing.push("partial MAs");
  } else {
    missing.push("moving averages");
  }

  // 52-week range (important for positioning)
  if (md.price?.week52_high && md.price?.week52_low &&
      md.price.week52_high > md.price.week52_low) {
    checks.push(2);
  } else {
    missing.push("52-week range");
  }

  // Valuation metrics (important for strategic)
  const hasValuation = md.valuation?.trailingPE || md.valuation?.priceToBook || md.valuation?.dividendYield;
  if (hasValuation) {
    checks.push(1);
  } else {
    missing.push("valuation metrics");
  }

  // Data source quality
  if (md.completeness === "full" || md.completeness === "A") {
    checks.push(1);
  } else if (md.completeness === "partial" || md.completeness === "B") {
    checks.push(0.5);
  }

  const totalWeight = checks.reduce((a, b) => a + b, 0);
  const maxWeight = 3 + 2 + 2 + 2 + 1 + 1; // 11

  const confidenceScore = +(totalWeight / maxWeight * 100).toFixed(0);

  const level = confidenceScore >= 75 ? "high" :
                confidenceScore >= 45 ? "medium" : "low";

  return { level, score: confidenceScore, missing };
}
