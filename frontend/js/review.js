// Review page for the red-flag benchmark labels. Verdicts stay in this browser until exported.
import { h } from "./lib.js";

const KEY = "stratum-review-v1";
const LABELS = [["supported", "sup", "Supported", "s"], ["ambiguous", "amb", "Ambiguous", "a"], ["unsupported", "uns", "Unsupported", "u"]];
const CATS = (c) => c.replaceAll("_", " ");

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode: verdicts live until the page closes */ } };

const straight = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The passage with the quoted words highlighted, when they can be found in it. */
function passageNodes(it) {
  if (!it.passage) return ["(No surrounding text was stored for this one. Use the filing link.)"];
  const p = straight(it.passage).toLowerCase(), q = straight(it.quote).toLowerCase().replace(/\s+/g, " ").trim();
  const at = p.indexOf(q);
  if (at < 0) return [it.passage];
  return [it.passage.slice(0, at), h("mark", { text: it.passage.slice(at, at + q.length) }), it.passage.slice(at + q.length)];
}

const state = { verdicts: load(), filter: "todo", reveal: false, items: [], current: 0 };

function visible() {
  const v = state.verdicts;
  return state.items.filter((i) => state.filter === "all" ? true
    : state.filter === "todo" ? !v[i.id]
    : state.filter === "done" ? !!v[i.id]
    : v[i.id] && v[i.id].label !== i.draft_label);
}

function exportFile() {
  const body = { reviewed_at: new Date().toISOString(), verdicts: state.verdicts };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const a = h("a", { href: url, download: "label-verdicts.json" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function card(it, isCurrent) {
  const v = state.verdicts[it.id];
  const set = (label) => {
    state.verdicts[it.id] = { label, comment: state.verdicts[it.id]?.comment ?? "" };
    save(state.verdicts); paint();
  };
  const comment = h("input", { class: "rv-comment", type: "text", placeholder: "Optional comment", value: v?.comment ?? "", "aria-label": "Comment" });
  comment.addEventListener("change", () => {
    if (!state.verdicts[it.id]) return;
    state.verdicts[it.id].comment = comment.value; save(state.verdicts);
  });
  const differs = v && state.reveal && v.label !== it.draft_label;
  return h("article", { class: `rv-card${isCurrent ? " current" : ""}`, id: `c-${it.id}` },
    h("div", { class: "rv-head" }, h("strong", { text: `${it.ticker} · ${it.form}` }), h("span", { text: `filed ${it.filed}` }),
      h("span", { class: "rv-cat", text: CATS(it.category) }), h("span", { text: it.id })),
    it.summary ? h("p", { class: "rv-claim" }, h("b", { text: "The model's summary: " }), it.summary) : null,
    h("blockquote", { class: "rv-q", text: `“${it.quote}”` }),
    h("p", { class: "rv-ask" }, `Does the highlighted text show a problem of the kind "${CATS(it.category)}" for ${it.ticker} in this period? A rise in something good, a possible future risk, or a different kind of problem is not supported.`),
    h("div", { class: "rv-passage" }, ...passageNodes(it)),
    h("div", { class: "rv-actions" },
      LABELS.map(([label, cls, text, key]) => h("button", { type: "button", class: `btn ${cls}`, "aria-pressed": String(v?.label === label), onclick: () => set(label) }, `${text} `, h("kbd", { text: key }))),
      it.source_url ? h("a", { href: it.source_url, target: "_blank", rel: "noopener", text: "Open the filing ↗" }) : null),
    comment,
    state.reveal ? h("div", { class: `rv-draft${differs ? " differs" : ""}` },
      h("b", { text: `My draft label: ${it.draft_label}. ` }), it.draft_note ? `${it.draft_note.replace(/\.?$/, ".")} ` : "",
      it.draft_better_category ? ` (I thought it belonged under ${CATS(it.draft_better_category)}.)` : "",
      it.raised_by?.length ? ` Raised by prompt ${it.raised_by.join(", ")}.` : "") : null);
}

function paint() {
  const root = document.getElementById("rv");
  const done = Object.keys(state.verdicts).length, total = state.items.length;
  const list = visible();
  state.current = Math.min(state.current, Math.max(0, list.length - 1));
  const seg = (id, text) => h("button", { type: "button", "aria-pressed": String(state.filter === id), text, onclick: () => { state.filter = id; state.current = 0; paint(); } });
  const revealBox = h("input", { type: "checkbox", checked: state.reveal, onchange: (e) => { state.reveal = e.target.checked; paint(); } });
  const file = h("input", { type: "file", accept: "application/json", hidden: true });
  file.addEventListener("change", async () => {
    try { const d = JSON.parse(await file.files[0].text()); Object.assign(state.verdicts, d.verdicts ?? d); save(state.verdicts); paint(); }
    catch { alert("That file isn't a verdicts export."); }
  });
  root.replaceChildren(
    h("h1", { text: "Check my red-flag labels" }),
    h("p", { class: "lede" }, "Each card is a flag the language model raised. Read the quote in its surrounding text and decide whether it really shows that kind of problem. My own label is hidden until you tick the box, so it doesn't sway you. Your verdicts are saved in this browser; export them when you're done and I'll rerun the published accuracy numbers with your labels."),
    h("div", { class: "rv-bar" },
      h("span", { class: "rv-progress", text: `${done} of ${total}` }), h("span", { class: "rv-prog-bar" }, h("i", { style: { width: `${(done / total) * 100}%` } })),
      h("div", { class: "seg", role: "group", "aria-label": "Show" }, seg("todo", "To review"), seg("done", "Reviewed"), seg("diff", "Differs from mine"), seg("all", "All")),
      h("label", {}, revealBox, "Show my draft labels"),
      h("button", { type: "button", class: "btn", text: "Export verdicts", onclick: exportFile }),
      h("button", { type: "button", class: "btn", text: "Import", onclick: () => file.click() }), file),
    ...(list.length ? list.map((it, i) => card(it, i === state.current))
      : [h("p", { class: "rv-empty", text: state.filter === "todo" ? "Nothing left to review. Export your verdicts." : "Nothing here." })]),
    h("p", { class: "rv-note", text: "Keys: s supported · a ambiguous · u unsupported (applies to the outlined card and moves on) · j and k move between cards." }));
  // Bring the quoted words into view inside each scrolling passage.
  for (const box of root.querySelectorAll(".rv-passage")) {
    const m = box.querySelector("mark");
    if (m) box.scrollTop = Math.max(0, m.offsetTop - box.offsetTop - box.clientHeight / 3);
  }
  document.querySelector(".rv-card.current")?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const list = visible(), it = list[state.current];
  if (e.key === "j") { state.current = Math.min(list.length - 1, state.current + 1); paint(); }
  else if (e.key === "k") { state.current = Math.max(0, state.current - 1); paint(); }
  else if (it) {
    const hit = LABELS.find(([, , , key]) => key === e.key);
    if (hit) {
      state.verdicts[it.id] = { label: hit[0], comment: state.verdicts[it.id]?.comment ?? "" };
      save(state.verdicts); paint();
    }
  }
});

fetch("data/review.json").then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then((items) => { state.items = items; paint(); })
  .catch((err) => { document.getElementById("rv").replaceChildren(h("p", { class: "rv-empty", text: `Couldn't load the review set (${err.message}).` })); });
