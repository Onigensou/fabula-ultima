/**
 * [ONI] Treasure Chest System — MODULE CORE (v4)
 * Foundry VTT v12
 *
 * What it does:
 * - Treasure chests and item bags placed on exploration maps, JRPG style.
 *   A chest is a tile with flags.oni-treasure-chest (Tile Config → Treasure).
 * - Proximity 🖐 button over the chest, and the keyboard Confirm key through
 *   window.oni.Interact.
 * - Opening it hands out its FIXED contents: Zenit and/or one item (with a
 *   quantity). Equipment goes through the dungeon loot screens (who takes it,
 *   equip now?) via TreasureRoulette Flow.awardFixed(); everything else goes
 *   straight to the party.
 *
 * Opened state is PER PARTY, not per world:
 * - Opening a chest writes Event System memory on the party database actor
 *   (flags.<module>.eventState.<sceneId>.<tileId>.erased, event-gameState.js),
 *   so each party has its own chests and a loaded save brings them back.
 *   The tile document is never changed. An opened chest stops drawing on
 *   player clients and shows faded to a GM.
 * - A tile already `hidden` in the world is a chest opened under the old
 *   system (v3 hid the tile) — still treated as opened, for everyone.
 *
 * Tiers (flags.oni-treasure-chest.tier):
 *   mundane  — Zenit or consumables. Bag art.
 *   standard — better gear, more Zenit, costly consumables. Silver chest for
 *              gear, bag for Zenit/consumables.
 *   rare     — big Zenit, Rare/Legendary item. Gold chest. Hidden on the map:
 *              players do not see it until the party is within revealRadius
 *              (grid squares), then it fades in with a sparkle sound.
 *   ""       — a chest made before tiers (v3). Behaves as standard; its art
 *              is whatever the tile already shows.
 *
 * Exposes API to:
 *   window.oni.TreasureChest.Core
 *   window.oni.TreasureChest.TIERS / artFor() (used by the config tab + lint)
 */

