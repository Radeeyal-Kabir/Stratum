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
