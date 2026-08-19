"use strict";

/**
 * preflight/scene-diff — full-fidelity scene config comparison.
 *
 * `bless` captures the ENTIRE scene document (lighting/environment, token
 * vision, walls, ambient lights, fog config, per-player ownership, scene mode,
 * dungeon config, scene network, wellsprings — everything). This module diffs a
 * blessed snapshot against the live scene and reports what changed.
 *
 * We capture everything but do NOT compare a short list of fields that change
 * during normal play (consumed-tile state, visited/fog maps, which scene is
 * active). Comparing those would flag "drift" after every session and train you
 * to ignore the tool. The excluded list is exported (VOLATILE_PATHS) and printed
 * by the suite so nothing is hidden silently — extend it if you find more churn.
 *
 * Runs offline; fidelity is favoured over size (goldens are on-disk files).
 */

const { SEVERITY, finding, stableStringify } = require("./util");

// Embedded arrays are compared structurally, not folded into the scalar diff.
const EMBEDDED_ARRAYS = ["tiles", "tokens", "walls", "lights", "notes", "sounds", "regions", "drawings", "templates"];
// tiles/tokens have dedicated handling (tiles suite; token presence + restore),
// so they're excluded from the generic scene-config diff below.
const STRUCT_EMBED = ["walls", "lights", "notes", "sounds", "regions", "drawings", "templates"];

// Fields that legitimately change during normal play — captured, never compared.
const VOLATILE_PATHS = [
  "_stats",
  "active",
  "flags.fabula-ultima-companion.dungeonPathing.tileStates",
  "flags.fabula-ultima-companion.dungeonPathing.visitedTiles",
  "flags.fabula-ultima-companion.dungeonPathing.fogRevealed",
  // Battle Director per-battle save snapshots (schemaVersion / dCombat / actors /
  // pendingAction / runtimeContinuation …). Pure runtime state: it grows by one
  // entry per battle and is never authored. On Training Ground it had reached 50
  // entries / 6.2 MB, which flattened to 215,751 leaf paths against a golden's 852
  // — 214,899 findings from ONE scene, and the crash below. Same category as the
  // dungeonPathing maps above.
  "flags.fabula-ultima-companion.directorHistory",
];

// Defence in depth for the next unbounded blob nobody has thought of yet. A diff
// this large is never actionable output, and before the non-variadic push in
// checks/scenes.js it was fatal. Capped findings are ANNOUNCED, never dropped
// silently — that is the same contract VOLATILE_PATHS carries.
const MAX_FINDINGS_PER_SCENE = 200;

function isVolatile(path) {
  return VOLATILE_PATHS.some((v) => path === v || path.startsWith(v + "."));
}

// Strip embedded arrays so the scalar flattener only sees config.
function scalarPart(doc) {
  const out = { ...doc };
  for (const f of EMBEDDED_ARRAYS) delete out[f];
  return out;
}

// Flatten to leaf paths (arrays flattened by index; empty objects/arrays kept).
function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object") { out[prefix] = obj; return out; }
  const keys = Object.keys(obj);
  if (!keys.length) { if (prefix) out[prefix] = Array.isArray(obj) ? [] : {}; return out; }
  for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function fmt(v) {
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

const ID = "scenes";

/**
 * Compare a blessed full scene doc against the live one.
 * Returns findings[] (config drift = WARN, embedded shrink = FAIL).
 */
function compareSceneConfig(gold, live, sceneName, sceneId) {
  const out = [];
  const ref = { doc: "scene", id: sceneId };

  // --- scalar config drift ------------------------------------------------
  const g = flatten(scalarPart(gold));
  const l = flatten(scalarPart(live));
  const keys = new Set([...Object.keys(g), ...Object.keys(l)]);
  for (const k of keys) {
    if (isVolatile(k)) continue;
    const inG = k in g, inL = k in l;
    if (inG && !inL) {
      out.push(finding(ID, SEVERITY.WARN, `Scene "${sceneName}": config "${k}" REMOVED (was ${fmt(g[k])})`, ref));
    } else if (!inG && inL) {
      // Added since blessing — usually a new field, low signal.
      out.push(finding(ID, SEVERITY.INFO, `Scene "${sceneName}": config "${k}" added (${fmt(l[k])})`, ref));
    } else if (stableStringify(g[k]) !== stableStringify(l[k])) {
      out.push(finding(ID, SEVERITY.WARN, `Scene "${sceneName}": config "${k}" ${fmt(g[k])} → ${fmt(l[k])}`, ref));
    }
  }

  // --- embedded structural drift -----------------------------------------
  for (const coll of STRUCT_EMBED) {
    const gc = (gold[coll] || []).length;
    const lc = (live[coll] || []).length;
    if (lc < gc) {
      out.push(finding(ID, SEVERITY.FAIL, `Scene "${sceneName}": ${coll} dropped ${gc} → ${lc} (some were removed)`, ref));
    } else if (stableStringify(gold[coll] || []) !== stableStringify(live[coll] || [])) {
      out.push(finding(ID, SEVERITY.WARN, `Scene "${sceneName}": ${coll} changed (${gc} → ${lc})`, ref));
    }
  }

  // Cap AFTER the structural checks above, so a genuine FAIL (embedded collection
  // shrank — the thing this suite exists to catch) can never be pushed out of the
  // report by a flood of scalar WARNs.
  if (out.length > MAX_FINDINGS_PER_SCENE) {
    const fails = out.filter((f) => f.severity === SEVERITY.FAIL);
    const rest = out.filter((f) => f.severity !== SEVERITY.FAIL);
    const keep = rest.slice(0, Math.max(0, MAX_FINDINGS_PER_SCENE - fails.length));
    const hidden = out.length - fails.length - keep.length;
    return [
      ...fails,
      ...keep,
      finding(ID, SEVERITY.WARN,
        `Scene "${sceneName}": +${hidden} more config differences not shown (capped at ${MAX_FINDINGS_PER_SCENE}). `
        + `A diff this large usually means the golden is stale or a runtime blob needs adding to VOLATILE_PATHS — re-bless this scene.`,
        ref),
    ];
  }

  return out;
}

module.exports = { compareSceneConfig, VOLATILE_PATHS, EMBEDDED_ARRAYS, MAX_FINDINGS_PER_SCENE };
