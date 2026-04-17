#!/usr/bin/env node
// generate-signals.mjs v6.4 — Hybrid scoring: 50% deterministic + 50% LLM.
// Deterministic layer handles RSI, 52w position, MAs, valuation math.
// LLM handles qualitative interpretation, catalysts, risks, rationale text.
// v6.0: calibration feedback, confidence bands, accuracy tracking integration.
// v6.1: SPY weight fix (20/40/40), SPY-specific prompt guidance, breadth data.
// v6.2: IBIT-specific prompt guidance (no mechanical cycle trim, flows > timing).
// v6.3: ASML secular_growth_monopoly (dampened RSI/52w, compounder thesis, 15/30/55).
// v6.4: ENB dividend_compounder (yield spread primary, rate regime, gas/LNG qualitative, 10/45/45).
// v6.5: AMKBY cyclical_trade_bellwether (shipping PE, enhanced P/B, GSCPI, freight cycle guidance, 25/35/40).
// v6.6: ETHA high_beta_crypto (wider RSI/daily bands, inverted 52w, 200DMA extension, ETHA/IBIT alt-season ratio, 30/35/35).
// v6.7: KOF em_dividend_growth (dampened RSI, mildly inverted 52w, MXN/USD FX regime, narrowed PE, 15/35/50).
// v6.8: GLNCY diversified_commodity_trader (COPX ratio, GSCPI+HY OAS, PE with trading arm floor, enhanced P/B, 20/35/45).

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
  { symbol: "MOS",   name: "Mosaic",          sector: "Ag Inputs",         archetype: "cyclical_commodity",           weights: { t:.25, p:.35, s:.40 } },
  { symbol: "ASML",  name: "ASML",            sector: "Semis (Litho)",     archetype: "secular_growth_monopoly",      weights: { t:.15, p:.30, s:.55 } },
  { symbol: "SMH",   name: "VanEck Semis",    sector: "Semiconductors",    archetype: "sector_beta",                  weights: { t:.30, p:.35, s:.35 } },
  { symbol: "ENB",   name: "Enbridge",        sector: "Midstream Energy",  archetype: "dividend_compounder",          weights: { t:.10, p:.45, s:.45 } },  // ← CHANGED from 15/35/50
  { symbol: "ETHA",  name: "iShares ETH",     sector: "Crypto (ETH)",      archetype: "high_beta_crypto",             weights: { t:.30, p:.35, s:.35 } },  // ← CHANGED from 25/35/40
  { symbol: "GLNCY", name: "Glencore",        sector: "Diversified Mining", archetype: "diversified_commodity_trader", weights: { t:.20, p:.35, s:.45 } },
  { symbol: "IBIT",  name: "iShares BTC",     sector: "Crypto (BTC)",      archetype: "momentum_store_of_value",      weights: { t:.30, p:.35, s:.35 } },
  { symbol: "KOF",   name: "Coca-Cola FEMSA", sector: "LatAm Consumer",    archetype: "em_dividend_growth",           weights: { t:.15, p:.35, s:.50 } },  // ← CHANGED from 15/30/55
  { symbol: "PBR.A", name: "Petrobras",       sector: "EM Energy",         archetype: "em_state_oil_dividend",        weights: { t:.20, p:.35, s:.45 } },
  { symbol: "AMKBY", name: "Maersk",          sector: "Global Shipping",   archetype: "cyclical_trade_bellwether",    weights: { t:.25, p:.35, s:.40 } },  // ← CHANGED from 25/40/35
  { symbol: "SPY",   name: "S&P 500",         sector: "US Broad Beta",     archetype: "beta_sizing",                  weights: { t:.20, p:.40, s:.40 } },
];

