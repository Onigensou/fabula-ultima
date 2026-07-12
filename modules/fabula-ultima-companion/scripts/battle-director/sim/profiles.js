// Player Profiles — how each PC plays, for the automated playtest.
//
// A profile has two layers, because one alone can't express a real turn:
//
//   rows[]   — a rotation table, in the EXACT shape an NPC's `action_pattern_table`
//              uses. The brain injects these into ActionReader, so the party gets
//              the same engine the monsters do: cost feasibility, affinity-aware
//              targeting, anti-repeat, and debuff gating, all for free.
//
//   policy() — a code hook that runs FIRST and can pre-empt the rotation. The
//              table's conditions are all self-referential (own hp/mp/round/…);
//              there is no "an ally is hurt" condition, so healing — the single
//              most important thing a real party does — cannot be expressed as a
//              row at all. That lives here.
//
// STATUS: BASIC. These are first-draft rotations written from each PC's real kit,
// not from watching you play. They exist to make the sim's numbers mean something
// rather than to be correct. Treat every fight result as provisional until the
// profiles are tuned against how the party ACTUALLY plays.
//
// Known simplifications, all of which make the party read WEAKER than it is:
//   - no Fabula Point spends, no Opportunity picks (the sim declines those)
//   - no equipment swaps, no item/consumable use
//   - Blanche's Adoration-cost skills are not cost-checked (feasibility only
//     parses MP/IP), so her rotation stays deliberately thin

// ── Tuning ──────────────────────────────────────────────────────────────────
// The judgement calls, in one place, so they can be moved from what the fights
// actually look like rather than from what anyone guessed up front. These are the
// numbers most likely to be wrong on the first pass — change them here.
export const TUNING = {
  // What counts as a hit worth spending a defensive reaction on: this fraction of
  // the target's MAX hp, or lethal.
  strongHitFraction: 0.30,
  // What counts as "she can take it": at most this fraction of HER max hp.
  safeDamageFraction: 0.10,
  // Blanche's Protect, per round.
  protectPerRound: 1,
  // Hina only bothers redirecting an action onto herself if it hits this many.
  propheticMinTargets: 2,

  // Hina's heal is a LAST RESORT (user's spec): she stays on the offensive unless
  // an ally is genuinely about to die AND the party's defensive answer (Blanche's
  // Protect) is already spent this round.
  healKoRiskFraction: 0.30,   // an ally at/below this much max hp could be KO'd
  healWorthItFraction: 0.60,  // "hurt enough to be worth a heal slot"
  healMinTargets: 2,          // wait for this many hurt allies — Heal covers 3
  healEmergencyFraction: 0.15, // …unless someone is THIS low, then go now
  healMaxTargets: 3,          // Heal's own cap ("Up to three creatures")
};

// Build one pattern row in the raw shape readPatternTable expects
// ({ rowKey, rowIndex, data }), keyed by the action_pattern_* props.
export function row(i, { name, cond = "always", v1 = 0, v2 = 0, str = "", prio = 10, focus = "", cd = 0 }) {
  return {
    rowKey: `sim-${i}`,
    rowIndex: i,
    data: {
      action_pattern_name: name,
      action_pattern_condition: cond,
      action_pattern_value_1: v1,
      action_pattern_value_2: v2,
      action_pattern_string: str,
      action_pattern_priority: prio,
      action_pattern_target_focus: focus,
      action_pattern_cooldown: cd,
      $deleted: false,
    },
  };
}

// ── Policy helpers ──────────────────────────────────────────────────────────
export const pct = (cur, max) => {
  const c = Number(cur), m = Number(max);
  if (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) return 1;
  return c / m;
};

const propNum = (actor, key) => Number(actor?.system?.props?.[key]);

// The most-hurt living ally (including self), as { dc, frac } — or null.
function weakestAlly(api) {
  const allies = api.allies();
  if (!allies.length) return null;
  const scored = allies.map((dc) => ({
    dc,
    frac: pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")),
  }));
  scored.sort((a, b) => a.frac - b.frac);
  return scored[0];
}

// A simple heal: worst-off ally below `threshold`, pay, cast. Used by anyone whose
// heal is a straightforward "top someone up" (Blanche, Keren).
function healPolicy({ spellName, threshold = 0.45, mpCost = 10 }) {
  return (api) => {
    const worst = weakestAlly(api);
    if (!worst || worst.frac > threshold) return null;
    if (propNum(api.self, "current_mp") < mpCost) return null;
    const item = api.findItem(spellName);
    if (!item) return null;
    return api.castOn(item, [worst.dc]);
  };
}

