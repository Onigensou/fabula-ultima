// ============================================================================
// Shop Roster — live-world side (Hako's randomized equipment)
//
// A shop actor with flags.fabula-ultima-companion.shopRoster.enabled rerolls
// its equipment at the camp Rest (rest-api.js awaits onRest() before the save
// ceremony, so the save captures the new stock). Consumables refill to their
// listing's baseQty on the same restock; Tackle (key items) and every other
// listing are left alone.
//
// State lives on the shop actor (saved + restored by the save system's shop
// extractor together with the stock it describes):
//   flags.fabula-ultima-companion.shopRoster = {
//     enabled, locked, config,
//     pool:    [{ id, price?, pin?, off?, authoring?: "needed", retired? }],
//     current: [{ id, price }],  previous: [{ id, price }] | null,
//     lastRestockAt, lastCardId, history: [{ at, seed, reason, names, repeats }]
//   }
// Listings this system creates carry flags…rosterSource = the world item id
// (purchases copy it, which helps the ownership check).
//
// Exposed as globalThis.FUCompanion.shopRoster.
// ============================================================================
import {
  EQUIP_TYPES, resolveConfig, rollRoster, simulateOdds, blockReason, normalizeName, rarityOf, tierOf,
} from "./shop-roster-engine.js";

const M = "fabula-ultima-companion";
const KEY = "shopRoster";
const TAG = "[ShopRoster]";
const HISTORY_CAP = 30;
const EMBED_FOLDER = "CSB - Embedded Items Folder - DO NOT RENAME OR REMOVE";

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const props = (doc) => doc?.system?.props ?? {};
const itemType = (doc) => String(props(doc).item_type ?? "").toLowerCase();

export const getState = (actor) => foundry.utils.deepClone(actor?.flags?.[M]?.[KEY] ?? null);
export const isRosterShop = (actor) => !!actor?.flags?.[M]?.[KEY]?.enabled;
const rosterShops = () => game.actors.filter(isRosterShop);

const STATE_KEYS = ["enabled", "locked", "config", "pool", "current", "previous", "lastRestockAt", "lastCardId", "history"];

async function saveState(actor, next) {
  // One merge write. Every key is written (null when empty) and the arrays
  // replace wholesale, so nothing stale survives the merge.
  const full = Object.fromEntries(STATE_KEYS.map((k) => [k, next[k] ?? null]));
  full.enabled = !!next.enabled; full.locked = !!next.locked;
  full.pool ??= []; full.history ??= []; full.current ??= [];
  await actor.update({ [`flags.${M}.${KEY}`]: full });
}

// ── Indexes over the live world ──────────────────────────────────────────────

/** Ids a party copy can point back to its world item with. */
function sourceIdsOf(item) {
  const out = new Set();
  const add = (v) => { const s = String(v ?? ""); const m = s.match(/(?:^|\.)Item\.([A-Za-z0-9]{16})$/) ?? s.match(/^([A-Za-z0-9]{16})$/); if (m) out.add(m[1]); };
  add(item._stats?.compendiumSource);
  add(item._stats?.duplicateSource);
  add(item.flags?.core?.sourceId);
  add(item.flags?.[M]?.rosterSource);
  return out;
}

async function partyHolders() {
  const holders = [];
  try {
    const r = await globalThis.FUCompanion?.api?.getCurrentGameDb?.();
    const db = r?.source ?? r?.db ?? null;
    if (db) {
      holders.push({ actor: db, label: "Stash" });
      for (let i = 1; i <= 4; i++) {
        const raw = String(props(db)[`member_id_${i}`] ?? "").trim();
        if (!raw) continue;
        const a = game.actors.get(raw) ?? await fromUuid(raw.includes(".") ? raw : `Actor.${raw}`).catch(() => null);
        if (a) holders.push({ actor: a, label: a.name });
      }
    }
  } catch (e) { console.warn(TAG, "party lookup failed", e); }
  return holders;
}

