/**
 * Migration: 2026-11-26-caster-fillers  (filler sets for the two caster banners)
 * ---------------------------------------------------------------------------
 * Review page https://claude.ai/artifact/JERJHoc46xgsx6EjF1MbCV, round 5 (all
 * approved). Both sets existed as text only; this authors them.
 *
 * Eternal Traveler (filler, Fey Wanderer banner) — all three pieces → Rare.
 *   Handy Knives      +2 DEX/INS checks (already authored) + counts as Sword /
 *                     Spear / Thrown (weapon_category_alias on the knives).
 *   Traveler's Cloak  field hazards −50% (hazard_damage_reduction_pct; engine
 *                     hook in damage-ruleset / apply-damage-core, same change).
 *   Traveler's Backpack  items cost 1 less IP, min 1 (ip_reduction_value).
 *   2pc  rest → 50% max IP, even outside town (rest_ip_recover_pct, set AE).
 *   3pc  Ready Pack: free Item action, now once per BATTLE (was once per round).
 *   Copies on Halsten / Yuri / St. Reefesia get the same AEs and text.
 *
 * Moonlight Dancer (filler, Sage of Destruction banner) — all three → Rare.
 *   Moon Dancer Chakram  swapped out → free Attack with it, no High Roll
 *                     (creature_unequips_item + free_action action_ref container).
 *   Moonlight Dancer Robe  1 extra Dance per round if it differs from your first,
 *                     15 MP (free_action exclude_skill_refs remembered:Dancing).
 *   Moon Dancer Ornament  would gain Slow/Dazed/Weak/Shaken → spend the matching
 *                     buff instead (status_trade, apply_ae gate).
 *   NEW set doc + 2pc Moonlit Step (+2 DEF/M.DEF on a Dance that differs from
 *   last turn's) + 3pc Waltz (Waltz Point counter, +3 Thrown damage per point,
 *   NO cap — user call). "Last Turn Dance" snapshots base Dance's "Dancing" at
 *   turn start (apply_ae ae_remember_from).
 *   Icons moved off img.altema.jp onto Forge (Item Icon/Valkyrie Connect/).
 *
 * Also: Hunter Boots gets the same hazard AE (identical printed line, was text
 * only); the Valley storm's "Lightning Rod" debuff AE is tagged "hazard".
 *
 * SEED-ONLY: fixed ids, per-document flag casterFillers; a re-run skips done docs.
 */

export const key = "2026-11-26-caster-fillers";
export const description = "Caster banner fillers: author Eternal Traveler + Moonlight Dancer (Rare, Genshin text, hazard/IP/rest/dance/status-trade mechanics), Hunter Boots hazard AE, Lightning Rod hazard tag.";

const M = "fabula-ultima-companion";
const FLAG = "casterFillers";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";

const ID = {
  // Eternal Traveler
  etSet: "SDyXwtWF0CgO7hIe", readyPack: "fR29CoH9EQ9ySXTs",
  knives: "gmnCyBBh5qJNb8HM", cloak: "dHS9b0tj8FnO0aOQ", pack: "FU3mR0UB7xuX9ZPu",
  aeKnife: "EtTrvKnifeAls001", aeCloak: "EtTrvCloakHzd001", aePack: "EtTrvPackIp00001", aeRest: "EtTrvRestIp00001",
  // Moonlight Dancer
  chakram: "nJXcfE31UpQ0rGJI", robe: "roafy3ui2JMXHqsa", ornament: "nYQMIXsVeTZzPvhd",
  mdSet: "MoonDncSetDef001", mdT2: "MoonDncStepSkl01", mdT3: "MoonDncWaltzSk01",
  chakPsv: "MoonDncChakPsv01", robePsv: "MoonDncRobePsv01",
  aeOrn: "MoonDncOrnTrade1", aeLtd: "MoonDncLastTurn1", aeGuard: "MoonDncGuardAE01", aeWaltz: "MoonDncWaltzAE01", aeEncore: "MoonDncEncoreAE1",
  // Others
  hunterBoots: "duaQp4cjNOboR9Gk", debuffLib: "XVOWOq9oUmEECGrU",
};
const MD_FOLDER = "D1OgeGHLjJ9dSkxS";       // ⚔️ Equipments/Set/Moonlight Dancer (the pieces)
const SET_DONOR = "CQ6Pq61KaMixQAjw";       // Bloodied Chivalry — Equipment Set
const PASSIVE_SHELL = "r5YlGxjwTfvpt5yM";   // Razor Plume (Passive)
const ICON = {
  chakram: `${FORGE}Item%20Icon/Valkyrie%20Connect/Moon_Dancer_Chakram_icon.jpg`,
  ornament: `${FORGE}Item%20Icon/Valkyrie%20Connect/Moon_Dancer_Ornament_icon.jpg`,
  robe: `${FORGE}Item%20Icon/Valkyrie%20Connect/Moonlight_Dancer_Robe_icon.jpg`,
};

