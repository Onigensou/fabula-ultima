// Icon focal-point tuner (GM tool).
//
// The turn-action tracker masks each token sprite into a circle with a fixed
// "top-centre, ×2" crop. For actors whose face sits lower in the sprite (Hina,
// Blanche) that frames the ears instead of the face. This tool lets the GM dial
// a PER-ACTOR focal point + zoom against a live WYSIWYG preview and save it to
// flags.fabula-ultima-companion.iconFocus — the exact value the icon reads.
//
// Operate it on the SELECTED token (falls back to the TARGETED token). The
// preview uses the token's CURRENT texture, so tuning DURING a battle frames
// against the same battle sprite the tracker shows. Saving refreshes the live
// tracker so the change is visible immediately.
//
// A "Round bar icon / Turn banner" switch re-uses the same panel for the turn
// banner's portrait (turn-start-cue.js): the banner shows the actor's PORTRAIT,
// a different image from the token, so it has its own value —
// flags.fabula-ultima-companion.bannerFocus, previewed against the portrait in
// the banner's own frame. An actor with no portrait falls back to the token in
// the banner, framed by the icon value, so there is nothing separate to tune.

import { log, warn } from "./logger.js";
import { isVideoSrc, applyIconFocusStyle, normalizeIconFocus, ICON_FOCUS_DEFAULT } from "./director-round-banner.js";
import { registerDevTool, devToolsAnchorBottom, devToolsAnchorLeft } from "./dev-tools-menu.js";
import {
  bannerArtFor, buildBannerParts, applyBannerFocusStyle, normalizeBannerFocus,
  BANNER_FOCUS_DEFAULT, BANNER_FOCUS_FLAG,
} from "./turn-start-cue.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG = "iconFocus";

const BTN_ID = "fud-iconfocus-btn";
const PANEL_ID = "fud-iconfocus-panel";
const STYLE_ID = "fud-iconfocus-style";

const CFG = { left: 16, bottom: 128, size: 46 };

let _booted = false;

