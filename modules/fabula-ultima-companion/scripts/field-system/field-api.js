// ============================================================================
// Field System — Foundry binding + public API (`FUCompanion.api.field`).
//
// Owns the three world documents the system needs and creates them lazily on
// the primary GM's first boot, so a world that has never seen this code (the
// co-dev's) gets them without shipping LevelDB:
//
//   Actor  "_Field Template"   CSB `_template` — notes + an AE container
//   Actor  "Field"             the ONE runtime holder (flag `isField`), GM-only
//   Item   "Field Effects"     activeEffectContainer library of AE templates
//
// Seeding: whenever a scene becomes the one the game is played on (world
// ready, scene activated, conflict start), the Field is reconciled to that
// scene's declared wellsprings + field effects. Scene-seeded AEs are stamped
// `fieldOrigin: "scene"` and only re-seeding removes them; anything a skill or
// the GM added is left alone (see field-core.planSceneReconcile).
//
// Battle Director touch points (all small, all additive):
//   standalone-reactions.collectReactors({ includeField })   → Field reacts
//   state-handlers / action-card / harness reactor sets        → Field reacts on cards
//   skill-targeting RESERVED_REFS.field / all_combatants       → skills reach it
//   skill-formulas WELLSPRING_* / FIELD_HAS_* / FIELD_FLAG_*   → gates read it
// ============================================================================

import {
  FLAG_NS, FIELD_ACTOR_FLAG, FIELD_ACTOR_NAME, FIELD_TEMPLATE_NAME, FIELD_LIBRARY_NAME,
  SCENE_FLAG_ROOT, SCENE_FLAG_GROUP, SCENE_FIELD_EFFECTS_KEY,
  AE_ORIGIN_KEY, AE_SCENE_ID_KEY, WELLSPRINGS, WELLSPRING_ELEMS,
  wellspringFlagKey, sceneWellsprings, parseFieldEffectList, desiredSceneEffectNames,
  planSceneReconcile, scenePromotionPatch, stampSceneAE, hasMarkerEffect, normName,
  buildFieldTemplateSystem, buildStarterLibraryEffects, FIELD_TEMPLATE_VERSION,
} from "./field-core.js";

