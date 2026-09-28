from screener import flag_benchmark as fb


def _flag(i, split, acc, cat, label, quote="the quick brown fox jumps over"):
    return {"id": i, "split": split, "accession": acc, "category": cat, "label": label, "quote": quote}


def test_passage_includes_neighbors_of_the_quoted_paragraph():
    section = "Intro para.\nRevenue fell 10% as demand for PCs weakened sharply.\nOutro para."
    assert fb.passage_for("demand for PCs weakened sharply", section) == section.replace("\n", "\n\n")
    assert fb.passage_for("not in the filing at all", section) is None


def test_evaluate_counts_by_filing_and_category():
    flags = [
        _flag("F1", "dev", "a", "demand_weakness", "unsupported"),
        _flag("F2", "dev", "a", "guidance_cut", "supported"),
        _flag("F3", "dev", "b", "margin_pressure", "unsupported"),
        _flag("F4", "test", "c", "margin_pressure", "supported"),
    ]
    run = {"filings": {
        "a": {"red_flags": [{"category": "demand_weakness", "quote": "the quick brown fox jumps over"},
                            {"category": "supply_chain", "quote": "a brand new quote here"}]},
        "b": {"red_flags": []},
        "c": {"red_flags": [{"category": "margin_pressure", "quote": "the quick brown fox jumps over"}]},
    }}
    r = fb.evaluate(flags, run)
    assert r["dev"]["kept_unsupported"] == ["F1"]
    assert r["dev"]["dropped_supported"] == ["F2"]
    assert r["dev"]["unsupported_still_raised"] == "1 of 2"
    assert r["dev"]["false_positive_rate_on_labeled"] == 1.0
    assert [u["category"] for u in r["dev"]["unlabeled_new_flags"]] == ["supply_chain"]
    assert r["test"]["supported_still_raised"] == "1 of 1"
    assert r["test"]["unlabeled_new_flags"] == []


def test_sample_counts_a_repeated_quote_once_and_splits_by_company():
    q = "demand for our products declined in the quarter"
    rec = lambda acc: {"accession": acc, "form": "10-Q", "filed": acc, "period_end": acc, "status": "ok",
                       "source_url": "u", "red_flags": [{"category": "demand_weakness", "summary": "s", "quote": q}]}
    state = {"companies": {"MU": {"qualitative": {"filings": [rec("2026-01"), rec("2026-04")]}},
                           "IBM": {"qualitative": {"filings": [rec("2026-02")]}}}}
    flags = fb.sample(state)
    assert len(flags) == 2
    mu = next(f for f in flags if f["ticker"] == "MU")
    assert mu["accession"] == "2026-04" and mu["also_in"] == ["2026-01"] and mu["split"] == "dev"
    assert next(f for f in flags if f["ticker"] == "IBM")["split"] == "test"
