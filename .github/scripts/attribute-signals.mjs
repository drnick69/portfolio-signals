// ─── attribute-signals.mjs ─────────────────────────────────────────────────────
// Forward-return attribution engine for the Portfolio Signals pipeline.
//
// What it does:
//   1. Reads every logged signal from docs/history/daily-log.jsonl
//      (one line per DAY containing all holdings — 14 since v8.3.0's MA/ISRG
//      add; still 14 after the v8.4.0 IBIT → RDDT, v8.5.0 RDDT → MLM,
//      v8.6.0 PBR.A → UBER and v8.7.0 ENB → CVX swaps; flattens to
//      per-symbol rows)
//   2. Deduplicates by (symbol, date) — most recent write wins
//   3. For each signal, fetches Alpaca daily bars covering entry_date → today
//   4. Computes forward returns at 1d, 3d, 5d, 10d, 20d, 40d, 60d, 120d
//      (trading days, not calendar days)
//   5. Pairs each layer's score with its native-horizon return and tags
//      whether the direction call was correct
//   6. Writes enriched records to docs/history/signals_with_returns.jsonl
//
// Design notes:
//   • Idempotent — safe to run repeatedly. Partial attributions (where the
//     forward horizon hasn't elapsed yet) are filled in on subsequent runs.
//   • Defensive normalization — handles BOTH the daily-log.jsonl shape
//     (one entry per day with nested holdings[] array) AND flat per-signal
//     rows, in case the log format changes again.
//   • Uses Alpaca bar close on the entry date as the entry price when available
//     (rather than the intra-day logged price) for clean daily alignment.
//   • Rate-limited symbol fetches (200ms between calls) to stay well under
//     Alpaca's 200 req/min data API limit.
//   • Symbol-agnostic — the script processes whatever tickers appear in the
//     log, so holdings swaps (e.g. V7.6 ETHA → NOW) and adds (v8.3.0 MA +
//     ISRG, 12 → 14) require no code changes here; attribution coverage for
//     new tickers simply begins from their first logged date forward (MA and
//     ISRG start accumulating from their first daily-log entry — both are
//     plain US listings, so Alpaca bar coverage is complete from day one).
//     The v8.4.0 IBIT → RDDT swap likewise needs no change: RDDT is a plain
//     US listing (NYSE, since March 2024), so Alpaca bar coverage is complete
//     from its first logged date, and IBIT's logged rows keep attributing
//     normally as closed history.
//     ⚠ One thing to watch on RDDT specifically: it is the highest-beta name
//     in the book (~1.94) and it printed a ~21% single-day move on 2026-07-30.
//     Forward-return buckets computed across horizons that straddle an event
//     like that are arithmetically correct but will dominate any small-n
//     calibration panel they land in. That is a sample-size caveat for whoever
//     reads the panels, not a bug here — this file's job is to compute the
//     returns faithfully, which it does.
//     Historical ETHA rows in the log keep being re-attributed against their
//     now-frozen forward windows, which is fine.
//
//     v8.5.0 sync (August 2026) — NO CODE CHANGE REQUIRED; note only.
//     The RDDT → MLM swap needs nothing here either. Martin Marietta Materials
//     is a plain US listing (NYSE, continuously since 1994), so Alpaca bar
//     coverage is complete from its first logged date, and RDDT's logged rows
//     keep attributing normally as closed history.
//     ✓ THE RDDT CAVEAT ABOVE RETIRES, AND INVERTS. MLM is a beta-1.11 name
//     against RDDT's ~1.94 — roughly the LIN/ISRG class rather than the
//     high-beta class. Its scoring bands are correspondingly tighter
//     (score-engine V8.4: RSI 38/70, ±2% daily noise floor vs RDDT's 32/72 and
//     ±4%). So the specific small-n distortion flagged for RDDT — a single ~21%
//     session dominating whatever forward-return bucket it lands in — is a
//     materially smaller risk on this name. Forward-return panels for MLM
//     should be readable at smaller n than RDDT's were.
//     ⚠ But a DIFFERENT small-n hazard replaces it, and it is calendar-bound
//     rather than volatility-bound: two scheduled events fall inside MLM's
//     first attribution windows. The surface-transportation authorization
//     expires 2026-09-30, and the Lhoist North America acquisition closes in
//     H2 2026 (all approvals received 2026-08-05, $6.5B notes priced
//     2026-08-12). Either can move the stock on a single session for reasons
//     that have nothing to do with whether the signal was right. Forward
//     windows straddling those dates are computed correctly here — that is this
//     file's job and it does it — but a panel reader should know that MLM's
//     earliest observations sit on top of two known event dates rather than a
//     quiet baseline.
//
//     v8.6.0 sync (October 2026) — NO CODE CHANGE REQUIRED; note only.
//     The PBR.A → UBER swap needs nothing here. Uber Technologies is a plain US
//     listing (NYSE, since May 2019), so Alpaca bar coverage is complete from
//     its first logged date. PBR.A's logged rows keep attributing normally as
//     closed history — and that is verified, not assumed: Alpaca serves the
//     "PBR.A" symbol natively, and 165 of PBR.A's 166 attributed records
//     already carry forward returns (the 166th is the newest, whose first
//     horizon had not yet elapsed). Its last rows will finish filling in as
//     their 60d/120d windows elapse, with no SYMBOL_MAP entry needed.
//     UBER sits between MLM and RDDT on volatility (beta ~1.26; score-engine
//     V8.5: RSI 35/70, ±2.5% daily noise floor), so the RDDT-style single-
//     session distortion is a moderate risk here, not a large one.
//     ⚠ The calendar hazard recurs, front-loaded. UBER's Q3 print lands on
//     2026-11-04 (before the open) and the Delivery Hero acceptance period
//     closes 2026-11-05, so its very first 5d windows straddle an earnings
//     session. Separately, this name is exposed to UNSCHEDULED autonomous-
//     vehicle headline days (fetch v4.19 screens for sessions down 4% or more,
//     and the LLM attributes them). Both are computed faithfully here; a panel
//     reader should know UBER's earliest observations sit on an earnings date,
//     not a quiet baseline.
//     NOT a price event, and so irrelevant to this file: the GAAP trailing P/E
//     roughly doubles at the same print as a $4.9B tax release rolls out of
//     the TTM window. Accounting only — returns are untouched.
//
//     v8.7.0 sync (October 2026) — NO CODE CHANGE REQUIRED; note only.
//     The ENB → CVX swap needs nothing here. Chevron is a plain US listing
//     (NYSE), so Alpaca bar coverage is complete from its first logged date.
//     ENB's logged rows keep attributing normally as closed history — verified,
//     not assumed: Alpaca serves "ENB" natively (the NYSE listing), and 165 of
//     ENB's 166 attributed records already carry forward returns (the 166th is
//     the newest, 2026-10-27, whose first horizon had not yet elapsed). Its last
//     rows finish filling in as their windows elapse; no SYMBOL_MAP entry.
//     CVX's five-year beta is 0.52, but its 2026 realized volatility is the oil
//     war's (a −21.5% oil-driven drawdown from 2026-03-27 to 2026-07-01);
//     score-engine V8.6 uses RSI 35/70 and a ±2% daily noise floor.
//     ⚠ The calendar hazard recurs, and sooner than UBER's. CVX's Q3 print lands
//     on 2026-10-30 (before the open), so its very first 5d windows straddle an
//     earnings session. And this name carries an UNSCHEDULED event class of its
//     own: geopolitical air pockets on Iran / Hormuz / Kazakhstan-pipeline
//     headlines (fetch v4.20 screens for sessions that move 4% or more; the LLM
//     classifies them). In a dislocated-high oil regime a de-escalation
//     sell-off is the war premium leaving the oil price, not news about
//     Chevron. Computed faithfully here; a panel reader should know what those
//     returns are measuring.
//     NOT a price event, and so irrelevant to this file: the GAAP trailing P/E
//     falls from ~22x toward ~17x at the same print as Q3'25 leaves the TTM
//     window. Accounting only — returns are untouched.
//
//     October 2026 — TWELVEDATA FALLBACK FOR OTC ADRs (code change).
//     AMKBY and GLNCY trade over the counter, and Alpaca's free IEX feed
//     carries no bars for them: through 2026-10-27 not one of AMKBY's 165 or
//     GLNCY's 139 logged signals had a forward return, so both were absent
//     from every calibration panel. When Alpaca returns no bars for a symbol,
//     this script now asks TwelveData for the same window of daily closes —
//     the source fetch-market-data already uses for these two names' RSI and
//     moving averages, so coverage is established, not hoped for. Such
//     records carry entry_price_source "twelvedata_close". Symbols Alpaca
//     serves are untouched (TwelveData is never called for them), and with
//     TD_KEY unset the script behaves exactly as before. The first run after
//     deploy back-fills AMKBY's and GLNCY's whole history in one pass.
//
// Env vars required:
//   ALPK, ALPS  — Alpaca API key + secret (already in GitHub Secrets)
//   TD_KEY      — TwelveData key, OPTIONAL: only the OTC fallback uses it
//                 (already in GitHub Secrets for fetch-market-data)
// ────────────────────────────────────────────────────────────────────────────────

