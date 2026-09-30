import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { filingChanges } from "../js/filing-changes.js";
import { cashMetrics, setSbcAsCost } from "../js/cashflow.js";
import { S, load } from "../js/state.js";
import { analysisCoverage } from "../js/coverage.js";
import { companyEvents, targetStatus, similar } from "../js/digest.js";

function cashFlowFixture(overrides = {}) {
  return {
    period_end: "2026-06-30", revenue_ttm: 100e9, operating_cash_flow_ttm: 30e9, capex_ttm: 5e9,
    fcf_ttm: 25e9, sbc_ttm: 5e9, fcf_margin: 0.25, sbc_pct_revenue: 0.05, fcf_less_sbc_margin: 0.20,
    cash: 10e9, short_term_investments: 4e9, debt: 20e9, shares_outstanding: 1e9, shares_as_of: "2026-06-30",
    concepts: {}, ...overrides,
  };
}

test("cashMetrics marks enterprise value incomplete rather than treating missing debt or cash as zero", () => {
  load({ companies: [
    { ticker: "AAA", fundamentals: { cash_flow: cashFlowFixture() } },
    { ticker: "BBB", fundamentals: { cash_flow: cashFlowFixture({ debt: null }) } },
    { ticker: "CCC", fundamentals: { cash_flow: cashFlowFixture({ cash: null }) } },
    { ticker: "DDD", fundamentals: { cash_flow: cashFlowFixture({ short_term_investments: null }) } },
    { ticker: "EEE", fundamentals: { cash_flow: cashFlowFixture({ shares_outstanding: null, shares_as_of: null }) } },
  ] }, { prices: [{ ticker: "AAA", close: 100 }, { ticker: "BBB", close: 100 }, { ticker: "CCC", close: 100 }, { ticker: "DDD", close: 100 }, { ticker: "EEE", close: 100 }] }, {});

  // All inputs present: EV = market cap (1e9 * 100 = 100e9) + debt - cash - short-term investments.
  const complete = cashMetrics(S.by.AAA);
  assert.equal(complete.marketCap, 100e9);
  assert.equal(complete.ev, 100e9 + 20e9 - 10e9 - 4e9);
  assert.equal(complete.evReason, null);

  // Missing debt or cash must blank the valuation, not silently substitute zero.
  const noDebt = cashMetrics(S.by.BBB);
  assert.equal(noDebt.ev, null);
  assert.equal(noDebt.evReason, "Debt figure unavailable");
  assert.equal(noDebt.shownYield, null);

  const noCash = cashMetrics(S.by.CCC);
  assert.equal(noCash.ev, null);
  assert.equal(noCash.evReason, "Cash figure unavailable");

  // Short-term investments is a genuinely optional line item: absence is treated as zero, not "incomplete".
  const noSti = cashMetrics(S.by.DDD);
  assert.equal(noSti.ev, 100e9 + 20e9 - 10e9 - 0);
  assert.equal(noSti.evReason, null);

  // No share count: unchanged pre-existing behavior (can't compute market cap at all).
  const noShares = cashMetrics(S.by.EEE);
  assert.equal(noShares.ev, null);
  assert.equal(noShares.evReason, "Needs share count and price");

  // The SBC-adjusted yield follows the toggle and is distinct from the plain FCF yield.
  setSbcAsCost(true);
  const adjOn = cashMetrics(S.by.AAA);
  setSbcAsCost(false);
  const adjOff = cashMetrics(S.by.AAA);
  assert.equal(adjOn.shownYield, adjOn.sbcAdjustedYield);
  assert.equal(adjOff.shownYield, adjOff.fcfYield);
  assert.notEqual(adjOn.shownYield, adjOff.shownYield);
});

test("analysis coverage keeps 'read and found nothing' apart from 'couldn't read it'", () => {
  const ok = (filed, read, flags = []) => ({ accession: filed, form: "10-Q", filed, period_end: filed, status: "ok", mda_chars: 1000, chars_analyzed: read, red_flags: flags });
  const co = (...filings) => ({ qualitative: { filings } });
  assert.equal(analysisCoverage(co()).state, "pending");
  const partial = analysisCoverage(co(ok("2026-01-01", 1000), ok("2026-04-01", 350, [{ category: "debt" }, { category: "margin" }])));
  assert.equal(partial.state, "partial");
  assert.equal(partial.share, 0.35);
  assert.equal(partial.flags, 2);
  const full = analysisCoverage(co(ok("2026-04-01", 990)));
  assert.equal(full.state, "full");
  assert.equal(full.flags, 0);
  // The newest attempt failed: say so, and name the older filing the score still rests on.
  const failed = analysisCoverage(co(ok("2026-01-01", 400), { accession: "x", form: "10-K", filed: "2026-04-01", period_end: "2026-03-31", status: "llm_failed" }));
  assert.equal(failed.state, "failed");
  assert.equal(failed.scored.filed, "2026-01-01");
  assert.match(failed.reason, /no usable answer/);
});

