// SFX Audition tool — a floating GM button that opens a panel of candidate
// UI sounds (hover / click / back), each auditionable on click. Also previews
// a sound on row-hover (toggleable) so you can feel a "hover" cue in context
// before committing it to the real menus.
//
// All cues live on the same Forge bucket the rest of the module uses; every
// entry here is a file already referenced somewhere in the codebase, so they
// are known-good URLs. Playback goes through director-sfx's Web Audio path
// (`playSfx`) — local-only (auditioning shouldn't broadcast to players) and
// instant after first decode.
//
// Not a manifest entry: this module is imported by director-boot.js (an
// existing esmodule) and initialised from its ready hook, so it loads on a
// normal reload with no Setup-relaunch.

import { log, warn } from "./logger.js";
import { playSfx } from "./director-sfx.js";
import { registerDevTool, devToolsAnchorBottom, devToolsAnchorLeft } from "./dev-tools-menu.js";

const FORGE_SOUND_BASE =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

// Build an absolute, properly-encoded URL from a bucket-relative path.
// encodeURI keeps the "/" separators and only encodes spaces / specials.
const soundUrl = (relPath) => FORGE_SOUND_BASE + encodeURI(relPath);

// Curated candidates, grouped by the role you'd most likely use them for.
// `note` is a short flavor hint shown in the row. The legacy menus used
// BattleCursor_4 (hover) + switch_mode (open/click); both are flagged.
const GROUPS = [
  {
    title: "Hover — light cursor blips",
    hint: "Short, quiet ticks for mouse-enter on a button / menu item.",
    items: [
      { path: "BattleCursor_1.wav", note: "soft tick" },
      { path: "BattleCursor_2.wav", note: "tick (variant)" },
      { path: "BattleCursor_4.wav", note: "legacy hover" },
      { path: "Soundboard/Cursor1.ogg", note: "dialog cursor" },
      { path: "CursorMove.mp3", note: "roulette cursor" },
      { path: "System_Tick.mp3", note: "dry tick" },
    ],
  },
  {
    title: "Click — select / confirm",
    hint: "Punchier cues for an actual button press / commit.",
    items: [
      { path: "switch_mode.wav", note: "legacy open / turn-enter" },
      { path: "check_start.wav", note: "crisp select" },
      { path: "Flash2.ogg", note: "snappy confirm" },
      { path: "success_3.wav", note: "positive blip" },
      { path: "success_4.wav", note: "positive blip 2" },
      { path: "success2.ogg", note: "chime" },
      { path: "Soundboard/SE_SYS_Upgrade_New_success2.ogg", note: "upgrade ding" },
      { path: "participant_enter.wav", note: "enter cue" },
      { path: "Soundboard/Item3.ogg", note: "item select" },
      { path: "Soundboard/Book1.ogg", note: "page / open" },
      { path: "Soundboard/Up4.ogg", note: "up step" },
    ],
  },
  {
    title: "Back — cancel / negative",
    hint: "For closing a menu, cancel, or an unavailable action.",
    items: [
      { path: "Soundboard/Buzzer2.ogg", note: "buzzer / reject" },
      { path: "failed_1.wav", note: "soft fail" },
      { path: "Soundboard/Down2.ogg", note: "down step" },
      { path: "participant_exit.wav", note: "exit cue" },
    ],
  },
];

const CFG = {
  gmOnly: true,
  offsetLeftPx: 16,
  offsetBottomPx: 16,
  sizePx: 46,
  btnZIndex: 81,
  panelZIndex: 100002, // above the round banner (100000) so it's never hidden
  iconText: "🔊",
  tipLabel: "SFX Audition",
};

const DOM = {
  BTN_ID: "fud-sfxaudition-btn",
  PANEL_ID: "fud-sfxaudition-panel",
  STYLE_ID: "fud-sfxaudition-style",
};

let _booted = false;

export function initSfxAudition() {
  try {
    if (_booted) return;
    if (CFG.gmOnly && !game.user?.isGM) return;
    ensureStyle();
    // Bundled under the Developer Tools launcher instead of its own button.
    registerDevTool({ id: "sfx-audition", icon: "🔊", label: "SFX Checker", onClick: togglePanel });
    _booted = true;
    log("sfx-audition: registered as dev tool");
  } catch (e) {
    warn("initSfxAudition threw", e);
  }
}

