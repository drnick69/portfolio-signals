#!/usr/bin/env node
// generate-signals.mjs — Runs all 11 models via Claude API, normalizes, picks daily 4-line output

import { writeFileSync } from "fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

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

function buildPrompt(h) {
  return `You are a SKEPTICAL quantitative analyst scoring ${h.symbol} (${h.name}).

CRITICAL CALIBRATION RULES — follow these EXACTLY:
• Scores range from -100 (max buy) to +100 (max sell). ZERO means "no edge."
• Most of the time, most stocks have NO EDGE. Your DEFAULT score should be 0 (NEUTRAL).
• Only deviate from 0 when concrete, measurable data supports it.
• RSI between 40-60 = score 0. RSI 30-40 = score -15 to -25. RSI <30 = score -40 to -60.
• RSI 60-70 = score +15 to +25. RSI >70 = score +40 to +60.
• Price within 5% of 52-week high = score +10 to +20 (NOT a buy).
• Price within 10% of 52-week low = score -10 to -20 (mild buy only).
• NEUTRAL is the correct answer most days. Resist the urge to find a signal that isn't there.
• Signal mapping: score -60 to -100 = STRONG_BUY. -25 to -59 = BUY. -24 to +24 = NEUTRAL. +25 to +59 = SELL. +60 to +100 = STRONG_SELL.

Fetch current data using web search for ${h.symbol}:
1. Current price, today's change %, 52-week high/low
2. RSI(14) estimate from recent price action
3. Key moving averages (50d, 200d)
4. Primary valuation metric for this asset type
5. The single most important sector-specific data point
6. Latest relevant news or catalyst

Return ONLY valid JSON:
{
  "symbol": "${h.symbol}",
  "timestamp": "ISO datetime",
  "price": { "current": 0, "change_pct": 0, "week52_high": 0, "week52_low": 0 },
  "tactical":   { "score": 0, "signal": "NEUTRAL", "rationale": "sentence" },
  "positional":  { "score": 0, "signal": "NEUTRAL", "rationale": "sentence" },
  "strategic":  { "score": 0, "signal": "NEUTRAL", "rationale": "sentence" },
  "composite":  { "score": 0, "recommendation": "HOLD", "summary": "sentence" },
  "key_metric": { "name": "string", "value": "string" },
  "risks": ["risk1"],
  "catalysts": ["catalyst1"]
}

Composite weights: tactical ${Math.round(h.weights.t*100)}%, positional ${Math.round(h.weights.p*100)}%, strategic ${Math.round(h.weights.s*100)}%.
Remember: NEUTRAL (score ~0) is the correct answer on most days.`;
}

