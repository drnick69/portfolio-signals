#!/usr/bin/env node
// risk-language-diff.mjs v1.1 — 10-Q/10-K/20-F/40-F risk-section temporal diffing.
//
// v1.1 (July 2026): HOLDINGS ADD — MA (Mastercard, CIK 1141391) + ISRG
// (Intuitive Surgical, CIK 1035267), 12 → 14, generate-signals v8.3.0 sync.
// Both are plain US filers (10-K/10-Q Item 1A — MSFT/NOW class). CIKs verified
// against EDGAR at build time. Because the comparison is stateless (latest vs
// prior same-form filing pulled fresh from EDGAR each run), both names produce
// a MEANINGFUL diff on their very first run — years of prior 10-Qs exist; no
// baseline-only warm-up period applies. The Sunday 14:00 UTC workflow is
// symbol-agnostic and unchanged. Weekly load rises ~6 EDGAR requests, still
// far inside fair-access limits.
//
// THE SIGNAL: management's risk-factor language is legal-reviewed, slow-moving,
// and asymmetric — companies add risk language faster than they remove it, and
// NEW risk sentences frequently precede the thesis-relevant bad quarter (and
// deletions frequently confirm a resolved overhang). This script pulls each
// holding's latest two comparable SEC filings from EDGAR, extracts the risk-
// factors section, and diffs them at the sentence level.
//
// v1 SCOPE: data producer only. Writes docs/history/risk-language.json and a
// console report. NOT wired into the LLM prompt or the deterministic engine —
// prompt integration is a separate, explicitly-approved step once the output
// has been eyeballed for a few cycles. No holding scores anywhere are touched.
//
// COMPARISON BASIS: latest filing vs the most recent PRIOR filing of the SAME
// form (10-Q vs 10-Q, 20-F vs 20-F, ...). Cross-form diffs are structurally
// noisy — a 10-Q's Item 1A is often two paragraphs of "no material changes"
// against a 10-K's thirty pages, which produces a ~100% delta that means
// nothing. If no prior same-form filing exists in the lookback, the holding
// reports status "no_prior_same_form" rather than shipping a misleading diff.
//
// COVERAGE: US filers (MSFT, NOW, LHX, TMO, LIN, ENB, MA, ISRG, IBIT — the trust files
// 10-K/10-Q) via 10-K/10-Q Item 1A; foreign private issuers (ASML, PBR.A/PBR,
// KOF) via 20-F Item 3.D / Risk Factors. GLNCY (Glencore — LSE, OTC ADR) and
// AMKBY (Maersk — Copenhagen, OTC ADR) are not SEC reporting companies: they
// are recorded with status "no_sec_filings", permanently, by design — not an
// error, and NOT a reason to bolt on a manual data file (no holding may
// require a manual file to participate; the ones EDGAR can't serve simply
// report that honestly).
//
// EDGAR ETIQUETTE: data.sec.gov and www.sec.gov require a descriptive
// User-Agent and fair-access pacing (<10 req/s). We send RLD_USER_AGENT (env,
// with a sane default) and sleep 500ms between every fetch. Total load is
// ~3 requests per ticker per weekly run — far inside the limits.
//
// CIK RESOLUTION: runtime lookup from https://www.sec.gov/files/company_tickers.json
// (authoritative, survives ticker changes), with a hardcoded fallback map in
// case the lookup file is unreachable. PBR.A resolves via PBR (same registrant;
// preferred vs common is a share-class distinction, not a filer distinction).
//
// SELF-TEST: `node risk-language-diff.mjs --selftest` runs the extraction and
// diff logic against embedded fixtures with zero network access (CI-safe).

import { readFileSync, writeFileSync, mkdirSync } from "fs";

const HISTORY_DIR = "docs/history";
const OUTPUT_PATH = `${HISTORY_DIR}/risk-language.json`;
const USER_AGENT = process.env.RLD_USER_AGENT || "drnick69-portfolio-signals research bot (https://github.com/drnick69/portfolio-signals)";
const FETCH_DELAY_MS = parseInt(process.env.RLD_FETCH_DELAY_MS || "500", 10);
const FORMS = new Set(["10-K", "10-Q", "20-F", "40-F"]);
const LOOKBACK_FILINGS = 40;   // how deep into the recent-filings arrays we look
const MAX_SNIPPETS = 8;        // top added/removed sentences carried in the output
const SNIPPET_CHARS = 240;
const MIN_SECTION_CHARS = 500; // below this, extraction is considered failed

