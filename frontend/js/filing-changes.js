// Compare model detections across distinct, successfully analyzed filings.
// A flag disappearing from an excerpt is not evidence that the risk is resolved.
export function filingChanges(filings = []) {
  const distinct = new Map();
  for (const f of filings.filter((f) => f.status === "ok")) {
    distinct.set(f.accession || f.source_url || `${f.form}:${f.filed}:${f.period_end}`, f);
  }
  const sorted = [...distinct.values()].sort((a, b) =>
    (a.filed || "").localeCompare(b.filed || "") || (a.period_end || "").localeCompare(b.period_end || ""));
  const latest = sorted.at(-1), previous = sorted.at(-2);
  if (!latest || !previous) return { latest, previous, added: [], absent: [], continuing: [] };
  const before = new Set((previous.red_flags || []).map((f) => f.category));
  const after = new Set((latest.red_flags || []).map((f) => f.category));
  return {
    latest, previous,
    added: [...after].filter((c) => !before.has(c)),
    absent: [...before].filter((c) => !after.has(c)),
    continuing: [...after].filter((c) => before.has(c)),
  };
}
