// ─── claire-summary.mjs ────────────────────────────────────────────────────────
// Generates plain-English one-line summaries of each holding for the "Claire"
// tab on the hub. Reads the most recent signal per ticker from the history log,
// batches all 11 into one Claude call, writes docs/history/claire.json.
//
// Voice: conversational but grounded, descriptive not prescriptive, assumes
// intelligence but zero market vocabulary. One sentence each. No jargon, no
// numbers unless they genuinely aid understanding.
// ────────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";

const HISTORY_DIR  = process.env.HISTORY_DIR  || "docs/history";
const SIGNALS_FILE = process.env.SIGNALS_FILE || path.join(HISTORY_DIR, "signals.jsonl");
const OUTPUT_FILE  = process.env.OUTPUT_FILE  || path.join(HISTORY_DIR, "claire.json");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PORTFOLIO = ["MOS", "ASML", "SMH", "ENB", "ETHA", "GLNCY", "IBIT", "KOF", "PBR.A", "AMKBY", "SPY"];

// ─── PROMPT ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are translating quantitative portfolio analysis into plain English for Claire, an intelligent nursing leader at a children's hospital who has zero background in equities or markets. She's smart and curious — treat her like an adult, not a child. She just doesn't speak the vocabulary.

Your job: rewrite each holding's analyst summary into ONE sentence she can understand over dinner.

RULES:
- One sentence per holding. Natural, conversational, not breezy.
- No jargon: avoid "P/E", "RSI", "yield spread", "forward multiple", "oversold", "basis points", "beta", "composite score", "backlog", "EBITDA", etc.
- Describe what's happening, don't tell her what to do. "Looks cheap here" not "buy more." "Holding steady" not "hold."
- No numbers unless a specific number aids understanding. "Down about 8%" is fine; "trading at 32.4x forward earnings" is not.
- Vary the sentence structure across the 11 holdings — don't start every line with "X is..."
- If nothing interesting is happening, say that honestly. Boring is fine. "SPY is quiet — the broader market is having an uneventful week" is a good output.
- Ground the sentence in what's actually driving the ticker (the business, the commodity, the macro factor) rather than the score itself. She cares about why, not the number.

EXAMPLES of the voice:
- "MOS is down a bit, but fertilizer prices are steady, so nothing is really wrong with the business."
- "ASML keeps climbing, which is normal for them — they're the only company in the world that makes a certain kind of chipmaking machine, and demand keeps growing."
- "Bitcoin has been quiet, which after a big run-up is actually what you want to see."
- "Petrobras is getting a dividend boost this quarter and oil prices are cooperating, so it's a good stretch for it."

OUTPUT: a JSON object mapping each ticker symbol to its one-sentence summary. Example:
{
  "MOS": "MOS is down a bit...",
  "ASML": "ASML keeps climbing...",
  ...
}

Return ONLY the JSON object. No preamble, no markdown fences, no commentary.`;

// ─── DATA LOADING ─────────────────────────────────────────────────────────────
async function loadLatestSignals() {
  const text = await fs.readFile(SIGNALS_FILE, "utf8");
  const rows = text.split("\n").filter(l => l.trim()).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  // Latest signal per ticker
  const latest = {};
  for (const row of rows) {
    const symbol = row.symbol;
    if (!symbol) continue;
    const ts = row.timestamp || row.logged_at || row.date;
    if (!ts) continue;
    if (!latest[symbol] || ts > latest[symbol]._ts) {
      latest[symbol] = { ...row, _ts: ts };
    }
  }
  return latest;
}

function buildInputForClaude(latestSignals) {
  const rows = [];
  for (const symbol of PORTFOLIO) {
    const sig = latestSignals[symbol];
    if (!sig) {
      rows.push({ symbol, note: "no recent signal data available" });
      continue;
    }
    rows.push({
      symbol,
      recommendation: sig.composite?.recommendation ?? sig.recommendation ?? "HOLD",
      composite_score: sig.composite?.score ?? sig.composite_score ?? null,
      summary: sig.composite?.summary ?? sig.summary ?? null,
      price_change_pct: sig.price?.change_pct ?? null,
      risks: sig.risks ?? [],
      catalysts: sig.catalysts ?? [],
    });
  }
  return rows;
}

// ─── CLAUDE CALL ──────────────────────────────────────────────────────────────
async function callClaude(inputRows) {
  const userMessage = `Here are today's analyst summaries for Claire's portfolio. Translate each into one plain-English sentence per the rules.

${JSON.stringify(inputRows, null, 2)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json();
  const text = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  // Extract JSON (defensive — strip any stray fences if the model slips)
  const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not extract JSON from Claude response: " + text.slice(0, 200));
  return JSON.parse(match[0]);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!ANTHROPIC_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  console.log("[claire-summary] loading latest signals...");
  const latest = await loadLatestSignals();
  const found = Object.keys(latest).filter(s => PORTFOLIO.includes(s));
  console.log(`  found recent signals for ${found.length}/${PORTFOLIO.length} tickers`);

  const input = buildInputForClaude(latest);

  console.log("[claire-summary] calling Claude for batched translation...");
  let translations = {};
  try {
    translations = await callClaude(input);
  } catch (e) {
    console.error("[claire-summary] Claude call failed:", e.message);
    // Fall through — we'll emit "No update today" for every ticker below
  }

  // Build final output with per-ticker fallback
  const summaries = {};
  for (const symbol of PORTFOLIO) {
    const sig = latest[symbol];
    const sentence = translations[symbol];
    summaries[symbol] = {
      sentence: (typeof sentence === "string" && sentence.trim()) ? sentence.trim() : "No update today.",
      recommendation: sig?.composite?.recommendation ?? sig?.recommendation ?? null,
      composite_score: sig?.composite?.score ?? sig?.composite_score ?? null,
      signal_timestamp: sig?._ts ?? null,
    };
  }

  const output = {
    generated_at: new Date().toISOString(),
    portfolio: PORTFOLIO,
    summaries,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");

  console.log(`[claire-summary] wrote ${OUTPUT_FILE}`);
  for (const sym of PORTFOLIO) {
    console.log(`  ${sym.padEnd(8)} ${summaries[sym].sentence}`);
  }
}

main().catch(e => {
  console.error("[claire-summary] FATAL:", e);
  process.exit(1);
});
