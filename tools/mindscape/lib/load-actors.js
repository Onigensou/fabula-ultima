"use strict";
//
// Mindscape — offline actor loader.
//
// Reads combat-relevant actor state straight out of the world LevelDB with the
// game CLOSED, and flattens it into the model the Mindscape engine consumes.
// See docs/mindscape-ruleset.md — this file must not decide anything the spec
// does not state; it only reads.
//
// Reuses safe-edit's db.js rather than opening LevelDB again, so there is one
// reader, one set of path conventions, and `classic-level` resolves from
// safe-edit's own node_modules.
//
// ⚠ The game must be CLOSED. Foundry holds an exclusive lock on the collection;
// an open game makes this throw LEVEL_LOCKED rather than return stale data, so
// the failure is loud. That is deliberate — see [[reference_safe_edit]].

const { withCollection } = require("../../safe-edit/lib/db");
const { DEFAULT_WORLD } = require("../../safe-edit/lib/paths");

// Element → affinity_N prop key. Mirrors snapshot.js AFFINITY_KEY exactly; a
// drift here silently mis-reads every monster's weaknesses, so it is copied
// verbatim rather than re-derived.
const AFFINITY_KEY = Object.freeze({
  physical: "affinity_1",
  air:      "affinity_2",
  bolt:     "affinity_3",
  dark:     "affinity_4",
  earth:    "affinity_5",
  fire:     "affinity_6",
  ice:      "affinity_7",
  light:    "affinity_8",
  poison:   "affinity_9",
});

const ELEMENTS = Object.freeze(Object.keys(AFFINITY_KEY));

// Weapon families that carry an `<family>_ef` percent on a target sheet.
const WEAPON_FAMILIES = Object.freeze([
  "arcane", "bow", "brawling", "dagger", "firearm", "flail", "heavy",
  "spear", "sword", "thrown",
]);

function num(v, d = 0) {
  if (v == null) return d;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : d;
}

// Attribute die size. Stored as `<attr>_base` (verified against the live world:
// Hina reads dex_base 6 / ins_base 12 / mig_base 8 / wlp_base 10 at L41). The
// `_current` spelling does NOT exist on these sheets — status die-steps are
// carried by the `is<Status>` flags below and applied by the model, not baked
// into a second prop.
//
// Returns null rather than 0 when absent: a silent 0 makes a character roll d0
// and deal no damage, which reads as a balance result instead of a load failure.
function attrDie(props, key) {
  const base = num(props[`${key}_base`], 0);
  return base > 0 ? base : null;   // null = "not found", surfaced by validate()
}

// The six die-stepping statuses (project_fu_core_math). Each drops one attribute
// a step; different effects on the same attribute stack. Read as flags so the
// model applies the step itself — see docs/mindscape-ruleset.md Part 1.
const STATUS_STEPS = Object.freeze({
  isDazed:    ["ins"],
  isShaken:   ["wlp"],
  isSlow:     ["dex"],
  isWeak:     ["mig"],
  isEnraged:  ["dex", "ins"],
  isPoisoned: ["mig", "wlp"],
});

function readStatuses(props) {
  const out = {};
  for (const k of Object.keys(STATUS_STEPS)) out[k] = !!props[k];
  return out;
}

// DEF / MDEF. The sheet carries a resolved `defense` / `magic_defense` alongside
// base/bonus/override components. Prefer the resolved value and fall back through
// the components, so a sheet that stores only the parts still loads.
function readDefense(props, { magic = false } = {}) {
  const p = magic
    ? ["magic_defense", "override_magic_defense", "base_magic_defense"]
    : ["defense", "override_defense", "base_defense"];
  for (const k of p) {
    const v = num(props[k], 0);
    if (v > 0) return v;
  }
  return 0;
}

function readAffinities(props) {
  const out = {};
  for (const [element, key] of Object.entries(AFFINITY_KEY)) {
    const raw = String(props[key] ?? "").trim().toUpperCase();
    out[element] = ["VU", "RS", "IM", "AB"].includes(raw) ? raw : "NE";
  }
  return out;
}

function readEfficiency(props) {
  const out = {};
  for (const fam of WEAPON_FAMILIES) {
    const v = num(props[`${fam}_ef`], 100);
    out[fam] = v > 0 ? v : 100;
  }
  return out;
}

