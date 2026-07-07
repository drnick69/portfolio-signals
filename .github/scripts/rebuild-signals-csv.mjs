// ─── claire-summary.mjs ────────────────────────────────────────────────────────
// Generates plain-English one-line summaries of each holding for the "Claire"
// tab on the hub. Reads the latest entry from docs/history/daily-log.jsonl,
// batches all 12 holdings into one Claude call, writes docs/history/claire.json.
//
// Voice: conversational but grounded, descriptive not prescriptive, assumes
// intelligence but zero market vocabulary. One sentence each. No jargon, no
// numbers unless they genuinely aid understanding.
//
// v2.0 (June 2026): ENSEMBLE VOTING + VERIFICATION GATE.
//   - Model claude-sonnet-4-20250514 → claude-opus-4-8.
//   - Ensemble: N independent candidate sets (CLAIRE_ENSEMBLE_N, default 3),
//     generated sequentially so calls 2..N read the cached prompt. Per ticker,
//     the winning sentence is the consensus medoid — the candidate most similar
//     (token Jaccard) to the other candidates — so a single hallucinated outlier
//     gets outvoted instead of shipped.
//   - Verification gate, run on every candidate before voting:
//       HARD (disqualifies candidate): per-ticker identity violations (the
//       documented AMKBY/LIN/GLNCY confusions), and direction contradictions —
//       sentence says the stock moved one way while price_change_pct moved the
//       other way beyond ±2pp (idiom-guarded: "wind down" etc. don't trip it).
//       SOFT (selection penalty): jargon blacklist from the prompt rules,
//       prescriptive phrasing ("you should buy"), and numeric claims that don't
//       match price_change_pct within 2pp — numbers are the verbatim "quotes" of
//       this layer and must match the data or stay out.
//     All candidates hard-fail → "No update today." + console warning (never
//     ship an unverified sentence to Claire's tab).
//   - Prompt caching: cache_control on system + user blocks; identical across
//     the N calls within a run, so candidates 2..N are nearly all cache reads.
//   - One retry per candidate call; ensemble proceeds with whatever succeeded.
//   - Output additive: per-ticker gate ("pass" | "soft" | "fallback"), top-level
//     ensemble { samples_requested, samples_ok }. Existing fields unchanged.
//
// v2.1 (July 2026): DATA_QUALITY RENDERING — the follow-up flagged in
//   generate-signals v8.1.1. The daily-log entry now carries the run's
//   completeness audit (log-signals v8.1.1); Claire's tab was the last surface
//   that could still make a partial run look healthy. When complete === false:
//   - top-level run_note: one deterministic plain-English sentence naming the
//     holdings that weren't scored (built from TICKER_IDENTITY — NOT LLM-
//     generated, so an incomplete-run notice can never itself hallucinate);
//   - each missing holding's summary is an honest deterministic sentence with
//     gate "missing" (the LLM never sees or invents content for a holding that
//     wasn't scored — its data rows aren't in the input anyway);
//   - data_quality passes through to claire.json for the dashboard.
//   Complete runs are unchanged (no run_note key). Additive only.
// ────────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";

const HISTORY_DIR  = process.env.HISTORY_DIR  || "docs/history";
const LOG_FILE     = process.env.LOG_FILE     || path.join(HISTORY_DIR, "daily-log.jsonl");
const OUTPUT_FILE  = process.env.OUTPUT_FILE  || path.join(HISTORY_DIR, "claire.json");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL_ID = "claude-opus-4-8";
const ENSEMBLE_N = Math.max(1, parseInt(process.env.CLAIRE_ENSEMBLE_N || "3", 10));

const PORTFOLIO = ["LHX", "ASML", "LIN", "MSFT", "TMO", "ENB", "NOW", "GLNCY", "IBIT", "KOF", "PBR.A", "AMKBY"];

