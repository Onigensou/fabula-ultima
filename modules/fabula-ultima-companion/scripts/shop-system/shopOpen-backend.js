// scripts/shop-open/shopopen-backend.js
import {
  SHOPOPEN,
  gp,
  normActorId,
  isShopActor,
  ownershipObserver,
  ownershipNone,
  getCenterPx,
  distPxCenters
} from "./shopopen-const.js";

export class ShopOpenBackend {
  constructor(cfg = {}) {
    this.cfg = {
      DEBUG: true,
      RANGE_PX: 140,
      POS_OVERRIDE_TTL_MS: 800,

      // DB caching
      DB_CACHE_MS: 3000,

      // Ownership behavior: on close -> NONE
      FORCE_CLOSE_TO_NONE: true,

      ...cfg,
    };

    this._installed = false;

    // UI adapter hook: setDesiredVisible(Set<tokenId>)
    this.uiSetDesiredVisible = null;

    // click handler callable by UI: open shop for this tokenId
    this.openShopByTokenId = this.openShopByTokenId.bind(this);

    // internal
    this._cachedPartyActorIds = new Set();
    this._lastDbResolveTs = 0;

    // tokenId -> {x,y,ts}
    this._posOverrides = new Map();

    this._scanQueued = false;
    this._desiredVisible = new Set();

    // track opened sessions (client side) for close hook
    this._openedByActorUuidLocal = new Set();

    // GM-side tracking so close only nukes those we opened
    this._gmOpenedByActorUuid = new Map(); // actorUuid -> Set<requesterId>

    // bound handlers
    this._onUpdateToken = this._onUpdateToken.bind(this);
    this._onCreateToken = this._onCreateToken.bind(this);
    this._onDeleteToken = this._onDeleteToken.bind(this);
    this._onUpdateActor = this._onUpdateActor.bind(this);
    this._onCanvasPan = this._onCanvasPan.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onCloseActorSheet = this._onCloseActorSheet.bind(this);
    this._onSocket = this._onSocket.bind(this);
    this._onCanvasReady = this._onCanvasReady.bind(this);
  }

  log(...a) { if (this.cfg.DEBUG) console.log(SHOPOPEN.TAG, ...a); }
  warn(...a) { console.warn(SHOPOPEN.TAG, ...a); }
  err(...a) { console.error(SHOPOPEN.TAG, ...a); }

  async start() {
    if (this._installed) return;
    if (!canvas?.ready) return;

    // Ensure DB_Resolver exists (your module already has it)
    if (!window.FUCompanion?.api?.getCurrentGameDb) {
      this.warn("DB_Resolver API missing: window.FUCompanion.api.getCurrentGameDb()");
      return;
    }

    // Install sockets
    for (const ch of SHOPOPEN.CHANNELS) {
      try {
        game.socket.on(ch, this._onSocket);
        this.log("Socket listener installed on:", ch);
      } catch (e) {
        this.warn("Socket listener failed on:", ch, e);
      }
    }

    // Install hooks
    Hooks.on("updateToken", this._onUpdateToken);
    Hooks.on("createToken", this._onCreateToken);
    Hooks.on("deleteToken", this._onDeleteToken);
    Hooks.on("updateActor", this._onUpdateActor);
    Hooks.on("canvasPan", this._onCanvasPan);
    Hooks.on("closeActorSheet", this._onCloseActorSheet);
    Hooks.on("canvasReady", this._onCanvasReady);
    window.addEventListener("resize", this._onResize);

    // Initial scan
    await this._resolvePartyActorIds(true);
    await this._scan("start");

    this._installed = true;
    this.log("Backend started.", { RANGE_PX: this.cfg.RANGE_PX });
  }

  async stop() {
    if (!this._installed) return;

    for (const ch of SHOPOPEN.CHANNELS) {
      try { game.socket.off(ch, this._onSocket); } catch {}
    }

    try { Hooks.off("updateToken", this._onUpdateToken); } catch {}
    try { Hooks.off("createToken", this._onCreateToken); } catch {}
    try { Hooks.off("deleteToken", this._onDeleteToken); } catch {}
    try { Hooks.off("updateActor", this._onUpdateActor); } catch {}
    try { Hooks.off("canvasPan", this._onCanvasPan); } catch {}
    try { Hooks.off("closeActorSheet", this._onCloseActorSheet); } catch {}
    try { Hooks.off("canvasReady", this._onCanvasReady); } catch {}
    try { window.removeEventListener("resize", this._onResize); } catch {}

    this._posOverrides.clear();
    this._desiredVisible.clear();

    // tell UI hide all
    this._emitDesired(new Set());

    this._installed = false;
    this.log("Backend stopped.");
  }

