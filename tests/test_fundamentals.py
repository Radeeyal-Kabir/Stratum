from datetime import date, timedelta

import pytest

from screener.fetch_fundamentals import (
    FundamentalsError,
    compute_fundamentals,
    quarterly_flow_series,
)

# A fiscal year ending late September, 13-week quarters (91 days), 364-day years.
FY_ENDS = [date(2021, 9, 25) + timedelta(days=364 * i) for i in range(4)]


def _quarters(fy_end: date) -> list[tuple[date, date]]:
    start = fy_end - timedelta(days=363)
    out = []
    for _ in range(4):
        end = start + timedelta(days=90)
        out.append((start, end))
        start = end + timedelta(days=1)
    out[-1] = (out[-1][0], fy_end)
    return out


def _flow(values_by_fy: dict[date, list[float]], *, filed_offset=40) -> list[dict]:
    """10-Q facts for Q1-Q3, and only the annual total in the 10-K (like real filers)."""
    facts = []
    for fy_end, qvals in values_by_fy.items():
        qs = _quarters(fy_end)
        for (s, e), v in list(zip(qs, qvals))[:3]:
            facts.append({"start": s.isoformat(), "end": e.isoformat(), "val": v, "form": "10-Q",
                          "filed": (e + timedelta(days=filed_offset)).isoformat()})
        facts.append({"start": qs[0][0].isoformat(), "end": fy_end.isoformat(), "val": sum(qvals),
                      "form": "10-K", "filed": (fy_end + timedelta(days=60)).isoformat()})
    return facts


def _instant(value_fn, *, fy_ends=FY_ENDS) -> list[dict]:
    facts = []
    for fy_end in fy_ends:
        for _, e in _quarters(fy_end):
            facts.append({"end": e.isoformat(), "val": value_fn(e), "form": "10-Q",
                          "filed": (e + timedelta(days=40)).isoformat()})
    return facts


def _companyfacts(concepts: dict[str, list[dict]]) -> dict:
    return {"facts": {"us-gaap": {k: {"units": {"USD": v}} for k, v in concepts.items()}}}


REVENUE = {fy: [100 * (1.1 ** i), 110 * (1.1 ** i), 120 * (1.1 ** i), 150 * (1.1 ** i)]
           for i, fy in enumerate(FY_ENDS)}
NET_INCOME = {fy: [v * 0.2 for v in qs] for fy, qs in REVENUE.items()}


def _base(**overrides):
    concepts = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": _flow(REVENUE),
        "NetIncomeLoss": _flow(NET_INCOME),
        "AssetsCurrent": _instant(lambda e: 300.0),
        "LiabilitiesCurrent": _instant(lambda e: 150.0),
        "StockholdersEquity": _instant(lambda e: 500.0),
        "LongTermDebt": _instant(lambda e: 250.0),
    }
    concepts.update(overrides)
    return _companyfacts({k: v for k, v in concepts.items() if v is not None})


TODAY = FY_ENDS[-1] + timedelta(days=30)


def test_q4_derived_from_annual_minus_q1_to_q3():
    series = quarterly_flow_series(_flow(REVENUE))
    fy = FY_ENDS[-1]
    assert series[fy] == pytest.approx(REVENUE[fy][3])
    assert len(series) == 16


def test_yoy_growth_margin_and_ratios():
    out = compute_fundamentals(_base(), today=TODAY)
    assert len(out["quarters"]) == 8
    latest = out["latest"]
    assert latest["period_end"] == FY_ENDS[-1].isoformat()
    assert latest["revenue_yoy"] == pytest.approx(0.10, abs=1e-4)
    assert latest["net_margin"] == pytest.approx(0.20, abs=1e-4)
    assert latest["debt_to_equity"] == pytest.approx(0.5)
    assert latest["current_ratio"] == pytest.approx(2.0)
    assert out["trend"]["net_margin_change_yoy"] == pytest.approx(0.0, abs=1e-4)
    assert out["warnings"] == []


def test_restated_value_wins():
    facts = _flow(REVENUE)
    q1 = next(f for f in facts if f["form"] == "10-Q" and f["end"] == _quarters(FY_ENDS[-1])[0][1].isoformat())
    facts.append({**q1, "val": 999.0, "filed": "2030-01-01"})
    series = quarterly_flow_series(facts)
    assert series[_quarters(FY_ENDS[-1])[0][1]] == 999.0


