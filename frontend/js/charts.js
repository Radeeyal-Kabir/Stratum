// Hand-drawn SVG charts. Every chart redraws at its container's width and
// carries a hover layer; colors come from CSS tokens so both themes work.
import { S, bands, navigate } from "./state.js";
import { chip, dshort, h, hideTip, interp, isNum, niceTicks, qlabel, ratingColor, responsive, s, showTip, signed, tipRow } from "./lib.js";

export function sparkline(values, { w = 96, hgt = 26 } = {}) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const X = (i) => 2 + (i / (values.length - 1)) * (w - 6);
  const Y = (v) => 3 + (1 - (v - lo) / (hi - lo || 1)) * (hgt - 6);
  const color = values[values.length - 1] >= values[0] ? "var(--up)" : "var(--down)";
  return s("svg", { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, "aria-hidden": "true", style: "display:block" },
    s("path", { d: values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(""), fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }),
    s("circle", { cx: X(values.length - 1), cy: Y(values[values.length - 1]), r: 2.5, fill: color }));
}

function xAxisLabels(svg, labels, X, y, spacing, alignEnds = true) {
  const last = labels.length - 1;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(spacing / 64))));
  labels.forEach((lb, i) => {
    if (!lb || (i !== last && (i % every || last - i < every))) return;
    const anchor = !alignEnds ? "middle" : i === 0 ? "start" : i === last ? "end" : "middle";
    svg.append(s("text", { x: X(i), y, "text-anchor": anchor, text: lb }));
  });
}