// ── Styled links (house convention; same markup as the Frankensteiner migration) ──
const A_STYLE = "box-sizing: border-box; user-select: text; scrollbar-width: thin; scrollbar-color: rgb(93, 20, 43) rgba(0, 0, 0, 0); cursor: pointer; --content-link-background: rgba(0, 0, 0, 0.1); background-image: none !important; background-position: initial !important; background-size: initial !important; background-repeat: initial !important; background-attachment: initial !important; background-origin: initial !important; background-clip: initial !important; background-color: rgb(102, 102, 102); padding: 0px !important; border: none !important; border-radius: 2px; white-space: nowrap; word-break: break-all; color: {COLOR}; font-weight: bold; text-decoration: underline; display: inline-flex; align-items: center; position: relative; top: 2px; {SHADOW}font-family: Signika, sans-serif; font-size: 14px; font-style: normal; font-variant-ligatures: normal; font-variant-caps: normal; letter-spacing: normal; orphans: 2; text-align: start; text-indent: 0px; text-transform: none; widows: 2; word-spacing: 0px; -webkit-text-stroke-width: 0px;";
const styledLink = (type, id, label, { color = "inherit", glow = null } = {}) => {
  const style = A_STYLE.replace("{COLOR}", color).replace("{SHADOW}", glow ? `text-shadow: ${glow} 0px 0px 4px; ` : "");
  const tip = type === "Item" ? "Equippable Item Item" : "Journal Entry";
  return `<span style="text-decoration: underline;"><span style="font-family: Signika, sans-serif"><a class="content-link" draggable="true" data-link="" data-uuid="${type}.${id}" data-id="${id}" data-type="${type}" data-tooltip="${tip}" aria-describedby="tooltip" style="${style}"><strong><span style="text-decoration: underline;">${label}</span></strong></a></span></span>`;
};
const J = (id, label) => styledLink("JournalEntry", id, label, { color: "rgb(25, 24, 19)" });
const SLOW = J("HHmYmj7xffQMqtzT", "Slow"), DAZED = J("3nmUvPei3zrOJkEt", "Dazed"),
  WEAK = J("KYehgac3Pw1fKC9S", "Weak"), SHAKEN = J("ImFKpNNGjstom7Q9", "Shaken"),
  QUICKCHANGE = J("scBCSpHipSeXcOYa", "Quickchange");
const B = (s) => `<strong>${s}</strong>`;
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

// ── Text (Genshin mode, Option A; approved on the review page, round 5) ──
const WALTZ = B("Waltz Point");
const TEXT = {
  knives: [`${B("+2")} to checks that use 【DEX】 or 【INS】.`, "When you attack, this weapon may count as a Sword, Spear or Thrown weapon."],
  cloak: [`Field hazards deal ${B("50%")} less damage to you.`],
  pack: [`Items you use cost ${B("1")} less IP. Min 1.`],
  et2: [`When you rest, recover ${B("50%")} of your max IP, even outside town.`],
  et3: ["Once per scene, you may perform the Item action as a Free Action."],
  chakram: [QUICKCHANGE, "When you swap this weapon out with the Equipment action, perform a free Attack with it first. That Attack doesn't add High Roll."],
  robe: [`You may perform ${B("1")} extra Dance per round if it differs from your first. It costs ${B("15")} MP.`],
  ornament: [`When you would gain ${SLOW}, ${DAZED}, ${WEAK} or ${SHAKEN}, you may lose its matching buff to block it.`],
  md2: [`When you perform a Dance that differs from last turn's, gain ${B("+2")} DEF and ${B("+2")} M.DEF until the start of your next turn.`],
  md3: [`When you perform a Dance that differs from last turn's, gain 1 ${WALTZ}: Thrown weapons deal ${B("+3")} damage per point. Lose all points if you end a turn without dancing or repeat a Dance.`],
};
const setDesc = (t2, t3) => `<p><strong>【Set Bonus】</strong></p><p><strong>2 Piece</strong></p>${ul(...t2)}<p><strong>3 Piece</strong></p>${ul(...t3)}`;
const ET_SET_DESC = setDesc(TEXT.et2, TEXT.et3);
const MD_SET_DESC = setDesc(TEXT.md2, TEXT.md3);

