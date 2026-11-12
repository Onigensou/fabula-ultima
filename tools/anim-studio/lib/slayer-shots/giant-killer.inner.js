// Slayer · Giant Killer (inner script, every client). Approved mockup v3: claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM.
// A damage rider's accent (battle-director/rider-cosmetic.js plays it at impact on the struck creature):
// hit-stop flash, then one tapered crimson notch per soldier the creature replaces (amount = +2 x soldiers).
// No backticks and no dollar-brace in this file.
const fx = globalThis.FUCompanion && globalThis.FUCompanion.api && globalThis.FUCompanion.api.slayerFx;
const amount = Math.abs(Number(ctx.params && ctx.params.amount) || 0);
const n = Math.max(1, Math.round(amount / 2) || 2);
const target = ctx.targetTokens && ctx.targetTokens[0];
try { if (fx && target) await fx.giantKiller({ oni: oni, target: target, n: n }); }
catch (e) { console.warn("[Giant Killer anim]", e); }
oni.fireDone();
