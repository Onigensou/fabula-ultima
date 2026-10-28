// scripts/orbment/alchemist-open.js
//
// The ALCHEMIST NPC — proximity button that opens the Attunement window, the
// Orbment counterpart of the refinement Blacksmith (refineOpen-*). Usually the
// accessory-shop owner, the way the Blacksmith is usually the weapon shop.
//
// Who is an Alchemist: actor flag `flags.fabula-ultima-companion.isAlchemist`
// (a FLAG, not a CSB prop — a prop with no template column is pruned by a
// template re-stamp). A `system.props.isAlchemist` checkbox is honoured too, in
// case the NPC template ever grows one. Set it with
//   FUCompanion.api.orbment.setAlchemist(actorOrUuid, true)
//
// Behaviour mirrors the Blacksmith exactly: a ⚗ button appears over the NPC
// when a party token stands at its feet (the shared window.oni.Interact rule),
// hidden NPC tokens get no button, keyboard Confirm offers it on walk maps.
// Placement: right of the shop button (+44), or +88 when the same NPC is also a
// Blacksmith so the two never overlap.

const TAG = "[Orbment][Alchemist]";
const FLAG_NS = "fabula-ultima-companion";
const LAYER_ID = "fu-alchemist-layer-v1";
const STYLE_ID = "fu-alchemist-style-v1";
const ANIM_IN_MS = 180, ANIM_OUT_MS = 140;
const RANGE_PX = 140;

const gp = (obj, path, fb) => { try { return foundry.utils.getProperty(obj, path) ?? fb; } catch { return fb; } };

export const isAlchemistActor = (actor) =>
  gp(actor, `flags.${FLAG_NS}.isAlchemist`, false) === true || gp(actor, "system.props.isAlchemist", false) === true;
const isBlacksmithActor = (actor) => gp(actor, "system.props.isBlacksmith", false) === true;
const isTokenHidden = (token) => token?.document?.hidden === true;

export async function setAlchemist(actorOrUuid, on = true) {
  if (!game.user?.isGM) throw new Error("Alchemist: GM only.");
  const actor = typeof actorOrUuid === "string" ? await fromUuid(actorOrUuid) : actorOrUuid;
  if (!actor || actor.documentName !== "Actor") throw new Error("Alchemist: actor not found.");
  await actor.setFlag(FLAG_NS, "isAlchemist", !!on);
  return actor;
}

const normActorId = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.startsWith("Actor.") ? s.slice(6) : s;
};
const centerOf = (token, ov = null) => ({
  x: (ov?.x ?? token?.document?.x ?? token?.x ?? 0) + (token?.w ?? 0) / 2,
  y: (ov?.y ?? token?.document?.y ?? token?.y ?? 0) + (token?.h ?? 0) / 2,
});

// ── Button layer ────────────────────────────────────────────────────────────
class AlchemistUI {
  constructor() {
    this._btnByTokenId = new Map();
    this._desired = new Set();
    this.onClick = null;
  }

