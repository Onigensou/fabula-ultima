// Node checks for the SFX cue tracks and the three cue sheets that use them. No game.
// Run: node scripts/shared/sfx-cues.test.mjs
import { makeCueTrack, cueStart, cueUrl, CUE_LATE_S, SOUND_BASE } from "./sfx-cues.js";
import { SOUL_SFX, SOUL_SFX_URLS } from "../conflict-event/soul-fx/soul-fx-sfx.js";
import { TITHE, CALLING, DESTROY } from "../conflict-event/soul-fx/soul-fx-effects.js";
import { DEATH_SFX, DEATH_SFX_URLS } from "../sealing-crystal/crystal-death-sfx.js";
import { DEATH, ENDING_BLACK_AT } from "../sealing-crystal/crystal-death.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// the track
{
  const cues = [{ beat: 1, file: "a.ogg", peak: 0.4 }, { beat: 2, file: "b c.ogg", peak: 0 }, { beat: 0.1, file: "c.ogg", peak: 0.5 }];
  ok(cueStart(cues[0]) === 0.6 && cueStart(cues[2]) === 0, "a cue starts peak seconds early, never before 0");
  ok(cueUrl("Soundboard/b c.ogg") === SOUND_BASE + "Soundboard/b%20c.ogg", "url: path segments encoded, slashes kept");
  const tr = makeCueTrack(cues), heard = [];
  const play = (c) => heard.push(c.file);
  for (let t = 0; t <= 2.5; t += 1 / 60) tr.step(t, play);
  ok(JSON.stringify(heard) === JSON.stringify(["c.ogg", "a.ogg", "b c.ogg"]), `every cue once, in start order (${heard})`);
  tr.step(3, play);
  ok(heard.length === 3, "never twice");
  const jump = makeCueTrack(cues), h2 = [];
  jump.step(1.9, (c) => h2.push(c.file));
  ok(h2.length === 0, "a clock that jumps past cues stays quiet (no pile of stale sounds)");
  jump.step(2.0 + CUE_LATE_S / 2, (c) => h2.push(c.file));
  ok(JSON.stringify(h2) === JSON.stringify(["b c.ogg"]), "a cue only just passed still plays");
  const boom = makeCueTrack([{ beat: 0, file: "x" }]);
  boom.step(0, () => { throw new Error("audio"); });
  ok(boom.fired.length === 1, "a play that throws never breaks the track");
}

// the cue sheets
const sane = (c, end, name) => {
  ok(typeof c.file === "string" && /\.(ogg|wav|mp3)$/.test(c.file) && !c.file.startsWith("http"), `${name}: ${c.label}: a file under Sound/`);
  ok(c.vol > 0 && c.vol <= 0.8, `${name}: ${c.label}: volume ${c.vol} in (0, 0.8]`);
  ok(c.beat >= 0 && c.beat <= end, `${name}: ${c.label}: lands inside the show (${c.beat} of ${end})`);
  ok(c.beat - (c.peak ?? 0) >= -1e-9, `${name}: ${c.label}: its start (${(c.beat - c.peak).toFixed(2)}) is not before the show starts`);
};
for (const c of SOUL_SFX.tithe) sane(c, TITHE.END, "tithe");
for (const c of SOUL_SFX.calling) sane(c, CALLING.END, "calling");
for (const c of SOUL_SFX.destroy) sane(c, DESTROY.END, "destroy");
for (const c of DEATH_SFX) sane(c, ENDING_BLACK_AT, "death");
ok(SOUL_SFX.calling.filter((c) => /bead/.test(c.label)).length === CALLING.BEADS, "calling: one sound per bead");
ok(SOUL_SFX.destroy.filter((c) => /flamelet/.test(c.label)).length === DESTROY.LANDINGS.length, "destroy: one sound per flamelet landing");
ok(Math.abs(Math.max(...SOUL_SFX.calling.filter((c) => /bead/.test(c.label)).map((c) => c.beat)) - (CALLING.PULL[1])) < 0.05, "calling: the last bead lands at the end of the pull");
ok(DEATH_SFX.filter((c) => c.beat === DEATH.shatter).length === 3, "death: the rumble peaks, the break and the explosion all land on the shatter");
ok(!DEATH_SFX.some((c) => c.beat > DEATH.whiteFull), "death: nothing after full white (silence into the black)");
// death has 7 distinct files since the swell + shimmer were cut (user ruling 2026-11-11)
ok(SOUL_SFX_URLS.length >= 8 && DEATH_SFX_URLS.length >= 7, "preload lists built");
ok(!DEATH_SFX.some((c) => /swell|shimmer/.test(c.label)), "death: no swell and no shimmer (cut 2026-11-11)");

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
