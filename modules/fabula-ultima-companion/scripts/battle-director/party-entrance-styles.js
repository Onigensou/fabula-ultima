// ============================================================================
// Party entrance styles — the table (pure; no Foundry, no DOM).
//
// The party's default battle-start entrance is the run-in dash
// (director-init.js dashInParty). A party member may instead carry a bespoke
// entrance, chosen with the same actor flag the enemy styles use:
//
//   actor.flags["fabula-ultima-companion"].entranceStyle = "mirror"
//
// The keys here are a separate family on purpose: they are drawn by
// party-entrance-fx.js at the member's own battle spot, and they are never
// routed into the enemy descents (an unknown key there falls back to flame).
// entranceStyleFromFlags (boss-entrance-fx.js) therefore keeps reading these
// as "fade", and only partyEntranceStyleFromFlags below sees them.
//
// Each style replaces the dash for that member only. Members still start
// DASH_STAGGER_MS apart, top to bottom, like the dash.
//
// Times are ms from the member's own start. Approved on the mockup
// claude.ai/artifact/C1vS3jyg2nRHXFuB8Rco4E (v21); the drawing lives in
// party-entrance-fx.js. Sound picks are the user's (2026-10-25).
// ============================================================================

const SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const PARTY_ENTRANCE_MODULE_ID = "fabula-ultima-companion";
export const PARTY_ENTRANCE_STYLE_FLAG = "entranceStyle";

// Four entrances play at once, so every cue is mixed down by this much (the
// mockup's whole-party view).
export const PARTY_SFX_MIX = 0.85;

// The outcomes of a style that rolls: success / fail.
export const OUTCOME_SUCCESS = "H";
export const OUTCOME_FAIL = "T";

export const PARTY_ENTRANCE_STYLES = {
  // Hina: a mirror spins out of thin air, shows her and her shadow, shatters;
  // she is there in her battle sprite, the shadow deepens, then hides in her.
  mirror: {
    label: "Mirror (Hina · party)",
    totalMs: 2400,
    // the token's ground shadow fades in from here (she is on the field)
    landMs: 1480,
    // actor sprite props the renderer draws besides the token's own (battle) art
    clips: ["sprite_standard"],
    sfx: [
      { atMs: 80,   url: SFX + "Teleport.ogg", volume: 0.5 },
      { atMs: 1480, url: SFX + "Flash2.ogg",   volume: 0.55 },
    ],
  },

  // Keren: six fox-fire wisps spiral in, merge, burst; she is behind the
  // flame. A wink glint, and a heart blows out of it.
  foxfire: {
    label: "Foxfire (Keren · party)",
    totalMs: 2300,
    landMs: 880,
    clips: [],
    sfx: [
      { atMs: 880,  url: SFX + "Fire1.ogg", volume: 0.6 },
      { atMs: 1450, url: SFX + "Charm.ogg", volume: 0.55 },
    ],
  },

  // Blanche: runs in; a 50/50 roll (made ONCE on the host and broadcast)
  // decides a skid-and-twirl or a trip, face-plant and walk back to the mark.
  fiftyFifty: {
    label: "50/50 (Blanche · party)",
    totalMs: { [OUTCOME_SUCCESS]: 2000, [OUTCOME_FAIL]: 2800 },
    landMs: { [OUTCOME_SUCCESS]: 650, [OUTCOME_FAIL]: 2450 },
    roll: [OUTCOME_SUCCESS, OUTCOME_FAIL],
    clips: ["sprite_standard", "sprite_walk", "sprite_hurt", "sprite_ko", "sprite_crisis"],
    // only the default party run-in cue
    sfx: [{ atMs: 0, url: SFX + "DashA.wav", volume: 0.85 }],
  },

  // Zarg: a flash arrow sticks in his tile, leaves spiral in, the arrow warps
  // into him (battle sprite, firm landing), one glint off his eye.
  warningShot: {
    label: "Warning Shot (Zarg · party)",
    totalMs: 1800,
    landMs: 800,
    clips: [],
    sfx: [{ atMs: 80, url: SFX + "Soundboard/Crossbow.ogg", volume: 0.6 }],
  },
};

// Every cue the party styles can play, for the boot-time Web Audio warm-up
// (director-vfx.js preloadDirectorSfx): Hina's first cue is 80 ms in.
export const PARTY_ENTRANCE_SFX_URLS = Array.from(new Set(
  Object.values(PARTY_ENTRANCE_STYLES).flatMap((s) => (s.sfx ?? []).map((c) => c.url)),
));

const own = (key) => Object.prototype.hasOwnProperty.call(PARTY_ENTRANCE_STYLES, key);

/** The member's party style key, or null (plain dash) for anything else. */
export function partyEntranceStyleFromFlags(flags, ns = PARTY_ENTRANCE_MODULE_ID) {
  try {
    const key = String(flags?.[ns]?.[PARTY_ENTRANCE_STYLE_FLAG] ?? "").trim();
    return key && own(key) ? key : null;
  } catch { return null; }
}

/** Roll the outcome of a style that has one (host only), else null. */
export function rollPartyOutcome(style, random = Math.random) {
  const cfg = own(style) ? PARTY_ENTRANCE_STYLES[style] : null;
  if (!cfg?.roll?.length) return null;
  const r = Number(random());
  const i = Math.min(cfg.roll.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * cfg.roll.length)));
  return cfg.roll[i];
}

/** A valid outcome for `style`: the broadcast one, else the first (success). */
export function outcomeFor(style, outcome) {
  const cfg = own(style) ? PARTY_ENTRANCE_STYLES[style] : null;
  if (!cfg?.roll?.length) return null;
  return cfg.roll.includes(outcome) ? outcome : cfg.roll[0];
}

// A per-outcome number ({H: …, T: …}) or a plain one.
function pick(v, outcome) {
  if (v && typeof v === "object") return Number(v[outcome] ?? Object.values(v)[0]) || 0;
  return Number(v) || 0;
}

export function partyTotalMs(style, outcome) {
  return own(style) ? pick(PARTY_ENTRANCE_STYLES[style].totalMs, outcomeFor(style, outcome)) : 0;
}

export function partyLandMs(style, outcome) {
  return own(style) ? pick(PARTY_ENTRANCE_STYLES[style].landMs, outcomeFor(style, outcome)) : 0;
}

/** The style's cues, mixed for a party entrance, sorted by time. */
export function partySfx(style) {
  if (!own(style)) return [];
  return (PARTY_ENTRANCE_STYLES[style].sfx ?? [])
    .map((s) => ({ atMs: s.atMs, url: s.url, volume: (s.volume ?? 0.6) * PARTY_SFX_MIX }))
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * How long the whole party entrance runs, given each member's order index
 * (0 = top) and stagger. Dashers take `dashMs`; styled members their style.
 *   members = [{ style: key|null, outcome }]  (already in top→bottom order)
 */
export function partyEntranceSpanMs(members, { staggerMs = 120, dashMs = 520 } = {}) {
  let end = 0;
  (members ?? []).forEach((m, i) => {
    const len = m?.style && own(m.style) ? partyTotalMs(m.style, m.outcome) : dashMs;
    end = Math.max(end, i * staggerMs + len);
  });
  return end;
}
