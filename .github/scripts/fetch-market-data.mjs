#!/usr/bin/env node
// fetch-market-data.mjs v4.15 — Finnhub (quotes) + TwelveData (technicals) + FRED (macro) + NY Fed (GSCPI) + Alpaca (bars)
//
// v4.15 (July 2026): ALPACA FEED FALLBACK — keys without a SIP data
// entitlement return 403 on every feed=sip bars request (observed in prod
// 2026-07-08: all Stage 2b/2c/3c–3i calls failed). All bars calls now route
// through alpacaBarsFetch(): try feed=sip first (better closes when
// entitled), and on 403 retry the identical URL with feed=iex (free tier).
// One extra request on the failure path only; the downgrade is logged once
// per run. Self-healing: restoring the SIP entitlement silently restores
// sip-quality data with no code change.
// No npm dependencies beyond xlsx (for GSCPI parsing). Direct fetch() calls only.
// v4.1: RSP/SPY breadth data fetch for SPY positional layer
// v4.2: GSCPI (NY Fed Global Supply Chain Pressure Index) for AMKBY strategic layer
// v4.3: ETHA/IBIT alt-season ratio for ETHA positional layer
// v4.4: MXN/USD (FRED DEXMXUS) for KOF FX regime scoring
// v4.5: COPX auxiliary quote for GLNCY copper regime scoring
// v4.6: WTI crude (DCOILWTICO) + BRL/USD (DEXBZUS) for PBR.A oil/FX regime
// v4.7: CORN auxiliary quote for MOS agricultural demand regime
// v4.8: MU auxiliary quote for SMH DRAM cycle regime
// v4.9: LIN oligopoly_quality_compounder additions (APD/AIQUY peers, BBB OAS, ISM, fundamentals)
// v4.10: LIN v3 deep-upgrade fields (BBB OAS delta, QUAL factor flow, tactical extras, H2 layer scaffolding)
// v4.11: MSFT ai_infra_quality_compounder additions (GOOGL/META/AAPL cohort, rotation pressure)
// v4.12: HOLDINGS SWAP — added LHX (defense_prime_backlog_compounder) and TMO (life_sciences_quality_compounder);
//        retired MOS (cyclical fertilizer) and SPY (broad market core).
// v4.13: HOLDINGS SWAP — sold ETHA (ETH spot ETF), bought NOW (ServiceNow / ai_workflow_quality_compounder).
//        Removals:
//          - ETHA removed from SYMBOLS
//          - ETHA/IBIT alt-season attachment block removed (was ETHA positional only)
//          - ETHA/IBIT summary line removed
//          NOTE: IBIT remains in SYMBOLS (still scored as a standalone holding).
//        Additions for NOW (analogous to MSFT cohort pattern + premium-SaaS multiple math):
//          - CRM, WDAY, ADBE aux quotes WITH metrics (enterprise SaaS cohort P/E)
//          - IGV aux quote (iShares Expanded Tech-Software — software sector factor proxy)
//          - cohort_valuation (NOW vs CRM/WDAY/ADBE avg trailing P/E)
//            ★ NOTE: NOW carries 80-120% premium to CRM/WDAY/ADBE as the BASELINE
//              (higher growth + higher quality). Premium <60% = unusual discount = buy;
//              >150% = stretched. Direction of change > absolute level.
//          - cohort_relative (rotation_pressure_pp = NOW 30d − cohort avg 30d;
//            rotation_active = TRUE if < -5pp — capital rotating to higher-beta AI/SaaS
//            names = historically a buy setup, not a warning)
//          - factor_flow.igv_vs_spy_30d_pp (software sector bid signal — IGV outperforming
//            SPY by >1pp/30d = SaaS factor bid active)
//          - fundamentals v1 explicit-null fields: crpo_growth_pct, subscription_growth_pct,
//            op_margin_pct, fcf_margin_pct, large_deals_growth_pct, federal_growth_pct,
//            eps_revisions_30d_pct, eps_revisions_90d_pct, ev_sales_current,
//            now_assist_traction, ai_agent_platform_status
//          - New fetchNOWHistoricalReturns() (6 Alpaca calls: NOW, CRM, WDAY, ADBE, IGV, SPY)
// v4.14: HOLDINGS ADD — MA (payments_network_quality_compounder) and
//        ISRG (surgical_robotics_moat_compounder). 12 → 14 scored holdings.
//        Additions for MA (twin/duopoly pattern — V is the ONLY comparator):
//          - V aux quote WITH metrics (duopoly twin trailing P/E)
//          - twin_valuation (MA vs V trailing P/E premium)
//            ★ NOTE: MA normally carries a 10-20% premium to V (faster grower).
//              Premium <5% = compressed = buy; >25% = rich. Direction > level.
//          - twin_relative (daily MA−V return spread) + duopoly_relative
//            (30d: twin_spread_pp, dislocation flag, MA+V avg vs SPY →
//            disruption_fear_regime categorical — the V8.1 weight-gate input)
//          - fundamentals v1 explicit-null fields: cross_border_growth_pct (THE
//            ops metric), gdv_growth_pct, switched_txn_growth_pct, vas fields,
//            rebates_incentives_trend, op_margin_pct, eps_revisions, buyback,
//            stablecoin/disruption/regulation categoricals
//          - New fetchMAHistoricalReturns() (3 Alpaca calls: MA, V, SPY)
//        Additions for ISRG (cohort pattern analogous to NOW premium-multiple math):
//          - MDT, SYK, BSX aux quotes WITH metrics (devices cohort P/E)
//          - IHI aux quote (iShares U.S. Medical Devices — devices factor proxy;
//            the V8.1 weight-gate input for ISRG)
//          - cohort_valuation (ISRG vs MDT/SYK/BSX avg trailing P/E)
//            ★ NOTE: ISRG carries 60-120% premium to the cohort as the BASELINE
//              (category king, ~86% recurring annuity). Premium <60% = unusual
//              discount = buy; >150% = stretched. Absolute PE is never the signal.
//          - cohort_relative (cohort_rotation_pp = ISRG 30d − cohort avg 30d;
//            rotation_active = TRUE if < -6pp — fear rotation without procedure
//            evidence = historically a buy setup, not a warning)
//          - factor_flow.ihi_vs_spy_30d_pp (devices sector bid signal)
//          - fundamentals v1 explicit-null fields: procedure_growth_pct (THE ops
//            metric) + guide range, dv_placements/dv5_mix, ion fields, recurring
//            %, I&A growth, installed base, op_margin_pct, eps_revisions,
//            moat_status / instrument_transition_status categoricals
//          - New fetchISRGHistoricalReturns() (6 Alpaca calls: ISRG, MDT, SYK, BSX, IHI, SPY)

import { writeFileSync } from "fs";

const FK      = process.env.FK;         // Finnhub
const TD_KEY  = process.env.TD_KEY;     // TwelveData
const FRED_KEY = process.env.FRED_KEY;  // FRED

if (!FK)       console.warn("⚠ Missing FK — quote data unavailable");
if (!TD_KEY)   console.warn("⚠ Missing TD_KEY — technicals unavailable");
if (!FRED_KEY) console.warn("⚠ Missing FRED_KEY — macro data unavailable");

const SYMBOLS = [
  { symbol: "LHX",   finnhub: "LHX",   td: "LHX" },
  { symbol: "ASML",  finnhub: "ASML",  td: "ASML" },
  { symbol: "LIN",   finnhub: "LIN",   td: "LIN" },
  { symbol: "MSFT",  finnhub: "MSFT",  td: "MSFT" },
  { symbol: "NOW",   finnhub: "NOW",   td: "NOW" },
  { symbol: "TMO",   finnhub: "TMO",   td: "TMO" },
  { symbol: "ENB",   finnhub: "ENB",   td: "ENB" },
  { symbol: "GLNCY", finnhub: "GLNCY", td: "GLNCY" },
  { symbol: "IBIT",  finnhub: "IBIT",  td: "IBIT" },
  { symbol: "KOF",   finnhub: "KOF",   td: "KOF" },
  { symbol: "PBR.A", finnhub: "PBR-A", td: "PBR" },
  { symbol: "AMKBY", finnhub: "AMKBY", td: "AMKBY" },
  { symbol: "MA",    finnhub: "MA",    td: "MA" },
  { symbol: "ISRG",  finnhub: "ISRG",  td: "ISRG" },
];

