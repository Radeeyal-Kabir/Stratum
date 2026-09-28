"""Qualitative pipeline: a 10-Q/10-K's MD&A -> management tone + red flags.

Usage:
    python -m screener.analyze_filing NVDA                 # latest 10-Q/10-K
    python -m screener.analyze_filing NVDA 0001045810-25-000209

Steps:
  1. Fetch the filing's primary HTML document and flatten it to text.
  2. Locate MD&A (10-K Item 7 / 10-Q Item 2). Headings also appear in the
     table of contents, so the longest heading-to-next-item span wins; only
     headings that start a line count, not cross-references in prose. If
     that span is only a stub incorporating MD&A by reference (IBM does
     this), follow it to the annual report exhibit (EX-13), found by its
     document type in the filing index.
  3. Select what to send to the model. A free GitHub Actions runner is
     CPU-only, so instead of the whole MD&A (often 50-100k characters) we
     keep the opening overview plus the paragraphs densest in tone/risk
     language, up to MAX_CHARS_ANALYZED, split into CHUNK_CHARS chunks.
     Safe-harbor legal boilerplate is never selected.
  4. Ask a small local model (via Ollama) for tone + red flags per chunk,
     with a JSON schema constraining the answer. Red flags must use a fixed
     category list (so persistence across quarters can be matched) and cite
     a verbatim quote; flags whose quote isn't in the text are dropped.
     The model also labels each flag's kind; only reported problems and
     lowered outlooks are kept, not hypothetical risks or disclaimers.
     Flags whose own summary negates them ("No guidance cut mentioned") or
     whose quote is boilerplate are dropped too: boilerplate recurs verbatim
     every quarter and would read as a persistent company-specific problem.
  5. Combine chunk results into one record per filing.

Section-extraction problems are recorded on the filing (status
"extraction_failed") and surfaced as a GitHub Actions warning rather than
aborting the run. EDGAR or Ollama being unreachable is a hard failure.
"""

from __future__ import annotations

import json
import os
import re
import sys
from html.parser import HTMLParser

import requests

from screener import edgar_client, store
from screener.universe import by_ticker

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
# num_predict: a small model can get stuck repeating one array item (IBM's 2025
# annual report did, until the 900s timeout aborted the run). A normal answer
# is 150-600 tokens; at ~5 tokens/s on CPU this cap ends well inside the timeout,
# and the truncated JSON is recorded as llm_failed instead of aborting the run.
OLLAMA_OPTIONS = {"temperature": 0, "seed": 42, "num_ctx": 4096, "num_predict": 1536}
OLLAMA_TIMEOUT = 900  # seconds per chunk; CPU inference is slow
MAX_FLAGS_PER_CHUNK = 8  # enforced by the JSON schema's grammar, which is what actually stops a repetition loop

PERIODIC_FORMS = ("10-K", "10-Q")
FILINGS_KEPT = 8

MAX_CHARS_ANALYZED = 12_000
CHUNK_CHARS = 6_000
OVERVIEW_CHARS = 2_500
MIN_SECTION_CHARS = 3_000

RED_FLAG_CATEGORIES = [
    "demand_weakness",
    "margin_pressure",
    "pricing_pressure",
    "supply_chain",
    "inventory_buildup",
    "customer_concentration",
    "competition",
    "export_controls_geopolitical",
    "regulatory_legal",
    "liquidity_debt",
    "restructuring_layoffs",
    "impairment_writedown",
    "accounting_controls",
    "guidance_cut",
    "macro_fx",
    "other",
]

TONE_VALUES = {"bearish": -1, "neutral": 0, "bullish": 1}

