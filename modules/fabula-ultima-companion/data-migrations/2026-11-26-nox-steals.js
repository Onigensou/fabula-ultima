/**
 * Migration: 2026-11-26-nox-steals  (steal tables for the six Sealed Cavern Nox monsters)
 * ---------------------------------------------------------------------------
 * User-approved plan 2026-11-26. Before this, every Nox actor's steal table was a
 * single "(Empty) 100" row.
 *
 *   Monster           Empty  Material                          Consumable               Equipment
 *   Nox Ghoul           45   Rotten Nail 22 · Nox Cinder 13    Acid Flask 13            Old Bandages 7
 *   Nox Hound           46   Animal Fang 22 · Nox Cinder 14    Tincture of Strength 12  Bloodthirster 6
 *   Nox Wraith          44   Regret 22 · Nox Cinder 14         Tincture of Spirit 13    Soul Ring 7
 *   Nox Viper           45   Clear Liquid 22 · Nox Cinder 14   Poison 13                Gorgonis Shield 6
 *   Nox Priest (elite)  40   Torned Fabric 18 · Nox Cinder 14  Phoenix Feather 16       Shadow Grimoire 12
 *   Nox Executioner     40   Steel 18 · Nox Cinder 14          Tincture of Endurance 16 Dullahan Armor 12
 *
 * New world items:
 *   Dullahan Armor   Rare martial armor 3200z, DEF 13 / M.DEF 11. +5 damage to creatures with a
 *                    lower HP percentage than yours; -5 damage from them. The Dullahan FAMILY
 *                    drop (a future palette-swap Dullahan steals/drops the same item).
 *   Nox Cinder       Uncommon material 250z, not an ingredient; the Sealed Cavern signature.
 *
 * Authoring of existing gear the tables hand out (carrier-scan 2026-11-26 found the text unwired):
 *   Shadow Grimoire  "deals Magic Damage" → defense_target_type "mdef"; "Mana Burn" → action
 *                    keyword `mana burn` (engine: action-profile resourceForKeywords, same branch).
 *   Gorgonis Shield  "Resistance to Poison damage" → affinity_9 RS while equipped (Old Bandages AE).
 *   Bloodthirster    set_name "<Set Name>" clone leftover → "" (not a set item; isSet already false).
 *
 * The monster holds a plain shell copy of each loot (unequipped, no children) whose
 * _stats.compendiumSource points at the world item; a steal resolves to the world item
 * (skill-effects.js resolveStealSourceItem), so contained passives come with it.
 * Unlinked tokens whose delta overrides the steal props are updated the same way.
 *
 * SEED-ONLY: new documents use fixed ids ("NoxSt…") and are skipped when they exist; each
 * actor's steal-table step is gated by flags.fabula-ultima-companion.noxSteals.
 */

export const key = "2026-11-26-nox-steals";
export const description = "Nox Legion steal tables (6 monsters) + Dullahan Armor, Nox Cinder; authors Shadow Grimoire (Magic Damage, Mana Burn) and Gorgonis Shield (Poison RS).";

const M = "fabula-ultima-companion";
const FLAG = "noxSteals";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const EMPTY = "(Empty)";

const DONOR = {
  armor: "Y7JL7P9hbWipwb90",    // Dragonic Scalemail (martial armor, Armor DEF/MDEF effects)
  passive: "r5YlGxjwTfvpt5yM",  // Razor Plume (Passive) — passive shell
  material: "oAP85eeLJCliYm2E", // Animal Fang
};
const MATERIAL_FOLDER = "36rowiHAcXnIPsKK"; // 💎 Material

const ID = {
  armor: "NoxStDullahArm01", armorPsv: "NoxStDullahPsv01",
  cinder: "NoxStNoxCinder01",
  gorgonAe: "NoxStGorgPoisAE1",
};
const ICON = {
  // FF Brave Exvius "Dark Armor (Xenogears)": black plate with a jade tint (Nox palette).
  // The stored file name carries a literal "%28"/"%29", hence the double encoding.
  armor: FORGE + "Item%20Icon/Armor/FF%20Brave%20Exvius/Icon-Dark_Armor_%2528Xenogears%2529.webp",
  cinder: FORGE + "Item%20Icon/Material/Genshin/Item_Spectral_Husk.webp",
};

