#!/usr/bin/env node
// generate-signals.mjs v7.5 — Hybrid scoring: 50% deterministic + 50% LLM.
// Deterministic layer handles RSI, 52w position, MAs, valuation math.
// LLM handles qualitative interpretation, catalysts, risks, rationale text.
// v6.0-v7.4: see git history.
// v7.5: HOLDINGS SWAP — added LHX (defense_prime_backlog_compounder, 20/40/40) and
//       TMO (life_sciences_quality_compounder, 20/35/45); retired MOS and SPY.
//       12 holdings preserved.
//       LHX: HYBRID of LIN-like quality + ASML-like DoD capex cycle + geopolitical regime overlay.
//            Tightened RSI 40/70, drawdown primary (>10% setup, >18% strong), cohort rotation vs
//            LMT/NOC/RTX/GD avg 30d (LHX lagging >5pp = BUY setup), ITA vs SPY 30d factor flow.
//            Smallest of Big 5 primes, historically -5 to -15% PE discount — compression is the
//            central re-rating thesis. Aerojet SRM duopoly with NOC.
//       TMO: "ASML of life sciences" — picks-and-shovels supplier. HYBRID of LIN-like quality +
//            ASML-like secular monopoly + cyclical end-market exposure (bioprocessing, biotech
//            funding, China capex). Strategic dominates (45%) — cycle inflection thesis.
//            Tightened RSI 35/70, drawdown primary (>15% setup, >25% strong), DHR peer P/E,
//            XBI biotech overlay (30d/90d), biotech sympathy setup (TMO+XBI both down = buy),
//            QUAL factor flow reused from LIN, DXY (~40% non-US revenue). Currently ~15-25%
//            drawdown + 1% Q1 2026 organic growth trough = high-conviction buy SETUP zone.
//       Removals: isSPY/isMOS flags, spyGuidance/mosGuidance (full + search), MOS ag_demand +
//       SPY breadth + MOS BRL/USD data lines, "cyclical_commodity" from CYCLICAL_ARCHETYPES set.

import { readFileSync, writeFileSync } from "fs";
import { computeDeterministicScores, blendScores } from "./score-engine.mjs";
import { loadCalibration, buildCalibrationBlock, computeConfidence } from "./calibration-loader.mjs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

