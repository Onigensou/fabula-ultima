/**
 * Migration: 2026-11-26-frankensteiner-rework  (Monster of Frankensteiner gacha set)
 * ---------------------------------------------------------------------------
 * User design 2026-11-25/26 (review page https://claude.ai/artifact/WupMhaYibJ3bTyUkNamN4t,
 * rounds 1-2 + v3 cards; convert call = option B, the page default). Goal: no PERMANENT
 * Bolt absorb on gear (Fafnir is a Bolt boss); pieces Rare, 2-Piece Rare tier, 3-Piece
 * Legendary tier. Text in Genshin style.
 *
 *   Stitched-Up Jacket  Rare armor · DEF +1 / M.DEF +1 · 3000z
 *                       One "Bolt Absorb" charge (affinity_3 = AB while it lasts), spent on
 *                       the first Bolt hit it absorbs, refilled at your turn start (Protect
 *                       pattern: turn_start + conflict_start refill, gone at conflict end).
 *   Silver Bolt         Rare accessory · 1500z
 *                       Take / Absorb Bolt → Strong.
 *                       Once per turn (a "Silver Bolt Ready" charge, refilled at turn start),
 *                       you may turn a hit you are about to take into Bolt: a defender card
 *                       pill (creature_targeted_by_action) with change_damage_element bolt +
 *                       element_no_absorb (engine, same branch): converted damage can't be
 *                       Absorbed, so the Jacket never eats it.
 *   Lightning Rod       Rare spear · HR +6 (was +8) · 2500z (name kept)
 *                       Take / Absorb Bolt → 1 Overcharge (own AE per stack, 2 of your turns,
 *                       max 3): attacks with this weapon +5 per stack.
 *                       On hit: 10% + 10% per Overcharge to inflict Paralyzed.
 *   2-Piece  Galvanic Feedback  Absorb ANY damage → recover MP equal to it, once per round.
 *   3-Piece  Spark of Life      Absorb Bolt → 1 Spark of Life (max 3). At 3, a lethal hit is
 *                       survived: HP becomes your Crisis score (Life Charm pattern, carried
 *                       by the Spark AE itself). Lost at conflict end. No drawback (user).
 *
 * Banner: the set's gacha table leaves the banner folder (user 2026-11-26, "for now") — moved
 * to a "Retired Banners" sub-folder, so moving it back restores it. Nothing else references
 * the pieces (no owner, no other banner's pool; Hako's shop roster skips set pieces).
 *
 * World items only: no actor owns a piece (checked against the export 2026-11-26), but any
 * copy that appears later is synced the same way (same fixed ids are skipped when present).
 * Gated by flags.fabula-ultima-companion.mofRework on each touched document.
 */

export const key = "2026-11-26-frankensteiner-rework";
export const description = "Monster of Frankensteiner rework: charge-based Bolt Absorb, Silver Bolt convert, Overcharge Rod, absorb→MP 2-Piece, Spark of Life 3-Piece; banner retired.";

const M = "fabula-ultima-companion";
const FLAG = "mofRework";

const ID = {
  jacket: "1RLyAV6Hx7n1PmBb", jacketPsv: "NsEPkgoPjLnmTyjl",
  silver: "aPVUpJ1KwspTpUTV", silverPsv: "JUuBEVyu4PgfMCol",
  rod: "nvsyVWdA6cevPiIL", rodPsv: "uEAuWAA7dZeSnaFk",
  set: "2Z502E09PMrRdWat", t2: "qKDhWuKfcffBKyAF", t3: "MofSparkOfLife01",
  aeAbsorb: "MofBoltAbsorb001", aeReady: "MofSilverReady01", aeOver: "MofOvercharge001", aeSpark: "MofSparkLifeAE01",
  banner: "5vK0Z321GuAYlywn", bannerFolder: "QGWhvmRAHt4ibvnG", retiredFolder: "MofRetiredBanner",
};
const LIFE_CHARM = "SccgW4PlHy8m6ph5";
const AE = { absorb: "Bolt Absorb", ready: "Silver Bolt Ready", over: "Overcharge", spark: "Spark of Life" };

