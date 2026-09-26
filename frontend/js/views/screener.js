import { S, bands, counts, navigate, starButton } from "../state.js";
import { chip, dirc, fx, h, link, pct, ratingColor, usd } from "../lib.js";
import { sparkline } from "../charts.js";

const COLS = [
  { k: "star", label: "", l: true },
  { k: "co", label: "Company", l: true, v: (c) => c.ticker },
  { k: "score", label: "Score", v: (c) => c.score?.composite },
  { k: "quant", label: "Quant", v: (c) => c.score?.quant.score },
  { k: "qual", label: "Qual.", v: (c) => c.score?.qualitative?.score },
  { k: "price", label: "Price", v: (c) => S.px[c.ticker]?.close },
  { k: "d1", label: "1D", v: (c) => S.px[c.ticker]?.change_1d },
  { k: "trend", label: "60-day trend" },
  { k: "rev", label: "Rev. YoY", v: (c) => c.fundamentals?.latest.revenue_yoy },
  { k: "mgn", label: "Net margin", v: (c) => c.fundamentals?.latest.net_margin },
  { k: "de", label: "Debt/equity", v: (c) => c.fundamentals?.latest.debt_to_equity },
];

export function viewScreener() {
  const st = S.screener;
  const n = counts();
  const { buy, hold } = bands();
  const sectors = [...new Set(S.companies.map((c) => c.sub_sector))].sort();
  const q = h("input", { id: "screener-q", type: "search", placeholder: "Filter by ticker, name or sector", value: st.q, "aria-label": "Filter companies" });
  const sector = h("select", { id: "screener-sector", "aria-label": "Sector" },
    h("option", { value: "", text: "All sectors" }), sectors.map((x) => h("option", { value: x, text: x, selected: x === st.sector })));
  const ratingSeg = h("div", { class: "seg", role: "group", "aria-label": "Rating" });
  const watchBtn = h("button", { type: "button", class: "toggle", "aria-pressed": String(st.watch), text: "★ Watchlist only" });
  const countEl = h("span", { class: "count" });
  const table = h("table", { class: "tbl rows" });

  function paintSeg() {
    ratingSeg.replaceChildren(...[["", "All", S.companies.length], ["Buy", "Buy", n.Buy], ["Hold", "Hold", n.Hold], ["Avoid", "Avoid", n.Avoid]].map(([k, lb, cnt]) =>
      h("button", { type: "button", "aria-pressed": String(st.rating === k), onclick: () => { st.rating = k; paintSeg(); paint(); } }, lb, h("span", { class: "cnt", text: cnt }))));
  }
  q.addEventListener("input", () => { st.q = q.value; paint(); });
  sector.addEventListener("change", () => { st.sector = sector.value; paint(); });
  watchBtn.addEventListener("click", () => { st.watch = !st.watch; watchBtn.setAttribute("aria-pressed", String(st.watch)); paint(); });

  function paint() {
    const needle = st.q.trim().toLowerCase();
    const col = COLS.find((c) => c.k === st.sort);
    const rows = S.companies
      .filter((c) => (!st.rating || c.score?.rating === st.rating) && (!st.sector || c.sub_sector === st.sector) &&
        (!st.watch || S.watch.has(c.ticker)) && (!needle || `${c.ticker} ${c.name} ${c.sub_sector}`.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const va = col.v(a), vb = col.v(b);
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * st.dir;
      });
    countEl.textContent = `${rows.length} of ${S.companies.length} companies`;

    const head = h("tr", {}, COLS.map((c) => {
      if (!c.v) return h("th", { class: c.l ? "l" : null, scope: "col" }, h("span", { text: c.label }));
      const th = h("th", { class: c.l ? "l" : null, scope: "col", "aria-sort": st.sort === c.k ? (st.dir > 0 ? "ascending" : "descending") : "none" });
      th.append(h("button", { type: "button", text: c.label, onclick: () => {
        if (st.sort === c.k) st.dir = -st.dir; else { st.sort = c.k; st.dir = c.k === "co" ? 1 : -1; }
        paint();
        table.querySelector('th[aria-sort="ascending"] button, th[aria-sort="descending"] button')?.focus();
      } }));
      return th;
    }));

    const body = rows.map((c) => {
      const p = S.px[c.ticker], f = c.fundamentals?.latest, sc = c.score;
      return h("tr", { onclick: () => navigate(c.ticker) },
        h("td", { class: "l", style: { paddingRight: 0, width: "30px" } }, starButton(c.ticker, () => st.watch && paint())),
        h("td", { class: "l" }, h("div", { class: "co" }, link(c.ticker, { class: "tk" }, c.ticker), h("span", { class: "nm", text: `${c.name} · ${c.sub_sector}` }))),
        h("td", {}, h("div", { class: "scorecell" },
          h("span", { class: "sbar", "aria-hidden": "true" },
            h("span", { style: { width: `${sc?.composite ?? 0}%`, background: ratingColor(sc?.rating) } }),
            h("i", { style: { left: `${hold}%` } }), h("i", { style: { left: `${buy}%` } })),
          chip(sc))),
        h("td", { text: fx(sc?.quant.score, 1) }),
        h("td", { text: fx(sc?.qualitative?.score, 1) }),
        h("td", { text: usd(p?.close) }),
        h("td", { class: dirc(p?.change_1d), text: pct(p?.change_1d, 1, true) }),
        h("td", {}, p?.closes?.length ? h("span", { style: { display: "inline-block" } }, sparkline(p.closes)) : "–"),
        h("td", { class: dirc(f?.revenue_yoy), text: pct(f?.revenue_yoy, 0, true) }),
        h("td", { text: pct(f?.net_margin, 0) }),
        h("td", { text: sc?.quant.negative_equity ? "n/a" : fx(f?.debt_to_equity) }));
    });
    table.replaceChildren(h("thead", {}, head),
      h("tbody", {}, body.length ? body : h("tr", {}, h("td", { colspan: COLS.length, class: "l muted", text: "No companies match these filters." }))));
  }

  paintSeg();
  paint();
  return h("div", { class: "view-in stack" },
    h("div", { style: { display: "grid", gap: "6px" } }, h("p", { class: "eyebrow", text: "Screener" }), h("h1", { class: "page-title", text: `All ${S.companies.length} companies` })),
    h("section", { class: "card" },
      h("div", { class: "toolbar" }, h("label", { class: "field" }, q), ratingSeg, h("label", { class: "field" }, sector), watchBtn, countEl),
      h("div", { class: "tscroll" }, table),
      h("p", { class: "note", text: `Score bars mark the ${hold} and ${buy} band edges. Price columns are context only and never part of the score. Click a row for the full company page.` })));
}