let MARKET_DATA = {};
try { MARKET_DATA = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8")); } catch {}

const CALIBRATION = loadCalibration();
console.log(`Calibration: ${CALIBRATION.available ? `${CALIBRATION.totalDays} days of history loaded` : "no history yet"}`);

const HOLDINGS = [
  { symbol: "LHX",   name: "L3Harris",        sector: "Defense Prime",      archetype: "defense_prime_backlog_compounder", weights: { t:.20, p:.40, s:.40 } },
  { symbol: "ASML",  name: "ASML",            sector: "Semis (Litho)",      archetype: "secular_growth_monopoly",          weights: { t:.15, p:.30, s:.55 } },
  { symbol: "LIN",   name: "Linde plc",       sector: "Industrial Gas",     archetype: "oligopoly_quality_compounder",     weights: { t:.20, p:.35, s:.45 } },
  { symbol: "MSFT",  name: "Microsoft",       sector: "AI Infrastructure",  archetype: "ai_infra_quality_compounder",      weights: { t:.20, p:.35, s:.45 } },
  { symbol: "TMO",   name: "Thermo Fisher",   sector: "Life Sciences Tools",archetype: "life_sciences_quality_compounder", weights: { t:.20, p:.35, s:.45 } },
  { symbol: "ENB",   name: "Enbridge",        sector: "Midstream Energy",   archetype: "dividend_compounder",              weights: { t:.10, p:.45, s:.45 } },
  { symbol: "ETHA",  name: "iShares ETH",     sector: "Crypto (ETH)",       archetype: "high_beta_crypto",                 weights: { t:.30, p:.35, s:.35 } },
  { symbol: "GLNCY", name: "Glencore",        sector: "Diversified Mining", archetype: "diversified_commodity_trader",     weights: { t:.20, p:.35, s:.45 } },
  { symbol: "IBIT",  name: "iShares BTC",     sector: "Crypto (BTC)",       archetype: "momentum_store_of_value",          weights: { t:.30, p:.35, s:.35 } },
  { symbol: "KOF",   name: "Coca-Cola FEMSA", sector: "LatAm Consumer",     archetype: "em_dividend_growth",               weights: { t:.15, p:.35, s:.50 } },
  { symbol: "PBR.A", name: "Petrobras",       sector: "EM Energy",          archetype: "em_state_oil_dividend",            weights: { t:.20, p:.35, s:.45 } },
  { symbol: "AMKBY", name: "Maersk",          sector: "Global Shipping",    archetype: "cyclical_trade_bellwether",        weights: { t:.25, p:.35, s:.40 } },
];

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
// MOS removed in v7.5 (cyclical_commodity no longer used).
const CYCLICAL_ARCHETYPES = new Set([
  "diversified_commodity_trader",
  "cyclical_trade_bellwether",
  "em_state_oil_dividend",
]);

// ─── HALVING PHASE HELPER (for IBIT prompt context) ─────────────────────────
function getIBITPhaseContext() {
  const halvingDate = new Date("2024-04-20");
  const now = new Date();
  const months = (now.getFullYear() - halvingDate.getFullYear()) * 12
               + (now.getMonth() - halvingDate.getMonth());
  let phase;
  if (months < 12) phase = "early_expansion";
  else if (months < 18) phase = "mid_expansion";
  else if (months < 30) phase = "extended_expansion";
  else phase = "post_expansion";
  return { months, phase };
}

// ─── LLM PROMPT ──────────────────────────────────────────────────────────────
const JSON_TEMPLATE = (sym) => `{"tactical":{"score":0,"rationale":""},"positional":{"score":0,"rationale":""},"strategic":{"score":0,"rationale":""},"composite":{"score":0,"summary":""},"key_metric":{"name":"","value":""},"risks":["",""],"catalysts":["",""]}`;

function buildPrompt(h, detScores) {
  const md = MARKET_DATA[h.symbol] || {};
  const macro = MARKET_DATA._macro || {};
  const isCyclical = CYCLICAL_ARCHETYPES.has(h.archetype);
  const isIBIT = h.archetype === "momentum_store_of_value";
  const isASML = h.archetype === "secular_growth_monopoly";
  const isENB = h.archetype === "dividend_compounder";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isETHA = h.archetype === "high_beta_crypto";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";
  const isPBRA = h.archetype === "em_state_oil_dividend";
  const isLIN = h.archetype === "oligopoly_quality_compounder";
  const isMSFT = h.archetype === "ai_infra_quality_compounder";
  const isLHX = h.archetype === "defense_prime_backlog_compounder";  // ← V7.5
  const isTMO = h.archetype === "life_sciences_quality_compounder";  // ← V7.5

  const curveStr = macro.spread_2s10s != null
    ? `${macro.spread_2s10s >= 0 ? "+" : ""}${macro.spread_2s10s}bps`
    : null;
  const realRate = (macro.fed_funds != null && macro.tips10y != null)
    ? +(macro.fed_funds - macro.tips10y).toFixed(2)
    : null;

  // IBIT-specific extension line
  let ibitExtensionLine = null;
  if (isIBIT && md.price?.current && md.technicals?.sma200) {
    const pct = ((md.price.current - md.technicals.sma200) / md.technicals.sma200) * 100;
    ibitExtensionLine = `BTC vs 200DMA: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (price $${md.price.current} vs 200DMA $${md.technicals.sma200})`;
  }

  // ENB yield spread line
  let enbYieldSpreadLine = null;
  if (isENB && md.valuation?.dividendYield && macro.us10y) {
    const spread = md.valuation.dividendYield - macro.us10y;
    const spreadBps = Math.round(spread * 100);
    enbYieldSpreadLine = `ENB yield spread vs 10Y: ${spreadBps}bps (ENB ${md.valuation.dividendYield}% − 10Y ${macro.us10y}%)${spreadBps > 300 ? " — ATTRACTIVE" : spreadBps < 150 ? " — RICH" : ""}`;
  }

  // AMKBY GSCPI line
  let amkbyGscpiLine = null;
  if (isAMKBY && macro.gscpi != null) {
    const g = macro.gscpi;
    const regime = g > 1.5 ? "STRESSED" : g > 0.5 ? "ELEVATED" : g > -0.5 ? "NORMAL" : g > -1.0 ? "CALM" : "VERY CALM";
    amkbyGscpiLine = `GSCPI (supply chain pressure): ${g} (${regime}) — date: ${macro.gscpi_date || "latest"}`;
  }

  // ETHA alt-season line + 200DMA extension
  let ethaAltSeasonLine = null;
  if (isETHA && md.alt_season) {
    const s = md.alt_season;
    const dir = s.relative_spread_pp > 0.5 ? "ALT-SEASON (ETHA outperforming)" :
                s.relative_spread_pp < -0.5 ? "BTC DOMINANCE (IBIT outperforming)" : "INLINE";
    ethaAltSeasonLine = `ETHA/IBIT ratio: ${s.etha_ibit_ratio ?? "—"} | Spread: ${s.relative_spread_pp != null ? (s.relative_spread_pp >= 0 ? "+" : "") + s.relative_spread_pp + "pp" : "—"} (${dir})`;
  }
  let ethaExtensionLine = null;
  if (isETHA && md.price?.current && md.technicals?.sma200) {
    const pct = ((md.price.current - md.technicals.sma200) / md.technicals.sma200) * 100;
    ethaExtensionLine = `ETH vs 200DMA: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (price $${md.price.current} vs 200DMA $${md.technicals.sma200})`;
  }

  // KOF MXN/USD line
  let kofMxnLine = null;
  if (isKOF && macro.mxn_usd != null) {
    const mxn = macro.mxn_usd;
    const regime = mxn < 16 ? "VERY STRONG PESO" : mxn < 17 ? "STRONG PESO" : mxn < 18.5 ? "NORMAL" : mxn < 20 ? "WEAKENING" : "WEAK PESO";
    kofMxnLine = `MXN/USD: ${mxn} (${regime}) — KOF earns ~60% in MXN`;
  }

  // GLNCY COPX line
  let glncyCopxLine = null;
  if (isGLNCY && md.copper_regime) {
    const cr = md.copper_regime;
    const dir = cr.relative_spread_pp > 0.5 ? "GLNCY OUTPERFORMING (diversification premium)" :
                cr.relative_spread_pp < -0.5 ? "COPX LEADING (copper surging, GLNCY catch-up?)" : "INLINE";
    glncyCopxLine = `GLNCY/COPX: ratio ${cr.glncy_copx_ratio ?? "—"} | COPX $${cr.copx_price ?? "—"} (${cr.copx_change_pct >= 0 ? "+" : ""}${cr.copx_change_pct}%) | Spread: ${cr.relative_spread_pp != null ? (cr.relative_spread_pp >= 0 ? "+" : "") + cr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }

  // ── LIN-specific data lines ──────────────────────────────────────────────
  let linPeerValuationLine = null;
  if (isLIN && md.peer_valuation) {
    const pv = md.peer_valuation;
    const prem = pv.premium_pct;
    const regime = prem == null ? "" : prem < 5 ? " — TIGHT (BUY)" : prem < 15 ? " — DESERVED PREMIUM" : prem < 18 ? " — STRETCHED" : " — RICH (TRIM)";
    linPeerValuationLine = `LIN P/E: ${pv.lin_pe ?? "—"}x | APD: ${pv.apd_pe ?? "—"}x | AI.PA: ${pv.ai_pa_pe ?? "—"}x | Peer avg: ${pv.peer_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime}`;
  }
  let linBacklogLine = null;
  if (isLIN && md.backlog) {
    const b = md.backlog;
    const yoy = b.yoy_growth_pct;
    const zone = yoy == null ? "" : yoy > 8 ? " (ACCELERATING)" : yoy > 3 ? " (HEALTHY)" : yoy > 0 ? " (STABLE)" : " (DECELERATING)";
    linBacklogLine = `LIN backlog YoY: ${yoy != null ? (yoy >= 0 ? "+" : "") + yoy + "%" : "—"}${zone} | Last reported: ${b.last_reported_quarter ?? "—"} (leading indicator — earnings lag 2-4Q)`;
  }
  let linFundamentalsLine = null;
  if (isLIN && md.fundamentals) {
    const f = md.fundamentals;
    const roceZone = f.roce_pct == null ? "" : f.roce_pct > 25 ? " (best-in-class)" : f.roce_pct > 22 ? " (slipping)" : " (concerning)";
    linFundamentalsLine = `LIN ROCE: ${f.roce_pct ?? "—"}%${roceZone} | Op margin: ${f.operating_margin_pct ?? "—"}% | Margin trend: ${f.margin_trend ?? "—"}`;
  }
  let linPeerRelativeLine = null;
  if (isLIN && md.peer_relative) {
    const pr = md.peer_relative;
    const dir = pr.relative_spread_pp > 1 ? "LIN OUTPERFORMING APD (quality premium extending)" :
                pr.relative_spread_pp < -1 ? "APD OUTPERFORMING LIN (catch-up potential)" : "INLINE";
    linPeerRelativeLine = `LIN/APD 1m spread: ${pr.relative_spread_pp != null ? (pr.relative_spread_pp >= 0 ? "+" : "") + pr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }
  let linDxyLine = null;
  if (isLIN && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 110 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 105 ? "STRONG USD (HEADWIND)" : dxy > 100 ? "NORMAL" : dxy > 95 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    linDxyLine = `DXY: ${dxy} (${regime}) — LIN ~70% non-US revenue`;
  }
  let linPmiLine = null;
  if (isLIN && (macro.us_ism != null || macro.eu_pmi != null || macro.china_pmi != null)) {
    const pmis = [macro.us_ism, macro.eu_pmi, macro.china_pmi].filter(p => p != null);
    const avg = pmis.length > 0 ? (pmis.reduce((a, b) => a + b, 0) / pmis.length).toFixed(1) : null;
    const regime = avg == null ? "" : avg > 51 ? "EXPANSION" : avg > 49 ? "NEUTRAL" : "CONTRACTION";
    linPmiLine = `Global Mfg PMI: US ISM ${macro.us_ism ?? "—"} | EU ${macro.eu_pmi ?? "—"} | China ${macro.china_pmi ?? "—"} | Avg: ${avg ?? "—"} (${regime})`;
  }
  let linBbbOasLine = null;
  if (isLIN && macro.bbb_oas_bps != null) {
    const oas = macro.bbb_oas_bps;
    const change = macro.bbb_oas_1m_change_bps;
    const regime = oas < 130 ? "TIGHT" : oas < 160 ? "NORMAL" : oas < 200 ? "WIDENING" : "WIDE";
    const trend = change != null ? ` | 1m: ${change >= 0 ? "+" : ""}${change}bps` : "";
    linBbbOasLine = `BBB OAS: ${oas}bps (${regime})${trend} — leads LIN backlog 6-12mo via capex-IRR math`;
  }
  let linOpsLine = null;
  if (isLIN && md.fundamentals && (md.fundamentals.asu_utilization_pct != null || md.fundamentals.price_mix_ex_fx_pct != null)) {
    const u = md.fundamentals.asu_utilization_pct;
    const px = md.fundamentals.price_mix_ex_fx_pct;
    const uZone = u == null ? "" : u > 85 ? " (TIGHT — pricing power)" : u > 80 ? " (HEALTHY)" : u > 75 ? " (NORMAL)" : " (LOOSE — margin pressure)";
    const pxZone = px == null ? "" : px > 2 ? " (MOAT WORKING)" : px > 0 ? " (POSITIVE)" : " (EROSION RISK)";
    linOpsLine = `ASU util: ${u != null ? u.toFixed(1) + "%" + uZone : "—"} | Price/mix ex-FX: ${px != null ? (px >= 0 ? "+" : "") + px.toFixed(1) + "%" + pxZone : "—"}`;
  }
  let linEpsRevLine = null;
  if (isLIN && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    linEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }
  let linPeerAipaLine = null;
  if (isLIN && md.peer_relative_aipa) {
    const sp = md.peer_relative_aipa.relative_spread_pp;
    const dir = sp == null ? "" : sp > 1 ? " (LIN leading)" : sp < -1 ? " (AI.PA leading — triangulation supports buy)" : " (inline)";
    linPeerAipaLine = `LIN/AI.PA 1m spread: ${sp != null ? (sp >= 0 ? "+" : "") + sp + "pp" : "—"}${dir}`;
  }
  let linPremiumDeltaLine = null;
  if (isLIN && md.peer_valuation?.premium_6m_delta_pp != null) {
    const d = md.peer_valuation.premium_6m_delta_pp;
    const dir = d < -3 ? " (COMPRESSING — buy bias)" : d > 3 ? " (EXPANDING — trim bias)" : " (STABLE)";
    linPremiumDeltaLine = `Peer P/E premium 6M Δ: ${d >= 0 ? "+" : ""}${d.toFixed(1)}pp${dir}`;
  }
  let linH2Line = null;
  if (isLIN && md.h2_layer) {
    const h2 = md.h2_layer;
    const c = h2.contracts_90d_usd_m;
    const cZone = c == null ? "" : c > 500 ? " (STRONG)" : c > 100 ? " (NORMAL)" : " (SLOW)";
    const reg = h2.subsidy_regime || "—";
    const gap = h2.lcoe_gap_usd_kg;
    const gapDelta = h2.lcoe_gap_6m_delta;
    const gapDir = gapDelta == null ? "" : gapDelta < -0.5 ? " (CLOSING — H2 thesis activating)" : gapDelta > 0.5 ? " (WIDENING — H2 thesis stalled)" : "";
    linH2Line = `H2 layer: contracts ${c != null ? "$" + c.toFixed(0) + "M/90d" + cZone : "—"} | Subsidy: ${reg} | Green/grey LCOE: ${gap != null ? "$" + gap.toFixed(2) + "/kg" : "—"}${gapDelta != null ? " (6m Δ " + (gapDelta >= 0 ? "+" : "") + gapDelta.toFixed(2) + ")" + gapDir : ""}`;
  }
  let linTacticalExtrasLine = null;
  if (isLIN && (md.tactical_extras || md.factor_flow)) {
    const iv = md.tactical_extras?.iv_rv_ratio;
    const q = md.factor_flow?.qual_vs_spy_30d_pp;
    const dd = md.tactical_extras?.spy_10d_drawdown_pct;
    const lo = md.tactical_extras?.lin_vs_spy_10d_pp;
    const ivLabel = iv != null ? `IV/RV ${iv.toFixed(2)}${iv < 0.9 ? " (compressed — catalyst hunt)" : iv > 1.2 ? " (elevated)" : ""}` : null;
    const qLabel = q != null ? `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp${q > 1 ? " (quality bid active)" : q < -1 ? " (quality under pressure)" : ""}` : null;
    const ddLabel = (dd != null && lo != null) ? `SPY 10d ${dd.toFixed(1)}% / LIN over SPY ${lo >= 0 ? "+" : ""}${lo.toFixed(1)}pp${dd < -3 && lo > 0.5 ? " (growth-scare setup)" : ""}` : null;
    const parts = [ivLabel, qLabel, ddLabel].filter(Boolean);
    if (parts.length > 0) linTacticalExtrasLine = parts.join(" | ");
  }
  let linRegimeLine = null;
  if (isLIN && detScores.regime) {
    const w = detScores.weights;
    const wStr = w ? `T=${Math.round(w.t * 100)}% / P=${Math.round(w.p * 100)}% / S=${Math.round(w.s * 100)}%` : "—";
    const pmi = detScores.regimePmi != null ? detScores.regimePmi.toFixed(1) : "—";
    linRegimeLine = `Active regime: ${detScores.regime.toUpperCase()} (geo-wgt PMI ${pmi}) → composite weights: ${wStr}`;
  }

  // ── MSFT-specific data lines ─────────────────────────────────────────────
  let msftCohortValuationLine = null;
  if (isMSFT && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < -8 ? " — DEEP DISCOUNT (BUY)" : prem < 0 ? " — BELOW COHORT" : prem <= 15 ? " — DESERVED PREMIUM" : prem < 20 ? " — STRETCHED" : " — RICH (TRIM)";
    msftCohortValuationLine = `MSFT P/E: ${cv.msft_pe ?? "—"}x | GOOGL: ${cv.googl_pe ?? "—"}x | META: ${cv.meta_pe ?? "—"}x | AAPL: ${cv.aapl_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let msftCohortRelativeLine = null;
  if (isMSFT && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.rotation_pressure_pp;
    const status = cr.rotation_pressure_active
      ? (rp != null && rp < -10 ? "ACTIVE/STRONG (capital chasing higher-beta AI — buy setup)" : "ACTIVE (mild buy setup)")
      : (rp != null && rp > 5 ? "MSFT LEADING COHORT (quality leadership)" : "INLINE");
    msftCohortRelativeLine = `MSFT 30d: ${cr.msft_30d_return_pct != null ? (cr.msft_30d_return_pct >= 0 ? "+" : "") + cr.msft_30d_return_pct + "%" : "—"} | Cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation pressure: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let msftDrawdownLine = null;
  if (isMSFT && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction buy)" : ddMag > 20 ? "DEEP (high-conviction setup)" : ddMag > 15 ? "MEANINGFUL (compounder buy interest)" : ddMag > 12 ? "SETUP territory" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    msftDrawdownLine = `MSFT drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for AI infra compounder`;
  }
  let msftFactorFlowLine = null;
  if (isMSFT && md.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = md.factor_flow.qual_vs_spy_30d_pp;
    const dir = q > 1 ? "QUALITY BID ACTIVE (MSFT benefits)" : q < -1 ? "QUALITY UNDER PRESSURE" : "INLINE";
    msftFactorFlowLine = `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp (${dir})`;
  }
  let msftDxyLine = null;
  if (isMSFT && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    msftDxyLine = `DXY: ${dxy} (${regime}) — MSFT ~50% non-US revenue`;
  }
  let msftFundamentalsLine = null;
  if (isMSFT && md.fundamentals && (md.fundamentals.azure_growth_cc_pct != null || md.fundamentals.capex_yoy_growth_pct != null || md.fundamentals.fcf_margin_pct != null || md.fundamentals.operating_margin_pct != null)) {
    const f = md.fundamentals;
    const azure = f.azure_growth_cc_pct != null ? `Azure CC: ${f.azure_growth_cc_pct.toFixed(1)}%` : null;
    const om = f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null;
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const cx = f.capex_yoy_growth_pct != null ? `Capex YoY: ${f.capex_yoy_growth_pct >= 0 ? "+" : ""}${f.capex_yoy_growth_pct.toFixed(0)}%` : null;
    const parts = [azure, om, fcf, cx].filter(Boolean);
    if (parts.length > 0) msftFundamentalsLine = `MSFT fundamentals: ${parts.join(" | ")}`;
  }
  let msftEpsRevLine = null;
  if (isMSFT && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    msftEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── V7.5: LHX-specific data lines ────────────────────────────────────────
  let lhxDrawdownLine = null;
  if (isLHX && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 25 ? "EXTREME (rare conviction)" : ddMag > 18 ? "DEEP (high-conviction setup)" : ddMag > 10 ? "SETUP territory" : ddMag > 5 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    lhxDrawdownLine = `LHX drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for defense prime compounder`;
  }
  let lhxCohortValuationLine = null;
  if (isLHX && md.cohort_valuation) {
    const cv = md.cohort_valuation;
    const prem = cv.premium_pct;
    const regime = prem == null ? "" : prem < -10 ? " — WIDE DISCOUNT (BUY — above-norm)" : prem < -5 ? " — NORMAL DISCOUNT range" : prem < 0 ? " — MILD DISCOUNT" : prem < 5 ? " — IN-LINE (rare for LHX)" : " — PREMIUM (TRIM — rare)";
    lhxCohortValuationLine = `LHX P/E: ${cv.lhx_pe ?? "—"}x | LMT: ${cv.lmt_pe ?? "—"}x | NOC: ${cv.noc_pe ?? "—"}x | RTX: ${cv.rtx_pe ?? "—"}x | GD: ${cv.gd_pe ?? "—"}x | Cohort avg: ${cv.cohort_avg_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let lhxCohortRelativeLine = null;
  if (isLHX && md.cohort_relative) {
    const cr = md.cohort_relative;
    const rp = cr.cohort_rotation_pp;
    const status = cr.cohort_rotation_active
      ? (rp != null && rp < -10 ? "ACTIVE/STRONG (capital flowing to larger primes — buy setup)" : "ACTIVE (mild buy setup)")
      : (rp != null && rp > 5 ? "LHX LEADING COHORT (leadership)" : "INLINE");
    lhxCohortRelativeLine = `LHX 30d: ${cr.lhx_30d_return_pct != null ? (cr.lhx_30d_return_pct >= 0 ? "+" : "") + cr.lhx_30d_return_pct + "%" : "—"} | Cohort avg 30d: ${cr.cohort_avg_30d_return_pct != null ? (cr.cohort_avg_30d_return_pct >= 0 ? "+" : "") + cr.cohort_avg_30d_return_pct + "%" : "—"} | Rotation Δ: ${rp != null ? (rp >= 0 ? "+" : "") + rp.toFixed(1) + "pp" : "—"} (${status})`;
  }
  let lhxFactorFlowLine = null;
  if (isLHX && md.factor_flow?.ita_vs_spy_30d_pp != null) {
    const i = md.factor_flow.ita_vs_spy_30d_pp;
    const dir = i > 1 ? "DEFENSE BID ACTIVE (positional positive)" : i < -1 ? "DEFENSE LAGGING" : "INLINE";
    lhxFactorFlowLine = `ITA vs SPY (30d): ${i >= 0 ? "+" : ""}${i.toFixed(1)}pp (${dir})`;
  }
  let lhxFundamentalsLine = null;
  if (isLHX && md.fundamentals && (md.fundamentals.book_to_bill != null || md.fundamentals.backlog_growth_yoy_pct != null || md.fundamentals.op_margin_pct != null || md.fundamentals.fcf_margin_pct != null)) {
    const f = md.fundamentals;
    const bb = f.book_to_bill != null ? `B/B: ${f.book_to_bill.toFixed(2)}` : null;
    const bl = f.backlog_growth_yoy_pct != null ? `Backlog YoY: ${f.backlog_growth_yoy_pct >= 0 ? "+" : ""}${f.backlog_growth_yoy_pct.toFixed(1)}%` : null;
    const om = f.op_margin_pct != null ? `Op margin: ${f.op_margin_pct.toFixed(1)}%` : (f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null);
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const parts = [bb, bl, om, fcf].filter(Boolean);
    if (parts.length > 0) lhxFundamentalsLine = `LHX fundamentals: ${parts.join(" | ")}`;
  }
  let lhxEpsRevLine = null;
  if (isLHX && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    lhxEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  // ── V7.5: TMO-specific data lines ────────────────────────────────────────
  let tmoDrawdownLine = null;
  if (isTMO && md.price?.current && md.price?.week52_high) {
    const dd = ((md.price.current - md.price.week52_high) / md.price.week52_high) * 100;
    const ddMag = Math.abs(dd);
    const zone = ddMag > 30 ? "EXTREME (rare conviction)" : ddMag > 25 ? "DEEP (strong conviction setup)" : ddMag > 15 ? "MEANINGFUL SETUP (compounder buy zone)" : ddMag > 8 ? "MILD" : ddMag < 2 ? "AT/NEAR HIGHS (normal compounder)" : "MODEST";
    tmoDrawdownLine = `TMO drawdown from 52w high: ${dd.toFixed(1)}% (${zone}) — primary tactical signal for life-sciences compounder`;
  }
  let tmoPeerValuationLine = null;
  if (isTMO && md.peer_valuation) {
    const pv = md.peer_valuation;
    const prem = pv.premium_pct;
    const regime = prem == null ? "" : prem < -10 ? " — DISCOUNT TO DHR (BUY)" : prem < 0 ? " — BELOW DHR" : prem < 10 ? " — IN-LINE" : " — PREMIUM (TRIM)";
    tmoPeerValuationLine = `TMO P/E: ${pv.tmo_pe ?? "—"}x | DHR: ${pv.dhr_pe ?? "—"}x | Premium: ${prem != null ? (prem >= 0 ? "+" : "") + prem.toFixed(1) + "%" : "—"}${regime} (trailing — see your search for forward P/E)`;
  }
  let tmoPeerRelativeLine = null;
  if (isTMO && md.peer_relative) {
    const pr = md.peer_relative;
    const dir = pr.relative_spread_pp > 0.5 ? "TMO OUTPERFORMING DHR" : pr.relative_spread_pp < -0.5 ? "DHR OUTPERFORMING TMO (catch-up potential)" : "INLINE";
    tmoPeerRelativeLine = `TMO/DHR 1d spread: ${pr.relative_spread_pp != null ? (pr.relative_spread_pp >= 0 ? "+" : "") + pr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }
  let tmoBiotechLine = null;
  if (isTMO && md.biotech_overlay) {
    const bo = md.biotech_overlay;
    const x30 = bo.xbi_30d_return_pct;
    const x90 = bo.xbi_90d_return_pct;
    const fund = x90 == null ? "" : x90 > 10 ? " (FUNDING THAWING — TMO bookings tailwind ahead)" : x90 < -10 ? " (FUNDING FROZEN — TMO bookings headwind)" : " (mixed funding signal)";
    const sympathy = bo.sympathy_setup_active ? " | SYMPATHY SETUP ACTIVE (TMO+XBI both down — collateral buy)" : "";
    tmoBiotechLine = `XBI: $${bo.xbi_price ?? "—"} (${bo.xbi_change_pct != null ? (bo.xbi_change_pct >= 0 ? "+" : "") + bo.xbi_change_pct + "%" : "—"}) | 30d: ${x30 != null ? (x30 >= 0 ? "+" : "") + x30 + "%" : "—"} | 90d: ${x90 != null ? (x90 >= 0 ? "+" : "") + x90 + "%" : "—"}${fund}${sympathy}`;
  }
  let tmoTacticalExtrasLine = null;
  if (isTMO && md.tactical_extras) {
    const te = md.tactical_extras;
    const tdSpread = te.tmo_vs_dhr_30d_pp;
    const dir = tdSpread == null ? "" : tdSpread > 1 ? " (TMO leading DHR — quality bid)" : tdSpread < -1 ? " (DHR leading TMO — catch-up potential)" : " (inline)";
    tmoTacticalExtrasLine = `TMO 30d: ${te.tmo_30d_return_pct != null ? (te.tmo_30d_return_pct >= 0 ? "+" : "") + te.tmo_30d_return_pct + "%" : "—"} | TMO-DHR 30d Δ: ${tdSpread != null ? (tdSpread >= 0 ? "+" : "") + tdSpread + "pp" : "—"}${dir}`;
  }
  let tmoFactorFlowLine = null;
  if (isTMO && md.factor_flow?.qual_vs_spy_30d_pp != null) {
    const q = md.factor_flow.qual_vs_spy_30d_pp;
    const dir = q > 1 ? "QUALITY BID ACTIVE (TMO benefits)" : q < -1 ? "QUALITY UNDER PRESSURE" : "INLINE";
    tmoFactorFlowLine = `QUAL vs SPY (30d): ${q >= 0 ? "+" : ""}${q.toFixed(1)}pp (${dir})`;
  }
  let tmoDxyLine = null;
  if (isTMO && macro.dxy != null) {
    const dxy = macro.dxy;
    const regime = dxy > 130 ? "VERY STRONG USD (FX HEADWIND)" : dxy > 125 ? "STRONG USD (HEADWIND)" : dxy > 120 ? "NORMAL" : dxy > 115 ? "MILD WEAKNESS (TAILWIND)" : "WEAK USD (TAILWIND)";
    tmoDxyLine = `DXY: ${dxy} (${regime}) — TMO ~40% non-US revenue`;
  }
  let tmoFundamentalsLine = null;
  if (isTMO && md.fundamentals && (md.fundamentals.organic_growth_pct != null || md.fundamentals.bioprocessing_phase != null || md.fundamentals.op_margin_pct != null || md.fundamentals.operating_margin_pct != null || md.fundamentals.fcf_margin_pct != null)) {
    const f = md.fundamentals;
    const og = f.organic_growth_pct != null ? `Organic growth: ${f.organic_growth_pct >= 0 ? "+" : ""}${f.organic_growth_pct.toFixed(1)}%` : null;
    const bp = f.bioprocessing_phase != null ? `Bioproc phase: ${String(f.bioprocessing_phase).toUpperCase()}` : null;
    const om = f.op_margin_pct != null ? `Op margin: ${f.op_margin_pct.toFixed(1)}%` : (f.operating_margin_pct != null ? `Op margin: ${f.operating_margin_pct}%` : null);
    const fcf = f.fcf_margin_pct != null ? `FCF margin: ${f.fcf_margin_pct.toFixed(1)}%` : null;
    const parts = [og, bp, om, fcf].filter(Boolean);
    if (parts.length > 0) tmoFundamentalsLine = `TMO fundamentals: ${parts.join(" | ")}`;
  }
  let tmoEpsRevLine = null;
  if (isTMO && md.fundamentals && (md.fundamentals.eps_revisions_30d_pct != null || md.fundamentals.eps_revisions_90d_pct != null)) {
    const r30 = md.fundamentals.eps_revisions_30d_pct;
    const r90 = md.fundamentals.eps_revisions_90d_pct;
    const dir = r90 == null ? "" : r90 > 1 ? " (UPWARD)" : r90 < -1 ? " (DOWNWARD)" : " (STABLE)";
    tmoEpsRevLine = `EPS revisions: 30d ${r30 != null ? (r30 >= 0 ? "+" : "") + r30.toFixed(1) + "%" : "—"} | 90d ${r90 != null ? (r90 >= 0 ? "+" : "") + r90.toFixed(1) + "%" : "—"}${dir}`;
  }

  const dataLines = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.price?.week52_high ? `52-Week: High $${md.price.week52_high} | Low $${md.price.week52_low} | Position: ${md.price.week52_position_pct}%` : null,
    md.technicals?.rsi14 != null ? `RSI(14): ${md.technicals.rsi14}` : null,
    md.technicals?.sma50 ? `SMA 50: $${md.technicals.sma50} | SMA 200: $${md.technicals.sma200 ?? "N/A"} | Signal: ${md.technicals.ma_signal}` : null,
    ibitExtensionLine, ethaExtensionLine,
    md.valuation?.trailingPE ? `P/E (trailing): ${md.valuation.trailingPE}` : null,
    md.valuation?.priceToBook ? `P/B: ${md.valuation.priceToBook}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
    enbYieldSpreadLine, amkbyGscpiLine, ethaAltSeasonLine, kofMxnLine, glncyCopxLine,
    linPeerValuationLine, linBacklogLine, linFundamentalsLine, linPeerRelativeLine, linDxyLine, linPmiLine,
    linBbbOasLine, linOpsLine, linEpsRevLine, linPeerAipaLine, linPremiumDeltaLine, linH2Line, linTacticalExtrasLine, linRegimeLine,
    msftDrawdownLine, msftCohortValuationLine, msftCohortRelativeLine, msftFactorFlowLine, msftDxyLine, msftFundamentalsLine, msftEpsRevLine,
    lhxDrawdownLine, lhxCohortValuationLine, lhxCohortRelativeLine, lhxFactorFlowLine, lhxFundamentalsLine, lhxEpsRevLine,           // ← V7.5
    tmoDrawdownLine, tmoPeerValuationLine, tmoPeerRelativeLine, tmoBiotechLine, tmoTacticalExtrasLine, tmoFactorFlowLine, tmoDxyLine, tmoFundamentalsLine, tmoEpsRevLine,  // ← V7.5
    (isPBRA && macro.wti != null) ? `WTI crude: $${macro.wti} — PBR.A primary commodity driver` : null,
    (isPBRA && macro.brl_usd != null) ? `BRL/USD: ${macro.brl_usd} (${macro.brl_usd < 5 ? "STRONG REAL" : macro.brl_usd < 5.5 ? "NORMAL" : macro.brl_usd < 6.5 ? "WEAKENING" : "WEAK REAL"})` : null,
    macro.vix ? `VIX: ${macro.vix}` : null,
    macro.us10y ? `10Y: ${macro.us10y}% | 2Y: ${macro.us2y}%${curveStr ? ` | 2s10s curve: ${curveStr}` : ""}` : null,
    macro.tips10y ? `TIPS 10Y (real): ${macro.tips10y}%${realRate != null ? ` | Fed Funds real rate: ${realRate}%` : ""}` : null,
    macro.hy_oas ? `HY OAS credit spread: ${macro.hy_oas}bps` : null,
    isIBIT ? (() => { const p = getIBITPhaseContext(); return `Halving cycle: month ${p.months} post-halving (phase: ${p.phase})`; })() : null,
  ].filter(Boolean).join("\n");

  const cyclicalWarning = isCyclical ? `
CRITICAL — CYCLICAL VALUATION RULES FOR ${h.symbol}:
${h.symbol} is a CYCLICAL business (archetype: ${h.archetype}). Trailing P/E must be interpreted INVERSELY:
• HIGH trailing P/E (>50x) = earnings are at TROUGH = this is a BUY signal, NOT expensive
• LOW trailing P/E (<10x) = earnings are at PEAK = cycle rollover risk = TRIM signal
• "Buy cyclicals when the P/E looks terrible, sell when it looks cheap." — Peter Lynch
• The deterministic engine has already applied inverted PE scoring. Your qualitative score should NOT penalize high trailing P/E for this holding. Instead, consider whether the earnings trough is deepening or recovering.
` : "";

  const ibitGuidance = isIBIT ? `
CRITICAL — IBIT-SPECIFIC SCORING GUIDANCE:
IBIT is a spot Bitcoin ETF. Bitcoin is momentum-dominant, flow-driven, and trades in regimes — NOT like equities.

PHILOSOPHY — CYCLE PHASE IS CONTEXT, NOT A TRIGGER:
• The halving cycle pattern is real but timing is STRETCHING. DO NOT score negatively just because we are "deep in the cycle."
• The deterministic engine uses cycle phase only as a MODIFIER on extension signals. Do not reintroduce calendar-based trim bias.

TRIM BIAS (only through current-condition signals):
• ETF flow DIVERGENCE (inflows decelerating while price rises), LTH supply rapidly distributing, funding rates sustained >0.05% for 7+ days, BTC >2x 200DMA WITH confirming signals.

DO NOT PENALIZE: RSI 70-80, proximity to 52w highs, price above 200DMA alone, months-since-halving reasoning.

BUY BIAS: BTC below 200DMA (more aggressive deeper in cycle), RSI <30, capitulation moves, flows turning positive after drawdown. UPSIDE IS UNCAPPED.

YOUR VALUE-ADD: Flow interpretation, regulatory catalysts, on-chain signals, whether THIS cycle is breaking the 4-year pattern.
` : "";

  const asmlGuidance = isASML ? `
CRITICAL — ASML-SPECIFIC SCORING GUIDANCE:
ASML is a SECULAR GROWTH MONOPOLY — sole EUV supplier. Compounds up-and-to-the-right.
DO NOT PENALIZE: 52w proximity (normal for compounder), RSI 65-75 (normal momentum), trailing P/E 30-42x (normal range), P/B (irrelevant), golden cross MA (default state).
TRIM BIAS (rare): Forward P/E >45x, book-to-bill <1.0, TSMC+Samsung+Intel ALL cutting capex, China revenue collapse.
BUY BIAS (rare but powerful): Drawdown >15% from highs, forward P/E <25x, TSMC rev accelerating + backlog growing, big single-day drops on non-fundamental news.
STRUCTURAL: ~3-5% annual buybacks ("sneaky buyback monster"), High-NA EUV ramp ($350M+/tool), 2-3yr backlog visibility.
YOUR VALUE-ADD: Forward P/E (#1 contribution), TSMC/Samsung/Intel capex commentary, China export controls, WFE cycle position.
MOST DAYS = NEUTRAL (±10). Scores beyond ±15 only on genuine drawdowns or valuation extremes.
` : "";

  const enbGuidance = isENB ? `
CRITICAL — ENB-SPECIFIC SCORING GUIDANCE:
Enbridge is a DIVIDEND COMPOUNDER — midstream pipeline infrastructure that trades like a toll road, NOT like an oil producer. Revenue is largely contracted and fee-based. ENB is a hold-forever income name.

WHAT DRIVES ENB:
1. YIELD SPREAD VS BONDS (#1 measurable signal — engine scores this). >300bps = cheap, <150bps = rich.
2. GAS VOLUMES + LNG BUILDOUT (your value-add). ~25% of EBITDA. LNG Canada Phase 2, Gulf Coast expansion, Henry Hub levels affect drilling/volumes.
3. CRUDE THROUGHPUT (Mainline economics). ~55% of EBITDA. WCS-WTI spread, Canadian production, Trans Mountain dynamics.

DO NOT PENALIZE: 52w proximity, RSI 55-70, P/E 18-24x, "boring" — that IS the thesis.
TRIM BIAS (rare): Yield spread <100bps, dividend cut risk, structural pipeline obsolescence. Mainly opportunity cost.
BUY BIAS: Yield spread >300bps, 10Y spike causing sympathetic drop, ENB yield in top quartile of 5yr range, rate cuts starting, LNG export expansion.

YOUR VALUE-ADD: Henry Hub gas volume outlook, LNG Canada Phase 2 progress, WCS-WTI spread, pipeline permitting, Fed/BoC rate commentary, dividend growth sustainability, CAD/USD impact.
MOST DAYS NEUTRAL: ±5 roughly 85% of trading days. Meaningful scores on rate overreaction or yield extremes.
` : "";

  const amkbyGuidance = isAMKBY ? `
CRITICAL — AMKBY-SPECIFIC SCORING GUIDANCE:
Maersk is a CYCLICAL TRADE BELLWETHER. INVERTED P/E. Shipping cycles MORE EXTREME than commodities: PE 2-5x = peak (trim), PE 6-12x = mid, PE 15-25x = below-trend, PE 50+ = trough buy. P/B matters (asset-heavy fleet): <0.7 = below replacement = strong buy. Engine scores both with enhanced weights.

YOUR PRIMARY VALUE-ADD — FREIGHT RATES AND TRADE VOLUMES:
Engine has NO freight rate data (WCI, SCFI, BDI paywalled). Search for: Drewry WCI / SCFI rates and trend, BDI, CPB World Trade Monitor, Red Sea/Suez disruptions, tariff/trade war impacts, sustainability of rate levels.

SUM-OF-PARTS:
Market often prices logistics segment at ZERO during freight troughs. Logistics implied EV/EBITDA vs DSV (~20x), Kuehne+Nagel (~15-20x). <5x peer = structural undervaluation.

GSCPI CONTEXT: >1.5 = supply chain stress, <-0.5 = calm markets.
SCORES MORE VOLATILE: ±15-25 during active freight markets.
` : "";

  const ethaGuidance = isETHA ? `
CRITICAL — ETHA-SPECIFIC SCORING GUIDANCE:
ETHA is a spot Ethereum ETF. ETH runs 1.3-1.5x BTC's vol, further out on risk curve. No halving cycle, no "digital gold" thesis, no meaningful valuation metrics.

DRIVERS: BTC direction (0.85-0.95 correlation), risk appetite (VIX/HY OAS/real rates), ETH/BTC ratio (alt-season).
DO NOT PENALIZE: RSI 70-80, 52w proximity, P/E/P/B/yield (meaningless), golden cross MA.
YOUR VALUE-ADD: DeFi/L2 TVL growth, regulatory catalysts (SEC staking ETFs), network upgrades (Pectra/Dencun), Solana competitive threat, BTC→ETH rotation legs, ETHA flow dynamics.
SCORES: ±15-20 during active crypto markets.
` : "";

  const kofGuidance = isKOF ? `
CRITICAL — KOF-SPECIFIC SCORING GUIDANCE:
KOF is Coca-Cola FEMSA, largest Coke bottler in LatAm, ~60% Mexico revenue. Consumer staples compounder. Trades as USD ADR but earns in MXN/BRL/COP.

#1 DRIVER: MXN/USD (engine scores level). Strong peso = ADR rises. Weak peso = falls. Your job: assess direction.
DO NOT PENALIZE: 52w proximity, RSI 50-65, P/E 15-22x.
YOUR VALUE-ADD: Mexican consumer trends, Banxico rate decisions, nearshoring impact, sugar/PET costs, geographic volume mix, KO parent guidance, vs Arca Continental, dividend growth.
MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on MXN regime shifts, EM selloffs, margin surprises, Banxico pivots.
` : "";

  const glncyGuidance = isGLNCY ? `
CRITICAL — GLNCY-SPECIFIC SCORING GUIDANCE:
Glencore is DIVERSIFIED COMMODITY TRADER (mining copper 30% / coal 25% / zinc-nickel-cobalt + trading arm). INVERTED P/E with trading-arm floor ($2-4B EBITDA in troughs). PE 6-20x mid, PE 40+ trough buy, PE 3-6x peak trim. P/B <0.8 = below replacement = strong buy.

YOUR VALUE-ADD — COPPER + COMMODITIES:
Engine has COPX proxy, no direct LME copper. Search for: LME copper price/trend (~30% of mining EBITDA lead indicator), LME copper inventories, Chinese PMI/property, zinc/nickel/cobalt prices, coal price + ESG dynamics, DXY direction.

SUM-OF-PARTS: Trading arm should trade 8-12x ($2-4B EBITDA on minimal capital). Market often prices at zero in troughs.
COPX RATIO: COPX leading = pure copper leading, GLNCY may catch up. GLNCY leading = trading arm getting credit.
SCORES: ±10-20 during active commodity markets.
` : "";

  const pbraGuidance = isPBRA ? `
CRITICAL — PBR.A-SPECIFIC SCORING GUIDANCE:
PBR.A is Petrobras — Brazil's state-controlled oil giant. THREE forces simultaneously: oil price, BRL/USD, political risk. Can conflict.

DRIVERS (in order):
1. OIL PRICE (engine scores WTI). High beta. Assess OPEC+ dynamics, demand outlook, inventories.
2. POLITICAL RISK (#1 YOUR VALUE-ADD). Lula government interference dominant idiosyncratic risk. CEO changes, fuel pricing violations, forced refining capex, dividend pressure. Single headline = 5-10% move.
3. BRL/USD. Engine scores level. Banxico/BCB policy, fiscal trajectory, carry trade.

CYCLICAL P/E: INVERTED. PE 3-5x peak = trim. PE 8-15x mid. PE 25-50x trough = buy. Pre-salt breakeven ~$35/bbl.
DIVIDEND YIELD: 10-15% is NORMAL — IS the thesis. Engine has enhanced bands (8-18%+). Assess sustainability.

YOUR VALUE-ADD: Government interference risk, dividend policy sustainability, pre-salt production trajectory, Brent-WTI spread, Brazilian fiscal situation, IOC peer comparison, refining margins / fuel pricing compliance.
SCORES: ±15-25 during active oil/political markets. Political crisis + oil crash = potential STRONG_BUY (-40+).
` : "";

  const linGuidance = isLIN ? `
CRITICAL — LIN-SPECIFIC SCORING GUIDANCE (V3):
LIN is Linde plc — world's #1 industrial gas company in a 3-player oligopoly with Air Products (APD) and Air Liquide (AI.PA). Quality compounder, 30+ year Dividend Aristocrat, ~30% on-site take-or-pay contracts with inflation pass-through. Best-in-class operator: ROCE >25%, operating margin >30%.

V3 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
The deterministic engine now scores all of the following quantitatively. If you agree with the quant's score on a layer, return a similar number — your job is what numbers can't capture, not to repeat them.
• Peer P/E premium vs APD/AI.PA + 6M delta direction (engine treats compression as buy bias)
• ROCE durability + operating margin trend
• ASU capacity utilization (THE core operational metric for industrial gas — high util = pricing power)
• Like-for-like price/mix ex-FX (replaces categorical moat checks — actual moat measurement)
• EPS estimate revisions trend (30d / 90d, FactSet/Refinitiv consensus delta)
• BBB OAS credit spread + 1m change (leads backlog 6-12mo via project-sanctioning IRR math)
• IV/RV compression (catalyst-hunt setup) and QUAL factor flow vs SPY
• Deterministic growth-scare amplifier (SPY 10d drawdown + LIN outperformance)
• H2 layer concrete metrics: contract dollar value 90d trailing, subsidy regime, green/grey LCOE gap + 6m direction
• Triangulated peer-relative — LIN vs APD AND AI.PA spreads both scored
• DXY FX overlay (LIN ~70% non-US revenue)
• Geo-weighted PMI composite (40/30/30 Americas/EMEA/APAC) drives REGIME-CONDITIONAL composite weights:
  - Expansion (PMI >55): 25/40/35 — tilt toward operating leverage
  - Neutral (PMI 48-55): 20/35/45 — default compounder weights
  - Contraction (PMI <48): 15/30/55 — tilt toward valuation re-rating
  See "Active regime" line in market data above — interpret in line with the live regime.

WHAT DRIVES LIN (in order of importance):
1. PEER VALUATION DISCIPLINE: LIN trades at a premium to APD/AI.PA because it deserves one (highest ROCE, best margins, most contracted revenue). The cleanest valuation signal is the premium spread + its 6M direction. Engine scores both. If you agree, return similar.
2. STRUCTURAL TAILWINDS — multi-year compounding drivers (THIS IS YOUR PRIMARY VALUE-ADD):
   • Hydrogen economy buildout: LIN is the global #1 H2 producer (blue + green). Mega-project announcements (>$1B) are major catalysts. Watch IRA 45V tax credit guidance, EU H2 Bank auctions, customer offtake agreements (steel, ammonia, refining). Engine sees the contract $ — you assess offtake quality and policy momentum.
   • Decarbonization capex: CCUS deployments, customer Net Zero commitments driving demand for industrial gas in carbon capture chains.
   • Semi fab buildouts: Specialty gases (neon, helium, ultra-high-purity nitrogen, argon) for TSMC Arizona, Samsung Texas, Intel Ohio, Micron New York. Each fab = multi-year on-site contract.
3. BACKLOG GROWTH: Sale-of-gas + on-site project pipeline, reported quarterly. Leading indicator — earnings lag 2-4 quarters. Engine scores YoY growth.

WHAT NOT TO PENALIZE:
• Proximity to 52-week highs — normal state for a compounder
• RSI 60-70 — normal range for low-volatility quality stock (LIN daily moves typically 0.5-1.5%, engine has tightened band 35/70)
• Trailing P/E 26-32x — normal compounder range
• P/B (high due to Praxair merger goodwill — the metric is uninformative for LIN)
• Premium to APD/AI.PA in the 5-15% range — that IS the quality moat being priced
• Active regime context: don't fight the regime weights. If engine is in CONTRACTION mode (defensive bid), structural strategic signals matter more than tactical noise.

WHAT EARNS BUY BIAS (in addition to engine signals):
• Mega-scale hydrogen project announcement (LNG-equivalent industrial gas project win — engine sees the contract $ but not the strategic significance)
• Semi capex super-cycle confirmation (multiple fab announcements in same quarter)
• IRA 45V or EU H2 Bank tightening interpretation that broadens green H2 economics
• Earnings beat with backlog acceleration vs consensus (the engine sees the metric, not the surprise)
• Defensive bid setup confirmation: engine flags growth-scare via SPY/LIN 10D math; you confirm it's macro-driven not LIN-specific

WHAT EARNS TRIM BIAS (in addition to engine signals):
• Mega-cap rotation away from quality (engine sees QUAL flow direction; you confirm narrative)
• Capital misallocation news: large value-destroying M&A
• Backlog growth turning negative + margins compressing simultaneously (multi-engine signals confirming)
• ROCE slipping below 22% with structural cause (moat erosion, not just timing)
• Price/mix ex-FX going negative (engine flags moat erosion risk; you assess durability)

YOUR VALUE-ADD FOR LIN (REFOCUSED):
With the engine scoring 30+ data points, your job is qualitative interpretation of what numbers can't capture:
• Mega-project announcements: H2 plant wins >$1B (each is a multi-day move catalyst), LNG ammonia offtake commitments, semi fab on-site contracts (e.g., TSMC Arizona, Samsung Texas, Intel Ohio, Micron NY)
• Regulatory implementation specifics: IRA 45V tax credit guidance evolution, EU H2 Bank auction outcomes, JP/KR Contracts-for-Difference structure
• Customer offtake quality: who is signing? Steel? Ammonia? Refining? Government-backed or private? Take-or-pay vs spot?
• Capital allocation pivots: special dividend signals, large M&A (cylinder business in EM, healthcare gases), buyback acceleration beyond ~3-4% baseline
• Earnings beats/misses with backlog inflection — the engine sees the metric, not the surprise vs consensus
• Specialty gas dynamics: helium scarcity pricing, neon supply (Ukraine pre-war was 50% global), rare-gas margins
• Competitive moves: APD's reset under new CEO, AI.PA's regional strategy
• China export-control impact on global semi capex flow (and thus on-site contract pipeline)

MOST DAYS SHOULD BE NEUTRAL:
LIN is a quality compounder with low daily vol. Composite scores between -5 and +5 roughly 80% of trading days. Meaningful scores appear during: peer premium dislocations (engine flags), H2 mega-project announcements (you flag), regulatory pivots (you flag), or earnings beats/misses with backlog inflection.
` : "";

  const msftGuidance = isMSFT ? `
CRITICAL — MSFT-SPECIFIC SCORING GUIDANCE (V1):
MSFT is Microsoft — AI infrastructure quality compounder. HYBRID archetype: LIN-like quality compounder + ASML-like secular growth + SPY-like rate sensitivity. Best-in-class operating margins (~44%), Azure as primary AI infrastructure beneficiary, OpenAI partnership as proprietary distribution moat, ~10% buyback yield baseline.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/65 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>12% setup, >20% strong, >25% rare conviction)
• Cohort rotation pressure vs GOOGL/META/AAPL avg 30d (capital flowing to higher-beta AI is a BUY setup, not a warning)
• QUAL factor flow vs SPY (mechanical quality bid)
• Compounder MA + 52w (no penalty at golden cross or near highs)
• Cohort P/E premium vs GOOGL/META/AAPL (TRAILING P/E via Finnhub free tier)
• TIPS + DXY overlays (long-duration rate sensitivity + ~50% non-US revenue)
• Static composite weights 20/35/45 — NO regime conditioning in v1

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E and PE-vs-3Y/5Y-history. If forward P/E tells a different story than trailing (trailing 25x looks cheap but forward 32x is rich on decelerating growth), call that out clearly.

WHAT DRIVES MSFT:
1. AZURE CC GROWTH TRAJECTORY (central operational metric). Acceleration (>30%) confirms AI thesis; deceleration (<22%) is headwind. LLM sources via web search.
2. AI CYCLE PHASE — secular growth at risk of expectation reset:
   • Hyperscaler peer capex discipline (GOOGL/META/AMZN). MSFT alone holds while peers raise = discipline signal. MSFT raises while peers hold = commitment risk.
   • OpenAI partnership status: governance, IP/access, AGI clauses, exclusivity. Single headlines = 3-5% moves.
   • Copilot monetization: revenue/seat × adoption. Slow seat growth = AI thesis air-pocket.
3. COHORT ROTATION DYNAMIC: When engine flags rotation_pressure_active = TRUE (capital rotating MSFT→NVDA/PLTR/AMD), historically a BUY setup, not a warning. Don't fight engine; reinforce buy bias.
4. FX: ~50% non-US revenue. Engine scores DXY.

DO NOT PENALIZE: 52w proximity, RSI 60-70, P/E 27-33x, P/B (Activision goodwill), cohort premium 0-15% (deserved quality moat), capex YoY 25-50% (AI infrastructure investment cycle).

BUY BIAS (in addition to engine signals): Azure CC re-acceleration (you flag broad vs single-deal), hyperscaler capex discipline confirmation (peers cutting / MSFT holding), OpenAI deal favorable renegotiation, Copilot adoption inflection (>50% seat YoY at >$30/seat ASP), forward P/E compressing toward 25x with Azure intact, cohort discount to GOOGL/META, defensive rotation setup (VIX elevated + MSFT lagging cohort).

TRIM BIAS: Azure CC decel to <22% with no catalyst, capex blowout with ROI questions (80%+ YoY + margin compression + no Azure accel = thesis impairment), OpenAI partnership unwind risk, forward P/E >35x with cohort premium >20%, Copilot monetization stalling.

YOUR VALUE-ADD: Forward P/E vs trailing + PE-vs-3Y/5Y/10Y, Azure CC narrative (broad vs concentrated, AI-driven vs core IaaS), hyperscaler peer capex direction, OpenAI partnership status (exclusivity/governance/IP/AGI), Copilot enterprise traction (seats/ASP/retention/verticals), earnings surprise on Azure CC specifically, AI cycle phase, FTC/EU regulatory, BUILD conference / FY guidance / large enterprise deals.

MOST DAYS NEUTRAL: ±5 roughly 80% of days. Meaningful scores on cohort rotation extremes (engine flags), drawdown setups (engine flags), Azure quarterly (you flag), OpenAI/regulatory (you flag), AI cycle inflection (you flag).
` : "";

  const lhxGuidance = isLHX ? `
CRITICAL — LHX-SPECIFIC SCORING GUIDANCE (V1):
LHX is L3Harris Technologies — defense prime backlog compounder. HYBRID archetype: LIN-like quality compounder + ASML-like secular DoD capex cycle + geopolitical regime overlay. Smallest of the "Big 5" US defense primes (LMT/RTX/NOC/GD/LHX), historically discounted 5-15% to cohort — cohort compression is the central re-rating thesis. Aerojet Rocketdyne SRM-duopoly position post-2023 acquisition.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (40/70 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>10% setup, >18% strong)
• Cohort rotation pressure vs LMT/NOC/RTX/GD avg 30d (LHX lagging by >5pp = capital flowing to larger primes = BUY setup, not warning)
• ITA factor flow vs SPY (>1pp/30d = defense bid active = positional positive)
• Compounder MA + 52w (no penalty at golden cross or near highs)
• Cohort P/E premium vs LMT/NOC/RTX/GD (TRAILING P/E via Finnhub free tier)
• Static composite weights 20/40/40 — positional+strategic co-equal (backlog forward visibility + DoD budget structural drivers)

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary valuation contribution is FORWARD P/E and PE-vs-3Y-history. Defense-prime cohort: forward PE 18-22x typical, LHX -5 to -15% discount historically. Cohort discount widening past -10% = above-norm buy. Positive premium = rare = trim.

WHAT DRIVES LHX:
1. BOOK-TO-BILL + BACKLOG: THE operational metric (equivalent to Azure CC for MSFT, ASU util for LIN). B/B >1.10 = accelerating (strong positional buy), 1.00-1.10 = healthy, <0.95 = backlog shrinking (thesis risk). Backlog YoY >8% = expansion, <0% = erosion. Search for: latest LHX earnings call B/B disclosure, backlog dollar value YoY delta.
2. DOD BUDGET CYCLE PHASE: Categorical (expansion / flat / cr_uncertainty / sequester_risk). FY27 NDAA progress, continuing resolution risk, supplemental funding flow (Ukraine/Israel/Taiwan packages), budget caps, sequester triggers. Real expansion = multi-year tailwind. Sequester risk = headwind.
3. GEOPOLITICAL REGIME PHASE: Categorical (great_power_competition / regional_conflict / transition / peace_dividend). Sustained great-power competition + regional conflicts = multi-year tailwind. Peace dividend = structural drawdown phase.
4. AEROJET ROCKETDYNE INTEGRATION: SRM duopoly with NOC. Track integration progress, margin contribution, propellant supply chain. Catalyst/risk only — not a scored field.
5. DEFENSE-INDUSTRIAL SUPPLY CHAIN: Titanium, semis, propellant — gating constraints on margin expansion.
6. EPS REVISIONS: 30d/60d/90d trend is cleanest positional factor. >+1% 90d = tailwind. <-1% = headwind.

DO NOT PENALIZE: 52w proximity, RSI 50-70 (low-vol prime), trailing P/E 22-28x, cohort DISCOUNT in -5 to -15% range (historical norm — smallest prime trades at discount), op margin 14-16%, ITA leading SPY by 1-2pp (defense sector outperformance is structural tailwind environment).

BUY BIAS: B/B re-accelerating off a low, major program win (F-35 mission systems, NGAD/6th-gen, Golden Dome, ISR, Aerojet propellant — single multi-billion award = multi-day move), DoD budget moving to real expansion (NDAA passage, supplemental approval, lifted caps), geopolitical regime sustained at great_power_competition / regional_conflict, cohort discount widening past -10% without thesis break, EPS revisions turning upward, ITA leading SPY by >2pp/30d, drawdown >10% on macro noise + cohort rotation active.

TRIM BIAS: B/B <0.95 with backlog YoY negative, DoD budget to sequester_risk / cr_uncertainty, regime shifting to peace_dividend / transition, op margin <13% with supply-chain root cause, LHX premium to cohort (rare — mean-reversion ahead), forward P/E >23x or PE >115% of 3y avg, Aerojet integration faltering.

YOUR VALUE-ADD: Forward P/E + PE-vs-3Y (engine trailing only), B/B + backlog YoY (engine null — earnings call), op/FCF margin trend + EPS revs (engine null), DoD budget reading (NDAA progress, CR risk, supplemental, sequester probability, BCA dynamics), geopolitical regime reading (great power durability, conflict escalation/de-escalation, NATO 2%+), major program awards, Aerojet integration + propellant supply chain, supply chain constraints (titanium/semis/energetics/rare earths), Dividend Aristocrat-track growth.

MOST DAYS NEUTRAL: ±5 roughly 75% of days. Meaningful scores on cohort rotation extremes (engine flags), drawdown setups (engine flags), DoD budget moments (you flag), geopolitical shifts (you flag), program/earnings catalysts (you flag).
` : "";

  const tmoGuidance = isTMO ? `
CRITICAL — TMO-SPECIFIC SCORING GUIDANCE (V1):
TMO is Thermo Fisher Scientific — life-sciences picks-and-shovels supplier ("ASML of life sciences"). HYBRID archetype: LIN-like quality compounder + ASML-like secular monopoly + cyclical end-market exposure (bioprocessing, biotech funding, China capex). Currently in cycle-inflection territory: bioprocessing destocking ending, biotech funding thawing, COVID comps fully lapped. Strategic dominates (45%) because the thesis right now is multiple reset + cycle bottoming.

V1 ENGINE COVERAGE — DO NOT DOUBLE-COUNT THESE:
• RSI tightened bands (35/70 — compounder, not single-stock generic)
• Drawdown-from-52w-high primary tactical (>15% setup, >25% strong conviction)
• Peer valuation: TMO vs DHR trailing P/E (TRAILING via Finnhub free tier)
• Peer relative: TMO vs DHR daily return spread (sympathy read)
• Biotech overlay: XBI 30d/90d (90d leads TMO bookings 2-3 quarters)
• Biotech sympathy detection: TMO + XBI both down meaningfully (tactical buy setup)
• QUAL factor flow vs SPY (same data signal as LIN/MSFT)
• Compounder MA + 52w, DXY overlay (~40% non-US revenue)
• Static composite weights 20/35/45 — NO regime conditioning in v1

IMPORTANT — TRAILING vs FORWARD P/E:
Engine uses TRAILING P/E. YOUR primary contribution is FORWARD P/E and PE-vs-5Y-history. TMO forward PE: <20x exceptional, 22-25x fair, >28x stretched. PE <85% of 5y avg = own-history buy zone.

WHAT DRIVES TMO:
1. BIOPROCESSING CYCLE PHASE (THE operational metric, categorical): destocking → bottoming → early_recovery → expansion → peak. Q1 2026 print at ~1% organic growth is the trough. Watch re-acceleration to 5%+ for cycle confirmation.
2. PEER TRIANGULATION — DHR, SARTORIUS, REPLIGEN: All three commentary same direction = high-conviction cycle read. All destocking = contrarian late-trough buy. All recovering = cycle confirmation buy.
3. XBI 90D RETURN: Biotech funding sentiment leads TMO bookings 2-3Q. >+10% = thawing (tailwind). <-10% = frozen (headwind). IPO activity, M&A deals, GLP-1 disruption narrative impact on biotech sentiment.
4. CHINA LIFE SCIENCES CAPEX + NIH FUNDING: Policy overlays. China stabilizing/expanding + NIH growing = positive. China collapse / NIH cuts = headwind.
5. WAVE 4 AI LIFE SCIENCES: Bioproduction for AI-discovered biologics, mass spec/sequencers for AI research, lab automation. Categorical v1 — qualitative read on activation.

DO NOT PENALIZE: 52w proximity (not relevant near-term given ~15-25% drawdown), RSI 50-65, trailing P/E 22-30x, P/B (PPD goodwill), bioprocessing destocking by itself (late-trough setup), organic growth at 1% trough (cycle bottom you're buying ahead of).

BUY BIAS: Biotech sympathy ACTIVE (engine flags TMO+XBI both down — collateral damage), cycle phase destocking→bottoming or bottoming→early_recovery, DHR+Sartorius+Repligen all destocking simultaneously (late-trough — engine null, you source from earnings), organic growth re-acceleration off 1% trough toward 5%+, XBI 90d turning positive after extended freeze, forward P/E compressing toward 20x with growth re-accel, Wave 4 AI activation (major AI biologics bioproduction wins), defensive setup (QUAL leading SPY + TMO catches quality bid).

TRIM BIAS: Cycle moving toward peak (expansion→peak), organic growth at peak (>10%) with multiple already expanded, forward P/E >28x with growth decel, China capex collapse + NIH cuts simultaneously, major PPD competitive loss, generic profit-taking when other names flash deeper buy signals.

YOUR VALUE-ADD: Forward P/E + PE-vs-5Y, bioprocessing cycle phase (engine null — TMO earnings + DHR/Sartorius/Repligen triangulation), organic growth trajectory off trough (engine null — latest quarter print), peer commentary, op/FCF margin + EPS revs (engine null), China direction + NIH outlook, PPD competitive position, Wave 4 activation status, GLP-1 disruption to diagnostics/lab volumes, catalysts (earnings, peer reads, M&A, regulatory, China policy).

MOST DAYS NEUTRAL — BUT CURRENT DRAWDOWN TILTS BUY: ±5 roughly 75% of days under normal conditions. CURRENT context (~15-25% drawdown + bioprocessing trough) = high-conviction buy SETUP zone — expect scores tilted negative (buy) until cycle confirmation drives multiple expansion.
` : "";

  const calibrationBlock = buildCalibrationBlock(h.symbol, CALIBRATION, md.price?.current);
  const confidence = computeConfidence(MARKET_DATA, h.symbol);
  const confidenceNote = confidence.level === "low"
    ? `\n⚠️ DATA CONFIDENCE: LOW (${confidence.score}%). Missing: ${confidence.missing.join(", ")}. Lean toward NEUTRAL when data is incomplete.\n`
    : confidence.level === "medium"
    ? `\nDATA CONFIDENCE: MEDIUM (${confidence.score}%). Missing: ${confidence.missing.join(", ")}. Exercise caution in extreme scores.\n`
    : "";

  return `You are a qualitative analyst providing the JUDGMENT half of a hybrid scoring system for ${h.symbol}.

A deterministic engine has already scored the quantitative data:
  Tactical (quant): ${detScores.tactical.score} — ${detScores.tactical.notes.join(", ")}
  Positional (quant): ${detScores.positional.score} — ${detScores.positional.notes.join(", ")}
  Strategic (quant): ${detScores.strategic.score} — ${detScores.strategic.notes.join(", ")}

Your job: provide YOUR OWN independent scores considering what numbers CANNOT capture:
• Sector trends, competitive dynamics, catalysts, management quality
• Macro regime interpretation (is VIX elevated for good reason?)
• Whether the technical signals are "right" in current context
• News, geopolitical factors, earnings trajectory
${cyclicalWarning}${ibitGuidance}${asmlGuidance}${enbGuidance}${amkbyGuidance}${ethaGuidance}${kofGuidance}${glncyGuidance}${pbraGuidance}${linGuidance}${msftGuidance}${lhxGuidance}${tmoGuidance}${confidenceNote}${calibrationBlock}
SCORING RULES:
• Scores: -100 (max buy) to +100 (max sell). ZERO = no edge.
• Your scores will be BLENDED 50/50 with the deterministic scores above.
• If you agree with the quant score, return a similar number. If you disagree, explain why.
• NEUTRAL (0) is correct when you have no qualitative edge to add.
• Signals: ≤-60 STRONG_BUY, -59 to -25 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.

MARKET DATA:
${dataLines}

MANDATORY: Every string field must have substantive text. No empty strings.
• rationale: explain your qualitative reasoning with specifics.
• summary: 1-2 sentences on overall thesis including both quant and your judgment.
• key_metric: the single most telling data point for this holding right now.
• risks/catalysts: at least 2 real items each.

Return ONLY valid JSON (no markdown):
${JSON_TEMPLATE(h.symbol)}

Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.`;
}

// Web search prompt for symbols with insufficient data
function buildSearchPrompt(h) {
  const isCyclical = CYCLICAL_ARCHETYPES.has(h.archetype);
  const isIBIT = h.archetype === "momentum_store_of_value";
  const isASML = h.archetype === "secular_growth_monopoly";
  const isENB = h.archetype === "dividend_compounder";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isETHA = h.archetype === "high_beta_crypto";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";
  const isPBRA = h.archetype === "em_state_oil_dividend";
  const isLIN = h.archetype === "oligopoly_quality_compounder";
  const isMSFT = h.archetype === "ai_infra_quality_compounder";
  const isLHX = h.archetype === "defense_prime_backlog_compounder";       // ← V7.5
  const isTMO = h.archetype === "life_sciences_quality_compounder";       // ← V7.5
  const md = MARKET_DATA[h.symbol] || {};

  const cyclicalWarning = isCyclical ? `\nCRITICAL — CYCLICAL VALUATION: ${h.symbol} is a cyclical business. High trailing P/E means earnings are at TROUGH — this is a BUY signal, not a sell signal. Low P/E means peak earnings and cycle rollover risk. Do NOT penalize high trailing P/E for cyclicals.\n` : "";

  const ibitGuidance = isIBIT ? `\nCRITICAL — IBIT SCORING: Bitcoin is momentum-dominant and flow-driven. Cycle phase is context, NOT a trim trigger. Do NOT penalize proximity to 52w highs or "late-cycle" timing. Real trim signals: flow divergence, LTH distribution, extreme 200DMA extension. RSI 70-80 is normal BTC momentum. Upside uncapped. Buy weakness harder deeper in cycle.\n` : "";

  const asmlGuidance = isASML ? `\nCRITICAL — ASML SCORING: Secular growth monopoly (sole EUV supplier). Do NOT penalize 52w proximity or RSI 65-75. Trailing P/E 30-42x is NORMAL. Buy signals: drawdowns >15%. Trim signals: forward P/E >45x, book-to-bill <1.0. Buybacks ~3-5% annual. Most days = NEUTRAL.\n` : "";

  const enbGuidance = isENB ? `\nCRITICAL — ENB SCORING: Dividend compounder / toll-road infrastructure — NOT an oil producer. Do NOT penalize 52w proximity or RSI 55-70 (normal for yield stock). P/E 18-24x is NORMAL. The #1 signal is yield spread vs US 10Y (>300bps = buy, <150bps = rich). ENB is a hold-forever income name — trim is rare and mainly opportunity cost. Search for: ENB dividend yield vs 10Y spread, rate outlook, LNG Canada buildout, WCS-WTI spread, pipeline permitting, dividend growth guidance. Gas volumes and LNG export buildout are real earnings drivers (not just "noise").\n` : "";

  const amkbyGuidance = isAMKBY ? `\nCRITICAL — AMKBY SCORING: Cyclical trade bellwether (world's largest container shipping). INVERTED P/E applies — high PE = trough = BUY, low PE = peak = TRIM. Shipping cycles are more extreme than commodities: PE 2-5x = peak, PE 50+ = trough. P/B matters (asset-heavy fleet): P/B <0.7 = below replacement cost = strong buy. Search for: WCI/SCFI container freight rates (THE primary signal), BDI, global trade volumes, Red Sea/Suez disruptions, Maersk logistics vs DSV/Kuehne+Nagel valuation gap, tariff/trade war impacts. Scores can be ±15 to ±25 during active freight markets.\n` : "";

  const ethaGuidance = isETHA ? `\nCRITICAL — ETHA SCORING: Spot Ethereum ETF. ETH runs at 1.3-1.5x BTC's volatility, further out on risk curve. Do NOT penalize RSI 70-80 or 52w proximity. P/E, P/B, yield are all MEANINGLESS for crypto. Key drivers: BTC direction (0.85-0.95 correlation), risk appetite (VIX/HY OAS), and ETH/BTC ratio (alt-season indicator). Search for: ETH/BTC ratio trend, ETF flow data, DeFi TVL trends, L2 ecosystem growth, regulatory stance on ETH, network upgrades, competitive L1 threats (Solana). Scores can be ±15-20 during active crypto markets.\n` : "";

  const kofGuidance = isKOF ? `\nCRITICAL — KOF SCORING: Coca-Cola FEMSA, largest Coke bottler in LatAm. Consumer staples compounder. Do NOT penalize 52w proximity or RSI 50-65 (normal for staples). P/E 15-22x is NORMAL. The #1 non-fundamental driver is MXN/USD — KOF earns ~60% in MXN. Strong peso = ADR tailwind, weak peso = headwind. Search for: MXN/USD direction, Banxico rate decisions, Mexican consumer spending, retail sales, nearshoring impact on peso, sugar/PET resin costs, volume growth by geography, dividend growth trajectory. Most days = NEUTRAL.\n` : "";

  const glncyGuidance = isGLNCY ? `\nCRITICAL — GLNCY SCORING: Diversified commodity trader (mining: copper 30%, coal 25%, zinc/nickel/cobalt + trading/marketing arm). INVERTED P/E applies but with higher floor than pure cyclicals (trading arm generates $2-4B EBITDA even in troughs). P/B matters (mining assets = replacement cost): P/B <0.8 = strong buy. Search for: LME copper price and trend (THE lead indicator), copper inventories, Chinese PMI/property, zinc/nickel/cobalt prices, coal price + ESG pressure, DXY direction, Glencore trading arm valuation (market often prices at zero). Scores ±10-20 during active commodity markets.\n` : "";

  const pbraGuidance = isPBRA ? `\nCRITICAL — PBR.A SCORING: Petrobras, Brazil state-controlled oil. INVERTED P/E (oil producer cyclical). Three forces: oil price (WTI/Brent), BRL/USD, and POLITICAL RISK (the #1 idiosyncratic factor). Yield 10-15% is NORMAL — the thesis IS the massive yield as compensation for state risk. Search for: WTI/Brent price and OPEC outlook, Lula government interference (CEO changes, fuel pricing, dividend pressure), BRL/USD direction, pre-salt production, dividend sustainability, refining margins. Political crisis + oil crash = potential STRONG_BUY. Scores ±15-25 during active oil/political markets.\n` : "";

  const linGuidance = isLIN ? `\nCRITICAL — LIN SCORING (V3): Linde plc, world's #1 industrial gas company in 3-player oligopoly (LIN/APD/AI.PA). Quality compounder, 30+ year Dividend Aristocrat, ROCE >25%, op margin >30%. Do NOT penalize 52w proximity, RSI 60-70, P/E 26-32x, or peer premium 5-15% — all normal for low-vol best-in-class compounder. Composite weights are regime-conditional on geo-weighted PMI (>55: 25/40/35 expansion · 48-55: 20/35/45 neutral · <48: 15/30/55 contraction). Cleanest valuation signal is P/E premium vs APD+AI.PA peer avg with 6M direction (compressing = buy bias even if level is normal). Search for: LIN P/E vs APD and Air Liquide (current + 6mo ago), ASU capacity utilization disclosed in earnings, like-for-like price/mix ex-FX from segment reporting, BBB OAS credit spread (FRED BAMLC0A4CBBB), EPS revisions from FactSet/Refinitiv, hydrogen project pipeline (LIN is global H2 leader, IRA 45V tax credits, EU H2 Bank auctions, contracts $ trailing 90d), green/grey LCOE gap (current + 6mo ago), semi fab capex (TSMC Arizona, Samsung Texas, Intel Ohio, Micron NY drive on-site contracts), decarbonization/CCUS deployments, backlog growth (sale-of-gas + on-site, leading indicator), DXY direction (~70% non-US revenue), QUAL ETF performance vs SPY (30d). Most days = NEUTRAL. Meaningful scores: peer premium dislocations, growth-scare drag-downs, mega-project wins, regulatory pivots.\n` : "";

  const msftGuidance = isMSFT ? `\nCRITICAL — MSFT SCORING (V1): Microsoft, AI infrastructure quality compounder. HYBRID archetype: LIN-like quality + ASML-like secular growth + SPY-like rate sensitivity. Best-in-class op margins (~44%), Azure as primary AI infrastructure beneficiary, OpenAI partnership as proprietary distribution moat. Do NOT penalize 52w proximity, RSI 60-70, P/E 27-33x, or cohort premium 0-15% (vs GOOGL/META/AAPL — that's the deserved quality premium). Static composite weights 20/35/45 (no regime conditioning in v1). PRIMARY SIGNALS: cohort P/E premium vs mega-cap quality peers + drawdown-from-52w-high (>12% setup, >20% strong, >25% rare conviction). Cohort rotation pressure (MSFT lagging GOOGL/META/AAPL avg 30d) is a BUY setup, not a warning — quality compounder catches the rotation back. Engine has TRAILING P/E only (Finnhub free tier); your forward P/E + PE-vs-history is critical. Search for: MSFT forward P/E vs trailing, MSFT P/E percentile vs 3y/5y/10y average, Azure constant-currency growth (latest quarter and trend — central operational metric, acceleration >28% confirms AI thesis, deceleration <22% is headwind), hyperscaler peer capex direction (GOOGL/META/AMZN), OpenAI partnership status (governance, IP, exclusivity, AGI clauses), Copilot enterprise adoption (seat count, ASP, retention), capex YoY growth + FCF margin compression, EPS revisions trend (FactSet/Refinitiv), DXY direction (~50% non-US revenue), QUAL ETF performance vs SPY (30d). Most days = NEUTRAL. Meaningful scores: drawdown-from-high setups, cohort rotation extremes, Azure inflection, OpenAI/regulatory headlines.\n` : "";

  const lhxGuidance = isLHX ? `\nCRITICAL — LHX SCORING (V1): L3Harris Technologies, defense prime backlog compounder. HYBRID: LIN-like quality + ASML-like DoD capex cycle + geopolitical regime overlay. Smallest of Big 5 primes (LMT/RTX/NOC/GD/LHX), historically -5 to -15% PE discount to cohort — compression is the central re-rating thesis. Aerojet SRM duopoly with NOC. Do NOT penalize 52w proximity, RSI 50-70, trailing P/E 22-28x, cohort discount -5 to -15% (normal). Static composite weights 20/40/40 — positional+strategic co-equal. PRIMARY SIGNALS: book-to-bill (>1.10 strong, <0.95 thesis risk), backlog YoY (>8% expansion, <0% erosion), cohort PE compression vs LMT/NOC/RTX/GD, drawdown from 52w high (>10% setup, >18% strong), cohort rotation pressure (LHX lagging cohort >5pp/30d = BUY setup, capital flowing to larger primes), ITA vs SPY 30d (>1pp = defense bid active). Engine has TRAILING P/E only; your forward P/E + PE-vs-3Y is critical. Search for: LHX forward P/E + PE-vs-3Y-history, latest book-to-bill ratio (from earnings call disclosure), backlog YoY (dollar value delta), op margin + FCF margin trend, EPS revisions 30d/60d/90d (FactSet/Refinitiv), LMT/NOC/RTX/GD forward PE (defense cohort average), DoD budget cycle phase (FY27 NDAA progress, CR risk, supplemental funding flow Ukraine/Israel/Taiwan, sequester probability, BCA dynamics), geopolitical regime phase (great_power_competition / regional_conflict / transition / peace_dividend), Aerojet Rocketdyne integration progress + propellant supply chain, major program awards (F-35 mission systems, NGAD/6th-gen, Golden Dome / homeland missile defense, ISR programs, tactical radios, space C4ISR), defense-industrial supply chain (titanium, semiconductors, energetics, rare earths), dividend growth trajectory. Most days = NEUTRAL. Meaningful scores: cohort rotation extremes, drawdown setups, B/B inflection, DoD budget moments, geopolitical regime shifts, major program/earnings catalysts.\n` : "";

  const tmoGuidance = isTMO ? `\nCRITICAL — TMO SCORING (V1): Thermo Fisher Scientific, "ASML of life sciences" — picks-and-shovels supplier. HYBRID: LIN-like quality + ASML-like secular monopoly + cyclical end-market exposure (bioprocessing, biotech funding, China capex). Strategic dominates (45%) — cycle inflection thesis: bioprocessing destocking ending, biotech funding thawing, COVID comps lapped. Do NOT penalize 52w proximity, RSI 50-65, trailing P/E 22-30x, bioprocessing destocking by itself (late-trough setup), organic growth at 1% trough (cycle bottom). Static composite weights 20/35/45. PRIMARY SIGNALS: bioprocessing cycle phase (destocking/bottoming/early_recovery/expansion/peak), organic growth trajectory off the 1% Q1 2026 trough, peer triangulation DHR+Sartorius+Repligen, XBI 90d return (leads TMO bookings 2-3Q — >+10% thawing, <-10% frozen), biotech sympathy setup (TMO+XBI both down = collateral buy), drawdown from 52w high (>15% setup, >25% strong), DHR peer P/E + daily spread, QUAL vs SPY 30d (quality bid), forward PE vs 5Y avg. Engine has TRAILING P/E only; your forward P/E + PE-vs-5Y is critical. Search for: TMO forward P/E + PE-vs-5Y-history, current bioprocessing cycle phase (TMO + DHR + Sartorius + Repligen commentary triangulation), organic growth YoY (latest quarter print), op margin + FCF margin + EPS revisions (FactSet/Refinitiv), XBI 30d / 90d performance, China life sciences capex direction, NIH funding outlook, Wave 4 AI life sciences activation (AI biologics bioproduction, mass spec for AI research, lab automation), GLP-1 disruption to diagnostics narrative, PPD clinical research competitive position, dividend growth. CURRENT context: ~15-25% drawdown + organic growth trough = high-conviction buy SETUP zone. Most days = NEUTRAL but current setup tilts buy bias until cycle confirmation drives multiple expansion.\n` : "";

  const calibrationBlock = buildCalibrationBlock(h.symbol, CALIBRATION, md.price?.current);

  return `You are a SKEPTICAL quantitative analyst scoring ${h.symbol} (${h.name} — ${h.sector}).

VERIFIED DATA (from APIs — do NOT override these):
${(() => {
  return [
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.valuation?.trailingPE ? `P/E: ${md.valuation.trailingPE}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
  ].filter(Boolean).join("\n") || "No verified data available.";
})()}

Search for MISSING data: RSI(14), 52-week range, moving averages, recent news/catalysts.
CRITICAL: Do NOT override VERIFIED prices with search results.
${cyclicalWarning}${ibitGuidance}${asmlGuidance}${enbGuidance}${amkbyGuidance}${ethaGuidance}${kofGuidance}${glncyGuidance}${pbraGuidance}${linGuidance}${msftGuidance}${lhxGuidance}${tmoGuidance}${calibrationBlock}
SCORING: -100 (buy) to +100 (sell). ZERO = no edge. NEUTRAL most days.
Signals: ≤-60 STRONG_BUY, -25 to -59 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.
Every string field must be non-empty.

Return ONLY JSON: ${JSON_TEMPLATE(h.symbol)}
Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.`;
}

// ─── FETCH LLM SCORE ────────────────────────────────────────────────────────
async function fetchLLMScore(holding, prompt, useWebSearch) {
  const MAX_RETRIES = 5;
  const mode = useWebSearch ? "WEB SEARCH" : "qualitative";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const body = {
        model: "claude-sonnet-4-20250514",
        max_tokens: useWebSearch ? 16000 : 1000,
        messages: [{ role: "user", content: prompt }],
      };
      if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });

      if (resp.status === 429) {
        const waitSec = useWebSearch ? 60 : 30;
        console.log(`    ⚠ rate limited. Waiting ${waitSec}s...`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitSec * 1000)); continue; }
        throw new Error("Rate limited");
      }
      if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 150)}`);

      const result = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (result.stop_reason === "max_tokens") { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("Truncated"); }

      const text = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      const sanitized = text.replace(/:\s*\+(\d)/g, ': $1');
      const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("No JSON"); }

      const cleaned = jsonMatch[0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
      const parsed = JSON.parse(cleaned);

      const valid = ["tactical","positional","strategic"].every(l => typeof parsed[l]?.score === "number");
      if (!valid) { if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; } throw new Error("Invalid structure"); }

      const tokIn = result.usage?.input_tokens || "?";
      const tokOut = result.usage?.output_tokens || "?";
      return { parsed, elapsed, tokIn, tokOut, mode };
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      console.log(`    ⚠ ${e.message.slice(0, 80)}. Retry ${attempt+1}...`);
      await new Promise(r => setTimeout(r, (useWebSearch ? 2000 : 1500) * attempt));
    }
  }
}