  ensureLayer() {
    let layer = document.getElementById(LAYER_ID);
    if (!layer) {
      layer = document.createElement("div");
      layer.id = LAYER_ID;
      Object.assign(layer.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", pointerEvents: "none", zIndex: "90" });
      document.body.appendChild(layer);
    }
    if (!document.getElementById(STYLE_ID)) {
      const s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = `
        #${LAYER_ID} .fu-alch-prox-btn {
          pointer-events: auto; position: absolute;
          transform: translate(-50%, -50%) scale(0.75); opacity: 0;
          transition: transform ${ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1), opacity ${ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1);
          display: inline-flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; border-radius: 999px;
          background: rgba(20,20,20,0.78); border: 1px solid rgba(255,200,100,0.4);
          box-shadow: 0 6px 18px rgba(0,0,0,0.35);
          cursor: pointer; user-select: none; font-size: 18px;
        }
        #${LAYER_ID} .fu-alch-prox-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        #${LAYER_ID} .fu-alch-prox-btn.is-hiding {
          transform: translate(-50%, -50%) scale(0.75); opacity: 0;
          transition: transform ${ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1), opacity ${ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1);
        }
        #${LAYER_ID} .fu-alch-prox-btn:hover { transform: translate(-50%, -50%) scale(1.08); background: rgba(40,30,10,0.88); }
        #${LAYER_ID} .fu-alch-prox-btn:active { transform: translate(-50%, -50%) scale(0.98); }
      `;
      document.head.appendChild(s);
    }
    return layer;
  }

  setDesiredVisible(set) {
    this.ensureLayer();
    this._desired = new Set(set);
    for (const id of this._desired) this._show(id);
    for (const id of [...this._btnByTokenId.keys()]) if (!this._desired.has(id)) this._hide(id);
    this.repositionAll();
  }

  _show(tokenId) {
    const existing = this._btnByTokenId.get(tokenId);
    if (existing) {
      if (existing.state === "hiding") {
        clearTimeout(existing.hideTimer);
        existing.state = "shown";
        existing.el.classList.remove("is-hiding");
        existing.el.classList.add("is-visible");
      }
      return;
    }
    const el = document.createElement("div");
    el.className = "fu-alch-prox-btn";
    el.title = "Attune Orbments";
    el.textContent = "⚗️";
    el.dataset.tokenId = tokenId;
    el.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      try { this.onClick?.(tokenId); } catch (e) { console.error(TAG, e); }
    });
    this.ensureLayer().appendChild(el);
    const rec = { el, state: "showing", hideTimer: null };
    this._btnByTokenId.set(tokenId, rec);
    requestAnimationFrame(() => {
      if (!this._btnByTokenId.has(tokenId)) return;
      el.classList.add("is-visible");
      rec.state = "shown";
    });
  }

  _hide(tokenId) {
    const rec = this._btnByTokenId.get(tokenId);
    if (!rec || rec.state === "hiding") return;
    rec.state = "hiding";
    rec.el.classList.add("is-hiding");
    rec.el.classList.remove("is-visible");
    rec.hideTimer = setTimeout(() => {
      if (this._desired.has(tokenId)) {
        rec.el.classList.remove("is-hiding");
        rec.el.classList.add("is-visible");
        rec.state = "shown";
        return;
      }
      rec.el.remove();
      this._btnByTokenId.delete(tokenId);
    }, ANIM_OUT_MS + 20);
  }

  repositionAll() {
    for (const [tokenId, rec] of this._btnByTokenId) {
      const tok = canvas.tokens?.get(tokenId);
      if (!tok || !rec?.el) continue;
      const c = centerOf(tok);
      const wt = canvas.app.stage.worldTransform;
      const offX = isBlacksmithActor(tok.actor) ? 88 : 44;
      const ax = Number(gp(tok.actor, "system.props.alchemist_icon_offset_x", 0)) || 0;
      const ay = Number(gp(tok.actor, "system.props.alchemist_icon_offset_y", 0)) || 0;
      rec.el.style.left = `${c.x * wt.a + wt.tx + offX + ax}px`;
      rec.el.style.top = `${c.y * wt.d + wt.ty - (56 + ay)}px`;
    }
  }
}

// ── Proximity backend (party token at an Alchemist's feet) ───────────────────
class AlchemistBackend {
  constructor(ui) {
    this.ui = ui;
    this._party = new Set();
    this._partyTs = 0;
    this._posOverrides = new Map();
    this._visible = new Set();
    this._queued = false;
    this._started = false;
  }

  async partyIds(force = false) {
    if (!force && this._party.size && Date.now() - this._partyTs < 3000) return this._party;
    const cache = await window.FUCompanion?.api?.getCurrentGameDb?.();
    const db = cache?.db ?? null;
    const source = cache?.source ?? db;
    const ids = new Set();
    if (db?.id) ids.add(db.id);
    const props = gp(source, "system.props", {}) || {};
    for (const [k, v] of Object.entries(props)) {
      const kl = k.toLowerCase();
      if (!kl.includes("member")) continue;
      if (typeof v === "string") { const id = normActorId(v); if (id) ids.add(id); }
      else if (Array.isArray(v)) for (const x of v) { const id = normActorId(x); if (id) ids.add(id); }
    }
    this._party = ids;
    this._partyTs = Date.now();
    return ids;
  }

