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

const FLAG_NS = "fabula-ultima-companion";
// Canonical Crisis AE template (name "Crisis", marker status). Same source the
// retired auto-crisis hook used, so existing gates/recognition are unchanged.
const CRISIS_TEMPLATE_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Threshold = stored crisis_hp (skill-manipulable) when present & finite, else
// ceil(max_hp/2) for NPCs/monsters that don't carry crisis_hp.
export function crisisThreshold(actor) {
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
      direction,
      // Subject = the creature whose status changed (matcher reads sourceActorUuid).
      sourceActorUuid: actor.uuid, sourceTokenUuid: tokenUuid ?? null,
      subjectActorUuid: actor.uuid, subjectTokenUuid: tokenUuid ?? null,
      originLabel: "Crisis",
    },
  });
}

// Built-in reactor — settleInstance invokes this per ledger event.
export async function crisisReactor(director, cfg) {
  if (!director?.ctx) return;
  const payload = cfg?.payload ?? {};
  if (String(payload.resource ?? "").toLowerCase() !== "hp") return;  // crisis is HP-only
  const actor = cfg.casterActor;
  if (!actor) return;
  const { changed, direction } = await evaluateCrisis(actor);
  if (changed) queueStatusEvent(director, actor, direction, payload.subjectTokenUuid ?? payload.sourceTokenUuid ?? null);
}

// One-time sweep over all combatants — seeds crisis state at combat start
// (the event-driven reactor only fires on HP changes).
export async function sweepCrisis(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  for (const c of combatants) {
    const actor = c.actor ?? (c.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor) continue;
    const { changed, direction } = await evaluateCrisis(actor);
    if (changed) queueStatusEvent(director, actor, direction, c.tokenUuid ?? null);
  }
}
