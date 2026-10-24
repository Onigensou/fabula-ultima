// ============================================================================
// Defeat styles — style-selection harness.
//
//     node scripts/battle-director/defeat-styles.test.mjs
//
// Bare Node, no Foundry. Covers the pure half: which defeat a monster gets.
// The renderer (defeat-fx.js) is DOM + PIXI and belongs in a live review.
//
// The load-bearing block is LEGACY EQUIVALENCE: every monster in the world
// carries no defeat flag, and anything that does not read as "standard" for
// them would change every existing fight's deaths.
// ============================================================================

import {
  DEFEAT_STYLES,
  DEFAULT_DEFEAT_STYLE,
  DEFEAT_MODULE_ID,
  DEFEAT_STYLE_FLAG,
  defeatStyleFromFlags,
  defeatStartsOnHit,
  ownsDefeatReaction,
} from "./defeat-styles.js";

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  console.error(`FAIL  ${label}\n        got  ${g}\n        want ${w}`);
};
const ok = (label, cond) => eq(label, !!cond, true);
const withStyle = (s) => ({ [DEFEAT_MODULE_ID]: { [DEFEAT_STYLE_FLAG]: s } });

/* ── LEGACY EQUIVALENCE ──────────────────────────────────────────────────── */

eq("default is standard",       DEFAULT_DEFEAT_STYLE, "standard");
eq("no flags",                  defeatStyleFromFlags(undefined), "standard");
eq("empty flags",               defeatStyleFromFlags({}), "standard");
eq("other modules' flags",      defeatStyleFromFlags({ theatre: { x: 1 } }), "standard");
eq("our ns, other keys only",   defeatStyleFromFlags({ [DEFEAT_MODULE_ID]: { entranceStyle: "shadowstorm" } }), "standard");
eq("blank",                     defeatStyleFromFlags(withStyle("")), "standard");
eq("whitespace",                defeatStyleFromFlags(withStyle("   ")), "standard");
eq("explicit standard",         defeatStyleFromFlags(withStyle("standard")), "standard");
ok("standard is not a table entry (it is the untouched legacy chain)", !("standard" in DEFEAT_STYLES));

/* ── Recognised styles ───────────────────────────────────────────────────── */

eq("dissolve",                  defeatStyleFromFlags(withStyle("dissolve")), "dissolve");
eq("burst",                     defeatStyleFromFlags(withStyle("burst")), "burst");
eq("padded value trimmed",      defeatStyleFromFlags(withStyle("  burst ")), "burst");

/* ── Bad values never become an effect ───────────────────────────────────── */

eq("typo → standard",           defeatStyleFromFlags(withStyle("disolve")), "standard");
eq("retired → standard",        defeatStyleFromFlags(withStyle("meteor")), "standard");
eq("inherited key → standard",  defeatStyleFromFlags(withStyle("toString")), "standard");
eq("number → standard",         defeatStyleFromFlags(withStyle(3)), "standard");
eq("object → standard",         defeatStyleFromFlags(withStyle({ a: 1 })), "standard");
eq("null → standard",           defeatStyleFromFlags(withStyle(null)), "standard");
const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
eq("throwing flags → standard", defeatStyleFromFlags(hostile), "standard");

/* ── Table integrity (what the renderer relies on) ───────────────────────── */

