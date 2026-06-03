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

import { log, warn } from "./logger.js";
import { isVideoSrc, applyIconFocusStyle, normalizeIconFocus, ICON_FOCUS_DEFAULT } from "./director-round-banner.js";
import { registerDevTool, devToolsAnchorBottom } from "./dev-tools-menu.js";

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
    registerDevTool({ id: "icon-focus", icon: "🎯", label: "Icon Adjuster", onClick: openPanel });
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

function openPanel() {
  document.getElementById(PANEL_ID)?.remove();

  const tok = resolveToken();
  if (!tok) { ui.notifications?.warn("Focal tuner: select (or target) a token first."); return; }
  // Save/read on the BASE (world) actor so the focal applies to EVERY copy of a
  // monster, not just this token. For unlinked tokens `tok.actor` is a synthetic
  // per-token actor; the world actor is game.actors.get(token.actorId). Linked
  // tokens resolve to the same document either way.
  const baseActor = game.actors?.get?.(tok.document?.actorId) ?? tok.actor;
  if (!baseActor) { ui.notifications?.warn("Focal tuner: that token has no actor."); return; }
  const src = tok.document?.texture?.src ?? baseActor.img ?? null;
  const focus = normalizeIconFocus(baseActor.getFlag?.(MODULE_ID, FLAG));

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  // Anchor just above the Developer Tools launcher (clear of the Players list).
  try { panel.style.bottom = `${devToolsAnchorBottom()}px`; } catch (_e) {}

  const head = document.createElement("div"); head.className = "ifc-head";
  const title = document.createElement("div"); title.className = "ifc-title";
  title.textContent = `🎯 Focal — ${baseActor.name ?? "Token"}`;
  const close = document.createElement("div"); close.className = "ifc-close"; close.textContent = "✕";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);

  // Previews — big (tuning) + small (actual icon size).
  const previews = document.createElement("div"); previews.className = "ifc-previews";
  const big = document.createElement("div"); big.className = "ifc-circle big";
  const small = document.createElement("div"); small.className = "ifc-circle small";
  const bigMedia = buildMedia(src);
  const smallMedia = buildMedia(src);
  big.appendChild(bigMedia); small.appendChild(smallMedia);
  previews.append(big, small);

  const state = { ...focus };
  const apply = () => { applyIconFocusStyle(bigMedia, state); applyIconFocusStyle(smallMedia, state); };

  const mkRow = (key, label, min, max, step) => {
    const row = document.createElement("div"); row.className = "ifc-row";
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

  const btns = document.createElement("div"); btns.className = "ifc-btns";
  const reset = document.createElement("div"); reset.className = "ifc-btn reset"; reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    Object.assign(state, ICON_FOCUS_DEFAULT);
    rowX.__sync(); rowY.__sync(); rowZ.__sync(); apply();
  });
  const save = document.createElement("div"); save.className = "ifc-btn save"; save.textContent = "Save";
  save.addEventListener("click", async () => {
    try {
      await baseActor.setFlag(MODULE_ID, FLAG, { x: Math.round(state.x), y: Math.round(state.y), zoom: Number(state.zoom) });
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
  hint.textContent = "Tune during a battle to frame against the battle sprite.";

  panel.append(head, previews, rowX, rowY, rowZ, btns, hint);
  document.body.appendChild(panel);
  apply();
}
