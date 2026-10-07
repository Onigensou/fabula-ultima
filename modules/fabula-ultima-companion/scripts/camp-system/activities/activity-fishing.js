// ============================================================================
// Camp Activity — Fishing
// Target: Yourself
//
// Two-phase minigame (Stardew-style):
//   Phase 1 — Casting: stop an oscillating gauge at the right moment.
//   Phase 2 — Battle:  keep the fish icon inside your fishing bar.
//
// Runs for 3 rounds per camp activity usage.
// Reward: fish items, drawn from the scene's fish RollTable (see below).
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
  // Fish tables — WHAT can be caught is world data, not code.
  //
  // Every scene may point at a fish RollTable (scene flag oniDungeon.loot.fish,
  // the "Fish" field in Dungeon Configuration). That table is the complete list
  // of what bites there: whichever generic fish the dungeon should have plus its
  // own exclusives. A scene with no table (or an empty/broken one) falls back to
  // the world's "Generic - Fish" table.
  //
  // Each row links an Item (💎 fish live in the Fish item folder):
  //   tier   = the item's rarity — Common / Uncommon / Rare / Legendary. Cast
  //            strength + WLP pick the tier; rarity also sets the sell price band
  //            (T1 15-25z, T2 40-100z, T3 90-150z, T4 150-500z) and cooking potency.
  //   weight = the row's weight, relative to the other fish of the SAME tier.
  //
  // The GM resolves the table once per session and broadcasts the pools with
  // FISHING_START; the owner's client picks a name from them and the GM awards
  // that name's item. Nothing about the roster is hard-coded on either side.
  // ---------------------------------------------------------------------------
  const DEFAULT_FISH_TABLE      = "RollTable.krmgo70mxn7HYI8w";
  const DEFAULT_FISH_TABLE_NAME = "Generic - Fish";
  const RARITY_TIER = { common: 0, uncommon: 1, rare: 2, legendary: 3 };

  // actorId → [{ id, name, weight }] — every fish catchable in the session in progress
  const _sessionFish = new Map();

  async function _findTable(ref) {
    const key = String(ref ?? "").trim();
    if (!key) return null;
    const byId = game.tables?.get(key);
    if (byId) return byId;
    const doc = await fromUuid(key).catch(() => null);
    return doc?.documentName === "RollTable" ? doc : null;
  }

  // RollTable → one pool per tier, or null when it holds no usable fish.
  function _readPools(table) {
    if (!table) return null;
    const tiers = [[], [], [], []];
    for (const row of table.results) {
      if (row.documentCollection !== "Item" || !row.documentId) continue;
      const item = game.items.get(row.documentId);
      if (!item) { console.warn(TAG, `"${table.name}" row points at a missing item:`, row.text); continue; }
      const tier   = RARITY_TIER[String(item.system?.props?.item_rarity ?? "").trim().toLowerCase()] ?? 0;
      const weight = Math.max(0, Number(row.weight) || 0);
      if (!weight) continue;
      const known = tiers[tier].find(e => e.id === item.id);
      if (known) known.weight += weight;
      else tiers[tier].push({ id: item.id, name: item.name, weight });
    }
    return tiers.some(pool => pool.length) ? tiers : null;
  }

  function _sceneFishRef(scene) {
    try {
      const dungeon = window.oni?.FabulaConfig?.readDungeon?.(scene)
                   ?? scene?.getFlag?.(MODULE_ID, "oniDungeon")
                   ?? {};
      return String(dungeon?.loot?.fish ?? "").trim();
    } catch { return ""; }
  }

  async function _resolveFishPools(tableRef) {
    const ref   = String(tableRef ?? "").trim();
    const pools = _readPools(await _findTable(ref));
    if (pools) return pools;
    if (ref) console.warn(TAG, "Fish table missing or empty, using the generic one:", ref);
    const fallback = await _findTable(DEFAULT_FISH_TABLE) ?? game.tables?.getName(DEFAULT_FISH_TABLE_NAME) ?? null;
    return _readPools(fallback);
  }

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

  // ---------------------------------------------------------------------------
  // Award fish — looks the name up in this session's pools for the world item id.
  // The id-less branch below only fires if the owner's client sent a name that
  // is not in the table the GM resolved for this session.
  // ---------------------------------------------------------------------------
  async function _awardFish(actor, fishName) {
    const entry = (_sessionFish.get(actor.id) ?? []).find(e => e.name === fishName) ?? { name: fishName };
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
      console.warn(TAG, `No item id for "${fishName}" — not in this session's fish table.`);
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

        // What bites here: the Fishing tile passes its scene's fish table, camp
        // reads the camp scene's own; neither set → the generic table.
        const pools = await _resolveFishPools(opts?.fishTable || _sceneFishRef(_scene));
        if (!pools) {
          ui.notifications?.warn("Fishing | No fish table found — there is nothing to catch here.");
          return;
        }
        _sessionFish.set(actor.id, pools.flat());
        const fishPools = pools.map(pool => pool.map(f => ({ name: f.name, weight: f.weight })));

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
          fishPools,
        });
        CAMP.FishingUI?.show(actor.id, actor.name, stats, { battleTimeout: BATTLE_TIMEOUT, totalRounds, fishPools });

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
        _sessionFish.delete(actor.id);

        CAMP.Socket.broadcast(CAMP.MSG.FISHING_DONE, { actorId: actor.id });
        CAMP.FishingUI?.hide();
      },
    });
  });

  console.debug(TAG, "Fishing activity loaded.");
})();
