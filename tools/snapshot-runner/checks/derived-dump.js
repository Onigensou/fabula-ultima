// Every document's CSB-derived data (+ a sample of rendered sheet bodies), for an
// on/off parity check. Run via: run.mjs --eval checks/derived-dump.js --dump <file>
//
// RUNNER ONLY. Rendering a CSB sheet WRITES: getSheetData re-stamps props (defaults,
// dynamic-table display rows) onto the document. In the runner that lands in the stand-in
// server and vanishes; against the real world it modified 9 documents (2026-11-03, reverted
// from HEAD). If you must run it on a real world, set RENDER=false below.
const RENDER = !!globalThis.__runner;   // only render when the stand-in server is underneath
const docs = [];
for (const a of game.actors) { docs.push(a); for (const i of a.items) docs.push(i); }
for (const s of game.scenes) for (const t of s.tokens) if (t.actor && !t.actorLink) { docs.push(t.actor); for (const i of t.actor.items) docs.push(i); }
for (const i of game.items) docs.push(i);
const props = {};
for (const d of docs) {
  props[d.uuid] = JSON.stringify({ props: d.system?.props ?? null, bars: d.system?.attributeBar ?? null, type: d.type });
}
// rendered sheet bodies for a spread of documents (render goes through the shared trees)
const sample = [...game.actors.filter((a) => a.type === "character").slice(0, 6), ...game.items.filter((i) => i.type === "equippableItem").slice(0, 6)];
for (const a of game.actors.filter((a) => a.type === "character").slice(0, 3)) sample.push(...a.items.contents.slice(0, 3));
const html = {};
for (const d of RENDER ? sample : []) {
  try { const ctx = await d.templateSystem.getSheetData(); html[d.uuid] = String(ctx.bodyPanel?.[0]?.outerHTML ?? ctx.bodyPanel?.html?.() ?? ctx.bodyPanel ?? "") + "||" + String(ctx.headerPanel?.[0]?.outerHTML ?? ""); }
  catch (e) { html[d.uuid] = "ERR " + e.message; }
}
return { n: docs.length, props, html, tree: globalThis.__fuLayoutTreeCache ? { on: __fuLayoutTreeCache.on, size: __fuLayoutTreeCache.size, ...__fuLayoutTreeCache.stats } : null };
