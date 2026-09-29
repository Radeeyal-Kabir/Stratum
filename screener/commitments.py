"""Management commitments: dated milestones, capital plans and quantified outlooks,
tracked across a company's filings so each revision sits next to the original.

Nothing here is interpreted. A commitment is a forward-looking sentence copied from an MD&A
that names a date or an amount ("we expect it to be operational by the end of 2028", "we
expect capital expenditures of approximately $18 billion"). Sentences from a company's
successive filings are chained by wording, ignoring numbers and dates, so a change of the
date or figure shows up as a revision of the same statement.

Not commitments: hedged wording (may, might, could), legal boilerplate, and anything without
a date or an amount.
"""

from __future__ import annotations

import re
import sys

from screener import analyze_filing as af
from screener import edgar_client, filing_diff, store
from screener.universe import tickers as all_tickers

COMMITMENTS_FILE = store.DATA_DIR / "commitments.json"
MIN_CHAIN_SIMILARITY = 0.55
MAX_GAP = 2  # a chain continues only if its last statement was at most this many filings back

_MONEY = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?\s*(?:million|billion|trillion)", re.I)
_PCT = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|percent)", re.I)
_YEAR = re.compile(r"\b(20[2-4]\d)\b")

_FORWARD = re.compile(
    r"\b(?:we|the\s+company|management)\s+(?:currently\s+|now\s+|also\s+|further\s+|continue\s+to\s+)?"
    r"(?:expect|anticipate|plan|intend|project|target|aim)s?\b"
    # "estimate" only looks ahead when it says what something will be ("we estimate ... to be 11%"),
    # not when it reports a past fact ("we estimate that one customer contributed ...").
    r"|\b(?:we|the\s+company|management)\s+estimates?\b(?=[^.;]{0,140}?\b(?:to\s+be|will|would\s+be)\b)"
    r"|\b(?:is|are|was|were)\s+(?:currently\s+|now\s+)?(?:expected|anticipated|scheduled|planned|projected|on\s+track|targeted)\b"
    r"|\bexpected\s+to\b|\bwill\s+(?:be|begin|start|complete|open|provide|ship|close|commence|reach|ramp)\b",
    re.I,
)
_HEDGED = re.compile(r"\b(?:may|might|could|can\s+be|if|upon|in\s+the\s+event|unless)\b", re.I)
_TOPIC = {
    "capital": re.compile(r"\b(?:capital\s+expenditures?|capex|construction|fabs?|plants?|campus|break(?:ing)?\s+ground|site\s+preparation)\b", re.I),
    "capital_weak": re.compile(r"\b(?:invest\w*|data\s+cent(?:er|re)s?|facilit\w+|capacity|build\w*)\b", re.I),
    "outlook": re.compile(r"\b(?:revenues?|gross\s+(?:margin|profit)|operating\s+(?:margin|income)|effective\s+tax\s+rate|cost\s+of\s+revenues?|(?:sales\s+and\s+marketing|research\s+and\s+development|general\s+and\s+administrative)\s+expenses?|stock-based\s+compensation|restructuring|charges|repurchase\w*|dividends?)\b", re.I),
}
# Rolling balances and liquidity assurances restate every quarter without being commitments.
_NOT_A_COMMITMENT = re.compile(
    r"\bfuture\s+cash\s+payments\b|\bsufficient\s+to\b|\bsufficient\s+(?:cash|liquidity|resources)\b|\bremaining\s+(?:liabilit|balance|obligation)"
    r"|\bsources\s+of\s+liquidity\b"
    # accounting standards: the date a new rule takes effect is not a management plan
    r"|\bauthoritative\s+guidance\b|\baccounting\s+standards?\b|\bwill\s+be\s+effective\s+for\s+us\b|\beffective\s+for\s+us\b"
    r"|\bASU\b|\bAccounting\s+Standards\s+Update\b"
    # past facts and rolling compensation balances
    r"|\b(?:have|has|had)\s+(?:been\s+)?recorded\b|\bwe\s+used\b|\bscheduled\s+to\s+mature\b|\bunrecognized\s+compensation\b|\bcontinue\s+to\s+do\s+so\b"
    # a rolling remainder shrinks every quarter without any change of plan
    r"|\bremainder\s+of\b[^.;]{0,120}?\$", re.I)
