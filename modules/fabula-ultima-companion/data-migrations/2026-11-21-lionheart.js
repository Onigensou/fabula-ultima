/**
 * Migration: 2026-11-21-lionheart  (Lionheart rework: two-form gunblade + Renzokuken)
 * ---------------------------------------------------------------------------
 * User-approved design 2026-11-21 (mockup E:\Art(New Com)\DND\Fabula Ultima\
 * Resource\Animation\Lionheart\lionheart-mockup.html v4; accuracy pairs changed
 * by the user the same day: Sword MIG+WLP, Gun DEX+INS+1).
 *
 *   Lionheart — Legendary, transforming (free once per round via the Equipment
 *   action's form chips; engine: weapon forms in equipment-swap.js / snapshot.js).
 *     Form I  · Sword: 2H, Melee, MIG + WLP, HR + 10 Physical. Renzokuken.
 *     Form II · Gun:   2H, Ranged, DEX + INS + 1, HR + 5 Physical. Entering Gun
 *                      form: +1 Cartridge (max 1) and 15 Shield (set_resource:
 *                      Shields keep the bigger value, they do not stack).
 *     The old "odd accuracy / crit → Vulnerable + Fire" rule and the Gun form's
 *     +1 DEF/M.DEF are gone.
 *   Cartridge — persistent counter (max 1), conflict-scoped; set to 1 at every
 *   conflict start by the weapon's passive.
 *   Renzokuken (Sword form only) — 30 MP + 1 Cartridge, no accuracy roll, six
 *   strikes on one creature through the `timed_strikes` effect kind (gauge per
 *   strike, ×0.55 on TRIGGER / ×0.20 otherwise, Lion Heart ×1.2 on 6/6).
 *
 * The forms live in the item flag `weaponForms` (the form the engine reads when
 * the item has no `weapon_forms` prop — same as Zarg's Bow). Index 0 = base =
 * the item's own props, so the base props ARE Form I.
 *
 * Hako's shop copy (restocked by 2026-11-21-hako-ch4-content, which runs first)
 * and any other actor copy get the same props, forms and contained items.
 *
 * SEED-ONLY: new documents use fixed ids ("LhRz…") and are skipped when they
 * exist; edits to existing items are gated by `flags.fabula-ultima-companion.lionheart`.
 */

export const key = "2026-11-21-lionheart";
export const description = "Lionheart: two-form gunblade (Sword MIG+WLP / Gun DEX+INS+1), Cartridge counter, Renzokuken timed strikes.";

const M = "fabula-ultima-companion";
const FLAG = "lionheart";

const LIONHEART = "GNQXRnV6t7CR9hZ5";
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";   // Razor Plume (Passive)
const SKILL_DONOR = "6nMEO6F1qogSymUQ";     // Judgement Sword (Excalibur's active, no check)
const ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/Image/Lionheart.webp";

const ID = {
  renzokuken: "LhRzRenzokuken01",
  passive: "LhRzLionheartPsv",
  cartridge: "LhRzCartridgeAE1",
};

const J = (id, label) => `<a class="content-link" data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry">${label}</a>`;
const I = (id, label) => `<a class="content-link" data-uuid="Item.${id}" data-id="${id}" data-type="Item">${label}</a>`;
const SHIELD = J("wrw2ENSwzCBjztvt", "Shield");
const PHYSICAL = I("XpKZuGo3VmT0TlTu", "Physical");
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

// ── The forms ────────────────────────────────────────────────────────────────
const FORMS = [
  { label: "Sword", weapon_type: "Sword", type_damage: "Physical", rolled_atr1: "MIG", rolled_atr2: "WLP", check_bonus: 0, damage_bonus: 10, weapon_range: "Melee" },
  { label: "Gun", weapon_type: "Firearm", type_damage: "Physical", rolled_atr1: "DEX", rolled_atr2: "INS", check_bonus: 1, damage_bonus: 5, weapon_range: "Ranged" },
];

// ── Text ─────────────────────────────────────────────────────────────────────
const RENZOKUKEN_LINK = `【⚔<strong>@UUID[Item.${ID.renzokuken}]{Renzokuken}</strong>】`;
const LIONHEART_TEXT =
  `<p><strong>Form I · Sword</strong></p><p><em><strong>Two-handed • Melee • Martial</strong></em></p>`
  + `<p><em><strong>Accuracy: 【MIG】+【WLP】 • Damage: 【HR + 10】${PHYSICAL}</strong></em></p>`
  + ul(`You may use the skill ${RENZOKUKEN_LINK}.`)
  + `<hr contenteditable="false"><p><strong>Form II · Gun</strong></p><p><em><strong>Two-handed • Ranged • Martial</strong></em></p>`
  + `<p><em><strong>Accuracy: 【DEX】+【INS】+ 1 • Damage: 【HR + 5】${PHYSICAL}</strong></em></p>`
  + ul(`When this weapon transforms into Gun form, gain <strong>1 Cartridge</strong> (max <strong>1</strong>) and <strong>15</strong> ${SHIELD}.`)
  + `<hr contenteditable="false">`
  + ul(
    "Once per turn, before or after your action, you may transform this weapon for free.",
    "You begin each conflict with <strong>1 Cartridge</strong>.",
  );
