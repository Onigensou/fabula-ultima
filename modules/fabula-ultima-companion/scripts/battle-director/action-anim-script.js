// ============================================================================
// Default action animations — script builder.
//
// Turns a plan from action-anim-rules.js into an ordinary animation_script, so
// the default runs through exactly the same path as an authored one: staging,
// the damage gate, Skip Animation, Chain cues, the true-end watch. Nothing in
// the director knows a default from a hand-written script except the spec's
// `source: "default"`.
//
// Shape (the house "shell" from tools/anim-studio/lib/dungeon-templates.js):
//   outer  — runs on the GM: broadcasts the inner via game.ONI.pseudo.play,
//            emits oni:animationStart when the inner signals ready (the offset
//            gate counts from here) and oni:animationEnd at the TRUE end.
//   inner  — runs on every client: steps a clone of the actor in, plays the MV
//            clip(s), cues oni.hit() on contact frames, steps back.
//
// The damage gate is "offset" mode with the plan's `impactAt`, so HP changes on
// the contact frame while the step back plays as a tail — the reaction window
// and the next turn wait for the true end, not the impact.
//
// The inner is written as a real function below (DEFAULT_INNER) so it is
// syntax-checked like any module code; its BODY text is what ships. Rules for
// that body: no backticks and no "${" (it is embedded in a String.raw template),
// no top-level returns of values (it runs inside an async IIFE).
// ============================================================================

import { MV_CLIPS, clipUrl, SFX, sfxUrl, TIMING } from "./action-anim-rules.js";

