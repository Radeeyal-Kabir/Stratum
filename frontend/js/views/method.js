import { S, bands } from "../state.js";
import { SCORE_URL, h, pct, pts, signed } from "../lib.js";
import { anchorChart } from "../charts.js";

const ANCHOR_INFO = {
  revenue_yoy: ["Revenue growth, YoY", "Level of the growth part", (v) => pct(v, 0), (c) => c.fundamentals?.latest.revenue_yoy],
  revenue_yoy_slope: ["Growth direction", "Trend of the growth part: change in YoY growth per quarter", (v) => pts(v, 0), (c) => c.fundamentals?.trend.revenue_yoy_slope],
  net_margin: ["Net margin", "Level of the margin part", (v) => pct(v, 0), (c) => c.fundamentals?.latest.net_margin],
  net_margin_change_yoy: ["Margin change vs a year ago", "Trend of the margin part", (v) => pts(v, 0), (c) => c.fundamentals?.trend.net_margin_change_yoy],
  debt_to_equity: ["Debt / equity", "Level of the leverage part; lower is better", (v) => `${v.toFixed(1)}×`, (c) => c.fundamentals?.latest.debt_to_equity],
  debt_to_equity_change_yoy: ["Debt / equity change", "Trend of the leverage part; falling is better", (v) => signed(v, 1), (c) => c.fundamentals?.trend.debt_to_equity_change_yoy],
  current_ratio: ["Current ratio", "The whole liquidity part", (v) => `${v.toFixed(1)}×`, (c) => c.fundamentals?.latest.current_ratio],
};

const pctW = (w) => `${+(w * 100).toFixed(1)}%`;

function weightBar(items) {
  return h("div", { class: "wbar" }, items.map(([label, w, color]) =>
    h("span", { style: { flex: w, background: color }, title: `${label}: ${pctW(w)}`, text: w >= 0.09 ? `${label} ${pctW(w)}` : pctW(w) })));
}

const steps = (list) => h("div", { class: "flow" }, list.flatMap((x, i) => [h("span", { class: "step", text: x }), i < list.length - 1 ? h("span", { class: "to", text: "→" }) : null]));

export function viewMethod() {
  const m = S.method;
  const { buy, hold } = bands();
  const { quant: wq, qualitative: wl } = m.weights;
  const [lvl, trd] = m.level_vs_trend;
  const model = S.companies.flatMap((c) => c.qualitative?.filings ?? []).find((f) => f.model)?.model ?? "a local model";
  const tone = m.tone_level;

  return h("div", { class: "view-in stack" },
    h("div", { style: { display: "grid", gap: "8px" } },
      h("p", { class: "eyebrow", text: "Methodology" }),
      h("h1", { class: "page-title", text: "How a company gets its score" }),
      h("p", { class: "ink2", style: { maxWidth: "66ch" } }, "One formula, applied the same way to every company, with every input taken from the company's own SEC filings. The numbers on this page are read from ",
        h("a", { href: SCORE_URL, text: "screener/score.py" }), ", so they always match what produced the ratings.")),

    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: "The formula" })),
      h("div", { class: "formula" }, `composite = ${wq.toFixed(2)} × `, h("span", { class: "q", text: "quant" }), ` + ${wl.toFixed(2)} × `, h("span", { class: "l", text: "qualitative" })),
      h("div", { class: "bandcards" },
        h("div", {}, h("span", { class: "chip Buy", text: "Buy" }), h("span", { text: `Composite of ${buy} or more.` })),
        h("div", {}, h("span", { class: "chip Hold", text: "Hold" }), h("span", { text: `From ${hold} up to ${buy}.` })),
        h("div", {}, h("span", { class: "chip Avoid", text: "Avoid" }), h("span", { text: `Below ${hold}.` }))),
      h("p", { class: "note", text: "The two parts are combined unrounded and the result is rounded once, so rounding can never move a company across a band edge that its data doesn't cross." })),

    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Where the weight goes" }), h("p", { text: "Each input's share of the final composite." }))),
      h("div", { class: "wtree" },
        h("div", { class: "wrow" }, h("span", { class: "ink2", text: "Composite" }), weightBar([["Quant", wq, "var(--s1)"], ["Qualitative", wl, "var(--s2)"]])),
        h("div", { class: "wrow" }, h("span", { class: "ink2", text: "Inputs" }), weightBar([
          ["Growth", wq * m.quant_weights.revenue_growth, "var(--s1)"], ["Margin", wq * m.quant_weights.net_margin, "var(--s1)"],
          ["Leverage", wq * m.quant_weights.leverage, "var(--s1)"], ["Liquidity", wq * m.quant_weights.liquidity, "var(--s1)"],
          ["Tone", wl * m.qual_weights.tone, "var(--s2)"], ["Red flags", wl * m.qual_weights.red_flags, "var(--s2)"]]))),
      h("p", { class: "note", text: `Growth, margin and leverage each blend the current level (${pctW(lvl)}) with the recent trend (${pctW(trd)}). If a company has negative stockholders' equity, debt/equity is undefined, so leverage drops out and the other quant inputs are scaled up to fill its share.` })),

    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Turning a metric into 0–100" }),
        h("p", { text: "Each metric maps through fixed anchor points (the dots) with straight lines between them, clamped at both ends. Ticks along the bottom show where the companies sit today; hover to read any value." }))),
      h("div", { class: "anchors" }, Object.entries(m.anchors).map(([key, anchors]) => {
        const [title, sub, fmt, get] = ANCHOR_INFO[key] ?? [key.replaceAll("_", " "), "", (v) => String(v), () => null];
        return h("div", {}, h("div", { class: "mini-h", text: title }), h("div", { class: "mini-s", text: sub }),
          anchorChart(h("div", { class: "chart" }), anchors, fmt, get));
      })),
      h("p", { class: "note", text: `A missing input scores a neutral ${m.neutral} and is listed on the company page, so a data gap never quietly helps or hurts.` })),

    h("div", { class: "grid-2" },
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Qualitative score" })),
        h("div", { class: "rules" },
          h("p", {}, h("b", { text: `Tone (${pctW(m.qual_weights.tone)}). ` }),
            `Bullish starts at ${tone.bullish}, neutral ${tone.neutral}, bearish ${tone.bearish}. Each step of change against the previous filing moves it ${m.tone_shift_points} points, and each extra bearish filing in a row costs another ${m.consecutive_bearish_penalty}.`),
          h("p", {}, h("b", { text: `Red flags (${pctW(m.qual_weights.red_flags)}). ` }),
            `Starts at 100. Each current flag costs ${m.red_flag_cost["1"]} points in its first filing, ${m.red_flag_cost["2"]} in its second consecutive filing and ${m.red_flag_cost_persistent} from the third on.`),
          h("p", {}, h("b", { text: "Verification. " }), "A flag counts only when the model quotes the filing word for word and the quote is found in the text. Safe-harbor and risk-factor boilerplate is filtered out first."))),
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("h2", { text: "Pipeline" })),
        steps(["SEC EDGAR", "XBRL company facts", "8 quarters of ratios", "Quant score"]),
        steps(["New 10-Q or 10-K", "MD&A section", `Local model (${model})`, "Qualitative score"]),
        h("p", { class: "note", text: "A scheduled job checks EDGAR every 6 hours and re-scores a company when it files. Prices refresh after each market close and stay outside the score, so the Price vs. rating view compares two independent signals." }))));
}
