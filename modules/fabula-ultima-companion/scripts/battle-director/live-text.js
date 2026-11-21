// Live values in item / skill text.
//
// A number in a description that depends on who is looking can be authored as
//
//   <span data-fu-formula="GRAPPLE_ESCAPE_DL">10</span>
//
// Everywhere the text is shown as-is (item sheet, Item Window, journals) the
// span's own text is the fallback ("10"). Battle surfaces that know the actor
// (the Objective picker, …) call renderLiveText(html, { actor }) and the span's
// text becomes that formula evaluated with the actor's skill resolver — the same
// resolver the effect rows use, so the card shows the number the engine checks.
// First user: Break Free's DL (the grappler's `grapple_escape_dl` rule).
//
// No-op on text without the attribute. An unknown formula or a non-finite
// result keeps the fallback text.

import { warn } from "./logger.js";
import { buildSkillResolver, evaluateFormula } from "./skill-formulas.js";

const LIVE_SPAN = /(<span\b[^>]*?\bdata-fu-formula\s*=\s*"([^"]*)"[^>]*>)([\s\S]*?)(<\/span>)/gi;

const decodeAttr = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function renderLiveText(html, { actor = null, skill = null, payload = null, round = 0 } = {}) {
  const text = String(html ?? "");
  if (!actor || !text.includes("data-fu-formula")) return text;
  let resolver = null;
  return text.replace(LIVE_SPAN, (whole, open, formula, _fallback, close) => {
    const expr = decodeAttr(formula).trim();
    if (!expr) return whole;
    try {
      resolver ??= buildSkillResolver({ actor, payload, skill, round });
      const v = Number(evaluateFormula(expr, resolver, NaN));
      if (!Number.isFinite(v)) return whole;
      return `${open}${Math.round(v * 100) / 100}${close}`;
    } catch (e) {
      warn(`live-text: "${expr}" threw — keeping the fallback text`, e);
      return whole;
    }
  });
}