for (const [key, s] of Object.entries(DEFEAT_STYLES)) {
  ok(`${key}: has a label`, typeof s.label === "string" && s.label.length);
  ok(`${key}: totalMs is a positive number`, Number.isFinite(s.totalMs) && s.totalMs > 0);
  ok(`${key}: totalMs within the 3 s a defeat may hold the battle`, s.totalMs <= 3000);
  ok(`${key}: body fade finishes inside totalMs`,
     (s.body?.delayMs ?? 0) + (s.body?.fadeMs ?? 0) <= s.totalMs);
  const cues = Array.isArray(s.sfx) ? s.sfx : [{ atMs: 0, ...s.sfx }];
  ok(`${key}: has a sound`, cues.length > 0);
  ok(`${key}: every cue is a URL inside totalMs`,
     cues.every((c) => typeof c.url === "string" && c.url.startsWith("https://") && (c.atMs ?? 0) >= 0 && (c.atMs ?? 0) < s.totalMs));
  for (const part of ["flash", "embers", "fluff", "screenFlash"]) {
    if (s[part]?.atMs == null) continue;
    ok(`${key}.${part}: ends inside totalMs`, s[part].atMs + s[part].ms <= s.totalMs);
  }
  for (const part of ["motes", "embers"]) {
    if (!s[part]) continue;
    ok(`${key}.${part}: count > 0`, s[part].count > 0);
    ok(`${key}.${part}: rgb list non-empty`, Array.isArray(s[part].rgb) && s[part].rgb.length);
  }
  if (s.motes) ok(`${key}.motes: last mote dies inside totalMs`, s.motes.spawnOverMs + s.motes.lifeMs[1] <= s.totalMs);
}

/* ── Overfed (King Gorger companion, user ruling 2026-10-24) ─────────────── */

eq("overfed reads as a style", defeatStyleFromFlags(withStyle("overfed")), "overfed");
{
  const o = DEFEAT_STYLES.overfed;
  ok("overfed: within the 3 s a defeat may hold the battle", o.totalMs <= 3000);
  ok("overfed: body copy pops before the burst ends", o.copy.popMs === o.flash.atMs && o.copy.popMs === o.crown.atMs);
  ok("overfed: shudder before swell before pop", 0 < o.copy.shudderMs && o.copy.shudderMs < o.copy.popMs);
  ok("overfed: leak is during the swell", o.leak.fromMs >= o.copy.shudderMs && o.leak.toMs + o.leak.lifeMs <= o.copy.popMs + 400);
  ok("overfed: crown fade ends inside totalMs", o.crown.atMs + o.crown.fadeAfterMs + o.crown.fadeMs <= o.totalMs);
  ok("overfed: crown lands before it bounces and fades", o.crown.flyMs + o.crown.bounceMs <= o.crown.fadeAfterMs);
  ok("overfed: landing cue matches the landing", o.sfx.some((c) => c.atMs === o.crown.atMs + o.crown.flyMs));
  ok("overfed: real token hidden at once (the copy stands in)", o.body.delayMs === 0 && o.body.fadeMs <= 1);
}

/* ── Launched (King Gorger Wild, Smash KO — user ask 2026-10-24) ─────────── */

eq("launched reads as a style", defeatStyleFromFlags(withStyle("launched")), "launched");
{
  const o = DEFEAT_STYLES.launched;
  const edge = o.hitstop.ms + o.launch.edgeMs;
  ok("launched: no sound of its own on the hit (the blow already has one)", !o.sfx.some((c) => c.atMs < o.hitstop.ms));
  ok("launched: launch cue on the release", o.sfx.some((c) => c.atMs === o.hitstop.ms));
  ok("launched: blast cue when he crosses the edge", o.sfx.some((c) => c.atMs === edge));
  ok("launched: blast ends inside totalMs", edge + o.blast.ms <= o.totalMs);
  ok("launched: camera is back before the blast (exit point is on the restored view)", o.launch.zoomOutMs < o.launch.edgeMs);
  ok("launched: punch-in lands inside the freeze", o.hitstop.zoomInMs < o.hitstop.ms && o.hitstop.zoom > 1);
  ok("launched: impact fits the freeze + flight", o.impact.ms <= edge);
  ok("launched: beam streaks + colours present", o.blast.streaks > 0 && o.blast.rgb.length > 0);
  ok("launched: beam core is a fraction of the band", o.blast.core > 0 && o.blast.core < 1);
  ok("launched: the flight is fast (force reads as speed)", o.launch.edgeMs <= 300);
  ok("launched: the spray and the shock ring are the opening of the beam", o.blast.spray.life > 0 && o.blast.spray.life <= 0.5 && o.blast.ring.life > 0 && o.blast.ring.life <= 0.5);
  ok("launched: air rings sit on the flight", o.launch.rings.every((r) => r >= 0 && r < 1) && o.launch.ringMs > 0);
  ok("launched: the bang flash is a short part of the beam", o.blast.flash.ms > 0 && o.blast.flash.ms < o.blast.ms / 4);
  ok("launched: field dims before the beam, while he is still flying", o.blast.dimLeadMs > 0 && o.blast.dimLeadMs < o.launch.edgeMs);
  ok("launched: real token hidden at once (the copy stands in)", o.body.delayMs === 0 && o.body.fadeMs <= 1);
}

