// ============================================================================
// Clock System — socket contract harness.
//
//     node scripts/clock-system/clock-socket.test.mjs
//
// The socket itself needs a live Foundry client, so this covers the part that
// CAN be checked cold: the op table is a string-keyed dispatch, and a typo in
// clock-api.js would only surface at runtime as an "unknown clock op" rejection
// on a player's client — quite possibly mid-session. So we read the API's
// source and prove every op it dispatches actually exists, that every op the
// table declares is reachable, and that the player allowlist is a real subset.
//
// Importing clock-socket.js is safe without Foundry: `game` and `foundry` are
// only touched inside function bodies, never at module scope.
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OP_NAMES, PLAYER_OPS } from "./clock-socket.js";

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = readFileSync(join(here, "clock-api.js"), "utf8");

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// Every `dispatch("op"` literal in the public API.
const dispatched = [...apiSrc.matchAll(/dispatch\(\s*"([^"]+)"/g)].map((m) => m[1]);
const uniqueDispatched = [...new Set(dispatched)].sort();

eq("the API dispatches at least one op", dispatched.length > 0, true);

const unknown = uniqueDispatched.filter((op) => !OP_NAMES.includes(op));
eq("every op the API dispatches exists in the op table", unknown, []);

const unreachable = OP_NAMES.filter((op) => !uniqueDispatched.includes(op));
eq("every op in the table is reachable from the API", unreachable, []);

const strays = [...PLAYER_OPS].filter((op) => !OP_NAMES.includes(op));
eq("the player allowlist is a subset of the op table", strays, []);

// A player may advance a clock. They may not create, delete, force-resolve or
// sweep — and notably may NOT applyRoll: a player's click asks the GM to run the
// Check Requester, and the GM commits dice rolled on its own client.
eq("players may advance and applyCheck", [...PLAYER_OPS].sort(), ["advance", "applyCheck"]);
eq("applyRoll is GM-only (no client-supplied dice)", PLAYER_OPS.has("applyRoll"), false);

for (const gmOnly of ["create", "destroy", "resolve", "sweep", "purgeDiscarded"]) {
  eq(`"${gmOnly}" is GM-only`, PLAYER_OPS.has(gmOnly), false);
}

// previewCheck must never cross the socket — it is the ungated, any-client read
// that makes pre-roll previews possible in the first place.
eq("previewCheck does not dispatch", /previewCheck:\s*\(id, spec\)\s*=>\s*store\.preview/.test(apiSrc), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