async function fetchSignal(holding) {
  const MAX_RETRIES = 5;
  console.log(`  Fetching ${holding.symbol}...`);

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
          max_tokens: 16000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: buildPrompt(holding) }],
        }),
      });

      // ── RATE LIMIT HANDLING ──
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "60", 10);
        const waitSec = Math.max(retryAfter, 60);
        console.log(`  ⚠ ${holding.symbol} rate limited (429). Waiting ${waitSec}s before retry ${attempt+1}/${MAX_RETRIES}...`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, waitSec * 1000)); continue; }
        throw new Error("Rate limited after all retries");
      }

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const result = await resp.json();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      // Check stop reason
      if (result.stop_reason === "max_tokens") {
        console.log(`  ⚠ ${holding.symbol} TRUNCATED (${elapsed}s). ${attempt < MAX_RETRIES ? `Retry ${attempt+1}...` : "Giving up."}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        throw new Error("Response truncated — model ran out of tokens");
      }

      const text = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      if (!text.trim()) {
        console.log(`  ⚠ ${holding.symbol} empty response (${elapsed}s). ${attempt < MAX_RETRIES ? "Retrying..." : ""}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        throw new Error("Empty response");
      }

      // Extract JSON — try greedy first, then individual objects
      let parsed = null;
      const greedyMatch = text.match(/\{[\s\S]*\}/);
      if (greedyMatch) {
        try {
          const cleaned = greedyMatch[0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
          const candidate = JSON.parse(cleaned);
          if (candidate.tactical && candidate.positional && candidate.strategic && candidate.composite) parsed = candidate;
        } catch { /* fall through */ }
      }
      if (!parsed) {
        const matches = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
        for (let i = matches.length - 1; i >= 0; i--) {
          try {
            const cleaned = matches[i][0].replace(/```json\s*/g,"").replace(/```\s*/g,"").replace(/,\s*}/g,"}").replace(/,\s*]/g,"]");
            const c = JSON.parse(cleaned);
            if (c.tactical && c.positional && c.strategic && c.composite) { parsed = c; break; }
          } catch { /* next */ }
        }
      }
      if (!parsed) {
        console.log(`  ⚠ ${holding.symbol} no valid JSON (${elapsed}s). ${attempt < MAX_RETRIES ? "Retrying..." : ""}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        throw new Error("No valid JSON in response");
      }

      // Validate
      const issues = [];
      for (const layer of ["tactical", "positional", "strategic"]) {
        if (typeof parsed[layer]?.score !== "number" || !isFinite(parsed[layer]?.score)) issues.push(`${layer}.score invalid`);
      }
      if (typeof parsed.composite?.score !== "number") issues.push("composite.score invalid");
      if (issues.length > 2) {
        console.log(`  ⚠ ${holding.symbol} validation failed: ${issues.join("; ")}. ${attempt < MAX_RETRIES ? "Retrying..." : ""}`);
        if (attempt < MAX_RETRIES) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
        throw new Error(`Validation: ${issues.join("; ")}`);
      }

      const grade = issues.length === 0 ? "A" : "B";
      console.log(`  ✓ ${holding.symbol} grade ${grade} (${elapsed}s) — composite: ${parsed.composite?.score}`);
      return { ...parsed, _holding: holding, _grade: grade };
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`  ✗ ${holding.symbol}: ${e.message}`);
        return null;
      }
      console.log(`  ⚠ ${holding.symbol} attempt ${attempt} error: ${e.message.slice(0, 80)}. Retry in ${2*attempt}s...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  return null;
}

function normalize(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length < 3) return { normalized: valid, assignments: null };

  const layers = ["tactical", "positional", "strategic", "composite"];
  const stats = {};

  for (const layer of layers) {
    const scores = valid.map(s => (layer === "composite" ? s.composite : s[layer])?.score ?? 0);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stddev = Math.sqrt(variance) || 1;
    stats[layer] = { mean, stddev, scores };
  }

  const normalized = valid.map(s => {
    const z = {};
    for (const layer of layers) {
      const raw = (layer === "composite" ? s.composite : s[layer])?.score ?? 0;
      z[layer] = (raw - stats[layer].mean) / stats[layer].stddev;
    }
    return { ...s, z };
  });

  // Assign signal budget
  const used = new Set();
  const assignments = { tacticalBuy: null, positionalBuy: null, strategicBuy: null, trim: null };

  // Trim first (highest composite z-score = weakest)
  const trimRanked = [...normalized].sort((a, b) => b.z.composite - a.z.composite);
  for (const s of trimRanked) {
    if (!used.has(s.symbol)) { assignments.trim = s.symbol; used.add(s.symbol); break; }
  }

  // Tactical buy (lowest tactical z)
  const tacRanked = [...normalized].sort((a, b) => a.z.tactical - b.z.tactical);
  for (const s of tacRanked) {
    if (!used.has(s.symbol)) { assignments.tacticalBuy = s.symbol; used.add(s.symbol); break; }
  }

  // Positional buy
  const posRanked = [...normalized].sort((a, b) => a.z.positional - b.z.positional);
  for (const s of posRanked) {
    if (!used.has(s.symbol)) { assignments.positionalBuy = s.symbol; used.add(s.symbol); break; }
  }

  // Strategic buy
  const strRanked = [...normalized].sort((a, b) => a.z.strategic - b.z.strategic);
  for (const s of strRanked) {
    if (!used.has(s.symbol)) { assignments.strategicBuy = s.symbol; used.add(s.symbol); break; }
  }

  return { normalized, assignments };
}

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
      const roleColor =
        s.symbol === assignments.trim ? "#ff6b6b" :
        role.includes("BUY") ? "#4ecdc4" : "#556677";
      const h = HOLDINGS.find(h => h.symbol === s.symbol);
      const km = s.key_metric;
      const compScore = s.composite?.score ?? 0;
      const tacScore = s.tactical?.score ?? 0;
      const posScore = s.positional?.score ?? 0;
      const strScore = s.strategic?.score ?? 0;
      // 52w range position as percentage
      const w52pct = (s.price?.week52_high && s.price?.week52_low && s.price?.current)
        ? Math.round(((s.price.current - s.price.week52_low) / (s.price.week52_high - s.price.week52_low)) * 100)
        : null;

      return `
      <tr style="border-bottom: 1px solid #0f1520;">
        <td style="padding: 10px 10px; color: #445566; font-size: 11px; text-align: center;">${i+1}</td>
        <td style="padding: 10px 8px;">
          <div style="font-weight: 800; font-size: 14px; color: #e0e8f0; line-height: 1.2;">${s.symbol}</div>
          <div style="font-size: 10px; color: #556677; margin-top: 2px;">${h?.name || ""}</div>
        </td>
        <td style="padding: 10px 8px; text-align: right;">
          <div style="font-size: 14px; font-weight: 700; color: #e0e8f0;">$${s.price?.current?.toFixed?.(2) || "—"}</div>
          <div style="font-size: 10px; color: ${chgClr(s.price?.change_pct)}; margin-top: 2px;">${chgFmt(s.price?.change_pct)}</div>
        </td>
        <td style="padding: 10px 8px; text-align: center;">
          <div style="font-size: 16px; font-weight: 800; color: ${scoreClr(compScore)};">${compScore}</div>
          <div style="font-size: 9px; color: #445566; margin-top: 2px;">COMP</div>
        </td>
        <td style="padding: 10px 6px; text-align: center;">
          <div style="font-size: 11px; color: ${scoreClr(tacScore)};">${tacScore}</div>
          <div style="font-size: 9px; color: #334455;">TAC</div>
        </td>
        <td style="padding: 10px 6px; text-align: center;">
          <div style="font-size: 11px; color: ${scoreClr(posScore)};">${posScore}</div>
          <div style="font-size: 9px; color: #334455;">POS</div>
        </td>
        <td style="padding: 10px 6px; text-align: center;">
          <div style="font-size: 11px; color: ${scoreClr(strScore)};">${strScore}</div>
          <div style="font-size: 9px; color: #334455;">STR</div>
        </td>
        <td style="padding: 10px 8px;">
          <div style="font-size: 10px; color: ${roleColor}; font-weight: 700;">${role}</div>
          ${w52pct !== null ? `<div style="font-size: 9px; color: #445566; margin-top: 3px;">52w: ${w52pct}%</div>` : ""}
        </td>
        <td style="padding: 10px 8px;">
          ${km ? `<div style="font-size: 10px; color: #889aaa;"><span style="color: #556677;">${km.name}:</span> ${km.value}</div>` : `<div style="font-size: 10px; color: #334455;">—</div>`}
        </td>
      </tr>`;
    }).join("");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background: #05080e; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;">
  <div style="max-width: 800px; margin: 0 auto; padding: 32px 24px;">

    <!-- Header -->
    <div style="border-bottom: 2px solid #1a2332; padding-bottom: 20px; margin-bottom: 28px;">
      <h1 style="margin: 0; font-size: 20px; color: #e0e8f0; letter-spacing: 0.04em;">PORTFOLIO STRATEGY SIGNAL</h1>
      <p style="margin: 6px 0 0; font-size: 12px; color: #556677;">${date} • 11 Holdings • Z-Score Normalized</p>
    </div>

    <!-- Daily 4-Line Output -->
    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <thead>
        <tr style="border-bottom: 2px solid #1a2332;">
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566; letter-spacing: 0.1em;">SIGNAL</th>
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">TICKER</th>
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">NAME</th>
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">PRICE</th>
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">CHG</th>
          <th style="padding: 12px 16px; text-align: left; font-size: 10px; color: #445566;">THESIS</th>
        </tr>
      </thead>
      <tbody>
        ${signalRow("TACTICAL BUY",   "⚡", "#00ff88", assignments.tacticalBuy)}
        ${signalRow("POSITIONAL BUY", "📐", "#4ecdc4", assignments.positionalBuy)}
        ${signalRow("STRATEGIC BUY",  "🏗️", "#5b8dee", assignments.strategicBuy)}
        ${signalRow("TRIM",           "✂️", "#ff6b6b", assignments.trim)}
      </tbody>
    </table>

    <!-- Composite Rankings 1–11 -->
    <div style="margin-bottom: 12px;">
      <h2 style="font-size: 13px; color: #667788; letter-spacing: 0.1em; margin: 0 0 4px;">COMPOSITE RANKINGS</h2>
      <p style="font-size: 10px; color: #334455; margin: 0 0 12px;">Sorted by normalized z-score — strongest buy opportunity at top, weakest at bottom</p>
    </div>
    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <thead>
        <tr style="border-bottom: 2px solid #1a2332;">
          <th style="padding: 10px 10px; text-align: center; font-size: 9px; color: #445566; letter-spacing: 0.08em;">#</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">HOLDING</th>
          <th style="padding: 10px 8px; text-align: right; font-size: 9px; color: #445566;">PRICE</th>
          <th style="padding: 10px 8px; text-align: center; font-size: 9px; color: #445566;">COMP</th>
          <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">TAC</th>
          <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">POS</th>
          <th style="padding: 10px 6px; text-align: center; font-size: 9px; color: #445566;">STR</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">ROLE</th>
          <th style="padding: 10px 8px; text-align: left; font-size: 9px; color: #445566;">KEY METRIC</th>
        </tr>
      </thead>
      <tbody>${rankingRows}</tbody>
    </table>

    <!-- Per-Holding Rationale -->
    <div style="margin-bottom: 12px;">
      <h2 style="font-size: 13px; color: #667788; letter-spacing: 0.1em; margin: 0 0 12px;">RATIONALE BY HOLDING</h2>
    </div>
    <table style="width: 100%; border-collapse: collapse; background: #0a0f18; border: 1px solid #1a2332; border-radius: 8px; margin-bottom: 28px;">
      <tbody>
        ${[...normalized].sort((a, b) => (a.z?.composite ?? 0) - (b.z?.composite ?? 0)).map(s => {
          const role =
            s.symbol === assignments.tacticalBuy   ? "⚡" :
            s.symbol === assignments.positionalBuy  ? "📐" :
            s.symbol === assignments.strategicBuy   ? "🏗️" :
            s.symbol === assignments.trim           ? "✂️" : "";
          return `
        <tr style="border-bottom: 1px solid #0f1520;">
          <td style="padding: 12px 14px; vertical-align: top; width: 80px;">
            <div style="font-weight: 800; font-size: 13px; color: #e0e8f0;">${role} ${s.symbol}</div>
          </td>
          <td style="padding: 12px 14px; vertical-align: top;">
            <div style="font-size: 11px; color: #889aaa; line-height: 1.6; margin-bottom: 4px;">${s.composite?.summary || "—"}</div>
            <div style="font-size: 10px; color: #556677;">
              <span style="color: #445566;">Tactical:</span> ${s.tactical?.rationale || "—"}
            </div>
          </td>
        </tr>`;
        }).join("")}
      </tbody>
    </table>

    <!-- Footer -->
    <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #141e2e; font-size: 10px; color: #334455; line-height: 1.6;">
      <p>Signals are z-score normalized across the portfolio. Only the strongest relative signal per timeframe receives an actionable recommendation. All other holdings are HOLD regardless of raw score.</p>
      <p>Generated by Portfolio Strategy Hub v2.0</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Portfolio Strategy Signal Generator");
  console.log("===================================");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Holdings: ${HOLDINGS.length}\n`);

  // Run ONE at a time with 60s cooldowns.
  // Your API tier has a 30k input tokens/min limit.
  // Each web-search call uses ~10-15k tokens, so we need ≥60s between calls.
  const allSignals = [];
  for (let i = 0; i < HOLDINGS.length; i++) {
    const h = HOLDINGS[i];
    console.log(`\n[${i+1}/${HOLDINGS.length}] ${h.symbol} (${h.name})`);
    const result = await fetchSignal(h);
    allSignals.push(result);
    if (i < HOLDINGS.length - 1) {
      console.log("  (60s cooldown — rate limit compliance)");
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  const validCount = allSignals.filter(Boolean).length;
  console.log(`\n✓ Fetched ${validCount}/${HOLDINGS.length} signals`);

  if (validCount < 4) {
    console.error("Too few valid signals for normalization. Aborting.");
    process.exit(1);
  }

  const { normalized, assignments } = normalize(allSignals);

  console.log("\n─── DAILY SIGNAL ───────────────────────");
  console.log(`  TACTICAL BUY:   ${assignments.tacticalBuy}`);
  console.log(`  POSITIONAL BUY: ${assignments.positionalBuy}`);
  console.log(`  STRATEGIC BUY:  ${assignments.strategicBuy}`);
  console.log(`  TRIM:           ${assignments.trim}`);
  console.log("────────────────────────────────────────\n");

  // Write outputs
  const emailHTML = buildEmailHTML(normalized, assignments);
  writeFileSync("/tmp/signal-email.html", emailHTML);
  writeFileSync("/tmp/signal-data.json", JSON.stringify({ normalized, assignments, timestamp: new Date().toISOString() }, null, 2));

  console.log("✓ Email HTML written to /tmp/signal-email.html");
  console.log("✓ Signal data written to /tmp/signal-data.json");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