// PC vs NPC. CSB makes every actor Foundry type "character", so `type` cannot
// separate Hina from a Flame Drake. Test BOTH npc_rank AND species: the live
// world has NPCs with an empty rank carrying only a species (Cardinal Gora,
// Eisendrachian Knight, Roselie), and a rank-only check waves them through as
// player characters. NEVER hasPlayerOwner — ~150 actors report it.
// See [[reference_pc_npc_discriminator]].
function isNpc(props) {
  return !!(String(props.npc_rank ?? "").trim() || String(props.species ?? "").trim());
}

// Turns per round. Mirrors director-combat.js readBaseActivation/readActivations
// (lines 31-69) — the AUTHORITATIVE source is `props.activation` plus the
// `bonus_activation` accumulator, NOT the creature's rank.
//
// Deriving this from rank is wrong and provably so: Asura is rank "elite" and
// plays as a 4-activation solo boss. A rank-based rule reads it as 1 turn/round
// and under-rates the fight by a factor of four — the exact shape of error this
// whole tool exists to avoid.
//
// An explicit 0 is meaningful (an effect can zero a creature's turn), so only a
// blank/absent value falls through to the default of 1.
function turnsPerRound(props) {
  let base = 1;
  const raw = props.activation;
  if (raw != null) {
    const s = typeof raw === "number" ? String(raw) : String(raw).replace(/[^0-9.\-]/g, "");
    const n = Number(s);
    if (s !== "" && s !== "-" && s !== "." && Number.isFinite(n) && n >= 0) base = n;
  }
  const bonus = num(props.bonus_activation, 0);
  return Math.max(0, base + bonus);
}

// Flatten one raw actor document into the combat model.
function toCombatModel(doc) {
  const props = doc?.system?.props ?? {};
  const npc = isNpc(props);

  return {
    id: doc._id,
    name: doc.name,
    isNpc: npc,
    rank: String(props.npc_rank ?? "").trim() || null,
    species: String(props.species ?? "").trim() || null,
    level: num(props.level ?? props.current_level, 0),

    attributes: {
      dex: attrDie(props, "dex"),
      ins: attrDie(props, "ins"),
      mig: attrDie(props, "mig"),
      wlp: attrDie(props, "wlp"),
    },

    // max_* is STORED on both NPCs and current-template PCs. It is NOT derivable
    // from props alone — a PC's maximum folds in class-list benefits and
    // equipment that the CSB sheet computes but does not break out, so deriving
    // it undershoots badly (Hina: formula gives 81, sheet says 98). Read it;
    // never recompute it. `null` when the sheet predates the field, which
    // validate() reports rather than silently substituting.
    hp:  { cur: num(props.current_hp), max: props.max_hp == null ? null : num(props.max_hp) },
    mp:  { cur: num(props.current_mp), max: props.max_mp == null ? null : num(props.max_mp) },
    ip:  { cur: num(props.current_ip), max: props.max_ip == null ? null : num(props.max_ip) },
    zp:  num(props.zero_power_value),
    fabulaPoints: num(props.fabula_point),

    def:  readDefense(props),
    mdef: readDefense(props, { magic: true }),

    affinities:  readAffinities(props),
    efficiency:  readEfficiency(props),
    statuses:    readStatuses(props),

    // Weapon damage is per-weapon on the sheet, not one flat `damage_bonus`.
    weapon: {
      name:       String(props.main_hand ?? "").trim() || null,
      baseDamage: num(props.weapon1_base_damage),
      baseMod:    num(props.weapon1_base_mod),
      element:    String(props.weapon1_damagetype ?? "").trim() || null,
      attrA:      String(props.main_attrib_1 ?? "").trim() || null,
      attrB:      String(props.main_attrib_2 ?? "").trim() || null,
    },

    turnsPerRound: turnsPerRound(props),

    // Item names only at this stage. Resolving them into modelled actions is the
    // coverage manifest's job (see docs/mindscape-ruleset.md Part 7) and must
    // stay separate: the loader may not decide that an unrecognised skill is
    // absent, because that is exactly the silent approximation this tool exists
    // to refuse.
    items: (doc.items ?? []).map((i) => ({
      id: i._id,
      name: i.name,
      props: i.system?.props ?? {},
    })),

    _rawProps: props,
  };
}

// Every actor in the world, as combat models, keyed by name.
async function loadAll({ world = DEFAULT_WORLD } = {}) {
  return withCollection("actors", world, async (db) => {
    const out = [];
    for await (const [, value] of db.iterator()) {
      if (!value?.name) continue;
      out.push(toCombatModel(value));
    }
    return out;
  });
}

