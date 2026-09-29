"""Red flags found by pattern, not by the language model.

A small model reads only part of each MD&A and misses plain reported facts ("Operating income
decreased by 26%"). These rules scan the whole section for a few unambiguous shapes:

  * a headline result reported as down: revenue, bookings, operating income, gross margin,
    net income, earnings per share, deferred revenue;
  * management expecting one of those margins to fall;
  * a restructuring charge or an impairment recorded in the period.

Every flag is a whole sentence copied from the filing, so it passes the same verbatim-quote
check as the model's flags. Declines that are good news (expenses falling) are never matched:
only measures that are worse when they fall are subjects. Small moves are ignored.
"""

from __future__ import annotations

import re

_NUM = r"\d[\d,]*(?:\.\d+)?"
_DOWN = r"(?:decreas(?:e|ed|es|ing)|declin(?:e|ed|es|ing)|fell|fall(?:s|ing)?|dropp?(?:ed|s)?|down|lower(?:ed)?|reduced)"

# subject pattern -> (category, label, kind of quantity)
SUBJECTS = [
    (r"(?:net |total |product |services? |subscription |software |consolidated )?(?:revenues?|net sales)\b(?! per)", "demand_weakness", "revenue", "pct"),
    (r"(?:new )?bookings\b", "demand_weakness", "bookings", "pct"),
    (r"deferred (?:product |services? )?revenue\b", "demand_weakness", "deferred revenue", "pct"),
    (r"operating (?:income|profit|margin)\b", "margin_pressure", "operating income", "margin"),
    (r"gross (?:profit|margin)(?: percentage)?\b", "margin_pressure", "gross margin", "margin"),
    (r"net (?:income|earnings)\b", "margin_pressure", "net income", "pct"),
    (r"(?:diluted |basic )?earnings per share\b", "margin_pressure", "earnings per share", "pct"),
]
_SUBJ = [(re.compile(p, re.I), cat, name, kind) for p, cat, name, kind in SUBJECTS]

_MIN_PCT = 3.0        # a revenue/income decline smaller than this isn't reported
_MIN_POINTS = 0.5     # a margin decline smaller than this many points isn't reported

_SKIP_START = re.compile(r"^\W*(excluding|the (?:decrease|decline) in (?:interest|other))", re.I)
_EXPECT = re.compile(rf"\bwe\s+expect\b[^.;]{{0,80}}?\b(gross (?:profit|margin)(?: percentage)?|operating (?:income|margin)|revenues?)\b[^.;]{{0,60}}?\bto\s+{_DOWN}\b", re.I)
_RESTRUCT = re.compile(rf"\b(?:recogni[sz]ed|recorded|incurred)\b[^.;]{{0,60}}?\$\s*({_NUM})\s*(million|billion)[^.;]{{0,40}}?\brestructuring\b|\brestructuring (?:and other |and related )?charges? of\s*\$\s*({_NUM})\s*(million|billion)", re.I)
_IMPAIR = re.compile(rf"\b(?:recorded|recogni[sz]ed|incurred)\b[^.;]{{0,60}}?\b(?:goodwill |intangible asset |asset )?impairment (?:charge|loss)|\$\s*({_NUM})\s*(?:million|billion)[^.;]{{0,40}}?\bimpairment\b", re.I)
_NEG_IMPAIR = re.compile(r"\b(?:no|not|did not|were no|was no)\b[^.;]{0,40}impairment|impairment (?:test|indicators?|analysis)|would be recorded|\bis recorded\b|\bare recorded\b|\bif\b|\bwhen\b|\bmay (?:be|need)\b|\bcould (?:be|result)\b|\bwill be\b", re.I)


def _sentences(section: str) -> list[str]:
    out = []
    for line in re.split(r"\n+", section):
        line = line.strip(" •-\t")
        for s in re.split(r"(?<=[.;])\s+(?=[A-Z•\-])", line):
            if 50 <= len(s) <= 450:
                out.append(s.strip())
    return out


def _magnitude(tail: str) -> tuple[float, bool] | None:
    """(size, is_points) of the decline the sentence states, or None. A bare level ("to 32.8%")
    is not a size; only "from A to B", "to B from A", "N points", "by N%" and "of N%" after a
    decrease noun are."""
    n = lambda x: float(x.replace(",", ""))
    m = re.search(rf"from\s+({_NUM})\s*(?:%|percent)[^.;]{{0,30}}?\bto\s+({_NUM})\s*(?:%|percent)", tail, re.I)
    if m:
        return n(m.group(1)) - n(m.group(2)), True
    m = re.search(rf"\bto\s+({_NUM})\s*(?:%|percent)[^.;]{{0,30}}?\bfrom\s+({_NUM})\s*(?:%|percent)", tail, re.I)
    if m:
        return n(m.group(2)) - n(m.group(1)), True
    m = re.search(rf"({_NUM})\s*(?:percentage points?|points?)", tail, re.I)
    if m:
        return n(m.group(1)), True
    m = re.search(rf"^\s*(?:by\s+)?({_NUM})\s*(?:%|percent)", tail, re.I)
    if m:
        return n(m.group(1)), False
    m = re.search(rf"\b(?:by|of)\s+({_NUM})\s*(?:%|percent)", tail, re.I)
    if m:
        return n(m.group(1)), False
    return None