// ─── TICKER IDENTITY MAP ──────────────────────────────────────────────────────
// Explicit disambiguation — some ADR tickers (AMKBY especially) are easy for
// LLMs to confuse with similar-sounding tickers. Keep this authoritative.
const TICKER_IDENTITY = {
  "LHX":   { name: "L3Harris Technologies", business: "American defense prime contractor — makes communications systems, electronic warfare gear, ISR/spy systems, and rocket motors for the US military. Smallest of the five big defense primes (Lockheed, Northrop, Raytheon, General Dynamics, L3Harris) and historically trades at a discount to the larger four" },
  "ASML":  { name: "ASML Holding",         business: "Dutch company that makes the lithography machines used to print advanced computer chips — the sole supplier of EUV machines worldwide" },
  "LIN":   { name: "Linde plc",            business: "world's largest industrial gas company — supplies oxygen, nitrogen, hydrogen, helium, and argon to hospitals, factories, and electronics manufacturers under long-term contracts" },
  "MSFT":  { name: "Microsoft",            business: "the software giant behind Windows, Office, and Xbox — but its biggest growth engine now is the Azure cloud service, which rents out the computing power that AI companies need, plus a major partnership with OpenAI (the maker of ChatGPT)" },
  "TMO":   { name: "Thermo Fisher Scientific", business: "the world's largest supplier of laboratory equipment and bioprocessing tools — sells to biotech companies, pharma, hospitals, and research labs. Often called the 'picks-and-shovels' supplier for the entire life sciences industry" },
  "ENB":   { name: "Enbridge",             business: "Canadian pipeline operator — moves oil and natural gas across North America, acts like a toll road" },
  "NOW":   { name: "ServiceNow",           business: "enterprise software company that helps large organizations automate their internal workflows — IT operations, HR requests, customer service ticketing — and is now a leading provider of 'agentic AI' tools that let companies deploy AI assistants for routine business tasks. Used heavily by Fortune 500 companies and the US federal government" },
  "GLNCY": { name: "Glencore plc",         business: "diversified miner AND the world's largest commodity trading house — mines copper, cobalt, nickel, and profits from commodity market volatility" },
  "IBIT":  { name: "iShares Bitcoin ETF",  business: "spot Bitcoin exposure" },
  "KOF":   { name: "Coca-Cola FEMSA",      business: "largest Coca-Cola bottler in Latin America, based in Mexico" },
  "PBR.A": { name: "Petrobras (preferred shares)", business: "Brazilian state-controlled oil major — one of the world's biggest dividend payers when oil is high" },
  "AMKBY": { name: "A.P. Møller-Mærsk",    business: "Danish container shipping and integrated logistics giant — a bellwether for global trade. Note: AMKBY is Maersk; it is NOT AmBev (the Brazilian beer company, ticker ABEV) and NOT any other company." },
};

// ─── PROMPT ───────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are translating quantitative portfolio analysis into plain English for Claire, an intelligent nursing leader at a children's hospital who has zero background in equities or markets. She's smart and curious — treat her like an adult, not a child. She just doesn't speak the vocabulary.

Your job: rewrite each holding's analyst summary into ONE sentence she can understand over dinner.

