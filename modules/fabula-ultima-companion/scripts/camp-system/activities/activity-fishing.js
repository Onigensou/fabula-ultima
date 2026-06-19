// ============================================================================
// Camp Activity — Fishing
// Target: Yourself
//
// Two-phase minigame (Stardew-style):
//   Phase 1 — Casting: stop an oscillating gauge at the right moment.
//   Phase 2 — Battle:  keep the fish icon inside your fishing bar.
//
// Runs for 3 rounds per camp activity usage.
// Reward: fish item (plain-text placeholder — wire actual items later).
//
// Stat influences (read from actor.system.props):
//   MIG → HP fill rate in battle phase
//   DEX → gauge speed (casting) + bar up-speed (battle)
//   INS → fishing bar height
//   WLP → catch chance + fish tier thresholds
// ============================================================================
(() => {
  const CAMP      = globalThis.CampSystem ??= {};
  const MODULE_ID = "fabula-ultima-companion";
  const TAG       = "[CampSystem][Fishing]";

  const TOTAL_ROUNDS = 3;

  // ---------------------------------------------------------------------------
  // Fish tier tables — entries with an id grant a real world item;
  // entries without id are still placeholder (no item created yet).
  // TODO: replace remaining placeholder entries with real item IDs later.
  // ---------------------------------------------------------------------------
  const FISH_TABLE = [
    [ { id: "fnd9BxHv1albIMpM", name: "Mudfish" },       { name: "Small Fish" },         { name: "Pebblecarp" }    ], // Tier 1
    [ { id: "14X26PHWXppupLYt", name: "River Trout" },   { name: "Silverscale" },        { name: "Speckled Bass" } ], // Tier 2
    [ { id: "czkjXYoh6vPaj5bQ", name: "Moonfish" },      { name: "Coral Bass" },         { name: "Goldfish" }      ], // Tier 3
    [ { name: "Starfish" },                               { name: "Dragonscale Carp" },   { name: "Phantom Eel" }   ], // Tier 4 (Legendary)
  ];

  // ---------------------------------------------------------------------------
  // Stat helpers
  // ---------------------------------------------------------------------------
  function _getStats(actor) {
    const p = actor?.system?.props ?? {};
    return {
      mig: parseInt(p.mig_current) || 8,
      dex: parseInt(p.dex_current) || 8,
      ins: parseInt(p.ins_current) || 8,
      wlp: parseInt(p.wlp_current) || 8,
    };
  }

  // WLP: catch chance bonus/penalty
  function _catchChance(castStrength, wlp) {
    const base = 35 + castStrength * 0.45;
    const wlpBonus = (wlp - 8) * 2;
    return Math.min(95, Math.max(5, base + wlpBonus));
  }

  // WLP: fish tier given cast strength
  function _fishTier(castStrength, wlp) {
    const shift = (wlp - 8) * 1.5;
    const t4 = Math.max(50, 97 - shift);
    const t3 = Math.max(20, 66 - shift);
    const t2 = Math.max(5,  33 - shift);
    if (castStrength >= t4) return 3;   // 0-indexed
    if (castStrength >= t3) return 2;
    if (castStrength >= t2) return 1;
    return 0;
  }

  function _pickFish(castStrength, wlp) {
    const tier = _fishTier(castStrength, wlp);
    const pool = FISH_TABLE[tier];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---------------------------------------------------------------------------
  // Award fish — looks up name in FISH_TABLE to find a real item ID.
  // Entries without an id are still placeholder (no item created yet).
  // TODO: replace remaining placeholder entries with real IDs in FISH_TABLE.
  // ---------------------------------------------------------------------------
  async function _awardFish(actor, fishName) {
    const entry = FISH_TABLE.flat().find(e => e.name === fishName) ?? { name: fishName };
    if (entry.id) {
      const worldItem = game.items.get(entry.id);
      if (!worldItem) {
        console.warn(TAG, `Fish item not found in world: ${entry.id} (${fishName})`);
        return;
      }
      const data = worldItem.toObject();
      delete data._id;
      await actor.createEmbeddedDocuments("Item", [data]);
      console.debug(TAG, `${actor.name} received: ${fishName}`);
    } else {
      // TODO: replace with actual item creation when fish items are implemented
      console.log(TAG, `${actor.name} caught: ${fishName} (placeholder — no item created yet)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Pending resolver pattern — GM awaits owner's per-round result
  // ---------------------------------------------------------------------------
  function _waitForRound(actor) {
    return new Promise(resolve => {
      CAMP.FishingUI ??= {};
      CAMP.FishingUI.roundResolvers ??= {};

      const timer = setTimeout(() => {
        if (CAMP.FishingUI.roundResolvers[actor.id]) {
          console.warn(TAG, "Round timeout — defaulting to no catch for", actor.name);
          delete CAMP.FishingUI.roundResolvers[actor.id];
          resolve({ fishName: null });
        }
      }, 120_000);   // 2 min: covers Click to Begin + cast + wait + 60s battle

      CAMP.FishingUI.roundResolvers[actor.id] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Proceed gate — GM awaits owner's "Click to Proceed" after all rounds
  // ---------------------------------------------------------------------------
  function _waitForProceed(actor) {
    return new Promise(resolve => {
      CAMP.FishingUI ??= {};
      CAMP.FishingUI.proceedResolvers ??= {};
      CAMP.FishingUI.proceedResolvers[actor.id] = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Chat summary
  // ---------------------------------------------------------------------------
  async function _postChatResult(actor, catches) {
    const hasCatch = catches.length > 0;
    const fishList = catches.length === 0
      ? "<em style='opacity:.6'>Nothing caught this session.</em>"
      : catches.map(f => `<li>🐟 <strong>${f}</strong></li>`).join("");

    const headerColor = hasCatch ? "#3a7a35" : "#7a5010";
    const headline    = hasCatch
      ? `Caught ${catches.length} fish!`
      : "The fish weren't biting today.";

    const msg = await ChatMessage.create({
      content: `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;">
          <div style="font-size:1.6em;line-height:1;flex-shrink:0;">🎣</div>
          <div>
            <div style="font-weight:700;font-size:1em;color:#6b3a1f;">
              ${actor.name} — Fishing
            </div>
            <div style="font-size:.95em;font-weight:700;color:${headerColor};margin-top:3px;">
              ${headline}
            </div>
            ${catches.length > 0
              ? `<ul style="margin:4px 0 0 4px;padding-left:14px;font-size:.9em;">${fishList}</ul>`
              : `<div style="font-size:.85em;margin-top:3px;">${fishList}</div>`
            }
          </div>
        </div>
      `,
    });

    // Strip default message header
    const styleId = `oni-fish-chat-${msg.id}`;
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
  }

  // ---------------------------------------------------------------------------
  // Activity registration
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    CAMP.ActivityRegistry?.register("fishing", {
      async execute(actor, _scene) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // Broadcast START with stats so all clients can display them
        const stats = _getStats(actor);
        const BATTLE_TIMEOUT = 15;   // seconds — fish escapes if not caught in time
        CAMP.Socket.broadcast(CAMP.MSG.FISHING_START, {
          actorId:      actor.id,
          actorName:    actor.name,
          stats,
          battleTimeout: BATTLE_TIMEOUT,
        });
        CAMP.FishingUI?.show(actor.id, actor.name, stats, { battleTimeout: BATTLE_TIMEOUT });

        await new Promise(r => setTimeout(r, 300));

        // ------------------------------------------------------------------
        // 3-round loop
        // ------------------------------------------------------------------
        const catches = [];   // fish names earned this session

        for (let round = 1; round <= TOTAL_ROUNDS; round++) {
          // Round 1 is gated by the owner's "Cast Line" button (already shown in show()).
          // Rounds 2+ need a broadcast so all clients (including owner) transition.
          if (round > 1) {
            CAMP.Socket.broadcast(CAMP.MSG.FISHING_NEXT_ROUND, {
              actorId:     actor.id,
              round,
              totalRounds: TOTAL_ROUNDS,
            });
            CAMP.FishingUI?.beginRound(actor.id, round, TOTAL_ROUNDS); // GM direct
          }

          // Wait for owner to complete this round (cast + optional battle)
          const { fishName, castStrength } = await _waitForRound(actor);

          // Determine actual fish based on cast strength + WLP
          let awardedFish = null;
          if (fishName) {
            // fishName was pre-resolved in UI using stats — just trust it
            awardedFish = fishName;
            catches.push(awardedFish);
            await _awardFish(actor, awardedFish);
          }

          // Broadcast round result to all clients
          CAMP.Socket.broadcast(CAMP.MSG.FISHING_RESULT, {
            actorId:  actor.id,
            round,
            fishName: awardedFish,
            catches:  [...catches],
          });
          CAMP.FishingUI?.applyResult(actor.id, round, awardedFish, [...catches]);

          // Brief pause between rounds (except after the last one)
          if (round < TOTAL_ROUNDS) {
            await new Promise(r => setTimeout(r, 2200));
          }
        }

        // ------------------------------------------------------------------
        // End of session — show summary, wait for Proceed
        // ------------------------------------------------------------------
        await _postChatResult(actor, catches);
        await _waitForProceed(actor);

        CAMP.Socket.broadcast(CAMP.MSG.FISHING_DONE, { actorId: actor.id });
        CAMP.FishingUI?.hide();
      },
    });
  });

  console.debug(TAG, "Fishing activity loaded.");
})();
