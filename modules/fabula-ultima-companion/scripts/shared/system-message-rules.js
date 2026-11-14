// ============================================================================
// System Message Panel — the pure rules (no DOM, no Foundry).
// Runtime: system-message.js. Tests: system-message-rules.test.mjs.
//
// The JRPG battle text box: one short line under the turn order, in the
// game's wood / gold / parchment frame. Approved on mockup v2, 2026-11-10
// (https://claude.ai/artifact/8t7cn7oWQqCwz3QiB21MGC); every default below is
// the user's pick, and every alternative stays available as an option.
// ============================================================================

export const KINDS = Object.freeze(["system", "speech", "alert", "narration"]);
export const ENTRANCES = Object.freeze(["slide", "open", "scale", "appear", "drop"]);

// Panel-wide defaults. `configure()` overrides them per client.
export const DEFAULTS = Object.freeze({
  enter: "slide",        // horizontal slide + fade: in from the left, out to the right
  advance: "auto",       // "press" waits for a click — only then does the pip show
  // Size: the mockup pick (46 / 23 / 0.9 / 11.2) read too big in-game — the
  // mockup's "screen" was drawn ~1200 px wide, so the same proportions looked
  // smaller there. Scaled ~0.8 on width and text after the watched run (11-10).
  widthPct: 38,          // of the window width
  fontPx1080: 18,        // text size on a 1920-wide screen; scales with the window
  heightScale: 0.9,      // box padding / min height
  // Below the BD action namecard (director-vfx.js: offsetY 64 px at a 900 px
  // baseline, scaled by window height → it spans ~7–12% of the window). At the
  // mockup's 11.2% the two overlapped when a passive answered an attack (11-10).
  topPct: 14.5,          // from the top of the window
  cps: 40,               // letter-by-letter pace
  minHoldMs: 1600,       // shortest time a finished line stays up (auto)
  holdBaseMs: 900,       // hold = base + per-char, at least minHoldMs
  holdPerCharMs: 28,
  maxWaitMs: 30000,      // "press" lines close by themselves after this
  maxQueueAgeMs: 8000,   // an auto line still queued after this is dropped, never shown late
});

// User, 2026-11-10: narration reads best letter by letter; systematic
// messages (stat changes, "draws its X") read best all at once.
export const KIND_REVEAL = Object.freeze({ system: "instant", speech: "instant", alert: "instant", narration: "type" });

const CLS = Object.freeze({ w: "kw", up: "up", down: "down", flat: "flat", st: "kw", p: "party" });

// "{w:Swords} {up:increased}!" → [{ t, cls? }]. Unknown tags stay literal, so
// a stray brace in authored text never eats words.
// {st:Slow}      a status: its name (umber) with the status icon in front. The
//                segment carries status: "Slow"; the runtime looks the icon up.
// {p:The party}  the whole party, in its own colour.
export function parseMarkup(text) {
  const s = String(text ?? "");
  const out = [];
  const re = /\{(w|up|down|flat|st|p):([^{}]*)\}/g;
  let i = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > i) out.push({ t: s.slice(i, m.index) });
    out.push(m[1] === "st" ? { t: m[2], cls: CLS.st, status: m[2] } : { t: m[2], cls: CLS[m[1]] });
    i = re.lastIndex;
  }
  if (i < s.length) out.push({ t: s.slice(i) });
  return out;
}

export function plainText(text) {
  return parseMarkup(text).map((p) => p.t).join("");
}

// How long a finished auto line stays up.
export function holdMs(text, cfg = DEFAULTS) {
  const n = plainText(text).length;
  return Math.max(cfg.minHoldMs, cfg.holdBaseMs + n * cfg.holdPerCharMs);
}

// How long letter-by-letter typing takes.
export function typeMs(text, cfg = DEFAULTS) {
  return Math.ceil((plainText(text).length / Math.max(1, cfg.cps)) * 1000);
}

// A message as given (string or object) + panel cfg → the resolved message.
export function normalizeMessage(input, cfg = DEFAULTS) {
  const m = typeof input === "string" ? { text: input } : { ...(input ?? {}) };
  const kind = KINDS.includes(m.kind) ? m.kind : "system";
  const reveal = m.reveal === "type" || m.reveal === "instant" ? m.reveal : KIND_REVEAL[kind];
  const advance = m.advance === "press" || m.advance === "auto" ? m.advance : cfg.advance;
  const enter = ENTRANCES.includes(m.enter) ? m.enter : cfg.enter;
  const hold = Number(m.hold) > 0 ? Number(m.hold) : null;
  return {
    text: String(m.text ?? ""),
    kind, reveal, advance, enter, hold,
    speaker: m.speaker ? String(m.speaker) : (kind === "speech" ? "" : null),
  };
}
