#!/usr/bin/env node
// fetch-market-data.mjs v4.3 — Finnhub (quotes) + TwelveData (technicals) + FRED (macro) + NY Fed (GSCPI)
// No npm dependencies beyond xlsx (for GSCPI parsing). Direct fetch() calls only.
// v4.1: RSP/SPY breadth data fetch for SPY positional layer
// v4.2: GSCPI (NY Fed Global Supply Chain Pressure Index) for AMKBY strategic layer
// v4.3: ETHA/IBIT alt-season ratio for ETHA positional layer
// v4.4: MXN/USD (FRED DEXMXUS) for KOF FX regime scoring
// v4.5: COPX auxiliary quote for GLNCY copper regime scoring
// v4.6: WTI crude (DCOILWTICO) + BRL/USD (DEXBZUS) for PBR.A oil/FX regime
// v4.7: CORN auxiliary quote for MOS agricultural demand regime
// v4.8: MU auxiliary quote for SMH DRAM cycle regime

import { writeFileSync } from "fs";

const FK      = process.env.FK;         // Finnhub
const TD_KEY  = process.env.TD_KEY;     // TwelveData
const FRED_KEY = process.env.FRED_KEY;  // FRED

if (!FK)       console.warn("⚠ Missing FK — quote data unavailable");
if (!TD_KEY)   console.warn("⚠ Missing TD_KEY — technicals unavailable");
if (!FRED_KEY) console.warn("⚠ Missing FRED_KEY — macro data unavailable");

const SYMBOLS = [
  { symbol: "MOS",   finnhub: "MOS",   td: "MOS" },
  { symbol: "ASML",  finnhub: "ASML",  td: "ASML" },
  { symbol: "SMH",   finnhub: "SMH",   td: "SMH" },
  { symbol: "ENB",   finnhub: "ENB",   td: "ENB" },
  { symbol: "ETHA",  finnhub: "ETHA",  td: "ETHA" },
  { symbol: "GLNCY", finnhub: "GLNCY", td: "GLNCY" },
  { symbol: "IBIT",  finnhub: "IBIT",  td: "IBIT" },
  { symbol: "KOF",   finnhub: "KOF",   td: "KOF" },
  { symbol: "PBR.A", finnhub: "PBR-A", td: "PBR" },
  { symbol: "AMKBY", finnhub: "AMKBY", td: "AMKBY" },
  { symbol: "SPY",   finnhub: "SPY",   td: "SPY" },
];

// ── Auxiliary symbols (not scored, used as inputs to other holdings) ──
// RSP = Invesco S&P 500 Equal Weight ETF — used for SPY breadth measurement.
const AUX_SYMBOLS = [
  { symbol: "RSP", finnhub: "RSP", purpose: "spy_breadth" },
  { symbol: "COPX", finnhub: "COPX", purpose: "glncy_copper" },  // Global X Copper Miners ETF
  { symbol: "CORN", finnhub: "CORN", purpose: "mos_ag_demand" },  // Teucrium Corn Fund ETF
  { symbol: "MU", finnhub: "MU", purpose: "smh_dram_cycle" },     // Micron — DRAM cycle proxy
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ─── STAGE 1: FINNHUB QUOTES (60 calls/min — plenty for 11 symbols) ────────
// Each call returns: c (current), d (change $), dp (change %), h (high), l (low), o (open), pc (prev close)
// Plus we get basic financials from /stock/metric for PE, PB, div yield, 52w range
async function fetchQuotes() {
  if (!FK) return {};
  const result = {};

  for (const sym of SYMBOLS) {
    console.log(`  [FH] ${sym.symbol}: quote + metrics...`);

    const q = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${sym.finnhub}&token=${FK}`,
      `FH quote ${sym.symbol}`
    );

    const m = await fetchJSON(
      `https://finnhub.io/api/v1/stock/metric?symbol=${sym.finnhub}&metric=all&token=${FK}`,
      `FH metrics ${sym.symbol}`
    );

    const metrics = m?.metric || {};
    const price = q?.c ?? null;
    const w52h = metrics["52WeekHigh"] ?? null;
    const w52l = metrics["52WeekLow"] ?? null;

    result[sym.symbol] = {
      price: price,
      change_pct: q?.dp != null ? +q.dp.toFixed(2) : 0,
      change_dollar: q?.d ?? 0,
      open: q?.o ?? null,
      high: q?.h ?? null,
      low: q?.l ?? null,
      previous_close: q?.pc ?? null,
      week52_high: w52h,
      week52_low: w52l,
      week52_position_pct: (w52h && w52l && price)
        ? +((price - w52l) / (w52h - w52l) * 100).toFixed(1) : null,
      pe: metrics["peBasicExclExtraTTM"] ?? metrics["peTTM"] ?? null,
      pb: metrics["pbQuarterly"] ?? metrics["pbAnnual"] ?? null,
      dividend_yield: metrics["dividendYieldIndicatedAnnual"] ?? null,
      beta: metrics["beta"] ?? null,
      market_cap: metrics["marketCapitalization"] ?? null,
    };

    const p = result[sym.symbol];
    console.log(`  [FH] ✓ ${sym.symbol}: $${p.price ?? "—"} (${p.change_pct >= 0 ? "+" : ""}${p.change_pct}%) 52w:${p.week52_position_pct ?? "—"}%`);

    await sleep(1100); // Finnhub free = 60/min, so ~1 call/sec is safe
  }

  return result;
}

