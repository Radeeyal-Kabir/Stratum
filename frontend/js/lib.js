// DOM builders, formatters, tooltip and small shared UI pieces.


export const FLAG = {
  demand_weakness: "Demand weakness", margin_pressure: "Margin pressure", pricing_pressure: "Pricing pressure",
  supply_chain: "Supply chain", inventory_buildup: "Inventory build-up", customer_concentration: "Customer concentration",
  competition: "Competition", export_controls_geopolitical: "Export controls", regulatory_legal: "Regulatory / legal",
  liquidity_debt: "Liquidity / debt", restructuring_layoffs: "Restructuring", impairment_writedown: "Impairment",
  accounting_controls: "Accounting / controls", guidance_cut: "Guidance cut", macro_fx: "Macro / FX", other: "Other",
};
export const flagName = (c) => FLAG[c] ?? c.replaceAll("_", " ");
// EDGAR labels most 8-K items; these are the codes it leaves bare.
export const ITEM_8K = {
  "Item 1.02": "Agreement terminated", "Item 2.03": "Debt obligation", "Item 3.02": "Unregistered equity sale",
  "Item 3.03": "Change to holder rights", "Item 5.03": "Bylaw amendment",
};
export const PART_LABEL = {
  revenue_growth: "Revenue growth", net_margin: "Net margin", leverage: "Leverage", liquidity: "Liquidity",
  tone: "Tone", red_flags: "Red flags",
};

export function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith("--")) n.style.setProperty(sk, sv);
        else n.style[sk] = sv;
      }
    } else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

const NS = "http://www.w3.org/2000/svg";
export function s(tag, attrs, ...kids) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c) n.append(c);
  return n;
}