import fs from "fs/promises";
import path from "path";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const HISTORY_DIR  = process.env.HISTORY_DIR  || "docs/history";
const SIGNALS_FILE = process.env.SIGNALS_FILE || path.join(HISTORY_DIR, "daily-log.jsonl");
const OUTPUT_FILE  = process.env.OUTPUT_FILE  || path.join(HISTORY_DIR, "signals_with_returns.jsonl");

const ALPACA_KEY      = process.env.ALPK;
const ALPACA_SECRET   = process.env.ALPS;
const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
const TD_KEY          = process.env.TD_KEY;        // optional — OTC fallback only
const TD_DATA_URL     = "https://api.twelvedata.com";
const TD_DELAY_MS     = parseInt(process.env.TD_DELAY_MS || "8000", 10);   // spacing after each TwelveData call

// Forward horizons in TRADING days
const HORIZONS = {
  "1d":   1,
  "3d":   3,
  "5d":   5,
  "10d":  10,
  "20d":  20,
  "40d":  40,
  "60d":  60,
  "120d": 120,
};

// Each layer has a "native" horizon for direct calibration
const LAYER_NATIVE_HORIZON = {
  tactical:   "5d",   // 1-5 day timeframe → use 5d as the consolidation point
  positional: "20d",  // 2-8 week timeframe → ~1 month
  strategic:  "60d",  // 1-6 month timeframe → 3 months (120d preferred long-term)
};