// Tuning (review page knobs, v3).
const T = { rodHr: "6", y: 5, x: 2, max: 3, pBase: 10, pStep: 10, sparkMax: 3 };

// ── Styled links (house convention; same markup as the trio-steals migration) ──
const A_STYLE = "box-sizing: border-box; user-select: text; scrollbar-width: thin; scrollbar-color: rgb(93, 20, 43) rgba(0, 0, 0, 0); cursor: pointer; --content-link-background: rgba(0, 0, 0, 0.1); background-image: none !important; background-position: initial !important; background-size: initial !important; background-repeat: initial !important; background-attachment: initial !important; background-origin: initial !important; background-clip: initial !important; background-color: rgb(102, 102, 102); padding: 0px !important; border: none !important; border-radius: 2px; white-space: nowrap; word-break: break-all; color: {COLOR}; font-weight: bold; text-decoration: underline; display: inline-flex; align-items: center; position: relative; top: 2px; {SHADOW}font-family: Signika, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px;";
const styledLink = (type, id, label, { color = "inherit", glow = null } = {}) => {
  const style = A_STYLE.replace("{COLOR}", color).replace("{SHADOW}", glow ? `text-shadow: ${glow} 0px 0px 4px; ` : "");
  const tip = type === "Item" ? "Equippable Item Item" : "Journal Entry";
  return `<span style="text-decoration: underline;"><span style="font-family: Signika, sans-serif"><a class="content-link" draggable="true" data-link="" data-uuid="${type}.${id}" data-id="${id}" data-type="${type}" data-tooltip="${tip}" aria-describedby="tooltip" style="${style}"><strong><span style="text-decoration: underline;">${label}</span></strong></a></span></span>`;
};
const J = (id, label) => styledLink("JournalEntry", id, label, { color: "rgb(25, 24, 19)" });
const BOLT = styledLink("Item", "5XAuMMbDPlLzhJLw", "Bolt", { glow: "rgb(215, 169, 255)" });
const STRONG = `<a class="content-link" data-uuid="Item.Gg1ot3L3XPuiGkym" data-id="Gg1ot3L3XPuiGkym" data-type="Item">Strong</a>`;
const PARALYZED = J("GqqgHkKOs0hkghdG", "Paralyzed");
const CRISIS = J("GJevbCPM8cffm1QM", "Crisis");
const B = (s) => `<strong>${s}</strong>`;
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

// ── Text (Genshin mode, Option A; approved on the review page, convert = B) ──
const OVER = B("Overcharge");
const SPARK = B("Spark of Life");
const TEXT = {
  jacket: [`Absorb the next ${BOLT} damage you take. Recharges at the start of your turn.`],
  silver: [
    `When you take or Absorb ${BOLT} damage, gain ${STRONG}.`,
    `When you take damage, you may change it to ${BOLT} damage. Recharges at the start of your turn.`,
    "Converted damage can't be Absorbed.",
  ],
  rod: [
    `When you take or Absorb ${BOLT} damage, gain 1 ${OVER}: this weapon deals ${B(T.y)} extra damage. Lasts ${B(T.x)} turns. Each stack has its own timer. Max ${B(T.max)} stacks.`,
    `On hit, ${B(T.pBase + "%")} chance to inflict ${PARALYZED}, ${B("+" + T.pStep + "%")} per ${OVER}.`,
  ],
  t2: ["When you Absorb damage, recover MP equal to the amount absorbed. Once per round."],
  t3: [
    `When you Absorb ${BOLT} damage, gain 1 ${SPARK}. Max ${B(T.sparkMax)} stacks.`,
    `When you would be reduced to 0 HP with ${B(T.sparkMax)} ${SPARK}, spend them. Your HP becomes your ${CRISIS} score instead.`,
    `${SPARK} is lost at the end of the scene.`,
  ],
};
const ROD_FLAVOR = em("This instrument harnesses the power of lightning and turns it into energy.");
const SET_DESC = `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p>${ul(...TEXT.t2)}<p><strong>3 Piece</strong></p>${ul(...TEXT.t3)}`;

