#!/usr/bin/env node
// generate-signals.mjs v5 — Hybrid scoring: 50% deterministic + 50% LLM.
// Deterministic layer handles RSI, 52w position, MAs, valuation math.
// LLM handles qualitative interpretation, catalysts, risks, rationale text.

import { readFileSync, writeFileSync } from "fs";
import { computeDeterministicScores, blendScores } from "./score-engine.mjs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

let MARKET_DATA = {};
try { MARKET_DATA = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8")); } catch {}

const HOLDINGS = [
  { symbol: "MOS",   name: "Mosaic",         sector: "Ag Inputs",        weights: { t:.25, p:.35, s:.40 } },
  { symbol: "ASML",  name: "ASML",            sector: "Semis (Litho)",    weights: { t:.20, p:.35, s:.45 } },
  { symbol: "SMH",   name: "VanEck Semis",    sector: "Semiconductors",   weights: { t:.30, p:.35, s:.35 } },
  { symbol: "ENB",   name: "Enbridge",        sector: "Midstream Energy", weights: { t:.15, p:.35, s:.50 } },
  { symbol: "ETHA",  name: "iShares ETH",     sector: "Crypto (ETH)",     weights: { t:.25, p:.35, s:.40 } },
  { symbol: "GLNCY", name: "Glencore", sector: "Diversified Mining",      weights: { t: .20, p: .35, s: .45 },
  { symbol: "IBIT",  name: "iShares BTC",     sector: "Crypto (BTC)",     weights: { t:.30, p:.35, s:.35 } },
  { symbol: "KOF",   name: "Coca-Cola FEMSA", sector: "LatAm Consumer",   weights: { t:.15, p:.30, s:.55 } },
  { symbol: "PBR.A", name: "Petrobras",       sector: "EM Energy",        weights: { t:.20, p:.35, s:.45 } },
  { symbol: "AMKBY", name: "Maersk",          sector: "Global Shipping",  weights: { t:.25, p:.40, s:.35 } },
  { symbol: "SPY",   name: "S&P 500",         sector: "US Broad Beta",    weights: { t:.25, p:.35, s:.40 } },
];

// ─── LLM PROMPT ──────────────────────────────────────────────────────────────
// The LLM's job is now QUALITATIVE: interpret context, assess catalysts/risks,
// and provide the "judgment" half of the score. The deterministic engine
// already handles the math — the LLM should add what numbers can't capture.

const JSON_TEMPLATE = (sym) => `{"tactical":{"score":0,"rationale":""},"positional":{"score":0,"rationale":""},"strategic":{"score":0,"rationale":""},"composite":{"score":0,"summary":""},"key_metric":{"name":"","value":""},"risks":["",""],"catalysts":["",""]}`;

function buildPrompt(h, detScores) {
  const md = MARKET_DATA[h.symbol] || {};
  const macro = MARKET_DATA._macro || {};

  const dataLines = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.price?.week52_high ? `52-Week: High $${md.price.week52_high} | Low $${md.price.week52_low} | Position: ${md.price.week52_position_pct}%` : null,
    md.technicals?.rsi14 != null ? `RSI(14): ${md.technicals.rsi14}` : null,
    md.technicals?.sma50 ? `SMA 50: $${md.technicals.sma50} | SMA 200: $${md.technicals.sma200 ?? "N/A"} | Signal: ${md.technicals.ma_signal}` : null,
    md.valuation?.trailingPE ? `P/E: ${md.valuation.trailingPE}` : null,
    md.valuation?.priceToBook ? `P/B: ${md.valuation.priceToBook}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
    macro.vix ? `VIX: ${macro.vix}` : null,
    macro.us10y ? `10Y: ${macro.us10y}% | 2Y: ${macro.us2y}%` : null,
    macro.tips10y ? `TIPS: ${macro.tips10y}%` : null,
    macro.hy_oas ? `HY OAS: ${macro.hy_oas}bps` : null,
  ].filter(Boolean).join("\n");

  const detSummary = detScores.allNotes.join("; ");

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
  return `You are a SKEPTICAL quantitative analyst scoring ${h.symbol} (${h.name} — ${h.sector}).

VERIFIED DATA (from APIs — do NOT override these):
${(() => {
  const md = MARKET_DATA[h.symbol] || {};
  return [
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.valuation?.trailingPE ? `P/E: ${md.valuation.trailingPE}` : null,
    md.valuation?.dividendYield ? `Yield: ${md.valuation.dividendYield}%` : null,
  ].filter(Boolean).join("\n") || "No verified data available.";
})()}

Search for MISSING data: RSI(14), 52-week range, moving averages, recent news/catalysts.
CRITICAL: Do NOT override VERIFIED prices with search results.

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
      // Handle +N in JSON (invalid but Claude sometimes produces it)
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

  // Step 1: Deterministic scores
  const dataForEngine = { ...md, _weights: holding.weights };
  const detScores = computeDeterministicScores(dataForEngine, macro);

  console.log(`  [DET] tac=${detScores.tactical.score} pos=${detScores.positional.score} str=${detScores.strategic.score} comp=${detScores.composite.score}`);

  // Step 2: LLM qualitative scores
  const prompt = useWebSearch ? buildSearchPrompt(holding) : buildPrompt(holding, detScores);
  console.log(`  [LLM] scoring [${useWebSearch ? "web search" : "qualitative"}]...`);

  try {
    const { parsed: llm, elapsed, tokIn, tokOut } = await fetchLLMScore(holding, prompt, useWebSearch);
    console.log(`  [LLM] tac=${llm.tactical?.score} pos=${llm.positional?.score} str=${llm.strategic?.score} comp=${llm.composite?.score} (${elapsed}s, ${tokIn}+${tokOut} tok)`);

    // Step 3: Blend 50/50
    const blended = blendScores(detScores, llm, holding.weights);

    // Inject verified price
    const price = {};
    if (md.price?.current) price.current = md.price.current;
    if (md.price?.change_pct != null) price.change_pct = md.price.change_pct;
    if (md.price?.week52_high) price.week52_high = md.price.week52_high;
    if (md.price?.week52_low) price.week52_low = md.price.week52_low;
    if (md.price?.week52_position_pct != null) price.week52_position_pct = md.price.week52_position_pct;

    const result = {
      symbol: holding.symbol,
      price: { ...price, ...(llm.price || {}) },
      ...blended,
      key_metric: llm.key_metric || { name: "", value: "" },
      risks: llm.risks || [],
      catalysts: llm.catalysts || [],
      _scoring: { deterministic: detScores.composite.score, llm: llm.composite?.score ?? 0, blend: "50/50" },
    };

    // Override price with verified values
    if (md.price?.current) result.price.current = md.price.current;
    if (md.price?.change_pct != null) result.price.change_pct = md.price.change_pct;

    console.log(`  ✓ ${holding.symbol}: DET=${detScores.composite.score} + LLM=${llm.composite?.score ?? 0} → BLENDED=${blended.composite.score}`);
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

  const rankingRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map((s,i) => {
    const role = s.symbol===assignments.tacticalBuy?"⚡ TAC BUY":s.symbol===assignments.positionalBuy?"📐 POS BUY":s.symbol===assignments.strategicBuy?"🏗️ STR BUY":s.symbol===assignments.trim?"✂️ TRIM":"━ HOLD";
    const roleColor = s.symbol===assignments.trim?"#ff6b6b":role.includes("BUY")?"#4ecdc4":"#556677";
    const h=HOLDINGS.find(h=>h.symbol===s.symbol); const km=s.key_metric;
    const cs=s.composite?.score??0; const ts=s.tactical?.score??0; const ps=s.positional?.score??0; const ss=s.strategic?.score??0;
    const det = s._scoring?.deterministic ?? ""; const llm = s._scoring?.llm ?? "";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:10px 10px;color:#445566;font-size:11px;text-align:center;">${i+1}</td><td style="padding:10px 8px;"><div style="font-weight:800;font-size:14px;color:#e0e8f0;">${s.symbol}</div><div style="font-size:10px;color:#556677;">${h?.name||""}</div></td><td style="padding:10px 8px;text-align:right;"><div style="font-size:14px;font-weight:700;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</div><div style="font-size:10px;color:${chgClr(s.price?.change_pct)};">${chgFmt(s.price?.change_pct)}</div></td><td style="padding:10px 8px;text-align:center;"><div style="font-size:16px;font-weight:800;color:${scoreClr(cs)};">${cs}</div><div style="font-size:9px;color:#334455;">D:${det} L:${llm}</div></td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ts)};">${ts}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ps)};">${ps}</td><td style="padding:10px 6px;text-align:center;color:${scoreClr(ss)};">${ss}</td><td style="padding:10px 8px;"><div style="font-size:10px;color:${roleColor};font-weight:700;">${role}</div></td><td style="padding:10px 8px;font-size:10px;color:#889aaa;">${km?.name?`${km.name}: ${km.value}`:"—"}</td></tr>`;
  }).join("");

  const rationaleRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map(s => {
    const icon = s.symbol===assignments.tacticalBuy?"⚡":s.symbol===assignments.positionalBuy?"📐":s.symbol===assignments.strategicBuy?"🏗️":s.symbol===assignments.trim?"✂️":"";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:12px 14px;vertical-align:top;width:80px;"><div style="font-weight:800;font-size:13px;color:#e0e8f0;">${icon} ${s.symbol}</div></td><td style="padding:12px 14px;"><div style="font-size:11px;color:#889aaa;line-height:1.6;margin-bottom:4px;">${s.composite?.summary||"—"}</div><div style="font-size:10px;color:#556677;">Tactical: ${s.tactical?.rationale||"—"}</div></td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#05080e;font-family:'SF Mono','Fira Code','Consolas',monospace;">
<div style="max-width:800px;margin:0 auto;padding:32px 24px;">
<div style="border-bottom:2px solid #1a2332;padding-bottom:20px;margin-bottom:28px;"><h1 style="margin:0;font-size:20px;color:#e0e8f0;">PORTFOLIO STRATEGY SIGNAL</h1><p style="margin:6px 0 0;font-size:12px;color:#556677;">${date} • 11 Holdings • Hybrid Scoring (50% Quant + 50% LLM) • Z-Score Normalized</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">SIGNAL</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">TICKER</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">NAME</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">PRICE</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">CHG</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">THESIS</th></tr></thead>
<tbody>${signalRow("TACTICAL BUY","⚡","#00ff88",assignments.tacticalBuy)}${signalRow("POSITIONAL BUY","📐","#4ecdc4",assignments.positionalBuy)}${signalRow("STRATEGIC BUY","🏗️","#5b8dee",assignments.strategicBuy)}${signalRow("TRIM","✂️","#ff6b6b",assignments.trim)}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 4px;">COMPOSITE RANKINGS</h2><p style="font-size:10px;color:#334455;margin:0 0 12px;">D = deterministic score, L = LLM score, Blended 50/50</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:10px 10px;text-align:center;font-size:9px;color:#445566;">#</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">HOLDING</th><th style="padding:10px 8px;text-align:right;font-size:9px;color:#445566;">PRICE</th><th style="padding:10px 8px;text-align:center;font-size:9px;color:#445566;">COMP</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">TAC</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">POS</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">STR</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">ROLE</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">KEY METRIC</th></tr></thead><tbody>${rankingRows}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 12px;">RATIONALE</h2></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><tbody>${rationaleRows}</tbody></table>
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #141e2e;font-size:10px;color:#334455;line-height:1.6;"><p>Hybrid scoring: 50% deterministic (RSI, 52w, MAs, valuation) + 50% LLM qualitative judgment. Z-score normalized across portfolio.</p><p>Portfolio Strategy Hub v5.0</p></div>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v5");
  console.log("======================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}`);
  console.log(`Scoring: 50% deterministic + 50% LLM\n`);

  const meta = MARKET_DATA._meta || {};
  const needsSearch = new Set(meta.needsWebSearch || []);
  const dataHoldings = HOLDINGS.filter(h => !needsSearch.has(h.symbol));
  const searchHoldings = HOLDINGS.filter(h => needsSearch.has(h.symbol));
  console.log(`Pre-fetched: ${dataHoldings.length} | Web search: ${searchHoldings.length}`);
  if (searchHoldings.length > 0) console.log(`  → ${searchHoldings.map(h=>h.symbol).join(", ")}`);
  console.log("");

  const allSignals = [];

  // Track A: Hybrid scoring (deterministic + LLM qualitative)
  if (dataHoldings.length > 0) {
    console.log(`── TRACK A: ${dataHoldings.length} holdings (hybrid scoring) ──`);
    for (let i = 0; i < dataHoldings.length; i++) {
      console.log(`[${i+1}/${dataHoldings.length}] ${dataHoldings[i].symbol}`);
      allSignals.push(await scoreHolding(dataHoldings[i], false));
      if (i < dataHoldings.length - 1) await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Track B: Web search (for insufficient data)
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
