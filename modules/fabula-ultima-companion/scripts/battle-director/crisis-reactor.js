/**
 * Built-in crisis reactor — the BD-native replacement for the detached
 * `auto-crisis-detection.js` hook. Reconciles each creature's Crisis AE against
 * its HP, by the creature's STORED `crisis_hp` (skill-manipulable; NPCs that
 * lack it fall back to ceil(max/2)).
 *
 * Runs INSIDE settleInstance (registered via registerBuiltinReactor) so it is
 * fully supervised by the FSM — fires on every `hp` resource-ledger event from
 * any commit path (Burn ticks at Start-of-Turn, attack/effect damage at the
 * RESOLVE tail). A one-time sweepCrisis() at conflict_start seeds the initial
 * state for creatures already below threshold when combat begins.
 *
 * Applying the Crisis AE appends a `creature_status_applied` event to the ledger
 * so the settle loop cascades (On-the-Hunt consumes it in a later batch);
 * removal appends `creature_loses_status`.
 *
 * Idempotent: evaluateCrisis reads current state + checks for an existing Crisis
 * AE before applying/removing, so repeated evaluation is a no-op. The Crisis AE
 * is the canonical template (name "Crisis", marker status) so `aeWhen("Crisis")`
 * gates (Dark Blood) keep working.
 */
import { log, warn } from "./logger.js";
import { isBattlefieldObject } from "./battlefield-object.js";
import { isOutOfPlay } from "./out-of-play.js";

const FLAG_NS = "fabula-ultima-companion";
// Canonical Crisis AE template (name "Crisis", marker status). Same source the
// retired auto-crisis hook used, so existing gates/recognition are unchanged.
const CRISIS_TEMPLATE_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Threshold = stored crisis_hp (skill-manipulable) when present & finite, else
// ceil(max_hp/2) for NPCs/monsters that don't carry crisis_hp.
export function crisisThreshold(actor) {
  // Crisis is a creature's state. No threshold also keeps an object out of
  // TARGET_WAS_IN_CRISIS, which reads this through captureSubjectSnapshot.
  if (isBattlefieldObject(actor)) return null;
  const p = actor?.system?.props ?? {};
  const stored = num(p.crisis_hp);
  if (stored != null) return stored;
  const max = num(p.max_hp);
  return max != null ? Math.ceil(max / 2) : null;
}

function isCrisisAE(e) {
  if (!e || e.disabled === true) return false;
  if (e.flags?.[FLAG_NS]?.bdCrisis === true) return true;
  if (e.flags?.[FLAG_NS]?.autoCrisis === true) return true;       // recognize any legacy-applied AE
  if (String(e.name ?? "").trim().toLowerCase() === "crisis") return true;
  return false;
}
function findCrisisAEs(actor) {
  return (actor?.effects?.contents ?? []).filter(isCrisisAE);
}

let _templateData = null;
async function buildCrisisData() {
  if (!_templateData) {
    const tpl = await fromUuid(CRISIS_TEMPLATE_UUID);
    if (!tpl) return null;
    const data = tpl.toObject();
    delete data._id;
    data.origin = CRISIS_TEMPLATE_UUID;
    data.duration = {};                                            // indefinite until HP recovers
    data.flags = data.flags ?? {};
    data.flags[FLAG_NS] = { ...(data.flags[FLAG_NS] ?? {}), bdCrisis: true };
    _templateData = data;
  }
  return foundry.utils.deepClone(_templateData);
}

// Reconcile ONE actor's Crisis AE against current HP.
// Returns { changed, direction: "applied" | "removed" | null }.
export async function evaluateCrisis(actor) {
  if (!actor) return { changed: false, direction: null };
  // Crisis is a creature's state; a Soul Fragment's low HP is not one.
  if (isBattlefieldObject(actor)) return { changed: false, direction: null };
  // Out of play (out-of-play.js): not on the field. Whoever brings it back reconciles it (evaluateCrisis).
  if (isOutOfPlay(actor)) return { changed: false, direction: null };
  const cur = num(actor.system?.props?.current_hp);
  const threshold = crisisThreshold(actor);
  if (cur == null || threshold == null) return { changed: false, direction: null };

  const inCrisis = cur <= threshold;
  const existing = findCrisisAEs(actor);

  if (inCrisis && existing.length === 0) {
    const data = await buildCrisisData();
    if (!data) { warn("crisis-reactor: Crisis template missing — cannot apply"); return { changed: false, direction: null }; }
    await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    log(`crisis-reactor: applied Crisis to ${actor.name} (hp ${cur} ≤ ${threshold})`);
    return { changed: true, direction: "applied" };
  }
  if (!inCrisis && existing.length > 0) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map((e) => e.id).filter(Boolean));
    log(`crisis-reactor: removed Crisis from ${actor.name} (hp ${cur} > ${threshold})`);
    return { changed: true, direction: "removed" };
  }
  // Collapse accidental duplicates without reporting a transition.
  if (inCrisis && existing.length > 1) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing.slice(1).map((e) => e.id).filter(Boolean));
  }
  return { changed: false, direction: null };
}

