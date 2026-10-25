// ============================================================================
// Party entrance styles — selection + roll harness.
//
//     node scripts/battle-director/party-entrance-styles.test.mjs
//
// Bare Node, no Foundry. Only the pure half: which members get a bespoke
// entrance, the host roll, timings and cues. The renderer is DOM + PIXI and is
// verified with headless frame captures against the mockup.
//
// The load-bearing assertions: an unflagged member (and every enemy style)
// reads as NO party style, so the run-in dash is untouched; and a party key
// never leaks into the enemy reader, whose unknown-style fallback is a flame.
// ============================================================================

import {
  PARTY_ENTRANCE_STYLES,
  PARTY_ENTRANCE_MODULE_ID,
  PARTY_ENTRANCE_STYLE_FLAG,
  PARTY_SFX_MIX,
  PARTY_ENTRANCE_SFX_URLS,
  OUTCOME_SUCCESS,
  OUTCOME_FAIL,
  partyEntranceStyleFromFlags,
  rollPartyOutcome,
  outcomeFor,
  partyTotalMs,
  partyLandMs,
  partySfx,
  partyEntranceSpanMs,
} from "./party-entrance-styles.js";
import { entranceStyleFromFlags, DESCENT_STYLES, DEFAULT_ENTRANCE_STYLE } from "./boss-entrance-fx.js";
import { GATHER_STYLES } from "./gather-styles.js";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };
const flags = (v) => ({ [PARTY_ENTRANCE_MODULE_ID]: { [PARTY_ENTRANCE_STYLE_FLAG]: v } });

// ── selection ──
ok("no flags → dash", partyEntranceStyleFromFlags(undefined) === null);
ok("empty flags → dash", partyEntranceStyleFromFlags({}) === null);
ok("blank → dash", partyEntranceStyleFromFlags(flags("  ")) === null);
ok("fade → dash", partyEntranceStyleFromFlags(flags("fade")) === null);
ok("typo → dash", partyEntranceStyleFromFlags(flags("Mirror")) === null);
ok("inherited name → dash", partyEntranceStyleFromFlags(flags("toString")) === null);
ok("wrong type → dash", partyEntranceStyleFromFlags(flags({ a: 1 })) === null);
ok("throwing flags → dash", partyEntranceStyleFromFlags({ get [PARTY_ENTRANCE_MODULE_ID]() { throw new Error("x"); } }) === null);
for (const k of ["mirror", "foxfire", "fiftyFifty", "warningShot"]) {
  ok(`${k} selected`, partyEntranceStyleFromFlags(flags(k)) === k);
  ok(`${k} padded selected`, partyEntranceStyleFromFlags(flags(` ${k} `)) === k);
  // never routed into the enemy renderer
  ok(`${k} reads as fade for the enemy reader`, entranceStyleFromFlags(flags(k)) === DEFAULT_ENTRANCE_STYLE);
}
for (const k of [...Object.keys(DESCENT_STYLES), ...Object.keys(GATHER_STYLES)]) {
  ok(`enemy style ${k} is not a party style`, partyEntranceStyleFromFlags(flags(k)) === null);
  ok(`enemy style ${k} does not collide`, !Object.prototype.hasOwnProperty.call(PARTY_ENTRANCE_STYLES, k));
}

