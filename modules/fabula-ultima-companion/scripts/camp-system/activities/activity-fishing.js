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
// v2 (2026-11-13): tackle (rod + bait), a lure phase, rank-based fights and a
// sunken treasure chest. The rules live in fishing-tuning.js; the screen in
// activity-fishing-ui.js. This file is the GM side: what can bite, the awards
// (fish, Perfect-catch bonus, chest loot) and the round flow.
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
      if (known) { known.weight += weight; continue; }
      // Per-fish data (flag fabula-ultima-companion.fish): silhouette shape,
      // size within its rank, liked bait taste. Missing = defaults.
      const fd = CAMP.FishingTuning?.fishData?.(item.getFlag?.(MODULE_ID, "fish")) ?? { shape: "std", size: 1, likes: null };
      tiers[tier].push({ id: item.id, name: item.name, weight, img: item.img,
        cost: Number(item.system?.props?.item_cost) || 0, sh: fd.shape, sz: fd.size, likes: fd.likes });
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
    if (pools) {
      // This area's own fish (not in the generic table) — bitter bait favours them.
      const generic = _readPools(await _findTable(DEFAULT_FISH_TABLE) ?? game.tables?.getName(DEFAULT_FISH_TABLE_NAME) ?? null);
      const common  = new Set((generic ?? []).flat().map(f => f.id));
      if (generic) for (const f of pools.flat()) f.ex = !common.has(f.id);
      return pools;
    }
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

  // ---------------------------------------------------------------------------
  // Award fish — looks the name up in this session's pools for the world item id.
  // The id-less branch below only fires if the owner's client sent a name that
  // is not in the table the GM resolved for this session.
  // ---------------------------------------------------------------------------
  async function _awardFish(actor, fishName, quantity = 1) {
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
      if (quantity > 1) foundry.utils.setProperty(data, "system.props.item_quantity", String(quantity));
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
      console.debug(TAG, `${actor.name} received: ${fishName} ×${quantity}`);
      return worldItem;
    } else {
      console.warn(TAG, `No item id for "${fishName}" — not in this session's fish table.`);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Item tooltip detail, in the shape TreasureRoulette's UIKit tooltip reads
  // (gear → equipment-swap candidate, anything else → kind:"item").
  // ---------------------------------------------------------------------------
  async function _tipFor(item) {
    if (!item) return null;
    const p = item.system?.props ?? {};
    const type = String(p.item_type ?? "").trim().toLowerCase();
    if (["weapon", "shield", "armor", "accessory"].includes(type)) {
      try {
        const cand = await globalThis.ONI?.TreasureRoulette?.Flow?._debug?.describeGear?.(item);
        if (cand) return { kind: "gear", cand };
      } catch {}
    }
    return { kind: "item", name: item.name, img: item.img, rarity: p.item_rarity ?? "", itemType: type, description: String(p.description ?? "") };
  }

  // ---------------------------------------------------------------------------
  // Sunken chest — a category by weight (IP 35 / Consumable 25 / Zenit 18 /
  // Accessory 9 / Armor 6 / Weapon 5 / Treasure 2), rolled on this area's own
  // loot tables (Dungeon Configuration, the same tables its loot tiles use).
  // "It's Empty" / "Junk" rows re-roll. Awarded straight to the angler — no
  // recipient screen; the fishing result panel shows it.
  // ---------------------------------------------------------------------------
  function _lootTableRef(scene, key) {
    try {
      const d = window.oni?.FabulaConfig?.readDungeon?.(scene) ?? scene?.getFlag?.(MODULE_ID, "oniDungeon") ?? {};
      return String(d?.loot?.[key] ?? "").trim();
    } catch { return ""; }
  }

  // A table row → a reward, or null for a row that gives nothing (re-roll).
  function _rowReward(key, row) {
    const text = String(row?.text ?? row?.name ?? "");
    if (row?.documentCollection === "Item" && row?.documentId) {
      const item = game.items.get(row.documentId);
      return item ? { kind: "item", item } : null;
    }
    if (key === "zenit") {
      const m = text.match(/(\d[\d,]*)/);
      const n = m ? parseInt(m[1].replace(/,/g, ""), 10) : 0;
      return n > 0 ? { kind: "zenit", amount: n } : null;
    }
    if (key === "item") {
      if (/refill/i.test(text) && /\bIP\b/i.test(text)) return { kind: "itempoint", fillToMax: true, text };
      const m = text.match(/\+\s*(\d+)\s*IP\b/i);
      return m && +m[1] > 0 ? { kind: "itempoint", amount: +m[1], text } : null;
    }
    return null;
  }

  async function _rollChest(actor, scene) {
    const T = CAMP.FishingTuning;
    const cats = [];
    // An angler whose IP is already full would get "+0 IP": skip that category.
    const p = actor?.system?.props ?? {};
    const ipFull = (parseInt(p.max_ip) || 0) > 0 && (parseInt(p.current_ip) || 0) >= (parseInt(p.max_ip) || 0);
    for (const c of T?.CHEST_LOOT ?? []) {
      if (c.key === "item" && ipFull) continue;
      const table = await _findTable(_lootTableRef(scene, c.key));
      if (table?.results?.size) cats.push({ ...c, table });
    }
    if (!cats.length) { console.warn(TAG, "Chest: this area has no loot tables."); return null; }
    for (let tries = 0; tries < 8; tries++) {
      let r = Math.random() * cats.reduce((a, c) => a + c.w, 0);
      const cat = cats.find(c => (r -= c.w) < 0) ?? cats[0];
      const rows = cat.table.results.contents.filter(x => (Number(x.weight) || 0) > 0);
      if (!rows.length) continue;
      let rr = Math.random() * rows.reduce((a, x) => a + (Number(x.weight) || 0), 0);
      const row = rows.find(x => (rr -= (Number(x.weight) || 0)) < 0) ?? rows[rows.length - 1];
      const reward = _rowReward(cat.key, row);
      if (reward) return { cat, reward };
    }
    return null;
  }

  async function _awardChest(actor, scene) {
    const roll = await _rollChest(actor, scene);
    if (!roll) return null;
    const { cat, reward } = roll;
    const dispatcher = window["oni.TreasureRoulette.AwardDispatcher"];
    const packet = { requestId: foundry.utils.randomID(), meta: { source: "fishing-chest" }, roller: { userId: game.user?.id } };
    let loot;
    if (reward.kind === "item") {
      packet.reward = { kind: "item", itemUuid: reward.item.uuid, quantity: 1 };
      packet.winner = { uuid: reward.item.uuid, name: reward.item.name, img: reward.item.img };
      loot = { cat: cat.label, name: reward.item.name, img: reward.item.img, tip: await _tipFor(reward.item) };
    } else if (reward.kind === "zenit") {
      packet.reward = { kind: "zenit", amount: reward.amount };
      packet.winner = { name: "Zenit", img: "icons/svg/coins.svg" };
      loot = { cat: cat.label, name: `${reward.amount} zenit`, img: null, tip: { kind: "text", name: `${reward.amount} Zenit` } };
    } else {
      packet.reward = { kind: "itempoint", amount: reward.amount ?? 0, fillToMax: !!reward.fillToMax };
      packet.winner = { name: "Inventory Points", img: null };
      loot = { cat: cat.label, name: reward.text || "Supply", img: null, tip: { kind: "text", name: reward.text || "Supply" } };
    }
    try {
      const res = await dispatcher?.award?.({ packet, recipientActorUuid: actor.uuid, postChat: true, showTransferCard: false, note: "sunken chest" });
      if (!res?.ok) { console.warn(TAG, "Chest award failed:", res?.reason); return null; }
    } catch (e) { console.error(TAG, "Chest award threw:", e); return null; }
    return loot;
  }

  // First catch of a fish by this character (the NEW! tag).
  async function _markCaught(actor, fishName) {
    const seen = actor.getFlag?.(MODULE_ID, "fishCaught") ?? [];
    if (seen.includes(fishName)) return false;
    try { await actor.setFlag(MODULE_ID, "fishCaught", [...seen, fishName]); } catch {}
    return true;
  }

  // ---------------------------------------------------------------------------
  // Pending resolver pattern — GM awaits owner's per-round result
  // ---------------------------------------------------------------------------
  // The lure can be unlimited (map spots), so a round has no fixed length: it
  // times out after IDLE_MS with no message at all from the angler.
  const IDLE_MS = 120_000;
  function _waitForRound(actor) {
    return new Promise(resolve => {
      CAMP.FishingUI ??= {};
      CAMP.FishingUI.roundResolvers ??= {};
      CAMP.FishingUI.roundTouch ??= {};

      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (CAMP.FishingUI.roundResolvers[actor.id]) {
            console.warn(TAG, "Round idle timeout — defaulting to no catch for", actor.name);
            delete CAMP.FishingUI.roundResolvers[actor.id];
            delete CAMP.FishingUI.roundTouch[actor.id];
            resolve({ fishName: null });
          }
        }, IDLE_MS);
      };
      arm();
      CAMP.FishingUI.roundTouch[actor.id] = arm;
      CAMP.FishingUI.roundResolvers[actor.id] = (result) => {
        clearTimeout(timer);
        delete CAMP.FishingUI.roundTouch[actor.id];
        resolve(result);
      };
    });
  }

  // Between rounds: the owner's CONTINUE on the result window.
  function _waitForContinue(actor) {
    return new Promise(resolve => {
      CAMP.FishingUI ??= {};
      CAMP.FishingUI.continueResolvers ??= {};
      CAMP.FishingUI.continueResolvers[actor.id] = resolve;
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
  async function _postChatResult(actor, catches, loot = []) {
    const hasCatch = catches.length > 0;
    loot = loot ?? [];
    const fishList = catches.length === 0
      ? "<em style='opacity:.6'>Nothing caught this session.</em>"
      : catches.map(f => `<li>🐟 <strong>${f}</strong></li>`).join("")
        + loot.map(l => `<li>🧰 <strong>${l.name}</strong> <em style="opacity:.7">(sunken chest)</em></li>`).join("");

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
          return false;
        }

        // A fishing spot on a map (map-system/fishing-spot.js) runs outside the
        // camp flow: it must not touch the camp's activity state.
        const fromSpot = opts?.source === "spot";

        // Who opens the minigame: null = every client (camp activity, dungeon
        // tile, walk-map spot); a list of user ids = those users and the GMs
        // only (a camp spot: the others keep roaming).
        const audience = Array.isArray(opts?.audience) ? opts.audience : null;
        _sessionFish.set(actor.id, pools.flat());
        // img rides along only so clients can preload the reveal picture at the strike.
        const fishPools = pools.map(pool => pool.map(f => ({ name: f.name, weight: f.weight, img: f.img, sh: f.sh, sz: f.sz, likes: f.likes, ex: !!f.ex })));
        // Every fish item in the world: a caught fish used as bait plays as "mooch".
        const fishFolder = game.folders?.find(f => f.type === "Item" && f.name === "Fish");
        const fishNames  = fishFolder ? game.items.filter(i => i.folder?.id === fishFolder.id).map(i => i.name) : pools.flat().map(f => f.name);
        // Lure time: camp activity + dungeon tile 20 s; a fishing spot on a map has no limit.
        const lureLimit  = fromSpot ? 0 : (CAMP.FishingTuning?.LURE_LIMIT?.camp ?? 20);
        const lootScene  = _scene ?? canvas?.scene ?? null;

        CAMP.Sound?.play(CAMP.SFX?.CAMP_START);

        // Broadcast START with stats so all clients can display them
        const stats = _getStats(actor);
        const BATTLE_TIMEOUT = 15;   // kept for old listeners; v2 derives the fight timer per angler
        const startPayload = {
          actorId:       actor.id,
          actorName:     actor.name,
          stats,
          battleTimeout: BATTLE_TIMEOUT,
          totalRounds,
          fishPools,
          fishNames,
          lureLimit,
          source:        fromSpot ? "spot" : "camp",
          audience,
        };
        CAMP.Socket.broadcast(CAMP.MSG.FISHING_START, startPayload);
        CAMP.FishingUI?.show(actor.id, actor.name, stats, startPayload);

        await new Promise(r => setTimeout(r, 300));

        // ------------------------------------------------------------------
        // Round loop (default 3; overridable via opts.totalRounds)
        // ------------------------------------------------------------------
        const catches = [];   // fish names earned this session
        const loots   = [];   // chest rewards this session

        for (let round = 1; round <= totalRounds; round++) {
          // Round 1 starts from show() (the owner's Tackle). Later rounds need
          // a broadcast so every client goes back to the Tackle / wait line.
          if (round > 1) {
            CAMP.Socket.broadcast(CAMP.MSG.FISHING_NEXT_ROUND, {
              actorId:     actor.id,
              round,
              totalRounds,
            });
            CAMP.FishingUI?.beginRound(actor.id, round, totalRounds); // GM direct
          }

          // Wait for the owner to finish this round (tackle, cast, lure, fight).
          const result   = await _waitForRound(actor);
          const fishName = result?.fishName ?? null;

          const extra = { escaped: !!result?.escaped, shape: result?.shape ?? "std", len: Number(result?.len) || 0, chestLost: !!result?.chestLost };
          let awardedFish = null;
          if (fishName && (_sessionFish.get(actor.id) ?? []).some(e => e.name === fishName)) {
            // The owner's client picked the fish (shipped trust model); the GM
            // only awards names in this session's table.
            const entry = (_sessionFish.get(actor.id) ?? []).find(e => e.name === fishName);
            const tier  = pools.findIndex(pool => pool.some(e => e.name === fishName));
            // Perfect catch (never left the bar): +1 of the same fish, not for Legendary.
            const bonus = !!result?.perfect && tier >= 0 && tier < 3;
            awardedFish = fishName;
            catches.push(awardedFish);
            const worldItem = await _awardFish(actor, awardedFish, bonus ? 2 : 1);
            const isNew = worldItem ? await _markCaught(actor, fishName) : false;
            Object.assign(extra, { tier: Math.max(0, tier), img: entry?.img ?? worldItem?.img ?? null, cost: entry?.cost ?? 0,
              bonus, isNew, fishTip: await _tipFor(worldItem) });
            // The chest is kept only when the fish lands (Stardew rule).
            if (result?.chest) {
              const loot = await _awardChest(actor, lootScene);
              if (loot) { extra.loot = loot; loots.push(loot); }
            }
            // Fish land round by round, before the Proceed wait. A GM reload must
            // not restart the rounds and award them again.
            if (!fromSpot) await CAMP.State.markResolved(actor.id);
          } else if (fishName) {
            console.warn(TAG, `"${fishName}" is not in this session's fish table — not awarded.`);
          }

          // Broadcast round result to all clients
          CAMP.Socket.broadcast(CAMP.MSG.FISHING_RESULT, {
            actorId:  actor.id,
            round,
            fishName: awardedFish,
            catches:  [...catches],
            ...extra,
          });
          CAMP.FishingUI?.applyResult(actor.id, round, awardedFish, [...catches], extra);

          // Between rounds the owner reads the result and presses CONTINUE.
          if (round < totalRounds) await _waitForContinue(actor);
        }

        // ------------------------------------------------------------------
        // End of session — show summary, wait for Proceed
        // ------------------------------------------------------------------
        await _postChatResult(actor, catches, loots);
        await _waitForProceed(actor);
        _sessionFish.delete(actor.id);

        CAMP.Socket.broadcast(CAMP.MSG.FISHING_DONE, { actorId: actor.id });
        CAMP.FishingUI?.hide();
        return true;
      },
    });
  });

  console.debug(TAG, "Fishing activity loaded.");
})();