def _decline(sentence: str) -> tuple[str, str] | None:
    if _SKIP_START.search(sentence):
        return None
    for rx, category, name, kind in _SUBJ:
        for m in rx.finditer(sentence):
            if re.search(r"percentage of\s+(?:total\s+|net\s+)?$", sentence[:m.start()], re.I):
                continue
            after = sentence[m.end():m.end() + 140]
            v = re.search(rf"^(?P<gap>(?:\W+\w+){{0,7}}?)\W+(?P<verb>{_DOWN}|a\s+(?:decrease|decline|reduction|drop))\b(?P<tail>.*)$", after, re.I | re.S)
            if not v or re.search(r"\bincreas|\bgrew|\bgrowth|\bhigher\b|\bup\b", v.group("gap"), re.I):
                continue
            got = _magnitude(v.group("tail").split(";")[0])
            if got is not None:
                size, points = got
                if size < (_MIN_POINTS if points else _MIN_PCT):
                    continue
            else:
                # No usable figure ("Wearables net sales decreased ... due to lower sales of Wearables"):
                # accept a plain past-tense decline as the main verb, in a sentence that hasn't
                # already reported something rising before the subject.
                if not re.match(r"^(?:decreased|declined|fell)$", v.group("verb"), re.I) or len(v.group("gap").split()) > 4:
                    continue
                if re.search(r"%|percent|\$", v.group("tail").split(";")[0]):
                    continue  # it states a figure we couldn't read as a size (a level, say): don't guess
                if re.search(r"\bincreas|\bgrew|\bgrowth|\bhigher\b|\boffset", sentence[:m.start()] + v.group("gap"), re.I):
                    continue
            return category, f"Reported {name} decline"
    return None


def find(section: str) -> list[dict]:
    """One flag per category, from the whole MD&A: {"category", "summary", "quote", "source"}."""
    flags: dict[str, dict] = {}
    for s in _sentences(section):
        hit = _decline(s)
        if hit is None and _EXPECT.search(s):
            hit = ("margin_pressure", "Management expects a lower margin or revenue")
        if hit is None and _RESTRUCT.search(s) and not re.search(r"\bno\b.{0,20}restructuring", s, re.I):
            hit = ("restructuring_layoffs", "Restructuring charge recorded")
        if hit is None and _IMPAIR.search(s) and not _NEG_IMPAIR.search(s):
            hit = ("impairment_writedown", "Impairment recorded")
        if hit and hit[0] not in flags:
            flags[hit[0]] = {"category": hit[0], "summary": hit[1], "quote": s[:300], "source": "pattern"}
    return list(flags.values())


def merge_into(record: dict, section: str) -> int:
    """Add pattern flags to an analyzed filing's record for categories the model didn't flag.
    Idempotent: flags from an earlier pattern pass are replaced. Returns how many were added."""
    kept = [f for f in record.get("red_flags", []) if f.get("source") != "pattern"]
    have = {f["category"] for f in kept}
    added = [f for f in find(section) if f["category"] not in have]
    record["red_flags"] = sorted(kept + added, key=lambda f: f["category"])
    record["pattern_flags"] = len(added)
    return len(added)


def main(argv: list[str]) -> int:
    """Apply the patterns to every analyzed filing on file (fetches each MD&A; no model needed),
    then rescore. Usage: python -m screener.metric_flags [TICKER ...]"""
    from screener import analyze_filing as af, edgar_client, score, store
    from screener.universe import tickers as all_tickers

    state = store.load_companies()
    tickers = [t.upper() for t in argv] or all_tickers()
    try:
        ciks = edgar_client.resolve_ciks(tickers)
        for t in tickers:
            recs = {f["accession"]: f for f in state["companies"][t].get("qualitative", {}).get("filings", [])}
            feed = edgar_client.recent_filings(edgar_client.get_submissions(ciks[t]), af.PERIODIC_FORMS)
            for filing in feed:
                rec = recs.get(filing["accession"])
                if not rec or rec.get("status") != "ok":
                    continue
                section, _ = af.extract_mda(ciks[t], filing)
                n = merge_into(rec, section)
                print(f"{t} {filing['form']} {filing['filed']}: +{n} pattern flags", file=__import__("sys").stderr)
    except (edgar_client.EdgarError, af.ExtractionError) as exc:
        print(f"ERROR: {exc}\nNothing written.", file=__import__("sys").stderr)
        return 1
    score.rescore_all(state)
    store.save_companies(state)
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main(sys.argv[1:]))
