// Party Menu — inventories, equipment, status and party setup (data layer).
//
// Inventories are the documents the game already keeps:
//   - each character's own carried items  (their actor's embedded items)
//   - the party's shared bag               (the party database actor's embedded items —
//                                           where treasure chests and auto-routed loot land)
// Nothing here invents a new store. Moves go through ItemTransferCore (stacking,
// sub-item trees), equipping goes through equipment-swap's applyEquipmentSwap
// (slot props, AE enable, set bonuses) — the same writers the rest of the game uses.
//
// Who may move what (enforced on the acting GM, which performs every move):
//   GM      → anything between party bags.
//   player  → out of a character they own (to any party bag), or out of the
//             shared bag (to any party member — handing out shared loot is
//             fine). Never out of a teammate's character — that is a trade.
//             Needs the Item command granted, and no conflict running.
// Every move runs on the acting GM, one at a time: players own the shared bag,
// so two players taking from one stack locally would both read the same
// quantity and mint an extra copy.

import { registerHandler, request, installNet, isActingGM } from "../advancement/advancement-net.js";
import { canUseCommand } from "./party-menu-access.js";
import { gatherHealingActions } from "../healing-system/healing-actions.js";
import {
  getPartyRoster, actorFromRef, ACTIVE_SLOTS, BENCH_SLOTS, AWAY_SLOTS, MODULE_ID,
} from "./party-menu-core.js";
import {
  gatherEquipmentSlots, canEquip, applyEquipmentSwap, syncItemEffectsToEquip,
} from "../battle-director/equipment-swap.js";

const TAG = "[PartyMenu]";
const log = (...a) => console.log(TAG, ...a);
const NS = MODULE_ID;

const GEAR_TEMPLATE = "ZoiV53VaLzeRsEps";
const GEAR_TYPES = new Set(["weapon", "armor", "shield", "accessory"]);

const MSG = {
  MOVE_REQ: "partyMenu.moveItem.req",
  MOVE_RES: "partyMenu.moveItem.res",
};

const str = (v) => String(v ?? "").trim();
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── items ─────────────────────────────────────────────────────────────────────

/** Item types in display order. */
export const ITEM_TYPES = {
  consumable: { order: 0, label: "Consumables", icon: "fa-flask" },
  weapon: { order: 1, label: "Weapons", icon: "fa-khanda" },
  shield: { order: 2, label: "Shields", icon: "fa-shield" },
  armor: { order: 3, label: "Armor", icon: "fa-shirt" },
  accessory: { order: 4, label: "Accessories", icon: "fa-ring" },
  recipe: { order: 5, label: "Recipes", icon: "fa-scroll" },
  material: { order: 6, label: "Materials", icon: "fa-gem" },
  key: { order: 7, label: "Key Items", icon: "fa-key" },
  other: { order: 8, label: "Other", icon: "fa-box" },
};

export const ITEM_FILTERS = [
  { id: "all", label: "All", icon: "fa-layer-group" },
  { id: "consumable", label: "Items", icon: "fa-flask" },
  { id: "gear", label: "Gear", icon: "fa-shield-halved" },
  { id: "recipe", label: "Recipe", icon: "fa-scroll" },
  { id: "material", label: "Material", icon: "fa-gem" },
  { id: "key", label: "Key", icon: "fa-key" },
];

export function itemType(item) {
  const t = str(item?.system?.props?.item_type).toLowerCase();
  return ITEM_TYPES[t] ? t : "other";
}

/**
 * A carried item shown in an inventory: the gear/carry template, not a CSB
 * sub-item of another item on the same actor (those travel with their parent),
 * and not one a skill has hidden until the battle ends.
 */
export function isInventoryItem(item) {
  if (str(item?.system?.template) !== GEAR_TEMPLATE) return false;
  if (item.flags?.[NS]?.hiddenUntilBattleEnd) return false;
  const holder = str(item.system?.container);
  if (holder && holder !== "-" && item.parent?.items?.get(holder)) return false;
  return true;
}

export function inventoryOf(actor) {
  return (actor?.items?.contents ?? []).filter(isInventoryItem);
}

export function itemMatchesFilter(item, filter) {
  if (filter === "all") return true;
  const t = itemType(item);
  if (filter === "gear") return GEAR_TYPES.has(t);
  return t === filter;
}

