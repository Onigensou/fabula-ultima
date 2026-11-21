// Run: node target-block-drift.test.mjs
// ONE drift test: every zero-import mirror of snapshot.js isTargetBlockedFor (ActionReader core,
// skill-formulas.js, formula-evaluator.js) must give the SAME verdict as the canonical predicate on
// a table of cases (Servant `opponent` block, permanent Soul Fragment, charm either side, neutral,
// self, unknown performer, Domination State). Plus ActionReader pool + count behaviour.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.foundry = { utils: { getProperty: (o, p) => String(p).split(".").reduce((a, k) => (a == null ? undefined : a[k]), o) } };
globalThis.CONFIG = { statusEffects: [] };
globalThis.game = { combat: null, user: { isGM: true }, actors: { get: () => null } };
const here = path.dirname(fileURLToPath(import.meta.url));
const S = path.join(here, "..");
const imp = (p) => import(pathToFileURL(path.join(S, p)).href);
const { isTargetBlockedFor } = await imp("battle-director/snapshot.js");

// Pull each mirror out of its file by marker (skill-formulas / formula-evaluator are not importable in Node).
const FILES = ["action-reader/actionReader-core.js", "battle-director/skill-formulas.js", "reaction-system/formula-evaluator.js"];
const RE = /\/\/ <<nox-opponent-mirror:begin>>([\s\S]*?)\/\/ <<nox-opponent-mirror:end>>/;
const mirrors = {};
const bodies = [];
for (const f of FILES) {
  const m = fs.readFileSync(path.join(S, f), "utf8").match(RE);
  assert.ok(m, `mirror markers missing in ${f}`);
  bodies.push(m[1].replace(/\r/g, ""));
  mirrors[f] = new Function(`${m[1]}\nreturn _noxOpponentBlockedFor;`)();
}
assert.equal(bodies[0], bodies[1], "mirror text differs: core vs skill-formulas");
assert.equal(bodies[0], bodies[2], "mirror text differs: core vs formula-evaluator");

const NS = "fabula-ultima-companion";
const mk = (uuid, effects = [], disp) => ({ uuid, name: uuid, effects: { contents: effects }, prototypeToken: { disposition: disp }, system: { props: {} } });
const block = { name: "Nox Servant", disabled: false, changes: [{ key: "cannot_be_targeted_by", value: "opponent" }] };
const anyBlock = { name: "Guest", disabled: false, changes: [{ key: "cannot_be_targeted_by", value: "any" }] };
const meleeBlock = { name: "Covered", disabled: false, changes: [{ key: "cannot_be_targeted_by", value: "melee" }] };
const fragAE = { name: "Mark", disabled: false, flags: { [NS]: { soulFragmentMark: true, soulPermanent: true } }, changes: [] };
const tempFragAE = { name: "Mark", disabled: false, flags: { [NS]: { soulFragmentMark: true } }, changes: [] };
const charm = { name: "Charm", disabled: false, changes: [{ key: "allegiance_override", value: "ally:enemy" }] };
const swap = { name: "Swap", disabled: false, changes: [{ key: "allegiance_override", value: "ally:enemy" }, { key: "allegiance_override", value: "enemy:ally" }] };
const domCharm = { name: "SuperArmor", disabled: false, changes: [{ key: "ignore_action_gating", value: "1" }, { key: "allegiance_override", value: "ally:enemy" }] };

