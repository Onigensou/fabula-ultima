// Director-native start-of-round banner.
//
// Screen-fixed DOM cinematic shown at the start of each round: a centered dark
// band fades in, gold accent lines sweep open from the center, and "ROUND N"
// rises in — holds — then fades out. Self-contained: own socketlib channel,
// own render surface, own SFX. No legacy dependency (the legacy "round
// announcer" was end-of-round chat cards coupled to Lancer Initiative + the
// chat log, which the director doesn't use).
//
// SFX: Critical_1.wav, loaded via Web Audio (fetch the FULL file →
// decodeAudioData → play). Foundry's HTML5 AudioHelper uses Range requests,
// and some Forge .wav assets fail to decode on a 206 partial response
// (ERR_CONTENT_DECODING_FAILED); a plain full fetch (200) sidesteps that.
//
// Flow:
//   boot        → initDirectorRoundBanner() registers the socket handler.
//   ROUND_START → playRoundBanner({round}) renders locally + broadcasts.

import { log, warn } from "./logger.js";
import { registerSurface, unregisterSurface } from "./director-surfaces.js";

const MODULE_ID = "fabula-ultima-companion";
const ACTION_PLAY = "FU_DIRECTOR_ROUND_PLAY";
const ACTION_HIDE = "FU_DIRECTOR_ROUND_HIDE";
const ACTION_BATTLE_START = "FU_DIRECTOR_BATTLE_START_PLAY";
const ACTION_TURNACTIONS = "FU_DIRECTOR_TURNACTIONS";
const STYLE_ID = "fu-dir-round-style";
const LAYER_ID = "fu-dir-round-layer";
const ROUND_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Critical_1.wav";
const ACCENT = "#ffd866";

let _socket = null;
// Surface-registry id for the banner overlay while it's visible (it persists
// in the DOM via an .active class flip, which the DOM observer can't see, so
// we register/unregister it explicitly).
let _bannerSurfaceId = null;

// ── boot: socket registration (idempotent; call once after socketlib up) ──
export function initDirectorRoundBanner() {
  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("director-round-banner: socketlib unavailable — banner will be local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    _socket.register(ACTION_PLAY, playRoundBannerLocal);
    _socket.register(ACTION_HIDE, () => { exitRoundBannerLocal({ animate: true }); clearTurnActionsLocal(); });
    _socket.register(ACTION_BATTLE_START, playBattleStartBannerLocal);
    _socket.register(ACTION_TURNACTIONS, renderTurnActionsLocal);
    log("director-round-banner: socket registered");
  } catch (e) {
    warn("director-round-banner: init failed", e);
  }
  // GM drives the turn-action tracker off dCombat's state-change hook (fired
  // from director-combat.js). Registered outside the socket guard so the GM's
  // own local render still works even if socketlib is unavailable.
  try {
    Hooks.on("fu-director-turnactions", (dCombat) => refreshTurnActions(dCombat));
  } catch (e) { warn("director-round-banner: turnactions hook registration failed", e); }
}

// ── Web Audio SFX (full-file fetch → decode → play; cached per session) ───
const _audio = { ctx: null, cache: {} };
async function playRoundSfx(url = ROUND_SFX_URL, vol = 0.6) {
  try {
    _audio.ctx = _audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audio.ctx.state === "suspended") { try { await _audio.ctx.resume(); } catch {} }
    let buf = _audio.cache[url];
    if (!buf) {
      const resp = await fetch(url, { cache: "reload" }); // full 200, no Range
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      buf = await _audio.ctx.decodeAudioData((await resp.arrayBuffer()).slice(0));
      _audio.cache[url] = buf;
    }
    const src = _audio.ctx.createBufferSource();
    const gain = _audio.ctx.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain).connect(_audio.ctx.destination);
    src.start(0);
  } catch (e) {
    warn("director-round-banner: sfx failed", e);
  }
}

