#!/usr/bin/env node
// risk-language-diff.mjs v1.6 — 10-Q/10-K/20-F/40-F risk-section temporal diffing.
//
// v1.6 (October 2026): HOLDINGS SWAP — ENB out, CVX in (Chevron Corporation,
// CIK 93410), generate-signals v8.7.0 sync; still 14. BUILT ON v1.5 (v1.4's
// PBR.A → UBER and 1000-row lookback, v1.5's declared User-Agent and loud
// failure): everything below lives in this file, so v1.6 supersedes v1.5 —
// deploy this one, not both. CVX is a plain US filer (10-K/10-Q Item 1A — the MSFT/NOW/MA/
// ISRG/MLM/UBER class), so no form handling changes. CIK verified against the
// EDGAR submissions API at build time: CHEVRON CORP, CIK 0000093410, NYSE: CVX,
// Delaware, SIC 2911 (Petroleum Refining), EIN 94-0890210, fiscal year end
// 1231. ENB's fallback CIK (895728) is REMOVED, as PBR's, RDDT's and IBIT's
// were: this script is stateless and only processes the current HOLDINGS list.
// Decades of Item 1A history (the v1.3 MLM case), and the v1.4 1000-row
// lookback covers the prior same-form comparator whatever the Form 4 volume.
//
// ⚠ EXPECTED CHURN IN CVX'S NEXT FILINGS — read the substance, not the
// magnitude, the v1.3/v1.4 rule:
//   (a) THE HESS MIDSTREAM EXIT (announced 2026-10-06; close expected by
//       year-end): deconsolidation of ~$3.7B of HESM debt, a one-time $3–4B
//       after-tax loss and the Bakken contract reset will likely rewrite the
//       Hess-related risk language. That is the company describing its own
//       transaction.
//   (b) THE IRAN CONFLICT AND THE KAZAKHSTAN EXPORT ROUTE. Chevron revises its
//       geopolitical and operational risk factors as Gulf shipping, the
//       Partitioned Zone, Israeli gas and the Caspian Pipeline Consortium
//       (TCO's export route — not Chevron Phillips Chemical) change. A
//       revision is near-certain; only its DIRECTION — a disruption described
//       as easing vs prolonged — carries information.
//   Until the Q3 2026 10-Q lands after the 2026-10-30 earnings release, the
//   CVX comparison is the Q2 10-Q against the Q1 10-Q.
// The v1.5 User-Agent fix below covers CVX like every other SEC filer; it needs
// the RLD_USER_AGENT repository secret to be set.
//
// v1.5 (October 2026): DECLARED USER-AGENT + LOUD FAILURE. The fix for the
// "never produced a diff" status recorded at v1.4 below.
//   • The User-Agent now comes from the RLD_USER_AGENT repository secret,
//     passed in by risk-language.yml. SEC fair-access policy asks automated
//     tools to declare themselves as "Company Name admin@domain.com"; the
//     built-in default (kept below as the last resort) carries no address —
//     SEC's documented trigger for a 403, and the most likely cause of the
//     403 on every request since July (not verifiable from outside SEC; the
//     first run with the secret set settles it).
//     A secret, not a literal in this file or the workflow, because the
//     repository is public and anything committed here is readable by anyone.
//   • A startup warning names the problem if the agent string in use has no
//     "@" — the condition that produced sixteen silent weeks.
//   • When EVERY SEC filer in the book errors (as happened on all sixteen
//     runs), the script still writes risk-language.json but exits non-zero,
//     so the workflow run fails and GitHub notifies instead of committing a
//     file of errors. A single filer erroring (one bad document, one timeout)
//     does NOT fail the run — that is ordinary and is recorded per holding.
//   If a run still fails with 403 after the secret is set, the block is at
//   SEC's network edge rather than the declared agent (GitHub-hosted runners
//   share IP ranges), and the remedy is a different runner — not a code
//   change here.
//
// v1.4 (October 2026): HOLDINGS SWAP — PBR.A out, UBER in (Uber Technologies,
// Inc., CIK 1543151), generate-signals v8.6.0 sync; still 14. UBER is a plain
// US filer (10-K/10-Q Item 1A — the MSFT/NOW/MA/ISRG/MLM class), so no form
// handling changes. CIK verified against the EDGAR submissions API at build
// time: Uber Technologies, Inc, CIK 0001543151, NYSE: UBER, Delaware, SIC 7389
// (Services-Business Services, NEC), fiscal year end 1231.
// PBR's fallback CIK (1119639) is REMOVED, as IBIT's and RDDT's were: this
// script is stateless and only processes the current HOLDINGS list. PBR.A was
// a 20-F filer; the foreign-private-issuer path stays in use for ASML and KOF.
//
// ★★ LOOKBACK 40 → 1000 — the one logic change, and UBER does not work without
// it. Uber's Section 16 volume is heavy: monthly RSU-vest Form 4 batches (five
// or six filings around the 16th–20th of each month) plus filer-agent
// submissions put ~32 rows between one 10-Q and the next. Checked against EDGAR
// at build time: the latest 10-Q (0001543151-26-000032, filed 2026-08-05,
// period 2026-06-30, uber-20260630.htm) sits at row 21; the prior 10-Q
// (0001543151-26-000022, filed 2026-05-06, period 2026-03-31) at row 53. Both
// must sit inside the window, so under v1.3 UBER finds its comparator only in
// the first two or three weeks after each 10-Q, before new Form 4s push the
// prior one past row 40 — for most of every quarter, including today, it
// reports "no_prior_same_form". And a 10-K against the prior year's 10-K
// (~130 rows apart) could never be compared at all. 1000 matches what EDGAR
// guarantees for filings.recent (the latest 1,000 filings or a full year,
// whichever is more), so the scan covers the whole block for every holding here.
// Effect on the other holdings: rows.find() still returns the NEAREST prior
// same-form filing, so any holding whose comparator was already inside 40
// rows gets the identical pair. The only possible change is
// "no_prior_same_form" → a real diff where the comparator sat deeper — e.g. a
// 10-K against the prior year's 10-K, or a 20-F filer whose 6-Ks (not in
// FORMS) crowd the window.
//
// ⚠ EXPECTED CHURN IN UBER'S NEXT FILINGS — read the substance, not the
// magnitude, exactly as for MLM's Lhoist deal at v1.3:
//   (a) THE DELIVERY HERO OFFER. A cash tender for a large German food-delivery
//       company, financed with a bridge facility and subject to merger control
//       in several jurisdictions, will almost certainly add acquisition,
//       financing, leverage and integration risk factors that did not exist in
//       the prior filing. That is the company describing its own deal.
//   (b) AUTONOMOUS-VEHICLE LANGUAGE. Uber revises its AV risk factors as
//       partnerships are signed or lapse. A revision is near-certain; only
//       its DIRECTION — partners listing on the platform vs operators going
//       direct — carries information.
//
// ⚠⚠ STATUS AT v1.4 — THIS SCRIPT HAS NEVER PRODUCED A DIFF. Every weekly run
// in the output history (2026-07-12 → 2026-10-25, 16 runs) recorded "EDGAR 403"
// on data.sec.gov/submissions for all twelve SEC filers; only GLNCY/AMKBY's
// by-design "no_sec_filings" rows were ever written. The most likely cause is
// the User-Agent: SEC fair-access policy asks for a declared agent of the form
// "Company Name admin@domain.com", the default below carries no contact
// address, and risk-language.yml does not set RLD_USER_AGENT. NOT changed here:
// the fix needs a real contact address and a repository secret, not a code
// edit. Until it lands, UBER (like every other filer) will record "error".
// Separately: because no run has succeeded, extractRiskSection() has only ever
// run against the --selftest fixture, never a real filing. The first live
// output should be read by eye before anything is built on it.
//
// v1.3 (August 2026): HOLDINGS SWAP — RDDT out, MLM in (Martin Marietta
// Materials, Inc., CIK 916076), generate-signals v8.5.0 sync; still 14. MLM is
// a plain US filer (10-K/10-Q Item 1A — the MSFT/NOW/MA/ISRG class), so no form
// handling changes. CIK verified against EDGAR at build time: MARTIN MARIETTA
// MATERIALS INC, CIK 0000916076, EIN 56-1848578, State of Incorporation NC,
// SIC 1400 (Mining & Quarrying of Nonmetallic Minerals, No Fuels), Commission
// file number 1-12744, fiscal year end 1231.
// RDDT's fallback CIK (1713445) is REMOVED rather than left behind, exactly as
// IBIT's was at v1.2: this script is stateless and only ever processes the
// current HOLDINGS list, so unlike score-engine's retired archetype branches
// there is no historical re-scoring path that could still reach it.
//
// ✓ DEEP FILING HISTORY — the v1.2 caveat INVERTS here. Where RDDT listed in
// March 2024 and carried only ~2.4 years of EDGAR history, Martin Marietta has
// filed since the mid-1990s and has roughly two decades of Item 1A risk-factor
// disclosure (Item 1A became mandatory in 2005). Prior same-form comparators
// sit comfortably inside the 40-filing lookback for both 10-K and 10-Q, and
// there is a genuine multi-cycle baseline for what this company's risk language
// looks like in calm conditions — including through the 2008-2011 construction
// collapse, which is the most informative stress period this business has.
//
// ⚠ BUT TWO SOURCES OF EXPECTED CHURN IN THE NEXT FEW FILINGS. Both will
// produce large Item 1A diffs that are CORPORATE-ACTION and CALENDAR artifacts
// rather than deterioration in the aggregates business. Structurally this is
// the same "read the next few diffs as baseline, not signal" caution the v1.2
// block carried for RDDT — same shape, entirely different cause:
//   (a) THE LHOIST NORTH AMERICA ACQUISITION. A $13.5B transaction ($7.0B cash
//       + $6.5B stock) that closes in H2 2026 and takes combined net leverage
//       to roughly 3.7x. The next 10-Q/10-K will almost certainly add a block
//       of new risk factors — integration execution, debt covenants and
//       leverage, synergy realization, and lime/industrial-minerals end-market
//       risks that simply did not exist in the prior filing. Expect a high
//       churn rate. That is the company describing a deal it announced, not a
//       signal that the underlying business got riskier.
//   (b) THE SURFACE TRANSPORTATION AUTHORIZATION DEADLINE. IIJA authorizations
//       expire 2026-09-30. Whatever Congress does — a multiyear bill, a
//       short-term extension, or a lapse — the government-funding risk factor
//       will be revised in the next filing, because the paragraph describing
//       the funding environment necessarily changes when the statute does. A
//       revision there is expected and near-certain; only its DIRECTION is
//       informative. Read the substance, not the churn magnitude.
// Once the LNA language settles (likely two filings after close) and the
// authorization outcome is in the text, MLM should produce cleaner diffs than
// RDDT ever could, precisely because the baseline is deep.
//
// v1.2 (August 2026): HOLDINGS SWAP — IBIT out, RDDT in (Reddit, Inc.,
// CIK 1713445), generate-signals v8.4.0 sync; still 14. RDDT is a plain US
// filer (10-K/10-Q Item 1A — the MSFT/NOW/MA/ISRG class). CIK verified against
// EDGAR at build time: Reddit, Inc., CIK 0001713445, Delaware, SIC 7374.
// IBIT's fallback CIK (1980994) is REMOVED rather than left behind: this
// script is stateless and only ever processes the current HOLDINGS list, so
// unlike score-engine's retired archetype branches there is no historical
// re-scoring path that could still reach it. A dead CIK in the fallback map
// would be pure confusion.
//
// ⚠ SHALLOWER FILING HISTORY THAN THE OTHER US FILERS. Reddit listed in March
// 2024, so its EDGAR history is ~2.4 years deep rather than decades. This does
// NOT block a meaningful first run — multiple 10-Qs and at least two 10-Ks
// (FY2024, FY2025) exist by August 2026, so both form types have a prior
// same-form comparator well inside the 40-filing lookback. But two things
// follow that are worth holding in mind when reading early RDDT output:
//   (a) The earliest available comparison reaches back only to the IPO, so
//       there is no pre-IPO baseline for what this company's risk language
//       looks like in calm conditions.
//   (b) Newly public companies revise Item 1A more heavily than seasoned
//       filers as disclosure settles post-IPO, so early diffs may show a
//       higher churn rate that reflects filing maturity rather than any
//       change in the business. Treat the first few RDDT diffs as
//       establishing a baseline, not as signal.
// This mirrors the partial-window caveat the valuation layers already carry
// for this name (score-engine V8.3, generate-signals v8.4.0) — same root
// cause, different data source.
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
// COVERAGE: US filers (MSFT, NOW, LHX, TMO, LIN, CVX, MLM, UBER, MA, ISRG) via
// 10-K/10-Q Item 1A; foreign private issuers (ASML, KOF) via 20-F Item 3.D /
// Risk Factors. GLNCY (Glencore — LSE, OTC ADR) and
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
// case the lookup file is unreachable. Where a holding's symbol is not its EDGAR
// ticker, edgarTicker carries the mapping (PBR.A → PBR did, until v1.4).
//
// SELF-TEST: `node risk-language-diff.mjs --selftest` runs the extraction and
// diff logic against embedded fixtures with zero network access (CI-safe).

