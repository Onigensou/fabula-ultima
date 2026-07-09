// ============================================================================
// Ritual System — constants, discipline registry, rulebook tables.
//
// Rituals (Fabula Ultima core, pp. 118–121) are the roleplaying-first magic
// system: the player describes an effect, the GM prices it from two tables
// (potency × area), and a Magic Check against a potency-derived Difficulty
// Level decides whether it works or twists catastrophically.
//
// This file holds only constants, pure data, and a local SFX helper. No DOM,
// no socket wiring — ritual-cost.js and ritual-actor.js import it and must
// stay headless-testable.
// ============================================================================

export const RITUAL_MODULE_ID = "fabula-ultima-companion";
export const RITUAL_TAG = "[FU][Ritual]";

// Raw-socket channel + envelope topics (player → active GM).
//
// CAST_REQ is fire-and-forget, not request/response. A cast runs a Check
// Requester session (dice, invokes, a confirm step) which can take a minute —
// far past any sane envelope timeout. The GM applies the MP debit and posts the
// outcome card; the result reaches the player through the chat card, not the
// socket. Same reasoning as clock-interaction.js.
//
// REFUSED travels back anyway. A cast the GM rejects (ineligible, unaffordable)
// posts no card, so without it the player's click would vanish in silence.
//
// FEEDBACK is operator → every OTHER client: the ritual window is local, so the
// rest of the table needs to see that someone is mid-ritual. Four players and
// no visual would make a long setup read as a stalled session.
export const RITUAL_CHANNEL = `module.${RITUAL_MODULE_ID}`;
export const RITUAL_SOCKET = Object.freeze({
  CAST_REQ: "ritual.cast.req",
  REFUSED:  "ritual.cast.refused",
  FEEDBACK: "ritual.feedback",
});

// CSB resource property, matching healing-const.js's HEAL_RESOURCE.mp.
// CSB stores current_* as STRINGS — always coerce with Number().
export const RITUAL_MP_PROP = Object.freeze({ cur: "current_mp", max: "max_mp" });

// CSB material item properties.
export const RITUAL_MATERIAL = Object.freeze({
  TYPE_PROP: "item_type",
  TYPE_VALUE: "material",
  RARITY_PROP: "item_rarity",
  QTY_PROP: "item_quantity",   // stored as a string
  COST_PROP: "item_cost",
});

// Feather cursor sprite — the same asset the Healing HUD and Save/Load UI use.
export const RITUAL_CURSOR_SRC = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/feather.png";

// Keyboard controls, imported wholesale from the Healing HUD so the two menus
// feel like one game. Arrows move between rows; Left/Right (and the wheel)
// scroll a value; Z confirms or scrolls forward; X cancels.
export const RITUAL_KEYS = Object.freeze({
  UP: ["ArrowUp", "w", "W"],
  DOWN: ["ArrowDown", "s", "S"],
  LEFT: ["ArrowLeft", "a", "A"],
  RIGHT: ["ArrowRight", "d", "D"],
  CONFIRM: ["z", "Z", "Enter"],
  CANCEL: ["x", "X", "Escape"],
});

// ── Local SFX ───────────────────────────────────────────────────────────────
// Same sound set as the Healing HUD; SCROLL is Check Roller's attribute-cycle
// sound, since the potency/area pickers are that control.
const _SND_BASE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/";

export const RITUAL_SFX = Object.freeze({
  OPEN:   { src: `${_SND_BASE}bond_create.wav`,      volume: 0.6 },
  MOVE:   { src: `${_SND_BASE}BattleCursor_4.wav`,   volume: 0.45 },
  SCROLL: { src: `${_SND_BASE}BattleCursor_1.wav`,   volume: 0.45 },
  SELECT: { src: `${_SND_BASE}BattleCursor_2.wav`,   volume: 0.55 },
  ARM:    { src: `${_SND_BASE}check_ready.wav`,      volume: 0.6 },
  CANCEL: { src: `${_SND_BASE}BattleCursor_2.wav`,   volume: 0.4 },
  DENY:   { src: `${_SND_BASE}BattleCursor_4.wav`,   volume: 0.35 },
  EXIT:   { src: `${_SND_BASE}bond_cleared.wav`,     volume: 0.6 },
});