/** { byId: Map<worldId, Set<label>>, byName: Map<normName, Set<label>> } */
async function ownershipIndex() {
  const byId = new Map(), byName = new Map();
  const put = (map, k, label) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(label); };
  for (const { actor, label } of await partyHolders()) {
    for (const it of actor.items) {
      if (it.system?.container) continue;
      for (const id of sourceIdsOf(it)) put(byId, id, label);
      put(byName, normalizeName(it.name), label);
    }
  }
  return { byId, byName };
}

/** normName → first monster that can drop/steal it (actors + placed token deltas). */
function stealIndex() {
  const idx = new Map();
  const scan = (p, who) => {
    const t = p?.steal_percentage_table;
    if (t && typeof t === "object") for (const r of Object.values(t)) if (r && r.loot_id && r.loot_id !== "(Empty)") { const k = normalizeName(r.loot_id); if (!idx.has(k)) idx.set(k, who); }
    const c = p?.stealable_loot;
    if (c && typeof c === "object") for (const r of Object.values(c)) if (r?.name) { const k = normalizeName(r.name); if (!idx.has(k)) idx.set(k, who); }
  };
  // Read the STORED props: CSB re-derives a live stealable_loot from the items
  // an actor currently holds, so `system` would miss catalog-only entries.
  // Shop actors' catalogs are their own stock history (drag-drop side effect), not steals.
  for (const a of game.actors) if (props(a).isShop !== true) scan(a._source?.system?.props ?? props(a), a.name);
  for (const s of game.scenes) for (const tok of s.tokens) {
    if (tok.actorLink) continue;
    if (tok.actor && props(tok.actor).isShop === true) continue;
    scan(tok.delta?._source?.system?.props ?? tok.delta?.system?.props, tok.name);
  }
  return idx;
}

/** normName → another shop that lists it right now. */
function otherShopIndex(self) {
  const idx = new Map();
  for (const a of game.actors) {
    if (a.id === self.id || props(a).isShop !== true) continue;
    for (const it of a.items) if (!it.system?.container) { const k = normalizeName(it.name); if (!idx.has(k)) idx.set(k, a.name); }
  }
  return idx;
}

/**
 * Pool entries → engine candidates (+ display info for the console/card).
 * Entries whose world item is gone are returned in `missing`.
 */
export async function buildCandidates(actor, state = getState(actor)) {
  const own = await ownershipIndex(), steal = stealIndex(), shops = otherShopIndex(actor);
  const candidates = [], missing = [];
  for (const e of state?.pool ?? []) {
    const it = game.items.get(e.id);
    if (!it) { missing.push(e.id); continue; }
    const p = props(it), key = normalizeName(it.name);
    const owners = new Set([...(own.byId.get(it.id) ?? []), ...(own.byName.get(key) ?? [])]);
    candidates.push({
      id: it.id, name: it.name, type: itemType(it), rarity: rarityOf(p.item_rarity), rawRarity: p.item_rarity ?? "",
      category: p.category ?? "", img: it.img,
      price: Number(e.price) > 0 ? Number(e.price) : Math.max(0, Number(p.item_cost) || 0),
      isSet: !!p.isSet, setName: p.set_name ?? "", retired: e.retired || "", off: !!e.off, pin: !!e.pin,
      needsAuthoring: e.authoring === "needed",
      owned: [...owners], steal: steal.get(key) ?? "", otherShop: shops.get(key) ?? "",
    });
  }
  return { candidates, missing };
}

// ── Stock writes ─────────────────────────────────────────────────────────────

