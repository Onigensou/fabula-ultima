// scripts/orbment/orbment-attune.js
//
// ATTUNE — the random Orbment roll (Orbment v3), run on ONE GM client.
//
// Entry: FUCompanion.api.orbment.attune({ itemUuid, slots: [{ index, grade }], mode })
//   mode "shop"  — the Alchemist: each slot carries the stone the player placed
//                  (rough | polished); Zenit = sum of attunePrice per slot.
//   mode "field" — Camp Forge Field Attune: free; each slot's grade comes from
//                  the attuner's hidden DEX + INS check (orbment-roll-tables
//                  fieldGrade). The attuner is the item's owner (own gear only).
//
// A player client sends the request over the module socket; the PRIMARY GM
// (FUCompanion.isPrimaryGM — the dual-GM dedupe rule) validates, charges, rolls,
// writes every slot in ONE flag update and recompiles ONCE, then answers with
// per-slot results. A GM calling it runs locally. The roll is GM-side so a
// player can't fake it. Overwrite is the design: the new roll replaces the slot.

import { FLAG_NS, ORBMENT_FLAG, readOrbment, slotCountOf, itemKindOf } from "./orbment-const.js";
import { getAugment, resolveAugment, rollableAugments } from "./augment-registry.js";
import { recompileOrbment } from "./orbment-compiler.js";
import { STONES, attunePrice, rollAugment, slotStanding, verdictFor, leadVerdict, fieldGrade } from "./orbment-roll-tables.js";

const TAG = "[Orbment][Attune]";
const CHANNEL = "module.fabula-ultima-companion";
export const ATTUNE_MSG = Object.freeze({ REQ: "orbment:attune:req", RES: "orbment:attune:res" });
const TIMEOUT_MS = 15000;
const EQUIPPABLE = new Set(["weapon", "armor", "shield"]);

const _pending = new Map();   // reqId → resolve

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;
const readZenit = (actor) => Math.max(0, Number(actor?.system?.props?.zenit ?? 0) || 0);
// A die size off the sheet ("d8" | 8 | "8") — current first, base as fallback.
function dieOf(actor, attr) {
  const p = actor?.system?.props ?? {};
  const raw = p[`${attr}_current`] ?? p[`${attr}_base`] ?? 8;
  const n = Number(String(raw).replace(/^d/i, ""));
  return Number.isFinite(n) && n > 0 ? n : 8;
}

// The display shape of one installed / rolled slot (null = empty).
function slotView(slot) {
  if (!slot) return null;
  const v = resolveAugment(slot.id, slot.param, slot.value);
  if (!v) return null;
  return { id: v.id, param: v.param, value: v.value, label: v.label, summary: v.summary, category: v.category, tier: v.tier, unit: v.unit };
}

function fail(reason, extra = {}) { return { ok: false, reason, ...extra }; }

