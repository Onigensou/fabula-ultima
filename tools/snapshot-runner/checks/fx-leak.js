// fx-leak — does playing animations leave anything behind? Plays each workload several times and
// reads resource counters after every repeat. A counter that climbs on EVERY repeat after the
// first (the first fills one-time caches) is a leak. Written 2026-11-12 after an audit found five
// (sprite-shadow bakes, oni canvas textures, Soul Tithe fire textures, pose videos, HUD curtain).
//
//   node ../snapshot-runner/bin/build-snapshot.mjs --profile leak --snapshot snap-leak       # once (every actor)
//   node ../snapshot-runner/bin/run.mjs --snapshot snap-leak --port 30104 --canvas low --time-warp 20 \
//        --eval ../snapshot-runner/checks/fx-leak.js --dump ../snapshot-runner/results/fx-leak.json
//
// --canvas low (not off): textures only reach the GPU when something renders. A/B the code with
// --code <gitref>. Options: prepend `globalThis.__FX_LEAK_OPTS = {...};` in a wrapper file.
//   workloads  which to run (default all): anim, hud, battle, scene
//   reps       repeats per workload (default 4; the first is the warm-up)
//   casters    "party" (default), "enemies", "all" (half each), or a list of actor names
//   skills     animation skill names, looked up on the casters (default casters "all" when given;
//              default skills: ones whose script makes textures / particles / clips)
//   maxSkills  how many animations per repeat (default 4)
//   heapSites  attribute the live heap to allocation sites (V8 sampling profiler; default true)
// Returns { ok, leaks: [...], workloads: { name: { samples, verdict } } }.
const O = Object.assign({ workloads: ["anim", "hud", "battle", "scene"], reps: 4, skills: null, maxSkills: 4, heapSites: true }, globalThis.__FX_LEAK_OPTS ?? {});
const NS = "fabula-ultima-companion";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// real-time wait even under --time-warp (which divides every setTimeout delay by its factor)
const WARP = Number(globalThis.__timeWarp?.F ?? 1) || 1;
const realTimeout = globalThis.__timeWarp?.real?.st ?? setTimeout;
const settle = (ms) => new Promise((r) => realTimeout.call(globalThis, r, ms));