# Words that make a paragraph more informative about tone or risk.
SIGNAL_WORDS = re.compile(
    r"\b(declin\w*|decreas\w*|lower|weak\w*|soft\w*|headwind\w*|pressure\w*|uncertain\w*|challeng\w*|"
    r"slow\w*|delay\w*|constrain\w*|shortage\w*|excess|impair\w*|restructur\w*|litigation|investigation|"
    r"export|restriction\w*|tariff\w*|inventor\w*|concentrat\w*|record|strong\w*|robust|accelerat\w*|"
    r"grow\w*|increas\w*|demand|outlook|expect\w*|anticipat\w*|guidance|momentum|risk\w*)\b",
    re.IGNORECASE,
)

# Legal boilerplate that recurs near-verbatim every filing, so it's never
# evidence of a company-specific problem this period. Safe-harbor paragraphs
# aren't sent to the model at all; a pointer to the Risk Factors section can
# end an otherwise informative paragraph, so it only disqualifies a quote.
SAFE_HARBOR = re.compile(
    r"forward[\s-]looking\s+statements?|safe\s+harbor|private\s+securities\s+litigation\s+reform"
    r"|(undertakes?|assumes?)\s+no\s+(obligation|duty)|no\s+obligation\s+to\s+(publicly\s+)?(update|revise)",
    re.IGNORECASE,
)
BOILERPLATE_QUOTE = re.compile(
    rf"{SAFE_HARBOR.pattern}"
    r"|(see|refer\s+to|discussed\s+(in|under)|described\s+(in|under)|set\s+forth\s+in|provided\s+in|included\s+in"
    r"|section\s+titled)\W+(part\s+i+\W+)?(item\s+1a\W+)?\W*risk\s+factors",
    re.IGNORECASE,
)

# A summary saying the category doesn't apply: "No guidance cut mentioned",
# "No specific red flags mentioned in this excerpt", "...but no details on
# impact". "No assurance that..." is a real (if soft) flag, so it's exempt.
NEGATED_SUMMARY = re.compile(
    r"^\W*(no|none|nothing|not)\b(?!\s+(assurance|guarantee))"
    r"|\bno\s+(specific|explicit|significant|material|details?|mention|evidence|indication|impact)\b"
    r"|\bnot\s+(specifically\s+|explicitly\s+)?(mentioned|stated|disclosed|discussed|identified|indicated|specified)\b"
    r"|\b(isn't|is\s+not|are\s+not|aren't)\s+(mentioned|a\s+red\s+flag|a\s+concern)\b",
    re.IGNORECASE,
)

_SEP = r"[\s\.:\-–—|]*"
_MDA = r"management\W{0,3}s?\s+discussion"
SECTION_PATTERNS = {
    "10-K": (rf"item{_SEP}7{_SEP}{_MDA}", rf"item{_SEP}7a\b|item{_SEP}8{_SEP}financial\s+statements"),
    "10-Q": (rf"item{_SEP}2{_SEP}{_MDA}", rf"item{_SEP}3{_SEP}quantitative|item{_SEP}4{_SEP}controls"),
    # Annual-report exhibits (EX-13) have no Item numbers.
    "EX-13": (
        _MDA,
        r"report\s+of\s+management\b|report\s+of\s+independent\s+registered\s+public\s+accounting\s+firm"
        r"|consolidated\s+(income\s+)?statements?\s+of\s+(earnings|income|operations)",
    ),
}

# Headings start a line of the flattened text (a heading split across table
# cells is joined onto one line). Cross-references in running prose -- 'see
# "Part II, Item 8. Financial Statements..."' -- don't, and must neither open
# nor close the section: QCOM's 10-Qs quote "Part I, Item 2. Management's
# Discussion..." inside Risk Factors, and that span (Risk Factors through the
# signatures) used to win as the longest.
_HEADING = r"^[ \t]*(?:part\s+i{{1,2}}\W{{0,5}})?(?:{})"


class QualitativeError(RuntimeError):
    """Environment problem (Ollama down, model missing): abort the run."""


class ExtractionError(RuntimeError):
    """This filing's MD&A couldn't be located/analyzed: record it and move on."""


