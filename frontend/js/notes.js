// Private per-company research notes, kept in this browser (localStorage) with
// JSON export/import so they can be backed up or moved between devices.
import { store } from "./lib.js";

export const STATUSES = ["No view yet", "Thesis intact", "Watching closely", "Thesis at risk", "Thesis broken"];

let all = store.get("notes", {});

export const getNote = (t) => all[t] ?? { text: "", status: STATUSES[0], target: null, updated: null };
export const noteCount = () => Object.keys(all).length;
export const notedTickers = () => Object.keys(all);

export function saveNote(t, note) {
  const empty = !note.text.trim() && note.status === STATUSES[0] && note.target === null;
  if (empty) delete all[t];
  else all[t] = { ...note, updated: new Date().toISOString() };
  store.set("notes", all);
}

export function exportNotes() {
  return JSON.stringify({ app: "stratum", kind: "notes", version: 1, exported: new Date().toISOString(), notes: all }, null, 2);
}

/** Merges imported notes over existing ones; returns how many companies were imported. */
export function importNotes(text) {
  const doc = JSON.parse(text);
  if (doc?.kind !== "notes" || typeof doc.notes !== "object" || doc.notes === null) throw new Error("This isn't a Stratum notes file.");
  let n = 0;
  for (const [t, note] of Object.entries(doc.notes)) {
    if (!/^[A-Z.]{1,6}$/.test(t) || typeof note?.text !== "string") continue;
    all[t] = {
      text: note.text.slice(0, 20000),
      status: STATUSES.includes(note.status) ? note.status : STATUSES[0],
      target: typeof note.target === "number" && Number.isFinite(note.target) ? note.target : null,
      updated: typeof note.updated === "string" ? note.updated : null,
    };
    n++;
  }
  store.set("notes", all);
  return n;
}