import { readFileSync, writeFileSync, mkdirSync } from "fs";

const HISTORY_DIR = "docs/history";
const OUTPUT_PATH = `${HISTORY_DIR}/risk-language.json`;
// v1.5: set RLD_USER_AGENT (repository secret, wired in risk-language.yml) to
// "Name email@domain". The default below has no contact address and is
// refused by SEC — it remains only so --selftest and local runs work.
const USER_AGENT = process.env.RLD_USER_AGENT || "drnick69-portfolio-signals research bot (https://github.com/drnick69/portfolio-signals)";
const UA_HAS_CONTACT = /\S+@\S+\.\S+/.test(USER_AGENT);
const FETCH_DELAY_MS = parseInt(process.env.RLD_FETCH_DELAY_MS || "500", 10);
const FORMS = new Set(["10-K", "10-Q", "20-F", "40-F"]);
const LOOKBACK_FILINGS = 1000; // v1.4: was 40 — too shallow for heavy Section 16 filers (UBER); see header
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
  { symbol: "CVX",   edgarTicker: "CVX" },   // Chevron — 10-K/10-Q Item 1A (v1.6)
  { symbol: "UBER",  edgarTicker: "UBER" },  // Uber Technologies — 10-K/10-Q Item 1A (v1.4); needs the v1.4 lookback
  { symbol: "KOF",   edgarTicker: "KOF" },
  { symbol: "MLM",   edgarTicker: "MLM" },   // Martin Marietta Materials — 10-K/10-Q Item 1A (v1.3); ~2 decades of Item 1A history
  { symbol: "MA",    edgarTicker: "MA" },    // Mastercard — 10-K/10-Q Item 1A (v1.1)
  { symbol: "ISRG",  edgarTicker: "ISRG" },  // Intuitive Surgical — 10-K/10-Q Item 1A (v1.1)
  { symbol: "GLNCY", edgarTicker: null },    // Glencore — LSE listing, no SEC reporting
  { symbol: "AMKBY", edgarTicker: null },    // Maersk — Copenhagen listing, no SEC reporting
];

