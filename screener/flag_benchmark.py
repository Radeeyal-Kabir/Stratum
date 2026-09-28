"""Benchmark for red-flag classification: how often is a flag wrong?

Usage:
    python -m screener.flag_benchmark sample              # pick flags from data/companies.json
    python -m screener.flag_benchmark context             # fetch each filing's passages (SEC)
    python -m screener.flag_benchmark run v2 MU --out benchmark/runs/v2/MU.json   # Ollama
    python -m screener.flag_benchmark report benchmark/runs/v1 benchmark/runs/v2

Steps:
  1. sample: draw flags already on file, spread across companies and weighted
     toward the categories most often misused. The same quote repeated in later
     filings counts once. Companies are split into a dev set (used to write the
     prompt) and a test set (only used to measure it), so a paragraph a company
     repeats every quarter can't sit on both sides.
  2. context: for every sampled filing, rebuild the exact chunks the model read
     (same extraction and selection code) and the paragraph around each quote,
     so labels can be checked against the filing and prompts compared on
     identical text without touching SEC again.
  3. Labels are written into benchmark/flags.json by hand: "supported",
     "unsupported" or "ambiguous", with a note and, for a real problem filed
     under the wrong category, the category it belongs in.
  4. run: replay a prompt version over the stored chunks.
  5. report: per split, for each labeled (filing, category) pair, whether a run
     still raises that category, plus every flag a run raises that has no label.

The unit is (filing, category) because that's what the score counts: one flag
per category per filing. This measures wrong flags, not missed ones; recall is
only checked on the flags labeled "supported".
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from screener import analyze_filing as af
from screener import store

ROOT = Path(__file__).resolve().parent.parent / "benchmark"
FLAGS_FILE = ROOT / "flags.json"
FILINGS_DIR = ROOT / "filings"

# How many flags to draw per category: heavier where the model is known to
# misfile (demand, guidance, margin), at least a few everywhere else.
QUOTAS = {
    "demand_weakness": 14, "guidance_cut": 12, "margin_pressure": 9, "liquidity_debt": 8,
    "restructuring_layoffs": 6, "inventory_buildup": 6, "pricing_pressure": 5, "customer_concentration": 4,
    "export_controls_geopolitical": 4, "supply_chain": 3, "accounting_controls": 3, "macro_fx": 3,
    "competition": 3, "impairment_writedown": 2, "regulatory_legal": 2, "other": 2,
}
# Known misclassifications that prompted this benchmark; always included.
MUST_INCLUDE = {"MU"}
# Company-level split. MU is in dev: its known errors are what the prompt is written against.
DEV_TICKERS = {"MU", "NVDA", "AMD", "HPE", "ORCL", "CRM", "INTU", "AAPL"}
LABELS = ("supported", "unsupported", "ambiguous")
SEED = 7


def _key(quote: str) -> str:
    return af._norm(quote)


def sample(state: dict) -> list[dict]:
    rng = random.Random(SEED)
    seen: dict[tuple[str, str], dict] = {}
    for ticker, rec in sorted(state["companies"].items()):
        filings = [f for f in rec.get("qualitative", {}).get("filings", []) if f.get("status") == "ok"]
        for f in filings:  # oldest first, so the latest filing carrying a quote wins
            for rf in f.get("red_flags", []):
                k = (ticker, _key(rf["quote"]))
                prior = seen.get(k)
                seen[k] = {
                    "ticker": ticker, "accession": f["accession"], "form": f["form"], "filed": f["filed"],
                    "period_end": f.get("period_end"), "source_url": f["source_url"],
                    "category": rf["category"], "summary": rf["summary"], "quote": rf["quote"],
                    "also_in": sorted({*(prior["also_in"] if prior else []), *([prior["accession"]] if prior else [])}),
                }
    pool = list(seen.values())
    rng.shuffle(pool)

    latest_mu = {f["accession"] for f in state["companies"]["MU"]["qualitative"]["filings"][-3:]} if "MU" in state["companies"] else set()
    chosen = [p for p in pool if p["ticker"] in MUST_INCLUDE and (p["accession"] in latest_mu or set(p["also_in"]) & latest_mu)]
    taken = Counter(p["category"] for p in chosen)
    for category, quota in QUOTAS.items():
        # Round-robin over companies so one talkative filer can't fill a category.
        by_ticker: dict[str, list[dict]] = defaultdict(list)
        for p in pool:
            if p["category"] == category and p not in chosen:
                by_ticker[p["ticker"]].append(p)
        order = sorted(by_ticker)
        rng.shuffle(order)
        while taken[category] < quota and any(by_ticker.values()):
            for t in order:
                if taken[category] >= quota:
                    break
                if by_ticker[t]:
                    chosen.append(by_ticker[t].pop())
                    taken[category] += 1

    chosen.sort(key=lambda p: (p["ticker"], p["filed"], p["category"]))
    for i, p in enumerate(chosen, 1):
        p.update({"id": f"F{i:03d}", "split": "dev" if p["ticker"] in DEV_TICKERS else "test",
                  "label": None, "better_category": None, "note": None, "passage": None})
    return [{k: p[k] for k in ("id", "split", "ticker", "accession", "form", "filed", "period_end", "source_url",
                               "category", "summary", "quote", "also_in", "passage", "label", "better_category", "note")}
            for p in chosen]


# --------------------------------------------------------------------------
# Context (needs SEC)


def _paragraphs(section: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n+", section) if p.strip()]


def passage_for(quote: str, section: str, around: int = 1) -> str | None:
    """The paragraph containing the quote plus its neighbors, so a label can read what surrounds it."""
    paras = _paragraphs(section)
    q = af._norm(quote)
    for i, p in enumerate(paras):
        if q in af._norm(p):
            return "\n\n".join(paras[max(0, i - around): i + around + 1])
    return None


def context(flags: list[dict]) -> None:
    from screener import edgar_client

    FILINGS_DIR.mkdir(parents=True, exist_ok=True)
    tickers = sorted({f["ticker"] for f in flags})
    ciks = edgar_client.resolve_ciks(tickers)
    feeds = {t: edgar_client.recent_filings(edgar_client.get_submissions(ciks[t]), af.PERIODIC_FORMS) for t in tickers}
    wanted = sorted({(f["ticker"], f["accession"]) for f in flags})
    for ticker, accession in wanted:
        filing = next(x for x in feeds[ticker] if x["accession"] == accession)
        print(f"{ticker} {accession}", file=sys.stderr)
        section, url = af.extract_mda(ciks[ticker], filing)
        chunks = af.chunk(af.select_text(section))
        store.write_json(FILINGS_DIR / f"{accession}.json", {
            "ticker": ticker, "accession": accession, "form": filing["form"], "filed": filing["filed"],
            "period_end": filing["period_end"], "source_url": url, "mda_chars": len(section),
            "chars_selected": sum(len(c) for c in chunks), "chunks": chunks,
        })
        for f in flags:
            if f["accession"] == accession:
                f["passage"] = passage_for(f["quote"], section)
                f["in_model_input"] = any(af.quote_in_text(f["quote"], c) for c in chunks)


# --------------------------------------------------------------------------
# Running a prompt version (needs Ollama)


def run(version: str, ticker: str) -> dict:
    out = {"prompt": version, "model": af.OLLAMA_MODEL, "filings": {}}
    for path in sorted(FILINGS_DIR.glob("*.json")):
        doc = json.loads(path.read_text())
        if doc["ticker"] != ticker:
            continue
        ctx = {"name": ticker, "ticker": ticker, "form": doc["form"], "period_end": doc["period_end"] or "unknown"}
        from screener.universe import by_ticker
        ctx["name"] = by_ticker(ticker).name
        results = [r for r in (af.analyze_chunk(c, ctx, version) for c in doc["chunks"]) if r is not None]
        out["filings"][doc["accession"]] = af.combine(results) if results else {"red_flags": [], "failed": True}
        print(f"{ticker} {doc['accession']}: {[rf['category'] for rf in out['filings'][doc['accession']]['red_flags']]}", file=sys.stderr)
    return out


# --------------------------------------------------------------------------
# Report


def _load_run(path: Path) -> dict:
    merged = {"filings": {}}
    for p in sorted(path.glob("*.json")) if path.is_dir() else [path]:
        data = json.loads(p.read_text())
        merged["prompt"] = data.get("prompt")
        merged["filings"].update(data["filings"])
    return merged


def evaluate(flags: list[dict], run_data: dict) -> dict:
    """Per split: labeled flags a run still raises, and flags it raises that have no label."""
    labeled = {(f["accession"], f["category"]): f for f in flags if f.get("label")}
    splits = {}
    for split in ("dev", "test"):
        items = [f for f in labeled.values() if f["split"] == split]
        accessions = {f["accession"] for f in flags if f["split"] == split}
        counts = Counter()
        kept_unsupported, dropped_supported, unlabeled = [], [], []
        for f in items:
            raised = {rf["category"]: rf for rf in run_data["filings"].get(f["accession"], {}).get("red_flags", [])}
            still = f["category"] in raised
            counts[(f["label"], still)] += 1
            if f["label"] == "unsupported" and still:
                kept_unsupported.append(f["id"])
            if f["label"] == "supported" and not still:
                dropped_supported.append(f["id"])
        for acc in sorted(accessions):
            for rf in run_data["filings"].get(acc, {}).get("red_flags", []):
                prior = labeled.get((acc, rf["category"]))
                if prior is None or _key(prior["quote"]) != _key(rf["quote"]):
                    unlabeled.append({"accession": acc, **rf})
        n_raised = sum(v for (label, still), v in counts.items() if still)
        n_bad = counts[("unsupported", True)]
        n_sup = counts[("supported", True)] + counts[("supported", False)]
        splits[split] = {
            "labeled": len(items),
            "unsupported_still_raised": f"{counts[('unsupported', True)]} of {counts[('unsupported', True)] + counts[('unsupported', False)]}",
            "supported_still_raised": f"{counts[('supported', True)]} of {n_sup}",
            "ambiguous_still_raised": f"{counts[('ambiguous', True)]} of {counts[('ambiguous', True)] + counts[('ambiguous', False)]}",
            "false_positive_rate_on_labeled": round(n_bad / n_raised, 3) if n_raised else None,
            "kept_unsupported": kept_unsupported, "dropped_supported": dropped_supported,
            "unlabeled_new_flags": unlabeled,
        }
    return splits


def population_estimate(flags: list[dict], state: dict) -> dict:
    """Share of all flags on file that are unsupported, reweighting each category's sampled
    rate by how common that category is (the sample over-draws the suspect categories).
    Ambiguous labels are reported separately rather than split."""
    population = Counter(rf["category"] for rec in state["companies"].values()
                         for f in rec.get("qualitative", {}).get("filings", []) if f.get("status") == "ok"
                         for rf in f.get("red_flags", []))
    by_cat: dict[str, Counter] = defaultdict(Counter)
    for f in flags:
        if f.get("label"):
            by_cat[f["category"]][f["label"]] += 1
    total = sum(population.values())
    est = {"unsupported": 0.0, "ambiguous": 0.0, "supported": 0.0}
    for cat, n in population.items():
        c = by_cat.get(cat)
        if not c:
            continue
        k = sum(c.values())
        for label in est:
            est[label] += n / total * c[label] / k
    covered = sum(n for cat, n in population.items() if cat in by_cat) / total if total else 0
    return {"flags_on_file": total, "share_of_flags_in_sampled_categories": round(covered, 3),
            **{f"est_{k}": round(v / covered, 3) if covered else None for k, v in est.items()}}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m screener.flag_benchmark")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sample")
    sub.add_parser("context")
    r = sub.add_parser("run")
    r.add_argument("version")
    r.add_argument("ticker")
    r.add_argument("--out", required=True, type=Path)
    rep = sub.add_parser("report")
    rep.add_argument("runs", nargs="+", type=Path)
    args = parser.parse_args(argv)

    if args.cmd == "sample":
        if FLAGS_FILE.exists():
            print(f"{FLAGS_FILE} exists; it holds labels. Delete it first to resample.", file=sys.stderr)
            return 1
        flags = sample(store.load_companies())
        store.write_json(FLAGS_FILE, flags)
        print(json.dumps({"flags": len(flags), "by_split": Counter(f["split"] for f in flags),
                          "by_category": Counter(f["category"] for f in flags)}, indent=2), file=sys.stderr)
    elif args.cmd == "context":
        flags = json.loads(FLAGS_FILE.read_text())
        context(flags)
        store.write_json(FLAGS_FILE, flags)
    elif args.cmd == "run":
        store.write_json(args.out, run(args.version, args.ticker.upper()))
    else:
        flags = json.loads(FLAGS_FILE.read_text())
        out = {"population_v1_labels": population_estimate(flags, store.load_companies())}
        out.update({str(p): evaluate(flags, _load_run(p)) for p in args.runs})
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
