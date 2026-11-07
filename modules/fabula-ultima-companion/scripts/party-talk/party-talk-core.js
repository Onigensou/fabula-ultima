// ============================================================================
// Party Talk — pure core (no Foundry, no DOM)
// ----------------------------------------------------------------------------
// Field chatter typed by the table: a player presses T on an exploration,
// dungeon or camp map, types a line, and every client shows it on the left
// beside the speaker's portrait for a few seconds. Design + mockup:
// docs/party-talk-design.md, https://claude.ai/artifact/JvoZp7b6DsFTmQGaz1AMRY
//
// This file holds everything that can be tested in bare Node:
//   text units (Thai clusters stay whole, Japanese counts double), the limit,
//   read time, slash commands, action formatting, line validation, face crops
//   and the bubble queue.
//
// Harness: node scripts/party-talk/party-talk-core.test.mjs
// ============================================================================

export const MODULE_ID = "fabula-ultima-companion";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;
export const MSG_TYPE = "ONI_PARTY_TALK_V1";

/** Scene modes (flags.<mod>.oniFabula.general.sceneMode) where Party Talk runs. */
export const TALK_SCENE_MODES = new Set(["exploration", "dungeon", "camp"]);

export const MODES = Object.freeze(["say", "shout", "think", "action"]);
export const MODE_LABEL = Object.freeze({ say: "Say", shout: "Shout", think: "Think", action: "Action" });

/** Line limit in units: Latin/Thai cluster = 1, Japanese character = 2. */
export const LIMIT = 120;
export const MAX_VISIBLE = 2;
export const PER_SPEAKER_WAITING = 2;
export const LOG_MAX = 30;
/** While anyone waits, bubble timers run this much faster. */
export const PRESSURE = 1.75;
/** Typewriter speed, units per second. */
export const CPS = 70;

