/**
 * Migration: 2026-11-24-oathsworn-paladin-set  (Oathsworn Paladin gacha set)
 * ---------------------------------------------------------------------------
 * The three pieces (Paladin Armor / Royal Shield / Save the Queen) already
 * carry the set text, but no "Equipment Set" document existed, so the set
 * granted nothing. This builds the set exactly as its text reads:
 *
 *   2pc  Oath of Vigilance — Protect one more time per round.
 *        A second `protect` charge AE ("Oathsworn Vigil"), refilled at turn
 *        start and conflict start beside Protect's own. consume_charge takes
 *        from any matching AE and the cost walker sums them, so Protect itself
 *        is untouched.
 *   3pc  Unbroken Oath — while KO, spend 1 FP to Protect. Once per round.
 *        Its own creature_targeted_by_action row, ticked
 *        `reaction_works_while_ko` (the engine opt-in added in the same
 *        change), gated CUR_HP <= 0: pay 1 FP, then the same redirect Protect
 *        does. A KO'd creature skips its turns, so the limit is a per-round
 *        cap, not the turn-refilled charge.
 *
 * Both skills require owning Protect (HAS_SKILL_PROTECT), as the text says
 * "perform the skill Protect". Paladin Armor's free spell on Protect / Cover
 * was already automated (v1.0.568, transfer AE on the armor) and is unchanged.
 *
 * SEED-ONLY: fixed ids ("OsPal…"), skipped when they exist, so a re-run never
 * re-applies and later hand edits are kept.
 */

export const key = "2026-11-24-oathsworn-paladin-set";
export const description = "Oathsworn Paladin set: set definition + 2pc Oath of Vigilance (extra Protect per round) + 3pc Unbroken Oath (1 FP: Protect while KO).";

const M = "fabula-ultima-companion";
const FLAG = "oathswornPaladin";

const SET_NAME = "Oathsworn Paladin";
const SET_FOLDER = "lU1fGjiR2mTgyPzI";        // ⚔️ Equipments/Set/Oathsworn Paladin (the pieces)
const SET_DONOR = "CQ6Pq61KaMixQAjw";         // Bloodied Chivalry — Equipment Set
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";     // Razor Plume (Passive)
const PROTECT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/01_PLD/cover.png";

const ID = {
  setDef: "OsPalSetDef00001",
  vigil: "OsPalVigilSkl001", vigilAe: "OsPalVigilAE0001",
  oath: "OsPalOathSkl0001",
};
const VIGIL = "Oath of Vigilance";
const OATH = "Unbroken Oath";
const VIGIL_AE = "Oathsworn Vigil";

const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const PROTECT = `<strong>【💥Protect】</strong>`;
const TEXT = {
  vigil: `<p>You can use ${PROTECT} one more time per round.</p>`,
  oath: `<p>While KO, you can spend <strong>1 Fabula Point</strong> to use ${PROTECT}. Once per round.</p>`,
};

