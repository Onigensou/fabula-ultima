// node modules/fabula-ultima-companion/scripts/battle-director/spell-fencer-cues.test.mjs
import { applySpellFencerCues, sfCueCss, sfCueHTML, sfOutline, sfGlowParams, sfBreath, CUE_P } from "./spell-fencer-cues.js";
import { cueOf } from "./status-classifier.js";

let fails = 0;
const eq = (label, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + label + (ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };
const M = "fabula-ultima-companion";
const ae = (name, flags = {}, statuses = []) => ({ name, disabled: false, statuses, flags: { [M]: flags } });
const actor = (...effs) => ({ appliedEffects: effs });
const cuesFor = (a) => { const s = new Set(); for (const e of a.appliedEffects) { const c = cueOf(e, []); if (c) s.add(c); } return [...applySpellFencerCues(a, s)].sort(); };

eq("Next Spell → blue", cuesFor(actor(ae("Next Spell", {}, ["fud-next-spell"]))), ["sfspell"]);
eq("Next Attack → red", cuesFor(actor(ae("Next Attack"))), ["sfattack"]);
eq("Resonance 1 → no gold", cuesFor(actor(ae("Next Attack"), ae("Resonance", { chargeKey: "resonance", charges: 1 }))), ["sfattack"]);
eq("Resonance 2 → gold on top", cuesFor(actor(ae("Next Attack"), ae("Resonance", { chargeKey: "resonance", charges: 2 }))), ["sfattack", "sfreso"]);
eq("Chanter-style AE named Resonance without the charge key → nothing", cuesFor(actor(ae("Resonance", { charges: 5 }))), []);
eq("Rhapsody Turn hides the rest", cuesFor(actor(ae("Next Spell"), ae("Rhapsody Turn"), ae("Resonance", { chargeKey: "resonance", charges: 3 }))), ["sfbraid"]);
eq("Berserk untouched", cuesFor(actor(ae("Berserk"))), ["berserk"]);

const rng = (seed) => { let s = 7; for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
const px = (v) => `${Math.round(v)}px`;
const html = sfCueHTML("tok1", new Set(["sfspell", "sfreso"]), 120, 250, rng, px);
eq("html: blue motes (5, approved v2)", (html.match(/class="sfm"/g) || []).length, 5);
eq("html: orbit motes (3) + notes (0), approved v2", [(html.match(/class="sfo"/g) || []).length, (html.match(/class="sfn"/g) || []).length], [3, 0]);
eq("html deterministic per token", sfCueHTML("tok1", new Set(["sfspell"]), 120, 250, rng, px) === sfCueHTML("tok1", new Set(["sfspell"]), 120, 250, rng, px), true);
eq("css has the four keyframes", ["fuCueSfRise", "fuCueSfOrbit", "fuCueSfHelixA", "fuCueSfHelixB"].every((k) => sfCueCss().includes("@keyframes " + k)), true);

// ── v2 outline glow: precedence → colour / strength
const out = (...c) => { const o = sfOutline(new Set(c)); return o && [o.cue, o.rgb.join(","), o.strength, o.width, o.breathMs]; };
eq("outline: none without a cue", sfOutline(new Set(["berserk"])), null);
eq("outline: Next Spell = blue .45 / 6 / 2600", out("sfspell"), ["sfspell", "77,166,255", 0.45, 6, 2600]);
eq("outline: Next Attack = red .45 / 6 / 2600", out("sfattack"), ["sfattack", "255,77,61", 0.45, 6, 2600]);
eq("outline: Resonance ready beats Next Attack = violet .65 / 7", out("sfattack", "sfreso"), ["sfreso", "180,92,255", 0.65, 7, 2600]);
eq("outline: Resonance ready beats Next Spell", out("sfspell", "sfreso")[0], "sfreso");
eq("outline: Rhapsody Turn wins = violet .8 / 13 / 4200", out("sfbraid", "sfreso", "sfattack"), ["sfbraid", "180,92,255", 0.8, 13, 4200]);
eq("approved blend = violet #b45cff", CUE_P.braid.olcol === 0 && CUE_P.reso.olcol === 0, true);
const g0 = sfGlowParams(sfOutline(new Set(["sfspell"])), 0), g1 = sfGlowParams(sfOutline(new Set(["sfspell"])), 2600);
eq("glow: colour 0x4da6ff, distance ceil(6 x 1.3) = 8", [g0.color, g0.distance], [0x4da6ff, 8]);
eq("glow: breath .7 → 1.0 of strength x 4", [+g0.outerStrength.toFixed(3), +g1.outerStrength.toFixed(3)], [1.26, 1.8]);
eq("glow: outline alpha = min(1, strength x 1.6)", +g0.outlineAlpha.toFixed(2), 0.72);
eq("glow: fade k scales it", +sfGlowParams(sfOutline(new Set(["sfspell"])), 2600, 0.5).outerStrength.toFixed(2), 0.9);
eq("breath curve 0 → 1 → 0", [sfBreath(0, 100), sfBreath(100, 100), +sfBreath(200, 100).toFixed(6)], [0, 1, 0]);

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
