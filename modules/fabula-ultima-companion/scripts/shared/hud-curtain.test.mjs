// Node checks: the HUD curtain's holds (pure) and that the DOM side never piles up frames or timers.
// Run: node hud-curtain.test.mjs
let pass = 0, fail = 0;
const ok = (name, c, got) => { if (c) pass++; else { fail++; console.log("FAIL", name, JSON.stringify(got)); } };

// a fake page: frames, timers, a body
let rafSeq = 0, pendingRaf = new Map(), pendingTimers = new Map(), tSeq = 0;
globalThis.requestAnimationFrame = (fn) => { const id = ++rafSeq; pendingRaf.set(id, fn); return id; };
globalThis.cancelAnimationFrame = (id) => { pendingRaf.delete(id); };
const realSet = setTimeout, realClear = clearTimeout;
globalThis.setTimeout = (fn, ms) => { const id = ++tSeq; pendingTimers.set(id, fn); return id; };
globalThis.clearTimeout = (id) => { pendingTimers.delete(id); };
const props = new Map(), classes = new Set();
globalThis.document = {
  getElementById: () => null, head: { appendChild: () => {} }, createElement: () => ({}),
  body: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } },
};
const frame = () => { const fns = [...pendingRaf.values()]; pendingRaf.clear(); for (const f of fns) f(); };

const { makeCurtain, hideHud, showHud, setHudLevel, releaseHud, hudCurtainPending } = await import("./hud-curtain.js");

// ── pure holds ──
let clock = 0;
const C = makeCurtain({ clock: () => clock });
const a = C.hide("a", { fade: 1 });
clock = 0.5; ok("fading out", C.level() > 0 && C.level() < 1, C.level());
clock = 1; ok("hidden after the fade", C.level() === 0);
const b = C.hide("b", { level: 0.3 });
C.show(a, { fade: 0 });
ok("ref-counted: the other hold still hides", C.level() === 0.3, C.level());
C.set(b, 1); ok("the owner drives its hold", C.level() === 1);
C.releaseAll(); ok("release drops every hold", C.size === 0);

// ── the DOM side: an owner driving its hold every frame never piles up work ──
const tok = hideHud("test", { level: 1 });
let maxRaf = 0, maxTimers = 0;
for (let i = 0; i < 90; i++) {   // 1.5 s at 60 fps
  setHudLevel(tok, 1 - i / 90);
  frame();
  maxRaf = Math.max(maxRaf, pendingRaf.size); maxTimers = Math.max(maxTimers, pendingTimers.size);
}
ok("never more than one frame pending", maxRaf <= 1, maxRaf);
ok("never more than one watchdog timer pending", maxTimers <= 1, maxTimers);
ok("the HUD is hidden through the hold", classes.has("fud-hud-curtain") && Number(props.get("--fud-hud-curtain")) < 0.05, [...props]);
showHud(tok, { fade: 0 });
ok("given back: the HUD shows, nothing left pending", !classes.has("fud-hud-curtain") && hudCurtainPending().raf === 0 && hudCurtainPending().timer === 0 && pendingRaf.size === 0, { ...hudCurtainPending(), raf: pendingRaf.size });

// ── a hidden tab (no frames): the watchdog finishes a release ──
const t2 = hideHud("hidden-tab", { fade: 0 });
showHud(t2, { fade: 0.2 });
for (let i = 0; i < 20 && pendingTimers.size; i++) { const fns = [...pendingTimers.values()]; pendingTimers.clear(); await new Promise((r) => realSet(r, 30)); for (const f of fns) f(); }
ok("with no frames, the watchdog still lets the HUD back", !classes.has("fud-hud-curtain"), [...classes]);
releaseHud();
ok("release leaves nothing pending", hudCurtainPending().raf === 0 && hudCurtainPending().timer === 0);

console.log(`${pass} pass, ${fail} fail`);
process.exitCode = fail ? 1 : 0;