/** Play a ritual SFX locally. Failures are swallowed — audio never breaks the HUD. */
export function playRitualSfx(key) {
  const cfg = typeof key === "string" ? RITUAL_SFX[key] : key;
  if (!cfg?.src) return;
  try {
    foundry.audio?.AudioHelper?.play?.({ src: cfg.src, volume: cfg.volume ?? 0.6, autoplay: true, loop: false }, false)
      ?? AudioHelper.play({ src: cfg.src, volume: cfg.volume ?? 0.6, autoplay: true, loop: false }, false);
  } catch (e) {
    console.warn(RITUAL_TAG, "SFX play failed", e);
  }
}

// ── Potency (core p. 119) ───────────────────────────────────────────────────
// `sections` is the Ritual Clock size from the RITUALS DURING CONFLICTS table
// (p. 121). Recorded here because it belongs to this rulebook table, but no v1
// code path reads it — the conflict flow is deferred to Battle Director.
export const POTENCY = Object.freeze({
  MINOR:   { id: "minor",   label: "Minor",   mp: 20, dl: 7,  sections: 4,
             example: "Create a flash of light, block a passage, shatter a glass." },
  MEDIUM:  { id: "medium",  label: "Medium",  mp: 30, dl: 10, sections: 6,
             example: "Create an illusion, treat an illness, locate someone." },
  MAJOR:   { id: "major",   label: "Major",   mp: 40, dl: 13, sections: 6,
             example: "Sense thoughts, dispel a curse, alter the weather." },
  EXTREME: { id: "extreme", label: "Extreme", mp: 50, dl: 16, sections: 8,
             example: "Weaken a divine entity, prevent a catastrophe." },
});

// ── Area (core p. 119) ──────────────────────────────────────────────────────
export const AREA = Object.freeze({
  INDIVIDUAL: { id: "individual", label: "Individual", multiplier: 1,
                example: "A human-sized creature, a door, a tree, a weapon." },
  SMALL:      { id: "small",      label: "Small",      multiplier: 2,
                example: "A few creatures, a large creature, a room, a hut." },
  LARGE:      { id: "large",      label: "Large",      multiplier: 3,
                example: "A crowd, a small forest, an airship, a castle hall." },
  HUGE:       { id: "huge",       label: "Huge",       multiplier: 4,
                example: "A fortress, a lake, a village, a city block." },
});

export const POTENCY_ORDER = Object.freeze(["minor", "medium", "major", "extreme"]);
export const AREA_ORDER    = Object.freeze(["individual", "small", "large", "huge"]);

// ── Cost reduction by offered material (homebrew) ───────────────────────────
// The book gives a flat "halve the cost once" for a rare or powerful
// ingredient (p. 120). We scale it by the material's rarity instead: 10% per
// tier, with a 20% jump from Rare to Legendary so the book's original halving
// survives as the Legendary case.
//
// Keys are the CSB `item_rarity` values, compared case-insensitively.
export const RARITY_DISCOUNT = Object.freeze({
  common:    0.10,
  uncommon:  0.20,
  rare:      0.30,
  legendary: 0.50,
});

export const RARITY_ORDER = Object.freeze(["common", "uncommon", "rare", "legendary"]);

/** Rarity → its cost reduction as a fraction, or 0 for an unknown rarity. */
export function discountForRarity(rarity) {
  return RARITY_DISCOUNT[String(rarity ?? "").toLowerCase()] ?? 0;
}

// Rarity tint for the picker rows.
export const RARITY_COLOR = Object.freeze({
  common:    "#7d7466",
  uncommon:  "#2f7d32",
  rare:      "#2f5fae",
  legendary: "#b8862f",
});