// ─── STAGE 1b: AUXILIARY QUOTES (RSP for SPY breadth) ───────────────────────
// Quote-only (no metrics needed). Used downstream as breadth indicator.
async function fetchAuxQuotes() {
  if (!FK) return {};
  const result = {};

  for (const sym of AUX_SYMBOLS) {
    console.log(`  [FH-AUX] ${sym.symbol} (${sym.purpose}): quote...`);

    const q = await fetchJSON(
      `https://finnhub.io/api/v1/quote?symbol=${sym.finnhub}&token=${FK}`,
      `FH aux ${sym.symbol}`
    );

    if (q?.c) {
      result[sym.symbol] = {
        price: q.c,
        change_pct: q.dp != null ? +q.dp.toFixed(2) : 0,
        previous_close: q.pc ?? null,
      };
      console.log(`  [FH-AUX] ✓ ${sym.symbol}: $${q.c} (${q.dp >= 0 ? "+" : ""}${q.dp?.toFixed(2)}%)`);
    } else {
      console.log(`  [FH-AUX] ✗ ${sym.symbol}: no quote returned`);
    }

    await sleep(1100);
  }

  return result;
}

// ─── STAGE 2: TWELVEDATA TECHNICALS ─────────────────────────────────────────
// Free tier: 8 calls/min. 3 calls per symbol (RSI + SMA50 + SMA200) = 33 total.
// Pacing: 8s between each set of 3, so ~8 calls/min.
async function fetchTechnicals(quotes) {
  if (!TD_KEY) return {};
  const result = {};

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    console.log(`  [TD] ${sym.symbol} (${i+1}/${SYMBOLS.length}): RSI + SMA...`);
    const t = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };

    // RSI(14)
    const rsiData = await fetchJSON(
      `https://api.twelvedata.com/rsi?symbol=${sym.td}&interval=1day&time_period=14&outputsize=1&apikey=${TD_KEY}`,
      `TD RSI ${sym.symbol}`
    );
    if (rsiData?.values?.[0]?.rsi) {
      t.rsi14 = +parseFloat(rsiData.values[0].rsi).toFixed(2);
    }

    await sleep(8000);

    // SMA(50)
    const sma50Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=50&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA50 ${sym.symbol}`
    );
    if (sma50Data?.values?.[0]?.sma) {
      t.sma50 = +parseFloat(sma50Data.values[0].sma).toFixed(2);
    }

    await sleep(8000);

    // SMA(200)
    const sma200Data = await fetchJSON(
      `https://api.twelvedata.com/sma?symbol=${sym.td}&interval=1day&time_period=200&outputsize=1&apikey=${TD_KEY}`,
      `TD SMA200 ${sym.symbol}`
    );
    if (sma200Data?.values?.[0]?.sma) {
      t.sma200 = +parseFloat(sma200Data.values[0].sma).toFixed(2);
    }

    // Compute MA signal using Finnhub price
    const price = quotes[sym.symbol]?.price;
    if (price && t.sma50 && t.sma200) {
      if (price > t.sma50 && price > t.sma200 && t.sma50 > t.sma200) t.ma_signal = "above_both_golden";
      else if (price > t.sma50 && price > t.sma200) t.ma_signal = "above_both";
      else if (price > t.sma50) t.ma_signal = "above_50_below_200";
      else if (price > t.sma200) t.ma_signal = "above_200_below_50";
      else if (t.sma50 < t.sma200) t.ma_signal = "below_both_death";
      else t.ma_signal = "below_both";
    }

    console.log(`  [TD] ✓ ${sym.symbol}: RSI=${t.rsi14 ?? "—"}, SMA50=${t.sma50 ?? "—"}, SMA200=${t.sma200 ?? "—"}, MA=${t.ma_signal}`);
    result[sym.symbol] = t;

    if (i < SYMBOLS.length - 1) await sleep(8000);
  }

  return result;
}

