import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { filingChanges } from "../js/filing-changes.js";

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
  for (const name of ["overview", "screener", "compare", "method", ...S.companies.map((c) => c.ticker)]) route(name);
  for (const c of S.companies) {
    route(c.ticker);
    const img = document.querySelector(".company-title img");
    assert.ok(existsSync(new URL("../" + img.getAttribute("src"), import.meta.url)), c.ticker);
    assert.match(document.querySelector(".filing-delta").textContent, /What changed/);
  }
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
  assert.equal(document.querySelectorAll('[role="option"]').length, 1);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(location.hash, "#NVDA");
  assert.equal(document.querySelector('[role="dialog"]'), null);
  document.querySelector("#theme-btn").click();
  assert.equal(document.documentElement.dataset.theme, "light");
  document.querySelector("#theme-btn").click();
  assert.equal(document.documentElement.dataset.theme, "dark");
  const img = document.querySelector(".company-logo img");
  const badge = img.parentElement;
  img.dispatchEvent(new Event("error"));
  assert.equal(badge.querySelector("img"), null);
  assert.equal(badge.textContent, "NV");
  console.log("Verified 24 routes at two chart widths, 20 logos, screener controls, filtered CSV, watchlist, palette, themes, and logo fallback.");
  dom.window.close();
});
