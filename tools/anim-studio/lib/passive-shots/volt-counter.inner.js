// Ampere · Volt Counter (inner script, every client). Approved mockup: claude.ai/artifact/GmHAYWhV8rCRHVigfTc4bw.
// Struck on an even roll, Ampere dumps its charge into the board: a white pinch at its core, then three
// electric ripple rings run out along the floor from its feet (pixelfx fu/volt-counter, 3 layers: the far
// half of each ring under the battlers, the near half over them). The damage gate fires as the first ring
// is out (cfg.impactMs); BD's numbers and flinches land there on every creature it hits.
// No backticks and no dollar-brace in this file.
const cfg = ctx.params.cfg || {};
const caster = ctx.casterToken;
if (!caster) { oni.fireDone(); return; }

// size: the clip was drawn around a body cfg.bodyPx clip-px tall; scale to Ampere's own (undrawn) height,
// oni.pxfx adds the 3D camera's scale on top
const meshH = Math.abs((caster.mesh && caster.mesh.height) || caster.h || 100);
const k = cfg.k * meshH / cfg.bodyPx;

oni.sfx(cfg.sfx, { volume: cfg.volume * cfg.sfxVol });
const fx = await oni.pxfx(cfg.clip, { token: caster, k: k });
oni.sfx(cfg.sfx2, { volume: cfg.volume * cfg.sfx2Vol, delay: 220 });
await oni.wait(cfg.impactMs);
oni.fireDone();
// the rings outlive the script (oni.vfx clips are not disposed with it)
if (fx && fx.ended) await fx.ended;