// ── Row builders ─────────────────────────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({
  reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref,
  condition_formula: "", reaction_resource_filter: "", reaction_cause_filter: "", reaction_max_per_round: "", reaction_requires_weapon_used: false, ...extra,
});
const removeAe = (label, name) => ({ effect_label: label, effect_kind: "remove_ae", ae_template_ref: name, include_persistent: true, target_ref: "self" });
const applyAe = (label, name, extra = {}) => ({ effect_label: label, effect_kind: "apply_ae", ae_template_ref: name, ae_duplicate_mode: "replace", target_ref: "self", ...extra });
// The battle engine's damage events are the resource ledger: a hit taken is an HP
// creature_lose_resource, an ABSORBED hit an HP creature_gain_resource, both carrying the
// true element (state-handlers: "an ABSORB is still a bolt event"). No cause filter on the
// Bolt rows, so a Bolt hazard (Lightning Storm) counts too; heals/costs carry no element.
const BOLT_HP = { reaction_resource_filter: "hp", condition_formula: "TRIGGER_DAMAGE_IS_BOLT == 1" };
const takeBolt = (ref, extra = {}) => rc("creature_lose_resource", ref, { ...BOLT_HP, ...extra });
const absorbBolt = (ref, extra = {}) => rc("creature_gain_resource", ref, { ...BOLT_HP, ...extra });
const takeOrAbsorbBolt = (ref, extra = {}) => [takeBolt(ref, extra), absorbBolt(ref, extra)];

// Jacket — the charge AE carries the Absorb.
const absorbAe = (img) => ({
  _id: ID.aeAbsorb, name: AE.absorb, img, transfer: false, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: "<p>Absorbs the next Bolt damage you take (Stitched-Up Jacket).</p>", duration: {}, origin: null,
  changes: [{ key: "affinity_3", mode: 5, priority: 30, value: "AB" }],
  flags: { [M]: { category: "Other", directorPermanent: true, [FLAG]: "ae" } },
});
const JACKET_RC = [
  rc("turn_start", "mj_refill"), rc("conflict_start", "mj_refill", { reaction_source: "" }),
  absorbBolt("mj_spend"),
  rc("conflict_end", "mj_spend", { reaction_source: "" }),
];
// "skip": an unspent charge stays as is. A re-apply over it would read its AB as native and
// drop the new copy's override (skill-effects' preserve-IM/AB guard); spending deletes it.
const JACKET_EFF = [applyAe("mj_refill", AE.absorb, { ae_duplicate_mode: "skip" }), removeAe("mj_spend", AE.absorb)];

// Silver Bolt — Strong + the once-a-turn convert (defender card pill).
const readyAe = (img) => ({
  _id: ID.aeReady, name: AE.ready, img, transfer: false, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: "<p>Silver Bolt can change the next hit you take into Bolt damage.</p>", duration: {}, origin: null, changes: [],
  flags: { [M]: { category: "Other", chargeKey: "silverbolt", charges: 1, chargesMax: 1, lifetimeMode: "persistent_counter", [FLAG]: "ae" } },
});
const SILVER_RC = [
  ...takeOrAbsorbBolt("sb_strong", { reaction_passive_mode: "on" }),
  rc("creature_targeted_by_action", "sb_convert", {
    reaction_passive_mode: "ask", reaction_action_intent: "harmful",
    condition_formula: "INCOMING_DAMAGE > 0 && TRIGGER_DAMAGE_IS_BOLT == 0 && AE_CHARGES_SILVER_BOLT_READY >= 1",
  }),
  rc("turn_start", "sb_refill"), rc("conflict_start", "sb_refill", { reaction_source: "" }),
  rc("conflict_end", "sb_clear", { reaction_source: "" }),
];
const SILVER_EFF = [
  applyAe("sb_strong", "Strong"),
  { effect_label: "sb_convert", effect_kind: "chain", chain_steps: "sb_el, sb_spend" },
  { effect_label: "sb_el", effect_kind: "change_damage_element", change_element: "bolt", element_no_absorb: true },
  { effect_label: "sb_spend", effect_kind: "consume_charge", charge_key: "silverbolt", count: "1", on_empty: "abort", target_ref: "self" },
  applyAe("sb_refill", AE.ready),
  removeAe("sb_clear", AE.ready),
];