/** Sorted the way the list shows it: by type section, then name. */
export function sortedInventory(actor, filter = "all") {
  return inventoryOf(actor)
    .filter((it) => itemMatchesFilter(it, filter))
    .sort((a, b) => ITEM_TYPES[itemType(a)].order - ITEM_TYPES[itemType(b)].order || a.name.localeCompare(b.name));
}

export function quantityOf(item) {
  return num(item?.system?.props?.item_quantity, 1);
}

// Worn ids per actor, memoised for the current synchronous pass (one render
// asks for every row) and dropped on the next microtask.
const _worn = new Map();
function wornIds(actor) {
  let hit = _worn.get(actor.id);
  if (hit) return hit;
  hit = new Set(equipSlotsOf(actor).map((s) => s.item?.id).filter(Boolean));
  _worn.set(actor.id, hit);
  queueMicrotask(() => _worn.delete(actor.id));
  return hit;
}

/**
 * Worn on a CHARACTER, read from the SLOTS (main_hand / off_hand / accessory
 * names, and the armor's own flag) — the source of truth the sheet and the
 * attack resolver use. `isEquipped` alone can drift from the slots (see
 * equipment-swap reconcileEquip). A party-bag copy is never worn.
 */
export function isWorn(item, roster) {
  if (!GEAR_TYPES.has(itemType(item)) || !item.parent) return false;
  if (roster?.db && item.parent.id === roster.db.id) return false;
  return wornIds(item.parent).has(item.id);
}

export function itemSummary(item) {
  const p = item?.system?.props ?? {};
  const t = itemType(item);
  const signed = (v) => { const n = num(v, 0); return n ? `${n > 0 ? "+" : ""}${n}` : ""; };
  const facts = [["Type", ITEM_TYPES[t].label.replace(/s$/, "")]];
  if (t === "weapon") {
    const a1 = str(p.rolled_atr1).toUpperCase(), a2 = str(p.rolled_atr2).toUpperCase();
    facts.push(["Category", str(p.category)], ["Hands", str(p.hand_slots)], ["Range", str(p.weapon_range)],
      ["Accuracy", a1 && a2 ? `【${a1} + ${a2}】${signed(p.check_bonus)}` : ""],
      ["Damage", `HR ${signed(p.damage_bonus) || "+0"} ${str(p.type_damage)}`.trim()]);
  }
  if (t === "armor" || t === "shield") {
    const def = p.isMartial && t === "armor" ? str(p.item_baseDef) : signed(p.item_def_bonus);
    const mdef = p.isMartial && t === "armor" ? str(p.item_baseMdef) : signed(p.item_mdef_bonus);
    facts.push(["DEF", def], ["M.DEF", mdef]);
  }
  if (p.isMartial) facts.push(["Martial", "Yes"]);
  facts.push(["Rarity", str(p.item_rarity)], ["Cost", num(p.item_cost, 0) ? `${num(p.item_cost)} z` : ""],
    ["IP", num(p.ip_cost, 0) ? String(num(p.ip_cost)) : ""], ["Set", str(p.set_name)]);
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    img: item.img || "icons/svg/item-bag.svg",
    type: t,
    qty: quantityOf(item),
    description: str(p.description),
    setDescription: str(p.set_description),
    // "<Set Name>" is the template's placeholder, not a value.
    facts: facts.filter(([, v]) => v !== "" && v !== "-" && v != null && !/^<[^>]*>$/.test(String(v))),
  };
}

// ── bags ──────────────────────────────────────────────────────────────────────

/** The shared bag first, then the active party, then the reserve. */
export function bagsOf(roster) {
  const out = [];
  if (roster?.db) out.push({ actor: roster.db, kind: "party", label: "Party Bag" });
  for (const a of roster?.active ?? []) out.push({ actor: a, kind: "member", label: a.name });
  for (const a of roster?.reserve ?? []) out.push({ actor: a, kind: "reserve", label: a.name });
  return out;
}

const owns = (actor, user) => !!actor?.testUserPermission?.(user, "OWNER");

/**
 * A conflict is running. The Battle Director keeps no Foundry Combat document,
 * so `game.combat` misses it; its `directorState` scene flag is the cross-client
 * signal (same reading as clock-interaction's directorConflictLive). Every scene
 * is checked: the acting GM may be looking at a different one than the player.
 */
export function conflictLive() {
  try {
    if (game.combat?.started) return true;
    if (globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.()) return true;
    return (game.scenes?.contents ?? []).some((sc) => {
      const st = sc.getFlag?.(NS, "directorState");
      return !!(st?.dCombat?.started && !st.dCombat.ended);
    });
  } catch { return false; }
}