// ─── SCORE ONE HOLDING ──────────────────────────────────────────────────────
async function scoreHolding(holding, useWebSearch) {
  const md = MARKET_DATA[holding.symbol] || {};
  const macro = MARKET_DATA._macro || {};

  const dataForEngine = { ...md, _weights: holding.weights, _archetype: holding.archetype };
  const detScores = computeDeterministicScores(dataForEngine, macro);

  console.log(`  [DET] tac=${detScores.tactical.score} pos=${detScores.positional.score} str=${detScores.strategic.score} comp=${detScores.composite.score}`);

  const prompt = useWebSearch ? buildSearchPrompt(holding) : buildPrompt(holding, detScores);
  console.log(`  [LLM] scoring [${useWebSearch ? "web search" : "qualitative"}]...`);

  try {
    const { parsed: llm, elapsed, tokIn, tokOut } = await fetchLLMScore(holding, prompt, useWebSearch);
    console.log(`  [LLM] tac=${llm.tactical?.score} pos=${llm.positional?.score} str=${llm.strategic?.score} comp=${llm.composite?.score} (${elapsed}s, ${tokIn}+${tokOut} tok)`);

    // V3: pass archetype so blendScores activates per-archetype overrides (LIN gets 65/60/40 vs default 70/50/30).
    // V7.4-V7.5: MSFT/LHX/TMO use defaults (no per-archetype override) — strategic 30/70 lean-LLM matches qualitative density.
    // Use detScores.weights so LIN's regime-conditional composite weights win over upstream holding.weights.
    const blended = blendScores(detScores, llm, detScores.weights || holding.weights, holding.archetype);

    const price = {};
    if (md.price?.current) price.current = md.price.current;
    if (md.price?.change_pct != null) price.change_pct = md.price.change_pct;
    if (md.price?.week52_high) price.week52_high = md.price.week52_high;
    if (md.price?.week52_low) price.week52_low = md.price.week52_low;
    if (md.price?.week52_position_pct != null) price.week52_position_pct = md.price.week52_position_pct;

    const confidence = computeConfidence(MARKET_DATA, holding.symbol);

    const result = {
      symbol: holding.symbol,
      price: { ...price, ...(llm.price || {}) },
      ...blended,
      // V3: hoist regime context to top level for clean downstream consumption
      // (log-signals, paper-trader, dashboard all look here first; null for non-LIN)
      regime: detScores.regime,
      regime_pmi: detScores.regimePmi,
      weights: detScores.weights,
      confidence,
      key_metric: llm.key_metric || { name: "", value: "" },
      risks: llm.risks || [],
      catalysts: llm.catalysts || [],
      _scoring: { deterministic: detScores.composite.score, llm: llm.composite?.score ?? 0, blend: "50/50" },
    };

    if (md.price?.current) result.price.current = md.price.current;
    if (md.price?.change_pct != null) result.price.change_pct = md.price.change_pct;

    const regimeStr = detScores.regime ? ` [regime: ${detScores.regime}]` : "";
    console.log(`  ✓ ${holding.symbol}: DET=${detScores.composite.score} + LLM=${llm.composite?.score ?? 0} → BLENDED=${blended.composite.score} [confidence: ${confidence.level}]${regimeStr}`);
    return result;
  } catch (e) {
    console.error(`  ✗ ${holding.symbol}: ${e.message}`);
    return null;
  }
}

