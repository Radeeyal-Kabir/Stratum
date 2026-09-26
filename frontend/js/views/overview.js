import { S, bands, counts } from "../state.js";
import { chip, dirc, dshort, dtime, flagName, h, hideTip, isNum, link, pct, plural, ratingColor, showTip, store } from "../lib.js";
import { identity, logo } from "../identity.js";
import { scoreMap } from "../charts.js";

function tile(label, value, detail, cls = "", wide = false) {
  return h("div", { class: "tile" + (wide ? " wide" : "") },
    h("div", { class: "eyebrow", text: label }), h("div", { class: `v ${cls}` }, value), detail ? h("div", { class: "d" }, detail) : null);
}

function card(title, sub, ...body) {
  return h("section", { class: "card" }, h("div", { class: "card-head" }, h("div", {}, h("h2", { text: title }), sub ? h("p", { text: sub }) : null)), ...body);
}

function hero() {
  const n = counts(), u = S.prices?.universe_avg ?? {};
  const scores = S.ranked.map((c) => c.score?.composite).filter(isNum).sort((a, b) => a - b);
  const median = scores.length ? (scores[(scores.length - 1) >> 1] + scores[scores.length >> 1]) / 2 : null;
  return h("section", { class: "overview-intro" },
    h("div", { class: "edition-line" },
      h("p", { class: "eyebrow", text: "THE RESEARCH DESK / S&P 500 INFORMATION TECHNOLOGY" }),
      h("span", { class: "edition-date", text: S.doc.as_of ? `Updated ${dshort(S.doc.as_of)}` : "Awaiting data" })),
    h("div", { class: "editorial-heading" },
      h("div", {}, h("h1", {}, "Technology, ", h("em", { text: "in focus." })),
        h("p", { class: "intro-copy", text: "Look beyond the price. Explore the fundamentals, management signals, and filing evidence behind 20 technology companies." })),
      link("screener", { class: "btn btn-primary" }, "Explore the screener", h("span", { "aria-hidden": "true", text: "↗" }))),
    h("div", { class: "market-strip" },
      tile("Coverage", String(S.companies.length).padStart(2, "0"), "Companies · SEC-sourced"),
      tile("Group · latest close", pct(u.change_1d, 2, true), S.prices?.market_date ? dshort(S.prices.market_date) : "Price unavailable", dirc(u.change_1d)),
      tile("Three-month return", pct(u.return_3m, 1, true), "Equal-weight group average", dirc(u.return_3m)),
      tile("Median composite", isNum(median) ? median.toFixed(1) : "–", "Out of 100 · 70% quant / 30% qual.")),
    h("div", { class: "rating-strip" },
      h("span", { class: "eyebrow", text: "THE CURRENT PICTURE" }),
      h("div", { class: "dist", role: "img", "aria-label": `${n.Buy} Buy, ${n.Hold} Hold, ${n.Avoid} Avoid` },
        ["Buy", "Hold", "Avoid"].filter((r) => n[r]).map((r) => h("span", { style: { flex: n[r], background: ratingColor(r) } }))),
      h("div", { class: "dist-legend" }, ["Buy", "Hold", "Avoid"].map((r) =>
        h("span", {}, h("i", { style: { background: ratingColor(r) } }), h("b", { class: "num", text: n[r] }), ` ${r}`)))));
}

function leadersCard() {
  return h("section", { class: "card leaders-card" },
    h("div", { class: "card-head" }, h("div", {}, h("p", { class: "section-kicker", text: "02 / THE SHORTLIST" }),
      h("h2", { text: "Leading the coverage" }), h("p", { text: "Highest composite scores in the group." }))),
    h("div", { class: "leaders-list" }, S.ranked.slice(0, 5).map((c, i) =>
      link(c.ticker, { class: "leader-row" }, h("span", { class: "rank-no", text: String(i + 1).padStart(2, "0") }),
        identity(c), h("span", { class: "leader-score" }, h("strong", { text: c.score?.composite.toFixed(1) ?? "–" }), chip(c.score, false))))),
    link("screener", { class: "section-link" }, "View all companies", h("span", { "aria-hidden": "true", text: "→" })),
    h("div", { class: "research-note" }, h("span", { class: "eyebrow", text: "A NOTE ON THE MODEL" }),
      h("p", { text: "Scores reflect financial strength and filing language. Market prices are shown separately and do not influence the rating." }),
      link("method", {}, "Read the methodology ↗")));
}

function scoreMapCard() {
  const el = h("div", { class: "chart" });
  scoreMap(el);
  const { buy, hold } = bands();
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("div", {}, h("p", { class: "section-kicker", text: "01 / THE LANDSCAPE" }), h("h2", { text: "Where the signals meet" }),
        h("p", { text: `Fundamentals meet management language. Lines mark the ${hold} and ${buy} rating thresholds. Select a company to explore.` })),
      h("div", { class: "legend" }, ["Buy", "Hold", "Avoid"].map((r) => h("span", {}, h("i", { style: { "--k": ratingColor(r) } }), r)))),
    el);
}

