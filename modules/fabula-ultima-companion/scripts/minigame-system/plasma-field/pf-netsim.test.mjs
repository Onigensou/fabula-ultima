// ============================================================================
// Plasma Field Dash: headless network test.
//   node scripts/minigame-system/plasma-field/pf-netsim.test.mjs [humans=2] [latencyMs=90] [jitterMs=60] [drop]
//
// One host (GM, no runner) + N player clients on autopilot, all in one process
// on a virtual clock, talking through a fake network with latency and jitter.
// A full game must finish (practice, 3 stages, finale, summary) and every
// screen must agree on places and points. "drop" kills player 1 mid-Stage 2:
// a CPU must take the runner over and the game must still finish cleanly.
// Exit code 1 on any failure. ~5-10 s.
// ============================================================================
let __errs = 0; const __ce = console.error; console.error = (...a) => { __errs++; if (__errs < 4) __ce(...a); };
const humans = +(process.argv[2] || 2), LAT = +(process.argv[3] || 90), JIT = +(process.argv[4] || 60), DROP = process.argv[5] === "drop";

// ---- DOM stubs (drawing is a no-op; layout code just needs objects to talk to)
const any = () => new Proxy(function(){}, { get: (t, k) => k === Symbol.toPrimitive ? () => 0 : k === "width" ? 10 : k === "length" ? 0 : any(), apply: () => any(), set: () => true });
const ctx2d = new Proxy({}, { get: (t, k) => k === "measureText" ? () => ({ width: 50 }) : k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop(){} }) : k === "getImageData" ? () => { throw 0; } : () => {}, set: () => true });
const el = () => { const e = { style: { setProperty(){} }, classList: { add(){}, remove(){}, toggle(){} }, children: [], innerHTML: "", appendChild(c){ return c; }, remove(){}, querySelector: () => el(), querySelectorAll: () => [], addEventListener(){}, setAttribute(){}, getContext: () => ctx2d, width: 0, height: 0, focus(){} }; return e; };
globalThis.document = { createElement: el, getElementById: () => null, body: { contains: () => true } };
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false }); globalThis.Image = class { set src(v){} };
globalThis.Audio = class { constructor(){ this.volume = 1; } play(){ return Promise.resolve(); } pause(){} load(){} removeAttribute(){} };
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};

const { createPlasmaField } = await import(new URL("./pf-game.js", import.meta.url).href);

