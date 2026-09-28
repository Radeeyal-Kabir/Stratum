"""What changed in MD&A between a company's latest filing and the one before.

Usage:
    python -m screener.filing_diff              # every company
    python -m screener.filing_diff MU NVDA

Compares the latest 10-K or 10-Q with the previous filing of the same form
(10-Q against the prior quarter's 10-Q, 10-K against last year's 10-K): a
10-K's MD&A is organized differently from a 10-Q's, and comparing across
forms would mark most of the section as changed.

Only prose paragraphs are compared; tables are skipped. Each paragraph of
the current filing is matched to the previous one regardless of position:
  unchanged   identical text, wherever it sits (moved paragraphs included);
              counted, never shown
  figures     identical apart from numbers, dates and period names
              ("third quarter", "nine months"); collapsed unless about guidance
  revised     the closest earlier paragraph, when similar enough; shown with
              word-level changes
  added       no earlier counterpart
  removed     an earlier paragraph with no counterpart now
  boilerplate safe-harbor and accounting-standards text; collapsed

Items touching guidance, demand, margins, liquidity or capacity come first.
The output is the filing text itself; the model's reading is kept separate
(it lives on each filing's analysis record).
"""

from __future__ import annotations

import re
import sys
from difflib import SequenceMatcher

from screener import analyze_filing as af
from screener import edgar_client, store
from screener.universe import tickers as all_tickers

DIFFS_DIR = store.DATA_DIR / "diffs"
MIN_SIMILARITY = 0.5  # word-sequence ratio above which two paragraphs are the same paragraph, revised

TOPICS = {
    "guidance": r"\b(expect\w*|anticipat\w*|outlook|guidance|forecast\w*|we\s+plan|plans?\s+to|intend\w*|target\w*|project(ed|ing|ions?))\b",
    "demand": r"\b(demand|orders?|bookings?|backlog|customer\s+spending|unit\s+(sales|shipments?)|shipments?|consumption)\b",
    "margins": r"\b(gross\s+margins?|operating\s+margins?|margins?|profitability)\b",
    "liquidity": r"\b(liquidity|cash\s+flows?|borrowings?|debt|credit\s+facilit\w+|notes\s+due|commercial\s+paper|share\s+repurchases?|dividends?)\b",
    "capacity": r"\b(capacity|fabs?|facilit(y|ies)|construction|capital\s+expenditures?|capex|data\s+cent(er|re)s?|manufacturing\s+sites?|supply)\b",
}
KEY_TOPICS = tuple(TOPICS)
_TOPIC_RE = {k: re.compile(v, re.IGNORECASE) for k, v in TOPICS.items()}

BOILERPLATE = re.compile(
    rf"{af.SAFE_HARBOR.pattern}|recent(ly)?\s+(issued|adopted)\s+accounting|accounting\s+standards?\s+update"
    r"|critical\s+accounting\s+(policies|estimates)|should\s+be\s+read\s+in\s+conjunction\s+with",
    re.IGNORECASE,
)

_MONTH = r"(january|february|march|april|may|june|july|august|september|october|november|december)"
_PERIOD = r"(first|second|third|fourth|1st|2nd|3rd|4th)\s+(fiscal\s+)?quarter|(three|six|nine|twelve)\s+months|\bq[1-4]\b"
_FIGURE = re.compile(rf"\$?\(?\d[\d,]*(\.\d+)?\)?\s*(%|percent|billion|million|thousand|bps|basis\s+points)?|{_MONTH}|{_PERIOD}", re.IGNORECASE)


def _norm(p: str) -> str:
    return af._norm(p)


def _shape(p: str) -> str:
    return _FIGURE.sub("#", _norm(p))


def paragraphs(section: str) -> list[str]:
    out = []
    for p in re.split(r"\n+", section):
        p = p.strip()
        letters = sum(ch.isalpha() for ch in p)
        if len(p) >= 80 and letters / len(p) >= 0.6:
            out.append(p)
    return out


def topics(text: str) -> list[str]:
    return [k for k, rx in _TOPIC_RE.items() if rx.search(text)]


def word_diff(a: str, b: str) -> list[list[str]]:
    """[[op, text], ...] with op "=", "-" or "+"; adjacent runs merged."""
    wa, wb = a.split(), b.split()
    ops: list[list[str]] = []

    def add(op: str, words: list[str]) -> None:
        if not words:
            return
        if ops and ops[-1][0] == op:
            ops[-1][1] += " " + " ".join(words)
        else:
            ops.append([op, " ".join(words)])

    for tag, i1, i2, j1, j2 in SequenceMatcher(None, wa, wb, autojunk=False).get_opcodes():
        if tag == "equal":
            add("=", wa[i1:i2])
        else:
            add("-", wa[i1:i2])
            add("+", wb[j1:j2])
    return ops


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a).split(), _norm(b).split(), autojunk=False).ratio()