/* ── Starting on the hit ─────────────────────────────────────────────────── */

{
  const go = { style: "launched", hp: 0, inBattle: true, willRemove: true, ownReaction: false };
  ok("on-hit: launched opts in", DEFEAT_STYLES.launched.startOnHit === true);
  eq("on-hit: every fact holds → starts on the hit", defeatStartsOnHit(go), true);
  eq("on-hit: a style without startOnHit waits for the settle", defeatStartsOnHit({ ...go, style: "overfed" }), false);
  eq("on-hit: standard (no style) waits", defeatStartsOnHit({ ...go, style: "standard" }), false);
  eq("on-hit: HP above 0 waits", defeatStartsOnHit({ ...go, hp: 3 }), false);
  eq("on-hit: unreadable HP waits", defeatStartsOnHit({ ...go, hp: null }), false);
  eq("on-hit: blank HP waits", defeatStartsOnHit({ ...go, hp: "" }), false);
  eq("on-hit: HP as the string \"0\" counts", defeatStartsOnHit({ ...go, hp: "0" }), true);
  eq("on-hit: no battle running waits (nothing would remove the token)", defeatStartsOnHit({ ...go, inBattle: false }), false);
  eq("on-hit: removal gates fail (champion, auto-defeat off, secret) waits", defeatStartsOnHit({ ...go, willRemove: false }), false);
  eq("on-hit: its own defeat reaction waits", defeatStartsOnHit({ ...go, ownReaction: true }), false);
  eq("on-hit: unknown reaction state waits", defeatStartsOnHit({ ...go, ownReaction: undefined }), false);
  for (const [key, st] of Object.entries(DEFEAT_STYLES)) if (key !== "launched") ok(`on-hit: ${key} keeps the settle timing`, !st.startOnHit);

  const row = (trigger, extra = {}) => ({ reaction_trigger: trigger, ...extra });
  const item = (rows) => ({ system: { props: { reaction_config_table: rows } } });
  const ae = (rows) => ({ flags: { [DEFEAT_MODULE_ID]: { reactionConfig: { reaction_config_table: rows } } } });
  eq("own reaction: none at all", ownsDefeatReaction({ items: [], effects: [] }), false);
  eq("own reaction: other triggers only", ownsDefeatReaction({ items: [item({ 0: row("creature_takes_damage") })], effects: [] }), false);
  eq("own reaction: item row on creature_defeated", ownsDefeatReaction({ items: [item({ 0: row("creature_defeated") })], effects: [] }), true);
  eq("own reaction: padded trigger still counts", ownsDefeatReaction({ items: [item({ 3: row("  creature_defeated ") })] }), true);
  eq("own reaction: a deleted row does not count", ownsDefeatReaction({ items: [item({ 0: row("creature_defeated", { $deleted: true }) })] }), false);
  eq("own reaction: Active Effect reactionConfig row", ownsDefeatReaction({ items: [], effects: [ae({ 0: row("creature_defeated") })] }), true);
  eq("own reaction: Foundry-style collections (.contents)", ownsDefeatReaction({ items: { contents: [item({ 0: row("creature_defeated") })] }, effects: { contents: [] } }), true);
  const hostileActor = new Proxy({}, { get() { throw new Error("boom"); } });
  eq("own reaction: unreadable actor → assume it might react", ownsDefeatReaction(hostileActor), true);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
