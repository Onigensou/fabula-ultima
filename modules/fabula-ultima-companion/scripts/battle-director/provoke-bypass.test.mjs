import assert from "node:assert/strict";
import { keywordsIgnoreProvoke, actionIgnoresProvoke, provokePinKind, IGNORE_PROVOKE_KEYWORD } from "./provoke-bypass.js";

let n = 0;
const ok = (v, msg) => { assert.ok(v, msg); n++; };
const no = (v, msg) => { assert.ok(!v, msg); n++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); n++; };

const skill = (kw) => ({ system: { props: { action_keywords: kw } } });

// Keyword parse: every accepted spelling, inside a real list, case-insensitive.
eq(IGNORE_PROVOKE_KEYWORD, "ignore_provoke");
ok(keywordsIgnoreProvoke("pierce, chain 4 seek, ignore_provoke"), "Asura Strike's list");
ok(keywordsIgnoreProvoke("Ignore Provoke"), "spaced, capitalised");
ok(keywordsIgnoreProvoke("ignores provoke\nmassive"), "newline list");
ok(keywordsIgnoreProvoke("ignores_provoke"), "ignores_ form");
ok(keywordsIgnoreProvoke(["pierce", "ignore_provoke"]), "array");
ok(keywordsIgnoreProvoke("<p>ignore_provoke</p>"), "rich-text cell");
no(keywordsIgnoreProvoke("pierce, chain 4 seek"), "no keyword");
no(keywordsIgnoreProvoke("ignore_provoked"), "no near-miss");
no(keywordsIgnoreProvoke(""), "blank");
no(keywordsIgnoreProvoke(null), "null");

// Sources: Item doc, weapon snapshot, pseudo-weapon, raw string; ANY source wins.
ok(actionIgnoresProvoke(skill("ignore_provoke")), "item doc");
ok(actionIgnoresProvoke({ actionKeywords: "ignore_provoke" }), "weapon snapshot");
ok(actionIgnoresProvoke({ action_keywords: "ignore_provoke" }), "pseudo-weapon");
ok(actionIgnoresProvoke("ignore_provoke"), "raw string");
ok(actionIgnoresProvoke(null, skill("pierce"), { actionKeywords: "ignore_provoke" }), "weapon carries it");
no(actionIgnoresProvoke(skill("pierce"), null, undefined), "none carry it");
no(actionIgnoresProvoke(), "no sources");

// The pin decision: a bypass drops the kind to null (= no attacker-side pin);
// otherwise the kind is passed through untouched, including a no-pin action.
eq(provokePinKind("attack", skill("pierce, chain 4 seek, ignore_provoke")), null, "signature attack: no pin");
eq(provokePinKind("spell", skill("ignore_provoke")), null, "signature spell: no pin");
eq(provokePinKind("attack", skill("pierce")), "attack", "normal attack keeps the pin");
eq(provokePinKind("spell", null), "spell", "no source keeps the pin");
eq(provokePinKind(null, skill("ignore_provoke")), null, "heal/buff stays unpinned");
eq(provokePinKind("", skill("pierce")), "", "empty kind passes through (ACTION_IS_PROVOKABLE reads '')");
eq(provokePinKind("attack", null, { actionKeywords: "ignore_provoke" }), null, "Attack command via the weapon");

// Random-target actions ignore Provoke (user rule 2026-11-28)
const { targetsAtRandom } = await import("./provoke-bypass.js");
eq(targetsAtRandom({ skillTarget: "One Random Enemy" }), true, "One Random Enemy = random");
eq(targetsAtRandom({ skillTarget: "One Random Creature" }), true, "roulette text = random");
eq(targetsAtRandom({ hasRoulette: true }), true, "legacy roulette weapon = random");
eq(targetsAtRandom({ skillTarget: "All Enemies", chainMode: "seek" }), true, "drawn chain (seek) = random");
eq(targetsAtRandom({ chainMode: "volley" }), true, "volley = random");
eq(targetsAtRandom({ skillTarget: "One Enemy", chainMode: "pick" }), false, "pick chain = declared");
eq(targetsAtRandom({ skillTarget: "One Enemy" }), false, "declared single target keeps the pin (Gigas Heavy Swing)");
eq(targetsAtRandom({ skillTarget: "Up to three enemies" }), false, "declared multi target keeps the pin");
eq(targetsAtRandom({}), false, "nothing = declared");

console.log(`provoke-bypass ok (${n} checks)`);