function ensureStyle() {
  if (document.getElementById(DOM.STYLE_ID)) return;
  const css = `
#${DOM.BTN_ID} {
  position: fixed; left: ${CFG.offsetLeftPx}px; bottom: ${CFG.offsetBottomPx}px;
  width: ${CFG.sizePx}px; height: ${CFG.sizePx}px; z-index: ${CFG.btnZIndex};
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; cursor: pointer; user-select: none;
  background: radial-gradient(circle at 35% 30%, #3a3f4b, #1b1e25);
  color: #ffe9a8; font-size: 20px;
  border: 1px solid rgba(255,224,134,.35);
  box-shadow: 0 3px 10px rgba(0,0,0,.45);
  transition: transform .12s ease, box-shadow .12s ease;
}
#${DOM.BTN_ID}:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.55); }
#${DOM.PANEL_ID} {
  position: fixed; left: ${CFG.offsetLeftPx}px; bottom: ${CFG.offsetBottomPx + CFG.sizePx + 10}px;
  z-index: ${CFG.panelZIndex}; width: 340px; max-height: 70vh; overflow-y: auto;
  background: linear-gradient(180deg, rgba(24,26,32,.98), rgba(16,18,22,.98));
  color: #e8eaf0; border: 1px solid rgba(255,224,134,.30); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 10px 12px 14px;
  font: 12px "Signika", system-ui, sans-serif;
}
#${DOM.PANEL_ID} .sfx-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
#${DOM.PANEL_ID} .sfx-title { font-weight: 800; font-size: 14px; color: #ffe9a8; letter-spacing: .02em; }
#${DOM.PANEL_ID} .sfx-close { cursor: pointer; opacity: .7; font-size: 16px; padding: 2px 6px; border-radius: 6px; }
#${DOM.PANEL_ID} .sfx-close:hover { opacity: 1; background: rgba(255,255,255,.08); }
#${DOM.PANEL_ID} .sfx-controls { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,.08); }
#${DOM.PANEL_ID} .sfx-controls label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; opacity: .9; }
#${DOM.PANEL_ID} .sfx-controls input[type=range] { width: 90px; }
#${DOM.PANEL_ID} .sfx-group-title { font-weight: 700; color: #cfe0ff; margin: 10px 0 3px; font-size: 12px; }
#${DOM.PANEL_ID} .sfx-group-hint { opacity: .55; font-size: 10.5px; margin-bottom: 5px; }
#${DOM.PANEL_ID} .sfx-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent;
}
#${DOM.PANEL_ID} .sfx-row:hover { background: rgba(127,160,255,.12); border-color: rgba(127,160,255,.30); }
#${DOM.PANEL_ID} .sfx-play { flex: 0 0 auto; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: rgba(255,224,134,.16); color: #ffe9a8; font-size: 11px; }
#${DOM.PANEL_ID} .sfx-name { flex: 1 1 auto; font-weight: 600; }
#${DOM.PANEL_ID} .sfx-note { flex: 0 0 auto; opacity: .55; font-size: 10.5px; font-style: italic; }
#${DOM.PANEL_ID} .sfx-tag { font-size: 9px; font-weight: 800; color: #1b1e25; background: #ffe9a8; border-radius: 999px; padding: 1px 5px; margin-left: 6px; }
`.trim();
  const style = document.createElement("style");
  style.id = DOM.STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// Shared playback state for the panel (volume + hover-preview toggle).
const _state = { vol: 0.6, previewOnHover: true, lastHover: 0 };

function togglePanel() {
  const existing = document.getElementById(DOM.PANEL_ID);
  if (existing) { existing.remove(); return; }
  buildPanel();
}

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = DOM.PANEL_ID;
  // Anchor just above the Players list and to the RIGHT of the launcher column
  // so it never covers the dev-tools buttons.
  try { panel.style.bottom = `${devToolsAnchorBottom()}px`; } catch (_e) {}
  try { panel.style.left = `${devToolsAnchorLeft()}px`; } catch (_e) {}

  // Header
  const head = document.createElement("div");
  head.className = "sfx-head";
  const title = document.createElement("div");
  title.className = "sfx-title";
  title.textContent = "🔊 SFX Audition";
  const close = document.createElement("div");
  close.className = "sfx-close";
  close.textContent = "✕";
  close.title = "Close";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);
  panel.append(head);

  // Controls: hover-preview toggle + volume.
  const controls = document.createElement("div");
  controls.className = "sfx-controls";

  const hoverLabel = document.createElement("label");
  const hoverCb = document.createElement("input");
  hoverCb.type = "checkbox";
  hoverCb.checked = _state.previewOnHover;
  hoverCb.addEventListener("change", () => { _state.previewOnHover = hoverCb.checked; });
  hoverLabel.append(hoverCb, document.createTextNode("Preview on hover"));

  const volLabel = document.createElement("label");
  const vol = document.createElement("input");
  vol.type = "range"; vol.min = "0"; vol.max = "1"; vol.step = "0.05"; vol.value = String(_state.vol);
  vol.addEventListener("input", () => { _state.vol = Number(vol.value) || 0; });
  volLabel.append(document.createTextNode("Vol"), vol);

  controls.append(hoverLabel, volLabel);
  panel.append(controls);

  // Groups + rows.
  for (const group of GROUPS) {
    const gt = document.createElement("div");
    gt.className = "sfx-group-title";
    gt.textContent = group.title;
    panel.append(gt);

    if (group.hint) {
      const gh = document.createElement("div");
      gh.className = "sfx-group-hint";
      gh.textContent = group.hint;
      panel.append(gh);
    }

    for (const item of group.items) {
      const url = soundUrl(item.path);
      const row = document.createElement("div");
      row.className = "sfx-row";
      row.title = url;

      const play = document.createElement("div");
      play.className = "sfx-play";
      play.textContent = "▶";

      const name = document.createElement("div");
      name.className = "sfx-name";
      name.textContent = item.path;
      if (/legacy/i.test(item.note ?? "")) {
        const tag = document.createElement("span");
        tag.className = "sfx-tag";
        tag.textContent = "LEGACY";
        name.append(tag);
      }

      const note = document.createElement("div");
      note.className = "sfx-note";
      note.textContent = item.note ?? "";

      row.append(play, name, note);
      row.addEventListener("click", () => playSfx(url, _state.vol));
      row.addEventListener("mouseenter", () => {
        if (!_state.previewOnHover) return;
        // light throttle so a fast drag across rows doesn't machine-gun
        const now = (window.performance?.now?.() ?? 0);
        if (now - _state.lastHover < 90) return;
        _state.lastHover = now;
        playSfx(url, _state.vol);
      });

      panel.append(row);
    }
  }

  document.body.appendChild(panel);
}
