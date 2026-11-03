// Battle Director — Passive Card UI subsystem (v2, 2026-11-03).
//
// A Bravely Default II band across the waist of the creature whose passive
// fired: one line per passive, its icon and its name. v2 stops the overload at
// battle start and in chains while keeping that look (mockup and tuning:
// passive-card-config.js):
//
//   - WHETHER a firing gets a card, and its TIER, is decided on the GM
//     (passive-card-classify.js): a card for a passive that acts, reaches
//     another creature or changes tracked points; nothing for one that changed
//     nothing. The GM then broadcasts at once — no pacing on the GM, so a hidden
//     GM tab no longer dumps its whole queue on the players in one burst.
//   - Every client paces its own cards ("band director"): a passive joins its
//     character's live card within a beat (the same passive again counts ×N), a
//     new card waits for a battle-start / round / turn plate and cascades after
//     the last one, and cards that arrive while 5+ are up come compact.
//   - Each line plays its tier's cue; one character never repeats a cue within
//     the gap. The tier also colors the band's hairlines and icon frames, and a
//     points line reads out what it granted ("+1 Adoration (1/5)").
//
// GM API: beginPassiveCard (firePreAcceptedCandidate), enqueuePassiveCard
// (notify "card" rows), broadcastStatusTick. Every client: initPassiveCardUi.

import { log, warn } from "../logger.js";
import { playSfx, preloadSfx } from "../director-sfx.js";
import { pWait } from "../presentation-clock.js";
import { flashStatusLocal } from "../status-pop.js";
import { spriteRect } from "../unit-anchors.js";
import { hasSurface } from "../director-surfaces.js";
import { PASSIVE_CARD_CONFIG as CFG, CARD_TIERS } from "./passive-card-config.js";
import { chainProfile, snapshotOwner, decideAfter, decideBefore } from "./passive-card-classify.js";

const MODULE_ID   = "fabula-ultima-companion";
const ACTION_KEY  = "FU_DIRECTOR_PASSIVE_CARD_SHOW";
const ACTION_TICK = "FU_DIRECTOR_STATUS_TICK_FLASH";   // GM → others: a status's own tick fired
const STYLE_ID    = "fud-passive-card-style-v2";
const ROOT_ID     = "fud-passive-card-root";
const NS          = "fabula-ultima-companion";

const T = CFG.timing;
const WAIST_FRACTION = 0.58;
// Surfaces a new card waits for (director-surfaces kinds), up to PLATE_WAIT.
const PLATES = ["round-plate", "round-banner", "turn-banner", "battle-loader"];
const TIER_RANK = Object.fromEntries(CARD_TIERS.map((t, i) => [t, i]));

let _socket = null;

// Band director state, per client.
const B = {
  cards: new Set(),        // pending → live → exiting → gone
  lastSpawn: -Infinity,
  lastCue: new Map(),      // `${cue}|${tokenUuid}` → time it last played
  ticker: null,
  decisions: [],           // GM: the last firings and what was decided (FUCompanion.api.passiveCards)
};

// ── Styles ───────────────────────────────────────────────────────────

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID} {
  position: fixed; left: 0; top: 0;
  pointer-events: none; z-index: 100000;
}
#${ROOT_ID} .fud-pc-pos { position: absolute; left: 0; top: 0; will-change: transform; }
/* Bravely Default II band (token status plan "G + E", 2026-10-27): a soft
   black band across the actor's waist, no border, one line per passive. The
   feet stay free for the NPC status strip; results pop above the head. */