// ── DOM surface (created lazily, reused) ──────────────────────────────────
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${LAYER_ID} { position: fixed; inset: 0; z-index: 100000; pointer-events: none; overflow: hidden; display: none; }
#${LAYER_ID}.active { display: block; }
#${LAYER_ID} .fu-rb-band {
  position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1.6vh; padding: 3.2vh 0;
}
#${LAYER_ID} .fu-rb-bg {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent 0%, rgba(8,8,12,.78) 16%, rgba(8,8,12,.78) 84%, transparent 100%);
}
#${LAYER_ID} .fu-rb-line {
  position: relative; height: 2px; width: 48vw; transform-origin: center;
  background: linear-gradient(90deg, transparent, ${ACCENT} 12%, ${ACCENT} 88%, transparent);
  box-shadow: 0 0 8px ${ACCENT};
}
#${LAYER_ID} .fu-rb-text {
  position: relative; color: #fff; white-space: nowrap; letter-spacing: .1em;
  font: 900 6.2vh "Pixel Operator", system-ui, sans-serif;
  text-shadow: 0 2px 12px rgba(0,0,0,.7);
}
/* Turn-action tracker — creature icons flanking ROUND X (enemies left, party right). */
#${LAYER_ID} .fu-rb-row {
  position: relative; display: flex; align-items: center; justify-content: center; gap: 1.6vw;
}
#${LAYER_ID} .fu-rb-ta-group { display: flex; align-items: center; gap: 0.7vh; }
#${LAYER_ID} .fu-rb-ta-icon {
  position: relative; width: 7.2vh; height: 7.2vh; border-radius: 50%; overflow: hidden;
  flex: 0 0 auto; background: #0a0a0e; border: 2px solid ${ACCENT};
  box-shadow: 0 0 7px rgba(0,0,0,.55);
  transition: filter .25s ease, opacity .25s ease;
}
#${LAYER_ID} .fu-rb-ta-icon .fu-rb-ta-media {
  /* Token sprite masked into the circle: anchored middle-top, zoomed 2x. */
  width: 100%; height: 100%; object-fit: cover; object-position: center top;
  transform: scale(2); transform-origin: center top; display: block;
}
#${LAYER_ID} .fu-rb-ta-icon.spent {
  /* Turn action spent this round → dim + grey out. */
  filter: grayscale(1) brightness(.5); opacity: .42;
  border-color: rgba(160,160,170,.45); box-shadow: none;
}
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function ensureLayer() {
  ensureStyle();
  let layer = document.getElementById(LAYER_ID);
  if (layer && layer.__fu) return layer;
  layer = document.createElement("div");
  layer.id = LAYER_ID;
  const band = document.createElement("div"); band.className = "fu-rb-band";
  const bg = document.createElement("div"); bg.className = "fu-rb-bg";
  const lt = document.createElement("div"); lt.className = "fu-rb-line";
  // Middle row: [enemy icons] [ROUND N] [party icons].
  const row = document.createElement("div"); row.className = "fu-rb-row";
  const leftGroup = document.createElement("div"); leftGroup.className = "fu-rb-ta-group left";
  const tx = document.createElement("div"); tx.className = "fu-rb-text";
  const rightGroup = document.createElement("div"); rightGroup.className = "fu-rb-ta-group right";
  row.append(leftGroup, tx, rightGroup);
  const lb = document.createElement("div"); lb.className = "fu-rb-line";
  band.append(bg, lt, row, lb);
  layer.append(band);
  document.body.appendChild(layer);
  layer.__fu = { band, bg, lt, lb, tx, row, leftGroup, rightGroup, turnActionKey: "" };
  return layer;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── exit: fade out + clear the docked banner ──────────────────────────────
// Used both on round change (before the next banner enters) and at battle end.
// Function declaration → hoisted, so playRoundBannerLocal can call it above.
async function exitRoundBannerLocal({ animate = true } = {}) {
  try {
    const layer = document.getElementById(LAYER_ID);
    if (!layer || !layer.__fu || !layer.classList.contains("active")) return;
    const { band, bg, lt, lb, tx } = layer.__fu;
    if (animate) {
      // Single-keyframe → fades from each element's CURRENT opacity to 0
      // (the docked banner sits at reduced bg opacity, full text/lines).
      await Promise.all([
        bg.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
        lt.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        lb.animate([{ opacity: 0 }], { duration: 300, fill: "forwards" }).finished,
        tx.animate([{ opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" }).finished,
      ]);
    }
    for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());
    layer.classList.remove("active");
    if (_bannerSurfaceId) { unregisterSurface(_bannerSurfaceId); _bannerSurfaceId = null; }
  } catch (e) {
    warn("exitRoundBannerLocal threw", e);
  }
}

// ── shared enter sequence ─────────────────────────────────────────────────
// Reset to centered start state, then play the entrance: band fades in,
// accent lines sweep open from the center, text rises in. Resolves once the
// text is fully in. Both the round banner (→ dock) and the battle-start
// banner (→ exit) build on this. Returns the layer's element refs.
async function enterBannerLocal({ text = "", sfx = true, sfxVol = 0.6 } = {}) {
  const layer = ensureLayer();
  const { band, bg, lt, lb, tx } = layer.__fu;

  // If a prior banner is still on screen (docked round indicator), fade it
  // out first so the new one enters from center cleanly (no jump from top).
  if (layer.classList.contains("active")) await exitRoundBannerLocal({ animate: true });

  for (const el of [band, bg, lt, lb, tx]) el.getAnimations?.().forEach((a) => a.cancel());

  tx.textContent = text;
  layer.classList.add("active");
  if (!_bannerSurfaceId) _bannerSurfaceId = registerSurface({ kind: "round-banner" });
  if (sfx) playRoundSfx(ROUND_SFX_URL, sfxVol);

  // Reset to centered start state.
  band.style.top = "50%";
  band.style.transform = "translateY(-50%) scale(1)";
  bg.style.opacity = "0";
  tx.style.opacity = "0";
  lt.style.transform = "scaleX(0)";
  lb.style.transform = "scaleX(0)";

  // Enter: band fades in, accent lines sweep open, text rises in.
  bg.animate([{ opacity: 0, transform: "scaleY(.55)" }, { opacity: 1, transform: "scaleY(1)" }],
    { duration: 240, easing: "ease-out", fill: "forwards" });
  await Promise.all([
    lt.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 400, easing: "cubic-bezier(.16,.84,.36,1)", fill: "forwards" }).finished,
    lb.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 400, easing: "cubic-bezier(.16,.84,.36,1)", fill: "forwards" }).finished,
  ]);
  await tx.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 300, easing: "ease-out", fill: "forwards" }).finished;

  return layer.__fu;
}