const PASSIVE_TEXT = ul(
  "You begin each conflict with <strong>1 Cartridge</strong>.",
  `When this weapon transforms into Gun form, gain <strong>1 Cartridge</strong> (max <strong>1</strong>) and <strong>15</strong> ${SHIELD}.`,
);
const RENZOKUKEN_TEXT =
  `<p><em>Sword form only.</em> This skill makes no Accuracy Check: it always hits. Make <strong>6</strong> strikes against the target. `
  + `Before each strike a gauge sweeps once; press inside <strong>TRIGGER</strong> to make that strike a Trigger.</p>`
  + ul(
    `Each strike deals ${PHYSICAL} damage equal to <strong>【55%】</strong> of this weapon's damage on a Trigger, or <strong>【20%】</strong> otherwise (this weapon's damage = 【10 + your damage bonuses】, with HR counted as 0).`,
    "If all <strong>6</strong> strikes are Triggers, finish with <strong>Lion Heart</strong>: one more strike for <strong>【120%】</strong>.",
    "Costs <strong>1 Cartridge</strong> as well as MP.",
  );
const FLAVOR = "<blockquote>\n<p>This rare gunblade gives you the strength and conviction of a lion.</p>\n</blockquote>";

// ── Helpers ──────────────────────────────────────────────────────────────────
function cloneData(srcId, { id, name, container = null, img, props = {}, effects } = {}) {
  const src = game.items.get(srcId);
  if (!src) throw new Error(`donor ${srcId} missing`);
  const d = src.toObject();
  d._id = id;
  d.name = name;
  if (img) d.img = img;
  d.folder = game.items.get(LIONHEART)?.folder?.id ?? d.folder ?? null;
  d.system.container = container;
  d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  if (img) d.system.props.img = img;
  if (effects !== undefined) d.effects = effects;
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d.flags[M].draftAutomation;
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}

async function createIfMissing(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}

function renzokukenData() {
  return cloneData(SKILL_DONOR, {
    id: ID.renzokuken, name: "Renzokuken", container: LIONHEART, img: ICON,
    props: {
      skill_type: "Active", cost: "30 MP", skill_target: "One Creature", duration: "Instantaneous", skill_range: "Melee",
      rolled_atr1: "-", rolled_atr2: "-", check_bonus: "0", damage_bonus: 0, type_damage: "", defense_target_type: "def",
      isCheck: false, isZeroPower: false, isOffensiveSpell: false, isReaction: false, class: "", skill_tags: "",
      animation_script: "", skill_animation_mode: "default", skill_animation_default: "",
      availability_formula: "WEAPON_FORM == 0 && AE_CHARGES_CARTRIDGE >= 1",
      availability_reason: "Needs Sword form and a Cartridge",
      description: RENZOKUKEN_TEXT,
      skill_description: `<p><strong>Cost:</strong> 30 MP + 1 Cartridge</p><p><strong>Target:</strong> One Creature</p><p><strong>Duration:</strong> Instantaneous</p>${RENZOKUKEN_TEXT}`,
      on_activate_effect_ref: "rzk_root",
      reaction_config_table: {},
      effect_table: table([
        { effect_kind: "chain", effect_label: "rzk_root", chain_steps: "rzk_cart, rzk_strikes" },
        { effect_kind: "consume_charge", effect_label: "rzk_cart", charge_key: "cartridge", count: "1", on_empty: "abort", target_ref: "self" },
        { effect_kind: "timed_strikes", effect_label: "rzk_strikes", target_ref: "action_targets",
          strike_count: "6", strike_hit_mult: "0.55", strike_miss_mult: "0.2", finisher_mult: "1.2", finisher_label: "Lion Heart",
          gauge_title: "Renzokuken", gauge_sweep_ms: "650", gauge_zone: "70-92", auto_rate: "0.7" },
      ]),
    },
  });
}

