#!/usr/bin/env node
/**
 * check-esm — syntax-check .js files under the ES MODULE goal.
 *
 *     node tools/check-esm.js <file|glob> [...]
 *
 * Why this exists
 * ---------------
 * `node --check foo.js` parses as a CommonJS *script*. Foundry loads module
 * scripts as ES *modules*, and the two goals do not accept the same inputs.
 *
 * The gap is not academic. A stray backtick inside a CSS comment that lives in
 * a JS template literal —
 *
 *     s.textContent = `
 *       /* NOT `-webkit-text-stroke` + `paint-order: stroke fill` *\/
 *     `;
 *
 * — can re-pair into something the script grammar accepts while the module
 * grammar rejects it. `node --check` says OK; Foundry throws
 * "Unexpected identifier" at load and the whole subsystem silently never boots.
 * That shipped once. This is the gate that would have caught it.
 *
 * Node picks the goal from the file extension, and `--check` has no flag to
 * override it, so we copy each file to a temp `.mjs` and check that.
 *
 * Exits non-zero if any file fails. Prints one line per file.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node tools/check-esm.js <file|glob> [...]");
  process.exit(2);
}

// Expand globs ourselves so the tool behaves the same from any shell.
const files = args.flatMap((a) => (/[*?[]/.test(a) ? globSync(a) : [a]))
  .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

if (!files.length) {
  console.error("check-esm: no .js files matched");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "check-esm-"));
let failed = 0;

try {
  for (const file of files) {
    const tmp = join(dir, basename(file).replace(/\.js$/, "") + ".mjs");
    copyFileSync(file, tmp);
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      console.log(`  ok    ${file}`);
    } catch (e) {
      failed++;
      const msg = String(e.stderr ?? e.message)
        .split("\n")
        .filter((l) => l.trim() && !l.includes(tmp) && !l.startsWith("    at"))
        .slice(0, 3)
        .join("\n          ");
      console.log(`  FAIL  ${file}\n          ${msg}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\ncheck-esm: ${failed} file(s) failed the ES module parse`);
  process.exit(1);
}
console.log(`\ncheck-esm: ${files.length} file(s) OK`);
