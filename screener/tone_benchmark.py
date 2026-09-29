"""How well does a filing's management-tone rating agree with what the company reported?

Tone is a judgement about language, so there is no clean answer key. The check used here is
consistency with the reported quarter: revenue growth and the change in net margin over a
year. A strong quarter described in a "neutral" or "bearish" tone, or a shrinking one
described as "bullish", is a disagreement worth reading. Management can of course sound
cautious about a good quarter; the point is that such disagreements should be rare and
explicable, and that a rule for combining excerpts shouldn't create them by accident.

Usage:
    python -m screener.tone_benchmark stored            # tone as stored on all 160 filings
    python -m screener.tone_benchmark rules benchmark/runs/v2t
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from collections import Counter
from pathlib import Path

from screener import flag_benchmark as fb
from screener import store

TONE_VALUE = {"bullish": 1, "neutral": 0, "bearish": -1}


def reference_tone(quarter: dict, year_ago: dict | None) -> str | None:
    """"bullish", "neutral" or "bearish" from the reported quarter, or None if growth is unknown."""
    yoy = quarter.get("revenue_yoy")
    if yoy is None:
        return None
    nm, nm0 = quarter.get("net_margin"), (year_ago or {}).get("net_margin")
    margin_change = nm - nm0 if nm is not None and nm0 is not None else None
    if yoy < 0 or (margin_change is not None and margin_change <= -0.08):
        return "bearish"
    if yoy >= 0.08 and (margin_change is None or margin_change >= -0.03):
        return "bullish"
    return "neutral"


def _reference_by_accession(state_companies: list[dict]) -> dict[str, dict]:
    out = {}
    for co in state_companies:
        qs = co["fundamentals"]["quarters"]
        for f in co["qualitative"]["filings"]:
            pe = f.get("period_end")
            if not pe:
                continue
            idx = next((i for i, q in enumerate(qs) if abs((dt.date.fromisoformat(q["end"]) - dt.date.fromisoformat(pe)).days) <= 7), None)
            if idx is None:
                continue
            ref = reference_tone(qs[idx], qs[idx - 4] if idx >= 4 else None)
            if ref:
                out[f["accession"]] = {"ticker": co["ticker"], "reference": ref, "revenue_yoy": qs[idx].get("revenue_yoy"),
                                       "stored": f["tone"], "filed": f["filed"]}
    return out


# --------------------------------------------------------------------------
# Combining rules over an filing's excerpts: each takes [{"tone","chars","density"}] -> tone


def _label(avg: float) -> str:
    return "bullish" if avg > 0.33 else "bearish" if avg < -0.33 else "neutral"


def rule_current(chunks: list[dict]) -> str:
    total = sum(c["chars"] for c in chunks)
    return _label(sum(TONE_VALUE[c["tone"]] * c["chars"] for c in chunks) / total) if total else "neutral"


def rule_ignore_neutral(chunks: list[dict]) -> str:
    """Excerpts the model calls neutral carry no tone; decide on the ones that say something."""
    voting = [c for c in chunks if c["tone"] != "neutral"]
    if not voting:
        return "neutral"
    total = sum(c["chars"] for c in voting)
    return _label(sum(TONE_VALUE[c["tone"]] * c["chars"] for c in voting) / total)


def rule_dense_only(min_density: float):
    def rule(chunks: list[dict]) -> str:
        dense = [c for c in chunks if c["density"] >= min_density] or chunks
        return rule_current(dense)
    rule.__name__ = f"dense>={min_density}"
    return rule


def rule_dense_ignore_neutral(min_density: float):
    def rule(chunks: list[dict]) -> str:
        dense = [c for c in chunks if c["density"] >= min_density] or chunks
        return rule_ignore_neutral(dense)
    rule.__name__ = f"dense>={min_density}+ignore neutral"
    return rule


def score(rule, rows: list[dict]) -> dict:
    """rows: [{"reference","chunks"}]. Disagreements split by kind."""
    c = Counter()
    for r in rows:
        got = rule(r["chunks"]) if r["chunks"] else "neutral"
        ref = r["reference"]
        c["agree" if got == ref else "disagree"] += 1
        if ref == "bullish" and got != "bullish":
            c["under_called_strong_quarter"] += 1
        if ref == "bearish" and got == "bullish":
            c["over_called_weak_quarter"] += 1
    n = len(rows)
    return {"n": n, "agree": c["agree"], "agreement": round(c["agree"] / n, 3) if n else None,
            "strong_quarter_not_bullish": c["under_called_strong_quarter"], "weak_quarter_bullish": c["over_called_weak_quarter"]}


def summary(companies: list[dict]) -> dict:
    """The figures the site shows: agreement with the reported quarter, and how tone behaves
    in the clearest cases (revenue falling; revenue up more than 15%)."""
    ref = _reference_by_accession(companies)
    rows = list(ref.values())
    agree = sum(1 for r in rows if r["stored"] == r["reference"])
    fall = [r for r in rows if r["revenue_yoy"] is not None and r["revenue_yoy"] < 0]
    fast = [r for r in rows if r["revenue_yoy"] is not None and r["revenue_yoy"] >= 0.15]
    return {"filings": len(rows), "agree": agree, "agreement": round(agree / len(rows), 3),
            "revenue_fell": {"filings": len(fall), "rated_bullish": sum(1 for r in fall if r["stored"] == "bullish")},
            "revenue_up_15": {"filings": len(fast), "rated_bullish": sum(1 for r in fast if r["stored"] == "bullish")},
            "tone_mix": dict(Counter(r["stored"] for r in rows))}


def main(argv: list[str]) -> int:
    state = store.load_companies()
    ref = _reference_by_accession(list(state["companies"].values()))
    if argv and argv[0] == "stored":
        rows = [{"reference": v["reference"], "chunks": [{"tone": v["stored"], "chars": 1, "density": 0}]} for v in ref.values()]
        print(json.dumps(score(rule_current, rows), indent=2))
        return 0
    run = fb._load_run(Path(argv[1]))["filings"]
    flags = json.loads(fb.FLAGS_FILE.read_text())
    split = {f["accession"]: f["split"] for f in flags}
    rows = {"dev": [], "test": []}
    for acc, f in run.items():
        if acc in ref and f.get("chunk_tones"):
            rows[split.get(acc, "test")].append({"reference": ref[acc]["reference"], "chunks": f["chunk_tones"], "id": acc})
    rules = [rule_current, rule_ignore_neutral, *[rule_dense_only(t) for t in (2.0, 3.0, 4.0)],
             *[rule_dense_ignore_neutral(t) for t in (2.0, 3.0, 4.0)]]
    out = {sp: {r.__name__: score(r, rs) for r in rules} for sp, rs in rows.items()}
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