function passiveData() {
  const cartRef = `Item.${ID.passive}.ActiveEffect.${ID.cartridge}`;
  const d = cloneData(PASSIVE_SHELL, {
    id: ID.passive, name: "Lionheart (Passive)", container: LIONHEART,
    props: {
      description: PASSIVE_TEXT, skill_description: PASSIVE_TEXT, isReaction: true, skill_type: "Passive", skill_target: "Self",
      effect_table: table([
        { effect_kind: "apply_ae", effect_label: "lh_cart_start", ae_template_ref: cartRef, ae_duplicate_mode: "replace", ae_initial_charges: "1", target_ref: "self" },
        { effect_kind: "chain", effect_label: "lh_gun", chain_steps: "lh_cart_add, lh_cart_new, lh_guard" },
        // add first: consecutive apply_ae rows batch, so the create comes last (Rewinder note)
        { effect_kind: "adjust_charges", effect_label: "lh_cart_add", condition_formula: "AE_COUNT_CARTRIDGE > 0", charge_ae_name: "Cartridge",
          charge_operation: "add", charge_amount: "1", charge_max: "1", target_ref: "self" },
        { effect_kind: "apply_ae", effect_label: "lh_cart_new", condition_formula: "AE_COUNT_CARTRIDGE == 0", ae_template_ref: cartRef,
          ae_duplicate_mode: "replace", ae_initial_charges: "1", target_ref: "self" },
        { effect_kind: "set_resource", effect_label: "lh_guard", grant_resource: "shield", grant_amount: "15", target_ref: "self" },
      ]),
      reaction_config_table: table([
        { reaction_trigger: "conflict_start", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "", reaction_effect_ref: "lh_cart_start" },
        { reaction_trigger: "creature_transforms_weapon", reaction_passive_mode: "force", reaction_passive_target: "self", reaction_source: "",
          condition_formula: "TRANSFORMED_TO_FORM == 1", reaction_effect_ref: "lh_gun" },
      ]),
    },
  });
  d.effects = [{
    _id: ID.cartridge, name: "Cartridge", img: ICON, transfer: false, disabled: false, changes: [],
    description: "<p><em>Cartridge:</em> a loaded Lionheart round (max 1). Renzokuken spends it; transforming into Gun form reloads it. Every conflict starts with 1.</p>",
    duration: { startTime: null, seconds: null, combat: null, rounds: null, turns: null, startRound: null, startTurn: null },
    flags: {
      [M]: { chargeKey: "cartridge", charges: 1, chargesMax: 1, lifetimeMode: "persistent_counter", conflictScoped: true, crossScene: false,
        directorPermanent: true, uncleansable: true, category: "buff", hudResourceColor: "#e0a040", [FLAG]: "cartridge" },
      statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: true },
    },
  }];
  return d;
}

// Props every Lionheart copy carries (world master + actor copies).
const LIONHEART_PROPS = {
  category: "Sword", weapon_range: "Melee", hand_slots: "Two-handed", rolled_atr1: "MIG", rolled_atr2: "WLP",
  check_bonus: "0", damage_bonus: "10", type_damage: "Physical", isMartial: true, item_rarity: "Legendary",
  description: LIONHEART_TEXT, flavor_text: FLAVOR,
};
const lionheartPatch = () => {
  const patch = Object.fromEntries(Object.entries(LIONHEART_PROPS).map(([k, v]) => [`system.props.${k}`, v]));
  patch[`flags.${M}.weaponForms`] = FORMS;
  patch[`flags.${M}.activeForm`] = 0;
  return patch;
};

// ── Steps ────────────────────────────────────────────────────────────────────
async function authorWorld(out) {
  const lh = game.items.get(LIONHEART);
  if (!lh) { out.push("! Lionheart missing"); return null; }
  await createIfMissing(renzokukenData(), out);
  await createIfMissing(passiveData(), out);
  if (lh.getFlag(M, FLAG)) { out.push("= Lionheart already reworked"); return lh; }
  await lh.update(lionheartPatch());
  await lh.setFlag(M, FLAG, true);
  out.push("~ Lionheart: Legendary, Sword MIG+WLP HR+10 / Gun DEX+INS+1 HR+5, forms + Renzokuken + passive");
  return lh;
}

async function updateActorCopies(out) {
  const children = [game.items.get(ID.renzokuken), game.items.get(ID.passive)].filter(Boolean);
  let n = 0;
  for (const a of game.actors) {
    for (const copy of a.items.filter((i) => i.name === "Lionheart" && !i.system?.container)) {
      if (copy.getFlag(M, FLAG)) continue;
      await copy.update(lionheartPatch());
      // Drop any stale contained items, then copy the two new children in.
      const stale = a.items.filter((i) => i.system?.container === copy.id && !children.some((c) => c.name === i.name));
      for (const s of stale) if (a.items.get(s.id)) await s.delete();
      for (const c of children) {
        if (a.items.some((i) => i.system?.container === copy.id && i.name === c.name)) continue;
        const cd = c.toObject(); delete cd._id;
        cd.system.container = copy.id;
        await a.createEmbeddedDocuments("Item", [cd]);
      }
      await copy.setFlag(M, FLAG, true);
      n++;
      out.push(`~ ${a.name}: Lionheart copy reworked`);
    }
  }
  if (!n) out.push("= no actor Lionheart copies to update");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await authorWorld(out);
  await updateActorCopies(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
