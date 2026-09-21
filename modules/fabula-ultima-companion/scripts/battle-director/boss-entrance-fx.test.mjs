// ============================================================================
// Boss Entrance FX — entrance-style selection harness.
//
//     node scripts/battle-director/boss-entrance-fx.test.mjs
//
// Bare Node, no Foundry. Only the pure half is covered: which enemies fade and
// which get a bespoke descent. The renderer itself is DOM + PIXI + camera and
// belongs in a live review, not here.
//
// The load-bearing assertions are the legacy-equivalence ones. Every enemy in
// the world today carries no entrance flag, so if an unflagged roster ever
// resolved to anything other than "every token fades, in roster order, with
// the original stagger", every existing fight's opening would change.
// ============================================================================

import {
  DESCENT_STYLES,
  entranceStyleFromFlags,
  splitByEntranceStyle,
  buildDescentPayload,
  DEFAULT_ENTRANCE_STYLE,
  ENTRANCE_MODULE_ID,
  ENTRANCE_STYLE_FLAG,
} from "./boss-entrance-fx.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);

const withStyle = (s) => ({ [ENTRANCE_MODULE_ID]: { [ENTRANCE_STYLE_FLAG]: s } });

/* ── Style reads ─────────────────────────────────────────────────────────── */

eq("no flags at all",            entranceStyleFromFlags(undefined),          DEFAULT_ENTRANCE_STYLE);
eq("empty flags",                entranceStyleFromFlags({}),                 DEFAULT_ENTRANCE_STYLE);
eq("other modules' flags only",  entranceStyleFromFlags({ theatre: { x: 1 } }), DEFAULT_ENTRANCE_STYLE);
eq("our namespace, no key",      entranceStyleFromFlags({ [ENTRANCE_MODULE_ID]: { damage_taken_mult: 1 } }), DEFAULT_ENTRANCE_STYLE);
eq("blank string",               entranceStyleFromFlags(withStyle("")),      DEFAULT_ENTRANCE_STYLE);
eq("whitespace only",            entranceStyleFromFlags(withStyle("   ")),   DEFAULT_ENTRANCE_STYLE);
eq("explicit fade",              entranceStyleFromFlags(withStyle("fade")),  DEFAULT_ENTRANCE_STYLE);

eq("shadowstorm",                entranceStyleFromFlags(withStyle("shadowstorm")), "shadowstorm");
eq("flame",                      entranceStyleFromFlags(withStyle("flame")),       "flame");
eq("padded value is trimmed",    entranceStyleFromFlags(withStyle("  shadowstorm  ")), "shadowstorm");

// An unrecognised style must NOT reach the renderer, whose own fallback is
// `flame` — that would drop a fiery explosion on a monster that never asked.
eq("typo'd style → fade",        entranceStyleFromFlags(withStyle("shadowstrom")), DEFAULT_ENTRANCE_STYLE);
eq("retired style → fade",       entranceStyleFromFlags(withStyle("meteor")),      DEFAULT_ENTRANCE_STYLE);
eq("non-string → fade",          entranceStyleFromFlags(withStyle({ a: 1 })),      DEFAULT_ENTRANCE_STYLE);
eq("number → fade",              entranceStyleFromFlags(withStyle(7)),             DEFAULT_ENTRANCE_STYLE);
eq("null → fade",                entranceStyleFromFlags(withStyle(null)),          DEFAULT_ENTRANCE_STYLE);

// A throwing accessor must not take the entrance down with it.
const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
eq("throwing flags object",      entranceStyleFromFlags(hostile),            DEFAULT_ENTRANCE_STYLE);

/* ── LEGACY EQUIVALENCE — the load-bearing block ─────────────────────────── */

const roster = ["tokA", "tokB", "tokC", "tokD"];
const noFlags = () => DEFAULT_ENTRANCE_STYLE;

{
  const { fading, descending } = splitByEntranceStyle(roster, noFlags);
  eq("unflagged roster: all fade",        fading, roster);
  eq("unflagged roster: none descend",    descending, []);
  // The stagger is `index * PER_TOKEN_STAGGER_MS` over the fading list, so
  // order-preservation is what keeps every existing fight's timing identical.
  eq("unflagged roster: order preserved", fading.map((id, i) => [id, i]),
     roster.map((id, i) => [id, i]));
}

