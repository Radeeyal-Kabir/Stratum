import { S, bands, counts, rankOf } from "../state.js";
import { chip, dirc, dshort, flagName, fx, h, isNum, link, pct, secLink } from "../lib.js";
import { identity, logo } from "../identity.js";
import { scoreMap, sparkline } from "../charts.js";

const latestAnalyzed = (c) => (c.qualitative?.filings ?? []).filter((f) => f.status === "ok")
  .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];

/** What the company looks like today, so the card is a briefing and not just a quote. */
function snapshot(c) {
  const p = S.px[c.ticker], rev = c.fundamentals?.latest.revenue_yoy;
  const cell = (label, ...body) => h("div", {}, h("span", { text: label }), ...body);
  return [
    cell("Composite", h("strong", { text: fx(c.score?.composite, 1) }), h("small", { text: `${c.score?.rating ?? "–"} · #${rankOf(c.ticker)} of ${S.companies.length}` })),
    cell("Revenue YoY", h("strong", { class: dirc(rev), text: pct(rev, 1, true) }), h("small", { text: c.sub_sector ?? "" })),
    cell("60-day price", p?.closes?.length > 1 ? sparkline(p.closes, { w: 110, hgt: 30 }) : h("strong", { text: "–" }), h("small", { class: dirc(p?.return_3m), text: p ? `${pct(p.return_3m, 1, true)} over 3 months` : "" })),
  ];
}

function filingFocus() {
  const latest = S.companies.map((c) => ({ c, f: latestAnalyzed(c) })).filter(({ f }) => f)
    .sort((a, b) => (b.f.filed ?? "").localeCompare(a.f.filed ?? "") || a.c.ticker.localeCompare(b.c.ticker))[0];
  if (!latest) return h("aside", { class: "filing-focus" }, h("p", { class: "eyebrow", text: "FILING FOCUS" }),
    h("h2", { text: "The next filing tells the next chapter." }), h("p", { text: "Analysis will appear here when a filing is available." }));
  const { c, f } = latest;
  const rationale = f.tone_rationale || "Explore management's latest discussion and the underlying filing evidence.";
  const flag = f.red_flags?.find((x) => x.quote);
  const quote = flag?.quote;
  const excerpt = quote && (quote.length > 210 ? quote.slice(0, 210).replace(/\s+\S*$/, "") + "…" : quote);
  const fact = (label, value) => h("div", {}, h("span", { text: label }), h("strong", { text: value }));
  return h("aside", { class: "filing-focus", "aria-label": "Latest analyzed filing" },
    h("div", { class: "focus-top" }, h("p", { class: "eyebrow", text: "FILING FOCUS" }), h("span", { text: dshort(f.filed) })),
    link(c.ticker, { class: "focus-company" }, logo(c.ticker), h("span", {}, h("strong", { text: c.name }), h("small", { text: c.ticker + " / " + f.form }))),
    h("div", { class: "focus-narrative" }, h("p", { class: "eyebrow", text: "MANAGEMENT READ-THROUGH" }),
      h("h2", { text: rationale.charAt(0).toUpperCase() + rationale.slice(1) + (/[.!?]$/.test(rationale) ? "" : ".") })),
    excerpt ? h("div", { class: "focus-evidence" }, h("p", { class: "eyebrow", text: `RISK FLAGGED IN THIS FILING · ${flagName(flag.category).toUpperCase()}` }), h("blockquote", { text: "“" + excerpt + "”" })) : null,
    h("div", { class: "focus-snap" }, snapshot(c)),
    h("div", { class: "focus-facts" }, fact("Filing", f.form), fact("Model tone", f.tone || "Unavailable"), fact("Period ended", dshort(f.period_end))),
    h("div", { class: "focus-links" }, link(c.ticker, { class: "focus-cta" }, "Explore company", h("span", { "aria-hidden": "true", text: "↗" })), secLink(f.source_url, "Read filing"), quote ? secLink(f.source_url, "See the quote", quote) : null),
    h("p", { class: "focus-disclosure", text: "Model interpretation · Check the linked SEC evidence." }));
}

