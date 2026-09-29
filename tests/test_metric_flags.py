from screener import metric_flags as mf


def cats(text):
    return {f["category"] for f in mf.find(text)}


def test_headline_declines_with_and_without_figures():
    assert cats("Operating income decreased by 26%, and operating income as a percentage of revenue decreased by 7.1 percentage points.") == {"margin_pressure"}
    assert cats("Revenue from the Networking product category decreased by 8%, or $1.8 billion in the quarter.") == {"demand_weakness"}
    assert cats("Gross profit as a percentage of revenue decreased to 57.4% from 59.6% in the quarter.") == {"margin_pressure"}
    assert cats("Wearables, Home and Accessories net sales decreased during the first quarter of 2026 compared to 2025 primarily due to lower net sales of Wearables.") == {"demand_weakness"}


def test_good_news_small_moves_and_levels_are_not_flagged():
    assert cats("Sales and marketing expense increased 3%, and decreased as a percentage of revenues to 10.1% from 10.5% due to lower labor costs.") == set()
    assert cats("Gross margin for the quarter decreased as a percentage of revenues to 32.8% compared to 32.9% in the prior year quarter.") == set()
    assert cats("Operating margin of 14.7%, a decrease from 14.8% in fiscal 2024; adjusted operating margin of 15.6%, an increase compared to 15.5%.") == set()
    assert cats("Revenue increased 12%, driven by growth in data center, and operating profit decreased $60 million on a small base.") == set()
    assert cats("Interest expense decreased in fiscal year 2026 compared to fiscal year 2025 primarily due to the maturity of senior notes.") == set()


def test_expected_margin_decline_restructuring_and_impairment():
    assert cats("We expect our subscription gross profit percentage to decrease slightly for the year ending December 31, 2025 compared to 2024.") == {"margin_pressure"}
    assert cats("In the first quarter of fiscal 2025 we recognized restructuring and other charges of $675 million related to a workforce reduction plan.") == {"restructuring_layoffs"}
    assert cats("During the six months ended May 29, 2026, we recorded a goodwill impairment charge related to our Publishing reporting unit.") == {"impairment_writedown"}
    assert cats("We test goodwill for impairment in our fourth quarter each year, and an impairment charge would be recorded if fair value is lower.") == set()
    assert cats("There was no impairment of goodwill in each of the first quarter of fiscal 2026 and 2025 for the reporting units.") == set()


def test_flags_are_verbatim_sentences_one_per_category():
    text = "Operating income decreased by 26% compared with the prior year.\nGross margin decreased by 4 percentage points on higher costs."
    flags = mf.find(text)
    assert [f["category"] for f in flags] == ["margin_pressure"]
    assert flags[0]["quote"] in text and flags[0]["source"] == "pattern"


def test_merge_keeps_model_flags_and_is_idempotent():
    rec = {"red_flags": [{"category": "margin_pressure", "quote": "model quote here", "summary": "s"}]}
    section = "Revenue decreased by 9% as customers reduced orders for the products in the quarter."
    assert mf.merge_into(rec, section) == 1
    assert sorted(f["category"] for f in rec["red_flags"]) == ["demand_weakness", "margin_pressure"]
    assert mf.merge_into(rec, section) == 1  # rerun replaces, not duplicates
    assert len(rec["red_flags"]) == 2 and rec["pattern_flags"] == 1