/** Line chart on one shared y axis. series: [{label, color, values: [number|null], endText?, tipFmt?}] */
export function lineChart(el, { series, height = 200, xLabels, yFmt, tipFmt, tipTitle, zero = false, area = false, endLabels = false, padR }) {
  return responsive(el, (W) => {
    const all = series.flatMap((sr) => sr.values).filter(isNum);
    let lo = Math.min(...all), hi = Math.max(...all);
    if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.12 || 1;
    lo = zero && Math.min(...all) >= 0 ? 0 : lo - pad;
    hi += pad;
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0]);
    hi = Math.max(hi, ticks[ticks.length - 1]);
    const n = Math.max(...series.map((sr) => sr.values.length));
    const m = { l: 48, r: padR ?? (endLabels ? 70 : 12), t: 10, b: xLabels ? 26 : 10 };
    const iw = W - m.l - m.r, ih = height - m.t - m.b;
    const X = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const svg = s("svg", { width: W, height, role: "img" });
    const grid = s("g", { class: "grid" });
    for (const t of ticks) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      svg.append(s("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end", text: yFmt(t) }));
    }
    svg.prepend(grid);
    if (zero && lo < 0 && hi > 0) svg.append(s("line", { class: "base", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }));
    if (xLabels) xAxisLabels(svg, xLabels, X, height - 6, iw);

    const ends = [];
    for (const sr of series) {
      const p = sr.values.map((y, i) => ({ i, y })).filter((q) => isNum(q.y));
      if (!p.length) continue;
      const d = p.map((q, k) => `${k ? "L" : "M"}${X(q.i).toFixed(1)},${Y(q.y).toFixed(1)}`).join("");
      if (area) svg.append(s("path", { d: `${d}L${X(p[p.length - 1].i)},${Y(lo)}L${X(p[0].i)},${Y(lo)}Z`, fill: sr.color, opacity: 0.1 }));
      svg.append(s("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const last = p[p.length - 1];
      svg.append(s("circle", { cx: X(last.i), cy: Y(last.y), r: 4, fill: sr.color, stroke: "var(--surface)", "stroke-width": 2 }));
      if (endLabels) ends.push({ x: X(last.i), y: Y(last.y), ly: Y(last.y), text: sr.endText ?? sr.label });
    }
    if (endLabels) {
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].ly - ends[i - 1].ly < 15) ends[i].ly = ends[i - 1].ly + 15;
      for (const e of ends) {
        if (Math.abs(e.ly - e.y) > 2) svg.append(s("path", { d: `M${e.x + 6},${e.y}L${e.x + 12},${e.ly}`, stroke: "var(--line-strong)", fill: "none" }));
        svg.append(s("text", { class: "lbl-strong", x: e.x + 14, y: e.ly + 4, text: e.text }));
      }
    }

    const cross = s("line", { y1: m.t, y2: m.t + ih, stroke: "var(--line-strong)", visibility: "hidden" });
    const dots = series.map((sr) => s("circle", { r: 4.5, fill: sr.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
    svg.append(cross, ...dots);
    const hit = s("rect", { x: m.l - 6, y: 0, width: iw + 12, height, fill: "transparent" });
    hit.addEventListener("pointermove", (ev) => {
      const px = ev.clientX - svg.getBoundingClientRect().left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
      cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
      series.forEach((sr, k) => {
        const y = sr.values[i];
        dots[k].setAttribute("visibility", isNum(y) ? "visible" : "hidden");
        if (isNum(y)) { dots[k].setAttribute("cx", X(i)); dots[k].setAttribute("cy", Y(y)); }
      });
      showTip([h("div", { class: "t", text: tipTitle(i) }),
        ...series.map((sr) => tipRow(sr.label, isNum(sr.values[i]) ? (tipFmt || yFmt)(sr.values[i]) : "–", series.length > 1 ? sr.color : null))],
      ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", () => {
      hideTip();
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    });
    svg.append(hit);
    el.append(svg);
  });
}

export function columnChart(el, { values, labels, height = 200, yFmt, tipTitle, tipRows, color = "var(--s1)" }) {
  return responsive(el, (W) => {
    const ticks = niceTicks(0, Math.max(...values.filter(isNum), 0) * 1.08, 4);
    const hi = ticks[ticks.length - 1];
    const m = { l: 52, r: 8, t: 20, b: 26 };
    const iw = W - m.l - m.r, ih = height - m.t - m.b;
    const band = iw / values.length, bw = Math.min(24, band * 0.6);
    const Y = (v) => m.t + (1 - v / hi) * ih;
    const svg = s("svg", { width: W, height, role: "img" });
    const grid = s("g", { class: "grid" });
    for (const t of ticks) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
      svg.append(s("text", { x: m.l - 8, y: Y(t) + 4, "text-anchor": "end", text: yFmt(t) }));
    }
    svg.append(grid);
    const cx = (i) => m.l + band * i + band / 2;
    values.forEach((v, i) => {
      const last = i === values.length - 1;
      if (isNum(v) && v > 0) {
        const y = Y(v), x = cx(i) - bw / 2, r = Math.min(4, m.t + ih - y);
        svg.append(s("path", { d: `M${x},${m.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${m.t + ih}Z`, fill: color, opacity: last ? 1 : 0.5 }));
        if (last) svg.append(s("text", { class: "lbl-strong", x: cx(i), y: y - 7, "text-anchor": "middle", text: yFmt(v) }));
      }
      const hit = s("rect", { x: cx(i) - band / 2, y: m.t, width: band, height: ih, fill: "transparent" });
      hit.addEventListener("pointermove", (ev) => showTip([h("div", { class: "t", text: tipTitle(i) }), ...tipRows(i)], ev.clientX, ev.clientY));
      hit.addEventListener("pointerleave", hideTip);
      svg.append(hit);
    });
    xAxisLabels(svg, labels, cx, height - 6, iw * 0.9, false);
    svg.append(s("line", { class: "base", x1: m.l, x2: W - m.r, y1: m.t + ih, y2: m.t + ih }));
    el.append(svg);
  });
}