(() => {
  const TAG = "[ONI][TreasureChest]";
  const DEBUG = false;

  // ─────────────────────────────────────────────────────────────
  // Global namespace + guard
  // ─────────────────────────────────────────────────────────────
  window.oni = window.oni || {};
  window.oni.TreasureChest = window.oni.TreasureChest || {};

  const CORE_KEY = "Core";
  if (window.oni.TreasureChest[CORE_KEY]?.installed) {
    DEBUG && console.log(TAG, "Already installed; skipping.");
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────
  const SCOPE = "oni-treasure-chest";
  const CHANNELS = ["module.fabula-ultima-companion", "fabula-ultima-companion"];
  const MSG_OPEN_REQ  = "ONI_TREASURE_OPEN_REQ_V3";
  const MSG_OPEN_DONE = "ONI_TREASURE_OPEN_DONE_V3";

  const POS_OVERRIDE_TTL_MS = 800;

  const ASSET = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
  const ZENIT_ICON = `${ASSET}/Item%20Icon/GP.png`;

  const SFX = {
    bag:    `${ASSET}/Sound/Soundboard/Item3.ogg`,
    chest:  `${ASSET}/Sound/TreasureGet.ogg`,
    unlock: `${ASSET}/Sound/Soundboard/Key.ogg`,
    reveal: `${ASSET}/Sound/Up3.ogg`,
  };

  const ART = {
    bag:    `${ASSET}/Item%20Icon/bag.png`,
    silver: `${ASSET}/Item%20Icon/Silver_Chest.png`,
    gold:   `${ASSET}/Item%20Icon/Gold_Chest.png`,
  };

  const TIERS = Object.freeze({
    mundane:  { label: "Mundane",  hidden: false },
    standard: { label: "Standard", hidden: false },
    rare:     { label: "Rare",     hidden: true  },
  });

  const DEFAULT_REVEAL_RADIUS = 1.5;   // grid squares, rare chests only
  // Tile opacity for placed chests: the icon art is clean and bright, painted
  // maps are not, and at full opacity a chest pops out of the scene (user,
  // 2026-10-24). Values are the user's own from the hand-placed chests on
  // Ancient Temple / Wyrmwood: bags 0.5, chests about 0.65.
  const ALPHA = { bag: 0.5, chest: 0.65 };
  const alphaFor = (src) => String(src ?? "").endsWith("bag.png") ? ALPHA.bag : ALPHA.chest;
  const OPENED_GM_ALPHA = 0.3;         // a GM still sees where an opened chest sat
  const HIDDEN_GM_ALPHA = 0.5;         // ...and where an unrevealed rare one is
  const REVEAL_FADE_MS = 700;

  const EQUIPPABLE_TYPES = new Set(["weapon", "shield", "armor", "accessory"]);

  // computed after canvas exists
  const getRangePx = () => Math.floor((canvas?.grid?.size ?? 100) * 1.25);

  const log  = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  // The one rule for which picture a chest wears. Zenit or consumables only
  // = the item bag; gear = a chest whose colour follows the tier.
  function artFor({ tier, hasEquipment }) {
    if (tier === "rare") return ART.gold;
    if (tier === "standard" && hasEquipment) return ART.silver;
    return ART.bag;
  }

  // ─────────────────────────────────────────────────────────────
  // Authority
  // ─────────────────────────────────────────────────────────────
  // Same election as every other GM-host system (lowest active GM id), so two
  // GM clients never both hand out a chest.
  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? !!game.user?.isGM;

  // Only the Movement Control main controller (and GMs) open things, the same
  // rule as examine points and talk.
  const isLocalInteractor = () => window.oni.EventSystem?.Flow?.isLocalUserInteractor?.() ?? true;

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  const escapeHTML = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  // GM-side, broadcast: everyone hears the chest open.
  const playSfx = (src, volume = 0.9) => {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, true);
    } catch (e) {
      warn("Failed to play SFX:", src, e);
    }
  };

  // Client-side only: each client reveals a rare chest on its own.
  const playLocalSfx = (src, volume = 0.7) => {
    try {
      AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
    } catch (e) {
      warn("Failed to play local SFX:", src, e);
    }
  };

  const worldToScreen = (x, y) => {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x, y };
    return { x: (t.a * x) + t.tx, y: (t.d * y) + t.ty };
  };

  const getTileCenter = (tile) => {
    const d = tile?.document ?? tile;
    const x = (d?.x ?? 0) + ((d?.width ?? 0) / 2);
    const y = (d?.y ?? 0) + ((d?.height ?? 0) / 2);
    return { x, y };
  };

  const getTokenCenterPx = (token, overrideXY = null) => {
    const doc = token?.document;
    const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
    const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
    const w = token?.w ?? 0;
    const h = token?.h ?? 0;
    return { x: baseX + (w / 2), y: baseY + (h / 2) };
  };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ─────────────────────────────────────────────────────────────
  // DB Resolver
  // ─────────────────────────────────────────────────────────────
  const resolveDbActor = async () => {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) {
      ui.notifications?.error?.("DB Resolver missing: window.FUCompanion.api.getCurrentGameDb()");
      return null;
    }
    const cache = await api.getCurrentGameDb();
    const db = cache?.db ?? null;
    if (!db) ui.notifications?.warn?.("No current game DB Actor found.");
    log("DB resolve:", { db: db?.name, uuid: db?.uuid });
    return db;
  };

  // A player controls the party token, so their selection IS the party. A GM
  // selects whatever they are working on, so a GM looks the party token up
  // first and falls back to the selection only on a map with no party token
  // (same rule as the Event System, after the 2026-10-13 NPC-selected bug).
  const resolvePartyToken = async () => {
    if (!canvas?.ready) return null;

    const controlled = canvas.tokens?.controlled?.[0] ?? null;
    if (controlled && !game.user?.isGM) return controlled;

    const api = window.FUCompanion?.api;
    const cache = api?.getCurrentGameDb ? await api.getCurrentGameDb().catch(() => null) : null;
    const db = cache?.db ?? null;
    if (!db) return controlled;

    const tokens = canvas.tokens?.placeables ?? [];
    return tokens.find(t => t?.actor?.id === db.id)
      ?? (cache?.source ? tokens.find(t => t?.actor?.id === cache.source.id) : null)
      ?? controlled;
  };

  // ─────────────────────────────────────────────────────────────
  // Treasure flags read
  // ─────────────────────────────────────────────────────────────
  const readTreasureData = (tile) => {
    const doc = tile?.document ?? tile;
    const data = doc?.flags?.[SCOPE] ?? {};
    const tier = String(data?.tier ?? "").trim().toLowerCase();
    return {
      isTreasure: !!data?.isTreasureChest,
      isHidden: !!doc?.hidden,
      tier: TIERS[tier] ? tier : "",
      itemUuid: String(data?.itemUuid ?? "").trim(),
      itemName: String(data?.itemName ?? "").trim(),
      itemImg:  String(data?.itemImg  ?? "").trim(),
      quantity: Math.max(1, Number(data?.quantity ?? 1) || 1),
      zenit:    Math.max(0, Number(data?.zenit ?? 0) || 0),
      revealRadius: Math.max(0, Number(data?.revealRadius ?? DEFAULT_REVEAL_RADIUS) || 0),
      _raw: data
    };
  };

  // ─────────────────────────────────────────────────────────────
  // Per-party opened state (Event System memory)
  // ─────────────────────────────────────────────────────────────
  const gameState = () => window.oni?.EventSystem?.GameState ?? window.oni?.GameState ?? null;

  function isOpened(tileDoc) {
    if (!tileDoc) return true;
    if (tileDoc.hidden) return true;   // opened under v3, or hidden by the GM
    const sceneId = tileDoc.parent?.id;
    const mem = gameState()?.getMemory?.(sceneId, tileDoc.id);
    return !!mem?.erased;
  }

  async function markOpened(tileDoc) {
    const GS = gameState();
    if (!GS?.erase) throw new Error("Event System GameState missing — cannot record the chest as opened.");
    const ok = await GS.erase(tileDoc.parent?.id, tileDoc.id);
    if (!ok) throw new Error("GameState.erase refused (no party actor?).");
  }

  // ─────────────────────────────────────────────────────────────
  // Visibility on this client
  // ─────────────────────────────────────────────────────────────
  // Rare chests this client has revealed: `${sceneId}.${tileId}`. Not saved —
  // a rare chest hides again when the scene is entered anew, as in a JRPG
  // where the sparkle shows only up close.
  const revealed = new Set();
  const revealKey = (tileDoc) => `${tileDoc?.parent?.id}.${tileDoc?.id}`;

  // How this client should draw a chest: "normal" | "opened" | "concealed".
  function visualState(tile) {
    const doc = tile?.document ?? tile;
    const td = readTreasureData(doc);
    if (!td.isTreasure) return "normal";
    if (isOpened(doc)) return doc.hidden ? "normal" : "opened";   // a world-hidden tile is Foundry's to draw
    if (TIERS[td.tier]?.hidden && !revealed.has(revealKey(doc))) return "concealed";
    return "normal";
  }

  // Runs on every refreshTile, after Foundry has set the mesh up, and on our
  // own state changes. Must never throw (a throw inside a PIXI-driven refresh
  // can stall the canvas).
  function applyVisual(tile) {
    try {
      const mesh = tile?.mesh;
      if (!mesh) return;
      const state = visualState(tile);
      if (state === "normal") {
        if (tile._oniChestVisual) {
          mesh.renderable = true;
          mesh.alpha = tile.document?.alpha ?? 1;
          tile._oniChestVisual = null;
        }
        return;
      }
      tile._oniChestVisual = state;
      if (game.user?.isGM) {
        mesh.renderable = true;
        mesh.alpha = state === "opened" ? OPENED_GM_ALPHA : HIDDEN_GM_ALPHA;
      } else {
        mesh.renderable = false;
      }
    } catch (e) {
      warn("applyVisual failed:", e);
    }
  }

  function applyAllVisuals() {
    for (const t of canvas?.tiles?.placeables ?? []) {
      if (readTreasureData(t).isTreasure) applyVisual(t);
    }
  }

  function revealChest(tile) {
    const key = revealKey(tile.document);
    if (revealed.has(key)) return;
    revealed.add(key);
    try {
      const mesh = tile.mesh;
      if (!mesh) return;
      tile._oniChestVisual = null;
      mesh.renderable = true;
      const target = tile.document?.alpha ?? 1;
      mesh.alpha = 0;
      playLocalSfx(SFX.reveal);
      CanvasAnimation.animate(
        [{ parent: mesh, attribute: "alpha", to: target }],
        { name: `oni-chest-reveal-${tile.id}`, duration: REVEAL_FADE_MS }
      ).catch(() => { mesh.alpha = target; });
    } catch (e) {
      warn("reveal failed:", e);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UI overlay (🖐) + chat CSS
  // ─────────────────────────────────────────────────────────────
  const CSS_ID = "oni-treasure-chest-style";
  const ensureCSS = () => {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
#oni-treasure-ui-layer{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:10000;}
.oni-treasure-btn{
  position:absolute;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;
  width:42px;height:42px;border-radius:999px;
  background:rgba(30,30,30,.85);border:1px solid rgba(255,255,255,.18);
  box-shadow:0 10px 22px rgba(0,0,0,.35);
  font-size:20px;line-height:1;
  opacity:0;transform:translate(-50%,-50%) scale(.85);
  transition:opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
}
.oni-treasure-btn.is-visible{opacity:1;transform:translate(-50%,-50%) scale(1);}
.oni-treasure-btn.is-hiding{opacity:0;transform:translate(-50%,-50%) scale(.78);}

/* Silent speaker wrapper (same class used by ItemAwarder) */
.chat-message.oni-obtain-msg,
.chat-message:has(.oni-obtain-card){background:transparent!important;border:none!important;box-shadow:none!important;padding:0!important;}
.chat-message.oni-obtain-msg header.message-header,
.chat-message:has(.oni-obtain-card) header.message-header{display:none!important;}
.chat-message.oni-obtain-msg .message-metadata,
.chat-message:has(.oni-obtain-card) .message-metadata{display:none!important;}
.chat-message.oni-obtain-msg .message-content,
.chat-message:has(.oni-obtain-card) .message-content{padding:0!important;}
.chat-message.oni-obtain-msg .message-controls,
.chat-message:has(.oni-obtain-card) .message-controls{display:none!important;}
    `;
    document.head.appendChild(style);
    log("Injected CSS:", CSS_ID);
  };

  class TreasureUI {
    constructor(core) {
      this.core = core;
      this.layer = null;
      this.buttons = new Map();
      this.desired = new Set();
      this.opening = new Set();
    }
    start() {
      if (this.layer) return;
      ensureCSS();
      this.layer = document.createElement("div");
      this.layer.id = "oni-treasure-ui-layer";
      document.body.appendChild(this.layer);
      log("UI layer created.");
    }
    stop() {
      for (const el of this.buttons.values()) el.remove();
      this.buttons.clear();
      this.desired.clear();
      this.opening.clear();
      this.layer?.remove();
      this.layer = null;
      log("UI layer removed.");
    }
    async press(tileId) {
      if (this.opening.has(tileId)) return;
      this.opening.add(tileId);
      const btn = this.buttons.get(tileId);
      if (btn) btn.disabled = true;
      try {
        await this.core.requestOpen(tileId);
      } finally {
        setTimeout(() => {
          this.opening.delete(tileId);
          if (btn) btn.disabled = false;
        }, 350);
      }
    }
    setDesired(desiredSet) {
      this.desired = new Set(desiredSet);

      for (const tileId of this.desired) {
        if (this.buttons.has(tileId)) continue;
        const btn = document.createElement("button");
        btn.className = "oni-treasure-btn";
        btn.type = "button";
        btn.title = "Open Treasure";
        btn.textContent = "🖐";

        btn.addEventListener("click", async (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          await this.press(tileId);
        });

        this.layer.appendChild(btn);
        this.buttons.set(tileId, btn);
        requestAnimationFrame(() => btn.classList.add("is-visible"));
        log("UI button created for tile:", tileId);
      }

      for (const [tileId, btn] of Array.from(this.buttons.entries())) {
        if (this.desired.has(tileId)) continue;
        btn.classList.remove("is-visible");
        btn.classList.add("is-hiding");
        this.buttons.delete(tileId);
        setTimeout(() => btn.remove(), 220);
        log("UI button removed for tile:", tileId);
      }
    }
    repositionAll() {
      for (const [tileId, btn] of this.buttons.entries()) {
        const tile = canvas.tiles?.get(tileId);
        if (!tile) continue;
        const c = getTileCenter(tile);
        const s = worldToScreen(c.x, c.y);
        btn.style.left = `${s.x}px`;
        btn.style.top  = `${s.y - 32}px`;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Chat cards
  // ─────────────────────────────────────────────────────────────
  const postObtainCard = async ({ iconImg, text }) => {
    const html = `
<div class="oni-obtain-card">
  <div class="oni-obtain-row">
    <img class="oni-obtain-icon" src="${escapeHTML(iconImg ?? "")}" alt="">
    <div class="oni-obtain-text">${text}</div>
  </div>
</div>`;

    await ChatMessage.create({
      user: game.user.id,
      speaker: null,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content: html,
      flags: { core: { cssClass: "oni-obtain-msg" } }
    });
  };

  const postObtainCard_Item = ({ iconImg, qty, name, linkUuid }) => {
    const safeName = escapeHTML(name ?? "Unknown Item");
    const qtyPrefix = (qty > 1) ? `${qty} ` : "";
    const nameLink = linkUuid
      ? `<a class="content-link" data-uuid="${escapeHTML(linkUuid)}"><span class="oni-obtain-name">${safeName}</span></a>`
      : `<span class="oni-obtain-name">${safeName}</span>`;
    return postObtainCard({ iconImg, text: `Obtain ${escapeHTML(qtyPrefix)}${nameLink}!` });
  };

  const postObtainCard_Zenit = ({ amount }) =>
    postObtainCard({
      iconImg: ZENIT_ICON,
      text: `Obtain <span class="oni-obtain-name">${escapeHTML(amount)}</span> Zenit!`
    });

  // ─────────────────────────────────────────────────────────────
  // GM open logic
  // ─────────────────────────────────────────────────────────────
  // Tiles with an open in progress (a double click, or a click and a key).
  const _busy = new Set();

  const isEquipment = (item) =>
    EQUIPPABLE_TYPES.has(String(item?.system?.props?.item_type ?? "").trim().toLowerCase());

  async function awardZenit({ db, amount, requesterId }) {
    const ITC = window["oni.ItemTransferCore"];
    const fn = ITC?.adjustZenit ?? ITC?.adjustActorZenit;
    if (typeof fn !== "function") throw new Error("ItemTransferCore.adjustZenit missing.");
    await fn.call(ITC, { actorUuid: db.uuid, delta: amount, requestedByUserId: requesterId });
    await postObtainCard_Zenit({ amount });
  }

  // Straight into the party's inventory, with the house "Obtain X!" card.
  async function awardItemToParty({ db, itemUuid, item, qty, requesterId, fallback }) {
    const ITC = window["oni.ItemTransferCore"];
    if (!ITC?.transfer) throw new Error('ItemTransferCore missing: window["oni.ItemTransferCore"].transfer');
    const result = await ITC.transfer({
      mode: "gmToActor",
      itemUuid,
      quantity: qty,
      receiverActorUuid: db.uuid,
      requestedByUserId: requesterId,
      showTransferCard: false
    });
    const receiverItemUuid = result?.receiverItemUuid || result?.receiver?.itemUuid || null;
    await postObtainCard_Item({
      iconImg: item?.img ?? fallback.img,
      qty,
      name: item?.name ?? fallback.name,
      linkUuid: receiverItemUuid || itemUuid
    });
  }

  const gmOpenChest = async ({ sceneId, tileId, requesterId }) => {
    if (!game.user?.isGM || !isPrimaryGM()) return;

    const scene = game.scenes?.get(sceneId);
    const tileDoc = scene?.tiles?.get(tileId);
    if (!tileDoc) return warn("GM open: tile not found:", { sceneId, tileId });

    const data = readTreasureData(tileDoc);
    if (!data.isTreasure) return warn("GM open: not a treasure tile, abort.");
    if (isOpened(tileDoc)) return log("GM open: already opened for this party.", tileId);

    const hasItem = !!data.itemUuid;
    const hasZenit = data.zenit > 0;
    if (!hasItem && !hasZenit) {
      ui.notifications?.warn?.("This chest has no reward configured.");
      return;
    }

    if (_busy.has(tileId)) return;
    _busy.add(tileId);

    try {
      const db = await resolveDbActor();
      if (!db) return;

      let item = null;
      if (hasItem) {
        try { item = await fromUuid(data.itemUuid); } catch {}
        if (!item) warn("GM open: chest item not found, awarding by uuid anyway:", data.itemUuid);
      }
      const gear = hasItem && isEquipment(item);

      // Consume first: once the chest is marked, a crash below must not let
      // it be opened a second time. The reward is then granted no matter what.
      await markOpened(tileDoc);

      playSfx(gear || data.tier === "rare" ? SFX.chest : SFX.bag);

      if (hasZenit) {
        try {
          await awardZenit({ db, amount: data.zenit, requesterId });
        } catch (e) {
          err("GM open: zenit award failed:", e);
          ui.notifications?.error?.("Treasure: Zenit could not be granted (see console).");
        }
      }

      if (hasItem) {
        const fallback = { name: data.itemName || "Unknown Item", img: data.itemImg || "" };
        const flow = window["oni.TreasureRoulette.Flow"];
        let handled = false;

        // Gear gets the dungeon loot screens: who carries it, equip now?
        if (gear && flow?.awardFixed) {
          try {
            const res = await flow.awardFixed({
              itemUuid: data.itemUuid,
              quantity: data.quantity,
              title: TIERS[data.tier]?.label ? `${TIERS[data.tier].label} Treasure` : "Treasure",
              meta: { source: "TreasureChest", sceneId, tileId, tier: data.tier }
            });
            handled = !!res?.ok;
            if (!handled) warn("awardFixed did not award, falling back to Party Inventory:", res);
          } catch (e) {
            warn("awardFixed threw, falling back to Party Inventory:", e);
          }
        }

        if (!handled) {
          try {
            await awardItemToParty({ db, itemUuid: data.itemUuid, item, qty: data.quantity, requesterId, fallback });
          } catch (e) {
            err("GM open: item award failed — chest already marked opened:", e, data);
            ui.notifications?.error?.(`Treasure: ${fallback.name} could not be granted (see console).`);
          }
        }
      }

      for (const ch of CHANNELS) {
        try { game.socket.emit(ch, { type: MSG_OPEN_DONE, payload: { sceneId, tileId } }); } catch {}
      }
    } catch (e) {
      err("GM open failed:", e);
      ui.notifications?.error?.("Treasure open failed (see console).");
    } finally {
      _busy.delete(tileId);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // Core object (module API)
  // ─────────────────────────────────────────────────────────────
  const core = {
    installed: true,
    running: false,

    ui: null,
    _hooks: [],
    _socketFn: null,

    _posOverrides: new Map(),
    _scanQueued: false,

    _setOverride(tokenId, x, y) {
      this._posOverrides.set(tokenId, { x, y, ts: Date.now() });
      log("Pos override set:", { tokenId, x, y });
    },

    _getOverride(tokenId) {
      const o = this._posOverrides.get(tokenId);
      if (!o) return null;
      if ((Date.now() - o.ts) > POS_OVERRIDE_TTL_MS) {
        this._posOverrides.delete(tokenId);
        return null;
      }
      return o;
    },

    _cleanupOverrides() {
      const now = Date.now();
      for (const [tid, o] of this._posOverrides.entries()) {
        if ((now - o.ts) > POS_OVERRIDE_TTL_MS) this._posOverrides.delete(tid);
      }
    },

    _queueScan(reason = "unknown") {
      if (this._scanQueued) return;
      this._scanQueued = true;

      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          this._scanQueued = false;
          await this.scan(reason);
        });
      });
    },

    async scan(reason = "scan") {
      try {
        if (!canvas?.ready) return;
        if (!this.running) return;

        this._cleanupOverrides();

        const partyTok = await resolvePartyToken();
        if (!partyTok) {
          this.ui?.setDesired(new Set());
          return;
        }

        const ov = this._getOverride(partyTok.id);
        const partyCenter = getTokenCenterPx(partyTok, ov ? { x: ov.x, y: ov.y } : null);
        const gridPx = canvas.grid?.size ?? 100;

        const tiles = canvas.tiles?.placeables ?? [];
        const desired = new Set();
        const RANGE_PX = getRangePx();

        for (const t of tiles) {
          const td = readTreasureData(t);
          if (!td.isTreasure) continue;
          if (isOpened(t.document)) continue;

          const d = dist(partyCenter, getTileCenter(t));

          if (TIERS[td.tier]?.hidden && !revealed.has(revealKey(t.document))) {
            if (d > td.revealRadius * gridPx) continue;
            revealChest(t);
          }

          if (d <= RANGE_PX) desired.add(t.id);
        }

        log("Scan:", { reason, RANGE_PX, desired: Array.from(desired), override: ov ?? null });
        this.ui?.setDesired(desired);
        this.ui?.repositionAll();
      } catch (e) {
        err("scan failed:", e);
      }
    },

    async requestOpen(tileId) {
      try {
        const sceneId = canvas.scene?.id;
        if (!sceneId) return;
        if (!isLocalInteractor()) {
          ui.notifications?.info?.("Only the player leading the party can open this.");
          return;
        }

        // Primary GM opens directly.
        if (game.user.isGM && isPrimaryGM()) {
          await gmOpenChest({ sceneId, tileId, requesterId: game.user.id });
          this._queueScan("after-gm-open");
          return;
        }

        // Secondary GM or player forwards request to primary GM.
        const payload = { sceneId, tileId, requesterId: game.user.id };
        for (const ch of CHANNELS) {
          try {
            game.socket.emit(ch, { type: MSG_OPEN_REQ, payload });
            log("Socket emit:", { ch, type: MSG_OPEN_REQ, payload });
            break;
          } catch (e) {
            warn("Socket emit failed on:", ch, e);
          }
        }
      } catch (e) {
        err("requestOpen failed:", e);
      }
    },

    // Keyboard play (window.oni.Interact): the chest buttons on offer now.
    listInteractions() {
      if (!this.running || !this.ui) return [];
      const allowed = isLocalInteractor();
      const out = [];
      for (const [tileId, el] of this.ui.buttons.entries()) {
        const tile = canvas.tiles?.get(tileId);
        if (!tile) continue;
        out.push({
          target: `tile:${tileId}`,
          label: "Open",
          icon: "fas fa-box-open",
          order: 10,
          anchor: getTileCenter(tile),
          el,
          allowed,
          run: () => this.ui?.press(tileId)
        });
      }
      return out;
    },

    async start() {
      if (this.running) return;
      if (!canvas?.ready) {
        warn("start() called but canvas not ready yet.");
        return;
      }

      this.ui = new TreasureUI(this);
      this.ui.start();

      // Socket
      this._socketFn = async (msg) => {
        try {
          if (!msg?.type) return;

          if (msg.type === MSG_OPEN_REQ) {
            if (!game.user.isGM || !isPrimaryGM()) return;
            await gmOpenChest(msg.payload);
            this._queueScan("after-socket-open");
          }

          if (msg.type === MSG_OPEN_DONE) {
            this._queueScan("after-open-done");
          }
        } catch (e) {
          err("socket handler error:", e);
        }
      };

      for (const ch of CHANNELS) {
        try {
          game.socket.on(ch, this._socketFn);
        } catch (e) {
          warn("Socket listener failed on:", ch, e);
        }
      }

      // Hooks
      const onUpdateToken = async (tokenDoc, changes) => {
        const moved = ("x" in changes) || ("y" in changes);
        if (!moved) return;

        const afterX = ("x" in changes) ? changes.x : tokenDoc.x;
        const afterY = ("y" in changes) ? changes.y : tokenDoc.y;

        const partyTok = await resolvePartyToken();
        if (!partyTok) return;
        if (tokenDoc.id !== partyTok.id) return;

        this._setOverride(tokenDoc.id, afterX, afterY);
        this._queueScan("updateToken(move)");
      };

      const onCreateToken = () => this._queueScan("createToken");
      const onDeleteToken = () => this._queueScan("deleteToken");
      const onUpdateTile  = () => this._queueScan("updateTile");
      const onRefreshTile = (tile) => applyVisual(tile);
      const onCanvasPan   = () => this.ui?.repositionAll();
      const onCanvasReady = () => {
        revealed.clear();
        applyAllVisuals();
        this._queueScan("canvasReady");
      };
      // A chest opened, a save loaded, another party took over: redraw.
      const onGameState   = () => {
        applyAllVisuals();
        this._queueScan("gameStateChanged");
      };
      const onResize      = () => this.ui?.repositionAll();

      const hooks = [
        ["updateToken", onUpdateToken],
        ["createToken", onCreateToken],
        ["deleteToken", onDeleteToken],
        ["updateTile", onUpdateTile],
        ["refreshTile", onRefreshTile],
        ["canvasPan", onCanvasPan],
        ["canvasReady", onCanvasReady],
        ["oniGameStateChanged", onGameState],
      ];
      for (const [evt, fn] of hooks) {
        Hooks.on(evt, fn);
        this._hooks.push([evt, fn]);
      }
      window.addEventListener("resize", onResize);
      this._hooks.push(["resize", onResize]);

      window.oni.Interact?.register?.("chest", () => this.listInteractions());

      this.running = true;

      applyAllVisuals();
      await this.scan("start");
      log("Treasure Chest system started.", { RANGE_PX: getRangePx(), isPrimaryGM: isPrimaryGM() });
    },

    async stop() {
      if (!this.running) return;

      for (const ch of CHANNELS) {
        try { game.socket.off(ch, this._socketFn); } catch {}
      }

      for (const [evt, fn] of this._hooks) {
        try {
          if (evt === "resize") window.removeEventListener("resize", fn);
          else Hooks.off(evt, fn);
        } catch {}
      }
      this._hooks = [];

      window.oni.Interact?.unregister?.("chest");

      this._posOverrides.clear();
      this._scanQueued = false;

      this.ui?.stop();
      this.ui = null;

      this.running = false;
      log("Treasure Chest system stopped.");
    },

    // Console / test helpers.
    isOpened,
    visualState,
    readTreasureData,
    _revealed: revealed
  };

  // Publish API
  window.oni.TreasureChest[CORE_KEY] = core;
  window.oni.TreasureChest.TIERS = TIERS;
  window.oni.TreasureChest.ART = ART;
  window.oni.TreasureChest.DEFAULT_REVEAL_RADIUS = DEFAULT_REVEAL_RADIUS;
  window.oni.TreasureChest.ALPHA = ALPHA;
  window.oni.TreasureChest.alphaFor = alphaFor;
  window.oni.TreasureChest.artFor = artFor;
  window.oni.TreasureChest.isEquipment = isEquipment;

  // ─────────────────────────────────────────────────────────────
  // Self install after Foundry ready
  // ─────────────────────────────────────────────────────────────
  function boot() {
    // We only auto-start once canvas is ready
    if (canvas?.ready) {
      core.start();
    } else {
      Hooks.once("canvasReady", () => core.start());
    }
  }

  Hooks.once("ready", () => {
    log("Boot on ready.");
    boot();
  });

  log("Core installed (module). API: window.oni.TreasureChest.Core");
})();
