// ───────────────────────────────────────────────────────────────────────────
// skill-regression — Regression Bench builder (runs inside Foundry via the
// test-bridge evalGM, driven by `bin/skill-regression.js bench`).
//
// The bench is a LOCAL test scene — it is NOT shipped as world data. A fresh
// clone regenerates it by running this builder; only the goldens + tooling are
// committed. This sidesteps the world-data/LevelDB submission flow and the
// per-run token-spawn cleanup hazard.
//
// It places one prototype token per "backbone" actor plus a single target
// dummy, so the collector can fingerprint the whole authored skill catalog
// (~450 skills across ClassTemplates + heroes + bosses + guests) instead of just
// the 4-PC Training-Ground roster.
//
// BACKBONE predicate (validated against the authored export 2026-07-27):
//   • ClassTemplate — system.props.class_facet is an object (37 actors, the
//     canonical 290-skill library; where "does this skill still resolve"
//     regressions concentrate).
//   • Hero/PC — has system.props.char_identity / bond_1 / fabula_point (16).
//   • Boss/villain — system.props.isBoss || isVillain (9).
//   • Guest — explicit allow-list by name (Kalina/Hako/Bruce/Crysta/Geist
//     (Overworld)) — NPC-schema but campaign-relevant.
// The long tail of 1–3-skill monster mooks is deliberately excluded (low value,
// large runtime). Idempotent by actor id: re-running only adds what's missing.
//
// Returns a summary the driver prints. Read-only apart from creating the bench
// scene + its tokens; touches no gameplay data.
// ───────────────────────────────────────────────────────────────────────────

const opts = (typeof OPTS !== "undefined" && OPTS) ? OPTS : {};
const BENCH = opts.sceneName || "Regression Bench";
// Reuse the existing director-harness fixture as the target dummy (Test Target
// Enemy: 50/50 HP, MDEF 10, affinity Light=VU / Dark=RS / others NE) so damage
// fingerprints are meaningful and stable. Overridable via OPTS.dummy.
const DUMMY_ID = opts.dummyActorId || "WJnlTHuNJaILbnrc";
const GUESTS = Array.isArray(opts.guests) ? opts.guests
  : ["Kalina", "Hako", "Bruce", "Crysta", "Geist (Overworld)"];

function hasCastable(actor) {
  return actor.items.some((i) => {
    const st = i.system?.props?.skill_type;
    return st === "Active" || st === "Spell";
  });
}
function isBackbone(actor) {
  if (!hasCastable(actor)) return false;
  const p = actor.system?.props || {};
  const isTemplate = p.class_facet && typeof p.class_facet === "object";
  const isHero = p.char_identity != null || p.bond_1 != null || p.fabula_point != null;
  const isBoss = !!(p.isBoss || p.isVillain);
  const isGuest = GUESTS.includes(actor.name);
  return isTemplate || isHero || isBoss || isGuest;
}
function roleOf(actor) {
  const p = actor.system?.props || {};
  if (p.class_facet && typeof p.class_facet === "object") return "template";
  if (p.isBoss || p.isVillain) return "boss";
  if (p.char_identity != null || p.bond_1 != null || p.fabula_point != null) return "hero";
  return "guest";
}

const dummy = game.actors.get(DUMMY_ID);
if (!dummy) return { ok: false, error: `target dummy actor ${DUMMY_ID} not found` };

// Find or create the bench scene.
let scene = game.scenes.find((s) => s.name === BENCH);
let createdScene = false;
if (!scene) {
  const src = game.scenes.find((s) => s.name === "Training Ground") || game.scenes.contents[0];
  const base = src ? src.toObject() : {};
  delete base._id;
  scene = await Scene.create({
    ...base, name: BENCH, active: false, navigation: false,
    // wipe any inherited tokens/notes/lighting so the bench starts clean
    tokens: [], notes: [], lights: [], sounds: [], templates: [], drawings: [], walls: [],
  });
  createdScene = true;
}

// Assemble the backbone roster, sorted deterministically.
const backbone = game.actors.contents
  .filter((a) => a.id !== DUMMY_ID && isBackbone(a))
  .sort((a, b) => (a.name || "").localeCompare(b.name || "") || a.id.localeCompare(b.id));

const grid = scene.grid?.size || scene.grid || 100;
const have = new Set(scene.tokens.contents.map((t) => t.actorId));

// Layout: dummy at top; casters in a column-wrapped grid to the side.
const placements = [];
if (!have.has(DUMMY_ID)) placements.push({ actor: dummy, gx: 2, gy: 2 });
let i = 0;
for (const a of backbone) {
  if (have.has(a.id)) continue;
  const col = Math.floor(i / 24);          // 24 rows per column
  const row = i % 24;
  placements.push({ actor: a, gx: 6 + col * 2, gy: 2 + row });
  i++;
}

const docs = [];
for (const pl of placements) {
  const td = await pl.actor.getTokenDocument({ x: pl.gx * grid, y: pl.gy * grid });
  const o = td.toObject();
  o.actorLink = true;                       // fingerprint the real actor, not an unlinked copy
  docs.push(o);
}
const made = docs.length ? await scene.createEmbeddedDocuments("Token", docs) : [];

// Report the roster grouped by role so the selection is eyeball-checkable.
const roleCounts = {};
let skillTotal = 0;
for (const a of backbone) {
  const r = roleOf(a);
  roleCounts[r] = (roleCounts[r] || 0) + 1;
  skillTotal += a.items.filter((it) => ["Active", "Spell"].includes(it.system?.props?.skill_type)).length;
}

return {
  ok: true,
  scene: scene.name,
  sceneId: scene.id,
  createdScene,
  dummy: dummy.name,
  backboneActors: backbone.length,
  skillTotal,
  roleCounts,
  alreadyPlaced: backbone.length - i,
  created: made.map((t) => t.name),
  roster: backbone.map((a) => ({ name: a.name, role: roleOf(a),
    skills: a.items.filter((it) => ["Active", "Spell"].includes(it.system?.props?.skill_type)).length })),
};