// ── Auxiliary symbols (not scored, used as inputs to other holdings) ──
// needsMetrics: true → also fetch /stock/metric for P/E (used by peer/cohort valuation).
const AUX_SYMBOLS = [
  { symbol: "COPX",  finnhub: "COPX",  purpose: "glncy_copper" },
  { symbol: "APD",   finnhub: "APD",   purpose: "lin_peer",          needsMetrics: true },  // Air Products
  { symbol: "AIQUY", finnhub: "AIQUY", purpose: "lin_peer",          needsMetrics: true },  // Air Liquide ADR
  { symbol: "GOOGL", finnhub: "GOOGL", purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort
  { symbol: "META",  finnhub: "META",  purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort
  { symbol: "AAPL",  finnhub: "AAPL",  purpose: "msft_cohort",       needsMetrics: true },  // MSFT mega-cap cohort
  { symbol: "LMT",   finnhub: "LMT",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "NOC",   finnhub: "NOC",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "RTX",   finnhub: "RTX",   purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "GD",    finnhub: "GD",    purpose: "lhx_cohort",        needsMetrics: true },  // Defense prime cohort
  { symbol: "ITA",   finnhub: "ITA",   purpose: "lhx_defense_factor" },                     // iShares Aero & Defense ETF
  { symbol: "XBI",   finnhub: "XBI",   purpose: "tmo_biotech" },                            // SPDR Biotech (funding proxy)
  { symbol: "DHR",   finnhub: "DHR",   purpose: "tmo_peer",          needsMetrics: true },  // Danaher (bioprocessing peer)
  { symbol: "CRM",   finnhub: "CRM",   purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Salesforce)
  { symbol: "WDAY",  finnhub: "WDAY",  purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Workday)
  { symbol: "ADBE",  finnhub: "ADBE",  purpose: "now_cohort",        needsMetrics: true },  // SaaS cohort (Adobe)
  { symbol: "IGV",   finnhub: "IGV",   purpose: "now_software_factor" },                    // iShares Expanded Tech-Software ETF
  { symbol: "V",     finnhub: "V",     purpose: "ma_twin",           needsMetrics: true },  // Visa — MA duopoly twin (the ONLY comparator)
  { symbol: "MDT",   finnhub: "MDT",   purpose: "isrg_cohort",       needsMetrics: true },  // Medtronic (Hugo) — devices cohort
  { symbol: "SYK",   finnhub: "SYK",   purpose: "isrg_cohort",       needsMetrics: true },  // Stryker — devices cohort
  { symbol: "BSX",   finnhub: "BSX",   purpose: "isrg_cohort",       needsMetrics: true },  // Boston Scientific — devices cohort
  { symbol: "IHI",   finnhub: "IHI",   purpose: "isrg_devices_factor" },                    // iShares U.S. Medical Devices ETF
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

// ─── STAGE 1: FINNHUB QUOTES (60 calls/min — plenty for 14 symbols) ────────
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
      // Fundamentals (used primarily by LIN/LHX/TMO/MSFT/NOW strategic layers).
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
// (used by LIN peer valuation, MSFT cohort valuation, LHX cohort valuation,
// TMO peer valuation, NOW cohort valuation).
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
// Free tier: 8 calls/min. 3 calls per symbol (RSI + SMA50 + SMA200) = 42 total.
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

// v4.15: sip → iex fallback (see header). All Alpaca bars calls go through here.
let alpacaIexNoticeShown = false;
async function alpacaBarsFetch(url) {
  const headers = { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET };
  let resp = await fetch(url, { headers });
  if (resp.status === 403 && url.includes("feed=sip")) {
    if (!alpacaIexNoticeShown) {
      console.log("    [ALPACA] 403 on feed=sip — retrying with feed=iex (key has no SIP entitlement).");
      alpacaIexNoticeShown = true;
    }
    resp = await fetch(url.replace("feed=sip", "feed=iex"), { headers });
  }
  return resp;
}

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
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`
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
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym.finnhub)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=300&adjustment=split&feed=sip`
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

// ─── STAGE 3c: ALPACA HISTORICAL RETURNS (LIN v3 tactical extras + factor flow) ──
// Pulls daily closes for LIN, SPY, QUAL and computes:
//   - SPY 10-trading-day return → tactical_extras.spy_10d_drawdown_pct (negative if drawdown)
//   - LIN 10d return - SPY 10d return → tactical_extras.lin_vs_spy_10d_pp
//   - QUAL 30d return - SPY 30d return → factor_flow.qual_vs_spy_30d_pp
// 60 calendar days back gives ~42 trading days, comfortably above the 30+ needed.
// Note: SPY is no longer a scored holding as of v4.12, but it remains the market
// benchmark for factor-flow spreads and is still fetched directly from Alpaca here.
async function fetchLINHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-LIN] No keys — skipping LIN historical returns");
    return null;
  }

  console.log("  [ALPACA-LIN] Fetching LIN/SPY/QUAL bars for v3 spreads...");
  const symbols = ["LIN", "SPY", "QUAL"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  // Return over the last N trading days
  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const linRet10 = retNDays(closes.LIN, 10);
  const spyRet10 = retNDays(closes.SPY, 10);
  const qualRet30 = retNDays(closes.QUAL, 30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const result = {
    spy_10d_drawdown_pct: spyRet10,
    lin_vs_spy_10d_pp: (linRet10 != null && spyRet10 != null) ? +(linRet10 - spyRet10).toFixed(3) : null,
    qual_vs_spy_30d_pp: (qualRet30 != null && spyRet30 != null) ? +(qualRet30 - spyRet30).toFixed(3) : null,
    // For console / debug:
    _debug: { linRet10, spyRet10, qualRet30, spyRet30 },
  };

  console.log(`  [ALPACA-LIN] ✓ SPY 10d=${spyRet10 != null ? (spyRet10 >= 0 ? "+" : "") + spyRet10 + "%" : "—"} | LIN-SPY 10d=${result.lin_vs_spy_10d_pp != null ? (result.lin_vs_spy_10d_pp >= 0 ? "+" : "") + result.lin_vs_spy_10d_pp + "pp" : "—"} | QUAL-SPY 30d=${result.qual_vs_spy_30d_pp != null ? (result.qual_vs_spy_30d_pp >= 0 ? "+" : "") + result.qual_vs_spy_30d_pp + "pp" : "—"}`);
  return result;
}

// ─── STAGE 3d: ALPACA HISTORICAL RETURNS (MSFT cohort rotation pressure) ─────
// Pulls daily closes for MSFT + cohort (GOOGL, META, AAPL) and computes:
//   - MSFT 30d return
//   - Cohort avg 30d return (avg of GOOGL/META/AAPL where available)
//   - rotation_pressure_pp = MSFT 30d - cohort avg 30d
//   - rotation_pressure_active = TRUE if rotation_pressure_pp < -5
// This is the SIGNATURE MSFT tactical setup — capital rotating away from the
// highest-quality AI infra name into higher-beta AI names (NVDA/PLTR/AMD)
// historically a buy setup, not a warning.
async function fetchMSFTHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-MSFT] No keys — skipping MSFT cohort returns");
    return null;
  }

  console.log("  [ALPACA-MSFT] Fetching MSFT/GOOGL/META/AAPL bars for cohort rotation...");
  const symbols = ["MSFT", "GOOGL", "META", "AAPL"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const msftRet30  = retNDays(closes.MSFT, 30);
  const googlRet30 = retNDays(closes.GOOGL, 30);
  const metaRet30  = retNDays(closes.META, 30);
  const aaplRet30  = retNDays(closes.AAPL, 30);

  const cohortRets = [googlRet30, metaRet30, aaplRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (msftRet30 != null && cohortAvg != null)
    ? +(msftRet30 - cohortAvg).toFixed(3)
    : null;

  const result = {
    msft_30d_return_pct:        msftRet30,
    googl_30d_return_pct:       googlRet30,
    meta_30d_return_pct:        metaRet30,
    aapl_30d_return_pct:        aaplRet30,
    cohort_avg_30d_return_pct:  cohortAvg,
    rotation_pressure_pp:       rotationPp,
    rotation_pressure_active:   rotationPp != null && rotationPp < -5,
    cohort_count:               cohortRets.length,
  };

  const activeStr = result.rotation_pressure_active ? " [ACTIVE — buy setup]" : "";
  console.log(`  [ALPACA-MSFT] ✓ MSFT 30d=${msftRet30 != null ? (msftRet30 >= 0 ? "+" : "") + msftRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr}`);
  return result;
}

// ─── STAGE 3e: ALPACA HISTORICAL RETURNS (LHX defense-cohort rotation + ITA factor) ──
// Pulls daily closes for LHX + cohort (LMT, NOC, RTX, GD) + ITA + SPY and computes:
//   - LHX 30d return
//   - Cohort avg 30d return (avg of LMT/NOC/RTX/GD where available)
//   - cohort_rotation_pp = LHX 30d - cohort avg 30d
//   - cohort_rotation_active = TRUE if cohort_rotation_pp < -5 (LHX lagging primes)
//   - ita_vs_spy_30d_pp = ITA 30d - SPY 30d (defense sector factor flow)
// LHX is the smallest of the Big 5 primes; rotation INTO larger primes (out of LHX)
// historically a setup, not a warning. ITA > SPY = defense bid active = positional positive.
async function fetchLHXHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-LHX] No keys — skipping LHX historical returns");
    return null;
  }

  console.log("  [ALPACA-LHX] Fetching LHX/LMT/NOC/RTX/GD/ITA/SPY bars for cohort rotation + defense factor...");
  const symbols = ["LHX", "LMT", "NOC", "RTX", "GD", "ITA", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const lhxRet30 = retNDays(closes.LHX, 30);
  const lmtRet30 = retNDays(closes.LMT, 30);
  const nocRet30 = retNDays(closes.NOC, 30);
  const rtxRet30 = retNDays(closes.RTX, 30);
  const gdRet30  = retNDays(closes.GD,  30);
  const itaRet30 = retNDays(closes.ITA, 30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const cohortRets = [lmtRet30, nocRet30, rtxRet30, gdRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (lhxRet30 != null && cohortAvg != null)
    ? +(lhxRet30 - cohortAvg).toFixed(3)
    : null;

  const itaVsSpyPp = (itaRet30 != null && spyRet30 != null)
    ? +(itaRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    lhx_30d_return_pct:        lhxRet30,
    lmt_30d_return_pct:        lmtRet30,
    noc_30d_return_pct:        nocRet30,
    rtx_30d_return_pct:        rtxRet30,
    gd_30d_return_pct:         gdRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_rotation_pp:        rotationPp,
    cohort_rotation_active:    rotationPp != null && rotationPp < -5,
    cohort_count:              cohortRets.length,
    ita_30d_return_pct:        itaRet30,
    spy_30d_return_pct:        spyRet30,
    ita_vs_spy_30d_pp:         itaVsSpyPp,
  };

  const activeStr = result.cohort_rotation_active ? " [ACTIVE — buy setup]" : "";
  const itaStr = itaVsSpyPp == null ? "—"
    : itaVsSpyPp > 1 ? `defense bid active (+${itaVsSpyPp}pp)`
    : itaVsSpyPp < -1 ? `defense lagging (${itaVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-LHX] ✓ LHX 30d=${lhxRet30 != null ? (lhxRet30 >= 0 ? "+" : "") + lhxRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | ITA-SPY 30d: ${itaStr}`);
  return result;
}

// ─── STAGE 3f: ALPACA HISTORICAL RETURNS (TMO biotech overlay + DHR peer) ────
// Pulls daily closes for TMO, XBI, DHR over a 150-day window (covers 90d return).
// Computes:
//   - TMO 30d return
//   - XBI 30d return + 90d return (biotech funding sentiment, leads TMO bookings 2-3Q)
//   - DHR 30d return (bioprocessing peer sympathy)
//   - tmo_vs_dhr_30d_pp = TMO 30d - DHR 30d (peer rotation read)
async function fetchTMOHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-TMO] No keys — skipping TMO historical returns");
    return null;
  }

  console.log("  [ALPACA-TMO] Fetching TMO/XBI/DHR bars (150d window for XBI 90d return)...");
  const symbols = ["TMO", "XBI", "DHR"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 150).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=150&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const tmoRet30 = retNDays(closes.TMO, 30);
  const xbiRet30 = retNDays(closes.XBI, 30);
  const xbiRet90 = retNDays(closes.XBI, 90);
  const dhrRet30 = retNDays(closes.DHR, 30);

  const tmoVsDhrPp = (tmoRet30 != null && dhrRet30 != null)
    ? +(tmoRet30 - dhrRet30).toFixed(3)
    : null;

  const result = {
    tmo_30d_return_pct: tmoRet30,
    xbi_30d_return_pct: xbiRet30,
    xbi_90d_return_pct: xbiRet90,
    dhr_30d_return_pct: dhrRet30,
    tmo_vs_dhr_30d_pp:  tmoVsDhrPp,
  };

  const xbi90Str = xbiRet90 == null ? "—"
    : xbiRet90 > 10 ? `biotech thawing (+${xbiRet90}%)`
    : xbiRet90 < -10 ? `funding frozen (${xbiRet90}%)`
    : `mixed (${xbiRet90 >= 0 ? "+" : ""}${xbiRet90}%)`;
  console.log(`  [ALPACA-TMO] ✓ TMO 30d=${tmoRet30 != null ? (tmoRet30 >= 0 ? "+" : "") + tmoRet30 + "%" : "—"} | XBI 30d=${xbiRet30 != null ? (xbiRet30 >= 0 ? "+" : "") + xbiRet30 + "%" : "—"} | XBI 90d: ${xbi90Str} | DHR 30d=${dhrRet30 != null ? (dhrRet30 >= 0 ? "+" : "") + dhrRet30 + "%" : "—"} | TMO-DHR Δ=${tmoVsDhrPp != null ? (tmoVsDhrPp >= 0 ? "+" : "") + tmoVsDhrPp + "pp" : "—"}`);
  return result;
}

