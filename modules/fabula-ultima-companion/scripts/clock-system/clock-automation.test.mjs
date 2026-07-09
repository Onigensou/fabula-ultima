// ============================================================================
// Clock System — automation matcher harness.
//
//     node scripts/clock-system/clock-automation.test.mjs
//
// `rowApplies` decides whether a director trigger moves a clock. It fails
// SILENTLY when wrong — a row that never matches looks exactly like a quiet
// combat, and a row that over-matches looks like a haunted clock. Neither is
// something you want to discover mid-session, so it is tested cold.
// ============================================================================

import { rowApplies, registerCondition } from "./clock-automation.js";
import { preset } from "./clock-model.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const clock = preset.threat({ id: "t", name: "Alarm" });
const withHistory = (causes) => ({ ...clock, history: causes.map((cause) => ({ cause })) });

const ev = (over = {}) => ({
  trigger: "creature_defeated",
  casterActor: { uuid: "Actor.x", hasPlayerOwner: false },
  payload: {},
  ...over,
});

// ── trigger name ──────────────────────────────────────────────────────────
eq("matching trigger applies", rowApplies(clock, { trigger: "creature_defeated" }, 0, ev()), true);
eq("other trigger does not", rowApplies(clock, { trigger: "round_end" }, 0, ev()), false);

// ── subject filter ────────────────────────────────────────────────────────
const player = ev({ casterActor: { uuid: "Actor.p", hasPlayerOwner: true } });
const enemy = ev({ casterActor: { uuid: "Actor.e", hasPlayerOwner: false } });

eq("subject defaults to any", rowApplies(clock, { trigger: "creature_defeated" }, 0, player), true);
eq("subject:player matches a PC", rowApplies(clock, { trigger: "creature_defeated", subject: "player" }, 0, player), true);
eq("subject:player rejects an enemy", rowApplies(clock, { trigger: "creature_defeated", subject: "player" }, 0, enemy), false);
eq("subject:enemy matches an enemy", rowApplies(clock, { trigger: "creature_defeated", subject: "enemy" }, 0, enemy), true);
eq("subject:enemy rejects a PC", rowApplies(clock, { trigger: "creature_defeated", subject: "enemy" }, 0, player), false);

// ── skill filter ──────────────────────────────────────────────────────────
const cast = ev({ trigger: "creature_completes_skill", payload: { skillName: "Crossfire" } });
eq("skill filter matches, case-insensitively", rowApplies(clock, { trigger: "creature_completes_skill", skill: "crossfire" }, 0, cast), true);
eq("skill filter rejects another skill", rowApplies(clock, { trigger: "creature_completes_skill", skill: "Vanish" }, 0, cast), false);
eq("no skill filter matches anything", rowApplies(clock, { trigger: "creature_completes_skill" }, 0, cast), true);
eq("skill filter falls back to actionName",
  rowApplies(clock, { trigger: "creature_completes_skill", skill: "Elixir" }, 0,
    ev({ trigger: "creature_completes_skill", payload: { actionName: "Elixir" } })), true);

// ── once ──────────────────────────────────────────────────────────────────
const onceRow = { trigger: "creature_defeated", once: true };
eq("once: fires the first time", rowApplies(clock, onceRow, 0, ev()), true);
eq("once: not again after its cause is in history",
  rowApplies(withHistory(["auto:creature_defeated:0"]), onceRow, 0, ev()), false);
eq("once: a different row index has its own fingerprint",
  rowApplies(withHistory(["auto:creature_defeated:0"]), onceRow, 1, ev()), true);
eq("once: an explicit cause is the fingerprint",
  rowApplies(withHistory(["the alarm sounds"]), { ...onceRow, cause: "the alarm sounds" }, 0, ev()), false);
eq("without once, history is irrelevant",
  rowApplies(withHistory(["auto:creature_defeated:0"]), { trigger: "creature_defeated" }, 0, ev()), true);

// ── conditions ────────────────────────────────────────────────────────────
registerCondition("always", () => true);
registerCondition("never", () => false);
registerCondition("explodes", () => { throw new Error("boom"); });
registerCondition("readsEvent", (e) => e.casterActor.uuid === "Actor.p");

eq("condition true → applies", rowApplies(clock, { trigger: "creature_defeated", condition: "always" }, 0, ev()), true);
eq("condition false → rejected", rowApplies(clock, { trigger: "creature_defeated", condition: "never" }, 0, ev()), false);
eq("condition receives the event", rowApplies(clock, { trigger: "creature_defeated", condition: "readsEvent" }, 0, player), true);
eq("a throwing condition rejects, it does not crash combat",
  rowApplies(clock, { trigger: "creature_defeated", condition: "explodes" }, 0, ev()), false);
eq("an unknown condition rejects rather than silently passing",
  rowApplies(clock, { trigger: "creature_defeated", condition: "nope" }, 0, ev()), false);

// ── filters compose (all must pass) ───────────────────────────────────────
const strict = { trigger: "creature_defeated", subject: "enemy", condition: "always", once: true };
eq("all filters pass", rowApplies(clock, strict, 0, enemy), true);
eq("one failing filter rejects the row", rowApplies(clock, strict, 0, player), false);
eq("a failing condition rejects even a matching subject",
  rowApplies(clock, { ...strict, condition: "never" }, 0, enemy), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
