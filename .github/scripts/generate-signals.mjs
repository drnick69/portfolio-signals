#!/usr/bin/env node
// generate-signals.mjs v3 — Uses pre-fetched market data instead of web search.
// Expects /tmp/market-data.json from fetch-market-data.mjs.
// Token usage: ~800 input + ~500 output per call (vs ~15k with web search).

import { readFileSync, writeFileSync } from "fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

// Load pre-fetched market data
let MARKET_DATA;
try {
  MARKET_DATA = JSON.parse(readFileSync("/tmp/market-data.json", "utf-8"));
} catch (e) {
  console.error("Missing /tmp/market-data.json — run fetch-market-data.mjs first");
  process.exit(1);
}

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

// ─── PROMPT (compact — data is pre-fetched) ──────────────────────────────────
function buildPrompt(h) {
  const md = MARKET_DATA[h.symbol];
  if (!md || md.error) {
    return `Score ${h.symbol} as NEUTRAL (0) — no market data available. Return the standard JSON with all scores at 0.`;
  }

  const dataBlock = [
    `Symbol: ${h.symbol} (${h.name}) — ${h.sector}`,
    `Price: $${md.price?.current} | Change: ${md.price?.change_pct}%`,
    `52-Week: High $${md.price?.week52_high} | Low $${md.price?.week52_low} | Position: ${md.price?.week52_position_pct}%`,
    `RSI(14): ${md.technicals?.rsi14 ?? "N/A"}`,
    `SMA 50: $${md.technicals?.sma50 ?? "N/A"} | SMA 200: $${md.technicals?.sma200 ?? "N/A"} | Signal: ${md.technicals?.ma_signal ?? "N/A"}`,
    md.valuation?.trailingPE ? `P/E: ${md.valuation.trailingPE} | Fwd P/E: ${md.valuation.forwardPE ?? "N/A"} | P/B: ${md.valuation.priceToBook ?? "N/A"}` : null,
    md.valuation?.dividendYield ? `Div Yield: ${md.valuation.dividendYield}%` : null,
    md.volume?.ratio ? `Volume Ratio (today/avg): ${md.volume.ratio}x` : null,
  ].filter(Boolean).join("\n");

  return `You are a SKEPTICAL quantitative analyst. Score ${h.symbol} using ONLY the data below.

CALIBRATION RULES:
• Scores: -100 (max buy) to +100 (max sell). ZERO = no edge (DEFAULT).
• RSI 40-60 → score 0. RSI 30-40 → -15 to -25. RSI <30 → -40 to -60.
• RSI 60-70 → +15 to +25. RSI >70 → +40 to +60.
• 52w position >90% → +10 to +30. 52w position <10% → -10 to -30.
• NEUTRAL is correct most days. Only deviate with clear evidence.
• Signals: ≤-60 STRONG_BUY, -59 to -25 BUY, -24 to +24 NEUTRAL, +25 to +59 SELL, ≥+60 STRONG_SELL.

MARKET DATA:
${dataBlock}

Return ONLY valid JSON (no markdown):
{"symbol":"${h.symbol}","price":{"current":${md.price?.current || 0},"change_pct":${md.price?.change_pct || 0},"week52_high":${md.price?.week52_high || 0},"week52_low":${md.price?.week52_low || 0}},"tactical":{"score":0,"signal":"NEUTRAL","rationale":""},"positional":{"score":0,"signal":"NEUTRAL","rationale":""},"strategic":{"score":0,"signal":"NEUTRAL","rationale":""},"composite":{"score":0,"recommendation":"HOLD","summary":""},"key_metric":{"name":"","value":""},"risks":[""],"catalysts":[""]}

Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
Fill in scores, signals, rationales, key_metric, risks, and catalysts based on the data.`;
}

