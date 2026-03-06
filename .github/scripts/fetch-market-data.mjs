#!/usr/bin/env node
// fetch-market-data.mjs — Gathers raw market data from Yahoo Finance for all 11 holdings.
// Runs BEFORE generate-signals.mjs. Outputs /tmp/market-data.json.
// This eliminates web search from Claude calls, cutting token usage ~90%.

import { writeFileSync } from "fs";
import yahooFinance from "yahoo-finance2";

// Suppress yahoo-finance2 deprecation notices
yahooFinance.suppressNotices(["yahooSurvey"]);

const SYMBOLS = [
  { symbol: "MOS",   yahoo: "MOS",   type: "equity" },
  { symbol: "ASML",  yahoo: "ASML",  type: "equity" },
  { symbol: "SMH",   yahoo: "SMH",   type: "etf" },
  { symbol: "ENB",   yahoo: "ENB",   type: "equity" },
  { symbol: "ETHA",  yahoo: "ETHA",  type: "etf" },
  { symbol: "GLD",   yahoo: "GLD",   type: "etf" },
  { symbol: "IBIT",  yahoo: "IBIT",  type: "etf" },
  { symbol: "KOF",   yahoo: "KOF",   type: "equity" },
  { symbol: "PBR-A", yahoo: "PBR-A", type: "equity", display: "PBR.A" },
  { symbol: "AMKBY", yahoo: "AMKBY", type: "equity" },
  { symbol: "SPY",   yahoo: "SPY",   type: "etf" },
];

// ─── RSI CALCULATION ─────────────────────────────────────────────────────────
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
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// ─── SIMPLE MOVING AVERAGE ───────────────────────────────────────────────────
function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return +(slice.reduce((a, b) => a + b, 0) / period).toFixed(2);
}

// ─── FETCH ONE SYMBOL ────────────────────────────────────────────────────────
async function fetchOne(sym) {
  const ticker = sym.yahoo;
  const displaySymbol = sym.display || sym.symbol;
  console.log(`  Fetching ${displaySymbol}...`);

  try {
    // Get quote data (price, change, 52w range, volume, key stats)
    const quote = await yahooFinance.quote(ticker);

    // Get 200 days of historical data for RSI + MAs
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 300); // extra buffer for 200-day MA

    const history = await yahooFinance.chart(ticker, {
      period1: startDate,
      period2: endDate,
      interval: "1d",
    });

    const closes = (history.quotes || [])
      .filter(q => q.close != null)
      .map(q => q.close);

    // Compute technicals
    const rsi14 = computeRSI(closes);
    const sma50 = computeSMA(closes, 50);
    const sma200 = computeSMA(closes, 200);

    // Determine MA signal
    let maSignal = "unknown";
    if (sma50 && sma200 && quote.regularMarketPrice) {
      const price = quote.regularMarketPrice;
      if (price > sma50 && price > sma200 && sma50 > sma200) maSignal = "above_both_golden";
      else if (price > sma50 && price > sma200) maSignal = "above_both";
      else if (price > sma50) maSignal = "above_50_below_200";
      else if (price > sma200) maSignal = "above_200_below_50";
      else if (sma50 < sma200) maSignal = "below_both_death";
      else maSignal = "below_both";
    }

    // 52-week position
    const price = quote.regularMarketPrice;
    const w52High = quote.fiftyTwoWeekHigh;
    const w52Low = quote.fiftyTwoWeekLow;
    const w52Pct = (w52High && w52Low) ? +((price - w52Low) / (w52High - w52Low) * 100).toFixed(1) : null;

    // Key valuation metrics (varies by type)
    const valuation = {};
    if (sym.type === "equity") {
      valuation.trailingPE = quote.trailingPE ?? null;
      valuation.forwardPE = quote.forwardPE ?? null;
      valuation.priceToBook = quote.priceToBook ?? null;
      valuation.dividendYield = quote.dividendYield ? +(quote.dividendYield * 100).toFixed(2) : null;
      valuation.marketCap = quote.marketCap ?? null;
    } else {
      // ETFs
      valuation.dividendYield = quote.dividendYield ? +(quote.dividendYield * 100).toFixed(2) : null;
      valuation.ytdReturn = quote.ytdReturn ? +(quote.ytdReturn * 100).toFixed(2) : null;
    }

    // Volume analysis
    const avgVolume = quote.averageDailyVolume3Month ?? quote.averageDailyVolume10Day;
    const todayVolume = quote.regularMarketVolume;
    const volumeRatio = (avgVolume && todayVolume) ? +(todayVolume / avgVolume).toFixed(2) : null;

    const result = {
      symbol: displaySymbol,
      price: {
        current: price,
        change_pct: quote.regularMarketChangePercent ? +quote.regularMarketChangePercent.toFixed(2) : 0,
        previous_close: quote.regularMarketPreviousClose ?? null,
        week52_high: w52High,
        week52_low: w52Low,
        week52_position_pct: w52Pct,
      },
      technicals: {
        rsi14,
        sma50,
        sma200,
        ma_signal: maSignal,
      },
      valuation,
      volume: {
        today: todayVolume,
        avg_3mo: avgVolume,
        ratio: volumeRatio,
      },
      type: sym.type,
    };

    console.log(`  ✓ ${displaySymbol}: $${price?.toFixed(2)} | RSI:${rsi14} | MA:${maSignal} | 52w:${w52Pct}%`);
    return result;
  } catch (e) {
    console.error(`  ✗ ${displaySymbol}: ${e.message}`);
    return { symbol: displaySymbol, error: e.message };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Market Data Pre-Fetch");
  console.log("=====================");
  console.log(`Date: ${new Date().toISOString()}\n`);

  const results = {};
  for (const sym of SYMBOLS) {
    results[sym.display || sym.symbol] = await fetchOne(sym);
    // Small delay to be polite to Yahoo
    await new Promise(r => setTimeout(r, 500));
  }

  const successCount = Object.values(results).filter(r => !r.error).length;
  console.log(`\n✓ Fetched ${successCount}/${SYMBOLS.length} symbols`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(results, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
