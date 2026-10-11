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
// trusts client-sent amounts) and re-validates affordability + stock. It also
// checks WHO asked: the requester is the socket frame's server-stamped sender
// (never a self-reported id), and a player may only act as a caster they own,
// spending only that caster's own consumables / skills.
// ============================================================================

import { HEAL_TAG } from "./healing-const.js";
import { resolveHealAction } from "./healing-resolve.js";
import { actorDebuffs } from "./healing-cleanse.js";
import { HealingFeedback } from "./healing-feedback.js";
import { debitCost } from "../battle-director/skill-cost.js";
import { consumeOne, spendIp } from "../battle-director/item-resource.js";
import { getPotionRain, isPotionItem, halveHeal } from "./potion-rain.js";
import { gatherHealingActions } from "./healing-actions.js";

const CHANNEL = "module.fabula-ultima-companion";
const T_REQ = "healing.apply.req";
const T_RES = "healing.apply.res";
const T_FEEDBACK = "healing.feedback";   // operator → all OTHER clients (spectator toast)

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

// Remove debuff(s) from one target. scope "all" → every debuff; "one" → the
// picked debuff (debuffId), else the first. Returns applied entries.
async function _applyCleanseToTarget(target, scope, debuffId) {
  const debuffs = actorDebuffs(target);
  if (!debuffs.length) return [];
  let toRemove;
  if (scope === "all") toRemove = debuffs;
  else {
    const picked = debuffId ? debuffs.find((e) => e.id === debuffId) : null;
    toRemove = [picked ?? debuffs[0]];
  }
  const entries = toRemove.filter(Boolean).map((e) => ({ type: "cleanse", targetName: target.name, debuffName: e.name }));
  try { await target.deleteEmbeddedDocuments("ActiveEffect", toRemove.map((e) => e.id)); }
  catch (e) { console.warn(HEAL_TAG, "deleteEmbeddedDocuments failed", e); return []; }
  return entries;
}

// Is `doc` an embedded document of `actor` (world actor or token synthetic)?
function _isOn(doc, actor) {
  return !!doc && !!actor && doc.parent?.uuid === actor.uuid;
}

const _same = (a, b) => (a ?? null) === (b ?? null);

// Party members a player may heal: the HUD's own target grid.
async function _partyActorIds() {
  try {
    const party = await globalThis.CampSystem?.Party?.resolve?.();
    if (Array.isArray(party)) return new Set(party.map((m) => m?.actor?.id ?? m?.actorId).filter(Boolean));
  } catch (e) { console.warn(HEAL_TAG, "party resolve failed", e); }
  return null;
}

// Authorise a request, or refuse it. A GM may heal from any caster (the HUD's
// GM fallback picks the first party member) and is trusted as sent. A player's
// request is only honoured as one of the caster's REAL actions: the GM gathers
// the caster's healing actions itself and requires the payload to name one row
// exactly. Everything that decides cost and effect — kind, cleanse scope, IP
// cost, the carrier — then comes from that row, never from the payload, so a
// hand-built frame can't pair a free cost with a strong heal, skip consuming a
// potion, or turn a one-target tonic into a cleanse-all.
async function _authorise(user, payload, { caster, consumable, targets }) {
  if (!user) return { refusal: "unknown-user" };
  if (user.isGM) return { row: null };
  if (!caster.testUserPermission?.(user, "OWNER")) return { refusal: "not-your-caster" };
  if (consumable && !_isOn(consumable, caster)) return { refusal: "not-your-item" };

  const actions = Object.values(await gatherHealingActions(caster)).flat();
  const row = actions.find((d) =>
    _same(d.effectItemUuid, payload.effectItemUuid) && _same(d.costItemUuid, payload.costItemUuid)
    && _same(d.consumableUuid, payload.consumableUuid) && _same(d.mode ?? "use", payload.mode ?? "use")
    && _same(d.carrierUuid, payload.carrierUuid));
  if (!row) return { refusal: "not-an-action" };

  // Targets: the active party only, and only as many as the action reaches.
  const party = await _partyActorIds();
  const allowed = party?.size ? party : new Set([caster.id]);
  if (targets.some((t) => !allowed.has(t.id))) return { refusal: "target-not-in-party" };
  if (row.targeting === "self" && targets.some((t) => t.id !== caster.id)) return { refusal: "self-only" };
  if (row.targeting !== "all" && targets.length > 1 && !payload.potionRain) return { refusal: "too-many-targets" };
  return { row };
}