// Existing world items handed out (the copy other monsters' shells already point at).
const W = {
  rottenNail: "CCURf38oJpHYSifI", animalFang: "oAP85eeLJCliYm2E", regret: "D1UEXDIcjCsAs85o",
  clearLiquid: "NX83y58twFEzmOG1", tornedFabric: "dyKC4c96SNjnBlNg", steel: "dmiYBQ7BczRfTH1w",
  acidFlask: "BrvcVy625CHzhxzn", tStrength: "AUCB5IXRys9uxu5F", tSpirit: "2YYYYUAxJ2DPo6Lc",
  poison: "mw4wizzYTBtqsW8s", phoenix: "QXgHt7VEXEaVdPz1", tEndurance: "JtwSOvg8Y3U8oJI4",
  oldBandages: "z0uVJxJnpkrsViSG", bloodthirster: "jsT5SaI4Rj9WFW2a", soulRing: "VgaustkUmW90hgSl",
  gorgonis: "FbNEjOWpsDZGPmjR", grimoire: "IbVSfCGXPcZdZHHV",
};

// actorId → [code, rows]; a row is [world item id | EMPTY, percent]. Shell ids are
// "NoxStLoot" + code + slot ("Ma1" / "Ma2" / "Con" / "Eqp") + "01".
const TABLES = {
  HiIGOwMq8q57TeUh: ["Gh", "Nox Ghoul", [[EMPTY, 45], [W.rottenNail, 22, "Ma1"], [ID.cinder, 13, "Ma2"], [W.acidFlask, 13, "Con"], [W.oldBandages, 7, "Eqp"]]],
  RFnNMvI0AtMQpwuP: ["Hd", "Nox Hound", [[EMPTY, 46], [W.animalFang, 22, "Ma1"], [ID.cinder, 14, "Ma2"], [W.tStrength, 12, "Con"], [W.bloodthirster, 6, "Eqp"]]],
  CzQhpNYeo3ZI0TzH: ["Wr", "Nox Wraith", [[EMPTY, 44], [W.regret, 22, "Ma1"], [ID.cinder, 14, "Ma2"], [W.tSpirit, 13, "Con"], [W.soulRing, 7, "Eqp"]]],
  gXSRiFqgfMZkQnXr: ["Vp", "Nox Viper", [[EMPTY, 45], [W.clearLiquid, 22, "Ma1"], [ID.cinder, 14, "Ma2"], [W.poison, 13, "Con"], [W.gorgonis, 6, "Eqp"]]],
  QlhI0YQZ0uqRKTLb: ["Pr", "Nox Priest", [[EMPTY, 40], [W.tornedFabric, 18, "Ma1"], [ID.cinder, 14, "Ma2"], [W.phoenix, 16, "Con"], [W.grimoire, 12, "Eqp"]]],
  lCrB0iEWzPkNrzry: ["Ex", "Nox Executioner", [[EMPTY, 40], [W.steel, 18, "Ma1"], [ID.cinder, 14, "Ma2"], [W.tEndurance, 16, "Con"], [ID.armor, 12, "Eqp"]]],
};
const shellId = (code, slot) => `NoxStLoot${code}${slot}01`;

// ── Text (Genshin mode, Option A) ────────────────────────────────────────────
const ul = (...li) => `<ul>${li.map((t) => `<li><p>${t}</p></li>`).join("")}</ul>`;
const em = (t) => `<p><em>${t}</em></p>`;
const B = (s) => `<strong>${s}</strong>`;
const table = (rows) => Object.fromEntries(rows.map((r, i) => [String(i), r]));

const ARMOR_TEXT = ul(
  `Deal ${B("5")} extra damage to creatures with a lower HP percentage than yours.`,
  `Take ${B("5")} less damage from creatures with a lower HP percentage than yours.`,
);
const ARMOR_FLAVOR = em("Plate of the headless knights. It has no eyes, yet it always knows who is losing.");
const CINDER_FLAVOR = "A flake of green soulfire left where a Nox servant fell. Cold to the touch, and it never goes out.";

// ── Helpers (trio-elite-steals pattern) ──────────────────────────────────────
function cloneData(srcId, { id, name, container = null, img, props = {}, effects, folder, flags = {} } = {}) {
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
  d.effects = effects !== undefined ? effects : (d.effects ?? []);
  const mine = { ...(d.flags?.[M] ?? {}), ...flags, [FLAG]: "created" };
  delete mine.draftAutomation;
  d.flags = { ...(d.flags ?? {}), [M]: mine };
  delete d.flags.fucompanion; // item-migrator backup of the donor
  delete d._stats; delete d.sort; delete d.ownership;
  return d;
}
async function createIfMissing(data, out) {
  if (game.items.get(data._id)) { out.push(`= ${data.name} exists`); return game.items.get(data._id); }
  const [doc] = await Item.createDocuments([data], { keepId: true });
  out.push(`+ ${data.name} (${data._id})`);
  return doc;
}
const freshEffect = (base) => {
  const e = foundry.utils.deepClone(base);
  delete e._stats;
  if (e.flags?.["custom-system-builder"]) {
    delete e.flags["custom-system-builder"].originalId;
    delete e.flags["custom-system-builder"].originalParentId;
    delete e.flags["custom-system-builder"].originalUuid;
  }
  return e;
};