// EDGAR ticker used for CIK resolution (null = not an SEC reporting company).
const HOLDINGS = [
  { symbol: "MSFT",  edgarTicker: "MSFT" },
  { symbol: "ASML",  edgarTicker: "ASML" },
  { symbol: "LIN",   edgarTicker: "LIN" },
  { symbol: "TMO",   edgarTicker: "TMO" },
  { symbol: "NOW",   edgarTicker: "NOW" },
  { symbol: "LHX",   edgarTicker: "LHX" },
  { symbol: "ENB",   edgarTicker: "ENB" },
  { symbol: "PBR.A", edgarTicker: "PBR" },   // same registrant as the preferreds
  { symbol: "KOF",   edgarTicker: "KOF" },
  { symbol: "IBIT",  edgarTicker: "IBIT" },  // iShares Bitcoin Trust files 10-K/10-Q
  { symbol: "MA",    edgarTicker: "MA" },    // Mastercard — 10-K/10-Q Item 1A (v1.1)
  { symbol: "ISRG",  edgarTicker: "ISRG" },  // Intuitive Surgical — 10-K/10-Q Item 1A (v1.1)
  { symbol: "GLNCY", edgarTicker: null },    // Glencore — LSE listing, no SEC reporting
  { symbol: "AMKBY", edgarTicker: null },    // Maersk — Copenhagen listing, no SEC reporting
];

// Fallback CIKs (used only if company_tickers.json is unreachable). Verified
// against EDGAR at build time; the runtime lookup remains authoritative.
const FALLBACK_CIK = {
  MSFT: 789019, ASML: 937966, LIN: 1707925, TMO: 97745, NOW: 1373715,
  LHX: 202058, ENB: 895728, PBR: 1119639, KOF: 910631, IBIT: 1980994,
  MA: 1141391, ISRG: 1035267,   // v1.1 — verified against EDGAR filing indexes
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function edgarFetch(url, asJson) {
  await sleep(FETCH_DELAY_MS);
  const resp = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate" } });
  if (!resp.ok) throw new Error(`EDGAR ${resp.status} for ${url}`);
  return asJson ? resp.json() : resp.text();
}

// ─── EXTRACTION ──────────────────────────────────────────────────────────────

// HTML → readable text. Deliberately dumb: strip tags, decode the entities that
// actually occur in filings, collapse whitespace. Filings are table-heavy but
// risk sections are prose, so this is sufficient for sentence-level diffing.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/td)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n");
}

// Extract the risk-factors section from filing text. Strategy:
//   1. Find every "risk factors" heading occurrence (covers 10-K/10-Q
//      "Item 1A. Risk Factors" and 20-F "D. Risk Factors" / "Item 3.D").
//   2. Skip table-of-contents hits by requiring substantial prose after the
//      heading; take the occurrence with the LONGEST following section.
//   3. End the section at the next item-style heading ("Item 1B", "Item 2",
//      "Item 4" etc.) or at a hard length cap.
// Returns { text, status }.
export function extractRiskSection(fullText) {
  const headingRe = /(item\s*1a[.\s:–—-]*risk\s*factors|item\s*3\s*[.]?\s*d[.\s:–—-]*risk\s*factors|^\s*d\s*[.]\s*risk\s*factors|risk\s*factors)/gim;
  const boundaryRe = /item\s*(1b|2|3|4|5|6)\b[.\s:–—-]|unresolved\s+staff\s+comments|unregistered\s+sales\s+of\s+equity/gi;

  const candidates = [];
  let m;
  while ((m = headingRe.exec(fullText)) !== null) {
    const start = m.index + m[0].length;
    boundaryRe.lastIndex = start + 200; // a boundary can't be inside the heading itself
    const b = boundaryRe.exec(fullText);
    const end = b ? b.index : Math.min(fullText.length, start + 600000);
    const section = fullText.slice(start, end).trim();
    candidates.push(section);
    if (candidates.length > 40) break; // pathological TOC protection
  }
  if (candidates.length === 0) return { text: "", status: "no_heading_found" };
  const best = candidates.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (best.length < MIN_SECTION_CHARS) return { text: best, status: "extract_failed" };
  return { text: best, status: "ok" };
}