// Neutral band around 0 — scores in this range don't predict direction
const NEUTRAL_BAND = 5;

// Alpaca ticker overrides (if any). Most match 1:1. PBR.A works as-is on Alpaca
// (closed history since v8.6.0 — its old rows still fetch and attribute).
// OTC/ADR symbols (AMKBY, GLNCY) get no bars from Alpaca at all; they are
// served by the TwelveData fallback in fetchTwelveDataCloses() below rather
// than by an override here. NOW (ServiceNow, NYSE) added in V7.6 — no
// override needed, fetches natively.
const SYMBOL_MAP = {};

// ─── US MARKET CALENDAR ───────────────────────────────────────────────────────
// Copy the same calendar convention used in paper-trader.mjs. Extend through
// 2028 when needed. Early-close half-days are treated as full trading days.
const US_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  // 2026
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  // 2027
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

function isTradingDay(d) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !US_HOLIDAYS.has(d.toISOString().slice(0, 10));
}

function addTradingDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isTradingDay(d)) added++;
  }
  return d.toISOString().slice(0, 10);
}

// ─── ALPACA ────────────────────────────────────────────────────────────────────
async function fetchDailyBars(symbol, startDate, endDate) {
  const alpacaSymbol = SYMBOL_MAP[symbol] || symbol;
  const url = `${ALPACA_DATA_URL}/stocks/${encodeURIComponent(alpacaSymbol)}/bars`
            + `?timeframe=1Day&start=${startDate}&end=${endDate}`
            + `&limit=10000&adjustment=raw&feed=iex`;

  const resp = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID":     ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });

  if (!resp.ok) {
    console.warn(`  [${symbol}] Alpaca HTTP ${resp.status}: ${await resp.text().catch(() => "")}`);
    return [];
  }
  const data = await resp.json();
  return data.bars || [];
}

