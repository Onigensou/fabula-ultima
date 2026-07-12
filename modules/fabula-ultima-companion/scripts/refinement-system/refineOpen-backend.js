// scripts/refinement-system/refineOpen-backend.js
import {
  REFINEOPEN, gp, normActorId, isBlacksmithActor, isTokenHidden, getCenterPx, distPxCenters,
} from "./refineOpen-const.js";
import { RefineWindowApp } from "./refineWindow-app.js";

export class RefineOpenBackend {
  constructor(cfg = {}) {
    this.cfg = {
      DEBUG:              false,
      RANGE_PX:           140,
      POS_OVERRIDE_TTL_MS: 800,
      DB_CACHE_MS:        3000,
      ...cfg,
    };

    this._installed            = false;
    this._cachedPartyActorIds  = new Set();
    this._lastDbResolveTs      = 0;
    this._posOverrides         = new Map();
    this._desiredVisible       = new Set();
    this._scanQueued           = false;

    // UI adapter hook
    this.uiSetDesiredVisible = null;

    this._onUpdateToken  = this._onUpdateToken.bind(this);
    this._onCreateToken  = this._onCreateToken.bind(this);
    this._onDeleteToken  = this._onDeleteToken.bind(this);
    this._onUpdateActor  = this._onUpdateActor.bind(this);
    this._onCanvasReady  = this._onCanvasReady.bind(this);
  }

  log(...a) { if (this.cfg.DEBUG) console.log(REFINEOPEN.TAG, ...a); }

  async start() {
    if (this._installed) return;
    if (!canvas?.ready) return;
    if (!window.FUCompanion?.api?.getCurrentGameDb) {
      console.warn(REFINEOPEN.TAG, "DB_Resolver API missing.");
      return;
    }

    Hooks.on("updateToken",  this._onUpdateToken);
    Hooks.on("createToken",  this._onCreateToken);
    Hooks.on("deleteToken",  this._onDeleteToken);
    Hooks.on("updateActor",  this._onUpdateActor);
    Hooks.on("canvasReady",  this._onCanvasReady);

    await this._resolvePartyActorIds(true);
    await this._scan("start");

    this._installed = true;
    this.log("Backend started.", { RANGE_PX: this.cfg.RANGE_PX });
  }

  stop() {
    if (!this._installed) return;
    try { Hooks.off("updateToken",  this._onUpdateToken); } catch {}
    try { Hooks.off("createToken",  this._onCreateToken); } catch {}
    try { Hooks.off("deleteToken",  this._onDeleteToken); } catch {}
    try { Hooks.off("updateActor",  this._onUpdateActor); } catch {}
    try { Hooks.off("canvasReady",  this._onCanvasReady); } catch {}
    this._desiredVisible.clear();
    this.uiSetDesiredVisible?.(new Set());
    this._installed = false;
  }

  // ── Public: UI calls this when the player clicks the ⚒️ button ──
  openBlacksmithByTokenId(tokenId) {
    try {
      const tok = canvas.tokens?.get(tokenId);
      if (!tok?.actor || !isBlacksmithActor(tok.actor)) return;
      RefineWindowApp.open(tok.actor.uuid);
    } catch (e) { console.error(REFINEOPEN.TAG, "openBlacksmithByTokenId:", e); }
  }