/** Quant score across, qualitative score up, with the composite band edges as diagonals. */
export function scoreMap(el) {
  return responsive(el, (W) => {
    const H = W < 560 ? 300 : 320;
    const m = { l: 50, r: 20, t: 16, b: 46 };
    // The usual frame, widened to whatever the data needs so no company can sit outside the plot.
    const sc = S.companies.filter((c) => c.score?.qualitative).map((c) => c.score);
    const lo = (v, base) => Math.min(base, Math.floor(Math.min(...v) / 10) * 10), hi = (v, base) => Math.max(base, Math.ceil(Math.max(...v) / 10) * 10);
    const xd = [lo(sc.map((x) => x.quant.score), 30), hi(sc.map((x) => x.quant.score), 100)];
    const yd = [lo(sc.map((x) => x.qualitative.score), 20), hi(sc.map((x) => x.qualitative.score), 90)];
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = (v) => m.l + ((v - xd[0]) / (xd[1] - xd[0])) * iw;
    const Y = (v) => m.t + (1 - (v - yd[0]) / (yd[1] - yd[0])) * ih;
    const { quant: wq, qualitative: wl } = S.method.weights;
    const { buy, hold } = bands();
    const yAt = (c, x) => (c - wq * x) / wl;
    const poly = (p) => p.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
    const svg = s("svg", { width: W, height: H, role: "img", "aria-label": "Each company's quant score plotted against its qualitative score" });
    svg.append(s("defs", {}, s("clipPath", { id: "map-clip" }, s("rect", { x: m.l, y: m.t, width: iw, height: ih }))));
    svg.append(s("g", { "clip-path": "url(#map-clip)" },
      s("polygon", { points: poly([[-100, yAt(hold, -100)], [200, yAt(hold, 200)], [-100, -1000]]), fill: "var(--avoid)", opacity: 0.06 }),
      s("polygon", { points: poly([[-100, yAt(buy, -100)], [200, yAt(buy, 200)], [200, 1000], [-100, 1000]]), fill: "var(--buy)", opacity: 0.06 })));
    const grid = s("g", { class: "grid" });
    for (let v = xd[0]; v <= xd[1]; v += 10) {
      grid.append(s("line", { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ih }));
      svg.append(s("text", { x: X(v), y: m.t + ih + 17, "text-anchor": "middle", text: v }));
    }
    for (let v = yd[0]; v <= yd[1]; v += 10) {
      grid.append(s("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v) }));
      svg.append(s("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", text: v }));
    }
    svg.append(grid);
    svg.append(s("text", { class: "axis-title", x: m.l + iw, y: H - 6, "text-anchor": "end", text: "Quant score (fundamentals) →" }));
    svg.append(s("text", { class: "axis-title", x: -m.t, y: 13, transform: "rotate(-90)", "text-anchor": "end", text: "Qualitative score (MD&A) →" }));
    const lines = s("g", { "clip-path": "url(#map-clip)" });
    for (const [c, col] of [[hold, "var(--avoid)"], [buy, "var(--buy)"]]) {
      lines.append(s("line", { x1: X(-100), y1: Y(yAt(c, -100)), x2: X(200), y2: Y(yAt(c, 200)), stroke: col, "stroke-width": 1.5, opacity: 0.75 }));
    }
    svg.append(lines);
    const labelAt = (c, yv) => (c - wl * yv) / wq;
    const ly = yd[1] - 5;  // near the top of the plot, clear of the companies
    svg.append(s("text", { class: "lbl", x: X(labelAt(buy, ly)) + 8, y: Y(ly) + 4, text: `Buy: composite ${buy}+` }));
    if (W >= 480) svg.append(s("text", { class: "lbl", x: X(labelAt(hold, 56)) + 8, y: Y(56) + 4, text: `Avoid below ${hold}` }));

    const pts = S.companies.filter((c) => c.score?.qualitative).map((c) => ({ c, x: X(c.score.quant.score), y: Y(c.score.qualitative.score) }));
    const placed = [];
    const hits = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) ||
      pts.some((p) => p.x > b.x - 6 && p.x < b.x + b.w + 6 && p.y > b.y - 6 && p.y < b.y + b.h + 6);
    const dots = s("g"), labels = s("g");
    for (const p of [...pts].sort((a, b) => b.c.score.composite - a.c.score.composite)) {
      dots.append(s("circle", { cx: p.x, cy: p.y, r: 6, fill: ratingColor(p.c.score.rating), stroke: "var(--surface)", "stroke-width": 2 }));
      if (W < 520) continue;
      const w = p.c.ticker.length * 7.2;
      const spot = [[p.x + 11, p.y - 7], [p.x - 11 - w, p.y - 7], [p.x - w / 2, p.y - 23], [p.x - w / 2, p.y + 10]]
        .map(([x, y]) => ({ x, y, w, h: 14 })).find((b) => !hits(b) && b.x > m.l && b.x + b.w < W - 2);
      if (spot) { placed.push(spot); labels.append(s("text", { class: "lbl", x: spot.x, y: spot.y + 11, text: p.c.ticker })); }
    }
    svg.append(dots, labels);
    const ring = s("circle", { r: 10, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5, visibility: "hidden" });
    svg.append(ring);
    const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
    let hot = null;
    hit.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      hot = null;
      let best = 28;
      for (const p of pts) { const d = Math.hypot(p.x - mx, p.y - my); if (d < best) { best = d; hot = p; } }
      hit.style.cursor = hot ? "pointer" : "default";
      if (!hot) { ring.setAttribute("visibility", "hidden"); hideTip(); return; }
      ring.setAttribute("cx", hot.x); ring.setAttribute("cy", hot.y); ring.setAttribute("visibility", "visible");
      const sc = hot.c.score;
      showTip([h("div", { class: "t", text: `${hot.c.ticker} · ${hot.c.name}` }), h("div", {}, chip(sc)),
        tipRow(`Quant (${Math.round(wq * 100)}%)`, sc.quant.score.toFixed(1), "var(--s1)"),
        tipRow(`Qualitative (${Math.round(wl * 100)}%)`, sc.qualitative.score.toFixed(1), "var(--s2)"),
        h("div", { class: "note xs", text: sc.rationale })], ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); hideTip(); });
    hit.addEventListener("click", () => { if (hot) navigate(hot.c.ticker); });
    svg.append(hit);
    el.append(svg);
  });
}

