/**
 * Migration: 2026-11-28-deva-area-skills  (user 2026-11-28: "convert those to skill"; Crysta: "KO Numen is dismissed")
 * ---------------------------------------------------------------------------
 * 1. Ground Slam, Fists of Fury and Fists of Focus become Active skills with a check (the house pattern for a
 *    damaging move that is not an Attack: Volt Stinger, Immolate, Apex Arrow). Same check (MIG + DEX +6 vs DEF),
 *    same damage, element, keywords (Overflow, Chain 12), rows and animations; the action type is the label, so
 *    Bane's attacks-only halving no longer reads them. Replaces the notNormalAttack flag of
 *    2026-11-28-deva-playtest-fixes (flag removed here; the engine reader is gone). Sheet entries move from the
 *    Attacks list to the Active skills list.
 * 2. Crysta (Numen) is dismissed at 0 HP: token_option_persist off, so the defeat reactor removes her token like
 *    any defeated summon. Resummoning sets her HP fresh (Create Phantasm: Numen summon_overrides).
 * Every copy (world actors, unlinked tokens). Idempotent.
 */
export const key = "2026-11-28-deva-area-skills";
export const description = "Deva's Ground Slam / Fists of Fury / Fists of Focus are Active skills (not Attacks); Crysta is dismissed at 0 HP.";

const M = "fabula-ultima-companion";
const DEVA = "amxILxU7mqQ0jKhZ", CRYSTA = "ZPPCxB0eOJPulEHv";
const MOVES = { "Ground Slam": "DvGroundSlam0001", "Fists of Fury": "DvFistsOfFury001", "Fists of Focus": "DvFistsOfFocus01" };

function actorsNamed(re, id) {
  const out = []; for (const a of game.actors) if (a.id === id || re.test(a.name ?? "")) out.push(a);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor && re.test(t.actor.name ?? "")) out.push(t.actor);
  return out;
}
const who = (a) => `${a.name}${a.isToken ? " (token)" : ""}`;

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const a of actorsNamed(/^deva$/i, DEVA)) {
    for (const it of a.items) {
      if (!(it.name in MOVES)) continue;
      const P = it.system?.props ?? {}, upd = {};
      if (P.skill_type !== "Active") upd["system.props.skill_type"] = "Active";
      if (P.action_command) upd["system.props.action_command"] = "";
      if (it.getFlag(M, "notNormalAttack") !== undefined) upd[`flags.${M}.-=notNormalAttack`] = null;
      if (Object.keys(upd).length) { await it.update(upd); out.push(`~ ${who(a)} / ${it.name}: Active skill`); }
    }
    // sheet entries: Attacks list → Active skills list (same text and target)
    const props = a.system?.props ?? {}, supd = {};
    for (const [name, id] of Object.entries(MOVES)) {
      const at = props.attack_list?.[id];
      if (at) {
        if (!props.skill_active_list?.[id]) supd[`system.props.skill_active_list.${id}`] = { active_cost: "-", active_description: at.attack_description ?? "", active_duration: "Instantaneous",
          active_target: at.active_target ?? "All Enemies", id: "${item.id}", name, roll: "", uuid: at.uuid ?? `Actor.${a.id}.Item.${id}` };
        supd[`system.props.attack_list.-=${id}`] = null;
      }
    }
    if (Object.keys(supd).length) { await a.update(supd); out.push(`~ ${who(a)}: sheet entries moved to Active skills`); }
  }
  for (const a of actorsNamed(/^crysta$/i, CRYSTA)) {
    const v = a.system?.props?.token_option_persist;
    if (v === true || String(v) === "true") { await a.update({ "system.props.token_option_persist": false }); out.push(`~ ${who(a)}: dismissed at 0 HP (persist off)`); }
  }
  if (!out.length) out.push("= Deva area skills / Crysta dismissal already applied");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
