// status-classifier.js — which battle UI tier an Active Effect belongs to.
//
// One answer, shared by every surface that shows statuses in a battle:
// battle-focus (token icons), the player HUD (pips + Ready chips), the NPC
// status strip, the token cues and the pop text. Pure: no Foundry globals
// except CONFIG.statusEffects, which callers may pass in (the tests do).
//
// Tiers, first match wins:
//   hidden   flagged hidden, or tag `hidden`            never shown anywhere
//   resource tag `resource` / `points`                  Clocks; the HUD draws rings
//   ready    tag `ready`, or a name ending in "Ready"   an ability still usable
//   debuff   an FU condition (Burn, Slow, Wet…), tag `debuff`, or a timed
//            effect whose numeric changes are all negative
//   buff     tag `buff` / `guard` / `cover`, Guard, or any other timed effect
//   marker   everything else: food, camp results, standing passives
//
// Vocabulary rule (user, 2026-10-27): player-facing words are buff / debuff.
//
// Cues: the statuses that draw a visual on the token (status-cues.js, phase 6).

const NS = "fabula-ultima-companion";

export const TIER = Object.freeze({
  HIDDEN: "hidden", RESOURCE: "resource", READY: "ready",
  DEBUFF: "debuff", BUFF: "buff", MARKER: "marker",
});

// The condition_<slug> props on the actor templates (condition-affinity.js),
// plus the few debuff statuses that have no affinity prop.
export const DEBUFF_SLUGS = new Set([
  "anomaly", "bane", "berserk", "bleed", "blind", "burn", "charm", "confused", "curse",
  "dazed", "delayed", "despair", "disarmed", "doom", "enraged", "envenomed", "fatigue",
  "frightened", "grappled", "hypothermia", "isolate", "obscure", "oil", "panic",
  "paralyzed", "petrify", "poisoned", "shaken", "silence", "slow", "stagger", "suppress",
  "turbulence", "weak", "wet", "wither", "zombie",
  "sleep", "frozen", "provoked",
  "crisis",   // public in FU; enemy passives (Predator) key off it
]);

// Tactical states from the status hub that help their bearer.
const BUFF_STATE_SLUGS = new Set(["guard", "flying", "hidden", "covered", "bodyguard"]);

// Shown by the battler pose instead (KO pose / defeat), never as a pip.
const POSE_STATE_SLUGS = new Set(["ko"]);

// Display-name slugs that drifted from the prop keys (condition-affinity.js).
const ALIASES = {
  doomed: "doom", cursed: "curse", charmed: "charm", delay: "delayed",
  suppressed: "suppress", paralyze: "paralyzed",
};

// Status → token cue id. Everything not listed draws nothing on the token.
export const STATUS_CUES = Object.freeze({
  burn: "burn", blind: "blind", poisoned: "poison", envenomed: "poison", wet: "wet",
  paralyzed: "paralyze", silence: "silence", provoked: "provoked", sleep: "sleep",
});

// `dispellable` = a spell's buff (Elemental Weapon, Mirror…); dances are buffs.
const BUFF_TAGS = ["buff", "guard", "cover", "dispellable", "dance-effect"];

/** Lower-cased `system.tags` of an effect (the canonical AE tag store). */
export function tagsOf(eff) {
  const t = eff?.system?.tags;
  return Array.isArray(t) ? t.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
}

/** "Provoked (Capote)" → "provoked". */
export function baseSlug(name) {
  const s = String(name ?? "").toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  return ALIASES[s] ?? s;
}

function statusList(eff) {
  const s = eff?.statuses;
  if (!s) return [];
  if (typeof s.has === "function" && typeof s[Symbol.iterator] === "function") return [...s];
  return Array.isArray(s) ? s : [];
}

/** Every slug the effect answers to: its name, its status ids, and those ids' names. */
export function slugsOf(eff, statusConfig = globalThis.CONFIG?.statusEffects ?? []) {
  const out = new Set();
  const add = (v) => { const s = baseSlug(v); if (s) out.add(s); };
  add(eff?.name);
  for (const sid of statusList(eff)) {
    add(sid);
    const entry = statusConfig.find?.((c) => c?.id === sid);
    if (entry) add(entry.name ?? entry.label);
  }
  return out;
}

/** The FU condition (or other debuff status) this effect is, else null. */
export function conditionOf(eff, statusConfig) {
  for (const s of slugsOf(eff, statusConfig)) if (DEBUFF_SLUGS.has(s)) return s;
  return null;
}

/** Token cue id for the effect, else null. */
export function cueOf(eff, statusConfig) {
  for (const s of slugsOf(eff, statusConfig)) if (STATUS_CUES[s]) return STATUS_CUES[s];
  return null;
}

function isTimed(eff) {
  const d = eff?.duration ?? {};
  return (Number(d.rounds) || 0) > 0 || (Number(d.turns) || 0) > 0 || (Number(d.seconds) || 0) > 0;
}

// -1 all numeric changes negative, +1 any positive, 0 no numeric changes.
function changeSign(eff) {
  const nums = (eff?.changes ?? []).map((c) => Number(c?.value)).filter((n) => Number.isFinite(n) && n !== 0);
  if (!nums.length) return 0;
  return nums.every((n) => n < 0) ? -1 : 1;
}

/** The tier for one effect (see the header). */
export function classifyEffect(eff, statusConfig) {
  if (!eff) return TIER.HIDDEN;
  const tags = tagsOf(eff);
  if (eff.flags?.[NS]?.hidden || tags.includes("hidden")) return TIER.HIDDEN;
  if (tags.includes("resource") || tags.includes("points")) return TIER.RESOURCE;
  const slugs = slugsOf(eff, statusConfig);
  if ([...slugs].some((s) => POSE_STATE_SLUGS.has(s))) return TIER.HIDDEN;
  if (tags.includes("ready") || /\bready$/i.test(String(eff.name ?? "").trim())) return TIER.READY;
  if (tags.includes("debuff") || conditionOf(eff, statusConfig)) return TIER.DEBUFF;
  if (BUFF_TAGS.some((t) => tags.includes(t))) return TIER.BUFF;
  if ([...slugs].some((s) => BUFF_STATE_SLUGS.has(s))) return TIER.BUFF;
  if (isTimed(eff)) return changeSign(eff) < 0 ? TIER.DEBUFF : TIER.BUFF;
  return TIER.MARKER;
}

/** Shown as a pip / tile in battle (debuffs and buffs; Ready has its own chip). */
export function isStatusTier(tier) { return tier === TIER.DEBUFF || tier === TIER.BUFF; }

/** Display order: debuffs, buffs, ready, markers. */
export const TIER_ORDER = Object.freeze({ debuff: 0, buff: 1, ready: 2, marker: 3, resource: 4, hidden: 5 });

/**
 * NPC or monster (no HUD card) vs player character. CSB makes every actor the
 * same type, so test the props — npc_rank AND species (some NPCs carry only
 * species). Never hasPlayerOwner.
 */
export function isNpcActor(actor) {
  const p = actor?.system?.props ?? {};
  return !!(String(p.npc_rank ?? "").trim() || String(p.species ?? "").trim());
}