export function overviewIntro() {
  const n = counts();
  const scores = S.ranked.map((c) => c.score?.composite).filter(isNum).sort((a, b) => a - b);
  const median = scores.length ? (scores[(scores.length - 1) >> 1] + scores[scores.length >> 1]) / 2 : null;
  const { buy, hold } = bands();
  const chart = h("div", { class: "chart" });
  scoreMap(chart);
  const stat = (label, value, ...more) => h("div", { class: "hero-stat" }, h("span", { class: "hs-label", text: label }), h("strong", { text: value }), ...more);
  const total = Math.max(1, n.Buy + n.Hold + n.Avoid);
  const top = (r) => S.ranked.filter((c) => c.score?.rating === r).slice(0, 2).map((c) => c.ticker);
  const ratingStat = (r) => h("div", { class: "hero-stat rated " + r.toLowerCase(), title: `${n[r]} of ${total} rated ${r}` },
    h("span", { class: "hs-label" }, h("i", { "aria-hidden": "true" }), r),
    h("strong", { text: n[r] }),
    h("div", { class: "hs-bar", "aria-hidden": "true" }, h("span", { style: { width: Math.round(100 * n[r] / total) + "%" } })),
    h("span", { class: "hs-share", text: n[r] ? `${Math.round(100 * n[r] / total)}% · ${top(r).join(", ")}${n[r] > 2 ? " …" : ""}` : "None right now" }));
  const scale = isNum(median) ? h("div", { class: "hs-scale", "aria-hidden": "true" },
    h("i", { class: "avoid", style: { width: hold + "%" } }), h("i", { class: "hold", style: { width: (buy - hold) + "%" } }), h("i", { class: "buy", style: { width: (100 - buy) + "%" } }),
    h("b", { style: { left: Math.min(100, Math.max(0, median)) + "%" } })) : null;
  return h("section", { class: "overview-intro" },
    h("div", { class: "studio-layout" },
      h("div", { class: "studio-main" },
        h("h1", {}, "Technology ", h("br"), "in focus", h("span", { class: "orange-dot", text: "." })),
        h("p", { class: "intro-copy", text: `A clearer view of the ${S.companies.length} S&P 500 technology companies shaping the sector. Explore the fundamentals, management signals, and evidence behind every score.` }),
        h("p", { class: "intro-asof", text: S.doc.as_of ? `Data as of ${dshort(S.doc.as_of)}` : "Awaiting data" }),
        h("div", { class: "hero-stats-wrap" }, h("div", { class: "hero-stats" }, stat("Companies", S.companies.length, h("span", { class: "hs-share", text: `${new Set(S.companies.map((c) => c.sub_sector)).size} subsectors` })), stat("Median score", fx(median, 1), scale, h("span", { class: "hs-share", text: `Buy ≥ ${buy}` })), ratingStat("Buy"), ratingStat("Hold"), ratingStat("Avoid"))),
        h("section", { class: "signal-landscape" },
          h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Where the signals meet" }), h("p", { text: "Financial strength meets management language." })),
            h("div", { class: "legend" }, ["Buy", "Hold", "Avoid"].map((r) => h("span", {}, h("i", { style: { "--k": "var(--" + r.toLowerCase() + ")" } }), r)))), chart,
          h("div", { class: "map-foot" }, h("span", { text: "Buy ≥ " + buy + " · Hold ≥ " + hold + " · Select a company to explore" }), link("method", {}, "How scores work ↗")))),
      filingFocus()));
}

