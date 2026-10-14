// @desc King Gorger — Element Gorge (drain cinematic): small motes of energy
// flow into the bitten target, which lights up in the gorged element's colour
// as an orb of that energy grows over it; the flow stops, and half a second
// later the orb races to King Gorger (accelerating, < 2 s), who flashes once as
// it lands — the gate fires there, so the +MP lands on the flash.
//
// Lives on the Element Gorge skill itself with timing option "resolve": the
// FSM plays a skill's own script BEFORE the hit resolves, but the
// element is only chosen in RESOLVE (eg_shift's ae_name_pool draw) — so "resolve" makes the FSM skip it and the chain
// eg_shift → eg_anim (play_animation, action_ref "Element Gorge") → eg_feed plays it; by the time
// this runs the target already carries the fresh "Element Gorge (X)" AE and the
// OUTER script reads the element off it.
"use strict";
(async () => {
  const CFG = {
    flowMs: 1100,          // motes stream in; target brightens; orb grows
    moteEveryMs: 70,       // spawn cadence during the flow
    moteMs: 460,           // one mote's travel into the target
    moteSize: 0.16,        // x token size
    moteSpread: [1.1, 1.9],// spawn radius, x token size
    orbSize: 1.25,         // orb diameter at full growth, x token size
    brightMax: 0.85,       // coloured silhouette alpha at the peak
    holdMs: 500,           // flow stops; orb hovers; target's colour fades
    travelMs: 1100,        // orb → King Gorger (accelerates over the first 40%)
    accelFrac: 0.4,
    trailEveryMs: 60,      // ghost copies left along the path (sparser + dimmer: the
    trailMs: 380,          // 45 ms / 55 % version strobed — user feedback 2026-09-22)
    trailAlpha: 0.22,
    travelHaloAlpha: 0.75, // the orb's additive halo while moving (1 = as at rest)
    gateAt: 0.93,          // fireDone this far along the travel: the +MP actor write's
                           // sync stutter then overlaps the last travel frames, not the flash
    landMs: 160,           // orb pop on arrival
    flashMs: 500,          // King Gorger's single flash — the engine's heal/hurt idiom:
    flashHold: 0.25,       // fraction of flashMs held at the peak before easing back
    flashPeak: 3.6,        // the SPRITE itself at brightness x3.6 easing back to 1 (not a
                           // white silhouette / glow over it)
    sfxFlow: { name: "AbsorbElement", volume: 0.5, rate: 0.95, fadeAfter: 1200, fadeMs: 350 },
    sfxLand: null,         // none: the engine's own MP-gain cue plays when eg_feed lands
    fallbackColor: "#ffffff",
    palette: { fire: "#e8603c", ice: "#6fb7e8", earth: "#c19a6b", bolt: "#e8c93c", air: "#5fd3c6" },
  };

  const NS = "fabula-ultima-companion";
  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);
  const sourceTokenId = String(casterUuid ?? "").split(".Token.").pop() || null;

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  // ── which element did the bite gorge? the NEWEST "Element Gorge (X)" AE on the
  //    target that this caster applied (a repeat bite adds a different element) ──
  let elem = null;
  try {
    const casterDoc = casterUuid ? await fromUuid(casterUuid) : null;
    const casterActorUuid = casterDoc?.actor?.uuid ?? null;
    const targetDoc = targetUuids[0] ? await fromUuid(targetUuids[0]) : null;
    let best = null;
    for (const e of targetDoc?.actor?.effects ?? []) {
      const f = e.flags?.[NS] ?? {};
      if (!f.elementGorge) continue;
      const by = f.directorAppliedBy?.reactorActorUuid ?? null;
      if (casterActorUuid && by && by !== casterActorUuid) continue;
      const t = Number(e._stats?.createdTime ?? 0);
      if (!best || t >= best.t) best = { t, elem: String(f.elementGorge).toLowerCase() };
    }
    elem = best?.elem ?? null;
  } catch (e) { console.warn("[KG Gorge anim] target AE read threw", e); }
  if (!elem) { const ks = Object.keys(CFG.palette); elem = ks[Math.floor(Math.random() * ks.length)]; }
  const color = CFG.palette[elem] ?? CFG.fallbackColor;

  Hooks.callAll("oni:animationStart", { local: true, world: false, sourceTokenId });

  // INNER (every client) — oni helper library; no backticks allowed in here.
  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const color = ctx.params.color;
    const caster = oni.caster;
    const target = oni.targets[0] || null;
    if (!caster || !target) { oni.fireDone(); return; }
    const col = foundry.utils.Color.from(color);
    const tokenSize = Math.max(target.w || 100, target.h || 100);
    const kgSize = Math.max(caster.w || 100, caster.h || 100);
    const tx = target.center.x, ty = target.center.y;
    const kx = caster.center.x, ky = caster.center.y;
    const layer = oni.layer({ zIndex: 94000 });

    const cue = (c) => { if (c && c.name) oni.sfx(c.name, { volume: c.volume, rate: c.rate, fadeAfter: c.fadeAfter, fadeMs: c.fadeMs }); };
    for (const c of [cfg.sfxFlow, cfg.sfxLand]) { try { const u = c && c.name && oni.sfxUrl(c.name); if (u) { const a = new Audio(); a.preload = 'auto'; a.src = u; } } catch (e) {} }

    const radial = (size) => new PIXI.Sprite(oni.radialTexture(color, 'rgba(0,0,0,0)', { size: size }));
    const mkSprite = (size, blend, alpha) => {
      const s = radial(256); s.anchor.set(0.5); s.blendMode = blend; s.width = s.height = size; s.alpha = alpha; layer.addChild(s); return s;
    };

    // ── target: coloured silhouette ("turns bright with the colour") + the orb ──
    const bright = oni.cloneToken(target, { parent: layer });
    if (bright) {
      const cm = new PIXI.ColorMatrixFilter();
      cm.matrix = [0,0,0,0,col.r,  0,0,0,0,col.g,  0,0,0,0,col.b,  0,0,0,1,0];
      bright.filters = [cm];
      bright.alpha = 0;
    }
    const orb = mkSprite(1, PIXI.BLEND_MODES.ADD, 0);
    orb.position.set(tx, ty);
    const orbCore = mkSprite(1, PIXI.BLEND_MODES.NORMAL, 0);
    orbCore.position.set(tx, ty);
    const setOrb = (d, a) => { orb.width = orb.height = d; orb.alpha = a; orbCore.width = orbCore.height = d * 0.45; orbCore.alpha = a * 0.9; };

    // ── motes: spawn around the target, fall into it ──
    const motes = [];
    let spawning = true;
    const spawnMote = () => {
      const ang = Math.random() * Math.PI * 2;
      const r = tokenSize * (cfg.moteSpread[0] + Math.random() * (cfg.moteSpread[1] - cfg.moteSpread[0]));
      const m = mkSprite(tokenSize * cfg.moteSize * (0.7 + Math.random() * 0.6), PIXI.BLEND_MODES.ADD, 0);
      const x0 = tx + Math.cos(ang) * r, y0 = ty + Math.sin(ang) * r;
      m.position.set(x0, y0);
      const size0 = m.width;
      motes.push(m);
      oni.tween({
        from: 0, to: 1, duration: cfg.moteMs, ease: oni.EASE.inQuad,
        onUpdate: (v) => {
          m.position.set(x0 + (tx - x0) * v, y0 + (ty - y0) * v);
          m.alpha = v < 0.15 ? v / 0.15 : 1 - Math.max(0, v - 0.75) / 0.25;
          m.width = m.height = size0 * (1 - 0.6 * v);
        },
        onComplete: () => { try { m.destroy(); } catch (e) {} },
      });
    };
    const spawner = (async () => { while (spawning) { spawnMote(); await oni.wait(cfg.moteEveryMs); } })();

    cue(cfg.sfxFlow);

    // ── FLOW: silhouette brightens, orb grows ──
    await oni.tween({
      from: 0, to: 1, duration: cfg.flowMs, ease: oni.EASE.outQuad,
      onUpdate: (v) => {
        if (bright) bright.alpha = cfg.brightMax * v;
        setOrb(tokenSize * cfg.orbSize * (0.15 + 0.85 * v), Math.min(1, v * 1.5));
      },
    });
    spawning = false;
    await spawner;

    // ── HOLD: flow has stopped; the orb hovers, the target's colour drains away ──
    await oni.tween({
      from: 0, to: 1, duration: cfg.holdMs, ease: oni.EASE.linear,
      onUpdate: (v) => {
        if (bright) bright.alpha = cfg.brightMax * (1 - v);
        const pulse = 1 + 0.06 * Math.sin(v * Math.PI * 4);
        setOrb(tokenSize * cfg.orbSize * pulse, 1);
      },
    });
    if (bright) { try { bright.destroy(); } catch (e) {} }

    // ── TRAVEL: accelerate over the first accelFrac of the path, then hold max speed ──
    const a = cfg.accelFrac, k = 1 / (2 * a - a * a);
    const dist = (t) => (t < a ? k * t * t : k * a * a + 2 * k * a * (t - a));
    let fired = false;
    let lastTrail = -1e9;
    const dNow = () => tokenSize * cfg.orbSize;
    await oni.tween({
      from: 0, to: 1, duration: cfg.travelMs, ease: oni.EASE.linear,
      onUpdate: (v) => {
        const s = Math.min(1, dist(v));
        if (!fired && s >= cfg.gateAt) { fired = true; oni.fireDone(); }
        const x = tx + (kx - tx) * s, y = ty + (ky - ty) * s;
        orb.position.set(x, y); orbCore.position.set(x, y);
        setOrb(dNow() * (1 - 0.25 * s), 1);
        orb.alpha = cfg.travelHaloAlpha;
        const now = performance.now();
        if (now - lastTrail >= cfg.trailEveryMs) {
          lastTrail = now;
          const g = mkSprite(dNow() * 0.8 * (1 - 0.25 * s), PIXI.BLEND_MODES.ADD, cfg.trailAlpha);
          g.position.set(x, y);
          oni.tween({ from: cfg.trailAlpha, to: 0, duration: cfg.trailMs, ease: oni.EASE.outQuad,
            onUpdate: (al) => { g.alpha = al; g.width = g.height = g.width * 0.985; },
            onComplete: () => { try { g.destroy(); } catch (e) {} } });
        }
      },
    });

    // ── LAND: orb pops, King Gorger flashes once — the gate fires here ──
    //    The flash is the SPRITE over-brightened (a clone of the body, tint
    //    filter and all, plus a brightness matrix eased from flashPeak back to
    //    1 — the same idiom as the engine's heal / hurt flash). At brightness 1
    //    the clone is pixel-identical to the real token, so it simply fades out.
    cue(cfg.sfxLand);
    const flash = oni.cloneToken(caster, { parent: layer });
    let flashMx = null;
    if (flash) {
      flashMx = new PIXI.ColorMatrixFilter();
      flashMx.brightness(cfg.flashPeak, false);
      flash.filters = [...(flash.filters || []), flashMx];
      flash.alpha = 1;
    }
    if (!fired) { fired = true; oni.fireDone(); }
    const d0 = orb.width;
    await Promise.all([
      oni.tween({ from: 0, to: 1, duration: cfg.landMs, ease: oni.EASE.outQuad,
        onUpdate: (v) => { setOrb(d0 * (1 + 0.7 * v), 1 - v); } }),
      oni.tween({ from: 0, to: 1, duration: cfg.flashMs, ease: oni.EASE.linear,
        onUpdate: (v) => {
          if (!flash || !flashMx) return;
          const u = v <= cfg.flashHold ? 0 : oni.EASE.outQuad((v - cfg.flashHold) / (1 - cfg.flashHold));
          flashMx.reset(); flashMx.brightness(cfg.flashPeak + (1 - cfg.flashPeak) * u, false);
          flash.alpha = v > 0.85 ? 1 - (v - 0.85) / 0.15 : 1;
        } }),
    ]);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/king-gorger-element-gorge",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG, color, elem },
  });

  await onceHook(doneHook, CFG.flowMs + CFG.holdMs + CFG.travelMs + 10000);   // wide failsafe: a loaded client measured gates ~2.5 s late
  Hooks.callAll("oni:animationEnd", { local: true, world: false, sourceTokenId });
})();
