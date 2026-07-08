#!/usr/bin/env node
// benchmark-scorecard.mjs v1.0 — Signal-following P&L vs equal-weight and SPY.
//
// THE QUESTION THIS ANSWERS: is the signal tilt worth anything? The paper
// portfolio and the equal-weight benchmark receive IDENTICAL cashflows on
// identical dates ($1M day one + $10K per trading day, read from the paper
// portfolio's own deposit record) and hold the SAME point-in-time membership.
// The ONLY difference is where each day's flow goes: the paper trader tilts
// it toward the day's buy signals (and trims), the benchmark splits it
// equally. Signal TWR minus equal-weight TWR is therefore the cleanest
// available read of the signal tilt's value-add. SPY under the same
// cashflows answers the broader "should this book exist at all" question.
//
// MEMBERSHIP CONVENTION (approved v8.3): POINT-IN-TIME, no retroactive
// restatement. Implemented generically: a date's members are exactly the
// symbols present in that date's daily-log.jsonl entry. So the benchmark is
// 1/12-weighted before the MA/ISRG add date and 1/14-weighted after, the
// historical ETHA era is honored as it was lived, and any future membership
// change needs zero changes here. When a held symbol disappears from the log
// (a retirement/swap), the benchmark liquidates it at its last known price
// and folds the proceeds into that day's deposit pool — redeployed equally
// across the surviving members the same day.
//
// INPUTS (all existing history; no new state files):
//   docs/history/paper-portfolio.json — the signal-following value series +
//     the authoritative deposit schedule (per-date flow = delta of
//     total_deposited between consecutive snapshots; the first snapshot's
//     flow is its full total_deposited, i.e. $1M seed + first $10K).
//   docs/history/daily-log.jsonl — per-date membership + per-symbol prices.
//   Alpaca (ALPK/ALPS) — SPY daily closes, ONE request for the whole span.
//     Keys absent or fetch fails → the SPY leg reports null and the
//     equal-weight comparison still ships (graceful degradation).
//
// OUTPUT: docs/history/benchmark-scorecard.json — daily series
//   { date, deposited, signal, ew, spy } + TWR summary (since inception,
//   trailing 30/90 snapshots), excess-return headline numbers, membership
//   event log, and a data_quality block. Console report.
//
// v1 SCOPE: data producer only. NOT wired into the dashboard (hub layout is
// frozen; a scorecard tab is a separate, explicitly-approved step).
//
// ACCOUNTING NOTES (stamped into output.notes):
//   • Price-return only, all three legs: daily-log prices are quote closes
//     (no dividend reinvestment) and SPY uses split-adjusted closes for
//     consistency. Dividend-blind on BOTH sides of every comparison — this
//     understates the income names (ENB/PBR.A/KOF) and SPY alike; treat
//     small excess readings near zero as noise accordingly.
//   • TWR flow convention: deposits land BEFORE trading (matches the paper
//     trader: cash += deposit, then buys), so r_t = V_t / (V_{t-1} + F_t) - 1
//     and TWR = Π(1+r_t) − 1. Identical F_t across all three legs by
//     construction, so TWR differences are portfolio effects only.
//   • A paper date with no matching daily-log entry (shouldn't happen — same
//     pipeline) carries membership and prices forward and is counted in
//     data_quality.dates_missing_log.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const HISTORY_DIR = "docs/history";
const PORTFOLIO_PATH = `${HISTORY_DIR}/paper-portfolio.json`;
const DAILY_LOG_PATH = `${HISTORY_DIR}/daily-log.jsonl`;
const OUTPUT_PATH = `${HISTORY_DIR}/benchmark-scorecard.json`;

const ALPACA_KEY = process.env.ALPK;
const ALPACA_SECRET = process.env.ALPS;

mkdirSync(HISTORY_DIR, { recursive: true });

