// restore.look: the public hook Army of the Damned drives a fragment's fire with (no Foundry, no PIXI).
//   node modules/fabula-ultima-companion/scripts/conflict-event/soul-fx/soul-fx-look.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
globalThis.Hooks ??= { on() {}, once() {} };
globalThis.PIXI ??= new Proxy(function () {}, { get: () => function () {} });
const rt = await import("./soul-fx-runtime.js");

let fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : "  " + d}`); if (!c) fail++; };

const fire = { override: null, dirty: false };
const r = rt.suppressFire(fire, { maxMs: 10000 });
ok("restore.look exists", typeof r.look === "function");
fire.dirty = false;
r.look({ k: 1, flare: 1.5, bright: 0.4 });
ok("look sets the override", fire.override.k === 1 && fire.override.flare === 1.5 && fire.override.bright === 0.4 && fire.dirty);
r.look({ flare: 0.2 });
ok("look: omitted fields untouched", fire.override.k === 1 && fire.override.flare === 0.2 && fire.override.bright === 0.4);
r.look();
ok("look() with no args is harmless", fire.override.flare === 0.2);
r();
ok("restore: override gone", fire.override === null);
fire.dirty = false;
r.look({ k: 1, flare: 2, bright: 1 });
ok("look after restore: no-op, no override resurrected", fire.override === null && fire.dirty === false);

const prev = { k: 0.5, flare: 1, bright: 0, hideMesh: false };
const f2 = { override: prev, dirty: false };
const r2 = rt.suppressFire(f2, { maxMs: 10000 });
r2.look({ flare: 2 }); r2();
ok("earlier override restored untouched", f2.override === prev && prev.flare === 1);

const f3 = { override: null, dirty: false };
const r3 = rt.suppressFire(f3, { maxMs: 10000 });
const newer = { k: 0, flare: 0, bright: 0, hideMesh: true };
f3.override = newer; f3.dirty = false;
r3.look({ k: 1, flare: 2, bright: 1 });
ok("look when a newer show owns the fire: no-op", newer.flare === 0 && newer.k === 0 && !f3.dirty);

const f4 = { override: null, dirty: false };
rt.suppressFire(f4, { maxMs: 30 }).look({ flare: 1 });
await new Promise((x) => setTimeout(x, 80));
const f4r = f4.override;
ok("timeout restore leaves nothing to drive", f4r === null);

ok("suppressFire(null) / non-fragment: harmless, no look", rt.suppressFire(null).look === undefined && rt.suppressFragmentFire("nope").look === undefined);

// two holders on one fire: only the newest live one writes
const f5 = { override: null, dirty: false };
const ra = rt.suppressFire(f5, { maxMs: 10000 }), rb = rt.suppressFire(f5, { maxMs: 10000 });
ra.look({ k: 1, flare: 1 });
ok("older holder is silent while a newer one is live", f5.override.flare === 0 && f5.override.k === 0);
rb.look({ k: 1, flare: 2 });
ok("newest holder writes", f5.override.flare === 2);
rb();
ra.look({ flare: 0.7 });
ok("after the newer restores, the older writes again", f5.override.flare === 0.7);
ra();
ok("last restore hands the fire back", f5.override === null);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const army = fs.readFileSync(path.join(HERE, "../../../../../tools/anim-studio/nidhogg-army-of-the-damned.js"), "utf8");
ok("generated Army clip no longer references __FU_SOUL_FX__", !army.includes("__FU_SOUL_FX__"));
ok("generated Army clip uses restore.look", army.includes("g.restore.look") && army.includes("g.look({"));

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
