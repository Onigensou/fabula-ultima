// ============================================================================
// Camp Activity — Curse (Straw Doll Hex)
// Target:   One Villain
// Requires: Hexer or Necromancer
// Effect:   Inflicts a villain debuff tier at the next conflict scene.
//           Tier is determined by minigame performance (standard/good/perfect).
//           Stored as a campRestCharges:1 Active Effect on the caster.
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";

  // ── Asset URLs ─────────────────────────────────────────────────────────────
  const CURSE_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Aisha/VoidPrincessPassive2.png";

  // ── Tier metadata ──────────────────────────────────────────────────────────
  const TIER_META = {
    standard: {
      name: "Curse (Basic)",
      title: "The Curse Takes Hold",
      desc:  "A basic curse coils around your foe. The next Villain you face will be inflicted with a <strong>Basic Debuff</strong> when the conflict begins.",
    },
    good: {
      name: "Curse (Bad)",
      title: "Your Hex Bites Deep",
      desc:  "A potent hex seeps into the straw. The next Villain you face will be inflicted with a <strong>Bad Debuff</strong> when the conflict begins.",
    },
    perfect: {
      name: "Curse (Very Bad)",
      title: "The Doll is Ruined!",
      desc:  "Your dark art reaches its peak. The next Villain you face will be inflicted with a <strong>Very Bad Debuff</strong> when the conflict begins.",
    },
  };

  // ── Grade from raw score (max 32 pts — 16 labels × 2) ─────────────────────
  function _scoreToTier(score) {
    if (score >= 24) return "perfect";   // ≥ 75 % of 32
    if (score >= 16) return "good";      // ≥ 50 % of 32
    return "standard";
  }

  // ── Pending resolver: wait for minigame score ──────────────────────────────
  function _waitForScore(actor) {
    return new Promise(resolve => {
      CAMP.CurseUI ??= {};
      CAMP.CurseUI.scoreResolvers ??= {};
      const timer = setTimeout(() => {
        if (CAMP.CurseUI.scoreResolvers?.[actor.id]) {
          delete CAMP.CurseUI.scoreResolvers[actor.id];
          resolve(0);     // timeout fallback → standard tier
        }
      }, 60_000);
      CAMP.CurseUI.scoreResolvers[actor.id] = (score) => {
        clearTimeout(timer);
        resolve(score);
      };
    });
  }

  // ── Pending resolver: wait for owner to click "Click to Proceed" ───────────
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.CurseUI ??= {};
      CAMP.CurseUI.proceedResolvers ??= {};
      CAMP.CurseUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ── Apply outcome: create Active Effect on actor ───────────────────────────
  async function _applyOutcome(actor, tier) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name:     TIER_META[tier].name,
      img:      CURSE_ICON,
      origin:   `Actor.${actor.id}`,
      disabled: false,
      changes:  [],
      statuses: ["permanent"],     // survive _clearTemporaryEffects; decrement via campRestCharges
      flags: {
        [MODULE_ID]: {
          campRestCharges: 1,      // active through current rest, gone after the next one
          curseTier:       tier,   // "standard" | "good" | "perfect"
          curseCasterId:   actor.id,
        },
      },
    }]);
  }

  // ── Post chat card ─────────────────────────────────────────────────────────
  async function _postChatResult(actor, score, tier) {
    const meta = TIER_META[tier];
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor:  "☽ Curse — Straw Doll Hex ☾",
      content: `
        <p><strong>${actor.name}</strong> drives pins into the straw effigy, channelling dark intent.</p>
        <p>${meta.desc}</p>
        <p style="font-size:0.85em;opacity:0.7;margin-top:6px;">Score: ${score} / 32 &nbsp;·&nbsp; ${meta.name}</p>
      `.trim(),
    });
  }

  // ── Main execute (GM-only entry point) ────────────────────────────────────
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("curse", {
      async execute(actor, _scene) {
        // 1. Broadcast overlay to all clients; call GM directly (no socket echo)
        CAMP.Socket.broadcast(CAMP.MSG.CURSE_START, { actorId: actor.id, actorName: actor.name });
        CAMP.CurseUI?.show(actor.id, actor.name);
        await new Promise(r => setTimeout(r, 300));   // let clients render

        // 2. Await player minigame result (resolves via socket CURSE_RESULT from owner)
        const score = await _waitForScore(actor);

        // 3. Compute tier + apply AE
        const tier = _scoreToTier(score);
        await _applyOutcome(actor, tier);
        await _postChatResult(actor, score, tier);

        // 4. Broadcast full result (tier+score) → reveal panel on all clients
        CAMP.Socket.broadcast(CAMP.MSG.CURSE_RESULT, { actorId: actor.id, score, tier });
        CAMP.CurseUI?.applyResult(actor.id, score, tier);   // GM direct call

        // 5. Wait for owner to dismiss
        await _waitForProceed(actor);

        // 6. Tear down
        CAMP.Socket.broadcast(CAMP.MSG.CURSE_DONE, { actorId: actor.id });
        CAMP.CurseUI?.hide();   // GM direct call
      },
    });
  });
})();
