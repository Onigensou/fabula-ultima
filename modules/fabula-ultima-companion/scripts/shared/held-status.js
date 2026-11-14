// ============================================================================
// Shared — Held status API ("inflicted until your next battle")
//
//   const hs = FUCompanion.api.heldStatus;
//   await hs.inflict({ actors: "party", status: "slow", source: "Rockslide" });
//   await hs.inflict({ actors: [zarg], status: "Dazed", turns: 2 });
//   hs.list();                       // every party member's held statuses
//   hs.list(zarg);                   // one actor
//   await hs.release({ actors: "party", status: "slow" });  // cure by hand
//   await hs.activate([zarg]);       // convert now (battle start does this)
//
// Story meaning: the actor IS inflicted now (status icon, Party Menu, and the
// condition's attribute changes apply to checks out of battle too), it does NOT
// count down while exploring, and when the actor's next battle starts it becomes
// an ordinary battle condition: it counts down on their own turns and the
// battle's end sweep cleanses it. A Rest cures it before then.
//
// The rules (flags, what each system does with them) are in held-status-rules.js.
// Lifetime gates: shared/ae-lifetime.js (isBattleHeld → not dungeon-tickable).
//
// Writes need GM authority. Called on a player client, every call is relayed to
// the primary GM and its result returned. Battle conversion runs on the battle
// host GM at fu-director-started, for every combatant whose actor holds one; a
// benched member is not a combatant, so theirs stays held for the next battle.
// ============================================================================

import {
  FLAG_NS, isHeld, statusIdsOf, matchStatus, buildHeldEffectData,
  holdExistingUpdate, conversionUpdate, describeHeld,
} from "./held-status-rules.js";
import {
  getConditionAffinityFor,
  resolveCanonicalConditionTemplate,
  buildAdoptedConditionData,
} from "../battle-director/skill-effects.js";

const TAG = "[Shared][HeldStatus]";
const CHANNEL = `module.${FLAG_NS}`;
const REQ = "FU_HELD_STATUS_REQ";
const RES = "FU_HELD_STATUS_RES";
const RELAY_TIMEOUT_MS = 15000;

const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;

// ── inputs ─────────────────────────────────────────────────────────────────
function statusEntries() {
  return (CONFIG.statusEffects ?? []).map(e => ({
    id: String(e.id ?? ""),
    name: game.i18n?.localize?.(e.name ?? e.label ?? "") ?? String(e.name ?? e.label ?? ""),
    img: e.img ?? e.icon ?? null,
  })).filter(e => e.id);
}

async function resolvePartyActors() {
  const party = await globalThis.CampSystem?.Party?.resolve?.().catch(() => []) ?? [];
  return party.map(p => p.actor).filter(Boolean);
}

async function resolveActorOne(ref) {
  if (!ref) return null;
  if (ref instanceof Actor) return ref;
  if (ref?.actor instanceof Actor) return ref.actor; // token / combatant-like
  const s = String(ref);
  if (s.includes(".")) {
    const doc = await fromUuid(s).catch(() => null);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  }
  return game.actors?.get(s) ?? null;
}

async function resolveActors(actors) {
  if (actors === "party" || actors == null) return resolvePartyActors();
  const list = Array.isArray(actors) ? actors : [actors];
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const a = await resolveActorOne(r);
    if (a && !seen.has(a.uuid)) { seen.add(a.uuid); out.push(a); }
  }
  return out;
}

// Serialisable form for the relay to the GM.
function actorsToWire(actors) {
  if (actors === "party" || actors == null) return "party";
  const list = Array.isArray(actors) ? actors : [actors];
  return list.map(r => (r instanceof Actor ? r.uuid : r?.actor instanceof Actor ? r.actor.uuid : String(r)));
}

function findStatusEffects(actor, statusId) {
  return (actor?.effects ?? []).filter(e => statusIdsOf(e).includes(statusId));
}

