/**
 * Migration: 2026-11-28-deva-anims  (Deva's animations from the approved mockup, move-engine 1.3.0)
 * ---------------------------------------------------------------------------
 * The approved Deva mockup (page deva-anim v20, artifact C7wZxC2jSAo15AAsJfQxRb, all 15 moves approved 2026-11-28) runs in
 * the game through tools/move-engine: the SAME move files the page runs (moves/deva/{head,deva}.js).
 *
 * Deva (amxILxU7mqQ0jKhZ):
 *   - turn actions (timing default, the gate = the move's first number / Fury's Chain cues / Focus's final impact):
 *     Vajra Fist, Mudra Lance, Double Slap, Ground Slam, Surya Palm, Rahu's Eclipse, Kala Strike, Fists of Fury,
 *     Fists of Focus (replaces the v1.0.575 barrage scripts).
 *   - Missile Fist + Enlightenment: timing "resolve" and a play_animation row in their chain, because RESOLVE decides what
 *     they show (the summoned fists = the animation's targets; the form swap). Missile Fist plays after the summon,
 *     Enlightenment before its form clear (she starts in the form she holds).
 *   - Celestial Discipline carries Stance Change + Form Change (#stance_maya / #stance_vajra / #form_fury / #form_focus):
 *     Guard round: plays only when the drawn stance differs from the last Guard round's (memory AE "Last Stance Maya",
 *     hidden); Offense round: plays before the form AE lands (she starts in her Standard art).
 * Missile Fist (MsFistSummon0001):
 *   - Detonate: timing "resolve", plays first in its chain with the random victim as target (then the hit, then it goes).
 *   - Fuse: a creature_defeated row (self only) plays the break (the third hit cracks it, it shatters); defeat style
 *     "consumed" so no second death effect follows.
 *   - the approved token art (Beastiary/Deva/Missile_Fist.png: fist_red turned to point at the party, stored pointing LEFT
 *     because Battle Director mirrors enemy tokens) + the float idle.
 * Every copy: world items, actor items and unlinked-token copies. A script field is only written when empty, or when it
 * holds an older Deva move-engine script or the v1.0.575 barrage. Idempotent.
 */
import * as S from "./_deva-anims.js";

export const key = "2026-11-28-deva-anims";
export const description = "Deva's 15 approved mockup animations through move-engine 1.3.0, with the chain rows, stance memory and Missile Fist art they need.";

const M = "fabula-ultima-companion";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const FIST_ART = FORGE + "Beastiary/Deva/Missile_Fist.png";

// item id → [script, timing]; matched by id, or by name on a Deva / Missile Fist copy
const ITEMS = {
  DvVajraFist00001: ["Vajra Fist", S.VAJRA_SCRIPT, "default"],
  DvMudraLance0001: ["Mudra Lance", S.LANCE_SCRIPT, "default"],
  DvDoubleSlap0001: ["Double Slap", S.SLAP_SCRIPT, "default"],
  DvGroundSlam0001: ["Ground Slam", S.SLAM_SCRIPT, "default"],
  DvSuryaPalm00001: ["Surya Palm", S.SURYA_SCRIPT, "default"],
  DvRahuEclipse001: ["Rahu's Eclipse", S.RAHU_SCRIPT, "default"],
  DvKalaStrike0001: ["Kala Strike", S.KALA_SCRIPT, "default"],
  DvFistsOfFury001: ["Fists of Fury", S.FURY_SCRIPT, "default"],
  DvFistsOfFocus01: ["Fists of Focus", S.FOCUS_SCRIPT, "default"],
  DvEnlighten00001: ["Enlightenment", S.ENL_SCRIPT, "resolve"],
  DvMissileFist001: ["Missile Fist", S.MFIST_SCRIPT, "resolve"],
  DvDisciplineP001: ["Celestial Discipline", S.DISC_SCRIPT, null],
  MsFistDetonate01: ["Detonate", S.F_BOOM_SCRIPT, "resolve"],
  MsFistFuseClock1: ["Fuse", S.F_BREAK_SCRIPT, null],
};
const BY_NAME = { deva: Object.keys(ITEMS).filter((id) => id.startsWith("Dv")), fist: Object.keys(ITEMS).filter((id) => id.startsWith("Ms")) };

