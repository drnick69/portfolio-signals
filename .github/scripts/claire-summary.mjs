// ─── claire-summary.mjs ────────────────────────────────────────────────────────
// Generates plain-English one-line summaries of each holding for the "Claire"
// tab on the hub. Reads the latest entry from docs/history/daily-log.jsonl,
// batches all 11 holdings into one Claude call, writes docs/history/claire.json.
//
// Voice: conversational but grounded, descriptive not prescriptive, assumes
// intelligence but zero market vocabulary. One sentence each. No jargon, no
// numbers unless they genuinely aid understanding.
// ────────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";

const HISTORY_DIR  = process.env.HISTORY_DIR  || "docs/history";
const LOG_FILE     = process.env.LOG_FILE     || path.join(HISTORY_DIR, "daily-log.jsonl");
const OUTPUT_FILE  = process.env.OUTPUT_FILE  || path.join(HISTORY_DIR, "claire.json");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PORTFOLIO = ["MOS", "ASML", "LIN", "ENB", "ETHA", "GLNCY", "IBIT", "KOF", "PBR.A", "AMKBY", "SPY"];

// ─── TICKER IDENTITY MAP ──────────────────────────────────────────────────────
// Explicit disambiguation — some ADR tickers (AMKBY especially) are easy for
// LLMs to confuse with similar-sounding tickers. Keep this authoritative.
const TICKER_IDENTITY = {
  "MOS":   { name: "Mosaic Company",       business: "North American fertilizer producer (potash and phosphate)" },
  "ASML":  { name: "ASML Holding",         business: "Dutch company that makes the lithography machines used to print advanced computer chips — the sole supplier of EUV machines worldwide" },
  "LIN":   { name: "Linde plc",            business: "world's largest industrial gas company — supplies oxygen, nitrogen, hydrogen, helium, and argon to hospitals, factories, and electronics manufacturers under long-term contracts" },
  "ENB":   { name: "Enbridge",             business: "Canadian pipeline operator — moves oil and natural gas across North America, acts like a toll road" },
  "ETHA":  { name: "iShares Ethereum ETF", business: "spot Ethereum exposure (ETHA tracks the price of ether, the second-largest cryptocurrency)" },
  "GLNCY": { name: "Glencore plc",         business: "diversified miner AND the world's largest commodity trading house — mines copper, cobalt, nickel, and profits from commodity market volatility" },
  "IBIT":  { name: "iShares Bitcoin ETF",  business: "spot Bitcoin exposure" },
  "KOF":   { name: "Coca-Cola FEMSA",      business: "largest Coca-Cola bottler in Latin America, based in Mexico" },
  "PBR.A": { name: "Petrobras (preferred shares)", business: "Brazilian state-controlled oil major — one of the world's biggest dividend payers when oil is high" },
  "AMKBY": { name: "A.P. Møller-Mærsk",    business: "Danish container shipping and integrated logistics giant — a bellwether for global trade. Note: AMKBY is Maersk; it is NOT AmBev (the Brazilian beer company, ticker ABEV) and NOT any other company." },
  "SPY":   { name: "SPDR S&P 500 ETF",     business: "the broad US stock market — owning SPY is owning the 500 largest American companies" },
};

// ─── PROMPT ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are translating quantitative portfolio analysis into plain English for Claire, an intelligent nursing leader at a children's hospital who has zero background in equities or markets. She's smart and curious — treat her like an adult, not a child. She just doesn't speak the vocabulary.

Your job: rewrite each holding's analyst summary into ONE sentence she can understand over dinner.