// Never called — its source text is the inner script. Free names (ctx, oni,
// canvas, PIXI, wait, Hooks) are the pseudo-animation listener's arguments.
/* eslint-disable no-undef */
async function DEFAULT_INNER() {
  const cfg = ctx.params.cfg || {};
  const T = cfg.T;
  const E = oni.EASE;
  const caster = ctx.casterToken;
  const tgts = (ctx.targetTokens || []).filter(function (t) { return t && t.center; });
  try { Hooks.callAll(ctx.params.readyHook); } catch (e) { /* the gate's failsafe covers it */ }

  // Mockup px (BD's 1682-wide stage) -> world px.
  const sceneW = (canvas.dimensions && canvas.dimensions.sceneWidth) || 1682;
  const s = sceneW / 1682;
  const CM = PIXI.ColorMatrixFilter || (PIXI.filters && PIXI.filters.ColorMatrixFilter);

  // ── the actor's stand-in: a clone that follows the real mesh (so an attack
  // pose or a size fix still shows) plus our step offset ─────────────────────
  let clone = null, restore = null, follow = null;
  const ofs = { x: 0, y: 0 };
  if (caster && caster.mesh) {
    clone = oni.cloneToken(caster);
    restore = oni.hideToken(caster);
    follow = function () {
      const m = caster.mesh;
      if (!m || !clone || clone.destroyed) return;
      if (clone.texture !== m.texture) clone.texture = m.texture;
      clone.anchor.copyFrom(m.anchor);
      clone.scale.copyFrom(m.scale);
      clone.angle = m.angle;
      clone.position.set(m.x + ofs.x, m.y + ofs.y);
    };
    follow();
    canvas.app.ticker.add(follow);
  }
  function finish() {
    if (follow) { try { canvas.app.ticker.remove(follow); } catch (e) {} }
    if (restore) restore();
    try { if (clone && !clone.destroyed) clone.destroy(); } catch (e) {}
  }
  const dirOf = function (t) {
    if (caster && t) return Math.sign(t.center.x - caster.center.x) || -1;
    return (caster && caster.document && caster.document.disposition === -1) ? 1 : -1;
  };
  const dir = dirOf(tgts[0]);
  function stepTo(x, ms, ease) {
    const from = ofs.x;
    return oni.tween({ from: 0, to: 1, duration: ms, ease: ease || E.inOutQuad, onUpdate: function (v) { ofs.x = from + (x - from) * v; } });
  }

  // Where a clip stands on a token: its body centre, or its ground point.
  function pointOn(t, pos) {
    if (t === caster && clone) {
      const cx = caster.mesh.x + ofs.x, cy = caster.center.y + ofs.y;
      return pos === "feet" ? { x: cx, y: caster.y + caster.h - 10 * s + ofs.y } : { x: cx, y: cy };
    }
    return pos === "feet" ? { x: t.center.x, y: t.y + t.h - 10 * s } : { x: t.center.x, y: t.center.y };
  }
  const handOf = function () { return { x: (caster ? caster.center.x : 0) + ofs.x + dir * 34 * s, y: (caster ? caster.center.y : 0) + ofs.y }; };

  function sfx(k) { const a = cfg.sfx[k]; if (a) oni.sfx(a.url, { volume: a.vol }); }
  function tintFilter(tint) {
    if (!tint || !CM) return null;
    const f = new CM();
    f.hue(tint.hue || 0, false);
    if (tint.sat != null && tint.sat !== 1) f.saturate(tint.sat - 1, true);
    if (tint.bright != null && tint.bright !== 1) f.brightness(tint.bright, true);
    return f;
  }
  // One MV clip on a token. Resolves when the clip is gone.
  async function clipOn(key, t, scale, tint) {
    const c = cfg.clips[key];
    if (!c || !t) return;
    const p = pointOn(t, c.pos);
    const r = await oni.vfx(c.url, { x: p.x, y: p.y, size: c.w * cfg.clipScale * (scale || 1) * s, zIndex: 95500 });
    if (!r || !r.sprite) return;
    r.sprite.anchor.set(c.ax, c.ay);
    r.sprite.position.set(p.x, p.y);
    const f = tintFilter(tint);
    if (f) r.sprite.filters = [f];
    await r.ended;
  }
  const firstFlash = function (key) { const c = cfg.clips[key]; return c ? (c.flashes[0] || 0) : 0; };
  const flashes = function (key) { const c = cfg.clips[key]; return c ? c.flashes : [0]; };

  // Hit one target list with a clip, staggered; cue oni.hit() on the first
  // target's contact frames. Returns { landed, all }.
  function strike(key, list, o) {
    o = o || {};
    const all = [];
    let land;
    const landed = new Promise(function (r) { land = r; });
    list.forEach(function (t, i) {
      all.push((async function () {
        await wait(i * T.staggerMs);
        const playing = clipOn(key, t, o.scale, o.tint);
        if (i === 0) {
          const fl = o.cueAll ? flashes(key) : [firstFlash(key)];
          let prev = 0;
          for (let k = 0; k < fl.length; k++) {
            await wait(Math.max(k === 0 ? 40 : 0, fl[k] - prev));
            prev = fl[k];
            if (o.cue !== false) oni.hit();
          }
          land();
        }
        await playing;
      })());
    });
    if (!list.length) land();
    return { landed: landed, all: Promise.all(all) };
  }
  function glow(ms) {
    if (!clone || !CM) return wait(ms);
    const f = new CM(); clone.filters = [f];
    return oni.tween({ from: 0, to: 1, duration: ms, ease: E.outQuad, onUpdate: function (v) { f.brightness(1 + 0.5 * Math.sin(v * Math.PI), false); } })
      .then(function () { clone.filters = null; });
  }

  try {
    if (cfg.mode === "attack") {
      const A = cfg.attack;
      // approach
      if (A.motion === "melee") await stepTo(dir * (A.quick ? 170 : 150) * s, A.quick ? T.quickStepMs : T.stepMs, E.outQuad);
      else await stepTo(-dir * 14 * s, T.readyMs, E.outQuad);

      // delivery
      if (A.motion === "melee") sfx("swing");
      if (A.motion === "arrow" || A.motion === "throw") {
        sfx(A.motion === "arrow" ? "bow" : "swing");
        stepTo(0, 200);
        const from = handOf();
        await Promise.all(tgts.map(async function (t, i) {
          await wait(i * 90);
          const g = new PIXI.Graphics();
          if (A.motion === "arrow") { g.lineStyle({ width: 4 * s, color: 0xffffff, alpha: 1, cap: "round" }); g.moveTo(-60 * s, 0); g.lineTo(30 * s, 0); }
          else { g.beginFill(0xe8eef4); g.drawStar ? g.drawStar(0, 0, 4, 17 * s, 6 * s) : g.drawCircle(0, 0, 9 * s); g.endFill(); }
          g.zIndex = 95400; canvas.stage.sortableChildren = true; canvas.stage.addChild(g);
          const to = t.center, ang = Math.atan2(to.y - from.y, to.x - from.x);
          await oni.tween({ from: 0, to: 1, duration: A.motion === "arrow" ? T.arrowMs : T.throwMs, ease: E.linear, onUpdate: function (v) {
            g.position.set(from.x + (to.x - from.x) * v, from.y + (to.y - from.y) * v);
            g.rotation = A.motion === "arrow" ? ang : v * 15;
          } });
          try { g.destroy(); } catch (e) {}
        }));
      }
      if (A.motion === "gun") {
        const hp = handOf();
        const flash = new PIXI.Sprite(oni.radialTexture("rgba(255,240,200,1)", "rgba(255,140,40,0)", { size: 128 }));
        flash.anchor.set(0.5); flash.blendMode = PIXI.BLEND_MODES.ADD;
        flash.position.set(hp.x, hp.y); flash.zIndex = 95400; canvas.stage.sortableChildren = true; canvas.stage.addChild(flash);
        sfx("gun");
        oni.tween({ from: 0, to: 1, duration: 160, ease: E.outQuad, onUpdate: function (v) { flash.alpha = 1 - v; flash.width = flash.height = 110 * s * (0.4 + v); } })
          .then(function () { try { flash.destroy(); } catch (e) {} });
        stepTo(-dir * 26 * s, 90).then(function () { return stepTo(0, 260); });
        await wait(T.gunLeadMs);
      }

      const pending = [];
      const strikes = Array.isArray(ctx.params.strikes) ? ctx.params.strikes : [];
      if (strikes.length > 1) {
        // Chain N: one strike per beat, each revealed by its own oni.hit()
        for (let j = 0; j < strikes.length; j++) {
          const outs = (strikes[j] && strikes[j].outcomes) || [];
          const struck = tgts.filter(function (t) {
            const o = outs.find(function (x) { return x && x.tokenUuid === t.document.uuid; });
            return !o || (o.kind !== "miss" && o.kind !== "lost");
          });
          const crit = outs.some(function (x) { return x && x.isCrit; });
          if (A.clip && struck.length) { sfx("hit"); sfx("element"); }
          else sfx("swing");
          const r = A.clip && struck.length ? strike(A.clip, struck, { scale: A.scale, tint: A.tint }) : null;
          if (r) { pending.push(r.all); await r.landed; } else { await wait(60); oni.hit(); }
          if (crit) { oni.screenshake({ duration: 300, intensity: 10 }); sfx("crit"); }
          if (j < strikes.length - 1) await wait(Math.max(0, T.chainBeatMs - (A.clip ? Math.max(40, firstFlash(A.clip)) : 60)));
        }
      } else if (A.clip) {
        sfx("hit"); sfx("element");
        const r = strike(A.clip, tgts, { scale: A.scale, tint: A.tint, cueAll: false });
        pending.push(r.all);
        // a multi-hit crit clip lands on its last contact frame
        if (A.crit) {
          const fl = flashes(A.clip);
          await wait(Math.max(40, fl[fl.length - 1]));
          oni.screenshake({ duration: 320, intensity: 12 });
          sfx("crit");
        } else {
          await r.landed;
          if (A.shake) oni.screenshake({ duration: 220, intensity: 6 });
        }
      } else {
        await wait(60);   // a miss: the swing is the whole beat (BD shows the miss)
        oni.hit();
      }
      await Promise.all(pending);
      await wait(T.tailMs);
      if (A.motion === "melee") await stepTo(0, T.returnMs, E.inOutQuad);
      else await wait(200);
    } else {
      // ── skills: the fallback composer's beats ───────────────────────────
      const B = cfg.beats || [];
      const lead = cfg.attackLike ? 150 : 120;
      await stepTo(dir * lead * s, cfg.attackLike ? T.stepMs : T.slideMs, E.outQuad);
      if (!cfg.attackLike) await glow(T.castMs);
      const pending = [];
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        const list = b.to === "self" ? (caster ? [caster] : []) : tgts;
        if (b.k === "damage") {
          if (cfg.attackLike) sfx("swing");
          if (!b.clip) { await wait(60); oni.hit(); continue; }
          sfx(b.sfx); if (b.elementSfx) sfx(b.elementSfx);
          const r = strike(b.clip, list, { scale: 0.9, tint: b.tint });
          pending.push(r.all);
          await r.landed;
          if (b.crit) { oni.screenshake({ duration: 320, intensity: 12 }); sfx("crit"); }
          if (i < B.length - 1) await wait(T.beatGapMs);
        } else {
          sfx(b.sfx);
          const r = strike(b.clip, list, { scale: 0.9, cue: false });
          pending.push(r.all);
          await wait(Math.max(200, firstFlash(b.clip)));
          if (i < B.length - 1) await wait(T.beatGapMs);
        }
      }
      await Promise.all(pending);
      await wait(T.tailMs);
      await stepTo(0, T.returnMs, E.inOutQuad);
    }
  } catch (e) {
    console.warn("[ONI][DefaultAnim] inner threw", e);
  } finally {
    finish();
    try { Hooks.callAll(ctx.params.doneHook); } catch (e) {}
  }
}
/* eslint-enable no-undef */

