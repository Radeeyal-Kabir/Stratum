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
# Labels for flags a replayed prompt raised that weren't in the original sample,
# keyed the same way: filing, category, quote. Same label scheme as flags.json.
EXTRA_LABELS_FILE = ROOT / "extra_labels.json"
# A random sample of unflagged negative-wording sentences from the excerpts the model saw,
# labeled for whether each is a real problem it missed; used to estimate what a prompt misses.
MISSED_FILE = ROOT / "missed.json"

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
        trace: list[dict] = []
        results = [r for r in (af.analyze_chunk(c, ctx, version, trace) for c in doc["chunks"]) if r is not None]
        out["filings"][doc["accession"]] = {**(af.combine(results) if results else {"red_flags": [], "failed": True}),
                                            "proposals": trace}
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


def apply_reviews(items: list[dict]) -> list[dict]:
    """Where the reviewer gave a verdict it replaces the draft label (kept as ``draft_label``)."""
    for f in items:
        if f.get("reviewer_label"):
            f["draft_label"] = f.get("label")
            f["label"] = f["reviewer_label"]
    return items


def review_stats(items: list[dict]) -> dict:
    reviewed = [f for f in items if f.get("reviewer_label")]
    return {"total": len(items), "reviewed": len(reviewed),
            "changed": sum(1 for f in reviewed if f["reviewer_label"] != f.get("label"))}


def _label_index(flags: list[dict], extra: list[dict]) -> dict:
    return {(f["accession"], f["category"], _key(f["quote"])): f["label"] for f in [*flags, *extra] if f.get("label")}


def evaluate(flags: list[dict], run_data: dict, extra: list[dict] | None = None) -> dict:
    """Per split: labeled flags a run still raises, flags it raises that have no label, and
    the label mix of everything it raises."""
    index = _label_index(flags, extra or [])
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
        raised = Counter()
        for acc in sorted(accessions):
            for rf in run_data["filings"].get(acc, {}).get("red_flags", []):
                label = index.get((acc, rf["category"], _key(rf["quote"])))
                raised[label or "unlabeled"] += 1
                if label is None:
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
            "all_raised": dict(raised),
            "unsupported_share_of_raised": round(raised["unsupported"] / (sum(raised.values()) - raised["unlabeled"]), 3)
            if sum(raised.values()) > raised["unlabeled"] else None,
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


def load_labeled() -> tuple[list[dict], list[dict]]:
    """flags.json and extra_labels.json with reviewer verdicts applied."""
    flags = json.loads(FLAGS_FILE.read_text())
    extra = json.loads(EXTRA_LABELS_FILE.read_text()) if EXTRA_LABELS_FILE.exists() else []
    return flags, extra


def _ensure_extra_ids(extra: list[dict]) -> None:
    for i, f in enumerate(extra, 1):
        f.setdefault("id", f"E{i:03d}")


def build_review(flags: list[dict], extra: list[dict], runs_dir: Path = ROOT / "runs") -> list[dict]:
    """Everything a reviewer needs, one item per label, in a fixed shuffled order (so a
    reviewer who stops early has seen a spread of companies and categories)."""
    _ensure_extra_ids(extra)
    raised: dict[tuple, list[str]] = defaultdict(list)
    for d in sorted(runs_dir.glob("*")) if runs_dir.exists() else []:
        if d.is_dir():
            for acc, f in _load_run(d)["filings"].items():
                for rf in f.get("red_flags", []):
                    raised[(acc, rf["category"], _key(rf["quote"]))].append(d.name)
    meta, text = {}, {}
    for path in FILINGS_DIR.glob("*.json"):
        doc = json.loads(path.read_text())
        meta[doc["accession"]] = doc
        text[doc["accession"]] = "\n\n".join(doc["chunks"])
    items = []
    for f in [*flags, *extra]:
        m = meta.get(f["accession"], {})
        passage = f.get("passage")
        if not passage and f["accession"] in text:
            passage = passage_for(f["quote"], text[f["accession"]])
        items.append({
            "id": f["id"], "ticker": f.get("ticker") or m.get("ticker"), "form": f.get("form") or m.get("form"),
            "filed": f.get("filed") or m.get("filed"), "source_url": f.get("source_url") or m.get("source_url"),
            "category": f["category"], "summary": f.get("summary"), "quote": f["quote"], "passage": passage,
            "split": f.get("split"), "raised_by": sorted(set(raised.get((f["accession"], f["category"], _key(f["quote"])), []))),
            "draft_label": f.get("draft_label") or f.get("label"), "draft_note": f.get("note"),
            "draft_better_category": f.get("better_category"),
        })
    random.Random(SEED).shuffle(items)
    return items


def apply_verdicts(flags: list[dict], extra: list[dict], verdicts: dict) -> dict:
    """Record a reviewer's exported verdicts ({id: {label, comment}}) on the label files."""
    _ensure_extra_ids(extra)
    by_id = {f["id"]: f for f in [*flags, *extra]}
    unknown = [i for i in verdicts if i not in by_id]
    for i, v in verdicts.items():
        f = by_id.get(i)
        if f is None:
            continue
        if v.get("label") not in LABELS:
            raise ValueError(f"{i}: label must be one of {LABELS}")
        f["reviewer_label"] = v["label"]
        f["reviewer_comment"] = v.get("comment") or None
    return {"applied": len(verdicts) - len(unknown), "unknown_ids": unknown, **review_stats([*flags, *extra])}


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / d
    return max(0.0, centre - half), min(1.0, centre + half)


