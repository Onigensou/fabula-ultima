// anim-studio/lib/encode.js
//
// Storage encode/decode + validation for BD `animation_script` fields.
//
// The animation_script CSB field is a ProseMirror rich-text area. BD's
// _stripHtml sets innerHTML then reads textContent, so raw `<` / `>` / `=>`
// get eaten as bogus tags. We store HTML-ESCAPED + <p>-wrapped; _stripHtml
// reverses it. Two gotchas this guards (both historically bit us):
//   1. Unescaped `<` / `>` in the script → mangled on load.
//   2. A stray backtick inside a String.raw`…` inner template closes it early
//      and breaks the outer parse. The whole file must contain exactly 2
//      backticks (the String.raw delimiters) and none inside the inner.
//
// Pure Node, no deps.

"use strict";

// ── Encode ────────────────────────────────────────────────────────────────
// Escape &<>, split on newlines, wrap each line in <p>…</p>. Order of escapes
// matters (& first).
function encode(script) {
  const esc = String(script)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = esc.split("\n");
  return "<p>" + lines.join("</p><p>") + "</p>";
}

// ── Decode ──────────────────────────────────────────────────────────────────
// Mirror of BD's _stripHtml fallback (the non-browser path). </p> / <br> →
// newline, strip remaining tags, unescape entities.
function decode(html) {
  return String(html)
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── Validate ────────────────────────────────────────────────────────────────
// Returns { ok, errors:[], warnings:[] }.
//   - Compiles the script as new Function("payload","targets", src) → syntax.
//   - Round-trips encode→decode and compares to source.trim() (lossless store).
//   - If the script uses a String.raw`…` inner template, enforces exactly 2
//     backticks total and none inside the inner (+ inner compiles as an async
//     IIFE the way the pseudo listener runs it).
function validate(script) {
  const errors = [];
  const warnings = [];
  const src = String(script);

  // 1. Outer compiles.
  try {
    // eslint-disable-next-line no-new-func
    new Function("payload", "targets", '"use strict";\n' + src);
  } catch (e) {
    errors.push(`outer script does not compile: ${e.message}`);
  }

  // 2. Storage round-trip is lossless.
  const round = decode(encode(src));
  if (round !== src.trimEnd() && round.trim() !== src.trim()) {
    errors.push("storage round-trip (encode→decode) is NOT lossless — the stored script would differ from source.");
  }

  // 3. Backtick / String.raw inner rules.
  const backtickCount = (src.match(/`/g) || []).length;
  const usesStringRaw = /String\.raw\s*`/.test(src);
  if (usesStringRaw) {
    if (backtickCount !== 2) {
      errors.push(`String.raw inner detected but file has ${backtickCount} backticks (expected exactly 2). A stray backtick — even in a comment — closes the template early.`);
    }
    const m = src.match(/String\.raw\s*`([\s\S]*?)`/);
    if (m) {
      const inner = m[1];
      if (inner.includes("`")) errors.push("inner String.raw template contains a backtick.");
      // Inner compiles the way the listener runs it.
      try {
        // eslint-disable-next-line no-new-func
        new Function("ctx", "canvas", "PIXI", "FAudioHelper", "loadTexture", "fromUuid", "wait", "foundry", "oni",
          `"use strict"; return (async () => {\n${inner}\n})();`);
      } catch (e) {
        errors.push(`inner scriptSource does not compile: ${e.message}`);
      }
    }
  } else if (backtickCount % 2 !== 0) {
    warnings.push(`odd number of backticks (${backtickCount}) — check template literals are balanced.`);
  }

  // 4. Placeholder sentinel (BD treats this as "no script").
  if (/insert your sequencer animation here/i.test(src)) {
    warnings.push("contains the legacy placeholder sentinel — BD will treat this as an empty animation.");
  }

  // 5. pseudo.play without scriptId is silently BLOCKED by validateOutgoing
  //    ("Missing scriptId"), so the animation never broadcasts.
  if (/pseudo\.play\s*\(/.test(src) && !/scriptId\s*:/.test(src)) {
    errors.push("game.ONI.pseudo.play({…}) is missing a `scriptId:` — pseudo-core blocks the emit without one, so nothing plays. Add e.g. scriptId: \"anim-studio/<name>\".");
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { encode, decode, validate };