// Named actors only. Throws on a miss rather than returning a short list — a
// silently absent party member would just look like a weaker party, which is a
// plausible-looking wrong answer of exactly the kind this tool must not produce.
async function loadNamed(names, { world = DEFAULT_WORLD } = {}) {
  const all = await loadAll({ world });
  const byName = new Map(all.map((a) => [a.name.trim().toLowerCase(), a]));

  const found = [];
  const missing = [];
  for (const n of names) {
    const hit = byName.get(String(n).trim().toLowerCase());
    if (hit) found.push(hit); else missing.push(n);
  }
  if (missing.length) {
    throw new Error(`Mindscape: actor(s) not found in world "${world}": ${missing.join(", ")}`);
  }
  return found;
}

// Every party DB actor in the world, as { name, memberIds }.
//
// This world holds MORE THAN ONE — "EXFURSION Party" (Hina/Keren/Blanche/Zarg)
// and "Zenit Crisis Party" (RaiRai/Surtur/Varan/Moses) — because the campaign is
// multi-party ([[project_multiparty_randomized_runs]]). They sit at different
// levels AND on different sheet template versions, so picking the wrong one
// silently balances against the wrong roster with the wrong stats.
async function listParties({ world = DEFAULT_WORLD, _all = null } = {}) {
  const all = _all ?? await loadAll({ world });
  const byId = new Map(all.map((a) => [a.id, a]));

  return all
    .filter((a) => a._rawProps?.member_id_1)
    .map((db) => {
      const members = [];
      // Slot 1 stores a bare id while the others store full uuids — normalise both.
      for (let i = 1; i <= 8; i++) {
        const raw = String(db._rawProps[`member_id_${i}`] ?? "").trim();
        if (!raw) continue;
        const id = raw.includes(".") ? raw.split(".").pop() : raw;
        members.push({ id, actor: byId.get(id) ?? null });
      }
      return { name: db.name, members };
    });
}

// Resolve ONE named party. `partyName` is required and there is deliberately no
// default: an arbitrary pick is exactly how the first probe of this loader ended
// up reporting the wrong four characters at the wrong level as "the party", and
// every stat read off them looked plausible. Never guess which party is the one
// under test. NEVER hasPlayerOwner ([[feedback_players_means_party]]).
async function loadParty({ partyName, world = DEFAULT_WORLD } = {}) {
  const all = await loadAll({ world });
  const parties = await listParties({ world, _all: all });

  if (!partyName) {
    throw new Error(
      `Mindscape: partyName is required — this world has ${parties.length}: ` +
      parties.map((p) => `"${p.name}"`).join(", ")
    );
  }

  const want = String(partyName).trim().toLowerCase();
  const party = parties.find((p) => p.name.trim().toLowerCase() === want);
  if (!party) {
    throw new Error(
      `Mindscape: no party named "${partyName}". Available: ` +
      parties.map((p) => `"${p.name}"`).join(", ")
    );
  }

  const unresolved = party.members.filter((m) => !m.actor);
  if (unresolved.length) {
    throw new Error(
      `Mindscape: party "${party.name}" names ${party.members.length} member(s) but ` +
      `${unresolved.length} did not resolve (id: ${unresolved.map((m) => m.id).join(", ")})`
    );
  }
  return party.members.map((m) => m.actor);
}

// Structural check on a loaded model. Returns [] when sound. This is not a
// balance opinion — it only catches a model that could not fight at all, so a
// load failure can never be misread as a fight result.
function validate(actor) {
  const problems = [];
  for (const [k, v] of Object.entries(actor.attributes)) {
    if (v == null) problems.push(`${actor.name}: attribute "${k}_base" not found on the sheet`);
  }
  if (actor.hp.max == null) {
    // An older sheet template predates the stored maximum. Deriving one is NOT an
    // acceptable fallback — the formula undershoots by 17-60 HP on this party
    // because class-list and equipment bonuses are not in props. Refuse instead.
    problems.push(`${actor.name}: no stored max_hp — sheet template predates the field; cannot be derived`);
  } else if (!(actor.hp.max > 0)) {
    problems.push(`${actor.name}: max_hp is ${actor.hp.max}`);
  }
  if (!(actor.def > 0))  problems.push(`${actor.name}: defense is ${actor.def}`);
  if (!(actor.mdef > 0)) problems.push(`${actor.name}: magic_defense is ${actor.mdef}`);
  if (actor.turnsPerRound == null) {
    problems.push(`${actor.name}: champion rank with no declared turns/round — supply it per run`);
  }
  return problems;
}

module.exports = {
  AFFINITY_KEY, ELEMENTS, WEAPON_FAMILIES, STATUS_STEPS,
  loadAll, loadNamed, loadParty, listParties, validate, toCombatModel, isNpc,
};
