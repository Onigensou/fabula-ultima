// scripts/crafting-system/crafting-craft.js
//
// CRAFT — one Blueprint, run on ONE GM client (the primary GM, dual-GM dedupe).
//
// Entry (any client): FUCompanion.api.crafting.craft({ bookId, blueprintId, place, actorId, qty })
//   A GM runs it locally; a player sends it over the module socket and waits.
// The GM re-checks everything (the window's numbers are only a preview), then:
//   1. takes the materials — the crafter's bag first, then the party stash;
//   2. charges Zenit and IP to the crafter;
//   3. gives the outputs to the crafter (carry limits overflow to the Party Bag,
//      handled by ItemTransferCore);
//   4. announces "<crafter> crafted <items>" to everyone (crafting-feedback).
//
// Who may craft:
//   place "npc" / "table" on a walk map — the Main Controller (or a GM), for the
//     party member they control; on a camp map, a player for their own member.
//   place "camp" — only through Camp Forge (runCampCraft below), never from the
//     socket: the activity itself is the permission.

import { TAG, CHANNEL, PLACES, MAX_QTY, isPrimaryGM, int, readIp, isCampScene } from "./crafting-const.js";
import { readConfig, getBook, findBlueprint, evaluate, stacksOf, partyStash, outputView, blueprintTitle, reasonText } from "./crafting-data.js";
import { announce } from "./crafting-feedback.js";

export const CRAFT_MSG = Object.freeze({ REQ: "crafting:craft:req", RES: "crafting:craft:res" });
const TIMEOUT_MS = 20000;
const ANNOUNCE_DELAY_MS = 1000;
const _pending = new Map();          // reqId → resolve (requesting client)
const _busy = new Set();             // actorIds being crafted for (GM)

function fail(reason, extra = {}) { return { ok: false, reason, ...extra }; }

// Is `user` allowed to craft for `actor` at `place` (not camp)?
async function mayCraft(user, actor, place, sceneId) {
  if (!user || user.isGM) return true;
  // Camp map: a player crafts for their own member. Walk map: the Main
  // Controller crafts for the party member they control.
  const scene = game.scenes?.get(sceneId) ?? null;
  if (isCampScene(scene)) return actor.testUserPermission(user, "OWNER");
  const mc = globalThis.FUCompanion?.api?.MovementControl;
  if (!mc?.getCurrentControllerUser) return actor.testUserPermission(user, "OWNER");
  try {
    const ctl = await mc.getCurrentControllerUser();
    if (!ctl || ctl.userId !== user.id) return false;
    const ctlActorId = ctl.partyMemberActorId ?? ctl.linkedActorId ?? null;
    return !ctlActorId || ctlActorId === actor.id || actor.testUserPermission(user, "OWNER");
  } catch { return false; }
}

// Take `need` of a material by name: bag stacks first, then the stash.
async function takeMaterial(actor, stash, name, need, requesterId) {
  const tc = window["oni.ItemTransferCore"];
  let left = need;
  for (const owner of [actor, stash]) {
    if (!owner || left <= 0) continue;
    for (const { item, qty } of stacksOf(owner, name)) {
      if (left <= 0) break;
      const n = Math.min(qty, left);
      if (tc?.transfer) {
        const r = await tc.transfer({ mode: "actorToGm", itemUuid: item.uuid, quantity: n, senderActorUuid: owner.uuid, requestedByUserId: requesterId, showTransferCard: false });
        if (r?.ok === false) throw new Error(`could not take ${name}: ${r.reason ?? "?"}`);
      } else if (qty - n <= 0) await item.delete();
      else await item.update({ "system.props.item_quantity": String(qty - n) });
      left -= n;
    }
  }
  if (left > 0) throw new Error(`ran out of ${name}`);
}

