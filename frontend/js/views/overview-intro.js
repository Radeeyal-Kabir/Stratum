import { S, bands, counts } from "../state.js";
import { chip, dirc, dshort, fx, h, isNum, link, pct, secLink } from "../lib.js";
import { identity, logo } from "../identity.js";
import { scoreMap, sparkline } from "../charts.js";

const latestAnalyzed = (c) => (c.qualitative?.filings ?? []).filter((f) => f.status === "ok")
  .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];

function filingFocus() {
  const latest = S.companies.map((c) => ({ c, f: latestAnalyzed(c) })).filter(({ f }) => f)
    .sort((a, b) => (b.f.filed ?? "").localeCompare(a.f.filed ?? "") || a.c.ticker.localeCompare(b.c.ticker))[0];
  if (!latest) return h("aside", { class: "filing-focus" }, h("p", { class: "eyebrow", text: "FILING FOCUS" }),
    h("h2", { text: "The next filing tells the next chapter." }), h("p", { text: "Analysis will appear here when a filing is available." }));
  const { c, f } = latest;
  const rationale = f.tone_rationale || "Explore management's latest discussion and the underlying filing evidence.";
  const quote = f.red_flags?.find((flag) => flag.quote)?.quote;
  const excerpt = quote && (quote.length > 210 ? quote.slice(0, 210).replace(/\s+\S*$/, "") + "…" : quote);
  const fact = (label, value) => h("div", {}, h("span", { text: label }), h("strong", { text: value }));
  return h("aside", { class: "filing-focus", "aria-label": "Latest analyzed filing" },
    h("div", { class: "focus-top" }, h("p", { class: "eyebrow", text: "FILING FOCUS" }), h("span", { text: dshort(f.filed) })),
    link(c.ticker, { class: "focus-company" }, logo(c.ticker), h("span", {}, h("strong", { text: c.name }), h("small", { text: c.ticker + " / " + f.form }))),
    h("div", { class: "focus-narrative" }, h("p", { class: "eyebrow", text: "MANAGEMENT READ-THROUGH" }),
      h("h2", { text: rationale.charAt(0).toUpperCase() + rationale.slice(1) + (/[.!?]$/.test(rationale) ? "" : ".") })),
    excerpt ? h("div", { class: "focus-evidence" }, h("p", { class: "eyebrow", text: "FROM THE FILING" }), h("blockquote", { text: "“" + excerpt + "”" })) : null,
    h("div", { class: "focus-facts" }, fact("Filing", f.form), fact("Model tone", f.tone || "Unavailable"), fact("Period ended", dshort(f.period_end))),
    h("div", { class: "focus-links" }, link(c.ticker, { class: "focus-cta" }, "Explore company", h("span", { "aria-hidden": "true", text: "↗" })), secLink(f.source_url, "Read filing")),
    h("p", { class: "focus-disclosure", text: "Model interpretation · Check the linked SEC evidence." }));
}

export function overviewIntro() {
  const n = counts();
  const scores = S.ranked.map((c) => c.score?.composite).filter(isNum).sort((a, b) => a - b);
  const median = scores.length ? (scores[(scores.length - 1) >> 1] + scores[scores.length >> 1]) / 2 : null;
  const { buy, hold } = bands();
  const chart = h("div", { class: "chart" });
  scoreMap(chart);
  const stat = (label, value, cls = "") => h("div", { class: "hero-stat " + cls }, h("strong", { text: value }), h("span", { text: label }));
  return h("section", { class: "overview-intro" },
    h("div", { class: "edition-line" }, h("p", { class: "eyebrow", text: "STRATUM / S&P 500 TECHNOLOGY" }),
      h("span", { class: "edition-date", text: S.doc.as_of ? "As of " + dshort(S.doc.as_of) : "Awaiting data" })),
    h("div", { class: "studio-layout" },
      h("div", { class: "studio-main" },
        h("h1", {}, "Technology ", h("br"), "in focus", h("span", { class: "orange-dot", text: "." })),
        h("p", { class: "intro-copy", text: "A clearer view of the companies shaping technology. Explore the fundamentals, management signals, and evidence behind every score." }),
        h("div", { class: "hero-stats" }, stat("Companies", S.companies.length), stat("Median score", fx(median, 1)), stat("Buy", n.Buy, "stat-buy"), stat("Hold", n.Hold), stat("Avoid", n.Avoid)),
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

export function marketPulse() {
  const u = S.prices?.universe_avg ?? {};
  return h("section", { class: "market-pulse" },
    h("div", {}, h("p", { class: "section-kicker", text: "MARKET CONTEXT" }), h("h2", { text: "The price perspective." }), h("p", { text: "Equal-weight returns across the coverage." })),
    [["Latest close", u.change_1d], ["This week", u.change_5d], ["Three months", u.return_3m]].map(([label, value]) =>
      h("div", { class: "pulse-stat" }, h("span", { text: label }), h("strong", { class: dirc(value), text: pct(value, 1, true) }))));
}