// ── Row builders ─────────────────────────────────────────────────────────────
const rc = (trigger, ref, extra = {}) => ({
  reaction_trigger: trigger, reaction_source: "self", reaction_passive_mode: "force", reaction_effect_ref: ref,
  condition_formula: "", reaction_resource_filter: "", reaction_cause_filter: "", reaction_max_per_round: "", reaction_requires_weapon_used: false, ...extra,
});
const applyAe = (label, name, extra = {}) => ({ effect_label: label, effect_kind: "apply_ae", ae_template_ref: name, ae_duplicate_mode: "replace", target_ref: "self", ...extra });
const removeAe = (label, name) => ({ effect_label: label, effect_kind: "remove_ae", ae_template_ref: name, include_persistent: true, target_ref: "self" });

// A gear AE: always enabled, the value gated by isEquipped (Handy Knives' own pattern).
const gearAe = (id, name, img, changes, desc) => ({
  _id: id, name, img, transfer: true, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: `<p>${desc}</p>`, duration: {}, origin: null, changes, flags: { [M]: { [FLAG]: "ae" } },
});
const templAe = (id, name, img, changes, desc, flags = {}) => ({
  _id: id, name, img, transfer: false, disabled: false, statuses: [], type: "base", system: {}, sort: 0, tint: "#ffffff",
  description: `<p>${desc}</p>`, duration: {}, origin: null, changes, flags: { [M]: { [FLAG]: "ae", ...flags } },
});

// The dance conditions. SKILL_HAS_TAG_MANAGED keeps it to base Dance's own performs
// (the same gate as Dance's bd_perform row). "Last Turn Dance" holds last turn's dance.
const DANCED = "SKILL_HAS_TAG_DANCE == 1 && SKILL_HAS_TAG_MANAGED == 1";
const LTD = `AE_FLAG("Last Turn Dance","rememberedAction")`;
const DIFFERS = `${DANCED} && AE_COUNT_LAST_TURN_DANCE > 0 && ${LTD} != PERFORMED_SKILL`;
const REPEATS = `${DANCED} && AE_COUNT_LAST_TURN_DANCE > 0 && ${LTD} == PERFORMED_SKILL`;

// Robe — the extra Dance. Offered right after a dance completes, once the base token
// is spent (AE_COUNT_DANCE == 0), not already used this round (Encore), and never the
// dance you just did (exclude remembered:Dancing). The 2nd dance's own perform adds
// 10 MP on top of base Dance's 5 (a different dance) = 15, and stamps Encore.
const ROBE_RC = [
  rc("creature_completes_skill", "rb_offer", {
    reaction_passive_mode: "ask", reaction_max_per_round: "1", reaction_max_scope: "round",
    condition_formula: "SKILL_HAS_TAG_DANCE == 1 && AE_COUNT_DANCE == 0 && AE_COUNT_ENCORE == 0 && HAS_MARTIAL_ARMOR == 0",
  }),
  rc("creature_performs_action", "rb_encore", { condition_formula: `${DANCED} && AE_COUNT_DANCE == 0` }),
];
const ROBE_EFF = [
  { effect_label: "rb_offer", effect_kind: "free_action", action_ref: "Skill", allowed_skill_refs: "tag:dance", exclude_skill_refs: "remembered:Dancing",
    menu_label: "Encore", menu_description: "Moonlight Dancer Robe — perform a different Dance (15 MP)." },
  { effect_label: "rb_encore", effect_kind: "chain", chain_steps: "rb_cost, rb_mark" },
  { effect_label: "rb_cost", effect_kind: "adjust_cost", cost_resource: "mp", cost_operation: "add", cost_amount: "10", consume_resource: "mp", consume_amount: "10", on_empty: "abort", target_ref: "self" },
  applyAe("rb_mark", "Encore", { ae_lifetime_mode: "target_turn_end", ae_duration_rounds: "1" }),
];

