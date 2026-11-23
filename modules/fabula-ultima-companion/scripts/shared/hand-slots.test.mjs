// node modules/fabula-ultima-companion/scripts/shared/hand-slots.test.mjs
// hand-slots.js (Book and Blade: two-handed arcane weapons in one hand) + keyword-registry lookupLinkTerm (an Item link is
// never turned into a keyword by its text: Chanter's skill "Resonance" vs the Spell Fencer keyword).
import { isTwoHandedFor, isTwoHandedItem, oneHandCategories } from "./hand-slots.js";
import { lookupLinkTerm, lookupTerm } from "../battle-director/keyword-registry.js";

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + label + (ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };

const item = (props) => ({ system: { props } });
const actor = (value) => ({ appliedEffects: value == null ? [] : [{ disabled: false, changes: [{ key: "one_hand_categories", mode: 5, value }] }] });
const staff = item({ item_type: "weapon", category: "Arcane", hand_slots: "Two-handed" });
const greatsword = item({ item_type: "weapon", category: "Heavy", hand_slots: "Two-handed" });
const rapier = item({ item_type: "weapon", category: "Sword", hand_slots: "One-handed" });
const tower = item({ item_type: "shield", hand_slots: "Two-handed" });

eq("staff is two-handed by data", isTwoHandedItem(staff), true);
eq("shield never two-handed", isTwoHandedItem(tower), false);
eq("one-handed rapier", isTwoHandedFor(actor(null), rapier), false);
eq("staff, no skill", isTwoHandedFor(actor(null), staff), true);
eq("staff, Book and Blade (arcane)", isTwoHandedFor(actor("arcane"), staff), false);
eq("greatsword, Book and Blade", isTwoHandedFor(actor("arcane"), greatsword), true);
eq("list parsing", oneHandCategories(actor("Arcane, heavy")), ["arcane", "heavy"]);
eq("no actor = item data", isTwoHandedFor(null, staff), true);

const kw = lookupTerm("Resonance");
eq("Resonance keyword registered", kw && kw.key, "JournalEntry.SpFnResonanceKw1");
eq("Next Spell status registered", lookupTerm("Next Spell")?.kind, "status");
eq("keyword link resolves", lookupLinkTerm("JournalEntry.SpFnResonanceKw1", "Resonance")?.label, "Resonance");
eq("plain bold text still resolves by name", lookupLinkTerm("", "Resonance")?.label, "Resonance");
eq("Chanter skill link is NOT the keyword", lookupLinkTerm("Item.0jmyCgEcXrA1FKKg", "Resonance"), null);
eq("embedded skill link is NOT the keyword", lookupLinkTerm("Actor.6N1FZECO8b1poKEG.Item.dR0TnMFEXotHMCPS", "Resonance"), null);
eq("damage type keeps the name fallback", lookupLinkTerm("Item.someOtherFireItem", "Fire")?.key, "Item.0sFCVCoM6FRrQP2f");
eq("status journal link by uuid", lookupLinkTerm("JournalEntry.GePNxftPupElcCWp", "Bleed")?.label, "Bleed");

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