def test_concept_switch_merges_old_and_new_tags():
    old_fys, new_fys = FY_ENDS[:2], FY_ENDS[2:]
    out = compute_fundamentals(
        _base(
            RevenueFromContractWithCustomerExcludingAssessedTax=_flow({fy: REVENUE[fy] for fy in new_fys}),
            Revenues=_flow({fy: REVENUE[fy] for fy in old_fys}),
        ),
        today=TODAY,
    )
    assert out["concepts_used"]["revenue"] == "RevenueFromContractWithCustomerExcludingAssessedTax"
    # YoY for the first new-tag quarter needs the old-tag quarter a year earlier.
    assert all(q["revenue_yoy"] == pytest.approx(0.10, abs=1e-4) for q in out["quarters"])


def test_missing_required_concept_fails_loudly():
    with pytest.raises(FundamentalsError, match="net_income"):
        compute_fundamentals(_base(NetIncomeLoss=None), today=TODAY)


def test_negative_equity_blanks_debt_to_equity():
    out = compute_fundamentals(_base(StockholdersEquity=_instant(lambda e: -50.0)), today=TODAY)
    assert out["latest"]["debt_to_equity"] is None
    assert any("Negative stockholders' equity" in w for w in out["warnings"])


def test_debt_falls_back_to_noncurrent_plus_current():
    out = compute_fundamentals(
        _base(
            LongTermDebt=None,
            LongTermDebtNoncurrent=_instant(lambda e: 200.0),
            LongTermDebtCurrent=_instant(lambda e: 50.0),
        ),
        today=TODAY,
    )
    assert out["latest"]["debt_to_equity"] == pytest.approx(0.5)


def test_stale_data_warns():
    out = compute_fundamentals(_base(), today=TODAY + timedelta(days=400))
    assert any("over 200 days old" in w for w in out["warnings"])


def test_panw_convertible_debt_resolves_real_debt_to_equity():
    # Real SEC EDGAR equity/debt facts for PANW (CIK 0001327567), fetched live -- see
    # tests/fixtures/panw_equity_debt_facts.json for provenance. PANW's old debt concept
    # (LongTermDebt) goes stale after 2023-07-31; its debt is reported under
    # ConvertibleDebtNoncurrent/ConvertibleDebtCurrent instead, which weren't in CONCEPTS
    # before. Equity resolves cleanly on its own (gap_days=0 every quarter) -- this is a
    # regression test for the debt side specifically, not the equity side.
    import json
    from pathlib import Path

    real = json.loads((Path(__file__).parent / "fixtures" / "panw_equity_debt_facts.json").read_text())
    real_concepts = real["facts"]["us-gaap"]

    ends = [date(2024, 10, 31), date(2025, 1, 31), date(2025, 4, 30), date(2025, 7, 31),
            date(2025, 10, 31), date(2026, 1, 31), date(2026, 4, 30), date(2026, 7, 31)]
    starts = [date(2024, 8, 1), date(2024, 11, 1), date(2025, 2, 1), date(2025, 5, 1),
              date(2025, 8, 1), date(2025, 11, 1), date(2026, 2, 1), date(2026, 5, 1)]
    assert all(80 <= (e - s).days <= 100 for s, e in zip(starts, ends))

    def flow_facts(value: float) -> list[dict]:
        out = []
        for s, e in zip(starts, ends):
            out.append({"start": s.isoformat(), "end": e.isoformat(), "val": value,
                        "form": "10-Q", "filed": (e + timedelta(days=30)).isoformat()})
            value *= 1.02
        return out

    def instant_facts(value: float) -> list[dict]:
        return [{"end": e.isoformat(), "val": value, "form": "10-Q",
                 "filed": (e + timedelta(days=30)).isoformat()} for e in ends]

    # Synthetic filler for the REQUIRED concepts this fix isn't about -- only equity/debt
    # (from the real fixture) matter for what this test asserts.
    companyfacts = {"facts": {"us-gaap": {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": flow_facts(1_000_000_000.0)}},
        "NetIncomeLoss": {"units": {"USD": flow_facts(150_000_000.0)}},
        "AssetsCurrent": {"units": {"USD": instant_facts(5_000_000_000.0)}},
        "LiabilitiesCurrent": {"units": {"USD": instant_facts(3_000_000_000.0)}},
        **real_concepts,
    }}}

    result = compute_fundamentals(companyfacts, today=date(2026, 8, 20))
    latest = result["latest"]
    assert latest["period_end"] == "2026-07-31"
    assert latest["debt_to_equity"] is not None
    assert latest["debt_to_equity"] == pytest.approx(1_774_000_000 / 27_492_000_000, abs=1e-4)
    assert result["concepts_used"]["debt_noncurrent"] == "ConvertibleDebtNoncurrent"
    assert result["concepts_used"]["debt_current"] == "ConvertibleDebtCurrent"