// ── GM-side operations ─────────────────────────────────────────────────────
async function gmInflict({ actors, status, source = "", turns = null } = {}) {
  const entry = matchStatus(statusEntries(), status);
  if (!entry) return { ok: false, error: "UNKNOWN_STATUS", status: String(status ?? "") };

  const template = resolveCanonicalConditionTemplate([entry.id])
    ?? { name: entry.name, img: entry.img, statuses: [entry.id] };

  const targets = await resolveActors(actors);
  if (!targets.length) return { ok: false, error: "NO_TARGETS" };

  const applied = [];
  const skipped = [];
  for (const actor of targets) {
    try {
      if (getConditionAffinityFor(actor, { statuses: [entry.id], name: entry.name }) === "IM") {
        skipped.push({ actorUuid: actor.uuid, name: actor.name, reason: "immune" });
        continue;
      }
      const existing = findStatusEffects(actor, entry.id);
      if (existing.some(isHeld)) {
        skipped.push({ actorUuid: actor.uuid, name: actor.name, reason: "already-held" });
        continue;
      }
      if (existing.length) {
        // Already inflicted (e.g. 2 steps left from a trap): the story now says
        // "until your next battle", so hold that one instead of stacking a copy.
        const eff = existing[0];
        await actor.updateEmbeddedDocuments("ActiveEffect", [holdExistingUpdate(eff, { source, turns })]);
        applied.push({ actorUuid: actor.uuid, name: actor.name, effectId: eff.id, held: "existing" });
        continue;
      }
      const data = buildHeldEffectData(template, { actorUuid: actor.uuid, statusId: entry.id, source, turns });
      const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
      applied.push({ actorUuid: actor.uuid, name: actor.name, effectId: created?.id ?? null, held: "new" });
    } catch (e) {
      warn(`inflict failed on ${actor?.name}`, e);
      skipped.push({ actorUuid: actor?.uuid ?? null, name: actor?.name ?? "", reason: "error", detail: String(e?.message ?? e) });
    }
  }
  log(`inflict ${entry.id}${source ? ` (${source})` : ""}: ${applied.length} held, ${skipped.length} skipped`);
  return { ok: applied.length > 0, status: entry.id, applied, skipped };
}

// The canonical condition's own effect on its container item (the "Debuff"
// container), as a registry id the Active Effect Manager understands.
function conditionRegistryId(statusId) {
  for (const it of game.items ?? []) {
    if (it.type !== "activeEffectContainer") continue;
    for (const eff of it.effects ?? []) if (statusIdsOf(eff).includes(statusId)) return eff.uuid;
  }
  return null;
}

// An ordinary status inflicted outside battle, landed the way dungeon tiles land
// theirs (dp-tile-effect-engine buildEffectRefs): registry entry + a dungeon step
// count + the landing-turn grace. Not held: it counts down while exploring.
async function gmApplyNow({ actors, status, steps = null, source = "" } = {}) {
  const entry = matchStatus(statusEntries(), status);
  if (!entry) return { ok: false, error: "UNKNOWN_STATUS", status: String(status ?? "") };
  const aem = globalThis.FUCompanion?.api?.activeEffectManager;
  if (!aem?.applyEffects) return { ok: false, error: "NO_AEM" };
  const turns = Number.isFinite(Number(steps)) && Number(steps) > 0 ? Math.floor(Number(steps)) : 3;
  const regId = conditionRegistryId(entry.id);
  const flags = { [FLAG_NS]: { dungeonTurnsRemaining: turns, dungeonTickGrace: true } };
  const ref = regId ? { registryId: regId, overrides: { flags } } : { name: entry.name, img: entry.img, statuses: [entry.id], flags };

  const targets = await resolveActors(actors);
  const applied = [];
  const skipped = [];
  const ok = [];
  for (const actor of targets) {
    if (getConditionAffinityFor(actor, { statuses: [entry.id], name: entry.name }) === "IM") {
      skipped.push({ actorUuid: actor.uuid, name: actor.name, reason: "immune" });
    } else ok.push(actor);
  }
  if (ok.length) {
    await aem.applyEffects({ actorUuids: ok.map(a => a.uuid), effects: [ref], silent: true });
    // Re-landing refreshes the count, as a tile does.
    for (const actor of ok) {
      const ups = (actor.effects ?? []).filter(e => statusIdsOf(e).includes(entry.id) && !isHeld(e))
        .map(e => ({ _id: e.id, [`flags.${FLAG_NS}.dungeonTurnsRemaining`]: turns, [`flags.${FLAG_NS}.dungeonTickGrace`]: true }));
      if (ups.length) await actor.updateEmbeddedDocuments("ActiveEffect", ups);
      applied.push({ actorUuid: actor.uuid, name: actor.name });
    }
  }
  log(`applyNow ${entry.id}${source ? ` (${source})` : ""}: ${applied.length} applied, ${skipped.length} skipped`);
  return { ok: applied.length > 0, status: entry.id, applied, skipped };
}

async function gmRelease({ actors, status = null } = {}) {
  const statusId = status ? matchStatus(statusEntries(), status)?.id : null;
  if (status && !statusId) return { ok: false, error: "UNKNOWN_STATUS", status: String(status) };
  const removed = [];
  for (const actor of await resolveActors(actors)) {
    const ids = (actor.effects ?? []).filter(e => isHeld(e) && (!statusId || statusIdsOf(e).includes(statusId))).map(e => e.id);
    if (!ids.length) continue;
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    removed.push({ actorUuid: actor.uuid, name: actor.name, count: ids.length });
  }
  return { ok: true, removed };
}

