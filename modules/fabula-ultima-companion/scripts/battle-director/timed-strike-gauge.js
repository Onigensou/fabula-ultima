// timed-strike-gauge.js — the trigger gauge for `timed_strikes` moves
// (Lionheart's Renzokuken, 2026-11-21; look + timing from the approved mockup
// E:\Art(New Com)\DND\Fabula Ultima\Resource\Animation\Lionheart\lionheart-mockup.html v4).
//
// Before each strike a needle sweeps the bar once (650 ms by default). The FIRST
// press (Z / Space / click on the bar) is judged: inside the TRIGGER zone
// (70-92 % of the bar by default) = a TRIGGER.
//
// Where the press is judged — the Midnight Oil / fishing-bar pattern: the GM
// broadcasts OPEN, the ACTING PLAYER's client runs the sweeps on its own clock
// (performance.now) and judges every press locally, streams each strike back
// (STRIKE) and finally submits RESULT; the GM's resolver waits with a timeout and
// fills any strike it never heard with the automatic path. Every other client
// (GM included) shows a read-only mirror driven by SWEEP / STRIKE / DONE.
//
// The automatic path (no active player client, the player left, or the sim):
// each strike is a TRIGGER at a fixed rate (70 %), see timed-strikes-rules.autoPress.
//
// The HUD here is the mockup's gauge; the cinematic (camera, dim, slashes, the
// Lion Heart finisher) is timed-strike-cinematic.js, which listens to
// `Hooks.callAll("fuTimedStrikeGauge", { phase, requestId, i, hit, ... })`. That
// hook fires on every client at open / sweep / strike / finisher / done / close,
// so the presenter never touches the judge. The presentation beats the GM holds
// for (TSG_TIMING) are FIXED: the GM never waits on any client's animation.

import { log, warn } from "./logger.js";
import { judgePress, autoPress } from "./timed-strikes-rules.js";
import { playSfx } from "./director-sfx.js";

const CHANNEL = "module.fabula-ultima-companion";
const NS = "timed-strike-gauge";
const STYLE_ID = "fu-tsg-style";

// Presentation timing (approved mockup v4, Lionheart/Renzokuken). The GM holds these
// fixed beats when presentation is on; the sim batch (presentation off) skips them.
//   introMs        — the cinematic's intro before the HUD shows: the camera hand-over (the 3D
//                    camera eases to neutral, up to ~600 ms) + the mockup's power-up light and
//                    dash (900 + 520 + 250 ms), so the gauge opens after the dash as in the mockup
//   leadMs         — HUD on screen → first sweep (unchanged from the engine build)
//   finisherLeadMs — FINISHER → the finisher's damage (its wind-up lands on the hit)
//   closeDelayMs   — DONE → the HUD leaves (the mockup closes it once the camera is home)
//   tailMs         — DONE → the action moves on (the restore has played out);
//                    finisherTailMs more after a finisher (its afterglow plays first)
export const TSG_TIMING = Object.freeze({ introMs: 2300, leadMs: 450, finisherLeadMs: 1200, closeDelayMs: 1850, tailMs: 2100, finisherTailMs: 1000 });
const SND = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";
// the mockup's gauge cues (its sfx(key, vol) plays at vol × 0.75)
export const TSG_SFX = Object.freeze({ cursor: [SND + "BattleCursor_1.wav", 0.2 * 0.75], back: [SND + "Cursor_Back.mp3", 0.3 * 0.75] });
const cue = (k) => { try { const c = TSG_SFX[k]; if (c) playSfx(c[0], c[1]); } catch (_) {} };