.fud-passive-card {
  position: absolute; left: 0; top: 0;
  transform: translate(-50%, -50%);
  pointer-events: none;
  display: grid; gap: 3px;
  padding: 5px 36px;
  background: linear-gradient(90deg, rgba(6,5,4,0), rgba(6,5,4,0.84) 16%, rgba(6,5,4,0.84) 84%, rgba(6,5,4,0));
  color: #ffffff;
  font-family: 'Signika', 'Palatino Linotype', serif;
  opacity: 0;
  will-change: transform, opacity;
  white-space: nowrap;
}
.fud-passive-card::before, .fud-passive-card::after {
  content: ""; position: absolute; left: 14%; right: 14%; height: 1px;
  background: linear-gradient(90deg, rgba(226,194,126,0), rgba(226,194,126,0.75), rgba(226,194,126,0));
}
.fud-passive-card::before { top: 0; }
.fud-passive-card::after { bottom: 0; }
.fud-passive-card .fud-pc-row {
  display: flex; align-items: center; gap: 7px;
  font-size: 16px; font-weight: 400; line-height: 1.15;
  letter-spacing: 0.01em;
  text-shadow: 0 1px 0 rgba(0,0,0,0.65), 0 0 6px rgba(0,0,0,0.6);
}
.fud-passive-card .fud-pc-row.is-added { animation: fudPassiveCardLine var(--fud-pc-line-ms, 300ms) cubic-bezier(0.22,1,0.36,1) both; }
.fud-passive-card .fud-pc-icon { flex: none; display: inline-flex; font-size: 15px; line-height: 1; }
/* max-width: none — Foundry's global img { max-width: 100% } collapses a large
   icon to 0 px inside this shrink-to-fit row (only tiny GIFs survived). */