// ─── STAGE 2b: ALPACA CANDLE FALLBACK ────────────────────────────────────────
// For symbols TwelveData can't handle, get historical bars from Alpaca and compute locally.
// Alpaca covers ALL US-exchange-listed securities including ADRs.
const ALPACA_KEY    = process.env.ALPK;
const ALPACA_SECRET = process.env.ALPS;

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
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

function computeSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return +(slice.reduce((a, b) => a + b, 0) / period).toFixed(2);
}

async function fillTechnicalsFromAlpaca(technicals, quotes) {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA] No keys — skipping candle fallback");
    return;
  }

  const gaps = SYMBOLS.filter(s => technicals[s.symbol]?.rsi14 == null);
  if (gaps.length === 0) { console.log("  [ALPACA] No gaps — all symbols have RSI"); return; }

  console.log(`  [ALPACA] Filling ${gaps.length} gaps: ${gaps.map(s => s.symbol).join(", ")}`);

  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 365).toISOString().split("T")[0];

  for (const sym of gaps) {
    // Alpaca uses the base ticker without class suffix for some ADRs
    // PBR-A on Finnhub → PBR.A on Alpaca (they support dot notation)
    const alpacaSymbol = sym.symbol.replace(".", "/"); // PBR.A → PBR/A for Alpaca

    try {
      const resp = await fetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`,
        {
          headers: {
            "APCA-API-KEY-ID": ALPACA_KEY,
            "APCA-API-SECRET-KEY": ALPACA_SECRET,
          },
        }
      );

      if (!resp.ok) {
        console.log(`    ✗ ${sym.symbol}: Alpaca ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data = await resp.json();
      const bars = data.bars || [];

      if (bars.length < 15) {
        console.log(`    ✗ ${sym.symbol}: only ${bars.length} bars (need 15+)`);
        continue;
      }

      const closes = bars.map(b => b.c); // close prices, oldest first
      const rsi = computeRSI(closes);
      const sma50 = computeSMA(closes, 50);
      const sma200 = computeSMA(closes, 200);

      if (!technicals[sym.symbol]) technicals[sym.symbol] = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };
      const t = technicals[sym.symbol];

      if (rsi != null) t.rsi14 = rsi;
      if (sma50 != null && t.sma50 == null) t.sma50 = sma50;
      if (sma200 != null && t.sma200 == null) t.sma200 = sma200;

      // Recompute MA signal
      const price = quotes[sym.symbol]?.price;
      if (price && t.sma50 && t.sma200) {
        if (price > t.sma50 && price > t.sma200 && t.sma50 > t.sma200) t.ma_signal = "above_both_golden";
        else if (price > t.sma50 && price > t.sma200) t.ma_signal = "above_both";
        else if (price > t.sma50) t.ma_signal = "above_50_below_200";
        else if (price > t.sma200) t.ma_signal = "above_200_below_50";
        else if (t.sma50 < t.sma200) t.ma_signal = "below_both_death";
        else t.ma_signal = "below_both";
      }

      console.log(`    ✓ ${sym.symbol}: RSI=${t.rsi14 ?? "—"}, SMA50=${t.sma50 ?? "—"}, SMA200=${t.sma200 ?? "—"}, MA=${t.ma_signal} [${bars.length} bars]`);
    } catch (e) {
      console.log(`    ✗ ${sym.symbol}: ${e.message}`);
    }

    await sleep(500);
  }
}

