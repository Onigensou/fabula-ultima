// ============================================================================
// Shared — Active Effect lifetime policy
//
// One place that answers "how does this AE expire?". Three systems used to
// answer it independently and they disagreed: rest treated `statuses:
// ["permanent"]` as protected, the dungeon turn tick did not, so a food buff
// (permanent + campRestCharges, expires at rest) was silently ticked down and
// deleted after 3 dungeon steps.
//
// The four lifetime classes:
//   director-permanent  flags.directorPermanent — never auto-expires (equipment
//                       set bonuses, "always Wet"). Only an explicit removal.
//   rest-bound          statuses has "permanent", or a numeric campRestCharges
//                       flag. Survives dungeon turns and battle rounds; expires
//                       at a Rest via rest-api's campRestCharges tick. Food
//                       buffs live here — they last the whole day.
//   charge-governed     lifetimeMode "on_activation" (consume_charge) or
//                       "round_end" (group-round mechanic, not a per-step tick).
//   turn-bound          everything else — the ordinary debuff that counts down
//                       per turn/step. This is the ONLY class the dungeon ticks.
//
// Item-transferred effects (origin `Item.…`) are also never turn-ticked: they
// are a projection of what the actor has equipped and the equipment, not a
// counter, decides when they go away. rest-api has always skipped them; the
// dungeon tick did not, which meant an equipped item's non-director AE could be
// deleted out from under it after 3 steps.
//
// Callers: dp-ae-lifecycle (tick), dp-status-hud (countdown badge), rest-api
// (rest cleanup). Keep those three reading from here, not from local copies.
// ============================================================================
(() => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};

  const FLAG_NS = "fabula-ultima-companion";

  function _flags(eff) {
    return eff?.flags?.[FLAG_NS] ?? {};
  }

  // `statuses` is a Set on a live ActiveEffect document but a plain array in raw
  // creation data / socket payloads. Accept both.
  function _hasStatus(eff, status) {
    const s = eff?.statuses;
    if (!s) return false;
    if (typeof s.has === "function") return s.has(status);
    return Array.isArray(s) && s.includes(status);
  }

  /** Equipment-managed / explicitly permanent. Never auto-expires. */
  function isDirectorPermanent(eff) {
    return _flags(eff).directorPermanent === true;
  }

  /** Lasts until the next Rest (food buffs). Ignored by every per-turn tick. */
  function isRestBound(eff) {
    if (_hasStatus(eff, "permanent")) return true;
    const charges = _flags(eff).campRestCharges;
    return charges != null && Number.isFinite(Number(charges));
  }

  /** Projected onto the actor by an equipped item; the item owns its lifetime. */
  function isItemTransferred(eff) {
    return String(eff?.origin ?? "").startsWith("Item.");
  }

  /** Expires on its own schedule (charges / round end), not a per-step counter. */
  function isChargeGoverned(eff) {
    const mode = String(_flags(eff).lifetimeMode ?? "").trim().toLowerCase();
    return mode === "on_activation" || mode === "round_end";
  }

  /**
   * True only for ordinary turn-bound effects — the ones a dungeon step should
   * count down. This is the single gate dp-ae-lifecycle and dp-status-hud use.
   */
  function isDungeonTickable(eff) {
    if (!eff) return false;
    return !isDirectorPermanent(eff)
        && !isRestBound(eff)
        && !isItemTransferred(eff)
        && !isChargeGoverned(eff);
  }

  globalThis.FUCompanion.AELifetime = {
    isDirectorPermanent,
    isRestBound,
    isItemTransferred,
    isChargeGoverned,
    isDungeonTickable,
  };

  console.debug("[Shared][AELifetime] Helper loaded.");
})();
