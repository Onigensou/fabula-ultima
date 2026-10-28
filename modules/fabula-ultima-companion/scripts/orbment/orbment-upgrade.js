// scripts/orbment/orbment-upgrade.js
//
// UPGRADE (Tinkerer heroic skill) at camp — Orbment v3, the GUARANTEED path.
// Once per rest the holder picks any party member's weapon / armor / shield, a
// socket, and a rulebook Quality worth ≤ 1000 z (registry upgradeAugments);
// they pay DOUBLE its cost when they queue it. No roll: it goes in at the full
// rulebook value. The queue is refundable until the party sleeps, installed
// when the rest completes (fabula.restPerformed), and announced to everyone
// once the party wakes (camp phase → Set Out lobby).
//
// The queue lives on the HOLDER: flags.<ns>.orbmentUpgrade =
//   { itemUuid, slot, id, param, cost, queuedAt }
// Every write goes through the primary GM — a player can't write another party
// member's items or charge Zenit on their own.

import { FLAG_NS, readOrbment, itemKindOf } from "./orbment-const.js";
import { upgradeAugments, canonicalizeParam, validateParam, resolveAugment } from "./augment-registry.js";
import { install } from "./orbment-api.js";
import { feedback } from "./orbment-feedback.js";

const TAG = "[Orbment][Upgrade]";
const CHANNEL = "module.fabula-ultima-companion";
export const UPGRADE_FLAG = "orbmentUpgrade";
export const UPGRADE_MSG = Object.freeze({ REQ: "orbment:upgrade:req", RES: "orbment:upgrade:res" });
const TIMEOUT_MS = 15000;
const KINDS = new Set(["weapon", "armor", "shield"]);
// Camp phases where the queue can change: before the party sleeps.
const OPEN_PHASES = ["free_roam", "sleep_lobby"];
const WAKE_PHASE = "set_out_lobby";
const WAKE_DELAY_MS = 1800;           // let the black curtain lift first

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const readZenit = (actor) => Math.max(0, Number(actor?.system?.props?.zenit ?? 0) || 0);
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

export const hasUpgradeHeroic = (actor) => !!actor?.items?.some?.((i) =>
  String(i.name ?? "").trim().toLowerCase() === "upgrade"
  && (i.system?.props?.isHeroic === true || String(i.system?.props?.isHeroic) === "true"));
export const queuedUpgrade = (actor) => actor?.flags?.[FLAG_NS]?.[UPGRADE_FLAG] ?? null;
export const upgradeCost = (augment) => 2 * Math.max(0, Number(augment?.cost ?? 0));
export const campPhase = () => globalThis.CampSystem?.State?.getPhase?.() ?? null;
// Open = the party is at camp (the ACTIVE scene, not whatever a GM is viewing)
// and hasn't gone to sleep yet.
export const upgradeOpen = () => OPEN_PHASES.includes(campPhase())
  && game.scenes?.active?.flags?.[FLAG_NS]?.oniFabula?.general?.sceneMode === "camp";

// Validate one Upgrade against an item as it stands now. Shared by the window
// (to enable its button) and the GM (before charging / installing).
export function planUpgrade({ item, slot, id, param }) {
  if (!item) return fail("item_not_found");
  const kind = itemKindOf(item);
  if (!KINDS.has(kind)) return fail("not_equippable");
  const orb = readOrbment(item);
  const idx = Number(slot);
  if (!Number.isInteger(idx) || idx < 0 || idx >= orb.slots.length) return fail("bad_slot");
  const augment = upgradeAugments(kind).find((a) => a.id === id);
  if (!augment) return fail("not_upgradeable");
  let p = null;
  if (augment.param) {
    p = canonicalizeParam(augment, param);
    if (validateParam(augment, p)) return fail("needs_choice", { augment });
  }
  const view = resolveAugment(id, p, null);
  const same = (s) => s && s.id === id && (s.param ?? null) === p;
  const dupe = orb.slots.findIndex((s, i) => i !== idx && same(s));
  if (dupe !== -1) return fail("duplicate", { dupeSlot: dupe, augment });
  // The same Quality in this very socket is only worth upgrading below full value.
  const here = orb.slots[idx];
  if (same(here) && resolveAugment(here.id, here.param, here.value)?.value === view.value) return fail("already_there", { augment });
  return { ok: true, augment, param: p, cost: upgradeCost(augment), view, was: here };
}

