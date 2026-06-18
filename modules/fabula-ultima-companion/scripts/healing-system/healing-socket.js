// ============================================================================
// Out-of-Combat Healing — GM-mediated apply.
//
// A player operating the HUD heals party members they may not own, so the
// resource writes (target recovery + caster cost + consumable consumption) must
// run on the GM client. We use Foundry's raw socket (channel
// module.fabula-ultima-companion) with a request/response envelope keyed by a
// generated id — the same proven pattern as the shop system. (socketlib's
// registerModule can only be called once per module and is already claimed by
// gm-executor.js, so raw game.socket is the clean choice here.)
//
// Flow:
//   • requestApply(payload) — called on ANY client. If the caller is the active
//     GM it applies directly; otherwise it emits APPLY_REQ and awaits APPLY_RES.
//   • Only the ACTIVE GM processes APPLY_REQ (avoids double-apply with multiple
//     GMs) and emits APPLY_RES back to the requesting user.
//
// The GM re-resolves the heal AUTHORITATIVELY via resolveHealAction (never
// trusts client-sent amounts) and re-validates affordability + stock.
// ============================================================================

import { HEAL_TAG } from "./healing-const.js";
import { resolveHealAction } from "./healing-resolve.js";
import { debitCost } from "../battle-director/skill-cost.js";
import { consumeOne, spendIp } from "../battle-director/item-resource.js";

const CHANNEL = "module.fabula-ultima-companion";
const T_REQ = "healing.apply.req";
const T_RES = "healing.apply.res";

const _pending = new Map();   // id → { resolve, timer }
let _wired = false;

function _isActiveGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM ?? null;
  // Fall back to "first active GM" if activeGM is unavailable on this core version.
  if (active) return active.id === game.user.id;
  const firstGM = game.users?.filter?.((u) => u.isGM && u.active)?.sort?.((a, b) => a.id.localeCompare(b.id))?.[0];
  return firstGM ? firstGM.id === game.user.id : true;
}

function _readNum(actor, key) {
  const v = actor?.system?.props?.[key];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ── Authoritative apply (GM only) ───────────────────────────────────────────
async function applyHeal(payload) {
  const { casterUuid, targetUuid, effectItemUuid, costItemUuid, consumableUuid = null,
          mode = "use", ipCost = 0, cleanse = false } = payload ?? {};
  const isCreate = mode === "create";
  const caster = await fromUuid(casterUuid).catch(() => null);
  const target = await fromUuid(targetUuid).catch(() => null);
  const effectItem = await fromUuid(effectItemUuid).catch(() => null);
  const costItem = costItemUuid ? await fromUuid(costItemUuid).catch(() => null) : null;
  if (!caster || !target || !effectItem) return { ok: false, reason: "resolve-failed" };

  const resolved = resolveHealAction({ caster, effectItem, costItem, targetCount: 1 });
  // Create mode (IP craft) may be a cleanse placeholder with no resource grant;
  // otherwise it must yield a heal like any other action.
  if (!resolved.ok && !(isCreate && cleanse)) return { ok: false, reason: resolved.reason ?? "no-heal" };
  if (!resolved.affordable) return { ok: false, reason: "unaffordable", missing: resolved.missing };

  // Re-validate cost source.
  let carrier = null;
  if (isCreate) {
    const curIp = _readNum(caster, "current_ip");
    if (curIp < ipCost) return { ok: false, reason: "unaffordable-ip" };
  } else if (consumableUuid) {
    carrier = await fromUuid(consumableUuid).catch(() => null);
    if (!carrier) return { ok: false, reason: "consumable-missing" };
    const isUnique = !!carrier.system?.props?.isUnique;
    const qty = Number(carrier.system?.props?.item_quantity ?? 0) || 0;
    if (!isUnique && qty <= 0) return { ok: false, reason: "out-of-stock" };
  }

  // Apply recovery to the target (single update, clamped to max).
  const update = {};
  const applied = [];
  for (const g of (resolved.grants ?? [])) {
    const slot = { hp: ["current_hp", "max_hp"], mp: ["current_mp", "max_mp"], ip: ["current_ip", "max_ip"] }[g.resource];
    if (!slot) continue;
    const [curKey, maxKey] = slot;
    const before = _readNum(target, curKey);
    const max = _readNum(target, maxKey) || before + g.amount;
    const after = Math.min(max, before + g.amount);
    update[`system.props.${curKey}`] = after;
    applied.push({ resource: g.resource, before, after, healed: after - before });
  }
  if (Object.keys(update).length) {
    try { await target.update(update); }
    catch (e) { console.warn(HEAL_TAG, "target.update failed", e); return { ok: false, reason: "target-write-failed" }; }
  }

  // Deduct the caster's cost. Create → spend IP; otherwise → the parsed cost map.
  if (isCreate) {
    if (ipCost > 0) { try { await spendIp(caster, ipCost); } catch (e) { console.warn(HEAL_TAG, "spendIp failed", e); } }
    // TODO: cleanse placeholder (Tonic) — remove one status effect once the
    // status system is wired into this HUD.
  } else if (resolved.costMap.size) {
    try { await debitCost(caster, resolved.costMap); }
    catch (e) { console.warn(HEAL_TAG, "debitCost failed", e); }
  }

  // Consume one unit of the consumable (use mode only).
  let consumed = false;
  if (carrier) {
    const res = await consumeOne(caster, carrier);
    consumed = !!res?.ok && !res?.skipped;
  }

  return {
    ok: true,
    targetName: target.name,
    casterName: caster.name,
    applied,
    cost: isCreate ? (ipCost > 0 ? { ip: ipCost } : {}) : Object.fromEntries(resolved.costMap),
    consumed,
    created: isCreate,
    placeholder: isCreate && cleanse && !applied.length,
  };
}

// ── Socket plumbing ─────────────────────────────────────────────────────────
function _onSocket(msg) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === T_REQ) {
    if (!_isActiveGM()) return;
    Promise.resolve(applyHeal(msg.payload))
      .then((result) => game.socket.emit(CHANNEL, { type: T_RES, id: msg.id, toUserId: msg.fromUserId, result }))
      .catch((e) => {
        console.warn(HEAL_TAG, "applyHeal threw", e);
        game.socket.emit(CHANNEL, { type: T_RES, id: msg.id, toUserId: msg.fromUserId, result: { ok: false, reason: "exception" } });
      });
    return;
  }

  if (msg.type === T_RES) {
    if (msg.toUserId && msg.toUserId !== game.user.id) return;
    const entry = _pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    _pending.delete(msg.id);
    entry.resolve(msg.result ?? { ok: false, reason: "empty-result" });
  }
}

export function wireHealingSocket() {
  if (_wired) return;
  _wired = true;
  game.socket.on(CHANNEL, _onSocket);
  console.debug(HEAL_TAG, "socket wired");
}

// Public — request a heal apply. Resolves to the GM's result object.
export async function requestApply(payload) {
  // GM (active) applies directly — no round-trip.
  if (_isActiveGM()) return applyHeal(payload);

  const id = `heal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_pending.has(id)) { _pending.delete(id); resolve({ ok: false, reason: "timeout" }); }
    }, 10_000);
    _pending.set(id, { resolve, timer });
    game.socket.emit(CHANNEL, { type: T_REQ, id, fromUserId: game.user.id, payload });
  });
}