// Chakram — swapped out mid-battle → a free Attack with it (no High Roll).
const CHAK_RC = [rc("creature_unequips_item", "ck_throw", { condition_formula: "ROUND > 0" })];
const CHAK_EFF = [{ effect_label: "ck_throw", effect_kind: "free_action", action_ref: "container", free_hr_as_zero: true,
  menu_label: "Parting Throw", menu_description: "Moon Dancer Chakram — a free Attack as it leaves your hand (no High Roll)." }];

// 2-Piece Moonlit Step — keeps "Last Turn Dance" and grants the DEF/M.DEF buff.
const MD2_RC = [
  rc("turn_start", "ms_snap", { condition_formula: "AE_COUNT_DANCING > 0" }),
  rc("turn_start", "ms_drop", { condition_formula: "AE_COUNT_DANCING == 0" }),
  rc("creature_performs_action", "ms_guard", { condition_formula: DIFFERS }),
  rc("conflict_end", "ms_clear", { reaction_source: "" }),
];
const MD2_EFF = [
  applyAe("ms_snap", "Last Turn Dance", { ae_remember_from: "Dancing", ae_duration_rounds: "scene" }),
  removeAe("ms_drop", "Last Turn Dance"),
  applyAe("ms_guard", "Moonlit Step", { ae_lifetime_mode: "target_turn_start", ae_duration_rounds: "1" }),
  { effect_label: "ms_clear", effect_kind: "chain", chain_steps: "ms_drop, ms_unguard" },
  removeAe("ms_unguard", "Moonlit Step"),
];
// 3-Piece Waltz — the counter (no cap) and its Thrown damage.
const MD3_RC = [
  rc("creature_performs_action", "wz_gain", { condition_formula: DIFFERS }),
  rc("creature_performs_action", "wz_reset", { condition_formula: `${REPEATS} && AE_CHARGES_WALTZ_POINT > 0` }),
  rc("turn_start", "wz_reset", { condition_formula: "AE_COUNT_DANCING == 0 && AE_CHARGES_WALTZ_POINT > 0" }),
  rc("creature_will_deal_damage", "wz_bonus", { condition_formula: "ACTION_IS_ATTACK == 1 && USED_WEAPON_CATEGORY_IS_THROWN == 1 && DAMAGE_IS_HP == 1 && AE_CHARGES_WALTZ_POINT > 0" }),
  rc("conflict_end", "wz_clear", { reaction_source: "" }),
];
const MD3_EFF = [
  applyAe("wz_gain", "Waltz Point", { ae_duplicate_mode: "add_charges", ae_initial_charges: "1", ae_initial_charges_max: "999" }),
  { effect_label: "wz_reset", effect_kind: "adjust_charges", charge_ae_name: "Waltz Point", charge_operation: "set", charge_amount: "0", target_ref: "self" },
  { effect_label: "wz_bonus", effect_kind: "adjust_damage", damage_stage: "outgoing", damage_operation: "add", damage_amount: "3 * AE_CHARGES_WALTZ_POINT" },
  removeAe("wz_clear", "Waltz Point"),
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const done = (doc) => !!doc?.getFlag?.(M, FLAG);
async function setTables(doc, rcRows, effRows, extra = {}) {
  // CSB dynamic tables deep-merge: null both first, then write the full key set.
  await doc.update({ "system.props.effect_table": null, "system.props.reaction_config_table": null });
  await doc.update({ "system.props.effect_table": table(effRows), "system.props.reaction_config_table": table(rcRows), "system.props.isReaction": true, ...extra });
}
async function putAe(doc, data) {
  const have = doc.effects.get(data._id) ?? doc.effects.find((e) => e.name === data.name);
  if (have) await have.delete();
  await doc.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
}
function cloneData(srcId, { id, name, container = null, folder = null, img = null, props = {}, effects = [] }) {
  const donor = game.items.get(srcId);
  if (!donor) throw new Error(`donor ${srcId} missing`);
  const d = donor.toObject();
  d._id = id; d.name = name; d.img = img ?? d.img; d.folder = folder; d.effects = effects;
  d.system.container = container; d.system.uniqueId = id;
  d.system.props = { ...d.system.props, ...props, name, id, uuid: `Item.${id}` };
  d.flags = { ...(d.flags ?? {}), [M]: { ...(d.flags?.[M] ?? {}), [FLAG]: "created" } };
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}
async function createIfMissing(data, out, label) {
  if (game.items.get(data._id)) { out.push(`= ${label}`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${label}`);
  return doc;
}
// Every copy: the world item + any actor / unlinked-token copy (by base name, refine prefix ignored).
const baseOf = (n) => String(n ?? "").replace(/^\+\d+\s+/, "").trim();
function copiesOf(name) {
  const res = [];
  const actors = [...game.actors];
  for (const sc of game.scenes) for (const t of sc.tokens) if (!t.actorLink && t.actor) actors.push(t.actor);
  for (const a of actors) {
    for (const it of a.items.filter((i) => !i.system?.container && baseOf(i.name) === name)) {
      if (a.isToken && !a.token?.delta?.items?.get(it.id)) continue; // inherited from the base actor
      res.push(it);
    }
  }
  return res;
}
const everyCopy = (id) => { const w = game.items.get(id); return w ? [w, ...copiesOf(w.name)] : []; };

// ── Piece specs ──────────────────────────────────────────────────────────────
const ET_COMMON = { item_rarity: "Rare", isSet: true, set_name: "Eternal Traveler", set_description: ET_SET_DESC };
const MD_COMMON = { item_rarity: "Rare", isSet: true, set_name: "Moonlight Dancer", set_description: MD_SET_DESC };
const PIECES = [
  { id: ID.knives, props: { ...ET_COMMON, description: ul(...TEXT.knives), item_cost: "1800" },
    ae: (img) => gearAe(ID.aeKnife, "Handy Knives — Counts As", img, [{ key: "weapon_category_alias", mode: 0, priority: 20, value: "dagger: sword, spear, thrown" }], "Handy Knives also count as a Sword, Spear or Thrown weapon.") },
  { id: ID.cloak, props: { ...ET_COMMON, description: ul(...TEXT.cloak), item_cost: "1800" },
    ae: (img) => gearAe(ID.aeCloak, "Traveler's Cloak — Hazards", img, [{ key: `flags.${M}.hazard_damage_reduction_pct`, mode: 2, priority: 20, value: "${isEquipped ? 50 : 0}$" }], "Field hazards deal 50% less damage to you.") },
  { id: ID.pack, props: { ...ET_COMMON, description: ul(...TEXT.pack), item_cost: "1800" },
    ae: (img) => gearAe(ID.aePack, "Traveler's Backpack — IP", img, [{ key: "ip_reduction_value", mode: 2, priority: 20, value: "${isEquipped ? 1 : 0}$" }], "Items you use cost 1 less IP (min 1).") },
  { id: ID.chakram, img: ICON.chakram, props: { ...MD_COMMON, description: ul(...TEXT.chakram), item_cost: "1800" }, passive: "chakram" },
  { id: ID.robe, img: ICON.robe, props: { ...MD_COMMON, description: ul(...TEXT.robe), item_cost: "2700" }, passive: "robe" },
  { id: ID.ornament, img: ICON.ornament, props: { ...MD_COMMON, description: ul(...TEXT.ornament), item_cost: "1320" },
    ae: (img) => gearAe(ID.aeOrn, "Moon Dancer Ornament — Trade", img, [{ key: "status_trade", mode: 0, priority: 20, value: "Slow>Swift,Dazed>Focus,Weak>Strong,Shaken>Energized" }], "Would-be Slow / Dazed / Weak / Shaken is blocked by spending Swift / Focus / Strong / Energized.") },
];

async function authorPiece(piece, doc, out) {
  const where = doc.parent ? `${doc.parent.name}: ${doc.name}` : doc.name;
  if (done(doc)) { out.push(`= ${where}`); return; }
  const patch = { [`flags.${M}.${FLAG}`]: true };
  for (const [k, v] of Object.entries(piece.props)) patch[`system.props.${k}`] = v;
  if (piece.img) patch.img = piece.img;
  await doc.update(patch);
  if (piece.ae) await putAe(doc, piece.ae(piece.img ?? doc.img));
  out.push(`~ ${where}`);
}

// Gear passives (world items only — no actor holds a Moonlight Dancer piece).
async function authorPassives(out) {
  const specs = [
    { kind: "chakram", id: ID.chakPsv, parent: ID.chakram, name: "Moon Dancer Chakram (Passive)", rc: CHAK_RC, eff: CHAK_EFF, text: TEXT.chakram.slice(1), effects: [] },
    { kind: "robe", id: ID.robePsv, parent: ID.robe, name: "Moonlight Dancer Robe (Passive)", rc: ROBE_RC, eff: ROBE_EFF, text: TEXT.robe,
      effects: [templAe(ID.aeEncore, "Encore", ICON.robe, [], "You already took Moonlight Dancer Robe's extra Dance this round.", { category: "Other" })] },
  ];
  for (const s of specs) {
    const parent = game.items.get(s.parent);
    if (!parent) { out.push(`! ${s.name}: parent missing`); continue; }
    const text = ul(...s.text);
    await createIfMissing(cloneData(PASSIVE_SHELL, {
      id: s.id, name: s.name, container: s.parent, folder: parent.folder?.id ?? MD_FOLDER, img: parent.img, effects: s.effects,
      props: { effect_table: table(s.eff), reaction_config_table: table(s.rc), description: text, skill_description: text, isReaction: true, skill_type: "Passive", skill_target: "Self", max_level: 1 },
    }), out, s.name);
  }
}

async function authorEtSet(out) {
  const set = game.items.get(ID.etSet);
  if (!set) { out.push("! Eternal Traveler set doc missing"); return; }
  if (!done(set)) {
    // 2pc rides a set-doc AE (resolveSetAe looks in the set doc's own effects first).
    await putAe(set, templAe(ID.aeRest, "Eternal Traveler: Rest", game.items.get(ID.pack)?.img ?? set.img,
      [{ key: `flags.${M}.rest_ip_recover_pct`, mode: 2, priority: 20, value: "50" }], "When you rest, recover 50% of your max IP, even outside town.", { category: "Other", directorPermanent: true }));
    await set.update({ "system.props.set_bonus_table": null });
    await set.update({
      "system.props.set_bonus_table": table([
        { pieces: "2", bonus_label: "Rest: recover 50% max IP, even outside town", bonus_ae_ref: "Eternal Traveler: Rest", bonus_skill_ref: "" },
        { pieces: "3", bonus_label: "Once per scene: free Item action", bonus_ae_ref: "", bonus_skill_ref: "Ready Pack" },
      ]),
      [`flags.${M}.${FLAG}`]: true,
    });
    out.push("~ Eternal Traveler set: 2-Piece rest AE + 3-Piece Ready Pack");
  }
  const rp = game.items.get(ID.readyPack);
  if (rp && !done(rp)) {
    const rows = foundry.utils.deepClone(rp.system.props.reaction_config_table ?? {});
    for (const r of Object.values(rows)) { r.reaction_max_per_round = "1"; r.reaction_max_scope = "battle"; }
    const text = ul(...TEXT.et3);
    await rp.update({ "system.props.reaction_config_table": null });
    await rp.update({ "system.props.reaction_config_table": rows, "system.props.description": text, "system.props.skill_description": text, [`flags.${M}.${FLAG}`]: true });
    out.push("~ Ready Pack: once per battle");
  }
}

async function authorMdSet(out) {
  const img = ICON.robe;
  const setData = cloneData(SET_DONOR, {
    id: ID.mdSet, name: "Moonlight Dancer — Equipment Set", folder: game.folders.get(MD_FOLDER) ? MD_FOLDER : null, img: "icons/svg/item-bag.svg",
    props: { isSet: false, set_name: "Moonlight Dancer", set_bonus_table: table([
      { pieces: "2", bonus_label: "Dance different from last turn: +2 DEF / M.DEF", bonus_ae_ref: "", bonus_skill_ref: "Moonlit Step" },
      { pieces: "3", bonus_label: "Waltz Points: +3 Thrown damage each", bonus_ae_ref: "", bonus_skill_ref: "Waltz" },
    ]) },
  });
  await createIfMissing(setData, out, "Moonlight Dancer — Equipment Set");
  const skill = (id, name, rcRows, effRows, text, effects) => cloneData(PASSIVE_SHELL, {
    id, name, container: ID.mdSet, folder: game.folders.get(MD_FOLDER) ? MD_FOLDER : null, img, effects,
    props: { effect_table: table(effRows), reaction_config_table: table(rcRows), description: ul(...text), skill_description: ul(...text), isReaction: true, skill_type: "Passive", skill_target: "Self", max_level: 1 },
  });
  await createIfMissing(skill(ID.mdT2, "Moonlit Step", MD2_RC, MD2_EFF, TEXT.md2, [
    templAe(ID.aeLtd, "Last Turn Dance", img, [], "The Dance you performed last turn (Moonlight Dancer).", { category: "Other" }),
    templAe(ID.aeGuard, "Moonlit Step", img, [
      { key: "bonus_defense", mode: 2, priority: 20, value: "2" },
      { key: "bonus_magic_defense", mode: 2, priority: 20, value: "2" },
    ], "+2 DEF and +2 M.DEF until the start of your next turn.", { category: "buff" }),
  ]), out, "2-Piece Moonlit Step");
  await createIfMissing(skill(ID.mdT3, "Waltz", MD3_RC, MD3_EFF, TEXT.md3, [
    templAe(ID.aeWaltz, "Waltz Point", img, [], "Thrown weapons deal +3 damage per Waltz Point.",
      { category: "Other", chargeKey: "waltz", charges: 0, chargesMax: 999, lifetimeMode: "persistent_counter", hudResourceColor: "#c9b6ff" }),
  ]), out, "3-Piece Waltz");
}

// Hunter Boots: same printed line as the Cloak, was text only.
async function authorHunterBoots(out) {
  for (const doc of everyCopy(ID.hunterBoots)) {
    if (doc.effects.get(ID.aeCloak)) { out.push(`= ${doc.parent ? doc.parent.name + ": " : ""}Hunter Boots`); continue; }
    await doc.createEmbeddedDocuments("ActiveEffect", [gearAe(ID.aeCloak, "Hunter Boots — Hazards", doc.img,
      [{ key: `flags.${M}.hazard_damage_reduction_pct`, mode: 2, priority: 20, value: "${isEquipped ? 50 : 0}$" }], "Hazards deal 50% less damage to you.")], { keepId: true });
    out.push(`~ ${doc.parent ? doc.parent.name + ": " : ""}Hunter Boots hazard AE`);
  }
}

// The Valley storm's Lightning Rod debuff counts as a field hazard.
async function tagLightningRod(out) {
  const lib = game.items.get(ID.debuffLib);
  const ae = lib?.effects?.find?.((e) => e.name === "Lightning Rod");
  if (!ae) { out.push("! Lightning Rod AE missing"); return; }
  const tags = new Set(Array.from(ae.system?.tags ?? []));
  if (tags.has("hazard")) { out.push("= Lightning Rod already a hazard"); return; }
  tags.add("hazard");
  await lib.updateEmbeddedDocuments("ActiveEffect", [{ _id: ae.id, "system.tags": [...tags] }]);
  out.push("~ Lightning Rod tagged hazard");
}

export async function migrate(game, log = () => {}) {
  const out = [];
  const api = await import("../scripts/battle-director/set-bonus.js").catch(() => null);
  const touched = new Set();
  for (const piece of PIECES) {
    for (const doc of everyCopy(piece.id)) {
      if (doc.parent && api?.withManagedEquip) {
        await api.withManagedEquip(doc.parent, () => authorPiece(piece, doc, out));
        touched.add(doc.parent);
      } else await authorPiece(piece, doc, out);
    }
  }
  await authorPassives(out);
  await authorEtSet(out);
  await authorMdSet(out);
  await authorHunterBoots(out);
  await tagLightningRod(out);
  // One reconcile per touched actor, after the set docs exist (piece edits schedule
  // the hooks' own debounced reconcile; withManagedEquip makes them stand down).
  for (const a of touched) {
    if (typeof api?.reconcileSetBonuses === "function") {
      try { await api.withManagedEquip(a, () => api.reconcileSetBonuses(a)); out.push(`~ reconciled ${a.name}`); }
      catch (e) { out.push(`! reconcile ${a.name}: ${e.message}`); }
    }
  }
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
