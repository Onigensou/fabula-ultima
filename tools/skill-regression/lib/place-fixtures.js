// ───────────────────────────────────────────────────────────────────────────
// skill-regression — EPHEMERAL fixture placement (runs inside Foundry via the
// test-bridge evalGM, driven by `bin/skill-regression.js verify`).
//
// WHY: `verify` needs the director harness fixtures (Test Caster / Test Target
// Ally / Test Target Enemy) plus any actor a spec names as `caster` to have a
// token on the ACTIVE scene. Those used to be left lying in the world by a
// hand-run restore helper, so test scaffolding accumulated in the user's game
// (and a world commit is a wholesale binary dump, so it would ship to the
// co-dev). This places them, `verify` runs, and remove-fixtures.js deletes
// EXACTLY what this created — the same place/run/teardown contract the
// Regression Bench already uses.
//
// SAFETY: returns the ids it CREATED, and only those. Tokens that were already
// on the scene are reported as `preExisting` and never touched, so a scene the
// user has deliberately populated is left exactly as found.
// ───────────────────────────────────────────────────────────────────────────

const opts = (typeof OPTS !== "undefined" && OPTS) ? OPTS : {};
const names = Array.isArray(opts.actorNames) ? opts.actorNames : [];
if (!names.length) return { ok: false, error: "no actor names given" };

const scene = game.scenes.find((s) => s.active) || canvas?.scene;
if (!scene) return { ok: false, error: "no active scene to place fixtures on" };

const grid = scene.grid?.size || 100;
const have = new Set(scene.tokens.contents.map((t) => t.actorId));

const created = [];
const preExisting = [];
const notFound = [];
const docs = [];
const pending = [];

let i = 0;
for (const name of names) {
  const actor = game.actors.getName(name);
  if (!actor) { notFound.push(name); continue; }
  if (have.has(actor.id)) { preExisting.push({ name, actorId: actor.id }); continue; }
  // 3 cells apart so the ~1.5x-scaled token art doesn't visually overlap.
  const gx = 4 + (i % 6) * 3;
  const gy = 4 + Math.floor(i / 6) * 3;
  const td = await actor.getTokenDocument({ x: gx * grid, y: gy * grid });
  const o = td.toObject();
  o.actorLink = true;                 // fingerprint the real actor, not a copy
  docs.push(o);
  pending.push({ name, actorId: actor.id });
  i++;
}

if (docs.length) {
  const made = await scene.createEmbeddedDocuments("Token", docs);
  for (const t of made) created.push({ tokenId: t.id, name: t.name, actorId: t.actorId });
}

return {
  ok: true,
  sceneId: scene.id,
  sceneName: scene.name,
  created,                 // <- ONLY these get removed afterwards
  preExisting,             // <- left alone, not ours
  notFound,
  requested: names,
};