const now = () => (globalThis.performance?.now?.() ?? Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (event, payload) => {
  try { game.socket?.emit(CHANNEL, { ns: NS, event, payload: { ...payload, fromUserId: game.user?.id ?? null } }); }
  catch (e) { warn("timed-strike-gauge: emit failed", e); }
};
const hook = (phase, data) => { try { Hooks.callAll("fuTimedStrikeGauge", { phase, ...data }); } catch (_) {} };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── HUD ──────────────────────────────────────────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
.fu-tsg { position: fixed; left: 50%; bottom: 190px; width: 500px; max-width: calc(100vw - 32px); box-sizing: border-box; z-index: 1000;
  padding: 10px 14px; pointer-events: auto; transform: translate(-50%, 12px); opacity: 0;
  background: linear-gradient(180deg, #f6f1e6, #ebe3d0); border: 2px solid #7a6a55; border-radius: 12px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset, 0 8px 22px rgba(0,0,0,.42);
  font-family: "Inter", "Signika", "Segoe UI", system-ui, sans-serif; color: #3a3228;
  transition: opacity 200ms ease, transform 260ms cubic-bezier(.2,.8,.2,1); }
.fu-tsg::before { content: ""; position: absolute; inset: 4px; pointer-events: none; border: 1px solid #d5b67a; border-radius: 8px; }
.fu-tsg.on { opacity: 1; transform: translate(-50%, 0); }
.fu-tsg.anchored { bottom: auto; transform: translateY(12px); }
.fu-tsg.anchored.on { transform: none; }
.fu-tsg-head { display: flex; align-items: center; gap: 8px; }
.fu-tsg-icon { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; box-shadow: 0 0 0 2px #b7935a; border: 0; }
.fu-tsg-title { font: 900 11px "Inter", "Signika", sans-serif; letter-spacing: .16em; text-transform: uppercase; color: #7a6a55; }
.fu-tsg-res { font: 900 15px "Inter", "Signika", sans-serif; letter-spacing: .08em; color: #c2410c; }
.fu-tsg.done .fu-tsg-res { animation: fuTsgPop 380ms cubic-bezier(.2,1.5,.4,1); }
.fu-tsg.perfect .fu-tsg-res { color: #b8860b; text-shadow: 0 0 8px rgba(255,210,90,.8); }
@keyframes fuTsgPop { 0% { transform: scale(.4); } 70% { transform: scale(1.15); } 100% { transform: scale(1); } }
.fu-tsg-pips { display: flex; gap: 9px; margin-left: auto; padding-right: 4px; }
.fu-tsg-pip { display: block; width: 15px; height: 10px; background: #15110c; box-shadow: inset 0 0 0 1px rgba(122,106,85,.9); }
.fu-tsg-pip.now { box-shadow: inset 0 0 0 2px #b7935a, 0 0 6px rgba(213,182,122,.9); animation: fuTsgBlink 500ms steps(2) infinite; }
@keyframes fuTsgBlink { 50% { background: rgba(120,130,255,.75); } }
.fu-tsg-pip.hit { background: linear-gradient(180deg, #fff0a8, #ffb21e 60%, #c86a08); box-shadow: 0 0 8px rgba(255,190,60,.9), inset 0 0 0 1px #fff3c0; }
.fu-tsg-pip.miss { background: #4a4440; box-shadow: inset 0 0 0 1px #2a2420; }
.fu-tsg-track { position: relative; height: 30px; margin-top: 8px; border-radius: 3px; overflow: hidden; cursor: pointer;
  background: linear-gradient(180deg, #05060c, #10132a 55%, #05060c);
  box-shadow: inset 0 2px 5px rgba(0,0,0,.9), 0 0 0 1px rgba(122,106,85,.95), 0 0 0 3px rgba(213,182,122,.45); transition: box-shadow 120ms ease; }
.fu-tsg-track::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: repeating-linear-gradient(180deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px); }
.fu-tsg-trail { position: absolute; left: 0; top: 5px; bottom: 5px; width: 0; z-index: 1; border-radius: 2px 0 0 2px;
  background: linear-gradient(90deg, rgba(75,72,214,0), rgba(110,118,255,.55) 55%, rgba(190,200,255,.95)); box-shadow: 0 0 10px rgba(110,120,255,.5); transition: opacity 160ms ease; }
.fu-tsg-zone { position: absolute; top: 0; bottom: 0; display: grid; place-items: center; background: linear-gradient(180deg, #3a3630, #22201c 55%, #141210); box-shadow: inset 0 0 0 2px rgba(213,182,122,.75); }
.fu-tsg-zone span { font: 900 10px "Inter", "Signika", sans-serif; letter-spacing: .24em; text-transform: uppercase; color: #e9cf8e; text-shadow: 0 1px 0 #000; white-space: nowrap; }
.fu-tsg-needle { position: absolute; left: 0; top: -2px; bottom: -2px; width: 6px; margin-left: -3px; border-radius: 2px; background: #fff; z-index: 2;
  box-shadow: 0 0 6px 2px rgba(220,226,255,1), 0 0 16px 5px rgba(130,140,255,.85); transition: opacity 160ms ease; }
.fu-tsg-needle.off, .fu-tsg-trail.off { opacity: .35; }
.fu-tsg-track.hit { box-shadow: inset 0 2px 5px rgba(0,0,0,.6), 0 0 0 2px #ffe07a, 0 0 0 4px #c98a1c, 0 0 22px 6px rgba(255,200,80,.9); animation: fuTsgTrig 300ms ease-out; }
.fu-tsg-track.hit .fu-tsg-trail.off { opacity: .9; background: linear-gradient(90deg, rgba(224,154,30,0), rgba(255,200,80,.6) 55%, #fff3c0); box-shadow: 0 0 12px rgba(255,200,80,.85); }
.fu-tsg-track.hit .fu-tsg-zone { background: linear-gradient(180deg, #fff6c8, #ffc844 55%, #e08a10); box-shadow: inset 0 0 0 2px #fff; }
.fu-tsg-track.hit .fu-tsg-zone span { color: #6a2a00; text-shadow: none; }
.fu-tsg-track.hit .fu-tsg-zone span::after { content: "!"; }
@keyframes fuTsgTrig { 0% { filter: brightness(2.2); } 100% { filter: brightness(1); } }
.fu-tsg-track.miss .fu-tsg-needle { background: #6e6a74; box-shadow: none; }
.fu-tsg-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 6px; font: 700 11px "Inter", "Signika", sans-serif; color: #6a5d4c; }
.fu-tsg-foot kbd { font: 800 10px "Inter", sans-serif; padding: 0 5px; border-radius: 3px; border: 1px solid #7a6a55; background: #fffaf0; color: #3a3228; }
.fu-tsg-tot { font: 800 13px "Inter", "Signika", sans-serif; color: #3a3228; font-variant-numeric: tabular-nums; }
`;
  document.head.appendChild(st);
}

// One HUD per gauge run. `interactive` = this client judges presses.
class GaugeHud {
  constructor({ title, icon, count, zone, interactive, actorName, showAfterMs = 0 }) {
    ensureStyle();
    this.count = count; this.zone = zone; this.interactive = interactive;
    this.press = null; this.armed = false; this.rafId = null; this.flashT = null;
    const el = document.createElement("div");
    el.className = "fu-tsg";
    el.innerHTML = `<div class="fu-tsg-head">${icon ? `<img class="fu-tsg-icon" src="${esc(icon)}" alt="">` : ""}<span class="fu-tsg-title">${esc(title || "Timed strikes")}</span><span class="fu-tsg-res"></span><span class="fu-tsg-pips">${Array.from({ length: count }, () => `<i class="fu-tsg-pip"></i>`).join("")}</span></div>
      <div class="fu-tsg-track"><div class="fu-tsg-trail"></div><div class="fu-tsg-zone"><span>Trigger</span></div><div class="fu-tsg-needle"></div></div>
      <div class="fu-tsg-foot"><span class="fu-tsg-hint">${interactive ? `Press <kbd>Z</kbd> <kbd>Space</kbd> or click inside <b>TRIGGER</b>` : esc(actorName ? `${actorName}'s timing` : "")}</span><span class="fu-tsg-tot"></span></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.q = (s) => el.querySelector(s);
    const zoneEl = this.q(".fu-tsg-zone");
    zoneEl.style.left = `${zone[0] * 100}%`; zoneEl.style.width = `${(zone[1] - zone[0]) * 100}%`;
    if (interactive) {
      this._onKey = (e) => {
        if (!this.armed) return;
        const k = e.key;
        if (k === " " || k === "z" || k === "Z" || e.code === "Space" || e.code === "KeyZ") {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!e.repeat) this._press();
        }
      };
      window.addEventListener("keydown", this._onKey, true);
      this.q(".fu-tsg-track").addEventListener("pointerdown", (e) => { if (this.armed) { e.preventDefault(); this._press(); } });
    }
    this._place = () => this.place();
    window.addEventListener("resize", this._place);
    this.place();
    // hidden through the cinematic's intro, then it slides in like the mockup's
    this.showT = setTimeout(() => { this.showT = null; this.place(); requestAnimationFrame(() => this.el?.classList.add("on")); }, Math.max(0, showAfterMs));
  }
  // On top of this client's plate when it has one (the mockup: right edge 10 px in,
  // 18 px above it), else the fixed bottom-centre spot (a GM / spectator with no plate).
  place() {
    const el = this.el; if (!el) return;
    const plate = document.querySelector(".dhud-plate-root");
    const r = plate?.getBoundingClientRect?.();
    if (r && r.width > 0 && r.height > 0) {
      el.classList.add("anchored");
      el.style.left = `${Math.max(16, Math.round(r.right - 10 - (el.offsetWidth || 500)))}px`;
      el.style.top = `${Math.max(8, Math.round(r.top - 18 - (el.offsetHeight || 96)))}px`;
    } else {
      el.classList.remove("anchored"); el.style.left = ""; el.style.top = "";
    }
  }
  _press() { if (this.armed && this.press == null) this.press = now(); }
  _draw(u) {
    const track = this.q(".fu-tsg-track"), needle = this.q(".fu-tsg-needle"), trail = this.q(".fu-tsg-trail");
    const TW = track.clientWidth || 470, x = u * TW, L = Math.min(x, 0.16 * TW);   // mockup v3: a 16 % comet tail
    needle.style.transform = `translateX(${x.toFixed(1)}px)`;
    trail.style.transform = `translateX(${(x - L).toFixed(1)}px)`; trail.style.width = `${L.toFixed(1)}px`;
  }
  _arm(i) {
    [...this.el.querySelectorAll(".fu-tsg-pip")].forEach((p, k) => p.classList.toggle("now", k === i));
    this.q(".fu-tsg-track").classList.remove("miss");
    this.q(".fu-tsg-needle").classList.remove("off"); this.q(".fu-tsg-trail").classList.remove("off");
    this._draw(0);
    cue("cursor");
  }
  // One sweep. interactive → the first press is judged; autoPos (0..1 | null) →
  // a scripted press; mirror (neither) → sweeps until mark() stops it.
  sweep(i, sweepMs, { autoPos } = {}) {
    this._arm(i);
    this._stopAt = null;
    this.press = null; this.armed = this.interactive;
    const t0 = now();
    return new Promise((res) => {
      const step = () => {
        if (!this.el) return res({ pos: null });
        const u = (now() - t0) / sweepMs;
        if (autoPos !== undefined && autoPos != null && this.press == null && u >= autoPos) this.press = t0 + autoPos * sweepMs;
        if (this._stopAt != null) { const p = this._stopAt; this._stopAt = null; this._draw(p ?? 1); return res({ pos: p }); }
        if (this.press != null || u >= 1) {
          const pos = this.press != null ? (this.press - t0) / sweepMs : null;
          this._draw(Math.min(1, pos ?? 1)); this.armed = false;
          return res({ pos });
        }
        this._draw(u); this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    });
  }
  // Mirror: stop the running sweep at `pos`.
  stopAt(pos) { this._stopAt = pos ?? 1; }
  mark(i, hit, total = null) {
    const pip = this.el?.querySelectorAll(".fu-tsg-pip")?.[i];
    if (pip) { pip.classList.remove("now"); pip.classList.add(hit ? "hit" : "miss"); }
    const track = this.q(".fu-tsg-track");
    track.classList.remove("hit"); void track.offsetWidth; track.classList.add(hit ? "hit" : "miss");
    clearTimeout(this.flashT); this.flashT = setTimeout(() => track?.classList.remove("hit"), 320);
    this.q(".fu-tsg-needle").classList.add("off"); this.q(".fu-tsg-trail").classList.add("off");
    if (!hit) cue("back");
    if (total != null) this.setTotal(total);
  }
  setTotal(total) { const t = this.q(".fu-tsg-tot"); if (t) t.textContent = total > 0 ? `${total} damage` : ""; }
  finish({ tier, hits, count, total }) {
    if (!this.el) return;
    // the mockup's result line: "N/6 TRIGGER", plus " · PERFECT" on a full set
    this.q(".fu-tsg-res").textContent = `${hits}/${count} TRIGGER${hits >= count ? " · PERFECT" : ""}`;
    if (total != null) this.setTotal(total);
    this.el.classList.add("done");
    if (hits >= count) this.el.classList.add("perfect");
  }
  close(delay = 0) {
    const el = this.el; if (!el) return;
    this.el = null; this.armed = false;
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.showT);
    if (this._place) window.removeEventListener("resize", this._place);
    if (this._onKey) window.removeEventListener("keydown", this._onKey, true);
    setTimeout(() => { el.classList.remove("on"); setTimeout(() => el.remove(), 300); }, delay);
  }
}

// ── Socket (every client) ────────────────────────────────────────────────────
const _runs = new Map();     // requestId → { hud, owner?: true }
const _gmWait = new Map();   // requestId → { onStrike(i, hit, pos), onResult(hits) }  (GM only)

async function ownerPlay(p) {
  const { requestId, spec } = p;
  const introMs = Math.max(0, Number(spec.introMs) || 0);
  const hud = new GaugeHud({ ...spec, interactive: true, showAfterMs: introMs });
  _runs.set(requestId, { hud, owner: true });
  hook("open", { requestId, owner: true, spec });
  const hits = [];
  await sleep(introMs + (spec.leadMs ?? TSG_TIMING.leadMs));   // the intro plays, then a beat to see the bar
  for (let i = 0; i < spec.count; i++) {
    if (!_runs.has(requestId)) return;   // GM closed it (timeout / battle stopped)
    emit("SWEEP", { requestId, i });
    hook("sweep", { requestId, i });
    const { pos } = await hud.sweep(i, spec.sweepMs);
    const hit = judgePress(pos, spec.zone);
    hits.push(hit);
    hud.mark(i, hit);
    emit("STRIKE", { requestId, i, hit, pos });
    hook("strike", { requestId, i, hit, pos });
    await sleep(spec.gapMs);
  }
  emit("RESULT", { requestId, hits });
}

function onSocket(data) {
  if (!data || data.ns !== NS) return;
  const p = data.payload ?? {};
  const me = game.user?.id;
  if (p.fromUserId && p.fromUserId === me) return;
  switch (data.event) {
    case "OPEN": {
      if (_runs.has(p.requestId)) return;
      if (p.ownerUserId && p.ownerUserId === me) { ownerPlay(p).catch((e) => warn("timed-strike-gauge: owner play threw", e)); return; }
      if (p.presentation === false) return;
      const hud = new GaugeHud({ ...p.spec, interactive: false, showAfterMs: Number(p.spec?.introMs) || 0 });
      hud._sweepMs = p.spec?.sweepMs ?? 650;
      _runs.set(p.requestId, { hud });
      hook("open", { requestId: p.requestId, owner: false, spec: p.spec });
      return;
    }
    case "SWEEP": {
      const r = _runs.get(p.requestId);
      if (r && !r.owner) r.hud.sweep(p.i, r.hud._sweepMs ?? 650).catch(() => {});
      hook("sweep", { requestId: p.requestId, i: p.i });
      return;
    }
    case "STRIKE": {
      const r = _runs.get(p.requestId);
      if (r && !r.owner) { r.hud.stopAt(p.pos ?? 1); r.hud.mark(p.i, !!p.hit, p.total ?? null); }
      hook("strike", { requestId: p.requestId, i: p.i, hit: !!p.hit, pos: p.pos });
      const w = game.user?.isGM ? _gmWait.get(p.requestId) : null;
      if (w && p.fromUserId === w.ownerUserId) w.onStrike(p.i, !!p.hit, p.pos ?? null);
      return;
    }
    case "RESULT": {
      const w = game.user?.isGM ? _gmWait.get(p.requestId) : null;
      if (w && p.fromUserId === w.ownerUserId) w.onResult(Array.isArray(p.hits) ? p.hits.map(Boolean) : []);
      return;
    }
    case "FINISHER": {
      hook("finisher", { requestId: p.requestId, label: p.label ?? null });
      return;
    }
    case "TOTAL": {
      const r = _runs.get(p.requestId);
      if (r) r.hud.setTotal(p.total);
      return;
    }
    case "DONE": {
      const r = _runs.get(p.requestId);
      if (r) r.hud.finish(p);
      hook("done", { requestId: p.requestId, tier: p.tier, hits: p.hits, total: p.total });
      return;
    }
    case "CLOSE": {
      const r = _runs.get(p.requestId);
      if (r) { r.hud.close(p.delay ?? 0); _runs.delete(p.requestId); }
      hook("close", { requestId: p.requestId, delay: p.delay ?? 0 });
      return;
    }
    default: return;
  }
}

Hooks.once("ready", () => {
  try { game.socket?.on(CHANNEL, onSocket); log("timed-strike-gauge: socket listener installed"); }
  catch (e) { warn("timed-strike-gauge: socket install failed", e); }
});

// ── GM entry ─────────────────────────────────────────────────────────────────
// Runs one gauge and calls `onStrike(i, hit)` (awaited, in order) as each strike
// is decided. Resolves { hits, judgedBy: "player" | "auto" | "mixed" }.
//   ownerUserId   — the acting player's user id (null → automatic path)
//   presentation  — false skips every HUD + delay (sim batch / no viewer)
//   spec          — { title, icon, actorName, count, sweepMs, zone, gapMs, autoRate,
//                     casterTokenId, targetTokenIds, sceneId, finisher (the cinematic's cast),
//                     introMs / leadMs / finisherLeadMs / closeDelayMs / tailMs (TSG_TIMING) }
// On the returned controller: `await finisher({ label })` right before the
// finisher's damage, then `await finish({ tier, total })` after it has landed
// (shows the result, closes, holds the restore tail).
export async function runTimedStrikeGauge({ ownerUserId = null, presentation = true, spec, onStrike, rng = Math.random }) {
  // A cast with a cinematic (the caster's token is known) holds its intro before the HUD;
  // resolved here so every client reads the same number from OPEN.
  spec = { ...spec, introMs: spec.introMs ?? (spec.casterTokenId ? TSG_TIMING.introMs : 0) };
  const requestId = foundry.utils?.randomID?.() ?? `tsg-${Date.now()}`;
  const count = spec.count;
  const hits = new Array(count).fill(null);
  let applied = 0, autoUsed = 0, playerUsed = 0;
  let chain = Promise.resolve();
  const decide = (i, hit, pos, by) => {
    if (i !== applied || hits[i] !== null || i >= count) return;
    hits[i] = !!hit; applied++;
    if (by === "auto") autoUsed++; else playerUsed++;
    chain = chain.then(() => onStrike(i, !!hit, pos)).catch((e) => warn("timed-strike-gauge: onStrike threw", e));
  };
  const ctl = { requestId, hud: null };

  // Automatic, no presentation (sim batch): decide all at once.
  if (!presentation) {
    for (let i = 0; i < count; i++) { const a = autoPress(spec, rng); decide(i, a.hit, a.pos, "auto"); }
    await chain;
    ctl.finish = async () => {};
    ctl.finisher = async () => {};
    return { hits, judgedBy: "auto", ctl };
  }

  const introMs = Math.max(0, Number(spec.introMs) || 0);
  const leadMs = spec.leadMs ?? TSG_TIMING.leadMs;
  ctl.hud = new GaugeHud({ ...spec, interactive: false, showAfterMs: introMs });
  ctl.hud._sweepMs = spec.sweepMs;
  _runs.set(requestId, { hud: ctl.hud });
  emit("OPEN", { requestId, ownerUserId, presentation: true, spec });
  hook("open", { requestId, owner: false, spec });

  const owner = ownerUserId ? game.users?.get(ownerUserId) : null;
  if (owner?.active) {
    // Player path: their client judges; we mirror + apply as strikes arrive.
    const perStrike = spec.sweepMs + spec.gapMs;
    const budgetMs = 6000 + introMs + count * (perStrike + 1500);
    await new Promise((resolve) => {
      let done = false;
      const finishWait = () => { if (done) return; done = true; clearInterval(watch); clearTimeout(timer); _gmWait.delete(requestId); resolve(); };
      _gmWait.set(requestId, {
        ownerUserId,
        onStrike: (i, hit, pos) => {
          // (the HUD mirror is updated by onSocket's STRIKE branch)
          decide(i, hit, pos, "player");
          if (applied >= count) finishWait();
        },
        onResult: (list) => { for (let i = applied; i < count; i++) decide(i, !!list[i], null, "player"); finishWait(); },
      });
      // The owner's SWEEP / STRIKE reach onSocket, which drives this HUD's mirror.
      const timer = setTimeout(() => { log(`timed-strike-gauge: ${owner.name} did not finish in ${budgetMs} ms — auto for the rest`); finishWait(); }, budgetMs);
      const watch = setInterval(() => { if (!game.users?.get(ownerUserId)?.active) { log(`timed-strike-gauge: ${owner.name} left — auto for the rest`); finishWait(); } }, 500);
    });
    for (let i = applied; i < count; i++) { const a = autoPress(spec, rng); decide(i, a.hit, a.pos, "auto"); ctl.hud.mark(i, a.hit); emit("STRIKE", { requestId, i, hit: a.hit, pos: a.pos }); hook("strike", { requestId, i, hit: a.hit, pos: a.pos, filled: true }); }
  } else {
    // Automatic path with presentation: the GM's HUD plays scripted presses.
    await sleep(introMs + leadMs);
    for (let i = 0; i < count; i++) {
      const a = autoPress(spec, rng);
      emit("SWEEP", { requestId, i });
      hook("sweep", { requestId, i });
      await ctl.hud.sweep(i, spec.sweepMs, { autoPos: a.pos });
      ctl.hud.mark(i, a.hit);
      emit("STRIKE", { requestId, i, hit: a.hit, pos: a.pos });
      hook("strike", { requestId, i, hit: a.hit, pos: a.pos });
      decide(i, a.hit, a.pos, "auto");
      await sleep(spec.gapMs);
    }
  }
  await chain;
  ctl.setTotal = (total) => { ctl.hud?.setTotal(total); emit("TOTAL", { requestId, total }); };
  // Before the finisher's damage: every client starts its wind-up now; the GM holds
  // a fixed beat so the damage lands on the hit (never waits on a client).
  let finisherShown = false;
  ctl.finisher = async ({ label = null } = {}) => {
    finisherShown = true;
    emit("FINISHER", { requestId, label }); hook("finisher", { requestId, label });
    await sleep(Number(spec.finisherLeadMs ?? TSG_TIMING.finisherLeadMs) || 0);
  };
  // Result + close. Resolves after the fixed tail (the cinematic's restore), so
  // the next turn does not start under the returning camera.
  ctl.finish = async ({ tier, total }) => {
    const n = hits.filter(Boolean).length;
    const payload = { requestId, tier, hits: n, count, total };
    const closeDelay = Number(spec.closeDelayMs ?? TSG_TIMING.closeDelayMs) || 0;
    ctl.hud?.finish(payload); emit("DONE", payload); hook("done", payload);
    ctl.hud?.close(closeDelay); emit("CLOSE", { requestId, delay: closeDelay }); _runs.delete(requestId);
    hook("close", { requestId, delay: closeDelay });
    const tail = (Number(spec.tailMs ?? TSG_TIMING.tailMs) || 0) + (finisherShown ? (Number(spec.finisherTailMs ?? TSG_TIMING.finisherTailMs) || 0) : 0);
    if (tail > 0) await sleep(tail);
  };
  const judgedBy = autoUsed && playerUsed ? "mixed" : (playerUsed ? "player" : "auto");
  return { hits, judgedBy, ctl };
}
