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
    "capacity": r"\b(capacity|fabs?|construction|capital\s+expenditures?|capex|manufacturing\s+(sites?|facilit(y|ies))|wafer\s+(output|starts?)|build-?outs?|supply\s+(constraints?|growth))\b",
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


# Words that only restate a quantity or period ("a mid-40% range", "low-single-digit percentage").
_QUANT_WORDS = set("""low mid high approximate approximately about roughly nearly slightly more less than over under
range percentage percent percentage-point points basis single-digit double-digit triple-digit low-single-digit mid-single-digit
high-single-digit low-double-digit mid-double-digit high-double-digit teens respectively and a an the of to from for by
first second third fourth three six nine twelve month months quarter quarters fiscal year years ended ending period periods""".split())
MIN_KEY_CHANGE = 5  # changed words before a revision to a key-topic paragraph counts as key, unless the change itself names the topic


def _figure_word(w: str) -> bool:
    w = w.lower().strip(".,;:()“”\"'’")
    return not w or bool(re.search(r"\d", w)) or w in _QUANT_WORDS or bool(re.fullmatch(_MONTH, w)) or w.endswith("%")


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


_ENTITY = re.compile(r"\b[A-Z][A-Z0-9&]{1,}\b")  # DRAM, NAND, HBM, EMEA: segment and product names
_ENTITY_STOP = {"US", "USD", "GAAP", "SEC", "MD", "A", "I", "II", "III", "IV", "Q1", "Q2", "Q3", "Q4"}


def _entities(p: str) -> set[str]:
    return {w for w in _ENTITY.findall(p) if w not in _ENTITY_STOP}


def same_subject(a: str, b: str) -> bool:
    """False when each paragraph opens on a segment or product the other doesn't mention ("Sales of DRAM
    products increased 74%" against "Sales of NAND products increased 183%"). Those share a template, not
    a subject, so they are shown as removed and added, not as one passage revised. A name that appears
    only on one side, or deeper in a rewritten paragraph, is still a revision."""
    lead = lambda p: _entities(" ".join(p.split()[:12]))
    return not (lead(a) - _entities(b) and lead(b) - _entities(a))


def _similarity(a: str, b: str) -> float:
    # On the figure-stripped text, so paragraphs that share a template (one per business unit)
    # pair by their names, not by coincidentally similar numbers.
    return SequenceMatcher(None, _shape(a).split(), _shape(b).split(), autojunk=False).ratio()


def lead_ins(paras: list[str], width: int = 200) -> list[str]:
    """For each paragraph, the nearest earlier paragraph that isn't a bullet: the sentence that says what
    period or base a list of figures is measured against ("... as compared to the second quarter")."""
    out, lead = [], ""
    for p in paras:
        out.append(lead)
        if not p.lstrip().startswith(("•", "-", "·")):
            lead = p[:width]
    return out


_MONTHS_SPAN = re.compile(r"\b(six|nine|twelve)\s+months\b", re.IGNORECASE)
_QUARTER_YEAR = re.compile(r"\bquarter\s+of\s+(?:fiscal\s+)?(\d{4})", re.IGNORECASE)
BASIS_LABEL = {"sequential": "Quarter over quarter", "yoy": "Year over year", "ytd": "Year to date"}


def basis(text: str) -> str | None:
    """What a passage's figures are measured against, read from "X as compared to Y": the previous quarter
    ("sequential"), the same quarter a year earlier ("yoy"), or a year-to-date span ("ytd"). None when the
    text doesn't say, or mixes bases (then it constrains nothing)."""
    m = re.search(r"\bas\s+compared\s+(?:to|with)\b|\bcompared\s+(?:to|with)\b", text, re.IGNORECASE)
    if not m:
        return None
    left, right = text[: m.start()], text[m.end():]
    months, quarters = bool(_MONTHS_SPAN.search(left)), bool(re.search(r"\bquarter\b", left, re.IGNORECASE))
    if months and quarters:
        return None
    if months:
        return "ytd"
    ly, ry = _QUARTER_YEAR.findall(left), _QUARTER_YEAR.findall(right)
    if not ly or not ry:
        return None
    gap = int(ly[0]) - int(ry[0])
    return "sequential" if gap == 0 else "yoy" if gap == 1 else None