// Append the status event that the settle loop cascades on (On-the-Hunt etc.).
function queueStatusEvent(director, actor, direction, tokenUuid) {
  if (!Array.isArray(director.ctx._postResolveTriggers)) director.ctx._postResolveTriggers = [];
  director.ctx._postResolveTriggers.push({
    casterActor: actor,
    trigger: direction === "applied" ? "creature_status_applied" : "creature_loses_status",
    payload: {
      status: "Crisis",
      statusTags: [],   // vocabulary parity with apply_ae / remove_ae (STATUS_HAS_TAG_<X>)
      direction,
      // Subject = the creature whose status changed (matcher reads sourceActorUuid).
      sourceActorUuid: actor.uuid, sourceTokenUuid: tokenUuid ?? null,
      subjectActorUuid: actor.uuid, subjectTokenUuid: tokenUuid ?? null,
      originLabel: "Crisis",
    },
  });
}

// ── Announce by DIFF, not by "did I write it" ────────────────────────────
// Crisis has TWO writers. This reactor runs in the settle loop and can queue the
// status event; derived-status-reactor's safety net (Prong B, the updateActor
// hook — rule "core-crisis") reconciles the moment HP is written and has no
// director to queue on. The hook fires on the damage write itself, long before
// RESOLVE's settle, so it nearly always wins: the settle then finds Crisis
// already there, reports `changed:false`, and the transition is never announced.
// Every "when you enter Crisis" reaction (Emergency Item, On the Hunt, Heart of
// Darkness) went silent that way. So announce what is TRUE now against what this
// battle last announced, whoever wrote the AE. The record lives on the director
// ctx (one battle); an actor with no record (a resume after a reload, a summon
// that joined mid-battle) falls back to this reactor's own write until the next
// sweep seeds it.
function announcedMap(director) {
  return (director.ctx._crisisAnnounced ??= {});
}

// A Crisis status event already on the ledger (queued by the derived-status
// reactor, or by us) — record it so the other writer does not repeat it.
export function noteCrisisAnnounced(director, actor, present) {
  if (!director?.ctx || !actor?.uuid) return;
  announcedMap(director)[actor.uuid] = !!present;
}

// Queue the status event iff Crisis presence differs from the last announcement.
// `fallback` = this caller's own transition, used only when there is no record.
export function announceCrisisTransition(director, actor, tokenUuid, fallback = null) {
  if (!director?.ctx || !actor?.uuid) return null;
  const present = findCrisisAEs(actor).length > 0;
  const known = announcedMap(director)[actor.uuid];
  let direction = null;
  if (known === undefined) direction = fallback;
  else if (present !== known) direction = present ? "applied" : "removed";
  announcedMap(director)[actor.uuid] = present;
  if (direction) queueStatusEvent(director, actor, direction, tokenUuid);
  return direction;
}

// Built-in reactor — settleInstance invokes this per ledger event.
export async function crisisReactor(director, cfg) {
  if (!director?.ctx) return;
  const payload = cfg?.payload ?? {};
  const actor = cfg.casterActor;
  if (!actor) return;
  if (String(payload.status ?? "").toLowerCase() === "crisis"
      && (cfg.trigger === "creature_status_applied" || cfg.trigger === "creature_loses_status")) {
    noteCrisisAnnounced(director, actor, cfg.trigger === "creature_status_applied");
    return;
  }
  if (String(payload.resource ?? "").toLowerCase() !== "hp") return;  // crisis is HP-only
  const { changed, direction } = await evaluateCrisis(actor);
  announceCrisisTransition(director, actor, payload.subjectTokenUuid ?? payload.sourceTokenUuid ?? null, changed ? direction : null);
}

// Sweep over all combatants — seeds crisis state at combat start (the
// event-driven reactor only fires on HP changes), and at every turn_start
// announces a change no settle saw (a manual HP edit between turns).
export async function sweepCrisis(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  for (const c of combatants) {
    const actor = c.actor ?? (c.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor) continue;
    const { changed, direction } = await evaluateCrisis(actor);
    announceCrisisTransition(director, actor, c.tokenUuid ?? null, changed ? direction : null);
  }
}
