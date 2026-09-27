import { S } from "../state.js";
import { PART_LABEL, chip, dshort, fx, h, isNum, link, mday, pct, signed, store, usd } from "../lib.js";
import { logo } from "../identity.js";
import { lineChart } from "../charts.js";
import { cashMetrics, sbcIsCost } from "../cashflow.js";

// Three fixed slots: a company keeps its color while the others are swapped.
const SLOT = ["var(--s1)", "var(--s2)", "var(--s3)"];

function slots() {
  if (!Array.isArray(S.compare) || S.compare.length !== 3 || !S.compare.some((t) => t && S.by[t])) {
    const holds = S.ranked.filter((c) => c.score?.rating === "Hold");
    S.compare = [S.ranked[0]?.ticker, holds[holds.length >> 1]?.ticker ?? S.ranked[1]?.ticker, S.ranked[S.ranked.length - 1]?.ticker];
  }
  S.compare = S.compare.map((t) => (t && S.by[t] ? t : null));
  return S.compare;
}

export function addToCompare(t) {
  const sl = slots();
  if (sl.includes(t)) return;
  const free = sl.indexOf(null);
  sl[free === -1 ? sl.length - 1 : free] = t;
  store.set("compare", sl);
}

function rowsDef() {
  const q = (k) => (x) => x.c.score?.quant.parts[k];
  const l = (k) => (x) => x.c.score?.qualitative?.parts[k];
  const part = (lb, get) => [lb, get, (v) => fx(v, 0), true, true];
  return [
    ["Score"],
    ["Composite", (x) => x.c.score?.composite, (v) => fx(v, 1), true, true],
    ["Rating", (x) => x.c.score, "chip"],
    ["Quant score", (x) => x.c.score?.quant.score, (v) => fx(v, 1), true, true],
    ["Qualitative score", (x) => x.c.score?.qualitative?.score, (v) => fx(v, 1), true, true],
    ...Object.keys(S.method.quant_weights).map((k) => part(PART_LABEL[k], q(k))),
    ...Object.keys(S.method.qual_weights).map((k) => part(PART_LABEL[k], l(k))),
    ["Fundamentals"],
    ["Revenue growth YoY", (x) => x.c.fundamentals?.latest.revenue_yoy, (v) => pct(v, 1, true), true],
    ["Net margin", (x) => x.c.fundamentals?.latest.net_margin, (v) => pct(v, 1), true],
    ["Debt / equity", (x) => x.c.fundamentals?.latest.debt_to_equity, (v) => fx(v), false],
    ["Current ratio", (x) => x.c.fundamentals?.latest.current_ratio, (v) => fx(v), true],
    ["Cash flow (TTM, context only)"],
    [sbcIsCost() ? "FCF margin after stock pay" : "FCF margin", (x) => cashMetrics(x.c)?.shownMargin, (v) => pct(v, 1), true],
    ["Stock pay / revenue", (x) => cashMetrics(x.c)?.sbc_pct_revenue, (v) => pct(v, 1), false],
    [sbcIsCost() ? "True yield" : "FCF yield", (x) => cashMetrics(x.c)?.shownYield, (v) => pct(v, 1), true],
    ["Latest quarter", (x) => x.c.fundamentals?.latest.period_end, (v) => (v ? dshort(v) : "–")],
    ["Price (context only)"],
    ["Close", (x) => x.p?.close, usd],
    ["60-day change", (x) => (x.p?.closes?.length ? x.p.closes[x.p.closes.length - 1] / x.p.closes[0] - 1 : null), (v) => pct(v, 1, true), true],
    ["3-month return", (x) => x.p?.return_3m, (v) => pct(v, 1, true), true],
    ["vs 200-day avg", (x) => x.p?.vs_sma200, (v) => pct(v, 1, true), true],
  ];
}

function leader(vals, higherIsBetter) {
  const nums = vals.filter(isNum);
  if (nums.length < 2) return -1;
  const b = higherIsBetter ? Math.max(...nums) : Math.min(...nums);
  return vals.filter((v) => v === b).length === 1 ? vals.indexOf(b) : -1;
}