export function coverageTable() {
  const heads = ["#", "Company", "Subsector", "Composite", "60-day price trend", "Revenue YoY", "Analyzed filing", ""];
  return h("section", { class: "coverage-section" },
    h("div", { class: "section-heading" }, h("div", {}, h("p", { class: "section-kicker", text: "THE COVERAGE" }),
      h("h2", { text: "Start with the strongest signals." }), h("p", { text: "The six highest composite scores in the group. A starting point for deeper research." })),
      link("screener", { class: "btn btn-primary" }, "All " + S.companies.length + " companies", h("span", { "aria-hidden": "true", text: "↗" }))),
    h("div", { class: "coverage-scroll", role: "region", "aria-label": "Leading companies, scroll for more columns", tabindex: "0" },
      h("table", { class: "tbl coverage-table", "aria-label": "Highest composite scores" },
        h("thead", {}, h("tr", {}, heads.map((text, i) => h("th", { scope: "col", class: i < 3 ? "l" : "" }, h("span", { text }))))),
        h("tbody", {}, S.ranked.slice(0, 6).map((c, i) => {
          const p = S.px[c.ticker], f = latestAnalyzed(c);
          return h("tr", {}, h("td", { class: "l rank-no", text: String(i + 1).padStart(2, "0") }),
            h("td", { class: "l" }, link(c.ticker, { class: "company-link" }, identity(c))),
            h("td", { class: "l coverage-sector", text: c.sub_sector }), h("td", {}, chip(c.score)),
            h("td", { class: "trend-cell" }, p?.closes?.length > 1 ? sparkline(p.closes, { w: 112, hgt: 30 }) : "–"),
            h("td", { class: dirc(c.fundamentals?.latest.revenue_yoy), text: pct(c.fundamentals?.latest.revenue_yoy, 1, true) }),
            h("td", { class: "coverage-filed", text: f ? dshort(f.filed) : "–" }),
            h("td", {}, link(c.ticker, { class: "row-open", "aria-label": "Explore " + c.name }, "↗")));
        })))),
    h("div", { class: "coverage-foot" }, h("span", { text: "Scores use SEC fundamentals and filing language. Price is shown separately." }),
      h("span", { text: S.prices?.market_date ? "Prices: " + dshort(S.prices.market_date) : "Prices unavailable" })));
}

/** Equal-weight index of the coverage, each stock rebased to 100 at the start of the window. */
function universeIndex() {
  const series = (S.prices?.prices ?? []).map((p) => p.closes).filter((cl) => cl?.length > 1);
  const len = Math.min(...series.map((cl) => cl.length));
  if (!series.length || len < 3) return [];
  // Aligned from the latest close backwards, so a stock missing early days doesn't skew the start.
  return Array.from({ length: len }, (_, i) => series.reduce((sum, cl) => sum + 100 * cl[cl.length - len + i] / cl[cl.length - len], 0) / series.length);
}

export function marketPulse() {
  const u = S.prices?.universe_avg ?? {};
  const rows = (S.prices?.prices ?? []).filter((p) => isNum(p.change_1d));
  const extremes = (key) => {
    const v = rows.filter((p) => isNum(p[key])).sort((a, b) => b[key] - a[key]);
    return v.length ? [v[0], v.at(-1)] : [];
  };
  const tile = (label, value, key) => {
    const [best, worst] = extremes(key);
    return h("div", { class: "pulse-stat" }, h("span", { text: label }),
      h("strong", { class: dirc(value) }, isNum(value) ? h("i", { "aria-hidden": "true", text: value > 0 ? "▲" : value < 0 ? "▼" : "–" }) : null, pct(value, 1, true)),
      best ? h("div", { class: "pulse-ex" },
        h("span", {}, "Best ", link(best.ticker, {}, best.ticker), h("em", { class: dirc(best[key]), text: " " + pct(best[key], 1, true) })),
        h("span", {}, "Worst ", link(worst.ticker, {}, worst.ticker), h("em", { class: dirc(worst[key]), text: " " + pct(worst[key], 1, true) }))) : null);
  };
  const idx = universeIndex();
  return h("section", { class: "market-pulse" },
    h("div", { class: "pulse-head" }, h("p", { class: "section-kicker", text: "MARKET CONTEXT" }), h("h2", { text: "The price perspective." }), h("p", { text: "Equal-weight returns across the coverage. Price never enters the score." }),
      idx.length > 2 ? h("div", { class: "pulse-trend" }, sparkline(idx, { w: 200, hgt: 40 }), h("span", { text: "Equal-weight index, 60 trading days" })) : null),
    h("div", { class: "pulse-grid" }, tile("Latest close", u.change_1d, "change_1d"), tile("This week", u.change_5d, "change_5d"), tile("Three months", u.return_3m, "return_3m")));
}