{
  // A throwing style lookup is the worst realistic case (a destroyed placeable
  // mid-teardown). It must degrade to the legacy path, not lose tokens.
  const { fading, descending } = splitByEntranceStyle(roster, () => { throw new Error("no actor"); });
  eq("throwing lookup: all fade",     fading, roster);
  eq("throwing lookup: none descend", descending, []);
}

eq("empty roster",     splitByEntranceStyle([], noFlags),        { fading: [], descending: [] });
eq("null roster",      splitByEntranceStyle(null, noFlags),      { fading: [], descending: [] });
eq("missing styleOf",  splitByEntranceStyle(roster, undefined),  { fading: roster, descending: [] });

/* ── Mixed rosters ───────────────────────────────────────────────────────── */

{
  const styleOf = (id) => (id === "tokC" ? "shadowstorm" : DEFAULT_ENTRANCE_STYLE);
  const { fading, descending } = splitByEntranceStyle(roster, styleOf);
  eq("mixed: faders keep order",  fading, ["tokA", "tokB", "tokD"]);
  eq("mixed: descent picked out", descending, [{ id: "tokC", style: "shadowstorm" }]);
}

{
  // Two bosses descending at once is legal and must not collapse to one.
  const styleOf = (id) => (id === "tokA" || id === "tokD" ? "shadowstorm" : DEFAULT_ENTRANCE_STYLE);
  const { fading, descending } = splitByEntranceStyle(roster, styleOf);
  eq("two descents: faders",   fading, ["tokB", "tokC"]);
  eq("two descents: descents", descending, [
    { id: "tokA", style: "shadowstorm" },
    { id: "tokD", style: "shadowstorm" },
  ]);
}

/* ── Style table integrity ───────────────────────────────────────────────── */

// `flame` reproduces the shipped Wandering Flame entrance. These were verified
// against git HEAD constant for constant; pinning them here means a future
// re-tune of that approved animation has to be deliberate.
const flame = DESCENT_STYLES.flame;
eq("flame fallMs",      flame.fallMs, 640);
eq("flame ease",        flame.ease, [0.55, 0, 1, 0.45]);
eq("flame rotateFrom",  flame.rotateFromDeg, -6);
eq("flame rotateTo",    flame.rotateToDeg, 4);
eq("flame burstScale",  flame.burstScale, 2.4);
eq("flame burstMs",     flame.burstMs, 640);
eq("flame shakeMs",     flame.shakeMs, 700);
eq("flame sfxVolume",   flame.sfxVolume, 0.8);
eq("flame fadeOutMs",   flame.fadeOutMs, 220);
eq("flame has no camera ride", flame.camera, null);
eq("flame has no shards",      flame.shards, null);
// Load-bearing: the impact FX must keep sizing straight off the sprite
// footprint for this style. Capping the basis (as shadowstorm does, because a
// boss-sized sprite otherwise throws a screen-wide flash) would visibly shrink
// an approved animation.
eq("flame FX basis is uncapped", flame.fxBasisMaxFrac, null);
// The Wandering Flame plummets and does not bellow. Both would be visible
// changes to a shipped animation.
ok("flame still a single plummet, not wing-beats", !flame.beats);
ok("flame has no roar",                            !flame.roar);
ok("flame has no idle float",                      !flame.floatAmpFrac);

