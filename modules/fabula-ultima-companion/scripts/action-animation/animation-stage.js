// ============================================================================
// Animation staging — get an animation's assets READY TO DRAW on every client
// before it starts, so its heavy frames don't pay for them.
//
// "Loaded" (what the combat-start preload in animation-asset-cache.js gives) is
// not "ready to draw". On first use a texture still has to be uploaded to the
// GPU, and a webm still has to (re)start its decoder: Chrome suspends the
// decoder of a video left paused for a while. All of it lands on the frame the
// effect first shows, which is the hitch. Hiding things does not pre-pay it:
// PIXI skips anything invisible or at alpha 0, so nothing uploads until it shows.
//
// Staging does that work ahead, while nothing is moving:
//   - every image / webm the script names is loaded and uploaded to the GPU
//     (bound once); a paused shared webm is re-seeked to wake its decoder;
//   - one independent, already-uploaded copy of each webm is parked in a pool,
//     which oni.vfx() plays (a fresh <video> per effect, minus the cold start);
//   - Sequencer's own file cache is filled when the script uses Sequencer.
//
// The director stages an action when its card goes up (CONFIRM) and waits for
// every client's ack before the script runs (ANIMATION), capped so a slow
// client never stalls the battle. See director-animation.js.
//
// Also here: a per-client frame meter around every animation run.
//   FUCompanion.api.animStage.perf()  → the last runs (worst frame, long tasks)
// ============================================================================

const NS = "fabula-ultima-companion";
const SOCKET = `module.${NS}`;
const TAG = "[ONI][AnimStage]";
const MSG_STAGE = "oni.animStage.stage";
const MSG_ACK = "oni.animStage.ack";

export const STAGE_CFG = {
  // off = animations play cold, as before staging existed (a kill switch, and
  // the baseline for measuring what staging buys)
  enabled: true,
  // longest the director holds an animation for a client that has not acked
  waitCapMs: 900,
  // a single asset that is not ready by then is left to load on first use
  assetTimeoutMs: 4000,
  // a pooled copy unused this long is released (it holds a decoder)
  poolTtlMs: 45000,
  maxUrls: 40,
};