// ── local render (runs on every client via socket) ───────────────────────
// Enter center → hold → DOCK to middle-top and persist as a round indicator.
async function playRoundBannerLocal(payload = {}) {
  try {
    const {
      round = 0, holdMs = 800, sfx = true, sfxVol = 0.6,
      dockTopPct = 9, dockScale = 0.4, dockBgOpacity = 0.3,
    } = payload;

    const { band, bg } = await enterBannerLocal({ text: `ROUND ${round}`, sfx, sfxVol });

    await sleep(holdMs);

    // Dock: shrink + glide to middle-top, then STAY (persistent indicator).
    band.animate(
      [
        { top: "50%", transform: "translateY(-50%) scale(1)" },
        { top: `${dockTopPct}%`, transform: `translateY(-50%) scale(${dockScale})` },
      ],
      { duration: 520, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }
    );
    bg.animate([{ opacity: 1 }, { opacity: dockBgOpacity }],
      { duration: 520, easing: "ease-in-out", fill: "forwards" });
    // Note: NO layer.classList.remove — the banner persists until the next
    // round (exited above) or battle end (hideRoundBanner).
  } catch (e) {
    warn("playRoundBannerLocal threw", e);
  }
}

// ── local render: battle-start flash ──────────────────────────────────────
// Same entrance as the round banner, but on hold-end it EXITS (fades out)
// right away instead of docking to the top. Awaited by the GM so the battle
// process kicks off only after the flash has cleared the screen.
async function playBattleStartBannerLocal(payload = {}) {
  try {
    const { text = "BATTLE START", holdMs = 900, sfx = true, sfxVol = 0.6 } = payload;
    await enterBannerLocal({ text, sfx, sfxVol });
    await sleep(holdMs);
    await exitRoundBannerLocal({ animate: true });
  } catch (e) {
    warn("playBattleStartBannerLocal threw", e);
  }
}

// ── public: fire from ROUND_START ─────────────────────────────────────────
// Render on THIS (GM) client + broadcast to all OTHERS. Fire-and-forget so the
// FSM is not blocked by the ~2.5s cinematic.
export function playRoundBanner({ round = 0 } = {}) {
  try {
    const payload = { round };
    playRoundBannerLocal(payload);
    try { _socket?.executeForOthers?.(ACTION_PLAY, payload); }
    catch (e) { warn("director-round-banner: broadcast failed", e); }
  } catch (e) {
    warn("playRoundBanner threw", e);
  }
}

// ── public: battle-start flash (fire at the start of battle) ──────────────
// Broadcast to all OTHER clients, then play + AWAIT locally. Unlike
// playRoundBanner this is awaited by the caller (runDirectorInit) so the
// battle process only begins once the flash has entered, held, and exited.
export async function playBattleStartBanner({ text = "BATTLE START", holdMs = 900 } = {}) {
  try {
    const payload = { text, holdMs };
    try { _socket?.executeForOthers?.(ACTION_BATTLE_START, payload); }
    catch (e) { warn("director-round-banner: battle-start broadcast failed", e); }
    await playBattleStartBannerLocal(payload);
  } catch (e) {
    warn("playBattleStartBanner threw", e);
  }
}

