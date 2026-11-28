import assert from "node:assert/strict";
import { sourceSkillNames, sourceSkillMatches } from "./source-skill-filter.js";

let n = 0;
const ok = (v, msg) => { assert.ok(v, msg); n++; };
const no = (v, msg) => { assert.ok(!v, msg); n++; };

// Blank = any skill.
ok(sourceSkillMatches("", "Elemental Slash"), "blank passes");
ok(sourceSkillMatches(null, null), "null filter passes an unnamed action");
ok(sourceSkillMatches("  ,  ", "Anything"), "only separators = blank");

// Single name: unchanged behaviour (exact, case-insensitive, trimmed).
ok(sourceSkillMatches("Elemental Slash", "Elemental Slash"), "exact");
ok(sourceSkillMatches("elemental slash", "ELEMENTAL SLASH "), "case + trim");
no(sourceSkillMatches("Elemental Slash", "Elemental Slash (Enchanted)"), "no substring match");
no(sourceSkillMatches("Elemental Slash", "Elemental Slash: Overflow"), "no prefix match");
no(sourceSkillMatches("Elemental Slash", ""), "unnamed action fails a named filter");
no(sourceSkillMatches("Elemental Slash", undefined), "missing name fails closed");

// Comma list: any listed name passes, nothing else does.
const list = "Elemental Slash, Elemental Slash: Overflow";
ok(sourceSkillMatches(list, "Elemental Slash"), "first of list");
ok(sourceSkillMatches(list, "elemental slash: overflow"), "second of list, case-insensitive");
no(sourceSkillMatches(list, "Elemental Slash (Enchanted)"), "unlisted name");
no(sourceSkillMatches(list, "Elemental"), "partial name");
no(sourceSkillMatches(list, "Elemental Slash, Elemental Slash: Overflow"), "the raw list is not a name");
ok(sourceSkillMatches("A,B ,  C", "c"), "loose spacing");

// Parsed names keep their casing for display.
assert.deepEqual(sourceSkillNames(" Elemental Slash ,Elemental Slash: Overflow,, "), ["Elemental Slash", "Elemental Slash: Overflow"]); n++;
assert.deepEqual(sourceSkillNames(""), []); n++;

console.log(`source-skill-filter ok (${n} checks)`);
