"use strict";

/**
 * suite: scenes — golden-snapshot drift for BLESSED scenes.
 *
 * Scenes are excluded from world-export, so a silently rolled-back scene (a
 * pre-placed boss token that vanished, a re-linked token, a dropped map note)
 * is invisible until you're running the session. The fix: after you set a scene
 * up correctly, `preflight bless <scene>` captures its critical fields to an
 * on-disk golden file (never stored in the world — see the payload-limit note).
 * This suite compares the live scene against that golden and reports drift.
 *
 * Only blessed scenes are checked. Unblessed scenes fall through to the `refs`
 * suite's structural invariants.
 */

const fs = require("node:fs");
const path = require("node:path");
const { SEVERITY, finding } = require("../util");
const { compareSceneConfig } = require("../scene-diff");

const ID = "scenes";
const TITLE = "Scene drift vs blessed snapshot";

function expectationsDir() {
  return path.join(__dirname, "..", "expectations", "scenes");
}

// The full token document, minus the `delta` array the loader synthesises and
// volatile stats — enough for the scenes fixer to re-place a rolled-back token
// at its original position/rotation/texture.
function restoreToken(t) {
  const { delta, _stats, ...rest } = t;
  return rest;
}

// Capture the fields worth guarding — stable identity, not volatile churn.
// `tokens`/`notes` are the lightweight compare keys the detection suite reads;
// `tokensFull` is the restore payload the fixer reads (older goldens lack it,
// which the fixer reports as "re-bless to enable restore").
function snapshotScene(scene) {
  return {
    sceneId: scene._id,
    name: scene.name,
    tokens: (scene.tokens || [])
      .map((t) => ({ name: t.name || null, actorId: t.actorId || null, actorLink: !!t.actorLink }))
      .sort((a, b) => String(a.actorId).localeCompare(String(b.actorId))),
    tokensFull: (scene.tokens || []).map(restoreToken),
    notes: (scene.notes || [])
      .map((n) => ({ entryId: n.entryId || null, pageId: n.pageId || null }))
      .sort((a, b) => String(a.entryId).localeCompare(String(b.entryId))),
    tileCount: (scene.tiles || []).length,
    // Full-fidelity capture of the scene's config — every setting (lighting,
    // vision, walls, lights, fog, ownership, dungeon config, scene network,
    // wellsprings, …). The scenes suite diffs this against the live scene,
    // excluding known-volatile fields (see scene-diff.VOLATILE_PATHS).
    // tokens+tiles are stripped here: they're huge (token `delta` carries full
    // actor data) and are already guarded by tokensFull/tileCount + the tiles
    // suite, and the config diff excludes them anyway.
    full: (() => { const { tokens, tiles, ...rest } = scene; return JSON.parse(JSON.stringify(rest)); })(),
  };
}

function loadGoldens() {
  const dir = expectationsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

// A token key that survives a token being re-placed: prefer actorId, fall back
// to name so we can talk about unlinked tokens too.
const tokKey = (t) => t.actorId || `name:${t.name}`;

function run(world) {
  const out = [];
  const goldens = loadGoldens();
  if (!goldens.length) {
    out.push(finding(ID, SEVERITY.INFO,
      "No scenes blessed yet — run `preflight bless <scene>` on the scenes you pre-set-up to guard them against rollback",
      {}));
    return out;
  }

  for (const gold of goldens) {
    const scene = world.byId.scenes.get(gold.sceneId);
    if (!scene) {
      out.push(finding(ID, SEVERITY.FAIL,
        `Blessed scene "${gold.name}" (${gold.sceneId}) no longer exists in the world`,
        { doc: "scene", id: gold.sceneId }));
      continue;
    }
    const live = snapshotScene(scene);

    // Missing pre-placed tokens — COUNT-based per key, because many identical
    // tokens can share one actorId (e.g. 39 villagers linked to one actor). A
    // 1:1 key match would collapse them and misreport; comparing counts is
    // correct and still survives a token being deleted+re-placed.
    const countBy = (arr) => {
      const m = new Map();
      for (const t of arr) { const k = tokKey(t); m.set(k, (m.get(k) || 0) + 1); }
      return m;
    };
    const goldCounts = countBy(gold.tokens);
    const liveCounts = countBy(live.tokens);
    const labelFor = (k) => (gold.tokens.find((t) => tokKey(t) === k) || {}).name || k;
    for (const [k, gc] of goldCounts) {
      const lc = liveCounts.get(k) || 0;
      if (lc < gc) {
        const missing = gc - lc;
        out.push(finding(ID, SEVERITY.FAIL,
          `Scene "${gold.name}": expected ${gc} pre-placed token(s) "${labelFor(k)}", found ${lc} (${missing} MISSING)`,
          { doc: "scene", id: gold.sceneId, extra: k }));
      }
    }

    // Missing map notes.
    const liveNotes = new Set(live.notes.map((n) => n.entryId));
    for (const gn of gold.notes) {
      if (gn.entryId && !liveNotes.has(gn.entryId)) {
        out.push(finding(ID, SEVERITY.FAIL,
          `Scene "${gold.name}": expected map note → journal ${gn.entryId} is MISSING`,
          { doc: "scene", id: gold.sceneId, extra: gn.entryId }));
      }
    }

    // Tile-count drop (a chunk of the dungeon disappeared).
    if (live.tileCount < gold.tileCount) {
      out.push(finding(ID, SEVERITY.WARN,
        `Scene "${gold.name}": tile count dropped ${gold.tileCount} → ${live.tileCount} since blessed`,
        { doc: "scene", id: gold.sceneId }));
    }

    // Full-scene config drift (lighting, vision, walls, ownership, dungeon
    // config, network, …). Only for goldens blessed with a full capture.
    if (gold.full) {
      out.push(...compareSceneConfig(gold.full, scene, gold.name, gold.sceneId));
    }
  }

  return out;
}

module.exports = { id: ID, title: TITLE, run, snapshotScene, expectationsDir };