export function upgradeFailText(r) {
  switch (r?.reason) {
    case "not_enough_zenit": return `Not enough Zenit: this needs ${r.cost} z and you have ${r.have} z.`;
    case "already_queued": return "An Upgrade is already queued for tonight.";
    case "nothing_queued": return "Nothing is queued.";
    case "not_now": return "Upgrades are queued at camp, before the party sleeps.";
    case "duplicate": return `That item already has this Quality in slot ${Number(r.dupeSlot) + 1}.`;
    case "already_there": return "That socket already holds this Quality at full strength.";
    case "needs_choice": return "Make its choice first.";
    case "not_party_gear": return "Upgrade works on party members' gear only.";
    case "no_heroic": return "That takes the Upgrade heroic skill.";
    case "not_your_character": return "You can only use your own character's Upgrade.";
    case "no_gm": return "Upgrade needs a GM online.";
    case "timeout": return "No answer from the GM. Try again in a moment.";
    default: return `Upgrade failed (${r?.reason ?? "unknown"}).`;
  }
}

async function adjustZenit(actor, delta, requester) {
  const tc = window["oni.ItemTransferCore"];
  if (tc?.adjustZenit) {
    const r = await tc.adjustZenit({ actorUuid: actor.uuid, delta, requestedByUserId: requester?.id ?? null });
    return !!r?.ok;
  }
  await actor.update({ "system.props.zenit": readZenit(actor) + delta });
  return true;
}