// The shipped body text of DEFAULT_INNER.
export function innerBody() {
  const src = DEFAULT_INNER.toString();
  return src.slice(src.indexOf("{") + 1, src.lastIndexOf("}")).trim();
}

// Sounds the plan names → { key: { url, vol } } (resolved now, so the script
// carries full URLs — the director's staging preloads every URL it names).
function sfxTable(keys) {
  const out = {};
  for (const [slot, key] of Object.entries(keys)) {
    if (!key || !SFX[key]) continue;
    out[slot] = { url: sfxUrl(key), vol: SFX[key].vol };
  }
  return out;
}
function clipTable(keys) {
  const out = {};
  for (const k of keys) {
    const c = MV_CLIPS[k];
    if (!c) continue;
    out[k] = { url: clipUrl(k), w: c.w, h: c.h, ax: c.ax, ay: c.ay, pos: c.pos, flashes: c.flashes.slice() };
  }
  return out;
}

// The mockup drew clips at 0.85 of native size on the 1682 stage.
export const CLIP_SCALE = 0.85;

// plan (attack): { mode:"attack", key, attack: pickAttack(...) }
// plan (beats):  { mode:"beats",  key, beats: resolveBeats(...), attackLike }
// → the full animation_script text.
export function buildDefaultScript(plan) {
  const cfg = { mode: plan.mode, T: TIMING, clipScale: CLIP_SCALE, totalTimeoutMs: 15000 };
  if (plan.mode === "attack") {
    const a = plan.attack;
    cfg.attack = { motion: a.motion, quick: a.quick, clip: a.clip, tint: a.tint, scale: a.scale, shake: a.shake, crit: a.outcome === "crit" && a.source !== "preset" };
    cfg.clips = clipTable(a.clip ? [a.clip] : []);
    cfg.sfx = sfxTable({ swing: a.motion === "melee" || a.motion === "throw" ? "swing" : null, bow: a.motion === "arrow" ? "bow" : null,
      gun: a.motion === "gun" ? "gun" : null, hit: a.sfx.hit, element: a.sfx.element, crit: "crit" });
  } else {
    const beats = plan.beats.map((b) => ({ k: b.k, to: b.to, clip: b.clip, tint: b.tint ?? null, sfx: b.sfx ?? null, elementSfx: b.elementSfx ?? null, crit: !!b.crit }));
    cfg.beats = beats;
    cfg.attackLike = !!plan.attackLike;
    cfg.clips = clipTable(beats.map((b) => b.clip).filter(Boolean));
    const keys = { swing: "swing", crit: "crit" };
    for (const b of beats) { if (b.sfx) keys[b.sfx] = b.sfx; if (b.elementSfx) keys[b.elementSfx] = b.elementSfx; }
    cfg.sfx = sfxTable(keys);
  }
  const key = "oni.default." + (plan.key || plan.mode);
  const j = (v) => JSON.stringify(v);
  return [
    "// Default action animation — generated by battle-director/action-anim-script.js",
    "// (" + (plan.label || plan.key || plan.mode) + "). Author an animation_script on the item to replace it.",
    "(async () => {",
    "const CFG = " + j(cfg) + ";",
    "const ANIM_KEY = " + j(key) + ";",
    "const P = globalThis.__PAYLOAD ?? payload ?? {};",
    "function tokFromUuid(u) { try { const d = fromUuidSync?.(u); return d?.object ?? null; } catch (_) { return null; } }",
    "let sourceToken = null;",
    "for (const c of [P?.casterTokenUuid, P?.sourceTokenUuid]) { sourceToken = tokFromUuid(c); if (sourceToken) break; }",
    "const tg = (Array.isArray(targets) ? targets : []).filter((t) => t?.document);",
    "const doneHook = 'oni.anim.' + ANIM_KEY + '.' + (foundry?.utils?.randomID?.(8) ?? String(Date.now()));",
    "const readyHook = doneHook + '.ready';",
    "function onceHook(name, ms) { return new Promise((resolve) => { let s = false; const timer = setTimeout(() => { if (s) return; s = true; Hooks.off(name, h); resolve({ ok: false, timeout: true }); }, ms); const h = (d) => { if (s) return; s = true; clearTimeout(timer); Hooks.off(name, h); resolve(d ?? { ok: true }); }; Hooks.on(name, h); }); }",
    "const emit = (n, d) => { try { Hooks.callAll(n, d); } catch (_) {} };",
    "const scriptSource = String.raw`",
    innerBody(),
    "`;",
    "try {",
    "  const waitReady = onceHook(readyHook, 8000);",
    "  const waitDone = onceHook(doneHook, CFG.totalTimeoutMs);",
    "  await game.ONI.pseudo.play({ scriptId: ANIM_KEY, scriptSource, casterTokenUuid: sourceToken?.document?.uuid ?? null,",
    "    targetTokenUuids: tg.map((t) => t.document.uuid),",
    "    params: { doneHook, readyHook, cfg: CFG, strikes: Array.isArray(P?.strikes) ? P.strikes : [] }, meta: { source: ANIM_KEY } });",
    "  await waitReady;",
    "  emit('oni:animationStart', { type: ANIM_KEY, sceneId: canvas.scene?.id ?? null, sourceTokenId: sourceToken?.id ?? null });",
    "  const r = await waitDone;",
    "  if (!r?.ok) console.warn('[ONI][DefaultAnim]', ANIM_KEY, 'timed out');",
    "} catch (err) {",
    "  console.error('[ONI][DefaultAnim] crashed', err);",
    "} finally {",
    "  emit('oni:animationEnd', { type: ANIM_KEY, timestamp: Date.now(), sourceTokenId: sourceToken?.id ?? null });",
    "}",
    "})();",
  ].join("\n");
}
