// spell-fencer-glow.js — the Spell Fencer auras' OUTLINE GLOW (approved mockup v2, round rmwsrvdn3): a soft glow + thin outline
// round the token in the aura's colour. Next Spell = blue, Next Attack = red, Resonance ready / Rhapsody Turn = the red/blue
// blend (violet #b45cff); one outline per token, by precedence (spell-fencer-cues.js sfOutline). Numbers: CUE_P there.
//
// The particle cues are DOM (status-cues.js), which cannot outline a sprite, so this is a PIXI filter pair on the token mesh,
// the way turn-glow.js outlines the acting token: re-attached every tick (other systems replace mesh.filters wholesale),
// fading in / out. Coexistence (approved rule 0): the TURN GLOW WINS — on the acting token this glow stands down and
// returns when the turn ends, so a mesh never carries two outlines. Hidden during action animations (fuBattleMarksHidden)
// and outside battle, like the status cues. Per client, display only.

import { warn, log } from "./logger.js";
import { battleActive } from "./battle-focus.js";
import { cuesOf } from "./status-cues.js";
import { turnGlowTokenId } from "./turn-glow.js";
import { sfOutline, sfGlowParams } from "./spell-fencer-cues.js";

const FADE_IN_MS = 450;
const FADE_OUT_MS = 300;
const S = { want: new Map(), recs: new Map(), hidden: false, tickerOn: false };   // tokenId -> outline | rec

const sig = (o) => (o ? `${o.cue}|${o.rgb.join(",")}|${o.width}` : "");

// The wanted outline per token, recomputed only when AEs change (never per frame).
function refresh(token) {
  if (!token?.id) return;
  const o = battleActive() && token.actor && !token.destroyed ? sfOutline(cuesOf(token.actor)) : null;
  if (o) S.want.set(token.id, o); else S.want.delete(token.id);
  ensureTicker();
}
function refreshAll() {
  S.want.clear();
  for (const t of canvas?.tokens?.placeables ?? []) refresh(t);
}

function makeFilters(p) {
  const F = PIXI?.filters ?? {};
  let glow = null, outline = null;
  try {
    if (typeof F.GlowFilter === "function") {
      glow = new F.GlowFilter({ distance: p.distance, outerStrength: 0, innerStrength: 0, color: p.color, quality: 0.3 });
      glow.padding = p.distance + 4;
    }
  } catch (e) { warn("spell-fencer-glow: GlowFilter failed", e); }
  try {
    if (typeof F.OutlineFilter === "function") { outline = new F.OutlineFilter(1, p.color, 0.3); outline.padding = 2; }
  } catch (e) { warn("spell-fencer-glow: OutlineFilter failed", e); }
  return { glow, outline };
}
globalThis.__fuShaderPrewarm?.register?.("spell-fencer-glow", () => {
  const p = sfGlowParams({ cue: "sfspell", rgb: [77, 166, 255], strength: 0.45, width: 6, breathMs: 2600 }, 0);
  const { glow, outline } = makeFilters(p);
  return [outline, glow].filter(Boolean);
});

function attach(rec, mesh) {
  const want = [rec.outline, rec.glow].filter(Boolean), have = mesh.filters ?? [];
  if (want.every((f) => have.includes(f))) return;
  mesh.filters = [...have.filter((f) => !want.includes(f)), ...want];
}
function detach(rec, mesh) {
  if (!mesh?.filters) return;
  const mine = [rec.outline, rec.glow], rest = mesh.filters.filter((f) => !mine.includes(f));
  mesh.filters = rest.length ? rest : null;
}
function drop(id) {
  const rec = S.recs.get(id); if (!rec) return;
  try { detach(rec, canvas?.tokens?.get?.(id)?.mesh); } catch { /* token gone */ }
  S.recs.delete(id);
}

function ensureTicker() {
  if (S.tickerOn) return;
  try { PIXI.Ticker.shared.add(tick); S.tickerOn = true; } catch (e) { warn("spell-fencer-glow: ticker add failed", e); }
}
function stopTicker() { if (!S.tickerOn) return; try { PIXI.Ticker.shared.remove(tick); } catch { /* */ } S.tickerOn = false; }

function tick() {
  try {
    const now = performance.now(), turnId = turnGlowTokenId();
    // a record whose token no longer wants an outline (or is the acting token, or the cues are hidden) fades out
    for (const [id, rec] of S.recs) {
      const o = S.want.get(id), off = !o || S.hidden || id === turnId || sig(o) !== rec.sig;
      if (off && !rec.fadeOutAt) rec.fadeOutAt = now;
      if (!off && rec.fadeOutAt) { rec.fadeOutAt = null; rec.start = now - FADE_IN_MS; }
    }
    for (const [id, o] of S.want) {
      if (S.hidden || id === turnId || S.recs.has(id)) continue;
      const p = sfGlowParams(o, 0);
      S.recs.set(id, { sig: sig(o), o, start: now, fadeOutAt: null, ...makeFilters(p) });
    }
    for (const [id, rec] of S.recs) {
      const token = canvas?.tokens?.get?.(id), mesh = token?.mesh;
      if (!token || token.destroyed || !mesh || mesh.destroyed) { if (rec.fadeOutAt) S.recs.delete(id); continue; }
      let k = Math.min(1, (now - rec.start) / FADE_IN_MS);
      if (rec.fadeOutAt) { k = Math.min(k, Math.max(0, 1 - (now - rec.fadeOutAt) / FADE_OUT_MS)); if (k <= 0) { drop(id); continue; } }
      const p = sfGlowParams(rec.o, now - rec.start, k);
      attach(rec, mesh);
      if (rec.glow) { rec.glow.outerStrength = p.outerStrength; try { rec.glow.alpha = p.glowAlpha; } catch { /* older pixi-filters */ } }
      if (rec.outline) { try { rec.outline.alpha = p.outlineAlpha; } catch { /* older pixi-filters */ } }
    }
    if (!S.recs.size && !S.want.size) stopTicker();
  } catch (e) {
    warn("spell-fencer-glow: tick threw — dropping every glow", e);
    for (const id of [...S.recs.keys()]) drop(id);
  }
}

function actorOfEffect(eff) {
  const p = eff?.parent;
  return p?.documentName === "Actor" ? p : p?.parent?.documentName === "Actor" ? p.parent : null;
}

export function initSpellFencerGlow() {
  const onAE = (eff) => { const a = actorOfEffect(eff); if (!a) return; for (const t of a.getActiveTokens?.(false, false) ?? []) refresh(t); };
  Hooks.on("createActiveEffect", onAE);
  Hooks.on("updateActiveEffect", onAE);
  Hooks.on("deleteActiveEffect", onAE);
  Hooks.on("createToken", (doc) => setTimeout(() => refresh(doc?.object), 0));
  Hooks.on("deleteToken", (doc) => { S.want.delete(doc?.id); drop(doc?.id); });
  Hooks.on("canvasTearDown", () => { S.recs.clear(); S.want.clear(); });
  Hooks.on("canvasReady", () => refreshAll());
  Hooks.on("fuBattleFocusChanged", () => refreshAll());
  Hooks.on("fuBattleMarksHidden", (hidden) => { S.hidden = !!hidden; ensureTicker(); });
  if (canvas?.ready) refreshAll();
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.spellFencerGlow = { refreshAll, wanted: () => [...S.want].map(([id, o]) => ({ id, cue: o.cue, rgb: o.rgb })), active: () => [...S.recs.keys()] };
  log("[SpellFencerGlow] ready");
}
