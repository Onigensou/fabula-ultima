// scripts/shop-open/shopopen-ui.js
import { SHOPOPEN, gp } from "./shopopen-const.js";

export class ShopOpenUI {
  constructor(cfg = {}) {
    this.cfg = {
      DEBUG: true,

      LAYER_ID: "fu-shopopen-layer-v1",
      STYLE_ID: "fu-shopopen-style-v1",
      LAYER_Z_INDEX: 90,

      ICON_OFFSET_X: 0,
      ICON_OFFSET_Y: 56,

      USE_ACTOR_OFFSETS: true,
      ANIM_IN_MS: SHOPOPEN.ANIM_IN_MS,
      ANIM_OUT_MS: SHOPOPEN.ANIM_OUT_MS,

      ...cfg,
    };

    this._layer = null;
    this._btnByTokenId = new Map(); // tokenId -> { el, state, hideTimer }
    this._desired = new Set();

    // Provided by bootstrap/backend:
    this.onClickShopToken = null; // (tokenId) => void
  }

  log(...a) { if (this.cfg.DEBUG) console.log(SHOPOPEN.TAG, ...a); }
  warn(...a) { console.warn(SHOPOPEN.TAG, ...a); }
  err(...a) { console.error(SHOPOPEN.TAG, ...a); }

  ensureLayer() {
    if (this._layer && document.getElementById(this.cfg.LAYER_ID)) return this._layer;

    let layer = document.getElementById(this.cfg.LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = this.cfg.LAYER_ID;
      layer.style.position = "fixed";
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.width = "100vw";
      layer.style.height = "100vh";
      layer.style.pointerEvents = "none";
      layer.style.zIndex = String(this.cfg.LAYER_Z_INDEX);
      document.body.appendChild(layer);
      this.log("UI layer created:", this.cfg.LAYER_ID, "zIndex=", this.cfg.LAYER_Z_INDEX);
    }

    if (!document.getElementById(this.cfg.STYLE_ID)) {
      const style = document.createElement("style");
      style.id = this.cfg.STYLE_ID;
      style.textContent = `
        #${this.cfg.LAYER_ID} .fu-shop-btn {
          pointer-events: auto;
          position: absolute;
          transform: translate(-50%, -50%) scale(0.75);
          opacity: 0;
          transition:
            transform ${this.cfg.ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1),
            opacity ${this.cfg.ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: 999px;
          background: rgba(20, 20, 20, 0.78);
          border: 1px solid rgba(255, 255, 255, 0.25);
          box-shadow: 0 6px 18px rgba(0,0,0,0.35);
          cursor: pointer;
          user-select: none;
          font-size: 18px;
        }
        #${this.cfg.LAYER_ID} .fu-shop-btn.is-visible {
          transform: translate(-50%, -50%) scale(1);
          opacity: 1;
        }
        #${this.cfg.LAYER_ID} .fu-shop-btn.is-hiding {
          transform: translate(-50%, -50%) scale(0.75);
          opacity: 0;
          transition:
            transform ${this.cfg.ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1),
            opacity ${this.cfg.ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1);
        }
        #${this.cfg.LAYER_ID} .fu-shop-btn:hover {
          transform: translate(-50%, -50%) scale(1.08);
          background: rgba(30, 30, 30, 0.88);
        }
        #${this.cfg.LAYER_ID} .fu-shop-btn:active {
          transform: translate(-50%, -50%) scale(0.98);
        }
      `;
      document.head.appendChild(style);
      this.log("UI style injected:", this.cfg.STYLE_ID);
    }

    this._layer = layer;
    return layer;
  }

  destroy() {
    for (const [tokenId, rec] of this._btnByTokenId.entries()) {
      if (rec.hideTimer) clearTimeout(rec.hideTimer);
      rec.el?.remove();
    }
    this._btnByTokenId.clear();
    document.getElementById(this.cfg.LAYER_ID)?.remove();
    document.getElementById(this.cfg.STYLE_ID)?.remove();
    this._layer = null;
    this._desired = new Set();
    this.log("UI destroyed.");
  }

