import { S, load, setNavigator } from "./state.js";
import { chip, h, hideTip, releaseCharts, s, store } from "./lib.js";
import { logo } from "./identity.js";
import { viewOverview } from "./views/overview.js";
import { viewScreener } from "./views/screener.js";
import { viewCompany } from "./views/company.js";
import { viewFilingDiff } from "./views/filing-diff.js";
import { viewCompare } from "./views/compare.js";
import { viewMethod } from "./views/method.js";

const PAGES = { overview: viewOverview, screener: viewScreener, compare: viewCompare, method: viewMethod };
const view = document.getElementById("view");

// ------------------------------------------------------------ router
const currentRoute = () => decodeURIComponent(location.hash.slice(1)) || "overview";

function render(route) {
  releaseCharts();
  hideTip();
  const [head, sub] = route.split("/");
  const ticker = head.toUpperCase();
  const key = S.by[ticker] ? ticker : PAGES[route] ? route : "overview";
  view.replaceChildren(S.by[key] ? (sub === "changes" ? viewFilingDiff(key) : viewCompany(key)) : PAGES[key]());
  const navKey = S.by[key] ? "screener" : key;
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.dataset.nav === navKey) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = S.by[key] ? `${key}${sub === "changes" ? " filing changes" : ""} · ${S.by[key].name} · Stratum` : "Stratum · S&P 500 technology research";
}

function navigate(route) {
  if (currentRoute() !== route) history.pushState(null, "", "#" + route);
  render(route);
  window.scrollTo({ top: 0 });
  view.focus({ preventScroll: true });
}
setNavigator(navigate);

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-go]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.dataset.go);
});
addEventListener("popstate", () => render(currentRoute()));

// ------------------------------------------------------------ command palette
function openPalette() {
  if (document.querySelector(".pal-bg")) return;
  const opener = document.activeElement;
  let sel = 0;
  let items = S.ranked;
  const input = h("input", { id: "palette-q", type: "search", placeholder: "Jump to a company…", "aria-label": "Search companies", autocomplete: "off" });
  const list = h("ul", { role: "listbox", "aria-label": "Companies" });
  const bg = h("div", { class: "pal-bg" },
    h("div", { class: "pal", role: "dialog", "aria-modal": "true", "aria-label": "Search companies" },
      input, list, h("div", { class: "foot", text: "↑ ↓ to move · Enter to open · Esc to close" })));
  const close = () => { bg.remove(); document.removeEventListener("keydown", onKey, true); opener?.focus?.(); };
  const go = (t) => { close(); navigate(t); };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    items = S.ranked.filter((c) => !q || c.ticker.toLowerCase().startsWith(q) || `${c.name} ${c.sub_sector}`.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...(items.length
      ? items.map((c, i) => h("li", { role: "option", "aria-selected": String(i === sel), onclick: () => go(c.ticker) },
        h("span", { class: "palette-company" }, logo(c.ticker), h("span", { class: "tk", text: c.ticker })), h("span", {}, c.name, h("br"), h("span", { class: "sec", text: c.sub_sector })), chip(c.score)))
      : [h("li", { class: "muted", text: "No company matches." })]));
    list.children[sel]?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === "Enter" && items[sel]) { e.preventDefault(); go(items[sel].ticker); }
  };
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  list.addEventListener("pointermove", (e) => {
    const i = [...list.children].indexOf(e.target.closest("li"));
    if (i >= 0 && i !== sel) { sel = i; paint(); }
  });
  input.addEventListener("input", () => { sel = 0; paint(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(bg);
  paint();
  input.focus();
}
document.getElementById("open-search").addEventListener("click", openPalette);
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    openPalette();
  }
});

// ------------------------------------------------------------ theme
const THEMES = ["system", "light", "dark"];
const ICONS = {
  system: "M4 5h16v11H4zM9 20h6M12 16v4",
  light: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  dark: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
};
let theme = store.get("theme", "system");
function applyTheme() {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  const b = document.getElementById("theme-btn");
  b.replaceChildren(s("svg", { width: 17, height: 17, viewBox: "0 0 24 24", "aria-hidden": "true" },
    s("path", { d: ICONS[theme], fill: theme === "dark" ? "currentColor" : "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" })));
  b.title = `Theme: ${theme}. Click to switch.`;
  b.setAttribute("aria-label", b.title);
}
document.getElementById("theme-btn").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store.set("theme", theme);
  applyTheme();
});
applyTheme();

// ------------------------------------------------------------ boot
async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

try {
  const [doc, prices, method] = await Promise.all(["data/companies.json", "data/prices.json", "data/methodology.json"].map(loadJson));
  load(doc, prices, method);
  if (!S.companies.some((c) => c.score)) {
    view.replaceChildren(h("p", { class: "empty", text: "No scores yet. Run the Backfill workflow (Actions → Backfill → Run workflow) to seed the data." }));
  } else {
    render(currentRoute());
  }
} catch (err) {
  view.replaceChildren(h("p", { class: "empty", text: `Couldn't load the data (${err.message}). Reload the page to try again.` }));
}
