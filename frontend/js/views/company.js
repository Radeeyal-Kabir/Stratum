import { S, bands, navigate, rankOf, toggleWatch } from "../state.js";
import { ITEM_8K, PART_LABEL, bil, capped, chip, dirc, dshort, dtime, flagName, fx, h, link, mday, pct, plural, pts, qlabel, secLink, signed, tipRow, usd } from "../lib.js";
import { columnChart, lineChart, toneChart } from "../charts.js";
import { logo } from "../identity.js";
import { filingChanges } from "../filing-changes.js";
import { addToCompare } from "./compare.js";
import { cashMetrics, sbcIsCost, setSbcAsCost } from "../cashflow.js";
import { STATUSES, exportNotes, getNote, importNotes, saveNote } from "../notes.js";

/** Copies text; if the browser refuses, shows it selected so the user can copy by hand. */
function copyButton(label, getText) {
  const status = h("span", { class: "copy-status", role: "status" });
  const btn = h("button", { type: "button", class: "btn", text: label });
  btn.addEventListener("click", async () => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied. Paste into Excel or Google Sheets.";
    } catch {
      const area = h("textarea", { class: "copy-fallback", readonly: true, "aria-label": "Table to copy" });
      area.value = text;
      status.replaceChildren("Copy blocked by the browser. Select and copy this instead:", area);
      area.select();
    }
  });
  return h("span", { class: "copy-wrap" }, btn, status);
}

/** Tab-separated, quarters as columns oldest to newest, plain numbers (USD millions, ratios as decimals). */
function modelTable(c) {
  const qs = c.fundamentals.quarters;
  const num = (v, scale = 1) => (v === null || v === undefined ? "" : String(+(v / scale).toFixed(scale === 1 ? 4 : 1)));
  const rows = [
    [`${c.ticker} (USD millions)`, ...qs.map((q) => q.end)],
    ["Revenue", ...qs.map((q) => num(q.revenue, 1e6))],
    ["Net income", ...qs.map((q) => num(q.net_income, 1e6))],
    ["Net margin", ...qs.map((q) => num(q.net_margin))],
    ["Revenue growth YoY", ...qs.map((q) => num(q.revenue_yoy))],
    ["Debt / equity", ...qs.map((q) => (q.negative_equity ? "" : num(q.debt_to_equity)))],
    ["Current ratio", ...qs.map((q) => num(q.current_ratio))],
    ["Source", "SEC EDGAR XBRL company facts; Q4 = annual minus Q1-Q3"],
  ];
  return rows.map((r) => r.join("\t")).join("\n");
}

function cashCard(c) {
  const m = cashMetrics(c);
  if (!m || (m.fcf_ttm === null && m.sbc_ttm === null)) return emptyCard("Cash-flow figures aren't available for this company yet.");
  const card = h("section", { class: "card" });
  const paint = () => {
    const x = cashMetrics(c);
    const cost = sbcIsCost();
    const toggle = h("label", { class: "switch" },
      h("input", { type: "checkbox", id: "sbc-toggle", checked: cost, onchange: (e) => { setSbcAsCost(e.target.checked); paint(); } }),
      h("span", { text: "Count stock-based pay as a cash cost" }));
    const stat = (k, v, sub) => h("div", {}, h("span", { class: "k", text: k }), h("span", { class: "v", text: v }), sub ? h("span", { class: "s", text: sub }) : null);
    card.replaceChildren(
      h("div", { class: "card-head" },
        h("div", {}, h("h2", { text: "Cash flow and valuation" }),
          h("p", { text: `Trailing twelve months to ${dshort(x.period_end)}. Shown for context; none of this feeds the score.` })),
        toggle),
      h("div", { class: "cash-grid" },
        stat("Free cash flow", bil(x.fcf_ttm), `Operating ${bil(x.operating_cash_flow_ttm)} − capex ${bil(x.capex_ttm)}`),
        stat("FCF margin", pct(cost ? x.fcf_less_sbc_margin : x.fcf_margin, 1), cost ? "After stock-based pay" : "Before stock-based pay"),
        stat("Stock-based pay", bil(x.sbc_ttm), `${pct(x.sbc_pct_revenue, 1)} of revenue`),
        stat("Enterprise value", bil(x.ev), x.ev !== null ? `Market cap ${bil(x.marketCap)} + debt − cash` : x.evReason),
        stat(cost ? "SBC-adjusted FCF yield" : "FCF yield", pct(x.shownYield, 1), cost ? "(FCF − stock-based pay) ÷ EV" : "FCF ÷ EV")),
      h("p", { class: "note", text: `Cash-flow statements are reported year to date, so the twelve-month figures are the last full year plus this year to date, minus the same period a year earlier. Enterprise value uses ${x.shares_as_of ? `shares outstanding as of ${dshort(x.shares_as_of)}` : "the latest share count"} and the latest close.` }));
  };
  paint();
  return card;
}

