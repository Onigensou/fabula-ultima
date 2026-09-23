#!/usr/bin/env node
"use strict";
// ============================================================================
// VFX mockup templates — clean, layered frames of a battle to draw on.
//
// Replaces "open the game, frame it, screenshot, crop the UI out". Captures
// straight from PIXI, so NO DOM UI can appear in the output — no toolbar, no
// sidebar, no "Game Paused", no chat — and the same frame is split into layers:
//
//   <framing>-composite.png    everything, the thing to draw on
//   <framing>-background.png   the arena alone
//   <framing>-tokens.png       the combatants alone, on TRANSPARENCY
//   guides.png                 viewport-fraction overlay (transparent)
//
// Layers because the real shots layer: a dim sits UNDER the tokens and a
// whiteout OVER them, so a mockup often needs to live between the two.
//
// guides.png is the point of the pack as much as the frames are. Every
// animation config in this repo positions things in VIEWPORT FRACTIONS, so a
// mark drawn on the guide can be read back as a number instead of estimated.
//
// Framings: `rest` (battle framing), plus a close-up on the caster and on the
// first target at the push-in the shots actually use, so things are drawn at
// the size they will appear.
//
// GAME MUST BE OPEN and the test bridge armed (see reference_test_bridge).
// Tokens it spawns are deleted again; tokens that were already on the scene
// are left alone.
//
//   node tools/anim-studio/bin/mockup-templates.js
//   node tools/anim-studio/bin/mockup-templates.js --subject Fafnir \
//        --caster P1uCkpNnxLRBNqZr --targets rftRuHZwWx5SiNpH,rftRuHZwWx5SiNpH \
//        --scene "Training Ground" --zoom 1.6 --out "C:/Users/Oni/OneDrive/Desktop/VFX Mockups"
// ============================================================================

const fs = require("fs");
const path = require("path");

const BR = path.resolve(__dirname, "..", "..", "..", "worlds", "fabula-ultima-2", "test-bridge");

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const OPT = {
  subject: arg("subject", "Fafnir"),
  caster:  arg("caster", "P1uCkpNnxLRBNqZr"),
  // Two of the same actor is fine — it spawns two tokens.
  targets: arg("targets", "rftRuHZwWx5SiNpH,rftRuHZwWx5SiNpH").split(",").map((s) => s.trim()).filter(Boolean),
  scene:   arg("scene", "Training Ground"),
  zoom:    Number(arg("zoom", "1.6")),
  out:     arg("out", "C:/Users/Oni/OneDrive/Desktop/VFX Mockups"),
};

/* ── Bridge client ───────────────────────────────────────────────────────── */

const secret = fs.readFileSync(path.join(BR, "bridge-secret.txt"), "utf8").trim();
const liveBoot = () => JSON.parse(fs.readFileSync(path.join(BR, "state.json"), "utf8")).bootId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalGM(code, timeoutMs = 120000) {
  const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const req = path.join(BR, "inbox", `req-${id}.json`);
  const res = path.join(BR, "outbox", `res-${id}.json`);
  fs.writeFileSync(req, JSON.stringify({ id, kind: "evalGM", args: { code, auth: secret }, auth: secret, timeoutMs }));
  const want = liveBoot();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs + 10000) {
    if (fs.existsSync(res)) {
      // The bridge write is not atomic and these payloads are MEGABYTES, so a
      // file that exists may be half-written. Wait for the size to settle.
      let r = null;
      for (let a = 0; a < 40; a++) {
        const s1 = fs.statSync(res).size;
        await sleep(150);
        const s2 = fs.statSync(res).size;
        if (s1 === s2 && s2 > 0) { try { r = JSON.parse(fs.readFileSync(res, "utf8")); break; } catch { /* still writing */ } }
      }
      try { fs.unlinkSync(req); } catch {}
      try { fs.unlinkSync(res); } catch {}
      if (!r) throw new Error("bridge response never became parseable");
      if (r.bootId && r.bootId !== want) throw new Error(`stale response (boot ${r.bootId} != ${want})`);
      if (!r.ok) throw new Error("bridge error: " + JSON.stringify(r.error));
      return r.result;
    }
    await sleep(300);
  }
  throw new Error("bridge timeout");
}

