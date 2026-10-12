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
//   charge-governed     lifetimeMode "on_activation" (consume_charge),
//                       "round_end" (group-round mechanic, not a per-step tick) or
//                       "persistent_counter" (a tracker / once-per-X pool that
//                       keeps its count until spent or swept). The same three
//                       modes skill-effects' UNTICKED_LIFETIME_MODES never
//                       turn-ticks in battle — the dungeon used to tick the
//                       third, deleting a stamped tracker after 3 steps.
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
// `describe()` is the read-only, player-facing summary of the same rules (the
// Party Menu Status view's Temporary / Permanent split).
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

  /**
   * Expires on its own schedule (charges spent, round end, a tracker's count),
   * not a per-step counter. The mode is read the way the battle ticks read it:
   * the director stamp's first (that is where a row's ae_lifetime_mode override
   * lands), the effect's own (template) flag as the fallback.
   */
  const UNTICKED_MODES = new Set(["on_activation", "round_end", "persistent_counter"]);
  function lifetimeModeOf(eff) {
    const f = _flags(eff);
    const stamp = f.directorAppliedBy && typeof f.directorAppliedBy === "object" ? f.directorAppliedBy : null;
    return String(stamp?.lifetimeMode || f.lifetimeMode || "").trim().toLowerCase();
  }
  function isChargeGoverned(eff) {
    return UNTICKED_MODES.has(lifetimeModeOf(eff));
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

  /**
   * Player-facing answer to "is this temporary, and until when?" (Party Menu
   * Status view). It DECIDES nothing — every branch names the code that acts:
   *   hosted on an Item   → lives as long as the item is held/equipped/learned
   *                         (v12 keeps transfer AEs on the item: origin is null,
   *                         so isItemTransferred above does not see them, and
   *                         no tick or sweep walks item effects)
   *   campRestCharges     → rest-api _tickCampRestEffects (N → expires at rest N+1)
   *   statuses "permanent" without charges, directorPermanent → nothing expires them
   *   directorAppliedBy.lifetimeMode round_end → skill-effects round-end sweep
   *     (the STAMP's mode, which is where a row's ae_lifetime_mode lands; the
   *     top-level flag is the template's and only the fallback)
   *   on_activation       → consume_charge
   *   stamp + charges     → the director's charge tick (chargeTickFor only ever
   *                         runs on stamped AEs; an unstamped `charges` is a counter)
   *   sceneExpiry         → bonus-actions scene sweep (ignores crossScene)
   *   stamp / duration / buff|debuff tag, not crossScene → sweepTransientAEsAtSceneEnd
   *   no origin or an Actor origin → rest-api _clearTemporaryEffects at a Rest
   * On top of that, anything isDungeonTickable is counted down per dungeon step
   * (dp-ae-lifecycle, 3 by default) — said in the label, and an effect that
   * would otherwise never expire becomes temporary because of it.
   * A persistent_counter is a tracker, labelled as one: dungeon steps leave it
   * alone (charge-governed), but otherwise it expires by the same rules
   * (116/137 templates carry neither crossScene nor directorPermanent, so the
   * scene-end sweep takes them).
   * Returns { temporary, kind, label, short, counter }.
   */
  function describe(eff) {
    const f = _flags(eff);
    const stamp = f.directorAppliedBy && typeof f.directorAppliedBy === "object" ? f.directorAppliedBy : null;
    const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const charges = num(f.charges);
    const max = num(f.chargesMax);
    const counter = charges != null && max != null ? `${charges}/${max}` : charges != null ? String(charges) : null;
    const mode = lifetimeModeOf(eff);
    const tracker = mode === "persistent_counter";
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const out = (temporary, kind, label, short = "") => ({
      temporary, kind, label: tracker ? `Tracker · ${label}` : label, short: tracker ? (counter ?? short) : short, counter,
    });

    if (eff?.parent?.documentName === "Item") return out(false, "item", "Lasts while the source is held");

    const restCharges = num(f.campRestCharges);
    if (restCharges != null) {
      return restCharges >= 1
        ? out(true, "rest", `Until ${plural(restCharges + 1, "rest")} from now`, plural(restCharges + 1, "rest"))
        : out(true, "rest", "Until the next rest", "Rest");
    }
    if (isRestBound(eff) || isDirectorPermanent(eff)) return out(false, "permanent", "Stays until removed", counter ?? "");

    const across = f.crossScene === true ? " (carries across scenes)" : "";
    let res;
    if (mode === "round_end" && stamp) res = out(true, "round", `Until the end of the round${across}`, "Round");
    else if (mode === "on_activation") {
      res = charges != null
        ? out(true, "uses", `${plural(charges, "use")} left${across}`, plural(charges, "use"))
        : out(true, "uses", `Until it is used${across}`, "Use");
    } else if (stamp && charges != null && !tracker) {
      res = out(true, "turns", `${plural(charges, "turn")} left${across}`, plural(charges, "turn"));
    } else {
      const d = eff?.duration ?? {};
      const tags = Array.isArray(eff?.system?.tags) ? eff.system.tags : [];
      const rounds = num(d.rounds) ?? num(d.turns);
      const origin = String(eff?.origin ?? "");
      if (f.sceneExpiry === true) res = out(true, "scene", "Until the scene ends", "Scene");
      else if (f.crossScene !== true && (stamp || rounds || num(d.seconds) || tags.includes("buff") || tags.includes("debuff"))) {
        res = out(true, "battle", rounds ? `${plural(rounds, "round")}, gone when the battle ends` : "Until the battle ends", "Battle");
      } else if (!origin || origin.startsWith("Actor.")) res = out(true, "rest", `Until the next rest${across}`, "Rest");
      else res = out(false, "permanent", "Stays until removed");
    }

    if (isDungeonTickable(eff) && res.kind !== "turns") {
      // dp-ae-lifecycle's own counter choice: a stamped AE spends its `charges`;
      // anything else lazily seeds dungeonTurnsRemaining from duration.rounds > 0, else 3.
      const rounds = num(eff?.duration?.rounds);
      const steps = stamp && charges != null ? charges : num(f.dungeonTurnsRemaining) ?? (rounds > 0 ? rounds : 3);
      res.label += ` · ${plural(steps, "step")} while exploring`;
      if (!res.temporary) { res.temporary = true; res.kind = "steps"; res.short = plural(steps, "step"); }
    }
    return res;
  }

  globalThis.FUCompanion.AELifetime = {
    isDirectorPermanent,
    isRestBound,
    isItemTransferred,
    isChargeGoverned,
    isDungeonTickable,
    describe,
  };

  console.debug("[Shared][AELifetime] Helper loaded.");
})();
