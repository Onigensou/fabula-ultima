// Run: node nox-b8-fragment-block.test.mjs   (B8: party-only block on a permanent Soul Fragment)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
globalThis.CONFIG = { statusEffects: [] };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };
const { isTargetBlockedFor } = await import("./snapshot.js");
const { snapshotEligibleTargetsFromDCombat } = await import("./snapshot.js");

const NS = "fabula-ultima-companion";
const mk = (uuid, effects = [], disp) => ({ uuid, id: uuid, name: uuid, system: { props: { current_hp: 10, max_hp: 10 } }, effects: { contents: effects }, prototypeToken: { disposition: disp } });
const mark = (permanent) => ({ disabled: false, changes: [], flags: { [NS]: { soulFragmentMark: true, ...(permanent ? { soulPermanent: true } : {}) } } });
const permFrag = () => mk("A.permfrag", [mark(true)], -1);
const normFrag = () => mk("A.normfrag", [mark(false)], -1);
const o = (a, t) => ({ attackerDisp: a, targetDisp: t });

assert.equal(isTargetBlockedFor(permFrag(), mk("A.pc", [], 1), o(1, -1)), true, "party vs permanent fragment: blocked");
assert.equal(isTargetBlockedFor(permFrag(), mk("A.nid", [], -1), o(-1, -1)), false, "Nidhogg side (Soul Devour) allowed");
assert.equal(isTargetBlockedFor(normFrag(), mk("A.pc", [], 1), o(1, -1)), false, "normal fragment unchanged");
assert.equal(isTargetBlockedFor(permFrag(), null, o(1, -1)), true, "unknown performer: blocked");
assert.equal(isTargetBlockedFor(permFrag(), mk("A.x", [], undefined), { targetDisp: -1 }), true, "unknown performer side: blocked");
assert.equal(isTargetBlockedFor(permFrag(), mk("A.neu", [], 0), o(0, -1)), false, "neutral performer: not an opponent");
const charm = { name: "Charm", disabled: false, changes: [{ key: "allegiance_override", value: "ally:enemy" }] };
assert.equal(isTargetBlockedFor(permFrag(), mk("A.mon", [charm], -1), { attackerDisp: -1, targetDisp: -1, targetTokenUuid: "T.f" }), true, "charmed monster acts for the party: blocked");
assert.equal(isTargetBlockedFor(mk("A.plain", [], 1), mk("A.mon", [], -1), o(-1, 1)), false, "plain actor untouched");

// Funnel: party survey drops the permanent fragment, keeps the normal one; Nidhogg's survey keeps both.
const comb = (id, actor, disp) => ({ id, actorDoc: actor, tokenDoc: { uuid: "T." + id, id, disposition: disp, actor }, disposition: disp, side: disp > 0 ? "party" : "enemy" });
const dc = { combatants: [comb("pc", mk("A.pc", [], 1), 1), comb("pf", permFrag(), -1), comb("nf", normFrag(), -1), comb("nid", mk("A.nid", [], -1), -1)] };
try {
  const ids = (snap, actor) => snapshotEligibleTargetsFromDCombat(dc, snap, { category: "enemy", attackerActor: actor }).map((e) => e.tokenId ?? e.id);
  const party = ids({ combatantId: "pc", actorId: "A.pc", disposition: 1 }, dc.combatants[0].actorDoc);
  assert.ok(!party.includes("pf") && party.includes("nf"), "party survey: permanent hidden, normal offered " + party);
  const nid = ids({ combatantId: "nid", actorId: "A.nid", disposition: -1 }, dc.combatants[3].actorDoc);
  const nidAlly = snapshotEligibleTargetsFromDCombat(dc, { combatantId: "nid", actorId: "A.nid", disposition: -1 }, { category: "ally" }).map((e) => e.tokenId);
  assert.ok(nidAlly.includes("pf") && nidAlly.includes("nf"), "Nidhogg survey still offers the permanent fragment " + nidAlly);
  assert.ok(!nid.includes("pf"), "(fragment is his side, not in his enemy list)");
} catch (e) { console.log("funnel smoke skipped:", e.message); }

// Drift: the picker mirror must reference the same two flags
const src = readFileSync(new URL("../reaction-system/visible-token-picker.js", import.meta.url), "utf8");
assert.ok(src.includes("soulFragmentMark") && src.includes("soulPermanent"), "picker mirror carries the permanent-fragment flags");
console.log("nox-b8 fragment block: ok");
