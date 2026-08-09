#!/usr/bin/env node
// Reject raw NUL bytes in staged TEXT source files.
//
// Why this exists: ripgrep classifies a file as binary the moment it sees a NUL
// byte and then SILENTLY skips it — `rg pattern` reports "no matches" rather
// than an error. On 2026-08-09 `scripts/battle-director/skill-effects.js` (the
// 10k-line core engine) carried exactly ONE raw NUL, inside the string literal
// `CAP_NO_SUBJECT`. Every content search of the project's most important file
// had been quietly returning nothing, which is how two implemented skills
// (Quick Summoning, Perfect Aim) got reported as unbuilt.
//
// Git's own binary heuristic does NOT catch this: git only sniffs the first 8000
// bytes, and that NUL sat at offset 91714 — so `--numstat` showed a normal text
// diff. The whole blob has to be scanned, which is what this does.
//
// If you genuinely need a NUL in a string, write the six-character source
// escape (backslash-u-0-0-0-0) — same runtime value, no NUL byte in the file.
//
// Reads the STAGED blob (`git show :path`), not the working tree, so it can't be
// fooled by an unstaged fixup.

const { execFileSync } = require("node:child_process");

const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|json|md|css|scss|html|hbs|sh|yml|yaml|txt)$/i;

function staged() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean).filter((f) => TEXT_EXT.test(f));
}

const bad = [];
for (const f of staged()) {
  let blob;
  try {
    blob = execFileSync("git", ["show", `:${f}`], { maxBuffer: 256 * 1024 * 1024 });
  } catch {
    continue; // deleted or unreadable from the index — not our concern
  }
  const at = blob.indexOf(0);
  if (at === -1) continue;
  const line = blob.slice(0, at).toString("utf8").split("\n").length;
  const count = blob.reduce((n, b) => (b === 0 ? n + 1 : n), 0);
  bad.push({ file: f, line, count });
}

if (!bad.length) process.exit(0);

console.error("");
console.error("[no-nul] ⛔ commit blocked: raw NUL byte(s) in staged text source:");
for (const b of bad) {
  console.error(`  ✗ ${b.file}:${b.line}  (${b.count} NUL byte${b.count === 1 ? "" : "s"})`);
}
console.error("");
console.error("  A NUL makes ripgrep treat the whole file as binary and skip it in every");
console.error("  content search, with NO error — the file becomes invisible to grep.");
console.error("  Fix: write the escape \\u0000 in source instead of the raw byte.");
console.error("  Intentional (e.g. a real binary blob with a text extension)? Bypass with:");
console.error("      git commit --no-verify");
process.exit(1);