// ── Dullahan Armor ───────────────────────────────────────────────────────────
// HP percentages compared by cross-multiplying (no division; an unresolved creature
// reads 0/0 and fails closed). Strict "<": equal percentages (both full) give nothing.
const OUT_GATE = "DAMAGE_IS_HP == 1 && TARGET_CURRENT_HP * MAX_HP < CUR_HP * TARGET_MAX_HP";
const IN_GATE = "INCOMING_DAMAGE > 0 && ATTACKER_CURRENT_HP * MAX_HP < CUR_HP * ATTACKER_MAX_HP";

function armorData() {
  const donor = game.items.get(DONOR.armor);
  const keep = (donor?.effects?.contents ?? []).filter((e) => e.name === "Armor DEF" || e.name === "Armor MDEF").map((e) => freshEffect(e.toObject()));
  return cloneData(DONOR.armor, {
    id: ID.armor, name: "Dullahan Armor", img: ICON.armor, folder: donor?.folder?.id ?? null, effects: keep,
    flags: { monsterFamily: "dullahan" },
    props: {
      item_type: "armor", isMartial: true, item_baseDef: "13", item_baseMdef: "11", item_def_bonus: "0", item_mdef_bonus: "0",
      item_rarity: "Rare", item_cost: "3200", item_quantity: "1", isEquipped: false, isUnique: false,
      isSet: false, set_name: "", refine_level: "0", refine_count: "0",
      description: ARMOR_TEXT, flavor_text: ARMOR_FLAVOR,
    },
  });
}
function armorPassiveData() {
  return cloneData(DONOR.passive, {
    id: ID.armorPsv, name: "Dullahan Armor (Passive)", container: ID.armor, effects: [],
    flags: { monsterFamily: "dullahan" },
    props: {
      description: ARMOR_TEXT, skill_description: ARMOR_TEXT, isReaction: true, skill_type: "Passive", skill_target: "Self",
      effect_table: table([
        { effect_kind: "adjust_damage", effect_label: "dl_press", damage_stage: "outgoing", damage_operation: "add", damage_amount: "5" },
        { effect_kind: "adjust_damage", effect_label: "dl_guard", damage_stage: "incoming", damage_operation: "subtract", damage_amount: "5" },
      ]),
      reaction_config_table: table([
        // Per target: the row's condition runs once per target (subject = that target).
        { reaction_trigger: "creature_will_deal_damage", reaction_passive_mode: "force", reaction_source: "self",
          condition_formula: OUT_GATE, reaction_effect_ref: "dl_press" },
        // The attacker is attackerActorUuid here (the payload subject is the wearer).
        { reaction_trigger: "creature_targeted_by_action", reaction_passive_mode: "force", reaction_source: "self",
          condition_formula: IN_GATE, reaction_effect_ref: "dl_guard" },
      ]),
    },
  });
}

// ── Nox Cinder ───────────────────────────────────────────────────────────────
function cinderData() {
  return cloneData(DONOR.material, {
    id: ID.cinder, name: "Nox Cinder", img: ICON.cinder, folder: MATERIAL_FOLDER, effects: [],
    props: {
      item_type: "material", item_rarity: "Uncommon", item_cost: "250", item_quantity: "1",
      isIngredient: false, ingredient_taste: "", ingredient_taste2: "",
      description: em(CINDER_FLAVOR), flavor_text: "",
    },
  });
}

// ── Authoring existing gear ──────────────────────────────────────────────────
async function authorExisting(out) {
  const grim = game.items.get(W.grimoire);
  if (grim && !grim.getFlag(M, FLAG)) {
    const kw = String(grim.system?.props?.action_keywords ?? "").split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!kw.some((k) => /^mana[\s_]?burn$/i.test(k))) kw.push("mana burn");
    await grim.update({ "system.props.defense_target_type": "mdef", "system.props.action_keywords": kw.join(", "), [`flags.${M}.${FLAG}`]: "authored" });
    out.push("~ Shadow Grimoire: Magic Damage (mdef) + Mana Burn keyword");
  } else out.push(grim ? "= Shadow Grimoire already authored" : "! Shadow Grimoire missing");

  const gorg = game.items.get(W.gorgonis);
  if (gorg && !gorg.effects.get(ID.gorgonAe)) {
    await gorg.createEmbeddedDocuments("ActiveEffect", [{
      _id: ID.gorgonAe, name: "Gorgonis Shield", img: gorg.img, transfer: true, disabled: false, statuses: [],
      description: "", duration: {}, origin: null, sort: 0, tint: "#ffffff", type: "base", system: {},
      changes: [{ key: "affinity_9", mode: 5, priority: 1, value: "${isEquipped ? 'RS' : 'NA'}$" }],
      flags: { "custom-system-builder": { isFromTemplate: false }, [M]: { [FLAG]: "ae" } },
    }], { keepId: true });
    out.push("+ Gorgonis Shield: Poison RS AE");
  } else out.push(gorg ? "= Gorgonis Shield AE exists" : "! Gorgonis Shield missing");

  const bt = game.items.get(W.bloodthirster);
  if (bt && bt.system?.props?.set_name === "<Set Name>") {
    await bt.update({ "system.props.set_name": "" });
    out.push("~ Bloodthirster: cleared <Set Name> placeholder");
  }
}

