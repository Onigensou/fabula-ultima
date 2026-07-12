/**
 * Derived-Status Reactor — generalizes crisis-reactor.js to DATA-AUTHORED rules
 * of the form "while <when> → grant status <grant>". Two-pronged supervision:
 *
 *   A) settle-loop reactor  — in-combat, fires on resource/status ledger events
 *      (registerBuiltinReactor) + a conflict_start sweep.
 *   B) updateActor/updateItem/AE safety net — BD-INDEPENDENT standing hooks, so
 *      manual HP/status edits, out-of-combat changes, and non-combatants all
 *      reconcile (the gap Crisis has today; see docs/derived-status-reactor.md).
 *
 * Reconcile is idempotent + non-stacking: the reactor owns at most ONE tagged
 * instance of each derived status per actor, never clobbers an independently
 * applied copy, and refcounts the providing rules in `byRules`.
 *
 * Phase 1: authored rules only (Crisis stays on crisis-reactor). Migration of
 * Crisis onto a `core-crisis` rule is Phase 2 (spec §7).
 */
import { log, warn } from "./logger.js";
import { crisisThreshold } from "./crisis-reactor.js";

const FLAG_NS = "fabula-ultima-companion";

// Engine-seeded built-in rules — applied to EVERY actor (no carrier AE, no equip
// gate). Phase 2: Crisis migrates here so its reconcile ALSO runs through Prong B
// (manual HP edits / out of combat / non-combatants) — the coverage crisis-reactor
// lacked. Built-in rules use a JS `predicate(actor)` (vs authored rules' `when`
// formula) and may name an explicit `grantTemplateUuid` (Crisis isn't in a hub).
const CRISIS_TEMPLATE_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";
const BUILTIN_RULES = [{
  ruleKey: "core-crisis",
  grant: "Crisis",
  grantTemplateUuid: CRISIS_TEMPLATE_UUID,
  extraFlags: { bdCrisis: true },   // so isCrisisAE / aeWhen("Crisis") gates recognise it
  predicate: (actor) => {
    const cur = Number(actor?.system?.props?.current_hp);
    const t = crisisThreshold(actor);
    return Number.isFinite(cur) && t != null && cur <= t;
  },
}];

// ── rule collection ──────────────────────────────────────────────────────────
// Rules live in `flags[NS].deriveStatus` on an AE — on the actor directly, or on
// an item (equip-gated by the carrier item's isEquipped when requireEquipped).
// Scanning item.effects directly (not appliedEffects) so a flag-only carrier AE
// with no `changes` is still found.
function collectRules(actor) {
  const rules = [];
  const consider = (e, carrierItem) => {
    if (!e || e.disabled) return;
    const spec = e.flags?.[FLAG_NS]?.deriveStatus;
    if (!spec) return;
    for (const r of (Array.isArray(spec) ? spec : [spec])) {
      if (!r?.when || !r?.grant) continue;
      const requireEquipped = r.requireEquipped !== false; // default true
      if (requireEquipped && carrierItem && !carrierItem.system?.props?.isEquipped) continue;
      rules.push({
        when: String(r.when),
        grant: String(r.grant),
        ruleKey: String(r.ruleKey || `${e.id}:${r.grant}`),
      });
    }
  };
  for (const e of (actor?.effects?.contents ?? [])) consider(e, null);
  for (const it of (actor?.items ?? [])) for (const e of it.effects) consider(e, it);
  for (const b of BUILTIN_RULES) rules.push({ ...b });   // engine-seeded, always
  return rules;
}

// ── canonical status template (activeEffectContainer hubs — Buff/Debuff) ─────
function findHubTemplate(name) {
  const want = String(name).trim().toLowerCase();
  for (const it of (game.items ?? [])) {
    if (it.type !== "activeEffectContainer") continue;
    for (const e of it.effects) if (String(e.name).trim().toLowerCase() === want) return e;
  }
  return null;
}

async function buildStatusData(status, byRules, opts = {}) {
  let tpl = null;
  if (opts.templateUuid) { try { tpl = await fromUuid(opts.templateUuid); } catch { /* fall through */ } }
  if (!tpl) tpl = findHubTemplate(status);
  if (!tpl) { warn(`derived-status: no template for "${status}" (hub or ${opts.templateUuid ?? "—"})`); return null; }
  const data = tpl.toObject();
  delete data._id;
  data.origin = tpl.uuid;
  data.transfer = false;
  data.disabled = false;
  data.duration = {};                                  // indefinite — reconcile owns lifetime
  data.flags = data.flags ?? {};
  data.flags[FLAG_NS] = {
    ...(data.flags[FLAG_NS] ?? {}),
    ...(opts.extraFlags ?? {}),
    derivedStatus: { forStatus: status, byRules: [...byRules] },
  };
  return data;
}