// ─── DIFF ────────────────────────────────────────────────────────────────────

export function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=["'(A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length >= 40 && s.length <= 800);
}

const normalizeSentence = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

export function diffRiskSections(priorText, latestText) {
  const priorSents = splitSentences(priorText);
  const latestSents = splitSentences(latestText);
  const priorSet = new Map(priorSents.map(s => [normalizeSentence(s), s]));
  const latestSet = new Map(latestSents.map(s => [normalizeSentence(s), s]));

  const added = [], removed = [];
  for (const [key, orig] of latestSet) if (!priorSet.has(key)) added.push(orig);
  for (const [key, orig] of priorSet) if (!latestSet.has(key)) removed.push(orig);

  const union = new Set([...priorSet.keys(), ...latestSet.keys()]);
  const intersection = [...latestSet.keys()].filter(k => priorSet.has(k)).length;
  const jaccard = union.size === 0 ? 1 : intersection / union.size;

  return {
    prior_sentences: priorSet.size,
    latest_sentences: latestSet.size,
    added_count: added.length,
    removed_count: removed.length,
    similarity_pct: +(jaccard * 100).toFixed(1),
    // delta_score 0-100: how much of the risk language turned over
    delta_score: +((1 - jaccard) * 100).toFixed(1),
    added_snippets: added.slice(0, MAX_SNIPPETS).map(s => s.slice(0, SNIPPET_CHARS)),
    removed_snippets: removed.slice(0, MAX_SNIPPETS).map(s => s.slice(0, SNIPPET_CHARS)),
  };
}

// ─── EDGAR PLUMBING ──────────────────────────────────────────────────────────

async function resolveCiks() {
  const bySymbol = {};
  let table = null;
  try {
    table = await edgarFetch("https://www.sec.gov/files/company_tickers.json", true);
  } catch (e) {
    console.warn(`⚠ company_tickers.json unreachable (${e.message}) — using hardcoded fallback CIKs.`);
  }
  const lookup = {};
  if (table) for (const rec of Object.values(table)) lookup[String(rec.ticker).toUpperCase()] = rec.cik_str;
  for (const h of HOLDINGS) {
    if (!h.edgarTicker) { bySymbol[h.symbol] = null; continue; }
    bySymbol[h.symbol] = lookup[h.edgarTicker] ?? FALLBACK_CIK[h.edgarTicker] ?? null;
  }
  return bySymbol;
}

function latestTwoSameForm(submissions) {
  const r = submissions?.filings?.recent;
  if (!r?.form) return null;
  const rows = [];
  for (let i = 0; i < Math.min(r.form.length, LOOKBACK_FILINGS); i++) {
    if (!FORMS.has(r.form[i])) continue;
    rows.push({ form: r.form[i], accession: r.accessionNumber[i], primary: r.primaryDocument[i], filed: r.filingDate[i] });
  }
  if (rows.length === 0) return null;
  const latest = rows[0]; // recent arrays are newest-first
  const prior = rows.find((x, i) => i > 0 && x.form === latest.form);
  return { latest, prior: prior || null };
}

const docUrl = (cik, accession, primary) =>
  `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${primary}`;

async function processHolding(symbol, cik) {
  if (cik == null) return { status: "no_sec_filings", note: "Not an SEC reporting company (foreign listing, OTC ADR). Permanent, by design." };
  const padded = String(cik).padStart(10, "0");
  const submissions = await edgarFetch(`https://data.sec.gov/submissions/CIK${padded}.json`, true);
  const pair = latestTwoSameForm(submissions);
  if (!pair) return { status: "no_filings_in_scope", note: `No ${[...FORMS].join("/")} in the last ${LOOKBACK_FILINGS} filings.` };
  if (!pair.prior) return { status: "no_prior_same_form", latest_form: pair.latest.form, latest_filed: pair.latest.filed, note: "Only one filing of this form in the lookback — a cross-form diff would be structurally misleading, so none is produced." };

  const [latestHtml, priorHtml] = [
    await edgarFetch(docUrl(cik, pair.latest.accession, pair.latest.primary), false),
    await edgarFetch(docUrl(cik, pair.prior.accession, pair.prior.primary), false),
  ];
  const latestExtract = extractRiskSection(htmlToText(latestHtml));
  const priorExtract = extractRiskSection(htmlToText(priorHtml));
  if (latestExtract.status !== "ok" || priorExtract.status !== "ok") {
    return {
      status: "extract_failed",
      latest_form: pair.latest.form, latest_filed: pair.latest.filed,
      prior_filed: pair.prior.filed,
      note: `Risk-section extraction failed (latest: ${latestExtract.status} ${latestExtract.text.length} chars, prior: ${priorExtract.status} ${priorExtract.text.length} chars).`,
    };
  }
  return {
    status: "ok",
    form: pair.latest.form,
    latest_filed: pair.latest.filed,
    prior_filed: pair.prior.filed,
    latest_section_chars: latestExtract.text.length,
    prior_section_chars: priorExtract.text.length,
    diff: diffRiskSections(priorExtract.text, latestExtract.text),
  };
}

