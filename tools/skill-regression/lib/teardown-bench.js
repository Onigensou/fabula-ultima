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
// SAFETY: deletes only scenes whose name is EXACTLY the bench name and which are
// not active — never a broad predicate over "test-looking" documents. Each delete
// re-resolves by id and re-checks the name first. Tokens die with their parent
// scene; no actor is touched (build-bench creates none — it only places tokens
// for actors that already exist).
//
// ⚠ Sweeps ALL matches, not one. The old version refused outright when it found
// more than one ("refusing to guess"), which sounded safe but was the opposite:
// build-bench has a create race (see its header), and once two benches existed
// teardown could never remove either. They accumulated as 67-token scenes that
// ship to the co-dev in the next wholesale binary push — precisely what this file
// exists to prevent. Sweeping is safe here because this tool OWNS the name: it is
// the only thing that creates "Regression Bench".
const BENCH = (typeof OPTS !== "undefined" && OPTS.sceneName) || "Regression Bench";

const matches = game.scenes.filter((s) => s.name === BENCH);
if (!matches.length) return { ok: true, removed: 0, note: `no scene named "${BENCH}" — nothing to tear down` };

// Never yank a scene out from under a viewer. An ACTIVE bench is reported, not
// deleted, and does not fail the sweep of the others.
const active = matches.filter((s) => s.active);
const targets = matches.filter((s) => !s.active);

const removed = [];
const skipped = [];
let tokensRemoved = 0;
for (const s of targets) {
  const sceneId = s.id;
  const tokenCount = s.tokens?.size ?? 0;
  // Re-resolve by id and re-check the name: the delete targets that exact document.
  const target = game.scenes.get(sceneId);
  if (!target || target.name !== BENCH) { skipped.push({ sceneId, reason: "no longer resolves to the bench name" }); continue; }
  try {
    await target.delete();
    removed.push(sceneId);
    tokensRemoved += tokenCount;
  } catch (e) {
    // A concurrent teardown/collapse may have removed it already — that is success.
    if (game.scenes.get(sceneId)) skipped.push({ sceneId, reason: String(e).slice(0, 120) });
    else { removed.push(sceneId); tokensRemoved += tokenCount; }
  }
}

const stillPresent = game.scenes.filter((s) => s.name === BENCH && !s.active).map((s) => s.id);
return {
  ok: skipped.length === 0,
  removed: removed.length,
  sceneId: removed[0] ?? null,
  scene: BENCH,
  tokensRemoved,
  duplicatesFound: matches.length,
  activeSkipped: active.map((s) => s.id),
  skipped,
  stillPresent: stillPresent.length > 0,
  ...(active.length ? { note: `"${BENCH}" is the ACTIVE scene — left in place; activate another scene and re-run to remove it` } : {}),
  ...(skipped.length ? { error: `${skipped.length} bench scene(s) could not be removed` } : {}),
};