def recall_estimates(flags: list[dict], extra: list[dict], runs: dict[str, Path], missed: dict) -> dict:
    """What share of the real problems in the excerpts each prompt raised.

    Real problems = every distinct flag labeled supported on the test filings (found by some
    prompt) plus an estimate of the ones no prompt raised, scaled up from the missed sample."""
    test_acc = {f["accession"] for f in flags if f["split"] == "test"}
    known = {(f["accession"], _key(f["quote"])) for f in [*flags, *extra]
             if f.get("label") == "supported" and f["accession"] in test_acc}
    sample = missed["sample"]
    k = sum(1 for m in sample if m["label"] == "supported")
    lo, hi = wilson(k, len(sample))
    pop = missed["population"]
    est = {"mid": pop * k / len(sample), "low": pop * lo, "high": pop * hi}
    out = {"known_real": len(known), "missed_sample": len(sample), "missed_sample_real": k, "candidates": pop,
           "est_missed": {a: round(b) for a, b in est.items()}}
    for version, path in runs.items():
        run = _load_run(path)["filings"]
        found = {(acc, _key(rf["quote"])) for acc in test_acc for rf in run.get(acc, {}).get("red_flags", [])} & known
        share = lambda m: round(len(found) / (len(known) + m), 3)
        out[version] = {"found": len(found), "share_found": share(est["mid"]),
                        "share_found_low": share(est["high"]), "share_found_high": share(est["low"])}
    return out


def publish(flags: list[dict], extra: list[dict], runs: dict[str, Path]) -> dict:
    """The summary the site shows: per prompt version, the label mix of every flag it
    raised on the held-out test filings."""
    stats = review_stats([*flags, *extra])
    apply_reviews(flags)
    apply_reviews(extra)
    results = {}
    for version, path in runs.items():
        t = evaluate(flags, _load_run(path), extra)["test"]
        r = t["all_raised"]
        labeled = sum(v for k, v in r.items() if k != "unlabeled")
        results[version] = {
            "raised": sum(r.values()), "labeled": labeled,
            "supported": r.get("supported", 0), "unsupported": r.get("unsupported", 0), "ambiguous": r.get("ambiguous", 0),
            "unsupported_share": round(r.get("unsupported", 0) / labeled, 3) if labeled else None,
            "known_good_kept": t["supported_still_raised"],
        }
    test = [f for f in flags if f["split"] == "test"]
    recall = None
    if MISSED_FILE.exists():
        recall = recall_estimates(flags, extra, runs, json.loads(MISSED_FILE.read_text()))
        for version in results:
            results[version]["recall"] = recall[version]
    return {
        "as_of": store.utc_now_iso()[:10],
        "model": af.OLLAMA_MODEL,
        "live_prompt": af.PROMPT_VERSION,
        "test_filings": len({f["accession"] for f in test}),
        "test_companies": len({f["ticker"] for f in test}),
        "labeled_by": ("Claude, reading each flag in its surrounding filing text" if not stats["reviewed"] else
                       f"Claude, reading each flag in its surrounding filing text; {stats['reviewed']} of {stats['total']} "
                       f"confirmed by the project owner ({stats['changed']} changed)"),
        "recall_sample": {k: v for k, v in (recall or {}).items() if k not in results},
        "labels_reviewed": stats["reviewed"], "labels_total": stats["total"], "labels_changed": stats["changed"],
        "results": results,
    }


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
    sub.add_parser("build-review", help="write benchmark/review.json for the review page")
    ar = sub.add_parser("apply-review", help="record a reviewer's exported verdicts")
    ar.add_argument("file", type=Path)
    pub = sub.add_parser("publish", help="write data/benchmark.json from runs given as version=path")
    pub.add_argument("runs", nargs="+")
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
    elif args.cmd == "publish":
        flags = json.loads(FLAGS_FILE.read_text())
        extra = json.loads(EXTRA_LABELS_FILE.read_text()) if EXTRA_LABELS_FILE.exists() else []
        runs = dict(r.split("=", 1) for r in args.runs)
        store.write_json(store.DATA_DIR / "benchmark.json", publish(flags, extra, {k: Path(v) for k, v in runs.items()}))
    elif args.cmd == "build-review":
        flags, extra = load_labeled()
        store.write_json(ROOT / "review.json", build_review(flags, extra))
        store.write_json(EXTRA_LABELS_FILE, extra)  # persists the E-ids
        print(f"{len(flags) + len(extra)} items -> {ROOT / 'review.json'}", file=sys.stderr)
    elif args.cmd == "apply-review":
        flags, extra = load_labeled()
        verdicts = json.loads(args.file.read_text())
        verdicts = verdicts.get("verdicts", verdicts)
        summary = apply_verdicts(flags, extra, verdicts)
        store.write_json(FLAGS_FILE, flags)
        store.write_json(EXTRA_LABELS_FILE, extra)
        disagreements = [(f["id"], f.get("label"), f["reviewer_label"]) for f in [*flags, *extra]
                         if f.get("reviewer_label") and f["reviewer_label"] != f.get("label")]
        print(json.dumps({**summary, "disagreements": disagreements}, indent=2))
    else:
        flags, extra = load_labeled()
        apply_reviews(flags)
        apply_reviews(extra)
        out = {"population_v1_labels": population_estimate(flags, store.load_companies())}
        out.update({str(p): evaluate(flags, _load_run(p), extra) for p in args.runs})
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