/** Players do not reorganise gear mid-conflict; the GM can. */
export function combatLock(user = game.user) {
  return !user?.isGM && conflictLive();
}

/**
 * Why `user` may not move `item` from `src` to `dst`, or "".
 * Shared by the menu (to dim actions) and the GM handler (to enforce them).
 */
export function moveRefusal({ user, item, src, dst, roster }) {
  if (!src || !dst) return "no-bag";
  if (src.id === dst.id) return "same-bag";
  const bags = bagsOf(roster).map((b) => b.actor.id);
  if (!bags.includes(src.id) || !bags.includes(dst.id)) return "not-in-party";
  if (!item || item.parent?.id !== src.id) return "item-gone";
  if (!isInventoryItem(item)) return "not-an-item";
  if (isWorn(item, roster)) return "equipped";
  if (user?.isGM) return "";
  if (!canUseCommand("item", user)) return "not-granted";
  if (combatLock(user)) return "in-combat";
  if (owns(src, user)) return "";
  const fromShared = src.id === roster.db?.id;
  const partyPlayer = [...roster.active, ...roster.reserve].some((a) => owns(a, user));
  if (fromShared && (owns(dst, user) || partyPlayer)) return "";
  return "not-yours";
}

/** Move `qty` of `item` from `src` to `dst`, performed by the acting GM. */
export async function moveItem(item, src, dst, qty = 1) {
  const roster = await getPartyRoster();
  const refusal = moveRefusal({ user: game.user, item, src, dst, roster });
  if (refusal) return { ok: false, reason: refusal };
  return request(MSG.MOVE_REQ, {
    itemUuid: item.uuid, srcUuid: src.uuid, dstUuid: dst.uuid,
    qty: Math.max(1, Math.floor(num(qty, 1))), requesterUserId: game.user.id,
  });
}

// One move at a time on the acting GM: the socket handler is otherwise free to
// interleave two requests against the same stack.
let _moveChain = Promise.resolve();
function performMove(payload) {
  const run = _moveChain.then(() => performMoveNow(payload)).catch((e) => {
    console.error(TAG, "move failed", e);
    // A thrown transfer must still ANSWER, or the player waits out the relay
    // timeout and is told no GM is online.
    return { ok: false, reason: "transfer-failed" };
  });
  _moveChain = run.then(() => {}, () => {});
  return run;
}

async function performMoveNow(payload) {
  const user = game.users?.get(payload?.requesterUserId);
  const [item, src, dst] = await Promise.all([payload?.itemUuid, payload?.srcUuid, payload?.dstUuid]
    .map((u) => fromUuid(str(u)).catch(() => null)));
  const roster = await getPartyRoster();
  const refusal = moveRefusal({ user, item, src, dst, roster });
  if (refusal) return { ok: false, reason: refusal };
  const ITC = globalThis["oni.ItemTransferCore"];
  if (!ITC?.transfer) return { ok: false, reason: "no-transfer-core" };

  const qty = Math.min(Math.max(1, Math.floor(num(payload.qty, 1))), quantityOf(item));
  const name = item.name;
  const res = await ITC.transfer({
    mode: "actorToActor",
    itemUuid: item.uuid,
    quantity: qty,
    senderActorUuid: src.uuid,
    receiverActorUuid: dst.uuid,
    requestedByUserId: user?.id,
    // Handing something to a teammate tells them; tidying your own bag doesn't.
    showTransferCard: dst.id !== roster.db?.id && !owns(dst, user),
  });
  if (!res?.ok) return { ok: false, reason: res?.reason ?? "transfer-failed" };

  // A copy that left a party bag with a stale `isEquipped` must not arrive
  // "worn" on a character whose slot props don't name it (and with its
  // transfer AEs live).
  const got = res.receiver?.itemUuid ? await fromUuid(res.receiver.itemUuid).catch(() => null) : null;
  if (got && dst.id !== roster.db?.id && got.system?.props?.isEquipped === true) {
    await got.update({ "system.props.isEquipped": false });
    await syncItemEffectsToEquip(got);
  }
  log(`${user?.name ?? "?"}: ${res.transferredQty}× ${name} · ${src.name} → ${dst.name}`);
  return { ok: true, qty: res.transferredQty, name };
}

registerHandler(MSG.MOVE_REQ, MSG.MOVE_RES, performMove);

