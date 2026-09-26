import { h } from "./lib.js";

const PNG = new Set(["TXN", "AMAT", "LRCX", "MU", "NOW", "HPE"]);
const KNOWN = new Set(["NVDA", "AVGO", "AMD", "QCOM", "TXN", "AMAT", "LRCX", "MU", "MSFT", "ORCL", "CRM", "ADBE", "INTU", "NOW", "PANW", "AAPL", "CSCO", "IBM", "ACN", "HPE"]);

// Assets are served locally: no third-party logo request or API key at runtime.
export function logo(ticker, size = "sm") {
  const badge = h("span", { class: `company-logo logo-${size}`, "aria-hidden": "true" });
  const fallback = h("span", { class: "logo-fallback", text: ticker.slice(0, 2) });
  badge.append(fallback);
  if (KNOWN.has(ticker)) {
    const img = h("img", {
      src: `assets/logos/${ticker}.${PNG.has(ticker) ? "png" : "svg"}`,
      alt: "", width: 32, height: 32, decoding: "async",
    });
    img.addEventListener("error", () => img.remove());
    badge.append(img);
  }
  return badge;
}

export function identity(c, { subtitle = c.name, size = "sm" } = {}) {
  return h("span", { class: "company-identity" }, logo(c.ticker, size),
    h("span", { class: "identity-copy" }, h("span", { class: "tk", text: c.ticker }),
      h("span", { class: "identity-name", text: subtitle })));
}