// ── GM side ──────────────────────────────────────────────────────────────────
export async function executeUpgradeOp({ op, holderUuid, itemUuid, slot, id, param, requesterUserId = null } = {}) {
  try {
    const holder = await fromUuid(String(holderUuid ?? "")).catch(() => null);
    if (!holder || holder.documentName !== "Actor") return fail("holder_not_found");
    const requester = requesterUserId ? game.users.get(requesterUserId) : game.user;
    if (requester && !requester.isGM && !holder.testUserPermission(requester, "OWNER")) return fail("not_your_character");
    if (!hasUpgradeHeroic(holder)) return fail("no_heroic");
    if (!upgradeOpen()) return fail("not_now");
    const queued = queuedUpgrade(holder);

    if (op === "cancel") {
      if (!queued) return fail("nothing_queued");
      await holder.unsetFlag(FLAG_NS, UPGRADE_FLAG);
      if (queued.cost > 0) await adjustZenit(holder, queued.cost, requester);
      return { ok: true, op, refunded: queued.cost, zenitAfter: readZenit(holder) };
    }
    if (op !== "queue") return fail("bad_op");
    if (queued) return fail("already_queued");

    const item = await fromUuid(String(itemUuid ?? "")).catch(() => null);
    if (!item || item.documentName !== "Item" || !item.parent) return fail("item_not_found");
    const party = (await globalThis.CampSystem?.RestAPI?.getPartyActors?.()) ?? [];
    if (!party.some((a) => a.id === item.parent.id)) return fail("not_party_gear");
    const plan = planUpgrade({ item, slot, id, param });
    if (!plan.ok) return plan;

    const have = readZenit(holder);
    if (have < plan.cost) return fail("not_enough_zenit", { cost: plan.cost, have });
    if (plan.cost > 0 && !(await adjustZenit(holder, -plan.cost, requester))) return fail("charge_failed", { cost: plan.cost });
    const q = { itemUuid: item.uuid, slot: Number(slot), id, param: plan.param, cost: plan.cost, queuedAt: Date.now() };
    await holder.setFlag(FLAG_NS, UPGRADE_FLAG, q);
    console.debug(TAG, "queued", holder.name, q);
    return { ok: true, op, queued: q, zenitAfter: readZenit(holder) };
  } catch (e) {
    console.error(TAG, "executeUpgradeOp failed", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

// Rest complete: install every rested holder's queue at full value. The flag is
// cleared FIRST so a re-run can never install (or refund) twice. Announcements
// wait for the party to wake.
const _toAnnounce = [];
async function installQueued(actors = []) {
  for (const holder of actors) {
    const q = queuedUpgrade(holder);
    if (!q) continue;
    await holder.unsetFlag(FLAG_NS, UPGRADE_FLAG);
    let reason = null;
    try {
      const item = await fromUuid(String(q.itemUuid ?? "")).catch(() => null);
      const plan = item ? planUpgrade({ item, slot: q.slot, id: q.id, param: q.param }) : fail("item_not_found");
      if (!plan.ok) { reason = upgradeFailText(plan); throw new Error(plan.reason); }
      const was = plan.was ? resolveAugment(plan.was.id, plan.was.param, plan.was.value) : null;
      await install(item, q.slot, q.id, { param: plan.param, deductZenit: false, source: "upgrade", quiet: true });
      _toAnnounce.push({
        kind: "upgrade", actorName: holder.name, ownerName: item.parent.id !== holder.id ? item.parent.name : "",
        itemName: item.name, itemUuid: item.uuid, itemRarity: String(item.system?.props?.item_rarity ?? ""),
        rows: [{ old: was?.label ?? null, now: plan.view.label, cat: plan.view.category }],
      });
      console.debug(TAG, "installed", holder.name, item.name, q);
    } catch (e) {
      console.warn(TAG, "install failed — refunding", holder.name, q, e);
      if (q.cost > 0) await adjustZenit(holder, q.cost, null).catch(() => {});
      whisperOwners(holder, `${holder.name}'s Upgrade couldn't be finished${reason ? ` (${reason})` : ""}. ${q.cost} z refunded.`);
    }
  }
  flushIfAwake();   // the party may already be up if the GM skipped the ceremony
}

function flushIfAwake() {
  if (!_toAnnounce.length || campPhase() !== WAKE_PHASE) return;
  const list = _toAnnounce.splice(0);
  setTimeout(() => list.forEach((p) => feedback.announce(p)), WAKE_DELAY_MS);
}

function whisperOwners(actor, text) {
  try {
    const ids = game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id);
    ChatMessage.create({ content: `<p>${foundry.utils.escapeHTML?.(text) ?? text}</p>`, whisper: ids, speaker: ChatMessage.getSpeaker({ actor }) });
  } catch (e) { console.warn(TAG, "whisper failed", e); }
}

function onRestPerformed(actors) {
  if (!isPrimaryGM()) return;
  installQueued(Array.isArray(actors) ? actors : []).catch((e) => console.error(TAG, "installQueued", e));
}
function onSetting(setting) {
  if (isPrimaryGM() && String(setting?.key ?? "").startsWith(`${FLAG_NS}.`)) flushIfAwake();
}

// ── Client side ──────────────────────────────────────────────────────────────
const _reqs = new Map();      // reqId → resolve
export function requestUpgrade(op, data = {}) {
  if (isPrimaryGM()) return executeUpgradeOp({ op, ...data, requesterUserId: game.user.id });
  if (!game.users?.activeGM && !game.users?.some?.((u) => u.isGM && u.active)) return Promise.resolve(fail("no_gm"));
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _reqs.set(reqId, resolve);
    game.socket.emit(CHANNEL, { type: UPGRADE_MSG.REQ, payload: { reqId, op, ...data, requesterUserId: game.user.id } });
    setTimeout(() => { if (_reqs.delete(reqId)) resolve(fail("timeout")); }, TIMEOUT_MS);
  });
}

function onSocket(msg) {
  if (msg?.type === UPGRADE_MSG.REQ) {
    if (!isPrimaryGM()) return;
    const { reqId, ...req } = msg.payload ?? {};
    executeUpgradeOp(req)
      .catch((e) => fail("server_error", { message: String(e?.message ?? e) }))
      .then((r) => game.socket.emit(CHANNEL, { type: UPGRADE_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ...r } }));
    return;
  }
  if (msg?.type === UPGRADE_MSG.RES) {
    const { reqId, toUserId, ...rest } = msg.payload ?? {};
    if (toUserId && toUserId !== game.user.id) return;
    const resolve = _reqs.get(reqId);
    if (!resolve) return;
    _reqs.delete(reqId);
    resolve(rest);
  }
}

let _installed = false;
export function installUpgrade() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
  Hooks.on("fabula.restPerformed", onRestPerformed);
  Hooks.on("updateSetting", onSetting);
  // Leaving camp without waking (back to the title) drops unshown announcements.
  Hooks.on("canvasReady", () => {
    if (canvas?.scene?.flags?.[FLAG_NS]?.oniFabula?.general?.sceneMode !== "camp") _toAnnounce.length = 0;
  });
}
