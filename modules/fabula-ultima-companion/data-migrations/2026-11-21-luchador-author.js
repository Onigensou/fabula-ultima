/**
 * Migration: 2026-11-21-luchador-author  (Luchador gacha equipment set)
 * ---------------------------------------------------------------------------
 * The three Luchador pieces (gloves / pant / mask) were text-only prototypes.
 * This makes them a real, automated set:
 *
 *   1. Balance + text: Luchador Gloves HR+15 → HR+9 (Rare budget, gacha gear);
 *      Luchador Pant priced (2200z); flavor lines; gameplay-only bullets.
 *      (Rarity → Rare already done by 2026-11-21-hako-ch4-content.)
 *   2. Automation (rule keys read by the engine — snapshot.js grapple section,
 *      skill-effects apply_ae, equipment-swap canEquip):
 *        Gloves  passive: Conquer 5 → Grappled; +5 vs a Grappled target.
 *                effect:  grapple_max 1 · equip_restrict no_shield
 *        Pant    passive: Grappled on you → Grappled on the grappler.
 *                effect:  grapple_escape_dl 13
 *        Mask    effect:  equip_restrict weapon_category:brawling ·
 *                         ignore_condition_immunity Grappled · DEF UP (+1 was inert)
 *        Set     "Luchador — Equipment Set": 2pc AE "Luchador: Ring Control"
 *                (grapple_max 3 + action lock-outs), 3pc skill Powerbomb.
 *   3. Break Free (Objective) reads GRAPPLE_ESCAPE_DL instead of a fixed 10.
 *   4. The pieces + the set doc move to ⚔️ Equipments/Set/Luchador.
 *
 * SEED-ONLY: new documents use fixed ids ("HkLu…") and are skipped when they
 * exist; edits to existing items are gated by the flag
 * `flags.fabula-ultima-companion.luchador`, so a re-run never re-applies and
 * hand edits made afterwards are kept.
 */

export const key = "2026-11-21-luchador-author";
export const description = "Luchador set: gloves retune + text, pant price, grapple automation (cap, escape DL, counter-grapple, immunity waiver, lock-outs), Powerbomb, Set/Luchador folder.";

const M = "fabula-ultima-companion";
const FLAG = "luchador";

// ── In-world ids ─────────────────────────────────────────────────────────────
const GLOVES = "r0dthPszZhHz2SVH";
const PANT = "e4fETqmxyFgqnGDO";
const MASK = "j66zqDzOEsqBntxo";
const SET_ROOT_FOLDER = "5KFkUixjqI5c6PpK";   // ⚔️ Equipments/Set
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";     // Razor Plume (Passive)
const SET_DONOR = "CQ6Pq61KaMixQAjw";         // Bloodied Chivalry — Equipment Set
const ACTIVE_DONOR = "iZByhhxBH5BNPj5z";      // Mistress' Mercy (set-granted active skill)
const DEF_UP_DONOR = "Li5RjJZdG2g7WFJ2";      // Guardian Emblem (accessory DEF UP)
const BREAK_FREE = "MV3cvmYEtB1N6TmA";        // Break Free (Objective)

const ID = {
  folder: "HkLuSetFolder001",
  glovesPsv: "HkLuGlovesPsv001", glovesAe: "HkLuGloveRules01",
  pantPsv: "HkLuPantPsv00001", pantAe: "HkLuPantRules001",
  maskAe: "HkLuMaskRules001", maskDef: "HkLuMaskDefUp001",
  setDef: "HkLuSetDef000001", setAe: "HkLuRingCtrlAE01", powerbomb: "HkLuPowerbomb001",
};
const SET_NAME = "Luchador";
const RING_CONTROL = "Luchador: Ring Control";