function moversCard() {
  if (!S.prices?.movers) return card("Winners and losers", null, h("p", { class: "empty", text: "Price data hasn't loaded yet." }));
  let period = store.get("period", "day");
  const body = h("div", { class: "movers" });
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Period" });
  const paint = () => {
    seg.replaceChildren(...[["day", "Today"], ["week", "This week"]].map(([k, lb]) =>
      h("button", { type: "button", "aria-pressed": String(period === k), text: lb, onclick: () => { period = k; store.set("period", k); paint(); } })));
    const key = period === "day" ? "change_1d" : "change_5d";
    const mv = S.prices.movers[period];
    const maxAbs = Math.max(...[...mv.winners, ...mv.losers].map((t) => Math.abs(S.px[t]?.[key] ?? 0))) || 1;
    const col = (title, list) => h("div", {}, h("h3", { text: title }), list.map((t) => {
      const v = S.px[t]?.[key];
      return link(t, { class: "mv" }, h("span", { class: "ticker-with-logo" }, logo(t, "xs"), h("span", { class: "tk", text: t })),
        h("span", { class: "bar" }, h("span", { style: { width: `${(Math.abs(v ?? 0) / maxAbs) * 100}%`, background: v >= 0 ? "var(--up)" : "var(--down)" } })),
        h("span", { class: `v ${dirc(v)}`, text: pct(v, 1, true) }));
    }));
    body.replaceChildren(col("Biggest gains", mv.winners), col("Biggest losses", mv.losers));
  };
  paint();
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Winners and losers" }), h("p", { text: "Largest price moves in the group." })), seg), body);
}

/** Where price action and the rating point in opposite directions. */
function findTensions() {
  const out = [];
  for (const c of S.companies) {
    const p = S.px[c.ticker];
    if (!c.score || !p) continue;
    const r = c.score.rating, d1 = p.change_1d ?? 0, d5 = p.change_5d ?? 0;
    const mv = Math.abs(d5) >= Math.abs(d1) ? { v: d5, when: "this week" } : { v: d1, when: "today" };
    if (r === "Avoid" && (d1 >= 0.02 || d5 >= 0.05)) out.push({ t: c.ticker, w: mv.v, text: `Up ${pct(mv.v)} ${mv.when} despite an Avoid rating.` });
    else if (r === "Buy" && (d1 <= -0.02 || d5 <= -0.05)) out.push({ t: c.ticker, w: -mv.v, text: `Down ${pct(-mv.v)} ${mv.when} despite a Buy rating.` });
    else if (r === "Avoid" && (p.vs_sma200 ?? 0) >= 0.10 && (p.rel_universe_3m ?? 0) >= 0.05) out.push({ t: c.ticker, w: p.vs_sma200 / 2, text: `Trading ${pct(p.vs_sma200, 0)} above its 200-day average and beating peers, despite an Avoid rating.` });
    else if (r === "Buy" && (p.vs_sma200 ?? 0) <= -0.10 && (p.rel_universe_3m ?? 0) <= -0.05) out.push({ t: c.ticker, w: -p.vs_sma200 / 2, text: `Trading ${pct(-p.vs_sma200, 0)} below its 200-day average and lagging peers, despite a Buy rating.` });
  }
  return out.sort((a, b) => b.w - a.w);
}

function tensionCard() {
  const items = findTensions();
  return card("Price vs. rating", "Where the market and the filings-based rating point in opposite directions.",
    items.length ? h("ul", { class: "tension" }, items.map((x) =>
      h("li", {}, link(x.t, { class: "ticker-with-logo" }, logo(x.t, "xs"), h("span", { class: "tk", text: x.t })), h("span", { text: x.text }), chip(S.by[x.t].score, false))))
      : h("p", { class: "empty", text: "No disagreements right now: price action and ratings point the same way for every company." }));
}

// Column headers only; tooltips and the rest of the site use the full names.
const SHORT = {
  demand_weakness: "Demand", guidance_cut: "Guidance cut", liquidity_debt: "Liquidity / debt", margin_pressure: "Margin",
  inventory_buildup: "Inventory", restructuring_layoffs: "Restructuring", customer_concentration: "Customers",
  pricing_pressure: "Pricing", regulatory_legal: "Regulatory", export_controls_geopolitical: "Export controls",
  supply_chain: "Supply chain", impairment_writedown: "Impairment", accounting_controls: "Accounting", macro_fx: "Macro / FX",
};

