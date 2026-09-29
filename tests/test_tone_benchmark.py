from screener import tone_benchmark as tb


def test_reference_tone_from_the_reported_quarter():
    q = lambda yoy, nm=None: {"revenue_yoy": yoy, "net_margin": nm}
    assert tb.reference_tone(q(0.25, 0.20), q(0.1, 0.18)) == "bullish"
    assert tb.reference_tone(q(-0.03, 0.20), q(0.1, 0.18)) == "bearish"
    assert tb.reference_tone(q(0.20, 0.02), q(0.1, 0.15)) == "bearish"   # margin collapsed
    assert tb.reference_tone(q(0.04, 0.20), q(0.1, 0.18)) == "neutral"
    assert tb.reference_tone(q(None), None) is None


def test_ignoring_neutral_excerpts_stops_a_factual_passage_from_diluting_the_call():
    chunks = [{"tone": "bullish", "chars": 6000, "density": 5.0},
              {"tone": "neutral", "chars": 6000, "density": 1.0},
              {"tone": "neutral", "chars": 6000, "density": 0.5}]
    assert tb.rule_current(chunks) == "neutral"          # 6000 of 18000 is 0.33, not above the bar
    assert tb.rule_ignore_neutral(chunks) == "bullish"
    assert tb.rule_ignore_neutral([{"tone": "neutral", "chars": 5, "density": 1}]) == "neutral"


def test_dense_rules_fall_back_to_all_excerpts_when_none_qualify():
    chunks = [{"tone": "bearish", "chars": 6000, "density": 1.0}]
    assert tb.rule_dense_only(3.0)(chunks) == "bearish"
    mixed = [{"tone": "bullish", "chars": 6000, "density": 4.0}, {"tone": "bearish", "chars": 6000, "density": 1.0}]
    assert tb.rule_dense_only(3.0)(mixed) == "bullish"


def test_score_counts_the_two_kinds_of_disagreement():
    rows = [{"reference": "bullish", "chunks": [{"tone": "neutral", "chars": 1, "density": 0}]},
            {"reference": "bearish", "chunks": [{"tone": "bullish", "chars": 1, "density": 0}]},
            {"reference": "bullish", "chunks": [{"tone": "bullish", "chars": 1, "density": 0}]}]
    s = tb.score(tb.rule_current, rows)
    assert (s["agree"], s["strong_quarter_not_bullish"], s["weak_quarter_bullish"]) == (1, 1, 1)