// ─── NORMALIZATION ───────────────────────────────────────────────────────────
function normalize(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length < 3) return { normalized: valid, assignments: null };
  const layers = ["tactical", "positional", "strategic", "composite"];
  const stats = {};
  for (const layer of layers) {
    const scores = valid.map(s => (layer === "composite" ? s.composite : s[layer])?.score ?? 0);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    stats[layer] = { mean, stddev: Math.sqrt(variance) || 1, scores };
  }
  const normalized = valid.map(s => {
    const z = {};
    for (const layer of layers) {
      const raw = (layer === "composite" ? s.composite : s[layer])?.score ?? 0;
      z[layer] = (raw - stats[layer].mean) / stats[layer].stddev;
    }
    return { ...s, z };
  });
  const used = new Set();
  const assignments = { tacticalBuy: null, positionalBuy: null, strategicBuy: null, trim: null };
  for (const s of [...normalized].sort((a, b) => b.z.composite - a.z.composite)) { if (!used.has(s.symbol)) { assignments.trim = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.tactical - b.z.tactical)) { if (!used.has(s.symbol)) { assignments.tacticalBuy = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.positional - b.z.positional)) { if (!used.has(s.symbol)) { assignments.positionalBuy = s.symbol; used.add(s.symbol); break; } }
  for (const s of [...normalized].sort((a, b) => a.z.strategic - b.z.strategic)) { if (!used.has(s.symbol)) { assignments.strategicBuy = s.symbol; used.add(s.symbol); break; } }
  return { normalized, assignments };
}

