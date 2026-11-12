// ============================================================================
// Terrarium — engine (2026-11-12). Approved mockup v4:
// https://claude.ai/artifact/Sg95izKw5SLo32vd2E53wD
//
// The main controller throws a Terrarium onto a tile next to the party; that
// tile's CURRENT type becomes the Terrarium's (origin untouched, see
// dp-tile-state.js "Terrarium"). Free: no step, the turn does not end.
//
//   DP.Terrarium.stock()                    → { kind: [{ item, owner, qty, inBag }] } (active party + Party Bag)
//   DP.Terrarium.sceneInfo(scene)           → { hasCampScene, hasMaterialTable, hasEncounterTable }
//   DP.Terrarium.checkTile(scene, tileId, kind) → dp-terrarium-rules checkTarget result
//   DP.Terrarium.request({ tileId, kind, itemUuid }) → { ok, reason? }   (any client)
//
// Flow: the client asks the GM (raw socket, primary GM only, serialized with
// the other dungeon writes). The GM re-checks everything — main controller,
// tile next to the party, rules, stock — spends one item, broadcasts the throw
// (every client plays dp-terrarium-fx.js), writes the tile at the landing beat
// under the smoke, then broadcasts DONE so every client rebuilds its graph.
// ============================================================================

import { KINDS, KIND_NAME, kindOfItem, checkTarget, kindBlock, typeLabel } from "./dp-terrarium-rules.js";

// Loaded on first use so this file does not change when those modules evaluate.
const getPartyRoster = async () => (await import("../party-menu/party-menu-core.js")).getPartyRoster();
const consumeOne = async (actor, item) => (await import("../battle-director/item-resource.js")).consumeOne(actor, item);

const DP  = (globalThis.DungeonPathing ??= {});
const MOD = "fabula-ultima-companion";
const TAG = "[DungeonPathing][Terrarium]";
const CH  = `module.${MOD}`;
const MSG = Object.freeze({ REQ: "DP_TERRARIUM_REQ", RES: "DP_TERRARIUM_RES", FX: "DP_TERRARIUM_FX", DONE: "DP_TERRARIUM_DONE" });

// Landing beat, measured from the FX start: lift 380 + hold 520 + throw 620.
// The GM writes the tile a moment after, while the smoke covers it.
export const LAND_MS = 1520;
const WRITE_AFTER_LAND_MS = 70;
const REQ_TIMEOUT_MS = 10000;

export const REASON = Object.freeze({
  "not-dungeon":    "Terrariums only work inside a dungeon.",
  "not-controller": "Only the main controller can use a Terrarium.",
  "in-combat":      "Terrariums can't be used during a conflict.",
  "busy":           "Wait for the party to finish moving.",
  "not-adjacent":   "Pick a tile next to the party.",
  "no-item":        "That Terrarium is gone.",
  "no-gm":          "No GM answered. A GM must be online to use a Terrarium.",
  "write-failed":   "The tile couldn't change. Nothing was used.",
  "in-progress":    "A Terrarium is already being thrown.",
});

const truthy = (v) => v === true || v === "true";
const num = (v) => Number(v) || 0;

// ── Party stock ───────────────────────────────────────────────────────────────
export function itemKind(item) {
  return kindOfItem({ flagKind: item?.getFlag?.(MOD, "terrarium") ?? item?.flags?.[MOD]?.terrarium, name: item?.name });
}

/** Terrariums held by the active party and the Party Bag, grouped by kind. */
export async function stock() {
  const roster = await getPartyRoster().catch(() => null);
  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  const owners = [...(roster?.active ?? [])];
  if (roster?.db) owners.push(roster.db);
  for (const owner of owners) {
    for (const item of owner?.items ?? []) {
      const kind = itemKind(item);
      if (!kind) continue;
      const p = item.system?.props ?? {};
      const qty = truthy(p.isUnique) ? 1 : num(p.item_quantity);
      if (qty <= 0) continue;
      out[kind].push({ item, owner, qty, inBag: owner === roster?.db });
    }
  }
  // Use the Party Bag last, then the smallest stack first.
  for (const k of KINDS) out[k].sort((a, b) => (a.inBag - b.inBag) || (a.qty - b.qty));
  return out;
}
export const totalOf = (st) => KINDS.reduce((s, k) => s + (st?.[k] ?? []).reduce((a, e) => a + e.qty, 0), 0);