// ─── CYCLICAL ARCHETYPE DETECTION ───────────────────────────────────────────
const CYCLICAL_ARCHETYPES = new Set([
  "cyclical_commodity",
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
  const isSPY = h.archetype === "beta_sizing";
  const isIBIT = h.archetype === "momentum_store_of_value";
  const isASML = h.archetype === "secular_growth_monopoly";
  const isENB = h.archetype === "dividend_compounder";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isETHA = h.archetype === "high_beta_crypto";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";  // ← NEW

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

  // ── NEW: ENB yield spread line ────────────────────────────────────────────
  let enbYieldSpreadLine = null;
  if (isENB && md.valuation?.dividendYield && macro.us10y) {
    const spread = md.valuation.dividendYield - macro.us10y;
    const spreadBps = Math.round(spread * 100);
    enbYieldSpreadLine = `ENB yield spread vs 10Y: ${spreadBps}bps (ENB ${md.valuation.dividendYield}% − 10Y ${macro.us10y}%)${spreadBps > 300 ? " — ATTRACTIVE" : spreadBps < 150 ? " — RICH" : ""}`;
  }

  // ── NEW: AMKBY GSCPI line ─────────────────────────────────────────────────
  let amkbyGscpiLine = null;
  if (isAMKBY && macro.gscpi != null) {
    const g = macro.gscpi;
    const regime = g > 1.5 ? "STRESSED" : g > 0.5 ? "ELEVATED" : g > -0.5 ? "NORMAL" : g > -1.0 ? "CALM" : "VERY CALM";
    amkbyGscpiLine = `GSCPI (supply chain pressure): ${g} (${regime}) — date: ${macro.gscpi_date || "latest"}`;
  }

  // ── NEW: ETHA alt-season line + 200DMA extension ──────────────────────────
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

  // ── NEW: KOF MXN/USD line ─────────────────────────────────────────────────
  let kofMxnLine = null;
  if (isKOF && macro.mxn_usd != null) {
    const mxn = macro.mxn_usd;
    const regime = mxn < 16 ? "VERY STRONG PESO" : mxn < 17 ? "STRONG PESO" : mxn < 18.5 ? "NORMAL" : mxn < 20 ? "WEAKENING" : "WEAK PESO";
    kofMxnLine = `MXN/USD: ${mxn} (${regime}) — KOF earns ~60% in MXN`;
  }

  // ── NEW: GLNCY COPX line ──────────────────────────────────────────────────
  let glncyCopxLine = null;
  if (isGLNCY && md.copper_regime) {
    const cr = md.copper_regime;
    const dir = cr.relative_spread_pp > 0.5 ? "GLNCY OUTPERFORMING (diversification premium)" :
                cr.relative_spread_pp < -0.5 ? "COPX LEADING (copper surging, GLNCY catch-up?)" : "INLINE";
    glncyCopxLine = `GLNCY/COPX: ratio ${cr.glncy_copx_ratio ?? "—"} | COPX $${cr.copx_price ?? "—"} (${cr.copx_change_pct >= 0 ? "+" : ""}${cr.copx_change_pct}%) | Spread: ${cr.relative_spread_pp != null ? (cr.relative_spread_pp >= 0 ? "+" : "") + cr.relative_spread_pp + "pp" : "—"} (${dir})`;
  }

  const dataLines = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.price?.week52_high ? `52-Week: High $${md.price.week52_high} | Low $${md.price.week52_low} | Position: ${md.price.week52_position_pct}%` : null,
    md.technicals?.rsi14 != null ? `RSI(14): ${md.technicals.rsi14}` : null,
    md.technicals?.sma50 ? `SMA 50: $${md.technicals.sma50} | SMA 200: $${md.technicals.sma200 ?? "N/A"} | Signal: ${md.technicals.ma_signal}` : null,
    ibitExtensionLine,
    ethaExtensionLine,   // ← NEW (null-filtered for non-ETHA)
    md.valuation?.trailingPE ? `P/E (trailing): ${md.valuation.trailingPE}` : null,
    md.valuation?.priceToBook ? `P/B: ${md.valuation.priceToBook}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
    enbYieldSpreadLine,  // ← NEW (null-filtered for non-ENB)
    amkbyGscpiLine,     // ← NEW (null-filtered for non-AMKBY)
    ethaAltSeasonLine,  // ← NEW (null-filtered for non-ETHA)
    kofMxnLine,         // ← NEW (null-filtered for non-KOF)
    glncyCopxLine,      // ← NEW (null-filtered for non-GLNCY)
    macro.vix ? `VIX: ${macro.vix}` : null,
    macro.us10y ? `10Y: ${macro.us10y}% | 2Y: ${macro.us2y}%${curveStr ? ` | 2s10s curve: ${curveStr}` : ""}` : null,
    macro.tips10y ? `TIPS 10Y (real): ${macro.tips10y}%${realRate != null ? ` | Fed Funds real rate: ${realRate}%` : ""}` : null,
    macro.hy_oas ? `HY OAS credit spread: ${macro.hy_oas}bps` : null,
    (isSPY && md.breadth) ? `Breadth (RSP/SPY): RSP ${md.breadth.rsp_change_pct >= 0 ? "+" : ""}${md.breadth.rsp_change_pct}% vs SPY ${md.breadth.spy_change_pct >= 0 ? "+" : ""}${md.breadth.spy_change_pct}% | Spread: ${md.breadth.rsp_spy_spread_pp >= 0 ? "+" : ""}${md.breadth.rsp_spy_spread_pp}pp (${md.breadth.rsp_spy_spread_pp > 0 ? "broad/healthy" : md.breadth.rsp_spy_spread_pp < 0 ? "narrow/top-heavy" : "inline"})` : null,
    isIBIT ? (() => {
      const p = getIBITPhaseContext();
      return `Halving cycle: month ${p.months} post-halving (phase: ${p.phase})`;
    })() : null,
  ].filter(Boolean).join("\n");

  const cyclicalWarning = isCyclical ? `
CRITICAL — CYCLICAL VALUATION RULES FOR ${h.symbol}:
${h.symbol} is a CYCLICAL business (archetype: ${h.archetype}). Trailing P/E must be interpreted INVERSELY:
• HIGH trailing P/E (>50x) = earnings are at TROUGH = this is a BUY signal, NOT expensive
• LOW trailing P/E (<10x) = earnings are at PEAK = cycle rollover risk = TRIM signal
• "Buy cyclicals when the P/E looks terrible, sell when it looks cheap." — Peter Lynch
• The deterministic engine has already applied inverted PE scoring. Your qualitative score should NOT penalize high trailing P/E for this holding. Instead, consider whether the earnings trough is deepening or recovering.
` : "";

  const spyGuidance = isSPY ? `
CRITICAL — SPY-SPECIFIC SCORING GUIDANCE:
SPY is the broad US market. It is the most efficient instrument in the world — edge is structurally limited. Your role here is narrower than for single stocks:

• DO NOT penalize proximity to 52-week highs. SPY makes new highs ~7% of trading days, and forward 20-day returns average +1.2% when within 2% of highs. New highs are momentum-positive for a broad index, NOT overbought. The deterministic engine has been corrected for this — do not reintroduce the bias.
• DO NOT double-count what the engine handles: RSI, VIX+RSI combo triggers, 2s10s curve, HY OAS credit spreads, real rate regime, and RSP/SPY breadth are all deterministically scored. If you agree with the quant, return a similar score.
• YOUR VALUE-ADD for SPY is what the numbers can't capture:
    — Event risk: earnings season heat, Fed meeting proximity, fiscal/policy catalysts, election uncertainty, geopolitical shocks
    — Regime context: is VIX elevated because of a specific event or broad fear? Is credit widening from one sector or systemic?
    — Forward catalysts: rate cut path priced in, earnings growth inflection, fiscal package
    — Qualitative breadth beyond RSP/SPY: mega-cap concentration, sector rotation dynamics
• SPY DESERVES MORE NEUTRAL SCORES THAN SINGLE STOCKS. The market is efficient. Scores beyond ±30 should reflect GENUINE dislocations (policy shock, crisis, earnings breakdown) — not ordinary technical readings.
• When in doubt on SPY, return closer to 0. NEUTRAL is the most common correct answer.
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

  // ── NEW: ENB-specific guidance ────────────────────────────────────────────
  const enbGuidance = isENB ? `
CRITICAL — ENB-SPECIFIC SCORING GUIDANCE:
Enbridge is a DIVIDEND COMPOUNDER — midstream pipeline infrastructure that trades like a toll road, NOT like an oil producer. Revenue is largely contracted and fee-based. ENB is a hold-forever income name.

WHAT DRIVES ENB (three layers of importance):
1. YIELD SPREAD VS BONDS (daily-to-monthly price action driver): The deterministic engine already scores the ENB yield spread vs US 10Y. When the spread is >300bps, ENB is historically cheap. When it compresses below 150bps, it's rich. This is the #1 measurable signal. DO NOT duplicate this scoring — if you agree with the quant's positional score, return similar.
2. GAS VOLUMES + LNG BUILDOUT (medium-to-long-term earnings trajectory): This is YOUR primary value-add. ENB's gas transmission is ~25% of EBITDA. Natural gas prices are a LEADING INDICATOR for throughput volumes, not a direct revenue driver. LNG export buildout (LNG Canada, US Gulf Coast expansion) creates structural demand for ENB's pipeline capacity. Henry Hub price levels affect drilling activity which affects volumes.
3. CRUDE THROUGHPUT (Mainline economics): WCS-WTI spread, Canadian crude production growth, Trans Mountain dynamics. ENB's Liquids Pipelines are ~55% of EBITDA.

WHAT NOT TO PENALIZE:
• Proximity to 52-week highs — normal for a dividend compounder
• RSI 55-70 — normal range for a low-volatility yield stock (ENB daily moves are typically 0.3-0.8%)
• Trailing P/E 18-24x — normal range for pipeline infrastructure
• The stock being "boring" — that IS the thesis

WHAT EARNS TRIM BIAS (very rare for a hold-forever income name):
• Yield spread compressing below 100bps (ENB yield advantage over bonds has eroded)
• Dividend cut risk (payout ratio >100%, EBITDA declining)
• Genuine structural pipeline obsolescence risk (not realistic near-term)
• Trim is mainly OPPORTUNITY COST — if other names flash much stronger signals, redeploy ENB capital

WHAT EARNS BUY BIAS:
• Yield spread >300bps (historically strong buy zone — market overpricing rate risk)
• 10Y yield spike causing ENB to drop >2% sympathetically — rate overreaction, the thesis hasn't changed
• ENB yield in top quartile of its 5-year range
• Rate cutting cycle beginning or accelerating — structural tailwind for yield stocks
• LNG export capacity expanding (LNG Canada Phase 2, new Gulf Coast terminals) — structural earnings growth

YOUR VALUE-ADD FOR ENB:
• Natural gas volume outlook: Is Henry Hub supportive? Are pipeline throughputs growing?
• LNG buildout status: LNG Canada Phase 2 progress, BC Pipeline utilization, Gulf Coast export terminal pipeline
• WCS-WTI spread dynamics and Canadian crude production trajectory
• Pipeline permitting environment (federal/provincial headwinds or tailwinds)
• Fed/BoC rate commentary and forward rate expectations
• Dividend growth sustainability: Does the earnings trajectory support 3-5% annual dividend growth?
• CAD/USD impact on USD-denominated ADR returns
• Ex-dividend date proximity (worth noting but should not drive the score)

MOST DAYS SHOULD BE NEUTRAL:
ENB should produce composite scores between -5 and +5 roughly 85% of trading days. It's a hold-and-collect-income stock. Meaningful scores only appear during rate overreaction selloffs (buy), yield spread extremes (buy or trim), or genuinely structural catalysts (LNG buildout, dividend policy changes).
` : "";

  // ── NEW: AMKBY-specific guidance ──────────────────────────────────────────
  const amkbyGuidance = isAMKBY ? `
CRITICAL — AMKBY-SPECIFIC SCORING GUIDANCE:
Maersk is a CYCLICAL TRADE BELLWETHER — the world's largest container shipping company, also transforming into an integrated logistics provider.

CYCLICAL P/E — SHIPPING-SPECIFIC:
The engine uses INVERTED P/E. Shipping cycles are MORE EXTREME than commodity cycles: PE 2-5x = genuine peak (trim risk), PE 6-12x = mid-cycle, PE 15-25x = below-trend (recovery), PE 50+ = deep trough (strong buy). Your job: assess WHERE IN THE FREIGHT CYCLE we are.

P/B MATTERS (asset-heavy fleet):
P/B <0.7 = fleet priced below replacement cost = historically powerful buy. P/B >2.0 = late-cycle premium. Engine already scores this with enhanced weights.

YOUR PRIMARY VALUE-ADD — FREIGHT RATES AND TRADE VOLUMES:
The engine has NO freight rate data (WCI, SCFI, BDI are paywalled). This is your most important contribution:
• Drewry WCI / SCFI: current container rates and trend. Are spikes from disruptions (Red Sea, congestion) or genuine demand?
• Baltic Dry Index as broader shipping demand proxy
• CPB World Trade Monitor: global trade volume direction (3-month trend)
• Tariff/trade war impact on container volumes
• Whether current freight rate levels are sustainable

SUM-OF-PARTS VALUATION:
• Market often prices Maersk's logistics segment at ZERO during freight troughs
• Compare logistics implied EV/EBITDA vs DSV (~20x) and Kuehne+Nagel (~15-20x)
• When logistics is priced at <5x vs peers at 15-20x → structural undervaluation
• Track logistics transformation progress: revenue mix, acquisition integration

GSCPI CONTEXT:
If shown in data, GSCPI >1.5 = supply chain stress (rates high but disrupted), GSCPI <-0.5 = calm markets (rate pressure).

SCORES CAN BE MORE VOLATILE:
Unlike compounders where ±5 is normal, AMKBY legitimately scores ±15 to ±25 during active freight markets. Ground scores in CURRENT freight conditions, not just technicals.
` : "";

  // ── NEW: ETHA-specific guidance ───────────────────────────────────────────
  const ethaGuidance = isETHA ? `
CRITICAL — ETHA-SPECIFIC SCORING GUIDANCE:
ETHA is a spot Ethereum ETF. ETH trades at ~1.3-1.5x BTC's daily volatility and sits further out on the risk curve. It has NO halving cycle, NO "digital gold" thesis, and NO meaningful valuation metrics.

WHAT ACTUALLY DRIVES ETHA'S PRICE (in order of magnitude):
1. BTC DIRECTION: ETH correlation with BTC is 0.85-0.95. When BTC moves, ETH follows — harder in both directions. The engine already scores this via RSI and 200DMA extension.
2. RISK APPETITE: ETH is more sensitive to VIX, HY OAS, and real rates than BTC. In risk-off, ETH drops 1.3-1.5x what BTC drops. The engine scores this with enhanced macro weights.
3. ETH/BTC RATIO (ALT-SEASON): When capital rotates from BTC into alts, ETH outperforms ("alt season"). When BTC dominance rises, ETH underperforms. The engine computes this as ETHA/IBIT daily performance spread. Your job: assess whether a rotation is starting, peaking, or fading.

DO NOT PENALIZE: RSI 70-80 (normal ETH momentum), proximity to 52w highs (momentum-positive), P/E or P/B (meaningless for crypto ETF), golden cross MA (normal trending state).

WHAT THE ENGINE CANNOT CAPTURE (YOUR VALUE-ADD):
• DeFi/L2 ecosystem health: is TVL growing? Are L2s (Arbitrum, Optimism, Base) gaining traction?
• Regulatory catalysts: SEC stance on ETH as commodity vs security, staking ETF approvals
• Network upgrades: Pectra, Dencun impacts on gas fees and throughput
• Competitive L1 threats: is Solana stealing mindshare/volume from ETH?
• Whether the BTC→ETH rotation has legs or is already exhausted
• ETF flow dynamics: are ETHA inflows accelerating, decelerating, or going negative?

SCORING CALIBRATION:
ETH is more volatile than BTC, so scores can be slightly wider. ±15-20 during active crypto markets is reasonable. But most days should still be close to neutral if BTC is flat and macro is stable.
` : "";

  // ── NEW: KOF-specific guidance ────────────────────────────────────────────
  const kofGuidance = isKOF ? `
CRITICAL — KOF-SPECIFIC SCORING GUIDANCE:
KOF is Coca-Cola FEMSA — largest Coke bottler in Latin America. Consumer staples compounder with ~60% of revenue from Mexico. The stock trades as an ADR in USD but earns in MXN/BRL/COP.

THE #1 NON-FUNDAMENTAL DRIVER — FX:
MXN/USD dominates KOF's ADR price action on a weekly/monthly basis. Strong peso = ADR rises (same earnings translate to more USD). Weak peso = ADR falls. The engine scores the MXN level as a regime indicator. Your job: assess the DIRECTION — is MXN strengthening or weakening, and why?

DO NOT PENALIZE: proximity to 52w highs (normal for compounder), RSI 50-65 (normal for consumer staples), P/E 15-22x (normal range for LatAm bottler).

WHAT THE ENGINE CANNOT CAPTURE (YOUR VALUE-ADD):
• Mexican consumer spending trends: retail sales, consumer confidence, real wage growth
• Banxico rate decisions and forward guidance — rate cuts weaken MXN but boost consumer spending
• Nearshoring narrative impact on MXN strength (structural peso support?)
• Sugar and PET resin input cost trends — margin pressure or tailwind?
• Volume growth by geography: Mexico (60%), Brazil, Colombia, Central America
• Coca-Cola parent company pricing guidance and raw material hedging
• Competitive dynamics vs Arca Continental (KOFL.MX)
• Dividend growth trajectory: is the 5-8% annual growth sustainable?

MOST DAYS SHOULD BE NEUTRAL:
KOF is a consumer staples name. Scores between -5 and +5 roughly 80% of trading days. Meaningful scores appear during: MXN regime shifts, EM selloffs, margin surprises, or Banxico policy pivots.
` : "";

  // ── NEW: GLNCY-specific guidance ──────────────────────────────────────────
  const glncyGuidance = isGLNCY ? `
CRITICAL — GLNCY-SPECIFIC SCORING GUIDANCE:
Glencore is a DIVERSIFIED COMMODITY TRADER — mining (copper ~30%, coal ~25%, zinc/nickel/cobalt) PLUS a massive commodity trading/marketing arm that profits from volatility regardless of price direction.

CYCLICAL P/E — WITH TRADING ARM FLOOR:
Inverted PE applies (high PE = trough = BUY). But Glencore's trading arm generates $2-4B EBITDA even in commodity troughs, so PE never goes as extreme as pure miners. PE 6-20x = mid-cycle, PE 40+ = trough buy, PE 3-6x = peak earnings trim.

P/B MATTERS (mining assets = real replacement cost):
P/B <0.8 = market pricing mines below replacement cost = strong buy. P/B <1.0 = below book = value. Mining assets don't depreciate like ships — this is a reliable signal.

YOUR PRIMARY VALUE-ADD — COPPER AND COMMODITY PRICES:
The engine has COPX (copper miners ETF) as a proxy but NO direct LME copper price. This is your most important contribution:
• LME copper price level and trend (THE lead indicator for ~30% of mining EBITDA)
• LME copper inventories (low = tight market = bullish, high = oversupply)
• Chinese PMI and property sector (demand driver for base metals)
• Zinc, nickel, cobalt price trends (the other 40% of mining EBITDA)
• Coal price and ESG divestment pressure vs cash generation reality
• DXY direction (strong dollar = broad commodity headwind)

SUM-OF-PARTS (same dynamic as AMKBY logistics):
• Market often values Glencore's trading arm at ZERO during commodity troughs
• Trading arm generates $2-4B EBITDA with minimal capital — should trade at 8-12x
• When total Glencore EV implies trading at <5x vs standalone 8-12x → structural undervaluation

COPX RATIO CONTEXT:
If COPX is outperforming GLNCY, pure copper is leading — Glencore may catch up (diversification discount). If GLNCY outperforms COPX, market is giving credit to the trading arm.

SCORES: More volatile than compounders but less extreme than AMKBY. ±10-20 during active commodity markets.
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
${cyclicalWarning}${spyGuidance}${ibitGuidance}${asmlGuidance}${enbGuidance}${amkbyGuidance}${ethaGuidance}${kofGuidance}${glncyGuidance}${confidenceNote}${calibrationBlock}
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
  const isSPY = h.archetype === "beta_sizing";
  const isIBIT = h.archetype === "momentum_store_of_value";
  const isASML = h.archetype === "secular_growth_monopoly";
  const isENB = h.archetype === "dividend_compounder";
  const isAMKBY = h.archetype === "cyclical_trade_bellwether";
  const isETHA = h.archetype === "high_beta_crypto";
  const isKOF = h.archetype === "em_dividend_growth";
  const isGLNCY = h.archetype === "diversified_commodity_trader";  // ← NEW
  const md = MARKET_DATA[h.symbol] || {};

  const cyclicalWarning = isCyclical ? `
CRITICAL — CYCLICAL VALUATION: ${h.symbol} is a cyclical business. High trailing P/E means earnings are at TROUGH — this is a BUY signal, not a sell signal. Low P/E means peak earnings and cycle rollover risk. Do NOT penalize high trailing P/E for cyclicals.
` : "";

  const spyGuidance = isSPY ? `
CRITICAL — SPY SCORING: SPY is the broad market, structurally efficient. Do NOT penalize proximity to 52w highs (momentum-positive for indexes). Focus on event risk, policy catalysts, and regime context. Scores beyond ±30 require genuine dislocations. When in doubt, return NEUTRAL (0).
` : "";

  const ibitGuidance = isIBIT ? `
CRITICAL — IBIT SCORING: Bitcoin is momentum-dominant and flow-driven. Cycle phase is context, NOT a trim trigger. Do NOT penalize proximity to 52w highs or "late-cycle" timing. Real trim signals: flow divergence, LTH distribution, extreme 200DMA extension. RSI 70-80 is normal BTC momentum. Upside uncapped. Buy weakness harder deeper in cycle.
` : "";

  const asmlGuidance = isASML ? `
CRITICAL — ASML SCORING: Secular growth monopoly (sole EUV supplier). Do NOT penalize 52w proximity or RSI 65-75. Trailing P/E 30-42x is NORMAL. Buy signals: drawdowns >15%. Trim signals: forward P/E >45x, book-to-bill <1.0. Buybacks ~3-5% annual. Most days = NEUTRAL.
` : "";

  // ── NEW: ENB guidance (abbreviated for web search path) ──
  const enbGuidance = isENB ? `
CRITICAL — ENB SCORING: Dividend compounder / toll-road infrastructure — NOT an oil producer. Do NOT penalize 52w proximity or RSI 55-70 (normal for yield stock). P/E 18-24x is NORMAL. The #1 signal is yield spread vs US 10Y (>300bps = buy, <150bps = rich). ENB is a hold-forever income name — trim is rare and mainly opportunity cost. Search for: ENB dividend yield vs 10Y spread, rate outlook, LNG Canada buildout, WCS-WTI spread, pipeline permitting, dividend growth guidance. Gas volumes and LNG export buildout are real earnings drivers (not just "noise").
` : "";

  // ── NEW: AMKBY guidance (abbreviated for web search path) ──
  const amkbyGuidance = isAMKBY ? `
CRITICAL — AMKBY SCORING: Cyclical trade bellwether (world's largest container shipping). INVERTED P/E applies — high PE = trough = BUY, low PE = peak = TRIM. Shipping cycles are more extreme than commodities: PE 2-5x = peak, PE 50+ = trough. P/B matters (asset-heavy fleet): P/B <0.7 = below replacement cost = strong buy. Search for: WCI/SCFI container freight rates (THE primary signal), BDI, global trade volumes, Red Sea/Suez disruptions, Maersk logistics vs DSV/Kuehne+Nagel valuation gap, tariff/trade war impacts. Scores can be ±15 to ±25 during active freight markets.
` : "";

  // ── NEW: ETHA guidance (abbreviated for web search path) ──
  const ethaGuidance = isETHA ? `
CRITICAL — ETHA SCORING: Spot Ethereum ETF. ETH runs at 1.3-1.5x BTC's volatility, further out on risk curve. Do NOT penalize RSI 70-80 or 52w proximity. P/E, P/B, yield are all MEANINGLESS for crypto. Key drivers: BTC direction (0.85-0.95 correlation), risk appetite (VIX/HY OAS), and ETH/BTC ratio (alt-season indicator). Search for: ETH/BTC ratio trend, ETF flow data, DeFi TVL trends, L2 ecosystem growth, regulatory stance on ETH, network upgrades, competitive L1 threats (Solana). Scores can be ±15-20 during active crypto markets.
` : "";

  // ── NEW: KOF guidance (abbreviated for web search path) ──
  const kofGuidance = isKOF ? `
CRITICAL — KOF SCORING: Coca-Cola FEMSA, largest Coke bottler in LatAm. Consumer staples compounder. Do NOT penalize 52w proximity or RSI 50-65 (normal for staples). P/E 15-22x is NORMAL. The #1 non-fundamental driver is MXN/USD — KOF earns ~60% in MXN. Strong peso = ADR tailwind, weak peso = headwind. Search for: MXN/USD direction, Banxico rate decisions, Mexican consumer spending, retail sales, nearshoring impact on peso, sugar/PET resin costs, volume growth by geography, dividend growth trajectory. Most days = NEUTRAL.
` : "";

  // ── NEW: GLNCY guidance (abbreviated for web search path) ──
  const glncyGuidance = isGLNCY ? `
CRITICAL — GLNCY SCORING: Diversified commodity trader (mining: copper 30%, coal 25%, zinc/nickel/cobalt + trading/marketing arm). INVERTED P/E applies but with higher floor than pure cyclicals (trading arm generates $2-4B EBITDA even in troughs). P/B matters (mining assets = replacement cost): P/B <0.8 = strong buy. Search for: LME copper price and trend (THE lead indicator), copper inventories, Chinese PMI/property, zinc/nickel/cobalt prices, coal price + ESG pressure, DXY direction, Glencore trading arm valuation (market often prices at zero). Scores ±10-20 during active commodity markets.
` : "";

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
${cyclicalWarning}${spyGuidance}${ibitGuidance}${asmlGuidance}${enbGuidance}${amkbyGuidance}${ethaGuidance}${kofGuidance}${glncyGuidance}${calibrationBlock}
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

    const blended = blendScores(detScores, llm, holding.weights);

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
      confidence,
      key_metric: llm.key_metric || { name: "", value: "" },
      risks: llm.risks || [],
      catalysts: llm.catalysts || [],
      _scoring: { deterministic: detScores.composite.score, llm: llm.composite?.score ?? 0, blend: "50/50" },
    };

    if (md.price?.current) result.price.current = md.price.current;
    if (md.price?.change_pct != null) result.price.change_pct = md.price.change_pct;

    console.log(`  ✓ ${holding.symbol}: DET=${detScores.composite.score} + LLM=${llm.composite?.score ?? 0} → BLENDED=${blended.composite.score} [confidence: ${confidence.level}]`);
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
<div style="border-bottom:2px solid #1a2332;padding-bottom:20px;margin-bottom:28px;"><h1 style="margin:0;font-size:20px;color:#e0e8f0;">PORTFOLIO STRATEGY SIGNAL</h1><p style="margin:6px 0 0;font-size:12px;color:#556677;">${date} • 11 Holdings • Hybrid Scoring (50% Quant + 50% LLM) • Z-Score Normalized</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">SIGNAL</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">TICKER</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">NAME</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">PRICE</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">CHG</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">THESIS</th></tr></thead>
<tbody>${signalRow("TACTICAL BUY","⚡","#00ff88",assignments.tacticalBuy)}${signalRow("POSITIONAL BUY","📐","#4ecdc4",assignments.positionalBuy)}${signalRow("STRATEGIC BUY","🏗️","#5b8dee",assignments.strategicBuy)}${signalRow("TRIM","✂️","#ff6b6b",assignments.trim)}</tbody></table>
${accuracySection}
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 4px;">COMPOSITE RANKINGS</h2><p style="font-size:10px;color:#334455;margin:0 0 12px;">D = deterministic score, L = LLM score, Blended 50/50</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:10px 10px;text-align:center;font-size:9px;color:#445566;">#</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">HOLDING</th><th style="padding:10px 8px;text-align:right;font-size:9px;color:#445566;">PRICE</th><th style="padding:10px 8px;text-align:center;font-size:9px;color:#445566;">COMP</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">TAC</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">POS</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">STR</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">ROLE</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">KEY METRIC</th></tr></thead><tbody>${rankingRows}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 12px;">RATIONALE</h2></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><tbody>${rationaleRows}</tbody></table>
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #141e2e;font-size:10px;color:#334455;line-height:1.6;"><p>Hybrid scoring: 50% deterministic (RSI, 52w, MAs, valuation) + 50% LLM qualitative judgment. Z-score normalized across portfolio.</p><p>Portfolio Strategy Hub v6.8 — GLNCY commodity trader model (COPX ratio, GSCPI, PE with trading arm floor)</p></div>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v6.8");
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
