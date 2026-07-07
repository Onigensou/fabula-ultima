"use strict";

/**
 * fix/scenes — re-place pre-placed tokens that rolled off a BLESSED scene.
 *
 * GAME-OPEN fix (via the test-bridge): tokens are embedded scene documents, so
 * a raw LevelDB write would corrupt the scene (Foundry keeps inline + keyed
 * copies consistent). We drive `scene.createEmbeddedDocuments("Token", …)`
 * through the bridge, exactly like world-import drives embedded writes.
 *
 * The restore payload comes from the golden's `tokensFull` (captured by `bless`).
 * A golden blessed before that field existed can't restore — it reports
 * "re-bless to enable restore" instead.
 *
 * Limitation: unlinked tokens (actorLink=false) carry per-token actor overrides
 * in `delta`, which the golden does not capture — only their base placement is
 * restored. Linked tokens (the usual pre-placed boss/NPC) restore fully.
 */

const fs = require("node:fs");
const path = require("node:path");
const { bridgeEval } = require("../../../csb-template/lib/bridge");
const scenesCheck = require("../checks/scenes");

const ID = "scenes";
const tokKey = (t) => t.actorId || `name:${t.name}`;

function loadGoldens() {
  const dir = scenesCheck.expectationsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function plan(world) {
  const actions = [];
  const countBy = (arr) => {
    const m = new Map();
    for (const t of arr) { const k = tokKey(t); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  for (const gold of loadGoldens()) {
    const scene = world.byId.scenes.get(gold.sceneId);
    if (!scene) continue;                            // whole scene gone — not a token restore
    const liveCounts = countBy(scene.tokens || []);
    const goldCounts = countBy(gold.tokens);
    // Restore payloads grouped by key (identical tokens share an actorId).
    const payloadsByKey = new Map();
    for (const t of gold.tokensFull || []) {
      const k = tokKey(t);
      if (!payloadsByKey.has(k)) payloadsByKey.set(k, []);
      payloadsByKey.get(k).push(t);
    }
    for (const [k, gc] of goldCounts) {
      const missing = gc - (liveCounts.get(k) || 0);
      if (missing <= 0) continue;                    // all present
      const payloads = payloadsByKey.get(k) || [];
      const label = (gold.tokens.find((t) => tokKey(t) === k) || {}).name || k;
      for (let i = 0; i < missing; i++) {
        const payload = payloads[i] || payloads[0] || null;
        actions.push({
          sceneId: gold.sceneId, sceneName: gold.name,
          tokenName: label,
          payload: payload || null,
          needsRebless: !payload,
          targetIds: [gold.sceneId, k, label, gold.name].filter(Boolean),
        });
      }
    }
  }
  return actions;
}

function describe(a) {
  if (a.needsRebless) {
    return `Scene "${a.sceneName}": token "${a.tokenName}" MISSING but golden has no restore payload — re-run \`bless\` on this scene first`;
  }
  const { x, y } = a.payload;
  return `Scene "${a.sceneName}": RESTORE token "${a.tokenName}" at (${x}, ${y})`;
}

const RESTORE_PROG = `
const { sceneId, tokens } = ARGS;
const scene = game.scenes.get(sceneId);
if (!scene) return { ok: false, error: "scene not found: " + sceneId };
const created = await scene.createEmbeddedDocuments("Token", tokens);
return { ok: true, created: created.map(t => ({ id: t.id, name: t.name })) };
`;

async function apply(actions, { world }) {
  const runnable = actions.filter((a) => !a.needsRebless && a.payload);
  const skipped = actions.filter((a) => a.needsRebless);
  const bySene = new Map();
  for (const a of runnable) {
    if (!bySene.has(a.sceneId)) bySene.set(a.sceneId, []);
    bySene.get(a.sceneId).push(a);
  }
  const results = [];
  for (const [sceneId, group] of bySene) {
    const res = await bridgeEval(world, RESTORE_PROG, {
      sceneId, tokens: group.map((a) => a.payload),
    });
    if (!res.ok) throw new Error(`scene restore failed for ${sceneId}: ${res.error}`);
    results.push({ sceneId, sceneName: group[0].sceneName, restored: res.created });
  }
  return { results, skipped: skipped.map((a) => a.tokenName) };
}

module.exports = { id: ID, plan, describe, apply, mode: "bridge" };