// Journal / element links (plain content-link, the house form in item text)
const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry">${label}</a>`;
const I = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item">${label}</a>`;
const GRAPPLED = J("FV8JefaHsehzgXR7", "Grappled");
const GRAPPLE = J("FV8JefaHsehzgXR7", "Grapple");
const CONQUER = J("Cz6U0ps98sYN8jMH", "Conquer 5");
const PHYSICAL = I("XpKZuGo3VmT0TlTu", "Physical");
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const flavor = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));
const rule = (key, value) => ({ key, mode: 0, priority: 20, value: String(value) });

// ── Text ─────────────────────────────────────────────────────────────────────
const TEXT = {
  gloves: ul(
    `${CONQUER}: inflicts ${GRAPPLED} on the target.`,
    `You deal <strong>5 bonus damage</strong> when you attack a ${GRAPPLED} target.`,
    "You cannot equip a <strong>Shield</strong>.",
  ),
  pant: ul(
    `Creatures you ${GRAPPLE} must beat <strong>DL 13</strong> to break free.`,
    `When a creature inflicts ${GRAPPLED} on you, you inflict ${GRAPPLED} on it.`,
  ),
  mask: ul(
    "You can only use <strong>Brawling</strong> weapons.",
    `You ignore the target's ${GRAPPLED} immunity.`,
  ),
  set: `<p><strong>【Set Bonus】</strong></p><p><strong>2-Piece</strong></p>` + ul(
    `You can ${GRAPPLE} up to <strong>3</strong> creatures.`,
    `You can't use the <strong>【Objective】</strong> and <strong>【Equipment】</strong> actions while you ${GRAPPLE} <strong>2</strong> or more creatures.`,
    `You can't use the <strong>【Inventory】</strong> and <strong>【Attack】</strong> actions while you ${GRAPPLE} <strong>3</strong> creatures.`,
  ) + `<hr><p><strong>3-Piece</strong></p>` + ul(
    `You may perform the skill 【💥<strong>@UUID[Item.${ID.powerbomb}]{Powerbomb}</strong>】`,
  ),
  powerbomb: `<p>Remove ${GRAPPLED} from every creature you ${GRAPPLE}, then deal <strong>50</strong> ${PHYSICAL} damage to each of them.</p>`,
};
const FLAVOR = {
  gloves: "Taped at the knuckles, stitched with stars. Once these grab you, the crowd is already counting to three.",
  pant: "Glittering tights cut for flying off the top rope. Nobody has ever wriggled out of them, and nobody has ever looked better trying.",
  mask: "Never take off the mask. Behind it is just some guy; in front of it is a legend.",
};

// ── Helpers (same shape as 2026-11-21-hako-ch4-content) ──────────────────────
const isDone = (doc) => !!doc?.getFlag?.(M, FLAG);
const mark = (doc, v = true) => doc.setFlag(M, FLAG, v);

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

function passiveData({ id, name, parent, effect_table, reaction_config_table, text }) {
  return cloneData(PASSIVE_SHELL, {
    id, name, container: parent,
    props: { effect_table, reaction_config_table, description: text, skill_description: text, isReaction: true, skill_type: "Passive", skill_target: "Self" },
  });
}

async function addEffects(item, effects, out) {
  const missing = effects.filter((e) => !item.effects.get(e._id));
  if (!missing.length) return;
  await item.createEmbeddedDocuments("ActiveEffect", missing, { keepId: true });
  out.push(`~ ${item.name}: +${missing.map((e) => e.name).join(", ")}`);
}

const ruleAe = (id, name, img, changes) => ({ _id: id, name, img, transfer: true, disabled: false, changes,
  flags: { [M]: { [FLAG]: "rules" } } });

// ── 1. Folder ────────────────────────────────────────────────────────────────
async function setFolder(out) {
  const existing = game.folders.get(ID.folder)
    ?? game.folders.find((f) => f.type === "Item" && f.name === SET_NAME && (f.folder?.id ?? f.folder) === SET_ROOT_FOLDER);
  if (existing) { out.push(`= folder Set/${SET_NAME} exists`); return existing; }
  if (!game.folders.get(SET_ROOT_FOLDER)) { out.push("! Set folder missing — pieces stay where they are"); return null; }
  const [f] = await Folder.createDocuments([{ _id: ID.folder, name: SET_NAME, type: "Item", folder: SET_ROOT_FOLDER, sorting: "a" }], { keepId: true });
  out.push(`+ folder Set/${SET_NAME}`);
  return f;
}