test("digest reports what changed since the last visit, and flags tracked commitments", () => {
  const filing = (acc, analyzed, cats) => ({ accession: acc, form: "10-Q", filed: analyzed.slice(0, 10), status: "ok", analyzed_at: analyzed, tone: "bullish", red_flags: cats.map((category) => ({ category })) });
  const c = {
    ticker: "AAA", name: "Alpha",
    qualitative: { filings: [filing("a", "2026-06-01T00:00:00Z", ["margin_pressure"]), filing("b", "2026-09-20T00:00:00Z", ["margin_pressure", "demand_weakness"])] },
    rating_history: [{ at: "2026-08-01T00:00:00Z", rating: "Hold", composite: 60 }, { at: "2026-09-21T00:00:00Z", rating: "Buy", composite: 66 }],
  };
  const stmt = (accession, quote, change) => ({ accession, quote, change, filed: "2026-09-19" });
  const chain = { status: "revised", statements: [stmt("a", "We expect the plant to open in 2027.", "original"), stmt("b", "We expect the plant to open in 2028.", "revised")] };
  const since = new Date("2026-09-10T00:00:00Z");
  const events = companyEvents(c, { price: { close: 90, change_1d: -0.07, date: "2026-09-25" }, chains: [chain], since, trackedQuotes: ["We expect the plant to open in 2027."] });
  const kinds = events.map((e) => e.kind);
  assert.deepEqual([...kinds].sort(), ["commitment", "filing", "flags", "price", "rating"]);
  assert.equal(events.find((e) => e.kind === "commitment").tracked, true);
  assert.match(events.find((e) => e.kind === "rating").text, /Hold → Buy \(60\.0 → 66\.0\)/);
  assert.match(events.find((e) => e.kind === "flags").text, /Demand weakness/);
  assert.ok(events.slice(0, 3).every((e) => e.important), "important events come first");
  // After the visit that saw them, nothing is new.
  assert.deepEqual(companyEvents(c, { price: { close: 90, change_1d: -0.07, date: "2026-09-25" }, chains: [chain], since: new Date("2026-09-30T00:00:00Z") }), []);
  // A long-filed report that was only reprocessed recently is not news.
  const reprocessed = { ...c, qualitative: { filings: [{ ...filing("z", "2026-09-29T00:00:00Z", ["margin_pressure"]), filed: "2026-06-25" }] } };
  assert.deepEqual(companyEvents(reprocessed, { chains: [], since }).filter((e) => e.kind === "filing" || e.kind === "flags"), []);
  // ...but one filed just before the last visit and analyzed after it is.
  const lagged = { ...c, qualitative: { filings: [{ ...filing("y", "2026-09-11T06:00:00Z", []), filed: "2026-09-09" }] } };
  assert.equal(companyEvents(lagged, { chains: [], since }).filter((e) => e.kind === "filing").length, 1);
  assert.equal(similar("We expect the plant to open in 2027.", "We expect the plant to open in 2028."), true);
  assert.equal(similar("We expect the plant to open in 2027.", "Revenue decreased because of lower demand."), false);
});

test("price target status", () => {
  assert.equal(targetStatus({ close: 98 }, 100).state, "within 3% below");
  assert.equal(targetStatus({ close: 80 }, 100).state, "below");
  assert.equal(targetStatus({ close: 101 }, 100).state, "at or above");
  assert.equal(targetStatus({ close: 101 }, null), null);
});

test("filing changes use distinct successful filings and compare categories", () => {
  const report = (accession, filed, categories, status = "ok") => ({ accession, filed, status, red_flags: categories.map((category) => ({ category })) });
  const old = report("a", "2026-01-01", ["debt", "demand"]);
  const latest = report("b", "2026-04-01", ["debt", "margin", "margin"]);
  const r = filingChanges([latest, old, report("failed", "2026-05-01", [], "error"), latest]);
  assert.equal(r.previous.accession, "a");
  assert.equal(r.latest.accession, "b");
  assert.deepEqual(r.added, ["margin"]);
  assert.deepEqual(r.absent, ["demand"]);
  assert.deepEqual(r.continuing, ["debt"]);
  assert.equal(filingChanges([latest, latest]).previous, undefined);
  assert.equal(filingChanges([]).latest, undefined);
});