const isVideo = (u) => /\.(webm|mp4|m4v|ogv)(?:\?|#|$)/i.test(u);
const isImage = (u) => /\.(png|jpe?g|webp|gif|avif|svg)(?:\?|#|$)/i.test(u);
const isAudio = (u) => /\.(ogg|mp3|wav|m4a|flac|opus)(?:\?|#|$)/i.test(u);
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
const onceEvent = (el, ev, ms) => new Promise((r) => {
  const done = () => { clearTimeout(t); el.removeEventListener(ev, done); r(); };
  const t = setTimeout(done, ms);
  el.addEventListener(ev, done);
});

// ============================================================================
// Local warm-up
// ============================================================================
// Binding a texture uploads it, which is all PIXI's own prepare plugin does per
// texture. Bind directly: under Foundry, renderer.prepare.upload() was measured
// (2026-10-23) to leave the textures un-uploaded after its 2 s wait.
function upload(baseTexture) {
  const r = globalThis.canvas?.app?.renderer;
  if (!r?.texture?.bind || !baseTexture?.valid || baseTexture._glTextures?.[r.CONTEXT_UID]) return;
  try { r.texture.bind(baseTexture); } catch (e) { console.warn(TAG, "upload failed", e); }
}

const videoOf = (tex) => {
  const v = tex?.baseTexture?.resource?.source;
  return v?.tagName === "VIDEO" ? v : null;
};

async function warmShared(url) {
  const tex = await withTimeout(loadTexture(url), STAGE_CFG.assetTimeoutMs);
  if (!tex?.baseTexture) return false;
  const v = videoOf(tex);
  if (v) {
    if (v.readyState < 2) await onceEvent(v, "loadeddata", STAGE_CFG.assetTimeoutMs);
    // seeking a paused video to where it already is decodes that frame again,
    // which brings a suspended decoder back without moving anything on screen
    if (v.paused && v.readyState >= 1) {
      try { v.currentTime = v.currentTime; await onceEvent(v, "seeked", 1000); } catch { /* not seekable */ }
    }
  }
  await upload(tex.baseTexture);
  return true;
}

// ── pool of independent, ready webm copies (oni.vfx) ──
const pool = new Map();   // url -> [{ texture, video, at }]

function releaseCopy(c) {
  try { c.video.pause(); c.video.removeAttribute("src"); c.video.load(); } catch { /* gone */ }
  try { c.texture.destroy(true); } catch { /* gone */ }
}

async function makeCopy(url) {
  const tex = await withTimeout(loadTexture(url), STAGE_CFG.assetTimeoutMs);
  const src = videoOf(tex);
  if (!src || !game.video?.cloneTexture) return null;
  const texture = await withTimeout(game.video.cloneTexture(src), STAGE_CFG.assetTimeoutMs);
  const video = videoOf(texture);
  if (!video) return null;
  video.muted = true; video.loop = false;
  if (video.readyState < 2) await onceEvent(video, "loadeddata", STAGE_CFG.assetTimeoutMs);
  await upload(texture.baseTexture);
  return { texture, video, at: Date.now() };
}

async function fillPool(url) {
  const list = pool.get(url) ?? [];
  if (list.length) { for (const c of list) c.at = Date.now(); return; }
  const c = await makeCopy(url);
  if (!c) return;
  const now = pool.get(url) ?? [];
  now.push(c);
  pool.set(url, now);
}

/**
 * An independent copy of a webm, ready to play from frame 0: the staged one if
 * there is one, else made now (the cold path, as costly as before staging).
 * The caller owns it and gives it back with releaseVideo().
 */
export async function takeVideo(url) {
  const list = pool.get(url);
  const c = list?.shift();
  if (list && !list.length) pool.delete(url);
  if (c) { stats.poolHits++; return c; }
  stats.poolMisses++;
  return makeCopy(url);
}
export const releaseVideo = releaseCopy;

setInterval(() => {
  const cut = Date.now() - STAGE_CFG.poolTtlMs;
  for (const [url, list] of pool) {
    const keep = list.filter((c) => (c.at > cut ? true : (releaseCopy(c), false)));
    if (keep.length) pool.set(url, keep); else pool.delete(url);
  }
}, 15000);

const stats = { staged: 0, poolHits: 0, poolMisses: 0 };

/**
 * Make these assets ready to draw on THIS client.
 * @param {string[]} urls
 * @param {object} [o]
 * @param {boolean} [o.sequencer]  also fill Sequencer's file cache (the script uses Sequencer)
 * @param {boolean} [o.copies]     park a ready independent copy of each webm for oni.vfx()
 */
export async function stageLocal(urls = [], { sequencer = false, copies = true } = {}) {
  const t0 = performance.now();
  const list = [...new Set((urls ?? []).filter((u) => typeof u === "string" && u))].slice(0, STAGE_CFG.maxUrls);
  if (!list.length || !globalThis.canvas?.ready) return { ok: true, n: 0, ms: 0 };
  const visual = list.filter((u) => isVideo(u) || isImage(u));
  const jobs = visual.map((u) => warmShared(u).catch(() => false));
  if (copies) for (const u of visual.filter(isVideo)) jobs.push(fillPool(u).catch(() => {}));
  const cache = globalThis.FUCompanion?.api?.animationCache;
  for (const u of list.filter(isAudio)) if (cache?.preloadAudio) jobs.push(cache.preloadAudio(u).catch(() => {}));
  if (sequencer && globalThis.Sequencer?.Preloader?.preload) {
    const files = visual.filter(isVideo);
    if (files.length) jobs.push(Promise.resolve(Sequencer.Preloader.preload(files, false)).catch(() => {}));
  }
  await Promise.all(jobs);
  stats.staged++;
  return { ok: true, n: list.length, ms: Math.round(performance.now() - t0) };
}

// ============================================================================
// Every client: GM asks, each client warms its own copy and acks
// ============================================================================
const pending = new Map();   // key -> { expect:Set, acks:Map, resolve, localDone }

function settleIfDone(key) {
  const p = pending.get(key);
  if (!p || !p.localDone) return;
  for (const id of p.expect) if (!p.acks.has(id)) return;
  pending.delete(key);
  p.resolve({ acked: [...p.acks.keys()], missing: [], local: p.local, clients: Object.fromEntries(p.acks) });
}

/**
 * Stage on every connected client. Resolves once all of them have acked —
 * callers cap the wait (see waitStaged); it never rejects.
 */
export function stageAcrossClients(urls = [], { sequencer = false } = {}) {
  const key = `${game.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const expect = new Set(game.users.filter((u) => u.active && u.id !== game.userId).map((u) => u.id));
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const entry = { expect, acks: new Map(), resolve, localDone: false, local: null };
  pending.set(key, entry);
  try { if (expect.size) game.socket.emit(SOCKET, { type: MSG_STAGE, key, urls, sequencer, senderUserId: game.userId }); }
  catch (e) { console.warn(TAG, "stage broadcast failed", e); }
  stageLocal(urls, { sequencer }).catch(() => null).then((r) => { entry.local = r; entry.localDone = true; settleIfDone(key); });
  // forget it eventually; whoever waited has long since moved on
  setTimeout(() => pending.delete(key), 30000);
  promise.key = key;
  return promise;
}

async function onStageMessage(msg) {
  if (msg?.type === MSG_ACK) {
    const p = pending.get(msg.key);
    if (p) { p.acks.set(msg.senderUserId, msg.ms ?? null); settleIfDone(msg.key); }
    return;
  }
  if (msg?.type !== MSG_STAGE) return;
  if (!game.users.get(msg.senderUserId)?.isGM) return;
  let ms = null;
  // a hidden tab plays no VFX at all (vfxSuppressed), so there is nothing to warm
  if (!globalThis.FUCompanion?.api?.vfxSuppressed?.()) {
    const r = await stageLocal(msg.urls ?? [], { sequencer: !!msg.sequencer }).catch(() => null);
    ms = r?.ms ?? null;
  }
  try { game.socket.emit(SOCKET, { type: MSG_ACK, key: msg.key, senderUserId: game.userId, ms }); } catch { /* GM moves on at the cap */ }
}

// ============================================================================
// Script-level entry points (director-animation.js)
// ============================================================================
const urlCache = new Map();   // script text -> urls

export function scriptAssetUrls(script) {
  const s = String(script ?? "");
  if (!s) return [];
  if (!urlCache.has(s)) {
    const extract = globalThis.FUCompanion?.api?.animationCache?.extractAssetUrlsFromText;
    urlCache.set(s, typeof extract === "function" ? extract(s) : []);
    if (urlCache.size > 300) urlCache.delete(urlCache.keys().next().value);
  }
  return urlCache.get(s);
}

/** Stage everything an animation script names, on every client. null = nothing to stage. */
export function stageScript(script) {
  if (!STAGE_CFG.enabled) return null;
  const urls = scriptAssetUrls(script);
  if (!urls.length) return null;
  return stageAcrossClients(urls, { sequencer: /\bnew\s+Sequence\s*\(/.test(script) });
}

/** Wait for a staging job, at most STAGE_CFG.waitCapMs. Returns its result, or { timedOut }. */
export async function waitStaged(job, capMs = STAGE_CFG.waitCapMs) {
  if (!job) return null;
  const t0 = performance.now();
  const r = await withTimeout(job, capMs);
  return r ?? { timedOut: true, waitedMs: Math.round(performance.now() - t0) };
}

// ============================================================================
// Frame meter
// ============================================================================
const runs = [];

/**
 * Start measuring frames; stop() records the run. Reads requestAnimationFrame
 * gaps (what the eye sees) and long tasks (main-thread work over 50 ms).
 */
export function frameMeter(label) {
  const ts = [], tasks = [];
  let on = true, po = null;
  const t0 = performance.now();
  try {
    po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push({ at: Math.round(e.startTime - t0), ms: Math.round(e.duration) }); });
    po.observe({ type: "longtask" });
  } catch { po = null; }
  const step = (t) => { if (!on) return; ts.push(t); requestAnimationFrame(step); };
  requestAnimationFrame(step);
  // a run that never ends must not keep the meter going
  const cap = setTimeout(() => meter.stop({ capped: true }), 60000);
  const meter = {
    stop(extra = {}) {
      if (!on) return null;
      on = false;
      clearTimeout(cap);
      try { po?.disconnect(); } catch { /* fine */ }
      const gaps = ts.slice(1).map((t, i) => ({ at: Math.round(ts[i] - t0), d: t - ts[i] }));
      const sorted = gaps.map((g) => g.d).sort((a, b) => a - b);
      const base = sorted[Math.floor(sorted.length * 0.1)] || 1000 / 60;
      const worst = gaps.reduce((w, g) => (g.d > (w?.d ?? 0) ? g : w), null);
      const r = {
        label, at: new Date().toISOString(), ms: Math.round(performance.now() - t0),
        frames: gaps.length, hz: Math.round(1000 / base),
        worstMs: Math.round(worst?.d ?? 0), worstAtMs: worst?.at ?? null,
        late: gaps.filter((g) => g.d > base * 2).length,
        p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        longTasks: tasks,
        ...extra,
      };
      runs.push(r);
      if (runs.length > 40) runs.shift();
      console.debug(TAG, "frames", r);
      return r;
    },
  };
  return meter;
}

// ============================================================================
// Boot
// ============================================================================
Hooks.once("ready", () => {
  game.socket.on(SOCKET, (msg) => { onStageMessage(msg).catch((e) => console.warn(TAG, "stage message failed", e)); });
  globalThis.FUCompanion ??= {};
  globalThis.FUCompanion.api ??= {};
  globalThis.FUCompanion.api.animStage = {
    config: STAGE_CFG,
    stageLocal, stageAcrossClients, stageScript, waitStaged, scriptAssetUrls,
    takeVideo, releaseVideo,
    perf: () => runs.slice(),
    stats: () => ({ ...stats, pooled: [...pool].map(([u, l]) => ({ url: u, n: l.length })) }),
  };
});
