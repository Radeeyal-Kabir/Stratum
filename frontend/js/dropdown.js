// A themed dropdown in place of the browser's <select>, whose open list can't be styled and is
// unreadable in dark mode. It behaves like a select for the code that uses it: `.value`,
// `.disabled`, and "input"/"change" events fired on the element when the choice changes.
import { h, s } from "./lib.js";

let uid = 0;

export function dropdown({ id, label, options, value = "", disabled = false }) {
  const listId = `dd-list-${++uid}`;
  const btn = h("button", { type: "button", class: "dd-btn", id, "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": listId, "aria-label": label });
  const text = h("span", { class: "dd-text" });
  btn.append(text, s("svg", { class: "dd-chev", width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" },
    s("path", { d: "M2.5 4.5 6 8l3.5-3.5", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" })));
  const list = h("ul", { class: "dd-list", role: "listbox", id: listId, tabindex: "-1", hidden: true, "aria-label": label });
  const root = h("div", { class: "dd" }, btn, list);
  let current = value, active = -1;

  const items = options.map((o) => h("li", { class: "dd-opt", role: "option", "data-value": o.value, text: o.text }));
  list.append(...items);

  const textOf = (v) => options.find((o) => o.value === v)?.text ?? options[0]?.text ?? "";
  const paint = () => {
    text.textContent = textOf(current);
    items.forEach((li) => li.setAttribute("aria-selected", String(li.dataset.value === current)));
    root.classList.toggle("placeholder", current === (options[0]?.value ?? ""));
  };
  const setActive = (i) => {
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((li, k) => li.classList.toggle("active", k === active));
    items[active]?.scrollIntoView({ block: "nearest" });
  };
  const open = () => {
    if (btn.disabled || !list.hidden) return;
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const r = btn.getBoundingClientRect();
    root.classList.toggle("up", innerHeight - r.bottom < 300 && r.top > innerHeight - r.bottom);
    setActive(Math.max(0, items.findIndex((li) => li.dataset.value === current)));
    document.addEventListener("pointerdown", outside, true);
  };
  const close = (focus = false) => {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    if (focus) btn.focus();
  };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  const choose = (v) => {
    const changed = v !== current;
    current = v;
    paint();
    close(true);
    if (changed) for (const type of ["input", "change"]) root.dispatchEvent(new Event(type));
  };

  btn.addEventListener("click", () => (list.hidden ? open() : close()));
  list.addEventListener("click", (e) => { const li = e.target.closest(".dd-opt"); if (li) choose(li.dataset.value); });
  list.addEventListener("mousemove", (e) => { const li = e.target.closest(".dd-opt"); if (li) setActive(items.indexOf(li)); });
  btn.addEventListener("keydown", (e) => {
    const isOpen = !list.hidden;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key) && !isOpen) { e.preventDefault(); open(); return; }
    if (!isOpen) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(items.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(items[active].dataset.value); }
    else if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close();
    else if (e.key.length === 1) {
      const i = items.findIndex((li, k) => k > active && li.textContent.toLowerCase().startsWith(e.key.toLowerCase()));
      setActive(i >= 0 ? i : items.findIndex((li) => li.textContent.toLowerCase().startsWith(e.key.toLowerCase())));
    }
  });

  Object.defineProperty(root, "value", { get: () => current, set: (v) => { current = v; paint(); } });
  Object.defineProperty(root, "disabled", { get: () => btn.disabled, set: (v) => { btn.disabled = !!v; root.classList.toggle("disabled", !!v); } });
  root.disabled = disabled;
  paint();
  return root;
}
