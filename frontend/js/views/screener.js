import { S, bands, counts, navigate, starButton } from "../state.js";
import { chip, dirc, dshort, fx, h, link, pct, ratingColor, usd } from "../lib.js";
import { identity } from "../identity.js";
import { sparkline } from "../charts.js";

const COLS = [
  { k: "star", label: "", l: true },
  { k: "co", label: "Company", l: true, v: (c) => c.ticker },
  { k: "score", label: "Composite", v: (c) => c.score?.composite },
  { k: "quant", label: "Quant", v: (c) => c.score?.quant.score },
  { k: "qual", label: "Qualitative", v: (c) => c.score?.qualitative?.score },
  { k: "price", label: "Last close", v: (c) => S.px[c.ticker]?.close },
  { k: "d1", label: "1D change", v: (c) => S.px[c.ticker]?.change_1d },
  { k: "trend", label: "60-day trend" },
  { k: "rev", label: "Revenue YoY", v: (c) => c.fundamentals?.latest.revenue_yoy },
  { k: "mgn", label: "Net margin", v: (c) => c.fundamentals?.latest.net_margin },
  { k: "de", label: "Debt / equity", v: (c) => c.score?.quant.negative_equity ? null : c.fundamentals?.latest.debt_to_equity },
];
const VIEWS = {
  overview: ["star", "co", "score", "price", "d1", "trend", "quant", "qual"],
  fundamentals: ["star", "co", "score", "rev", "mgn", "de", "quant", "qual"],
};

