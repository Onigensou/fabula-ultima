// scripts/refinement-system/refineOpen-ui.js
import { REFINEOPEN, gp } from "./refineOpen-const.js";

// Default horizontal offset puts this button to the right of the shop button (which sits at x+0).
// Both sit at the same Y so they appear side-by-side when an NPC is both shop + blacksmith.
const DEFAULT_OFFSET_X = 44;
const DEFAULT_OFFSET_Y = 56;

export class RefineOpenUI {
  constructor(cfg = {}) {
    this.cfg = {
      DEBUG: false,
      LAYER_ID:      "fu-refineopen-layer-v1",
      STYLE_ID:      "fu-refineopen-style-v1",
      LAYER_Z_INDEX: 90,
      ICON_OFFSET_X: DEFAULT_OFFSET_X,
      ICON_OFFSET_Y: DEFAULT_OFFSET_Y,
      ANIM_IN_MS:  REFINEOPEN.ANIM_IN_MS,
      ANIM_OUT_MS: REFINEOPEN.ANIM_OUT_MS,
      ...cfg,
    };

    this._layer        = null;
    this._btnByTokenId = new Map();
    this._desired      = new Set();

    // Provided by bootstrap:
    this.onClickBlacksmithToken = null; // (tokenId) => void
  }

  log(...a) { if (this.cfg.DEBUG) console.log(REFINEOPEN.TAG, ...a); }

  ensureLayer() {
    if (this._layer && document.getElementById(this.cfg.LAYER_ID)) return this._layer;

    let layer = document.getElementById(this.cfg.LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = this.cfg.LAYER_ID;
      Object.assign(layer.style, {
        position: "fixed", left: "0", top: "0",
        width: "100vw", height: "100vh",
        pointerEvents: "none", zIndex: String(this.cfg.LAYER_Z_INDEX),
      });
      document.body.appendChild(layer);
    }

    if (!document.getElementById(this.cfg.STYLE_ID)) {
      const s = document.createElement("style");
      s.id = this.cfg.STYLE_ID;
      s.textContent = `
        #${this.cfg.LAYER_ID} .fu-refine-prox-btn {
          pointer-events: auto; position: absolute;
          transform: translate(-50%, -50%) scale(0.75); opacity: 0;
          transition:
            transform ${this.cfg.ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1),
            opacity   ${this.cfg.ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1);
          display: inline-flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; border-radius: 999px;
          background: rgba(20,20,20,0.78); border: 1px solid rgba(255,200,100,0.4);
          box-shadow: 0 6px 18px rgba(0,0,0,0.35);
          cursor: pointer; user-select: none; font-size: 18px;
        }
        #${this.cfg.LAYER_ID} .fu-refine-prox-btn.is-visible {
          transform: translate(-50%, -50%) scale(1); opacity: 1;
        }
        #${this.cfg.LAYER_ID} .fu-refine-prox-btn.is-hiding {
          transform: translate(-50%, -50%) scale(0.75); opacity: 0;
          transition:
            transform ${this.cfg.ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1),
            opacity   ${this.cfg.ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1);
        }
        #${this.cfg.LAYER_ID} .fu-refine-prox-btn:hover {
          transform: translate(-50%, -50%) scale(1.08);
          background: rgba(40,30,10,0.88);
        }
        #${this.cfg.LAYER_ID} .fu-refine-prox-btn:active {
          transform: translate(-50%, -50%) scale(0.98);
        }
      `;
      document.head.appendChild(s);
    }

    this._layer = layer;
    return layer;
  }

  destroy() {
    for (const [, rec] of this._btnByTokenId) {
      if (rec.hideTimer) clearTimeout(rec.hideTimer);
      rec.el?.remove();
    }
    this._btnByTokenId.clear();
    document.getElementById(this.cfg.LAYER_ID)?.remove();
    document.getElementById(this.cfg.STYLE_ID)?.remove();
    this._layer  = null;
    this._desired = new Set();
  }

  setDesiredVisible(tokenIdSet) {
    this.ensureLayer();
    this._desired = new Set(tokenIdSet);
    for (const id of this._desired) this._showToken(id);
    for (const id of this._btnByTokenId.keys()) {
      if (!this._desired.has(id)) this._hideToken(id);
    }
    this.repositionAll();
  }

  _showToken(tokenId) {
    const layer    = this.ensureLayer();
    const existing = this._btnByTokenId.get(tokenId);

    if (existing) {
      if (existing.state === "hiding") {
        clearTimeout(existing.hideTimer);
        existing.hideTimer = null;
        existing.state = "shown";
        existing.el.classList.remove("is-hiding");
        existing.el.classList.add("is-visible");
      }
      return;
    }

    const el = document.createElement("div");
    el.className = "fu-refine-prox-btn";
    el.title     = "Refine Equipment";
    el.textContent = "⚒️";
    el.dataset.tokenId = tokenId;
    el.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try { this.onClickBlacksmithToken?.(tokenId); } catch (e) { console.error(REFINEOPEN.TAG, e); }
    });
    layer.appendChild(el);

    const rec = { el, state: "showing", hideTimer: null };
    this._btnByTokenId.set(tokenId, rec);
    requestAnimationFrame(() => {
      if (!this._btnByTokenId.has(tokenId)) return;
      el.classList.add("is-visible");
      rec.state = "shown";
    });
  }

  _hideToken(tokenId) {
    const rec = this._btnByTokenId.get(tokenId);
    if (!rec || rec.state === "hiding") return;
    rec.state = "hiding";
    rec.el.classList.add("is-hiding");
    rec.el.classList.remove("is-visible");
    rec.hideTimer = setTimeout(() => {
      if (this._desired.has(tokenId)) {
        rec.el.classList.remove("is-hiding");
        rec.el.classList.add("is-visible");
        rec.state    = "shown";
        rec.hideTimer = null;
        return;
      }
      rec.el.remove();
      this._btnByTokenId.delete(tokenId);
    }, this.cfg.ANIM_OUT_MS + 20);
  }

  repositionAll() {
    try {
      for (const [tokenId, rec] of this._btnByTokenId) {
        const tok = canvas.tokens?.get(tokenId);
        if (!tok || !rec?.el) continue;
        this._placeElForToken(rec.el, tok);
      }
    } catch (e) { console.error(REFINEOPEN.TAG, "repositionAll:", e); }
  }

  _placeElForToken(el, token) {
    const ax = Number(gp(token.actor, "system.props.blacksmith_icon_offset_x", 0)) || 0;
    const ay = Number(gp(token.actor, "system.props.blacksmith_icon_offset_y", 0)) || 0;

    const baseX = token.document?.x ?? token.x ?? 0;
    const baseY = token.document?.y ?? token.y ?? 0;
    const cx    = baseX + token.w / 2;
    const cy    = baseY + token.h / 2;

    const wt      = canvas.app.stage.worldTransform;
    const screenX = cx * wt.a + wt.tx;
    const screenY = cy * wt.d + wt.ty;

    el.style.left = `${screenX + this.cfg.ICON_OFFSET_X + ax}px`;
    el.style.top  = `${screenY - (this.cfg.ICON_OFFSET_Y + ay)}px`;
  }
}
