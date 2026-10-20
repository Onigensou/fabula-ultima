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

// ── Lightning Crystal ───────────────────────────────────────────────────────
// docs/lightning-crystal-design.md (ruling 2026-10-10), the underground maps:
// 1. At the start of a conflict 0-2 crystals appear (25 / 50 / 25 %).
// 2. Each has its own countdown, rolled 6-9.
// 3. At the start of every turn (both sides, each activation) every countdown drops 1.
// 4. A crystal that takes damage gains time: <=24 +1, 25-49 +2, 50+ +3 (after affinity).
// 5. At zero it deals 20-30 Bolt to every creature (one roll), then shatters.
// No Lightning Rod down here. A crystal is a battlefield OBJECT: enemy side, no turns,
// indestructible, Bolt IM / Earth VU, immune to statuses, DEF/MDEF 6. Monsters never
// target it and it never keeps the enemy side alive. The party never aims at it either
// (the live sim's party brains ignore crystals too) — only "all enemies" actions hit it.
const LIGHTNING_CRYSTAL = {
  id: "lightning-crystal",
  label: "Lightning Crystal",
  noRod: true,

  init(state) {
    const roll = state.rng.int(1, 100);
    const count = roll <= 25 ? 0 : roll <= 75 ? 1 : 2;
    state.crystals = [];
    for (let i = 0; i < count; i++) {
      const c = state.eventApi.spawnObject(state, crystalModel(count > 1 ? `Lightning Crystal ${i + 1}` : "Lightning Crystal"));
      c.countdown = state.rng.int(6, 9);
      state.crystals.push(c);
    }
    if (count) state.log.push({ round: 0, actor: "Lightning Crystal", action: count > 1 ? `${count} Lightning Crystals appear` : "A Lightning Crystal appears", reaction: true, announce: true, crystals: state.crystals.map((c) => c.countdown) });
  },

  onTurnStart(state, actor, { granted = false } = {}) {
    if (granted || !state.crystals?.length) return null;
    for (const c of state.crystals.slice()) {
      if (!c.alive) continue;
      c.countdown -= 1;
      if (c.countdown <= 0) blast(state, c);
    }
    return null;
  },

  onDamage(state, victim, cause, amount) {
    if (!victim?.crystal || !victim.alive || !(amount > 0)) return;
    victim.countdown += amount >= 50 ? 3 : amount >= 25 ? 2 : 1;
  },
};

function blast(state, crystal) {
  const dmg = state.rng.int(20, 30);
  state.log.push({ round: state.round, actor: crystal.name, action: "Lightning Explosion", reaction: true, announce: true, blast: dmg });
  for (const c of state.combatants.slice()) {
    if (!c.alive || c === crystal || c.crystal) continue;
    state.eventApi.applyFlatDamage(state, crystal, c, dmg, "bolt", "Lightning Explosion", "damage");
  }
  crystal.alive = false;
  crystal.shattered = true;
  state.crystals = state.crystals.filter((x) => x !== crystal);
}

function crystalModel(name) {
  const NE = { physical: "NE", air: "NE", bolt: "IM", dark: "NE", earth: "VU", fire: "NE", ice: "NE", light: "NE", poison: "NE" };
  return {
    id: `object:${name}`, name, isNpc: true, rank: null, species: "Construct", level: 1,
    hp: { cur: 9999, max: 9999 }, mp: { cur: 0, max: 0 }, ip: { cur: 0, max: 0 },
    attributes: { dex: 6, ins: 6, mig: 6, wlp: 6 }, def: 6, mdef: 6,
    affinities: NE, efficiency: {}, statuses: {}, statusImmunities: { "*": true },
    weapon: { name: null, baseDamage: 0 }, checkMods: null, damageReduction: { flat: 0, percent: 0, byElement: {} },
    extraDamage: null, turnsPerRound: 0, items: [], itemIds: [], _rawProps: {},
    object: true,
  };
}

function pickRandomLiving(state) {
  const living = state.combatants.filter((c) => c.alive && !c.object);
  if (!living.length) return null;
  return living[state.rng.int(0, living.length - 1)];
}

const EVENTS = Object.freeze({ "lightning-storm": LIGHTNING_STORM, "lightning-crystal": LIGHTNING_CRYSTAL });

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

module.exports = { EVENTS, resolveEvent, LIGHTNING_STORM, LIGHTNING_CRYSTAL };