  queue() {
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => { this._queued = false; await this.scan(); }));
  }

  async scan() {
    try {
      if (!canvas?.ready) return;
      const now = Date.now();
      for (const [tid, o] of this._posOverrides) if (now - o.ts > 800) this._posOverrides.delete(tid);
      const party = await this.partyIds(false);
      const tokens = canvas.tokens?.placeables ?? [];
      const alchemists = tokens.filter((t) => t?.actor && !isTokenHidden(t) && isAlchemistActor(t.actor));
      const members = tokens.filter((t) => t?.actor && !isTokenHidden(t) && party.has(t.actor.id));
      const show = new Set();
      for (const at of alchemists) {
        const ac = centerOf(at, this._posOverrides.get(at.id));
        for (const pt of members) {
          const pc = centerOf(pt, this._posOverrides.get(pt.id));
          const near = window.oni?.Interact?.npcInRange
            ? window.oni.Interact.npcInRange(pt, pc, window.oni.Interact.rectOf(at, ac), at)
            : Math.hypot(ac.x - pc.x, ac.y - pc.y) <= RANGE_PX;
          if (near) { show.add(at.id); break; }
        }
      }
      const same = show.size === this._visible.size && [...show].every((id) => this._visible.has(id));
      if (!same) { this._visible = show; this.ui.setDesiredVisible(show); }
    } catch (e) { console.error(TAG, "scan:", e); }
  }

  start() {
    if (this._started) return;
    this._started = true;
    Hooks.on("updateToken", (doc, changes) => {
      const moved = "x" in changes || "y" in changes;
      if (!moved && !("hidden" in changes)) return;
      if (moved) this._posOverrides.set(doc.id, { x: changes.x ?? doc.x, y: changes.y ?? doc.y, ts: Date.now() });
      this.queue();
    });
    Hooks.on("createToken", () => this.queue());
    Hooks.on("deleteToken", () => this.queue());
    Hooks.on("updateActor", (actor, changes) => {
      if (gp(changes, `flags.${FLAG_NS}.isAlchemist`, undefined) !== undefined || gp(changes, "system.props.isAlchemist", undefined) !== undefined) this.queue();
    });
    Hooks.on("canvasReady", () => this.queue());
    this.queue();
  }
}

// Open the Attunement window for an Alchemist actor (lazy: the window module
// only loads the first time someone uses it).
export async function openAlchemist(actorUuid) {
  const mod = await import("./alchemist-window.js");
  return mod.AlchemistWindow.open(actorUuid);
}

let _installed = false;
export function initAlchemist() {
  if (_installed) return;
  _installed = true;
  const ui = new AlchemistUI();
  const backend = new AlchemistBackend(ui);
  ui.onClick = (tokenId) => {
    const tok = canvas.tokens?.get(tokenId);
    if (tok?.actor && isAlchemistActor(tok.actor)) openAlchemist(tok.actor.uuid).catch((e) => console.error(TAG, e));
  };
  window.oni?.Interact?.register?.("alchemist", window.oni.Interact.tokenButtons(ui._btnByTokenId, {
    label: "Attune", icon: "fas fa-flask", order: 31,
    run: (tokenId) => ui.onClick(tokenId),
  }));
  Hooks.on("canvasPan", () => ui.repositionAll());
  Hooks.on("canvasReady", () => ui.repositionAll());
  window.addEventListener("resize", () => ui.repositionAll());
  backend.start();
  globalThis.FUCompanion = globalThis.FUCompanion ?? {};
  globalThis.FUCompanion.alchemistOpen = { ui, backend, open: openAlchemist };
  console.debug(TAG, "Alchemist proximity system ready.");
}
