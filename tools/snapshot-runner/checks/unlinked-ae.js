// Probe: an Active Effect created on an UNLINKED token's synthetic actor (every NPC in a battle).
// In a seeded sim battle the real engine put Provoked / Element Gorge on the Hellhound and the
// runner did not, so: does the write land, and does the hook fire, through the stand-in server?
const scene = canvas.scene;
const hh = game.actors.getName("Hellhound");
const td = (await hh.getTokenDocument({ x: 1200, y: 600 })).toObject();
td.actorLink = false;
const [tok] = await scene.createEmbeddedDocuments("Token", [td]);
const seen = [];
const ids = ["createActiveEffect", "updateActiveEffect", "deleteActiveEffect", "updateActor", "updateToken"].map((n) => [n, Hooks.on(n, (doc, ch) => seen.push({ hook: n, doc: doc.name ?? doc.id, parent: doc.parent?.name ?? null, keys: ch && typeof ch === "object" ? Object.keys(foundry.utils.flattenObject(ch)).slice(0, 6) : null }))]);
const w0 = __runner.writes.length;
let made = null, err = null;
try { made = await tok.actor.createEmbeddedDocuments("ActiveEffect", [{ name: "Probe Effect", img: "icons/svg/aura.svg", changes: [] }]); }
catch (e) { err = String(e?.message ?? e); }
await new Promise((r) => setTimeout(r, 500));
const after = { effects: tok.actor.effects.map((e) => e.name), delta: tok.delta?.effects?.map?.((e) => e.name) ?? null, made: made?.map((e) => e?.name ?? null) ?? null };
let upd = null;
try { await tok.actor.update({ "system.props.current_hp": 1 }); upd = tok.actor.system.props.current_hp; } catch (e) { upd = "threw " + e.message; }
for (const [n, id] of ids) Hooks.off(n, id);
return { err, after, hpAfterUpdate: upd, seen, writes: __runner.writes.slice(w0), errors: __runner.errors };