function isStatusAe(e, status) {
  return String(e?.name ?? "").trim().toLowerCase() === String(status).trim().toLowerCase();
}
function isDerived(e) { return !!e?.flags?.[FLAG_NS]?.derivedStatus?.forStatus; }

// ── reconcile ONE actor ──────────────────────────────────────────────────────
// Per-actor serialization: Prong A (settle) and Prong B (hooks) can both fire on
// the same event; without this, two overlapping reconciles race (double-apply /
// stale-id delete). A busy actor's caller awaits the in-flight run, then re-runs
// once (idempotent → no-op if nothing changed meanwhile).
const _chain = new Map();   // actorId -> tail Promise (serialize per actor)
export async function evaluateDerivedStatuses(actor) {
  if (!actor?.id) return { changed: false, events: [] };
  const prev = _chain.get(actor.id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => _reconcile(actor));
  _chain.set(actor.id, next);
  try { return await next; }
  finally { if (_chain.get(actor.id) === next) _chain.delete(actor.id); }
}

async function _reconcile(actor) {
  if (!actor?.createEmbeddedDocuments) return { changed: false, events: [] };
  const rules = collectRules(actor);
  const own = actor.effects?.contents ?? [];

  // status -> { wanted:Set(ruleKey), templateUuid, extraFlags }. Seed from every
  // status any rule grants PLUS any we already derived (so a removed carrier /
  // recovered HP gets cleaned up).
  const byStatus = new Map();
  const ensure = (s) => {
    if (!byStatus.has(s)) byStatus.set(s, { wanted: new Set(), templateUuid: null, extraFlags: null });
    return byStatus.get(s);
  };
  for (const r of rules) {
    const info = ensure(r.grant);
    if (r.grantTemplateUuid) info.templateUuid = r.grantTemplateUuid;
    if (r.extraFlags) info.extraFlags = { ...(info.extraFlags ?? {}), ...r.extraFlags };
  }
  for (const e of own) if (isDerived(e)) ensure(e.flags[FLAG_NS].derivedStatus.forStatus);

  // Evaluate conditions — predicate for built-ins, `when` formula for authored.
  const formulaRules = rules.filter((r) => !r.predicate && r.when);
  let evaluateFormula = null, resolver = null;
  if (formulaRules.length) {
    const sf = await import("./skill-formulas.js");
    evaluateFormula = sf.evaluateFormula;
    resolver = sf.buildSkillResolver({ actor });
  }
  for (const r of rules) {
    let ok = false;
    try {
      if (r.predicate) ok = !!r.predicate(actor);
      else if (r.when) ok = Number(evaluateFormula(r.when, resolver, 0)) > 0;
    } catch (e) { warn(`derived-status: rule "${r.ruleKey}" condition threw`, e); }
    if (ok) ensure(r.grant).wanted.add(r.ruleKey);
  }

  let changed = false;
  const events = [];
  for (const [status, info] of byStatus) {
    const list = actor.effects?.contents ?? [];
    const derived = list.find((e) => e.flags?.[FLAG_NS]?.derivedStatus?.forStatus === status);
    const independent = list.find((e) => isStatusAe(e, status) && !isDerived(e));
    const wantedBy = [...info.wanted];

    if (wantedBy.length) {
      if (independent) {
        // Real status already present from another source (incl. crisis-reactor's
        // own Crisis during the coexist phase) — never add a second; drop a stale dupe.
        if (derived) { await actor.deleteEmbeddedDocuments("ActiveEffect", [derived.id]); changed = true; }
        continue;
      }
      if (!derived) {
        const data = await buildStatusData(status, wantedBy, { templateUuid: info.templateUuid, extraFlags: info.extraFlags });
        if (data) {
          await actor.createEmbeddedDocuments("ActiveEffect", [data]);
          changed = true; events.push([status, "applied"]);
          log(`derived-status: applied "${status}" to ${actor.name} (by ${wantedBy.join(", ")})`);
        }
      } else {
        const cur = [...(derived.flags?.[FLAG_NS]?.derivedStatus?.byRules ?? [])].sort();
        if (JSON.stringify(cur) !== JSON.stringify([...wantedBy].sort())) {
          await derived.update({ [`flags.${FLAG_NS}.derivedStatus.byRules`]: wantedBy });
        }
      }
    } else if (derived) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [derived.id]);
      changed = true; events.push([status, "removed"]);
      log(`derived-status: removed "${status}" from ${actor.name} (no rule satisfied)`);
    }
  }
  return { changed, events };
}

