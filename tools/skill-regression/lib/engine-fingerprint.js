// ───────────────────────────────────────────────────────────────────────────
// Semantic fingerprint of the skill-engine source.
//
// The Stop-hook gate used to fire on a PATH match alone, so a comment rewrite,
// a re-indent, or an edit-then-revert cost the same full-catalog sweep as a real
// engine change — and that sweep is ~22 min (measured 2026-08-08: 491 skills,
// compute mode, 1294 s). This hashes what the engine actually *does*: comments
// stripped, indentation normalized, blank lines dropped. Same hash as the last
// completed check ⇒ nothing semantically changed ⇒ the check is guaranteed to
// reproduce its previous verdict, so the gate skips it.
//
// The skip is only ever taken on an EXACT hash match, and any parse trouble in
// the stripper changes the hash rather than preserving it — so the failure
// direction is "run the check anyway", never "silently miss a regression".
// ───────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..", "..", "..");
const ENGINE_DIR = path.join(REPO, "modules", "fabula-ultima-companion", "scripts", "battle-director");

// Single source of truth for "which files can regress OTHER skills" — the
// PostToolUse marker hook (hooks/on-skill-edit.js) matches on this too, so the
// trigger list and the fingerprint list can never drift apart.
const ENGINE_FILE_RE = /^(skill-[^\\/]+|[^\\/]*reaction[^\\/]*|[^\\/]*reactor[^\\/]*|state-handlers|states|damage-ruleset|card-mutations|template-field-registry)\.js$/i;
const ENGINE_PATH_RE = /[\\/]scripts[\\/]battle-director[\\/](skill-[^\\/]+\.js|[^\\/]*reaction[^\\/]*\.js|[^\\/]*reactor[^\\/]*\.js|state-handlers\.js|states\.js|damage-ruleset\.js|card-mutations\.js|template-field-registry\.js)$/i;

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/**
 * Remove JS comments while leaving string / template / regex literals intact.
 *
 * Regex-vs-division is decided by the previous significant token, the standard
 * heuristic: a `/` opens a regex unless the last thing seen was a value
 * (identifier, number, string, `)`, `]`, `}`).
 */
function stripComments(src) {
  let out = "";
  let prev = "";           // last significant token: an identifier/number, or one char
  const n = src.length;
  let i = 0;

  const regexAllowed = () => {
    if (!prev) return true;
    if (KEYWORDS_BEFORE_REGEX.has(prev)) return true;
    // a value-ish token means `/` is division
    if (/^[A-Za-z_$][\w$]*$/.test(prev)) return false;   // identifier / other keyword
    if (/^[\d.]/.test(prev)) return false;               // number
    return !(prev === ")" || prev === "]" || prev === "}" || prev === '"' || prev === "'" || prev === "`");
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ── comments (checked first: neither `//` nor `/*` can open a valid regex)
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }

    // ── string literals: copied verbatim, escapes honoured
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < n) {
        const s = src[i];
        if (s === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        // `${ … }` inside a template can hold anything, including comments and
        // nested templates — hand it back to the main loop via a depth walk.
        if (quote === "`" && s === "$" && src[i + 1] === "{") {
          let depth = 1; out += "${"; i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
              const q = src[i]; i++;
              while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
            }
            i++;
          }
          out += src.slice(start, i);
          continue;
        }
        out += s; i++;
        if (s === quote) break;
      }
      prev = quote;
      continue;
    }

    // ── regex literal
    if (c === "/" && regexAllowed()) {
      const start = i;
      out += c; i++;
      let inClass = false;
      while (i < n) {
        const s = src[i];
        if (s === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        if (s === "[") inClass = true;
        else if (s === "]") inClass = false;
        else if (s === "/" && !inClass) { out += s; i++; break; }
        else if (s === "\n") { // unterminated — not a regex after all; rewind
          out = out.slice(0, out.length - (i - start));
          i = start;
          out += "/"; i++;
          break;
        }
        out += s; i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; }  // flags
      prev = ")";  // a regex is a value
      continue;
    }

    out += c;
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      prev = src.slice(i, j);
      out += src.slice(i + 1, j);
      i = j;
      continue;
    }
    prev = c; i++;
  }
  return out;
}

/** Comment-free, indentation-insensitive, blank-line-free source. */
function normalize(src) {
  return stripComments(src)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Is this an engine file whose edit can regress other skills? */
function isEngineFile(filePath) {
  const p = String(filePath).replace(/\\/g, "/");
  return ENGINE_PATH_RE.test(filePath) || ENGINE_PATH_RE.test(p);
}

/**
 * @returns {{hash:string, count:number, files:Object<string,string>, dir:string}}
 *          `hash` is null-safe: an unreadable engine dir yields hash "" so the
 *          gate falls through to running the real check.
 */
function engineFingerprint() {
  let names = [];
  try {
    names = fs.readdirSync(ENGINE_DIR).filter((f) => ENGINE_FILE_RE.test(f)).sort();
  } catch {
    return { hash: "", count: 0, files: {}, dir: ENGINE_DIR };
  }
  const files = {};
  for (const name of names) {
    try {
      files[name] = sha(normalize(fs.readFileSync(path.join(ENGINE_DIR, name), "utf8")));
    } catch {
      return { hash: "", count: 0, files: {}, dir: ENGINE_DIR };
    }
  }
  const hash = names.length
    ? sha(names.map((n) => `${n}:${files[n]}`).join("\n"))
    : "";
  return { hash, count: names.length, files, dir: ENGINE_DIR };
}

// ── "last verified" marker ──────────────────────────────────────────────────
// Written by whatever last established a verdict for the whole catalog — the
// Stop-hook gate, or a manual full `check` / `capture`. Read by the gate to
// decide whether the sweep can be skipped. Only ever written for FULL runs:
// a `--caster` / `--limit` run proves nothing about the rest of the catalog,
// and recording it would let the gate skip on stale evidence.
const STATE_DIR = path.resolve(__dirname, "..", ".state");
const VERIFIED = path.join(STATE_DIR, "verified.json");

function readVerified() {
  try { return JSON.parse(fs.readFileSync(VERIFIED, "utf8")); } catch { return null; }
}

function recordVerified(extra = {}, fp = engineFingerprint()) {
  if (!fp.hash) return null;
  const rec = { hash: fp.hash, files: fp.count, at: new Date().toISOString(), ...extra };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(VERIFIED, JSON.stringify(rec, null, 2));
  } catch { return null; }
  return rec;
}

module.exports = {
  engineFingerprint, isEngineFile, normalize, stripComments,
  readVerified, recordVerified,
  ENGINE_DIR, ENGINE_PATH_RE, ENGINE_FILE_RE, VERIFIED,
};