// ── Scene / tile checks ───────────────────────────────────────────────────────
export function sceneInfo(scene) {
  const f = scene?.flags?.[MOD] ?? {};
  const dun = f.oniDungeon ?? {};
  return {
    hasCampScene:      !!String(f.campSceneUuid ?? "").trim(),
    hasMaterialTable:  !!String(dun?.loot?.material ?? "").trim(),
    hasEncounterTable: !!String(dun.encounterTable ?? "").trim() || !!String(dun.enemiesTable ?? "").trim(),
  };
}

export function isDungeon(scene) {
  return scene?.flags?.[MOD]?.oniFabula?.general?.sceneMode === "dungeon";
}

export function checkTile(scene, tileId, kind) {
  const td = scene?.tiles?.get(tileId);
  if (!td) return { ok: false, why: "That tile is gone." };
  return checkTarget({
    kind,
    currentType: DP.TileState?.getCurrentType?.(scene, tileId),
    initialType: DP.TileState?.getInitialType?.(scene, tileId),
    dp:          td.getFlag(MOD, DP.PATHING_ROOT_KEY ?? "dungeonPathing") ?? {},
    monksActions: td.getFlag("monks-active-tiles", "actions") ?? [],
    teleporter:  td.getFlag(MOD, "teleporter") ?? null,
  });
}

function conflictLive() {
  try {
    if (game.combat?.started) return true;
    return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.();
  } catch { return false; }
}

async function controllerOf() {
  const api = globalThis.__ONI_MOVEMENT_CONTROL_API__ ?? globalThis.FUCompanion?.api?.MovementControl;
  try { return (await api?.getCurrentControllerUser?.()) ?? null; } catch { return null; }
}

/** Can this client open the Terrarium picker at all? → "" or a REASON key. */
export async function clientRefusal(scene = canvas?.scene) {
  if (!isDungeon(scene)) return "not-dungeon";
  if (conflictLive()) return "in-combat";
  if (game.user?.isGM) return "";
  const c = await controllerOf();
  return c?.userId === game.user?.id ? "" : "not-controller";
}

// ── Client request ────────────────────────────────────────────────────────────
const _pending = new Map();   // reqId -> resolve

export async function request({ tileId, kind, itemUuid }) {
  const scene = canvas?.scene;
  const payload = { reqId: foundry.utils.randomID(), sceneId: scene?.id, tileId, kind, itemUuid, userId: game.user?.id };
  if (game.user?.isGM) return handleRequest(payload);
  if (!game.users?.activeGM) return { ok: false, reason: "no-gm" };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { _pending.delete(payload.reqId); resolve({ ok: false, reason: "no-gm" }); }, REQ_TIMEOUT_MS);
    _pending.set(payload.reqId, (res) => { clearTimeout(timer); resolve(res); });
    game.socket.emit(CH, { type: MSG.REQ, payload });
  });
}

// ── GM side ───────────────────────────────────────────────────────────────────
let _gmBusy = false;
const serialize = (fn) => (DP.gmSerialize ?? ((f) => f()))(fn);

async function validate(p) {
  const scene = game.scenes?.get(p.sceneId);
  if (!scene || !isDungeon(scene)) return { reason: "not-dungeon" };
  if (conflictLive()) return { reason: "in-combat" };
  const user = game.users?.get(p.userId);
  const ctrl = await controllerOf();
  if (!user?.isGM && ctrl?.userId !== p.userId) return { reason: "not-controller" };
  // Next to the party: the primary GM views the active dungeon scene (dp-bootstrap
  // keeps its graph); the walkable neighbours are the only valid targets.
  const rt = DP.Runtime;
  if (!rt?.active || canvas?.scene?.id !== scene.id || !rt.neighborIds?.has?.(p.tileId)) return { reason: "not-adjacent" };
  if (rt.busy) return { reason: "busy" };
  if (!KINDS.includes(p.kind)) return { reason: "no-item" };
  const block = kindBlock(p.kind, sceneInfo(scene));
  if (block) return { reason: "rule", why: block };
  const check = checkTile(scene, p.tileId, p.kind);
  if (!check.ok) return { reason: "rule", why: check.why };
  const item = await fromUuid(p.itemUuid).catch(() => null);
  const owner = item?.parent ?? null;
  if (!item || !owner || itemKind(item) !== p.kind) return { reason: "no-item" };
  const roster = await getPartyRoster().catch(() => null);
  const inParty = owner.id === roster?.db?.id || (roster?.active ?? []).some((a) => a.id === owner.id);
  if (!inParty) return { reason: "no-item" };
  const pr = item.system?.props ?? {};
  if (!truthy(pr.isUnique) && num(pr.item_quantity) <= 0) return { reason: "no-item" };
  const by = ctrl?.partyMemberActorName || ctrl?.linkedActorName || user?.character?.name || user?.name || "The party";
  return { scene, item, owner, by, user };
}

