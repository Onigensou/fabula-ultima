// node modules/fabula-ultima-companion/scripts/battle-director/spell-fencer-cues.test.mjs
import { applySpellFencerCues, sfCueCss, sfCueHTML } from "./spell-fencer-cues.js";
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
eq("html: blue motes (7) + glow", (html.match(/class="sfm"/g) || []).length, 7);
eq("html: orbit motes (6) + notes (2)", [(html.match(/class="sfo"/g) || []).length, (html.match(/class="sfn"/g) || []).length], [6, 2]);
eq("html deterministic per token", sfCueHTML("tok1", new Set(["sfspell"]), 120, 250, rng, px) === sfCueHTML("tok1", new Set(["sfspell"]), 120, 250, rng, px), true);
eq("css has the four keyframes", ["fuCueSfRise", "fuCueSfOrbit", "fuCueSfHelixA", "fuCueSfHelixB"].every((k) => sfCueCss().includes("@keyframes " + k)), true);

console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