// ── Disciplines ─────────────────────────────────────────────────────────────
// Eligibility is resolved by ritual-actor.js against TWO independent layers,
// because neither alone covers the live world:
//
//   itemIds   — union of _stats.compendiumSource, _stats.duplicateSource and
//               flags.core.sourceId on the actor's embedded copy. Present on
//               some copies, absent on others, and occasionally pointing at a
//               DIFFERENT world item of the same name (there are duplicates).
//   itemNames — exact names. The only field every copy reliably carries.
//               An allowlist, never a prefix match: the world also holds
//               "Ritual Seal", "Curse Magic", "Curse Collector" and
//               "Curse Mallet", none of which grant a discipline.
//
// Ritualism grants on CLASS, not on any skill.
//
// `attrs` is the Magic Check attribute pair. Chimerism is the only discipline
// the book gives two pairs; `altAttrs` is offered as a toggle in the window.
const _ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/";

export const DISCIPLINE = Object.freeze({
  ARCANISM: {
    id: "arcanism", label: "Arcanism", attrs: ["WLP", "WLP"],
    icon: `${_ICON}stat.png`,
    itemIds: ["NqgJHogtrenPHxPP"],
    itemNames: ["Ritual Arcanism"],
    blurb: "Produce a magical effect based on the Arcana you have bound.",
  },
  CHIMERISM: {
    id: "chimerism", label: "Chimerism", attrs: ["INS", "WLP"], altAttrs: ["MIG", "WLP"],
    icon: `${_ICON}beast.png`,
    itemIds: ["4itLjWpw5cQKLgYt"],
    itemNames: ["Ritual Chimerism"],
    blurb: "Enhance your senses, see through the eyes of an animal, quell the fury of a monster.",
  },
  ELEMENTALISM: {
    id: "elementalism", label: "Elementalism", attrs: ["INS", "WLP"],
    icon: `${_ICON}raibcryst.png`,
    itemIds: ["LHR1vDVMGqEBIyMi"],
    itemNames: ["Ritual Elementalism"],
    blurb: "Walk on water, shape rock, snuff out fires, summon powerful cyclones.",
  },
  ENTROPISM: {
    id: "entropism", label: "Entropism", attrs: ["INS", "WLP"],
    icon: `${_ICON}Material/Genshin/Item_Alien_Life_Core.webp`,
    itemIds: ["tbtry6egID5MOcxv"],
    itemNames: ["Ritual Entropism"],
    blurb: "Cause the decay of physical matter, twist the flow of time, teleport creatures or items.",
  },
  RITUALISM: {
    id: "ritualism", label: "Ritualism", attrs: ["INS", "WLP"],
    icon: `${_ICON}Material/Genshin/Item_Divining_Scroll.webp`,
    itemIds: [], itemNames: [],
    classes: ["Chimerist", "Elementalist", "Entropist", "Spiritist"],
    blurb: "Extract magic from an object, activate a soul circuit, sense the presence of magic.",
  },
  SPIRITISM: {
    id: "spiritism", label: "Spiritism", attrs: ["INS", "WLP"],
    icon: `${_ICON}Material/Genshin/Item_Slime_Concentrate.webp`,
    // Curse Ritualism grants Spiritism too — it is a way of practising the
    // discipline (manipulating souls), not a discipline of its own. Either
    // skill suffices; neither requires the other.
    itemIds: ["JL9xPk3EXxh16ooY", "A7DaASySso4pdaar"],
    itemNames: ["Ritual Spiritism", "Curse Ritualism"],
    blurb: "Sense the presence and feelings of creatures, put someone to sleep or embolden their heart.",
  },
  ILLUSIONISM: {
    id: "illusionism", label: "Illusionism", attrs: ["INS", "WLP"],
    icon: `${_ICON}Material/Genshin/Item_Mistshroud_Helmet.webp`,
    itemIds: ["5J4eJJ466ztg20zm"],
    itemNames: ["Ritual Illusionism"],
    homebrew: true,
    blurb: "Create false imagery, sound and smell.",
  },
});

export const DISCIPLINE_ORDER = Object.freeze([
  "arcanism", "chimerism", "elementalism", "entropism",
  "ritualism", "spiritism", "illusionism",
]);

/** Look a discipline up by its lowercase id. */
export function disciplineById(id) {
  return Object.values(DISCIPLINE).find((d) => d.id === id) ?? null;
}