// ─── LOAD PAPER HISTORY (the signal-following leg + the flow schedule) ──────
if (!existsSync(PORTFOLIO_PATH)) {
  console.log("No paper-portfolio.json yet — scorecard starts after the paper trader's first day.");
  writeFileSync(OUTPUT_PATH, JSON.stringify({ generated: new Date().toISOString(), days: 0, series: [], summary: null, notes: ["no paper history yet"] }, null, 2));
  process.exit(0);
}
const paper = JSON.parse(readFileSync(PORTFOLIO_PATH, "utf-8"));
const paperHistory = (paper.history || []).filter(h => h.date && h.total_value != null && h.total_deposited != null);
if (paperHistory.length === 0) {
  console.log("Paper history empty — nothing to score yet.");
  writeFileSync(OUTPUT_PATH, JSON.stringify({ generated: new Date().toISOString(), days: 0, series: [], summary: null, notes: ["paper history empty"] }, null, 2));
  process.exit(0);
}
paperHistory.sort((a, b) => a.date < b.date ? -1 : 1);

// Deposit schedule: F_t = Δ total_deposited (first snapshot = its full total).
const flows = [];
for (let i = 0; i < paperHistory.length; i++) {
  const prev = i === 0 ? 0 : paperHistory[i - 1].total_deposited;
  flows.push(+(paperHistory[i].total_deposited - prev).toFixed(2));
}

// ─── LOAD DAILY LOG (per-date membership + prices) ──────────────────────────
const logByDate = {};
if (existsSync(DAILY_LOG_PATH)) {
  for (const line of readFileSync(DAILY_LOG_PATH, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.date && Array.isArray(e.holdings)) logByDate[e.date] = e;
    } catch { /* skip malformed */ }
  }
}

// ─── SPY CLOSES (one Alpaca request for the whole span) ─────────────────────
async function fetchSpyCloses(startDate, endDate) {
  if (!ALPACA_KEY || !ALPACA_SECRET) {
    console.log("  [SPY] No Alpaca keys — SPY leg disabled this run.");
    return null;
  }
  try {
    const url = `https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=${startDate}&end=${endDate}&limit=10000&adjustment=split&feed=sip`;
    const resp = await fetch(url, { headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET } });
    if (!resp.ok) { console.log(`  [SPY] Alpaca ${resp.status} — SPY leg disabled this run.`); return null; }
    const data = await resp.json();
    const closes = {};
    for (const b of (data.bars || [])) closes[String(b.t).slice(0, 10)] = b.c;
    console.log(`  [SPY] ${Object.keys(closes).length} closes loaded (${startDate} → ${endDate}).`);
    return closes;
  } catch (e) {
    console.log(`  [SPY] fetch failed (${e.message}) — SPY leg disabled this run.`);
    return null;
  }
}

