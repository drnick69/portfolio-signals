#!/usr/bin/env node
// generate-signals.mjs v4 — Two-track: pre-fetched data OR web search fallback.
// Reads /tmp/market-data.json. Symbols with complete data get scored without web search.
// Symbols missing data get scored WITH web search (uses more tokens but ensures coverage).

import { readFileSync, writeFileSync } from "fs";

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
  { symbol: "GLD",   name: "SPDR Gold",       sector: "Precious Metals",  weights: { t:.20, p:.35, s:.45 } },
  { symbol: "IBIT",  name: "iShares BTC",     sector: "Crypto (BTC)",     weights: { t:.30, p:.35, s:.35 } },
  { symbol: "KOF",   name: "Coca-Cola FEMSA", sector: "LatAm Consumer",   weights: { t:.15, p:.30, s:.55 } },
  { symbol: "PBR.A", name: "Petrobras",       sector: "EM Energy",        weights: { t:.20, p:.35, s:.45 } },
  { symbol: "AMKBY", name: "Maersk",          sector: "Global Shipping",  weights: { t:.25, p:.40, s:.35 } },
  { symbol: "SPY",   name: "S&P 500",         sector: "US Broad Beta",    weights: { t:.25, p:.35, s:.40 } },
];

const CALIBRATION = `CALIBRATION RULES:
• Scores: -100 (max buy) to +100 (max sell). ZERO = no edge (DEFAULT).
• RSI 40-60 → score 0. RSI 30-40 → -15 to -25. RSI <30 → -40 to -60.
• RSI 60-70 → +15 to +25. RSI >70 → +40 to +60.
• 52w position >90% → +10 to +30. 52w position <10% → -10 to -30.
• NEUTRAL is correct most days. Only deviate with clear evidence.
• Signals: ≤-60 STRONG_BUY, -59 to -25 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.`;

const JSON_TEMPLATE = (sym, price) => `{"symbol":"${sym}","price":{"current":${price?.current||0},"change_pct":${price?.change_pct||0},"week52_high":${price?.week52_high||0},"week52_low":${price?.week52_low||0}},"tactical":{"score":0,"signal":"NEUTRAL","rationale":""},"positional":{"score":0,"signal":"NEUTRAL","rationale":""},"strategic":{"score":0,"signal":"NEUTRAL","rationale":""},"composite":{"score":0,"recommendation":"HOLD","summary":""},"key_metric":{"name":"","value":""},"risks":[""],"catalysts":[""]}`;

// ─── TRACK A: DATA-RICH PROMPT (no web search) ──────────────────────────────
function buildDataPrompt(h) {
  const md = MARKET_DATA[h.symbol];
  const macro = MARKET_DATA._macro || {};

  const lines = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    md.price?.current ? `Price: $${md.price.current} | Change: ${md.price.change_pct}%` : null,
    md.price?.week52_high ? `52-Week: High $${md.price.week52_high} | Low $${md.price.week52_low} | Position: ${md.price.week52_position_pct}%` : null,
    md.technicals?.rsi14 != null ? `RSI(14): ${md.technicals.rsi14}` : null,
    md.technicals?.sma50 ? `SMA 50: $${md.technicals.sma50} | SMA 200: $${md.technicals.sma200 ?? "N/A"} | Signal: ${md.technicals.ma_signal}` : null,
    md.valuation?.trailingPE ? `Trailing P/E: ${md.valuation.trailingPE}` : null,
    md.valuation?.priceToBook ? `P/B: ${md.valuation.priceToBook}` : null,
    md.valuation?.dividendYield ? `Div Yield: ${md.valuation.dividendYield}%` : null,
    md.valuation?.beta ? `Beta: ${md.valuation.beta}` : null,
    // Macro context for all holdings
    macro.vix ? `VIX: ${macro.vix}` : null,
    macro.us10y ? `US 10Y: ${macro.us10y}% | 2Y: ${macro.us2y}%` : null,
    macro.tips10y ? `TIPS Real Yield: ${macro.tips10y}%` : null,
    macro.spread_2s10s != null ? `2s10s Spread: ${macro.spread_2s10s}bps` : null,
    macro.hy_oas ? `HY OAS: ${macro.hy_oas}bps` : null,
  ].filter(Boolean).join("\n");

  return `You are a SKEPTICAL quantitative analyst. Score ${h.symbol} using ONLY the data below.

${CALIBRATION}

MARKET DATA:
${lines}

Return ONLY valid JSON (no markdown):
${JSON_TEMPLATE(h.symbol, md.price)}

Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
Fill in scores, signals, rationales, key_metric, risks, catalysts.`;
}