export function initIconFocusTuner() {
  try {
    if (_booted) return;
    if (!game.user?.isGM) return;
    ensureStyle();
    // Bundled under the Developer Tools launcher instead of its own button.
    registerDevTool({ id: "icon-focus", icon: "🎯", label: "Icon Adjuster", onClick: () => openPanel("icon") });
    _booted = true;
    log("icon-focus-tuner: registered as dev tool");
  } catch (e) {
    warn("initIconFocusTuner threw", e);
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${BTN_ID} {
  position: fixed; left: ${CFG.left}px; bottom: ${CFG.bottom}px; width: ${CFG.size}px; height: ${CFG.size}px;
  z-index: 81; display: flex; align-items: center; justify-content: center; border-radius: 50%;
  cursor: pointer; user-select: none; font-size: 20px; color: #cfe0ff;
  background: radial-gradient(circle at 35% 30%, #2f3f5a, #11161f);
  border: 1px solid rgba(127,160,255,.4); box-shadow: 0 3px 10px rgba(0,0,0,.45);
  transition: transform .12s ease, box-shadow .12s ease;
}
#${BTN_ID}:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.55); }
#${PANEL_ID} {
  position: fixed; left: ${CFG.left}px; bottom: ${CFG.bottom + CFG.size + 10}px; z-index: 100002;
  width: 280px; background: linear-gradient(180deg, rgba(24,26,32,.98), rgba(16,18,22,.98));
  color: #e8eaf0; border: 1px solid rgba(127,160,255,.3); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; font: 12px "Signika", system-ui, sans-serif;
}
#${PANEL_ID} .ifc-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
#${PANEL_ID} .ifc-title { font-weight: 800; color: #cfe0ff; font-size: 13px; }
#${PANEL_ID} .ifc-close { cursor: pointer; opacity: .7; padding: 2px 6px; border-radius: 6px; }
#${PANEL_ID} .ifc-close:hover { opacity: 1; background: rgba(255,255,255,.08); }
#${PANEL_ID} .ifc-previews { display: flex; align-items: center; justify-content: center; gap: 14px; margin-bottom: 12px; }
#${PANEL_ID} .ifc-circle {
  /* Rectangle to match the live icon (Dota-2 hero-bar style), 11:8 aspect. */
  border-radius: 5px; overflow: hidden; background: #0a0a0e; border: 2px solid #ffd866; flex: 0 0 auto;
}
#${PANEL_ID} .ifc-circle.big { width: 154px; height: 112px; }
#${PANEL_ID} .ifc-circle.small { width: 55px; height: 40px; }
#${PANEL_ID} .ifc-circle .ifc-media { width: 100%; height: 100%; object-fit: cover; display: block; }
#${PANEL_ID} .ifc-row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
#${PANEL_ID} .ifc-row label { width: 44px; opacity: .85; }
#${PANEL_ID} .ifc-row input[type=range] { flex: 1 1 auto; }
#${PANEL_ID} .ifc-row .ifc-val { width: 38px; text-align: right; opacity: .8; font-variant-numeric: tabular-nums; }
#${PANEL_ID} .ifc-btns { display: flex; gap: 8px; margin-top: 12px; }
#${PANEL_ID} .ifc-btn {
  flex: 1 1 auto; text-align: center; cursor: pointer; padding: 6px 0; border-radius: 7px;
  font-weight: 700; border: 1px solid rgba(255,255,255,.14);
}
#${PANEL_ID} .ifc-btn.save { background: rgba(80,150,90,.25); border-color: rgba(80,150,90,.5); color: #cfeccf; }
#${PANEL_ID} .ifc-btn.reset { background: rgba(255,255,255,.06); }
#${PANEL_ID} .ifc-btn:hover { filter: brightness(1.15); }
#${PANEL_ID} .ifc-hint { opacity: .55; font-size: 10.5px; margin-top: 8px; text-align: center; }
#${PANEL_ID}.ifc-wide { width: 360px; }
#${PANEL_ID} .ifc-modes { display: flex; gap: 0; margin-bottom: 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; overflow: hidden; }
#${PANEL_ID} .ifc-mode { flex: 1 1 0; text-align: center; cursor: pointer; padding: 5px 0; background: rgba(255,255,255,.04); opacity: .75; }
#${PANEL_ID} .ifc-mode + .ifc-mode { border-left: 1px solid rgba(255,255,255,.14); }
#${PANEL_ID} .ifc-mode.on { background: rgba(255,216,102,.16); color: #ffd866; opacity: 1; box-shadow: inset 0 -2px 0 #ffd866; }
#${PANEL_ID} .ifc-previews.ifc-stack { flex-direction: column; gap: 10px; }
#${PANEL_ID} .ifc-art { width: 330px; height: 125px; border-radius: 4px; overflow: hidden; background: #0a0a0e; border: 2px solid #d5b67a; flex: 0 0 auto; }
#${PANEL_ID} .ifc-art .ifc-media { width: 100%; height: 100%; object-fit: cover; display: block; }
#${PANEL_ID} .ifc-strip { position: relative; width: 336px; overflow: hidden; flex: 0 0 auto; }
#${PANEL_ID} .ifc-strip-stage { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; }
#${PANEL_ID} .ifc-row.off { opacity: .35; pointer-events: none; }
#${PANEL_ID} .ifc-btn.off { opacity: .35; pointer-events: none; }
#${PANEL_ID} .ifc-note { font-size: 11px; line-height: 1.35; color: #f1d9a6; background: rgba(255,216,102,.08); border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function resolveToken() {
  return canvas?.tokens?.controlled?.[0]
    ?? Array.from(game.user?.targets ?? [])[0]
    ?? null;
}

function buildMedia(src) {
  let media;
  if (isVideoSrc(src)) {
    media = document.createElement("video");
    media.autoplay = true; media.loop = true; media.muted = true;
    media.playsInline = true; media.setAttribute("playsinline", "");
  } else {
    media = document.createElement("img");
    media.draggable = false;
  }
  media.className = "ifc-media";
  if (src) media.src = src;
  return media;
}

// Static turn-banner preview: the band at rest, scaled to the panel.
function buildBannerStrip(opts, width = 336) {
  const BAND_LEFT = 430, BAND_TOP = 318, BAND_W = 1060, BAND_H = 128, PAD = 18;
  const scale = width / (BAND_W + PAD * 2);
  const strip = document.createElement("div"); strip.className = "ifc-strip";
  strip.style.height = `${Math.round((BAND_H + PAD * 2) * scale)}px`;
  const stage = document.createElement("div"); stage.className = "ifc-strip-stage";
  stage.style.transform = `scale(${scale}) translate(${PAD - BAND_LEFT}px, ${PAD - BAND_TOP}px)`;
  const parts = buildBannerParts(opts);
  stage.appendChild(parts.mover);
  strip.appendChild(stage);
  return { strip, media: parts.media };
}