// ── using an item ─────────────────────────────────────────────────────────────
//
// Outside a conflict the game has ONE consume-and-apply path for items: the
// out-of-combat Healing HUD (HP/MP/IP restoratives and cleansers, GM-relayed).
// "Use" hands the item to it; anything else (a Polymorph Potion, an Elemental
// Shard) is a battle action and says so. No second item engine is built here.

/** Why `user` can't start using `item` from this bag, or "". Cheap; no item lookup. */
export function useRefusal({ user = game.user, item, roster }) {
  if (!item || itemType(item) !== "consumable") return "not-consumable";
  const owner = item.parent;
  if (!owner || owner.id === roster?.db?.id) return "in-party-bag";
  // The Healing HUD's target grid is the ACTIVE party; a reserve caster could not
  // even target themselves there.
  if (!(roster?.active ?? []).some((a) => a.id === owner.id)) return "not-active";
  if (!(user?.isGM || owns(owner, user))) return "not-yours";
  if (!user?.isGM && !canUseCommand("item", user)) return "not-granted";
  if (conflictLive()) return "in-combat-use";
  if (!item.system?.props?.isUnique && quantityOf(item) <= 0) return "none-left";
  return "";
}

/**
 * Open the Healing HUD on `item`, armed. `{ ok:false, reason:"battle-only" }`
 * when the HUD has no use for it (it is used through the Battle Director).
 */
export async function useItem(item) {
  const roster = await getPartyRoster();
  const refusal = useRefusal({ item, roster });
  if (refusal) return { ok: false, reason: refusal };
  const owner = item.parent;
  const actions = await gatherHealingActions(owner);
  const usable = Object.values(actions).flat().some((d) => d.consumableUuid === item.uuid);
  if (!usable) return { ok: false, reason: "battle-only" };
  const api = globalThis.FUCompanion?.api?.healing;
  if (!api?.open) return { ok: false, reason: "no-healing-hud" };
  return { ok: true, open: () => api.open({ casterActorId: owner.id, focusItemUuid: item.uuid }) };
}

// ── equipment ─────────────────────────────────────────────────────────────────

const SLOT_ORDER = ["main", "off", "armor", "accessory1", "accessory2"];
const SLOT_ICONS = { main: "fa-khanda", off: "fa-shield", armor: "fa-shirt", accessory1: "fa-ring", accessory2: "fa-ring" };

/** The five worn slots with what each holds (read off the actor's slot props). */
export function equipSlotsOf(actor) {
  const { slots } = gatherEquipmentSlots(actor, { includeArmor: true });
  return SLOT_ORDER.map((k) => slots.find((s) => s.key === k)).filter(Boolean).map((s) => ({
    key: s.key,
    label: s.label,
    icon: SLOT_ICONS[s.key],
    item: s.currentItemId ? actor.items.get(s.currentItemId) ?? null : null,
    candidateIds: s.candidates.map((c) => c.id),
  }));
}

const isTwoHanded = (item) => itemType(item) === "weapon"
  && str(item?.system?.props?.hand_slots).toLowerCase().includes("two");

/** Candidates for one slot: `{ item, check:{ok,reason}, wornIn }`, wearable first. */
export function equipCandidates(actor, slotKey) {
  const slots = equipSlotsOf(actor);
  const slot = slots.find((s) => s.key === slotKey);
  if (!slot) return [];
  return slot.candidateIds.map((id) => actor.items.get(id)).filter(Boolean).map((item) => {
    const other = slots.find((s) => s.key !== slotKey && s.item?.id === item.id);
    return { item, check: canEquip(actor, item, slotKey), wornIn: other?.label ?? "" };
  }).sort((a, b) => (b.check.ok - a.check.ok) || a.item.name.localeCompare(b.item.name));
}

export function equipRefusal(actor, user = game.user) {
  if (!actor) return "no-actor";
  if (!canUseCommand("equip", user)) return "not-granted";
  if (!(user?.isGM || owns(actor, user))) return "not-owner";
  if (combatLock(user)) return "in-combat";
  return "";
}

/**
 * Put `itemId` (or nothing) in `slotKey`. Builds the whole loadout from the
 * current slots and commits it through applyEquipmentSwap — the treasure
 * roulette pattern — so slot props, isEquipped, AEs and set bonuses move together.
 */
