import { S, bands } from "../state.js";
import { h, pct, pts, signed } from "../lib.js";
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

function qualitativeCard(m, tone) {
  const c1 = m.red_flag_cost["1"], c2 = m.red_flag_cost["2"], c3 = m.red_flag_cost_persistent;
  const levels = [["Bullish", tone.bullish, "bullish"], ["Neutral", tone.neutral, "neutral"], ["Bearish", tone.bearish, "bearish"]];
  const costs = [["First filing", c1], ["Second in a row", c2], ["Third or later", c3]];
  const panel = (title, weight, ...body) => h("div", { class: "q-panel" },
    h("div", { class: "q-head" }, h("h3", { text: title }), weight ? h("span", { class: "q-weight", text: weight }) : null), ...body);
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Qualitative score" }),
      h("p", { text: "Read from the MD&A section of each 10-Q and 10-K. Two equal halves: how management sounds, and what risks it discloses. A language model reads part of the section; plain pattern rules then scan all of it for reported declines in revenue, bookings, margins or earnings, expected margin drops, and restructuring or impairment charges." }))),
    h("div", { class: "q-grid" },
      panel("Tone", pctW(m.qual_weights.tone),
        h("div", { class: "tone-scale", role: "img", "aria-label": levels.map(([l, v]) => `${l} ${v}`).join(", ") },
          h("div", { class: "tone-track" }), levels.map(([l, v, k]) => h("span", { class: `tone-mark ${k}`, style: { left: `${v}%` } }, h("b", { text: v }), h("small", { text: l })))),
        h("ul", { class: "q-list" },
          h("li", {}, h("b", { text: `±${m.tone_shift_points}` }), " for each step of change against the previous filing"),
          h("li", {}, h("b", { text: `−${m.consecutive_bearish_penalty}` }), " for each extra bearish filing in a row"))),
      panel("Red flags", pctW(m.qual_weights.red_flags),
        h("p", { class: "q-lead", text: "Starts at 100. Each current flag costs more the longer it persists:" }),
        h("div", { class: "cost-bars" }, costs.map(([label, v]) => h("div", { class: "cost-row" },
          h("span", { text: label }), h("span", { class: "cost-bar" }, h("i", { style: { width: `${(v / c3) * 100}%` } })), h("b", { text: `−${v}` })))),
        h("p", { class: "q-example", text: `Example: one new flag and one on its third filing scores 100 − ${c1} − ${c3} = ${100 - c1 - c3}.` })),
      panel("Verification", null,
        h("ol", { class: "q-steps" },
          h("li", { text: "Safe-harbor and risk-factor boilerplate is removed before the model reads anything." }),
          h("li", { text: "The model proposes red flags, each with a quote from the filing." }),
          h("li", { text: "Every quote is checked word for word against the filing text." }),
          h("li", { text: "Flags whose quote isn't found are dropped, never scored." }),
          h("li", { text: "The quote must be about its category (an inventory flag has to mention inventory; a guidance cut needs a lowered expectation), and a rise can't be filed as a decline." })))));
}

const VERSION_NAME = { v1: "Prompt v1", v2: "Prompt v2", v2p: "Prompt v2 + pattern rules" };

/** Published error rate for red flags, from screener/flag_benchmark.py. Loaded on demand. */
function accuracyCard() {
  const card = h("section", { class: "card" });
  fetch("data/benchmark.json").then((r) => (r.ok ? r.json() : null)).catch(() => null).then((b) => {
    if (!b) return card.remove();
    const recall = b.recall_sample?.candidates ? b.recall_sample : null;
    const row = (version, r) => {
      const seg = (n, cls, label) => (n ? h("span", { class: cls, style: { flex: n }, title: `${label}: ${n}` }) : null);
      return h("div", { class: `acc-row${version === b.live_prompt ? " live" : ""}` },
        h("div", { class: "acc-name" }, h("strong", { text: VERSION_NAME[version] ?? `Prompt ${version}` }), version === b.live_prompt ? h("span", { class: "tag", text: "live" }) : null),
        h("div", { class: "acc-bar", role: "img", "aria-label": `${r.supported} supported, ${r.ambiguous} ambiguous, ${r.unsupported} unsupported of ${r.labeled}` },
          seg(r.supported, "ok", "Supported"), seg(r.ambiguous, "amb", "Ambiguous"), seg(r.unsupported, "bad", "Unsupported")),
        h("div", { class: "acc-num" }, h("strong", { text: `${Math.round(r.unsupported_share * 100)}%` }), h("span", { text: `unsupported, of ${r.labeled} flags` }),
          r.recall ? h("span", { class: "acc-found", text: `Finds about ${Math.round(r.recall.share_found * 100)}% of real problems (${Math.round(r.recall.share_found_low * 100)}–${Math.round(r.recall.share_found_high * 100)}%)` }) : null));
    };
    card.append(
      h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "How often red flags are wrong" }),
        h("p", { text: `Every flag the model raised on ${b.test_filings} held-out filings from ${b.test_companies} companies was checked against the surrounding filing text: supported, ambiguous, or unsupported (the passage doesn't show that problem, or shows a different one).` }))),
      h("div", { class: "acc-rows" }, Object.entries(b.results).map(([v, r]) => row(v, r))),
      h("div", { class: "acc-key" }, h("span", { class: "ok", text: "Supported" }), h("span", { class: "amb", text: "Ambiguous" }), h("span", { class: "bad", text: "Unsupported" })),
      h("p", { class: "note", text: recall
        ? `Finding rate: ${recall.known_real} real problems were found by at least one prompt. To estimate the ones neither found, a random sample of ${recall.missed_sample} unflagged sentences with negative wording was checked and ${recall.missed_sample_real} were real, which scales to roughly ${recall.est_missed.mid} more (${recall.est_missed.low}–${recall.est_missed.high}) in the excerpts the model was shown. That excludes the rest of each filing. A blank flag list is therefore not a clean bill of health.`
        : "This counts wrong flags, not missed ones." }),
      b.pattern_live_sample ? h("p", { class: "note", text: `The pattern rules were also checked on live data: of ${b.pattern_live_sample.sampled} of their ${b.pattern_live_sample.flags_on_file} flags picked at random, ${b.pattern_live_sample.supported} were clearly real, ${b.pattern_live_sample.ambiguous} were borderline and ${b.pattern_live_sample.unsupported} were wrong (an accounting-policy sentence, since excluded).` }) : null,
      h("p", { class: "note", text: `Labels: ${b.labeled_by}. Model ${b.model}, measured ${b.as_of}.` }));
  });
  return card;
}