// table edits per item: chain steps to insert (after / before a step) and rows to add (by effect_label)
const row = (label, kind, extra) => ({ $deleted: false, effect_kind: kind, effect_label: label, ...extra });
const play = (label, ref, target = "self", extra = {}) => row(label, "play_animation", { action_ref: ref, target_ref: target, on_condition_fail: "skip", ...extra });
const EDITS = {
  DvDisciplineP001: {
    rows: [
      play("g_anim_m", "Celestial Discipline#stance_maya", "self", { condition_formula: "AE_COUNT_MAYA_STANCE > 0 && AE_COUNT_LAST_STANCE_MAYA == 0" }),
      play("g_anim_v", "Celestial Discipline#stance_vajra", "self", { condition_formula: "AE_COUNT_VAJRA_STANCE > 0 && AE_COUNT_LAST_STANCE_MAYA > 0" }),
      row("g_mem_m", "apply_ae", { ae_template_ref: "Last Stance Maya", target_ref: "self", ae_duplicate_mode: "skip", condition_formula: "AE_COUNT_MAYA_STANCE > 0", on_condition_fail: "skip" }),
      row("g_mem_v", "remove_ae", { ae_template_ref: "Last Stance Maya", target_ref: "self", include_persistent: "true", count: "all", condition_formula: "AE_COUNT_VAJRA_STANCE > 0", on_condition_fail: "skip" }),
      play("s_anim", "Celestial Discipline#form_fury"),
      play("m_anim", "Celestial Discipline#form_focus"),
    ],
    chains: {
      guard: { after: "g_stance", add: ["g_anim_m", "g_anim_v", "g_mem_m", "g_mem_v"] },
      guard_nf: { after: "g_stance", add: ["g_anim_m", "g_anim_v", "g_mem_m", "g_mem_v"] },
      to_strike: { before: "s_form", add: ["s_anim"] },
      to_magic: { before: "m_form", add: ["m_anim"] },
    },
    aes: [{ _id: "DvAeLastMaya0001", name: "Last Stance Maya", img: null, transfer: false, disabled: false, changes: [], statuses: [], description: "",
      duration: {}, origin: "Actor.amxILxU7mqQ0jKhZ.Item.DvDisciplineP001", system: { tags: ["deva_memory"] },
      flags: { [M]: { crossScene: false, charges: 1, lifetimeMode: "persistent_counter", hidden: true } } }],
  },
  DvMissileFist001: { rows: [play("mf_anim", "Missile Fist", "mf_summon")], chains: { mf_chain: { after: "mf_summon", add: ["mf_anim"] } } },
  DvEnlighten00001: { rows: [play("en_anim", "Enlightenment")], chains: { en_chain: { before: "en_clear", add: ["en_anim"] } } },
  MsFistDetonate01: { rows: [play("fd_anim", "Detonate", "fd_victim")], chains: { fd_chain: { before: "fd_hit", add: ["fd_anim"] } } },
  MsFistFuseClock1: { rows: [play("fu_break", "Fuse")],
    reactions: [{ $deleted: false, reaction_trigger: "creature_defeated", reaction_source: "self", reaction_isPassive: true, reaction_passive_mode: "force",
      reaction_effect_ref: "fu_break", reaction_cause_filter: "", reaction_resource_filter: "", condition_formula: "SUBJECT_IS_SELF == 1" }] },
};

function allItems() {
  const items = [...game.items];
  for (const a of game.actors) items.push(...a.items);
  for (const s of game.scenes) for (const t of s.tokens) if (!t.actorLink && t.actor) items.push(...t.actor.items);
  return items;
}
function idFor(it) {
  if (ITEMS[it.id]) return it.id;
  const owner = it.parent?.name ?? "";
  const pool = /^deva$/i.test(owner) ? BY_NAME.deva : /^missile fist$/i.test(owner) ? BY_NAME.fist : [];
  return pool.find((id) => ITEMS[id][0] === it.name) ?? null;
}
// empty, an older Deva move-engine build, or the v1.0.575 barrage (tools/anim-studio deva-shots)
export const replaceable = (s) => { const t = String(s ?? "").replace(/<[^>]*>/g, "").trim();
  return !t || /move-engine "(vajra|lance|slap|slam|surya|rahu|kala|fury|focus|enl|fist|boom|brk|stance)"/.test(t) || /Fists of (Fury|Focus)|fists-barrage|deva-shots/.test(t.slice(0, 4000)); };