# ---------------------------------------------------------------- cash flow (display-only)
from screener.fetch_fundamentals import ttm_flow  # noqa: E402


def _ytd(fy_end: date, cumulative: list[float]) -> list[dict]:
    """10-Q cash-flow facts are year-to-date (3, 6, 9 months); the 10-K has the full year."""
    qs = _quarters(fy_end)
    start = qs[0][0]
    out = []
    for (_, e), v in zip(qs, cumulative):
        form = "10-K" if e == fy_end else "10-Q"
        out.append({"start": start.isoformat(), "end": e.isoformat(), "val": v, "form": form,
                    "filed": (e + timedelta(days=40)).isoformat()})
    return out


def test_ttm_at_fiscal_year_end_is_the_annual_figure():
    facts = _ytd(FY_ENDS[-1], [10, 25, 45, 70])
    assert ttm_flow(facts, FY_ENDS[-1]) == 70


def test_ttm_mid_year_rolls_forward_from_ytd():
    # Prior year: quarters 10, 15, 20, 25 (FY 70). This year so far: 12 + 18 (H1 30).
    facts = _ytd(FY_ENDS[-2], [10, 25, 45, 70]) + _ytd(FY_ENDS[-1], [12, 30])
    h1_end = _quarters(FY_ENDS[-1])[1][1]
    # TTM = FY 70 + this H1 30 - last H1 25 = 75 (= 20 + 25 + 12 + 18).
    assert ttm_flow(facts, h1_end) == 75


def test_ttm_without_prior_year_comparison_is_none():
    facts = _ytd(FY_ENDS[-1], [12, 30])
    assert ttm_flow(facts, _quarters(FY_ENDS[-1])[1][1]) is None


def test_cash_flow_block_computes_fcf_and_sbc_ratios():
    fy = FY_ENDS[-1]
    extra = {
        "NetCashProvidedByUsedInOperatingActivities": _ytd(fy, [40, 90, 150, 220]),
        "PaymentsToAcquirePropertyPlantAndEquipment": _ytd(fy, [5, 10, 15, 20]),
        "ShareBasedCompensation": _ytd(fy, [4, 8, 12, 16]),
        "CashAndCashEquivalentsAtCarryingValue": _instant(lambda e: 120.0),
    }
    facts = _base(**extra)
    facts["facts"]["dei"] = {"EntityCommonStockSharesOutstanding": {"units": {"shares": [
        {"end": (fy + timedelta(days=30)).isoformat(), "val": 1000, "filed": (fy + timedelta(days=60)).isoformat(), "accn": "a"}]}}}
    cf = compute_fundamentals(facts, today=TODAY)["cash_flow"]
    revenue_ttm = sum(REVENUE[fy])
    assert cf["revenue_ttm"] == pytest.approx(revenue_ttm)
    assert cf["fcf_ttm"] == 200
    assert cf["fcf_margin"] == pytest.approx(200 / revenue_ttm, abs=1e-4)
    assert cf["sbc_pct_revenue"] == pytest.approx(16 / revenue_ttm, abs=1e-4)
    assert cf["fcf_less_sbc_margin"] == pytest.approx(184 / revenue_ttm, abs=1e-4)
    assert cf["cash"] == 120 and cf["debt"] == 250 and cf["shares_outstanding"] == 1000


def test_cash_flow_block_tolerates_missing_concepts():
    cf = compute_fundamentals(_base(), today=TODAY)["cash_flow"]
    assert cf["fcf_ttm"] is None and cf["fcf_margin"] is None and cf["shares_outstanding"] is None