function cloneData(srcId, { id, name, container = null, folder, img, props = {}, effects } = {}) {
  const src = game.items.get(srcId);
  if (!src) throw new Error(`donor ${srcId} missing`);
  const d = src.toObject();
  d._id = id;
  d.name = name;
  if (img) d.img = img;
  if (folder !== undefined) d.folder = folder;
  d.system.container = container;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  if (img) d.system.props.img = img;
  if (effects !== undefined) d.effects = effects;
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

async function createIfMissing(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}

function passiveData({ id, name, effect_table, reaction_config_table, text, effects = [] }) {
  return cloneData(PASSIVE_SHELL, {
    id, name, container: ID.setDef, folder: SET_FOLDER, img: PROTECT_ICON, effects,
    props: { effect_table, reaction_config_table, description: text, skill_description: text,
      isReaction: true, skill_type: "Passive", skill_target: "Self", max_level: 1 },
  });
}

const selfTargeting = (label) => ({
  effect_label: label, effect_kind: "targeting", candidate_source: "self", mode: "exact", count: "1",
  exclude_self: false, auto_confirm_when_obvious: true, skip_when_passive: true, iteration_mode: "together",
});

// ── Set definition ──────────────────────────────────────────────────────────
async function authorSetDef(out) {
  if (!game.folders.get(SET_FOLDER)) out.push("! Oathsworn Paladin folder missing — set doc lands at root");
  await createIfMissing(cloneData(SET_DONOR, {
    id: ID.setDef, name: `${SET_NAME} — Equipment Set`, folder: game.folders.get(SET_FOLDER) ? SET_FOLDER : null,
    effects: [],
    props: { isSet: false, set_name: SET_NAME, set_bonus_table: table([
      { pieces: "2", bonus_label: "Protect one more time per round", bonus_ae_ref: "", bonus_skill_ref: VIGIL },
      { pieces: "3", bonus_label: "While KO: 1 FP → Protect (once per round)", bonus_ae_ref: "", bonus_skill_ref: OATH },
    ]) },
  }), out);
}

// ── 2pc: Oath of Vigilance ──────────────────────────────────────────────────
async function authorVigil(out) {
  const vigilAe = {
    _id: ID.vigilAe, name: VIGIL_AE, img: PROTECT_ICON, transfer: false, disabled: false, changes: [],
    statuses: ["fud-oathsworn-vigil"],
    description: `<p><em>${VIGIL_AE}:</em> One extra ${PROTECT} this round.</p>`,
    system: { tags: ["ready"] },
    flags: { [M]: { charges: 1, chargesMax: 1, chargeKey: "protect", lifetimeMode: "persistent_counter", [FLAG]: "vigil-ae" } },
  };
  const refill = (trigger) => ({
    reaction_trigger: trigger, reaction_source: trigger === "turn_start" ? "self" : "", reaction_passive_mode: "force",
    reaction_passive_target: "self", condition_formula: "HAS_SKILL_PROTECT == 1", reaction_effect_ref: "ov_refill",
  });
  await createIfMissing(passiveData({
    id: ID.vigil, name: VIGIL, text: TEXT.vigil, effects: [vigilAe],
    reaction_config_table: table([refill("turn_start"), refill("conflict_start")]),
    effect_table: table([
      { effect_label: "ov_refill", effect_kind: "apply_ae", ae_template_ref: VIGIL_AE, ae_duplicate_mode: "replace",
        target_ref: "ov_self", on_empty: "abort", count: "1" },
      selfTargeting("ov_self"),
    ]),
  }), out);
}

// ── 3pc: Unbroken Oath ──────────────────────────────────────────────────────
async function authorOath(out) {
  await createIfMissing(passiveData({
    id: ID.oath, name: OATH, text: TEXT.oath,
    reaction_config_table: table([
      { reaction_trigger: "creature_targeted_by_action", reaction_source: "ally", reaction_passive_mode: "ask",
        reaction_action_intent: "harmful", reaction_works_while_ko: true,
        reaction_max_per_round: "1", reaction_max_scope: "round",
        condition_formula: "CUR_HP <= 0 && HAS_SKILL_PROTECT == 1", reaction_effect_ref: "uo_react" },
    ]),
    effect_table: table([
      { effect_label: "uo_react", effect_kind: "chain", chain_steps: "uo_fp, uo_anim, uo_redirect" },
      { effect_label: "uo_fp", effect_kind: "consume_resource", consume_resource: "fp", consume_amount: "1",
        target_ref: "self", on_empty: "abort" },
      { effect_label: "uo_anim", effect_kind: "play_animation", action_ref: "Protect", target_ref: "trigger_subject" },
      { effect_label: "uo_redirect", effect_kind: "redirect_target", rebuild_card: true,
        target_ref: "uo_incoming", destination_ref: "uo_self", on_empty: "abort", count: "1" },
      selfTargeting("uo_self"),
      { effect_label: "uo_incoming", effect_kind: "targeting", candidate_source: "action_targets", mode: "exact",
        count: "1", exclude_self: true, auto_confirm_when_obvious: true, skip_when_passive: true, iteration_mode: "together" },
    ]),
  }), out);
}

// ── Entry ────────────────────────────────────────────────────────────────────
export async function migrate(game, log = () => {}) {
  const out = [];
  await authorSetDef(out);
  await authorVigil(out);
  await authorOath(out);
  // Anyone already wearing 2+ pieces gets the grants now, not on their next equip.
  const api = await import("../scripts/battle-director/set-bonus.js").catch(() => null);
  if (typeof api?.reconcileSetBonuses === "function") {
    for (const a of game.actors) {
      const wearing = a.items.some((i) => i.system?.props?.set_name === SET_NAME && i.system?.props?.isEquipped);
      if (!wearing) continue;
      try { await api.reconcileSetBonuses(a); out.push(`~ reconciled ${a.name}`); }
      catch (e) { out.push(`! reconcile ${a.name}: ${e?.message ?? e}`); }
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
