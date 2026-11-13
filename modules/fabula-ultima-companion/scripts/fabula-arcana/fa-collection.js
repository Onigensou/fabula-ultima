// scripts/fabula-arcana/fa-collection.js
// Card collection: a card is an item in a character's OWN inventory (the party bag does not count).
//   item: CSB "_Item Template", item_type "card", flags.<mod>.faCard = { cid }, carryLimit 1 (one copy per card).
// No world master items: a card item is built from the catalog when granted.

import { MODULE_ID, TAG, FLAG_CARD, GEAR_TEMPLATE, Catalog, Engine, artUrl, esc } from "./fa-const.js";

// Full CSB prop set of a plain key item (a partial set would leave template fields blank).
const BASE_PROPS = {
  active_effect_config_table: {}, aquatic_ef: "100", automaton_ef: "100", avian_ef: "100", beast_ef: "100", category: "", celestial_ef: "100",
  check_bonus: "0", construct_ef: "100", damage_bonus: "0", demiHuman_ef: "100", demon_ef: "100", description: "", dragon_ef: "100",
  elemental_ef: "100", enforcer_ef: "100", fey_ef: "100", flavor_text: "", flora_ef: "100", fungus_ef: "100", golem_ef: "100", gorger_ef: "100",
  hand_slots: "One-handed", human_ef: "100", humanoid_ef: "100", img: "", insect_ef: "100", ip_cost: "", isEquipped: false, isKey: false,
  isMartial: false, isModule: false, isRelatedItem: false, isSet: false, isUnique: true, item_baseDef: "0", item_baseMdef: "0", item_cost: "0",
  item_def_bonus: "0", item_mdef_bonus: "0", item_quantity: "1", item_rarity: "Common", item_type: "card", mimic_ef: "100", monster_ef: "100",
  name: "", optional_params: {}, plant_ef: "100", reptilian_ef: "100", rolled_atr1: "DEX", rolled_atr2: "DEX", set_name: "", soldier_ef: "100",
  spirit_ef: "100", type_damage: "Physical", undead_ef: "100", vehicle_ef: "100", weapon_range: "Melee",
};
const RARITY = { 1: "Common", 2: "Uncommon", 3: "Rare" };

export const cardName = (cid) => `${Catalog()?.CARDS?.[cid]?.name ?? cid} Card`;
export const cidOf = (item) => item?.flags?.[MODULE_ID]?.[FLAG_CARD]?.cid ?? null;
export const isCardItem = (item) => !!cidOf(item);

/** The card ids this actor owns (its own items only). */
export function ownedCards(actor) {
  const C = Catalog()?.CARDS ?? {};
  const out = [];
  for (const it of actor?.items?.contents ?? []) { const cid = cidOf(it); if (cid && C[cid] && !C[cid].retired && !out.includes(cid)) out.push(cid); }
  return out;
}

export function cardItemData(cid) {
  const C = Catalog(); const c = C?.CARDS?.[cid];
  if (!c) throw new Error(`${TAG} unknown card ${cid}`);
  const EL = C.EL ?? {};
  const stars = "★".repeat(c.cost);
  const description = `<p><strong>${esc(c.name)}</strong> · ${esc(EL[c.el] ?? c.el)} · ${stars} · ${esc(c.role)}</p>`
    + `<p>ATK ${c.atk} · HP ${c.hp} · DEF ${c.def} · SPD ${c.spd}</p>`
    + `<p><strong>${esc(c.ab)}:</strong> ${esc(c.txt)}</p>`
    + `<p><em>A Fabula Arcana card. Play it in a card duel at camp or against a challenger.</em></p>`;
  return {
    name: cardName(cid), type: "equippableItem", img: artUrl(cid),
    system: { template: GEAR_TEMPLATE, props: { ...BASE_PROPS, name: cardName(cid), img: artUrl(cid), description, item_rarity: RARITY[c.cost] ?? "Common" } },
    flags: { [MODULE_ID]: { [FLAG_CARD]: { cid }, carryLimit: 1 } },
  };
}

/** Give `actor` one copy of a card (no-op if it already has one). Returns { ok, created }. */
export async function grantCard(actor, cid) {
  if (!actor) return { ok: false, reason: "no-actor" };
  if (ownedCards(actor).includes(cid)) return { ok: true, created: false };
  await actor.createEmbeddedDocuments("Item", [cardItemData(cid)]);
  return { ok: true, created: true };
}

// Starter gift (Shipping Plan v1): top a character up to three common (★) cards so they can play.
const STARTER_POOL = ["pyrefly", "skizzik", "wolf", "salamander", "manaray", "hellhound", "scorpion", "archer", "obsidrax", "gorger", "sylph", "cryo"];
export async function grantStarter(actor, { rng = Math.random } = {}) {
  const owned = ownedCards(actor);
  const commons = owned.filter((cid) => Catalog()?.CARDS?.[cid]?.cost === 1);
  const need = Math.max(0, 3 - Math.max(commons.length, Engine()?.LEGAL_TEAMS?.some((t) => t.every((c) => owned.includes(c))) ? 3 : 0));
  const pool = STARTER_POOL.filter((cid) => !owned.includes(cid));
  const given = [];
  for (let i = 0; i < need && pool.length; i++) { const cid = pool.splice(Math.floor(rng() * pool.length), 1)[0]; await grantCard(actor, cid); given.push(cid); }
  if (given.length) console.log(TAG, `starter gift for ${actor.name}:`, given.join(", "));
  return given;
}

/** Can this owned set field a legal team? */
export const canPlay = (owned) => !!Engine()?.LEGAL_TEAMS?.some((t) => t.every((c) => owned.includes(c)));