// ─── SELF-TEST (no network) ──────────────────────────────────────────────────

function selftest() {
  const mkFiling = (extraSentence) => `
    <html><body>
    <p>TABLE OF CONTENTS</p><p>Item 1A. Risk Factors ....... 12</p>
    <h2>Item 1. Business</h2><p>${"We make widgets for industrial customers worldwide. ".repeat(20)}</p>
    <h2>Item 1A. Risk Factors</h2>
    <p>Our business depends on a small number of large customers, and the loss of any one of them could materially reduce our revenue.</p>
    <p>We face intense competition from larger rivals with greater resources, which could pressure our margins over time.</p>
    <p>Changes in trade policy, including tariffs on imported components, could increase our costs and disrupt our supply chain.</p>
    ${extraSentence ? `<p>${extraSentence}</p>` : ""}
    <h2>Item 1B. Unresolved Staff Comments</h2><p>None.</p>
    </body></html>`;

  const prior = htmlToText(mkFiling(null));
  const latest = htmlToText(mkFiling("Recent developments in artificial intelligence could disrupt demand for our legacy products faster than we can adapt our portfolio."));

  const pe = extractRiskSection(prior);
  const le = extractRiskSection(latest);
  console.log(`extract prior: ${pe.status} (${pe.text.length} chars) | latest: ${le.status} (${le.text.length} chars)`);
  if (pe.status !== "ok" || le.status !== "ok") { console.error("✗ selftest: extraction failed"); process.exit(1); }
  if (/unresolved staff comments/i.test(le.text)) { console.error("✗ selftest: boundary not respected"); process.exit(1); }
  if (/table of contents/i.test(le.text)) { console.error("✗ selftest: TOC leaked into section"); process.exit(1); }

  const d = diffRiskSections(pe.text, le.text);
  console.log(`diff: added=${d.added_count} removed=${d.removed_count} similarity=${d.similarity_pct}%`);
  if (d.added_count !== 1 || d.removed_count !== 0) { console.error("✗ selftest: expected exactly 1 added / 0 removed"); process.exit(1); }
  if (!/artificial intelligence/i.test(d.added_snippets[0] || "")) { console.error("✗ selftest: wrong added snippet"); process.exit(1); }
  console.log("✓ selftest passed");
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--selftest")) { selftest(); return; }

  console.log("risk-language-diff v1.0 — SEC risk-factor temporal diff (data producer only; nothing consumes this yet)");
  mkdirSync(HISTORY_DIR, { recursive: true });

  const ciks = await resolveCiks();
  const holdings = {};
  for (const h of HOLDINGS) {
    process.stdout.write(`  ${h.symbol.padEnd(6)} `);
    try {
      const rec = await processHolding(h.symbol, ciks[h.symbol]);
      holdings[h.symbol] = rec;
      if (rec.status === "ok") {
        const d = rec.diff;
        console.log(`${rec.form} ${rec.prior_filed} → ${rec.latest_filed}: similarity ${d.similarity_pct}% | +${d.added_count} / −${d.removed_count} sentence(s)`);
        for (const s of d.added_snippets.slice(0, 3)) console.log(`      + ${s.slice(0, 110)}…`);
      } else {
        console.log(rec.status);
      }
    } catch (e) {
      holdings[h.symbol] = { status: "error", note: e.message.slice(0, 200) };
      console.log(`error: ${e.message.slice(0, 120)}`);
    }
  }

  const output = {
    version: "1.0",
    generated_at: new Date().toISOString(),
    comparison_basis: "latest filing vs most recent prior filing of the SAME form",
    forms_in_scope: [...FORMS],
    holdings,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