const TAG = "[FU][Field]";
const log = (...a) => console.debug(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

// ── Lookups (synchronous, safe inside formula resolvers) ────────────────────

export function isFieldActor(actor) {
  return !!actor?.flags?.[FLAG_NS]?.[FIELD_ACTOR_FLAG];
}

export function getFieldActor() {
  const actors = globalThis.game?.actors;
  if (!actors) return null;
  return actors.find?.((a) => isFieldActor(a)) ?? null;
}

export function getFieldTemplate() {
  return globalThis.game?.actors?.find?.((a) => a.type === "_template" && a.name === FIELD_TEMPLATE_NAME) ?? null;
}

export function getFieldLibrary() {
  return globalThis.game?.items?.find?.((i) => i.type === "activeEffectContainer" && i.name === FIELD_LIBRARY_NAME) ?? null;
}

/** The Field's ENABLED effects (live docs). */
export function activeFieldEffects() {
  const f = getFieldActor();
  return f ? Array.from(f.effects ?? []).filter((e) => e && e.disabled !== true) : [];
}

/** AE-applied flag on the Field (`flags.<NS>.<key>`), or undefined. */
export function fieldFlag(key) {
  return getFieldActor()?.flags?.[FLAG_NS]?.[String(key)];
}

/** 1/0 — does the Field carry an enabled AE named/tagged `needle`? */
export function fieldHas(needle) {
  return hasMarkerEffect(activeFieldEffects(), needle) ? 1 : 0;
}

/**
 * Is `elem`'s wellspring available to `actor`? The one scoping rule:
 * Field flag ∪ the asking creature's own flag (Inner Wellspring / Wheel).
 * Legacy fallback when the Field actor does not exist yet (module never
 * booted as GM on this world): the scene's raw chip flags, unset = available.
 */
export function wellspringAvailableFor(elem, actor = null, scene = null) {
  const key = wellspringFlagKey(elem);
  if (actor?.flags?.[FLAG_NS]?.[key]) return 1;
  const field = getFieldActor();
  if (field) return field.flags?.[FLAG_NS]?.[key] ? 1 : 0;
  const s = scene ?? currentScene();
  const g = s?.flags?.[FLAG_NS]?.[SCENE_FLAG_ROOT]?.[SCENE_FLAG_GROUP] ?? null;
  return sceneWellsprings(g).includes(String(elem).toLowerCase()) ? 1 : 0;
}

/** Elements whose wellspring is currently on the Field. */
export function fieldWellsprings() {
  const f = getFieldActor();
  if (!f) return [];
  return WELLSPRING_ELEMS.filter((e) => !!f.flags?.[FLAG_NS]?.[wellspringFlagKey(e)]);
}

/** Reactor-list entry for the Field, or null when there is no Field actor. */
export function fieldReactorEntry() {
  const actor = getFieldActor();
  return actor ? { actor, token: null, combatantId: "field", isField: true } : null;
}

/** The scene the Field should reflect: a running battle's scene, else the active one. */
export function currentScene(director = null) {
  return director?.dCombat?.scene
    ?? globalThis.game?.combat?.scene
    ?? globalThis.game?.scenes?.active
    ?? globalThis.canvas?.scene
    ?? null;
}

function sceneGeneral(scene) {
  return scene?.flags?.[FLAG_NS]?.[SCENE_FLAG_ROOT]?.[SCENE_FLAG_GROUP] ?? null;
}

// ── Document bootstrap (GM only) ────────────────────────────────────────────

function isPrimaryGM() {
  const u = globalThis.game?.user;
  if (!u?.isGM) return false;
  // Prefer the module's shared primary-GM election (scripts/shared/primary-gm.js);
  // fall back to "the active GM with the lowest id" so two GM clients never both create.
  const shared = globalThis.FUCompanion?.isPrimaryGM;
  if (typeof shared === "function") { try { return !!shared(); } catch { /* fall through */ } }
  const gms = (globalThis.game?.users ?? []).filter((x) => x.isGM && x.active).map((x) => x.id).sort();
  return gms.length ? gms[0] === u.id : true;
}

let _ensuring = null;

// The Field actor's portrait: a landscape, not a creature.
const FIELD_ACTOR_IMG = "icons/environment/wilderness/terrain-river-road-gray.webp";

// Placeholder icons earlier module versions stamped on starter effects. Only an
// effect still wearing one of these gets the new per-element art — a GM who
// picked their own image keeps it.
const LEGACY_STARTER_IMGS = new Set(["icons/svg/aura.svg", "icons/svg/fire.svg", "icons/svg/daze.svg"]);

/**
 * Update patches that bring pre-existing copies of the STARTER effects (library
 * rows or seeded Field rows) up to the current starter definition, touching only
 * what an older module version wrote: the v2 tag split (wellspring AEs are
 * `wellspring` only, so the sheet's two containers don't both list them) and
 * the v3 element icons. Never touches an effect whose name isn't a starter's.
 */
function starterMigrations(effects, starters) {
  const byName = new Map(starters.map((s) => [normName(s.name), s]));
  const out = [];
  for (const e of effects ?? []) {
    const s = byName.get(normName(e.name));
    if (!s) continue;
    const patch = {};
    const cur = Array.isArray(e.system?.tags) ? e.system.tags : [];
    if (cur.includes("wellspring") && cur.includes("field")) patch["system.tags"] = s.system?.tags ?? ["wellspring"];
    if (LEGACY_STARTER_IMGS.has(e.img) && s.img && s.img !== e.img) patch.img = s.img;
    if (Object.keys(patch).length) out.push({ _id: e.id, ...patch });
  }
  return out;
}

/** Create whichever of template / actor / library is missing. Idempotent. */
export async function ensureField({ quiet = false } = {}) {
  if (_ensuring) return _ensuring;
  _ensuring = (async () => {
    const created = [];
    let template = getFieldTemplate();
    let templateUpgraded = false;
    if (!template) {
      template = await Actor.create({
        name: FIELD_TEMPLATE_NAME, type: "_template", img: "icons/svg/aura.svg",
        system: buildFieldTemplateSystem(),
        flags: { [FLAG_NS]: { fieldTemplate: true, fieldTemplateVersion: FIELD_TEMPLATE_VERSION } },
      });
      created.push("template");
    } else if ((template.flags?.[FLAG_NS]?.fieldTemplateVersion ?? 0) < FIELD_TEMPLATE_VERSION) {
      // Layout changed in a newer module version: rewrite the sheet definition
      // and re-stamp. The Field actor picks it up via reloadTemplate below.
      await template.update({
        system: buildFieldTemplateSystem(),
        [`flags.${FLAG_NS}.fieldTemplateVersion`]: FIELD_TEMPLATE_VERSION,
      });
      templateUpgraded = true;
      created.push(`template→v${FIELD_TEMPLATE_VERSION}`);
    }
    let actor = getFieldActor();
    if (actor && templateUpgraded) {
      if (actor.img === "icons/svg/aura.svg") await actor.update({ img: FIELD_ACTOR_IMG });
      try { await actor.reloadTemplate(template.id); }
      catch (e) { warn("reloadTemplate after template upgrade threw", e); }
    }
    if (!actor) {
      actor = await Actor.create({
        name: FIELD_ACTOR_NAME, type: "character", img: FIELD_ACTOR_IMG,
        system: { template: template.id, props: {} },
        flags: { [FLAG_NS]: { [FIELD_ACTOR_FLAG]: true } },
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      });
      try { await actor.reloadTemplate(template.id); }
      catch (e) { warn("reloadTemplate on the new Field actor threw", e); }
      created.push("actor");
    }
    let library = getFieldLibrary();
    const starters = buildStarterLibraryEffects();
    if (!library) {
      library = await Item.create({
        name: FIELD_LIBRARY_NAME, type: "activeEffectContainer", img: "icons/svg/aura.svg",
        effects: starters,
        flags: { [FLAG_NS]: { fieldLibrary: true } },
      });
      created.push("library");
    } else {
      // Backfill starters the library lacks (a new wellspring / hazard added by a
      // later module version). Never overwrite an effect the GM has edited.
      const have = new Set(Array.from(library.effects ?? []).map((e) => normName(e.name)));
      const missing = starters.filter((s) => !have.has(normName(s.name)));
      if (missing.length) {
        await library.createEmbeddedDocuments("ActiveEffect", missing);
        created.push(`library+${missing.length}`);
      }
      // Tag migration (template v2): wellspring AEs are `wellspring` only, so the
      // sheet's two containers (tag `wellspring` / tag `field`) don't both list
      // them. Only touches the starter names, never a GM-authored effect.
      const retag = starterMigrations(library.effects, starters);
      if (retag.length) { await library.updateEmbeddedDocuments("ActiveEffect", retag); created.push(`library~${retag.length}`); }
    }
    // The same migrations on live Field copies (seeded before v2/v3).
    if (actor) {
      const retag = starterMigrations(actor.effects, starters);
      if (retag.length) await actor.updateEmbeddedDocuments("ActiveEffect", retag);
    }
    if (created.length && !quiet) log(`ensureField: created ${created.join(", ")}`);
    return { actor, template, library, created };
  })().finally(() => { _ensuring = null; });
  return _ensuring;
}

// ── Seeding ─────────────────────────────────────────────────────────────────

/** Resolve a library AE template by name → plain object, or null. */
export function resolveLibraryTemplate(name) {
  const want = normName(name);
  const lib = getFieldLibrary();
  const inLib = lib ? Array.from(lib.effects ?? []).find((e) => normName(e.name) === want) : null;
  if (inLib) return inLib.toObject();
  // Any other activeEffectContainer (the Buff/Debuff/Active Effects hubs) —
  // a GM may want a stock status as a scene-wide effect.
  for (const it of globalThis.game?.items ?? []) {
    if (it.type !== "activeEffectContainer" || it === lib) continue;
    const hit = Array.from(it.effects ?? []).find((e) => normName(e.name) === want);
    if (hit) return hit.toObject();
  }
  return null;
}

let _seedChain = Promise.resolve();

/**
 * Reconcile the Field to `scene`'s declared wellsprings + field effects.
 * Serialised so two triggers (ready + canvasReady) cannot interleave writes.
 * Returns `{ sceneId, deleted, created, missing }`.
 */
export async function seedFromScene(scene, { reason = "manual" } = {}) {
  const run = async () => {
    if (!scene) return { sceneId: null, deleted: 0, created: 0, missing: [] };
    const { actor } = await ensureField({ quiet: true });
    if (!actor) return { sceneId: scene.id, deleted: 0, created: 0, missing: [] };
    const desiredNames = desiredSceneEffectNames(sceneGeneral(scene));
    const existing = Array.from(actor.effects ?? []).map((e) => ({ _id: e.id, name: e.name, flags: e.flags }));
    const { deleteIds, createNames, promoteIds } = planSceneReconcile({ existing, desiredNames, sceneId: scene.id });
    const creates = [];
    const missing = [];
    for (const n of createNames) {
      const tpl = resolveLibraryTemplate(n);
      if (!tpl) { missing.push(n); continue; }
      creates.push(stampSceneAE(tpl, scene.id));
    }
    if (deleteIds.length) await actor.deleteEmbeddedDocuments("ActiveEffect", deleteIds);
    if (promoteIds.length) {
      const patch = scenePromotionPatch(scene.id);
      await actor.updateEmbeddedDocuments("ActiveEffect", promoteIds.map((id) => ({ _id: id, ...patch })));
    }
    if (creates.length) await actor.createEmbeddedDocuments("ActiveEffect", creates);
    if (missing.length) warn(`seedFromScene(${reason}): scene "${scene.name}" names field effect(s) with no library template: ${missing.join(", ")}`);
    if (deleteIds.length || creates.length || promoteIds.length) {
      log(`seedFromScene(${reason}): "${scene.name}" → −${deleteIds.length} +${creates.length} ↑${promoteIds.length} [${desiredNames.join(", ")}]`);
    }
    return { sceneId: scene.id, deleted: deleteIds.length, created: creates.length, promoted: promoteIds.length, missing };
  };
  _seedChain = _seedChain.then(run, run);
  return _seedChain;
}

// ── GM / skill conveniences ─────────────────────────────────────────────────

/**
 * Put a library effect on the Field by name.
 *   origin        "gm" (default) | "skill" — provenance stamp
 *   untilRoundEnd true → removed by the round_end ticker
 *   permanent     true → survives the scene-end sweep (default: transient, so a
 *                 GM's ad-hoc effect is cleaned up with the battle)
 */
export async function addFieldEffect(name, { origin = "gm", untilRoundEnd = false, permanent = false, replace = true } = {}) {
  const { actor } = await ensureField({ quiet: true });
  const tpl = resolveLibraryTemplate(name);
  if (!tpl) throw new Error(`${TAG} no field-effect template named "${name}"`);
  // Precedence: a SCENE-declared copy is the scene's standing state and outranks
  // a transient add of the same name — displacing it would let the scene-end
  // sweep remove what the scene declares. Already in effect → return it.
  const sceneCopy = Array.from(actor.effects ?? []).find((e) =>
    normName(e.name) === normName(name) && e.flags?.[FLAG_NS]?.[AE_ORIGIN_KEY] === "scene");
  if (sceneCopy) {
    log(`add("${name}"): the active scene already declares it — leaving the scene copy in place`);
    return sceneCopy;
  }
  const data = stampSceneAE(tpl, null);
  const ns = data.flags[FLAG_NS];
  ns[AE_ORIGIN_KEY] = origin;
  delete ns[AE_SCENE_ID_KEY];
  ns.directorPermanent = !!permanent;
  if (!permanent) ns.directorAppliedBy = { reactorActorUuid: null, lifetimeMode: untilRoundEnd ? "round_end" : "" };
  if (replace) {
    const dup = Array.from(actor.effects ?? []).filter((e) => normName(e.name) === normName(name)).map((e) => e.id);
    if (dup.length) await actor.deleteEmbeddedDocuments("ActiveEffect", dup);
  }
  const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  return created;
}

export async function removeFieldEffect(name) {
  const actor = getFieldActor();
  if (!actor) return 0;
  const ids = Array.from(actor.effects ?? []).filter((e) => normName(e.name) === normName(name)).map((e) => e.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  return ids.length;
}

export function listFieldEffects() {
  const actor = getFieldActor();
  if (!actor) return [];
  return Array.from(actor.effects ?? []).map((e) => ({
    id: e.id, uuid: e.uuid, name: e.name, disabled: !!e.disabled,
    origin: e.flags?.[FLAG_NS]?.[AE_ORIGIN_KEY] ?? null,
    sceneId: e.flags?.[FLAG_NS]?.[AE_SCENE_ID_KEY] ?? null,
    tags: Array.isArray(e.system?.tags) ? [...e.system.tags] : [],
  }));
}

export function listLibrary() {
  const lib = getFieldLibrary();
  if (!lib) return [];
  return Array.from(lib.effects ?? []).map((e) => ({
    id: e.id, name: e.name,
    tags: Array.isArray(e.system?.tags) ? [...e.system.tags] : [],
    description: e.description ?? "",
  }));
}

// ── Hooks ───────────────────────────────────────────────────────────────────

const api = {
  FLAG_NS, FIELD_ACTOR_FLAG, FIELD_ACTOR_NAME, FIELD_TEMPLATE_NAME, FIELD_LIBRARY_NAME,
  SCENE_FIELD_EFFECTS_KEY, WELLSPRINGS, WELLSPRING_ELEMS,
  isFieldActor, getActor: getFieldActor, getTemplate: getFieldTemplate, getLibrary: getFieldLibrary,
  ensure: ensureField,
  seedFromScene, currentScene,
  add: addFieldEffect, remove: removeFieldEffect, list: listFieldEffects, library: listLibrary,
  has: fieldHas, flag: fieldFlag, wellsprings: fieldWellsprings, wellspringAvailableFor,
  reactorEntry: fieldReactorEntry,
  parseFieldEffectList, sceneWellsprings, desiredSceneEffectNames,
};

function ensureGlobalApi() {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  return globalThis.FUCompanion.api;
}

Hooks.once("init", () => {
  ensureGlobalApi().field = api;
  const mod = game.modules?.get(FLAG_NS);
  if (mod) { mod.api = mod.api || {}; mod.api.field = api; }
});

Hooks.once("ready", async () => {
  if (!isPrimaryGM()) return;
  try {
    const r = await ensureField();
    if (r.created.length) log(`ready: Field documents created (${r.created.join(", ")})`);
    await seedFromScene(currentScene(), { reason: "ready" });
  } catch (e) { warn("ready bootstrap failed", e); }
});

// A scene becoming ACTIVE is the game moving there.
Hooks.on("updateScene", async (scene, changes) => {
  if (!isPrimaryGM()) return;
  try {
    if (changes?.active === true) await seedFromScene(scene, { reason: "activate" });
    // Editing the active scene's own field config re-seeds it live.
    else if (scene.active && changes?.flags?.[FLAG_NS]?.[SCENE_FLAG_ROOT]?.[SCENE_FLAG_GROUP]) {
      await seedFromScene(scene, { reason: "config" });
    }
  } catch (e) { warn("updateScene seed failed", e); }
});

export { api as FieldApi };
