// Delete the Regression Bench scene (and with it every token placed by
// build-bench). Runs in-page via evalGM; OPTS mirrors build-bench's.
//
// WHY this exists: a world commit is a wholesale binary LevelDB dump, so any
// scene living in the world at commit time ships to the co-dev — there is no way
// to hold one document back. The bench is pure test scaffolding, so it must not
// be resident when we commit. The goldens don't care: fingerprints are keyed
// "<Actor> / <Skill>", never by scene or token id, so a bench torn down and
// rebuilt later still diffs against the same golden.
//
// SAFETY: deletes exactly ONE scene, resolved by name and then re-checked by id
// before the delete — never a broad predicate over "test-looking" documents.
// Tokens die with their parent scene; no actor is touched (build-bench creates
// none — it only places tokens for actors that already exist).
const BENCH = (typeof OPTS !== "undefined" && OPTS.sceneName) || "Regression Bench";

const matches = game.scenes.filter((s) => s.name === BENCH);
if (!matches.length) return { ok: true, removed: 0, note: `no scene named "${BENCH}" — nothing to tear down` };
if (matches.length > 1) {
  return { ok: false, error: `${matches.length} scenes named "${BENCH}" — refusing to guess; delete by hand` };
}

const scene = matches[0];
const sceneId = scene.id;
const tokenCount = scene.tokens?.size ?? 0;

// Never yank the scene out from under a viewer.
if (scene.active) {
  return { ok: false, error: `"${BENCH}" is the ACTIVE scene — activate another scene first, then re-run teardown` };
}

// Re-resolve by id and re-check the name: the delete targets that exact document.
const target = game.scenes.get(sceneId);
if (!target || target.name !== BENCH) {
  return { ok: false, error: `scene ${sceneId} no longer resolves to "${BENCH}" — aborting` };
}
await target.delete();

return {
  ok: true,
  removed: 1,
  sceneId,
  scene: BENCH,
  tokensRemoved: tokenCount,
  stillPresent: game.scenes.some((s) => s.id === sceneId),
};