/** Model tone score per filing, -1 (bearish) to +1 (bullish). */
export function toneChart(el, filings) {
  return responsive(el, (W) => {
    const H = 170, m = { l: 62, r: 14, t: 12, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b, n = filings.length;
    const X = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => m.t + (1 - (v + 1) / 2) * ih;
    const svg = s("svg", { width: W, height: H, role: "img", "aria-label": "Tone by filing, oldest to newest: " + filings.map((f) => f.tone).join(", ") });
    const grid = s("g", { class: "grid" });
    for (const [v, lb] of [[1, "Bullish"], [0, "Neutral"], [-1, "Bearish"]]) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
      svg.append(s("text", { x: m.l - 10, y: Y(v) + 4, "text-anchor": "end", text: lb }));
    }
    svg.append(grid);
    svg.append(s("path", { d: filings.map((f, i) => `${i ? "L" : "M"}${X(i)},${Y(f.tone_score)}`).join(""), fill: "none", stroke: "var(--line-strong)", "stroke-width": 2, "stroke-linejoin": "round" }));
    const col = { bullish: "var(--buy)", neutral: "var(--muted)", bearish: "var(--avoid)" };
    xAxisLabels(svg, filings.map((f) => qlabel(f.period_end)), X, H - 6, iw);
    const slot = iw / Math.max(1, n - 1);
    filings.forEach((f, i) => {
      svg.append(s("circle", { cx: X(i), cy: Y(f.tone_score), r: 5, fill: col[f.tone] ?? "var(--muted)", stroke: "var(--surface)", "stroke-width": 2 }));
      const hit = s("rect", { x: X(i) - slot / 2, y: 0, width: slot, height: H, fill: "transparent" });
      hit.addEventListener("pointermove", (ev) => showTip([h("div", { class: "t", text: `${f.form} · period ending ${dshort(f.period_end)}` }),
        tipRow("Tone", `${f.tone} (${signed(f.tone_score, 2)})`), tipRow("Red flags", String(f.red_flags.length)),
        f.tone_rationale ? h("div", { class: "note", text: f.tone_rationale }) : null], ev.clientX, ev.clientY));
      hit.addEventListener("pointerleave", hideTip);
      svg.append(hit);
    });
    el.append(svg);
  });
}