// ─── STAGE 3g: ALPACA HISTORICAL RETURNS (NOW SaaS-cohort rotation + IGV factor) ──
// Pulls daily closes for NOW + cohort (CRM, WDAY, ADBE) + IGV + SPY and computes:
//   - NOW 30d return
//   - Cohort avg 30d return (avg of CRM/WDAY/ADBE where available)
//   - rotation_pressure_pp = NOW 30d - cohort avg 30d
//   - rotation_pressure_active = TRUE if rotation_pressure_pp < -5 (NOW lagging SaaS cohort)
//   - igv_vs_spy_30d_pp = IGV 30d - SPY 30d (software sector factor flow)
// NOW is the highest-quality enterprise-SaaS compounder; rotation INTO higher-beta
// AI/SaaS names (out of NOW) historically a buy setup, not a warning.
// IGV > SPY = software bid active = positional positive.
async function fetchNOWHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-NOW] No keys — skipping NOW historical returns");
    return null;
  }

  console.log("  [ALPACA-NOW] Fetching NOW/CRM/WDAY/ADBE/IGV/SPY bars for cohort rotation + software factor...");
  const symbols = ["NOW", "CRM", "WDAY", "ADBE", "IGV", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const nowRet30  = retNDays(closes.NOW,  30);
  const crmRet30  = retNDays(closes.CRM,  30);
  const wdayRet30 = retNDays(closes.WDAY, 30);
  const adbeRet30 = retNDays(closes.ADBE, 30);
  const igvRet30  = retNDays(closes.IGV,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const cohortRets = [crmRet30, wdayRet30, adbeRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (nowRet30 != null && cohortAvg != null)
    ? +(nowRet30 - cohortAvg).toFixed(3)
    : null;

  const igvVsSpyPp = (igvRet30 != null && spyRet30 != null)
    ? +(igvRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    now_30d_return_pct:        nowRet30,
    crm_30d_return_pct:        crmRet30,
    wday_30d_return_pct:       wdayRet30,
    adbe_30d_return_pct:       adbeRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    rotation_pressure_pp:      rotationPp,
    rotation_pressure_active:  rotationPp != null && rotationPp < -5,
    cohort_count:              cohortRets.length,
    igv_30d_return_pct:        igvRet30,
    spy_30d_return_pct:        spyRet30,
    igv_vs_spy_30d_pp:         igvVsSpyPp,
  };

  const activeStr = result.rotation_pressure_active ? " [ACTIVE — buy setup]" : "";
  const igvStr = igvVsSpyPp == null ? "—"
    : igvVsSpyPp > 1 ? `software bid active (+${igvVsSpyPp}pp)`
    : igvVsSpyPp < -1 ? `software lagging (${igvVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-NOW] ✓ NOW 30d=${nowRet30 != null ? (nowRet30 >= 0 ? "+" : "") + nowRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | IGV-SPY 30d: ${igvStr}`);
  return result;
}

// ─── STAGE 3h: MA TWIN/DUOPOLY HISTORICAL RETURNS (v4.14) ────────────────────
// Pulls daily closes for MA, V, SPY and computes:
//   • twin_spread_pp        = MA 30d − V 30d (twin dislocation read — duopoly
//                             twins rarely diverge; <-4pp without an MA-specific
//                             fundamental break = buy setup)
//   • duopoly_vs_spy_pp     = (MA+V avg 30d) − SPY 30d (disruption-fear gauge)
//   • disruption_fear_regime categorical — the V8.1 regime-gate input for MA:
//       acute <-8pp | elevated -8..-5pp | neutral -5..+3pp | absent >+3pp
async function fetchMAHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-MA] No keys — skipping MA historical returns");
    return null;
  }

  console.log("  [ALPACA-MA] Fetching MA/V/SPY bars for twin spread + duopoly fear regime...");
  const symbols = ["MA", "V", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const maRet30  = retNDays(closes.MA,  30);
  const vRet30   = retNDays(closes.V,   30);
  const spyRet30 = retNDays(closes.SPY, 30);

  const twinSpreadPp = (maRet30 != null && vRet30 != null)
    ? +(maRet30 - vRet30).toFixed(3)
    : null;

  const duopolyAvg = (maRet30 != null && vRet30 != null)
    ? +((maRet30 + vRet30) / 2).toFixed(3)
    : null;

  const duopolyVsSpyPp = (duopolyAvg != null && spyRet30 != null)
    ? +(duopolyAvg - spyRet30).toFixed(3)
    : null;

  const fearRegime = duopolyVsSpyPp == null ? null
    : duopolyVsSpyPp < -8 ? "acute"
    : duopolyVsSpyPp < -5 ? "elevated"
    : duopolyVsSpyPp <= 3 ? "neutral"
    : "absent";

  const result = {
    ma_30d_return_pct:          maRet30,
    v_30d_return_pct:           vRet30,
    spy_30d_return_pct:         spyRet30,
    twin_spread_pp:             twinSpreadPp,
    twin_dislocation_active:    twinSpreadPp != null && twinSpreadPp < -4,
    duopoly_avg_30d_return_pct: duopolyAvg,
    duopoly_vs_spy_pp:          duopolyVsSpyPp,
    disruption_fear_regime:     fearRegime,
  };

  const dislocStr = result.twin_dislocation_active ? " [DISLOCATION — buy setup]" : "";
  const regimeStr = fearRegime == null ? "—"
    : fearRegime === "acute" ? `ACUTE fear regime (${duopolyVsSpyPp}pp — buy setup)`
    : fearRegime === "elevated" ? `elevated fear (${duopolyVsSpyPp}pp)`
    : fearRegime === "absent" ? `fear absent (+${duopolyVsSpyPp}pp)`
    : "neutral";
  console.log(`  [ALPACA-MA] ✓ MA 30d=${maRet30 != null ? (maRet30 >= 0 ? "+" : "") + maRet30 + "%" : "—"} | V 30d=${vRet30 != null ? (vRet30 >= 0 ? "+" : "") + vRet30 + "%" : "—"} | twin Δ=${twinSpreadPp != null ? (twinSpreadPp >= 0 ? "+" : "") + twinSpreadPp + "pp" : "—"}${dislocStr} | duopoly-SPY: ${regimeStr}`);
  return result;
}