TICKER GLOSSARY — use these exact company identities, do not substitute or infer:
- MOS     = Mosaic Company (North American fertilizer producer)
- ASML    = ASML Holding (Dutch maker of EUV chipmaking machines)
- LIN     = Linde plc (world's largest industrial gas supplier — oxygen, nitrogen, hydrogen, etc.)
- ENB     = Enbridge (Canadian oil & gas pipeline operator)
- ETHA    = iShares Ethereum ETF (spot Ethereum / ether exposure)
- GLNCY   = Glencore plc (diversified miner + world's largest commodity trading house)
- IBIT    = iShares Bitcoin ETF (spot Bitcoin exposure)
- KOF     = Coca-Cola FEMSA (Mexican Coca-Cola bottler for Latin America)
- PBR.A   = Petrobras preferred shares (Brazilian state oil major)
- AMKBY   = A.P. Møller-Mærsk (Danish container shipping / logistics giant)
- SPY     = SPDR S&P 500 ETF (broad US stock market)

CRITICAL DISAMBIGUATION:
- AMKBY is A.P. Møller-Mærsk. It is NEVER AmBev. AmBev is the Brazilian beer company with ticker ABEV, which is not in this portfolio. If you are about to write the word "beer," "brewer," "AmBev," or "beverage" in an AMKBY sentence, STOP — you have the wrong company. Maersk moves containers on ships.
- GLNCY is Glencore, not Glencoe or anything else.
- PBR.A is Petrobras preferred stock — a Brazilian oil company, not a consumer brand.
- LIN is Linde, the industrial gas company. It is NOT LinkedIn and NOT a Chinese company.

RULES:
- One sentence per holding. Natural, conversational, not breezy.
- No jargon: avoid "P/E", "RSI", "yield spread", "forward multiple", "oversold", "basis points", "beta", "composite score", "EBITDA", etc.
- Describe what's happening, don't tell her what to do. "Looks cheap here" not "buy more." "Holding steady" not "hold."
- No numbers unless a specific number aids understanding. "Down about 8%" is fine; "trading at 32.4x forward earnings" is not.
- Vary the sentence structure across the 11 holdings — don't start every line with "X is..."
- If nothing interesting is happening, say that honestly. Boring is fine. "SPY is quiet — the broader market is having an uneventful week" is a good output.
- Ground the sentence in what's actually driving the ticker (the business, the commodity, the macro factor) rather than the score itself. She cares about why, not the number.

EXAMPLES of the voice:
- "MOS is down a bit, but fertilizer prices are steady, so nothing is really wrong with the business."
- "ASML keeps climbing, which is normal for them — they're the only company in the world that makes a certain kind of chipmaking machine, and demand keeps growing."
- "Linde is having a quiet week — industrial gas demand is steady and they keep raising prices a little each quarter, which is the whole story with this one."
- "Bitcoin has been quiet, which after a big run-up is actually what you want to see."
- "Petrobras is getting a dividend boost this quarter and oil prices are cooperating, so it's a good stretch for it."
- "Maersk is having a steady week — global shipping rates haven't moved much, and that tends to mean the world economy is humming along."

OUTPUT: a JSON object mapping each ticker symbol to its one-sentence summary. Example:
{
  "MOS": "MOS is down a bit...",
  "ASML": "ASML keeps climbing...",
  ...
}

Return ONLY the JSON object. No preamble, no markdown fences, no commentary.`;

// ─── DATA LOADING ─────────────────────────────────────────────────────────────
async function loadLatestDailyEntry() {
  const text = await fs.readFile(LOG_FILE, "utf8");
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;
  // Latest entry is the last valid line
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* skip malformed */ }
  }
  return null;
}

function buildInputForClaude(dailyEntry) {
  // daily-log.jsonl schema: { date, timestamp, assignments, macro, holdings: [...] }
  const byHolding = {};
  for (const h of (dailyEntry.holdings || [])) byHolding[h.symbol] = h;

  const rows = [];
  for (const symbol of PORTFOLIO) {
    const identity = TICKER_IDENTITY[symbol] || { name: symbol, business: "" };
    const h = byHolding[symbol];
    if (!h) {
      rows.push({
        symbol,
        company_name: identity.name,
        what_it_is:   identity.business,
        note:         "no data for this holding today",
      });
      continue;
    }
    rows.push({
      symbol,
      company_name:      identity.name,
      what_it_is:        identity.business,
      recommendation:    h.composite?.recommendation ?? "HOLD",
      composite_score:   h.composite?.blended ?? null,
      tactical_signal:   h.tactical?.signal ?? null,
      positional_signal: h.positional?.signal ?? null,
      strategic_signal:  h.strategic?.signal ?? null,
      price_change_pct:  h.change_pct ?? null,
      role:              h.role ?? null,
      key_metric:        h.key_metric ?? null,
    });
  }
  return rows;
}

// ─── CLAUDE CALL ──────────────────────────────────────────────────────────────
async function callClaude(inputRows) {
  const userMessage = `Here are today's analyst summaries for Claire's portfolio. Each row includes the ticker, the exact company name, and what the business actually does — use those as the source of truth for identifying each holding. Translate each into one plain-English sentence per the rules.

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

  console.log("[claire-summary] loading latest daily entry...");
  const daily = await loadLatestDailyEntry();
  if (!daily) {
    console.error(`[claire-summary] no entries in ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`  latest entry: ${daily.date} with ${daily.holdings?.length ?? 0} holdings`);

  const input = buildInputForClaude(daily);

  console.log("[claire-summary] calling Claude for batched translation...");
  let translations = {};
  try {
    translations = await callClaude(input);
  } catch (e) {
    console.error("[claire-summary] Claude call failed:", e.message);
    // Fall through — "No update today" per ticker below
  }

  // Build final output
  const byHolding = {};
  for (const h of (daily.holdings || [])) byHolding[h.symbol] = h;

  const summaries = {};
  for (const symbol of PORTFOLIO) {
    const h = byHolding[symbol];
    const sentence = translations[symbol];
    summaries[symbol] = {
      sentence: (typeof sentence === "string" && sentence.trim()) ? sentence.trim() : "No update today.",
      recommendation:  h?.composite?.recommendation ?? null,
      composite_score: h?.composite?.blended ?? null,
      signal_date:     daily.date ?? null,
    };
  }

  const output = {
    generated_at: new Date().toISOString(),
    signal_date:  daily.date,
    portfolio:    PORTFOLIO,
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