// ── GM side ──────────────────────────────────────────────────────────────────
export async function executeAttune({ itemUuid, slots, mode = "shop", requesterUserId = null } = {}) {
  try {
    const item = await fromUuid(String(itemUuid ?? "")).catch(() => null);
    if (!item || item.documentName !== "Item") return fail("item_not_found");
    const actor = item.parent;
    if (!actor) return fail("item_not_owned");
    const kind = itemKindOf(item);
    if (!EQUIPPABLE.has(kind)) return fail("not_equippable");

    // Own gear only (shop + field). A GM may act for anyone.
    const requester = requesterUserId ? game.users.get(requesterUserId) : game.user;
    if (requester && !requester.isGM && !actor.testUserPermission(requester, "OWNER")) return fail("not_your_gear");

    // Validate the requested slots: unique, in range, shop slots need a stone.
    const count = slotCountOf(item);
    const asked = Array.isArray(slots) ? slots : [];
    const seen = new Set();
    const plan = [];
    for (const s of asked) {
      const index = Number(s?.index);
      if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) return fail("bad_slot", { index: s?.index });
      seen.add(index);
      if (mode === "shop" && !STONES[s?.grade]) return fail("bad_stone", { index });
      plan.push({ index, grade: mode === "shop" ? s.grade : null });
    }
    if (!plan.length) return fail("no_slots");
    if (mode !== "shop" && mode !== "field") return fail("bad_mode");

    // Field grades: the attuner's hidden DEX + INS check, per slot.
    if (mode === "field") {
      const dex = dieOf(actor, "dex"), ins = dieOf(actor, "ins");
      for (const p of plan) p.grade = fieldGrade(dex, ins).grade;
    }

    // Price + charge (shop only). Charged BEFORE the roll: the stone is spent
    // whatever comes out, like refinement.
    const rarity = item.system?.props?.item_rarity;
    const cost = mode === "shop" ? plan.reduce((t, p) => t + attunePrice(rarity, p.grade), 0) : 0;
    if (cost > 0) {
      const have = readZenit(actor);
      if (have < cost) return fail("not_enough_zenit", { cost, have });
      const tc = window["oni.ItemTransferCore"];
      if (tc?.adjustZenit) {
        const r = await tc.adjustZenit({ actorUuid: actor.uuid, delta: -cost, requestedByUserId: requester?.id ?? null });
        if (!r?.ok) return fail("charge_failed", { cost });
      } else {
        await actor.update({ "system.props.zenit": have - cost });
      }
    }

    // Roll. Slots NOT being attuned keep their augment and block duplicates;
    // each new roll joins the blocked set so a batch can't land the same one twice.
    const orb = readOrbment(item);
    const pool = rollableAugments(kind);
    const attuning = new Set(plan.map((p) => p.index));
    const taken = orb.slots
      .map((s, i) => (s && !attuning.has(i) ? `${s.id}|${s.param ?? ""}` : null))
      .filter(Boolean);
    const newSlots = orb.slots.slice();
    const results = [];
    for (const p of plan) {
      const rolled = rollAugment(pool, p.grade, { taken });
      if (!rolled) { results.push({ index: p.index, grade: p.grade, was: slotView(orb.slots[p.index]), now: slotView(orb.slots[p.index]), verdict: "sidegrade", empty: true }); continue; }
      taken.push(`${rolled.id}|${rolled.param ?? ""}`);
      const was = orb.slots[p.index];
      const verdict = verdictFor(
        was ? slotStanding(getAugment(was.id), was.value) : null,
        { tier: rolled.tier, stepIndex: rolled.stepIndex, stepCount: rolled.stepCount });
      const now = { id: rolled.id, param: rolled.param, value: rolled.value, source: mode === "field" ? "field" : "roll" };
      newSlots[p.index] = now;
      results.push({ index: p.index, grade: p.grade, was: slotView(was), now: slotView(now), verdict });
    }

    // One write + one recompile for the whole batch (mirrors the link group).
    await item.update({ [`flags.${FLAG_NS}.${ORBMENT_FLAG}.slots`]: newSlots });
    await recompileOrbment(item);

    const out = {
      ok: true, mode, itemUuid: item.uuid, itemName: item.name, itemImg: item.img, itemRarity: String(rarity ?? ""),
      actorUuid: actor.uuid, actorName: actor.name, cost, zenitAfter: readZenit(actor),
      results, lead: leadVerdict(results.map((r) => r.verdict)),
    };
    console.debug(TAG, "attuned", out);
    return out;
  } catch (e) {
    console.error(TAG, "executeAttune failed", e);
    return fail("error", { message: String(e?.message ?? e) });
  }
}

// ── Client side ──────────────────────────────────────────────────────────────
export function attune({ itemUuid, slots, mode = "shop" } = {}) {
  if (game.user?.isGM) return executeAttune({ itemUuid, slots, mode, requesterUserId: game.user.id });
  if (!game.users?.activeGM && !game.users?.some?.((u) => u.isGM && u.active)) {
    return Promise.resolve(fail("no_gm"));
  }
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    _pending.set(reqId, resolve);
    game.socket.emit(CHANNEL, { type: ATTUNE_MSG.REQ, payload: { reqId, itemUuid, slots, mode, requesterUserId: game.user.id } });
    setTimeout(() => {
      if (!_pending.has(reqId)) return;
      _pending.delete(reqId);
      resolve(fail("timeout"));
    }, TIMEOUT_MS);
  });
}

function onSocket(msg) {
  if (!msg?.type) return;
  if (msg.type === ATTUNE_MSG.REQ) {
    if (!isPrimaryGM()) return;                       // exactly one GM writes
    const { reqId, ...req } = msg.payload ?? {};
    executeAttune(req)
      .then((r) => game.socket.emit(CHANNEL, { type: ATTUNE_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ...r } }))
      .catch((e) => game.socket.emit(CHANNEL, { type: ATTUNE_MSG.RES, payload: { reqId, toUserId: req.requesterUserId, ok: false, reason: "server_error", message: String(e?.message ?? e) } }));
    return;
  }
  if (msg.type === ATTUNE_MSG.RES) {
    const { reqId, toUserId, ...rest } = msg.payload ?? {};
    if (toUserId && toUserId !== game.user.id) return;
    const resolve = _pending.get(reqId);
    if (!resolve) return;
    _pending.delete(reqId);
    resolve(rest);
  }
}

let _installed = false;
export function installAttuneSocket() {
  if (_installed) return;
  _installed = true;
  game.socket.on(CHANNEL, onSocket);
}

// Human-readable reason for a failed attune (window toasts).
export function attuneFailText(r) {
  switch (r?.reason) {
    case "not_enough_zenit": return `Not enough Zenit — this needs ${r.cost} z and you have ${r.have} z.`;
    case "not_your_gear": return "You can only attune your own gear.";
    case "no_gm": return "The Alchemist needs a GM online to work.";
    case "timeout": return "The Alchemist didn't answer. Try again in a moment.";
    case "no_slots": return "Place a stone on at least one socket.";
    case "not_equippable": return "Only weapons, armor and shields hold Orbments.";
    default: return `Attunement failed (${r?.reason ?? "unknown"}).`;
  }
}
