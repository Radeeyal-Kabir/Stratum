// Loaded data plus the per-browser preferences every view shares.
import { h, s, store } from "./lib.js";

export const S = {
  doc: null, prices: null, method: null,
  companies: [], by: {}, px: {}, ranked: [],
  watch: new Set(store.get("watch", [])),
  screener: { q: "", rating: "", sector: "", watch: false, sort: "score", dir: -1 },
  compare: store.get("compare", null),
};

export function load(doc, prices, method) {
  S.doc = doc;
  S.prices = prices;
  S.method = method;
  S.companies = doc.companies ?? [];
  S.by = Object.fromEntries(S.companies.map((c) => [c.ticker, c]));
  for (const p of prices.prices ?? []) {
    const pairs = (p.closes ?? []).filter((c) => Array.isArray(c) && typeof c[1] === "number");
    p.dates = pairs.map((c) => c[0]);
    p.closes = pairs.map((c) => c[1]);
  }
  S.px = Object.fromEntries((prices.prices ?? []).map((p) => [p.ticker, p]));
  S.ranked = [...S.companies].sort((a, b) => (b.score?.composite ?? -1) - (a.score?.composite ?? -1));
}

/** Band edges straight from score.py (via data/methodology.json). */
export function bands() {
  const min = (r) => S.method.bands.find((b) => b.rating === r).min;
  return { buy: min("Buy"), hold: min("Hold") };
}

export function counts() {
  const n = { Buy: 0, Hold: 0, Avoid: 0 };
  for (const c of S.companies) if (c.score) n[c.score.rating]++;
  return n;
}
export const rankOf = (t) => S.ranked.findIndex((c) => c.ticker === t) + 1;

let navHandler = () => {};
export const setNavigator = (fn) => { navHandler = fn; };
export const navigate = (route) => navHandler(route);

export function toggleWatch(t) {
  if (S.watch.has(t)) S.watch.delete(t); else S.watch.add(t);
  store.set("watch", [...S.watch]);
}
export function starButton(t, onChange) {
  const b = h("button", { class: "star", type: "button", "aria-pressed": String(S.watch.has(t)), "aria-label": `Watch ${t}`, title: "Add to watchlist" },
    s("svg", { width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": "true" },
      s("path", { d: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z", fill: "currentColor" })));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWatch(t);
    b.setAttribute("aria-pressed", String(S.watch.has(t)));
    onChange?.();
  });
  return b;
}