function writePng(file, dataUrl) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error("not a PNG data URL for " + file);
  fs.writeFileSync(file, Buffer.from(m[1], "base64"));
  return fs.statSync(file).size;
}

/* ── Browser-side program ─────────────────────────────────────────────────── */

// Installed once. Kept as a string because it runs in the GM client.
const INSTALL = String.raw`
const ORIG = globalThis.__mockup ?? {};
globalThis.__mockup = ORIG;

// Render the stage at its CURRENT view into a screen-sized texture. PIXI-side,
// so DOM UI cannot appear. Visibility is toggled only for the duration of one
// synchronous render, so Foundry's own refresh never gets a chance to fight it.
ORIG.snap = async function ({ tokens = true, background = true } = {}) {
  const r = canvas.app.renderer;
  const W = r.screen.width, H = r.screen.height;
  const isToken = (c) => typeof c?.name === 'string'
    && (c.name.startsWith('Token.') || c.name.startsWith('fud-sprite-shadow:'));
  const saved = [];
  const set = (o, v) => { if (!o) return; saved.push([o, o.visible]); o.visible = v; };
  for (const c of canvas.primary.children) set(c, isToken(c) ? tokens : background);
  set(canvas.interface, false);          // nameplates, bars, borders, selection
  if (canvas.effects) set(canvas.effects, background);
  for (const g of canvas.stage.children) if (g !== canvas.rendered) set(g, background);
  const rt = PIXI.RenderTexture.create({ width: W, height: H, resolution: 1 });
  try {
    r.render(canvas.stage, { renderTexture: rt, clear: true });
    return await r.extract.base64(rt, 'image/png');
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) saved[i][0].visible = saved[i][1];
    rt.destroy(true);
  }
};

// Viewport-fraction guides on transparency. Quarters as fine lines, the
// centre cross heavier, every line labelled with the fraction it marks.
ORIG.guides = function () {
  const W = canvas.app.renderer.screen.width, H = canvas.app.renderer.screen.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const line = (x1, y1, x2, y2, w, a) => {
    g.strokeStyle = 'rgba(255,40,200,' + a + ')'; g.lineWidth = w;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  };
  for (const f of [0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9]) {
    line(W * f, 0, W * f, H, 1, 0.22); line(0, H * f, W, H * f, 1, 0.22);
  }
  for (const f of [0.25, 0.75]) {
    line(W * f, 0, W * f, H, 2, 0.6); line(0, H * f, W, H * f, 2, 0.6);
  }
  line(W * 0.5, 0, W * 0.5, H, 3, 0.9); line(0, H * 0.5, W, H * 0.5, 3, 0.9);
  g.font = 'bold 18px monospace'; g.fillStyle = 'rgba(255,40,200,0.95)';
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 4;
  const label = (t, x, y) => { g.strokeText(t, x, y); g.fillText(t, x, y); };
  for (const f of [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9]) {
    label('x ' + f, W * f + 4, 22);
    label('y ' + f, 6, H * f - 6);
  }
  label(W + ' x ' + H + '  —  screen fractions, as used in animation cfg', 10, H - 12);
  return c.toDataURL('image/png');
};
return 'installed';
`;

/* ── Main ─────────────────────────────────────────────────────────────────── */