def compare(prev: list[str], curr: list[str]) -> dict:
    """Align two filings' paragraphs; see the module docstring for the kinds."""
    pending_prev = list(range(len(prev)))
    matched_curr: dict[int, dict] = {}

    def take(key, kind):
        index: dict[str, list[int]] = {}
        for i in pending_prev:
            index.setdefault(key(prev[i]), []).append(i)
        for j, p in enumerate(curr):
            if j in matched_curr:
                continue
            hits = index.get(key(p))
            if hits:
                i = hits.pop(0)
                pending_prev.remove(i)
                matched_curr[j] = {"kind": kind, "i": i}

    take(_norm, "unchanged")
    take(_shape, "figures")

    # Fuzzy pass, best pairs first. A cheap word-overlap check skips hopeless pairs.
    words = lambda s: set(_norm(s).split())
    wp = {i: words(prev[i]) for i in pending_prev}
    candidates = []
    for j, p in enumerate(curr):
        if j in matched_curr:
            continue
        wc = words(p)
        for i in pending_prev:
            overlap = len(wc & wp[i]) / max(1, len(wc | wp[i]))
            if overlap >= 0.3:
                candidates.append((_similarity(prev[i], p), j, i))
    for sim, j, i in sorted(candidates, reverse=True):
        if sim < MIN_SIMILARITY:
            break
        if j in matched_curr or i not in pending_prev:
            continue
        pending_prev.remove(i)
        matched_curr[j] = {"kind": "revised", "i": i, "sim": round(sim, 2)}

    items, counts = [], {k: 0 for k in ("unchanged", "figures", "revised", "added", "removed", "boilerplate")}

    def emit(kind: str, pos: int, before: str | None, after: str | None, sim: float | None = None) -> None:
        text = after if after is not None else before
        if kind != "unchanged" and BOILERPLATE.search(text):
            kind = "boilerplate"
        counts[kind] += 1
        if kind == "unchanged":
            return
        t = topics(" ".join(x for x in (before, after) if x))
        item = {"kind": kind, "pos": pos, "topics": t,
                "key": bool(t) and (kind in ("revised", "added", "removed") or (kind == "figures" and "guidance" in t))}
        if before is not None and after is not None:
            item["diff"] = word_diff(before, after)
            if sim is not None:
                item["similarity"] = sim
        elif after is not None:
            item["text"] = after
        else:
            item["text"] = before
        items.append(item)

    for j, p in enumerate(curr):
        m = matched_curr.get(j)
        if m is None:
            emit("added", j, None, p)
        else:
            emit(m["kind"], j, prev[m["i"]], p, m.get("sim"))
    # A removed paragraph sits where its predecessor's match sits now, so it reads in context.
    where = {m["i"]: j for j, m in matched_curr.items()}
    for i in pending_prev:
        before = [where[k] for k in range(i) if k in where]
        emit("removed", (before[-1] if before else -1) + 0.5, prev[i], None)

    items.sort(key=lambda x: (not x["key"], x["pos"]))
    for x in items:
        del x["pos"]
    return {"counts": counts, "items": items}


# --------------------------------------------------------------------------


def _meta(f: dict, url: str) -> dict:
    return {k: f[k] for k in ("accession", "form", "filed", "period_end")} | {"source_url": url}


def pick_pair(feed: list[dict]) -> tuple[dict, dict] | None:
    """Latest periodic filing and the previous one of the same form (10-K/A etc. excluded)."""
    periodic = [f for f in feed if f["form"] in af.PERIODIC_FORMS]
    if not periodic:
        return None
    latest = periodic[0]
    prior = next((f for f in periodic[1:] if f["form"] == latest["form"]), None)
    return (prior, latest) if prior else None


def build(ticker: str, cik10: str) -> dict | None:
    feed = edgar_client.recent_filings(edgar_client.get_submissions(cik10), af.PERIODIC_FORMS)
    pair = pick_pair(feed)
    if pair is None:
        return None
    (prev_f, curr_f) = pair
    prev_text, prev_url = af.extract_mda(cik10, prev_f)
    curr_text, curr_url = af.extract_mda(cik10, curr_f)
    result = compare(paragraphs(prev_text), paragraphs(curr_text))
    return {"ticker": ticker, "generated_at": store.utc_now_iso(),
            "previous": _meta(prev_f, prev_url), "current": _meta(curr_f, curr_url), **result}


def update(tickers: list[str]) -> list[str]:
    """Rebuild the comparison for each ticker; returns tickers that failed (warned, not fatal)."""
    ciks = edgar_client.resolve_ciks(tickers)
    failed = []
    for t in tickers:
        try:
            doc = build(t, ciks[t])
        except af.ExtractionError as exc:
            print(f"::warning title=Filing comparison {t}::{exc}", file=sys.stderr)
            failed.append(t)
            continue
        if doc:
            store.write_json(DIFFS_DIR / f"{t}.json", doc)
            c = doc["counts"]
            print(f"{t}: {doc['previous']['form']} {doc['previous']['filed']} -> {doc['current']['filed']}: "
                  f"{c['revised']} revised, {c['added']} added, {c['removed']} removed, {c['figures']} figures, "
                  f"{c['unchanged']} unchanged", file=sys.stderr)
    return failed


def main(argv: list[str]) -> int:
    tickers = [t.upper() for t in argv] or all_tickers()
    try:
        update(tickers)
    except edgar_client.EdgarError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