// ─── TRACK B: WEB SEARCH PROMPT (for missing symbols) ───────────────────────
function buildSearchPrompt(h) {
  return `You are a SKEPTICAL quantitative analyst scoring ${h.symbol} (${h.name}).

${CALIBRATION}

Fetch these data points using web search for ${h.symbol}:
1. Current price, today's change %, 52-week high/low
2. RSI(14) or recent price action to estimate
3. Key moving averages (50d, 200d)
4. Primary valuation metric for this asset type
5. The single most important sector-specific data point
6. Latest relevant news or catalyst

Return ONLY valid JSON (no markdown):
${JSON_TEMPLATE(h.symbol, {})}

Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
Remember: NEUTRAL (score ~0) is the correct answer on most days.`;
}

// ─── FETCH SIGNAL ────────────────────────────────────────────────────────────
async function fetchSignal(holding, useWebSearch) {
  const MAX_RETRIES = 5;
  const mode = useWebSearch ? "WEB SEARCH" : "pre-fetched";
  console.log(`  Scoring ${holding.symbol} [${mode}]...`);

  const prompt = useWebSearch ? buildSearchPrompt(holding) : buildDataPrompt(holding);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const body = {
        model: "claude-sonnet-4-20250514",
        max_tokens: useWebSearch ? 16000 : 1000,
        messages: [{ role: "user", content: prompt }],
      };
      // Only add web search tool when needed
      if (useWebSearch) {
        body.tools = [{ type: "web_search_20250305", name: "web_search" }];
      }

      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (resp.status === 429) {
        const waitSec = useWebSearch ? 60 : 30;
        console.log(`  ⚠ ${holding.symbol} rate limited. Waiting ${waitSec}s...`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitSec * 1000)); continue; }
        throw new Error("Rate limited after all retries");
      }
      if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);

      const result = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (result.stop_reason === "max_tokens") {
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("Truncated");
      }

      const text = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("No JSON");
      }

      const cleaned = jsonMatch[0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
      const parsed = JSON.parse(cleaned);

      const valid = ["tactical","positional","strategic"].every(l => typeof parsed[l]?.score === "number")
        && typeof parsed.composite?.score === "number";
      if (!valid) {
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("Invalid structure");
      }

      // Inject accurate price from pre-fetched data if available
      const md = MARKET_DATA[holding.symbol];
      if (md?.price?.current) {
        parsed.price = { ...parsed.price, ...md.price };
      }

      const tokIn = result.usage?.input_tokens || "?";
      const tokOut = result.usage?.output_tokens || "?";
      console.log(`  ✓ ${holding.symbol} (${elapsed}s, ${tokIn}+${tokOut} tok) — composite: ${parsed.composite.score}`);
      return parsed;
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`  ✗ ${holding.symbol}: ${e.message}`);
        return null;
      }
      const wait = useWebSearch ? 2000 * attempt : 2000;
      console.log(`  ⚠ ${holding.symbol}: ${e.message.slice(0, 80)}. Retry ${attempt+1}...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return null;
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

// ─── EMAIL HTML (same as v3) ─────────────────────────────────────────────────
function buildEmailHTML(normalized, assignments) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const find = sym => normalized.find(s => s.symbol === sym);
  const signalRow = (label, icon, color, sym) => {
    const s = find(sym); if (!s) return "";
    const h = HOLDINGS.find(h => h.symbol === sym);
    return `<tr style="border-bottom:1px solid #1a2332;"><td style="padding:14px 16px;font-size:13px;color:${color};font-weight:700;white-space:nowrap;">${icon} ${label}</td><td style="padding:14px 16px;font-size:18px;font-weight:800;color:#e0e8f0;">${sym}</td><td style="padding:14px 16px;font-size:12px;color:#889aaa;">${h?.name||""}</td><td style="padding:14px 16px;font-size:14px;font-weight:600;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</td><td style="padding:14px 16px;font-size:12px;color:${(s.price?.change_pct||0)>=0?"#4ecdc4":"#ff6b6b"};">${(s.price?.change_pct||0)>=0?"+":""}${(s.price?.change_pct||0).toFixed(2)}%</td><td style="padding:14px 16px;font-size:11px;color:#667788;max-width:320px;">${s.composite?.summary||"—"}</td></tr>`;
  };
  const scoreClr = v => v<=-60?"#00ff88":v<=-25?"#4ecdc4":v<=24?"#8899aa":v<=59?"#f4a261":"#ff6b6b";
  const chgClr = v => (v||0)>=0?"#4ecdc4":"#ff6b6b";
  const chgFmt = v => `${(v||0)>=0?"+":""}${(v||0).toFixed(2)}%`;
  const rankingRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map((s,i) => {
    const role = s.symbol===assignments.tacticalBuy?"⚡ TAC BUY":s.symbol===assignments.positionalBuy?"📐 POS BUY":s.symbol===assignments.strategicBuy?"🏗️ STR BUY":s.symbol===assignments.trim?"✂️ TRIM":"━ HOLD";
    const roleColor = s.symbol===assignments.trim?"#ff6b6b":role.includes("BUY")?"#4ecdc4":"#556677";
    const h=HOLDINGS.find(h=>h.symbol===s.symbol); const km=s.key_metric;
    const cs=s.composite?.score??0; const ts=s.tactical?.score??0; const ps=s.positional?.score??0; const ss=s.strategic?.score??0;
    const w52=(s.price?.week52_high&&s.price?.week52_low&&s.price?.current)?Math.round(((s.price.current-s.price.week52_low)/(s.price.week52_high-s.price.week52_low))*100):null;
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:10px 10px;color:#445566;font-size:11px;text-align:center;">${i+1}</td><td style="padding:10px 8px;"><div style="font-weight:800;font-size:14px;color:#e0e8f0;">${s.symbol}</div><div style="font-size:10px;color:#556677;margin-top:2px;">${h?.name||""}</div></td><td style="padding:10px 8px;text-align:right;"><div style="font-size:14px;font-weight:700;color:#e0e8f0;">$${s.price?.current?.toFixed?.(2)||"—"}</div><div style="font-size:10px;color:${chgClr(s.price?.change_pct)};margin-top:2px;">${chgFmt(s.price?.change_pct)}</div></td><td style="padding:10px 8px;text-align:center;"><div style="font-size:16px;font-weight:800;color:${scoreClr(cs)};">${cs}</div><div style="font-size:9px;color:#445566;">COMP</div></td><td style="padding:10px 6px;text-align:center;"><div style="font-size:11px;color:${scoreClr(ts)};">${ts}</div><div style="font-size:9px;color:#334455;">TAC</div></td><td style="padding:10px 6px;text-align:center;"><div style="font-size:11px;color:${scoreClr(ps)};">${ps}</div><div style="font-size:9px;color:#334455;">POS</div></td><td style="padding:10px 6px;text-align:center;"><div style="font-size:11px;color:${scoreClr(ss)};">${ss}</div><div style="font-size:9px;color:#334455;">STR</div></td><td style="padding:10px 8px;"><div style="font-size:10px;color:${roleColor};font-weight:700;">${role}</div>${w52!==null?`<div style="font-size:9px;color:#445566;margin-top:3px;">52w: ${w52}%</div>`:""}</td><td style="padding:10px 8px;">${km?.name?`<div style="font-size:10px;color:#889aaa;"><span style="color:#556677;">${km.name}:</span> ${km.value}</div>`:`<div style="font-size:10px;color:#334455;">—</div>`}</td></tr>`;
  }).join("");
  const rationaleRows = [...normalized].sort((a,b)=>(a.z?.composite??0)-(b.z?.composite??0)).map(s => {
    const icon = s.symbol===assignments.tacticalBuy?"⚡":s.symbol===assignments.positionalBuy?"📐":s.symbol===assignments.strategicBuy?"🏗️":s.symbol===assignments.trim?"✂️":"";
    return `<tr style="border-bottom:1px solid #0f1520;"><td style="padding:12px 14px;vertical-align:top;width:80px;"><div style="font-weight:800;font-size:13px;color:#e0e8f0;">${icon} ${s.symbol}</div></td><td style="padding:12px 14px;"><div style="font-size:11px;color:#889aaa;line-height:1.6;margin-bottom:4px;">${s.composite?.summary||"—"}</div><div style="font-size:10px;color:#556677;"><span style="color:#445566;">Tactical:</span> ${s.tactical?.rationale||"—"}</div></td></tr>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#05080e;font-family:'SF Mono','Fira Code','Consolas',monospace;">
<div style="max-width:800px;margin:0 auto;padding:32px 24px;">
<div style="border-bottom:2px solid #1a2332;padding-bottom:20px;margin-bottom:28px;"><h1 style="margin:0;font-size:20px;color:#e0e8f0;letter-spacing:0.04em;">PORTFOLIO STRATEGY SIGNAL</h1><p style="margin:6px 0 0;font-size:12px;color:#556677;">${date} • 11 Holdings • Z-Score Normalized</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;letter-spacing:0.1em;">SIGNAL</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">TICKER</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">NAME</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">PRICE</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">CHG</th><th style="padding:12px 16px;text-align:left;font-size:10px;color:#445566;">THESIS</th></tr></thead>
<tbody>${signalRow("TACTICAL BUY","⚡","#00ff88",assignments.tacticalBuy)}${signalRow("POSITIONAL BUY","📐","#4ecdc4",assignments.positionalBuy)}${signalRow("STRATEGIC BUY","🏗️","#5b8dee",assignments.strategicBuy)}${signalRow("TRIM","✂️","#ff6b6b",assignments.trim)}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 4px;">COMPOSITE RANKINGS</h2><p style="font-size:10px;color:#334455;margin:0 0 12px;">Sorted by z-score — strongest buy at top, weakest at bottom</p></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><thead><tr style="border-bottom:2px solid #1a2332;"><th style="padding:10px 10px;text-align:center;font-size:9px;color:#445566;">#</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">HOLDING</th><th style="padding:10px 8px;text-align:right;font-size:9px;color:#445566;">PRICE</th><th style="padding:10px 8px;text-align:center;font-size:9px;color:#445566;">COMP</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">TAC</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">POS</th><th style="padding:10px 6px;text-align:center;font-size:9px;color:#445566;">STR</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">ROLE</th><th style="padding:10px 8px;text-align:left;font-size:9px;color:#445566;">KEY METRIC</th></tr></thead><tbody>${rankingRows}</tbody></table>
<div style="margin-bottom:12px;"><h2 style="font-size:13px;color:#667788;letter-spacing:0.1em;margin:0 0 12px;">RATIONALE BY HOLDING</h2></div>
<table style="width:100%;border-collapse:collapse;background:#0a0f18;border:1px solid #1a2332;border-radius:8px;margin-bottom:28px;"><tbody>${rationaleRows}</tbody></table>
<div style="margin-top:28px;padding-top:16px;border-top:1px solid #141e2e;font-size:10px;color:#334455;line-height:1.6;"><p>Signals z-score normalized. Strongest relative signal per timeframe gets actionable recommendation.</p><p>Portfolio Strategy Hub v4.0</p></div>
</div></body></html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v4");
  console.log("======================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}`);

  const meta = MARKET_DATA._meta || {};
  const needsSearch = new Set(meta.needsWebSearch || []);
  const dataCount = HOLDINGS.filter(h => !needsSearch.has(h.symbol)).length;
  console.log(`Pre-fetched: ${dataCount} | Web search fallback: ${needsSearch.size}`);
  if (needsSearch.size > 0) console.log(`  → ${[...needsSearch].join(", ")}`);
  console.log("");

  // Score all holdings — data-rich ones first (fast), then web search ones (slower)
  const dataHoldings = HOLDINGS.filter(h => !needsSearch.has(h.symbol));
  const searchHoldings = HOLDINGS.filter(h => needsSearch.has(h.symbol));

  const allSignals = [];

  // Track A: Pre-fetched data (fast, low tokens, 5s cooldown)
  if (dataHoldings.length > 0) {
    console.log(`── TRACK A: ${dataHoldings.length} holdings with pre-fetched data ──`);
    for (let i = 0; i < dataHoldings.length; i++) {
      console.log(`[${i+1}/${dataHoldings.length}]`);
      allSignals.push(await fetchSignal(dataHoldings[i], false));
      if (i < dataHoldings.length - 1) await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Track B: Web search fallback (slower, more tokens, 60s cooldown)
  if (searchHoldings.length > 0) {
    console.log(`\n── TRACK B: ${searchHoldings.length} holdings via web search ──`);
    for (let i = 0; i < searchHoldings.length; i++) {
      console.log(`[${i+1}/${searchHoldings.length}]`);
      allSignals.push(await fetchSignal(searchHoldings[i], true));
      if (i < searchHoldings.length - 1) {
        console.log("  (60s cooldown — web search rate limit)");
        await new Promise(r => setTimeout(r, 60000));
      }
    }
  }

  const validCount = allSignals.filter(Boolean).length;
  console.log(`\n✓ Scored ${validCount}/${HOLDINGS.length} holdings`);

  if (validCount < 4) { console.error("Too few signals. Aborting."); process.exit(1); }

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
