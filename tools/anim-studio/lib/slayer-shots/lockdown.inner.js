// Slayer · Lockdown (inner script, every client). Approved mockup v3: claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM.
//   default take (Lockdown's own chain, after the MP is paid): MP motes from Zarg, chains snap shut on the target,
//     the shackle sigil, the chains sink to a ring at its feet (the lingering ring is an aeCue on the debuff)
//   "cut" (rider-cosmetic.js, the locked creature uses the locked action): the chains flare and climb its body
// No backticks and no dollar-brace in this file.
const fx = globalThis.FUCompanion && globalThis.FUCompanion.api && globalThis.FUCompanion.api.slayerFx;
const variant = String((ctx.params && ctx.params.variant) || "");
const caster = ctx.casterToken;
const target = ctx.targetTokens && ctx.targetTokens[0];
try {
  if (!fx) { /* nothing to draw */ }
  else if (variant === "cut") { if (caster) await fx.lockdownFlare({ oni: oni, target: caster }); }
  else if (target) await fx.lockdownBind({ oni: oni, caster: caster, target: target });
} catch (e) { console.warn("[Lockdown anim]", e); }
oni.fireDone();