// ─── FETCH SIGNAL (no web search — much faster) ─────────────────────────────
async function fetchSignal(holding) {
  const MAX_RETRIES = 5;
  console.log(`  Scoring ${holding.symbol}...`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,  // Much smaller — no web search content to return
          // NO tools — no web search needed
          messages: [{ role: "user", content: buildPrompt(holding) }],
        }),
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "30", 10);
        const waitSec = Math.max(retryAfter, 30);
        console.log(`  ⚠ ${holding.symbol} rate limited. Waiting ${waitSec}s...`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitSec * 1000)); continue; }
        throw new Error("Rate limited after all retries");
      }

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const result = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (result.stop_reason === "max_tokens") {
        console.log(`  ⚠ ${holding.symbol} truncated. ${attempt < MAX_RETRIES ? "Retrying..." : ""}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("Truncated response");
      }

      const text = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("No JSON in response");
      }

      const cleaned = jsonMatch[0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
      const parsed = JSON.parse(cleaned);

      // Validate
      const valid = ["tactical","positional","strategic"].every(l => typeof parsed[l]?.score === "number")
        && typeof parsed.composite?.score === "number";
      if (!valid) {
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error("Invalid signal structure");
      }

      // Inject market data that the LLM might not have echoed back perfectly
      if (MARKET_DATA[holding.symbol]?.price) {
        parsed.price = { ...parsed.price, ...MARKET_DATA[holding.symbol].price };
      }

      const tokensIn = result.usage?.input_tokens || "?";
      const tokensOut = result.usage?.output_tokens || "?";
      console.log(`  ✓ ${holding.symbol} (${elapsed}s, ${tokensIn}+${tokensOut} tok) — composite: ${parsed.composite.score}`);
      return parsed;
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`  ✗ ${holding.symbol}: ${e.message}`);
        return null;
      }
      console.log(`  ⚠ ${holding.symbol}: ${e.message.slice(0, 80)}. Retry ${attempt+1}...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
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

// ─── EMAIL HTML ──────────────────────────────────────────────────────────────
function buildEmailHTML(normalized, assignments) {
  const date = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const find = (sym) => normalized.find(s => s.symbol === sym);

  const signalRow = (label, icon, color, sym) => {
    const s = find(sym);
    if (!s) return "";
    const h = HOLDINGS.find(h => h.symbol === sym);
    return `
      <tr style="border-bottom: 1px solid #1a2332;">
        <td style="padding: 14px 16px; font-size: 13px; color: ${color}; font-weight: 700; white-space: nowrap;">${icon} ${label}</td>
        <td style="padding: 14px 16px; font-size: 18px; font-weight: 800; color: #e0e8f0;">${sym}</td>
        <td style="padding: 14px 16px; font-size: 12px; color: #889aaa;">${h?.name || ""}</td>
        <td style="padding: 14px 16px; font-size: 14px; font-weight: 600; color: #e0e8f0;">$${s.price?.current?.toFixed?.(2) || "—"}</td>
        <td style="padding: 14px 16px; font-size: 12px; color: ${(s.price?.change_pct || 0) >= 0 ? "#4ecdc4" : "#ff6b6b"};">${(s.price?.change_pct || 0) >= 0 ? "+" : ""}${(s.price?.change_pct || 0).toFixed(2)}%</td>
        <td style="padding: 14px 16px; font-size: 11px; color: #667788; max-width: 320px;">${s.composite?.summary || "—"}</td>
      </tr>`;
  };

  const scoreClr = (v) => v <= -60 ? "#00ff88" : v <= -25 ? "#4ecdc4" : v <= 24 ? "#8899aa" : v <= 59 ? "#f4a261" : "#ff6b6b";
  const chgClr = (v) => (v || 0) >= 0 ? "#4ecdc4" : "#ff6b6b";
  const chgFmt = (v) => `${(v || 0) >= 0 ? "+" : ""}${(v || 0).toFixed(2)}%`;

  const rankingRows = [...normalized]
    .sort((a, b) => (a.z?.composite ?? 0) - (b.z?.composite ?? 0))
    .map((s, i) => {
      const role =
        s.symbol === assignments.tacticalBuy   ? "⚡ TAC BUY" :
        s.symbol === assignments.positionalBuy  ? "📐 POS BUY" :
        s.symbol === assignments.strategicBuy   ? "🏗️ STR BUY" :
        s.symbol === assignments.trim           ? "✂️ TRIM" : "━ HOLD";
      const roleColor = s.symbol === assignments.trim ? "#ff6b6b" : role.includes("BUY") ? "#4ecdc4" : "#556677";
      const h = HOLDINGS.find(h => h.symbol === s.symbol);
      const km = s.key_metric;
      const compScore = s.composite?.score ?? 0;
      const tacScore = s.tactical?.score ?? 0;
      const posScore = s.positional?.score ?? 0;
      const strScore = s.strategic?.score ?? 0;
      const w52pct = (s.price?.week52_high && s.price?.week52_low && s.price?.current)
        ? Math.round(((s.price.current - s.price.week52_low) / (s.price.week52_high - s.price.week52_low)) * 100) : null;

      return `
      <tr style="border-bottom: 1px solid #0f1520;">
        <td style="padding: 10px 10px; color: #445566; font-size: 11px; text-align: center;">${i+1}</td>
        <td style="padding: 10px 8px;"><div style="font-weight: 800; font-size: 14px; color: #e0e8f0;">${s.symbol}</div><div style="font-size: 10px; color: #556677; margin-top: 2px;">${h?.name || ""}</div></td>
        <td style="padding: 10px 8px; text-align: right;"><div style="font-size: 14px; font-weight: 700; color: #e0e8f0;">$${s.price?.current?.toFixed?.(2) || "—"}</div><div style="font-size: 10px; color: ${chgClr(s.price?.change_pct)}; margin-top: 2px;">${chgFmt(s.price?.change_pct)}</div></td>
        <td style="padding: 10px 8px; text-align: center;"><div style="font-size: 16px; font-weight: 800; color: ${scoreClr(compScore)};">${compScore}</div><div style="font-size: 9px; color: #445566;">COMP</div></td>
        <td style="padding: 10px 6px; text-align: center;"><div style="font-size: 11px; color: ${scoreClr(tacScore)};">${tacScore}</div><div style="font-size: 9px; color: #334455;">TAC</div></td>
        <td style="padding: 10px 6px; text-align: center;"><div style="font-size: 11px; color: ${scoreClr(posScore)};">${posScore}</div><div style="font-size: 9px; color: #334455;">POS</div></td>
        <td style="padding: 10px 6px; text-align: center;"><div style="font-size: 11px; color: ${scoreClr(strScore)};">${strScore}</div><div style="font-size: 9px; color: #334455;">STR</div></td>
        <td style="padding: 10px 8px;"><div style="font-size: 10px; color: ${roleColor}; font-weight: 700;">${role}</div>${w52pct !== null ? `<div style="font-size: 9px; color: #445566; margin-top: 3px;">52w: ${w52pct}%</div>` : ""}</td>
        <td style="padding: 10px 8px;">${km?.name ? `<div style="font-size: 10px; color: #889aaa;"><span style="color: #556677;">${km.name}:</span> ${km.value}</div>` : `<div style="font-size: 10px; color: #334455;">—</div>`}</td>
      </tr>`;
    }).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #05080e; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;">
  <div style="max-width: 800px; margin: 0 auto; padding: 32px 24px;">
    <div style="border-bottom: 2px solid #1a2332; padding-bottom: 20px; margin-bottom: 28px;">
      <h1 style="margin: 0; font-size: 20px; color: #e0e8f0; letter-spacing: 0.04em;">PORTFOLIO STRATEGY SIGNAL</h1>
      <p style="margin: 6px 0 0; font-size: 12px; color: #556677;">${date} • 11 Holdings • Z-Score Normalized</p>
    </div>

    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <thead><tr style="border-bottom: 2px solid #1a2332;">
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566; letter-spacing: 0.1em;">SIGNAL</th>
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">TICKER</th>
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">NAME</th>
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">PRICE</th>
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">CHG</th>
        <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">THESIS</th>
      </tr></thead>
      <tbody>
        ${signalRow("TACTICAL BUY",   "⚡", "#00ff88", assignments.tacticalBuy)}
        ${signalRow("POSITIONAL BUY", "📐", "#4ecdc4", assignments.positionalBuy)}
        ${signalRow("STRATEGIC BUY",  "🏗️", "#5b8dee", assignments.strategicBuy)}
        ${signalRow("TRIM",           "✂️", "#ff6b6b", assignments.trim)}
      </tbody>
    </table>

    <div style="margin-bottom: 12px;">
      <h2 style="font-size: 13px; color: #667788; letter-spacing: 0.1em; margin: 0 0 4px;">COMPOSITE RANKINGS</h2>
      <p style="font-size: 10px; color: #334455; margin: 0 0 12px;">Sorted by normalized z-score — strongest buy at top, weakest at bottom</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <thead><tr style="border-bottom: 2px solid #1a2332;">
        <th style="padding: 10px 10px; text-align: center; font-size: 9px; color: #445566;">#</th>
        <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">HOLDING</th>
        <th style="padding: 10px 8px; text-align: right; font-size: 9px; color: #445566;">PRICE</th>
        <th style="padding: 10px 8px; text-align: center; font-size: 9px; color: #445566;">COMP</th>
        <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">TAC</th>
        <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">POS</th>
        <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">STR</th>
        <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">ROLE</th>
        <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">KEY METRIC</th>
      </tr></thead>
      <tbody>${rankingRows}</tbody>
    </table>

    <div style="margin-bottom: 12px;"><h2 style="font-size: 13px; color: #667788; letter-spacing: 0.1em; margin: 0 0 12px;">RATIONALE BY HOLDING</h2></div>
    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <tbody>
        ${[...normalized].sort((a, b) => (a.z?.composite ?? 0) - (b.z?.composite ?? 0)).map(s => {
          const icon = s.symbol === assignments.tacticalBuy ? "⚡" : s.symbol === assignments.positionalBuy ? "📐" : s.symbol === assignments.strategicBuy ? "🏗️" : s.symbol === assignments.trim ? "✂️" : "";
          return `<tr style="border-bottom: 1px solid #0f1520;"><td style="padding: 12px 14px; vertical-align: top; width: 80px;"><div style="font-weight: 800; font-size: 13px; color: #e0e8f0;">${icon} ${s.symbol}</div></td><td style="padding: 12px 14px;"><div style="font-size: 11px; color: #889aaa; line-height: 1.6; margin-bottom: 4px;">${s.composite?.summary || "—"}</div><div style="font-size: 10px; color: #556677;"><span style="color: #445566;">Tactical:</span> ${s.tactical?.rationale || "—"}</div></td></tr>`;
        }).join("")}
      </tbody>
    </table>

    <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #141e2e; font-size: 10px; color: #334455; line-height: 1.6;">
      <p>Signals are z-score normalized across the portfolio. Only the strongest relative signal per timeframe receives an actionable recommendation.</p>
      <p>Generated by Portfolio Strategy Hub v3.0 — Pre-fetched data pipeline</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator v3");
  console.log("======================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}`);
  console.log(`Mode: Pre-fetched data (no web search)\n`);

  const dataCount = Object.values(MARKET_DATA).filter(d => !d.error).length;
  console.log(`Market data: ${dataCount}/${HOLDINGS.length} symbols loaded\n`);

  // Run sequentially with short cooldowns (much smaller token usage now)
  const allSignals = [];
  for (let i = 0; i < HOLDINGS.length; i++) {
    const h = HOLDINGS[i];
    console.log(`[${i+1}/${HOLDINGS.length}] ${h.symbol}`);
    const result = await fetchSignal(h);
    allSignals.push(result);
    if (i < HOLDINGS.length - 1) {
      // 5s cooldown is enough without web search (~800 tokens per call)
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const validCount = allSignals.filter(Boolean).length;
  console.log(`\n✓ Scored ${validCount}/${HOLDINGS.length} holdings`);

  if (validCount < 4) {
    console.error("Too few valid signals. Aborting.");
    process.exit(1);
  }

  const { normalized, assignments } = normalize(allSignals);

  console.log("\n─── DAILY SIGNAL ───────────────────────");
  console.log(`  TACTICAL BUY:   ${assignments.tacticalBuy}`);
  console.log(`  POSITIONAL BUY: ${assignments.positionalBuy}`);
  console.log(`  STRATEGIC BUY:  ${assignments.strategicBuy}`);
  console.log(`  TRIM:           ${assignments.trim}`);
  console.log("────────────────────────────────────────\n");

  const emailHTML = buildEmailHTML(normalized, assignments);
  writeFileSync("/tmp/signal-email.html", emailHTML);
  writeFileSync("/tmp/signal-data.json", JSON.stringify({ normalized, assignments, timestamp: new Date().toISOString() }, null, 2));

  console.log("✓ Email HTML written to /tmp/signal-email.html");
  console.log("✓ Signal data written to /tmp/signal-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