.fud-passive-card .fud-pc-img {
  display: block; flex: none; width: 20px; height: 20px; max-width: none; object-fit: cover; border-radius: 4px;
  border: 1.5px solid #e2c27e; background: #1a140f;
}
/* ×N: a white suffix to the name; it pulses on each count. */
.fud-passive-card .fud-pc-x {
  display: inline-block; margin-left: -3px; color: #fff; white-space: nowrap;
  transform-origin: 15% 60%; font-weight: 700; line-height: 1; letter-spacing: .02em;
}
.fud-passive-card .fud-pc-x:empty { display: none; }
.fud-passive-card .fud-pc-x i { font-style: normal; font-size: .8em; margin-right: .06em; }
#${ROOT_ID}.xs-glow .fud-pc-x { font-size: .88em; text-shadow: 0 0 1px rgba(0,0,0,.95), 0 0 6px rgba(255,255,255,.62), 0 0 13px rgba(255,255,255,.3); }
#${ROOT_ID}.xs-outline .fud-pc-x { font-size: .94em; font-weight: 800; text-shadow: -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 1.5px 0 #000, 0 -1.5px 0 #000, 1.5px 0 0 #000, -1.5px 0 0 #000; }
#${ROOT_ID}.xs-raised .fud-pc-x { font-size: .72em; position: relative; top: -.5em; margin-left: -5px; text-shadow: 0 0 1px rgba(0,0,0,.95), 0 0 5px rgba(255,255,255,.55); }
/* Points readout: what the line granted so far and the new total. */
.fud-passive-card .fud-pc-pts { margin-left: 2px; color: #ffb340; font-size: 14px; font-weight: 600; }
.fud-passive-card .fud-pc-pts:empty { display: none; }
/* Compact: cards that arrive while 5+ are up. */
.fud-passive-card.compact { padding: 4px 26px; gap: 2px; }
.fud-passive-card.compact .fud-pc-row { font-size: 14px; gap: 6px; }
.fud-passive-card.compact .fud-pc-img { width: 17px; height: 17px; }
.fud-passive-card.compact .fud-pc-pts { font-size: 12px; }
/* Tier colors: the band's two hairlines (its highest tier) and each icon frame. */
.fud-passive-card [data-tier], .fud-passive-card[data-tier] { --tc: #e2c27e; --tg: transparent; }
.fud-passive-card[data-tier="spotlight"], .fud-passive-card [data-tier="spotlight"] { --tc: #fff1cc; --tg: rgba(255,222,150,.95); }
.fud-passive-card[data-tier="offense"], .fud-passive-card [data-tier="offense"] { --tc: #ff5a6e; --tg: rgba(255,80,105,.75); }
.fud-passive-card[data-tier="defense"], .fud-passive-card [data-tier="defense"] { --tc: #62b6ff; --tg: rgba(80,170,255,.75); }
.fud-passive-card[data-tier="support"], .fud-passive-card [data-tier="support"] { --tc: #5fdc8f; --tg: rgba(80,220,140,.7); }
.fud-passive-card[data-tier="ready"], .fud-passive-card [data-tier="ready"] { --tc: #f2c14e; --tg: rgba(240,190,70,.75); }
.fud-passive-card[data-tier="points"], .fud-passive-card [data-tier="points"] { --tc: #ff9a3d; --tg: rgba(255,150,60,.75); }
.fud-passive-card[data-tier="background"], .fud-passive-card [data-tier="background"] { --tc: rgba(236,226,210,.42); --tg: transparent; }
#${ROOT_ID}.bg-gold .fud-passive-card[data-tier="background"] { --tc: rgba(226,194,126,.75); }
.fud-passive-card[data-tier]::before, .fud-passive-card[data-tier]::after {
  height: 1.5px; background: linear-gradient(90deg, transparent, var(--tc), transparent); filter: drop-shadow(0 0 3px var(--tg));
}
.fud-passive-card[data-tier="background"]::before, .fud-passive-card[data-tier="background"]::after { height: 1px; filter: none; }
.fud-passive-card .fud-pc-row[data-tier] .fud-pc-img { border-color: var(--tc); }
.fud-passive-card .fud-pc-row[data-tier="background"] .fud-pc-img { border-color: rgba(236,226,210,.62); }
#${ROOT_ID}.bg-gold .fud-pc-row[data-tier="background"] .fud-pc-img { border-color: #e2c27e; }
/* Spotlight: a light sweeps across the band once. */
.fud-passive-card .fud-pc-sheen {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: linear-gradient(105deg, rgba(255,240,200,0) 42%, rgba(255,240,200,.36) 50%, rgba(255,240,200,0) 58%) no-repeat;
  background-size: 300% 100%; background-position: 100% 0;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 16%, #000 84%, transparent);
}
.fud-passive-card.enter {
  animation: fudPassiveCardIn var(--fud-pc-in-ms, 280ms) cubic-bezier(0.22,1,0.36,1) forwards;
}
.fud-passive-card.exit {
  animation: fudPassiveCardOut var(--fud-pc-out-ms, 260ms) cubic-bezier(0.4,0,1,1) forwards;
}
@keyframes fudPassiveCardIn {
  0%   { opacity: 0; transform: translate(-62%, -50%); }
  100% { opacity: 1; transform: translate(-50%, -50%); }
}
@keyframes fudPassiveCardOut {
  0%   { opacity: 1; transform: translate(-50%, -50%); }
  100% { opacity: 0; transform: translate(-62%, -50%); }
}
@keyframes fudPassiveCardLine {
  0%   { opacity: 0; transform: translateX(-10px); }
  100% { opacity: 1; transform: none; }
}
  `.trim();
  document.head.appendChild(style);
}

function ensureRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  root.className = `xs-${CFG.xStyle}${CFG.backgroundLines === "gold" ? " bg-gold" : ""}`;
  return root;
}

const reducedMotion = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
const plateUp = () => PLATES.some((k) => hasSurface(k));

// ── Sound ────────────────────────────────────────────────────────────

function cueUrls() {
  const defs = [CFG.sound.plain, ...Object.values(CFG.sound.cues)];
  return [...new Set(defs.filter((d) => d?.url).map((d) => d.url))];
}

// A cue plays its sound unless the same character played it within the gap.
function playCue(cue, tokenUuid) {
  const def = cue === "plain" ? CFG.sound.plain : CFG.sound.cues[cue];
  if (!def?.url) return;
  const key = `${cue}|${tokenUuid}`;
  const now = performance.now();
  const last = B.lastCue.get(key);
  if (last != null && now - last < CFG.sound.gapMs) return;
  B.lastCue.set(key, now);
  playSfx(def.url, def.vol);
}

function cueOf(line, res) {
  if (!CFG.soundByTier || !line.tier) return "plain";
  if (line.tier === "points" && res && res.op !== "add") return "pointsDown";
  return line.tier;
}

// ── Lines ────────────────────────────────────────────────────────────

// "+1 Adoration (1/5)" · "Adoration reset (0/5)" · "−2 Zero Power (1/6)".
function shortName(name, n) {
  let s = String(name ?? "").replace(/\s+Clock$/i, "");
  if (n === 1) s = s.replace(/Points$/, "Point");
  return s;
}
function readoutText(res) {
  if (!res) return "";
  const max = res.max && res.max < 99 ? `/${res.max}` : "";
  if (res.op === "reset") return `${shortName(res.name)} reset (0${max})`;
  return `${res.op === "spend" ? "−" : "+"}${res.n} ${shortName(res.name, res.n)} (${res.after}${max})`;
}
// A repeat adds to what the line granted so far; a reset starts it over.
function mergeRes(a, b) {
  if (!a || !b || b.op === "reset" || a.op !== b.op) return b ?? a;
  return { ...b, n: a.n + b.n };
}

function buildIcon(icon) {
  const iconEl = document.createElement("span");
  iconEl.className = "fud-pc-icon";
  const iconStr = String(icon ?? "📜");
  // Any file path is a picture — a world-local asset ("worlds/…/x.png") used to
  // fall through to the text branch and print its whole path on the card.
  if (/^(https?:|data:|\/|[\w.-]+\/)/.test(iconStr) || /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i.test(iconStr)) {
    const img = document.createElement("img");
    img.className = "fud-pc-img";
    img.onerror = () => img.remove();   // a broken icon leaves no empty frame
    img.src = iconStr;
    iconEl.appendChild(img);
  } else {
    iconEl.textContent = iconStr;
  }
  return iconEl;
}

function mountLine(c, line, added) {
  const row = document.createElement("div");
  row.className = "fud-pc-row" + (added ? " is-added" : "");
  if (CFG.colorByTier && line.tier) row.dataset.tier = line.tier;
  row.appendChild(buildIcon(line.icon));
  const nameEl = document.createElement("span");
  nameEl.className = "fud-pc-name";
  nameEl.textContent = line.name;
  row.appendChild(nameEl);
  line.xEl = document.createElement("span");
  line.xEl.className = "fud-pc-x";
  row.appendChild(line.xEl);
  line.ptsEl = document.createElement("span");
  line.ptsEl.className = "fud-pc-pts";
  row.appendChild(line.ptsEl);
  line.row = row;
  c.band.appendChild(row);
  renderLine(line, false);
}

function renderLine(line, pulse) {
  if (!line.xEl) return;
  line.xEl.innerHTML = line.n > 1 ? `<i>×</i>${line.n}` : "";
  line.ptsEl.textContent = CFG.readout ? readoutText(line.res) : "";
  if (pulse && line.n > 1 && !reducedMotion()) {
    try {
      line.xEl.animate([
        { transform: "scale(1.35)", filter: "drop-shadow(0 0 7px rgba(255,255,255,.9))" },
        { transform: "scale(1)", filter: "drop-shadow(0 0 0 rgba(255,255,255,0))" },
      ], { duration: 320, easing: "cubic-bezier(0, 0, 0.58, 1)" });
    } catch { /* no WAAPI */ }
  }
}

// The band takes the color of its highest tier.
function recolor(c) {
  if (!c.band || !CFG.colorByTier) return;
  let top = null;
  for (const l of c.lines) if (l.tier && (top == null || TIER_RANK[l.tier] < TIER_RANK[top])) top = l.tier;
  if (top) c.band.dataset.tier = top; else delete c.band.dataset.tier;
}

function sweepSheen(c) {
  if (!CFG.colorByTier || c.sheened || reducedMotion() || !c.band) return;
  if (!c.lines.some((l) => l.tier === "spotlight")) return;
  c.sheened = true;
  const sheen = document.createElement("div");
  sheen.className = "fud-pc-sheen";
  c.band.appendChild(sheen);
  try {
    sheen.animate([
      { backgroundPosition: "100% 0", opacity: 1 },
      { backgroundPosition: "0% 0", opacity: 1 },
    ], { duration: 900, delay: 150, easing: "cubic-bezier(0, 0, 0.58, 1)" });
  } catch { /* no WAAPI */ }
}

// A passive arriving on a card: a new line, or ×N on the line it already has.
function addLine(c, spec, now) {
  const name = String(spec.title ?? "Passive");
  const res = spec.res ?? null;
  let line = c.lines.find((l) => l.name === name);
  if (line) {
    line.n += 1;
    line.res = mergeRes(line.res, res);
    renderLine(line, true);
    if (CFG.sound.repeats === "each") cueFor(c, line, res);
  } else {
    line = { name, icon: spec.icon, tier: spec.tier ?? null, n: 1, res, row: null, xEl: null, ptsEl: null };
    c.lines.push(line);
    if (c.band) { mountLine(c, line, true); recolor(c); sweepSheen(c); }
    cueFor(c, line, res);
  }
  c.lastLine = now;
  if (c.state === "live") {
    c.exitAt = Math.max(Math.min(Math.max(c.exitAt, now + T.HOLD), c.cap), now + T.MIN_AFTER);
    armExit(c);
  }
}

// Cues of a card still waiting for its turn play when it appears.
function cueFor(c, line, res) {
  const cue = cueOf(line, res);
  if (c.state === "pending") c.cues.push(cue);
  else playCue(cue, c.tokenUuid);
}

// ── Cards ────────────────────────────────────────────────────────────

function tokenOf(tokenUuid) {
  try {
    const doc = fromUuidSync(tokenUuid);
    const token = doc?.object ?? null;
    return token && !token.destroyed ? token : null;
  } catch { return null; }
}

function newestFor(tokenUuid) {
  let out = null;
  for (const c of B.cards) if (c.tokenUuid === tokenUuid && (c.state === "pending" || c.state === "live")) out = c;
  return out;
}

// Joins the card already there only within the same beat: it hasn't appeared
// yet, or its last line landed under JOIN ago, it is under its life cap and
// no plate is up. Anything later starts a fresh card.
function joins(c, now) {
  if (c.state === "pending") return true;
  return c.state === "live" && now < c.cap && now - c.lastLine <= T.JOIN && !plateUp();
}

function liveCount() {
  let n = 0;
  for (const c of B.cards) if (c.state === "live" || c.state === "exiting") n++;
  return n;
}

function later(c, ms) {
  clearTimeout(c.spawnTimer);
  c.spawnTimer = setTimeout(() => trySpawn(c), Math.max(16, ms));
}

// A new card waits for a plate (up to PLATE_WAIT after it arrived), spawns at
// least CASCADE after the last card, and replaces its character's older card:
// that one slides out and this one follows SWAP later.
function trySpawn(c) {
  if (c.state !== "pending") return;
  if (document.hidden) { drop(c); return; }
  const now = performance.now();
  if (plateUp() && now < c.arrived + T.PLATE_WAIT) return later(c, 100);
  if (now < B.lastSpawn + T.CASCADE) return later(c, B.lastSpawn + T.CASCADE - now);
  let gone = -Infinity;
  for (const o of B.cards) {
    if (o === c || o.tokenUuid !== c.tokenUuid || (o.state !== "live" && o.state !== "exiting")) continue;
    startExit(o);
    gone = Math.max(gone, o.exitStart);
  }
  if (now < gone + T.SWAP) return later(c, gone + T.SWAP - now);
  spawn(c, now);
}

function spawn(c, now) {
  c.state = "live";
  c.cap = now + T.LIFE_CAP;
  c.lastLine = now;
  B.lastSpawn = now;
  const compact = !!CFG.compact && liveCount() >= T.BUSY;   // counts this card
  const el = document.createElement("div");
  el.className = "fud-pc-pos";
  const band = document.createElement("div");
  band.className = `fud-passive-card enter${compact ? " compact" : ""}`;
  band.style.setProperty("--fud-pc-in-ms", `${T.IN}ms`);
  band.style.setProperty("--fud-pc-out-ms", `${T.OUT}ms`);
  band.style.setProperty("--fud-pc-line-ms", `${T.LINE_IN}ms`);
  el.appendChild(band);
  c.el = el; c.band = band;
  for (const line of c.lines) mountLine(c, line, false);
  recolor(c);
  ensureRoot().appendChild(el);
  // Placed before its first frame: at the waist, then clear of any card up.
  // A token with nothing rendered to dock to gets no card (it would sit at 0,0).
  const a = anchorOf(c);
  if (!a) { drop(c); return; }
  c.dy = 0;
  place(c, a, true);
  c.dy = neighbourOffset(c);
  place(c, a, true);
  ensureTicker();
  for (const cue of c.cues.splice(0)) playCue(cue, c.tokenUuid);
  sweepSheen(c);
  c.exitAt = now + T.IN + T.HOLD;
  armExit(c);
}

function armExit(c) {
  clearTimeout(c.exitTimer);
  c.exitTimer = setTimeout(() => startExit(c), Math.max(0, c.exitAt - performance.now()));
}

function startExit(c) {
  if (c.state === "exiting" || c.state === "gone") return;
  clearTimeout(c.exitTimer);
  clearTimeout(c.spawnTimer);
  if (!c.band) { drop(c); return; }
  c.state = "exiting";
  c.exitStart = performance.now();
  c.band.classList.remove("enter");
  c.band.classList.add("exit");
  setTimeout(() => drop(c), T.OUT + 40);
}

function drop(c) {
  clearTimeout(c.exitTimer);
  clearTimeout(c.spawnTimer);
  c.state = "gone";
  try { c.el?.remove(); } catch { /* gone */ }
  B.cards.delete(c);
  if (B.ticker && ![...B.cards].some((x) => x.el)) {
    try { canvas?.app?.ticker?.remove(B.ticker); } catch { /* canvas gone */ }
    B.ticker = null;
  }
}

function clearAll() {
  for (const c of [...B.cards]) drop(c);
}

// ── Position: one shared updater, every read before any write ─────────

function ensureTicker() {
  if (B.ticker || !canvas?.app?.ticker) return;
  B.ticker = () => {
    const list = [];
    for (const c of B.cards) if (c.el) list.push(c);
    const anchors = list.map(anchorOf);
    for (let i = 0; i < list.length; i++) place(list[i], anchors[i], false);
  };
  canvas.app.ticker.add(B.ticker);
}

function anchorOf(c) {
  const t = c.token;
  if (!t || t.destroyed || !c.band) return null;
  const r = spriteRect(t);   // the RENDERED sprite (unit-anchors.js)
  if (!r) return null;
  const st = canvas?.stage;
  return {
    x: r.cx, y: r.top + r.height * WAIST_FRACTION, h: r.height,
    w: c.band.offsetWidth, bh: c.band.offsetHeight,
    sig: `${st?.pivot?.x}|${st?.pivot?.y}|${st?.scale?.x}|${t.x}|${t.y}`,
  };
}

// Whole pixels, kept on screen. While neither the token nor the view moved, the
// band holds still through the idle breathing (±2.5% sprite height) instead of
// bobbing with it.
function place(c, a, force) {
  if (!a || !c.el) return;
  const half = a.w / 2;
  let x = Math.round(a.x);
  if (half) x = Math.min(window.innerWidth - 16 - half, Math.max(16 + half, x));
  const y = Math.round(a.y + (c.dy || 0));
  c.w = a.w; c.h = a.bh;
  if (!force && c.px != null && a.sig === c.sig && Math.abs(x - c.px) < 1 && Math.abs(y - c.py) <= Math.max(2, a.h * 0.03)) return;
  c.px = x; c.py = y; c.sig = a.sig;
  c.el.style.transform = `translate(${x}px, ${y}px)`;
}

// Neighbours firing together: a new card never covers one already up; it
// drops just below it. Returns the extra px for this card's top.
function neighbourOffset(c) {
  if (c.px == null) return 0;
  let dy = 0;
  const me = { l: c.px - c.w / 2, r: c.px + c.w / 2, t: c.py - c.h / 2, b: c.py + c.h / 2 };
  for (const o of B.cards) {
    if (o === c || o.state !== "live" || o.px == null || o.tokenUuid === c.tokenUuid) continue;
    const ot = o.py - o.h / 2, ob = o.py + o.h / 2;
    if (me.l < o.px + o.w / 2 && me.r > o.px - o.w / 2 && me.t + dy < ob && me.b + dy > ot) dy += (ob - (me.t + dy)) + 4;
  }
  return dy;
}

// ── Every client: one card event ─────────────────────────────────────

function showLocal(spec) {
  try {
    if (!spec?.tokenUuid || typeof document === "undefined") return;
    // Nobody is watching a hidden tab: drop it rather than replay a backlog.
    if (document.hidden) return;
    if (spec.chime) { playCue("ready", spec.tokenUuid); return; }
    const token = tokenOf(spec.tokenUuid);
    if (!token) return;
    ensureStyles();
    const now = performance.now();
    const live = newestFor(spec.tokenUuid);
    if (live && joins(live, now)) { addLine(live, spec, now); return; }
    const c = { tokenUuid: spec.tokenUuid, token, lines: [], cues: [], state: "pending", arrived: now, el: null, band: null };
    B.cards.add(c);
    addLine(c, spec, now);
    trySpawn(c);
  } catch (e) {
    warn("[BD][PassiveCardUI] show failed", e);
  }
}

// ── GM side ──────────────────────────────────────────────────────────

const NOOP = Object.freeze({ settle() {} });
const tokenUuidOf = (t) => t?.document?.uuid ?? t?.uuid ?? null;
const safeIcon = (icon) => { const s = String(icon ?? "📜"); return /['"<>\n\r]/.test(s) ? "📜" : s; };

function broadcastCard(spec) {
  const full = { v: 2, runId: foundry.utils.randomID(), ...spec };
  try { _socket?.executeForOthers?.(ACTION_KEY, full); }
  catch (e) { warn("[BD][PassiveCardUI] executeForOthers failed", e); }
  showLocal(full);
}

function remember(title, d) {
  B.decisions.push({ at: new Date().toISOString(), title, show: !!d.show, tier: d.tier ?? null, chime: !!d.chime, why: d.why ?? "" });
  if (B.decisions.length > 80) B.decisions.shift();
  log(`[BD][PassiveCard] "${title}" → ${d.show ? `card (${d.tier})` : d.chime ? "chime" : "quiet"}: ${d.why}`);
}

function triggerOf(carrier, rowKey) {
  const t = carrier?.system?.props?.reaction_config_table ?? carrier?.flags?.[NS]?.reactionConfig?.reaction_config_table;
  return String(t?.[rowKey]?.reaction_trigger ?? "");
}

/**
 * GM, from firePreAcceptedCandidate, BEFORE the passive's chain runs. A chain
 * that can't be waited for gets its card now; a quick one is decided by
 * settle(result) once it has run, from what changed on its owner.
 * @returns {{ settle(result: object): Promise<void>|void }}
 */
export function beginPassiveCard({ candidate, carrier, item, table, actor, casterToken, payload, round = 0 } = {}) {
  const tokenUuid = tokenUuidOf(casterToken);
  if (!tokenUuid || !candidate) return NOOP;
  const title = String(candidate.carrierName ?? "Passive");
  const base = { title, tokenUuid, icon: safeIcon(candidate.carrierImg), mode: candidate.mode ? String(candidate.mode) : null };
  const dial = CFG.detail;
  // An effect another creature put on the owner (Searing Brand's caster): harm it does to "self" is an attack.
  const appliedBy = candidate.carrierKind === "ae" ? carrier?.flags?.[NS]?.directorAppliedBy?.reactorActorUuid : null;
  const foreign = !!appliedBy && appliedBy !== actor?.uuid;
  let p;
  try {
    p = chainProfile({ table, ref: candidate.ref, item, trigger: triggerOf(carrier, candidate.rowKey), foreign });
  } catch (e) {
    warn("[BD][PassiveCardUI] chain profile failed; showing the card as before", e);
    broadcastCard(base);
    return NOOP;
  }
  if (!p.waits) {
    const d = decideBefore({ p, item, title, tokenUuid, dial });
    remember(title, d);
    if (d.show) broadcastCard({ ...base, tier: d.tier });
    return NOOP;
  }
  let before;
  try { before = snapshotOwner(actor, p); }
  catch (e) { warn("[BD][PassiveCardUI] owner snapshot failed; showing the card as before", e); broadcastCard(base); return NOOP; }
  return {
    async settle(result) {
      try {
        const d = await decideAfter({ p, result, before, actor, item, title, tokenUuid, dial, candidate, payload, round });
        remember(title, d);
        if (d.show) broadcastCard({ ...base, tier: d.tier, res: CFG.readout ? (d.res ?? null) : null });
        else if (d.chime) broadcastCard({ tokenUuid, title, chime: true });
      } catch (e) {
        warn("[BD][PassiveCardUI] card decision failed", e);
      }
    },
  };
}

/**
 * GM: show a card now, untiered (notify "card" rows: Life Charm's death-save).
 * Resolves after its entrance so a caller can sequence after it.
 */
export async function enqueuePassiveCard({ title, casterToken, icon, mode, tier = null } = {}) {
  const tokenUuid = tokenUuidOf(casterToken);
  if (!tokenUuid) { warn("[BD][PassiveCardUI] enqueuePassiveCard: no token"); return; }
  broadcastCard({ title: String(title ?? "Passive"), tokenUuid, icon: safeIcon(icon), mode: mode ? String(mode) : null, tier });
  await pWait(T.IN);
}

// ── Status tick (token status plan "G + E") ──────────────────────────
//
// A status's own clock tick (Burn at turn start, Regen…) is not a passive:
// it gets no card. The bearer's pip / strip tile flashes on every client
// instead; the damage number already carries the amount.
export function broadcastStatusTick({ casterToken, name } = {}) {
  const tokenUuid = casterToken?.document?.uuid ?? casterToken?.uuid ?? null;
  if (!tokenUuid || !name) return;
  const spec = { tokenUuid, name: String(name) };
  try { _socket?.executeForOthers?.(ACTION_TICK, spec); }
  catch (e) { warn("[BD][PassiveCardUI] tick broadcast failed", e); }
  flashStatusLocal(spec);
}

// Director stop cleanup (director-boot): cards waiting for their turn are dropped.
export const passiveCardQueue = {
  size() { let n = 0; for (const c of B.cards) if (c.state === "pending") n++; return n; },
  isEmpty() { return this.size() === 0; },
  clear() { for (const c of [...B.cards]) if (c.state === "pending") drop(c); },
  snapshot() { return [...B.cards].map((c) => ({ tokenUuid: c.tokenUuid, state: c.state, lines: c.lines.map((l) => ({ name: l.name, tier: l.tier, n: l.n })) })); },
};

// ── Boot / socket registration ───────────────────────────────────────
//
// Call once on the `ready` hook (all clients).
export function initPassiveCardUi() {
  // Warm the cue sounds at boot so the first play has no fetch latency.
  // Deferred 4 s to match the director's own preloadDirectorSfx schedule.
  setTimeout(() => preloadSfx(cueUrls()).catch(() => {}), 4000);

  document.addEventListener("visibilitychange", () => { if (document.hidden) clearAll(); });
  Hooks.on("canvasTearDown", () => clearAll());

  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.passiveCards = Object.freeze({
    config: CFG,
    // GM: the last firings — shown or quiet, and why.
    decisions: () => B.decisions.slice(),
    cards: () => passiveCardQueue.snapshot(),
    // Test hook: play one card event on this client only.
    show: (spec) => showLocal(spec),
  });

  try {
    if (typeof socketlib === "undefined" || !game.modules.get("socketlib")?.active) {
      warn("[BD][PassiveCardUI] socketlib unavailable — passive cards are local-only");
      return;
    }
    _socket = socketlib.registerModule(MODULE_ID);
    // Every non-GM client: the card event, paced and voiced here.
    _socket.register(ACTION_KEY, (spec) => {
      // The reaction deck (reaction-deck.js) plays the same card out of the
      // owner's deck. Display only; never blocks the badge.
      if (spec && !spec.chime) { try { Hooks.callAll("fuPassiveCardShown", spec); } catch { /* */ } }
      showLocal(spec);
    });
    _socket.register(ACTION_TICK, (spec) => flashStatusLocal(spec ?? {}));
    log("[BD][PassiveCardUI] socket registered");
  } catch (e) {
    warn("[BD][PassiveCardUI] init failed", e);
  }
}