// Lightning Rod — Overcharge stacks (own AE each) + on-hit Paralyze.
const overAe = (img) => ({
  _id: ID.aeOver, name: AE.over, img, transfer: false, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: `<p>Lightning Rod deals ${T.y} extra damage per Overcharge.</p>`, duration: {}, origin: null, changes: [],
  flags: { [M]: { category: "buff", [FLAG]: "ae" } },
});
const ROD_RC = [
  ...takeOrAbsorbBolt("lr_gain", { reaction_passive_mode: "on" }).map((r) => ({
    ...r,
    condition_formula: [r.condition_formula, `AE_COUNT_OVERCHARGE < ${T.max}`].filter(Boolean).join(" && "),
  })),
  rc("creature_will_deal_damage", "lr_bonus", {
    reaction_requires_weapon_used: true,
    condition_formula: "ACTION_IS_ATTACK == 1 && DAMAGE_IS_HP == 1 && AE_COUNT_OVERCHARGE >= 1",
  }),
  rc("creature_deals_damage", "lr_para", {
    reaction_passive_mode: "on", reaction_requires_weapon_used: true,
    condition_formula: "TRIGGER_IS_SELF == 1 && ACTION_IS_ATTACK == 1",
  }),
  rc("conflict_end", "lr_clear", { reaction_source: "" }),
];
const ROD_EFF = [
  applyAe("lr_gain", AE.over, { ae_duplicate_mode: "stack", ae_duration_rounds: String(T.x), ae_lifetime_mode: "target_turn_end" }),
  { effect_label: "lr_bonus", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "add", damage_amount: `${T.y} * AE_COUNT_OVERCHARGE` },
  { effect_label: "lr_para", effect_kind: "apply_ae", ae_template_ref: "Paralyzed", ae_duplicate_mode: "replace", target_ref: "hit_action_targets",
    ae_chance_percent: `${T.pBase} + ${T.pStep} * AE_COUNT_OVERCHARGE` },
  removeAe("lr_clear", AE.over),
];

// 2-Piece — absorb anything → MP, once per round.
// An absorbed hit = an HP gain with cause "damage" (a heal is cause "heal").
const T2_RC = [rc("creature_gain_resource", "gf_mp", { reaction_passive_mode: "on", reaction_max_per_round: "1", reaction_resource_filter: "hp", reaction_cause_filter: "damage" })];
const T2_EFF = [{ effect_label: "gf_mp", effect_kind: "grant", grant_resource: "mp", grant_amount: "TRIGGER_AMOUNT", target_ref: "self" }];

