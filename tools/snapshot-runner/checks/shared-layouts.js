// Whole-world sheet parity for the shared actor layouts (run on a snapshot before and after
// _share-actor-layouts.js; diff the two dumps). Per actor (world actors + unlinked token
// actors on every scene): the in-memory layout module code reads (system.body/header), the
// built CSB trees (customBody/customHeader), derived props, and the rendered sheet.
// With FREEZE, shared library layouts are deep-frozen first and every actor re-prepared,
// so any code that writes into a shared layout fails loudly instead of corrupting others.
// RUNNER ONLY (rendering writes props).
if (!globalThis.__runner) return { error: "runner only" };
const FREEZE = true;
const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
const lib = globalThis.__fuSharedActorLayouts?.libraryLayouts?.() ?? null;
const freezeErrors = [];
// Both runs re-prepare every actor the same way (a reset alone changes derived props that
// depend on other actors' state, so it must happen on both sides of the diff).
{
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } };
  if (FREEZE && lib) deepFreeze(lib);
  for (const a of game.actors) { try { a.reset(); } catch (e) { freezeErrors.push(`${a.name}: ${e.message}`); } }
  for (const s of game.scenes) for (const t of s.tokens) if (t.actor && !t.actorLink) { try { t.actor.reset(); } catch (e) { freezeErrors.push(`${t.name}: ${e.message}`); } }
}
const actors = [...game.actors];
for (const s of game.scenes) for (const t of s.tokens) if (t.actor && !t.actorLink) actors.push(t.actor);
const out = {};
let rendered = 0;
for (const a of actors) {
  if (a.type === "_template") continue;
  const ts = a.templateSystem;
  const r = {
    layout: await sha(JSON.stringify({ body: a.system?.body ?? null, header: a.system?.header ?? null })),
    tree: await sha(JSON.stringify({ b: ts?.customBody?.toJSON?.() ?? null, h: ts?.customHeader?.toJSON?.() ?? null })),
    props: await sha(JSON.stringify(a.system?.props ?? null)),
    contents: a.system?.body?.contents?.length ?? 0,
  };
  try {
    const ctx = await ts.getSheetData();
    r.sheet = await sha(String(ctx.bodyPanel?.[0]?.outerHTML ?? ctx.bodyPanel?.html?.() ?? ctx.bodyPanel ?? "") + "||" + String(ctx.headerPanel?.[0]?.outerHTML ?? ""));
    rendered++;
  } catch (e) { r.sheet = "ERR " + e.message; }
  out[a.uuid] = r;
}
const src = game.actors.filter((a) => a.type !== "_template");
return {
  n: Object.keys(out).length, rendered, freezeErrors, libraryLayouts: lib ? Object.keys(lib).length : 0,
  sourceEmpty: src.filter((a) => !(a._source.system?.body?.contents?.length)).length,
  withRef: src.filter((a) => a.flags?.["fabula-ultima-companion"]?.layoutRef).length,
  missing: [...(globalThis.__fuSharedActorLayouts?.missing ?? [])],
  actors: out,
};