function notesCard(t) {
  const note = getNote(t);
  const text = h("textarea", { id: `notes-${t}`, class: "notes-text", rows: 5, placeholder: "Your thesis, what to check next earnings, questions for the filing…", "aria-label": `Notes on ${t}` });
  text.value = note.text;
  const status = h("select", { id: `notes-status-${t}`, "aria-label": "Thesis status" }, STATUSES.map((s) => h("option", { value: s, text: s, selected: s === note.status })));
  const target = h("input", { id: `notes-target-${t}`, type: "number", min: "0", step: "0.01", inputmode: "decimal", placeholder: "Price target", "aria-label": "Price target in dollars", value: note.target ?? "" });
  const saved = h("span", { class: "copy-status", role: "status", text: note.updated ? `Saved ${dtime(note.updated)}` : "" });
  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tv = parseFloat(target.value);
      saveNote(t, { text: text.value, status: status.value, target: Number.isFinite(tv) ? tv : null });
      saved.textContent = "Saved in this browser";
    }, 400);
  };
  [text, status, target].forEach((el) => el.addEventListener("input", save));
  const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try { saved.textContent = `Imported notes for ${importNotes(await f.text())} companies. Reload the page to see them.`; }
    catch (err) { saved.textContent = `Couldn't import: ${err.message}`; }
    file.value = "";
  });
  const exportBtn = h("button", { type: "button", class: "btn", text: "Export all notes", onclick: () => {
    const url = URL.createObjectURL(new Blob([exportNotes()], { type: "application/json" }));
    const a = h("a", { href: url, download: "stratum-notes.json" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Your notes" }),
      h("p", { text: "Private to this browser. Export them to back up or move to another device." }))),
    h("div", { class: "notes-row" }, h("label", { class: "field" }, status), h("label", { class: "field" }, h("span", { class: "muted", text: "$" }), target)),
    text,
    h("div", { class: "notes-actions" }, saved, h("span", { class: "notes-io" }, exportBtn,
      h("button", { type: "button", class: "btn", text: "Import", onclick: () => file.click() }), file)));
}

function researchBrief(c, sc, filings) {
  const delta = filingChanges(filings);
  const latest = delta.latest;
  const groups = [["Newly detected", delta.added, "new"], ["Still present", delta.continuing, "continuing"], ["Not detected this time", delta.absent, "absent"]];
  return h("section", { class: "research-brief" },
    h("div", { class: "brief-main" }, h("p", { class: "section-kicker", text: "THE INVESTMENT SIGNAL" }),
      h("h2", { text: "Behind the rating" }), h("p", { class: "brief-rationale", text: sc?.rationale ?? "Analysis is pending for this company." }),
      c.fundamentals?.latest ? h("div", { class: "brief-metrics" },
        [["Revenue YoY", pct(c.fundamentals.latest.revenue_yoy, 1, true)],
          ["Net margin", pct(c.fundamentals.latest.net_margin, 1)],
          ["Current ratio", fx(c.fundamentals.latest.current_ratio)]].map(([label, value]) =>
          h("div", {}, h("span", { text: label }), h("strong", { text: value })))) : null,
      h("div", { class: "brief-meta" },
        h("span", { text: `Score updated ${dtime(sc?.scored_at)}` }),
        h("span", { text: latest ? `Latest analysis: ${latest.form} · filed ${dshort(latest.filed)}` : "Filing analysis pending" }))),
    h("div", { class: "filing-delta" }, h("div", { class: "card-head" }, h("div", {},
      h("p", { class: "section-kicker", text: "SINCE THE PREVIOUS FILING" }), h("h3", { text: "What changed?" })),
      latest ? secLink(latest.source_url, "Source filing") : null),
      delta.previous ? [
        h("p", { class: "delta-tone" }, "Management tone: ", h("b", { text: `${delta.previous.tone} → ${latest.tone}` })),
        h("div", { class: "delta-grid" }, groups.map(([label, items, kind]) => h("div", { class: `delta-item ${kind}` },
          h("span", { class: "delta-number", text: items.length }), h("span", { class: "delta-label", text: label }),
          h("span", { class: "delta-categories", text: items.map(flagName).join(" · ") || "None" })))),
        h("p", { class: "note", text: `${dshort(delta.previous.filed)} → ${dshort(latest.filed)}. Changes in model-detected risk categories, not proof that risks appeared or were resolved.` }),
      ] : h("p", { class: "muted", text: "Two successfully analyzed filings are needed to show changes." }),
      latest?.mda_chars ? h("p", { class: "coverage-note", text: `Analysis coverage: ${Math.round(latest.chars_analyzed / latest.mda_chars * 100)}% of the latest MD&A text. Quotes are matched to the filing; category labels are model interpretations.` }) : null));
}

const emptyCard = (text) => h("section", { class: "card" }, h("p", { class: "empty", text }));

function header(c, p, sc) {
  const t = c.ticker;
  const rank = rankOf(t), prev = S.ranked[rank - 2], next = S.ranked[rank];
  const watch = h("button", { type: "button", class: "btn" });
  const paintWatch = () => {
    watch.setAttribute("aria-pressed", String(S.watch.has(t)));
    watch.textContent = S.watch.has(t) ? "★ Watching" : "☆ Watch";
  };
  watch.addEventListener("click", () => { toggleWatch(t); paintWatch(); });
  paintWatch();
  return h("section", { style: { display: "grid", gap: "16px" } },
    h("div", { class: "crumbs" }, link("screener", {}, "Screener"), h("span", { text: "/" }), h("span", { text: t }),
      h("span", { class: "pn" }, prev ? link(prev.ticker, {}, `← ${prev.ticker}`) : null, next ? link(next.ticker, {}, `${next.ticker} →`) : null)),
    h("div", { class: "co-head" },
      h("div", { class: "co-id" },
        h("div", { class: "company-title" }, logo(t, "lg"), h("div", {}, h("p", { class: "eyebrow", text: `${t} / COMPANY RESEARCH` }), h("h1", { text: c.name }))),
        h("div", { class: "meta" }, chip(sc), h("span", { text: c.sub_sector }), h("span", { class: "muted", text: `Rank ${rank} of ${S.companies.length}` }))),
      h("div", { class: "co-px" },
        p ? h("div", {}, h("div", { class: "price", text: usd(p.close) }),
          h("div", { class: "small" }, h("span", { class: `num ${dirc(p.change_1d)}`, text: `${pct(p.change_1d, 2, true)} today` }), h("span", { class: "muted", text: ` · ${dshort(p.date)} close` }))) : null,
        h("div", { class: "co-actions" }, watch,
          h("button", { type: "button", class: "btn", text: "Compare", onclick: () => { addToCompare(t); navigate("compare"); } })))));
}

function scoreCard(c, sc) {
  if (!sc) return emptyCard("Not scored yet: no fundamentals on file.");
  const card = h("section", { class: "card" });
  const { quant: wq, qualitative: wl } = S.method.weights;
  const { buy, hold } = bands();
  const qc = sc.quant.raw * wq, lc = sc.qualitative ? sc.qualitative.raw * wl : 0;
  const part = (k, v, color, weight) => h("div", { class: "part" },
    h("span", {}, PART_LABEL[k], h("span", { class: "w", text: weight })),
    h("span", { class: "pb" }, h("span", { style: { width: `${v}%`, background: color } })),
    h("span", { class: "pv", text: v.toFixed(0) }));
  card.append(
    h("div", { class: "card-head", style: { marginBottom: "8px" } }, h("h2", { text: "Composite score" }), link("method", { class: "small" }, "How it works")),
    h("div", { class: "bigscore" }, h("span", { class: "n", text: sc.composite.toFixed(1) }), h("span", { class: "of", text: "out of 100" }), chip(sc, false)),
    h("div", { class: "ruler", role: "img", "aria-label": `Composite ${sc.composite} on a 0 to 100 scale; Avoid below ${hold}, Buy from ${buy}` },
      h("div", { class: "track" },
        h("span", { style: { flex: hold, background: "var(--avoid-soft)" } }), h("span", { style: { flex: buy - hold, background: "var(--hold-soft)" } }),
        h("span", { style: { flex: 100 - buy, background: "var(--buy-soft)" } })),
      h("div", { class: "mark", style: { left: `${sc.composite}%` } }),
      h("div", { class: "ticks" }, [0, hold, buy, 100].map((v) => h("span", { style: { left: `${v}%`, transform: v === 0 ? "none" : v === 100 ? "translateX(-100%)" : null }, text: v }))),
      h("div", { class: "bands" },
        h("span", { style: { flex: hold }, text: "Avoid" }), h("span", { style: { flex: buy - hold }, text: "Hold" }), h("span", { style: { flex: 100 - buy }, text: "Buy" }))),
    h("div", { class: "sub-h", text: "What makes up the score" }),
    h("div", { class: "contrib", role: "img", "aria-label": `Quant contributes ${qc.toFixed(1)} points, qualitative ${lc.toFixed(1)}` },
      h("span", { style: { width: `${qc}%`, background: "var(--s1)" }, title: `Quant ${qc.toFixed(1)}`, text: qc >= 20 ? `Quant ${qc.toFixed(1)}` : "" }),
      sc.qualitative ? h("span", { style: { width: `${lc}%`, background: "var(--s2)" }, title: `Qualitative ${lc.toFixed(1)}`, text: lc >= 20 ? `Qual. ${lc.toFixed(1)}` : "" }) : null),
    h("p", { class: "note", style: { marginTop: "8px" }, text: `Quant ${sc.quant.score.toFixed(1)} × ${Math.round(wq * 100)}% + qualitative ${sc.qualitative ? sc.qualitative.score.toFixed(1) : "pending"} × ${Math.round(wl * 100)}% = ${sc.composite.toFixed(1)}` }),
    h("div", { class: "parts" },
      Object.keys(S.method.quant_weights).map((k) => {
        const v = sc.quant.parts[k];
        if (v === undefined) {
          return h("div", { class: "part" }, h("span", {}, PART_LABEL[k], h("span", { class: "w", text: "excluded" })),
            h("span", { class: "small muted", text: "Negative equity makes the ratio undefined; the other inputs are reweighted." }), h("span"));
        }
        return part(k, v, "var(--s1)", `${Math.round(S.method.quant_weights[k] * 100)}% of quant`);
      }),
      sc.qualitative ? Object.keys(S.method.qual_weights).map((k) =>
        part(k, sc.qualitative.parts[k], "var(--s2)", `${Math.round(S.method.qual_weights[k] * 100)}% of qual.`)) : null),
    h("p", { class: "rationale", text: sc.rationale }));
  const notes = [...(c.fundamentals?.warnings ?? []), ...(sc.quant.missing ?? []).map((m) => `Missing input scored neutral (${S.method.neutral}): ${m.replaceAll("_", " ")}`)];
  if (notes.length) card.append(h("ul", { class: "note" }, notes.map((n) => h("li", { text: n }))));
  return card;
}

function priceCard(p) {
  if (!p?.closes?.length) return emptyCard("No price history loaded.");
  const card = h("section", { class: "card" });
  const cl = p.closes, chg = cl[cl.length - 1] / cl[0] - 1;
  const el = h("div", { class: "chart" });
  lineChart(el, {
    series: [{ label: "Close", color: "var(--accent)", values: cl }], height: 250, area: true,
    yFmt: (v) => "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(2)), tipFmt: usd,
    xLabels: p.dates.map(mday), tipTitle: (i) => `${dshort(p.dates[i])} close`,
  });
  const mom = [["vs 50-day avg", pct(p.vs_sma50, 1, true), p.vs_sma50], ["vs 200-day avg", pct(p.vs_sma200, 1, true), p.vs_sma200],
    ["3-month return", pct(p.return_3m, 1, true), p.return_3m], ["3M vs peers", pts(p.rel_universe_3m), p.rel_universe_3m]];
  card.append(
    h("div", { class: "card-head" },
      h("div", {}, h("h2", { text: `Price, last ${cl.length} sessions` }),
        h("p", {}, h("span", { class: `num ${dirc(chg)}`, style: { fontWeight: 600 }, text: pct(chg, 1, true) }), ` since ${dshort(p.dates[0])}`)),
      h("span", { class: "tag", text: `Source: ${p.source}` })),
    el,
    h("div", { class: "mom" }, mom.map(([k, v, raw]) => h("div", {}, h("span", { class: "k", text: k }), h("span", { class: `v ${dirc(raw)}`, text: v })))),
    h("p", { class: "note", text: `50-day average ${usd(p.sma50)}, 200-day average ${usd(p.sma200)}. Shown for context; price is not an input to the score.` }));
  return card;
}

function fundamentalsCard(c, sc) {
  const f = c.fundamentals;
  if (!f?.quarters?.length) return emptyCard("No fundamentals on file yet.");
  const card = h("section", { class: "card" });
  const qs = f.quarters, L = f.latest, T = f.trend, labels = qs.map((q) => qlabel(q.end));
  const qTitle = (i) => `Quarter ending ${dshort(qs[i].end)}`;
  const revEl = h("div", { class: "chart" }), yoyEl = h("div", { class: "chart" }), mgnEl = h("div", { class: "chart" });
  columnChart(revEl, {
    values: qs.map((q) => q.revenue), labels, height: 190,
    yFmt: (v) => (v === 0 ? "0" : "$" + (v / 1e9).toFixed(v < 1e10 ? 1 : 0) + "B"),
    tipTitle: qTitle, tipRows: (i) => [tipRow("Revenue", bil(qs[i].revenue)), tipRow("Net income", bil(qs[i].net_income))],
  });
  lineChart(yoyEl, { series: [{ label: "Revenue growth", color: "var(--s1)", values: qs.map((q) => q.revenue_yoy) }], height: 190, zero: true,
    yFmt: (v) => pct(v, 0), tipFmt: (v) => pct(v, 1, true), xLabels: labels, tipTitle: qTitle });
  lineChart(mgnEl, { series: [{ label: "Net margin", color: "var(--s1)", values: qs.map((q) => q.net_margin) }], height: 190, zero: true,
    yFmt: (v) => pct(v, 0), tipFmt: (v) => pct(v, 1), xLabels: labels, tipTitle: qTitle });
  const direction = T.revenue_yoy_slope > 0.005 ? "accelerating" : T.revenue_yoy_slope < -0.005 ? "slowing" : "steady";
  const th = (x, i) => h("th", { class: i === 0 ? "l" : null }, h("span", { text: x }));
  const table = h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, ["Quarter end", "Revenue", "Net income", "Rev. YoY", "Net margin", "Debt/equity", "Current ratio"].map(th))),
    h("tbody", {}, [...qs].reverse().map((q) => h("tr", {},
      h("td", { class: "l", text: dshort(q.end) }), h("td", { text: bil(q.revenue) }), h("td", { text: bil(q.net_income) }),
      h("td", { text: pct(q.revenue_yoy, 1, true) }), h("td", { text: pct(q.net_margin, 1) }),
      h("td", { text: q.negative_equity ? "n/a" : fx(q.debt_to_equity) }), h("td", { text: fx(q.current_ratio) })))));
  card.append(
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: `Fundamentals, last ${qs.length} quarters` }),
      h("p", { text: `From XBRL data in each 10-Q and 10-K. Latest quarter ended ${dshort(L.period_end)}. Q4 is derived as the annual figure minus Q1 to Q3.` }))),
    h("div", { class: "grid-3" },
      h("div", {}, h("div", { class: "mini-h", text: "Revenue per quarter" }), h("div", { class: "mini-s", text: `Latest ${bil(qs[qs.length - 1].revenue)}` }), revEl),
      h("div", {}, h("div", { class: "mini-h", text: "Revenue growth, year over year" }), h("div", { class: "mini-s", text: `Latest ${pct(L.revenue_yoy, 1, true)} · ${direction}` }), yoyEl),
      h("div", {}, h("div", { class: "mini-h", text: "Net margin" }), h("div", { class: "mini-s", text: `Latest ${pct(L.net_margin, 1)} · ${pts(T.net_margin_change_yoy)} vs a year ago` }), mgnEl)),
    h("div", { class: "stat-row" },
      h("div", {}, h("span", { class: "k", text: "Debt / equity" }),
        h("span", { class: "v", text: sc?.quant.negative_equity ? "n/a (negative equity)" : `${fx(L.debt_to_equity)} (${signed(T.debt_to_equity_change_yoy)} vs a year ago)` })),
      h("div", {}, h("span", { class: "k", text: "Current ratio" }), h("span", { class: "v", text: fx(L.current_ratio) })),
      h("div", {}, h("span", { class: "k", text: "Fundamentals refreshed" }), h("span", { class: "v", style: { fontWeight: 500 }, text: dtime(c.fundamentals_as_of) }))),
    h("details", { class: "more" }, h("summary", { text: "Quarterly table" }),
      h("div", { class: "table-tools" }, copyButton("Copy for spreadsheet", () => modelTable(c))),
      h("div", { class: "tscroll" }, table)));
  return card;
}

