/**
 * Migration: 2026-11-28-deva-playtest-fixes  (user's manual playtest 2026-11-28, all four approved: "go ahead")
 * ---------------------------------------------------------------------------
 * 1. Bane stays strong against her single-target moves, but her big area moves are not Normal Attacks: Ground Slam,
 *    Fists of Fury and Fists of Focus get flags.notNormalAttack (actor-shape → action-profile reads the skill damage
 *    bucket, so Bane's damage_dealt_mult_attack no longer halves them; the card drops "Normal Attack"). Rahu's Eclipse
 *    was never an Attack.
 * 2. Missile Fist detonates on its FIRST turn (the round after the summon). Fuse ticks at each fist turn start and the
 *    Detonate pattern needed 2 stacks, so a fist hovered through the round the party braced for it and only blew the
 *    round after (probe: summoned r5, hovered r6, detonated r7). Detonate pattern effect_stacks 2 → 1.
 * 3. The summoned fists spawn hidden (mf_summon summon_hidden) and appear when the summon cinematic ends; they no
 *    longer pop in at their spots before the cinematic flies them there.
 * 4. Fist break cinematic (Fuse fu_break, move-engine "brk"): shows the hit the fist already took (cracks + dim)
 *    before the final hit and the shatter, as the mockup does. Script from _deva-anims.js.
 * Texts: Missile Fist "on its second turn" → "on its first turn"; Fuse "breaks after three hits" → "two hits";
 * Fists of Fury sheet entry Physical → Light (its damage has been Light since tuning round 2).
 * Every copy (world actors, unlinked tokens). Idempotent.
 */
import * as S from "./_deva-anims.js";

export const key = "2026-11-28-deva-playtest-fixes";
export const description = "Deva: area moves not Normal Attacks (Bane), Missile Fist detonates on its first turn, hidden summon until the cinematic ends, fist break shows its cracks.";

const M = "fabula-ultima-companion";
const DEVA = "amxILxU7mqQ0jKhZ", FIST = "MsFistSummon0001";
const NOT_NORMAL = ["Ground Slam", "Fists of Fury", "Fists of Focus"];
const link = (uuid, label) => `<a class="content-link" data-uuid="${uuid}" data-id="${uuid.split(".").pop()}" data-type="Item" data-tooltip="Item"><strong>${label}</strong></a>`;
const PHYS = link("Item.XpKZuGo3VmT0TlTu", "Physical"), LIGHT = link("Item.IQaK3IzvfFp4I1xB", "Light");

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
      const upd = {}; const P = it.system?.props ?? {};
      // 1. not Normal Attacks
      if (NOT_NORMAL.includes(it.name) && it.getFlag(M, "notNormalAttack") !== true) upd[`flags.${M}.notNormalAttack`] = true;
      if (it.name === "Missile Fist") {
        // 3. hidden summon
        for (const [k, r] of Object.entries(P.effect_table ?? {})) if (r?.effect_label === "mf_summon" && r.summon_hidden !== true) upd[`system.props.effect_table.${k}.summon_hidden`] = true;
        // text: first turn
        const d = String(P.description ?? ""), d2 = d.replace("on its second turn", "on its first turn");
        if (d2 !== d) upd["system.props.description"] = d2;
      }
      if (it.name === "Fists of Fury" && String(P.description ?? "").includes(PHYS)) upd["system.props.description"] = String(P.description).split(PHYS).join(LIGHT);
      if (Object.keys(upd).length) { await it.update(upd); out.push(`~ ${who(a)} / ${it.name}: ${Object.keys(upd).map((x) => x.replace("system.props.", "").replace(`flags.${M}.`, "")).join(", ")}`); }
    }
    const fe = a.system?.props?.attack_list?.DvFistsOfFury001;
    if (fe && String(fe.attack_description ?? "").includes(PHYS)) { await a.update({ "system.props.attack_list.DvFistsOfFury001.attack_description": String(fe.attack_description).split(PHYS).join(LIGHT) }); out.push(`~ ${who(a)}: sheet entry Fists of Fury → Light`); }
  }
  for (const a of actorsNamed(/^missile fist$/i, FIST)) {
    // 2. Detonate on the first turn
    const P = a.system?.props ?? {};
    for (const [k, r] of Object.entries(P.action_pattern_table ?? {})) {
      if (r?.action_pattern_name === "Detonate" && r.action_pattern_condition === "effect_stacks" && String(r.action_pattern_value_1) !== "1") {
        await a.update({ [`system.props.action_pattern_table.${k}.action_pattern_value_1`]: "1" }); out.push(`~ ${who(a)}: Detonate at Fuse 1 (first turn)`);
      }
    }
    for (const it of a.items) {
      const upd = {}; const Q = it.system?.props ?? {};
      if (it.name === "Fuse") {
        const d = String(Q.description ?? ""), d2 = d.replace("It breaks after three hits.", "It breaks after two hits.");
        if (d2 !== d) upd["system.props.description"] = d2;
        // 4. the break cinematic
        if (String(Q.animation_script ?? "") !== S.F_BREAK_SCRIPT) upd["system.props.animation_script"] = S.F_BREAK_SCRIPT;
      }
      if (Object.keys(upd).length) { await it.update(upd); out.push(`~ ${who(a)} / ${it.name}: ${Object.keys(upd).map((x) => x.replace("system.props.", "")).join(", ")}`); }
    }
  }
  if (!out.length) out.push("= Deva playtest fixes already applied (or no Deva in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
