// The watchlist page: what changed, since you last looked, for the companies you follow.
import { S, toggleWatch } from "../state.js";
import { chip, dshort, h, link, pct, usd } from "../lib.js";
import { logo } from "../identity.js";
import { digest, markSeen, FIRST_VISIT_DAYS } from "../digest.js";
import { loadCommitments } from "./commitments.js";

const KIND = { filing: "Filing", flags: "New risk", rating: "Rating", score: "Score", commitment: "Commitment", price: "Price" };

function targetLine(t) {
  if (!t) return null;
  const gap = `${pct(Math.abs(t.gap), 1)} ${t.gap >= 0 ? "above" : "below"}`;
  return h("span", { class: `wl-target ${t.state === "below" ? "" : "hit"}` }, `${usd(t.close)} close · target ${usd(t.target)} · ${t.state === "below" ? gap : t.state === "within 3% below" ? `${gap}, close` : `${gap}, reached`}`);
}

function card(r, since) {
  const { c, note, events } = r;
  const thesis = note.status !== "No view yet" ? h("span", { class: `wl-thesis ${note.status === "Thesis at risk" || note.status === "Thesis broken" ? "risk" : ""}`, text: note.status }) : null;
  return h("section", { class: "card wl-card" },
    h("div", { class: "wl-head" },
      link(c.ticker, { class: "wl-id" }, logo(c.ticker), h("span", {}, h("b", { class: "tk", text: c.ticker }), h("span", { class: "muted", text: ` ${c.name}` }))),
      h("div", { class: "wl-meta" }, chip(c.score), thesis, targetLine(r.target),
        r.tracked ? h("span", { class: "wl-tracking", text: `Tracking ${r.tracked} commitment${r.tracked === 1 ? "" : "s"}` }) : null)),
    events.length
      ? h("ul", { class: "wl-events" }, events.map((e) => h("li", { class: e.important ? "important" : "" },
          h("span", { class: `wl-kind ${e.kind}`, text: KIND[e.kind] }), h("span", { class: "wl-text", text: e.text }),
          link(e.route, { class: "wl-open", "aria-label": `Open ${c.ticker}` }, "Open →"))))
      : h("p", { class: "wl-none", text: `Nothing new since ${dshort(since.toISOString())}.` }),
    note.text.trim() ? h("p", { class: "wl-note" }, h("b", { text: "Your note: " }), note.text.trim().slice(0, 200) + (note.text.trim().length > 200 ? "…" : "")) : null);
}

export function viewWatchlist() {
  const root = h("div", { class: "view-in stack" });
  let chains = {};
  const paint = () => {
    const d = digest(chains);
    const notFollowed = S.ranked.filter((c) => !d.rows.some((r) => r.c.ticker === c.ticker));
    const pick = h("select", { id: "wl-add", "aria-label": "Follow a company" }, h("option", { value: "", text: "Follow a company…" }),
      notFollowed.map((c) => h("option", { value: c.ticker, text: `${c.ticker} · ${c.name}` })));
    pick.addEventListener("change", () => { if (pick.value) { toggleWatch(pick.value); paint(); } });
    const withChanges = d.rows.filter((r) => r.events.length).length;
    root.replaceChildren(
      h("div", { style: { display: "grid", gap: "10px" } },
        h("p", { class: "eyebrow", text: "YOUR WATCHLIST" }),
        h("h1", { class: "page-title", text: "What changed since you last looked" }),
        h("p", { class: "ink2", style: { maxWidth: "70ch" } },
          d.first ? `No earlier visit is recorded in this browser, so this shows the last ${FIRST_VISIT_DAYS} days.` : `Changes since ${dshort(d.since.toISOString())}.`,
          " It covers companies you've starred, written notes on, or tracked a commitment for. Nothing is sent to you: there are no accounts or emails, so this is worked out in your browser each time you open it.")),
      h("div", { class: "wl-bar" },
        h("span", { class: "wl-count", text: d.rows.length ? `${d.count} change${d.count === 1 ? "" : "s"} across ${withChanges} of ${d.rows.length} companies` : "" }),
        h("span", { class: "wl-actions" }, pick,
          h("button", { type: "button", class: "btn btn-primary", id: "wl-seen", text: "Mark all as seen", onclick: () => { markSeen(); paint(); window.dispatchEvent(new Event("digest-seen")); } }))),
      ...(d.rows.length ? d.rows.map((r) => card(r, d.since))
        : [h("section", { class: "card" }, h("p", { class: "empty" }, "You aren't following anyone yet. Star a company in the screener or on its page, write a note, or press “Track” on a commitment, and it will show up here. ", link("screener", {}, "Open the screener")))]));
  };
  paint();
  loadCommitments().then((doc) => { if (doc?.companies) { chains = doc.companies; paint(); } });
  return root;
}