test("all routes render; filters, watchlist, sorting, export and themes work", async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://preview.example/#overview", pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ["document", "localStorage", "location", "history", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent"]) globalThis[k] = w[k];
  globalThis.window = w;
  globalThis.innerWidth = 1280; globalThis.innerHeight = 850;
  globalThis.addEventListener = w.addEventListener.bind(w);
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const observers = new Set();
  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; }
    observe(el) { this.el = el; observers.add(this); }
    disconnect() { observers.delete(this); }
  };
  globalThis.fetch = async (path) => ({ ok: true, json: async () => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")) });
  await import("../js/app.js");
  const { S } = await import("../js/state.js");
  const draw = (width) => {
    for (const o of observers) o.fn([{ contentRect: { width } }]);
    for (const el of document.querySelectorAll("main svg *")) {
      for (const attr of el.attributes) assert.doesNotMatch(attr.value, /NaN|undefined|Infinity/, `${el.tagName}.${attr.name}`);
    }
  };
  const route = (name) => {
    location.hash = "#" + name;
    w.dispatchEvent(new w.PopStateEvent("popstate"));
    assert.ok(document.querySelector("main h1"), name);
    draw(900); draw(310);
  };
  for (const name of ["overview", "screener", "compare", "watchlist", "method", ...S.companies.map((c) => c.ticker)]) route(name);
  for (const c of S.companies) {
    route(c.ticker);
    const img = document.querySelector(".company-title img");
    assert.ok(existsSync(new URL("../" + img.getAttribute("src"), import.meta.url)), c.ticker);
    assert.match(document.querySelector(".filing-delta").textContent, /What changed/);
  }
  route("MU/changes");
  assert.match(document.querySelector("main h1").textContent, /What changed in Micron/);
  assert.ok(document.querySelector('.crumbs a[href="#MU"]'));
  route("screener");
  const q = document.querySelector("#screener-q");
  q.value = "Microsoft"; q.dispatchEvent(new Event("input"));
  assert.equal(document.querySelectorAll("tbody tr").length, 1);
  assert.match(document.querySelector("tbody").textContent, /MSFT/);
  document.querySelector(".star").click();
  assert.ok(S.watch.has("MSFT"));
  assert.equal(location.hash, "#screener");
  let csvBlob;
  const savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { csvBlob = blob; return "blob:test"; };
  URL.revokeObjectURL = () => {};
  const originalClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = () => {};
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Export CSV")).click();
  const csv = await csvBlob.text();
  assert.equal(csv.split("\r\n").length, 2);
  assert.match(csv, /MSFT/); assert.doesNotMatch(csv, /NVDA/);
  URL.createObjectURL = savedCreate; URL.revokeObjectURL = savedRevoke;
  w.HTMLAnchorElement.prototype.click = originalClick;
  q.value = ""; q.dispatchEvent(new Event("input"));
  document.querySelector(".toggle").click();
  assert.equal(document.querySelectorAll("tbody tr").length, 1);
  document.querySelector(".star").click();
  assert.match(document.querySelector("tbody").textContent, /No companies match/);
  assert.equal([...document.querySelectorAll("button")].find((b) => b.textContent.includes("Export CSV")).disabled, true);
  document.querySelector(".toggle").click();
  [...document.querySelectorAll('[aria-label="Table view"] button')].find((b) => b.textContent === "Fundamentals").click();
  assert.match(document.querySelector("thead").textContent, /Revenue YoY/);
  assert.doesNotMatch(document.querySelector("thead").textContent, /Last close/);
  const sortButton = [...document.querySelectorAll("th button")].find((b) => b.textContent === "Company");
  sortButton.click();
  assert.equal(document.querySelector("tbody .tk").textContent, "AAPL");
  const buy = [...document.querySelectorAll('[aria-label="Rating"] button')].find((b) => b.textContent.startsWith("Buy"));
  buy.click();
  for (const row of document.querySelectorAll("tbody tr")) assert.ok(row.querySelector(".chip.Buy"));
  document.querySelector("#open-search").click();
  const palette = document.querySelector("#palette-q");
  palette.value = "NVDA"; palette.dispatchEvent(new Event("input"));
  assert.equal(document.querySelectorAll('.pal [role="option"]').length, 1);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(location.hash, "#NVDA");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  // Two modes only: a click flips between them, never to a third "system" state.
  const before = document.documentElement.dataset.theme;
  assert.ok(["light", "dark"].includes(before));
  document.querySelector("#theme-btn").click();
  assert.notEqual(document.documentElement.dataset.theme, before);
  document.querySelector("#theme-btn").click();
  assert.equal(document.documentElement.dataset.theme, before);
  const img = document.querySelector(".company-logo img");
  const badge = img.parentElement;
  img.dispatchEvent(new Event("error"));
  assert.equal(badge.querySelector("img"), null);
  assert.equal(badge.textContent, "NV");
  console.log("Verified 24 routes at two chart widths, 20 logos, screener controls, filtered CSV, watchlist, palette, themes, and logo fallback.");
  dom.window.close();
});
