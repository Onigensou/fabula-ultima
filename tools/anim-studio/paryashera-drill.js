// @desc Paryashera drill ram: the body goes to a black silhouette, deforms into a spinning cone, rams the target, grinds, springs home
"use strict";
(async () => {
  const CFG = {
    GGS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/",
    // look: "steam" = Spiral Drill, "bolt" = Galvanic Drill
    look: "steam",
    bandColor: 0xe8e4f4,   // the moving spiral grooves
    rimColor: 0xb9a8dc,    // thin light edge so the black reads on a dark cave
    trailClip: "smoke_anim12.webm",
    trailTint: 0xd8d4e4,
    burstTint: 0xf2eefa,
    sparkTint: 0xffffff,
    // timing (ms)
    blackoutMs: 420,       // body drains to black and pulls back
    morphMs: 560,          // silhouette deforms into the cone
    revMs: 300,            // cone spins up in place
    ramMs: 170,            // the hit: fast and violent
    grindMs: 620,          // bores into the target; the Chain ticks land across this
    ticks: 6,              // matches the chain 6 keyword on the item
    returnMs: 560,         // springs home, turning back into the creature
    // shape (fractions of the body)
    recoil: 0.14,          // pull-back before the ram
    coneLen: 0.92,         // length of the cone against the body width
    coneBack: 0.4,         // radius at the back, against the body height
    grooves: 8,
    spinFrom: 7,           // groove speed (radians per second)
    spinTo: 46,
    stopShort: 0.24,       // tip buries this fraction of the cone into the target
    shake: 16,
    shakeMs: 460,
    revSfx: "ChargeAttack",
    ramSfx: "DashA",
    hitSfx: "Explosion2",
    volume: 0.8,
  };

  const P = payload ?? globalThis.__PAYLOAD ?? {};
  const casterUuid = P.casterTokenUuid ?? P.sourceTokenUuid ?? null;
  const targetUuids = (P.targetTokenUuids ?? (P.targets ?? []).map((t) => t.tokenUuid) ?? []).filter(Boolean);
  const doneHook = "oni:done:" + foundry.utils.randomID(8);
  const fireAtMs = CFG.blackoutMs + CFG.morphMs + CFG.revMs + CFG.ramMs;

  const onceHook = (name, ms) => new Promise((resolve) => {
    const id = Hooks.once(name, () => { clearTimeout(t); resolve(); });
    const t = setTimeout(() => { Hooks.off(name, id); resolve(); }, ms);
  });

  Hooks.callAll("oni:animationStart", { local: true, world: false });

  const scriptSource = String.raw`
    const cfg = ctx.params.cfg;
    const caster = oni.caster;
    // Nearest first: the ram lands on it, then the grind rakes through the rest.
    const stops = [...oni.targets].sort((a, b) => Math.hypot(a.center.x - caster.center.x, a.center.y - caster.center.y) - Math.hypot(b.center.x - caster.center.x, b.center.y - caster.center.y));
    const target = stops[0];
    const mesh = caster && caster.mesh;
    if (!mesh || !mesh.texture || !target) { oni.fireDone(); return; }
    const E = oni.EASE;
    const hx = caster.center.x, hy = caster.center.y;
    const tx = target.center.x, ty = target.center.y;
    const dist = Math.max(1, Math.hypot(tx - hx, ty - hy));
    const ux = (tx - hx) / dist, uy = (ty - hy) / dist;
    const flip = Math.sign(mesh.scale.x || 1) || 1;
    const bodyW = Math.abs(mesh.width), bodyH = Math.abs(mesh.height);

    const layer = oni.layer({ zIndex: 96000 });
    const rig = new PIXI.Container();
    rig.position.set(hx, hy);
    layer.addChild(rig);
    const restoreToken = oni.hideToken(caster);

    // The body as a bendable sheet. Texture left = the head, so the head becomes
    // the tip of the cone.
    const NX = 28, NY = 12;
    const tex = mesh.texture;
    const plane = new PIXI.SimplePlane(tex, NX, NY);
    const texW = tex.width, texH = tex.height;
    plane.scale.set(bodyW / texW, bodyH / texH);
    rig.addChild(plane);
    const buf = plane.geometry.getBuffer('aVertexPosition');
    const base = Float32Array.from(buf.data);

    // Cone radius along its length, u = 0 at the tip.
    const coneR = (u) => 0.012 + (1 - 0.012) * Math.pow(u, 0.88);
    const state = { morph: 0, phase: 0, jitter: 0 };

    const bend = () => {
      const d = buf.data, m = state.morph;
      const L = (texW * cfg.coneLen) / 1;
      for (let i = 0; i < d.length; i += 2) {
        const u = base[i] / texW, v = base[i + 1] / texH * 2 - 1;
        const flatX = base[i] - texW / 2, flatY = base[i + 1] - texH / 2;
        const r = coneR(u) * cfg.coneBack * texH;
        // a corkscrew wobble that travels down the shaft: this is what turns a
        // flat shape into something that looks like it is turning
        const twist = Math.sin(state.phase + u * 15) * 0.2 * r;
        const coneX = (u - 0.5) * L;
        const coneY = v * r * (0.82 + 0.18 * Math.cos(state.phase + u * 9)) + twist;
        d[i] = flatX + (coneX - flatX) * m;
        d[i + 1] = flatY + (coneY - flatY) * m;
      }
      buf.update();
    };

    // Solid core + moving grooves, drawn in the same space as the sheet.
    const core = new PIXI.Graphics();
    const grooves = new PIXI.Graphics();
    const glow = new PIXI.Graphics();
    glow.blendMode = PIXI.BLEND_MODES.ADD;
    const overlay = new PIXI.Container();
    overlay.scale.set(bodyW / texW, bodyH / texH);
    overlay.addChild(core, grooves, glow);
    rig.addChild(overlay);

    const paintCone = () => {
      const m = state.morph;
      core.clear(); grooves.clear(); glow.clear();
      overlay.alpha = Math.min(1, Math.max(0, m - 0.25) * 2);
      if (m <= 0.01) return;
      const L = texW * cfg.coneLen, R = cfg.coneBack * texH;
      const tipX = -L / 2, n = 22;
      // The core stays inside the bent silhouette so the body's spikes still break
      // the outline: this is the creature wound into a drill, not a clean cone.
      const inner = 0.72;
      const edge = (s) => { const pts = []; for (let k = 0; k <= n; k++) { const u = k / n; pts.push(tipX + u * L, s * coneR(u) * R * inner); } return pts; };
      const top = edge(-1), low = edge(1);
      core.beginFill(0x000000, 1).moveTo(top[0], top[1]);
      for (let k = 2; k < top.length; k += 2) core.lineTo(top[k], top[k + 1]);
      for (let k = low.length - 2; k >= 0; k -= 2) core.lineTo(low[k], low[k + 1]);
      core.endFill();
      // long highlight down the upper flank gives the shaft a round body
      core.beginFill(cfg.bandColor, 0.16);
      for (let k = 0; k <= n; k++) { const u = k / n; const x = tipX + u * L, r = coneR(u) * R * inner; if (k === 0) core.moveTo(x, -r * 0.62); else core.lineTo(x, -r * 0.62); }
      for (let k = n; k >= 0; k--) { const u = k / n; core.lineTo(tipX + u * L, -coneR(u) * R * inner * 0.2); }
      core.endFill();
      // spiral grooves: curved thread that thickens toward the back and slides
      // down the shaft, brightest on the near side
      const lw = Math.max(3, texH * 0.016);
      for (let g = 0; g < cfg.grooves; g++) {
        const a = ((g / cfg.grooves + state.phase / (Math.PI * 2)) % 1 + 1) % 1;
        const r = coneR(a) * R * inner;
        const x0 = tipX + a * L;
        const lean = L * 0.11;
        const shade = 0.2 + 0.8 * Math.pow(a, 0.7);
        grooves.lineStyle(lw * (0.45 + 1.15 * a), cfg.bandColor, shade);
        for (let s = 0; s <= 10; s++) {
          const q = s / 10, yy = -1 + 2 * q;
          const x = x0 + lean * (1 - yy * yy) + lean * 0.7 * q;
          const uu = Math.min(1, Math.max(0, (x - tipX) / L));
          const y = yy * coneR(uu) * R * inner;
          if (s === 0) grooves.moveTo(x, y); else grooves.lineTo(x, y);
        }
      }
      // air wound up around the shaft, moving toward the tip
      for (let i = 0; i < 3; i++) {
        const a = 1 - ((i / 3 + state.phase * 0.05) % 1);
        const x = tipX + a * L * 0.98, ry = coneR(Math.min(1, a)) * R * 0.86;
        grooves.lineStyle(lw * 0.5, cfg.rimColor, 0.15 + 0.4 * (1 - a));
        grooves.drawEllipse(x, 0, Math.max(3, ry * 0.2), ry);
      }
      // thin rim so the black reads against a dark floor
      grooves.lineStyle(lw * 0.6, cfg.rimColor, 0.85);
      grooves.moveTo(top[0], top[1]);
      for (let k = 2; k < top.length; k += 2) grooves.lineTo(top[k], top[k + 1]);
      grooves.moveTo(low[0], low[1]);
      for (let k = 2; k < low.length; k += 2) grooves.lineTo(low[k], low[k + 1]);
      if (cfg.look === 'bolt') {
        for (let b = 0; b < 3; b++) {
          let x = tipX + Math.random() * L * 0.5, y = (Math.random() - 0.5) * R * 0.5;
          glow.lineStyle(lw * 1.1, b === 0 ? 0xffffff : 0xc070ff, 1).moveTo(x, y);
          for (let s = 0; s < 6; s++) { x += L * 0.09; y += (Math.random() - 0.5) * R * 0.55; glow.lineTo(x, y); }
        }
      }
    };

    // The rig's heading: head first toward the target.
    const heading = (flip > 0 ? Math.atan2(uy, ux) + Math.PI : Math.atan2(uy, ux));
    const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
    const faceAngle = wrap(heading);
    rig.scale.x = flip;
    const setAim = (k) => { rig.rotation = faceAngle * k * flip; };
    const setRig = (x, y) => {
      rig.position.set(x + (Math.random() - 0.5) * state.jitter, y + (Math.random() - 0.5) * state.jitter);
    };

    const backX = hx - ux * bodyW * cfg.recoil, backY = hy - uy * bodyW * cfg.recoil;
    let spin = cfg.spinFrom, ticking = true, last = performance.now();
    let curX = hx, curY = hy;
    const tick = () => {
      if (!ticking || rig.destroyed) return;
      const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
      state.phase += spin * dt;
      bend(); paintCone(); setRig(curX, curY);
    };
    canvas.app.ticker.add(tick);

    const tintGrey = (k) => { const c = Math.round(255 * (1 - k)); plane.tint = (c << 16) | (c << 8) | c; };

    // 1. Drain to black, pull back.
    oni.sfx(cfg.revSfx, { volume: cfg.volume * 0.7 });
    await oni.tween({ from: 0, to: 1, duration: cfg.blackoutMs, ease: E.inOutQuad, onUpdate: (v) => {
      tintGrey(v);
      curX = hx + (backX - hx) * v; curY = hy + (backY - hy) * v;
      state.jitter = v * 2;
    } });

    // Steam or sparks shed while it turns.
    const shed = async (n) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        oni.vfx(cfg.GGS + cfg.trailClip, { x: curX + Math.cos(a) * bodyW * 0.36, y: curY + Math.sin(a) * bodyH * 0.36, size: bodyW * 0.26, alpha: 0.5, zIndex: 95800, angle: Math.random() * 360 }).then((fx) => { if (fx) { fx.sprite.tint = cfg.trailTint; try { fx.video.playbackRate = 0.8; } catch (e) {} } });
        await oni.wait(140);
      }
    };
    shed(4);

    // 2. Silhouette deforms into the cone.
    await oni.tween({ from: 0, to: 1, duration: cfg.morphMs, ease: E.inOutQuad, onUpdate: (v) => {
      state.morph = v; setAim(v);
      spin = cfg.spinFrom + (cfg.spinTo * 0.55 - cfg.spinFrom) * v;
      state.jitter = 2 + v * 3;
    } });

    // 3. Rev up in place.
    await oni.tween({ from: 0, to: 1, duration: cfg.revMs, ease: E.inQuad, onUpdate: (v) => {
      spin = cfg.spinTo * (0.55 + 0.45 * v);
      state.jitter = 5 + v * 7;
    } });

    // 4. The ram.
    const coneWorld = bodyW * cfg.coneLen;
    const hitX = tx - ux * coneWorld * (0.5 - cfg.stopShort), hitY = ty - uy * coneWorld * (0.5 - cfg.stopShort);
    oni.sfx(cfg.ramSfx, { volume: cfg.volume });
    oni.vfx(cfg.GGS + "dashsmoke_anim01.webm", { x: backX, y: backY + bodyH * 0.25, size: bodyW * 0.7, zIndex: 95700, alpha: 0.65, mirror: ux > 0 }).then((fx) => { if (fx) fx.sprite.tint = cfg.trailTint; });
    const lines = new PIXI.Graphics();
    layer.addChild(lines);
    const fromX = curX, fromY = curY;
    state.jitter = 0;
    await oni.tween({ from: 0, to: 1, duration: cfg.ramMs, ease: E.inCubic, onUpdate: (v) => {
      curX = fromX + (hitX - fromX) * v; curY = fromY + (hitY - fromY) * v;
      rig.scale.y = 1 - 0.14 * v;
      rig.scale.x = flip * (1 + 0.28 * v);
      lines.clear();
      for (let i = 0; i < 12; i++) {
        const off = (i / 11 - 0.5) * bodyH * 0.95 + (Math.random() - 0.5) * 12;
        const px = -uy * off, py = ux * off;
        const len = coneWorld * (0.5 + Math.random() * 0.9) * v;
        const sx = curX - ux * coneWorld * 0.35 + px, sy = curY - uy * coneWorld * 0.35 + py;
        lines.lineStyle(i % 3 === 0 ? 5 : 2.5, cfg.bandColor, 0.3 + 0.55 * Math.random());
        lines.moveTo(sx, sy).lineTo(sx - ux * len, sy - uy * len);
      }
    } });

    // 5. Impact: the first damage tick, and the gate for the rest of the action.
    oni.hit();
    oni.fireDone();
    oni.sfx(cfg.hitSfx, { volume: cfg.volume });
    oni.screenshake({ duration: cfg.shakeMs, intensity: cfg.shake });
    rig.scale.set(flip * 0.92, 1.12);
    const tipX = tx - ux * target.w * 0.1, tipY = ty - uy * target.h * 0.1;
    for (const st of stops) oni.vfx(cfg.GGS + "burst_anim02.webm", { x: st.center.x, y: st.center.y, size: Math.max(st.w, 160) * 2.6, zIndex: 96500, blend: PIXI.BLEND_MODES.ADD }).then((fx) => { if (fx) fx.sprite.tint = cfg.burstTint; });
    oni.domFlash?.({ color: cfg.look === 'bolt' ? '#d9a0ff' : '#ffffff', alpha: 0.32, fadeIn: 20, fadeOut: 170 });
    await oni.hitstop(60);
    lines.clear();

    // 6. Grind: bore in, throw sparks.
    state.jitter = 15;
    spin = cfg.spinTo;
    oni.particles({ x: tipX, y: tipY, count: 26, color: cfg.look === 'bolt' ? 0xd29aff : 0xfff2d8, size: 16, radius: Math.max(target.w, 160) * 1.5, life: 520, mode: 'burst', blend: PIXI.BLEND_MODES.ADD, parent: layer });
    const sparkAt = async () => {
      const gap = cfg.grindMs / cfg.ticks;
      for (let i = 1; i < cfg.ticks; i++) {
        await oni.wait(gap);
        oni.hit();
        oni.screenshake({ duration: 90, intensity: 5 });
        // every creature on the card takes this tick
        for (const st of stops) oni.vfx(cfg.GGS + "spark_anim01.webm", { x: st.center.x + (Math.random() - 0.5) * st.w * 0.5, y: st.center.y + (Math.random() - 0.5) * st.h * 0.5, size: Math.max(st.w, 160) * 1.5, zIndex: 96400, blend: PIXI.BLEND_MODES.ADD, angle: Math.random() * 360 }).then((fx) => { if (fx) fx.sprite.tint = cfg.sparkTint; });
      }
    };
    sparkAt();
    await oni.tween({ from: 0, to: 1, duration: cfg.grindMs, ease: E.linear, onUpdate: (v) => {
      if (stops.length < 2) { curX = hitX + ux * 26 * Math.sin(v * Math.PI); curY = hitY + uy * 26 * Math.sin(v * Math.PI); return; }
      // rake through the party, tip on each creature in turn
      const p = v * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), k = p - i;
      const ax = stops[i].center.x - ux * coneWorld * (0.5 - cfg.stopShort), ay = stops[i].center.y - uy * coneWorld * (0.5 - cfg.stopShort);
      const bx = stops[i + 1].center.x - ux * coneWorld * (0.5 - cfg.stopShort), by = stops[i + 1].center.y - uy * coneWorld * (0.5 - cfg.stopShort);
      curX = ax + (bx - ax) * k; curY = ay + (by - ay) * k;
    } });

    // 7. Spring home, turning back into the creature.
    state.jitter = 0;
    const outX = curX, outY = curY;
    await oni.tween({ from: 0, to: 1, duration: cfg.returnMs, ease: E.outCubic, onUpdate: (v) => {
      curX = outX + (hx - outX) * v;
      curY = outY + (hy - outY) * v - Math.sin(v * Math.PI) * bodyH * 0.22;
      const k = 1 - v;
      state.morph = k; setAim(k);
      spin = cfg.spinFrom + (cfg.spinTo - cfg.spinFrom) * k;
      rig.scale.set(flip * (1 + (0.92 - 1) * k), 1 + 0.12 * k);
      tintGrey(Math.max(0, 1 - Math.max(0, v - 0.5) * 2));
    } });
    ticking = false;
    canvas.app.ticker.remove(tick);
    tintGrey(0);
    restoreToken();
    await oni.wait(40);
  `;

  game.ONI.pseudo.play({
    scriptId: "anim-studio/paryashera-drill",
    scriptSource,
    casterTokenUuid: casterUuid,
    targetTokenUuids: targetUuids,
    params: { doneHook, cfg: CFG },
  });

  await onceHook(doneHook, fireAtMs + 6000);
  Hooks.callAll("oni:animationEnd", { local: true, world: false });
})();
