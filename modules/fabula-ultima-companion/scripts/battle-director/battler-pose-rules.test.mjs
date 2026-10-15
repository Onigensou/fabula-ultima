// ============================================================================
// Battler pose rules — fallback, priority and sizing harness.
//
//     node scripts/battle-director/battler-pose-rules.test.mjs
//
// The promise of the pose system is that an actor with no pose art looks
// EXACTLY as it did before. Every rule here fails silently at the table: a
// wrong fallback shows the wrong art (or none), a wrong priority lets a KO'd
// creature flinch, and a wrong size fix makes a death clip jump or shrink.
// ============================================================================
import assert from "node:assert/strict";
import {
  poseSrc, declaredPoseSrcs, lastingPose, shownPose, actionPose, skillPose,
  poseScaleFix, poseAnchor, isGuardEffect, isCrisisEffect, isKoEffect,
} from "./battler-pose-rules.js";

const NS = "fabula-ultima-companion";
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("  ok", name); };

console.log("fallbacks");
t("no art anywhere -> own image for every pose", () => {
  for (const p of ["hurt", "ko", "crisis", "guard", "attack", "cast", "idle"]) assert.equal(poseSrc({}, p), null);
});
t("blank and whitespace count as missing", () => {
  assert.equal(poseSrc({ sprite_hurt: "   " }, "hurt"), null);
});
t("a pose uses its own art", () => {
  assert.equal(poseSrc({ sprite_ko: "k.webm" }, "ko"), "k.webm");
});
t("cast falls back to attack, then own image", () => {
  assert.equal(poseSrc({ sprite_attack: "a.webm" }, "cast"), "a.webm");
  assert.equal(poseSrc({ sprite_cast: "c.webm", sprite_attack: "a.webm" }, "cast"), "c.webm");
  assert.equal(poseSrc({}, "cast"), null);
});
t("attack never borrows cast art", () => {
  assert.equal(poseSrc({ sprite_cast: "c.webm" }, "attack"), null);
});
t("a failed URL counts as missing", () => {
  const failed = new Set(["c.webm"]);
  assert.equal(poseSrc({ sprite_cast: "c.webm", sprite_attack: "a.webm" }, "cast", failed), "a.webm");
  assert.equal(poseSrc({ sprite_hurt: "c.webm" }, "hurt", failed), null);
});
t("idle is never swapped (sprite_battle stays on the token)", () => {
  assert.equal(poseSrc({ sprite_battle: "b.webm" }, "idle"), null);
});
t("preload list = distinct declared pose art, no idle/walk", () => {
  const got = declaredPoseSrcs({ sprite_battle: "b", sprite_walk: "w", sprite_hurt: "h", sprite_attack: "a", sprite_cast: "a" });
  assert.deepEqual(got.sort(), ["a", "h"]);
});

console.log("markers");
const ko = { name: "KO", flags: { [NS]: { bdDefeated: true } } };
const guard = { name: "Guard", statuses: new Set(["guard"]), flags: { core: { statusId: "guard" } } };
const crisis = { name: "Crisis", flags: { [NS]: { bdCrisis: true } } };
t("KO marker is the bdDefeated flag only", () => {
  assert.ok(isKoEffect(ko));
  assert.ok(!isKoEffect({ name: "KO" }));
});
t("Guard by status set, status array, core statusId or name", () => {
  assert.ok(isGuardEffect(guard));
  assert.ok(isGuardEffect({ statuses: ["guard"] }));
  assert.ok(isGuardEffect({ flags: { core: { statusId: "guard" } } }));
  assert.ok(isGuardEffect({ name: "Guard" }));
  assert.ok(!isGuardEffect({ name: "Covered", statuses: new Set(["covered"]) }));
});
t("Crisis recognised like crisis-reactor (flag, legacy flag, name)", () => {
  assert.ok(isCrisisEffect(crisis));
  assert.ok(isCrisisEffect({ flags: { [NS]: { autoCrisis: true } } }));
  assert.ok(isCrisisEffect({ name: " crisis " }));
});
t("disabled effects do not count", () => {
  assert.equal(lastingPose([{ ...guard, disabled: true }, { ...crisis, disabled: true }]), "idle");
});
t("lasting priority: KO > Guard > Crisis > idle", () => {
  assert.equal(lastingPose([crisis, guard, ko]), "ko");
  assert.equal(lastingPose([crisis, guard]), "guard");
  assert.equal(lastingPose([crisis]), "crisis");
  assert.equal(lastingPose([]), "idle");
});