  // ──────────────────────────────────────────────────────────────
  // UI -> Backend entrypoint
  // ──────────────────────────────────────────────────────────────
  async openShopByTokenId(shopTokenId) {
    try {
      const tok = canvas.tokens?.get(shopTokenId);
      if (!tok?.actor) return;
      if (!isShopActor(tok.actor)) return;
      await this._requestOpenShop(tok.actor.uuid);
    } catch (e) {
      this.err("openShopByTokenId failed:", e);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // DB Party resolve (same logic as macro)
  // ──────────────────────────────────────────────────────────────
  async _resolvePartyActorIds(force = false) {
    if (!force && this._cachedPartyActorIds.size > 0 && (Date.now() - this._lastDbResolveTs) < this.cfg.DB_CACHE_MS) {
      return this._cachedPartyActorIds;
    }

    const cache = await window.FUCompanion.api.getCurrentGameDb();
    const db = cache?.db ?? null;
    const source = cache?.source ?? db;

    if (!db) {
      this.warn("DB cache returned no db:", cache);
      this._cachedPartyActorIds = new Set();
      this._lastDbResolveTs = Date.now();
      return this._cachedPartyActorIds;
    }

    const partyActorIds = new Set();
    if (db?.id) partyActorIds.add(db.id);

    const props = gp(source, "system.props", {}) || {};

    for (const [k, v] of Object.entries(props)) {
      if (!k.startsWith("member_id_")) continue;
      const id = normActorId(v);
      if (id) partyActorIds.add(id);
    }

    for (const [k, v] of Object.entries(props)) {
      const kLower = k.toLowerCase();
      if (!kLower.includes("member")) continue;
      if (k.startsWith("member_id_")) continue;

      if (typeof v === "string") {
        const id = normActorId(v);
        if (id) partyActorIds.add(id);
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const id = normActorId(v[i]);
          if (id) partyActorIds.add(id);
        }
      }
    }

    this._cachedPartyActorIds = partyActorIds;
    this._lastDbResolveTs = Date.now();
    return partyActorIds;
  }

  // ──────────────────────────────────────────────────────────────
  // Proximity scan (doc-based + overrides)
  // ──────────────────────────────────────────────────────────────
  _setOverride(tokenId, x, y) {
    this._posOverrides.set(tokenId, { x, y, ts: Date.now() });
  }

  _getOverride(tokenId) {
    const o = this._posOverrides.get(tokenId);
    if (!o) return null;
    if ((Date.now() - o.ts) > this.cfg.POS_OVERRIDE_TTL_MS) {
      this._posOverrides.delete(tokenId);
      return null;
    }
    return o;
  }

  _cleanupOverrides() {
    const now = Date.now();
    for (const [tid, o] of this._posOverrides.entries()) {
      if ((now - o.ts) > this.cfg.POS_OVERRIDE_TTL_MS) this._posOverrides.delete(tid);
    }
  }

  _queueScan(reason = "unknown") {
    if (this._scanQueued) return;
    this._scanQueued = true;

    // Defer to let Foundry apply doc changes; scan uses doc coords anyway
    requestAnimationFrame(() => {
      requestAnimationFrame(async () => {
        this._scanQueued = false;
        await this._scan(reason);
      });
    });
  }

  async _scan(reason = "scan") {
    try {
      if (!canvas?.ready) return;

      this._cleanupOverrides();

      const partyIds = await this._resolvePartyActorIds(false);
      const tokens = canvas.tokens?.placeables ?? [];

      const shopTokens = tokens.filter(t => t?.actor && isShopActor(t.actor));
      const partyTokens = tokens.filter(t => t?.actor && partyIds.has(t.actor.id));

      if (partyTokens.length === 0) {
        this._emitDesired(new Set());
        return;
      }

      const partyCenters = new Map();
      for (const t of partyTokens) {
        const ov = this._getOverride(t.id);
        partyCenters.set(t.id, getCenterPx(t, ov ? { x: ov.x, y: ov.y } : null));
      }

      const shopCenters = new Map();
      for (const t of shopTokens) {
        const ov = this._getOverride(t.id);
        shopCenters.set(t.id, getCenterPx(t, ov ? { x: ov.x, y: ov.y } : null));
      }

      const shouldShow = new Set();

      for (const shopT of shopTokens) {
        const sc = shopCenters.get(shopT.id);
        for (const partyT of partyTokens) {
          const pc = partyCenters.get(partyT.id);
          const d = distPxCenters(sc, pc);
          if (d <= this.cfg.RANGE_PX) {
            shouldShow.add(shopT.id);
            break;
          }
        }
      }

      this._emitDesired(shouldShow);
    } catch (e) {
      this.err("_scan error:", e);
    }
  }

  _emitDesired(set) {
    // Only update UI if changed (prevents pointless UI calls)
    const same =
      set.size === this._desiredVisible.size &&
      Array.from(set).every(id => this._desiredVisible.has(id));

    if (same) return;

    this._desiredVisible = new Set(set);
    this.uiSetDesiredVisible?.(this._desiredVisible);
  }

  // ──────────────────────────────────────────────────────────────
  // Hooks
  // ──────────────────────────────────────────────────────────────
  async _onUpdateToken(tokenDoc, changes) {
    const moved = ("x" in changes) || ("y" in changes);
    if (!moved) return;

    const afterX = ("x" in changes) ? changes.x : tokenDoc.x;
    const afterY = ("y" in changes) ? changes.y : tokenDoc.y;
    this._setOverride(tokenDoc.id, afterX, afterY);

    // Relevance filter (party or shop moved)
    const placeable = tokenDoc.object;
    const actor = placeable?.actor ?? game.actors?.get(tokenDoc.actorId);
    if (!actor) return;

    const partyIds = await this._resolvePartyActorIds(false);
    const isParty = partyIds.has(actor.id);
    const isShop = isShopActor(actor);
    if (!(isParty || isShop)) return;

    this._queueScan("updateToken(move)");
  }

  _onCreateToken() { this._queueScan("createToken"); }
  _onDeleteToken() { this._queueScan("deleteToken"); }

  _onUpdateActor(actor, changes) {
    const touched =
      gp(changes, "system.props.shop_icon_offset_x", undefined) !== undefined ||
      gp(changes, "system.props.shop_icon_offset_y", undefined) !== undefined ||
      gp(changes, "system.props.isShop", undefined) !== undefined;

    if (touched) this._queueScan("updateActor(shop props)");
  }

  _onCanvasPan() {
    // UI handles reposition; backend does not touch UI directly beyond desired-set.
    // Bootstrap wires canvasPan to ui.repositionAll().
  }

  _onResize() {
    // Bootstrap wires resize to ui.repositionAll().
  }

  _onCanvasReady() {
    this._queueScan("canvasReady");
  }

  // ──────────────────────────────────────────────────────────────
  // Ownership + sockets
  // ──────────────────────────────────────────────────────────────
  _emitSocket(msg) {
    for (const ch of SHOPOPEN.CHANNELS) {
      try { game.socket.emit(ch, msg); } catch {}
    }
  }

  async _requestOpenShop(actorUuid) {
    const requesterId = game.user.id;

    if (game.user.isGM) {
      await this._gmHandleOpenRequest({ actorUuid, requesterId });
      return;
    }

    this._emitSocket({ type: SHOPOPEN.MSG.OPEN_REQ, payload: { actorUuid, requesterId } });
  }

  _requestCloseShop(actorUuid) {
    const requesterId = game.user.id;

    if (game.user.isGM) {
      this._gmHandleCloseRequest({ actorUuid, requesterId }).catch(e => this.err("_gmHandleCloseRequest failed:", e));
      return;
    }

    this._emitSocket({ type: SHOPOPEN.MSG.CLOSE_REQ, payload: { actorUuid, requesterId } });
  }

  async _gmHandleOpenRequest({ actorUuid, requesterId }) {
    const actor = await fromUuid(actorUuid);
    if (!actor || !isShopActor(actor)) return;

    const obs = ownershipObserver();

    // Track opened session
    const perActor = this._gmOpenedByActorUuid.get(actorUuid) ?? new Set();
    perActor.add(requesterId);
    this._gmOpenedByActorUuid.set(actorUuid, perActor);

    await actor.update({ ownership: { [requesterId]: obs } });
    this._emitSocket({ type: SHOPOPEN.MSG.OPEN_GRANT, payload: { actorUuid, requesterId } });
  }

  async _gmHandleCloseRequest({ actorUuid, requesterId }) {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;

    const perActor = this._gmOpenedByActorUuid.get(actorUuid);
    const wasOpened = perActor?.has(requesterId);
    if (!wasOpened) return;

    const none = ownershipNone();
    await actor.update({ ownership: { [requesterId]: none } });

    perActor.delete(requesterId);
    if (perActor.size === 0) this._gmOpenedByActorUuid.delete(actorUuid);
  }

  _onSocket(msg) {
    try {
      if (!msg?.type) return;

      if (game.user.isGM && msg.type === SHOPOPEN.MSG.OPEN_REQ) {
        const { actorUuid, requesterId } = msg.payload ?? {};
        this._gmHandleOpenRequest({ actorUuid, requesterId }).catch(e => this.err("_gmHandleOpenRequest failed:", e));
        return;
      }

      if (game.user.isGM && msg.type === SHOPOPEN.MSG.CLOSE_REQ) {
        const { actorUuid, requesterId } = msg.payload ?? {};
        this._gmHandleCloseRequest({ actorUuid, requesterId }).catch(e => this.err("_gmHandleCloseRequest failed:", e));
        return;
      }

      if (msg.type === SHOPOPEN.MSG.OPEN_GRANT) {
        const { actorUuid, requesterId } = msg.payload ?? {};
        if (requesterId !== game.user.id) return;

        fromUuid(actorUuid).then(actor => {
          if (!actor) return;
          this._openedByActorUuidLocal.add(actorUuid);
          actor.sheet?.render(true, { focus: true });
        }).catch(e => this.err("OPEN_GRANT fromUuid failed:", e));
      }
    } catch (e) {
      this.err("Socket handler error:", e);
    }
  }

  _onCloseActorSheet(app) {
    try {
      const actor = app?.object;
      if (!actor || !isShopActor(actor)) return;

      const actorUuid = actor.uuid;
      if (!this._openedByActorUuidLocal.has(actorUuid)) return;

      this._openedByActorUuidLocal.delete(actorUuid);
      this._requestCloseShop(actorUuid);
    } catch (e) {
      this.err("closeActorSheet error:", e);
    }
  }
}