// V12 can list an embedded Item the server no longer has; deleting it throws
// "does not exist" on a real server (not in the snapshot runner). Skip those.
// Foundry also raises an error toast for it, so that one message is filtered
// while we delete (same pattern as the Chapter 4 restock migration).
async function safeDelete(actor, ids) {
  const n = ui?.notifications;
  const orig = n?.error?.bind(n);
  if (n) n.error = (msg, ...rest) => (typeof msg === "string" && /does not exist/i.test(msg) ? null : orig?.(msg, ...rest));
  try {
    for (const id of ids) {
      if (!actor.items.get(id)) continue;
      try { await actor.deleteEmbeddedDocuments("Item", [id]); }
      catch (e) { if (!/does not exist/i.test(String(e?.message ?? e))) throw e; }
    }
  } finally { if (n) n.error = orig; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function subtreeIds(actor, rootId) {
  const out = [];
  const walk = (id) => { for (const c of actor.items.filter((i) => i.system?.container === id)) { out.push(c.id); walk(c.id); } };
  walk(rootId);
  return out;
}

function worldSubtree(rootId) {
  const out = [];
  const walk = (id) => { for (const c of game.items.filter((i) => i.system?.container === id)) { out.push(c); walk(c.id); } };
  walk(rootId);
  return out;
}

const equipmentListings = (actor) => actor.items.filter((i) => !i.system?.container && EQUIP_TYPES.includes(itemType(i)));

/** The world item a listing was copied from (flag first; older listings by name). */
function listingSource(it) {
  const id = it.flags?.[M]?.rosterSource;
  if (id && game.items.get(id)) return id;
  const key = normalizeName(it.name);
  return game.items.find((w) => !w.system?.container && w.folder?.name !== EMBED_FOLDER && normalizeName(w.name) === key)?.id ?? null;
}

async function deleteListing(actor, it) {
  const kids = subtreeIds(actor, it.id);
  await safeDelete(actor, [it.id]);
  // CSB cascades the contained items itself. Give that a moment to land on
  // this client before sweeping, or we race it (real server: "does not exist").
  for (let i = 0; i < 20 && kids.some((id) => actor.items.get(id)); i++) await wait(100);
  await safeDelete(actor, kids.reverse());
}

async function createListing(actor, { id, price }) {
  const src = game.items.get(id);
  if (!src) { console.warn(TAG, `world item ${id} missing, listing skipped`); return false; }
  const data = src.toObject(); delete data._id;
  data.system.container = null;
  data.system.props = { ...data.system.props, item_cost: String(price), item_quantity: "1" };
  foundry.utils.setProperty(data, `flags.${M}.rosterSource`, src.id);
  const [parent] = await actor.createEmbeddedDocuments("Item", [data]);
  const map = new Map([[src.id, parent.id]]);
  for (const child of worldSubtree(src.id)) {
    const cd = child.toObject(); delete cd._id;
    cd.system.container = map.get(child.system.container) ?? parent.id;
    const [c] = await actor.createEmbeddedDocuments("Item", [cd]);
    map.set(child.id, c.id);
  }
  return true;
}

/** Replace every equipment listing with `entries` ([{id, price}]). */
async function writeEquipment(actor, entries) {
  for (const it of equipmentListings(actor)) await deleteListing(actor, it);
  let made = 0;
  for (const e of entries) if (await createListing(actor, e)) made++;
  return made;
}

/**
 * Make the equipment listings match state.current without touching listings
 * that already match (their sold-out state is kept). Used after a save load:
 * the save system keeps shop stock that differs from its world master, so a
 * load would otherwise leave the newer roll's listings on sale next to the
 * restored ones.
 */
export async function syncToState(actor) {
  const state = getState(actor);
  if (!state?.enabled) return { removed: 0, added: 0 };
  const want = new Map((state.current ?? []).map((e) => [e.id, e]));
  const seen = new Set();
  let removed = 0, added = 0;
  for (const it of equipmentListings(actor)) {
    const src = listingSource(it);
    if (src && want.has(src) && !seen.has(src)) { seen.add(src); continue; }
    await deleteListing(actor, it);
    removed++;
  }
  for (const [id, e] of want) if (!seen.has(id) && await createListing(actor, e)) added++;
  if (removed || added) console.log(TAG, `${actor.name}: synced to saved roster (−${removed} +${added})`);
  return { removed, added };
}

// Save system: after shop stock is restored (phase 0), line roster shops up
// with their restored roster record. Nothing is stored (the record lives in
// the shop actor's flags, which the shop extractor already saves).
Hooks.once("init", () => {
  const SS = globalThis.SaveSystem;
  if (!SS?.registerExtractor) { console.warn(TAG, "save system not found; roster/load sync off"); return; }
  SS.registerExtractor({
    key: "shopRosterSync",
    label: "Shop roster sync",
    phase: 2,
    extract: async () => null,
    async apply() {
      if (!game.user?.isGM) return;
      for (const actor of rosterShops()) await syncToState(actor);
    },
  });
});

/** Consumable listings with a baseQty go back to it. Returns refilled names. */
async function refillConsumables(actor) {
  const updates = [], names = [];
  for (const it of actor.items) {
    if (it.system?.container || itemType(it) !== "consumable") continue;
    const base = Number(it.flags?.[M]?.baseQty);
    if (!(base > 0)) continue;
    if (Number(props(it).item_quantity) >= base) continue;
    updates.push({ _id: it.id, "system.props.item_quantity": String(base) });
    names.push(it.name);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return names;
}

// ── Roll / undo / lock ───────────────────────────────────────────────────────

/**
 * Reroll now. reason: "Rest" | "Reroll". Writes stock + state, whispers the GM.
 * @returns the engine result plus listing count
 */
export async function reroll(actor, { reason = "Reroll", refill = true } = {}) {
  if (!game.user?.isGM) throw new Error("GM only");
  const state = getState(actor);
  if (!state?.enabled) throw new Error(`${actor.name} is not a roster shop`);
  const cfg = resolveConfig(state.config);
  const { candidates, missing } = await buildCandidates(actor, state);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seed = Math.floor(Math.random() * 2 ** 31);
  const lastIds = new Set((state.current ?? []).map((e) => e.id));
  const res = rollRoster(candidates, cfg, { seed, lastIds });
  const entries = res.picks.map((p) => ({ id: p.id, price: byId.get(p.id).price }));

  const made = await writeEquipment(actor, entries);
  const refilled = refill ? await refillConsumables(actor) : [];
  const now = Date.now();
  const next = {
    ...state,
    previous: state.current ?? null,
    current: entries,
    lastRestockAt: now,
    history: [...(state.history ?? []), {
      at: now, seed, reason, names: res.picks.map((p) => byId.get(p.id).name), repeats: res.picks.filter((p) => p.tier === 1).length,
    }].slice(-HISTORY_CAP),
  };
  const card = await postCard(actor, { res, byId, reason, refilled, missing, locked: !!state.locked });
  next.lastCardId = card?.id ?? null;
  await saveState(actor, next);
  console.log(TAG, `${actor.name}: ${reason} → ${made} listings (seed ${seed.toString(16)})`, res.warnings);
  return { ...res, listings: made, refilled };
}

export async function undo(actor) {
  if (!game.user?.isGM) throw new Error("GM only");
  const state = getState(actor);
  if (!state?.previous) { ui.notifications?.warn?.("Nothing to undo."); return false; }
  await writeEquipment(actor, state.previous);
  const now = Date.now();
  await saveState(actor, {
    ...state, current: state.previous, previous: null, lastCardId: null,
    history: [...(state.history ?? []), { at: now, seed: null, reason: "Undo", names: state.previous.map((e) => game.items.get(e.id)?.name ?? e.id), repeats: 0 }].slice(-HISTORY_CAP),
  });
  await whisper(actor, `<div class="fu-roster-card"><h3>↩ ${esc(actor.name)}: roster restored</h3><p>The equipment from before the last roll is back on sale.</p></div>`);
  return true;
}

export async function setLocked(actor, locked) {
  const state = getState(actor);
  await saveState(actor, { ...state, locked: !!locked });
  await whisper(actor, `<div class="fu-roster-card"><h3>${locked ? "🔒" : "🔓"} ${esc(actor.name)}: roster ${locked ? "locked" : "unlocked"}</h3><p>${locked
    ? "Rests keep this equipment until you unlock it. Consumables still refill."
    : "The next Rest after the cooldown rerolls the equipment."}</p></div>`);
}

/** Merge a partial state change (console edits). */
export async function patchState(actor, patch) {
  const state = getState(actor);
  await saveState(actor, { ...state, ...patch });
}

/**
 * Called by RestAPI.perform() (awaited) after the party is restored.
 * Once per cooldown: refill consumables, and reroll unless locked.
 */
export async function onRest() {
  if (!game.user?.isGM || !isPrimaryGM()) return;
  for (const actor of rosterShops()) {
    try {
      const state = getState(actor);
      const cfg = resolveConfig(state.config);
      const since = Date.now() - Number(state.lastRestockAt || 0);
      if (since < cfg.cooldownHours * 3600e3) {
        await whisper(actor, `<div class="fu-roster-card"><h3>${esc(actor.name)} kept her stock</h3><p>She already restocked ${Math.max(1, Math.round(since / 3600e3))} h ago (one restock per ${cfg.cooldownHours} h). Use Reroll in the roster console to force one.</p></div>`);
        continue;
      }
      if (state.locked) {
        const refilled = await refillConsumables(actor);
        await saveState(actor, { ...state, lastRestockAt: Date.now() });
        await whisper(actor, `<div class="fu-roster-card"><h3>🔒 ${esc(actor.name)}: roster locked</h3><p>Equipment kept.${refilled.length ? ` Refilled: ${refilled.map(esc).join(", ")}.` : ""}</p></div>`);
        continue;
      }
      await reroll(actor, { reason: "Rest" });
    } catch (e) {
      console.error(TAG, `restock failed for ${actor.name}`, e);
      ui.notifications?.error?.(`${actor.name}'s restock failed — see console. Her stock was not changed.`);
    }
  }
}

/** For the console: candidates with status + odds of appearing next roll. */
export async function inspect(actor, { runs = 400 } = {}) {
  const state = getState(actor);
  const cfg = resolveConfig(state?.config);
  const { candidates, missing } = await buildCandidates(actor, state);
  const lastIds = new Set((state?.current ?? []).map((e) => e.id));
  const odds = simulateOdds(candidates, cfg, { lastIds, runs });
  const rows = candidates.map((c) => ({ ...c, block: blockReason(c, cfg), tier: tierOf(c), odds: odds.hit[c.id] ?? 0, onSale: lastIds.has(c.id) }));
  return { state, cfg, rows, missing, perRarity: odds.perRarity };
}

// ── Chat ─────────────────────────────────────────────────────────────────────

const gmIds = () => game.users.filter((u) => u.isGM).map((u) => u.id);

async function whisper(actor, content, flags = {}) {
  return ChatMessage.create({
    content, whisper: gmIds(),
    speaker: { alias: actor.name },
    flags: { [M]: { shopRosterCard: { actorId: actor.id, ...flags } } },
  });
}

async function postCard(actor, { res, byId, reason, refilled, missing, locked }) {
  const groups = EQUIP_TYPES.map((t) => {
    const list = res.picks.filter((p) => byId.get(p.id).type === t);
    if (!list.length) return "";
    return `<div class="fu-roster-grp"><b>${t} · ${list.length}</b><ul>${list.map((p) => {
      const c = byId.get(p.id);
      const tags = (p.why === "pin" ? `<span class="fu-roster-tag pin">PIN</span>` : "")
        + (p.why === "signature" ? `<span class="fu-roster-tag sig">SIGNATURE</span>` : "")
        + (p.tier ? `<span class="fu-roster-tag rep" title="Owned by ${esc(c.owned.join(", "))}">REPEAT</span>` : "");
      return `<li><span class="fu-roster-dot ${rarityOf(c.rarity)}"></span>${esc(c.name)} <small>${c.price.toLocaleString()} z</small>${tags}</li>`;
    }).join("")}</ul></div>`;
  }).join("");
  const reps = res.picks.filter((p) => p.tier).length;
  const notes = [
    reps ? `${reps} repeat${reps > 1 ? "s" : ""}: a category ran out of gear the party doesn't own.` : "",
    ...res.warnings,
    missing.length ? `${missing.length} pool item(s) no longer exist in the world.` : "",
  ].filter(Boolean).map((t) => `<div class="fu-roster-note">${esc(t)}</div>`).join("");
  const content = `<div class="fu-roster-card">
    <h3>🎲 ${esc(actor.name)} restocked <small>${esc(reason)}</small></h3>
    <p>${res.picks.length} equipment listings${refilled.length ? ` · refilled ${refilled.length} consumable(s)` : ""} · Tackle unchanged</p>
    ${groups}${notes}
    <div class="fu-roster-acts">
      <button type="button" data-roster="reroll">Reroll</button>
      <button type="button" data-roster="undo">Undo</button>
      <button type="button" data-roster="lock">${locked ? "Unlock" : "Lock roster"}</button>
      <button type="button" data-roster="console">Open console</button>
    </div></div>`;
  return whisper(actor, content, { roll: true });
}

function bindCard(message, html) {
  const info = message.flags?.[M]?.shopRosterCard;
  if (!info) return;
  const root = html instanceof jQuery ? html[0] : html;
  if (!game.user?.isGM) { root.querySelectorAll("[data-roster]").forEach((b) => b.remove()); return; }
  root.querySelectorAll("[data-roster]").forEach((btn) => btn.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const actor = game.actors.get(info.actorId);
    if (!actor) return;
    const act = btn.dataset.roster;
    const state = getState(actor);
    // Reroll/Undo act on the CURRENT roster; an old card would undo the wrong roll.
    if ((act === "reroll" || act === "undo") && state?.lastCardId !== message.id) {
      ui.notifications?.warn?.("This card is out of date — use the latest restock card or the roster console.");
      return;
    }
    btn.disabled = true;
    try {
      if (act === "reroll") await reroll(actor, { reason: "Reroll", refill: false });
      else if (act === "undo") await undo(actor);
      else if (act === "lock") await setLocked(actor, !state?.locked);
      else if (act === "console") globalThis.FUCompanion?.shopRosterConsole?.open?.(actor);
    } catch (e) { console.error(TAG, e); ui.notifications?.error?.(`Roster: ${e.message}`); }
    finally { btn.disabled = false; }
  }));
}

const CARD_CSS = `
.fu-roster-card h3 { margin: 0 0 4px; font-size: 14px; border: 0; }
.fu-roster-card h3 small { font-weight: 400; opacity: .7; }
.fu-roster-card p { margin: 0 0 4px; }
.fu-roster-grp { margin-top: 6px; }
.fu-roster-grp b { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.fu-roster-grp ul { margin: 2px 0 0; padding-left: 16px; }
.fu-roster-grp small { opacity: .65; }
.fu-roster-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; background: #8a8170; }
.fu-roster-dot.Legendary { background: #c79100; } .fu-roster-dot.Rare { background: #2f6fb3; } .fu-roster-dot.Uncommon { background: #3f8a52; }
.fu-roster-tag { font-size: 9px; font-weight: 700; color: #fff; border-radius: 3px; padding: 0 4px; margin-left: 4px; }
.fu-roster-tag.rep { background: #a8661a; } .fu-roster-tag.pin { background: #3c5f91; } .fu-roster-tag.sig { background: #b8860b; }
.fu-roster-note { font-size: 12px; background: rgba(168,102,26,.15); border-radius: 3px; padding: 3px 6px; margin-top: 5px; }
.fu-roster-acts { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.fu-roster-acts button { flex: 1 1 auto; line-height: 22px; font-size: 12px; }`;

Hooks.once("init", () => {
  const s = document.createElement("style");
  s.id = "fu-shop-roster-card-style";
  s.textContent = CARD_CSS;
  document.head.appendChild(s);
});
Hooks.on("renderChatMessage", bindCard);

globalThis.FUCompanion ??= {};
globalThis.FUCompanion.shopRoster = { onRest, reroll, undo, setLocked, patchState, inspect, buildCandidates, getState, isRosterShop, syncToState };