console.log("shown pose");
t("a one-shot plays over a lasting pose", () => {
  assert.equal(shownPose("guard", "hurt"), "hurt");
  assert.equal(shownPose("crisis", "attack"), "attack");
});
t("KO beats every one-shot", () => {
  assert.equal(shownPose("ko", "hurt"), "ko");
  assert.equal(shownPose("ko", "attack"), "ko");
});
t("no one-shot -> lasting pose", () => {
  assert.equal(shownPose("crisis", null), "crisis");
  assert.equal(shownPose(undefined, null), "idle");
});

console.log("action -> pose (user decision 2026-10-16)");
t("Attack and other skills attack; spells cast", () => {
  assert.equal(actionPose({ kind: "Attack" }), "attack");
  assert.equal(actionPose({ kind: "Skill", skillType: "active" }), "attack");
  assert.equal(actionPose({ kind: "Skill", skillType: "Spell" }), "cast");
  assert.equal(actionPose({ kind: "Spell" }), "cast");
});
t("Guard, Study, Objective, Item, Equipment, Hinder have no pose", () => {
  for (const kind of ["Guard", "Study", "Objective", "Item", "Equipment", "Hinder"]) assert.equal(actionPose({ kind }), null);
  assert.equal(actionPose(null), null);
});
t("reaction-path plays pose from the skill type", () => {
  assert.equal(skillPose("spell"), "cast");
  assert.equal(skillPose("active"), "attack");
  assert.equal(skillPose(undefined), "attack");
});

console.log("sizing");
t("same canvas -> no change", () => {
  assert.deepEqual(poseScaleFix("contain", 100, 100, { w: 297, h: 342 }, { w: 297, h: 342 }), [1, 1]);
});
t("bigger KO canvas keeps the idle pixel size (contain)", () => {
  // Dark Priest: idle 291x318, die 591x318. Fitted in a 100x100 box the idle
  // scale is 100/318; the die alone would get 100/591 — the fix restores 100/318.
  const [kx, ky] = poseScaleFix("contain", 100, 100, { w: 291, h: 318 }, { w: 591, h: 318 });
  const idleScale = 100 / 318, dieScale = 100 / 591;
  assert.ok(Math.abs(dieScale * kx - idleScale) < 1e-12);
  assert.ok(Math.abs(dieScale * ky - idleScale) < 1e-12);
});
t("bigger canvas keeps the pixel size under fill", () => {
  const [kx, ky] = poseScaleFix("fill", 100, 200, { w: 50, h: 50 }, { w: 100, h: 80 });
  assert.ok(Math.abs((100 / 100) * kx - 100 / 50) < 1e-12);
  assert.ok(Math.abs((200 / 80) * ky - 200 / 50) < 1e-12);
});
t("anchor keeps bottom-centre on bottom-centre", () => {
  const idle = { w: 231, h: 153 }, pose = { w: 1047, h: 1014 };
  for (const ia of [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0.3, y: 0.7 }]) {
    const a = poseAnchor(ia, idle, pose);
    // offset from anchor to the bottom edge / horizontal centre, in pixels
    assert.ok(Math.abs((1 - a.y) * pose.h - (1 - ia.y) * idle.h) < 1e-9);
    assert.ok(Math.abs((0.5 - a.x) * pose.w - (0.5 - ia.x) * idle.w) < 1e-9);
  }
});
t("same size -> same anchor", () => {
  assert.deepEqual(poseAnchor({ x: 0.5, y: 0.5 }, { w: 10, h: 10 }, { w: 10, h: 10 }), { x: 0.5, y: 0.5 });
});

console.log(`\n${n} passed`);