// ─── STAGE 2c: ALPACA 52-WEEK FIX ───────────────────────────────────────────
// Finnhub's 52w data is wrong for ADRs. Compute actual 52w high/low from Alpaca bars.
async function fix52WeekFromAlpaca(quotes) {
  if (!ALPACA_KEY || !ALPACA_SECRET) { console.log("  [ALPACA] No keys — skipping 52w fix"); return; }

  const suspects = SYMBOLS.filter(sym => {
    const q = quotes[sym.symbol];
    if (!q?.price || !q.week52_high || !q.week52_low) return true;
    const pct = ((q.price - q.week52_low) / (q.week52_high - q.week52_low)) * 100;
    return pct < -10 || pct > 110 || q.week52_low <= 0;
  });

  if (suspects.length === 0) { console.log("  [ALPACA 52W] All 52w data looks valid"); return; }
  console.log(`  [ALPACA 52W] Fixing ${suspects.length} symbols: ${suspects.map(s => s.symbol).join(", ")}`);

  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 365).toISOString().split("T")[0];

  for (const sym of suspects) {
    try {
      const resp = await fetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`,
        { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } }
      );
      if (!resp.ok) { console.log(`    ✗ ${sym.symbol}: Alpaca ${resp.status}`); continue; }

      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 20) { console.log(`    ✗ ${sym.symbol}: only ${bars.length} bars`); continue; }

      const highs = bars.map(b => b.h);
      const lows = bars.map(b => b.l);
      const w52High = Math.max(...highs);
      const w52Low = Math.min(...lows);
      const price = quotes[sym.symbol]?.price;

      if (w52High > 0 && w52Low > 0 && price) {
        const pct = +((price - w52Low) / (w52High - w52Low) * 100).toFixed(1);
        quotes[sym.symbol].week52_high = +w52High.toFixed(2);
        quotes[sym.symbol].week52_low = +w52Low.toFixed(2);
        quotes[sym.symbol].week52_position_pct = pct;
        console.log(`    ✓ ${sym.symbol}: 52w H=$${w52High.toFixed(2)} L=$${w52Low.toFixed(2)} Position=${pct}% [${bars.length} bars]`);
      }
    } catch (e) {
      console.log(`    ✗ ${sym.symbol}: ${e.message}`);
    }
    await sleep(500);
  }
}

// ─── STAGE 3: FRED MACRO ────────────────────────────────────────────────────
async function fetchMacro() {
  if (!FRED_KEY) return {};
  console.log("  [FRED] Fetching macro indicators...");

  const series = {
    dxy_proxy: "DTWEXBGS",
    us10y: "DGS10",
    us2y: "DGS2",
    tips10y: "DFII10",
    fed_funds: "FEDFUNDS",
    vix: "VIXCLS",
    hy_oas: "BAMLH0A0HYM2",
    mxn_usd: "DEXMXUS",           // MXN/USD exchange rate — KOF primary FX signal
    wti: "DCOILWTICO",             // WTI crude oil — PBR.A primary commodity signal
    brl_usd: "DEXBZUS",           // BRL/USD exchange rate — PBR.A FX signal
  };

  const result = {};
  for (const [key, seriesId] of Object.entries(series)) {
    const data = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&api_key=${FRED_KEY}&file_type=json`,
      `FRED ${key}`
    );
    const obs = data?.observations?.find(o => o.value && o.value !== ".");
    if (obs) result[key] = +parseFloat(obs.value).toFixed(4);
    await sleep(200);
  }

  if (result.us10y != null && result.us2y != null) {
    result.spread_2s10s = +((result.us10y - result.us2y) * 100).toFixed(0);
  }

  console.log(`  [FRED] ✓ ${Object.keys(result).length} indicators: VIX=${result.vix ?? "—"}, 10Y=${result.us10y ?? "—"}, HY OAS=${result.hy_oas ?? "—"}, MXN=${result.mxn_usd ?? "—"}, WTI=${result.wti ?? "—"}, BRL=${result.brl_usd ?? "—"}`);
  return result;
}