function mdaCard(c, sc, filings) {
  const latest = filings[filings.length - 1];
  if (!latest) return emptyCard("No filing analyzed yet.");
  const card = h("section", { class: "card" });
  const q = sc?.qualitative;
  const persist = Object.fromEntries((q?.flags ?? []).map((x) => [x.category, x.consecutive_filings]));
  const toneLine = !q ? "" : q.consecutive_bearish >= 2 ? `Bearish for ${q.consecutive_bearish} filings running`
    : q.tone_shift > 0 ? "Improving on the prior filing" : q.tone_shift < 0 ? "Worse than the prior filing" : "Unchanged from the prior filing";
  const toneEl = h("div", { class: "chart" });
  toneChart(toneEl, filings);
  const flagNodes = (latest.red_flags ?? []).map((rf) => {
    const n = persist[rf.category] ?? 1;
    return h("div", { class: "flag" },
      h("div", { class: "flag-top" }, h("span", { class: "flag-cat", text: flagName(rf.category) }),
        h("span", { class: `persist ${n >= 3 ? "" : n === 2 ? "lo" : "new"}`, text: n === 1 ? "New this filing" : `${n} filings running` })),
      h("div", { class: "small", text: rf.summary }),
      rf.quote ? h("blockquote", { text: `“${rf.quote}”` }) : null,
      h("div", { class: "src" }, `${latest.form}, filed ${dshort(latest.filed)} · `, secLink(latest.source_url, rf.quote ? "See this quote in the filing" : "Read on SEC.gov", rf.quote)));
  });
  card.append(
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "What management is saying" }),
      h("p", { text: `Tone and red flags read from the MD&A section of the last ${plural(filings.length, "periodic filing")}.` }))),
    h("div", { class: "split" },
      h("div", {},
        h("div", { class: "tone-sum" }, h("span", { class: `tone-pill ${latest.tone}`, text: latest.tone }), h("span", { class: "small ink2", text: toneLine })),
        h("div", { class: "mini-h", text: "Tone by filing" }), h("div", { class: "mini-s", text: "Model tone score from −1 (bearish) to +1 (bullish), oldest to newest" }), toneEl,
        latest.tone_rationale ? h("p", { class: "said" }, h("b", { text: `Latest ${latest.form}, period ending ${dshort(latest.period_end)}: ` }), latest.tone_rationale) : null),
      h("div", {},
        h("div", { class: "mini-h", text: `Red flags in the latest filing (${flagNodes.length})` }),
        h("div", { class: "mini-s", text: "Each one is backed by a word-for-word quote from the filing." }),
        flagNodes.length ? capped(h("div", { class: "flags" }), flagNodes, 3, "red flags") : h("p", { class: "empty", text: "No verified red flags in the latest filing." }))));
  return card;
}

