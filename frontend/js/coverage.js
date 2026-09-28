// How much of the filing the qualitative score actually rests on. "35% assessed"
// is a share of the MD&A text the model read, not a confidence level, and the
// states below keep "read and found nothing" apart from "couldn't read it".
const FAILED = { extraction_failed: "the MD&A section couldn't be located", llm_failed: "the model returned no usable answer" };

const order = (a, b) => (a.period_end || a.filed || "").localeCompare(b.period_end || b.filed || "") || (a.filed || "").localeCompare(b.filed || "");

export function analysisCoverage(c) {
  const all = [...(c.qualitative?.filings ?? [])].sort(order);
  const attempt = all.at(-1);
  const scored = all.filter((f) => f.status === "ok").at(-1);
  if (!attempt) return { state: "pending" };
  if (attempt.status !== "ok") {
    return { state: "failed", attempt, scored, reason: FAILED[attempt.status] ?? attempt.error ?? "analysis failed" };
  }
  const share = attempt.mda_chars > 0 ? Math.min(1, attempt.chars_analyzed / attempt.mda_chars) : null;
  return {
    state: share !== null && share < 0.95 ? "partial" : "full",
    attempt, scored, share,
    flags: attempt.red_flags?.length ?? 0,
  };
}