const servant = (d = 1) => mk("A.servant", [block], d);
const cases = [
  ["party vs Servant", servant(), mk("A.pc", [], 1), 1, 1, false],
  ["monster vs Servant", servant(), mk("A.mon", [], -1), -1, 1, true],
  ["neutral vs Servant", servant(), mk("A.neu", [], 0), 0, 1, false],
  ["Servant vs itself", servant(), servant(), 1, 1, false],
  ["no block", mk("A.plain", [], 1), mk("A.mon", [], -1), -1, 1, false],
  ["any block only (not opponent)", mk("A.g", [anyBlock], 1), mk("A.mon", [], -1), -1, 1, false],
  ["melee block only", mk("A.c", [meleeBlock], 1), mk("A.mon", [], -1), -1, 1, false],
  ["disabled block", mk("A.d", [{ ...block, disabled: true }], 1), mk("A.mon", [], -1), -1, 1, false],
  ["charmed PC (charmed side)", servant(), mk("A.pc2", [charm], 1), 1, 1, true],
  ["charmed monster (natural side)", servant(), mk("A.mon2", [charm], -1), -1, 1, true],
  ["disabled charm on PC", servant(), mk("A.pc3", [{ ...charm, disabled: true }], 1), 1, 1, false],
  ["full swap on PC", servant(), mk("A.pc4", [swap], 1), 1, 1, true],
  ["monster with swap", servant(), mk("A.mon3", [swap], -1), -1, 1, true],
  ["Domination State voids charm", servant(), mk("A.dom", [domCharm], 1), 1, 1, false],
  ["monster dominated onto party", servant(), mk("A.mon4", [], 1), 1, 1, false],
  ["no performer", servant(), null, undefined, 1, true],
  ["no performer, no block", mk("A.plain"), null, undefined, 1, false],
  ["dispositions unknown", servant(null), mk("A.x", [], null), null, null, true],
  ["perm fragment vs party", mk("A.frag", [fragAE], -1), mk("A.pc", [], 1), 1, -1, true],
  ["perm fragment vs Nidhogg (same side)", mk("A.frag", [fragAE], -1), mk("A.nid", [], -1), -1, -1, false],
  ["perm fragment vs no performer", mk("A.frag", [fragAE], -1), null, undefined, -1, true],
  ["temp fragment vs party", mk("A.tfrag", [tempFragAE], -1), mk("A.pc", [], 1), 1, -1, false],
  ["perm fragment, charmed Nidhogg-side", mk("A.frag", [fragAE], -1), mk("A.mon5", [charm], -1), -1, -1, true]
];
for (const [name, target, perf, pd, td, expect] of cases) {
  const canon = isTargetBlockedFor(target, perf, { attackerDisp: pd, targetDisp: td });
  assert.equal(canon, expect, `canonical: ${name}`);
  for (const f of FILES) {
    assert.equal(mirrors[f](target, perf, { performerDisp: pd, targetDisp: td }), canon, `DRIFT ${f}: ${name}`);
  }
}
{ // override addressed by token uuid (canonical lowercases override targets, so a real mixed-case uuid never matches: pre-existing, see handoff)
  const t = servant();
  const pc = mk("A.pcu", [{ name: "C", disabled: false, changes: [{ key: "allegiance_override", value: "scene.s.token.tk:enemy" }] }], 1);
  const canon = isTargetBlockedFor(t, pc, { attackerDisp: 1, targetDisp: 1, targetTokenUuid: "scene.s.token.tk" });
  assert.equal(canon, true);
  for (const f of FILES) assert.equal(mirrors[f](t, pc, { performerDisp: 1, targetDisp: 1, targetTokenUuid: "scene.s.token.tk" }), canon, `DRIFT token-uuid ${f}`);
}

// ── ActionReader: pool + counts ──────────────────────────────────────────────
const { ActionReaderCore: AR } = await imp("action-reader/actionReader-core.js");
const { _poolTestSeam } = await imp("action-reader/actionReader-buildAndPickTargets.js");
const mkTok = (id, actor, disp) => { const d = { id, uuid: `Scene.s.Token.${id}`, disposition: disp, actor, name: id, hidden: false }; d.document = d; return d; };
const nid = mk("A.nid", [], -1), pc1 = mk("A.pc1", [], 1), pc2 = mk("A.pc2", [], 1), sv = servant(1), frag = mk("A.frag", [fragAE], -1);
const tNid = mkTok("tN", nid, -1), tPc = mkTok("tP", pc1, 1), tPc2 = mkTok("tP2", pc2, 1), tSv = mkTok("tS", sv, 1), tFrag = mkTok("tF", frag, -1);
const all = [tNid, tPc, tPc2, tSv, tFrag];
globalThis.canvas = { tokens: { placeables: all } };

assert.equal(AR.isOpponentBlockedFor(sv, tSv, nid, tNid), true, "AR: monster vs Servant");
assert.equal(AR.isOpponentBlockedFor(sv, tSv, pc1, tPc), false, "AR: party vs Servant");
assert.equal(AR.isOpponentBlockedFor(frag, tFrag, pc1, tPc), true, "AR: party vs permanent fragment");
assert.equal(AR.isOpponentBlockedFor(frag, tFrag, nid, tNid), false, "AR: Nidhogg vs fragment");
const charmedPc = mk("A.cpc", [charm], 1);
assert.equal(AR.isOpponentBlockedFor(sv, tSv, charmedPc, mkTok("tC", charmedPc, 1)), true, "AR: charmed PC vs Servant");

// counts
assert.equal(AR.countSceneTargetsForRelation(nid, tNid, "enemy"), 2, "monster: 2 PCs, Servant not counted");
assert.equal(AR.countSceneTargetsForRelation(pc1, tPc, "ally"), 3, "party: ally = self + pc2 + Servant (Servant counted)");
assert.equal(AR.countSceneTargetsForRelation(pc1, tPc, "enemy"), 1, "party enemy count: Nidhogg only, permanent fragment is party-blocked");
assert.equal(AR.countSceneTargetsForRelation(charmedPc, mkTok("tC", charmedPc, 1), "ally"), 2, "charmed PC: Servant dropped from ally count (pc1, pc2 remain)");

// candidate pool
const idsOf = (entries) => entries.map((e) => e.tokenId);
const pool = (actor, tokenDoc) => idsOf(_poolTestSeam.getCandidatePool({ performer: { actor, tokenDocument: tokenDoc } }, { sceneTokens: all }));
const monsterPool = pool(nid, tNid);
assert.ok(!monsterPool.includes("tS"), "monster pool excludes the Servant");
assert.ok(monsterPool.includes("tP") && monsterPool.includes("tP2"), "monster pool keeps the PCs");
const partyPool = pool(pc1, tPc);
assert.ok(partyPool.includes("tS"), "party pool includes the Servant");
assert.ok(!partyPool.includes("tF"), "party pool excludes the permanent fragment");
assert.ok(monsterPool.includes("tF"), "monster pool keeps the fragment (Soul Devour)");
console.log("target-block-drift tests OK");
