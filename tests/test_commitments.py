from screener import commitments as cm


def q(text, filed="2026-06-25"):
    return [i["quote"] for i in cm.extract(text, filed)]


def test_dated_milestones_capital_plans_and_quantified_outlooks_are_commitments():
    assert q("We plan to begin construction of the second Idaho fab in 2026, and expect it to be operational by the end of 2028.")
    assert cm.kind_of("We expect capital expenditures of approximately $18 billion in fiscal 2027.", 2026) == "capital"
    assert cm.kind_of("We expect our subscription gross profit percentage to decrease by about 2% for the year ending December 31, 2026.", 2026) == "outlook"
    assert cm.kind_of("The transaction is expected to close in the second quarter of fiscal 2026.", 2026) == "milestone"


def test_hedged_boilerplate_undated_and_past_statements_are_not():
    assert q("We may expect to open a new facility in 2027 if conditions allow.") == []
    assert q("We expect to continue to invest in our business and grow our customer base over time.") == []
    assert q("These forward-looking statements are subject to risks, and we expect results to be affected in 2027 as described.") == []
    assert q("As of April 30, 2026, we expect to make future cash payments of approximately $89 million in connection with our restructuring plans.") == []
    assert q("Our current cash and investments are sufficient to meet our needs, and we expect to fund $2 billion of repurchases in 2027.") == []
    assert q("The plan was completed in 2022 and we expect nothing further.") == []


def _filing(acc, filed, *quotes):
    return {"accession": acc, "form": "10-Q", "filed": filed, "period_end": filed, "source_url": f"https://sec.example/{acc}",
            "items": [{"kind": "milestone", "quote": t} for t in quotes]}


def test_a_changed_date_is_a_revision_and_keeps_the_original():
    a = _filing("a", "2025-02-18", "We expect this plan to be substantially completed by the end of fiscal 2025.")
    b = _filing("b", "2025-05-20", "We expect this plan to be substantially completed by the end of the first quarter of fiscal 2026.")
    c = _filing("c", "2025-11-18", "We expect this plan to be completed by the end of the second quarter of fiscal 2026.")
    [chain] = cm.build_chains([a, b, c])
    assert chain["status"] == "revised"
    assert [s["change"] for s in chain["statements"]] == ["original", "revised", "revised"]
    assert "fiscal 2025" in chain["statements"][0]["quote"]
    assert ["-", "fiscal 2025."] in chain["statements"][1]["diff"] or any(op == "-" for op, _ in chain["statements"][1]["diff"])


def test_repeats_rewording_and_year_roll_forward_are_not_revisions():
    same = "We expect the transaction to close in the second quarter of fiscal 2026 pending approvals."
    r = cm.build_chains([_filing("a", "2026-01-01", same), _filing("b", "2026-04-01", same)])
    assert r[0]["status"] == "unchanged" and r[0]["statements"][1]["change"] == "same"
    old = "We expect our subscription gross profit percentage to decrease slightly for the year ending December 31, 2025 compared to the year ended December 31, 2024."
    new = "We expect our subscription gross profit percentage to decrease for the year ending December 31, 2026 compared to the year ended December 31, 2025, due to cloud usage."
    r = cm.build_chains([_filing("a", "2025-10-30", old), _filing("b", "2026-07-23", new)])
    assert r[0]["status"] == "unchanged" and r[0]["statements"][1]["change"] == "rolled_forward"


def test_status_for_new_and_dropped_statements():
    a = _filing("a", "2025-02-18", "We expect the first phase of the new campus to open in 2027 with production starting shortly after.")
    b = _filing("b", "2025-05-20", "We expect to begin shipping the new product line in the second half of fiscal 2026 to customers.")
    chains = {c["statements"][0]["accession"]: c for c in cm.build_chains([a, b])}
    assert chains["a"]["status"] == "not_repeated" and chains["b"]["status"] == "new"