// ─── SIMULATE ────────────────────────────────────────────────────────────────
function simulate(spyCloses) {
  // Equal-weight state
  const ewShares = {};       // symbol → shares
  const lastPrice = {};      // symbol → last known price (valuation carry-forward)
  let lastMembers = [];      // carried membership for missing-log dates
  // SPY state
  let spyShares = 0;
  let lastSpyClose = null;

  const series = [];
  const events = [];         // membership changes (adds/retirements) as they occur
  const dq = { dates: paperHistory.length, dates_missing_log: 0, dates_missing_spy: 0, members_skipped_no_price: 0 };

  for (let i = 0; i < paperHistory.length; i++) {
    const snap = paperHistory[i];
    const date = snap.date;
    const F = flows[i];

    // Membership + prices for this date
    const entry = logByDate[date];
    let members, priceOf = {};
    if (entry) {
      members = entry.holdings.map(h => h.symbol);
      for (const h of entry.holdings) if (h.price != null && h.price > 0) priceOf[h.symbol] = h.price;
    } else {
      dq.dates_missing_log++;
      members = lastMembers;   // carry forward
    }
    for (const [sym, p] of Object.entries(priceOf)) lastPrice[sym] = p;

    // Membership events (point-in-time convention made visible)
    if (lastMembers.length > 0) {
      const added = members.filter(m => !lastMembers.includes(m));
      const removed = lastMembers.filter(m => !members.includes(m));
      if (added.length || removed.length) events.push({ date, added, removed, members_after: members.length });
    } else if (members.length > 0) {
      events.push({ date, added: members.slice(), removed: [], members_after: members.length, note: "inception" });
    }

    // Retirements: liquidate at last known price into today's deposit pool.
    let pool = F;
    for (const sym of Object.keys(ewShares)) {
      if (!members.includes(sym) && ewShares[sym] > 0) {
        const px = lastPrice[sym];
        if (px != null) {
          pool += ewShares[sym] * px;
          events[events.length - 1] && events[events.length - 1].removed?.includes(sym)
            ? (events[events.length - 1].liquidated = events[events.length - 1].liquidated || []).push({ symbol: sym, proceeds: +(ewShares[sym] * px).toFixed(2) })
            : null;
        }
        delete ewShares[sym];
      }
    }

    // Equal split of the pool across members WITH a price today.
    const buyable = members.filter(m => priceOf[m] != null);
    dq.members_skipped_no_price += members.length - buyable.length;
    if (buyable.length > 0 && pool > 0) {
      const per = pool / buyable.length;
      for (const sym of buyable) ewShares[sym] = (ewShares[sym] || 0) + per / priceOf[sym];
      pool = 0;
    }
    // pool only survives a day with zero priced members (degenerate); value it as cash.

    // EW valuation at last known prices.
    let ewValue = pool;
    for (const [sym, sh] of Object.entries(ewShares)) {
      const px = lastPrice[sym];
      if (px != null) ewValue += sh * px;
    }

    // SPY leg under identical flow.
    let spyValue = null;
    if (spyCloses) {
      const close = spyCloses[date] ?? lastSpyClose;
      if (spyCloses[date] == null) dq.dates_missing_spy++;
      if (close != null) {
        spyShares += F / close;
        lastSpyClose = close;
        spyValue = +(spyShares * close).toFixed(2);
      }
    }

    series.push({
      date,
      deposited: snap.total_deposited,
      flow: F,
      signal: snap.total_value,
      ew: +ewValue.toFixed(2),
      spy: spyValue,
      members: members.length,
    });

    lastMembers = members;
  }

  return { series, events, dq };
}

// ─── TWR (deposit-before-trading convention; identical flows all legs) ──────
function twr(series, key, fromIdx = 0) {
  let chain = 1, n = 0;
  for (let i = fromIdx; i < series.length; i++) {
    const v = series[i][key];
    if (v == null) return null;                       // leg disabled (SPY without keys)
    const prev = i === 0 ? 0 : series[i - 1][key];
    if (i === 0 || (fromIdx > 0 && i === fromIdx)) {
      if (fromIdx > 0) continue;                      // trailing windows: skip base row
      chain *= v / series[i].flow;                    // day one: V1 / F1
    } else {
      const denom = (prev ?? 0) + series[i].flow;
      if (denom <= 0) continue;
      chain *= v / denom;
    }
    n++;
  }
  return n > 0 ? +((chain - 1) * 100).toFixed(3) : null;
}

