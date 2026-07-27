// ───────────────────────────────────────────────────────────────────────────
// skill-regression — EPHEMERAL fixture teardown (counterpart to
// place-fixtures.js; runs inside Foundry via the test-bridge evalGM).
//
// SAFETY CONTRACT: deletes ONLY the exact token ids place-fixtures.js reported
// as `created`, and only after re-resolving each id and confirming it still
// carries the expected actorId. Never a predicate over "test-looking" tokens —
// a broad-predicate cleanup previously wiped real placements in this world.
// A token that is already gone is a no-op, not an error.
// ───────────────────────────────────────────────────────────────────────────

const opts = (typeof OPTS !== "undefined" && OPTS) ? OPTS : {};
const created = Array.isArray(opts.created) ? opts.created : [];
const sceneId = opts.sceneId;

if (!created.length) return { ok: true, removed: 0, note: "nothing was placed — nothing to remove" };

const scene = game.scenes.get(sceneId);
if (!scene) return { ok: false, error: `scene ${sceneId} no longer exists` };

const toDelete = [];
const alreadyGone = [];
const mismatched = [];

for (const c of created) {
  const t = scene.tokens.get(c.tokenId);
  if (!t) { alreadyGone.push(c); continue; }
  if (t.actorId !== c.actorId) { mismatched.push({ ...c, actualActorId: t.actorId }); continue; }
  toDelete.push(c.tokenId);
}

// A mismatch means the id was recycled onto something else — refuse rather than
// risk deleting a document we did not create.
if (mismatched.length) return { ok: false, error: "token id/actor mismatch — refusing to delete", mismatched };

const removed = toDelete.length ? await scene.deleteEmbeddedDocuments("Token", toDelete) : [];

return {
  ok: true,
  removed: removed.length,
  removedNames: removed.map((t) => t.name),
  alreadyGone: alreadyGone.length,
  stillPresent: toDelete.filter((id) => scene.tokens.get(id)).length,
  remainingOnScene: scene.tokens.size,
};