// TwelveData daily closes for the same window — used ONLY when Alpaca returned
// no bars (the OTC ADRs). end_date is pushed one day past today because
// TwelveData can treat it as exclusive; future dates simply have no data.
async function fetchTwelveDataCloses(symbol, startDate, endDate) {
  const end = new Date(endDate + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() + 1);
  const url = `${TD_DATA_URL}/time_series?symbol=${encodeURIComponent(symbol)}`
            + `&interval=1day&start_date=${startDate}&end_date=${end.toISOString().slice(0, 10)}`
            + `&outputsize=5000&order=ASC&apikey=${TD_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    console.warn(`  [${symbol}] TwelveData HTTP ${resp.status}`);
    return {};
  }
  const data = await resp.json();
  if (data.status !== "ok" || !Array.isArray(data.values)) {
    console.warn(`  [${symbol}] TwelveData: ${data.message || data.status || "no values"}`);
    return {};
  }
  const idx = {};
  for (const v of data.values) {
    const d = String(v.datetime).slice(0, 10);
    const c = parseFloat(v.close);
    if (d && c > 0) idx[d] = c;
  }
  return idx;
}

function indexBarsByDate(bars) {
  const idx = {};
  for (const b of bars) {
    // b.t is ISO timestamp; take the date portion only
    const d = b.t.slice(0, 10);
    idx[d] = b.c; // close price
  }
  return idx;
}

// Find price on a specific trading day, or the next available trading day
// within 5 days (handles holidays/data gaps gracefully).
function priceOnOrAfter(priceIdx, dateStr) {
  if (priceIdx[dateStr]) return priceIdx[dateStr];
  const d = new Date(dateStr + "T00:00:00Z");
  for (let i = 0; i < 5; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (priceIdx[iso]) return priceIdx[iso];
  }
  return null;
}

// ─── SIGNAL NORMALIZATION ─────────────────────────────────────────────────────
async function loadJsonl(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text
      .split("\n")
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

// Flatten daily-log.jsonl entries into per-(symbol, date) signal records.
// daily-log.jsonl shape (one line per day):
//   { date, timestamp, assignments, macro, holdings: [ { symbol, price, tactical, ... } ] }
// If the input is ALREADY flat (one line per symbol per day), we pass it
// through untouched so this script stays compatible with older log formats.
function flattenDailyLogEntries(rawEntries) {
  const flat = [];
  for (const entry of rawEntries) {
    if (Array.isArray(entry.holdings) && entry.holdings.length > 0) {
      // Full daily-log entry — flatten each holding into its own record
      for (const h of entry.holdings) {
        flat.push({
          // Top-level date/timestamp from the parent entry
          date:        entry.date,
          timestamp:   entry.timestamp,
          assignments: entry.assignments,
          // Holding-level fields
          ...h,
        });
      }
    } else if (entry.symbol) {
      // Already-flat signal row — pass through
      flat.push(entry);
    }
    // else: malformed entry, skip silently
  }
  return flat;
}

// Handles both daily-log (flattened) shape and flat logged rows.
function normalizeSignal(raw) {
  // Date: prefer explicit date field, else derive from timestamp
  const date = raw.date
            || (raw.timestamp ? raw.timestamp.slice(0, 10) : null)
            || (raw.logged_at ? raw.logged_at.slice(0, 10) : null);

  const symbol = raw.symbol;

  // Price: daily-log flattens to a flat `price` number field.
  // Older hub payloads nest it under price.current. Support both.
  const price = (typeof raw.price === "number" ? raw.price : null)
             ?? raw.price?.current
             ?? raw.price?.current_usd
             ?? raw.entry_price
             ?? raw.logged_price
             ?? null;

  // Scores: daily-log uses `blended` inside each layer object.
  // Older hub shape used `score`. Flat rows use `<layer>_score`.
  const tacticalScore   = raw.tactical?.blended   ?? raw.tactical?.score   ?? raw.tactical_score   ?? null;
  const positionalScore = raw.positional?.blended ?? raw.positional?.score ?? raw.positional_score ?? null;
  const strategicScore  = raw.strategic?.blended  ?? raw.strategic?.score  ?? raw.strategic_score  ?? null;
  const compositeScore  = raw.composite?.blended  ?? raw.composite?.score  ?? raw.composite_score  ?? null;

  const recommendation  = raw.composite?.recommendation
                       ?? raw.recommendation
                       ?? null;

  return {
    date,
    symbol,
    entry_price: typeof price === "number" ? price : null,
    scores: {
      tactical:   tacticalScore,
      positional: positionalScore,
      strategic:  strategicScore,
      composite:  compositeScore,
    },
    layer_signals: {
      tactical:   raw.tactical?.signal   ?? raw.tactical_signal   ?? null,
      positional: raw.positional?.signal ?? raw.positional_signal ?? null,
      strategic:  raw.strategic?.signal  ?? raw.strategic_signal  ?? null,
    },
    recommendation,
    role:      raw.role      ?? null,
    archetype: raw.archetype ?? null,
    weights:   raw.weights   ?? null,
    // V8.0 telemetry propagation (null for pre-v8 daily-log entries):
    // divergence + hostile_review + V8.1 regime gates flow through to
    // signals_with_returns.jsonl so calibration v2 can condition on them
    // (who-was-right-on-divergence, falsifier audit, regime hit rates).
    regime:         raw.regime         ?? null,
    regime_pmi:     raw.regime_pmi     ?? null,
    regime_driver:  raw.regime_driver  ?? null,
    regime_basis:   raw.regime_basis   ?? null,
    divergence:     raw.divergence     ?? null,
    hostile_review: raw.hostile_review ?? null,
  };
}

// ─── ATTRIBUTION ──────────────────────────────────────────────────────────────
function computeForwardReturns(entryDate, entryPrice, priceIdx, todayIso) {
  const returns = {};
  let status = "complete";

  for (const [label, nDays] of Object.entries(HORIZONS)) {
    const fwdDate = addTradingDays(entryDate, nDays);
    if (fwdDate > todayIso) {
      returns[label] = null;
      status = "partial";
      continue;
    }
    const fwdPrice = priceOnOrAfter(priceIdx, fwdDate);
    if (!fwdPrice || !entryPrice) {
      returns[label] = null;
      status = "partial";
    } else {
      returns[label] = (fwdPrice - entryPrice) / entryPrice;
    }
  }
  return { returns, status };
}

// Direction correctness per layer: did the score call the sign of the move?
// Returns true/false for conviction signals, null inside the neutral band or
// when the forward return isn't yet available.
function layerDirectionCorrect(score, fwdReturn) {
  if (score == null || fwdReturn == null) return null;
  if (Math.abs(score) < NEUTRAL_BAND) return null;
  // Negative score = buy conviction → expecting positive return
  // Positive score = trim conviction → expecting negative return
  if (score < 0 && fwdReturn > 0) return true;
  if (score > 0 && fwdReturn < 0) return true;
  return false;
}

function buildLayerAttribution(scores, returns) {
  const out = {};
  for (const [layer, horizon] of Object.entries(LAYER_NATIVE_HORIZON)) {
    const score = scores[layer];
    const ret   = returns[horizon];
    out[layer] = {
      score,
      native_horizon:    horizon,
      fwd_return:        ret,
      direction_correct: layerDirectionCorrect(score, ret),
    };
  }
  return out;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.error("ERROR: ALPK and ALPS env vars must be set");
    process.exit(1);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  console.log(`[attribute-signals] running as of ${todayIso}`);
  console.log(`  input:  ${SIGNALS_FILE}`);
  console.log(`  output: ${OUTPUT_FILE}`);

  // 1. Load raw log entries (one line per day in daily-log.jsonl)
  const rawEntries = await loadJsonl(SIGNALS_FILE);
  console.log(`  loaded ${rawEntries.length} raw log entries`);

  if (rawEntries.length === 0) {
    console.log("  no signals to attribute; exiting");
    return;
  }

  // 2. Flatten daily-log entries (each entry has all holdings nested inside — 14 since v8.3.0; unchanged by the v8.4.0 IBIT → RDDT, v8.5.0 RDDT → MLM, v8.6.0 PBR.A → UBER and v8.7.0 ENB → CVX swaps)
  //    into per-(symbol, date) rows. Already-flat rows pass through.
  const rawSignals = flattenDailyLogEntries(rawEntries);
  console.log(`  flattened to ${rawSignals.length} per-symbol signal records`);

  // 3. Normalize + dedupe by (symbol, date); last write wins
  const bucket = new Map();
  for (const raw of rawSignals) {
    const sig = normalizeSignal(raw);
    if (!sig.date || !sig.symbol) continue;
    bucket.set(`${sig.symbol}_${sig.date}`, sig);
  }
  const signals = [...bucket.values()];
  console.log(`  ${signals.length} unique (symbol, date) signals after dedupe`);

  if (signals.length === 0) {
    console.log("  no valid signals after normalization; exiting");
    return;
  }

  // 4. Group by symbol and determine earliest entry date per symbol
  const bySymbol = {};
  for (const sig of signals) {
    if (!bySymbol[sig.symbol]) bySymbol[sig.symbol] = [];
    bySymbol[sig.symbol].push(sig);
  }

  // 5. Fetch Alpaca bars per symbol (batched per-ticker, not per-signal);
  //    TwelveData daily closes for any symbol Alpaca has no bars for.
  const priceIndices = {};
  const priceSource = {};   // symbol → "alpaca" | "twelvedata" | "none"
  for (const symbol of Object.keys(bySymbol).sort()) {
    const sigs = bySymbol[symbol];
    const earliest = sigs.reduce((m, s) => s.date < m ? s.date : m, sigs[0].date);
    try {
      const bars = await fetchDailyBars(symbol, earliest, todayIso);
      priceIndices[symbol] = indexBarsByDate(bars);
      priceSource[symbol] = bars.length > 0 ? "alpaca" : "none";
      console.log(`  ${symbol.padEnd(8)} ${bars.length.toString().padStart(4)} bars  ${earliest} → ${todayIso}`);
    } catch (e) {
      console.error(`  ${symbol.padEnd(8)} fetch error: ${e.message}`);
      priceIndices[symbol] = {};
      priceSource[symbol] = "none";
    }
    await new Promise(r => setTimeout(r, 200)); // gentle rate limit
    if (priceSource[symbol] === "none" && TD_KEY) {
      try {
        const idx = await fetchTwelveDataCloses(SYMBOL_MAP[symbol] || symbol, earliest, todayIso);
        const n = Object.keys(idx).length;
        if (n > 0) { priceIndices[symbol] = idx; priceSource[symbol] = "twelvedata"; }
        console.log(`  ${symbol.padEnd(8)} ${n.toString().padStart(4)} TwelveData closes (Alpaca had none)`);
      } catch (e) {
        console.error(`  ${symbol.padEnd(8)} TwelveData fetch error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, TD_DELAY_MS)); // free tier: 8 requests/minute
    }
  }

  // 6. Compute forward returns + layer attribution for every signal
  const enriched = [];
  for (const sig of signals) {
    const priceIdx     = priceIndices[sig.symbol] || {};
    const barEntry     = priceIdx[sig.date]; // bar close on logged date
    const entryPrice   = barEntry ?? sig.entry_price;
    const entrySource  = barEntry
      ? (priceSource[sig.symbol] === "twelvedata" ? "twelvedata_close" : "alpaca_close")
      : (sig.entry_price ? "logged" : "none");

    const { returns, status } = computeForwardReturns(sig.date, entryPrice, priceIdx, todayIso);
    const layerAttribution    = buildLayerAttribution(sig.scores, returns);

    const ageDays = Math.floor(
      (new Date(todayIso) - new Date(sig.date)) / (1000 * 60 * 60 * 24)
    );

    enriched.push({
      date:                sig.date,
      symbol:              sig.symbol,
      role:                sig.role,
      archetype:           sig.archetype,
      weights:             sig.weights,
      // V8.0 telemetry (additive; null for pre-v8 entries)
      regime:              sig.regime,
      regime_pmi:          sig.regime_pmi,
      regime_driver:       sig.regime_driver,
      regime_basis:        sig.regime_basis,
      divergence:          sig.divergence,
      hostile_review:      sig.hostile_review,
      entry_price:         entryPrice,
      entry_price_source:  entrySource,
      scores:              sig.scores,
      layer_signals:       sig.layer_signals,
      recommendation:      sig.recommendation,
      forward_returns:     returns,
      layer_attribution:   layerAttribution,
      signal_age_days:     ageDays,
      attribution_status:  status,
      attributed_at:       new Date().toISOString(),
    });
  }

  // 7. Sort (date asc, then symbol) and write
  enriched.sort((a, b) =>
    a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol)
  );
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, enriched.map(r => JSON.stringify(r)).join("\n") + "\n");

  // 8. Console summary — what the Actions log will show
  const complete = enriched.filter(e => e.attribution_status === "complete").length;
  const partial  = enriched.length - complete;
  console.log(`\n[attribute-signals] DONE`);
  console.log(`  wrote ${enriched.length} enriched records  (${complete} complete, ${partial} partial)`);

  // Per-ticker coverage table — useful for spotting symbols where attribution is failing
  console.log("\n  per-ticker coverage:");
  console.log("    symbol   n   5d hit%   20d hit%   avg 5d ret   avg 20d ret");
  console.log("    ─────────────────────────────────────────────────────────────");
  const perTicker = {};
  for (const e of enriched) {
    const t = perTicker[e.symbol] ||= { n: 0, ret5: [], ret20: [], hit5: [], hit20: [] };
    t.n++;
    const r5  = e.forward_returns["5d"];
    const r20 = e.forward_returns["20d"];
    const tac = e.layer_attribution.tactical.direction_correct;
    const pos = e.layer_attribution.positional.direction_correct;
    if (r5  != null) t.ret5.push(r5);
    if (r20 != null) t.ret20.push(r20);
    if (tac != null) t.hit5.push(tac);
    if (pos != null) t.hit20.push(pos);
  }
  const pct  = arr => arr.length ? (arr.filter(Boolean).length / arr.length * 100).toFixed(0) + "%" : "  -";
  const mean = arr => arr.length
    ? (arr.reduce((a, b) => a + b, 0) / arr.length * 100).toFixed(2).padStart(6) + "%"
    : "     -";
  for (const [sym, s] of Object.entries(perTicker).sort()) {
    console.log(
      `    ${sym.padEnd(8)} ${s.n.toString().padStart(3)}   `
      + `${pct(s.hit5).padStart(4)}     ${pct(s.hit20).padStart(4)}    `
      + `${mean(s.ret5)}     ${mean(s.ret20)}`
    );
  }
}

// Run main() when invoked as a script. When imported (e.g. from tests) the
// caller is responsible for calling and awaiting main() themselves.
import { fileURLToPath } from "url";
const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main().catch(e => {
    console.error("[attribute-signals] FATAL:", e);
    process.exit(1);
  });
}

export { main, normalizeSignal, flattenDailyLogEntries, computeForwardReturns, layerDirectionCorrect, addTradingDays };
