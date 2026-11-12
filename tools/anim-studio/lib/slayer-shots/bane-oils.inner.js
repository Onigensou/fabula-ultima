// Slayer · Bane Oils (inner script, every client). Approved mockup v3: claude.ai/artifact/H7kodjsPFBHdSeufy2CqNM.
// One script, several takes, picked by the play_animation row's "#variant" (battle-director/slayer-fx.js draws them):
//   apply:<species>                 vial, uncork, the oil runs along the weapon (or is lobbed onto an ally's), sheen
//   slow:<species> / weak:<species> the bane bites: sludge drags down / the colour drains
//   res:<species>:<element>         a ward in the element's colour cracks and shatters
// The gate fires when the take is done, so the next row (the free attack, the debuff) lands after it.
// No backticks and no dollar-brace in this file.
const fx = globalThis.FUCompanion && globalThis.FUCompanion.api && globalThis.FUCompanion.api.slayerFx;
const v = String((ctx.params && ctx.params.variant) || "apply:beast").split(":");
const caster = ctx.casterToken;
const target = (ctx.targetTokens && ctx.targetTokens[0]) || caster;
try {
  if (!fx || !caster) { /* nothing to draw */ }
  else if (v[0] === "apply") await fx.baneApply({ oni: oni, caster: caster, target: target, species: v[1] || "beast" });
  else await fx.baneProc({ oni: oni, target: target, kind: v[0], species: v[1] || "beast", element: v[2] || "physical" });
} catch (e) { console.warn("[Bane Oils anim]", e); }
oni.fireDone();
