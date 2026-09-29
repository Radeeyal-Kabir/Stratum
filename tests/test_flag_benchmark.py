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


def test_population_estimate_reweights_by_category_frequency():
    flags = [_flag("F1", "dev", "a", "demand_weakness", "unsupported"),
             _flag("F2", "dev", "b", "demand_weakness", "supported"),
             _flag("F3", "dev", "c", "restructuring_layoffs", "supported")]
    filings = [{"status": "ok", "red_flags": [{"category": "demand_weakness"}] * 3 + [{"category": "restructuring_layoffs"}]}]
    est = fb.population_estimate(flags, {"companies": {"X": {"qualitative": {"filings": filings}}}})
    # Demand is 3 of 4 flags on file and half wrong in the sample; restructuring is 1 of 4 and all right.
    assert est["est_unsupported"] == 0.375
    assert est["est_supported"] == 0.625


def test_reviewer_verdicts_override_draft_labels_and_are_counted():
    flags = [_flag("F1", "dev", "a", "demand_weakness", "unsupported"), _flag("F2", "dev", "b", "guidance_cut", "supported")]
    extra = [{"accession": "c", "category": "macro_fx", "quote": "lower interest rates reduced income", "label": "unsupported"}]
    summary = fb.apply_verdicts(flags, extra, {"F1": {"label": "supported", "comment": "actually fine"},
                                               "E001": {"label": "unsupported"}, "F9": {"label": "supported"}})
    assert summary == {"applied": 2, "unknown_ids": ["F9"], "total": 3, "reviewed": 2, "changed": 1}
    assert extra[0]["id"] == "E001"
    fb.apply_reviews(flags)
    assert flags[0]["label"] == "supported" and flags[0]["draft_label"] == "unsupported"
    assert flags[1]["label"] == "supported" and "draft_label" not in flags[1]


def test_apply_verdicts_rejects_an_unknown_label():
    import pytest
    with pytest.raises(ValueError):
        fb.apply_verdicts([_flag("F1", "dev", "a", "demand_weakness", "unsupported")], [], {"F1": {"label": "maybe"}})