// 3-Piece — Spark of Life. The KO save rides the Spark AE (resolveDamageReactions walks the
// victim's AEs at HP-write), Life Charm's chain: cap → card → KO pose → revive → HP = Crisis.
const sparkAe = (img) => ({
  _id: ID.aeSpark, name: AE.spark, img, transfer: false, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: "<p>At 3 Spark of Life, a hit that would reduce you to 0 HP leaves you at your Crisis score instead.</p>", duration: {}, origin: null, changes: [],
  flags: { [M]: {
    category: "Other", chargeKey: "spark", charges: 0, chargesMax: T.sparkMax, lifetimeMode: "persistent_counter", hudResourceColor: "#b48cff", [FLAG]: "ae",
    reactionConfig: {
      name: AE.spark,
      reaction_config_table: { 0: {
        reaction_trigger: "creature_takes_damage", reaction_source: "self", reaction_passive_mode: "force",
        reaction_damage_outcome: "would_reduce_to_zero", reaction_last_resort: true,
        condition_formula: `AE_CHARGES_SPARK_OF_LIFE >= ${T.sparkMax}`, reaction_effect_ref: "sl_save",
      } },
      effect_table: table([
        { effect_label: "sl_save", effect_kind: "chain", chain_steps: "sl_cap, sl_card, sl_wait, sl_fall, sl_hold, sl_fx, sl_heal, sl_rise" },
        { effect_label: "sl_cap", effect_kind: "adjust_damage", damage_stage: "incoming", damage_operation: "cap", damage_amount: "CUR_HP - 1", consume_self: true },
        { effect_label: "sl_card", effect_kind: "notify", notify_type: "card", notify_message: AE.spark, notify_abort: false },
        { effect_label: "sl_wait", effect_kind: "delay", delay_ms: "500" },
        { effect_label: "sl_fall", effect_kind: "play_pose", pose_name: "ko" },
        { effect_label: "sl_hold", effect_kind: "delay", delay_ms: "1200" },
        { effect_label: "sl_fx", effect_kind: "play_animation", action_ref: "Item.FxShared0Revive1", target_ref: "self" },
        { effect_label: "sl_heal", effect_kind: "set_resource", grant_resource: "hp", grant_amount: "floor(MAX_HP / 2)", target_ref: "self" },
        { effect_label: "sl_rise", effect_kind: "play_pose", pose_name: "idle" },
      ]),
    },
  } },
});
const T3_RC = [
  absorbBolt("sp_gain", { reaction_passive_mode: "on" }),
  rc("conflict_end", "sp_clear", { reaction_source: "" }),
];
const T3_EFF = [
  applyAe("sp_gain", AE.spark, { ae_duplicate_mode: "add_charges", ae_initial_charges: "1" }),
  removeAe("sp_clear", AE.spark),
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const done = (doc) => !!doc?.getFlag?.(M, FLAG);
async function setTables(doc, rcRows, effRows, extra = {}) {
  // CSB dynamic tables deep-merge: null both first, then write the full key set.
  await doc.update({ "system.props.effect_table": null, "system.props.reaction_config_table": null });
  await doc.update({
    "system.props.effect_table": table(effRows), "system.props.reaction_config_table": table(rcRows),
    "system.props.isReaction": true, ...extra,
  });
}
async function putAe(doc, data) {
  const have = doc.effects.get(data._id) ?? doc.effects.find((e) => e.name === data.name);
  if (have) await have.delete();
  await doc.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
}
function pieceProps(which) {
  const common = { item_rarity: "Rare", isSet: true, set_name: "Monster of Frankensteiner", set_description: SET_DESC };
  if (which === "jacket") return { ...common, description: ul(...TEXT.jacket), isMartial: false, item_baseDef: "0", item_baseMdef: "0", item_def_bonus: "1", item_mdef_bonus: "1", item_cost: "3000" };
  if (which === "silver") return { ...common, description: ul(...TEXT.silver), item_cost: "1500" };
  return { ...common, description: ul(...TEXT.rod), flavor_text: ROD_FLAVOR, damage_bonus: T.rodHr, item_cost: "2500" };
}
const PIECES = [
  { which: "jacket", id: ID.jacket, psv: ID.jacketPsv, rc: JACKET_RC, eff: JACKET_EFF, ae: absorbAe },
  { which: "silver", id: ID.silver, psv: ID.silverPsv, rc: SILVER_RC, eff: SILVER_EFF, ae: readyAe },
  { which: "rod", id: ID.rod, psv: ID.rodPsv, rc: ROD_RC, eff: ROD_EFF, ae: overAe },
];

async function authorPiece(piece, parent, passive, out) {
  const where = parent.parent ? `${parent.parent.name}: ${parent.name}` : parent.name;
  if (done(parent) && done(passive)) { out.push(`= ${where}`); return; }
  const props = pieceProps(piece.which);
  const patch = { [`flags.${M}.${FLAG}`]: true };
  for (const [k, v] of Object.entries(props)) patch[`system.props.${k}`] = v;
  await parent.update(patch);
  if (passive) {
    const text = ul(...TEXT[piece.which]);
    await setTables(passive, piece.rc, piece.eff, { "system.props.description": text, "system.props.skill_description": text, [`flags.${M}.${FLAG}`]: true });
    await putAe(passive, piece.ae(parent.img));
  }
  out.push(`~ ${where}${passive ? "" : " (no passive found)"}`);
}

// Every copy: the world item + any actor / unlinked-token copy (by name, top-level).
function copiesOf(name) {
  const res = [];
  const actors = [...game.actors];
  for (const sc of game.scenes) for (const t of sc.tokens) if (!t.actorLink && t.actor) actors.push(t.actor);
  for (const a of actors) {
    for (const it of a.items.filter((i) => !i.system?.container && i.name === name)) {
      if (a.isToken && !a.token?.delta?.items?.get(it.id)) continue; // inherited from the base actor
      const psv = a.items.find((c) => c.system?.container === it.id && /\(Passive\)$/.test(c.name));
      res.push({ parent: it, passive: psv ?? null });
    }
  }
  return res;
}

async function authorSet(out) {
  const set = game.items.get(ID.set);
  if (!set) { out.push("! set document missing"); return; }
  // 2-Piece (rewrite in place).
  const t2 = game.items.get(ID.t2);
  if (t2 && !done(t2)) {
    const text = ul(...TEXT.t2);
    await setTables(t2, T2_RC, T2_EFF, { "system.props.description": text, "system.props.skill_description": text, [`flags.${M}.${FLAG}`]: true });
    out.push("~ 2-Piece Galvanic Feedback");
  }
  // 3-Piece (new skill, cloned from the 2-Piece shell; container = the set doc).
  if (!game.items.get(ID.t3) && t2) {
    const d = t2.toObject();
    d._id = ID.t3; d.name = AE.spark;
    d.system.uniqueId = ID.t3; d.system.container = ID.set;
    const text = ul(...TEXT.t3);
    d.system.props = { ...d.system.props, name: AE.spark, id: ID.t3, uuid: `Item.${ID.t3}`, description: text, skill_description: text,
      effect_table: table(T3_EFF), reaction_config_table: table(T3_RC), isReaction: true, skill_type: "Passive" };
    const img = game.items.get(LIFE_CHARM)?.img ?? game.items.get(ID.jacket)?.img ?? d.img;
    d.effects = [sparkAe(img)];
    d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: true } };
    delete d._stats; delete d.sort; delete d.ownership;
    await Item.createDocuments([d], { keepId: true });
    out.push("+ 3-Piece Spark of Life");
  }
  if (!done(set)) {
    await set.update({ "system.props.set_bonus_table": null });
    await set.update({
      "system.props.set_bonus_table": table([
        { pieces: "2", bonus_label: "Absorb damage: recover that much MP (once per round)", bonus_ae_ref: "", bonus_skill_ref: "Galvanic Feedback" },
        { pieces: "3", bonus_label: "Absorb Bolt: Spark of Life; at 3, survive a KO at your Crisis score", bonus_ae_ref: "", bonus_skill_ref: AE.spark },
      ]),
      [`flags.${M}.${FLAG}`]: true,
    });
    out.push("~ set table: 2-Piece + 3-Piece");
  }
}

async function retireBanner(out) {
  const tbl = game.tables.get(ID.banner);
  if (!tbl) { out.push("! banner table missing"); return; }
  if (tbl.folder?.id !== ID.bannerFolder) { out.push("= banner already out of the gacha"); return; }
  if (!game.folders.get(ID.retiredFolder)) {
    await Folder.create({ _id: ID.retiredFolder, name: "Retired Banners", type: "RollTable", folder: ID.bannerFolder, sorting: "a" }, { keepId: true });
  }
  await tbl.update({ folder: ID.retiredFolder, [`flags.${M}.${FLAG}`]: "retired" });
  out.push("~ banner Monster of Frankensteiner → Retired Banners (out of the gacha)");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  for (const piece of PIECES) {
    const world = game.items.get(piece.id);
    if (!world) { out.push(`! ${piece.which} missing`); continue; }
    await authorPiece(piece, world, game.items.get(piece.psv) ?? null, out);
    for (const c of copiesOf(world.name)) await authorPiece(piece, c.parent, c.passive, out);
  }
  await authorSet(out);
  await retireBanner(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