// Every style must be renderable: the fields runDescent reads unconditionally.
// A style describes its descent EITHER as a single eased plummet (fallMs+ease)
// OR as wing-beats; exactly one, or the renderer silently ignores half the
// config.
for (const [name, cfg] of Object.entries(DESCENT_STYLES)) {
  const hasPlummet = Number.isFinite(cfg.fallMs) && cfg.fallMs > 0;
  const hasBeats = Array.isArray(cfg.beats) && cfg.beats.length > 0;
  ok(`${name}: describes a descent`, hasPlummet || hasBeats);
  ok(`${name}: not both shapes`,     !(hasPlummet && hasBeats));
  if (hasPlummet) {
    ok(`${name}: ease is 4 numbers`, Array.isArray(cfg.ease) && cfg.ease.length === 4 && cfg.ease.every(Number.isFinite));
  }
  if (hasBeats) {
    let prev = 0;
    cfg.beats.forEach((b, i) => {
      ok(`${name}: beat ${i} moves downward`, Number.isFinite(b.to) && b.to > prev);
      ok(`${name}: beat ${i} dropMs > 0`,     Number.isFinite(b.dropMs) && b.dropMs > 0);
      ok(`${name}: beat ${i} ease valid`,     !b.ease || (Array.isArray(b.ease) && b.ease.length === 4));
      // A rebound larger than the drop would send her back above where the beat
      // started, which reads as flying up, not as a wing catching her.
      ok(`${name}: beat ${i} rebound < drop`, (b.reboundFrac ?? 0) < (b.to - prev) + 1e-9);
      prev = b.to - (b.reboundFrac ?? 0);
    });
    // The last beat must actually reach the ground or she lands in mid-air.
    eq(`${name}: final beat lands`, cfg.beats[cfg.beats.length - 1].to, 1.0);
    ok(`${name}: final beat does not rebound`, !(cfg.beats[cfg.beats.length - 1].reboundFrac > 0));
  }
  if (cfg.roar) {
    ok(`${name}: roar ms > 0`,       Number.isFinite(cfg.roar.ms) && cfg.roar.ms > 0);
    ok(`${name}: roar has sfx`,      typeof cfg.roar.sfxUrl === "string" && cfg.roar.sfxUrl.startsWith("http"));
    ok(`${name}: roar reveals`,      typeof cfg.roar.revealClass === "string" && cfg.roar.revealClass.includes("fud-be-faller"));
    // The reveal class must NOT keep the silhouette, or the roar plays on a
    // black shape and the reveal never reads.
    ok(`${name}: reveal drops silhouette`, !cfg.roar.revealClass.includes("--shadow"));
    ok(`${name}: roar blurs`,        Number.isFinite(cfg.roar.blurPx) && cfg.roar.blurPx > 0);
  }
  ok(`${name}: has faller class`,  typeof cfg.fallerClass === "string" && cfg.fallerClass.includes("fud-be-faller"));
  ok(`${name}: has burst class`,   typeof cfg.burstClass === "string" && cfg.burstClass.includes("fud-be-burst"));
  ok(`${name}: has shake class`,   typeof cfg.shakeClass === "string" && cfg.shakeClass.includes("fud-be-shake"));
  ok(`${name}: shakeMs > 0`,       Number.isFinite(cfg.shakeMs) && cfg.shakeMs > 0);
  ok(`${name}: fadeOutMs >= 0`,    Number.isFinite(cfg.fadeOutMs) && cfg.fadeOutMs >= 0);
  ok(`${name}: burstScale > 0`,    Number.isFinite(cfg.burstScale) && cfg.burstScale > 0);
  if (cfg.camera) {
    ok(`${name}: camera riseFrac`, Number.isFinite(cfg.camera.riseFrac) && cfg.camera.riseFrac > 0);
    ok(`${name}: camera zoom`,     Number.isFinite(cfg.camera.zoom) && cfg.camera.zoom > 0);
  }
  if (cfg.shards) {
    ok(`${name}: shard count`,     Number.isInteger(cfg.shards.count) && cfg.shards.count > 0);
    ok(`${name}: shard ms`,        Number.isFinite(cfg.shards.ms) && cfg.shards.ms > 0);
  }
}

/* ── Payload ─────────────────────────────────────────────────────────────── */

{
  // A TokenDocument (what the Wandering Flame followup passes).
  const doc = {
    id: "tokX",
    texture: { src: "sprites/flame.webm", scaleX: -1 },
    parent: { id: "sceneY" },
  };
  const p = buildDescentPayload(doc, "flame");
  eq("payload: tokenId",  p.tokenId, "tokX");
  eq("payload: src",      p.src, "sprites/flame.webm");
  eq("payload: sceneId",  p.sceneId, "sceneY");
  eq("payload: style",    p.style, "flame");
  eq("payload: mirrored token → flipX", p.flipX, true);
}

{
  // A placeable (what the director's entrance phase passes).
  const placeable = {
    id: "tokZ",
    document: { texture: { src: "sprites/fafnir.webm", scaleX: 1 } },
  };
  const p = buildDescentPayload(placeable, "shadowstorm", { id: "sceneQ" });
  eq("payload: placeable src",     p.src, "sprites/fafnir.webm");
  eq("payload: explicit scene",    p.sceneId, "sceneQ");
  eq("payload: unmirrored → flipX", p.flipX, false);
  eq("payload: style carried",     p.style, "shadowstorm");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
