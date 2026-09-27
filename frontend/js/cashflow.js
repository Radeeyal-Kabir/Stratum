// Cash-flow and valuation figures. Display-only: none of these feed the score.
// Enterprise value uses the latest close, so it moves with the price even though
// the cash-flow figures only change when a company files.
import { S } from "./state.js";
import { isNum, store } from "./lib.js";

let sbcAsCost = store.get("sbc-as-cost", true);
export const sbcIsCost = () => sbcAsCost;
export function setSbcAsCost(v) { sbcAsCost = v; store.set("sbc-as-cost", v); }

export function cashMetrics(c) {
  const cf = c.fundamentals?.cash_flow;
  const p = S.px[c.ticker];
  if (!cf) return null;
  const marketCap = isNum(cf.shares_outstanding) && isNum(p?.close) ? cf.shares_outstanding * p.close : null;
  const ev = isNum(marketCap) ? marketCap + (cf.debt ?? 0) - (cf.cash ?? 0) - (cf.short_term_investments ?? 0) : null;
  const fcfAdj = isNum(cf.fcf_ttm) && isNum(cf.sbc_ttm) ? cf.fcf_ttm - cf.sbc_ttm : null;
  const yieldOf = (v) => (isNum(v) && isNum(ev) && ev > 0 ? v / ev : null);
  return {
    ...cf, marketCap, ev,
    fcfYield: yieldOf(cf.fcf_ttm),
    trueYield: yieldOf(fcfAdj),
    // What the rest of the site shows, following the SBC toggle.
    shownMargin: sbcAsCost ? cf.fcf_less_sbc_margin : cf.fcf_margin,
    shownYield: sbcAsCost ? yieldOf(fcfAdj) : yieldOf(cf.fcf_ttm),
  };
}

export const hasCashData = () => S.companies.some((c) => isNum(c.fundamentals?.cash_flow?.fcf_ttm));
