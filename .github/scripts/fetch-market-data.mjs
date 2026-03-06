#!/usr/bin/env node
// fetch-market-data.mjs v3 — Uses FMP + TwelveData + CoinGecko + FRED
// No yahoo-finance2 dependency. Direct API calls only.

import { writeFileSync } from "fs";

// ─── API KEYS (from GitHub Secrets) ──────────────────────────────────────────
const FMP_KEY   = process.env.FMP_KEY;       // Financial Modeling Prep
const TD_KEY    = process.env.TD_KEY;        // TwelveData
const CG_KEY    = process.env.CG_KEY;        // CoinGecko
const FRED_KEY  = process.env.FRED_KEY;      // FRED

if (!FMP_KEY)  console.warn("⚠ Missing FMP_KEY — quote data will be limited");
if (!TD_KEY)   console.warn("⚠ Missing TD_KEY — technical indicators unavailable");

const SYMBOLS = [
  { symbol: "MOS",   fmp: "MOS",   td: "MOS",   type: "equity" },
  { symbol: "ASML",  fmp: "ASML",  td: "ASML",  type: "equity" },
  { symbol: "SMH",   fmp: "SMH",   td: "SMH",   type: "etf" },
  { symbol: "ENB",   fmp: "ENB",   td: "ENB",   type: "equity" },
  { symbol: "ETHA",  fmp: "ETHA",  td: "ETHA",  type: "etf" },
  { symbol: "GLD",   fmp: "GLD",   td: "GLD",   type: "etf" },
  { symbol: "IBIT",  fmp: "IBIT",  td: "IBIT",  type: "etf" },
  { symbol: "KOF",   fmp: "KOF",   td: "KOF",   type: "equity" },
  { symbol: "PBR.A", fmp: "PBR-A", td: "PBR-A", type: "equity" },
  { symbol: "AMKBY", fmp: "AMKBY", td: "AMKBY", type: "equity" },
  { symbol: "SPY",   fmp: "SPY",   td: "SPY",   type: "etf" },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── STAGE 1: FMP BATCH QUOTES ──────────────────────────────────────────────
// Gets: price, change%, 52w high/low, PE, EPS, market cap, volume, div yield
async function fetchFMPQuotes() {
  if (!FMP_KEY) return {};
  const tickers = SYMBOLS.map(s => s.fmp).join(",");
  console.log("  [FMP] Fetching batch quotes...");
  const data = await fetchJSON(
    `https://financialmodelingprep.com/api/v3/quote/${tickers}?apikey=${FMP_KEY}`,
    "FMP batch"
  );
  if (!data || !Array.isArray(data)) return {};

  const result = {};
  for (const q of data) {
    // Map FMP ticker back to our symbol
    const sym = SYMBOLS.find(s => s.fmp === q.symbol);
    if (!sym) continue;
    result[sym.symbol] = {
      price: q.price,
      change_pct: q.changesPercentage ? +q.changesPercentage.toFixed(2) : 0,
      previous_close: q.previousClose,
      week52_high: q.yearHigh,
      week52_low: q.yearLow,
      week52_position_pct: (q.yearHigh && q.yearLow && q.price)
        ? +((q.price - q.yearLow) / (q.yearHigh - q.yearLow) * 100).toFixed(1) : null,
      pe: q.pe,
      eps: q.eps,
      market_cap: q.marketCap,
      volume: q.volume,
      avg_volume: q.avgVolume,
      volume_ratio: (q.volume && q.avgVolume) ? +(q.volume / q.avgVolume).toFixed(2) : null,
      dividend_yield: q.dividendYield ? +q.dividendYield.toFixed(2) : null,
      name: q.name,
      exchange: q.exchange,
    };
  }
  console.log(`  [FMP] ✓ ${Object.keys(result).length} quotes loaded`);
  return result;
}

// ─── STAGE 2: TWELVEDATA TECHNICALS ─────────────────────────────────────────
// Gets: RSI(14), SMA(50), SMA(200) per symbol
async function fetchTechnicals() {
  if (!TD_KEY) return {};
  const result = {};

  for (const sym of SYMBOLS) {
    console.log(`  [TD] ${sym.symbol}: RSI + SMA...`);
    result[sym.symbol] = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };

    // RSI(14)
    const rsiData = await fetchJSON(
      `https://api.twelvedata.com/rsi?symbol=${sym.td}&interval=1day&time_period=14&outputsize=1&apikey=${TD_KEY}`,
      `TD RSI ${sym.symbol}`
    );
    if (rsiData?.values?.[0]?.rsi) {
      result[sym.symbol].rsi14 = +parseFloat(rsiData.values[0].rsi).toFixed(2);
    }

    await sleep(200); // pace requests

    // SMA(50)
    const sma50Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=50&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA50 ${sym.symbol}`
    );
    if (sma50Data?.values?.[0]?.sma) {
      result[sym.symbol].sma50 = +parseFloat(sma50Data.values[0].sma).toFixed(2);
    }

    await sleep(200);

    // SMA(200)
    const sma200Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=200&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA200 ${sym.symbol}`
    );
    if (sma200Data?.values?.[0]?.sma) {
      result[sym.symbol].sma200 = +parseFloat(sma200Data.values[0].sma).toFixed(2);
    }

    // Compute MA signal
    const t = result[sym.symbol];
    const fmpData = QUOTES[sym.symbol];
    const price = fmpData?.price;
    if (price && t.sma50 && t.sma200) {
      if (price > t.sma50 && price > t.sma200 && t.sma50 > t.sma200) t.ma_signal = "above_both_golden";
      else if (price > t.sma50 && price > t.sma200) t.ma_signal = "above_both";
      else if (price > t.sma50) t.ma_signal = "above_50_below_200";
      else if (price > t.sma200) t.ma_signal = "above_200_below_50";
      else if (t.sma50 < t.sma200) t.ma_signal = "below_both_death";
      else t.ma_signal = "below_both";
    }

    const rsiStr = t.rsi14 != null ? t.rsi14 : "—";
    const maStr = t.ma_signal;
    console.log(`  [TD] ✓ ${sym.symbol}: RSI=${rsiStr}, MA=${maStr}`);

    await sleep(300); // pace between symbols
  }

  return result;
}