// ── the host roll ──
ok("50/50 low → success", rollPartyOutcome("fiftyFifty", () => 0) === OUTCOME_SUCCESS);
ok("50/50 0.49 → success", rollPartyOutcome("fiftyFifty", () => 0.49) === OUTCOME_SUCCESS);
ok("50/50 0.5 → fail", rollPartyOutcome("fiftyFifty", () => 0.5) === OUTCOME_FAIL);
ok("50/50 0.9999 → fail", rollPartyOutcome("fiftyFifty", () => 0.9999) === OUTCOME_FAIL);
ok("50/50 junk random → a valid outcome", [OUTCOME_SUCCESS, OUTCOME_FAIL].includes(rollPartyOutcome("fiftyFifty", () => NaN)));
ok("50/50 1.0 clamps → fail", rollPartyOutcome("fiftyFifty", () => 1) === OUTCOME_FAIL);
ok("no-roll style → null", rollPartyOutcome("mirror") === null);
ok("unknown style → null", rollPartyOutcome("nope") === null);
{
  let h = 0; for (let i = 0; i < 4000; i++) if (rollPartyOutcome("fiftyFifty") === OUTCOME_SUCCESS) h++;
  ok(`50/50 is near even (${h}/4000)`, h > 1700 && h < 2300);
}
ok("outcome kept", outcomeFor("fiftyFifty", OUTCOME_FAIL) === OUTCOME_FAIL);
ok("missing outcome → success (never a crash)", outcomeFor("fiftyFifty", null) === OUTCOME_SUCCESS);
ok("junk outcome → success", outcomeFor("fiftyFifty", "X") === OUTCOME_SUCCESS);
ok("no-roll style outcome → null", outcomeFor("mirror", OUTCOME_FAIL) === null);

// ── timings (the mockup's) ──
ok("mirror 2.4 s", partyTotalMs("mirror") === 2400);
ok("foxfire 2.3 s", partyTotalMs("foxfire") === 2300);
ok("warningShot 1.8 s", partyTotalMs("warningShot") === 1800);
ok("50/50 success 2.0 s", partyTotalMs("fiftyFifty", OUTCOME_SUCCESS) === 2000);
ok("50/50 fail 2.8 s", partyTotalMs("fiftyFifty", OUTCOME_FAIL) === 2800);
ok("unknown 0", partyTotalMs("nope") === 0);
for (const k of Object.keys(PARTY_ENTRANCE_STYLES)) {
  for (const o of [OUTCOME_SUCCESS, OUTCOME_FAIL]) {
    ok(`${k}/${o}: lands inside the entrance`, partyLandMs(k, o) >= 0 && partyLandMs(k, o) < partyTotalMs(k, o));
  }
}
ok("50/50 fail lands on the mark at 2.45 s", partyLandMs("fiftyFifty", OUTCOME_FAIL) === 2450);

// ── cues: minimal, the user's picks, mixed down ──
const urls = (k) => partySfx(k).map((c) => c.url.split("/").pop());
ok("mirror cues = Teleport + Flash2", urls("mirror").join() === "Teleport.ogg,Flash2.ogg");
ok("foxfire cues = Fire1 + Charm", urls("foxfire").join() === "Fire1.ogg,Charm.ogg");
ok("50/50 cue = DashA only", urls("fiftyFifty").join() === "DashA.wav");
ok("warningShot cue = Crossbow", urls("warningShot").join() === "Crossbow.ogg");
ok("cues mixed by PARTY_SFX_MIX", Math.abs(partySfx("warningShot")[0].volume - 0.6 * PARTY_SFX_MIX) < 1e-9);
ok("at most two cues per member", Object.keys(PARTY_ENTRANCE_STYLES).every((k) => partySfx(k).length <= 2));
ok("cues inside the entrance", Object.keys(PARTY_ENTRANCE_STYLES).every((k) => partySfx(k).every((c) => c.atMs >= 0 && c.atMs < partyTotalMs(k, OUTCOME_SUCCESS))));
ok("cue urls absolute", PARTY_ENTRANCE_SFX_URLS.every((u) => u.startsWith("https://")));
ok("cue urls unique", new Set(PARTY_ENTRANCE_SFX_URLS).size === PARTY_ENTRANCE_SFX_URLS.length);
ok("partySfx returns a copy", (() => { const a = partySfx("mirror"); a.pop(); return partySfx("mirror").length === 2; })());

// ── whole-party span ──
const party = [{ style: "mirror" }, { style: "foxfire" }, { style: "fiftyFifty", outcome: OUTCOME_FAIL }, { style: "warningShot" }];
ok("span = Blanche's fail from slot 2", partyEntranceSpanMs(party) === Math.max(2400, 120 + 2300, 240 + 2800, 360 + 1800));
ok("all dashers = legacy dash span", partyEntranceSpanMs([{}, {}, {}, {}]) === 360 + 520);
ok("empty party = 0", partyEntranceSpanMs([]) === 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