TICKER GLOSSARY — use these exact company identities, do not substitute or infer:
- LHX     = L3Harris Technologies (American defense prime — comms systems, electronic warfare, ISR, rocket motors)
- ASML    = ASML Holding (Dutch maker of EUV chipmaking machines)
- LIN     = Linde plc (world's largest industrial gas supplier — oxygen, nitrogen, hydrogen, etc.)
- MSFT    = Microsoft (Windows/Office/Xbox plus Azure cloud powering AI plus OpenAI partnership)
- TMO     = Thermo Fisher Scientific (world's largest life sciences lab equipment and bioprocessing supplier)
- ENB     = Enbridge (Canadian oil & gas pipeline operator)
- NOW     = ServiceNow (enterprise software that automates IT/HR/customer service workflows, increasingly via AI agents; heavy Fortune 500 and US federal government customer base)
- GLNCY   = Glencore plc (diversified miner + world's largest commodity trading house)
- IBIT    = iShares Bitcoin ETF (spot Bitcoin exposure)
- KOF     = Coca-Cola FEMSA (Mexican Coca-Cola bottler for Latin America)
- PBR.A   = Petrobras preferred shares (Brazilian state oil major)
- AMKBY   = A.P. Møller-Mærsk (Danish container shipping / logistics giant)

CRITICAL DISAMBIGUATION:
- AMKBY is A.P. Møller-Mærsk. It is NEVER AmBev. AmBev is the Brazilian beer company with ticker ABEV, which is not in this portfolio. If you are about to write the word "beer," "brewer," "AmBev," or "beverage" in an AMKBY sentence, STOP — you have the wrong company. Maersk moves containers on ships.
- GLNCY is Glencore, not Glencoe or anything else.
- PBR.A is Petrobras preferred stock — a Brazilian oil company, not a consumer brand.
- LIN is Linde, the industrial gas company. It is NOT LinkedIn and NOT a Chinese company.
- NOW is the ticker for ServiceNow, the enterprise workflow-automation software company. It is NEVER a generic adverb and NEVER any retail or consumer brand. ServiceNow's product helps big companies and government agencies automate the boring, repetitive parts of running an organization — IT tickets, HR forms, employee onboarding — and they're now leaders in deploying AI agents to do this work autonomously.

RULES:
- One sentence per holding. Natural, conversational, not breezy.
- No jargon: avoid "P/E", "RSI", "yield spread", "forward multiple", "oversold", "basis points", "beta", "composite score", "EBITDA", etc.
- Describe what's happening, don't tell her what to do. "Looks cheap here" not "buy more." "Holding steady" not "hold."
- No numbers unless a specific number aids understanding. "Down about 8%" is fine; "trading at 32.4x forward earnings" is not.
- Vary the sentence structure across the 12 holdings — don't start every line with "X is..."
- If nothing interesting is happening, say that honestly. Boring is fine. "Microsoft is quiet — the AI infrastructure story keeps grinding along without any drama" is a good output.
- Ground the sentence in what's actually driving the ticker (the business, the commodity, the macro factor) rather than the score itself. She cares about why, not the number.
- Any number you state must come directly from the data rows provided — never from memory. If you can't point to it in the row, leave the number out.

EXAMPLES of the voice:
- "L3Harris is down a bit, but defense spending is on a steady tailwind, so nothing has really changed about the business."
- "ASML keeps climbing, which is normal for them — they're the only company in the world that makes a certain kind of chipmaking machine, and demand keeps growing."
- "Linde is having a quiet week — industrial gas demand is steady and they keep raising prices a little each quarter, which is the whole story with this one."
- "Bitcoin has been quiet, which after a big run-up is actually what you want to see."
- "Petrobras is getting a dividend boost this quarter and oil prices are cooperating, so it's a good stretch for it."
- "Maersk is having a steady week — global shipping rates haven't moved much, and that tends to mean the world economy is humming along."
- "ServiceNow is holding up well — corporate IT departments keep signing on for their AI tools, and those tend to be long-term contracts that take years to wind down."

OUTPUT: a JSON object mapping each ticker symbol to its one-sentence summary. Example:
{
  "LHX": "L3Harris is down a bit...",
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

// ─── VERIFICATION GATE (v2.0) ─────────────────────────────────────────────────
// Verifies each candidate sentence against the authoritative input row before it
// is allowed to compete in the ensemble vote. Numbers and direction words are
// this layer's verbatim "quotes" — they must match the data or the sentence
// doesn't ship. HARD violations disqualify a candidate; SOFT violations only
// penalize selection.

// Per-ticker identity poison words (from CRITICAL DISAMBIGUATION). Hard.
const HARD_BANNED_BY_TICKER = {
  "AMKBY": [/\bbeer\b/i, /\bbrewer\w*\b/i, /\bbrewing\b/i, /\bambev\b/i, /\babev\b/i, /\bbeverage\w*\b/i],
  "LIN":   [/\blinkedin\b/i],
  "GLNCY": [/\bglencoe\b/i],
};

// Jargon blacklist (from prompt RULES). Soft.
const JARGON_RES = [
  /\bP\/E\b/i, /\bRSI\b/, /\byield spread\b/i, /\bforward multiple\b/i,
  /\boversold\b/i, /\boverbought\b/i, /\bbasis points?\b/i, /\bbeta\b/i,
  /\bcomposite score\b/i, /\bEBITDA\b/i,
];

// Prescriptive phrasing (descriptive-not-prescriptive rule). Soft.
const PRESCRIPTIVE_RES = [/\byou should\b/i, /\bbuy more\b/i, /\btime to (?:buy|sell|trim)\b/i];

// Direction word lists for contradiction checks. Idioms that contain direction
// words but don't describe price movement are neutralized before scanning.
const IDIOM_GUARDS = [/wind(?:ing|s)? down/gi, /slow(?:ing|s)? down/gi, /calm(?:ing|s)? down/gi, /cool(?:ing|s)? down/gi, /settl(?:e|es|ing) down/gi, /down the road/gi, /up to\b/gi, /sign(?:ing|s|ed)? up\b/gi, /hold(?:ing|s)? up\b/gi, /set(?:ting)? up\b/gi, /make(?:s)? up\b/gi, /up and running/gi];
const DOWN_RE = /\b(?:down|dropp?ed|dropping|fell|falling|declined?|declining|slipp?ed|slipping|slid|sliding|pull(?:ed|ing)? back|sold off|sell-?off|tumbl(?:ed|ing))\b/i;
const UP_RE   = /\b(?:up|climb(?:ed|ing|s)?|rose|rising|rall(?:ied|ying)|jump(?:ed|ing)?|gain(?:ed|ing|s)?|surg(?:ed|ing)|popp?ed)\b/i;
const DIRECTION_TOLERANCE_PP = 2.0;   // contradiction only counts beyond ±2pp
const NUMERIC_TOLERANCE_PP   = 2.0;   // % claims must land within 2pp of actual

function verifySentence(symbol, sentence, row) {
  const hard = [];
  const soft = [];
  if (typeof sentence !== "string" || !sentence.trim()) {
    return { hard: ["empty"], soft: [] };
  }

  // Identity gate (hard)
  for (const re of (HARD_BANNED_BY_TICKER[symbol] || [])) {
    if (re.test(sentence)) hard.push(`identity:${re.source}`);
  }

  // Direction gate (hard, idiom-guarded, only when the move is unambiguous)
  const chg = row?.price_change_pct;
  if (typeof chg === "number") {
    let scan = sentence;
    for (const g of IDIOM_GUARDS) scan = scan.replace(g, " ");
    if (chg >= DIRECTION_TOLERANCE_PP && DOWN_RE.test(scan) && !UP_RE.test(scan)) {
      hard.push(`direction:says_down_actual_+${chg}`);
    }
    if (chg <= -DIRECTION_TOLERANCE_PP && UP_RE.test(scan) && !DOWN_RE.test(scan)) {
      hard.push(`direction:says_up_actual_${chg}`);
    }
  }

  // Numeric gate (soft): any % stated must match |price_change_pct| within 2pp.
  const pctMatches = [...sentence.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m => parseFloat(m[1]));
  for (const n of pctMatches) {
    if (typeof chg === "number" && Math.abs(n - Math.abs(chg)) <= NUMERIC_TOLERANCE_PP) continue;
    soft.push(`number:unverified_${n}%`);
  }

  // Jargon gate (soft)
  for (const re of JARGON_RES) if (re.test(sentence)) soft.push(`jargon:${re.source}`);

  // Prescriptive gate (soft)
  for (const re of PRESCRIPTIVE_RES) if (re.test(sentence)) soft.push(`prescriptive:${re.source}`);

  return { hard, soft };
}

// ─── ENSEMBLE VOTE (v2.0) ─────────────────────────────────────────────────────
// Per ticker: gate every candidate; among hard-passing candidates pick the
// consensus medoid (highest summed token-Jaccard similarity to the other
// candidates), with soft violations as a penalty. A lone hallucination diverges
// from the consensus and loses; if everything hard-fails, ship the fallback.

function tokenize(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9\s%]/g, " ").split(/\s+/).filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

const SOFT_PENALTY = 10;

function voteOnSentences(symbol, candidates, row) {
  const gated = candidates.map((sentence, i) => ({ i, sentence, ...verifySentence(symbol, sentence, row) }));
  const eligible = gated.filter(c => c.hard.length === 0);
  const rejected = gated.filter(c => c.hard.length > 0);

  if (eligible.length === 0) {
    return { sentence: null, gate: "fallback", rejected, picked: null };
  }

  const tokens = eligible.map(c => tokenize(c.sentence));
  let best = null;
  for (let k = 0; k < eligible.length; k++) {
    let consensus = 0;
    for (let j = 0; j < eligible.length; j++) {
      if (j !== k) consensus += jaccard(tokens[k], tokens[j]);
    }
    const score = consensus - SOFT_PENALTY * eligible[k].soft.length;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && eligible[k].soft.length < best.cand.soft.length)
    ) {
      best = { score, cand: eligible[k] };
    }
  }

  return {
    sentence: best.cand.sentence.trim(),
    gate: best.cand.soft.length > 0 ? "soft" : "pass",
    rejected,
    picked: best.cand.i,
  };
}

// ─── CLAUDE CALL ──────────────────────────────────────────────────────────────
// One call = one full candidate set (all 12 tickers). System + user blocks carry
// cache_control and are identical across the run, so candidates 2..N are nearly
// all cache reads. One retry per candidate; ensemble proceeds with successes.
async function callClaudeOnce(userMessage) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: 2000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: [{ type: "text", text: userMessage, cache_control: { type: "ephemeral" } }] }],
        }),
      });

      if (!resp.ok) {
        throw new Error(`Anthropic API ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
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
      const parsed = JSON.parse(match[0]);
      const cacheRead = data.usage?.cache_read_input_tokens || 0;
      return { parsed, cacheRead };
    } catch (e) {
      if (attempt === 2) throw e;
      console.log(`  [claire-summary] candidate call failed (${e.message.slice(0, 80)}) — retrying...`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function gatherCandidates(inputRows) {
  const userMessage = `Here are today's analyst summaries for Claire's portfolio. Each row includes the ticker, the exact company name, and what the business actually does — use those as the source of truth for identifying each holding. Translate each into one plain-English sentence per the rules.

${JSON.stringify(inputRows, null, 2)}`;

  const candidateSets = [];
  for (let n = 1; n <= ENSEMBLE_N; n++) {
    try {
      const { parsed, cacheRead } = await callClaudeOnce(userMessage);
      candidateSets.push(parsed);
      console.log(`  [claire-summary] candidate set ${n}/${ENSEMBLE_N} ok (cache r${cacheRead})`);
    } catch (e) {
      console.log(`  [claire-summary] candidate set ${n}/${ENSEMBLE_N} FAILED: ${e.message.slice(0, 100)}`);
    }
  }
  return candidateSets;
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
  const rowsBySymbol = {};
  for (const r of input) rowsBySymbol[r.symbol] = r;

  console.log(`[claire-summary] gathering ${ENSEMBLE_N} candidate set(s) [${MODEL_ID}]...`);
  const candidateSets = await gatherCandidates(input);
  if (candidateSets.length === 0) {
    console.error("[claire-summary] all candidate calls failed — falling back per ticker");
  }

  // Build final output
  const byHolding = {};
  for (const h of (daily.holdings || [])) byHolding[h.symbol] = h;

  const summaries = {};
  for (const symbol of PORTFOLIO) {
    const h = byHolding[symbol];
    const candidates = candidateSets
      .map(set => set?.[symbol])
      .filter(s => typeof s === "string" && s.trim());

    let sentence = "No update today.";
    let gate = "fallback";
    // v2.1: a holding absent from today's entry wasn't scored this run — say so
    // honestly and deterministically instead of shipping a generic fallback.
    if (!h) {
      const who = TICKER_IDENTITY[symbol]?.name || symbol;
      summaries[symbol] = {
        sentence: `${who} didn't get scored in today's run because of a technical problem on our side — nothing happened to the company itself. It should be back in tomorrow's update.`,
        recommendation: null,
        composite_score: null,
        signal_date: daily.date ?? null,
        gate: "missing",
      };
      continue;
    }
    if (candidates.length > 0) {
      const vote = voteOnSentences(symbol, candidates, rowsBySymbol[symbol]);
      for (const rej of vote.rejected) {
        console.log(`  ⚠ ${symbol}: candidate ${rej.i + 1} rejected [${rej.hard.join("; ")}] — "${String(rej.sentence).slice(0, 70)}..."`);
      }
      if (vote.sentence) {
        sentence = vote.sentence;
        gate = vote.gate;
        if (gate === "soft") {
          console.log(`  ~ ${symbol}: winner carries soft flags (picked candidate ${vote.picked + 1})`);
        }
      } else {
        console.log(`  ⚠ ${symbol}: ALL candidates hard-failed — shipping fallback`);
      }
    }

    summaries[symbol] = {
      sentence,
      recommendation:  h?.composite?.recommendation ?? null,
      composite_score: h?.composite?.blended ?? null,
      signal_date:     daily.date ?? null,
      gate,            // v2.0: "pass" | "soft" | "fallback"
    };
  }

  // v2.1: deterministic plain-English incomplete-run notice (never LLM-generated).
  const dq = daily.data_quality ?? null;
  let runNote = null;
  if (dq && dq.complete === false) {
    const names = (dq.missing || []).map(sym => TICKER_IDENTITY[sym]?.name || sym);
    const list = names.length <= 1 ? names.join("")
      : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    runNote = `Heads up: today's update only covers ${dq.scored} of the usual ${dq.expected} holdings. ${list} ${names.length === 1 ? "wasn't" : "weren't"} scored because of a technical problem on our side — nothing to do with the ${names.length === 1 ? "company" : "companies"} themselves.`;
    console.log(`  ⚠ incomplete run — adding run_note for: ${(dq.missing || []).join(", ")}`);
  }

  const output = {
    generated_at: new Date().toISOString(),
    signal_date:  daily.date,
    portfolio:    PORTFOLIO,
    ensemble:     { samples_requested: ENSEMBLE_N, samples_ok: candidateSets.length },  // v2.0
    ...(runNote ? { run_note: runNote } : {}),          // v2.1: only present when the run was short
    ...(dq ? { data_quality: dq } : {}),                // v2.1: pass-through for the dashboard
    summaries,
  };

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n");

  console.log(`[claire-summary] wrote ${OUTPUT_FILE}`);
  for (const sym of PORTFOLIO) {
    console.log(`  ${sym.padEnd(8)} [${summaries[sym].gate.padEnd(8)}] ${summaries[sym].sentence}`);
  }
}

main().catch(e => {
  console.error("[claire-summary] FATAL:", e);
  process.exit(1);
});