/** One score.py anchor curve, with a tick for each company's current raw value. */
export function anchorChart(el, anchors, fmt, getRaw) {
  return responsive(el, (W) => {
    const H = 150, m = { l: 34, r: 12, t: 10, b: 24 };
    const span = anchors[anchors.length - 1][0] - anchors[0][0];
    const x0 = anchors[0][0] - span * 0.12, x1 = anchors[anchors.length - 1][0] + span * 0.12;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * iw;
    const Y = (v) => m.t + (1 - v / 100) * ih;
    const clampX = (v) => X(Math.max(x0, Math.min(x1, v)));
    const svg = s("svg", { width: W, height: H, role: "img" });
    const grid = s("g", { class: "grid" });
    for (const v of [0, 50, 100]) {
      grid.append(s("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
      svg.append(s("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", text: v }));
    }
    svg.append(grid);
    const raws = S.companies.map((c) => ({ t: c.ticker, v: getRaw(c) })).filter((r) => isNum(r.v));
    for (const r of raws) svg.append(s("line", { x1: clampX(r.v), x2: clampX(r.v), y1: m.t + ih - 7, y2: m.t + ih, stroke: "var(--s1)", "stroke-width": 1.5, opacity: 0.55 }));
    const line = [[x0, anchors[0][1]], ...anchors, [x1, anchors[anchors.length - 1][1]]];
    svg.append(s("path", { d: line.map(([x, y], i) => `${i ? "L" : "M"}${X(x)},${Y(y)}`).join(""), fill: "none", stroke: "var(--ink-2)", "stroke-width": 2, "stroke-linejoin": "round" }));
    anchors.forEach(([x, y], i) => {
      svg.append(s("circle", { cx: X(x), cy: Y(y), r: 4, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }));
      svg.append(s("text", { x: X(x), y: H - 6, "text-anchor": i === 0 ? "start" : i === anchors.length - 1 ? "end" : "middle", text: fmt(x) }));
    });
    const hit = s("rect", { x: m.l, y: 0, width: iw, height: H, fill: "transparent" });
    hit.addEventListener("pointermove", (ev) => {
      const px = ev.clientX - svg.getBoundingClientRect().left;
      const xv = x0 + ((px - m.l) / iw) * (x1 - x0);
      const near = raws.filter((q) => Math.abs(clampX(q.v) - px) < 6).map((q) => q.t);
      showTip([h("div", { class: "t", text: `${fmt(xv)} scores ${interp(xv, anchors).toFixed(0)}` }),
        near.length ? h("div", { class: "note", text: `Near here: ${near.join(", ")}` }) : null], ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", hideTip);
    svg.append(hit);
    el.append(svg);
  });
}


/**
 * Rule of 40: revenue growth across, FCF margin up, the x + y = 40% line drawn in.
 * Dots are shaded by stock-based pay as a share of revenue. Growth beyond the
 * axis is pinned to the edge and labelled with its real value.
 */
export function ruleOf40Chart(el, points) {
  return responsive(el, (W) => {
    const H = W < 560 ? 320 : 380;
    const m = { l: 52, r: 22, t: 16, b: 46 };
    const xd = [-0.2, 1.2];
    const ys = points.map((p) => p.y);
    const yd = [Math.min(-0.1, Math.floor(Math.min(...ys) * 10) / 10 - 0.05), Math.max(0.5, Math.ceil(Math.max(...ys) * 10) / 10 + 0.05)];
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const X = (v) => m.l + ((Math.max(xd[0], Math.min(xd[1], v)) - xd[0]) / (xd[1] - xd[0])) * iw;
    const Y = (v) => m.t + (1 - (v - yd[0]) / (yd[1] - yd[0])) * ih;
    const svg = s("svg", { width: W, height: H, role: "img", "aria-label": "Revenue growth against free cash flow margin for each company" });
    svg.append(s("defs", {}, s("clipPath", { id: "r40-clip" }, s("rect", { x: m.l, y: m.t, width: iw, height: ih }))));
    // Region above the line: growth + margin of 40% or more.
    svg.append(s("g", { "clip-path": "url(#r40-clip)" },
      s("polygon", { points: [[xd[0] - 1, 0.4 - (xd[0] - 1)], [xd[1] + 1, 0.4 - (xd[1] + 1)], [xd[1] + 1, 10], [xd[0] - 1, 10]].map(([x, y]) => `${m.l + ((x - xd[0]) / (xd[1] - xd[0])) * iw},${Y(y)}`).join(" "), fill: "var(--accent)", opacity: 0.05 }),
      s("line", { x1: m.l + ((-5 - xd[0]) / (xd[1] - xd[0])) * iw, y1: Y(5.4), x2: m.l + ((5 - xd[0]) / (xd[1] - xd[0])) * iw, y2: Y(-4.6), stroke: "var(--accent)", "stroke-width": 1.5, opacity: 0.8 })));
    const grid = s("g", { class: "grid" });
    for (let v = xd[0]; v <= xd[1] + 1e-9; v += 0.2) {
      grid.append(s("line", { x1: X(v), x2: X(v), y1: m.t, y2: m.t + ih }));
      svg.append(s("text", { x: X(v), y: m.t + ih + 17, "text-anchor": "middle", text: `${Math.round(v * 100)}%` }));
    }
    for (let v = Math.ceil(yd[0] * 10) / 10; v <= yd[1] + 1e-9; v += 0.1) {
      grid.append(s("line", { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v) }));
      svg.append(s("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end", text: `${Math.round(v * 100)}%` }));
    }
    svg.insertBefore(grid, svg.children[1]);
    svg.append(s("line", { class: "base", x1: m.l, x2: m.l + iw, y1: Y(0), y2: Y(0) }));
    svg.append(s("text", { class: "axis-title", x: m.l + iw, y: H - 6, "text-anchor": "end", text: "Revenue growth, latest quarter YoY →" }));
    svg.append(s("text", { class: "axis-title", x: -m.t, y: 13, transform: "rotate(-90)", "text-anchor": "end", text: "FCF margin, trailing 12 months →" }));
    const lx = 0.4 - (yd[1] - 0.06);
    svg.append(s("text", { class: "lbl", x: X(Math.max(lx, xd[0])) + 8, y: Y(Math.min(yd[1] - 0.06, 0.4 - xd[0])) + 4, text: "Rule of 40 line" }));

    const placed = [];
    const pts = points.map((p) => ({ ...p, px: X(p.x), py: Y(p.y), pinned: p.x > xd[1] || p.x < xd[0] }));
    const hits = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) ||
      pts.some((p) => p.px > b.x - 6 && p.px < b.x + b.w + 6 && p.py > b.y - 6 && p.py < b.y + b.h + 6);
    const dots = s("g"), labels = s("g");
    for (const p of pts) {
      dots.append(s("circle", { cx: p.px, cy: p.py, r: 6, fill: `var(--h${p.level})`,
        // The lightest level is pale on a white ground; a ring keeps it visible.
        stroke: p.pinned ? "var(--ink)" : p.level === 2 ? "var(--h3)" : "var(--surface)", "stroke-width": p.level === 2 && !p.pinned ? 1.5 : 2 }));
      if (W < 520 && !p.pinned) continue;
      const text = p.pinned ? `${p.t} ${Math.round(p.x * 100)}% →` : p.t;
      const w = text.length * 7;
      const spot = [[p.px + 11, p.py - 7], [p.px - 11 - w, p.py - 7], [p.px - w / 2, p.py - 23], [p.px - w / 2, p.py + 10]]
        .map(([x, y]) => ({ x, y, w, h: 14 })).find((b) => !hits(b) && b.x > m.l && b.x + b.w < W - 2);
      if (spot) { placed.push(spot); labels.append(s("text", { class: "lbl", x: spot.x, y: spot.y + 11, text })); }
    }
    svg.append(dots, labels);
    const ring = s("circle", { r: 10, fill: "none", stroke: "var(--ink)", "stroke-width": 1.5, visibility: "hidden" });
    svg.append(ring);
    const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
    let hot = null;
    hit.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left, my = ev.clientY - r.top;
      hot = null;
      let best = 28;
      for (const p of pts) { const d = Math.hypot(p.px - mx, p.py - my); if (d < best) { best = d; hot = p; } }
      hit.style.cursor = hot ? "pointer" : "default";
      if (!hot) { ring.setAttribute("visibility", "hidden"); hideTip(); return; }
      ring.setAttribute("cx", hot.px); ring.setAttribute("cy", hot.py); ring.setAttribute("visibility", "visible");
      showTip([h("div", { class: "t", text: `${hot.t} · ${hot.name}` }),
        tipRow("Revenue growth", `${(hot.x * 100).toFixed(1)}%`), tipRow("FCF margin", `${(hot.y * 100).toFixed(1)}%`),
        tipRow("Rule of 40 total", `${Math.round((hot.x + hot.y) * 100)}`), tipRow("Stock pay / revenue", `${(hot.sbc * 100).toFixed(1)}%`)],
      ev.clientX, ev.clientY);
    });
    hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); hideTip(); });
    hit.addEventListener("click", () => { if (hot) navigate(hot.t); });
    svg.append(hit);
    el.append(svg);
  });
}