_AS_OF_LEAD = re.compile(r"^\W*as\s+of\b", re.I)
_FULL_DATE = re.compile(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d\d\b", re.I)


def _sentences(section: str) -> list[str]:
    out = []
    for line in re.split(r"\n+", section):
        line = line.strip(" •-\t")
        for s in re.split(r"(?<=[.;])\s+(?=[A-Z•\-])", line):
            if 60 <= len(s) <= 500:
                out.append(s.strip())
    return out


def kind_of(sentence: str, filed_year: int) -> str | None:
    """"milestone", "capital" or "outlook", or None if the sentence isn't a specific commitment."""
    if af.SAFE_HARBOR.search(sentence) or af.BOILERPLATE_QUOTE.search(sentence) or _HEDGED.search(sentence) or _NOT_A_COMMITMENT.search(sentence):
        return None
    fwd = _FORWARD.search(sentence)
    if not fwd or _AS_OF_LEAD.search(sentence):
        return None
    # The date or amount has to be part of what looks ahead, not a past figure before it
    # ("...was $16.4 billion, and we expect it to grow").
    ahead = sentence[fwd.start():]
    years = [int(y) for y in _YEAR.findall(ahead)]
    dated = any(y >= filed_year for y in years)
    amount = bool(_MONEY.search(ahead) or _PCT.search(ahead))
    if not (dated or amount):
        return None
    if _TOPIC["capital"].search(sentence):
        return "capital"
    if _TOPIC["outlook"].search(sentence):
        return "outlook"
    if _TOPIC["capital_weak"].search(sentence):
        return "capital"
    return "milestone" if dated else None


def extract(section: str, filed: str) -> list[dict]:
    year = int(filed[:4])
    out, seen = [], set()
    for s in _sentences(section):
        k = kind_of(s, year)
        if k and s not in seen:
            seen.add(s)
            out.append({"kind": k, "quote": s})
    return out


# --------------------------------------------------------------------------
# Chaining


_TERMS = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?\s*(?:million|billion|trillion)?|\d[\d,]*(?:\.\d+)?\s*(?:%|percent)|\b20\d\d\b|\b(?:early|mid|late|end|first|second|third|fourth|half|quarter)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b", re.I)


def _terms(text: str) -> list[str]:
    text = _FULL_DATE.sub("", text)
    return sorted(re.sub(r"\s+", " ", t.lower()) for t in _TERMS.findall(text))


def _rolled_forward(old: str, new: str) -> bool:
    """The same statement with every year moved on by the same step ("during fiscal 2026" then
    "during fiscal 2027") and nothing else different: routine, not a revision."""
    y_old, y_new = [int(y) for y in _YEAR.findall(old)], [int(y) for y in _YEAR.findall(new)]
    if not y_old or len(y_old) != len(y_new):
        return False
    steps = {b - a for a, b in zip(y_old, y_new)}
    if len(steps) != 1 or next(iter(steps)) < 1:
        return False
    strip = lambda t: _terms(_YEAR.sub("", _FULL_DATE.sub("", t)))
    return strip(old) == strip(new)


def _chain_similarity(a: str, b: str) -> float:
    return filing_diff._similarity(_FULL_DATE.sub("", a), _FULL_DATE.sub("", b))


def build_chains(filings: list[dict]) -> list[dict]:
    """``filings``: oldest first, each {"accession","form","filed","period_end","source_url",
    "items": [{"kind","quote"}]}. Returns chains of statements about the same commitment."""
    chains: list[dict] = []
    for idx, f in enumerate(filings):
        f["_idx"] = idx
        taken: set[int] = set()
        for it in f["items"]:
            best, best_sim = None, MIN_CHAIN_SIMILARITY
            for i, ch in enumerate(chains):
                if i in taken or ch["statements"][-1]["accession"] == f["accession"]:
                    continue
                # A statement absent for several filings is a different one, not a revision.
                if idx - ch["_last"] > MAX_GAP:
                    continue
                sim = _chain_similarity(ch["statements"][-1]["quote"], it["quote"])
                if sim >= best_sim:
                    best, best_sim = i, sim
            stmt = {"accession": f["accession"], "form": f["form"], "filed": f["filed"], "period_end": f.get("period_end"),
                    "source_url": f["source_url"], "quote": it["quote"], "change": "original"}
            if best is None:
                chains.append({"kind": it["kind"], "statements": [stmt], "_last": idx})
                taken.add(len(chains) - 1)
                continue
            prev = chains[best]["statements"][-1]
            if re.sub(r"\s+", " ", prev["quote"]).strip() == re.sub(r"\s+", " ", it["quote"]).strip():
                stmt["change"] = "same"
            elif _rolled_forward(prev["quote"], it["quote"]):
                stmt["change"] = "rolled_forward"
            elif _terms(prev["quote"]) == _terms(it["quote"]):
                stmt["change"] = "reworded"
            else:
                stmt["change"] = "revised"
                stmt["diff"] = filing_diff.word_diff(prev["quote"], it["quote"])
            chains[best]["statements"].append(stmt)
            chains[best]["_last"] = idx
            taken.add(best)
    latest = filings[-1]["accession"] if filings else None
    for f in filings:
        f.pop("_idx", None)
    for i, ch in enumerate(chains):
        st = ch["statements"]
        ch["id"] = f"c{i + 1}"
        ch.pop("_last", None)
        ch["first_seen"], ch["last_seen"] = st[0]["filed"], st[-1]["filed"]
        if st[-1]["accession"] != latest:
            ch["status"] = "not_repeated"
        elif len(st) == 1:
            ch["status"] = "new"
        elif any(s["change"] == "revised" for s in st):
            ch["status"] = "revised"
        else:
            ch["status"] = "unchanged"
    order = {"revised": 0, "new": 1, "unchanged": 2, "not_repeated": 3}
    chains.sort(key=lambda c: (order[c["status"]], c["kind"], c["first_seen"]))
    return chains


# --------------------------------------------------------------------------
# Building the dataset


def build_company(ticker: str, cik10: str, state: dict) -> list[dict]:
    """Chains for one company from its analyzed filings (fetches each MD&A)."""
    recs = {f["accession"]: f for f in state["companies"][ticker].get("qualitative", {}).get("filings", [])
            if f.get("status") == "ok"}
    feed = edgar_client.recent_filings(edgar_client.get_submissions(cik10), af.PERIODIC_FORMS)
    filings = []
    for f in sorted((f for f in feed if f["accession"] in recs), key=lambda f: (f["filed"], f["accession"])):
        section, url = af.extract_mda(cik10, f)
        filings.append({"accession": f["accession"], "form": f["form"], "filed": f["filed"], "period_end": f["period_end"],
                        "source_url": url, "items": extract(section, f["filed"])})
    return build_chains(filings)


def update(tickers: list[str]) -> list[str]:
    """Rebuild commitments for the given companies; returns tickers that failed (warned, not fatal)."""
    state = store.load_companies()
    doc = store.read_json(COMMITMENTS_FILE, {"companies": {}})
    ciks = edgar_client.resolve_ciks(tickers)
    failed = []
    for t in tickers:
        try:
            chains = build_company(t, ciks[t], state)
        except af.ExtractionError as exc:
            print(f"::warning title=Commitments {t}::{exc}", file=sys.stderr)
            failed.append(t)
            continue
        doc["companies"][t] = chains
        n = {s: sum(1 for c in chains if c["status"] == s) for s in ("revised", "new", "unchanged", "not_repeated")}
        print(f"{t}: {len(chains)} commitments {n}", file=sys.stderr)
    doc["generated_at"] = store.utc_now_iso()
    store.write_json(COMMITMENTS_FILE, doc)
    return failed


def main(argv: list[str]) -> int:
    try:
        update([t.upper() for t in argv] or all_tickers())
    except edgar_client.EdgarError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