// ---- network on a virtual clock
let now = 0; const q = [];
const clients = [];
const ROSTER = ["Hina", "Keren", "Blanche", "Zarg"].map((name, i) => ({ name, actorId: "A" + i, attrs: [{mig:8,dex:6,ins:12,wlp:10},{mig:6,dex:8,ins:12,wlp:10},{mig:12,dex:12,ins:6,wlp:6},{mig:8,dex:12,ins:8,wlp:8}][i], userId: i < humans ? "U" + i : null, cpu: i >= humans, art: {} }));
let bytes = 0, msgs = 0; const byKind = {};
function mkClient(userId, isGM, myIdx){
  const c = { userId, isGM, inbox: [], lastHost: 0, dead: false };
  const env = {
    canvas: el(), overlay: el(), roster: ROSTER.map(r => ({ ...r })), myIdx, userId, hostId: "GM", isHost: isGM, isGM, autopilot: true,
    asset: f => f, bgm: {}, sfxVol: () => 0, musicVol: () => 0, isActive: () => true, firstClear: true,
    stageBox: () => ({ w: 960, h: 600 }), place(){}, showPerf: () => false,
    onResult: (r) => { c.result = r; }, onClose: () => { c.closed = true; },
    net: {
      send(k, d){ if (c.dead) return; const s = JSON.stringify(d); bytes += s.length; msgs++; byKind[k] = (byKind[k] || 0) + s.length;
        for (const o of clients) if (o !== c) q.push({ at: now + LAT + Math.random()*JIT, to: o, k, d: JSON.parse(s), from: { id: userId, isGM } }); },
      hostNow: () => now, hostSilentMs: () => isGM ? 0 : now - c.lastHost,
    },
  };
  c.env = env; c.game = createPlasmaField(env);
  return c;
}
clients.push(mkClient("GM", true, -1));
for (let i = 0; i < humans; i++) clients.push(mkClient("U" + i, false, i));
for (const c of clients) c.game.begin({ intro: "full" });
const host = clients[0];
let tLast = 0, dropped = false;
const STEP = 16;
const t0 = Date.now();
while (now < 12*60*1000){
  now += STEP;
  q.sort((a, b) => a.at - b.at);
  while (q.length && q[0].at <= now){ const m = q.shift(); if (m.to.dead) continue; if (m.from.id === "GM") m.to.lastHost = now; m.to.game.handle(m.k, m.d, m.from); }
  for (const c of clients) if (!c.dead) c.game.debug.step(STEP);
  if (DROP && !dropped && host.game.G.mode === "play" && host.game.G.stage === 1 && host.game.G.stageT > (globalThis.__dropAt ??= 3000 + Math.random()*40000) && clients[1].game.G.players[0].state !== "walk"){ dropped = true; clients[1].dead = true; console.log("-- dropped U0 at", (now/1000).toFixed(1), "s"); }
  if (now - tLast > 20000){ tLast = now; const G = host.game.G; console.log(`t=${(now/1000).toFixed(0)}s mode=${G.mode} stage=${G.stage} stageT=${(G.stageT/1000).toFixed(0)} haz=${G.haz.length} players=${G.players.map(p => `${p.name}:${p.state}${p.cpu ? "(cpu)" : ""}@${Math.round(p.y)}`).join(" ")}`); }
  if (host.game.G.mode === "summary" && clients.every(c => c.dead || c.game.G.mode === "summary")) break;
}
console.log("ended at", (now/1000).toFixed(1), "s virtual,", ((Date.now() - t0)/1000).toFixed(1), "s real");
for (const c of clients){ if (c.dead) continue; const G = c.game.G;
  console.log(c.userId.padEnd(3), "mode", G.mode, "| pts", G.players.map(p => p.stats.points).join("/"), "| places", G.players.map(p => p.stats.places.map(r => r ? r.place : "-").join("")).join(" "), "| perf", JSON.stringify(c.game.perf()));
}
console.log("times", JSON.stringify(host.game.G.players.map(p => p.stats.places.map(r => r ? Math.round(r.time/1000) : null))));
console.log("summary rows", JSON.stringify(host.game.G.summary?.rows?.map(r => [r.i, r.place, r.points, r.title])));
console.log("result", JSON.stringify(host.result));
console.log(`net: ${msgs} msgs, ${(bytes/1024).toFixed(0)} KiB total, ${(bytes/1024/(now/1000)).toFixed(1)} KiB/s; by kind (KiB):`, Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, +(v/1024).toFixed(0)])));
// cross-client agreement
const sig = c => c.game.G.players.map(p => p.stats.points + ":" + p.stats.places.map(r => r?.place).join(",")).join("|");
const sigs = clients.filter(c => !c.dead).map(sig); console.log("agree:", sigs.every(s => s === sigs[0]));
console.log("console.errors", __errs);

const fail = [];
if (!clients.filter(c => !c.dead).every(c => c.game.G.mode === "summary")) fail.push("not every screen reached the summary");
if (!sigs.every(x => x === sigs[0])) fail.push("screens disagree on places/points");
if (!host.game.G.summary?.rows?.length) fail.push("no summary built");
if (__errs) fail.push(__errs + " console errors");
if (DROP && !dropped) fail.push("the drop never happened");
console.log(fail.length ? "FAIL: " + fail.join("; ") : "PASS");
process.exit(fail.length ? 1 : 0);