def compare(prev: list[str], curr: list[str]) -> dict:
    """Align two filings' paragraphs; see the module docstring for the kinds."""
    pending_prev = list(range(len(prev)))
    matched_curr: dict[int, dict] = {}
    # A figure list is only comparable to one measured the same way: a quarter-over-quarter bullet is
    # never paired with a year-over-year one, though both open "Sales of DRAM products increased".
    prev_basis = [basis(p) or basis(l) for p, l in zip(prev, lead_ins(prev))]
    curr_basis = [basis(p) or basis(l) for p, l in zip(curr, lead_ins(curr))]
    comparable = lambda i, j: not (prev_basis[i] and curr_basis[j] and prev_basis[i] != curr_basis[j])

    def take(key, kind):
        index: dict[str, list[int]] = {}
        for i in pending_prev:
            index.setdefault(key(prev[i]), []).append(i)
        for j, p in enumerate(curr):
            if j in matched_curr:
                continue
            hits = index.get(key(p))
            i = next((h for h in hits or [] if comparable(h, j)), None)
            if i is not None:
                hits.remove(i)
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
            if overlap >= 0.3 and same_subject(prev[i], p) and comparable(i, j):
                candidates.append((_similarity(prev[i], p), j, i))
    for sim, j, i in sorted(candidates, reverse=True):
        if sim < MIN_SIMILARITY:
            break
        if j in matched_curr or i not in pending_prev:
            continue
        pending_prev.remove(i)
        matched_curr[j] = {"kind": "revised", "i": i, "sim": round(sim, 2)}

    items, counts = [], {k: 0 for k in ("unchanged", "figures", "revised", "added", "removed", "boilerplate")}


    def emit(kind: str, pos: int, before: str | None, after: str | None, sim: float | None = None, ij: tuple | None = None) -> None:
        text = after if after is not None else before
        if kind != "unchanged" and BOILERPLATE.search(text):
            kind = "boilerplate"
        if kind == "unchanged":
            counts[kind] += 1
            return
        diff = word_diff(before, after) if before is not None and after is not None else None
        changed = [w for op, text in diff or [] if op != "=" for w in text.split()]
        if kind == "revised" and all(_figure_word(w) for w in changed):
            kind = "figures"
        t = topics(" ".join(x for x in (before, after) if x))
        if kind == "revised":
            key = bool(t) and (len(changed) >= MIN_KEY_CHANGE or bool(topics(" ".join(changed))))
        else:
            key = bool(t) and (kind in ("added", "removed") or (kind == "figures" and "guidance" in t))
        counts[kind] += 1
        size = len(changed) if diff is not None else len(text.split())
        # Key items are listed most substantial first: changes whose own words name a topic, then larger changes.
        weight = 2 * len(topics(" ".join(changed) if diff is not None else text)) + min(size, 60) / 30
        item = {"kind": kind, "pos": pos, "topics": t, "key": key, "changed_words": size, "weight": round(weight, 2)}
        if ij is not None and curr_basis[ij[1]]:
            item["basis"] = curr_basis[ij[1]]
        if diff is not None:
            item["diff"] = diff
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
            emit(m["kind"], j, prev[m["i"]], p, m.get("sim"), (m["i"], j))
    # A removed paragraph sits where its predecessor's match sits now, so it reads in context.
    where = {m["i"]: j for j, m in matched_curr.items()}
    for i in pending_prev:
        before = [where[k] for k in range(i) if k in where]
        emit("removed", (before[-1] if before else -1) + 0.5, prev[i], None)

    items.sort(key=lambda x: (not x["key"], -x["weight"] if x["key"] else 0, x["pos"]))
    for x in items:
        del x["pos"], x["weight"]
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