const tableOf = (v) => (v && typeof v === "object" ? v : {});
function editTable(tbl, edit) {
  const out = {}; let changed = false; const rows = Object.values(tbl);
  // chains
  for (const [k, r] of Object.entries(tbl)) {
    const c = edit.chains && r && r.effect_kind === "chain" && edit.chains[r.effect_label];
    if (!c) continue; const steps = String(r.chain_steps || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (c.add.every((a) => steps.includes(a))) continue;
    const at = steps.indexOf(c.after || c.before); if (at < 0) continue;
    const ins = c.add.filter((a) => !steps.includes(a)); steps.splice(c.after ? at + 1 : at, 0, ...ins);
    out[k] = { ...r, chain_steps: steps.join(",") }; changed = true;
  }
  // rows
  let n = Object.keys(tbl).reduce((m, k) => Math.max(m, Number(k) + 1 || 0), 0);
  for (const r of edit.rows || []) if (!rows.some((x) => x && x.effect_label === r.effect_label)) { out[String(n++)] = r; changed = true; }
  return changed ? out : null;
}
function editReactions(tbl, edit) {
  if (!edit.reactions) return null; const out = {}; let changed = false;
  let n = Object.keys(tbl).reduce((m, k) => Math.max(m, Number(k) + 1 || 0), 0);
  for (const r of edit.reactions) if (!Object.values(tbl).some((x) => x && x.reaction_trigger === r.reaction_trigger && x.reaction_effect_ref === r.reaction_effect_ref)) { out[String(n++)] = r; changed = true; }
  return changed ? out : null;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const it of allItems()) {
    const id = idFor(it); if (!id) continue;
    const [, script, timing] = ITEMS[id];
    const where = `${it.parent ? `${it.parent.name} / ` : ""}${it.name} (${it.id})`;
    const props = it.system?.props ?? {};
    const upd = {};
    const cur = props.animation_script;
    if (!(cur === script && it.getFlag?.(M, "moveEngine") === S.ENGINE_VERSION)) {
      if (replaceable(cur)) { upd["system.props.animation_script"] = script; upd[`flags.${M}.moveEngine`] = S.ENGINE_VERSION; }
      else out.push(`= ${where} has its own script — left`);
    }
    if (timing && props.animation_damage_timing_options !== timing) upd["system.props.animation_damage_timing_options"] = timing;
    if (timing && String(props.animation_damage_timing_offset ?? "0") !== "0") upd["system.props.animation_damage_timing_offset"] = "0";
    const edit = EDITS[id];
    if (edit) {
      const e = editTable(tableOf(props.effect_table), edit); if (e) for (const [k, r] of Object.entries(e)) upd[`system.props.effect_table.${k}`] = r;
      const r = editReactions(tableOf(props.reaction_config_table), edit); if (r) for (const [k, v] of Object.entries(r)) upd[`system.props.reaction_config_table.${k}`] = v;
    }
    if (Object.keys(upd).length) { await it.update(upd); out.push(`~ ${where}: ${Object.keys(upd).map((k) => k.replace("system.props.", "")).join(", ")}`); }
    // the stance memory AE (a template on Celestial Discipline, like its other markers)
    for (const ae of (edit && edit.aes) || []) {
      if (it.effects?.some((e) => e.name === ae.name)) continue;
      await it.createEmbeddedDocuments("ActiveEffect", [{ ...ae, origin: it.parent ? `Actor.${it.parent.id}.Item.${it.id}` : ae.origin }], { keepId: true });
      out.push(`+ ${where}: AE ${ae.name}`);
    }
  }
  // the Missile Fist actor: approved art, float idle, no second death effect after its own shatter
  for (const a of game.actors) {
    if (a.id !== "MsFistSummon0001" && !/^missile fist$/i.test(a.name ?? "")) continue;
    const upd = {};
    if (a.img !== FIST_ART) upd.img = FIST_ART;
    if (a.prototypeToken?.texture?.src !== FIST_ART) upd["prototypeToken.texture.src"] = FIST_ART;
    if (a.system?.props && a.system.props.sprite_battle !== FIST_ART) upd["system.props.sprite_battle"] = FIST_ART;
    if (a.getFlag(M, "defeatStyle") !== "consumed") upd[`flags.${M}.defeatStyle`] = "consumed";
    if (!a.getFlag(M, "idleAnimation")?.float) upd[`flags.${M}.idleAnimation`] = { ...(a.getFlag(M, "idleAnimation") ?? {}), float: true };
    if (Object.keys(upd).length) { await a.update(upd); out.push(`~ ${a.name} (${a.id}): ${Object.keys(upd).join(", ")}`); }
  }
  if (!out.length) out.push("= Deva animations already set (or no Deva in the world)");
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
