// "What changed since you last looked" for the companies you follow. Computed in this browser
// from the latest data: there are no accounts or emails, so nothing can notify you unless you
// open the page. What you follow, your notes and the last-seen time all stay in localStorage.
import { S } from "./state.js";
import { CAUSE_TEXT, dshort, flagName, isNum, store } from "./lib.js";
import { filingChanges } from "./filing-changes.js";
import { getNote, notedTickers } from "./notes.js";

const SEEN_KEY = "digest-seen", TRACK_KEY = "tracked-commitments";
export const FIRST_VISIT_DAYS = 14;
const SCORE_MOVE = 3, BIG_DAY_MOVE = 0.05, NEAR_TARGET = 0.03;

// ------------------------------------------------------------ what you follow
let tracked = store.get(TRACK_KEY, {});

const words = (t) => new Set(String(t).toLowerCase().replace(/[$\d.,%]+|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/g, " ").split(/[^a-z]+/).filter((w) => w.length > 2));
export function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both) >= 0.6;
}

export const trackedFor = (t) => tracked[t] ?? [];
export const isTracked = (t, chain) => trackedFor(t).some((x) => chain.statements.some((s) => similar(x.quote, s.quote)));
export function toggleTracked(t, chain) {
  const list = trackedFor(t);
  if (isTracked(t, chain)) tracked[t] = list.filter((x) => !chain.statements.some((s) => similar(x.quote, s.quote)));
  else tracked[t] = [...list, { quote: chain.statements.at(-1).quote, added: new Date().toISOString() }];
  if (!tracked[t].length) delete tracked[t];
  store.set(TRACK_KEY, tracked);
}

/** Companies to include: starred, with a note, or with a tracked commitment. */
export const followed = () => [...new Set([...S.watch, ...notedTickers(), ...Object.keys(tracked)])].filter((t) => S.by[t]);

// ------------------------------------------------------------ last seen
export function sinceDate() {
  const seen = store.get(SEEN_KEY, null);
  if (seen) return { since: new Date(seen), first: false };
  return { since: new Date(Date.now() - FIRST_VISIT_DAYS * 864e5), first: true };
}
export const markSeen = () => store.set(SEEN_KEY, new Date().toISOString());

// ------------------------------------------------------------ events
const after = (iso, since) => !!iso && new Date(iso) > since;
const LAG_DAYS = 7;
/** A filing is new to you if it was filed since you looked, or was filed shortly before and only analyzed since.
 *  A long-filed report that was merely reprocessed recently is not news. */
const isNew = (filed, analyzed, since) => after(filed, since) || (after(analyzed, since) && new Date(filed) > new Date(since.getTime() - LAG_DAYS * 864e5));

/**
 * Changes for one company since `since`. `chains` is the company's commitments (may be empty).
 * Each event: { kind, when, text, route, important }.
 */
export function companyEvents(c, { price, chains = [], since, trackedQuotes = [] }) {
  const t = c.ticker, events = [];
  const filings = (c.qualitative?.filings ?? []).filter((f) => f.status === "ok");
  const latest = filings.at(-1);

  if (latest && isNew(latest.filed, latest.analyzed_at, since)) {
    events.push({ kind: "filing", when: latest.analyzed_at, route: `${t}/changes`, important: false,
      text: `${latest.form} filed ${dshort(latest.filed)} is now analyzed: tone ${latest.tone}, ${latest.red_flags.length} flag${latest.red_flags.length === 1 ? "" : "s"}.` });
    const added = filingChanges(filings).added;
    if (added.length) events.push({ kind: "flags", when: latest.analyzed_at, route: t, important: true, text: `New risk categories in that filing: ${added.map(flagName).join(", ")}.` });
  }

  const hist = c.rating_history ?? [];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    if (a.rating !== b.rating && after(b.at, since)) {
      events.push({ kind: "rating", when: b.at, route: t, important: true, text: `Rating moved ${a.rating} → ${b.rating} (${a.composite.toFixed(1)} → ${b.composite.toFixed(1)}).${b.cause ? ` ${CAUSE_TEXT[b.cause]}.` : ""}` });
    }
  }
  if (!events.some((e) => e.kind === "rating") && hist.length >= 2) {
    const inWindow = hist.filter((h) => after(h.at, since));
    const base = [...hist].reverse().find((h) => !after(h.at, since)) ?? inWindow[0];
    const last = hist.at(-1);
    if (base && base !== last && Math.abs(last.composite - base.composite) >= SCORE_MOVE) {
      events.push({ kind: "score", when: last.at, route: t, important: false, text: `Score ${base.composite.toFixed(1)} → ${last.composite.toFixed(1)}.` });
    }
  }

  const meta = Object.fromEntries((c.qualitative?.filings ?? []).map((f) => [f.accession, f]));
  for (const ch of chains) {
    const isTr = trackedQuotes.some((q) => ch.statements.some((s) => similar(q, s.quote)));
    const revised = ch.statements.filter((s) => s.change === "revised" && meta[s.accession] && isNew(meta[s.accession].filed, meta[s.accession].analyzed_at, since)).at(-1);
    if (revised) {
      events.push({ kind: "commitment", when: meta[revised.accession].analyzed_at ?? meta[revised.accession].filed, route: t, important: isTr || undefined,
        text: `${isTr ? "A commitment you track changed" : "A commitment changed"}: “${revised.quote}”`, tracked: isTr });
    }
  }

  if (price && isNum(price.change_1d) && Math.abs(price.change_1d) >= BIG_DAY_MOVE && after(price.date, since)) {
    events.push({ kind: "price", when: price.date, route: t, important: false,
      text: `Moved ${price.change_1d > 0 ? "+" : "−"}${Math.abs(price.change_1d * 100).toFixed(1)}% on ${dshort(price.date)}.` });
  }
  return events.sort((a, b) => Number(!!b.important) - Number(!!a.important) || b.when.localeCompare(a.when));
}

/** Where the last close sits against the price target from your notes, or null. */
export function targetStatus(price, target) {
  if (!price || !isNum(price.close) || !isNum(target) || target <= 0) return null;
  const gap = price.close / target - 1;
  return { close: price.close, target, gap, state: gap >= 0 ? "at or above" : gap >= -NEAR_TARGET ? "within 3% below" : "below" };
}

export function digest(chainsByTicker = {}, sinceInfo = sinceDate()) {
  const { since, first } = sinceInfo;
  const rows = followed().map((t) => {
    const c = S.by[t], note = getNote(t);
    const events = companyEvents(c, { price: S.px[t], chains: chainsByTicker[t] ?? [], since, trackedQuotes: trackedFor(t).map((x) => x.quote) });
    return { c, note, events, target: targetStatus(S.px[t], note.target), tracked: trackedFor(t).length };
  });
  const urgency = (r) => (r.note.status === "Thesis at risk" || r.note.status === "Thesis broken" ? 2 : 0) + (r.events.some((e) => e.important) ? 3 : 0) + (r.events.length ? 1 : 0);
  rows.sort((a, b) => urgency(b) - urgency(a) || a.c.ticker.localeCompare(b.c.ticker));
  return { since, first, rows, count: rows.reduce((n, r) => n + r.events.length, 0) };
}