export function viewCompare() {
  const wrap = h("div", { class: "view-in stack" });
  const paint = () => {
    const sl = slots();
    const sel = sl.map((t, i) => (t ? { c: S.by[t], p: S.px[t], color: SLOT[i] } : null)).filter(Boolean);

    const add = h("select", { id: "compare-add", "aria-label": "Add a company to compare", disabled: sel.length >= 3 },
      h("option", { value: "", text: sel.length >= 3 ? "Remove one to add another" : "Add a company…" }),
      S.ranked.filter((c) => !sl.includes(c.ticker)).map((c) => h("option", { value: c.ticker, text: `${c.ticker} · ${c.name}` })));
    add.addEventListener("change", () => { if (add.value) { addToCompare(add.value); paint(); } });
    const picker = h("div", { class: "picker" },
      sl.map((t, i) => (t ? h("span", { class: "pick" },
        logo(t, "xs"), link(t, { class: "tk", style: { color: "var(--ink)" } }, t),
        h("span", { class: "small muted", text: S.by[t].name }),
        h("button", { type: "button", "aria-label": `Remove ${t}`, text: "×", onclick: () => { S.compare[i] = null; store.set("compare", S.compare); paint(); } })) : null)),
      h("label", { class: "field" }, add));

    const priced = sel.filter((x) => x.p?.closes?.length);
    const chartEl = h("div", { class: "chart" });
    if (priced.length) {
      const longest = priced.reduce((a, b) => (b.p.closes.length > a.p.closes.length ? b : a));
      const dates = longest.p.dates;
      lineChart(chartEl, {
        series: priced.map((x) => {
          const base = x.p.closes[0];
          const idx = x.p.closes.map((v) => (v / base) * 100);
          return { label: x.c.ticker, color: x.color, values: idx, endText: `${x.c.ticker} ${signed(idx[idx.length - 1] - 100, 1)}%` };
        }),
        height: 300, endLabels: true, padR: 104, yFmt: (v) => v.toFixed(0),
        tipFmt: (v) => `${v.toFixed(1)} (${signed(v - 100, 1)}%)`,
        xLabels: dates.map(mday), tipTitle: (i) => `${dshort(dates[i])} close`,
      });
    }

    const table = h("table", { class: "tbl cmp" },
      h("thead", {}, h("tr", {}, h("th", { class: "l" }, h("span")),
        sel.map((x) => h("th", {}, h("span", { class: "hk" }, logo(x.c.ticker, "xs"), h("span", { class: "tk", text: x.c.ticker })))))),
      h("tbody", {}, rowsDef().map(([label, get, fmt, higherIsBetter, bar]) => {
        if (!get) return h("tr", { class: "grp" }, h("td", { colspan: sel.length + 1, text: label }));
        const vals = sel.map(get);
        if (fmt === "chip") return h("tr", {}, h("td", { class: "l ink2", text: label }), vals.map((v) => h("td", {}, chip(v, false))));
        const best = higherIsBetter === undefined ? -1 : leader(vals, higherIsBetter);
        return h("tr", {}, h("td", { class: "l ink2", text: label }), vals.map((v, i) => h("td", {},
          bar && isNum(v) ? h("span", { class: "minibar" }, h("span", { style: { width: `${v}%`, background: sel[i].color } })) : null,
          fmt(v), i === best ? h("span", { class: "best", text: "best" }) : null)));
      })));

    wrap.replaceChildren(
      h("div", { style: { display: "grid", gap: "6px" } }, h("p", { class: "eyebrow", text: "Compare" }), h("h1", { class: "page-title", text: "Side by side" })),
      h("section", { class: "card" }, h("div", { class: "card-head", style: { marginBottom: 0 } },
        h("div", {}, h("h2", { text: "Companies" }), h("p", { text: "Pick up to three. Each keeps its color while you swap the others." })), picker)),
      h("section", { class: "card" },
        h("div", { class: "card-head" },
          h("div", {}, h("h2", { text: "Price, indexed to 100" }),
            h("p", { text: priced.length ? `Each line starts at 100 on ${dshort(priced[0].p.dates[0])}, so moves compare directly whatever the share price.` : "Add a company to see its price line." })),
          h("div", { class: "legend" }, priced.map((x) => h("span", {}, h("i", { class: "ln", style: { "--k": x.color } }), x.c.ticker)))),
        priced.length ? chartEl : null),
      h("section", { class: "card" },
        h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Scores and fundamentals" }), h("p", { text: "“Best” marks the strongest value in a row when one company leads outright." }))),
        sel.length ? h("div", { class: "tscroll" }, table) : h("p", { class: "empty", text: "Nothing selected." })));
  };
  paint();
  return wrap;
}
