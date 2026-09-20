// Hilde-Fafnir — Scorched Claw gains a 50% Burn rider, and its base drops to pay
// for it. A DELTA on the live docs; run AFTER _hilde-rework-fillers.js.
// From tools/safe-edit; --apply to write.
//
// Base 52 -> 40. Measured against the NEUTRAL design point (120 max HP, DEF 14,
// her 2d12+8 enumerated exactly): the hit falls 84.6 -> 73.4 while Burn adds
// 16.8 expected, so the move lands at 90.2 — about +7% on today's 84.6. Burn is
// delayed over three of the victim's turns, cleansable, and inert against a Fire
// absorber, which is what that premium buys. Strict parity would have been 34.
//
// The rider is the shipped on-hit shape (Ampere's Bubble Beam, Mist Dragon's
// 50% Blind): a force-mode `creature_deals_damage` reaction whose apply_ae row
// carries `ae_chance_percent`, rolled INDEPENDENTLY per creature hit.
// `ae_duplicate_mode: "skip"` — a hit on someone already Burning does NOT
// refresh the counter (user's call; refreshing would make the Claw the dominant
// threat in a kit that already has Wyrmbreath and the Lance).
//
// Burn itself is the shared template: 3 charges, `lifetimeMode: "on_activation"`,
// ticking ceil(10% max HP) as FIRE at the VICTIM's turn start. Two consequences
// worth remembering: this party halves it (all Fire RS), and a tick that pushes
// someone into Crisis feeds Contempt — on the victim's turn, so outside the
// Culling window that mutes her own Zero Power.
const { getByKey } = require("../lib/db");
const { IDS, L } = require("./_fafnir-lib");
const { run } = require("./_fafnir-util");

const A = IDS.HF;
const CLAW_NAME = "Scorched Claw";
const CLAW_BASE = "40";
const BURN_CHANCE = "50";

const DESC_CLAW =
  `<p>Deal <strong>heavy</strong> ${L.fire}&nbsp;damage to one creature. ` +
  "Damage increases with the target's maximum Hit Points.</p>" +
  `<p><strong>${BURN_CHANCE}%</strong> chance to inflict ${L.burn}.</p>`;

run(async ({ changes }) => {
  const ik = (id) => `!actors.items!${A}.${id}`;
  const actor = await getByKey("actors", `!actors!${A}`);
  const claw = await getByKey("actors", ik(IDS.HF_CLAW));
  if (!actor || !claw) throw new Error("missing Hilde-Fafnir doc");
  const p = claw.system.props;
  if (p.name !== CLAW_NAME) throw new Error(`expected ${CLAW_NAME}, found "${p.name}" — run _hilde-rework-fillers.js first`);

  p.damage_bonus = CLAW_BASE;
  p.description = DESC_CLAW;
  // Row 0 (the max-HP rider) is left exactly as it is; this adds row 1 beside it.
  p.reaction_config_table = {
    ...p.reaction_config_table,
    "1": { $deleted: false, reaction_trigger: "creature_deals_damage", reaction_source: "self",
           reaction_source_skill: CLAW_NAME, reaction_passive_mode: "force",
           reaction_effect_ref: "sc_burn" },
  };
  p.effect_table = {
    ...p.effect_table,
    "1": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_burn",
           ae_template_ref: "Burn", target_ref: "hit_action_targets",
           ae_chance_percent: BURN_CHANCE, ae_duplicate_mode: "skip" },
  };
  changes.push([ik(IDS.HF_CLAW), claw, `${CLAW_NAME} — base ${CLAW_BASE}, ${BURN_CHANCE}% Burn on hit (skip if already Burning)`]);

  const al = actor.system.props.attack_list ?? {};
  if (al[IDS.HF_CLAW]) al[IDS.HF_CLAW] = { ...al[IDS.HF_CLAW], attack_description: DESC_CLAW };
  actor.system.props.attack_list = al;
  changes.push([`!actors!${A}`, actor, "actor — Scorched Claw sheet text"]);
}, "hilde-fafnir: Scorched Claw Burn rider", "actors");
