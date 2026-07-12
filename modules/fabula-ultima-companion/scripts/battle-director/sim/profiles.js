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

// A heal policy shared by everyone who can heal: if the worst-off ally is under
// `threshold` and we can pay, cast `spellName` on them. This is the behaviour the
// Phase-0 brain lacked entirely, and it is most of the difference between a party
// that folds and a party that holds.
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

// ── The profiles ────────────────────────────────────────────────────────────
// Keyed by actor name (the clone's " [SIM]" suffix is stripped before lookup).
export const PROFILES = {
  // Ice mage / healer. The single biggest lesson of the first live run: she owns
  // Iceberg + Glacies and never cast them, while the Wandering Flame sat there
  // Ice-VULNERABLE. by_affinity targeting is the whole point of her rotation.
  Hina: {
    label: "Hina — ice caster / backup healer",
    policy: healPolicy({ spellName: "Heal", threshold: 0.45, mpCost: 10 }),
    rows: [
      row(0, { name: "Glacies", cond: "enemy_count", v1: 2, v2: 99, prio: 22, focus: "by_affinity" }),
      row(1, { name: "Iceberg", cond: "mp", v1: 20, v2: 100, prio: 20, focus: "by_affinity" }),
      row(2, { name: "Drain Spirit", cond: "mp", v1: 0, v2: 15, prio: 8, focus: "auto" }),
    ],
  },

  // Archer. Barrage is the damage button; High Speed is a tempo buff worth one
  // early cast, hence the cooldown rather than a spam.
  Zarg: {
    label: "Zarg — archer, sustained damage",
    policy: null,
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
  Keren: {
    label: "Keren — phantasm damage",
    policy: (api) => {
      const heal = healPolicy({ spellName: "Life Transference", threshold: 0.3, mpCost: 20 })(api);
      if (heal) return heal;

      const hasPhantasm = api.allies().some((dc) => /phantasm|numen/i.test(dc.name ?? ""));
      if (!hasPhantasm) return null;   // nothing to detonate — fall through to the rotation

      const spell = api.findItem("Detonate Phantasm");
      if (!spell || Number(api.self?.system?.props?.current_mp) < 20) return null;
      const foes = api.foes();
      if (!foes.length) return null;
      return api.castOn(spell, [foes[0]]);
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