  // Backend calls this with the desired visible set.
  // Decoupling behavior:
  // - If a button is hiding and becomes desired again, cancel hide.
  // - If a button is currently visible and becomes undesired, animate out then remove.
  setDesiredVisible(tokenIdSet) {
    this.ensureLayer();
    this._desired = new Set(tokenIdSet);

    // Show/keep desired
    for (const tokenId of this._desired) {
      this._showToken(tokenId);
    }

    // Hide those not desired
    for (const tokenId of Array.from(this._btnByTokenId.keys())) {
      if (!this._desired.has(tokenId)) this._hideToken(tokenId);
    }

    // Position updates (do this once per apply)
    this.repositionAll();
  }

  _showToken(tokenId) {
    const layer = this.ensureLayer();
    const existing = this._btnByTokenId.get(tokenId);

    if (existing) {
      // Cancel hiding if needed
      if (existing.state === "hiding") {
        if (existing.hideTimer) clearTimeout(existing.hideTimer);
        existing.hideTimer = null;
        existing.state = "shown";
        existing.el.classList.remove("is-hiding");
        existing.el.classList.add("is-visible");
      }
      return;
    }

    // Create
    const el = document.createElement("div");
    el.className = "fu-shop-btn";
    el.title = "Open Shop";
    el.textContent = "🏷️";
    el.dataset.tokenId = tokenId;

    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        this.onClickShopToken?.(tokenId);
      } catch (e) {
        this.err("UI click handler error:", e);
      }
    });

    layer.appendChild(el);

    const rec = { el, state: "showing", hideTimer: null };
    this._btnByTokenId.set(tokenId, rec);

    // Animate in next frame
    requestAnimationFrame(() => {
      if (!this._btnByTokenId.has(tokenId)) return;
      el.classList.add("is-visible");
      rec.state = "shown";
    });
  }

  _hideToken(tokenId) {
    const rec = this._btnByTokenId.get(tokenId);
    if (!rec) return;

    // Already hiding? do nothing
    if (rec.state === "hiding") return;

    rec.state = "hiding";
    rec.el.classList.add("is-hiding");
    rec.el.classList.remove("is-visible");

    rec.hideTimer = setTimeout(() => {
      // If it became desired again during hide, don't remove.
      if (this._desired.has(tokenId)) {
        rec.el.classList.remove("is-hiding");
        rec.el.classList.add("is-visible");
        rec.state = "shown";
        rec.hideTimer = null;
        return;
      }
      rec.el.remove();
      this._btnByTokenId.delete(tokenId);
    }, this.cfg.ANIM_OUT_MS + 20);
  }

  // Position buttons based on token center and actor offsets (same behavior as macro)
  repositionAll() {
    try {
      for (const [tokenId, rec] of this._btnByTokenId.entries()) {
        const tok = canvas.tokens?.get(tokenId);
        if (!tok || !rec?.el) continue;
        this._placeElForToken(rec.el, tok);
      }
    } catch (e) {
      this.err("repositionAll error:", e);
    }
  }

  _placeElForToken(el, shopToken) {
    let ax = 0, ay = 0;
    if (this.cfg.USE_ACTOR_OFFSETS && shopToken.actor) {
      ax = Number(gp(shopToken.actor, "system.props.shop_icon_offset_x", 0)) || 0;
      ay = Number(gp(shopToken.actor, "system.props.shop_icon_offset_y", 0)) || 0;
    }

    // doc-based center (no PIXI lag)
    const baseX = shopToken.document?.x ?? shopToken.x ?? 0;
    const baseY = shopToken.document?.y ?? shopToken.y ?? 0;
    const cx = baseX + (shopToken.w / 2);
    const cy = baseY + (shopToken.h / 2);

    // canvas world -> screen
    const wt = canvas.app.stage.worldTransform;
    const screenX = (cx * wt.a) + wt.tx;
    const screenY = (cy * wt.d) + wt.ty;

    const finalX = screenX + this.cfg.ICON_OFFSET_X + ax;
    const finalY = screenY - (this.cfg.ICON_OFFSET_Y + ay);

    el.style.left = `${finalX}px`;
    el.style.top  = `${finalY}px`;
  }
}