// ─── EMAIL HTML ──────────────────────────────────────────────────────────────
function buildEmailHTML(normalized, assignments) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const find = sym => normalized.find(s => s.symbol === sym);
  const scoreClr = v => v<=-60?"#00ff88":v<=-25?"#4ecdc4":v<=24?"#8899aa":v<=59?"#f4a261":"#ff6b6b";
  const chgClr = v => (v||0)>=0?"#4ecdc4":"#ff6b6b";
  const chgFmt = v => `${(v||0)>=0?"+":""}${(v||0).toFixed(2)}%`;

  const signalRow = (label, icon, color, sym) => {
    const s = find(sym); if (!s) return "";
    const h = HOLDINGS.find(h => h.symbol === sym);
    const det = s._scoring?.deterministic ?? "?";
    const llm = s._scoring?.llm ?? "?";
    return `<tr style="border-bottom:1px solid #1a2332;"><td style="padding:14px 16px;font-size:13px;color:${color};font-weight:700;white-space:nowrap;">${icon} ${label}</td><td style="padding:14px 16px;font-size:18px;font-weight:800;color:#e0e8f0;">${sym}</td><td style="padding:14px 16px;font-size:12px;color:#889aaa;">${h?.name||""}</td><td style="padding:14px 16px;font-size:14px;font-weight:600;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</td><td style="padding:14px 16px;font-size:12px;color:${chgClr(s.price?.change_pct)};">${chgFmt(s.price?.change_pct)}</td><td style="padding:14px 16px;font-size:11px;color:#667788;max-width:320px;">${s.composite?.summary||"—"}<br><span style="color:#445566;font-size:9px;">DET:${det} LLM:${llm}</span></td></tr>`;
  };

  const confBadge = (level) => {
    const colors = { high: "#4ecdc4", medium: "#f4a261", low: "#ff6b6b" };
    const color = colors[level] || "#556677";
    return `<span style="font-size:8px;letter-spacing:0.06em;color:${color};border:1px solid ${color}40;padding:1px 4px;margin-left:4px;">${(level||"?").toUpperCase()}</span>`;
  };

  const rankingRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map((s,i) => {
    const role = s.symbol===assignments.tacticalBuy?"⚡ TAC BUY":s.symbol===assignments.positionalBuy?"📐 POS BUY":s.symbol===assignments.strategicBuy?"🏗️ STR BUY":s.symbol===assignments.trim?"✂️ TRIM":"━ HOLD";
    const roleColor = s.symbol===assignments.trim?"#ff6b6b":role.includes("BUY")?"#4ecdc4":"#556677";
    const h=HOLDINGS.find(h=>h.symbol===s.symbol); const km=s.key_metric;
    const cs=s.composite?.score??0; const ts=s.tactical?.score??0; const ps=s.positional?.score??0; const ss=s.strategic?.score??0;
    const det = s._scoring?.deterministic ?? ""; const llm = s._scoring?.llm ?? "";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:10px 10px;color:#445566;font-size:11px;text-align:center;">${i+1}</td><td style="padding:10px 8px;"><div style="font-weight:800;font-size:14px;color:#e0e8f0;">${s.symbol}${confBadge(s.confidence?.level)}</div><div style="font-size:10px;color:#556677;">${h?.name||""}</div></td><td style="padding:10px 8px;text-align:right;"><div style="font-size:14px;font-weight:700;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</div><div style="font-size:10px;color:${chgClr(s.price?.change_pct)};">${chgFmt(s.price?.change_pct)}</div></td><td style="padding:10px 8px;text-align:center;"><div style="font-size:16px;font-weight:800;color:${scoreClr(cs)};">${cs}</div><div style="font-size:9px;color:#334455;">D:${det} L:${llm}</div></td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ts)};">${ts}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ps)};">${ps}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ss)};">${ss}</td><td style="padding:10px 8px;"><div style="font-size:10px;color:${roleColor};font-weight:700;">${role}</div></td><td style="padding:10px 8px;font-size:10px;color:#889aaa;">${km?.name?`${km.name}: ${km.value}`:"—"}</td></tr>`;
  }).join("");

  const rationaleRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map(s => {
    const icon = s.symbol===assignments.tacticalBuy?"⚡":s.symbol===assignments.positionalBuy?"📐":s.symbol===assignments.strategicBuy?"🏗️":s.symbol===assignments.trim?"✂️":"";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:12px 14px;vertical-align:top;width:80px;"><div style="font-weight:800;font-size:13px;color:#e0e8f0;">${icon} ${s.symbol}</div></td><td style="padding:12px 14px;"><div style="font-size:11px;color:#889aaa;line-height:1.6;margin-bottom:4px;">${s.composite?.summary||"—"}</div><div style="font-size:10px;color:#556677;">Tactical: ${s.tactical?.rationale||"—"}</div></td></tr>`;
  }).join("");

  let accuracySection = "";
  if (CALIBRATION.available && CALIBRATION.totalDays >= 3) {
    const rel = CALIBRATION.reliability || {};
    const gradeColor = (g) => ({ STRONG:"#00ff88", MODERATE:"#f4a261", WEAK:"#ff6b6b", POOR:"#ff3355" }[g] || "#556677");
    const relRow = (layer, d) => {
      if (!d) return "";
      return `<tr><td style="padding:4px 8px;color:#7a8a9a;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">${layer}</td><td style="padding:4px 8px;color:${gradeColor(d.grade)};font-size:11px;font-weight:600;">${d.grade}</td><td style="padding:4px 8px;color:#c8d0e5;font-size:11px;">${d.hit_rate!=null?d.hit_rate+"%":"—"}</td><td style="padding:4px 8px;color:${(d.avg_return||0)>=0?"#4ecdc4":"#ff6b6b"};font-size:11px;">${d.avg_return!=null?(d.avg_return>=0?"+":"")+d.avg_return+"%":"—"}</td><td style="padding:4px 8px;color:#445566;font-size:10px;">${d.total_signals||0}</td></tr>`;
    };

    let streakWarning = "";
    if (CALIBRATION.streaks) {
      const long = Object.entries(CALIBRATION.streaks).filter(([_,s]) => s.streak_days >= 5).map(([sym,s]) => `${sym}: ${s.current_role} ${s.streak_days}d`);
      if (long.length > 0) streakWarning = `<div style="margin-top:10px;padding:6px 10px;background:#1a1000;border:1px solid #3a2a00;font-size:10px;color:#c8a050;">⚠️ Extended streaks: ${long.join(" · ")}</div>`;
    }

    accuracySection = `<div style="margin-bottom:28px;padding:16px 20px;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;"><div style="font-size:11px;letter-spacing:0.1em;color:#667788;margin-bottom:10px;">SIGNAL ACCURACY — ${CALIBRATION.totalDays} TRADING DAYS</div><table style="width:100%;border-collapse:collapse;"><tr style="border-bottom:1px solid #1a2332;"><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">LAYER</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">GRADE</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">HIT RATE</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">AVG RET</th><th style="padding:4px 8px;text-align:left;font-size:9px;color:#445566;">N</th></tr>${relRow("tactical",rel.tactical)}${relRow("positional",rel.positional)}${relRow("strategic",rel.strategic)}${relRow("composite",rel.composite)}</table>${streakWarning}</div>`;
  } else if (CALIBRATION.totalDays > 0) {
    accuracySection = `<div style="margin-bottom:28px;padding:12px 16px;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;font-size:11px;color:#556677;">Signal accuracy tracking: ${CALIBRATION.totalDays} day(s) logged. Grades appear after 3+ days.</div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#05080e;font-family:'SF Mono','Fira Code','Consolas',monospace;">
<div style="max-width:800px;margin:0 auto;padding:32px 24px;">
<div style="border-bottom:2px solid #1a2332;padding-bottom:20px;margin-bottom:28px;"><h1 style="margin:0;font-size:20px;color:#e0e8f0;">PORTFOLIO STRATEGY SIGNAL</h1><p style="margin:6px 0 0;font-size:12px;color:#556677;">${date} • ${HOLDINGS.length} Holdings • Hybrid Scoring (50% Quant + 50% LLM) • Z-Score Normalized</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">SIGNAL</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">TICKER</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">NAME</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">PRICE</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">CHG</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">THESIS</th></tr></thead>
<tbody>${signalRow("TACTICAL BUY","⚡","#00ff88",assignments.tacticalBuy)}${signalRow("POSITIONAL BUY","📐","#4ecdc4",assignments.positionalBuy)}${signalRow("STRATEGIC BUY","🏗️","#5b8dee",assignments.strategicBuy)}${signalRow("TRIM","✂️","#ff6b6b",assignments.trim)}</tbody></table>
${accuracySection}
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 4px;">COMPOSITE RANKINGS</h2><p style="font-size:10px;color:#334455;margin:0 0 12px;">D = deterministic score, L = LLM score, Blended 50/50</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:10px 10px;text-align:center;font-size:9px;color:#445566;">#</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">HOLDING</th><th style="padding:10px 8px;text-align:right;font-size:9px;color:#445566;">PRICE</th><th style="padding:10px 8px;text-align:center;font-size:9px;color:#445566;">COMP</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">TAC</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">POS</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">STR</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">ROLE</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">KEY METRIC</th></tr></thead><tbody>${rankingRows}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 12px;">RATIONALE</h2></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><tbody>${rationaleRows}</tbody></table>
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #141e2e;font-size:10px;color:#334455;line-height:1.6;"><p>Hybrid scoring: 50% deterministic (RSI, 52w, MAs, valuation) + 50% LLM qualitative judgment. Z-score normalized across portfolio.</p><p>Portfolio Strategy Hub v7.5 — ${HOLDINGS.length} holdings. LHX added (defense_prime_backlog_compounder: LIN-like quality + ASML-like DoD capex cycle + geopolitical regime overlay). TMO added (life_sciences_quality_compounder: "ASML of life sciences" — bioprocessing cycle inflection thesis). MOS and SPY retired. MSFT (ai_infra_quality_compounder) and LIN v3 (regime-conditional weights, BBB OAS, ASU util, EPS revisions, AI.PA peer triangulation, H2 layer) retained.</p></div>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v7.5");
  console.log("========================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}`);
  console.log(`Scoring: 50% deterministic + 50% LLM (archetype-aware)\n`);

  const meta = MARKET_DATA._meta || {};
  const needsSearch = new Set(meta.needsWebSearch || []);
  const dataHoldings = HOLDINGS.filter(h => !needsSearch.has(h.symbol));
  const searchHoldings = HOLDINGS.filter(h => needsSearch.has(h.symbol));
  console.log(`Pre-fetched: ${dataHoldings.length} | Web search: ${searchHoldings.length}`);
  if (searchHoldings.length > 0) console.log(`  → ${searchHoldings.map(h=>h.symbol).join(", ")}`);
  console.log("");

  const allSignals = [];

  if (dataHoldings.length > 0) {
    console.log(`── TRACK A: ${dataHoldings.length} holdings (hybrid scoring) ──`);
    for (let i = 0; i < dataHoldings.length; i++) {
      console.log(`[${i+1}/${dataHoldings.length}] ${dataHoldings[i].symbol}`);
      allSignals.push(await scoreHolding(dataHoldings[i], false));
      if (i < dataHoldings.length - 1) await new Promise(r => setTimeout(r, 5000));
    }
  }

  if (searchHoldings.length > 0) {
    console.log(`\n── TRACK B: ${searchHoldings.length} holdings (web search) ──`);
    for (let i = 0; i < searchHoldings.length; i++) {
      console.log(`[${i+1}/${searchHoldings.length}] ${searchHoldings[i].symbol}`);
      allSignals.push(await scoreHolding(searchHoldings[i], true));
      if (i < searchHoldings.length - 1) {
        console.log("  (60s cooldown)");
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  const validCount = allSignals.filter(Boolean).length;
  console.log(`\n✓ Scored ${validCount}/${HOLDINGS.length}`);
  if (validCount < 4) { console.error("Too few signals."); process.exit(1); }

  const { normalized, assignments } = normalize(allSignals);

  console.log("\n─── DAILY SIGNAL ───────────────────────");
  console.log(`  TACTICAL BUY:   ${assignments.tacticalBuy}`);
  console.log(`  POSITIONAL BUY: ${assignments.positionalBuy}`);
  console.log(`  STRATEGIC BUY:  ${assignments.strategicBuy}`);
  console.log(`  TRIM:           ${assignments.trim}`);
  console.log("────────────────────────────────────────\n");

  writeFileSync("/tmp/signal-email.html", buildEmailHTML(normalized, assignments));
  writeFileSync("/tmp/signal-data.json", JSON.stringify({ normalized, assignments, timestamp: new Date().toISOString() }, null, 2));
  console.log("✓ Email + data written");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