// Hina's heal, which is a different animal (user's spec): a LAST RESORT, not a
// reflex. She stays on the offensive while the party still has a defensive answer,
// and when she does heal she tries to make the action pay for itself — Heal covers
// up to three creatures, so topping up one target is a wasted turn.
//
// The gate, in order:
//   1. Is anyone actually at risk of dying?            (else stay on offense)
//   2. Has Blanche already spent her Protect?          (else SHE handles it)
//   3. Is it worth the action yet — enough hurt allies to fill the cast —
//      unless somebody is critical, in which case go now and don't be clever.
function hinaHealPolicy(api) {
  const round = api.round;
  const allies = api.allies();
  if (!allies.length) return null;

  const hurt = allies
    .map((dc) => ({ dc, frac: pct(propNum(dc.actorDoc, "current_hp"), propNum(dc.actorDoc, "max_hp")) }))
    .filter((a) => a.frac < TUNING.healWorthItFraction)
    .sort((a, b) => a.frac - b.frac);

  if (!hurt.length) return null;

  const atRisk = hurt.filter((a) => a.frac <= TUNING.healKoRiskFraction);
  const critical = hurt.some((a) => a.frac <= TUNING.healEmergencyFraction);

  // 1. Nobody is close to dying → keep casting Ice.
  if (!atRisk.length && !critical) return null;

  // 2. Blanche can still Protect → that is the party's answer to this, not a heal.
  //    Skipped when it is already an emergency: at that point nobody is being cute.
  if (!critical && !api.protectExhausted(round)) return null;

  // 3. Action economy: hold until the cast is worth its slot — unless critical.
  if (!critical && hurt.length < TUNING.healMinTargets) return null;

  const item = api.findItem("Heal");
  if (!item) return null;

  // "10 x T MP" — per target. Only bring as many targets as she can pay for.
  const mp = propNum(api.self, "current_mp");
  const affordable = Math.max(1, Math.floor(mp / 10));
  const targets = hurt.slice(0, Math.min(TUNING.healMaxTargets, affordable)).map((a) => a.dc);
  if (!targets.length || mp < 10) return null;

  return api.castOn(item, targets);
}