// ── Steal tables ─────────────────────────────────────────────────────────────
function stealPatch(actor, actorId, code, rows) {
  const p = actor.system?.props ?? {};
  const patch = {};
  const tbl = [];
  for (const [ref, pct, slot] of rows) {
    if (ref === EMPTY) { tbl.push({ $deleted: false, loot_id: EMPTY, loot_percentage: String(pct) }); continue; }
    const item = game.items.get(ref);
    const sid = shellId(code, slot);
    patch[`system.props.stealable_loot.${sid}`] = {
      id: "${item.id}", name: item.name, roll: "",
      loot_description: item.system?.props?.description ?? "",
      uuid: `Actor.${actorId}.Item.${sid}`,
    };
    tbl.push({ $deleted: false, loot_id: item.name, loot_percentage: String(pct) });
  }
  // Delete every old row key past the new length, then write the rows outright.
  for (const k of Object.keys(p.steal_percentage_table ?? {})) if (Number(k) >= tbl.length) patch[`system.props.steal_percentage_table.-=${k}`] = null;
  tbl.forEach((r, i) => { patch[`system.props.steal_percentage_table.${i}`] = r; });
  return patch;
}
async function wireSteals(out) {
  for (const [actorId, [code, label, rows]] of Object.entries(TABLES)) {
    const actor = game.actors.get(actorId);
    if (!actor) { out.push(`! ${label}: actor missing`); continue; }
    const sum = rows.reduce((s, r) => s + r[1], 0);
    if (sum !== 100) { out.push(`! ${label}: rows sum to ${sum}, skipped`); continue; }
    const missing = rows.filter(([ref]) => ref !== EMPTY && !game.items.get(ref));
    if (missing.length) { out.push(`! ${label}: world item(s) missing ${missing.map((r) => r[0]).join(", ")}`); continue; }
    const shells = [];
    for (const [ref, , slot] of rows) {
      if (ref === EMPTY) continue;
      const sid = shellId(code, slot);
      if (actor.items.get(sid)) continue;
      const d = game.items.get(ref).toObject();
      d._id = sid;
      d.system.container = null;
      d.system.props.isEquipped = false;
      d.system.props.item_quantity = "1";
      d._stats = { ...(d._stats ?? {}), compendiumSource: `Item.${ref}` };
      shells.push(d);
    }
    if (shells.length) {
      await actor.createEmbeddedDocuments("Item", shells, { keepId: true });
      out.push(`+ ${label}: ${shells.length} loot shell(s)`);
    }
    if (actor.getFlag(M, FLAG)) { out.push(`= ${label}: steal table already set`); continue; }
    await actor.update(stealPatch(actor, actorId, code, rows));
    await actor.setFlag(M, FLAG, true);
    out.push(`~ ${label}: steal table ${rows.map(([ref, pct]) => `${ref === EMPTY ? EMPTY : game.items.get(ref).name} ${pct}`).join(" / ")}`);
    for (const scene of game.scenes ?? []) {
      for (const t of scene.tokens ?? []) {
        if (t.actorLink || t.actorId !== actorId || !t.actor) continue;
        const dp = t.delta?.system?.props ?? {};
        if (dp.stealable_loot === undefined && dp.steal_percentage_table === undefined) continue;
        await t.actor.update(stealPatch(t.actor, actorId, code, rows));
        out.push(`~ ${scene.name} / ${t.name}: token steal props synced`);
      }
    }
  }
}

export async function migrate(game, log = () => {}) {
  const out = [];
  await createIfMissing(armorData(), out);
  await createIfMissing(armorPassiveData(), out);
  await createIfMissing(cinderData(), out);
  try { game.items.get(ID.armor)?.prepareData?.(); } catch { /* next load re-derives */ }
  await authorExisting(out);
  await wireSteals(out);
  for (const l of out) log(l);
  return { applied: true, summary: out.join(" | ") };
}