async function partyTokenId(scene) {
  try { return (await DP.Graph?.resolvePartyToken?.())?.id ?? null; } catch { return null; }
}

export async function handleRequest(p) {
  if (!game.user?.isGM) return { ok: false, reason: "no-gm" };
  if (_gmBusy) return { ok: false, reason: "in-progress" };
  _gmBusy = true;
  try {
    // 1 · check + spend (serialized with the other per-turn dungeon writes)
    const v = await serialize(() => validate(p).then(async (v) => {
      if (v.reason) return v;
      const spent = await consumeOne(v.owner, v.item);
      return spent?.ok ? v : { reason: "no-item" };
    }));
    if (v.reason) return { ok: false, reason: v.reason, why: v.why };

    // 2 · the throw, on every client
    const fx = {
      sceneId: p.sceneId, tileId: p.tileId, kind: p.kind, by: v.by,
      tokenId: await partyTokenId(v.scene),
      fromLabel: typeLabel(DP.TileState?.getCurrentType?.(v.scene, p.tileId)),
    };
    game.socket.emit(CH, { type: MSG.FX, payload: fx });
    DP.TerrariumFX?.play?.(fx);

    // 3 · write under the smoke
    await new Promise((r) => setTimeout(r, LAND_MS + WRITE_AFTER_LAND_MS));
    const res = await serialize(() => DP.TileState.terraform(v.scene, p.tileId, p.kind, {
      by: v.by, byUserId: p.userId, item: KIND_NAME[p.kind],
    }));
    if (!res?.ok) {
      console.error(TAG, "terraform failed after the item was spent", p, res);
      return { ok: false, reason: "write-failed" };
    }
    const done = { sceneId: p.sceneId, tileId: p.tileId, kind: p.kind };
    game.socket.emit(CH, { type: MSG.DONE, payload: done });
    onDone(done);
    console.log(TAG, `${v.by} placed ${KIND_NAME[p.kind]} on ${p.tileId} (${fx.fromLabel} → ${typeLabel(p.kind)})`);
    return { ok: true };
  } catch (e) {
    console.error(TAG, "request failed", e);
    return { ok: false, reason: "write-failed" };
  } finally {
    _gmBusy = false;
  }
}

// Every client: the tile changed, rebuild the graph (tooltips, neighbours).
function onDone(d) {
  DP.TerrariumFX?.landed?.(d);
  if (canvas?.scene?.id !== d.sceneId) return;
  globalThis.__ONI_DUNGEON_PATHING__?.rebuild?.().catch?.(() => {});
  Hooks.callAll("dungeonPathing.terrariumPlaced", d);
}

// ── Socket ───────────────────────────────────────────────────────────────────
Hooks.once("ready", () => {
  game.socket.on(CH, async (msg) => {
    const t = msg?.type;
    if (t === MSG.REQ) {
      if (!game.user?.isGM || (DP.isPrimaryGM && !DP.isPrimaryGM())) return;
      const res = await handleRequest(msg.payload ?? {});
      game.socket.emit(CH, { type: MSG.RES, payload: { reqId: msg.payload?.reqId, res } });
    } else if (t === MSG.RES) {
      _pending.get(msg.payload?.reqId)?.(msg.payload?.res ?? { ok: false });
      _pending.delete(msg.payload?.reqId);
    } else if (t === MSG.FX) {
      DP.TerrariumFX?.play?.(msg.payload ?? {});
    } else if (t === MSG.DONE) {
      onDone(msg.payload ?? {});
    }
  });
});

DP.Terrarium = Object.freeze({
  stock, totalOf, itemKind, sceneInfo, isDungeon, checkTile, clientRefusal, request, REASON, LAND_MS,
});
