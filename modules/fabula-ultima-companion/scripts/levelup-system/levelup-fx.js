/**
 * Level-up window — sound and motion.
 *
 * Audio goes through the Battle Director's `playSfx`, which already solves the
 * awkward parts: it fetches each cue as a full GET (a Range request trips the
 * Forge `.wav` 206 decode bug), caches the decoded buffer so the first play of
 * a session has no hitch, and resumes a suspended AudioContext. Playback is
 * LOCAL only — this window is one player's own interaction and has no business
 * on anyone else's speakers.
 *
 * Motion is WAAPI and CSS rather than Sequencer/PIXI: everything here is DOM,
 * so there is no canvas to hang effects off, and the particle burst has to sit
 * over an HTML row.
 */

import { playSfx, preloadSfx } from "../battle-director/director-sfx.js";

const BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const SFX = Object.freeze({
  tab:        BASE + "BattleCursor_1.wav",
  toggle:     BASE + "BattleCursor_2.wav",
  cursor:     BASE + "BattleCursor_4.wav",
  open:       BASE + "bond_start.wav",
  close:      BASE + "bond_cleared.wav",
  levelUp:    BASE + "skill_levelUp.wav",
  levelDown:  BASE + "skill_levelDown.wav",
});

const VOL = Object.freeze({
  tab: 0.5, toggle: 0.5, cursor: 0.35, open: 0.6, close: 0.55,
  levelUp: 0.75, levelDown: 0.55,
});

/** Warm every cue so the first click of a session is not the slow one. */
export const preloadLevelUpSfx = () => preloadSfx(Object.values(SFX));

export function sfx(name) {
  const url = SFX[name];
  if (url) playSfx(url, VOL[name] ?? 0.5);
}

// Hover fires on every row the cursor crosses, which on a long list is a
// machine-gun. One blip per element, and never twice for the same one.
let _lastHover = null;
export function hoverSfx(el) {
  if (!el || el === _lastHover) return;
  _lastHover = el;
  sfx("cursor");
}
export const resetHover = () => { _lastHover = null; };

// ── motion ────────────────────────────────────────────────────────────────

const reduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/**
 * Stagger a list of rows in, or out.
 *
 * `dir: "in"` slides left→right; `"out"` reverses. Returns the total duration
 * so a caller can wait for an exit before swapping content, capped so a
 * seventeen-row Facet list does not become a loading screen.
 */
export function staggerRows(rows, dir = "in") {
  const list = Array.from(rows ?? []);
  if (!list.length || reduced()) return 0;

  const step = Math.min(26, 200 / Math.max(1, list.length));
  const dur = dir === "in" ? 210 : 150;

  list.forEach((el, i) => {
    const from = dir === "in"
      ? [{ opacity: 0, transform: "translateX(-22px)" }, { opacity: 1, transform: "none" }]
      : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(22px)" }];
    el.animate(from, {
      duration: dur,
      delay: i * step,
      easing: dir === "in" ? "cubic-bezier(.2,.8,.3,1)" : "cubic-bezier(.5,0,.8,.4)",
      fill: "both",
    });
  });

  return dur + (list.length - 1) * step;
}

/** Scale + fade the window itself. Resolves when the animation finishes. */
export function windowAnim(panel, dir = "in") {
  if (!panel || reduced()) return Promise.resolve();
  const frames = dir === "in"
    ? [{ opacity: 0, transform: "scale(.92)" }, { opacity: 1, transform: "scale(1)" }]
    : [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.94)" }];
  const a = panel.animate(frames, {
    duration: dir === "in" ? 190 : 150,
    easing: dir === "in" ? "cubic-bezier(.2,.9,.3,1)" : "cubic-bezier(.4,0,.9,.4)",
    fill: "both",
  });
  return a.finished.catch(() => {});
}

/**
 * Celebrate a row that just gained a level.
 *
 * Particles are positioned fixed against the viewport rather than parented to
 * the row: a row lives inside an `overflow: auto` list, which would clip any
 * child that tried to fly out of it.
 */
export function burst(el, { kind = "up" } = {}) {
  if (!el || reduced()) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;

  const up = kind === "up";
  const tints = up ? ["#ffd479", "#fff3c4", "#b6f08a", "#ffffff"] : ["#c9a3a3", "#e6d6d6"];
  const n = up ? 16 : 8;

  // A soft sweep across the row reads as "this one changed" even if the
  // particles are missed.
  const glow = document.createElement("div");
  glow.className = "lu-fx-glow";
  Object.assign(glow.style, {
    left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    background: up
      ? "linear-gradient(90deg, rgba(255,212,121,0) 0%, rgba(255,212,121,.55) 50%, rgba(255,212,121,0) 100%)"
      : "linear-gradient(90deg, rgba(160,120,120,0) 0%, rgba(160,120,120,.4) 50%, rgba(160,120,120,0) 100%)",
  });
  document.body.appendChild(glow);
  glow.animate(
    [{ opacity: 0, transform: "translateX(-40%)" }, { opacity: 1, offset: 0.4 }, { opacity: 0, transform: "translateX(40%)" }],
    { duration: 620, easing: "ease-out", fill: "both" }
  ).finished.catch(() => {}).finally(() => glow.remove());

  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "lu-fx-p";
    const size = 3 + Math.random() * 4;
    Object.assign(p.style, {
      left: `${r.left + r.width * (0.25 + Math.random() * 0.6)}px`,
      top: `${r.top + r.height * (0.3 + Math.random() * 0.5)}px`,
      width: `${size}px`, height: `${size}px`,
      background: tints[(Math.random() * tints.length) | 0],
    });
    document.body.appendChild(p);

    const dx = (Math.random() - 0.5) * 130;
    const dy = up ? -(30 + Math.random() * 70) : (20 + Math.random() * 45);
    p.animate(
      [
        { opacity: 1, transform: "translate(0,0) scale(1)" },
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${up ? 0.3 : 0.6})` },
      ],
      { duration: 480 + Math.random() * 380, easing: "cubic-bezier(.15,.7,.3,1)", fill: "both" }
    ).finished.catch(() => {}).finally(() => p.remove());
  }
}

export const FX_CSS = `
.lu-fx-p { position: fixed; z-index: 100000; border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 6px currentColor; }
.lu-fx-glow { position: fixed; z-index: 99999; pointer-events: none; border-radius: 8px;
  mix-blend-mode: screen; }
`;
