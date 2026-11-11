/**
 * Texture sweep for animation scripts (2026-11-12).
 *
 * Animation scripts (world data, run by pseudoAnimation-listener) make textures with
 * PIXI.Texture.from(<canvas|video|img>) — a per-cast element that PIXI caches under a fresh id
 * for the whole session. Nothing ever freed them: the leak check (tools/snapshot-runner/checks/
 * fx-leak.js) measured ~4 videos + ~6 cached textures left behind per Glacies Finis cast, and 66
 * of 368 world scripts use the pattern.
 *
 * The script is handed a SCOPED PIXI: the same namespace, except Texture.from / Sprite.from /
 * BaseTexture.from note every base texture made from an ELEMENT (never a URL string: those are
 * Foundry's shared, cached files). After the script ends, each noted base that no display object
 * still shows is destroyed (a video is also stopped and emptied). One still on screen — a
 * lingering cosmetic tail — is re-checked every 2 s, for up to a minute, then left alone.
 *
 * A script that keeps state across casts (it writes a globalThis/window store, e.g. a texture
 * cache like __ZP_TEX, or the Rewind sprite maps) is NOT swept: a texture held for the next cast
 * but off screen right now would be destroyed under it. So is one that says `oni:keep-textures`.
 */

const READONLY_GLOBALS = new Set([
  "__TARGETS", "__PAYLOAD", "ONI", "AudioHelper", "_token", "token", "loadTexture", "loadTextureSafe",
  "FUCompanion", "Sequence", "Sequencer", "FU", "gsap", "VideoHelper", "__ONI_BATTLE_STAGE_3D__",
  "foundry", "game", "canvas", "ui", "PIXI", "CONFIG", "Hooks", "document", "setTimeout", "clearTimeout",
  "requestAnimationFrame", "cancelAnimationFrame", "performance", "console", "fromUuid", "getComputedStyle",
  "innerWidth", "innerHeight", "devicePixelRatio", "addEventListener", "removeEventListener",
]);

/** Whether a script's element textures may be swept after it ends (see the header). */
export function sweepAllowed(src) {
  const s = String(src ?? "");
  if (/oni:keep-textures/.test(s)) return false;
  if (/\b(?:globalThis|window)\s*\[/.test(s)) return false;
  for (const m of s.matchAll(/\b(?:globalThis|window)\.([\w$]+)/g)) if (!READONLY_GLOBALS.has(m[1])) return false;
  return true;
}

const isElement = (src) => !!src && typeof src === "object" && typeof src.tagName === "string";

/** A PIXI namespace for one script run that records element-made base textures into `made`. */
export function scopedPixi(P, made) {
  // only a base this call CREATED: an element PIXI already knew (_pixiId) belongs to someone else, e.g. a
  // token's own video, and must never be swept
  const fresh = (src) => isElement(src) && !src._pixiId;
  const note = (base, isNew) => { if (base && isNew) made.add(base); };
  const wrap = (C, fromFn) => new Proxy(C, {
    get(t, k, r) { return k === "from" ? fromFn(t) : Reflect.get(t, k, r); },
  });
  const ns = Object.create(P);
  Object.defineProperties(ns, {
    Texture: { value: wrap(P.Texture, (T) => function (src, ...a) { const n = fresh(src); const tex = T.from(src, ...a); note(tex?.baseTexture, n); return tex; }) },
    BaseTexture: { value: wrap(P.BaseTexture, (B) => function (src, ...a) { const n = fresh(src); const b = B.from(src, ...a); note(b, n); return b; }) },
    Sprite: { value: wrap(P.Sprite, (S) => function (src, ...a) { const n = fresh(src); const sp = S.from(src, ...a); note(sp?.texture?.baseTexture, n); return sp; }) },
  });
  return ns;
}

/** Every base texture something on the stage (or its masks / filter uniforms) still shows. */
export function basesInUse(root) {
  const used = new Set();
  const addTex = (t) => { const b = t?.baseTexture; if (b) used.add(b); };
  const seen = new Set();
  const walk = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    addTex(n._texture ?? n.texture);
    addTex(n.material?.texture);
    if (n.mask && typeof n.mask === "object") walk(n.mask);
    for (const f of n.filters ?? []) for (const v of Object.values(f?.uniforms ?? {})) if (v?.baseTexture) addTex(v);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return used;
}

function freeBase(b) {
  const el = b.resource?.source;
  try { if (el?.tagName === "VIDEO") { el.pause(); el.removeAttribute("src"); el.load(); } } catch { /* gone */ }
  try { b.destroy(); } catch { /* gone */ }
}

/**
 * Free what a finished run made, once nothing shows it. Returns a promise that settles when the
 * set is empty or the minute is up (tests await it; the listener does not).
 * opts: { root: () => display root, every: ms, tries, delay: (ms) => Promise }
 */
export async function sweepWhenUnused(made, { root, every = 2000, tries = 30, delay } = {}) {
  const sleep = delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let freed = 0;
  for (let i = 0; i < tries && made.size; i++) {
    await sleep(every);
    const used = basesInUse(root?.());
    for (const b of [...made]) {
      if (b.destroyed) { made.delete(b); continue; }
      if (used.has(b) || b.resource?.source?.isConnected) continue;   // still drawn, or a <video>/<canvas> in the page
      made.delete(b);
      freeBase(b);
      freed++;
    }
  }
  return { freed, left: made.size };
}