  // ── Party resolution (mirrors shop backend) ──
  async _resolvePartyActorIds(force = false) {
    if (!force && this._cachedPartyActorIds.size > 0
        && (Date.now() - this._lastDbResolveTs) < this.cfg.DB_CACHE_MS) {
      return this._cachedPartyActorIds;
    }

    const cache = await window.FUCompanion.api.getCurrentGameDb();
    const db    = cache?.db ?? null;
    const source = cache?.source ?? db;

    if (!db) {
      this._cachedPartyActorIds = new Set();
      this._lastDbResolveTs    = Date.now();
      return this._cachedPartyActorIds;
    }

    const ids = new Set();
    if (db?.id) ids.add(db.id);

    const props = gp(source, "system.props", {}) || {};
    for (const [k, v] of Object.entries(props)) {
      if (!k.startsWith("member_id_")) continue;
      const id = normActorId(v);
      if (id) ids.add(id);
    }
    for (const [k, v] of Object.entries(props)) {
      const kl = k.toLowerCase();
      if (!kl.includes("member") || k.startsWith("member_id_")) continue;
      if (typeof v === "string") { const id = normActorId(v); if (id) ids.add(id); }
      else if (Array.isArray(v)) { for (const x of v) { const id = normActorId(x); if (id) ids.add(id); } }
    }

    this._cachedPartyActorIds = ids;
    this._lastDbResolveTs    = Date.now();
    return ids;
  }

  // ── Proximity scan ──
  _queueScan(reason = "") {
    if (this._scanQueued) return;
    this._scanQueued = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      this._scanQueued = false;
      await this._scan(reason);
    }));
  }

  async _scan(reason = "") {
    try {
      if (!canvas?.ready) return;

      const now = Date.now();
      for (const [tid, o] of this._posOverrides) {
        if (now - o.ts > this.cfg.POS_OVERRIDE_TTL_MS) this._posOverrides.delete(tid);
      }

      const partyIds      = await this._resolvePartyActorIds(false);
      const tokens        = canvas.tokens?.placeables ?? [];
      const smithTokens   = tokens.filter(t => t?.actor && !isTokenHidden(t) && isBlacksmithActor(t.actor));
      const partyTokens   = tokens.filter(t => t?.actor && !isTokenHidden(t) && partyIds.has(t.actor.id));

      if (!partyTokens.length) { this._emit(new Set()); return; }

      const pCenters = new Map(partyTokens.map(t => {
        const ov = this._posOverrides.get(t.id);
        return [t.id, getCenterPx(t, ov ?? null)];
      }));
      const sCenters = new Map(smithTokens.map(t => {
        const ov = this._posOverrides.get(t.id);
        return [t.id, getCenterPx(t, ov ?? null)];
      }));

      const show = new Set();
      for (const st of smithTokens) {
        const sc = sCenters.get(st.id);
        for (const pt of partyTokens) {
          if (distPxCenters(sc, pCenters.get(pt.id)) <= this.cfg.RANGE_PX) {
            show.add(st.id); break;
          }
        }
      }
      this._emit(show);
    } catch (e) { console.error(REFINEOPEN.TAG, "_scan:", e); }
  }

  _emit(set) {
    const same = set.size === this._desiredVisible.size
      && [...set].every(id => this._desiredVisible.has(id));
    if (same) return;
    this._desiredVisible = new Set(set);
    this.uiSetDesiredVisible?.(this._desiredVisible);
  }

  // ── Hooks ──
  async _onUpdateToken(tokenDoc, changes) {
    const moved      = ("x" in changes) || ("y" in changes);
    const hidToggled = ("hidden" in changes);
    if (!moved && !hidToggled) return;

    if (moved) {
      const afterX = "x" in changes ? changes.x : tokenDoc.x;
      const afterY = "y" in changes ? changes.y : tokenDoc.y;
      this._posOverrides.set(tokenDoc.id, { x: afterX, y: afterY, ts: Date.now() });
    }

    const actor   = tokenDoc.object?.actor ?? game.actors?.get(tokenDoc.actorId);
    if (!actor) return;
    const partyIds = await this._resolvePartyActorIds(false);
    if (partyIds.has(actor.id) || isBlacksmithActor(actor)) {
      this._queueScan(hidToggled ? "hidden" : "move");
    }
  }

  _onCreateToken() { this._queueScan("create"); }
  _onDeleteToken() { this._queueScan("delete"); }

  _onUpdateActor(actor, changes) {
    if (gp(changes, "system.props.isBlacksmith", undefined) !== undefined)
      this._queueScan("actorUpdate");
  }

  _onCanvasReady() { this._queueScan("canvasReady"); }
}
