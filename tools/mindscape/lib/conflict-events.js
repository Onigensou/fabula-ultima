"use strict";
//
// Mindscape — conflict events.
//
// A scene-selected extra rule layered onto a normal conflict. Previously not
// modelled at all, which mattered for Valley of the Dragon specifically: the
// Lightning Storm is the intended feed for several monsters' passives, so a run
// without it evaluates a different monster than the one on the sheet.
//
// Spec: docs/lightning-storm-design.md (the ruling section is normative).
// Selected with `--conflict-event lightning-storm`; never auto-read from the
// scene, matching sim.run()'s explicit-only behaviour.

// ── Lightning Storm ─────────────────────────────────────────────────────────
// 1. At the beginning of combat, a random creature gains Lightning Rod.
// 2. At the start of a creature's turn, if it holds the Rod: 30 Bolt damage and
//    +30 MP.
// 3. Whenever a creature takes damage dealt by ANOTHER creature, it gains the Rod.
// 4. Singleton — a new holder replaces the previous one.
// 5. No holder at the start of a round → a random creature gains it.
//
// Exclusions that matter here: the Storm's own strike does NOT move the Rod
// (otherwise it self-refreshes and never leaves), and neither do DoT ticks —
// both share the `hazard` damage cause, so one filter excludes both.
const LIGHTNING_STORM = {
  id: "lightning-storm",
  label: "Lightning Storm",
  strikeDamage: 30,
  strikeElement: "bolt",
  strikeMp: 30,

  init(state) {
    state.rod = pickRandomLiving(state);
  },

  // Rule 5 — the round re-seed. This is what stops the party suppressing the
  // mechanic forever by only ever damaging already-acted monsters.
  onRoundStart(state) {
    if (!state.rod || !state.rod.alive) state.rod = pickRandomLiving(state);
  },

  // Rule 3. `cause` is "damage" for creature-inflicted, "hazard" for the strike
  // itself and for ticks — the latter must not move it.
  onDamage(state, victim, cause) {
    if (cause !== "damage") return;
    if (!victim?.alive) return;
    state.rod = victim;
  },

  // Rule 2. Returns a strike descriptor for the engine to resolve through the
  // normal incoming pipeline — the affinity read is the whole point, since an
  // absorbing holder is HEALED and hands its passives a bolt event anyway.
  onTurnStart(state, actor) {
    if (state.rod !== actor || !actor.alive) return null;
    return { damage: this.strikeDamage, element: this.strikeElement, mp: this.strikeMp };
  },
};

function pickRandomLiving(state) {
  const living = state.combatants.filter((c) => c.alive);
  if (!living.length) return null;
  return living[state.rng.int(0, living.length - 1)];
}

const EVENTS = Object.freeze({ "lightning-storm": LIGHTNING_STORM });

function resolveEvent(id) {
  if (!id) return null;
  const key = String(id).trim().toLowerCase();
  const ev = EVENTS[key];
  if (!ev) {
    const known = Object.keys(EVENTS).join(", ");
    throw new Error(`unknown conflict event "${id}" — known: ${known}`);
  }
  return ev;
}

module.exports = { EVENTS, resolveEvent, LIGHTNING_STORM };