export async function setEquipSlot(actor, slotKey, itemId) {
  const refusal = equipRefusal(actor);
  if (refusal) return { ok: false, reason: refusal };
  const r = equipSelection(actor, slotKey, itemId);
  if (!r.ok) return r;
  const res = await applyEquipmentSwap(actor, r.sel, { allowArmor: true });
  return { ok: true, changes: res?.changes ?? [] };
}

/**
 * The whole loadout after putting `itemId` (or nothing) in `slotKey`, as the
 * `selections` applyEquipmentSwap takes — shared by the commit above and the
 * equip comparison (party-menu-gear-preview.js), so both mean the same swap.
 */
export function equipSelection(actor, slotKey, itemId) {
  const slots = equipSlotsOf(actor);
  if (!slots.some((s) => s.key === slotKey)) return { ok: false, reason: "no-such-slot" };
  const item = itemId ? actor.items.get(itemId) : null;
  if (itemId) {
    if (!item || !slots.find((s) => s.key === slotKey).candidateIds.includes(itemId)) return { ok: false, reason: "not-a-candidate" };
    const check = canEquip(actor, item, slotKey);
    if (!check.ok) return { ok: false, reason: "cannot-equip", detail: check.reason };
  }
  const sel = Object.fromEntries(slots.map((s) => [s.key, s.item?.id ?? null]));
  if (item) for (const k of Object.keys(sel)) if (sel[k] === item.id) sel[k] = null;   // one item, one slot
  sel[slotKey] = item?.id ?? null;
  if (slotKey === "main" && isTwoHanded(item)) sel.off = null;
  return { ok: true, sel };
}

// ── status ────────────────────────────────────────────────────────────────────

const ELEMENTS = ["physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"];

export function statusOf(actor) {
  const p = actor?.system?.props ?? {};
  const attr = (k) => ({ cur: num(p[`${k}_current`], num(p[`${k}_base`])), base: num(p[`${k}_base`]) });
  const classes = Object.values(p.class_list ?? {})
    .filter((r) => r && !r.$deleted && str(r.class_name))
    .map((r) => ({ name: str(r.class_name), level: num(r.level) }));
  const bonds = [1, 2, 3, 4, 5, 6].map((i) => str(p[`bond_${i}`])).filter(Boolean);
  const effects = [...(actor?.appliedEffects ?? [])]
    .filter((e) => !e.disabled && !e.flags?.[NS]?.hidden)
    .map((e) => ({ id: e.id, name: e.name, img: e.img || e.icon || "icons/svg/aura.svg", description: str(e.description) }));
  return {
    identity: str(p.char_identity), theme: str(p.theme), origin: str(p.origin),
    level: num(p.level), exp: num(p.experience), zenit: num(p.zenit),
    attrs: { DEX: attr("dex"), INS: attr("ins"), MIG: attr("mig"), WLP: attr("wlp") },
    def: num(p.defense, NaN), mdef: num(p.magic_defense, NaN),
    // Signed, added — the sheet's own Initiative roll is `D1 + D2 + init_penalty`
    // and actors store armor penalties as negatives (Steel Plate −4).
    init: num(p.check_mod_init) + num(p.init_penalty),
    affinities: ELEMENTS.map((el, i) => ({ el, v: str(p[`affinity_${i + 1}`]) || "NA" })),
    classes, bonds, effects,
  };
}

// ── setup (GM) ────────────────────────────────────────────────────────────────

export const ROSTER_GROUPS = [
  { kind: "member", label: "Active", n: ACTIVE_SLOTS },
  { kind: "bench", label: "Reserve", n: BENCH_SLOTS },
  { kind: "away", label: "Away", n: AWAY_SLOTS },
];

/** Every roster slot on the party database, in group order. */
export function rosterSlots(db) {
  const p = db?.system?.props ?? {};
  const out = [];
  for (const g of ROSTER_GROUPS) {
    for (let i = 1; i <= g.n; i++) {
      const ref = str(p[`${g.kind}_id_${i}`]);
      out.push({ kind: g.kind, group: g.label, slot: i, ref, actor: actorFromRef(ref) });
    }
  }
  return out;
}

/** Actors the GM can seat in the party: player characters, not system actors. */
export function rosterCandidates(db) {
  return (game.actors?.contents ?? []).filter((a) => {
    if (a.type !== "character" || a.id === db?.id) return false;
    const p = a.system?.props ?? {};
    if (p.isParty_boolean === true || str(p.isParty_boolean) === "true" || "game_id" in p) return false;
    const f = a.flags?.[NS] ?? {};
    return !(f.isField || f.isPersistentSummon || f.bdGuest);
  });
}