(async () => {
  const outDir = path.join(OPT.out, OPT.subject);
  fs.mkdirSync(outDir, { recursive: true });

  console.log("installing capture program…");
  await evalGM(INSTALL);

  console.log(`setting up "${OPT.scene}"…`);
  const setup = await evalGM(`
    const sc0 = game.scenes.getName(${JSON.stringify(OPT.scene)});
    if (!sc0) throw new Error('no scene named ' + ${JSON.stringify(OPT.scene)});
    if (canvas.scene?.id !== sc0.id) { await sc0.view(); await new Promise(r => setTimeout(r, 2500)); }
    const sc = canvas.scene;
    const spawned = [];
    // Caster: reuse one already on the scene, otherwise spawn.
    let casterTok = sc.tokens.find(t => t.actorId === ${JSON.stringify(OPT.caster)})?.id;
    if (!casterTok) {
      const td = await game.actors.get(${JSON.stringify(OPT.caster)}).getTokenDocument({ x: 760, y: 470 });
      casterTok = (await sc.createEmbeddedDocuments('Token', [td.toObject()]))[0].id;
      spawned.push(casterTok);
    }
    // Targets: reuse existing tokens of each actor in order, spawn the rest.
    const want = ${JSON.stringify(OPT.targets)};
    const spots = [{ x: 1560, y: 430 }, { x: 1560, y: 760 }, { x: 1350, y: 600 }, { x: 1750, y: 600 }];
    const used = new Set([casterTok]);
    const targetToks = [];
    for (let i = 0; i < want.length; i++) {
      let t = sc.tokens.find(x => x.actorId === want[i] && !used.has(x.id))?.id;
      if (!t) {
        const td = await game.actors.get(want[i]).getTokenDocument(spots[i % spots.length]);
        t = (await sc.createEmbeddedDocuments('Token', [td.toObject()]))[0].id;
        spawned.push(t);
      }
      used.add(t); targetToks.push(t);
    }
    await new Promise(r => setTimeout(r, 1800));
    for (const id of used) { const p = canvas.tokens.get(id); if (p) { p.alpha = 1; if (p.mesh) p.mesh.alpha = 1; } }
    return { casterTok, targetToks, spawned };
  `);
  console.log(`  caster ${setup.casterTok}, targets ${setup.targetToks.join(", ")}, spawned ${setup.spawned.length}`);

  const framings = [
    { key: "rest", focus: null },
    { key: "closeup-caster", focus: setup.casterTok },
    { key: "closeup-target", focus: setup.targetToks[0] },
  ];

  const written = [];
  try {
    for (const fr of framings) {
      await evalGM(`
        const CAM = await import('/modules/fabula-ultima-companion/scripts/battle-director/director-camera.js');
        await CAM.settleRestFraming(canvas.scene, { attempts: 2 });
        const focus = ${JSON.stringify(fr.focus)};
        if (focus) {
          const t = canvas.tokens.get(focus);
          const v = CAM.resolveIntent({ point: t.center, zoom: ${OPT.zoom} }, canvas.scene);
          CAM.panSnap(v, { scene: canvas.scene });
        }
        await new Promise(r => setTimeout(r, 700));
        return 'framed';
      `);
      for (const [layer, o] of [
        ["composite",  { tokens: true,  background: true  }],
        ["background", { tokens: false, background: true  }],
        ["tokens",     { tokens: true,  background: false }],
      ]) {
        const url = await evalGM(`return await globalThis.__mockup.snap(${JSON.stringify(o)});`);
        const file = path.join(outDir, `${fr.key}-${layer}.png`);
        const bytes = writePng(file, url);
        written.push(file);
        console.log(`  ✓ ${path.basename(file)}  (${(bytes / 1024).toFixed(0)} KB)`);
      }
    }
    const g = await evalGM(`return globalThis.__mockup.guides();`);
    const gf = path.join(outDir, "guides.png");
    writePng(gf, g); written.push(gf);
    console.log(`  ✓ guides.png`);
  } finally {
    // Only delete what THIS run created; tokens that were already there stay.
    const cleaned = await evalGM(`
      const ids = ${JSON.stringify(setup.spawned)}.filter(id => canvas.scene.tokens.get(id));
      if (ids.length) await canvas.scene.deleteEmbeddedDocuments('Token', ids);
      const CAM = await import('/modules/fabula-ultima-companion/scripts/battle-director/director-camera.js');
      await CAM.settleRestFraming(canvas.scene, { attempts: 2 });
      return ids.length;
    `);
    console.log(`cleaned up ${cleaned} spawned token(s); camera back at rest framing.`);
  }

  console.log(`\n${written.length} file(s) -> ${outDir}`);
})().catch((e) => { console.error("FAILED:", e.message ?? e); process.exitCode = 1; });