// ------------------------------------------------------------ formatting
const MINUS = "−";
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export function pct(v, d = 1, sign = false) {
  if (!isNum(v)) return "–";
  return (v < 0 ? MINUS : sign && v > 0 ? "+" : "") + Math.abs(v * 100).toFixed(d) + "%";
}
export function pts(v, d = 1) {
  if (!isNum(v)) return "–";
  return (v < 0 ? MINUS : v > 0 ? "+" : "") + Math.abs(v * 100).toFixed(d) + " pts";
}
export const fx = (v, d = 2) => (isNum(v) ? v.toFixed(d) : "–");
export const signed = (v, d = 2) => (!isNum(v) ? "–" : (v < 0 ? MINUS : v > 0 ? "+" : "") + Math.abs(v).toFixed(d));
export const usd = (v) => (isNum(v) ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "–");
export function bil(v) {
  if (!isNum(v)) return "–";
  const sign = v < 0 ? "\u2212" : "", a = Math.abs(v);
  return sign + (a >= 1e12 ? `$${(a / 1e12).toFixed(2)}T` : `$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`);
}
export const dirc = (v) => (!isNum(v) || v === 0 ? "flat" : v > 0 ? "up" : "down");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dshort(iso) { const [y, m, d] = iso.slice(0, 10).split("-"); return `${MONTHS[+m - 1]} ${+d}, ${y}`; }
export function mday(iso) { const [, m, d] = iso.slice(0, 10).split("-"); return `${MONTHS[+m - 1]} ${+d}`; }
export function qlabel(iso) { const [y, m] = iso.slice(0, 10).split("-"); return `${MONTHS[+m - 1]} ’${y.slice(2)}`; }
export function dtime(iso) {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function interp(x, a) {
  if (x <= a[0][0]) return a[0][1];
  if (x >= a[a.length - 1][0]) return a[a.length - 1][1];
  for (let i = 0; i < a.length - 1; i++) {
    const [x0, y0] = a[i], [x1, y1] = a[i + 1];
    if (x >= x0 && x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return a[a.length - 1][1];
}

export function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= n) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem("ts:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ts:" + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

// ------------------------------------------------------------ small components
export const ratingColor = (r) => `var(--${(r || "hold").toLowerCase()})`;
export const RATING_BASIS = "Based on fundamentals and filing analysis; valuation is assessed separately.";
export function chip(score, withNum = true) {
  if (!score) return h("span", { class: "tag", text: "Not rated" });
  return h("span", { class: `chip ${score.rating}` }, score.rating, withNum ? h("span", { class: "sc", text: score.composite.toFixed(1) }) : null);
}
export const link = (route, attrs, ...kids) => h("a", { href: "#" + route, "data-go": route, ...attrs }, ...kids);
/**
 * Adds a text fragment (#:~:text=start,end) so supporting browsers scroll to and
 * highlight the quote; others just open the filing. Anchors only on runs of plain
 * words: the filing's HTML may use curly quotes where the model's text has straight ones.
 */
export function quoteUrl(u, quote) {
  // Stored quotes can be cut mid-word at either end; fragments only match whole words.
  const words = String(quote ?? "").split(/\s+/).filter(Boolean).slice(1, -1);
  const plain = (w) => /^[\w$%.,;:()/-]+$/.test(w);
  const run = (list, n) => {
    for (let i = 0; i + n <= list.length; i++) if (list.slice(i, i + n).every(plain)) return list.slice(i, i + n);
    return null;
  };
  const enc = (ws) => encodeURIComponent(ws.join(" ").replace(/^[.,;:()]+|[.,;:()]+$/g, "")).replace(/[-,&]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  const start = run(words, Math.min(5, words.length));
  if (!start || words.length < 4) return u;
  if (words.length <= 10) return `${u}#:~:text=${enc(start.length === words.length ? words : start)}`;
  const end = run([...words].reverse(), 5)?.reverse();
  return `${u}#:~:text=${enc(start)}${end && end.join(" ") !== start.join(" ") ? "," + enc(end) : ""}`;
}

export function secLink(u, text, quote, cls = "small") {
  if (typeof u !== "string" || !u.startsWith("https://www.sec.gov/")) return null;
  return h("a", { href: quote ? quoteUrl(u, quote) : u, target: "_blank", rel: "noopener", class: cls, text: `${text} ↗` });
}
/** Shows the first `n` children and a button that reveals the rest. */
export function capped(container, items, n, noun) {
  if (items.length <= n) { container.append(...items); return [container]; }
  container.append(...items.slice(0, n));
  const btn = h("button", { type: "button", class: "linkbtn", text: `Show all ${items.length} ${noun}` });
  btn.addEventListener("click", () => { container.append(...items.slice(n)); btn.remove(); });
  return [container, btn];
}

// ------------------------------------------------------------ tooltip
let tip;
export function showTip(nodes, x, y) {
  tip ??= document.getElementById("tip");
  tip.replaceChildren(...nodes.filter(Boolean));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 16, top = y + 16;
  if (left + r.width > innerWidth - 8) left = x - r.width - 16;
  if (top + r.height > innerHeight - 8) top = y - r.height - 16;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
}
export function hideTip() { (tip ??= document.getElementById("tip")).hidden = true; }
export const tipRow = (k, v, key) =>
  h("div", { class: "r" }, h("span", {}, key ? h("i", { class: "k", style: { background: key } }) : null, k), h("b", { text: v }));

// ------------------------------------------------------------ responsive drawing
let observers = [];
/** Calls draw(width) now and whenever the element's width changes. */
export function responsive(el, draw) {
  let last = 0;
  const ro = new ResizeObserver((entries) => {
    const w = Math.floor(entries[0].contentRect.width);
    if (w > 0 && Math.abs(w - last) > 2) { last = w; el.replaceChildren(); draw(w); }
  });
  ro.observe(el);
  observers.push(ro);
  return el;
}
export function releaseCharts() { observers.forEach((o) => o.disconnect()); observers = []; }

/** Why a rating moved, so a better reading of a filing isn't taken for a better company. Entries made before causes were recorded have none. */
export const CAUSE_TEXT = {
  new_filing: "After a new filing",
  new_financials: "After updated financial data",
  reanalysis: "From re-reading an existing filing (a method update), not new company results",
  other: "Cause not determined",
};