/**
 * GM only. Seat `actor` (or nobody) in `kind`/`slot`. An actor already seated
 * elsewhere is moved, never duplicated. Writes the same `*_id_N` slot the CSB
 * sheet edits by hand, then lets party-sync refresh the mirrored fields.
 */
export async function setRosterSlot(kind, slot, actor) {
  if (!game.user?.isGM) return { ok: false, reason: "not-gm" };
  const roster = await getPartyRoster();
  const db = roster.db;
  if (!db) return { ok: false, reason: "no-db" };
  const g = ROSTER_GROUPS.find((x) => x.kind === kind);
  if (!g || slot < 1 || slot > g.n) return { ok: false, reason: "no-such-slot" };
  if (actor && !rosterCandidates(db).includes(actor)) return { ok: false, reason: "bad-target" };
  const upd = {};
  if (actor) {
    for (const s of rosterSlots(db)) {
      if (s.actor?.id === actor.id && !(s.kind === kind && s.slot === slot)) {
        upd[`system.props.${s.kind}_id_${s.slot}`] = "";
        upd[`system.props.${s.kind}_name_${s.slot}`] = "";
      }
    }
  }
  upd[`system.props.${kind}_id_${slot}`] = actor ? `Actor.${actor.id}` : "";
  upd[`system.props.${kind}_name_${slot}`] = actor?.name ?? "";
  await db.update(upd);
  try { await globalThis.FUCompanion?.api?.syncPartySheet?.(); }
  catch (e) { console.warn(TAG, "party sync after roster change failed", e); }
  log(`roster ${g.label} ${slot} → ${actor?.name ?? "(empty)"}`);
  return { ok: true };
}

// ── roster guard ──────────────────────────────────────────────────────────────
//
// Every player OWNS the party database (the shared bag lives on it), so for a
// player the roster is otherwise only menu-gated: a console `db.update(...)`
// would reseat the party. Every GM client remembers the roster as a GM last left
// it; when a non-GM's write touches a roster field, the acting GM puts those
// fields back. (A preUpdate hook cannot do this: it runs on the writer's client.)

// `-=` is a deletion key in an update diff; a delete must not slip through.
const ROSTER_FIELD = /^(-=)?(member|bench|away)_(id|name)_\d+$/;
const _rosterSeen = new Map();   // party db id → { field: value }

const isPartyDb = (actor) => !!actor?.system?.props && "member_id_1" in actor.system.props;
const rosterFieldsOf = (actor) => Object.fromEntries(
  Object.entries(actor.system?.props ?? {}).filter(([k]) => ROSTER_FIELD.test(k)));

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  for (const a of game.actors ?? []) if (isPartyDb(a)) _rosterSeen.set(a.id, rosterFieldsOf(a));
});

Hooks.on("updateActor", (actor, change, _opts, userId) => {
  if (!game.user?.isGM || !isPartyDb(actor)) return;
  const touched = Object.keys(change?.system?.props ?? {}).filter((k) => ROSTER_FIELD.test(k));
  const author = game.users?.get(userId);
  if (author?.isGM || !touched.length) { _rosterSeen.set(actor.id, rosterFieldsOf(actor)); return; }
  if (!isActingGM()) return;
  const prev = _rosterSeen.get(actor.id);
  // No snapshot (a party database made after this GM loaded): there is no known
  // good value to restore, and blanking the seats would be worse than the edit.
  if (!prev) { console.warn(`${TAG} ${author?.name ?? userId} changed the roster of ${actor.name}; no earlier copy to restore.`); return; }
  const fields = [...new Set(touched.map((k) => k.replace(/^-=/, "")))];
  const revert = Object.fromEntries(fields.map((k) => [`system.props.${k}`, prev[k] ?? ""]));
  console.warn(`${TAG} ${author?.name ?? userId} changed the party roster (${touched.join(", ")}); restoring it.`);
  actor.update(revert).catch((e) => console.error(TAG, "roster restore failed", e));
});

Hooks.once("ready", () => {
  installNet();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.partyMenuInventory = {
    bagsOf, sortedInventory, moveRefusal, moveItem, useRefusal, useItem, equipSlotsOf, equipCandidates, setEquipSlot,
    statusOf, rosterSlots, rosterCandidates, setRosterSlot,
  };
});
