// One Sealed Cavern balance fight through the real engine (sim.run, Soul Tithe on, Valley_Battlemap004).
// Options: globalThis.__NOX_OPTS = { group: "Nox Ghoul, Nox Hound, ...", seed: null|n, maxRounds, pace }.
// Returns the outcome plus PC-only HP (the sim's partyHpRemaining pools guest Kalina's 498 HP in).
//   warm:  node ../snapshot-runner/bin/warm.mjs eval <wrapper.js> --port 30111 --dump out.json
const O = Object.assign({ group: "Nox Hound, Nox Viper, Nox Hound", seed: null, maxRounds: 10, expectedRounds: 6, pace: "batch" }, globalThis.__NOX_OPTS ?? {});
const NS = "fabula-ultima-companion";
const X = FUCompanion.api.experimental;
if (game.paused) await game.togglePause(false, true);
// Battle depth off (client setting; presentation only): the Valley backdrop is a three.js set, and
// software GL drew it at ~170 ms a frame, most of the wall time. stage3d: "camera" keeps it.
const stage = O.stage3d ?? "off";
if (game.settings.get(NS, "battleStage3d") !== stage) { await game.settings.set(NS, "battleStage3d", stage); await canvas.draw(); }
{ // let the Field's scene reseed settle first (see sim-battle.js)
  const sceneId = canvas.scene?.id;
  const settled = () => game.actors.filter((a) => a.flags?.[NS]?.isField)
    .every((f) => f.effects.contents.every((e) => e.flags?.[NS]?.fieldOrigin !== "scene" || e.flags[NS].fieldSceneId === sceneId));
  for (let i = 0; i < 60 && !settled(); i++) await new Promise((r) => setTimeout(r, 250));
}
const mulberry = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const real = { random: Math.random, uniform: CONFIG.Dice.randomUniform };
if (O.seed != null) { Math.random = mulberry(O.seed); CONFIG.Dice.randomUniform = mulberry(O.seed + 7919); }

const errs = [];
const oe = console.error;
console.error = (...a) => { try { errs.push(a.map((x) => x?.stack ?? (typeof x === "string" ? x : JSON.stringify(x)?.slice(0, 300))).join(" ").slice(0, 400)); } catch {} return oe.apply(console, a); };
const names = String(O.group).split(",").map((s) => s.trim());
const counts = {}; for (const n of names) counts[n] = (counts[n] ?? 0) + 1;
const enemies = Object.entries(counts).map(([n, q]) => { const a = game.actors.find((x) => x.name === n && x.type !== "_template"); if (!a) throw new Error("no actor " + n); return { uuid: a.uuid, quantity: q }; });
const PCS = ["Hina", "Zarg", "Keren", "Blanche"];
const t0 = performance.now();
// skipAnim (default on): skip each director presentation as it starts (as checks/sim-battle-profile.js
// does). The battle logic does not wait on them; software-drawn action animations were most of the wall time.
const skipT = O.skipAnim === false ? null : setInterval(() => { try { if (X.battleDirector.status?.()?.running) X.battleDirector.skipAnimation?.(); } catch {} }, 50);
let r, hung = null;
const runP = X.sim.run({ enemies, pace: O.pace, maxRounds: O.maxRounds, expectedRounds: O.expectedRounds, conflictEvent: "soul-tithe", scene: "Valley_Battlemap004" });
try {
  // A stuck fight (a prompt nobody answers, a wait that never ends) reports where it stopped.
  // Real time: the runner's --fast warps setTimeout x20, performance.now() is not warped.
  const limit = new Promise((res) => { const tl = performance.now(); const tick = () => (performance.now() - tl > (O.timeoutS ?? 240) * 1000 ? res("__timeout") : setTimeout(tick, 200)); tick(); });
  r = await Promise.race([runP, limit]);
  if (r === "__timeout") {
    const d = X.battleDirector.getActiveDirector?.();
    hung = {
      state: X.battleDirector.status?.()?.state ?? null, round: d?.dCombat?.round ?? null,
      turn: d?.dCombat?.current?.actorDoc?.name ?? d?.dCombat?.activeCombatant?.actorDoc?.name ?? null,
      dialogs: Object.values(ui.windows ?? {}).map((w) => w?.title ?? w?.constructor?.name).slice(0, 10),
      bdLog: (globalThis.__bdLog ?? []).slice(-40).map((x) => String(typeof x === "string" ? x : (x?.msg ?? JSON.stringify(x))).slice(0, 240)),
    };
    try { await X.sim.abort?.(); } catch {}
    try { if (X.battleDirector.isRunning?.()) await X.battleDirector.stop(); } catch {}
    r = null;
  }
} finally {
  console.error = oe;
  if (skipT) clearInterval(skipT);
  Math.random = real.random; CONFIG.Dice.randomUniform = real.uniform;
}
const cs = r?.combatants ?? [];
const pcs = PCS.map((n) => {
  const c = cs.find((x) => String(x.name).replace(/ \[SIM\]$/, "") === n);
  const base = Number(game.actors.getName(n)?.system?.props?.max_hp) || null;   // base max: Soul Tithe lowers max mid-fight
  return { name: n, hp: c?.hp ?? null, max: base, down: !!(c?.defeated ?? c?.isDefeated) };
});
const sumHp = pcs.reduce((s, p) => s + Math.max(0, Number(p.hp) || 0), 0);
const sumMax = pcs.reduce((s, p) => s + (Number(p.max) || 0), 0);
return {
  hung, group: O.group, seed: O.seed, outcome: r?.outcome, rounds: r?.rounds,
  pcHp: sumMax ? +(sumHp / sumMax).toFixed(3) : null, pcsDown: pcs.filter((p) => p.down || !(p.hp > 0)).length, pcs,
  wallS: +((performance.now() - t0) / 1000).toFixed(1),
  combatants: cs.map((c) => ({ name: c.name, side: c.side, hp: c.hp, maxHp: c.maxHp, defeated: c.defeated ?? c.isDefeated })),
  transcript: (r?.transcript ?? []).slice(-400), errs: errs.slice(0, 40),
};