// ── Turn-action tracker ───────────────────────────────────────────────────
// Creature icons flanking ROUND X: enemies on the left, party on the right.
// Each icon is the token sprite masked into a circle; when that creature has
// spent its turn action(s) for the round it greys out + dims. Driven by the
// `fu-director-turnactions` hook (director-combat.js fires it on start /
// nextTurn / round reset); the GM builds a snapshot, renders locally, and
// broadcasts to every client.

function isVideoSrc(u) {
  return /\.(webm|mp4|m4v|ogv)(\?|#|$)/i.test(String(u ?? ""));
}

function buildTurnActionIcon(c) {
  const icon = document.createElement("div");
  icon.className = "fu-rb-ta-icon" + (c.spent ? " spent" : "");
  icon.dataset.cid = c.id;
  icon.title = c.name ?? "";
  let media;
  if (isVideoSrc(c.img)) {
    media = document.createElement("video");
    media.autoplay = true; media.loop = true; media.muted = true;
    media.playsInline = true; media.setAttribute("playsinline", "");
  } else {
    media = document.createElement("img");
    media.draggable = false;
  }
  media.className = "fu-rb-ta-media";
  if (c.img) media.src = c.img;
  icon.appendChild(media);
  return icon;
}

// Render (idempotent). Rebuilds the icon DOM only when the membership/order
// changes (new round / combatant added or removed); otherwise just toggles
// each icon's spent/dim state so an in-round update is a cheap class flip.
function renderTurnActionsLocal(combatants = []) {
  try {
    const layer = ensureLayer();
    const { leftGroup, rightGroup } = layer.__fu;
    if (!leftGroup || !rightGroup) return;
    const list = Array.isArray(combatants) ? combatants : [];
    const key = list.map((c) => `${c.side === "enemy" ? "L" : "R"}:${c.id}`).join("|");
    if (key !== layer.__fu.turnActionKey) {
      leftGroup.replaceChildren();
      rightGroup.replaceChildren();
      for (const c of list) {
        const grp = c.side === "enemy" ? leftGroup : rightGroup;
        grp.appendChild(buildTurnActionIcon(c));
      }
      layer.__fu.turnActionKey = key;
    } else {
      for (const c of list) {
        const grp = c.side === "enemy" ? leftGroup : rightGroup;
        const sel = `.fu-rb-ta-icon[data-cid="${(window.CSS?.escape?.(c.id)) ?? c.id}"]`;
        const icon = grp.querySelector(sel);
        if (icon) icon.classList.toggle("spent", !!c.spent);
      }
    }
  } catch (e) {
    warn("renderTurnActionsLocal threw", e);
  }
}

function clearTurnActionsLocal() {
  const layer = document.getElementById(LAYER_ID);
  if (!layer?.__fu) return;
  layer.__fu.leftGroup?.replaceChildren();
  layer.__fu.rightGroup?.replaceChildren();
  layer.__fu.turnActionKey = "";
}

// GM: snapshot dCombat's combatants into the slim shape the renderer needs.
function buildTurnActionSnapshot(dCombat) {
  const out = [];
  for (const c of (dCombat?.combatants ?? [])) {
    const td = c.tokenDoc;
    out.push({
      id: c.id,
      side: c.side === "enemy" ? "enemy" : "party",
      name: c.name ?? td?.name ?? "",
      img: td?.texture?.src ?? c.actorDoc?.img ?? null,
      spent: !(Number(c.turnsRemaining) > 0),
    });
  }
  return out;
}

// GM: build the snapshot, render locally, and broadcast to every other client.
// Fired from the `fu-director-turnactions` hook. No-op for non-GM (the hook
// only fires where dCombat lives, but guard anyway).
export function refreshTurnActions(dCombat) {
  try {
    if (!game.user?.isGM) return;
    const snap = buildTurnActionSnapshot(dCombat);
    renderTurnActionsLocal(snap);
    try { _socket?.executeForOthers?.(ACTION_TURNACTIONS, snap); }
    catch (e) { warn("refreshTurnActions broadcast failed", e); }
  } catch (e) {
    warn("refreshTurnActions threw", e);
  }
}

// ── public: clear the docked banner at battle end ─────────────────────────
// Fade out + remove on THIS client and broadcast the same to all others, so
// the persistent round indicator never lingers after the director stops.
export function hideRoundBanner() {
  try {
    exitRoundBannerLocal({ animate: true });
    clearTurnActionsLocal();
    try { _socket?.executeForOthers?.(ACTION_HIDE); }
    catch (e) { warn("director-round-banner: hide broadcast failed", e); }
  } catch (e) {
    warn("hideRoundBanner threw", e);
  }
}
