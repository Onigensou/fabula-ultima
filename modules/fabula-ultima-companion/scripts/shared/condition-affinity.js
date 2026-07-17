// ============================================================================
// Shared — Condition affinity (immunity / resistance) lookup
//
// One place that answers "how does this actor react to this condition?".
// Actors carry per-condition affinity props on their sheet:
//
//   system.props.condition_<slug> = "NA" (or blank) | "RS" | "IM"
//
// (37 fields: condition_burn, condition_poisoned, … — dropdowns on the NPC
// template, label fields on the PC template.)
//
//   IM — immune:   the condition NEVER lands. Appliers skip the AE entirely.
//   RS — resist:   each application grants AT MOST 1 charge; chargeless AEs
//                  stay chargeless and get their duration clamped instead
//                  (so a default 3-round condition lasts ~1 round).
//
// Resolving an AE template → prop slug is the tricky part. Every condition AE
// carries a Foundry status id in `statuses` (an opaque id like
// "cDgbFRi9TA68TvYr"), which CONFIG.statusEffects maps to a display name
// ("Burn"). Slugified names USUALLY match the prop key (burn →
// condition_burn), but a handful of AE names drifted from the prop slugs —
// STATUS_SLUG_ALIASES patches those. Non-condition ids ("fud-bodyguard",
// buffs, …) resolve to no condition_* prop and return null, so appliers can
// call this unconditionally.
//
// Callers (all inside Battle Director — the scope is deliberately BD-only for
// now): skill-effects.js `apply_ae` (IM skip + RS charge/turn clamps for
// BD-applied conditions) and condition-adoption.js (the preCreateActiveEffect
// hook that gates/reshapes conditions applied mid-battle by non-BD paths).
// `clampEffectDataForResist` is currently unused — reserved for the deferred
// out-of-battle (whole-game) handling. Keep callers reading from here.
// ============================================================================
(() => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};

  const FLAG_NS = "fabula-ultima-companion";

  // Slugified status/AE display names whose actor prop key differs.
  // left = slugified name, right = the condition_<slug> suffix actually
  // present on the actor templates.
  const STATUS_SLUG_ALIASES = {
    doomed:     "doom",
    cursed:     "curse",
    charmed:    "charm",
    delay:      "delayed",
    suppressed: "suppress",
    paralyze:   "paralyzed",
  };

  const slugify = (s) => String(s ?? "").trim().toLowerCase();

  // "IM" | "RS" | null for one slug. Only fires when the prop EXISTS —
  // unknown slugs (buffs, custom ids) fall through to null.
  function propAffinity(props, slug) {
    if (!slug) return null;
    const key = `condition_${STATUS_SLUG_ALIASES[slug] ?? slug}`;
    if (!(key in props)) return null;
    const v = String(props[key] ?? "").trim().toUpperCase();
    return (v === "IM" || v === "RS") ? v : null;
  }

  // getConditionAffinity(actor, { statuses, name }) → "IM" | "RS" | null
  //
  //   statuses — the AE's `statuses` (Set on a live document, array on raw
  //              template data). Each entry may be a canonical slug ("slow")
  //              or an opaque Foundry status id (resolved via
  //              CONFIG.statusEffects id → name → slug).
  //   name     — the AE's display name, used as a fallback when the template
  //              carries no resolvable status id.
  //
  // When several statuses map to different affinities, IM wins over RS.
  function getConditionAffinity(actor, { statuses, name } = {}) {
    const props = actor?.system?.props;
    if (!props) return null;
    const cfg = globalThis.CONFIG?.statusEffects ?? [];
    const found = new Set();

    let list = [];
    if (statuses) {
      if (typeof statuses.has === "function") list = Array.from(statuses);
      else if (Array.isArray(statuses)) list = statuses;
    }
    for (const sid of list) {
      const raw = String(sid ?? "").trim();
      if (!raw) continue;
      const direct = propAffinity(props, slugify(raw));           // already a slug
      if (direct) found.add(direct);
      const entry = cfg.find((e) => e.id === raw);                 // opaque id → name
      const entryName = entry?.name ?? entry?.label;
      if (entryName) {
        const a = propAffinity(props, slugify(entryName));
        if (a) found.add(a);
      }
    }
    if (name) {
      const a = propAffinity(props, slugify(name));
      if (a) found.add(a);
    }

    if (found.has("IM")) return "IM";
    if (found.has("RS")) return "RS";
    return null;
  }

  // RS clamp for RAW AE creation data (mutates in place; returns true if it
  // changed anything). Charges > 1 → 1. A chargeless AE stays chargeless —
  // never stamps a charges flag onto it — and gets its native
  // duration.rounds/turns clamped to 1 instead. (The battle director does NOT
  // use this: its lifecycle runs on directorAppliedBy.turnsRemaining and it
  // clamps inline in apply_ae.)
  function clampEffectDataForResist(effectData) {
    if (!effectData || typeof effectData !== "object") return false;
    let changed = false;
    const ns = effectData.flags?.[FLAG_NS];
    if (ns && Number(ns.charges) > 1) {
      ns.charges = 1;
      changed = true;
    } else {
      const d = effectData.duration;
      if (d && Number(d.rounds) > 1) { d.rounds = 1; changed = true; }
      if (d && Number(d.turns) > 1)  { d.turns = 1;  changed = true; }
    }
    return changed;
  }

  globalThis.FUCompanion.api.conditionAffinity = {
    getConditionAffinity,
    clampEffectDataForResist,
    STATUS_SLUG_ALIASES,
  };
})();
