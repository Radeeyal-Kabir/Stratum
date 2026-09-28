// Side-by-side MD&A comparison: the filing's own words first, the model's reading
// kept apart. Built by screener/filing_diff.py; loaded only when this page opens.
import { S } from "../state.js";
import { dshort, flagName, h, link, secLink } from "../lib.js";

const TOPIC_LABEL = { guidance: "Guidance", demand: "Demand", margins: "Margins", liquidity: "Liquidity", capacity: "Capacity" };
const KIND_LABEL = { revised: "Revised", added: "New", removed: "Removed", figures: "Figures updated", boilerplate: "Boilerplate" };
const cache = new Map();

export async function loadDiff(t) {
  if (!cache.has(t)) {
    cache.set(t, fetch(`data/diffs/${t}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(t);
}

/** Long unchanged stretches are shortened so the eye lands on what moved. */
function elide(text, keep = 14) {
  const w = text.split(" ");
  return w.length > keep * 2 + 6 ? `${w.slice(0, keep).join(" ")} … ${w.slice(-keep).join(" ")}` : text;
}

function side(ops, show) {
  const parts = ops.filter(([op]) => op === "=" || op === show);
  return parts.flatMap(([op, text], i) => [i ? " " : "",
    op === "=" ? (parts.length > 1 ? elide(text) : text) : h(show === "+" ? "ins" : "del", { text })]);
}

const fullText = (item, which) => item.text ?? item.diff.filter(([op]) => op === "=" || op === which).map(([, t]) => t).join(" ");

function itemCard(item, doc) {
  const { previous: p, current: c } = doc;
  const col = (label, body, url, snippet, empty) => h("div", { class: `fd-col${empty ? " empty" : ""}` },
    h("div", { class: "fd-col-head" }, h("span", { text: label }), url && snippet ? secLink(url, "Find in filing", snippet) : null),
    h("p", {}, body));
  const prevLabel = `${p.form} · ${dshort(p.filed)}`, curLabel = `${c.form} · ${dshort(c.filed)}`;
  let left, right;
  // A passage on one side only takes the full width; its header says which side.
  if (item.kind === "added") {
    left = col(`Only in the current filing · ${curLabel}`, h("ins", { text: item.text }), c.source_url, item.text);
  } else if (item.kind === "removed") {
    left = col(`Only in the previous filing · ${prevLabel}`, h("del", { text: item.text }), p.source_url, item.text);
  } else if (item.diff) {
    left = col(prevLabel, side(item.diff, "-"), p.source_url, fullText(item, "-"));
    right = col(curLabel, side(item.diff, "+"), c.source_url, fullText(item, "+"));
  } else {
    left = col(prevLabel, "—", null, null, true);
    right = col(curLabel, item.text, c.source_url, item.text);
  }
  return h("article", { class: `fd-item ${item.kind}` },
    h("div", { class: "fd-tags" }, h("span", { class: `fd-kind ${item.kind}`, text: KIND_LABEL[item.kind] }),
      item.topics.map((t) => h("span", { class: "fd-topic", text: TOPIC_LABEL[t] ?? t }))),
    h("div", { class: `fd-cols${right ? "" : " single"}` }, left, right ?? null));
}

function modelReading(t, doc) {
  const byAcc = Object.fromEntries((S.by[t].qualitative?.filings ?? []).map((f) => [f.accession, f]));
  const cell = (meta) => {
    const f = byAcc[meta.accession];
    if (!f || f.status !== "ok") return h("div", {}, h("span", { class: "k", text: `${meta.form} · ${dshort(meta.filed)}` }), h("span", { class: "muted", text: "Not analyzed" }));
    return h("div", {}, h("span", { class: "k", text: `${meta.form} · ${dshort(meta.filed)}` }),
      h("span", {}, h("span", { class: `tone-pill ${f.tone}`, text: f.tone })),
      h("span", { class: "fd-cats", text: f.red_flags.length ? f.red_flags.map((r) => flagName(r.category)).join(" · ") : "No flags detected in assessed text" }));
  };
  return h("section", { class: "card fd-model" },
    h("div", { class: "card-head" }, h("div", {}, h("p", { class: "section-kicker", text: "MODEL INTERPRETATION" }),
      h("h2", { text: "How the model read these two filings" }),
      h("p", { text: "Tone and risk categories assigned by the language model. They are its interpretation, based on part of each MD&A, and are shown separately from the filing text on this page." }))),
    h("div", { class: "fd-model-grid" }, cell(doc.previous), cell(doc.current)));
}

function render(root, t, doc) {
  const st = { topic: "all" };
  const { previous: p, current: c, counts } = doc;
  const list = h("div", { class: "fd-list" });
  const filterBtns = h("div", { class: "seg", role: "group", "aria-label": "Topic" });
  const topicCount = (k) => doc.items.filter((i) => ["revised", "added", "removed"].includes(i.kind) && (k === "all" || i.topics.includes(k))).length;
  const paint = () => {
    filterBtns.replaceChildren(...["all", ...Object.keys(TOPIC_LABEL)].map((k) => h("button", {
      type: "button", "aria-pressed": String(st.topic === k), text: `${k === "all" ? "All" : TOPIC_LABEL[k]} ${topicCount(k)}`,
      onclick: () => { st.topic = k; paint(); } })));
    const match = (i) => st.topic === "all" || i.topics.includes(st.topic);
    const substantive = doc.items.filter((i) => ["revised", "added", "removed"].includes(i.kind) && match(i));
    const key = substantive.filter((i) => i.key), other = substantive.filter((i) => !i.key);
    const figures = doc.items.filter((i) => i.kind === "figures" && match(i));
    const boiler = doc.items.filter((i) => i.kind === "boilerplate" && match(i));
    // Long groups start with their most substantial items and reveal the rest on request.
    const group = (title, sub, items, open = true, first = 12) => {
      if (!items.length) return null;
      const body = h("div", {}, items.slice(0, first).map((i) => itemCard(i, doc)));
      const more = items.length > first ? h("button", { type: "button", class: "btn fd-more", text: `Show ${items.length - first} more`,
        onclick: (e) => { body.append(...items.slice(first).map((i) => itemCard(i, doc))); e.currentTarget.remove(); } }) : null;
      return h("details", { class: "fd-group", open },
        h("summary", {}, h("span", { text: title }), h("span", { class: "muted", text: ` ${items.length}` })),
        sub ? h("p", { class: "note", text: sub }) : null, body, more);
    };
    list.replaceChildren(
      group("Guidance, demand, margins, liquidity and capacity", "Changed passages that touch these topics, largest changes first.", key),
      group("Other changed passages", null, other, key.length === 0),
      group("Figures updated", "Same wording with new numbers, dates or period names. Guidance with new figures appears above.", figures, false),
      group("Boilerplate", "Safe-harbor and accounting-standards text that changed.", boiler, false),
      !key.length && !other.length && !figures.length ? h("p", { class: "empty", text: "No changed passages on this topic." }) : null);
  };
  paint();
  const stat = (n, label) => h("div", {}, h("strong", { text: n }), h("span", { text: label }));
  root.replaceChildren(
    h("section", { class: "card fd-summary" },
      h("div", { class: "fd-pair" },
        h("div", {}, h("span", { class: "k", text: "Previous" }), h("strong", { text: `${p.form} filed ${dshort(p.filed)}` }), h("span", { class: "muted", text: `Period ending ${dshort(p.period_end)}` }), secLink(p.source_url, "Filing on SEC.gov")),
        h("span", { class: "fd-arrow", "aria-hidden": "true", text: "→" }),
        h("div", {}, h("span", { class: "k", text: "Current" }), h("strong", { text: `${c.form} filed ${dshort(c.filed)}` }), h("span", { class: "muted", text: `Period ending ${dshort(c.period_end)}` }), secLink(c.source_url, "Filing on SEC.gov"))),
      h("div", { class: "fd-stats" }, stat(counts.revised, "revised"), stat(counts.added, "new"), stat(counts.removed, "removed"),
        stat(counts.figures, "figures only"), stat(counts.unchanged, "unchanged, hidden")),
      h("p", { class: "note", text: `Compares the MD&A prose of two ${c.form} filings paragraph by paragraph. Tables aren't compared. Paragraphs that only moved are treated as unchanged. Deleted words are struck through on the left; added words are highlighted on the right.` })),
    h("div", { class: "fd-toolbar" }, filterBtns),
    list,
    modelReading(t, doc));
}

export function viewFilingDiff(t) {
  const c = S.by[t];
  const body = h("div", { class: "stack" }, h("p", { class: "muted", text: "Loading the comparison…" }));
  loadDiff(t).then((doc) => {
    if (!doc) body.replaceChildren(h("section", { class: "card" }, h("p", { class: "empty", text: "No filing comparison yet. It's built when the company next files, or by the Filing comparisons workflow." })));
    else render(body, t, doc);
  });
  return h("div", { class: "view-in stack" },
    h("div", { style: { display: "grid", gap: "10px" } },
      h("div", { class: "crumbs" }, link("screener", {}, "Screener"), h("span", { text: "/" }), link(t, {}, t), h("span", { text: "/" }), h("span", { text: "Filing changes" })),
      h("p", { class: "eyebrow", text: `${t} / FILING COMPARISON` }),
      h("h1", { class: "page-title", text: `What changed in ${c.name}'s filing` }),
      h("p", { class: "ink2", style: { maxWidth: "68ch" }, text: "The filing's own words, previous against current. Nothing on this page is scored; the model's reading is shown separately at the end." })),
    body);
}

export const changedCount = (doc) => (doc ? doc.counts.revised + doc.counts.added + doc.counts.removed : 0);