export function viewScreener() {
  const st = S.screener;
  st.view ??= "overview";
  const n = counts(), { buy, hold } = bands();
  const sectors = [...new Set(S.companies.map((c) => c.sub_sector))].sort();
  const q = h("input", { id: "screener-q", type: "search", placeholder: "Search company or ticker…", value: st.q, "aria-label": "Filter companies" });
  const sector = h("select", { id: "screener-sector", "aria-label": "Sector" },
    h("option", { value: "", text: "All subsectors" }), sectors.map((x) => h("option", { value: x, text: x, selected: x === st.sector })));
  const ratingSeg = h("div", { class: "seg", role: "group", "aria-label": "Rating" });
  const viewSeg = h("div", { class: "seg", role: "group", "aria-label": "Table view" });
  const watchBtn = h("button", { type: "button", class: "toggle", "aria-pressed": String(st.watch), text: "☆ Watchlist" });
  const countEl = h("span", { class: "count", "aria-live": "polite" });
  const table = h("table", { class: "tbl rows", "aria-label": "Technology company screener" });
  let currentRows = [];

  function paintSeg() {
    ratingSeg.replaceChildren(...[["", "All", S.companies.length], ["Buy", "Buy", n.Buy], ["Hold", "Hold", n.Hold], ["Avoid", "Avoid", n.Avoid]].map(([k, lb, cnt]) =>
      h("button", { type: "button", "aria-pressed": String(st.rating === k), onclick: () => { st.rating = k; paintSeg(); paint(); } }, lb, h("span", { class: "cnt", text: cnt }))));
    viewSeg.replaceChildren(...[["overview", "Overview"], ["fundamentals", "Fundamentals"]].map(([k, label]) =>
      h("button", { type: "button", text: label, "aria-pressed": String(st.view === k), onclick: () => {
        st.view = k;
        if (!VIEWS[k].includes(st.sort)) { st.sort = "score"; st.dir = -1; }
        paintSeg(); paint();
      } })));
  }
  q.addEventListener("input", () => { st.q = q.value; paint(); });
  sector.addEventListener("change", () => { st.sector = sector.value; paint(); });
  watchBtn.addEventListener("click", () => { st.watch = !st.watch; watchBtn.setAttribute("aria-pressed", String(st.watch)); paint(); });

  function cell(c, key) {
    const p = S.px[c.ticker], f = c.fundamentals?.latest, sc = c.score;
    switch (key) {
      case "star": return h("td", { class: "l", style: { paddingRight: 0, width: "30px" } }, starButton(c.ticker, () => st.watch && paint()));
      case "co": return h("td", { class: "l" }, link(c.ticker, { class: "company-link" }, identity(c)));
      case "score": return h("td", {}, h("div", { class: "scorecell" },
        h("span", { class: "sbar", "aria-hidden": "true" },
          h("span", { style: { width: `${sc?.composite ?? 0}%`, background: ratingColor(sc?.rating) } }),
          h("i", { style: { left: `${hold}%` } }), h("i", { style: { left: `${buy}%` } })), chip(sc)));
      case "quant": return h("td", { text: fx(sc?.quant.score, 1) });
      case "qual": return h("td", { text: fx(sc?.qualitative?.score, 1) });
      case "price": return h("td", { text: usd(p?.close) });
      case "d1": return h("td", { class: dirc(p?.change_1d), text: pct(p?.change_1d, 1, true) });
      case "trend": return h("td", { class: "trend-cell" }, p?.closes?.length ? sparkline(p.closes) : "–");
      case "rev": return h("td", { class: dirc(f?.revenue_yoy), text: pct(f?.revenue_yoy, 1, true) });
      case "mgn": return h("td", { text: pct(f?.net_margin, 1) });
      case "de": return h("td", { text: sc?.quant.negative_equity ? "n/a" : fx(f?.debt_to_equity) });
    }
  }

  function paint() {
    const needle = st.q.trim().toLowerCase();
    const col = COLS.find((c) => c.k === st.sort && c.v) || COLS[2];
    const columns = VIEWS[st.view].map((k) => COLS.find((c) => c.k === k));
    currentRows = S.companies
      .filter((c) => (!st.rating || c.score?.rating === st.rating) && (!st.sector || c.sub_sector === st.sector) &&
        (!st.watch || S.watch.has(c.ticker)) && (!needle || `${c.ticker} ${c.name} ${c.sub_sector}`.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const va = col.v(a), vb = col.v(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * st.dir;
      });
    countEl.textContent = `${currentRows.length} / ${S.companies.length} companies`;
    exportBtn.disabled = !currentRows.length;
    const head = h("tr", {}, columns.map((c) => {
      if (!c.v) return h("th", { class: c.l ? "l" : null, scope: "col" }, h("span", { text: c.label, "aria-label": c.k === "star" ? "Watchlist" : null }));
      const th = h("th", { class: c.l ? "l" : null, scope: "col", "aria-sort": st.sort === c.k ? (st.dir > 0 ? "ascending" : "descending") : "none" });
      th.append(h("button", { type: "button", text: c.label, onclick: () => {
        if (st.sort === c.k) st.dir = -st.dir; else { st.sort = c.k; st.dir = c.k === "co" ? 1 : -1; }
        paint(); table.querySelector('th[aria-sort="ascending"] button, th[aria-sort="descending"] button')?.focus();
      } }));
      return th;
    }));
    table.replaceChildren(h("thead", {}, head), h("tbody", {}, currentRows.length
      ? currentRows.map((c) => h("tr", { onclick: (e) => { if (!e.target.closest("a,button")) navigate(c.ticker); } }, columns.map((col) => cell(c, col.k))))
      : h("tr", {}, h("td", { colspan: columns.length, class: "l muted", text: "No companies match. Try another filter or add companies to your watchlist." }))));
  }

  const exportBtn = h("button", { class: "btn", type: "button", text: "Export CSV ↓", onclick: () => {
    const clean = (value) => {
      let text = String(value ?? "");
      if (/^[=+@\-]/.test(text) && typeof value !== "number") text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    const header = ["Ticker", "Company", "Subsector", "Rating", "Composite", "Quant", "Qualitative", "Close", "Price date", "1D change (fraction)", "Revenue YoY (fraction)", "Net margin (fraction)", "Debt/equity", "Quarter end", "Score updated"];
    const data = currentRows.map((c) => {
      const f = c.fundamentals?.latest, sc = c.score, p = S.px[c.ticker];
      return [c.ticker, c.name, c.sub_sector, sc?.rating, sc?.composite, sc?.quant.score, sc?.qualitative?.score,
        p?.close, p?.date, p?.change_1d, f?.revenue_yoy, f?.net_margin, sc?.quant.negative_equity ? null : f?.debt_to_equity, f?.period_end, sc?.scored_at];
    });
    const csv = [header, ...data].map((row) => row.map(clean).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" }));
    const a = h("a", { href: url, download: "stratum.csv" });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  paintSeg(); paint();
  return h("div", { class: "view-in stack" },
    h("div", { class: "screener-header" }, h("div", {}, h("p", { class: "eyebrow", text: "THE COVERAGE / COMPANY SCREENER" }),
      h("h1", { class: "page-title", text: "Company screener." }),
      h("p", { text: "A clearer view of the companies behind the numbers." })),
      h("div", { class: "screener-actions" }, exportBtn, link("compare", { class: "btn btn-primary" }, "Compare companies ↗"))),
    h("section", { class: "card screener-card" },
      h("div", { class: "toolbar" }, h("label", { class: "field" }, q), ratingSeg, h("label", { class: "field" }, sector), watchBtn),
      h("div", { class: "view-switch" }, viewSeg, countEl),
      h("div", { class: "tscroll", tabindex: "0", role: "region", "aria-label": "Company results; scroll horizontally for more columns" }, table),
      h("div", { class: "table-caption" },
        h("p", { class: "note", text: `Score thresholds: Hold ${hold} · Buy ${buy}. Prices do not affect the score.` }),
        h("p", { class: "note", text: S.prices?.market_date ? `Prices as of ${dshort(S.prices.market_date)} close` : "Price data unavailable" }))));
}

