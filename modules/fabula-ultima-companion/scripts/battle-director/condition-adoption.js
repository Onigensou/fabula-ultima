// ============================================================================
// Battle Director — Condition adoption (immunity / resistance INSIDE a battle)
//
// PROBLEM. Conditions applied by BD's own `apply_ae` are "BD-shaped": canonical
// Debuff-container template (charges + the reactionConfig that drives DOTs) plus
// a `directorAppliedBy` stamp that BD's turn/charge tickers key off. Conditions
// applied by ANY OTHER path during a battle — the Active Effect Manager UI, the
// token-HUD status toggle, a macro — arrive as a bare CONFIG.statusEffects clone
// with none of that. They never expire (no ticker sees them) and carry no
// charges. A Bane the target RESISTS was the trigger: it landed with 0 charges
// and sat on the actor forever.
//
// SCOPE (deliberately narrow — set by the design owner). This ONLY acts on an AE
// when the bearer has an explicit RS or IM value for THAT condition
// (`system.props.condition_<slug>`). AEs are used for a great many things in this
// game; anything the resolver can't tie to an RS/IM-flagged condition —
// non-condition buffs, neutral (NA) conditions, custom AEs — is left completely
// untouched and behaves exactly as it does today. It also only acts while a BD
// battle is running; out-of-battle handling is deferred.
//
// MECHANISM. A single `preCreateActiveEffect` hook, so the fix is atomic (no
// flash, no delete+recreate) and needs no multi-GM gate — preCreate fires only
// on the initiating client, before the create broadcasts:
//   • IM  → return false: the condition never lands (+ the status-immune cue).
//   • RS  → `updateSource` transforms the bare AE in place into a BD-shaped,
//           charge/turn-clamped condition (via buildAdoptedConditionData), so
//           the existing bearer-turn / charge tickers expire it normally.
// AEs BD already shaped (`directorAppliedBy` / `bdAdopted` present) are skipped,
// which also breaks the transform's own re-entrancy.
// ============================================================================

import {
  getConditionAffinityFor,
  resolveCanonicalConditionTemplate,
  buildAdoptedConditionData,
} from "./skill-effects.js";
import { playStatusImmuneVfx } from "./director-vfx.js";

const FLAG_NS = "fabula-ultima-companion";

let _installed = false;
let _getActiveDirector = null;

// The TokenDocument uuid to anchor the IM cue on. Synthetic (unlinked) token
// actors expose `.token` directly; a linked/world actor resolves via its active
// canvas token(s). Deliberately does NOT read `game.combat` — inside a BD battle
// that is null (the director keeps its own combat model), which was the original
// bug. Best-effort: a null uuid just floats the cue with no anchor.
function bearerTokenUuid(bearer) {
  if (bearer?.token?.uuid) return bearer.token.uuid;
  try {
    const tok = bearer?.getActiveTokens?.(false, true)?.[0];
    if (tok?.uuid) return tok.uuid;
  } catch { /* ignore */ }
  return null;
}

// Install once on ready. `getActiveDirector` returns the running BattleDirector
// instance (or null out of combat) — the "is a BD battle live" gate.
export function installConditionAdoptionWatcher({ getActiveDirector } = {}) {
  if (_installed) return;
  _installed = true;
  _getActiveDirector = typeof getActiveDirector === "function" ? getActiveDirector : null;

  Hooks.on("preCreateActiveEffect", (effect) => {
    try {
      // Only inside a running BD battle.
      if (_getActiveDirector && !_getActiveDirector()) return;

      const bearer = effect.parent instanceof Actor ? effect.parent : null;
      if (!bearer) return;

      // Skip AEs BD already shaped (its own apply_ae output, or a prior adopt).
      const ns = effect.flags?.[FLAG_NS] ?? {};
      if (ns.directorAppliedBy || ns.bdAdopted) return;

      // No combatant-membership gate: `game.combat` is null inside a BD battle
      // (director owns its combat model), and battle-live + the RS/IM affinity
      // filter below already scope this tightly enough. A condition on a
      // non-combatant is an accepted edge — adopting it is harmless.

      // THE FILTER: only RS/IM-flagged conditions. null covers non-condition
      // AEs and NA conditions → leave them exactly as they are today.
      const affinity = getConditionAffinityFor(bearer, { statuses: effect.statuses, name: effect.name });
      if (!affinity) return;

      if (affinity === "IM") {
        try { playStatusImmuneVfx({ tokenUuid: bearerTokenUuid(bearer), statusName: effect.name }); }
        catch (e) { console.warn("[condition-adoption] IM cue threw", e); }
        return false;   // block the create entirely — the condition never lands
      }

      // RS: reconstitute the bare AE as a BD-shaped, clamped condition. Prefer
      // the canonical charge/reactionConfig-bearing template; fall back to the
      // AE's own data if this status has no curated template.
      const template = resolveCanonicalConditionTemplate(effect.statuses) ?? effect.toObject();
      const bdData = buildAdoptedConditionData(template, { affinity: "RS" });
      effect.updateSource(bdData);
    } catch (e) {
      console.warn("[condition-adoption] preCreateActiveEffect hook threw", e);
    }
  });

  console.log("[condition-adoption] RS/IM in-battle condition watcher installed");
}