// ── Prong A — settle-loop reactor + conflict_start sweep ─────────────────────
function queueStatusEvent(director, actor, status, direction, srcPayload) {
  if (!Array.isArray(director.ctx._postResolveTriggers)) director.ctx._postResolveTriggers = [];
  const tokenUuid = srcPayload?.subjectTokenUuid ?? srcPayload?.sourceTokenUuid ?? null;
  director.ctx._postResolveTriggers.push({
    casterActor: actor,
    trigger: direction === "applied" ? "creature_status_applied" : "creature_loses_status",
    payload: {
      status, direction,
      sourceActorUuid: actor.uuid, sourceTokenUuid: tokenUuid,
      subjectActorUuid: actor.uuid, subjectTokenUuid: tokenUuid,
      originLabel: status,
    },
  });
}

// Built-in reactor — settleInstance invokes per ledger event. Reconcile the
// subject actor when a condition input (resource / status) may have changed.
export async function derivedStatusReactor(director, cfg) {
  if (!director?.ctx) return;
  const actor = cfg?.casterActor;
  if (!actor) return;
  if (!/resource|status/.test(String(cfg?.trigger ?? ""))) return;
  const { changed, events } = await evaluateDerivedStatuses(actor);
  if (changed) for (const [status, dir] of events) queueStatusEvent(director, actor, status, dir, cfg?.payload);
}

// One-time sweep at conflict_start — seeds combatants (event-driven reactor only
// fires on subsequent changes).
export async function sweepDerivedStatuses(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  for (const c of combatants) {
    const actor = c.actor ?? (c.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor) continue;
    const { changed, events } = await evaluateDerivedStatuses(actor);
    if (changed) for (const [status, dir] of events) queueStatusEvent(director, actor, status, dir, { subjectTokenUuid: c.tokenUuid ?? null });
  }
}

// ── Prong B — BD-independent safety net (manual edits / out of combat) ───────
let _installed = false;
let _draining = false;
const _pending = new Set();

function queueReconcile(actor) {
  if (!actor?.id || !game.user?.isGM) return;              // GM authority only
  _pending.add(actor);
  if (_draining) return;
  _draining = true;
  queueMicrotask(drain);
}

async function drain() {
  const batch = [..._pending]; _pending.clear();
  for (const actor of batch) {
    try { await evaluateDerivedStatuses(actor); }         // idempotent; loop-safe
    catch (e) { warn("derived-status(safety-net): evaluate threw", e); }
  }
  _draining = false;
  if (_pending.size) { _draining = true; queueMicrotask(drain); }
}

// Ignore our OWN reconcile writes (loop guard); a real second pass is a no-op
// anyway (evaluate is idempotent → changed:false → no further writes).
const onAeChange = (effect) => {
  if (isDerived(effect)) return;
  const p = effect?.parent;
  const actor = p?.documentName === "Actor" ? p
    : (p?.parent?.documentName === "Actor" ? p.parent : null);
  if (actor) queueReconcile(actor);
};

export function installDerivedStatusSafetyNet() {
  if (_installed) return;
  _installed = true;
  Hooks.on("updateActor", (actor) => queueReconcile(actor));               // HP / props
  Hooks.on("updateItem", (item) => { if (item?.parent?.documentName === "Actor") queueReconcile(item.parent); }); // equip / carrier props
  Hooks.on("createActiveEffect", onAeChange);                              // a status landed
  Hooks.on("deleteActiveEffect", onAeChange);                              // a status left
  log("derived-status: safety-net hooks installed (updateActor/updateItem/AE)");
}

// Self-install at ready so Prong B works even if BD combat never starts.
Hooks.once("ready", () => {
  try { installDerivedStatusSafetyNet(); }
  catch (e) { warn("derived-status: safety-net install failed", e); }
});