// ─── STAGE 3b: NY FED GSCPI (Global Supply Chain Pressure Index) ────────────
// Monthly composite of BDI + Harpex (container shipping) + airfreight + PMI
// supply chain components. Free, no API key needed.
// Source: https://www.newyorkfed.org/research/policy/gscpi
//
// GSCPI interpretation:
//   0    = historical average
//   >0   = above-average supply chain pressure (disruptions, high freight rates)
//   <0   = below-average pressure (calm shipping, low freight rates)
//   >1.5 = stressed (2021-2022 crisis peaked at ~4.3)
//   <-1  = unusually calm
//
// Attached to _macro.gscpi and _macro.gscpi_date.
// Used by score-engine.mjs for AMKBY positional + strategic layers.
async function fetchGSCPI() {
  console.log("  [GSCPI] Fetching NY Fed Global Supply Chain Pressure Index...");
  try {
    const resp = await fetch(
      "https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx"
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());

    // Dynamic import — xlsx must be installed (package.json dependency)
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    if (!rows || rows.length === 0) throw new Error("Empty spreadsheet");

    // Find the latest row with a GSCPI value
    const lastRow = rows[rows.length - 1];
    const keys = Object.keys(lastRow);

    // Try to find the GSCPI column (flexible matching)
    const gscpiKey = keys.find(k => /gscpi/i.test(k)) || keys[keys.length - 1];
    const dateKey = keys.find(k => /date/i.test(k)) || keys[0];

    const value = parseFloat(lastRow[gscpiKey]);
    const dateRaw = lastRow[dateKey];

    if (isNaN(value)) throw new Error(`Could not parse GSCPI value from column "${gscpiKey}"`);

    // Format date (could be Excel serial number or string)
    let dateStr;
    if (typeof dateRaw === "number") {
      // Excel serial date → JS date
      const excelEpoch = new Date(1899, 11, 30);
      const jsDate = new Date(excelEpoch.getTime() + dateRaw * 86400000);
      dateStr = jsDate.toISOString().split("T")[0];
    } else {
      dateStr = String(dateRaw);
    }

    const rounded = +value.toFixed(2);
    const regime = rounded > 1.5 ? "STRESSED" :
      rounded > 0.5 ? "ELEVATED" :
      rounded > -0.5 ? "NORMAL" :
      rounded > -1 ? "CALM" : "VERY CALM";

    console.log(`  [GSCPI] ✓ Latest: ${rounded} (${dateStr}) — ${regime}`);
    return { gscpi: rounded, gscpi_date: dateStr };
  } catch (e) {
    console.log(`  [GSCPI] ✗ Failed: ${e.message} — continuing without GSCPI`);
    return {};
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Market Data Pre-Fetch v4.8");
  console.log("==========================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`APIs: Finnhub=${!!FK} TwelveData=${!!TD_KEY} FRED=${!!FRED_KEY} Alpaca=${!!ALPACA_KEY}\n`);

  // Stage 1: Quotes (Finnhub — ~15s)
  console.log("─── STAGE 1: QUOTES (Finnhub) ───");
  const quotes = await fetchQuotes();

  // Stage 1b: Auxiliary quotes (RSP for SPY breadth)
  console.log("\n─── STAGE 1b: AUXILIARY QUOTES (Finnhub) ───");
  const auxQuotes = await fetchAuxQuotes();

  // Stage 2: Technicals (TwelveData — ~5 min with rate limit pacing)
  console.log("\n─── STAGE 2: TECHNICALS (TwelveData) ───");
  const technicals = await fetchTechnicals(quotes);

  // Stage 2b: Fill gaps from Alpaca candles (for ADRs that TwelveData doesn't cover)
  console.log("\n─── STAGE 2b: ALPACA CANDLE FALLBACK ───");
  await fillTechnicalsFromAlpaca(technicals, quotes);

  // Stage 2c: Fix 52-week data from Alpaca (Finnhub gives garbage for ADRs)
  console.log("\n─── STAGE 2c: ALPACA 52-WEEK FIX ───");
  await fix52WeekFromAlpaca(quotes);

  // Stage 3: Macro (FRED — ~3s)
  console.log("\n─── STAGE 3: MACRO (FRED) ───");
  const macro = await fetchMacro();

  // Stage 3b: GSCPI (NY Fed — supply chain pressure for AMKBY)
  console.log("\n─── STAGE 3b: GSCPI (NY Fed) ───");
  const gscpiData = await fetchGSCPI();
  Object.assign(macro, gscpiData);

  // ─── ASSEMBLE + VALIDATE ────────────────────────────────────────────────────
  // Aggressive quality checks: bad data gets nulled out and symbol routed to web search.
  const output = {};
  const needsWebSearch = [];

  console.log("\n─── DATA QUALITY AUDIT ───");

  for (const sym of SYMBOLS) {
    const q = quotes[sym.symbol] || {};
    const t = technicals[sym.symbol] || {};
    const issues = [];

    // ── Price check ──
    const hasPrice = q.price != null && q.price > 0;
    if (!hasPrice) issues.push("NO PRICE");

    // ── 52-week validation ──
    // Finnhub returns garbage for ADRs (negative percentages, impossible ranges).
    let w52High = q.week52_high ?? null;
    let w52Low = q.week52_low ?? null;
    let w52Pct = null;
    let w52Valid = false;

    if (w52High && w52Low && hasPrice) {
      const rangePositive = w52Low > 0 && w52High > 0;
      const lowUnderHigh = w52Low < w52High;
      const priceReasonable = q.price >= w52Low * 0.85 && q.price <= w52High * 1.15;

      if (rangePositive && lowUnderHigh && priceReasonable) {
        w52Pct = +((q.price - w52Low) / (w52High - w52Low) * 100).toFixed(1);
        if (w52Pct >= -10 && w52Pct <= 110) {
          w52Valid = true;
        } else {
          issues.push(`52w%=${w52Pct} out of bounds`);
          w52High = null; w52Low = null; w52Pct = null;
        }
      } else {
        issues.push(`bad 52w: L=$${w52Low} H=$${w52High} P=$${q.price}`);
        w52High = null; w52Low = null;
      }
    } else if (hasPrice) {
      issues.push("no 52w data");
    }

    // ── RSI check ──
    const hasRSI = t.rsi14 != null && t.rsi14 >= 0 && t.rsi14 <= 100;
    if (!hasRSI) issues.push("no RSI");

    // ── SMA check ── (validate SMAs are in plausible range vs price)
    let sma50 = t.sma50, sma200 = t.sma200, maSignal = t.ma_signal;
    if (sma50 && hasPrice) {
      if (sma50 > q.price * 5 || sma50 < q.price * 0.1) {
        issues.push(`SMA50=$${sma50} vs price=$${q.price} suspicious`);
        sma50 = null; maSignal = "unknown";
      }
    }
    if (sma200 && hasPrice) {
      if (sma200 > q.price * 5 || sma200 < q.price * 0.1) {
        issues.push(`SMA200=$${sma200} vs price=$${q.price} suspicious`);
        sma200 = null; maSignal = "unknown";
      }
    }
    const hasSMA = sma50 != null || sma200 != null;
    if (!hasSMA) issues.push("no SMA");

    // ── Route decision ──
    // Web search if: no price, OR (bad 52w AND no RSI), OR no price AND no RSI
    const insufficient = !hasPrice || (!w52Valid && !hasRSI) || (issues.length >= 4);
    if (insufficient) needsWebSearch.push(sym.symbol);

    // Log
    const grade = issues.length === 0 ? "✓ FULL" : insufficient ? "✗ → WEB SEARCH" : `⚠ PARTIAL (${issues.length} issues)`;
    console.log(`  ${sym.symbol.padEnd(6)} ${grade}`);
    if (issues.length > 0) console.log(`         ${issues.join(" | ")}`);

    output[sym.symbol] = {
      symbol: sym.symbol,
      completeness: issues.length === 0 ? "full" : insufficient ? "insufficient" : "partial",
      issues,
      price: {
        current: hasPrice ? q.price : null,
        change_pct: q.change_pct ?? 0,
        previous_close: q.previous_close ?? null,
        week52_high: w52Valid ? w52High : null,
        week52_low: w52Valid ? w52Low : null,
        week52_position_pct: w52Valid ? w52Pct : null,
      },
      technicals: {
        rsi14: hasRSI ? t.rsi14 : null,
        sma50: sma50 ?? null,
        sma200: sma200 ?? null,
        ma_signal: maSignal ?? "unknown",
      },
      valuation: {
        trailingPE: q.pe ?? null,
        priceToBook: q.pb ?? null,
        dividendYield: q.dividend_yield ?? null,
        beta: q.beta ?? null,
        marketCap: q.market_cap ?? null,
      },
      volume: {},
      type: sym.type || "equity",
    };
  }

  // ── Attach SPY breadth data from RSP auxiliary quote ────────────────────
  // The score-engine's positional layer reads data.breadth.* for SPY.
  if (output.SPY && auxQuotes.RSP) {
    const spyPrice = output.SPY.price?.current;
    const spyChange = output.SPY.price?.change_pct;
    const rspPrice = auxQuotes.RSP.price;
    const rspChange = auxQuotes.RSP.change_pct;

    if (spyPrice && rspPrice) {
      const ratio = +(rspPrice / spyPrice).toFixed(6);
      const spread = (rspChange != null && spyChange != null)
        ? +(rspChange - spyChange).toFixed(3) : null;

      output.SPY.breadth = {
        rsp_price: rspPrice,
        rsp_change_pct: rspChange,
        spy_change_pct: spyChange,
        rsp_spy_ratio: ratio,
        rsp_spy_spread_pp: spread, // RSP return minus SPY return, in percentage points
      };

      const broadStr = spread == null ? "—"
        : spread > 0 ? `RSP outperforming by ${spread}pp (broad rally)`
        : spread < 0 ? `SPY outperforming by ${(-spread).toFixed(2)}pp (narrow rally)`
        : "inline";
      console.log(`  SPY breadth: RSP/SPY=${ratio} | ${broadStr}`);
    } else {
      console.log(`  SPY breadth: skipped (missing price data)`);
    }
  } else if (output.SPY) {
    console.log(`  SPY breadth: skipped (no RSP quote available)`);
  }

  // ── Attach ETHA/IBIT ratio for alt-season detection ────────────────────
  // When ETHA outperforms IBIT, capital is rotating down the risk curve ("alt season").
  // When IBIT outperforms ETHA, BTC dominance is rising (risk-off within crypto).
  // Same pattern as RSP/SPY breadth — computed from data we already have.
  if (output.ETHA && output.IBIT) {
    const ethaPrice = output.ETHA.price?.current;
    const ibitPrice = output.IBIT.price?.current;
    const ethaChange = output.ETHA.price?.change_pct;
    const ibitChange = output.IBIT.price?.change_pct;

    if (ethaPrice && ibitPrice) {
      const ratio = +(ethaPrice / ibitPrice).toFixed(6);
      const spread = (ethaChange != null && ibitChange != null)
        ? +(ethaChange - ibitChange).toFixed(3) : null;

      output.ETHA.alt_season = {
        etha_ibit_ratio: ratio,
        etha_change_pct: ethaChange,
        ibit_change_pct: ibitChange,
        relative_spread_pp: spread, // ETHA return minus IBIT return, in percentage points
      };

      const altStr = spread == null ? "—"
        : spread > 0.5 ? `ETHA outperforming IBIT by ${spread}pp (alt-season rotation)`
        : spread < -0.5 ? `IBIT outperforming ETHA by ${(-spread).toFixed(2)}pp (BTC dominance)`
        : "inline";
      console.log(`  ETHA alt-season: ETHA/IBIT=${ratio} | ${altStr}`);
    } else {
      console.log(`  ETHA alt-season: skipped (missing price data)`);
    }
  }

  // ── Attach GLNCY/COPX ratio for copper regime detection ────────────────
  // COPX (Global X Copper Miners ETF) proxies for the copper/base metals complex.
  // When GLNCY outperforms COPX, market is pricing in diversification + trading arm.
  // When COPX outperforms GLNCY, pure copper is leading and Glencore lagging.
  if (output.GLNCY && auxQuotes.COPX) {
    const glncyPrice = output.GLNCY.price?.current;
    const copxPrice = auxQuotes.COPX.price;
    const glncyChange = output.GLNCY.price?.change_pct;
    const copxChange = auxQuotes.COPX.change_pct;

    if (glncyPrice && copxPrice) {
      const ratio = +(glncyPrice / copxPrice).toFixed(6);
      const spread = (glncyChange != null && copxChange != null)
        ? +(glncyChange - copxChange).toFixed(3) : null;

      output.GLNCY.copper_regime = {
        glncy_copx_ratio: ratio,
        glncy_change_pct: glncyChange,
        copx_change_pct: copxChange,
        copx_price: copxPrice,
        relative_spread_pp: spread, // GLNCY return minus COPX return
      };

      const copperStr = spread == null ? "—"
        : spread > 0.5 ? `GLNCY outperforming COPX by ${spread}pp (diversification premium)`
        : spread < -0.5 ? `COPX outperforming GLNCY by ${(-spread).toFixed(2)}pp (pure copper leading)`
        : "inline";
      console.log(`  GLNCY copper: GLNCY/COPX=${ratio} | COPX $${copxPrice} (${copxChange >= 0 ? "+" : ""}${copxChange}%) | ${copperStr}`);
    } else {
      console.log(`  GLNCY copper: skipped (missing price data)`);
    }
  }

  // ── Attach MOS/CORN ratio for agricultural demand regime ───────────────
  // CORN (Teucrium Corn Fund ETF) proxies farmer economics.
  // When corn is rallying, farmers buy more fertilizer → MOS demand up.
  // When CORN outperforms MOS, agricultural demand is strong but MOS is lagging.
  if (output.MOS && auxQuotes.CORN) {
    const mosPrice = output.MOS.price?.current;
    const cornPrice = auxQuotes.CORN.price;
    const mosChange = output.MOS.price?.change_pct;
    const cornChange = auxQuotes.CORN.change_pct;

    if (mosPrice && cornPrice) {
      const ratio = +(mosPrice / cornPrice).toFixed(6);
      const spread = (mosChange != null && cornChange != null)
        ? +(mosChange - cornChange).toFixed(3) : null;

      output.MOS.ag_demand = {
        mos_corn_ratio: ratio,
        mos_change_pct: mosChange,
        corn_change_pct: cornChange,
        corn_price: cornPrice,
        relative_spread_pp: spread, // MOS return minus CORN return
      };

      const agStr = spread == null ? "—"
        : spread > 0.5 ? `MOS outperforming CORN by ${spread}pp (MOS running ahead)`
        : spread < -0.5 ? `CORN outperforming MOS by ${(-spread).toFixed(2)}pp (ag demand strong, MOS catch-up?)`
        : "inline";
      console.log(`  MOS ag-demand: MOS/CORN=${ratio} | CORN $${cornPrice} (${cornChange >= 0 ? "+" : ""}${cornChange}%) | ${agStr}`);
    } else {
      console.log(`  MOS ag-demand: skipped (missing price data)`);
    }
  }

  // ── Attach SMH/MU ratio for DRAM/memory cycle detection ────────────────
  // MU (Micron) is the purest DRAM proxy. When MU outperforms SMH, the
  // commodity memory cycle is leading (early/mid cycle). When SMH outperforms
  // MU, secular growth (AI/NVIDIA) is carrying the sector.
  if (output.SMH && auxQuotes.MU) {
    const smhPrice = output.SMH.price?.current;
    const muPrice = auxQuotes.MU.price;
    const smhChange = output.SMH.price?.change_pct;
    const muChange = auxQuotes.MU.change_pct;

    if (smhPrice && muPrice) {
      const ratio = +(smhPrice / muPrice).toFixed(6);
      const spread = (smhChange != null && muChange != null)
        ? +(smhChange - muChange).toFixed(3) : null;

      output.SMH.dram_cycle = {
        smh_mu_ratio: ratio,
        smh_change_pct: smhChange,
        mu_change_pct: muChange,
        mu_price: muPrice,
        relative_spread_pp: spread, // SMH return minus MU return
      };

      const dramStr = spread == null ? "—"
        : spread > 0.5 ? `SMH outperforming MU by ${spread}pp (secular/AI leading, DRAM lagging)`
        : spread < -0.5 ? `MU outperforming SMH by ${(-spread).toFixed(2)}pp (DRAM cycle recovery leading)`
        : "inline";
      console.log(`  SMH DRAM-cycle: SMH/MU=${ratio} | MU $${muPrice} (${muChange >= 0 ? "+" : ""}${muChange}%) | ${dramStr}`);
    } else {
      console.log(`  SMH DRAM-cycle: skipped (missing price data)`);
    }
  }

  output._macro = macro;
  output._meta = {
    needsWebSearch,
    timestamp: new Date().toISOString(),
    sources: { quotes: "finnhub", technicals: "twelvedata", macro: "fred", gscpi: "nyfed", aux: "finnhub" },
    aux_symbols: Object.keys(auxQuotes),
  };

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  const fullCount = SYMBOLS.filter(s => (output[s.symbol].issues || []).length === 0).length;
  const partialCount = SYMBOLS.filter(s => (output[s.symbol].issues || []).length > 0 && !needsWebSearch.includes(s.symbol)).length;

  console.log(`\n═══════════════════════════════════`);
  console.log(`  Full data:      ${fullCount}/${SYMBOLS.length}`);
  console.log(`  Partial (ok):   ${partialCount}/${SYMBOLS.length}`);
  console.log(`  → Web search:   ${needsWebSearch.length}/${SYMBOLS.length}`);
  if (needsWebSearch.length > 0) {
    console.log(`    Symbols: ${needsWebSearch.join(", ")}`);
  }
  console.log(`  Macro:          ${Object.keys(macro).length} indicators`);
  console.log(`  GSCPI:          ${macro.gscpi != null ? `${macro.gscpi} (${macro.gscpi_date})` : "unavailable"}`);
  console.log(`  ETHA/IBIT:      ${output.ETHA?.alt_season ? `ratio=${output.ETHA.alt_season.etha_ibit_ratio}, spread=${output.ETHA.alt_season.relative_spread_pp}pp` : "unavailable"}`);
  console.log(`  GLNCY/COPX:     ${output.GLNCY?.copper_regime ? `ratio=${output.GLNCY.copper_regime.glncy_copx_ratio}, COPX $${output.GLNCY.copper_regime.copx_price}` : "unavailable"}`);
  console.log(`  MOS/CORN:       ${output.MOS?.ag_demand ? `ratio=${output.MOS.ag_demand.mos_corn_ratio}, CORN $${output.MOS.ag_demand.corn_price}` : "unavailable"}`);
  console.log(`  SMH/MU:         ${output.SMH?.dram_cycle ? `ratio=${output.SMH.dram_cycle.smh_mu_ratio}, MU $${output.SMH.dram_cycle.mu_price}` : "unavailable"}`);
  console.log(`  Aux (breadth):  ${Object.keys(auxQuotes).length} symbols`);
  console.log(`═══════════════════════════════════`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(output, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
