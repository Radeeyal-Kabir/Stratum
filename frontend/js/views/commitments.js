// Management commitments: dated milestones, capital plans and quantified outlooks, copied
// from each filing and followed across a company's filings. Built by screener/commitments.py.
// Nothing here is scored or interpreted; a revision is just the earlier wording next to the later.
import { dshort, h, plural, secLink } from "../lib.js";
import { isTracked, toggleTracked } from "../digest.js";

const STATUS = {
  revised: ["Revised", "The date or figure changed between filings"],
  new: ["New", "First stated in the latest filing"],
  unchanged: ["Repeated", "Stated the same way in each filing since it first appeared"],
  not_repeated: ["Not repeated", "In an earlier filing, absent from the latest one"],
};
const KIND = { milestone: "Milestone", capital: "Capital plan", outlook: "Outlook" };
let cache;

export function loadCommitments() {
  cache ??= fetch("data/commitments.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return cache;
}

/** Deleted words struck, added words highlighted, for a statement that changed. */
function diffNodes(ops) {
  return ops.flatMap(([op, text], i) => [i ? " " : "", op === "=" ? text : h(op === "+" ? "ins" : "del", { text })]);
}

const filingLabel = (s) => `${s.form} · ${dshort(s.filed)}`;

function chainItem(ch, t) {
  const [label, hint] = STATUS[ch.status];
  const st = ch.statements, last = st[st.length - 1];
  const find = (s) => secLink(s.source_url, "Find in filing", s.quote);
  let body;
  if (ch.status === "revised") {
    // Show each revision as a change from the one before: the deleted words belong to the earlier statement.
    body = st.map((s, i) => {
      const text = s.change === "revised" && s.diff ? diffNodes(s.diff) : s.quote;
      return h("div", { class: `cm-stmt ${s.change}` },
        h("div", { class: "cm-when" }, h("span", { text: filingLabel(s) }),
          h("span", { class: "cm-tag", text: i === 0 ? "Original" : s.change === "revised" ? "Revised" : s.change === "same" ? "Repeated" : s.change === "rolled_forward" ? "Year rolled forward" : "Reworded" }),
          find(s)),
        h("p", {}, text));
    });
  } else {
    body = [h("div", { class: "cm-stmt" },
      h("div", { class: "cm-when" }, h("span", { text: filingLabel(last) }), find(last)),
      h("p", { text: last.quote })),
      st.length > 1 ? h("p", { class: "cm-note", text: `First stated ${dshort(st[0].filed)}; ${plural(st.length, "filing")} in all.` }) : null];
  }
  const track = h("button", { type: "button", class: "btn cm-track", "aria-pressed": String(isTracked(t, ch)), title: "Show changes to this on your watchlist page" });
  const paintTrack = () => { const on = isTracked(t, ch); track.setAttribute("aria-pressed", String(on)); track.textContent = on ? "Tracking" : "Track"; };
  track.addEventListener("click", () => { toggleTracked(t, ch); paintTrack(); });
  paintTrack();
  return h("article", { class: `cm-item ${ch.status}` },
    h("div", { class: "cm-tags" }, h("span", { class: `cm-status ${ch.status}`, text: label, title: hint }), h("span", { class: "cm-kind", text: KIND[ch.kind] ?? ch.kind }), track),
    ...body.filter(Boolean));
}

export function commitmentsCard(t) {
  const card = h("section", { class: "card" });
  loadCommitments().then((doc) => {
    const chains = doc?.companies?.[t] ?? [];
    const show = chains.filter((c) => c.status !== "not_repeated");
    const old = chains.filter((c) => c.status === "not_repeated");
    if (!chains.length) return card.remove();
    const q = doc.quality;
    const count = (s) => chains.filter((c) => c.status === s).length;
    const list = (items, first = 5) => {
      const box = h("div", { class: "cm-list" }, items.slice(0, first).map((c) => chainItem(c, t)));
      if (items.length > first) {
        box.append(h("button", { type: "button", class: "btn fd-more", text: `Show ${items.length - first} more`,
          onclick: (e) => { box.append(...items.slice(first).map((c) => chainItem(c, t))); e.currentTarget.remove(); } }));
      }
      return box;
    };
    card.append(...[
      h("div", { class: "card-head" }, h("div", {},
        h("h2", { text: "What management has committed to" }),
        h("p", { text: "Dated milestones, capital plans and quantified outlooks, copied from each filing and followed across filings. When a date or figure changes, the earlier wording stays next to the later. Nothing here is interpreted or scored." })),
        h("div", { class: "cm-counts" }, [["revised", "revised"], ["new", "new"], ["unchanged", "repeated"]].map(([k, w]) => count(k) ? h("span", { class: `cm-status ${k}`, text: `${count(k)} ${w}` }) : null))),
      show.length ? list(show) : h("p", { class: "empty", text: "No dated commitments in the latest filing." }),
      old.length ? h("details", { class: "more" }, h("summary", { text: `Stated earlier, not in the latest filing (${old.length})` }), list(old, 4)) : null,
      h("p", { class: "note", text: `Found by pattern from forward-looking sentences that name a date or an amount. It won't catch every commitment, and a change in wording isn't always a change in plan: check the filing.${q ? ` Checked by hand on the first build: all ${q.revised.checked} revisions were real changes, and ${q.other.real} of ${q.other.checked} other statements were clear commitments (${q.other.weak} weak, ${q.other.wrong} wrong; the wrong kinds are now excluded).` : ""}` })].filter(Boolean));
  });
  return card;
}