// ── text units ─────────────────────────────────────────────────────────────
const SEG = (typeof Intl !== "undefined" && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** Grapheme clusters: "ที่" is ONE cluster (3 code points), never split. */
export function graphemes(s) {
  const str = String(s ?? "");
  return SEG ? Array.from(SEG.segment(str), (x) => x.segment) : Array.from(str);
}

const WIDE = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
export const unitOf = (g) => (WIDE.test(g) ? 2 : 1);
export const units = (s) => graphemes(s).reduce((n, g) => n + unitOf(g), 0);

/** Script of a line, for lang="" (line breaking, glyph choice). */
export function langOf(s) {
  const str = String(s ?? "");
  if (/[฀-๿]/.test(str)) return "th";
  if (/[぀-ヿ㐀-鿿]/.test(str)) return "ja";
  return "en";
}

/** Trim to LIMIT units without cutting a cluster. */
export function clampUnits(s, limit = LIMIT) {
  const str = String(s ?? "");
  if (units(str) <= limit) return str;
  let out = "", n = 0;
  for (const g of graphemes(str)) {
    const w = unitOf(g);
    if (n + w > limit) break;
    out += g; n += w;
  }
  return out;
}

/** How long a bubble stays up after it finishes typing (ms). */
export const duration = (text) => Math.min(12000, Math.max(5000, 4000 + 70 * units(text)));
/** How long the typewriter takes (ms). */
export const typeMs = (text) => (units(text) / CPS) * 1000;

// ── slash commands ─────────────────────────────────────────────────────────
const SLASH = { s: "say", say: "say", y: "shout", yell: "shout", shout: "shout",
  t: "think", think: "think", me: "action", em: "action", emote: "action" };

/** "/y Hello" → { mode: "shout", rest: "Hello" }; anything else → { mode: null, rest }. */
export function parseSlash(value) {
  const str = String(value ?? "");
  const m = str.match(/^\/(say|s|yell|y|shout|think|t|me|emote|em)\s+/i);
  if (!m) return { mode: null, rest: str };
  return { mode: SLASH[m[1].toLowerCase()], rest: str.slice(m[0].length) };
}

// ── line formatting ────────────────────────────────────────────────────────
/**
 * A line as styled segments [{ t, cls? }].
 *  - action (English): the speaker's name leads ("Hina peers into the well."),
 *    unless the line already starts with it or the speaker is the narrator.
 *  - action (Japanese / Thai): no name; those languages drop the subject.
 *  - *text* inside a say/shout/think line: an inline action (cls act-inline).
 *  - asterisks inside an action line are dropped.
 */
export function toSegments(text, mode, speakerName = "", { narrator = false } = {}) {
  const str = String(text ?? "");
  const segs = [];
  const name = String(speakerName ?? "").trim();
  if (mode === "action" && !narrator && name && langOf(str) === "en"
      && !str.toLowerCase().startsWith(name.toLowerCase())) {
    segs.push({ t: name, cls: "act-name" }, { t: " " });
  }
  for (const part of str.split(/(\*[^*]+\*)/)) {
    if (!part) continue;
    if (mode !== "action" && /^\*[^*]+\*$/.test(part)) segs.push({ t: part.slice(1, -1), cls: "act-inline" });
    else segs.push({ t: mode === "action" ? part.replace(/\*/g, "") : part });
  }
  return segs.filter((s) => s.t);
}

/** Plain text of a line as shown (for the log, accessibility). */
export const plainText = (segs) => segs.map((s) => s.t).join("");

// ── validation ─────────────────────────────────────────────────────────────
const cleanStr = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const num01 = (v, d) => (Number.isFinite(+v) && +v > 0 && +v <= 1.5 ? +v : d);

/**
 * Normalise a line from the socket. Returns null when it can't be shown.
 * Text is clamped to LIMIT units; strings are length-capped; mode must be known.
 * Rendering always uses textContent, so markup in text is shown, never parsed.
 */
export function sanitizeLine(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = MODES.includes(raw.mode) ? raw.mode : null;
  const text = clampUnits(cleanStr(raw.text, 600).trim());
  if (!mode || !text) return null;
  const sp = raw.speaker ?? {};
  const face = sp.face ?? {};
  return {
    id: cleanStr(raw.id, 64) || `${Date.now()}`,
    userId: cleanStr(raw.userId, 32),
    mode,
    text,
    ts: Number.isFinite(+raw.ts) ? +raw.ts : Date.now(),
    speaker: {
      key: cleanStr(sp.key, 64),
      actorId: cleanStr(sp.actorId, 32) || null,
      name: cleanStr(sp.name, 60),
      narrator: !!sp.narrator,
      face: {
        src: cleanStr(face.src, 500),
        fx: num01(face.fx, 0.5), fy: num01(face.fy, 0.4), fw: num01(face.fw, 0.5),
        cut: !!face.cut,
      },
    },
  };
}

// ── face crop ──────────────────────────────────────────────────────────────
/**
 * Place an image inside a square box so the face fills `fill` of the box width
 * with its centre at height `faceY`. Image is w×h px; face = { fx, fy, fw } as
 * fractions of the image (centre x, centre y, face width / image width).
 * Returns CSS percentages of the box: { width, left, top } (never leaves a gap).
 */
export function faceCrop(face, w, h, fill = 0.78, faceY = 0.54) {
  const fw = Math.max(0.02, face?.fw ?? 0.5);
  const scale = fill / fw;
  const imgH = scale * (h > 0 && w > 0 ? h / w : 1);
  let left = 0.5 - (face?.fx ?? 0.5) * scale;
  let top = faceY - (face?.fy ?? 0.4) * imgH;
  if (scale >= 1) left = Math.min(0, Math.max(1 - scale, left)); else left = (1 - scale) / 2;
  if (imgH >= 1) top = Math.min(0, Math.max(1 - imgH, top)); else top = (1 - imgH) / 2;
  return { width: scale * 100, left: left * 100, top: top * 100 };
}

// Portraits for the party, tuned in the approved mockup. An actor flag
// flags.<mod>.talkPortrait { src, fx, fy, fw, cut } overrides these; anything
// else falls back to the actor's own image in a round frame.
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
export const PARTY_FACES = Object.freeze({
  hina:    { src: `${FORGE}/Character/Hina/Portrait/Hina_Portrait001.png`,       fx: 0.52, fy: 0.60, fw: 0.40, cut: true },
  zarg:    { src: `${FORGE}/Character/Zarg/Portrait/Zarg_Portrait.png`,          fx: 0.47, fy: 0.43, fw: 0.50, cut: true },
  keren:   { src: `${FORGE}/Character/Keren/Portrait/Keren_Portrait001.png`,     fx: 0.51, fy: 0.51, fw: 0.44, cut: true },
  blanche: { src: `${FORGE}/Character/Blanche/Portrait/Blanche_Portrait001.png`, fx: 0.55, fy: 0.53, fw: 0.42, cut: true },
});
export const NARRATOR_FACE = Object.freeze({ src: `${FORGE}/GM_Portrait.png`, fx: 0.5, fy: 0.5, fw: 0.85, cut: false });
export const FALLBACK_FACE = Object.freeze({ fx: 0.5, fy: 0.38, fw: 0.55, cut: false });

/** Face for an actor-like { name, img, flag }: flag > party default (by first name) > image. */
export function resolveFace({ name, img, flag } = {}) {
  if (flag && typeof flag === "object" && (flag.src || img)) {
    return { ...FALLBACK_FACE, ...flag, src: flag.src || img };
  }
  const first = String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (PARTY_FACES[first]) return { ...PARTY_FACES[first] };
  return { ...FALLBACK_FACE, src: img || "" };
}

// ── queue ──────────────────────────────────────────────────────────────────
/**
 * Which bubbles are on screen and which wait. Every send is its own bubble
 * (no merging). Time is passed in, so the same logic runs in tests.
 *
 *   offer(line, now)  → "show" | "wait" | "log"
 *   expire(now)       → ids that just ran out (call often)
 *   remove(id)        → drop a visible bubble (dismissed / faded out)
 *   promote(now)      → lines that may now enter (fills free slots)
 *
 * A visible bubble holds { line, readyAt (typing done), endAt }. While any
 * line waits, the time left runs PRESSURE× faster.
 */
export class TalkQueue {
  constructor({ maxVisible = MAX_VISIBLE, perSpeaker = PER_SPEAKER_WAITING } = {}) {
    this.maxVisible = maxVisible;
    this.perSpeaker = perSpeaker;
    this.visible = [];
    this.waiting = [];
    this._lastTick = null;
  }

  offer(line, now) {
    if (this.visible.length < this.maxVisible && !this.waiting.length) { this._enter(line, now); return "show"; }
    const key = line.speaker?.key ?? line.userId;
    if (this.waiting.filter((l) => (l.speaker?.key ?? l.userId) === key).length >= this.perSpeaker) return "log";
    this.waiting.push(line);
    return "wait";
  }

  _enter(line, now) {
    const readyAt = now + typeMs(line.text);
    this.visible.push({ line, readyAt, left: duration(line.text), held: false });
  }

  /** Advance timers to `now`; returns ids whose time ran out. */
  expire(now) {
    // No cap on dt: a tab that slept through a bubble's time drops it on wake
    // instead of replaying stale chatter (Party Talk never holds for hidden tabs).
    const dt = this._lastTick == null ? 0 : Math.max(0, now - this._lastTick);
    this._lastTick = now;
    const rate = this.waiting.length ? PRESSURE : 1;
    const out = [];
    for (const v of this.visible) {
      if (v.gone) continue;
      if (now < v.readyAt || v.held) continue;
      v.left -= dt * rate;
      if (v.left <= 0) { v.gone = true; out.push(v.line.id); }
    }
    return out;
  }

  /** Hold or release a bubble's timer (hover). */
  hold(id, on) { const v = this.visible.find((x) => x.line.id === id); if (v) v.held = !!on; }

  remove(id) { this.visible = this.visible.filter((v) => v.line.id !== id); }

  promote(now) {
    const shown = [];
    while (this.waiting.length && this.visible.length < this.maxVisible) {
      const line = this.waiting.shift();
      this._enter(line, now);
      shown.push(line);
    }
    return shown;
  }

  /** Empty everything (story event started, scene left). Returns the waiting lines. */
  flush() { const w = this.waiting; this.visible = []; this.waiting = []; return w; }
}