// ---- probes: pending timers / frames, live <video> elements --------------------------------
const P = globalThis.__fxLeakProbe ??= (() => {
  const to = new Map(), iv = new Set(), raf = new Set(), videos = new Set();
  const w = window;
  const sT = w.setTimeout, cT = w.clearTimeout, sI = w.setInterval, cI = w.clearInterval;
  const rA = w.requestAnimationFrame, cA = w.cancelAnimationFrame, cE = document.createElement;
  w.setTimeout = function (fn, ms, ...a) {
    if (typeof fn !== "function") return sT.call(w, fn, ms, ...a);
    let id; id = sT.call(w, (...x) => { to.delete(id); return fn(...x); }, ms, ...a); to.set(id, Number(ms) || 0); return id;
  };
  w.clearTimeout = function (id) { to.delete(id); return cT.call(w, id); };
  w.setInterval = function (fn, ms, ...a) { const id = sI.call(w, fn, ms, ...a); iv.add(id); return id; };
  w.clearInterval = function (id) { iv.delete(id); return cI.call(w, id); };
  w.requestAnimationFrame = function (fn) { let id; id = rA.call(w, (t) => { raf.delete(id); return fn(t); }); raf.add(id); return id; };
  w.cancelAnimationFrame = function (id) { raf.delete(id); return cA.call(w, id); };
  document.createElement = function (tag, ...a) {
    const el = cE.call(document, tag, ...a);
    if (String(tag).toLowerCase() === "video") videos.add(new WeakRef(el));
    return el;
  };
  // who made each canvas/video texture: Texture.from caches those under a pixiid_N key, and the key alone
  // names nothing
  const tf = PIXI.Texture.from;
  PIXI.Texture.from = function (src, ...a) {
    const t = tf.call(this, src, ...a);
    try {
      if (src && typeof src === "object" && t?.baseTexture && !t.baseTexture.__fxBy) {
        const lines = String(new Error().stack).split("\n").slice(2);
        const f = lines.find((l) => !/fx-leak|pixi/.test(l)) ?? lines[0] ?? "";
        t.baseTexture.__fxBy = f.replace(/^\s*at\s+/, "").replace(/https?:\/\/[^/]+\//, "").replace(/\?[^:)]*/, "").slice(0, 140);
      }
    } catch { /* probe only */ }
    return t;
  };
  // who made EVERY base texture (render textures, buffers, images too): the constructor always calls
  // _refreshPOT, so the first call is the creation
  const rp = PIXI.BaseTexture.prototype._refreshPOT;
  PIXI.BaseTexture.prototype._refreshPOT = function (...a) {
    if (!this.__fxBy) { try { this.__fxBy = creator(); } catch { this.__fxBy = "?"; } }
    return rp.apply(this, a);
  };
  return { to, iv, raf, videos };
})();
function creator() {
  const lines = String(new Error().stack).split("\n").slice(3)
    .filter((l) => !/fx-leak|pixi\.|\/pixi|<anonymous>:\d+:\d+\)$/.test(l));
  return lines.slice(0, 2).map((l) => l.replace(/^\s*at\s+/, "").replace(/https?:\/\/[^/]+\//, "").replace(/\?[^:)]*/, "").slice(0, 110)).join(" < ");
}
// GPU textures + DOM, by origin: what a workload added after its warm-up that is still there
function gpuSet() { return new Set(canvas.app?.renderer?.texture?.managedTextures ?? []); }
const CHAT = "#chat-log, #chat-popout, .chat-popout";
function chatNodes() { let n = 0; for (const el of document.querySelectorAll(CHAT)) n += el.getElementsByTagName("*").length; return n; }
function domCounts() {
  const c = {};
  for (const el of document.body.getElementsByTagName("*")) {
    if (el.closest(CHAT)) continue;
    const top = el.closest("[id]")?.id ?? "-";
    const k = `${top} > ${el.tagName.toLowerCase()}${el.classList[0] ? "." + el.classList[0] : ""}`;
    c[k] = (c[k] ?? 0) + 1;
  }
  return c;
}
function gpuGrowth(before) {
  const by = {};
  for (const bt of canvas.app?.renderer?.texture?.managedTextures ?? []) {
    if (before.has(bt)) continue;
    const kind = bt.resource ? (bt.resource.source?.tagName?.toLowerCase() ?? bt.resource.constructor?.name ?? "resource") : (bt.framebuffer ? "render-texture" : "no-resource");
    // drawn in the last ~2 s, or only waiting for texture GC (frees after ~1 min idle; render textures never)
    const gc = canvas.app.renderer.textureGC, live = gc ? gc.count - bt.touched < 120 : true;
    const k = `${live ? "drawn" : "idle"} ${kind} | ${bt.width}x${bt.height} | ${bt.__fxBy ?? "?"}`;
    by[k] = (by[k] ?? 0) + 1;
  }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${n}x ${k}`);
}
function domGrowth(before, reps) {
  const now = domCounts();
  return Object.entries(now).map(([k, n]) => [k, n - (before[k] ?? 0)]).filter(([, d]) => d >= reps)
    .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, d]) => `+${d} ${k}`);
}

const tickerCount = (t) => { let n = 0; for (let l = t?._head?.next; l; l = l.next) n++; return n; };
async function gcHeapMB() {
  // run.mjs exposes a CDP-backed GC; without it the heap figure is unforced (noisier)
  let used = null;
  if (typeof window.__runnerGC === "function") { await window.__runnerGC(); await sleep(0); used = await window.__runnerGC(); }
  else used = performance.memory?.usedJSHeapSize ?? null;
  return used == null ? null : +(used / 1048576).toFixed(1);
}
async function sample() {
  await settle(2500);          // let fades, ended handlers and short TTLs run out
  const heapMB = await gcHeapMB();
  const R = canvas.app?.renderer;
  let liveVideos = 0;
  for (const ref of [...P.videos]) {
    const v = ref.deref();
    if (!v) { P.videos.delete(ref); continue; }
    if (v.currentSrc || v.getAttribute("src")) liveVideos++;   // a video that still holds media
  }
  return {
    gpuTextures: R?.texture?.managedTextures?.length ?? null,
    framebuffers: R?.framebuffer?.managedFramebuffers?.length ?? null,
    cachedTextures: Object.keys(PIXI.utils.TextureCache).length,
    cachedBaseTextures: Object.keys(PIXI.utils.BaseTextureCache).length,
    liveVideos,
    pendingFrames: P.raf.size,
    shortTimeouts: [...P.to.values()].filter((ms) => ms <= 5000).length,
    intervals: P.iv.size,
    tickerListeners: tickerCount(canvas.app?.ticker) + (canvas.app?.ticker === PIXI.Ticker.shared ? 0 : tickerCount(PIXI.Ticker.shared)),
    hooks: Object.values(Hooks.events ?? {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : a?.size ?? 0), 0),
    hookEvents: Object.keys(Hooks.events ?? {}).length,
    mediaInDom: document.querySelectorAll("canvas, video, audio").length,
    // chat cards are content the table keeps on purpose (a battle posts a few), not a leak
    domNodes: document.getElementsByTagName("*").length - chatNodes(),
    stageChildren: (canvas.stage?.children?.length ?? 0) + (canvas.primary?.children?.length ?? 0),
    heapMB,
    // what this repeat added to PIXI's global caches (names the leaking asset)
    newCacheKeys: newKeys(),
  };
}
let _lastKeys = null, _nSamples = 0;
const _firstSeen = new Map();   // cache key -> sample index it first appeared in
const describeKey = (k) => {
  const bt = PIXI.utils.BaseTextureCache[k], el = bt?.resource?.source;
  const what = el?.tagName ? `${el.tagName.toLowerCase()}${el.currentSrc ? " " + el.currentSrc.replace(/^https?:\/\/[^/]+\//, "").slice(-60) : ""}` : "";
  return [k.replace(/^https?:\/\/[^/]+\//, "").slice(-90), what, bt?.__fxBy ?? ""].filter(Boolean).join(" | ");
};
function newKeys() {
  const now = new Set(Object.keys(PIXI.utils.BaseTextureCache));
  const added = _lastKeys ? [...now].filter((k) => !_lastKeys.has(k)) : [];
  _lastKeys = now; _nSamples++;
  for (const k of added) if (!_firstSeen.has(k)) _firstSeen.set(k, _nSamples);
  return added.slice(0, 12).map(describeKey);
}
// Cache entries made after a workload's warm-up that are STILL cached: each names a leaking asset and
// the line that made it. URL-keyed entries (Foundry's loadTexture) are one per file, so they are listed
// only when made by Texture.from of an element (pixiid_N), the per-use kind.
function survivors(sinceSample) {
  const out = [];
  for (const [k, n] of _firstSeen) if (n > sinceSample && k in PIXI.utils.BaseTextureCache && /^pixiid_/.test(k)) out.push(describeKey(k));
  const by = {};
  for (const d of out) { const key = d.split(" | ").slice(1).join(" | ").replace(/pixiid_\d+/, ""); by[key] = (by[key] ?? 0) + 1; }
  return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([what, n]) => `${n}x ${what}`);
}
// growth that counts as a leak, per repeat after the warm-up
const MIN = { hookEvents: 1, gpuTextures: 1, framebuffers: 1, cachedTextures: 1, cachedBaseTextures: 1, liveVideos: 1, pendingFrames: 1,
  shortTimeouts: 2, intervals: 1, tickerListeners: 1, hooks: 1, mediaInDom: 1, domNodes: 25, stageChildren: 1, heapMB: 2 };
function verdict(samples) {
  const out = {};
  const s = samples.slice(1);   // samples[0] = after the warm-up repeat
  if (s.length < 2) return out;
  for (const k of Object.keys(MIN)) {
    const v = s.map((x) => x[k]);
    if (v.some((x) => x == null)) continue;
    const rising = v.every((x, i) => i === 0 || x > v[i - 1]);
    const perRep = (v.at(-1) - v[0]) / (v.length - 1);
    if (rising && perRep >= MIN[k]) out[k] = { values: v, perRep: +perRep.toFixed(2) };
  }
  return out;
}

// ---- workloads ---------------------------------------------------------------------------
const party = ["Hina", "Keren", "Blanche", "Zarg"].map((n) => game.actors.getName(n)).filter(Boolean);
async function tokenFor(actor, x, y = 400) {
  const have = canvas.tokens.placeables.find((t) => t.actor?.id === actor.id);
  if (have) return have;
  const data = (await actor.getTokenDocument({ x, y })).toObject();
  const [doc] = await canvas.scene.createEmbeddedDocuments("Token", [data]);
  for (let i = 0; i < 40 && !doc.object; i++) await sleep(25);
  return doc.object;
}
const TEXTURE_SCRIPT = /oni\.(particles|radialTexture|gradientTexture|webmSprite|vfx|pxfx)|Texture\.from|RenderTexture/;
// Who casts: party members, enemies (any other actor with animation scripts), or both. Each animation is
// played against the other side: party casters hit the Hellhound, enemy casters hit a party member.
const isPartyActor = (a) => party.includes(a);
const isEnemyActor = (a) => !isPartyActor(a) && a.type !== "_template" && !a.flags?.[NS]?.isField && !/^_|\[SIM\]$/.test(a.name ?? "")
  && !/^(Test |Current|Global_Database|EXFURSION|Zenit)/.test(a.name ?? "");
// Spread over actors (one skill each first), and the most leak-prone scripts first: ones that build their
// own textures with PIXI.*.from, then oni clips/particles.
const RAW_TEXTURE = /\b(?:Texture|Sprite|BaseTexture)\.from\s*\(/;
function pickFrom(actors, n) {
  const all = [];
  for (const a of actors) for (const it of a.items) {
    const src = String(it.system?.props?.animation_script ?? "");
    if (!src.trim()) continue;
    if (O.skills ? O.skills.includes(it.name) : TEXTURE_SCRIPT.test(src)) all.push({ actor: a, item: it, enemy: !isPartyActor(a), raw: RAW_TEXTURE.test(src) });
  }
  if (O.skills) return all.slice(0, n);
  all.sort((x, y) => (y.raw - x.raw));
  const out = [], used = new Set();
  for (const c of all) if (out.length < n && !used.has(c.actor.id)) { out.push(c); used.add(c.actor.id); }
  for (const c of all) if (out.length < n && !out.includes(c)) out.push(c);
  return out;
}
function animSkills() {
  const named = Array.isArray(O.casters) ? O.casters.map((n) => game.actors.getName(n)).filter(Boolean) : null;
  if (named) return pickFrom(named, O.maxSkills);
  const mode = O.casters ?? (O.skills ? "all" : "party");
  const enemies = () => game.actors.filter(isEnemyActor);
  if (mode === "party") return pickFrom(party, O.maxSkills);
  if (mode === "enemies") return pickFrom(enemies(), O.maxSkills);
  if (O.skills) return pickFrom([...party, ...enemies()], O.maxSkills);
  const half = Math.ceil(O.maxSkills / 2);
  const p = pickFrom(party, half);
  return [...p, ...pickFrom(enemies(), O.maxSkills - p.length)];
}

const WORKLOADS = {
  async anim() {
    const anim = await import(`/modules/${NS}/scripts/battle-director/director-animation.js`);
    const picks = animSkills();
    if (!picks.length) return { skipped: `no ${O.casters ?? "party"} skill with a texture-making animation script` };
    const enemyTarget = await tokenFor(game.actors.getName("Hellhound") ?? game.actors.getName("Test Target Enemy"), 1300, 400);
    const partyTarget = await tokenFor(party[0] ?? game.actors.getName("Test Target Ally"), 1300, 800);
    const casters = new Map();
    let np = 0, ne = 0;
    for (const p of picks) {
      if (casters.has(p.actor.id)) continue;
      casters.set(p.actor.id, await tokenFor(p.actor, 300 + (p.enemy ? ne++ : np++) * 140, p.enemy ? 800 : 400));
    }
    return {
      label: picks.map((p) => `${p.actor.name}: ${p.item.name}`),
      async rep() {
        for (const p of picks) {
          const target = p.enemy ? partyTarget : enemyTarget;
          const r = await anim.playSkillAnimation({ skillUuid: p.item.uuid, casterTokenUuid: casters.get(p.actor.id).document.uuid, targetTokenUuids: [target.document.uuid] });
          await Promise.race([r?.endPromise, settle(40000)]);
        }
      },
    };
  },
  async hud() {
    const api = FUCompanion?.api?.hudCurtain;
    if (!api) return { skipped: "hudCurtain api not registered" };
    const during = [];
    return {
      during,
      async rep() {
        // the owner drives the level every frame, as the Nidhogg shows do
        const key = api.hide("fx-leak", { fade: 0 });
        const t0 = performance.now();
        await new Promise((res) => {
          const tick = () => { api.set(key, 0.5); if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(); };
          requestAnimationFrame(tick);
        });
        during.push({ pendingFrames: P.raf.size, shortTimeouts: [...P.to.values()].filter((ms) => ms <= 5000).length });
        api.show(key, { fade: 0 });
      },
    };
  },
  async battle() {
    const sim = FUCompanion.api.experimental?.sim;
    const enemy = game.actors.getName("Hellhound");
    if (!sim?.testSkill || !enemy) return { skipped: "sim runner or Hellhound missing" };
    if (game.paused) await game.togglePause(false, true);
    await enemy.update({ "system.props.max_hp": 4000, "system.props.current_hp": 4000 });
    return {
      async rep() {
        await sim.testSkill({ caster: "Blanche", skill: "Provoke", enemy: enemy.uuid, targets: "enemy", once: true,
          startingZp: 0, maxRounds: 1, expectedRounds: 1, pace: "fast", reactions: "apply" });
      },
    };
  },
  async scene() {
    return { async rep() { await canvas.draw(); } };
  },
};

// ---- run -----------------------------------------------------------------------------------
const result = { opts: O, warp: WARP, gcForced: typeof window.__runnerGC === "function", workloads: {}, leaks: [] };
for (const name of O.workloads) {
  const w = { samples: [] };
  result.workloads[name] = w;
  try {
    const wl = await WORKLOADS[name]();
    if (wl.skipped) { w.skipped = wl.skipped; continue; }
    if (wl.label) w.label = wl.label;
    let warmSample = null;
    for (let i = 0; i < O.reps; i++) {
      const t0 = Date.now();
      await wl.rep();
      w.samples.push({ rep: i + 1, ms: Date.now() - t0, ...(await sample()) });
      if (i === 0) {
        warmSample = _nSamples; w._gpu0 = gpuSet(); w._dom0 = domCounts();
        if (O.heapSites && typeof window.__runnerHeapSampling === "function") w._sampling = await window.__runnerHeapSampling("start");
      }
    }
    w.verdict = verdict(w.samples);
    w.kept = survivors(warmSample);   // per-use textures made after the warm-up and never freed
    if (w._gpu0) { w.gpuKept = gpuGrowth(w._gpu0); w.domKept = domGrowth(w._dom0, O.reps - 1); }
    delete w._gpu0; delete w._dom0;
    // where the heap that is still alive was allocated (V8 sampling profiler, after a GC)
    if (w._sampling) w.heapSites = await window.__runnerHeapSampling("stop");
    delete w._sampling;
    if (wl.during) {
      w.during = wl.during;
      // against the page's resting count (other loops keep a few frames pending all the time): the curtain itself
      // should add 1-2 (its frame + the test's driver), not one per frame held
      const rest = Math.min(...w.samples.map((s) => s.pendingFrames));
      const extra = wl.during.map((d) => d.pendingFrames - rest);
      if (Math.max(...extra) > 3) w.verdict.framesDuringHold = { values: extra, note: "frame callbacks pending while the HUD is held, above the resting count (expect 1-2)" };
    }
    // The heap is a SOFT signal: in the runner it also holds the fake server's database (every chat message and
    // document a battle writes lands in runner/fake-io.js), which a real client keeps on the server. It is
    // reported with its allocation sites (heapSites) but does not fail the check; the countable resources do.
    for (const k of Object.keys(w.verdict)) {
      const line = `${name}.${k} ${JSON.stringify(w.verdict[k].values)}`;
      if (k === "heapMB") (result.notes ??= []).push(line + " (soft: see heapSites)"); else result.leaks.push(line);
    }
    if (w.heapSites) w.heapSites = w.heapSites.map((l) => /runner\//.test(l) ? l + "   <- the runner's fake server, not the game" : l);
  } catch (e) { w.error = String(e?.stack ?? e).slice(0, 600); result.leaks.push(`${name}: threw (${String(e?.message ?? e).slice(0, 120)})`); }
}
result.ok = result.leaks.length === 0;
return result;
