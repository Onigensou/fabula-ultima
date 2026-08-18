// ============================================================================
// Travel Roll API
// Fabula Ultima — Journeys and Travels (Core Rulebook p.106–108)
//
// Exposed as: globalThis.TravelRoll
//
// Usage:
//   await TravelRoll.performRoll()           — uses canvas.scene threat level
//   await TravelRoll.performRoll(scene)      — explicit scene
//   TravelRoll.getThreatLevel(scene)         — "minimal"|"low"|"medium"|"high"|"very_high"
//   TravelRoll.getDieFormula(level)          — "1d6" … "1d20"
//   TravelRoll.getOutcome(total[, threshold]) — "discovery"|"safe"|"danger"
//        threshold defaults to 1 (vanilla). Treasure Hunter raises it. Note
//        total <= 0 now returns "discovery" where the 1-arg form returned
//        "safe"; no die in DIE_LADDER can produce that.
//   TravelRoll.getCartographyHolder()        — { actor, effect } | null
//
// Hook fired after final result:
//   Hooks.callAll("oni.travelRoll.completed", { roll, total, outcome, level, formula, rerolled, rerollBy })
//
// Scene flag for threat level:
//   flags.fabula-ultima-companion.oniDungeon.threatLevel
//   Values: "minimal" | "low" | "medium" | "high" | "very_high"  (default: "medium")
//
// Cartography AE marker (set by activity-cartography.js):
//   flags.fabula-ultima-companion.cartographyReroll: true
// ============================================================================
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[TravelRoll]";

  // ---------------------------------------------------------------------------
  // Threat level → die mapping
  // ---------------------------------------------------------------------------
  const THREAT_DIE = Object.freeze({
    minimal:   "1d6",
    low:       "1d8",
    medium:    "1d10",
    high:      "1d12",
    very_high: "1d20",
  });

  const THREAT_LABEL = Object.freeze({
    minimal:   "Minimal",
    low:       "Low",
    medium:    "Medium",
    high:      "High",
    very_high: "Very High",
  });

  // ---------------------------------------------------------------------------
  // Wayfarer travel skills (code-backed — the documents carry no config)
  //
  // Registered in scripts/shared/code-backed-content.js so carrier-scan does
  // not report them as unimplemented.
  //
  //   WELL-TRAVELED    (max SL 1)  reduce the travel die by one size, min d6.
  //                                Explicitly NOT cumulative across characters.
  //   TREASURE HUNTER  (max SL 2)  discovery on SL+1 or lower, instead of
  //                                only on a 1.
  //
  // Both are scoped to PARTY MEMBERS, never to every character actor in the
  // world: the Wayfarer class-template actor holds its own copy of each skill,
  // and a world-wide scan would let that template hand the party a permanent
  // die reduction. (getCartographyHolder below still scans world-wide; its
  // marker is a runtime AE that no template carries, so it does not have this
  // failure mode.)
  // ---------------------------------------------------------------------------
  // The ladder is the TRAVEL threat table (core rulebook p.106), not the
  // attribute die ladder — which is why it runs to d20. RAW says only "by one
  // size (to a minimum of d6)" and never defines the step for the travel d20,
  // so d20 -> d12 is an AUTHORED RULING, and the only threat level it affects
  // is Very High.
  const DIE_LADDER = Object.freeze(["1d6", "1d8", "1d10", "1d12", "1d20"]);

  // CSB gives skills and gear the same document type ("equippableItem"); the
  // sheet template is the only discriminator. Without this filter any item
  // whose name normalised to one of these skills — an accessory, a material, a
  // gacha reward — would silently buff the party's travel rolls.
  const SKILL_TEMPLATE_ID = "j0F5Msw5RZ8aIB3j";   // _Skill Template

  const WELL_TRAVELED   = Object.freeze({ name: "Well-Traveled",   id: "E1dOu3pYQKL60blD", maxSl: 1 });
  const TREASURE_HUNTER = Object.freeze({ name: "Treasure Hunter", id: "zgb1ZKLnw50WNjlG", maxSl: 2 });

  // The danger band starts at 6. Canonical Treasure Hunter caps at SL 2, so the
  // threshold can never exceed 3 — this clamp only stops a mis-authored max_level
  // from swallowing "danger" entirely.
  const MAX_DISCOVERY_THRESHOLD = 5;

  function safeInt(v, fallback = 0) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function getThreatLevel(scene) {
    const raw = scene?.flags?.[MODULE_ID]?.oniDungeon?.threatLevel;
    return (raw && THREAT_DIE[raw]) ? raw : "medium";
  }

  function getDieFormula(level) {
    return THREAT_DIE[level] ?? THREAT_DIE.medium;
  }

  // discoveryThreshold defaults to 1 — the vanilla rule — so every existing
  // caller of getOutcome(total) keeps its exact previous behaviour.
  function getOutcome(total, discoveryThreshold = 1) {
    const threshold = Math.min(
      MAX_DISCOVERY_THRESHOLD,
      Math.max(1, safeInt(discoveryThreshold, 1)),
    );
    // Discovery is tested first: Treasure Hunter widens the discovery band, and
    // with the clamp above it can never reach the danger band.
    if (total <= threshold) return "discovery";
    if (total >= 6)         return "danger";
    return "safe";
  }

  // One step down the FU die ladder. An unrecognised formula, or one already at
  // the d6 floor, is returned untouched rather than coerced.
  function reduceDieOneSize(formula) {
    const i = DIE_LADDER.indexOf(String(formula));
    return i > 0 ? DIE_LADDER[i - 1] : String(formula);
  }

  // Name comparison tolerant of case and of hyphen/space/underscore drift, so
  // "Well-Traveled", "Well-traveled" and "Well Traveled" all resolve.
  function normaliseSkillName(s) {
    return String(s ?? "").trim().toLowerCase().replace(/[\s\-_]+/g, " ");
  }

  // Identity, in the fields this world actually populates. findResourceful in
  // tile-event-gathering.js reads flags.core.sourceId / system.props.id, but
  // NEITHER exists on any authored copy here — those branches are dead, and
  // system.props.id (where present at all) holds the embedded _id, not the
  // world id. The live carriers are system.uniqueId and _stats.compendiumSource,
  // which is also what scripts/lint/engine-canon-lint.js prescribes. Matching
  // on them means a sheet rename no longer silently kills the skill.
  function findSkillOnActor(actor, spec) {
    const want = normaliseSkillName(spec.name);
    return actor?.items?.find((it) => {
      if (String(it.system?.template ?? "") !== SKILL_TEMPLATE_ID) return false;
      return normaliseSkillName(it.name) === want ||
             String(it.system?.uniqueId ?? "") === spec.id ||
             String(it._stats?.compendiumSource ?? "").includes(spec.id);
    }) ?? null;
  }

  function skillLevel(skill, spec) {
    const maxLv = Math.max(1, safeInt(skill?.system?.props?.max_level, spec.maxSl));
    return Math.max(1, Math.min(maxLv, safeInt(skill?.system?.props?.level, 1)));
  }

  // Party members only — see the note on the skill constants above.
  async function resolvePartyMembers() {
    const api = globalThis.FUCompanion?.api;
    let partyActor = null;
    if (api?.getCurrentGameDb) {
      const res = await api.getCurrentGameDb().catch(() => null);
      partyActor = res?.db ?? res?.source ?? null;
    }
    if (!partyActor) {
      console.warn(TAG, "Party actor not resolved — Wayfarer travel skills will not apply.");
      return [];
    }

    const props   = partyActor.system?.props ?? {};
    const members = [];
    for (let i = 1; i <= 4; i++) {
      const rawId = String(props[`member_id_${i}`] ?? "").trim();
      if (!rawId) continue;
      let actor = null;
      try {
        actor = /^Actor\./i.test(rawId)
          ? await fromUuid(rawId)
          : (game.actors.get(rawId) ?? await fromUuid(`Actor.${rawId}`).catch(() => null));
      } catch {}
      if (actor) members.push(actor);
    }
    return members;
  }

  // Both holders require SL >= 1. Holding the document is NOT ownership: some
  // class templates carry level "0" and some live sheets carry level null, and
  // a blank CSB field read as "present" is the measured permissive-failure shape.
  //
  // This is NOT a second line of defence against the Wayfarer class template —
  // that template's copies carry level "1" and clear this check. PARTY SCOPING
  // is the only thing keeping the template out; do not relax it on the strength
  // of this function.
  function hasRank(skill, spec) {
    return safeInt(skill?.system?.props?.level, 0) >= 1 && skillLevel(skill, spec) >= 1;
  }

  // Not cumulative: the first holder found is enough, extra holders add nothing.
  function getWellTraveledHolder(members) {
    for (const actor of members ?? []) {
      const skill = findSkillOnActor(actor, WELL_TRAVELED);
      if (skill && hasRank(skill, WELL_TRAVELED)) return { actor, skill };
    }
    return null;
  }

  // Highest SL wins when several characters have it.
  function getTreasureHunterHolder(members) {
    let best = null;
    for (const actor of members ?? []) {
      const skill = findSkillOnActor(actor, TREASURE_HUNTER);
      if (!skill || !hasRank(skill, TREASURE_HUNTER)) continue;
      const sl = skillLevel(skill, TREASURE_HUNTER);
      if (!best || sl > best.sl) best = { actor, skill, sl };
    }
    return best;
  }

  // Clamped ONCE here so the chat card, the returned result and getOutcome can
  // never disagree about which threshold was actually applied.
  function discoveryThresholdFor(holder) {
    if (!holder) return 1;
    return Math.min(MAX_DISCOVERY_THRESHOLD, Math.max(1, holder.sl + 1));
  }

  function getCartographyHolder() {
    for (const actor of game.actors ?? []) {
      if (actor.type !== "character") continue;
      for (const effect of actor.effects ?? []) {
        if (effect.flags?.[MODULE_ID]?.cartographyReroll === true) {
          return { actor, effect };
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Chat card
  // ---------------------------------------------------------------------------
  const OUTCOME_STYLE = Object.freeze({
    danger:    { color: "#a82828", label: "Danger!",      icon: "fas fa-skull-crossbones" },
    discovery: { color: "#b8860b", label: "Discovery!",   icon: "fas fa-star"             },
    safe:      { color: "#3a7a35", label: "Safe passage", icon: "fas fa-route"            },
  });

  async function _postTravelRollChat({ roll, outcome, level, formula, rerolled = false, rerollBy = null, skillNotes = [] }) {
    const style   = OUTCOME_STYLE[outcome];
    const dieIcon = formula.replace("1d", "fa-dice-d");

    const rerollNote = rerolled
      ? `<div style="font-size:.8em;margin-top:4px;opacity:.7;font-style:italic;">
           <i class="fas fa-redo"></i> Cartography reroll used by <b>${rerollBy}</b>
         </div>`
      : "";

    // Passive Wayfarer skills change the die or the outcome band silently, so
    // say so on the card — otherwise the roll looks wrong to the table.
    const skillNote = skillNotes.length
      ? `<div style="font-size:.8em;margin-top:4px;opacity:.7;font-style:italic;">
           <i class="fas fa-hiking"></i> ${skillNotes.join(" &middot; ")}
         </div>`
      : "";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <div style="font-size:2rem;color:${style.color};flex-shrink:0;line-height:1;">
            <i class="fas ${dieIcon}" style="font-size:1.8rem;"></i>
          </div>
          <div>
            <div style="font-weight:700;font-size:1em;color:${style.color};">
              <i class="${style.icon}"></i>&ensp;Travel Roll — ${THREAT_LABEL[level]} (${formula})
            </div>
            <div style="font-size:1.4em;font-weight:800;margin:2px 0;color:${style.color};">
              ${roll.total}
            </div>
            <div style="font-weight:600;font-size:.9em;">${style.label}</div>
            ${skillNote}
            ${rerollNote}
          </div>
        </div>
      `,
    });

    const styleId = `oni-travel-roll-style-${msg.id}`;
    if (!document.getElementById(styleId)) {
      const s = document.createElement("style");
      s.id = styleId;
      s.textContent = `
        .chat-message[data-message-id="${msg.id}"] .message-header { display:none !important; }
        .chat-message[data-message-id="${msg.id}"] { padding-top:6px !important; }
        .chat-message[data-message-id="${msg.id}"] .message-content { margin:0 !important; }
      `;
      document.head.appendChild(s);
    }

    return msg;
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------
  async function performRoll(scene) {
    const targetScene = scene ?? canvas?.scene ?? null;

    const level       = getThreatLevel(targetScene);
    const baseFormula = getDieFormula(level);

    // Wayfarer passives, resolved once and reused for the Cartography reroll so
    // the reroll cannot silently fall back to the unreduced die.
    const members    = await resolvePartyMembers();
    const wellTravel = getWellTraveledHolder(members);
    const treasure   = getTreasureHunterHolder(members);

    const formula = wellTravel ? reduceDieOneSize(baseFormula) : baseFormula;
    const discoveryThreshold = discoveryThresholdFor(treasure);

    const skillNotes = [];
    if (wellTravel && formula !== baseFormula) {
      skillNotes.push(`Well-Traveled (${wellTravel.actor.name}): ${baseFormula} &rarr; ${formula}`);
    }
    if (treasure) {
      skillNotes.push(`Treasure Hunter (${treasure.actor.name}): discovery on ${discoveryThreshold} or lower`);
    }
    // The whole point of the note block is that a silent modifier makes the
    // roll look wrong. An unresolvable party is the same failure, inverted.
    if (!members.length) {
      skillNotes.push("Wayfarer travel skills unavailable (party not resolved)");
    }

    const roll = await new Roll(formula).evaluate();
    const outcome = getOutcome(roll.total, discoveryThreshold);

    console.debug(TAG, `Travel Roll: ${formula} → ${roll.total} (${outcome}), scene: ${targetScene?.name ?? "none"}, level: ${level}, discovery<=${discoveryThreshold}`);

    await _postTravelRollChat({ roll, outcome, level, formula, rerolled: false, skillNotes });

    // Check for Cartography reroll
    let finalRoll    = roll;
    let finalOutcome = outcome;
    let rerolled     = false;
    let rerollBy     = null;

    const holder = getCartographyHolder();
    if (holder) {
      const charges = holder.effect.flags?.["fabula-ultima-companion"]?.cartographyCharges ?? 1;
      const chargeNote = charges > 1 ? ` <em>(${charges} charges remaining)</em>` : "";

      const use = await Dialog.confirm({
        title:   "Cartography — Reroll Available",
        content: `<p><b>${holder.actor.name}</b> has <b>Cartography</b> active.${chargeNote}</p>
                  <p>Reroll the travel die and keep the new result?</p>`,
        yes:     () => true,
        no:      () => false,
        defaultYes: true,
      });

      if (use) {
        finalRoll    = await new Roll(formula).evaluate();
        finalOutcome = getOutcome(finalRoll.total, discoveryThreshold);
        rerolled     = true;
        rerollBy     = holder.actor.name;

        // Consume one charge — delete AE when last charge is spent
        try {
          const remaining = charges - 1;
          if (remaining <= 0) {
            await holder.effect.delete();
          } else {
            const newName = remaining === 1 ? "Cartography" : `Cartography ×${remaining}`;
            await holder.effect.update({ name: newName });
            await holder.effect.setFlag("fabula-ultima-companion", "cartographyCharges", remaining);
          }
          console.debug(TAG, `Cartography charge consumed from ${holder.actor.name}. Remaining: ${remaining}`);
        } catch (e) {
          console.warn(TAG, "Could not update Cartography AE:", e.message);
        }

        await _postTravelRollChat({ roll: finalRoll, outcome: finalOutcome, level, formula, rerolled: true, rerollBy, skillNotes });
      }
    }

    const result = {
      roll:      finalRoll,
      total:     finalRoll.total,
      outcome:   finalOutcome,
      level,
      formula,
      rerolled,
      rerollBy,
      baseFormula,
      discoveryThreshold,
      // Credits who APPLIED the reduction, matching the chat card. At minimal
      // threat the die is already at the d6 floor, so a holder changes nothing
      // and is not credited — otherwise a hook consumer would report a skill
      // that did not fire.
      wellTraveledBy:   (wellTravel && formula !== baseFormula) ? wellTravel.actor.name : null,
      treasureHunterBy: treasure?.actor?.name ?? null,
    };

    Hooks.callAll("oni.travelRoll.completed", result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  globalThis.TravelRoll = {
    performRoll,
    getThreatLevel,
    getDieFormula,
    getOutcome,
    getCartographyHolder,
    // Wayfarer passives — exposed so the camp/journey UI can preview the
    // party's effective die and discovery band without rolling.
    reduceDieOneSize,
    resolvePartyMembers,
    getWellTraveledHolder,
    getTreasureHunterHolder,
    THREAT_DIE,
    THREAT_LABEL,
    DIE_LADDER,
  };

  Hooks.once("ready", () => {
    console.debug(TAG, "Travel Roll API ready. Call TravelRoll.performRoll() to perform a travel roll.");
  });
})();