// Fallback CIKs (used only if company_tickers.json is unreachable). Verified
// against EDGAR at build time; the runtime lookup remains authoritative.
const FALLBACK_CIK = {
  MSFT: 789019, ASML: 937966, LIN: 1707925, TMO: 97745, NOW: 1373715,
  LHX: 202058, KOF: 910631,
  MA: 1141391, ISRG: 1035267,   // v1.1 — verified against EDGAR filing indexes
  MLM: 916076,                  // v1.3 — Martin Marietta Materials, Inc.; verified against EDGAR
                                //        (NC incorporation, SIC 1400 Mining & Quarrying of
                                //        Nonmetallic Minerals, file no. 1-12744, EIN 56-1848578)
  UBER: 1543151,                // v1.4 — Uber Technologies, Inc; verified against the EDGAR
                                //        submissions API (Delaware, SIC 7389, NYSE: UBER, FYE 1231)
  CVX: 93410,                   // v1.6 — Chevron Corp; verified against the EDGAR submissions
                                //        API (Delaware, SIC 2911, NYSE: CVX, FYE 1231, EIN 94-0890210)
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

  console.log("risk-language-diff v1.6 — SEC risk-factor temporal diff (data producer only; nothing consumes this yet)");
  if (!UA_HAS_CONTACT) {
    console.warn("⚠ User-Agent has no contact email. SEC asks automated tools to declare \"Name email@domain\" and refuses");
    console.warn("⚠ undeclared ones with HTTP 403. Set the RLD_USER_AGENT repository secret (see risk-language.yml).");
  } else {
    console.log("  User-Agent: declared with a contact address (from RLD_USER_AGENT).");
  }
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

  // v1.5: fail the run when EVERY SEC filer errored — sixteen weeks of silent
  // all-error commits is the failure this exists to prevent.
  const secFilers = HOLDINGS.filter(h => ciks[h.symbol] != null).map(h => h.symbol);
  const errored = secFilers.filter(s => holdings[s]?.status === "error");
  if (secFilers.length > 0 && errored.length === secFilers.length) {
    const all403 = errored.every(s => /\b403\b/.test(holdings[s].note || ""));
    console.error(`\n✗ ALL ${secFilers.length} SEC filers errored${all403 ? " with HTTP 403" : ""} — no diff was produced.`);
    if (all403) console.error(UA_HAS_CONTACT
      ? "✗ The User-Agent declares a contact, so the refusal is likely at SEC's network edge (shared runner IPs), not the agent string."
      : "✗ Cause: undeclared User-Agent. Set the RLD_USER_AGENT repository secret to \"Name email@domain\".");
    process.exitCode = 1;
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