// ─── STAGE 3: MACRO DATA (FRED) ─────────────────────────────────────────────
async function fetchMacro() {
  if (!FRED_KEY) return {};
  console.log("  [FRED] Fetching macro indicators...");

  const series = {
    dxy_proxy: "DTWEXBGS",      // Trade-weighted dollar
    us10y: "DGS10",              // 10-year yield
    us2y: "DGS2",                // 2-year yield
    tips10y: "DFII10",           // 10yr TIPS real yield
    fed_funds: "FEDFUNDS",       // Fed funds rate
    vix: "VIXCLS",               // VIX
    hy_oas: "BAMLH0A0HYM2",     // HY OAS spread
  };

  const result = {};
  for (const [key, seriesId] of Object.entries(series)) {
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=1&api_key=${FRED_KEY}&file_type=json`,
      `FRED ${key}`
    );
    if (data?.observations?.[0]?.value && data.observations[0].value !== ".") {
      result[key] = +parseFloat(data.observations[0].value).toFixed(4);
    }
    await sleep(100);
  }

  // Computed fields
  if (result.us10y != null && result.us2y != null) {
    result.spread_2s10s = +((result.us10y - result.us2y) * 100).toFixed(0); // bps
  }

  console.log(`  [FRED] ✓ ${Object.keys(result).length} indicators loaded`);
  return result;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
let QUOTES = {}; // module-level so technicals stage can reference prices

async function main() {
  console.log("Market Data Pre-Fetch v3");
  console.log("========================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`APIs: FMP=${!!FMP_KEY} TD=${!!TD_KEY} CG=${!!CG_KEY} FRED=${!!FRED_KEY}\n`);

  // Stage 1: Quotes
  QUOTES = await fetchFMPQuotes();

  // Stage 2: Technicals
  console.log("");
  const technicals = await fetchTechnicals();

  // Stage 3: Macro
  console.log("");
  const macro = await fetchMacro();

  // Assemble final output
  const output = {};
  for (const sym of SYMBOLS) {
    const q = QUOTES[sym.symbol] || {};
    const t = technicals[sym.symbol] || {};

    output[sym.symbol] = {
      symbol: sym.symbol,
      price: {
        current: q.price ?? null,
        change_pct: q.change_pct ?? 0,
        previous_close: q.previous_close ?? null,
        week52_high: q.week52_high ?? null,
        week52_low: q.week52_low ?? null,
        week52_position_pct: q.week52_position_pct ?? null,
      },
      technicals: {
        rsi14: t.rsi14 ?? null,
        sma50: t.sma50 ?? null,
        sma200: t.sma200 ?? null,
        ma_signal: t.ma_signal ?? "unknown",
      },
      valuation: {
        trailingPE: q.pe ?? null,
        eps: q.eps ?? null,
        dividendYield: q.dividend_yield ?? null,
        marketCap: q.market_cap ?? null,
      },
      volume: {
        today: q.volume ?? null,
        avg: q.avg_volume ?? null,
        ratio: q.volume_ratio ?? null,
      },
      type: sym.type,
    };
  }

  // Attach macro to output
  output._macro = macro;

  const successCount = Object.keys(output).filter(k => k !== "_macro" && output[k].price?.current != null).length;
  console.log(`\n✓ ${successCount}/${SYMBOLS.length} symbols with price data`);
  console.log(`✓ Macro indicators: ${Object.keys(macro).length}`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(output, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