function openPanel(mode = "icon") {
  document.getElementById(PANEL_ID)?.remove();

  const tok = resolveToken();
  if (!tok) { ui.notifications?.warn("Focal tuner: select (or target) a token first."); return; }
  // Save/read on the BASE (world) actor so the focal applies to EVERY copy of a
  // monster, not just this token. For unlinked tokens `tok.actor` is a synthetic
  // per-token actor; the world actor is game.actors.get(token.actorId). Linked
  // tokens resolve to the same document either way.
  const baseActor = game.actors?.get?.(tok.document?.actorId) ?? tok.actor;
  if (!baseActor) { ui.notifications?.warn("Focal tuner: that token has no actor."); return; }

  const banner = mode === "banner";
  // Banner mode tunes the PORTRAIT. With no portrait the banner shows the token
  // framed by the icon value, so there is nothing of its own to set.
  const art = banner ? bannerArtFor(baseActor, tok.document) : null;
  const editable = !banner || !!art?.portrait;
  const flagKey = banner ? BANNER_FOCUS_FLAG : FLAG;
  const defaults = banner ? BANNER_FOCUS_DEFAULT : ICON_FOCUS_DEFAULT;
  const src = banner ? art.src : (tok.document?.texture?.src ?? baseActor.img ?? null);
  const focus = banner
    ? (art.portrait ? normalizeBannerFocus(baseActor.getFlag?.(MODULE_ID, flagKey)) : art.focus)
    : normalizeIconFocus(baseActor.getFlag?.(MODULE_ID, flagKey));

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  if (banner) panel.classList.add("ifc-wide");
  // Anchor just above the Players list and to the RIGHT of the launcher column
  // so it never covers the dev-tools buttons (lets you re-tune another token
  // without closing this panel first).
  try { panel.style.bottom = `${devToolsAnchorBottom()}px`; } catch (_e) {}
  try { panel.style.left = `${devToolsAnchorLeft()}px`; } catch (_e) {}

  const head = document.createElement("div"); head.className = "ifc-head";
  const title = document.createElement("div"); title.className = "ifc-title";
  title.textContent = `🎯 Focal — ${baseActor.name ?? "Token"}`;
  const close = document.createElement("div"); close.className = "ifc-close"; close.textContent = "✕";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);

  const modes = document.createElement("div"); modes.className = "ifc-modes";
  for (const [key, label] of [["icon", "Round bar icon"], ["banner", "Turn banner"]]) {
    const b = document.createElement("div");
    b.className = "ifc-mode" + (key === mode ? " on" : "");
    b.textContent = label;
    if (key !== mode) b.addEventListener("click", () => openPanel(key));
    modes.appendChild(b);
  }

  // Previews. Icon: big (tuning) + small (actual icon size). Banner: the
  // portrait frame (tuning) + the banner itself at rest.
  const previews = document.createElement("div"); previews.className = "ifc-previews";
  const big = document.createElement("div");
  const paint = (() => {
    if (!banner) {
      big.className = "ifc-circle big";
      const small = document.createElement("div"); small.className = "ifc-circle small";
      const bigMedia = buildMedia(src);
      const smallMedia = buildMedia(src);
      big.appendChild(bigMedia); small.appendChild(smallMedia);
      previews.append(big, small);
      return (f) => { applyIconFocusStyle(bigMedia, f); applyIconFocusStyle(smallMedia, f); };
    }
    previews.classList.add("ifc-stack");
    big.className = "ifc-art";
    const bigMedia = editable ? buildMedia(src) : null;
    if (bigMedia) { big.appendChild(bigMedia); previews.appendChild(big); }
    const enemy = Number(tok.document?.disposition) === -1;
    const { strip, media } = buildBannerStrip({
      name: tok.document?.name ?? baseActor.name ?? "", side: enemy ? "enemy" : "party",
      round: 1, activation: 1, art: src, focus,
    });
    previews.appendChild(strip);
    return (f) => {
      if (bigMedia) applyBannerFocusStyle(bigMedia, f);
      // The token fallback keeps the frame the banner already gave it.
      if (media && editable) applyBannerFocusStyle(media, f, { skew: 12, flip: enemy });
    };
  })();

  const state = { ...focus };
  const apply = () => paint(state);

  const mkRow = (key, label, min, max, step) => {
    const row = document.createElement("div"); row.className = "ifc-row" + (editable ? "" : " off");
    const lab = document.createElement("label"); lab.textContent = label;
    const input = document.createElement("input");
    input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(state[key]);
    const val = document.createElement("span"); val.className = "ifc-val";
    const fmt = () => { val.textContent = key === "zoom" ? `${Number(state[key]).toFixed(2)}×` : `${Math.round(state[key])}%`; };
    fmt();
    input.addEventListener("input", () => { state[key] = Number(input.value); fmt(); apply(); });
    row.__sync = () => { input.value = String(state[key]); fmt(); };
    row.append(lab, input, val);
    return row;
  };
  const rowX = mkRow("x", "X", 0, 100, 1);
  const rowY = mkRow("y", "Y", 0, 100, 1);
  const rowZ = mkRow("zoom", "Zoom", 1, 6, 0.05);

  // Drag on the BIG preview to pan the focal point (grab-and-pan: the sprite
  // follows the cursor). Same effect as the X/Y sliders — keeps state + both
  // previews + the slider rows in sync. Delta is divided by zoom so higher
  // magnification pans proportionally finer.
  if (editable) (() => {
    let dragging = false, sx = 0, sy = 0, startX = 0, startY = 0;
    big.style.cursor = "grab";
    big.style.touchAction = "none";
    big.addEventListener("pointerdown", (ev) => {
      dragging = true; sx = ev.clientX; sy = ev.clientY; startX = state.x; startY = state.y;
      big.style.cursor = "grabbing";
      try { big.setPointerCapture(ev.pointerId); } catch (_e) {}
      ev.preventDefault();
    });
    big.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const r = big.getBoundingClientRect();
      const z = Math.max(0.001, Number(state.zoom) || 1);
      const dxPct = ((ev.clientX - sx) / r.width) * 100 / z;
      const dyPct = ((ev.clientY - sy) / r.height) * 100 / z;
      state.x = Math.min(100, Math.max(0, startX - dxPct));
      state.y = Math.min(100, Math.max(0, startY - dyPct));
      rowX.__sync(); rowY.__sync();
      apply();
    });
    const end = (ev) => {
      if (!dragging) return;
      dragging = false; big.style.cursor = "grab";
      try { big.releasePointerCapture(ev.pointerId); } catch (_e) {}
    };
    big.addEventListener("pointerup", end);
    big.addEventListener("pointercancel", end);
    // Mouse wheel over the big preview = zoom (scroll up → in, down → out).
    // passive:false so we can preventDefault the page scroll.
    big.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const step = 0.15;
      const dir = ev.deltaY < 0 ? 1 : -1;
      state.zoom = Math.min(6, Math.max(1, (Number(state.zoom) || 1) + dir * step));
      rowZ.__sync();
      apply();
    }, { passive: false });
  })();

  const btns = document.createElement("div"); btns.className = "ifc-btns";
  const off = editable ? "" : " off";
  const reset = document.createElement("div"); reset.className = "ifc-btn reset" + off; reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    Object.assign(state, defaults);
    rowX.__sync(); rowY.__sync(); rowZ.__sync(); apply();
  });
  const save = document.createElement("div"); save.className = "ifc-btn save" + off; save.textContent = "Save";
  save.addEventListener("click", async () => {
    try {
      await baseActor.setFlag(MODULE_ID, flagKey, { x: Math.round(state.x), y: Math.round(state.y), zoom: Number(state.zoom) });
      if (banner) {
        ui.notifications?.info(`Saved turn-banner framing for ${baseActor.name} (all copies).`);
        return;
      }
      // Refresh the live turn-action tracker if a battle is running.
      try { globalThis.FUCompanion?.api?.experimental?.battleDirector?.refreshTurnActions?.(); } catch (_e) {}
      ui.notifications?.info(`Saved icon focal for ${baseActor.name} (all copies).`);
    } catch (e) {
      warn("icon-focus-tuner: save failed", e);
      ui.notifications?.error("Focal tuner: save failed (see console).");
    }
  });
  btns.append(reset, save);

  const hint = document.createElement("div"); hint.className = "ifc-hint";
  hint.textContent = banner
    ? "Drag to pan, scroll to zoom. Frames the portrait in the turn banner."
    : "Drag to pan, scroll to zoom. Tune during a battle to frame the battle sprite.";

  const body = [head, modes];
  if (!editable) {
    const note = document.createElement("div"); note.className = "ifc-note";
    note.textContent = "No portrait of its own, so the turn banner shows this token, framed like its round-bar icon. Set that framing on the Round bar icon tab.";
    body.push(note);
  }
  panel.append(...body, previews, rowX, rowY, rowZ, btns, hint);
  document.body.appendChild(panel);
  apply();
}
