// Regression test for world-export's session-state stripping.
//
// Why this exists: one player login (any player-seat test) moves the movement
// controller and re-skins the central party token. Movement control writes
// both back to the world (Current Game's movementControlState flag, and the
// party actor's prototypeToken.texture.src), so the export reported two
// modified documents nobody authored. They are re-derived on every refresh,
// so the export now drops them.
//
// The test also proves the strip is NARROW: an authored edit on the same two
// documents, and the token art of any other actor, still show in the diff.
//
// No game required. Docs come from HEAD's export (pre-strip, real shape).
// Run: node <this file>
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const require = createRequire(import.meta.url);
const { serialize, stripSessionState } = require("../bin/world-export.js");

const EXPORT = "worlds/fabula-ultima-2/_authored-export/actors";
// HEAD before the strip landed still carries both session fields.
const REF = process.env.WE_REF ?? "818c6cbe";
const show = (id) => JSON.parse(execFileSync("git", ["show", `${REF}:${EXPORT}/${id}.json`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 }));
const CURRENT_GAME = "DMpK5Bi119jIrCFZ", PARTY = "t6E3CQ0pGxwLgXrn", OTHER_PARTY = "0Ttg3RYQZUySixH1";

const clone = (x) => structuredClone(x);
const exportOf = (docs) => {
  const d = stripSessionState("actors", clone(docs));
  return Object.fromEntries(d.map((x) => [x._id, serialize(x)]));
};

let fail = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) fail++; };

const base = [show(CURRENT_GAME), show(PARTY), show(OTHER_PARTY)];

// Preconditions: the fixtures really carry the fields we claim to strip,
// and Current Game really points at the party actor.
check("fixture: Current Game holds movementControlState", !!base[0].flags?.["fabula-ultima-companion"]?.movementControlState);
check("fixture: Current Game game_id -> EXFURSION Party", base[0].system?.props?.game_id === `Actor.${PARTY}`, base[0].system?.props?.game_id);
check("fixture: party token art is set", !!base[1].prototypeToken?.texture?.src);

// The residue a player login leaves (measured 2026-10-12, Trinio seat).
const residue = clone(base);
Object.assign(residue[0].flags["fabula-ultima-companion"].movementControlState, {
  controllerActorId: "zargZARGzargZARG", controllerActorName: "Zarg", currentControllerUserId: "trinioTRINIO0000",
  currentControllerUserName: "Trinio", updatedAt: 1, updateReason: "refresh:bootstrap:updateUser",
});
residue[1].prototypeToken.texture.src = "https://example.invalid/Zarg_Standard.png";

const rawDiffers = (i) => JSON.stringify(base[i]) !== JSON.stringify(residue[i]);
check("precondition: residue changes the raw docs", rawDiffers(0) && rawDiffers(1));

const a = exportOf(base), b = exportOf(residue);
check("Current Game export identical after a login", a[CURRENT_GAME] === b[CURRENT_GAME]);
check("party actor export identical after a login", a[PARTY] === b[PARTY]);
check("party export keeps the rest of prototypeToken.texture", JSON.parse(a[PARTY]).prototypeToken?.texture?.scaleX === base[1].prototypeToken.texture.scaleX);

// Narrowness: authored edits must still surface.
const authored = clone(base);
authored[0].system.props.game_id = `Actor.${OTHER_PARTY}`;
authored[1].name = "EXFURSION Party (renamed)";
const c = exportOf(authored);
check("authored edit on Current Game still shows", a[CURRENT_GAME] !== c[CURRENT_GAME]);
check("authored edit on party actor still shows", a[PARTY] !== c[PARTY]);
// game_id now names the other party, so ITS art is the mirrored one.
check("mirroring follows game_id", !JSON.parse(c[OTHER_PARTY]).prototypeToken?.texture?.src);

const other = clone(base);
other[2].prototypeToken.texture.src = "https://example.invalid/changed.png";
check("token art of a non-central actor still shows", a[OTHER_PARTY] !== exportOf(other)[OTHER_PARTY]);

const otherFlag = clone(base);
otherFlag[0].flags["fabula-ultima-companion"].someAuthoredFlag = 1;
check("other flags in the same scope still show", a[CURRENT_GAME] !== exportOf(otherFlag)[CURRENT_GAME]);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