// ── 2. The set definition + Powerbomb ───────────────────────────────────────
async function authorSet(folder, out) {
  const ringControl = {
    _id: ID.setAe, name: RING_CONTROL, img: "icons/svg/net.svg", transfer: false, disabled: false,
    changes: [
      rule("grapple_max", 3),
      rule("disable_action_while_grappling", "2:Objective,Equipment"),
      rule("disable_action_while_grappling", "3:Item,Attack"),
    ],
    flags: { [M]: { [FLAG]: "ring-control" } },
  };
  await createIfMissing(cloneData(SET_DONOR, {
    id: ID.setDef, name: `${SET_NAME} — Equipment Set`, folder: folder?.id ?? null,
    props: { isSet: false, set_name: SET_NAME, set_bonus_table: table([
      { pieces: "2", bonus_label: "Grapple up to 3 (Objective/Equipment locked at 2, Inventory/Attack at 3)", bonus_ae_ref: RING_CONTROL, bonus_skill_ref: "" },
      { pieces: "3", bonus_label: "Powerbomb", bonus_ae_ref: "", bonus_skill_ref: "Powerbomb" },
    ]) },
    effects: [ringControl],
  }), out);

  await createIfMissing(cloneData(ACTIVE_DONOR, {
    id: ID.powerbomb, name: "Powerbomb", container: ID.setDef, img: "icons/svg/explosion.svg",
    props: {
      cost: "-", skill_type: "Active", skill_target: "Self", duration: "Instantaneous", isCheck: false, max_level: "1",
      availability_formula: "AE_COUNT_GRAPPLING > 0", availability_reason: "You are not grappling anyone",
      description: TEXT.powerbomb,
      on_activate_effect_ref: "pb_root",
      effect_table: table([
        { effect_kind: "chain", effect_label: "pb_root", chain_steps: "pb_pick, pb_release, pb_slam" },
        { effect_kind: "targeting", effect_label: "pb_pick", candidate_source: "grappled_by_self", mode: "all", auto_target: "skip", iteration_mode: "together" },
        { effect_kind: "break_free", effect_label: "pb_release", target_ref: "pb_pick" },
        { effect_kind: "deal_damage", effect_label: "pb_slam", damage_amount: "50", damage_element: "physical", damage_verbosity: "full", target_ref: "pb_pick" },
      ]),
    },
  }), out);
}