// ── Authoritative apply (GM only) — heal OR cleanse, one OR many targets ─────
// `requesterUserId` is who asked: this client on a direct apply, the socket
// frame's sender on a relayed one.
async function applyHeal(payload, requesterUserId = game.user?.id) {
  payload = payload ?? {};
  const {
    casterUuid, targetUuids = [], effectItemUuid, costItemUuid, consumableUuid = null,
    mode = "use", cleansePicks = null, potionRain = false,
  } = payload;
  let { kind = "heal", ipCost = 0, cleanseScope = null, carrierUuid = null } = payload;
  const isCreate = mode === "create";

  const caster = await fromUuid(casterUuid).catch(() => null);
  const effectItem = await fromUuid(effectItemUuid).catch(() => null);
  const costItem = costItemUuid ? await fromUuid(costItemUuid).catch(() => null) : null;
  const targets = [];
  for (const u of targetUuids) { const t = await fromUuid(u).catch(() => null); if (t) targets.push(t); }
  if (!caster || !effectItem || !targets.length) return { ok: false, reason: "resolve-failed" };

  const consumable = (!isCreate && consumableUuid) ? await fromUuid(consumableUuid).catch(() => null) : null;
  const { refusal, row } = await _authorise(game.users?.get(requesterUserId) ?? null, payload, { caster, consumable, targets });
  if (refusal) {
    console.warn(HEAL_TAG, `apply refused (${refusal})`, { requesterUserId, casterUuid, effectItemUuid, consumableUuid, costItemUuid });
    return { ok: false, reason: refusal };
  }
  if (row) {
    kind = row.kind ?? "heal";
    cleanseScope = row.cleanseScope ?? null;
    ipCost = row.ipCost ?? 0;
    carrierUuid = row.carrierUuid ?? null;
  }
  const isCleanse = kind === "cleanse";

  // Cost is resolved ONCE against the action ("×T" costs scale with targets).
  // The count is the targets actually sent — a Potion Rain spread is one use —
  // never a client-reported number.
  const targetCount = (potionRain && targets.length > 1) ? 1 : targets.length;
  const resolved = resolveHealAction({ caster, effectItem, costItem, targetCount: Math.max(1, targetCount) });
  if (!isCleanse && !resolved.ok) return { ok: false, reason: resolved.reason ?? "no-heal" };
  if (!resolved.affordable) return { ok: false, reason: "unaffordable", missing: resolved.missing };

  // Re-validate cost source.
  let carrier = null;
  if (isCreate) {
    if (_readNum(caster, "current_ip") < ipCost) return { ok: false, reason: "unaffordable-ip" };
  } else if (consumableUuid) {
    carrier = consumable;
    if (!carrier) return { ok: false, reason: "consumable-missing" };
    const isUnique = !!carrier.system?.props?.isUnique;
    const qty = Number(carrier.system?.props?.item_quantity ?? 0) || 0;
    if (!isUnique && qty <= 0) return { ok: false, reason: "out-of-stock" };
  }

  // Potion Rain spread — AUTHORITATIVE re-validation (never trust the client):
  // the caster must own Potion Rain, the item must be a tagged potion, and the
  // target count must fit 1 primary + SL extra. Only then do grants halve.
  let spread = false;
  if (potionRain && !isCleanse && targets.length > 1) {
    const pr = getPotionRain(caster);
    if (!pr.has) return { ok: false, reason: "no-potion-rain" };
    // The potion tag may live on the effect item (consumables: carrier == effect)
    // OR on the carrier/preset (Create presets heal via a linked action whose
    // own item isn't tagged). Accept either.
    const presetCarrier = carrier ?? (carrierUuid ? await fromUuid(carrierUuid).catch(() => null) : null);
    if (!isPotionItem(effectItem) && !isPotionItem(presetCarrier)) return { ok: false, reason: "not-a-potion" };
    if (targets.length > 1 + pr.sl) return { ok: false, reason: "too-many-targets" };
    spread = true;
  }

  const applied = [];

  if (isCleanse) {
    // Cleanse = embedded ActiveEffect deletes (can't fold into an actor update).
    const perTarget = await Promise.all(targets.map((target) =>
      _applyCleanseToTarget(target, cleanseScope, cleansePicks?.[target.uuid] ?? null)));
    applied.push(...perTarget.flat());
    // Deduct the caster's cost (separate write; cleanse isn't the perf case).
    if (isCreate) {
      if (ipCost > 0) { try { await spendIp(caster, ipCost); } catch (e) { console.warn(HEAL_TAG, "spendIp failed", e); } }
    } else if (resolved.costMap.size) {
      try { await debitCost(caster, resolved.costMap); } catch (e) { console.warn(HEAL_TAG, "debitCost failed", e); }
    }
  } else {
    // Heal: build ONE merged write per actor — target recoveries AND the caster's
    // cost — then commit them all in a single batched Actor.updateDocuments call.
    // Each actor.update triggers heavy synchronous CSB prepareData, so paying it
    // once for the whole group (instead of per target + per cost) is the win.
    const spreadGrants = spread ? resolved.grants.map((g) => ({ ...g, amount: halveHeal(g.amount) })) : resolved.grants;
    const HEAL_PROP = { hp: "current_hp", mp: "current_mp", ip: "current_ip" };
    const HEAL_MAX = { hp: "max_hp", mp: "max_mp", ip: "max_ip" };
    const plan = new Map();   // actorId → { doc, update }
    const ensure = (doc) => { let e = plan.get(doc.id); if (!e) plan.set(doc.id, e = { doc, update: {} }); return e; };

    for (const target of targets) {
      const e = ensure(target);
      for (const g of spreadGrants) {
        const prop = HEAL_PROP[g.resource]; if (!prop) continue;
        const before = _readNum(target, prop);
        const max = _readNum(target, HEAL_MAX[g.resource]) || before + g.amount;
        const after = Math.min(max, before + g.amount);
        e.update[`system.props.${prop}`] = after;
        applied.push({ type: "heal", targetName: target.name, resource: g.resource, before, after, max, healed: after - before });
      }
    }

    // Fold the caster's cost into the same batch (reads the merged value first so
    // a self-heal + cost on the same resource composes correctly).
    const debit = (prop, amount) => {
      const e = ensure(caster);
      const key = `system.props.${prop}`;
      const cur = e.update[key] ?? _readNum(caster, prop);
      e.update[key] = Math.max(0, cur - amount);
    };
    if (isCreate) {
      if (ipCost > 0) debit("current_ip", ipCost);
    } else {
      for (const [resource, amount] of resolved.costMap) { if (HEAL_PROP[resource]) debit(HEAL_PROP[resource], amount); }
    }

    // Commit: one batched write for world actors; token/synthetic actors update
    // individually (they live on the scene, not the world collection).
    const worldUpdates = [];
    const tokenWrites = [];
    for (const { doc, update } of plan.values()) {
      if (!Object.keys(update).length) continue;
      if (doc.isToken) tokenWrites.push(doc.update(update));
      else worldUpdates.push({ _id: doc.id, ...update });
    }
    try {
      if (worldUpdates.length) await Actor.updateDocuments(worldUpdates);
      if (tokenWrites.length) await Promise.all(tokenWrites);
    } catch (e) { console.warn(HEAL_TAG, "batched heal update failed", e); }
  }

  // Consume one unit of the consumable (use mode only).
  let consumed = false;
  if (carrier) {
    const res = await consumeOne(caster, carrier);
    consumed = !!res?.ok && !res?.skipped;
  }

  return {
    ok: true,
    kind,
    casterName: caster.name,
    applied,
    cost: isCreate ? (ipCost > 0 ? { ip: ipCost } : {}) : Object.fromEntries(resolved.costMap),
    consumed,
    created: isCreate,
  };
}

// ── Socket plumbing ─────────────────────────────────────────────────────────
// `senderId` is stamped by the server on module-channel frames — the requester
// is whoever SENT the frame, never `msg.fromUserId` (any client can claim a GM's
// id). Without it the request is refused rather than trusted.
function _onSocket(msg, senderId) {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === T_REQ) {
    if (!_isActiveGM()) return;
    Promise.resolve(applyHeal(msg.payload, senderId ?? null))
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
    return;
  }

  if (msg.type === T_FEEDBACK) {
    // Only OTHER clients receive this (emit doesn't echo to the operator, who
    // already sees the HUD). Spectators get the toast.
    try { HealingFeedback.enqueue(msg.payload); } catch (e) { console.warn(HEAL_TAG, "feedback enqueue failed", e); }
  }
}

// Operator → all other clients: show the spectator heal toast.
export function broadcastHealFeedback(payload) {
  try { game.socket.emit(CHANNEL, { type: T_FEEDBACK, payload }); }
  catch (e) { console.warn(HEAL_TAG, "broadcastHealFeedback failed", e); }
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