// ── GM side ──────────────────────────────────────────────────────────────────
// `internal` = called by Camp Forge on the GM (the only way to craft at camp).
export async function executeCraft({ bookId, blueprintId, place, actorId, qty = 1, requesterUserId = null, sceneId = null, campDone = false, internal = false, quiet = false } = {}) {
  if (!PLACES.includes(place)) return fail("bad_place");
  if (place === "camp" && !internal) return fail("camp_only_in_forge");
  const actor = game.actors?.get(actorId);
  if (!actor) return fail("no_actor");
  const requester = requesterUserId ? game.users.get(requesterUserId) : game.user;
  if (place !== "camp" && !(await mayCraft(requester, actor, place, sceneId ?? canvas?.scene?.id))) return fail("not_your_turn");

  const cfg = readConfig();
  const book = getBook(bookId, cfg);
  const bp = findBlueprint(book, blueprintId);
  if (!book || !bp) return fail("no_blueprint");
  const q = place === "camp" ? 1 : Math.max(1, Math.min(MAX_QTY, int(qty, 1)));

  if (_busy.has(actor.id)) return fail("busy");
  _busy.add(actor.id);
  try {
    const stash = await partyStash();
    const ev = evaluate(bp, { actor, stash, book, place, campDone }, q);
    if (!ev.ok) return fail(ev.reason, { text: reasonText(ev, actor.name), cost: ev.cost });

    const tc = window["oni.ItemTransferCore"];
    // 1. Materials (all checked above; a failure mid-way is logged loudly).
    for (const m of bp.materials) await takeMaterial(actor, stash, m.name, m.qty * q, requester?.id ?? null);
    // 2. Zenit + IP.
    if (ev.cost.zenit > 0) {
      if (tc?.adjustZenit) await tc.adjustZenit({ actorUuid: actor.uuid, delta: -ev.cost.zenit, requestedByUserId: requester?.id ?? null });
      else await actor.update({ "system.props.zenit": Math.max(0, ev.zenit - ev.cost.zenit) });
    }
    if (ev.cost.ip > 0) await actor.update({ "system.props.current_ip": Math.max(0, readIp(actor).cur - ev.cost.ip) });
    // 3. Outputs.
    const outputs = [];
    for (const o of bp.outputs) {
      const view = outputView(o);
      const n = o.qty * q;
      if (tc?.transfer) {
        const r = await tc.transfer({ mode: "gmToActor", itemUuid: view.uuid, quantity: n, receiverActorUuid: actor.uuid, requestedByUserId: requester?.id ?? null, showTransferCard: false });
        if (r?.ok === false) console.warn(TAG, "output not delivered", view.name, r);
      } else {
        const src = await fromUuid(view.uuid);
        const data = src.toObject(); delete data._id;
        foundry.utils.setProperty(data, "system.props.item_quantity", String(n));
        await actor.createEmbeddedDocuments("Item", [data]);
      }
      outputs.push({ uuid: view.uuid, name: view.name, img: view.img, qty: n, rarity: view.rarity });
    }

    const out = { ok: true, place, bookId, blueprintId, title: blueprintTitle(bp), qty: q, actorId: actor.id, actorName: actor.name, actorImg: actor.img, outputs, cost: ev.cost };
    // The banner lands just after the crafter's own window shows the result
    // (its "working" beat is MIN_WORK_MS), so the reveal isn't spoiled and the
    // "done" cue plays once. Camp Forge passes quiet and announces itself.
    if (!quiet) setTimeout(() => announce({ actorName: actor.name, actorImg: actor.img, outputs }), ANNOUNCE_DELAY_MS);
    console.log(TAG, "crafted", out);
    return out;
  } catch (e) {
    console.error(TAG, "executeCraft failed", e);
    return fail("error", { message: String(e?.message ?? e) });
  } finally {
    _busy.delete(actor.id);
  }
}

// ── Client side ──────────────────────────────────────────────────────────────
export function craft({ bookId, blueprintId, place, actorId, qty = 1 } = {}) {
  const req = { bookId, blueprintId, place, actorId, qty, sceneId: canvas?.scene?.id ?? null, requesterUserId: game.user.id };
  if (game.user?.isGM && isPrimaryGM()) return executeCraft(req);
  if (!game.users?.some?.((u) => u.isGM && u.active)) return Promise.resolve(fail("no_gm"));
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _pending.set(reqId, resolve);
    game.socket.emit(CHANNEL, { type: CRAFT_MSG.REQ, payload: { reqId, ...req } });
    setTimeout(() => { if (_pending.delete(reqId)) resolve(fail("timeout")); }, TIMEOUT_MS);
  });
}

function onSocket(msg) {
  if (!msg?.type) return;
  if (msg.type === CRAFT_MSG.REQ) {
    if (!isPrimaryGM()) return;
    const { reqId, ...req } = msg.payload ?? {};
    // Camp crafts never come in over the socket.
    const safe = { ...req, internal: false, campDone: false, quiet: false };
    executeCraft(safe)
      .then((r) => game.socket.emit(CHANNEL, { type: CRAFT_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ...r } }))
      .catch((e) => game.socket.emit(CHANNEL, { type: CRAFT_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ok: false, reason: "server_error", message: String(e?.message ?? e) } }));
    return;
  }
  if (msg.type === CRAFT_MSG.RES) {
    const { reqId, toUserId, ...rest } = msg.payload ?? {};
    if (toUserId && toUserId !== game.user.id) return;
    const resolve = _pending.get(reqId);
    if (!resolve) return;
    _pending.delete(reqId);
    resolve(rest);
  }
}

let _installed = false;
export function installCraftSocket() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
}

export function craftFailText(r) {
  if (r?.text) return r.text;
  switch (r?.reason) {
    case "no_gm": return "Crafting needs a GM online.";
    case "timeout": return "No answer from the GM. Try again in a moment.";
    case "not_your_turn": return "Only the party leader can craft here.";
    case "no_blueprint": return "That Blueprint no longer exists.";
    case "busy": return "Still finishing the last craft.";
    case "no_actor": return "No crafter found.";
    case "camp_only_in_forge": return "Camp crafting happens through the Camp Forge activity.";
    default: return reasonText(r) || `Crafting failed (${r?.reason ?? "unknown"}).`;
  }
}