# --------------------------------------------------------------------------
# HTML -> text


class _TextExtractor(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section", "center"}
    VOID = {"br", "img", "hr", "meta", "input", "link", "col", "area", "base", "wbr"}
    SKIP = {"script", "style", "head", "title", "ix:header"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.stack: list[tuple[str, bool]] = []  # (tag, hidden)

    def _hidden(self) -> bool:
        return bool(self.stack) and self.stack[-1][1]

    def handle_starttag(self, tag, attrs):
        if tag in self.BLOCK:
            self.parts.append("\n")
        if tag in self.VOID:
            return
        style = (dict(attrs).get("style") or "").replace(" ", "").lower()
        hidden = self._hidden() or tag in self.SKIP or "display:none" in style
        self.stack.append((tag, hidden))

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self.parts.append(" | ")
        elif tag in self.BLOCK:
            self.parts.append("\n")
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if not self._hidden():
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    parser.feed(html)
    text = "".join(parser.parts).replace("\xa0", " ").replace("​", "")
    lines = [re.sub(r"[ \t|]+", " ", line).strip(" |") for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


# --------------------------------------------------------------------------
# Locating MD&A


def find_section(text: str, kind: str) -> str:
    start_pat, end_pat = (_HEADING.format(p) for p in SECTION_PATTERNS[kind])
    flags = re.IGNORECASE | re.MULTILINE
    starts = [m.start() for m in re.finditer(start_pat, text, flags)]
    if not starts:
        raise ExtractionError(f"No MD&A heading found ({kind})")
    ends = [m.start() for m in re.finditer(end_pat, text, flags)]
    best, best_closed = "", False
    for s in starts:
        e = next((e for e in ends if e > s + 50), None)
        closed = e is not None
        span = text[s:e if closed else min(len(text), s + 250_000)]
        # A span that reaches its closing heading beats one that runs off the end of the document.
        if (closed, len(span)) > (best_closed, len(best)):
            best, best_closed = span, closed
    return best.strip()


def _incorporated_by_reference(section: str) -> bool:
    return len(section) < MIN_SECTION_CHARS and re.search(r"incorporated\W+(herein\W+)?by\W+reference", section, re.I) is not None


def _annual_report_exhibit(cik10: str, accession: str) -> str | None:
    """Filename of the filing's EX-13 (annual report to shareholders), if any."""
    html_docs = [n for n in edgar_client.filing_documents(cik10, accession) if n.lower().endswith((".htm", ".html"))]
    by_name = [n for n in html_docs if re.search(r"ex-?13", n, re.I)]
    if by_name:
        return by_name[0]
    # The filename needn't say so (IBM's EX-13 is "ibm-20251231_d2.htm"); the
    # filing index's document type does.
    types = edgar_client.filing_document_types(cik10, accession)
    return next((n for n in html_docs if re.fullmatch(r"EX-13(\.\d+)?", types.get(n, ""))), None)


def extract_mda(cik10: str, filing: dict) -> tuple[str, str]:
    """Return (mda_text, source_url)."""
    url = edgar_client.archive_url(cik10, filing["accession"], filing["primary_document"])
    text = html_to_text(edgar_client.get_text(url))
    kind = "10-K" if filing["form"].startswith("10-K") else "10-Q"
    section = find_section(text, kind)

    if _incorporated_by_reference(section):
        exhibit = _annual_report_exhibit(cik10, filing["accession"])
        if not exhibit:
            raise ExtractionError("MD&A incorporated by reference, but no EX-13 exhibit found")
        url = edgar_client.archive_url(cik10, filing["accession"], exhibit)
        section = find_section(html_to_text(edgar_client.get_text(url)), "EX-13")

    if len(section) < MIN_SECTION_CHARS:
        raise ExtractionError(f"MD&A section too short ({len(section)} chars) — likely mis-located")
    return section, url


# --------------------------------------------------------------------------
# Selecting and chunking text for the model


def _prose_paragraphs(section: str) -> list[str]:
    paras = []
    for p in re.split(r"\n+", section):
        p = p.strip()
        letters = sum(ch.isalpha() for ch in p)
        # Drop table rows, page numbers, short headings and safe-harbor boilerplate.
        if len(p) >= 80 and letters / len(p) >= 0.6 and not SAFE_HARBOR.search(p):
            paras.append(p)
    return paras


def select_text(section: str, budget: int = MAX_CHARS_ANALYZED) -> list[str]:
    """Opening overview + highest-signal paragraphs, in original order."""
    paras = _prose_paragraphs(section)
    chosen: set[int] = set()
    used = 0
    for i, p in enumerate(paras):
        if used >= OVERVIEW_CHARS:
            break
        chosen.add(i)
        used += len(p)

    def density(i: int) -> float:
        return len(SIGNAL_WORDS.findall(paras[i])) / max(1, len(paras[i]) / 100)

    for i in sorted((i for i in range(len(paras)) if i not in chosen), key=density, reverse=True):
        if used + len(paras[i]) > budget:
            continue
        chosen.add(i)
        used += len(paras[i])
    return [paras[i] for i in sorted(chosen)]


def chunk(paragraphs: list[str], size: int = CHUNK_CHARS) -> list[str]:
    chunks: list[str] = []
    current = ""
    for p in paragraphs:
        p = p[:size]
        if current and len(current) + len(p) + 2 > size:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{p}" if current else p
    if current:
        chunks.append(current)
    return chunks


# --------------------------------------------------------------------------
# The model

# The model labels what each flag's quote is; only these kinds are kept.
# Asking a small model to classify the quote it just copied works far better
# than asking it to silently "skip boilerplate".
FLAG_KINDS = ["reported_problem", "lowered_outlook", "possible_risk", "disclaimer"]
KEPT_FLAG_KINDS = {"reported_problem", "lowered_outlook"}

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "tone": {"type": "string", "enum": list(TONE_VALUES)},
        "reason": {"type": "string"},
        "red_flags": {
            "type": "array",
            "maxItems": MAX_FLAGS_PER_CHUNK,
            "items": {
                "type": "object",
                # Quote first, so the kind, category and summary are about the text actually cited.
                "properties": {
                    "quote": {"type": "string"},
                    "kind": {"type": "string", "enum": FLAG_KINDS},
                    "category": {"type": "string", "enum": RED_FLAG_CATEGORIES},
                    "summary": {"type": "string"},
                },
                "required": ["quote", "kind", "category", "summary"],
            },
        },
    },
    "required": ["tone", "reason", "red_flags"],
}

FLAG_KINDS_V2 = ["got_worse", "lowered_outlook", "improved_or_unchanged", "could_happen", "disclaimer"]
KEPT_FLAG_KINDS_V2 = {"got_worse", "lowered_outlook"}


def _schema(kinds: list[str]) -> dict:
    schema = json.loads(json.dumps(RESPONSE_SCHEMA))
    schema["properties"]["red_flags"]["items"]["properties"]["kind"]["enum"] = kinds
    return schema


SCHEMAS = {"v1": RESPONSE_SCHEMA, "v2": _schema(FLAG_KINDS_V2)}
KEPT_KINDS = {"v1": KEPT_FLAG_KINDS, "v2": KEPT_FLAG_KINDS_V2}

# v2 also requires the quote itself to be about its category, and for the
# directional categories to point the right way. A small model often picks a
# category from one shared word; these checks are cheap and deterministic.
_WORSE = (r"\b(decreas\w*|declin\w*|lower\w*|fell|fall\w*|drop\w*|down|weak\w*|soft\w*|fewer|reduc\w*|slow\w*"
          r"|loss\w*|lost|delay\w*|compress\w*|pressure\w*|headwind\w*|below|negative\w*|advers\w*|unfavorab\w*"
          r"|shortfall|cut\w*|constrain\w*|shortage\w*|charges?|impact\w*|hurt|harm\w*)\b")
_BETTER = r"\b(increas\w*|grew|grow\w*|higher|improv\w*|strong\w*|record|benefit\w*|favorab\w*|exceed\w*|gains?|robust|accelerat\w*)\b"
CATEGORY_EVIDENCE = {
    "demand_weakness": [_WORSE],
    "margin_pressure": [r"\b(margins?|profitab\w*|costs?|expenses?|charges?)\b"],
    "pricing_pressure": [r"\b(pric\w*|discount\w*|asps?)\b"],
    "supply_chain": [r"\b(suppl\w*|shortage\w*|constrain\w*|components?|manufactur\w*|capacity|lead\s+times?|logistic\w*|production)\b"],
    "inventory_buildup": [r"\binventor(y|ies)\b"],
    "customer_concentration": [r"\bcustomers?\b"],
    "competition": [r"\b(compet\w*|rivals?|in-house|market\s+share|vertical\s+integration|rather\s+than\s+our|its\s+own)\b"],
    "export_controls_geopolitical": [r"\b(export\w*|tariff\w*|sanction\w*|licen[cs]\w*|china|trade|restrict\w*|geopolit\w*|entity\s+list)\b"],
    "regulatory_legal": [r"\b(litigat\w*|lawsuits?|legal|courts?|fines?|penalt\w*|settle\w*|regulat\w*|investigat\w*|antitrust|rulings?|complian\w*)\b"],
    "liquidity_debt": [r"\b(liquidity|borrow\w*|debt|credit\s+facilit\w*|covenants?|refinanc\w*|downgrad\w*|going\s+concern|cash)\b"],
    "restructuring_layoffs": [r"\b(restructur\w*|severance|layoffs?|workforce\s+reduction|reduction\s+in\s+(force|workforce)|reorganiz\w*|exit\s+costs?|terminat\w*)\b"],
    "impairment_writedown": [r"\b(impair\w*|write-?(downs?|offs?)|written\s+(down|off)|valuation\s+allowance)\b"],
    "accounting_controls": [r"\b(material\s+weakness\w*|restat\w*|internal\s+control\w*|significant\s+deficienc\w*)\b"],
    "guidance_cut": [r"\b(expect\w*|outlook|guidance|forecast\w*|anticipat\w*|project\w*)\b",
                     r"\b(lower\w*|reduc\w*|below|cut\w*|delay\w*|later|push\w*|decreas\w*|revis\w*|weaker|withdr\w*)\b"],
    "macro_fx": [r"\b(currenc\w*|foreign\s+exchange|fx|macro\w*|econom\w*|interest\s+rates?|inflation\w*)\b"],
}
# Categories where "it went up" is only ever good news: a quote with a rise and no decline isn't a problem.
_BETTER_ONLY_EXCLUDES = {"demand_weakness", "margin_pressure", "pricing_pressure", "guidance_cut", "macro_fx", "other"}


def evidence_ok(category: str, quote: str) -> bool:
    q = quote.lower()
    if not all(re.search(rx, q) for rx in CATEGORY_EVIDENCE.get(category, [])):
        return False
    if category in _BETTER_ONLY_EXCLUDES and re.search(_BETTER, q) and not re.search(_WORSE, q):
        return False
    return True


SYSTEM_PROMPT = (
    "You are a careful equity analyst reading the Management's Discussion and Analysis (MD&A) "
    "section of an SEC filing. Answer only with JSON matching the requested schema."
)

PROMPT_TEMPLATE = """Company: {name} ({ticker}). Filing: {form} for the period ending {period_end}.

Read this MD&A excerpt and return:
- "tone": management's overall tone about the business: "bullish" (confident, strong demand, improving results), "neutral" (balanced or purely factual), or "bearish" (cautious, weakening results, headwinds dominate).
- "reason": one sentence explaining the tone.
- "red_flags": problems management reports about THIS company in THIS period: a result that got worse (e.g. revenue or margin declined), something that happened (e.g. a charge, layoffs, a lost customer, a new restriction hitting sales), or an outlook management lowered. Use an empty list if there are none.
  Do NOT include:
  * legal disclaimers: forward-looking-statement warnings, "we undertake no obligation to update", pointers to the Risk Factors section;
  * risks that could or may happen (economic conditions, exchange rates, trade policy, competition, regulation) unless the excerpt says they are hurting results now;
  * good or neutral facts: cash is sufficient, no borrowings, no impact expected, plans to buy back shares;
  * a category that does not apply. Never write a red flag whose summary says something is "not mentioned".
  For each red flag:
  * "quote": 5-25 words copied exactly, word for word, from the excerpt;
  * "kind": "reported_problem" (something bad that happened this period), "lowered_outlook" (management expects worse results ahead), "possible_risk" (something that could or may happen), or "disclaimer" (legal boilerplate);
  * "category": one of: {categories};
  * "summary": at most 20 words stating the problem.

Excerpt:
\"\"\"
{text}
\"\"\"
"""

# v2, written against the benchmark's dev split (benchmark/flags.json). The v1
# failures it targets: flagging favourable facts ("revenue increased 62%"),
# filing any forward-looking sentence as a guidance cut, and categories chosen
# by a shared word ("demand exceeds supply" as demand weakness, receivables or
# goodwill as inventory, buybacks as liquidity strain).
PROMPT_V2 = """Company: {name} ({ticker}). Filing: {form} for the period ending {period_end}.

Read this MD&A excerpt and return:
- "tone": management's overall tone about the business: "bullish" (confident, strong demand, improving results), "neutral" (balanced or purely factual), or "bearish" (cautious, weakening results, headwinds dominate).
- "reason": one sentence explaining the tone.
- "red_flags": sentences showing that something got WORSE for {name} in this period, or that management LOWERED what it expects. Most excerpts have zero to three. Use an empty list if there are none.

For each red flag:
* "quote": 8-40 words copied exactly from the excerpt. The quoted words themselves must show the problem; never quote a positive sentence because a negative one is nearby.
* "kind": what the quoted sentence says:
  - "got_worse": a result declined or a bad event happened in this period (sales fell, margin fell, a charge was recorded, a customer was lost);
  - "lowered_outlook": management now expects less than it expected before;
  - "improved_or_unchanged": a result grew, improved, or is simply described (revenue increased, costs fell, buybacks, a new plan, a prior year's event);
  - "could_happen": a risk that may or could occur;
  - "disclaimer": legal boilerplate.
* "category", using these definitions:
  - demand_weakness: sales, orders, units or customer spending FELL. Not demand that is strong or exceeds supply.
  - margin_pressure: gross or operating margin FELL, or costs rose faster than revenue. Not margins that improved or costs that fell.
  - pricing_pressure: the company's selling prices FELL or discounting rose.
  - supply_chain: shortages or supplier problems held back the company's own shipments or raised its costs.
  - inventory_buildup: the company's inventory rose faster than sales, or it recorded excess-inventory charges. Not receivables, goodwill or headcount.
  - customer_concentration: reliance on a few customers rose, or a major customer was lost.
  - competition: the company lost share or a customer switched to a rival or to its own product.
  - export_controls_geopolitical: export rules, tariffs or sanctions that already cut sales or raised costs.
  - regulatory_legal: fines, lawsuits, rulings or investigations with an actual effect. Not tax-rate changes.
  - liquidity_debt: cash running short, borrowing to fund operations, refinancing or covenant strain. Not share buybacks, dividends or routine cash-flow line items.
  - restructuring_layoffs: layoffs, restructuring plans or restructuring charges. Not hiring or acquisitions.
  - impairment_writedown: impairments or write-downs recorded in this period.
  - accounting_controls: material weaknesses, restatements or control failures.
  - guidance_cut: management REDUCED an earlier expectation (a lower revenue or margin outlook, a date pushed later). Not a new plan, a construction schedule, expected growth, or costs expected to rise with growth.
  - macro_fx: currency or economic conditions that already reduced results.
  - other: a clearly adverse event that fits none of the above.
* "summary": at most 20 words stating the problem.

Excerpt:
\"\"\"
{text}
\"\"\"
"""

# Prompt versions are kept side by side so screener/flag_benchmark.py can compare
# them on identical text; each analyzed filing records the version that read it.
PROMPTS = {"v1": PROMPT_TEMPLATE, "v2": PROMPT_V2}
PROMPT_VERSION = "v1"


def _ollama_generate(prompt: str, schema: dict = RESPONSE_SCHEMA) -> str:
    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={
                "model": OLLAMA_MODEL,
                "system": SYSTEM_PROMPT,
                "prompt": prompt,
                "format": schema,
                "stream": False,
                "options": OLLAMA_OPTIONS,
            },
            timeout=OLLAMA_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise QualitativeError(f"Ollama not reachable at {OLLAMA_URL}: {exc}") from exc
    if resp.status_code == 404:
        raise QualitativeError(f"Model {OLLAMA_MODEL!r} not available — run `ollama pull {OLLAMA_MODEL}`")
    if resp.status_code != 200:
        raise QualitativeError(f"Ollama HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json().get("response", "")


def _norm(s: str) -> str:
    s = s.lower().replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip(" .,;:\"'")


def quote_in_text(quote: str, text: str) -> bool:
    """The whole quote must appear verbatim (modulo whitespace/quote-style normalization).
    A model that trails off or alters the tail of a quote has its flag dropped, not trimmed:
    accepting a quote on a partial match would let unverified text stand next to a "quoted
    word for word" claim."""
    q, t = _norm(quote), _norm(text)
    if len(q.split()) < 4:
        return False
    return q in t


def analyze_chunk(text: str, context: dict, version: str = PROMPT_VERSION) -> dict | None:
    prompt = PROMPTS[version].format(text=text, categories=", ".join(RED_FLAG_CATEGORIES), **context)
    for _ in range(2):
        raw = _ollama_generate(prompt, SCHEMAS[version])
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if data.get("tone") not in TONE_VALUES:
            continue
        flags, dropped, not_flags = [], 0, 0
        for rf in data.get("red_flags") or []:
            if not isinstance(rf, dict):
                continue
            quote, summary = str(rf.get("quote", "")), str(rf.get("summary", ""))
            if not quote_in_text(quote, text):
                dropped += 1
            elif not is_red_flag(rf.get("kind"), summary, quote, KEPT_KINDS[version]):
                not_flags += 1
            elif version != "v1" and not evidence_ok(rf.get("category", "other"), quote):
                not_flags += 1
            else:
                category = rf.get("category") if rf.get("category") in RED_FLAG_CATEGORIES else "other"
                flags.append({"category": category, "summary": summary[:200], "quote": quote[:300]})
        return {"tone": data["tone"], "reason": str(data.get("reason", ""))[:300],
                "red_flags": flags, "dropped": dropped, "not_flags": not_flags, "chars": len(text)}
    return None


def is_red_flag(kind, summary: str, quote: str, kept: set[str] = KEPT_FLAG_KINDS) -> bool:
    """False for what the model itself labels a hypothetical risk or disclaimer, for flags whose
    own summary says they don't apply, and for boilerplate quotes, whatever the model called them."""
    if kind is not None and kind not in kept:
        return False
    return not NEGATED_SUMMARY.search(summary) and not BOILERPLATE_QUOTE.search(quote)


def combine(chunk_results: list[dict]) -> dict:
    """Length-weighted average tone; red flags de-duplicated by category."""
    total = sum(r["chars"] for r in chunk_results)
    avg = sum(TONE_VALUES[r["tone"]] * r["chars"] for r in chunk_results) / total
    tone = "bullish" if avg > 0.33 else "bearish" if avg < -0.33 else "neutral"
    reason = next((r["reason"] for r in chunk_results if r["tone"] == tone), chunk_results[0]["reason"])
    flags: dict[str, dict] = {}
    for r in chunk_results:
        for rf in r["red_flags"]:
            flags.setdefault(rf["category"], rf)
    return {
        "tone": tone,
        "tone_score": round(avg, 3),
        "tone_rationale": reason,
        "red_flags": [flags[c] for c in sorted(flags)],
        "unverified_flags_dropped": sum(r["dropped"] for r in chunk_results),
        "non_flags_dropped": sum(r.get("not_flags", 0) for r in chunk_results),
    }


# --------------------------------------------------------------------------
# Orchestration


def analyze_filing(ticker: str, cik10: str, filing: dict) -> dict:
    company = by_ticker(ticker)
    base = {
        "accession": filing["accession"],
        "form": filing["form"],
        "filed": filing["filed"],
        "period_end": filing["period_end"],
        "analyzed_at": store.utc_now_iso(),
        "model": OLLAMA_MODEL,
        "prompt_version": PROMPT_VERSION,
    }
    try:
        section, source_url = extract_mda(cik10, filing)
    except ExtractionError as exc:
        return {**base, "status": "extraction_failed", "error": str(exc)}

    selected = select_text(section)
    context = {"name": company.name, "ticker": ticker, "form": filing["form"],
               "period_end": filing["period_end"] or "unknown"}
    results = [r for r in (analyze_chunk(c, context) for c in chunk(selected)) if r is not None]
    if not results:
        return {**base, "status": "llm_failed", "error": "Model returned no valid JSON for any chunk",
                "source_url": source_url}
    return {
        **base,
        "status": "ok",
        "source_url": source_url,
        "mda_chars": len(section),
        "chars_analyzed": sum(r["chars"] for r in results),
        **combine(results),
    }


def record_result(state: dict, ticker: str, result: dict) -> None:
    rec = state["companies"][ticker]
    filings = [f for f in rec.setdefault("qualitative", {}).get("filings", [])
               if f["accession"] != result["accession"]]
    filings.append(result)
    filings.sort(key=lambda f: (f.get("period_end") or f["filed"], f["filed"]))
    rec["qualitative"]["filings"] = filings[-FILINGS_KEPT:]
    rec["qualitative_as_of"] = store.utc_now_iso()
    if result["status"] != "ok":
        # Shows as a yellow annotation on the Actions run without failing it.
        print(f"::warning title=Qualitative {ticker}::{result['accession']} {result['status']}: "
              f"{result.get('error')}", file=sys.stderr)


def main(argv: list[str]) -> int:
    from screener import score

    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    ticker = argv[0].upper()
    state = store.load_companies()
    try:
        cik10 = edgar_client.resolve_ciks([ticker])[ticker]
        filings = edgar_client.recent_filings(edgar_client.get_submissions(cik10), PERIODIC_FORMS)
        if len(argv) > 1:
            filing = next(f for f in filings if f["accession"] == argv[1])
        else:
            filing = filings[0]
        result = analyze_filing(ticker, cik10, filing)
    except StopIteration:
        print(f"ERROR: accession {argv[1]} is not a recent 10-K/10-Q for {ticker}", file=sys.stderr)
        return 1
    except (edgar_client.EdgarError, QualitativeError) as exc:
        print(f"ERROR: {exc}\nNothing written.", file=sys.stderr)
        return 1
    record_result(state, ticker, result)
    state["companies"][ticker]["cik"] = cik10
    score.rescore_all(state)
    store.save_companies(state)
    print(json.dumps({k: v for k, v in result.items() if k != "red_flags"}, indent=2), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