function windowTwr(series, key, days) {
  if (series.length < days + 1) return null;
  return twr(series, key, series.length - days);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Benchmark Scorecard v1.0");
  console.log("========================");
  const first = paperHistory[0].date, last = paperHistory[paperHistory.length - 1].date;
  console.log(`Span: ${first} → ${last} (${paperHistory.length} trading days)`);

  const spyCloses = await fetchSpyCloses(first, last);
  const { series, events, dq } = simulate(spyCloses);

  const lastRow = series[series.length - 1];
  const sinceInception = {
    signal_twr_pct: twr(series, "signal"),
    ew_twr_pct: twr(series, "ew"),
    spy_twr_pct: twr(series, "spy"),
  };
  const excess = {
    signal_vs_ew_pp: (sinceInception.signal_twr_pct != null && sinceInception.ew_twr_pct != null)
      ? +(sinceInception.signal_twr_pct - sinceInception.ew_twr_pct).toFixed(3) : null,
    signal_vs_spy_pp: (sinceInception.signal_twr_pct != null && sinceInception.spy_twr_pct != null)
      ? +(sinceInception.signal_twr_pct - sinceInception.spy_twr_pct).toFixed(3) : null,
  };
  const trailing = {
    d30: { signal: windowTwr(series, "signal", 30), ew: windowTwr(series, "ew", 30), spy: windowTwr(series, "spy", 30) },
    d90: { signal: windowTwr(series, "signal", 90), ew: windowTwr(series, "ew", 90), spy: windowTwr(series, "spy", 90) },
  };
  const grade = series.length < 20 ? "INSUFFICIENT_DATA (n<20 — directional only)"
    : series.length < 60 ? "EARLY (n<60 — treat excess as provisional)"
    : "SEASONED";

  const out = {
    generated: new Date().toISOString(),
    version: "1.0",
    membership_convention: "point-in-time via daily-log presence (approved v8.3 — no retroactive restatement; 1/12 pre-add, 1/14 post-add)",
    days: series.length,
    date_range: { first, last },
    grade,
    final: { deposited: lastRow.deposited, signal: lastRow.signal, ew: lastRow.ew, spy: lastRow.spy },
    since_inception: sinceInception,
    excess,
    trailing,
    membership_events: events,
    data_quality: dq,
    notes: [
      "Price-return only on all three legs (no dividend reinvestment anywhere) — income names and SPY are understated symmetrically.",
      "TWR flow convention: deposits before trading, r_t = V_t/(V_{t-1}+F_t)−1; flows identical across legs by construction.",
      "Retired symbols liquidate at last known price into the same day's equal-split pool.",
      "SPY leg null = Alpaca keys absent or fetch failed this run; EW comparison unaffected.",
    ],
    series,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));

  // ─── CONSOLE REPORT ─────────────────────────────────────────────────────
  const fmt = v => v == null ? "   n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  console.log(`\nGrade: ${grade}`);
  console.log(`\n─── SINCE INCEPTION (TWR, identical cashflows) ───`);
  console.log(`  Signal-following: ${fmt(sinceInception.signal_twr_pct)}   → $${lastRow.signal?.toLocaleString()}`);
  console.log(`  Equal-weight:     ${fmt(sinceInception.ew_twr_pct)}   → $${lastRow.ew?.toLocaleString()}`);
  console.log(`  SPY:              ${fmt(sinceInception.spy_twr_pct)}   → ${lastRow.spy != null ? "$" + lastRow.spy.toLocaleString() : "n/a"}`);
  console.log(`\n  SIGNAL TILT (vs equal-weight): ${excess.signal_vs_ew_pp != null ? (excess.signal_vs_ew_pp >= 0 ? "+" : "") + excess.signal_vs_ew_pp + "pp" : "n/a"}   ← the number that matters`);
  console.log(`  vs SPY:                        ${excess.signal_vs_spy_pp != null ? (excess.signal_vs_spy_pp >= 0 ? "+" : "") + excess.signal_vs_spy_pp + "pp" : "n/a"}`);
  console.log(`\n─── TRAILING ───`);
  console.log(`  30d: signal ${fmt(trailing.d30.signal)} | ew ${fmt(trailing.d30.ew)} | spy ${fmt(trailing.d30.spy)}`);
  console.log(`  90d: signal ${fmt(trailing.d90.signal)} | ew ${fmt(trailing.d90.ew)} | spy ${fmt(trailing.d90.spy)}`);
  if (events.length > 0) {
    console.log(`\n─── MEMBERSHIP EVENTS (point-in-time) ───`);
    for (const e of events.slice(-6)) {
      console.log(`  ${e.date}: ${e.note ?? ""}${e.added?.length ? " +" + e.added.join(",+") : ""}${e.removed?.length ? " −" + e.removed.join(",−") : ""} → ${e.members_after} members`);
    }
  }
  if (dq.dates_missing_log > 0 || dq.members_skipped_no_price > 0) {
    console.log(`\n⚠ data quality: ${dq.dates_missing_log} dates missing log entries, ${dq.members_skipped_no_price} member-days skipped for missing prices, ${dq.dates_missing_spy} SPY gaps.`);
  }
  console.log(`\n✓ Scorecard → ${OUTPUT_PATH}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