// ── 3. The pieces ────────────────────────────────────────────────────────────
async function updatePieces(folder, out) {
  const defUpSrc = game.items.get(DEF_UP_DONOR)?.effects.find((e) => e.name === "DEF UP");
  const specs = [
    { id: GLOVES, key: "gloves",
      props: { damage_bonus: "9", check_bonus: "0" },
      effects: [ruleAe(ID.glovesAe, "Luchador Gloves: Lock-Up", "icons/svg/net.svg", [rule("grapple_max", 1), rule("equip_restrict", "no_shield")])],
      passive: { id: ID.glovesPsv, name: "Luchador Gloves (Passive)",
        effect_table: table([
          { effect_kind: "apply_ae", effect_label: "lu_grab", ae_template_ref: "Grappled", ae_duplicate_mode: "skip", on_empty: "skip", target_ref: "trigger_subject" },
          { effect_kind: "adjust_damage", effect_label: "lu_bonus", damage_stage: "outgoing", damage_operation: "add", damage_amount: "5" },
        ]),
        reaction_config_table: table([
          { reaction_trigger: "creature_deals_damage", reaction_passive_mode: "on", reaction_source: "self", reaction_requires_weapon_used: true,
            condition_formula: "HIT_MARGIN >= 5 && DAMAGE_IS_HP == 1", reaction_effect_ref: "lu_grab" },
          { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "on", reaction_source: "self", reaction_requires_weapon_used: true,
            condition_formula: "TARGET_AE_COUNT_GRAPPLED > 0 && DAMAGE_IS_HP == 1", reaction_effect_ref: "lu_bonus" },
        ]) } },
    { id: PANT, key: "pant",
      props: { item_cost: "2200" },
      effects: [ruleAe(ID.pantAe, "Luchador Pant: Escape DL", "icons/svg/net.svg", [rule("grapple_escape_dl", 13)])],
      passive: { id: ID.pantPsv, name: "Luchador Pant (Passive)",
        effect_table: table([
          { effect_kind: "apply_ae", effect_label: "lp_counter", ae_template_ref: "Grappled", ae_duplicate_mode: "skip", on_empty: "skip", target_ref: "cause_actor" },
        ]),
        reaction_config_table: table([
          { reaction_trigger: "creature_status_applied", reaction_passive_mode: "on", reaction_source: "self", reaction_status_filter: "Grappled",
            condition_formula: "CAUSE_IS_SELF == 0", reaction_effect_ref: "lp_counter" },
        ]) } },
    { id: MASK, key: "mask",
      props: { item_def_bonus: "1" },
      effects: [
        ruleAe(ID.maskAe, "Luchador Mask: Brawler's Code", "icons/svg/mystery-man.svg", [rule("equip_restrict", "weapon_category:brawling"), rule("ignore_condition_immunity", "Grappled")]),
        ...(defUpSrc ? [{ ...defUpSrc.toObject(), _id: ID.maskDef, flags: { [M]: { [FLAG]: "def-up" } } }] : []),
      ] },
  ];
  for (const s of specs) {
    const item = game.items.get(s.id);
    if (!item) { out.push(`! ${s.key} (${s.id}) missing`); continue; }
    if (isDone(item)) { out.push(`= ${item.name} already authored`); continue; }
    await item.update({
      ...(folder ? { folder: folder.id } : {}),
      ...Object.fromEntries(Object.entries(s.props).map(([k, v]) => [`system.props.${k}`, v])),
      "system.props.isSet": true, "system.props.set_name": SET_NAME,
      "system.props.description": TEXT[s.key],
      "system.props.flavor_text": flavor(FLAVOR[s.key]),
      "system.props.set_description": TEXT.set,
    });
    await addEffects(item, s.effects, out);
    if (s.passive) await createIfMissing(passiveData({ ...s.passive, parent: item.id, text: TEXT[s.key] }), out);
    await mark(item);
    out.push(`~ ${item.name}`);
  }
}

// ── 4. Break Free reads the grappler's escape DL ────────────────────────────
async function breakFreeDl(out) {
  const bf = game.items.get(BREAK_FREE);
  if (!bf) { out.push("! Break Free missing"); return; }
  if (isDone(bf)) { out.push("= Break Free already reads the escape DL"); return; }
  const et = foundry.utils.deepClone(bf.system.props.effect_table ?? {});
  let n = 0;
  for (const r of Object.values(et)) {
    if (r?.effect_kind === "break_free" && /TOTAL\s*>=\s*10\b/.test(r.condition_formula ?? "")) { r.condition_formula = "TOTAL >= GRAPPLE_ESCAPE_DL"; n++; }
  }
  const desc = String(bf.system.props.description ?? "").replace("<strong>DL 10</strong>", "<strong>DL 10</strong> (or the escape DL of whoever holds you)");
  await bf.update({ "system.props.effect_table": et, "system.props.description": desc });
  await mark(bf);
  out.push(`~ Break Free: ${n} row(s) read GRAPPLE_ESCAPE_DL`);
}

// ── Entry ────────────────────────────────────────────────────────────────────
export async function migrate(game, log = () => {}) {
  const out = [];
  const folder = await setFolder(out);
  await authorSet(folder, out);
  await updatePieces(folder, out);
  await breakFreeDl(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
