from screener import filing_diff as fd

P = "Revenue for the third quarter was $5.2 billion, up 12% from a year ago, driven by data center demand."
MOVED = "Our products are sold primarily to original equipment manufacturers and distributors in many regions worldwide."
LIQ = "We believe our existing cash and investments will be sufficient to meet our liquidity needs for the next twelve months."


def kinds(result):
    return sorted(i["kind"] for i in result["items"])


def test_moved_and_identical_paragraphs_are_not_shown():
    r = fd.compare([MOVED, LIQ], [LIQ, MOVED])
    assert r["items"] == []
    assert r["counts"]["unchanged"] == 2


def test_figure_only_changes_are_classified_as_figures():
    now = P.replace("third", "fourth").replace("$5.2", "$5.9").replace("12%", "15%")
    r = fd.compare([P], [now])
    assert kinds(r) == ["figures"]
    item = r["items"][0]
    assert ["-", "third"] in item["diff"] and ["+", "fourth"] in item["diff"]


def test_revised_paragraph_gets_a_word_diff_and_topics():
    before = "We expect demand for our memory products to remain strong through the remainder of fiscal 2026 as customers expand capacity."
    after = "We expect demand for our memory products to weaken through the remainder of fiscal 2026 as customers digest inventory."
    r = fd.compare([before], [after])
    [item] = r["items"]
    assert item["kind"] == "revised" and item["key"]
    assert {"guidance", "demand"} <= set(item["topics"])
    assert ["+", "weaken"] in item["diff"] or any(op == "+" and "weaken" in t for op, t in item["diff"])


def test_added_removed_and_boilerplate():
    safe = "This report contains forward-looking statements within the meaning of the Private Securities Litigation Reform Act of 1995."
    new = "In the fourth quarter we announced a restructuring plan that will reduce our global workforce by approximately five percent."
    gone = "Gross margin declined due to higher manufacturing costs and an unfavorable product mix during the period under review."
    r = fd.compare([gone, safe], [new, safe + " Actual results may differ."])
    assert kinds(r) == ["added", "boilerplate", "removed"]
    assert r["items"][0]["key"]  # the removed margin paragraph is a key topic, so it leads


def test_pick_pair_matches_forms():
    feed = [{"form": "10-K", "accession": "3"}, {"form": "10-Q", "accession": "2"}, {"form": "10-Q", "accession": "1"},
            {"form": "10-K", "accession": "0"}]
    prev, cur = fd.pick_pair(feed)
    assert (prev["accession"], cur["accession"]) == ("0", "3")
    assert fd.pick_pair([{"form": "10-Q", "accession": "1"}]) is None


def test_paragraphs_skip_tables_and_headings():
    section = "Results of Operations\n$ 1,234 | $ 2,345 | 12 %\n" + P
    assert fd.paragraphs(section) == [P]


def test_quantities_restated_in_words_count_as_figures():
    before = "DRAM revenue increased 207%, primarily due to a mid-110% increase in bit shipments and a mid-40% increase in prices."
    after = "DRAM revenue increased 67%, primarily due to a low-60% increase in bit shipments and a low-single-digit percentage increase in prices."
    assert kinds(fd.compare([before], [after])) == ["figures"]


def test_template_paragraphs_pair_by_name_not_by_numbers():
    prev = ["CDBU revenue increased 139%, primarily due to increases in average selling prices and bit shipments.",
            "AEBU revenue increased 57%, primarily due to increases in average selling prices and bit shipments."]
    curr = ["AEBU revenue increased 139% and 71%, respectively, primarily due to increases in average selling prices and bit shipments.",
            "CDBU revenue increased 653% and 247%, respectively, primarily due to increases in average selling prices and bit shipments."]
    r = fd.compare(prev, curr)
    for item in r["items"]:
        removed = " ".join(t for op, t in item["diff"] if op == "-")
        assert "CDBU" not in removed and "AEBU" not in removed


def test_small_wording_edit_in_a_topic_paragraph_is_not_key():
    before = "In June 2025 we announced plans for a second fab in Idaho to serve growing market demand fueled by AI."
    after = "In June 2025 we announced investment for a second fab in Idaho to serve growing market demand fueled by AI."
    [item] = fd.compare([before], [after])["items"]
    assert item["kind"] == "revised" and not item["key"]
    moved_date = "We plan to begin construction of the second Idaho fab in 2026, and expect it to be operational by the end of 2028."
    new_date = "We plan to begin construction of the second Idaho fab in 2026, and expect initial wafer output by late calendar 2028."
    [item] = fd.compare([moved_date], [new_date])["items"]
    assert item["kind"] == "revised" and item["key"]
