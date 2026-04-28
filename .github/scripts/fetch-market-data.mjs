#!/usr/bin/env node
// fetch-market-data.mjs v4.9 — Finnhub (quotes) + TwelveData (technicals) + FRED (macro) + NY Fed (GSCPI)
// No npm dependencies beyond xlsx (for GSCPI parsing). Direct fetch() calls only.
// v4.1: RSP/SPY breadth data fetch for SPY positional layer
// v4.2: GSCPI (NY Fed Global Supply Chain Pressure Index) for AMKBY strategic layer
// v4.3: ETHA/IBIT alt-season ratio for ETHA positional layer
// v4.4: MXN/USD (FRED DEXMXUS) for KOF FX regime scoring
// v4.5: COPX auxiliary quote for GLNCY copper regime scoring
// v4.6: WTI crude (DCOILWTICO) + BRL/USD (DEXBZUS) for PBR.A oil/FX regime
// v4.7: CORN auxiliary quote for MOS agricultural demand regime
// v4.8: MU auxiliary quote for SMH DRAM cycle regime
// v4.9: LIN oligopoly_quality_compounder additions:
//       - APD + AIQUY (Air Liquide ADR) auxiliary quotes WITH metrics for peer P/E comparison
//       - peer_valuation (LIN P/E premium vs APD/AIQUY average)
//       - peer_relative (daily return spread LIN vs APD)
//       - fundamentals (ROI as ROCE proxy + operating margin) added per-symbol from
//         existing Finnhub metrics call (zero extra API cost)
//       - data.LIN.backlog loaded from data/lin-backlog.json (manually maintained quarterly)
//       - macro.dxy (renamed from dxy_proxy — cleaner score-engine consumption)
//       - macro.us_ism (FRED NAPM — US ISM Manufacturing PMI Composite) for LIN global PMI
//       - SMH/MU retired (replaced by LIN's peer infrastructure)

import { writeFileSync, readFileSync, existsSync } from "fs";

const FK      = process.env.FK;         // Finnhub
const TD_KEY  = process.env.TD_KEY;     // TwelveData
const FRED_KEY = process.env.FRED_KEY;  // FRED

if (!FK)       console.warn("⚠ Missing FK — quote data unavailable");
if (!TD_KEY)   console.warn("⚠ Missing TD_KEY — technicals unavailable");
if (!FRED_KEY) console.warn("⚠ Missing FRED_KEY — macro data unavailable");

const SYMBOLS = [
  { symbol: "MOS",   finnhub: "MOS",   td: "MOS" },
  { symbol: "ASML",  finnhub: "ASML",  td: "ASML" },
  { symbol: "LIN",   finnhub: "LIN",   td: "LIN" },
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
// needsMetrics: true → also fetch /stock/metric for P/E (used by LIN peer valuation).
const AUX_SYMBOLS = [
  { symbol: "RSP",   finnhub: "RSP",   purpose: "spy_breadth" },
  { symbol: "COPX",  finnhub: "COPX",  purpose: "glncy_copper" },
  { symbol: "CORN",  finnhub: "CORN",  purpose: "mos_ag_demand" },
  { symbol: "APD",   finnhub: "APD",   purpose: "lin_peer", needsMetrics: true },  // Air Products
  { symbol: "AIQUY", finnhub: "AIQUY", purpose: "lin_peer", needsMetrics: true },  // Air Liquide ADR
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
// Plus we get basic financials from /stock/metric for PE, PB, div yield, 52w range, ROI, op margin.
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
      // ── NEW v4.9: fundamentals for LIN strategic layer (also collected for all symbols) ──
      // ROI is closest Finnhub proxy for ROCE (no direct ROCE field).
      roi: metrics["roiTTM"] ?? metrics["roiAnnual"] ?? null,
      operating_margin: metrics["operatingMarginTTM"] ?? metrics["operatingMarginAnnual"] ?? null,
    };

    const p = result[sym.symbol];
    console.log(`  [FH] ✓ ${sym.symbol}: $${p.price ?? "—"} (${p.change_pct >= 0 ? "+" : ""}${p.change_pct}%) 52w:${p.week52_position_pct ?? "—"}%`);

    await sleep(1100); // Finnhub free = 60/min, so ~1 call/sec is safe
  }

  return result;
}

