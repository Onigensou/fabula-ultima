// anim-studio/lib/cfg.js
//
// CFG helpers. Two uses:
//   - render(templateSrc, cfgObj): substitute a `__CFG__` token with a JSON
//     CFG object (scaffolding parametric templates). Uses split/join so ALL
//     occurrences are replaced (String.replace only hits the first).
//   - extract(src): pull the `const CFG = {…};` object-literal slice (for tools
//     that surface it for editing). Brace-balanced; our templates keep a single
//     numeric CFG block by convention.
"use strict";

function render(templateSrc, cfgObj) {
  const json = JSON.stringify(cfgObj, null, 2);
  return String(templateSrc).split("__CFG__").join(json);
}

function extract(src) {
  const m = /const\s+CFG\s*=\s*/.exec(src);
  if (!m) return null;
  const braceStart = m.index + m[0].length;
  if (src[braceStart] !== "{") return null;
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) return null;
  return { start: braceStart, end: i, text: src.slice(braceStart, i) };
}

module.exports = { render, extract };
