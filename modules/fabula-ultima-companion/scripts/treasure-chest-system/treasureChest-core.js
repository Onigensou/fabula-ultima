/**
 * [ONI] Treasure Chest System — MODULE CORE (v3.1)
 * - Auto-installs after Foundry is ready (self installing)
 * - Guarded to prevent double installs
 * - Exposes window.oni.TreasureChest.Core.start/stop
 *
 * Keeps the same gameplay behavior as your macro core:
 * - Proximity detection (override + double-rAF scan)
 * - Show 🫴 button
 * - Award item (priority) or zenit (fallback)
 * - Hide tile after open; ignore hidden tiles
 * - Pickup SFX
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
  const CHANNELS = ["module.fabula-ultima-companion", "fabula-ultima-companion"];
  const MSG_OPEN_REQ  = "ONI_TREASURE_OPEN_REQ_V3";
  const MSG_OPEN_DONE = "ONI_TREASURE_OPEN_DONE_V3";

  const POS_OVERRIDE_TTL_MS = 800;
  const PICKUP_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Item3.ogg";
  const ZENIT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";

  // computed after canvas exists
  const getRangePx = () => Math.floor((canvas?.grid?.size ?? 100) * 1.25);

  const log  = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

  // ─────────────────────────────────────────────────────────────
  // Multi-GM authority helpers
  // ─────────────────────────────────────────────────────────────
  function getPrimaryActiveGM() {
    const gms = (game.users?.contents ?? []).filter((u) => u?.isGM && u?.active);
    return gms[0] ?? null;
  }

  function isPrimaryActiveGM() {
    const gm = getPrimaryActiveGM();
    return !!gm && game.user?.id === gm.id;
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  const escapeHTML = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  const playPickupSfx = () => {
    try {
      AudioHelper.play({ src: PICKUP_SFX, volume: 0.9, autoplay: true, loop: false }, true);
      log("Pickup SFX played:", PICKUP_SFX);
    } catch (e) {
      warn("Failed to play pickup SFX:", e);
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

  const resolvePartyToken = async () => {
    if (!canvas?.ready) return null;

    const controlled = canvas.tokens?.controlled?.[0];
    if (controlled) return controlled;

    const db = await resolveDbActor();
    if (!db) return null;

    const tokens = canvas.tokens?.placeables ?? [];
    return tokens.find(t => t?.actor?.id === db.id) ?? null;
  };

  // ─────────────────────────────────────────────────────────────
  // Treasure flags read (robust scan)
  // ─────────────────────────────────────────────────────────────
  const findTreasureConfigObject = (tileDoc) => {
    const flags = tileDoc?.flags ?? {};
    for (const [scope, scopeObj] of Object.entries(flags)) {
      if (!scopeObj || typeof scopeObj !== "object") continue;
      for (const [key, val] of Object.entries(scopeObj)) {
        if (val && typeof val === "object" && ("isTreasureChest" in val)) return { scope, key, data: val };
      }
      if ("isTreasureChest" in scopeObj) return { scope, key: null, data: scopeObj };
    }
    return { scope: null, key: null, data: null };
  };

  const readTreasureData = (tile) => {
    const doc = tile?.document ?? tile;
    const found = findTreasureConfigObject(doc);
    const data = found?.data ?? {};
    return {
      isTreasure: !!data?.isTreasureChest,
      isHidden: !!doc?.hidden,
      itemUuid: String(data?.itemUuid ?? "").trim(),
      itemName: String(data?.itemName ?? "").trim(),
      itemImg:  String(data?.itemImg  ?? "").trim(),
      quantity: Math.max(1, Number(data?.quantity ?? 1) || 1),
      zenit:    Math.max(0, Number(data?.zenit ?? 0) || 0),
      _raw: data
    };
  };

  // ─────────────────────────────────────────────────────────────
  // UI overlay (🫴) + chat CSS
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
          if (this.opening.has(tileId)) return;
          this.opening.add(tileId);
          btn.disabled = true;
          try {
            await this.core.requestOpen(tileId);
          } finally {
            setTimeout(() => {
              this.opening.delete(tileId);
              btn.disabled = false;
            }, 350);
          }
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
        setTimeout(() => {
          btn.remove();
          this.buttons.delete(tileId);
          log("UI button removed for tile:", tileId);
        }, 220);
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
  const postObtainCard_Item = async ({ iconImg, qty, name, linkUuid }) => {
    const safeName = escapeHTML(name ?? "Unknown Item");
    const qtyPrefix = (qty > 1) ? `${qty} ` : "";
    const nameLink = linkUuid
      ? `<a class="content-link" data-uuid="${escapeHTML(linkUuid)}"><span class="oni-obtain-name">${safeName}</span></a>`
      : `<span class="oni-obtain-name">${safeName}</span>`;

    const html = `
<div class="oni-obtain-card">
  <div class="oni-obtain-row">
    <img class="oni-obtain-icon" src="${escapeHTML(iconImg ?? "")}" alt="${safeName}">
    <div class="oni-obtain-text">Obtain ${escapeHTML(qtyPrefix)}${nameLink}!</div>
  </div>
</div>`;

    await ChatMessage.create({
      user: game.user.id,
      speaker: null,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content: html,
      flags: { core: { cssClass: "oni-obtain-msg" } }
    });

    log("Chat card posted (item).", { qty, name, linkUuid });
  };

  const postObtainCard_Zenit = async ({ amount }) => {
    const html = `
<div class="oni-obtain-card">
  <div class="oni-obtain-row">
    <img class="oni-obtain-icon" src="${ZENIT_ICON}" alt="Zenit">
    <div class="oni-obtain-text">Obtain <span class="oni-obtain-name">${escapeHTML(amount)}</span> Zenit!</div>
  </div>
</div>`;

    await ChatMessage.create({
      user: game.user.id,
      speaker: null,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content: html,
      flags: { core: { cssClass: "oni-obtain-msg" } }
    });

    log("Chat card posted (zenit).", { amount });
  };

  // ─────────────────────────────────────────────────────────────
  // GM open logic
  // ─────────────────────────────────────────────────────────────
  const gmOpenChest = async ({ sceneId, tileId, requesterId }) => {
    if (!game.user?.isGM) {
      warn("gmOpenChest called on non-GM client; ignoring.", {
        sceneId, tileId, requesterId, localUserId: game.user?.id ?? null
      });
      return;
    }

    if (!isPrimaryActiveGM()) {
      warn("gmOpenChest called on secondary GM; ignoring.", {
        sceneId,
        tileId,
        requesterId,
        localUserId: game.user?.id ?? null,
        primaryGmUserId: getPrimaryActiveGM()?.id ?? null
      });
      return;
    }

    log("GM open request received:", {
      sceneId,
      tileId,
      requesterId,
      localUserId: game.user?.id ?? null,
      primaryGmUserId: getPrimaryActiveGM()?.id ?? null
    });

    const scene = game.scenes?.get(sceneId);
    if (!scene) return warn("GM open: scene not found:", sceneId);

    const tileDoc = scene.tiles?.get(tileId);
    if (!tileDoc) return warn("GM open: tile not found:", tileId);

    if (tileDoc.hidden) {
      warn("GM open: tile is hidden → ignore.", { tileId });
      return;
    }

    const data = readTreasureData(tileDoc);
    log("GM open: read treasure data:", data);

    if (!data.isTreasure) return warn("GM open: not a treasure tile, abort.");

    const ITC = window["oni.ItemTransferCore"];
    if (!ITC?.transfer) {
      ui.notifications?.error?.('ItemTransferCore missing: window["oni.ItemTransferCore"].transfer');
      return;
    }

    const hasItem = !!data.itemUuid;
    const hasZenit = (data.zenit > 0);

    if (!hasItem && !hasZenit) {
      ui.notifications?.warn?.("This chest has no reward configured.");
      return;
    }

    const db = await resolveDbActor();
    if (!db) return;

    // ITEM priority
    if (hasItem) {
      const qty = Math.max(1, data.quantity || 1);

      let srcItem = null;
      try { srcItem = await fromUuid(data.itemUuid); } catch {}
      const srcName = srcItem?.name ?? data.itemName ?? "Unknown Item";
      const srcImg  = srcItem?.img  ?? data.itemImg  ?? "";

      log("GM open: awarding item via ITC.transfer", { receiverActorUuid: db.uuid, itemUuid: data.itemUuid, qty });

      let receiverItemUuid = null;
      try {
        const result = await ITC.transfer({
          mode: "gmToActor",
          itemUuid: data.itemUuid,
          quantity: qty,
          receiverActorUuid: db.uuid,
          requestedByUserId: requesterId ?? game.user.id,
          showTransferCard: false
        });
        receiverItemUuid = result?.receiverItemUuid || result?.receiver?.itemUuid || null;
        log("GM open: ITC.transfer result:", result);
      } catch (e) {
        err("GM open: ITC.transfer failed:", e);
        ui.notifications?.error?.("Treasure open failed: item transfer error (see console).");
        return;
      }

      try {
        await tileDoc.update({ hidden: true });
        log("GM open: tile hidden after open.", { tileId, sceneId });
      } catch (e) {
        warn("GM open: failed to hide tile:", e);
      }

      playPickupSfx();

      await postObtainCard_Item({
        iconImg: srcImg,
        qty,
        name: srcName,
        linkUuid: receiverItemUuid || data.itemUuid
      });

      for (const ch of CHANNELS) {
        try { game.socket.emit(ch, { type: MSG_OPEN_DONE, payload: { sceneId, tileId } }); } catch {}
      }
      return;
    }

    // ZENIT only
    if (hasZenit) {
      const amount = Math.max(0, data.zenit || 0);
      log("GM open: awarding zenit", { actorUuid: db.uuid, delta: amount });

      try {
        if (typeof ITC.adjustZenit === "function") {
          await ITC.adjustZenit({ actorUuid: db.uuid, delta: amount, requestedByUserId: requesterId ?? game.user.id });
        } else if (typeof ITC.adjustActorZenit === "function") {
          await ITC.adjustActorZenit({ actorUuid: db.uuid, delta: amount, requestedByUserId: requesterId ?? game.user.id });
        } else {
          throw new Error("No adjustZenit/adjustActorZenit found on ItemTransferCore.");
        }
      } catch (e) {
        err("GM open: zenit adjust failed:", e);
        ui.notifications?.error?.("Treasure open failed: zenit update error (see console).");
        return;
      }

      try {
        await tileDoc.update({ hidden: true });
        log("GM open: tile hidden after open.", { tileId, sceneId });
      } catch (e) {
        warn("GM open: failed to hide tile:", e);
      }

      playPickupSfx();
      await postObtainCard_Zenit({ amount });

      for (const ch of CHANNELS) {
        try { game.socket.emit(ch, { type: MSG_OPEN_DONE, payload: { sceneId, tileId } }); } catch {}
      }
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

        const tiles = canvas.tiles?.placeables ?? [];
        const desired = new Set();
        const RANGE_PX = getRangePx();

        for (const t of tiles) {
          const td = readTreasureData(t);
          if (!td.isTreasure) continue;
          if (td.isHidden) continue;

          const tc = getTileCenter(t);
          const d = dist(partyCenter, tc);
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

        log("requestOpen called:", {
          tileId,
          sceneId,
          user: game.user.id,
          isGM: game.user.isGM,
          primaryGmUserId: getPrimaryActiveGM()?.id ?? null,
          isPrimaryActiveGM: isPrimaryActiveGM()
        });

        // Primary GM opens directly.
        if (game.user.isGM && isPrimaryActiveGM()) {
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
            log("Socket RX:", msg);

            if (!game.user.isGM) return;
            if (!isPrimaryActiveGM()) {
              log("Ignoring chest open request on secondary GM.", {
                localUserId: game.user?.id ?? null,
                primaryGmUserId: getPrimaryActiveGM()?.id ?? null,
                payload: msg.payload
              });
              return;
            }

            await gmOpenChest(msg.payload);
            this._queueScan("after-socket-open");
          }

          if (msg.type === MSG_OPEN_DONE) {
            log("Socket RX:", msg);
            this._queueScan("after-open-done");
          }
        } catch (e) {
          err("socket handler error:", e);
        }
      };

      for (const ch of CHANNELS) {
        try {
          game.socket.on(ch, this._socketFn);
          log("Socket listener installed on:", ch);
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
      const onCanvasPan   = () => this.ui?.repositionAll();
      const onCanvasReady = () => this._queueScan("canvasReady");
      const onResize      = () => this.ui?.repositionAll();

      Hooks.on("updateToken", onUpdateToken);
      Hooks.on("createToken", onCreateToken);
      Hooks.on("deleteToken", onDeleteToken);
      Hooks.on("updateTile", onUpdateTile);
      Hooks.on("canvasPan", onCanvasPan);
      Hooks.on("canvasReady", onCanvasReady);
      window.addEventListener("resize", onResize);

      this._hooks.push(["updateToken", onUpdateToken]);
      this._hooks.push(["createToken", onCreateToken]);
      this._hooks.push(["deleteToken", onDeleteToken]);
      this._hooks.push(["updateTile", onUpdateTile]);
      this._hooks.push(["canvasPan", onCanvasPan]);
      this._hooks.push(["canvasReady", onCanvasReady]);
      this._hooks.push(["resize", onResize]);

      this.running = true;

      await this.scan("start");
      log("Treasure Chest system started.", {
        RANGE_PX: getRangePx(),
        POS_OVERRIDE_TTL_MS,
        localUserId: game.user?.id ?? null,
        isGM: !!game.user?.isGM,
        primaryGmUserId: getPrimaryActiveGM()?.id ?? null,
        isPrimaryActiveGM: isPrimaryActiveGM()
      });
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

      this._posOverrides.clear();
      this._scanQueued = false;

      this.ui?.stop();
      this.ui = null;

      this.running = false;
      log("Treasure Chest system stopped.");
    }
  };

  // Publish API
  window.oni.TreasureChest[CORE_KEY] = core;

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