// ─── STAGE 3i: ISRG COHORT HISTORICAL RETURNS (v4.14) ────────────────────────
// Pulls daily closes for ISRG, MDT, SYK, BSX, IHI, SPY and computes:
//   • cohort_rotation_pp = ISRG 30d − MDT/SYK/BSX avg 30d (fear rotation read —
//     <-6pp without procedure-share evidence = historically a buy setup)
//   • ihi_vs_spy_30d_pp  = devices sector factor bid — the V8.1 regime-gate
//     input for ISRG (bid_active >+1pp | neutral ±1pp | bid_absent <-1pp)
async function fetchISRGHistoricalReturns() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [ALPACA-ISRG] No keys — skipping ISRG historical returns");
    return null;
  }

  console.log("  [ALPACA-ISRG] Fetching ISRG/MDT/SYK/BSX/IHI/SPY bars for cohort rotation + devices factor...");
  const symbols = ["ISRG", "MDT", "SYK", "BSX", "IHI", "SPY"];
  const closes = {};
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - 86400000 * 60).toISOString().split("T")[0];

  for (const sym of symbols) {
    try {
      const resp = await alpacaBarsFetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=split&feed=sip`
      );
      if (!resp.ok) { console.log(`    ✗ ${sym}: Alpaca ${resp.status}`); continue; }
      const data = await resp.json();
      const bars = data.bars || [];
      if (bars.length < 31) { console.log(`    ✗ ${sym}: only ${bars.length} bars (need 31+)`); continue; }
      closes[sym] = bars.map(b => b.c);
      console.log(`    ✓ ${sym}: ${bars.length} bars`);
    } catch (e) {
      console.log(`    ✗ ${sym}: ${e.message}`);
    }
    await sleep(500);
  }

  const retNDays = (arr, n) => {
    if (!arr || arr.length < n + 1) return null;
    const last = arr[arr.length - 1];
    const ago = arr[arr.length - 1 - n];
    if (!last || !ago) return null;
    return +(((last - ago) / ago) * 100).toFixed(3);
  };

  const isrgRet30 = retNDays(closes.ISRG, 30);
  const mdtRet30  = retNDays(closes.MDT,  30);
  const sykRet30  = retNDays(closes.SYK,  30);
  const bsxRet30  = retNDays(closes.BSX,  30);
  const ihiRet30  = retNDays(closes.IHI,  30);
  const spyRet30  = retNDays(closes.SPY,  30);

  const cohortRets = [mdtRet30, sykRet30, bsxRet30].filter(r => r != null);
  const cohortAvg = cohortRets.length > 0
    ? +(cohortRets.reduce((a, b) => a + b, 0) / cohortRets.length).toFixed(3)
    : null;

  const rotationPp = (isrgRet30 != null && cohortAvg != null)
    ? +(isrgRet30 - cohortAvg).toFixed(3)
    : null;

  const ihiVsSpyPp = (ihiRet30 != null && spyRet30 != null)
    ? +(ihiRet30 - spyRet30).toFixed(3)
    : null;

  const result = {
    isrg_30d_return_pct:       isrgRet30,
    mdt_30d_return_pct:        mdtRet30,
    syk_30d_return_pct:        sykRet30,
    bsx_30d_return_pct:        bsxRet30,
    cohort_avg_30d_return_pct: cohortAvg,
    cohort_rotation_pp:        rotationPp,
    cohort_rotation_active:    rotationPp != null && rotationPp < -6,
    cohort_count:              cohortRets.length,
    ihi_30d_return_pct:        ihiRet30,
    spy_30d_return_pct:        spyRet30,
    ihi_vs_spy_30d_pp:         ihiVsSpyPp,
  };

  const activeStr = result.cohort_rotation_active ? " [ACTIVE — buy setup]" : "";
  const ihiStr = ihiVsSpyPp == null ? "—"
    : ihiVsSpyPp > 1 ? `devices bid active (+${ihiVsSpyPp}pp)`
    : ihiVsSpyPp < -1 ? `devices lagging (${ihiVsSpyPp}pp)`
    : "inline";
  console.log(`  [ALPACA-ISRG] ✓ ISRG 30d=${isrgRet30 != null ? (isrgRet30 >= 0 ? "+" : "") + isrgRet30 + "%" : "—"} | cohort avg=${cohortAvg != null ? (cohortAvg >= 0 ? "+" : "") + cohortAvg + "%" : "—"} | rotation Δ=${rotationPp != null ? (rotationPp >= 0 ? "+" : "") + rotationPp + "pp" : "—"}${activeStr} | IHI-SPY 30d: ${ihiStr}`);
  return result;
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
    us_ism:   "NAPM",          // ISM Manufacturing PMI Composite — LIN global PMI
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

  // ── V3: BBB OAS (BAMLC0A4CBBB) + 1m delta — leads LIN backlog 6-12mo ──
  // FRED returns percent (e.g. 1.45 = 145 bps); we store in bps to match field name.
  // limit=25 gets ~22 trading days = ~1 calendar month for delta computation.
  const bbbHist = await fetchJSON(
    `https://api.stlouisfed.org/fred/series/observations?series_id=BAMLC0A4CBBB&sort_order=desc&limit=25&api_key=${FRED_KEY}&file_type=json`,
    `FRED bbb_oas history`
  );
  const bbbObs = (bbbHist?.observations || []).filter(o => o.value && o.value !== ".");
  if (bbbObs.length >= 1) {
    const latestBps = Math.round(parseFloat(bbbObs[0].value) * 100);
    result.bbb_oas_bps = latestBps;
    if (bbbObs.length >= 22) {
      const monthAgoBps = Math.round(parseFloat(bbbObs[21].value) * 100);
      result.bbb_oas_1m_change_bps = latestBps - monthAgoBps;
    } else {
      result.bbb_oas_1m_change_bps = null;
    }
  }
  await sleep(200);

  console.log(`  [FRED] ✓ ${Object.keys(result).length} indicators: VIX=${result.vix ?? "—"}, 10Y=${result.us10y ?? "—"}, HY OAS=${result.hy_oas ?? "—"}, BBB OAS=${result.bbb_oas_bps ?? "—"}bps (1m Δ ${result.bbb_oas_1m_change_bps != null ? (result.bbb_oas_1m_change_bps >= 0 ? "+" : "") + result.bbb_oas_1m_change_bps : "—"}bps), MXN=${result.mxn_usd ?? "—"}, WTI=${result.wti ?? "—"}, BRL=${result.brl_usd ?? "—"}, DXY=${result.dxy ?? "—"}, ISM=${result.us_ism ?? "—"}`);
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

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Market Data Pre-Fetch v4.14");
  console.log("===========================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`APIs: Finnhub=${!!FK} TwelveData=${!!TD_KEY} FRED=${!!FRED_KEY} Alpaca=${!!ALPACA_KEY}\n`);

  // Stage 1: Quotes (Finnhub — ~15s)
  console.log("─── STAGE 1: QUOTES (Finnhub) ───");
  const quotes = await fetchQuotes();

  // Stage 1b: Auxiliary quotes
  console.log("\n─── STAGE 1b: AUXILIARY QUOTES (Finnhub) ───");
  const auxQuotes = await fetchAuxQuotes();

  // Stage 2: Technicals (TwelveData — ~6 min with rate limit pacing)
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

  // Stage 3c: LIN historical returns (Alpaca — v3 tactical extras + factor flow)
  console.log("\n─── STAGE 3c: LIN HISTORICAL RETURNS (Alpaca) ───");
  const linHistReturns = await fetchLINHistoricalReturns();

  // Stage 3d: MSFT cohort historical returns (Alpaca — rotation pressure)
  console.log("\n─── STAGE 3d: MSFT COHORT HISTORICAL RETURNS (Alpaca) ───");
  const msftHistReturns = await fetchMSFTHistoricalReturns();

  // Stage 3e: LHX cohort historical returns (Alpaca — defense rotation + ITA factor)
  console.log("\n─── STAGE 3e: LHX COHORT HISTORICAL RETURNS (Alpaca) ───");
  const lhxHistReturns = await fetchLHXHistoricalReturns();

  // Stage 3f: TMO historical returns (Alpaca — biotech overlay + DHR peer)
  console.log("\n─── STAGE 3f: TMO HISTORICAL RETURNS (Alpaca) ───");
  const tmoHistReturns = await fetchTMOHistoricalReturns();

  // Stage 3g: NOW cohort historical returns (Alpaca — SaaS rotation + IGV factor)
  console.log("\n─── STAGE 3g: NOW COHORT HISTORICAL RETURNS (Alpaca) ───");
  const nowHistReturns = await fetchNOWHistoricalReturns();

  // Stage 3h: MA twin/duopoly historical returns (Alpaca — twin spread + fear regime)
  console.log("\n─── STAGE 3h: MA TWIN/DUOPOLY HISTORICAL RETURNS (Alpaca) ───");
  const maHistReturns = await fetchMAHistoricalReturns();

  // Stage 3i: ISRG cohort historical returns (Alpaca — devices rotation + IHI factor)
  console.log("\n─── STAGE 3i: ISRG COHORT HISTORICAL RETURNS (Alpaca) ───");
  const isrgHistReturns = await fetchISRGHistoricalReturns();

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
      // Fundamentals (per-symbol). ROI is closest Finnhub proxy for ROCE.
      // Score-engine branches that don't consume these ignore them.
      fundamentals: {
        roce_pct: q.roi ?? null,
        operating_margin_pct: q.operating_margin ?? null,
      },
      volume: {},
      type: sym.type || "equity",
    };
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

  // ── LIN peer valuation (vs APD + AIQUY) ───────────────────────────────
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
        ai_pa_pe: aiquyPE ?? null,
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

    const f = output.LIN.fundamentals;
    if (f.roce_pct != null || f.operating_margin_pct != null) {
      console.log(`  LIN fundamentals: ROCE(proxy/ROI)=${f.roce_pct ?? "—"}% | Op margin=${f.operating_margin_pct ?? "—"}%`);
    } else {
      console.log(`  LIN fundamentals: unavailable from Finnhub metrics`);
    }

    // ─── V3 LIN ATTACHMENTS ───────────────────────────────────────────────
    const aiquyChange = auxQuotes.AIQUY?.change_pct;
    const aiquyPrice = auxQuotes.AIQUY?.price;
    if (linChange != null && aiquyChange != null) {
      const spread = +(linChange - aiquyChange).toFixed(3);
      output.LIN.peer_relative_aipa = {
        lin_change_pct: linChange,
        aipa_change_pct: aiquyChange,
        aipa_price: aiquyPrice ?? null,
        relative_spread_pp: spread,
      };
      const dir = spread > 0.5 ? `LIN outperforming AI.PA by ${spread}pp`
        : spread < -0.5 ? `AI.PA outperforming LIN by ${(-spread).toFixed(2)}pp`
        : "inline";
      console.log(`  LIN peer-relative-aipa: ${dir}`);
    } else {
      console.log(`  LIN peer-relative-aipa: skipped (no AIQUY daily change)`);
    }

    output.LIN.tactical_extras = {
      iv_rv_ratio: null,
      spy_10d_drawdown_pct: linHistReturns?.spy_10d_drawdown_pct ?? null,
      lin_vs_spy_10d_pp:    linHistReturns?.lin_vs_spy_10d_pp ?? null,
    };

    output.LIN.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    output.LIN.fundamentals.asu_utilization_pct   = null;
    output.LIN.fundamentals.price_mix_ex_fx_pct   = null;
    output.LIN.fundamentals.eps_revisions_30d_pct = null;
    output.LIN.fundamentals.eps_revisions_90d_pct = null;

    if (output.LIN.peer_valuation) {
      output.LIN.peer_valuation.premium_6m_delta_pp = null;
    }

    output.LIN.h2_layer = {
      contracts_90d_usd_m: null,
      subsidy_regime:      null,
      lcoe_gap_usd_kg:     null,
      lcoe_gap_6m_delta:   null,
    };

    const v3Coverage = [
      output.LIN.peer_relative_aipa ? "AIPA" : null,
      output.LIN.tactical_extras?.spy_10d_drawdown_pct != null ? "tac" : null,
      output.LIN.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
      macro.bbb_oas_bps != null ? "BBB" : null,
    ].filter(Boolean);
    console.log(`  LIN v3 sourced: ${v3Coverage.length > 0 ? v3Coverage.join(", ") : "(none)"} | pending external data: ASU util, price/mix ex-FX, EPS revs, peer P/E 6m Δ, H2 layer`);
  }

  // ── MSFT cohort valuation (vs GOOGL + META + AAPL) ────────────────────
  if (output.MSFT) {
    const msftPE = output.MSFT.valuation?.trailingPE;
    const googlPE = auxQuotes.GOOGL?.pe;
    const metaPE = auxQuotes.META?.pe;
    const aaplPE = auxQuotes.AAPL?.pe;
    const cohortPEs = [googlPE, metaPE, aaplPE].filter(p => p != null && p > 0);

    if (msftPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((msftPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.MSFT.cohort_valuation = {
        msft_pe: msftPE,
        googl_pe: googlPE ?? null,
        meta_pe: metaPE ?? null,
        aapl_pe: aaplPE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < -8 ? "DISCOUNT (BUY)" : premiumPct < 0 ? "BELOW COHORT" : premiumPct < 5 ? "IN-LINE" : premiumPct < 15 ? "DESERVED PREMIUM" : "RICH (TRIM)";
      console.log(`  MSFT cohort-valuation: MSFT ${msftPE}x | GOOGL ${googlPE ?? "—"}x | META ${metaPE ?? "—"}x | AAPL ${aaplPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !msftPE ? "no MSFT P/E" : "no cohort P/E (GOOGL/META/AAPL unavailable)";
      console.log(`  MSFT cohort-valuation: skipped (${reason})`);
    }

    if (msftHistReturns) {
      output.MSFT.cohort_relative = {
        msft_30d_return_pct:        msftHistReturns.msft_30d_return_pct,
        googl_30d_return_pct:       msftHistReturns.googl_30d_return_pct,
        meta_30d_return_pct:        msftHistReturns.meta_30d_return_pct,
        aapl_30d_return_pct:        msftHistReturns.aapl_30d_return_pct,
        cohort_avg_30d_return_pct:  msftHistReturns.cohort_avg_30d_return_pct,
        rotation_pressure_pp:       msftHistReturns.rotation_pressure_pp,
        rotation_pressure_active:   msftHistReturns.rotation_pressure_active,
        cohort_count:               msftHistReturns.cohort_count,
      };

      const rp = msftHistReturns.rotation_pressure_pp;
      const rpStr = rp == null ? "—"
        : msftHistReturns.rotation_pressure_active ? `MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION PRESSURE ACTIVE — buy setup)`
        : rp < 0 ? `MSFT lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `MSFT leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  MSFT cohort-relative: ${rpStr}`);
    } else {
      console.log(`  MSFT cohort-relative: skipped (no historical returns)`);
    }

    output.MSFT.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    output.MSFT.fundamentals.azure_growth_cc_pct    = null;
    output.MSFT.fundamentals.capex_ttm_usd_b        = null;
    output.MSFT.fundamentals.fcf_margin_pct         = null;
    output.MSFT.fundamentals.eps_revisions_30d_pct  = null;
    output.MSFT.fundamentals.eps_revisions_90d_pct  = null;

    const msftCoverage = [
      output.MSFT.cohort_valuation ? "cohort-PE" : null,
      output.MSFT.cohort_relative?.rotation_pressure_pp != null ? "rotation" : null,
      output.MSFT.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  MSFT v1 sourced: ${msftCoverage.length > 0 ? msftCoverage.join(", ") : "(none)"} | pending external data: Azure CC growth, capex TTM, FCF margin, EPS revs, forward PE`);
  }

  // ── v4.12: LHX cohort valuation (vs LMT + NOC + RTX + GD) ─────────────
  // Defense-prime quality compounder, analogous to MSFT's mega-cap cohort pattern.
  // Trailing P/E here from Finnhub free tier; forward PE surfaced by LLM via web search.
  // LHX historically trades at -5 to -15% discount to LMT/NOC/RTX/GD avg —
  // cohort compression is the central re-rating thesis.
  if (output.LHX) {
    const lhxPE = output.LHX.valuation?.trailingPE;
    const lmtPE = auxQuotes.LMT?.pe;
    const nocPE = auxQuotes.NOC?.pe;
    const rtxPE = auxQuotes.RTX?.pe;
    const gdPE  = auxQuotes.GD?.pe;
    const cohortPEs = [lmtPE, nocPE, rtxPE, gdPE].filter(p => p != null && p > 0);

    if (lhxPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((lhxPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.LHX.cohort_valuation = {
        lhx_pe: lhxPE,
        lmt_pe: lmtPE ?? null,
        noc_pe: nocPE ?? null,
        rtx_pe: rtxPE ?? null,
        gd_pe:  gdPE  ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < -10 ? "WIDE DISCOUNT (BUY — above-norm)"
        : premiumPct < -5 ? "DISCOUNT (normal range)"
        : premiumPct < 0 ? "MILD DISCOUNT"
        : premiumPct < 5 ? "IN-LINE (rare for LHX)"
        : "PREMIUM (TRIM — rare)";
      console.log(`  LHX cohort-valuation: LHX ${lhxPE}x | LMT ${lmtPE ?? "—"}x | NOC ${nocPE ?? "—"}x | RTX ${rtxPE ?? "—"}x | GD ${gdPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !lhxPE ? "no LHX P/E" : "no cohort P/E (LMT/NOC/RTX/GD unavailable)";
      console.log(`  LHX cohort-valuation: skipped (${reason})`);
    }

    // ── LHX cohort-relative (rotation pressure: 30d return spread) ─────
    if (lhxHistReturns) {
      output.LHX.cohort_relative = {
        lhx_30d_return_pct:        lhxHistReturns.lhx_30d_return_pct,
        lmt_30d_return_pct:        lhxHistReturns.lmt_30d_return_pct,
        noc_30d_return_pct:        lhxHistReturns.noc_30d_return_pct,
        rtx_30d_return_pct:        lhxHistReturns.rtx_30d_return_pct,
        gd_30d_return_pct:         lhxHistReturns.gd_30d_return_pct,
        cohort_avg_30d_return_pct: lhxHistReturns.cohort_avg_30d_return_pct,
        cohort_rotation_pp:        lhxHistReturns.cohort_rotation_pp,
        cohort_rotation_active:    lhxHistReturns.cohort_rotation_active,
        cohort_count:              lhxHistReturns.cohort_count,
      };

      const rp = lhxHistReturns.cohort_rotation_pp;
      const rpStr = rp == null ? "—"
        : lhxHistReturns.cohort_rotation_active ? `LHX lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION ACTIVE — buy setup, capital flowing to larger primes)`
        : rp < 0 ? `LHX lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `LHX leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  LHX cohort-relative: ${rpStr}`);

      // factor_flow: ITA vs SPY 30d (defense sector bid)
      output.LHX.factor_flow = {
        ita_vs_spy_30d_pp: lhxHistReturns.ita_vs_spy_30d_pp,
        ita_30d_return_pct: lhxHistReturns.ita_30d_return_pct,
        spy_30d_return_pct: lhxHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  LHX cohort-relative: skipped (no historical returns)`);
      output.LHX.factor_flow = { ita_vs_spy_30d_pp: null, ita_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // LHX fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.LHX.fundamentals.book_to_bill           = null;  // earnings release / backlog disclosure
    output.LHX.fundamentals.backlog_growth_yoy_pct = null;  // earnings release / backlog disclosure
    output.LHX.fundamentals.op_margin_pct          = null;  // overrides the generic ROI/op-margin fields for LHX-specific scoring
    output.LHX.fundamentals.fcf_margin_pct         = null;  // 10-Q cash flow statement
    output.LHX.fundamentals.eps_revisions_30d_pct  = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.LHX.fundamentals.eps_revisions_90d_pct  = null;  // FactSet/Refinitiv consensus EPS delta 90d

    const lhxCoverage = [
      output.LHX.cohort_valuation ? "cohort-PE" : null,
      output.LHX.cohort_relative?.cohort_rotation_pp != null ? "rotation" : null,
      output.LHX.factor_flow?.ita_vs_spy_30d_pp != null ? "ITA" : null,
    ].filter(Boolean);
    console.log(`  LHX v1 sourced: ${lhxCoverage.length > 0 ? lhxCoverage.join(", ") : "(none)"} | pending external data: book-to-bill, backlog YoY, op margin, FCF margin, EPS revs, forward PE`);
  }

  // ── v4.12: TMO peer valuation + biotech overlay ─────────────────────
  // Life-sciences quality compounder, analogous to LIN's peer pattern (vs DHR)
  // overlaid with a biotech-funding sentiment proxy (XBI 30d/90d leads bookings 2-3Q).
  if (output.TMO) {
    const tmoPE = output.TMO.valuation?.trailingPE;
    const dhrPE = auxQuotes.DHR?.pe;

    if (tmoPE && dhrPE) {
      const premiumPct = +(((tmoPE - dhrPE) / dhrPE) * 100).toFixed(2);

      output.TMO.peer_valuation = {
        tmo_pe: tmoPE,
        dhr_pe: dhrPE,
        premium_pct: premiumPct,
      };

      const zone = premiumPct < -10 ? "DISCOUNT TO DHR (BUY)"
        : premiumPct < 0 ? "BELOW DHR"
        : premiumPct < 10 ? "IN-LINE WITH DHR"
        : "PREMIUM (TRIM)";
      console.log(`  TMO peer-valuation: TMO ${tmoPE}x | DHR ${dhrPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !tmoPE ? "no TMO P/E" : "no DHR P/E";
      console.log(`  TMO peer-valuation: skipped (${reason})`);
    }

    // ── TMO peer relative (daily return spread vs DHR) ──────────────
    const tmoChange = output.TMO.price?.change_pct;
    const dhrChange = auxQuotes.DHR?.change_pct;
    const dhrPrice = auxQuotes.DHR?.price;

    if (tmoChange != null && dhrChange != null) {
      const spread = +(tmoChange - dhrChange).toFixed(3);

      output.TMO.peer_relative = {
        tmo_change_pct: tmoChange,
        dhr_change_pct: dhrChange,
        dhr_price: dhrPrice ?? null,
        relative_spread_pp: spread,
      };

      const peerStr = spread > 0.5 ? `TMO outperforming DHR by ${spread}pp`
        : spread < -0.5 ? `DHR outperforming TMO by ${(-spread).toFixed(2)}pp (TMO catch-up potential)`
        : "inline";
      console.log(`  TMO peer-relative: ${peerStr}`);
    } else {
      console.log(`  TMO peer-relative: skipped (no DHR daily change)`);
    }

    // ── TMO biotech overlay (XBI 30d/90d + daily change) ────────────
    const xbiPrice = auxQuotes.XBI?.price;
    const xbiChange = auxQuotes.XBI?.change_pct;

    if (xbiPrice != null) {
      output.TMO.biotech_overlay = {
        xbi_price:          xbiPrice,
        xbi_change_pct:     xbiChange ?? null,
        xbi_30d_return_pct: tmoHistReturns?.xbi_30d_return_pct ?? null,
        xbi_90d_return_pct: tmoHistReturns?.xbi_90d_return_pct ?? null,
        // Sympathy detection: TMO and XBI both down meaningfully on the day
        // (score-engine uses this for tactical biotech-sympathy buy signal)
        sympathy_setup_active: (tmoChange != null && xbiChange != null && tmoChange < -1.5 && xbiChange < -1.5),
      };

      const fund = tmoHistReturns?.xbi_90d_return_pct;
      const fundStr = fund == null ? "—"
        : fund > 10 ? `funding thawing (+${fund}%)`
        : fund < -10 ? `funding frozen (${fund}%)`
        : `mixed (${fund >= 0 ? "+" : ""}${fund}%)`;
      console.log(`  TMO biotech-overlay: XBI $${xbiPrice} (${xbiChange >= 0 ? "+" : ""}${xbiChange}%) | 90d: ${fundStr}${output.TMO.biotech_overlay.sympathy_setup_active ? " | SYMPATHY SETUP ACTIVE" : ""}`);
    } else {
      console.log(`  TMO biotech-overlay: skipped (no XBI quote)`);
    }

    // ── TMO 30d return tactical extras + reused QUAL/SPY factor flow ──
    output.TMO.tactical_extras = {
      tmo_30d_return_pct: tmoHistReturns?.tmo_30d_return_pct ?? null,
      tmo_vs_dhr_30d_pp:  tmoHistReturns?.tmo_vs_dhr_30d_pp ?? null,
    };

    // factor_flow: QUAL vs SPY 30d — reused from LIN's fetch (market-wide quality bid)
    output.TMO.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    // TMO fundamentals — explicit nulls for fields needing earnings disclosure.
    output.TMO.fundamentals.organic_growth_pct      = null;  // earnings release (TMO segment)
    output.TMO.fundamentals.op_margin_pct           = null;  // overrides generic for TMO-specific scoring
    output.TMO.fundamentals.fcf_margin_pct          = null;  // 10-Q cash flow statement
    output.TMO.fundamentals.eps_revisions_30d_pct   = null;  // FactSet/Refinitiv 30d
    output.TMO.fundamentals.eps_revisions_90d_pct   = null;  // FactSet/Refinitiv 90d
    output.TMO.fundamentals.bioprocessing_phase     = null;  // categorical: destocking/bottoming/early_recovery/expansion/peak (LLM)

    const tmoCoverage = [
      output.TMO.peer_valuation ? "peer-PE" : null,
      output.TMO.biotech_overlay?.xbi_90d_return_pct != null ? "XBI-90d" : null,
      output.TMO.tactical_extras?.tmo_vs_dhr_30d_pp != null ? "DHR-30d" : null,
      output.TMO.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  TMO v1 sourced: ${tmoCoverage.length > 0 ? tmoCoverage.join(", ") : "(none)"} | pending external data: organic growth, bioprocessing phase, op/FCF margin, EPS revs, forward PE, peer commentary (Sartorius/Repligen)`);
  }

  // ── NEW v4.13: NOW cohort valuation (vs CRM + WDAY + ADBE) ───────────
  // AI workflow quality compounder, analogous to MSFT's mega-cap cohort pattern,
  // tuned for premium-SaaS multiple math.
  // ★ CRITICAL: NOW carries 80-120% premium to CRM/WDAY/ADBE as the BASELINE
  //   (higher growth + higher quality). This is structural, not a warning.
  //   The flag is direction of change, not absolute level.
  //   Premium <60% = unusual discount = buy; >150% = stretched.
  if (output.NOW) {
    const nowPE = output.NOW.valuation?.trailingPE;
    const crmPE = auxQuotes.CRM?.pe;
    const wdayPE = auxQuotes.WDAY?.pe;
    const adbePE = auxQuotes.ADBE?.pe;
    const cohortPEs = [crmPE, wdayPE, adbePE].filter(p => p != null && p > 0);

    if (nowPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((nowPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.NOW.cohort_valuation = {
        now_pe: nowPE,
        crm_pe: crmPE ?? null,
        wday_pe: wdayPE ?? null,
        adbe_pe: adbePE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < 60 ? "UNUSUAL DISCOUNT (BUY)"
        : premiumPct < 80 ? "BELOW NORMAL PREMIUM (BUY-leaning)"
        : premiumPct < 120 ? "NORMAL PREMIUM"
        : premiumPct < 150 ? "ABOVE NORMAL PREMIUM"
        : "STRETCHED (TRIM)";
      console.log(`  NOW cohort-valuation: NOW ${nowPE}x | CRM ${crmPE ?? "—"}x | WDAY ${wdayPE ?? "—"}x | ADBE ${adbePE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !nowPE ? "no NOW P/E" : "no cohort P/E (CRM/WDAY/ADBE unavailable)";
      console.log(`  NOW cohort-valuation: skipped (${reason})`);
    }

    // ── NOW cohort-relative (rotation pressure: 30d return spread) ─────
    if (nowHistReturns) {
      output.NOW.cohort_relative = {
        now_30d_return_pct:        nowHistReturns.now_30d_return_pct,
        crm_30d_return_pct:        nowHistReturns.crm_30d_return_pct,
        wday_30d_return_pct:       nowHistReturns.wday_30d_return_pct,
        adbe_30d_return_pct:       nowHistReturns.adbe_30d_return_pct,
        cohort_avg_30d_return_pct: nowHistReturns.cohort_avg_30d_return_pct,
        rotation_pressure_pp:      nowHistReturns.rotation_pressure_pp,
        rotation_pressure_active:  nowHistReturns.rotation_pressure_active,
        cohort_count:              nowHistReturns.cohort_count,
      };

      const rp = nowHistReturns.rotation_pressure_pp;
      const rpStr = rp == null ? "—"
        : nowHistReturns.rotation_pressure_active ? `NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d (ROTATION PRESSURE ACTIVE — buy setup, capital flowing to higher-beta AI/SaaS)`
        : rp < 0 ? `NOW lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `NOW leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  NOW cohort-relative: ${rpStr}`);

      // factor_flow: IGV vs SPY 30d (software sector bid)
      output.NOW.factor_flow = {
        igv_vs_spy_30d_pp:  nowHistReturns.igv_vs_spy_30d_pp,
        igv_30d_return_pct: nowHistReturns.igv_30d_return_pct,
        spy_30d_return_pct: nowHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  NOW cohort-relative: skipped (no historical returns)`);
      output.NOW.factor_flow = { igv_vs_spy_30d_pp: null, igv_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // NOW fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.NOW.fundamentals.crpo_growth_pct          = null;  // current Remaining Performance Obligations YoY (THE ops metric)
    output.NOW.fundamentals.subscription_growth_pct  = null;  // total subscription revenue YoY
    output.NOW.fundamentals.op_margin_pct            = null;  // non-GAAP op margin (overrides generic Finnhub op margin)
    output.NOW.fundamentals.fcf_margin_pct           = null;  // 10-Q cash flow statement (~32% historical)
    output.NOW.fundamentals.large_deals_growth_pct   = null;  // $1M+ ACV deal count YoY (enterprise traction read)
    output.NOW.fundamentals.federal_growth_pct       = null;  // US Federal/Government revenue YoY (secular tailwind)
    output.NOW.fundamentals.eps_revisions_30d_pct    = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.NOW.fundamentals.eps_revisions_90d_pct    = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.NOW.fundamentals.ev_sales_current         = null;  // EV/Sales (premium SaaS primary valuation lens)
    output.NOW.fundamentals.now_assist_traction      = null;  // categorical: strong/moderate/early/unclear (LLM)
    output.NOW.fundamentals.ai_agent_platform_status = null;  // categorical: structural_moat/stable/uncertain/deteriorating (LLM)

    const nowCoverage = [
      output.NOW.cohort_valuation ? "cohort-PE" : null,
      output.NOW.cohort_relative?.rotation_pressure_pp != null ? "rotation" : null,
      output.NOW.factor_flow?.igv_vs_spy_30d_pp != null ? "IGV" : null,
    ].filter(Boolean);
    console.log(`  NOW v1 sourced: ${nowCoverage.length > 0 ? nowCoverage.join(", ") : "(none)"} | pending external data: cRPO growth, subs growth, op/FCF margin, $1M+ deals, federal growth, EV/Sales, forward PE, Now Assist traction, AI Agent Platform status`);
  }

  // ── NEW v4.14: MA twin valuation + duopoly fear regime (vs V) ─────────
  // Payments-network quality compounder. The twin comparison is V ONLY —
  // the duopoly partner, NOT PayPal/fintech/AXP (closed-loop lender).
  // ★ NOTE: MA normally carries a 10-20% trailing-P/E premium to V (faster
  //   grower, larger VAS mix). Premium <5% = compressed = buy; >25% = rich.
  //   Direction of change > absolute level.
  if (output.MA) {
    const maPE = output.MA.valuation?.trailingPE;
    const vPE = auxQuotes.V?.pe;

    if (maPE && vPE) {
      const premiumPct = +(((maPE - vPE) / vPE) * 100).toFixed(2);

      output.MA.twin_valuation = {
        ma_pe: maPE,
        v_pe: vPE,
        premium_pct: premiumPct,
      };

      const zone = premiumPct < 0 ? "DISCOUNT TO V (BUY — rare)"
        : premiumPct < 5 ? "COMPRESSED (BUY)"
        : premiumPct < 10 ? "BELOW NORMAL PREMIUM (BUY-leaning)"
        : premiumPct < 20 ? "NORMAL PREMIUM"
        : premiumPct < 25 ? "ABOVE NORMAL PREMIUM"
        : "RICH (TRIM)";
      console.log(`  MA twin-valuation: MA ${maPE}x | V ${vPE}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !maPE ? "no MA P/E" : "no V P/E";
      console.log(`  MA twin-valuation: skipped (${reason})`);
    }

    // ── MA twin relative (daily return spread vs V) ────────────────────
    const maChange = output.MA.price?.change_pct;
    const vChange = auxQuotes.V?.change_pct;
    const vPrice = auxQuotes.V?.price;

    if (maChange != null && vChange != null) {
      const spread = +(maChange - vChange).toFixed(3);

      output.MA.twin_relative = {
        ma_change_pct: maChange,
        v_change_pct: vChange,
        v_price: vPrice ?? null,
        relative_spread_pp: spread,
      };

      const twinStr = spread > 0.5 ? `MA outperforming V by ${spread}pp`
        : spread < -0.5 ? `V outperforming MA by ${(-spread).toFixed(2)}pp (twin-divergence watch)`
        : "inline";
      console.log(`  MA twin-relative: ${twinStr}`);
    } else {
      console.log(`  MA twin-relative: skipped (no V daily change)`);
    }

    // ── MA duopoly relative (30d twin spread + fear regime — V8.1 gate input) ──
    if (maHistReturns) {
      output.MA.duopoly_relative = {
        ma_30d_return_pct:          maHistReturns.ma_30d_return_pct,
        v_30d_return_pct:           maHistReturns.v_30d_return_pct,
        spy_30d_return_pct:         maHistReturns.spy_30d_return_pct,
        twin_spread_pp:             maHistReturns.twin_spread_pp,
        twin_dislocation_active:    maHistReturns.twin_dislocation_active,
        duopoly_avg_30d_return_pct: maHistReturns.duopoly_avg_30d_return_pct,
        duopoly_vs_spy_pp:          maHistReturns.duopoly_vs_spy_pp,
        disruption_fear_regime:     maHistReturns.disruption_fear_regime,
      };

      const ts = maHistReturns.twin_spread_pp;
      const tsStr = ts == null ? "—"
        : maHistReturns.twin_dislocation_active ? `MA lagging V by ${(-ts).toFixed(1)}pp/30d (TWIN DISLOCATION ACTIVE — buy setup if no MA-specific break)`
        : ts < 0 ? `MA lagging V by ${(-ts).toFixed(1)}pp/30d (mild)`
        : `MA leading V by ${ts.toFixed(1)}pp/30d`;
      console.log(`  MA duopoly-relative: ${tsStr} | fear regime: ${(maHistReturns.disruption_fear_regime || "—").toUpperCase()}`);
    } else {
      console.log(`  MA duopoly-relative: skipped (no historical returns)`);
      output.MA.duopoly_relative = { ma_30d_return_pct: null, v_30d_return_pct: null, spy_30d_return_pct: null, twin_spread_pp: null, twin_dislocation_active: false, duopoly_avg_30d_return_pct: null, duopoly_vs_spy_pp: null, disruption_fear_regime: null };
    }

    // factor_flow: QUAL vs SPY 30d — reused from LIN's fetch (market-wide quality bid)
    output.MA.factor_flow = {
      qual_vs_spy_30d_pp: linHistReturns?.qual_vs_spy_30d_pp ?? null,
    };

    // MA fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.MA.fundamentals.cross_border_growth_pct        = null;  // earnings release — THE ops metric
    output.MA.fundamentals.gdv_growth_pct                 = null;  // earnings release (gross dollar volume)
    output.MA.fundamentals.switched_txn_growth_pct        = null;  // earnings release (network share read)
    output.MA.fundamentals.vas_growth_pct                 = null;  // earnings release (value-added services net revenue)
    output.MA.fundamentals.vas_share_of_revenue_pct       = null;  // earnings release (~38% baseline)
    output.MA.fundamentals.rebates_incentives_trend       = null;  // categorical: outpacing_gross/in_line/lagging_gross (LLM)
    output.MA.fundamentals.op_margin_pct                  = null;  // adjusted op margin — overrides generic Finnhub field for MA scoring
    output.MA.fundamentals.eps_revisions_30d_pct          = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.MA.fundamentals.eps_revisions_90d_pct          = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.MA.fundamentals.buyback_share_reduction_yoy_pct = null; // 10-Q share count YoY (~-2.3% baseline)
    output.MA.fundamentals.stablecoin_strategy_execution  = null;  // categorical: leading/active/reactive/absent (LLM — BVNK, consortium, MTN)
    output.MA.fundamentals.disruption_narrative_phase     = null;  // categorical: narrative_peak/narrative_active/narrative_fading/resolved (LLM)
    output.MA.fundamentals.disruption_fundamental_evidence = null; // categorical: none/anecdotal/measurable/material (LLM)
    output.MA.fundamentals.interchange_regulation_status  = null;  // categorical: dormant/proposed_stalled/advancing/passed (LLM)

    const maCoverage = [
      output.MA.twin_valuation ? "twin-PE" : null,
      output.MA.duopoly_relative?.twin_spread_pp != null ? "twin-30d" : null,
      output.MA.duopoly_relative?.disruption_fear_regime != null ? "fear-regime" : null,
      output.MA.factor_flow?.qual_vs_spy_30d_pp != null ? "QUAL" : null,
    ].filter(Boolean);
    console.log(`  MA v1 sourced: ${maCoverage.length > 0 ? maCoverage.join(", ") : "(none)"} | pending external data: cross-border growth, GDV, switched txns, VAS, rebates trend, op margin, EPS revs, buyback, forward PE, stablecoin/disruption/regulation categoricals`);
  }

  // ── NEW v4.14: ISRG cohort valuation + devices factor (vs MDT/SYK/BSX) ──
  // Surgical-robotics moat compounder, analogous to NOW's premium-multiple
  // cohort pattern. Cohort is large-cap devices — NOT life-science tools
  // (TMO/DHR are a different category in this portfolio).
  // ★ CRITICAL: ISRG carries 60-120% premium to MDT/SYK/BSX as the BASELINE
  //   (category king, ~86% recurring annuity, two-decade moat). This is
  //   structural, not a warning. Absolute PE is never the signal.
  //   Premium <60% = unusual discount = buy; >150% = stretched.
  if (output.ISRG) {
    const isrgPE = output.ISRG.valuation?.trailingPE;
    const mdtPE = auxQuotes.MDT?.pe;
    const sykPE = auxQuotes.SYK?.pe;
    const bsxPE = auxQuotes.BSX?.pe;
    const cohortPEs = [mdtPE, sykPE, bsxPE].filter(p => p != null && p > 0);

    if (isrgPE && cohortPEs.length > 0) {
      const cohortAvg = cohortPEs.reduce((a, b) => a + b, 0) / cohortPEs.length;
      const premiumPct = +(((isrgPE - cohortAvg) / cohortAvg) * 100).toFixed(2);

      output.ISRG.cohort_valuation = {
        isrg_pe: isrgPE,
        mdt_pe: mdtPE ?? null,
        syk_pe: sykPE ?? null,
        bsx_pe: bsxPE ?? null,
        cohort_avg_pe: +cohortAvg.toFixed(2),
        premium_pct: premiumPct,
        cohort_count: cohortPEs.length,
      };

      const zone = premiumPct < 60 ? "UNUSUAL DISCOUNT (BUY)"
        : premiumPct < 90 ? "BELOW MID-PREMIUM (BUY-leaning)"
        : premiumPct < 120 ? "NORMAL PREMIUM"
        : premiumPct < 150 ? "ABOVE NORMAL PREMIUM"
        : "STRETCHED (TRIM)";
      console.log(`  ISRG cohort-valuation: ISRG ${isrgPE}x | MDT ${mdtPE ?? "—"}x | SYK ${sykPE ?? "—"}x | BSX ${bsxPE ?? "—"}x | cohort avg ${cohortAvg.toFixed(1)}x | premium ${premiumPct >= 0 ? "+" : ""}${premiumPct}% (${zone})`);
    } else {
      const reason = !isrgPE ? "no ISRG P/E" : "no cohort P/E (MDT/SYK/BSX unavailable)";
      console.log(`  ISRG cohort-valuation: skipped (${reason})`);
    }

    // ── ISRG cohort-relative (fear rotation: 30d return spread) ────────
    if (isrgHistReturns) {
      output.ISRG.cohort_relative = {
        isrg_30d_return_pct:       isrgHistReturns.isrg_30d_return_pct,
        mdt_30d_return_pct:        isrgHistReturns.mdt_30d_return_pct,
        syk_30d_return_pct:        isrgHistReturns.syk_30d_return_pct,
        bsx_30d_return_pct:        isrgHistReturns.bsx_30d_return_pct,
        cohort_avg_30d_return_pct: isrgHistReturns.cohort_avg_30d_return_pct,
        cohort_rotation_pp:        isrgHistReturns.cohort_rotation_pp,
        cohort_rotation_active:    isrgHistReturns.cohort_rotation_active,
        cohort_count:              isrgHistReturns.cohort_count,
      };

      const rp = isrgHistReturns.cohort_rotation_pp;
      const rpStr = rp == null ? "—"
        : isrgHistReturns.cohort_rotation_active ? `ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d (FEAR ROTATION ACTIVE — buy setup if no procedure-share evidence)`
        : rp < 0 ? `ISRG lagging cohort by ${(-rp).toFixed(1)}pp/30d (mild)`
        : `ISRG leading cohort by ${rp.toFixed(1)}pp/30d`;
      console.log(`  ISRG cohort-relative: ${rpStr}`);

      // factor_flow: IHI vs SPY 30d (devices sector bid — V8.1 gate input)
      output.ISRG.factor_flow = {
        ihi_vs_spy_30d_pp:  isrgHistReturns.ihi_vs_spy_30d_pp,
        ihi_30d_return_pct: isrgHistReturns.ihi_30d_return_pct,
        spy_30d_return_pct: isrgHistReturns.spy_30d_return_pct,
      };
    } else {
      console.log(`  ISRG cohort-relative: skipped (no historical returns)`);
      output.ISRG.factor_flow = { ihi_vs_spy_30d_pp: null, ihi_30d_return_pct: null, spy_30d_return_pct: null };
    }

    // ISRG fundamentals — explicit nulls for fields needing earnings disclosure.
    // LLM web-search prompt sources these as fallback fetch targets.
    output.ISRG.fundamentals.procedure_growth_pct       = null;  // earnings release — THE ops metric (total procedures YoY)
    output.ISRG.fundamentals.procedure_guide_low_pct    = null;  // current-year dV procedure guide low (2026: 13.5)
    output.ISRG.fundamentals.procedure_guide_high_pct   = null;  // current-year dV procedure guide high (2026: 15.5)
    output.ISRG.fundamentals.dv_placements_qtr          = null;  // earnings release (quarterly dV system placements)
    output.ISRG.fundamentals.dv5_mix_pct                = null;  // earnings release (dV5 share of placements)
    output.ISRG.fundamentals.ion_procedure_growth_pct   = null;  // earnings release (Ion second leg)
    output.ISRG.fundamentals.ion_installed_base         = null;  // earnings release
    output.ISRG.fundamentals.recurring_revenue_pct      = null;  // earnings release (~86% baseline; <84% = mix warning)
    output.ISRG.fundamentals.ia_revenue_growth_pct      = null;  // earnings release (instruments & accessories)
    output.ISRG.fundamentals.installed_base_total       = null;  // earnings release (~11,400 baseline)
    output.ISRG.fundamentals.installed_base_yoy_pct     = null;  // earnings release
    output.ISRG.fundamentals.op_margin_pct              = null;  // non-GAAP op margin — overrides generic Finnhub field for ISRG scoring
    output.ISRG.fundamentals.eps_revisions_30d_pct      = null;  // FactSet/Refinitiv consensus EPS delta 30d
    output.ISRG.fundamentals.eps_revisions_90d_pct      = null;  // FactSet/Refinitiv consensus EPS delta 90d
    output.ISRG.fundamentals.moat_status                = null;  // categorical: intact/probing/eroding/breached (LLM — Hugo/Ottava evidence)
    output.ISRG.fundamentals.instrument_transition_status = null; // categorical: unquantified_fear/quantified_manageable/quantified_material (LLM — 2027 lifespan change)

    const isrgCoverage = [
      output.ISRG.cohort_valuation ? "cohort-PE" : null,
      output.ISRG.cohort_relative?.cohort_rotation_pp != null ? "rotation" : null,
      output.ISRG.factor_flow?.ihi_vs_spy_30d_pp != null ? "IHI" : null,
    ].filter(Boolean);
    console.log(`  ISRG v1 sourced: ${isrgCoverage.length > 0 ? isrgCoverage.join(", ") : "(none)"} | pending external data: procedure growth + guide, dV placements/dV5 mix, Ion, recurring %, I&A growth, installed base, op margin, EPS revs, forward PE, moat/instrument-transition categoricals`);
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
  console.log(`  GLNCY/COPX:     ${output.GLNCY?.copper_regime ? `ratio=${output.GLNCY.copper_regime.glncy_copx_ratio}, COPX $${output.GLNCY.copper_regime.copx_price}` : "unavailable"}`);
  console.log(`  LIN peer P/E:   ${output.LIN?.peer_valuation ? `LIN ${output.LIN.peer_valuation.lin_pe}x vs ${output.LIN.peer_valuation.peer_count}-peer avg ${output.LIN.peer_valuation.peer_avg_pe}x = ${output.LIN.peer_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  LIN v3 BBB OAS: ${macro.bbb_oas_bps != null ? `${macro.bbb_oas_bps}bps (1m Δ ${macro.bbb_oas_1m_change_bps != null ? (macro.bbb_oas_1m_change_bps >= 0 ? "+" : "") + macro.bbb_oas_1m_change_bps + "bps" : "—"})` : "unavailable"}`);
  console.log(`  LIN v3 returns: ${linHistReturns ? `SPY 10d=${linHistReturns.spy_10d_drawdown_pct}%, LIN-SPY 10d=${linHistReturns.lin_vs_spy_10d_pp}pp, QUAL-SPY 30d=${linHistReturns.qual_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  LIN AI.PA:      ${output.LIN?.peer_relative_aipa ? `spread=${output.LIN.peer_relative_aipa.relative_spread_pp}pp` : "unavailable"}`);
  console.log(`  MSFT cohort PE: ${output.MSFT?.cohort_valuation ? `MSFT ${output.MSFT.cohort_valuation.msft_pe}x vs ${output.MSFT.cohort_valuation.cohort_count}-name cohort avg ${output.MSFT.cohort_valuation.cohort_avg_pe}x = ${output.MSFT.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  MSFT rotation:  ${output.MSFT?.cohort_relative ? `MSFT 30d=${output.MSFT.cohort_relative.msft_30d_return_pct}%, cohort=${output.MSFT.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.MSFT.cohort_relative.rotation_pressure_pp}pp${output.MSFT.cohort_relative.rotation_pressure_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  LHX cohort PE:  ${output.LHX?.cohort_valuation ? `LHX ${output.LHX.cohort_valuation.lhx_pe}x vs ${output.LHX.cohort_valuation.cohort_count}-name cohort avg ${output.LHX.cohort_valuation.cohort_avg_pe}x = ${output.LHX.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  LHX rotation:   ${output.LHX?.cohort_relative ? `LHX 30d=${output.LHX.cohort_relative.lhx_30d_return_pct}%, cohort=${output.LHX.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.LHX.cohort_relative.cohort_rotation_pp}pp${output.LHX.cohort_relative.cohort_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  LHX ITA-SPY:    ${output.LHX?.factor_flow?.ita_vs_spy_30d_pp != null ? `${output.LHX.factor_flow.ita_vs_spy_30d_pp >= 0 ? "+" : ""}${output.LHX.factor_flow.ita_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  TMO peer P/E:   ${output.TMO?.peer_valuation ? `TMO ${output.TMO.peer_valuation.tmo_pe}x vs DHR ${output.TMO.peer_valuation.dhr_pe}x = ${output.TMO.peer_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  TMO biotech:    ${output.TMO?.biotech_overlay ? `XBI 30d=${output.TMO.biotech_overlay.xbi_30d_return_pct}%, 90d=${output.TMO.biotech_overlay.xbi_90d_return_pct}%${output.TMO.biotech_overlay.sympathy_setup_active ? " [SYMPATHY ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  TMO-DHR 30d:    ${output.TMO?.tactical_extras?.tmo_vs_dhr_30d_pp != null ? `${output.TMO.tactical_extras.tmo_vs_dhr_30d_pp >= 0 ? "+" : ""}${output.TMO.tactical_extras.tmo_vs_dhr_30d_pp}pp` : "unavailable"}`);
  console.log(`  NOW cohort PE:  ${output.NOW?.cohort_valuation ? `NOW ${output.NOW.cohort_valuation.now_pe}x vs ${output.NOW.cohort_valuation.cohort_count}-name cohort avg ${output.NOW.cohort_valuation.cohort_avg_pe}x = ${output.NOW.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  NOW rotation:   ${output.NOW?.cohort_relative ? `NOW 30d=${output.NOW.cohort_relative.now_30d_return_pct}%, cohort=${output.NOW.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.NOW.cohort_relative.rotation_pressure_pp}pp${output.NOW.cohort_relative.rotation_pressure_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  NOW IGV-SPY:    ${output.NOW?.factor_flow?.igv_vs_spy_30d_pp != null ? `${output.NOW.factor_flow.igv_vs_spy_30d_pp >= 0 ? "+" : ""}${output.NOW.factor_flow.igv_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  MA twin PE:     ${output.MA?.twin_valuation ? `MA ${output.MA.twin_valuation.ma_pe}x vs V ${output.MA.twin_valuation.v_pe}x = ${output.MA.twin_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  MA duopoly:     ${output.MA?.duopoly_relative?.duopoly_vs_spy_pp != null ? `twin Δ=${output.MA.duopoly_relative.twin_spread_pp}pp${output.MA.duopoly_relative.twin_dislocation_active ? " [DISLOCATION]" : ""}, duopoly-SPY=${output.MA.duopoly_relative.duopoly_vs_spy_pp}pp (${output.MA.duopoly_relative.disruption_fear_regime})` : "unavailable"}`);
  console.log(`  ISRG cohort PE: ${output.ISRG?.cohort_valuation ? `ISRG ${output.ISRG.cohort_valuation.isrg_pe}x vs ${output.ISRG.cohort_valuation.cohort_count}-name cohort avg ${output.ISRG.cohort_valuation.cohort_avg_pe}x = ${output.ISRG.cohort_valuation.premium_pct}% premium` : "unavailable"}`);
  console.log(`  ISRG rotation:  ${output.ISRG?.cohort_relative ? `ISRG 30d=${output.ISRG.cohort_relative.isrg_30d_return_pct}%, cohort=${output.ISRG.cohort_relative.cohort_avg_30d_return_pct}%, Δ=${output.ISRG.cohort_relative.cohort_rotation_pp}pp${output.ISRG.cohort_relative.cohort_rotation_active ? " [ACTIVE]" : ""}` : "unavailable"}`);
  console.log(`  ISRG IHI-SPY:   ${output.ISRG?.factor_flow?.ihi_vs_spy_30d_pp != null ? `${output.ISRG.factor_flow.ihi_vs_spy_30d_pp >= 0 ? "+" : ""}${output.ISRG.factor_flow.ihi_vs_spy_30d_pp}pp` : "unavailable"}`);
  console.log(`  Aux quotes:     ${Object.keys(auxQuotes).length} symbols (${Object.keys(auxQuotes).join(", ")})`);
  console.log(`═══════════════════════════════════`);

  writeFileSync("/tmp/market-data.json", JSON.stringify(output, null, 2));
  console.log("✓ Written to /tmp/market-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