// Zarg's Gadgets (2 IP): a self-buff that loads his damage with a chosen element.
// The element is picked from a MENU that opens after the action is declared, so
// the choice can't live in a pattern row — the brain leaves a pick-hint and the
// list-picker consumes it (falling back to first-option if the menu doesn't have
// what we asked for). Without the hint the sim would blindly take option one,
// which for Gadgets is actively wrong.
//
// Only worth an action when there is a weakness to hit. If no enemy is VU to
// anything he carries, he skips it and shoots normally.
const ELEMENTS = ["air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];

function zargGadgetPolicy(api) {
  if (propNum(api.self, "current_ip") < 2) return null;

  const item = api.findItem("Gadgets");
  if (!item) return null;

  const foes = api.foes();
  if (!foes.length) return null;

  // Find the juiciest (foe, element) pair: something a living enemy is VU to.
  for (const foe of foes.slice().sort((a, b) =>
    pct(propNum(a.actorDoc, "current_hp"), propNum(a.actorDoc, "max_hp"))
    - pct(propNum(b.actorDoc, "current_hp"), propNum(b.actorDoc, "max_hp")))) {
    const weak = ELEMENTS.find((el) => api.affinityOf(foe, el) === "VU");
    if (!weak) continue;
    api.hintPick({ label: weak });   // answer the element menu before it opens
    return api.castOn(item, [foe]);
  }
  return null;   // nothing is weak to anything — just shoot
}

// ── The profiles ────────────────────────────────────────────────────────────
// Keyed by actor name (the clone's " [SIM]" suffix is stripped before lookup).
export const PROFILES = {
  // Ice mage / healer. The single biggest lesson of the first live run: she owns
  // Iceberg + Glacies and never cast them, while the Wandering Flame sat there
  // Ice-VULNERABLE. by_affinity targeting is the whole point of her rotation.
  // Ice caster. Offense is the DEFAULT — the heal is a last resort (see
  // hinaHealPolicy), and her big defensive contribution is Prophetic Defender,
  // which is a REACTION and lives in reaction-brain.js, not here.
  Hina: {
    label: "Hina — ice caster; heals only as a last resort",
    policy: hinaHealPolicy,
    rows: [
      row(0, { name: "Glacies", cond: "enemy_count", v1: 2, v2: 99, prio: 22, focus: "by_affinity" }),
      row(1, { name: "Iceberg", cond: "mp", v1: 20, v2: 100, prio: 20, focus: "by_affinity" }),
      row(2, { name: "Drain Spirit", cond: "mp", v1: 0, v2: 15, prio: 8, focus: "auto" }),
    ],
  },

  // Archer. Gadgets loads his shot with an element the enemy is WEAK to — a plain
  // rotation row can't do that, because the element is a menu choice made after
  // the action is declared, so it needs the pick-hint (see zargGadgetPolicy).
  // Barrage grants a free Attack, which the brain now actually spends.
  Zarg: {
    label: "Zarg — archer; exploits elemental weakness via Gadgets",
    policy: zargGadgetPolicy,
    rows: [
      row(0, { name: "High Speed", cond: "round", v1: 1, v2: 2, prio: 18, cd: 4 }),
      row(1, { name: "Barrage", cond: "mp", v1: 15, v2: 100, prio: 16, focus: "lowest_hp" }),
    ],
  },

  // Phantasm controller.
  //
  // Detonate Phantasm needs a PHANTASM ON THE FIELD — a precondition that exists
  // nowhere on the item, so neither ActionReader nor any row condition can see
  // it. Declared without one, the FSM bounces back to DECLARE and a deterministic
  // brain re-picks it forever; that is exactly what parked our first profiled
  // run. The re-declare guard now catches this class of thing generically, but
  // guessing wrong still burns a turn — so gate it properly here, in the policy
  // layer, which is the one place that can look at the actual board.
  //
  // Create Phantasm: Strike is free, so it is the floor.
  // She ALTERNATES: conjure a phantasm, then blow it up. Detonate needs one on the
  // field — a precondition that exists nowhere on the item, so only the policy
  // layer (which can see the board) can gate it. Her damage riders — Thermokinesis
  // and For Whom the Bell Tolls — are REACTIONS on her own action card and live in
  // reaction-brain.js; they fire when the target won't shrug the damage off.
  Keren: {
    label: "Keren — alternates Create ↔ Detonate Phantasm",
    policy: (api) => {
      const heal = healPolicy({ spellName: "Life Transference", threshold: 0.3, mpCost: 20 })(api);
      if (heal) return heal;

      const hasPhantasm = api.allies().some((dc) => /phantasm|numen/i.test(dc.name ?? ""));
      if (!hasPhantasm) return null;   // nothing to detonate → rotation conjures one

      const spell = api.findItem("Detonate Phantasm");
      if (!spell || propNum(api.self, "current_mp") < 20) return null;

      const foes = api.foes();
      if (!foes.length) return null;
      // Detonate is VAR_ELEMENT, so aim it at whoever is worst off rather than
      // trying to out-think an element we don't know yet.
      const target = foes.slice().sort((a, b) =>
        propNum(a.actorDoc, "current_hp") - propNum(b.actorDoc, "current_hp"))[0];
      return api.castOn(spell, [target]);
    },
    rows: [
      row(0, { name: "Create Phantasm: Strike", cond: "always", prio: 14, focus: "lowest_hp" }),
    ],
  },

  // Tank / support. Her damage skills cost Adoration, which the feasibility check
  // cannot see (it only parses MP/IP), so the rotation stays thin on purpose and
  // she leans on Heal + her weapon. Guarding is handled by the terminal fallback.
  Blanche: {
    label: "Blanche — tank, healing support",
    policy: healPolicy({ spellName: "Heal", threshold: 0.5, mpCost: 10 }),
    rows: [
      row(0, { name: "Muleta", cond: "always", prio: 12, focus: "lowest_hp" }),
    ],
  },
};

// Anything not named above: no rotation, no policy — the brain falls straight
// through to an affinity-aware basic attack. A sane floor for a guest or a PC
// nobody has written up yet.
export const GENERIC_PROFILE = { label: "generic — basic attacks only", policy: null, rows: [] };

export function profileFor(actorName) {
  const base = String(actorName ?? "").replace(/\s*\[SIM\]\s*$/i, "").trim();
  return PROFILES[base] ?? GENERIC_PROFILE;
}