// Convert every held status on these actors into a battle condition. The
// actor passed is the one the battle sees (a linked PC token's actor IS the
// world actor, so the conversion is the same effect the sheet shows).
async function gmActivate(actors) {
  const converted = [];
  for (const actor of await resolveActors(actors)) {
    const held = (actor.effects ?? []).filter(isHeld);
    if (!held.length) continue;
    const updates = [];
    for (const eff of held) {
      const affinity = getConditionAffinityFor(actor, { statuses: eff.statuses, name: eff.name });
      if (affinity === "IM") {
        // Became immune since (gear change): the status simply ends.
        await actor.deleteEmbeddedDocuments("ActiveEffect", [eff.id]).catch(() => {});
        continue;
      }
      const adopted = buildAdoptedConditionData(eff.toObject(), { affinity: affinity === "RS" ? "RS" : null });
      updates.push(conversionUpdate(eff, adopted));
      converted.push({ actorUuid: actor.uuid, name: actor.name, effect: eff.name, charges: adopted?.flags?.[FLAG_NS]?.charges ?? null });
    }
    if (updates.length) await actor.updateEmbeddedDocuments("ActiveEffect", updates);
  }
  if (converted.length) log("battle start: converted held statuses", converted);
  return { ok: true, converted };
}

// ── relay (player client → primary GM) ─────────────────────────────────────
const OPS = { inflict: gmInflict, applyNow: gmApplyNow, release: gmRelease, activate: (args) => gmActivate(args?.actors) };
const _pending = new Map();

function relay(op, args) {
  const reqId = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(reqId);
      resolve({ ok: false, error: "NO_GM_RESPONSE" });
    }, RELAY_TIMEOUT_MS);
    _pending.set(reqId, (res) => { clearTimeout(timer); resolve(res); });
    game.socket.emit(CHANNEL, { type: REQ, reqId, userId: game.user.id, op, args });
  });
}

async function run(op, args) {
  if (game.user?.isGM) return OPS[op](args);
  if (!game.users?.activeGM) return { ok: false, error: "NO_GM_ONLINE" };
  return relay(op, { ...args, actors: actorsToWire(args?.actors) });
}

function installSocket() {
  game.socket.on(CHANNEL, async (msg) => {
    if (msg?.type === RES && msg.userId === game.user.id) {
      _pending.get(msg.reqId)?.(msg.result);
      _pending.delete(msg.reqId);
      return;
    }
    if (msg?.type !== REQ || !game.user?.isGM || !isPrimaryGM()) return;
    const fn = OPS[msg.op];
    let result;
    try { result = fn ? await fn(msg.args ?? {}) : { ok: false, error: "UNKNOWN_OP" }; }
    catch (e) { result = { ok: false, error: "CRASH", detail: String(e?.message ?? e) }; }
    game.socket.emit(CHANNEL, { type: RES, reqId: msg.reqId, userId: msg.userId, result });
  });
}

// ── battle start ───────────────────────────────────────────────────────────
function amBattleHost() {
  if (!game.user?.isGM) return false;
  const host = globalThis.FUCompanion?.api?.experimental?.battleDirector?.host?.();
  return host ? host.amHost !== false : isPrimaryGM();
}

function installBattleHook() {
  Hooks.on("fu-director-started", async (director) => {
    try {
      if (!amBattleHost()) return;
      const combatants = Array.isArray(director?.dCombat?.combatants) ? director.dCombat.combatants : [];
      const actors = combatants.map(c => c.actorDoc ?? c.tokenDoc?.actor).filter(a => a && (a.effects ?? []).some(isHeld));
      if (actors.length) await gmActivate(actors);
    } catch (e) { warn("battle-start conversion failed", e); }
  });
}

// ── public API ─────────────────────────────────────────────────────────────
const api = {
  /** Inflict a status that waits for the actor's next battle. */
  inflict: (args = {}) => run("inflict", args),
  /**
   * An ordinary status landed now, outside battle, the way a dungeon tile lands
   * one: counts down `steps` dungeon steps (default 3). Not held.
   */
  applyNow: (args = {}) => run("applyNow", args),
  /** Status names this world knows, for pickers. */
  statusNames: () => statusEntries().map(e => e.name),
  /** Remove held statuses (all, or one status) — a cure outside battle. */
  release: (args = {}) => run("release", args),
  /** Convert held statuses into battle conditions now. GM / tests. */
  activate: (actors) => run("activate", { actors }),
  /**
   * Read held statuses. No argument → every party member. Synchronous for one
   * actor; returns a Promise for the party form.
   */
  list(actor) {
    if (actor instanceof Actor) return (actor.effects ?? []).filter(isHeld).map(describeHeld);
    return resolveActors(actor ?? "party").then(list => list.map(a => ({
      actorUuid: a.uuid, name: a.name, held: (a.effects ?? []).filter(isHeld).map(describeHeld),
    })));
  },
  isHeld,
};

Hooks.once("init", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.heldStatus = api;
});
Hooks.once("ready", () => { installSocket(); installBattleHook(); });