function heatmapCard() {
  const m = S.method;
  const freq = {};
  for (const c of S.companies) for (const f of c.score?.qualitative?.flags ?? []) freq[f.category] = (freq[f.category] || 0) + 1;
  // Categories only one company raised fold into "Other" so the grid stays readable.
  const main = Object.keys(freq).filter((k) => freq[k] > 1 && k !== "other").sort((a, b) => freq[b] - freq[a] || a.localeCompare(b));
  const folded = Object.keys(freq).filter((k) => !main.includes(k));
  const cols = folded.length ? [...main, "__other"] : main;
  const rows = S.ranked.filter((c) => (c.score?.qualitative?.flags ?? []).length);
  const level = (n) => (n >= 5 ? 4 : n >= 3 ? 3 : n === 2 ? 2 : 1);

  const grid = h("div", { class: "hm", style: { gridTemplateColumns: `max-content repeat(${cols.length}, minmax(60px, 1fr))` } }, h("div"));
  for (const k of cols) grid.append(h("div", { class: "hdr", title: k === "__other" ? null : flagName(k), text: k === "__other" ? "Other" : SHORT[k] ?? flagName(k) }));
  for (const c of rows) {
    const flags = Object.fromEntries(c.score.qualitative.flags.map((f) => [f.category, f.consecutive_filings]));
    grid.append(h("div", { class: "row-h" }, link(c.ticker, { class: "tk" }, c.ticker), chip(c.score, false)));
    for (const k of cols) {
      const cats = k === "__other" ? folded.filter((f) => flags[f]) : flags[k] ? [k] : [];
      if (!cats.length) { grid.append(h("div", { class: "cell" })); continue; }
      const n = Math.max(...cats.map((f) => flags[f]));
      const L = level(n);
      const cell = h("div", { class: "cell", style: { background: `var(--h${L})`, color: `var(--h${L}-t)` }, text: n });
      cell.addEventListener("pointermove", (ev) => showTip([h("div", { class: "t", text: `${c.ticker} · ${cats.map(flagName).join(", ")}` }),
        ...cats.map((f) => h("div", { class: "note", text: flags[f] === 1 ? `${flagName(f)}: raised in the latest filing only.` : `${flagName(f)}: raised in ${flags[f]} consecutive filings.` }))],
      ev.clientX, ev.clientY));
      cell.addEventListener("pointerleave", hideTip);
      grid.append(cell);
    }
  }
  const cost = m.red_flag_cost;
  return card("Red flags that keep coming back",
    `Each cell counts consecutive 10-Q and 10-K filings that raised the flag. A flag costs more the longer it persists: ${cost["1"]} points when new, ${cost["2"]} on its second filing, ${m.red_flag_cost_persistent} from the third on.`,
    h("div", { class: "hm-scroll" }, grid),
    h("div", { class: "hm-legend" }, h("span", { text: "Consecutive filings:" }),
      [["1", 1], ["2", 2], ["3–4", 3], ["5 or more", 4]].map(([lb, L]) => h("span", {}, h("i", { style: { background: `var(--h${L})` } }), lb)),
      folded.length ? h("span", { class: "muted", text: `Other: ${folded.map(flagName).join(", ")}` }) : null));
}

function changesCard() {
  const changes = S.companies.map((c) => {
    const hist = c.rating_history ?? [];
    if (hist.length < 2) return null;
    const a = hist[hist.length - 2], b = hist[hist.length - 1];
    return a.rating !== b.rating ? { c, a, b } : null;
  }).filter(Boolean).sort((x, y) => y.b.at.localeCompare(x.b.at));
  return card("Rating changes", "The most recent band move for each company that has changed rating.",
    changes.length ? h("div", {}, changes.map(({ c, a, b }) => h("div", { class: "change-row" },
      link(c.ticker, { class: "tk" }, c.ticker),
      h("div", {}, h("span", { class: `chip ${a.rating}`, text: a.rating }), h("span", { class: "arrow", text: "→" }), h("span", { class: `chip ${b.rating}`, text: b.rating })),
      h("div", { class: "small muted num", style: { textAlign: "right" } }, `${a.composite.toFixed(1)} → ${b.composite.toFixed(1)}`, h("br"), dshort(b.at)))))
      : h("p", { class: "empty", text: "No company has changed band yet." }));
}

function watchCard() {
  const watched = S.ranked.filter((c) => S.watch.has(c.ticker));
  return card("Your watchlist", "Star companies in the screener or on their page. Saved in this browser only.",
    watched.length ? h("div", { class: "list" }, watched.map((c) => {
      const p = S.px[c.ticker];
      return link(c.ticker, { class: "li watch-row" }, logo(c.ticker), h("span", {}, h("b", { class: "tk", text: c.ticker }), ` · ${c.name} `, chip(c.score)),
        h("span", { class: `num ${dirc(p?.change_1d)}`, text: pct(p?.change_1d, 2, true) }));
    })) : h("p", { class: "empty", text: "Nothing starred yet." }));
}

export function viewOverview() {
  return h("div", { class: "view-in stack" },
    hero(), h("div", { class: "landscape-grid" }, scoreMapCard(), leadersCard()),
    h("div", { class: "grid-2" }, moversCard(), tensionCard()),
    heatmapCard(),
    h("div", { class: "grid-2" }, changesCard(), watchCard()));
}