function pipelineCard(model, wq, wl) {
  const node = (text, sub, cls = "") => h("div", { class: `pipe-node ${cls}` }, h("strong", { text }), sub ? h("span", { text: sub }) : null);
  const lane = (label, cls, nodes) => h("div", { class: `pipe-lane ${cls}` }, h("span", { class: "pipe-label", text: label }), h("div", { class: "pipe-row" }, nodes));
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Pipeline" }),
      h("p", { text: "Two independent readings of each company's own SEC filings, combined into one score. Prices run alongside and never enter it." }))),
    h("div", { class: "pipe", role: "img", "aria-label": `Fundamentals lane: SEC EDGAR XBRL facts, 8 quarters of ratios, quant score at ${pctW(wq)}. Filing language lane: new 10-Q or 10-K, MD&A section, local model with quote check, qualitative score at ${pctW(wl)}. Both combine into the composite score and rating. Price lane: daily closes and momentum, shown beside the score only.` },
      h("div", { class: "pipe-lanes" },
        lane("Fundamentals", "quant", [node("SEC EDGAR", "XBRL company facts"), node("8 quarters", "growth, margin, leverage, liquidity"), node("Quant score", `${pctW(wq)} of composite`, "score")]),
        lane("Filing language", "qual", [node("New 10-Q or 10-K", "checked every 6 hours"), node("MD&A section", `read by ${model}`), node("Qualitative score", `${pctW(wl)} of composite`, "score")])),
      h("div", { class: "pipe-merge", "aria-hidden": "true" }),
      h("div", { class: "pipe-out" }, h("span", { class: "pipe-label", text: "Result" }),
        h("div", { class: "pipe-node out" }, h("strong", { text: "Composite score" }), h("span", { text: "0 to 100" }),
          h("div", { class: "pipe-chips" }, ["Buy", "Hold", "Avoid"].map((r) => h("span", { class: `chip ${r}`, text: r })))))),
    h("div", { class: "pipe-side" },
      lane("Price, kept separate", "price", [node("Daily closes", "after each market close"), node("Momentum", "moves, averages, vs peers"), node("Shown beside the score", "never an input", "aside")])),
    h("p", { class: "note", text: "Keeping price out of the score is what lets the Price vs. rating view compare two independent signals." }));
}

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
      h("p", { class: "ink2", style: { maxWidth: "66ch" } }, "One formula, applied the same way to every company, with every input taken from the company's own SEC filings. The numbers on this page are read directly from the scoring code, so they always match what produced the ratings.")),

    h("section", { class: "card" },
      h("div", { class: "card-head" }, h("h2", { text: "The formula" })),
      h("div", { class: "formula" }, `composite = ${wq.toFixed(2)} × `, h("span", { class: "q", text: "quant" }), ` + ${wl.toFixed(2)} × `, h("span", { class: "l", text: "qualitative" })),
      h("div", { class: "bandcards" },
        h("div", {}, h("span", { class: "chip Buy", text: "Buy" }), h("span", { text: `Composite of ${buy} or more.` })),
        h("div", {}, h("span", { class: "chip Hold", text: "Hold" }), h("span", { text: `From ${hold} up to ${buy}.` })),
        h("div", {}, h("span", { class: "chip Avoid", text: "Avoid" }), h("span", { text: `Below ${hold}.` }))),
      h("p", { class: "note", text: "The two parts are combined unrounded and rounded once at the end, avoiding double-rounding artifacts. The band is assigned to that rounded, displayed number, so it always matches what's on screen — but a raw score within 0.05 of a threshold can round up into the next band." })),

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

    qualitativeCard(m, tone),
    accuracyCard(),
    pipelineCard(model, wq, wl));
}
