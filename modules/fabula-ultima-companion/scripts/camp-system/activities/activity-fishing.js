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
  // Fish tier tables — every entry grants a real world item (💎 Material folder).
  //
  // MUST stay name-for-name identical to FISH_TIERS in activity-fishing-ui.js:
  // the owner's client resolves the fish NAME locally and the GM trusts it, then
  // looks the name up here for the item id. A name that exists in only one of the
  // two tables silently awards nothing.
  //
  // Tier = sell price band (see the 💎 Material ladder): T1 15-25z, T2 40-100z,
  // T3 90-150z, T4 150-500z. Rarity follows tier (Common/Uncommon/Rare/Legendary)
  // and doubles as cooking potency 1/2/3/4.
  // ---------------------------------------------------------------------------
  const FISH_TABLE = [
    [ // Tier 1 — Shallow Waters
      { id: "fnd9BxHv1albIMpM", name: "Mudfish" },
      { id: "n5oeHTFJ7MApEWe4", name: "Wind Bass" },
      { id: "0ieofw23oYf5FNCc", name: "Bolt Eel" },
      { id: "4Ddvp1twE1rwqB9P", name: "Silt Catfish" },
      { id: "ZGvuE5jHpDgxMHNQ", name: "Flame Salmon" },
      { id: "0xZvao2eWYVjrHp9", name: "Ice Pike" },
    ],
    [ // Tier 2 — River Catch
      { id: "14X26PHWXppupLYt", name: "River Trout" },
      { id: "uvtEB71f8xmQAiRB", name: "Shadow Sturgeon" },
      { id: "FSj6trk1hdPaDpPd", name: "Shine Herring" },
      { id: "s28J2fB5xoskAtwu", name: "Toxic Puffer" },
      { id: "enbL361u8CaT5owG", name: "Blade Angler" },
      { id: "ALRbhk8NLRpzUcPc", name: "Lucky Loach" },
    ],
    [ // Tier 3 — Deep Waters
      { id: "czkjXYoh6vPaj5bQ", name: "Moonfish" },
      { id: "zQfpEWAxwJjaBVIe", name: "Stash Gar" },
      { id: "unAiIGTSSYpmonn8", name: "Hearty Cod" },
      { id: "SOQKbs6yuSbbHkvv", name: "Mindful Sole" },
      { id: "WtBVtnY6ergJWXHv", name: "Keystone Ray" },
      { id: "bgVJ3tF898fertoZ", name: "Wandering Shark" },
    ],
    [ // Tier 4 — Legendary
      { id: "epTljNMoOwYyy3FD", name: "Prophet Tuna" },
      { id: "ZHfjikNnFjGQr8Kq", name: "Magnificent Mahi-mahi" },
      { id: "lTqvatWNAQ4vdfkM", name: "Golden Koi" },
    ],
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
    if (castStrength >= 97) return 100;              // Perfect cast → guaranteed bite
    const wlpBonus = (wlp - 8) * 2;                  // WLP nudges the odds (flavor)
    return Math.min(100, Math.max(25, castStrength + 10 + wlpBonus));
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
  // Award fish — looks up name in FISH_TABLE to find the world item ID.
  // Every table entry now has an id; the id-less branch below only fires if the
  // UI resolved a name this table doesn't know (i.e. the two tables drifted).
  // ---------------------------------------------------------------------------
  async function _awardFish(actor, fishName) {
    const entry = FISH_TABLE.flat().find(e => e.name === fishName) ?? { name: fishName };
    if (entry.id) {
      const worldItem = game.items.get(entry.id);
      if (!worldItem) {
        console.warn(TAG, `Fish item not found in world: ${entry.id} (${fishName})`);
        return;
      }
      // prepareItemCopyData clears system.container: a copy inherits the
      // source's parent link, which would land the fish on the actor pointing
      // at a world item (an invisible, un-cascadable orphan).
      const core = window["oni.ItemTransferCore"];
      const data = core?.prepareItemCopyData
        ? core.prepareItemCopyData(worldItem)
        : (() => { const d = worldItem.toObject(); delete d._id; delete d.items;
                   d.system = d.system ?? {}; d.system.container = null; return d; })();
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);

      // A bare embedded create yields a CHILDLESS parent — CSB only walks
      // `data.items` in its own static create. Same primitive the shop/trade
      // transfers use. Best-effort: the fish still lands if a child fails.
      if (created && typeof core?.copySubItemTree === "function") {
        try {
          await core.copySubItemTree({ sourceItem: worldItem, receiverActor: actor, receiverParent: created });
        } catch (e) {
          console.warn(TAG, `sub-item copy failed for ${fishName}`, e);
        }
      }
      console.debug(TAG, `${actor.name} received: ${fishName}`);
    } else {
      console.warn(TAG, `No item id for "${fishName}" — FISH_TABLE and the UI's FISH_TIERS have drifted apart.`);
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
      async execute(actor, _scene, opts = {}) {
        if (!actor) {
          console.warn(TAG, "execute() called with null actor.");
          return;
        }

        // Round count is overridable (e.g. the dungeon Fishing tile runs 1 round
        // per angler); camp passes nothing → default TOTAL_ROUNDS.
        const totalRounds = Math.max(1, Number(opts?.totalRounds ?? TOTAL_ROUNDS));

        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // Broadcast START with stats so all clients can display them
        const stats = _getStats(actor);
        const BATTLE_TIMEOUT = 15;   // seconds — fish escapes if not caught in time
        CAMP.Socket.broadcast(CAMP.MSG.FISHING_START, {
          actorId:      actor.id,
          actorName:    actor.name,
          stats,
          battleTimeout: BATTLE_TIMEOUT,
          totalRounds,
        });
        CAMP.FishingUI?.show(actor.id, actor.name, stats, { battleTimeout: BATTLE_TIMEOUT, totalRounds });

        await new Promise(r => setTimeout(r, 300));

        // ------------------------------------------------------------------
        // Round loop (default 3; overridable via opts.totalRounds)
        // ------------------------------------------------------------------
        const catches = [];   // fish names earned this session

        for (let round = 1; round <= totalRounds; round++) {
          // Round 1 is gated by the owner's "Cast Line" button (already shown in show()).
          // Rounds 2+ need a broadcast so all clients (including owner) transition.
          if (round > 1) {
            CAMP.Socket.broadcast(CAMP.MSG.FISHING_NEXT_ROUND, {
              actorId:     actor.id,
              round,
              totalRounds,
            });
            CAMP.FishingUI?.beginRound(actor.id, round, totalRounds); // GM direct
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
          if (round < totalRounds) {
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