function filingsCard(c, p, sc, filings) {
  const f = c.fundamentals;
  const analyzed = [...filings].reverse().map((x) => h("div", { class: "li" },
    h("span", { class: "f", text: x.form }),
    h("span", {}, `Period ending ${dshort(x.period_end)}`, h("br"),
      h("span", { class: "xs muted", text: `${x.tone} · ${plural(x.red_flags.length, "flag")} · read ${x.chars_analyzed.toLocaleString()} of ${x.mda_chars.toLocaleString()} MD&A characters` })),
    secLink(x.source_url, "SEC")));
  const recent = (c.recent_filings ?? []).map((e) => h("div", { class: "li" },
    h("span", { class: "f", text: e.form }),
    h("span", {}, dshort(e.filed), e.items?.length ? h("span", { class: "xs muted", text: ` · ${e.items.map((i) => ITEM_8K[i] ?? i).join(", ")}` }) : null),
    secLink(e.url, "SEC")));
  return h("section", { class: "card" },
    h("div", { class: "card-head" }, h("div", {}, h("h2", { text: "Filings" }), h("p", { text: "Periodic reports the model has read, and the latest filings on EDGAR." }))),
    h("div", { class: "grid-2" },
      h("div", {}, h("div", { class: "mini-h", style: { marginBottom: "10px" }, text: "Analyzed 10-Q and 10-K" }), capped(h("div", { class: "list" }), analyzed, 5, "filings")),
      h("div", {}, h("div", { class: "mini-h", style: { marginBottom: "10px" }, text: "Recent filings on EDGAR" }), capped(h("div", { class: "list" }), recent, 5, "filings"))),
    h("details", { class: "more" }, h("summary", { text: "Data sources and XBRL tags" }),
      h("p", { class: "note", style: { marginTop: 0, marginBottom: "14px" }, text: "Companies tag the same line item differently in XBRL. These are the tags the pipeline matched for this filer." }),
      h("div", { class: "grid-2" },
        h("dl", { class: "kv" }, Object.entries(f?.concepts_used ?? {}).map(([k, v]) => [h("dt", { text: k.replaceAll("_", " ") }), h("dd", { text: v ?? "not reported" })])),
        h("dl", { class: "kv" },
          h("dt", { text: "Fundamentals" }), h("dd", { text: dtime(c.fundamentals_as_of) }),
          h("dt", { text: "MD&A analysis" }), h("dd", { text: dtime(c.qualitative_as_of) }),
          h("dt", { text: "Score" }), h("dd", { text: dtime(sc?.scored_at) }),
          h("dt", { text: "Price" }), h("dd", { text: p ? `${p.date} close (${p.source})` : "–" }),
          h("dt", { text: "Language model" }), h("dd", { text: filings[filings.length - 1]?.model ?? "–" })))));
}

export function viewCompany(t) {
  const c = S.by[t], p = S.px[t], sc = c.score;
  const filings = (c.qualitative?.filings ?? []).filter((x) => x.status === "ok");
  return h("div", { class: "view-in stack" },
    header(c, p, sc),
    researchBrief(c, sc, filings),
    h("div", { class: "split" }, scoreCard(c, sc), priceCard(p)),
    fundamentalsCard(c, sc),
    cashCard(c),
    mdaCard(c, sc, filings),
    notesCard(t),
    filingsCard(c, p, sc, filings));
}