// ─── STAGE 1b: AUXILIARY QUOTES ─────────────────────────────────────────────
// Quote-only by default. Symbols with needsMetrics: true also fetch P/E
// (used by LIN peer valuation — APD and AIQUY).
async function fetchAuxQuotes() {
  if (!FK) return {};
  const result = {};

  for (const sym of AUX_SYMBOLS) {
    const wantMetrics = sym.needsMetrics === true;
    console.log(`  [FH-AUX] ${sym.symbol} (${sym.purpose}): quote${wantMetrics ? " + metrics" : ""}...`);

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

      if (wantMetrics) {
        await sleep(1100);
        const m = await fetchJSON(
          `https://finnhub.io/api/v1/stock/metric?symbol=${sym.finnhub}&metric=all&token=${FK}`,
          `FH aux-metrics ${sym.symbol}`
        );
        const metrics = m?.metric || {};
        result[sym.symbol].pe = metrics["peBasicExclExtraTTM"] ?? metrics["peTTM"] ?? null;
      }

      const peStr = result[sym.symbol].pe ? ` PE=${result[sym.symbol].pe}x` : "";
      console.log(`  [FH-AUX] ✓ ${sym.symbol}: $${q.c} (${q.dp >= 0 ? "+" : ""}${q.dp?.toFixed(2)}%)${peStr}`);
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

      const closes = bars.map(b => b.c);
      const rsi = computeRSI(closes);
      const sma50 = computeSMA(closes, 50);
      const sma200 = computeSMA(closes, 200);

      if (!technicals[sym.symbol]) technicals[sym.symbol] = { rsi14: null, sma50: null, sma200: null, ma_signal: "unknown" };
      const t = technicals[sym.symbol];

      if (rsi != null) t.rsi14 = rsi;
      if (sma50 != null && t.sma50 == null) t.sma50 = sma50;
      if (sma200 != null && t.sma200 == null) t.sma200 = sma200;

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
    dxy:      "DTWEXBGS",      // Trade-weighted broad USD index (renamed from dxy_proxy in v4.9)
    us10y:    "DGS10",
    us2y:     "DGS2",
    tips10y:  "DFII10",
    fed_funds: "FEDFUNDS",
    vix:      "VIXCLS",
    hy_oas:   "BAMLH0A0HYM2",
    mxn_usd:  "DEXMXUS",
    wti:      "DCOILWTICO",
    brl_usd:  "DEXBZUS",
    us_ism:   "NAPM",          // NEW v4.9: ISM Manufacturing PMI Composite — for LIN global PMI
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

  console.log(`  [FRED] ✓ ${Object.keys(result).length} indicators: VIX=${result.vix ?? "—"}, 10Y=${result.us10y ?? "—"}, HY OAS=${result.hy_oas ?? "—"}, MXN=${result.mxn_usd ?? "—"}, WTI=${result.wti ?? "—"}, BRL=${result.brl_usd ?? "—"}, DXY=${result.dxy ?? "—"}, ISM=${result.us_ism ?? "—"}`);
  return result;
}

// ─── STAGE 3b: NY FED GSCPI (Global Supply Chain Pressure Index) ────────────
// Monthly composite for AMKBY positional + strategic layers.
async function fetchGSCPI() {
  console.log("  [GSCPI] Fetching NY Fed Global Supply Chain Pressure Index...");
  try {
    const resp = await fetch(
      "https://www.newyorkfed.org/medialibrary/research/interactives/gscpi/downloads/gscpi_data.xlsx"
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    if (!rows || rows.length === 0) throw new Error("Empty spreadsheet");

    const lastRow = rows[rows.length - 1];
    const keys = Object.keys(lastRow);
    const gscpiKey = keys.find(k => /gscpi/i.test(k)) || keys[keys.length - 1];
    const dateKey = keys.find(k => /date/i.test(k)) || keys[0];

    const value = parseFloat(lastRow[gscpiKey]);
    const dateRaw = lastRow[dateKey];

    if (isNaN(value)) throw new Error(`Could not parse GSCPI value from column "${gscpiKey}"`);

    let dateStr;
    if (typeof dateRaw === "number") {
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

// ─── STAGE 3c: LIN BACKLOG (cached JSON) ────────────────────────────────────
// LIN reports backlog (sale-of-gas + on-site project pipeline) quarterly in
// earnings releases — not available via any free API. Manually maintained at
// data/lin-backlog.json after each earnings call (4×/year). The file format:
//
//   {
//     "yoy_growth_pct": 7.2,
//     "last_reported_quarter": "Q3 2025",
//     "value_usd_billions": 8.5,
//     "report_date": "2025-10-30"
//   }
//
// If the file is missing or older than 100 days, we log a warning and pass
// through what we have. The score-engine handles missing backlog gracefully —
// LIN's positional layer will simply skip the backlog signal.
async function loadLINBacklog() {
  const path = "data/lin-backlog.json";
  console.log(`  [LIN-BACKLOG] Loading ${path}...`);

  if (!existsSync(path)) {
    console.log(`  [LIN-BACKLOG] ⚠ File not found — backlog signal will be unavailable`);
    console.log(`  [LIN-BACKLOG]   Create ${path} after each LIN earnings (quarterly).`);
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));

    if (data.report_date) {
      const ageDays = Math.round((Date.now() - new Date(data.report_date).getTime()) / 86400000);
      data.age_days = ageDays;
      if (ageDays > 100) {
        console.log(`  [LIN-BACKLOG] ⚠ STALE: ${ageDays} days since ${data.report_date} (max 100). Update after next earnings.`);
      }
    }

    console.log(`  [LIN-BACKLOG] ✓ ${data.yoy_growth_pct >= 0 ? "+" : ""}${data.yoy_growth_pct}% YoY (${data.last_reported_quarter}) — ${data.age_days ?? "?"} days old`);
    return data;
  } catch (e) {
    console.log(`  [LIN-BACKLOG] ✗ Failed to parse: ${e.message}`);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Market Data Pre-Fetch v4.9");
  console.log("==========================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`APIs: Finnhub=${!!FK} TwelveData=${!!TD_KEY} FRED=${!!FRED_KEY} Alpaca=${!!ALPACA_KEY}\n`);

  // Stage 1: Quotes (Finnhub — ~15s)
  console.log("─── STAGE 1: QUOTES (Finnhub) ───");
  const quotes = await fetchQuotes();

  // Stage 1b: Auxiliary quotes
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

  // Stage 3c: LIN backlog (cached JSON — manually maintained quarterly)
  console.log("\n─── STAGE 3c: LIN BACKLOG (cached) ───");
  const linBacklog = await loadLINBacklog();

  // ─── ASSEMBLE + VALIDATE ────────────────────────────────────────────────────
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

    // ── SMA check ──
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
    const insufficient = !hasPrice || (!w52Valid && !hasRSI) || (issues.length >= 4);
    if (insufficient) needsWebSearch.push(sym.symbol);

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
      // ── NEW v4.9: fundamentals (per-symbol, primarily for LIN strategic layer) ──
      // ROI is closest Finnhub proxy for ROCE — LIN's signature durability metric.
      // Other archetypes ignore this field; LIN's strategic block reads it.
      fundamentals: {
        roce_pct: q.roi ?? null,
        operating_margin_pct: q.operating_margin ?? null,
      },
      volume: {},
      type: sym.type || "equity",
    };
  }

  // ── Attach SPY breadth data from RSP auxiliary quote ────────────────────
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
        rsp_spy_spread_pp: spread,
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
        relative_spread_pp: spread,
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
        relative_spread_pp: spread,
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
        relative_spread_pp: spread,
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

  // ── NEW v4.9: Attach LIN peer valuation (vs APD + AIQUY) ──────────────
  // The cleanest valuation signal for LIN is the P/E premium vs APD/AI.PA.
  // Historical normal range: 5-15%. <5% = exceptional buy. >18% = trim.
  if (output.LIN) {
    const linPE = output.LIN.valuation?.trailingPE;
    const apdPE = auxQuotes.APD?.pe;
    const aiquyPE = auxQuotes.AIQUY?.pe;
    const peerPEs = [apdPE, aiquyPE].filter(p => p != null && p > 0);

    if (linPE && peerPEs.length > 0) {
      const peerAvg = peerPEs.reduce((a, b) => a + b, 0) / peerPEs.length;
      const premiumPct = +(((linPE - peerAvg) / peerAvg) * 100).toFixed(2);

      output.LIN.peer_valuation = {
        lin_pe: linPE,
        apd_pe: apdPE ?? null,
        ai_pa_pe: aiquyPE ?? null,  // key matches score-engine field expectation
        peer_avg_pe: +peerAvg.toFixed(2),
        premium_pct: premiumPct,
        peer_count: peerPEs.length,
      };

      const zone = premiumPct < 5 ? "TIGHT (BUY)" : premiumPct < 15 ? "DESERVED PREMIUM" : premiumPct < 18 ? "STRETCHED" : "RICH (TRIM)";
      console.log(`  LIN peer-valuation: LIN ${linPE}x | APD ${apdPE ?? "—"}x | AIQUY ${aiquyPE ?? "—"}x | peer avg ${peerAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !linPE ? "no LIN P/E" : "no peer P/E (APD/AIQUY unavailable)";
      console.log(`  LIN peer-valuation: skipped (${reason})`);
    }

    // ── LIN peer relative (daily return spread vs APD) ─────────────────
    const linChange = output.LIN.price?.change_pct;
    const apdChange = auxQuotes.APD?.change_pct;
    const apdPrice = auxQuotes.APD?.price;

    if (linChange != null && apdChange != null) {
      const spread = +(linChange - apdChange).toFixed(3);

      output.LIN.peer_relative = {
        lin_change_pct: linChange,
        apd_change_pct: apdChange,
        apd_price: apdPrice ?? null,
        relative_spread_pp: spread,
      };

      const peerStr = spread > 0.5 ? `LIN outperforming APD by ${spread}pp (quality premium extending)`
        : spread < -0.5 ? `APD outperforming LIN by ${(-spread).toFixed(2)}pp (LIN catch-up potential)`
        : "inline";
      console.log(`  LIN peer-relative: ${peerStr}`);
    } else {
      console.log(`  LIN peer-relative: skipped (no APD daily change)`);
    }

    // ── LIN backlog (from cached JSON) ─────────────────────────────────
    if (linBacklog) {
      output.LIN.backlog = {
        yoy_growth_pct: linBacklog.yoy_growth_pct ?? null,
        last_reported_quarter: linBacklog.last_reported_quarter ?? null,
        value_usd_billions: linBacklog.value_usd_billions ?? null,
        report_date: linBacklog.report_date ?? null,
        age_days: linBacklog.age_days ?? null,
        stale: (linBacklog.age_days ?? 0) > 100,
      };
      const staleFlag = output.LIN.backlog.stale ? " ⚠ STALE" : "";
      console.log(`  LIN backlog: ${linBacklog.yoy_growth_pct >= 0 ? "+" : ""}${linBacklog.yoy_growth_pct}% YoY (${linBacklog.last_reported_quarter})${staleFlag}`);
    } else {
      console.log(`  LIN backlog: unavailable — score-engine will skip backlog signal`);
    }

    // ── LIN fundamentals already attached via per-symbol roi/operating_margin ──
    const f = output.LIN.fundamentals;
    if (f.roce_pct != null || f.operating_margin_pct != null) {
      console.log(`  LIN fundamentals: ROCE(proxy/ROI)=${f.roce_pct ?? "—"}% | Op margin=${f.operating_margin_pct ?? "—"}%`);
    } else {
      console.log(`  LIN fundamentals: unavailable from Finnhub metrics`);
    }
  }

  output._macro = macro;
  output._meta = {
    needsWebSearch,
    timestamp: new Date().toISOString(),
    sources: { quotes: "finnhub", technicals: "twelvedata", macro: "fred", gscpi: "nyfed", aux: "finnhub", lin_backlog: "data/lin-backlog.json" },
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
  console.log(`  LIN peer P/E:   ${output.LIN?.peer_valuation ? `LIN ${output.LIN.peer_valuation.lin_pe}x vs ${output.LIN.peer_valuation.peer_count}-peer avg ${output.LIN.peer_valuation.peer_avg_pe}x = ${output.LIN.peer_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  LIN backlog:    ${output.LIN?.backlog ? `${output.LIN.backlog.yoy_growth_pct}% YoY (${output.LIN.backlog.last_reported_quarter})${output.LIN.backlog.stale ? " STALE" : ""}` : "unavailable"}`);
  console.log(`  Aux quotes:     ${Object.keys(auxQuotes).length} symbols (${Object.keys(auxQuotes).join(", ")})`);
  console.log(`═══════════════════════════════════`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(output, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
