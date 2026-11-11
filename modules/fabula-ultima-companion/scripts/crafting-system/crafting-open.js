// scripts/crafting-system/crafting-open.js
//
// THE WAYS IN (besides Camp Forge):
//
//   Crafter NPC  actor flags isCrafter + crafterBook (+ crafterQuote). A Craft
//                button joins the NPC's overhead row (Talk / Shop / Refine /
//                Alchemist / Craft / Inn — keyboard-interact.js lines them up)
//                when a party token stands at its feet (window.oni.Interact
//                feet rule). Keyboard Confirm offers "Craft" in the NPC's menu.
//   Crafting table  a Region with flags.fabula-ultima-companion.craftSpot =
//                { enabled, bookId, name }, set in Region Config → Identity.
//                The walker gets the standard "!" (one-symbol rule), named
//                "Craft" on hover and in the keyboard menu.
//
// Who crafts (user, 2026-11-12): the actor who opens the window.
//   walk map — the Main Controller's party member; only they (or a GM) see the
//              buttons, like every party-wide prompt (Inn, teleporter).
//   camp map — each player's own member.

import { TAG, MODULE_ID, CRAFTER_FLAG, CRAFTER_BOOK_FLAG, CRAFTER_QUOTE_FLAG, SPOT_FLAG, gp, esc, isCampScene, cameraRuntime } from "./crafting-const.js";
import { readConfig, getBook } from "./crafting-data.js";
import { CraftWindow } from "./crafting-window.js";

const NPC_LAYER_ID = "fu-craft-layer-v1";
const SPOT_LAYER_ID = "oni-craft-spot-layer";
const STYLE_ID = "fu-craft-open-style";
const ANIM_IN_MS = 180, ANIM_OUT_MS = 140;
const RANGE_PX = 140;
const SPOT_RANGE_GRID = 0.7;
const SPOT_LIFT_PX = 10;

export const isCrafterActor = (actor) => gp(actor, `flags.${MODULE_ID}.${CRAFTER_FLAG}`, false) === true;
const isTokenHidden = (t) => t?.document?.hidden === true;
const centerOf = (token, ov = null) => ({
  x: (ov?.x ?? token?.document?.x ?? token?.x ?? 0) + (token?.w ?? 0) / 2,
  y: (ov?.y ?? token?.document?.y ?? token?.y ?? 0) + (token?.h ?? 0) / 2,
});

// GM: make an NPC a Crafter (or not). Also exposed on the API.
export async function setCrafter(actorOrUuid, { on = true, bookId = "", quote } = {}) {
  if (!game.user?.isGM) throw new Error("Crafting: GM only.");
  const actor = typeof actorOrUuid === "string" ? await fromUuid(actorOrUuid) : actorOrUuid;
  if (!actor || actor.documentName !== "Actor") throw new Error("Crafting: actor not found.");
  if (!on) return actor.update({ [`flags.${MODULE_ID}.-=${CRAFTER_FLAG}`]: null, [`flags.${MODULE_ID}.-=${CRAFTER_BOOK_FLAG}`]: null, [`flags.${MODULE_ID}.-=${CRAFTER_QUOTE_FLAG}`]: null });
  const upd = { [`flags.${MODULE_ID}.${CRAFTER_FLAG}`]: true, [`flags.${MODULE_ID}.${CRAFTER_BOOK_FLAG}`]: String(bookId ?? "") };
  if (quote !== undefined) upd[`flags.${MODULE_ID}.${CRAFTER_QUOTE_FLAG}`] = String(quote ?? "");
  return actor.update(upd);
}

// ── Who is crafting / may press the button ───────────────────────────────────
async function controller() {
  try { return (await globalThis.FUCompanion?.api?.MovementControl?.getCurrentControllerUser?.()) ?? null; } catch { return null; }
}

// The party's actor ids: the four members AND the party database actor, whose
// central token is what walks on exploration maps (the Alchemist's rule).
async function partyMemberIds({ withParty = false } = {}) {
  const ids = new Set();
  const rt = cameraRuntime();
  if (rt?.state?.partyMemberIds?.size) for (const id of rt.state.partyMemberIds) ids.add(id);
  try {
    const r = await window.FUCompanion?.api?.getCurrentGameDb?.();
    if (withParty && r?.db?.id) ids.add(r.db.id);
    const props = r?.source?.system?.props ?? r?.db?.system?.props ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (!/^member_id_\d+$/i.test(k) || typeof v !== "string") continue;
      const id = v.trim().replace(/^Actor\./, "");
      if (id) ids.add(id);
    }
  } catch {}
  return ids;
}

// The crafter for this client right now (null = nobody here may craft).
export async function resolveCrafter() {
  const scene = canvas?.scene;
  if (isCampScene(scene) && !game.user.isGM) {
    const t = cameraRuntime()?.getFollowToken?.();
    if (t?.actor && t.document?.isOwner) return t.actor;
    return game.user.character ?? null;
  }
  const ctl = await controller();
  const ctlActor = game.actors?.get(ctl?.partyMemberActorId ?? ctl?.linkedActorId ?? "") ?? null;
  if (game.user.isGM) {
    if (ctlActor) return ctlActor;
    const ids = await partyMemberIds();
    return game.actors?.get([...ids][0] ?? "") ?? null;
  }
  if (!ctl || ctl.userId !== game.user.id) return null;
  return ctlActor ?? game.user.character ?? null;
}

let _canCache = { at: 0, v: false, scene: null };
async function canOperate() {
  if (game.user?.isGM) return true;
  if (isCampScene(canvas?.scene)) return true;
  const now = Date.now();
  if (_canCache.scene === canvas?.scene?.id && now - _canCache.at < 1500) return _canCache.v;
  let v = false;
  try { v = !!(await globalThis.FUCompanion?.api?.MovementControl?.isCurrentUserMainController?.()); } catch {}
  _canCache = { at: now, v, scene: canvas?.scene?.id };
  return v;
}

// ── Open ─────────────────────────────────────────────────────────────────────
export async function openForNpc(actor) {
  if (!actor) return;
  const crafter = await resolveCrafter();
  if (!crafter) return ui.notifications?.warn("Crafting | Only the party leader can craft here.");
  const bookId = String(gp(actor, `flags.${MODULE_ID}.${CRAFTER_BOOK_FLAG}`, "") ?? "");
  return CraftWindow.open({
    place: "npc", bookId, actor: crafter,
    title: `Craft — ${actor.name}`, sourceName: actor.name, portrait: actor.img,
    quote: String(gp(actor, `flags.${MODULE_ID}.${CRAFTER_QUOTE_FLAG}`, "") ?? "") || defaultQuote(bookId),
  });
}

export async function openForSpot(regionDoc) {
  const spot = spotOf(regionDoc);
  if (!spot) return;
  const crafter = await resolveCrafter();
  if (!crafter) return ui.notifications?.warn("Crafting | Only the party leader can craft here.");
  const name = spot.name || regionDoc.name || "Workbench";
  return CraftWindow.open({ place: "table", bookId: spot.bookId, actor: crafter, title: `Craft — ${name}`, sourceName: name, portrait: null, quote: "" });
}

function defaultQuote(bookId) {
  return getBook(bookId) ? "Bring me the materials and a little coin, and I'll make it." : "";
}

// ── Crafter NPC buttons ──────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  // NPC button: the Alchemist's chrome. Spot button: the standard "!" (pose-spot-core).
  s.textContent = `
#${NPC_LAYER_ID}, #${SPOT_LAYER_ID} { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 90; }
#${NPC_LAYER_ID} .fu-craft-prox-btn {
  pointer-events: auto; position: absolute; transform: translate(-50%, -50%) scale(0.75); opacity: 0;
  transition: transform ${ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1), opacity ${ANIM_IN_MS}ms cubic-bezier(.2,.9,.2,1);
  display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 999px;
  background: rgba(20,20,20,0.78); border: 1px solid rgba(255,200,100,0.4); box-shadow: 0 6px 18px rgba(0,0,0,0.35);
  cursor: pointer; user-select: none; font-size: 16px; color: #f3e2b5;
}
#${NPC_LAYER_ID} .fu-craft-prox-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
#${NPC_LAYER_ID} .fu-craft-prox-btn.is-hiding { transform: translate(-50%, -50%) scale(0.75); opacity: 0;
  transition: transform ${ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1), opacity ${ANIM_OUT_MS}ms cubic-bezier(.4,0,.6,1); }
#${NPC_LAYER_ID} .fu-craft-prox-btn:hover { transform: translate(-50%, -50%) scale(1.08); background: rgba(40,30,10,0.88); }
.oni-craft-spot-btn {
  position: absolute; pointer-events: auto; width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95); border: 2px solid rgba(0,0,0,0.75); border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35); cursor: pointer; user-select: none;
  transform: translate(-50%, -50%) scale(0.75); transform-origin: 50% 100%; opacity: 0;
  transition: transform 160ms ease-out, opacity 160ms ease-out;
}
.oni-craft-spot-btn .mark { font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900; font-size: 20px; line-height: 1; color: rgba(20,16,10,0.95); transform: translateY(-1px); }
.oni-craft-spot-btn.is-visible { transform: translate(-50%, -50%) scale(1); opacity: 1; }
.oni-craft-spot-btn.is-visible:hover { transform: translate(-50%, -50%) scale(1.06); }
`;
  document.head.appendChild(s);
}

function layerEl(id) {
  injectStyles();
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("div"); el.id = id; document.body.appendChild(el); }
  return el;
}

class NpcButtons {
  constructor() { this.btns = new Map(); this.desired = new Set(); this.pos = new Map(); this.queued = false; }

  show(tokenId) {
    const rec = this.btns.get(tokenId);
    if (rec) {
      if (rec.state === "hiding") { clearTimeout(rec.timer); rec.state = "shown"; rec.el.classList.remove("is-hiding"); rec.el.classList.add("is-visible"); }
      return;
    }
    const el = document.createElement("div");
    el.className = "fu-craft-prox-btn";
    el.title = "Craft";
    el.innerHTML = `<i class="fas fa-screwdriver-wrench"></i>`;
    el.dataset.tokenId = tokenId;
    el.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); this.run(tokenId); });
    layerEl(NPC_LAYER_ID).appendChild(el);
    const r = { el, state: "showing", timer: null };
    this.btns.set(tokenId, r);
    requestAnimationFrame(() => { if (this.btns.get(tokenId) !== r) return; el.classList.add("is-visible"); r.state = "shown"; });
  }

  hide(tokenId) {
    const rec = this.btns.get(tokenId);
    if (!rec || rec.state === "hiding") return;
    rec.state = "hiding";
    rec.el.classList.add("is-hiding");
    rec.el.classList.remove("is-visible");
    rec.timer = setTimeout(() => {
      if (this.desired.has(tokenId)) { rec.el.classList.remove("is-hiding"); rec.el.classList.add("is-visible"); rec.state = "shown"; return; }
      rec.el.remove(); this.btns.delete(tokenId);
    }, ANIM_OUT_MS + 20);
  }

  // A first position; keyboard-interact's overhead row takes over every frame.
  place() {
    const wt = canvas?.app?.stage?.worldTransform;
    if (!wt) return;
    for (const [id, rec] of this.btns) {
      const tok = canvas.tokens?.get(id);
      if (!tok) continue;
      const c = centerOf(tok);
      rec.el.style.left = `${c.x * wt.a + wt.tx + 44}px`;
      rec.el.style.top = `${c.y * wt.d + wt.ty - 56}px`;
    }
  }

  run(tokenId) {
    const tok = canvas.tokens?.get(tokenId);
    if (tok?.actor && isCrafterActor(tok.actor)) openForNpc(tok.actor).catch((e) => console.error(TAG, e));
  }

  queue() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => { this.queued = false; await this.scan(); }));
  }

  async scan() {
    try {
      if (!canvas?.ready) return;
      const show = new Set();
      if (await canOperate()) {
        const now = Date.now();
        for (const [id, o] of this.pos) if (now - o.ts > 800) this.pos.delete(id);
        const party = await partyMemberIds({ withParty: true });
        const tokens = canvas.tokens?.placeables ?? [];
        const crafters = tokens.filter((t) => t?.actor && !isTokenHidden(t) && isCrafterActor(t.actor));
        const members = tokens.filter((t) => t?.actor && !isTokenHidden(t) && party.has(t.actor.id));
        for (const ct of crafters) {
          const cc = centerOf(ct, this.pos.get(ct.id));
          for (const pt of members) {
            const pc = centerOf(pt, this.pos.get(pt.id));
            const I = window.oni?.Interact;
            const near = I?.npcInRange ? I.npcInRange(pt, pc, I.rectOf(ct, cc), ct) : Math.hypot(cc.x - pc.x, cc.y - pc.y) <= RANGE_PX;
            if (near) { show.add(ct.id); break; }
          }
        }
      }
      this.desired = show;
      for (const id of show) this.show(id);
      for (const id of [...this.btns.keys()]) if (!show.has(id)) this.hide(id);
      this.place();
    } catch (e) { console.error(TAG, "npc scan:", e); }
  }

  start() {
    Hooks.on("updateToken", (doc, ch) => {
      const moved = "x" in ch || "y" in ch;
      if (!moved && !("hidden" in ch)) return;
      if (moved) this.pos.set(doc.id, { x: ch.x ?? doc.x, y: ch.y ?? doc.y, ts: Date.now() });
      this.queue();
    });
    Hooks.on("createToken", () => this.queue());
    Hooks.on("deleteToken", () => this.queue());
    Hooks.on("updateActor", (a, ch) => { if (gp(ch, `flags.${MODULE_ID}`, null)) this.queue(); });
    Hooks.on("canvasReady", () => { _canCache.at = 0; this.queue(); });
    Hooks.on("canvasPan", () => this.place());
    window.addEventListener("resize", () => this.place());
    // The Main Controller can change hands without anyone moving.
    setInterval(() => { if (this.btns.size || canvas?.tokens?.placeables?.some((t) => isCrafterActor(t.actor))) this.queue(); }, 2000);
    this.queue();
  }
}

// ── Crafting spots (Region "!") ──────────────────────────────────────────────
export function spotOf(regionDoc) {
  const s = regionDoc?.getFlag?.(MODULE_ID, SPOT_FLAG);
  return s?.enabled ? { bookId: String(s.bookId ?? ""), name: String(s.name ?? "").trim() } : null;
}

class SpotButtons {
  constructor() { this.btns = new Map(); this.ticker = null; this.can = false; this.canAt = 0; }

  walker() {
    const rt = cameraRuntime();
    // A GM walks nothing; the token they have selected stands in, so a GM can try a spot.
    const t = rt?.getFollowToken?.() ?? (game.user.isGM && canvas.tokens?.controlled?.length === 1 ? canvas.tokens.controlled[0] : null);
    if (!t || t.mesh?.destroyed) return null;
    if (game.user.isGM) return t;
    if (!t.document?.isOwner) return null;
    return rt.canCurrentUserMovePartyToken?.() ? t : null;
  }

  nearest(walker) {
    const feet = { x: walker.x + walker.w / 2, y: walker.y + walker.h * 0.85 };
    const g = canvas.dimensions?.size || 100;
    let best = null;
    for (const region of canvas.regions?.placeables ?? []) {
      if (!spotOf(region.document)) continue;
      let inside = false;
      try { inside = !!region.testPoint?.(feet, 0); } catch {}
      if (inside) return { region, anchor: feet, dist: 0 };
      const e = edgeDist(region.document, feet);
      if (e && e.dist <= g * SPOT_RANGE_GRID && (!best || e.dist < best.dist)) best = { region, anchor: e.point, dist: e.dist };
    }
    return best;
  }

  button(regionId, label) {
    let el = this.btns.get(regionId);
    if (!el) {
      el = document.createElement("div");
      el.className = "oni-craft-spot-btn";
      el.innerHTML = `<div class="mark">!</div>`;
      el.addEventListener("pointerdown", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const r = canvas.regions?.get(regionId);
        if (r) openForSpot(r.document).catch((e) => console.error(TAG, e));
      });
      layerEl(SPOT_LAYER_ID).appendChild(el);
      this.btns.set(regionId, el);
      el._frame = requestAnimationFrame(() => { el._frame = null; if (this.btns.get(regionId) === el) el.classList.add("is-visible"); });
    }
    if (el.title !== label) el.title = label;
    return el;
  }

  drop(regionId) {
    const el = this.btns.get(regionId);
    if (!el) return;
    this.btns.delete(regionId);
    if (el._frame) cancelAnimationFrame(el._frame);
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 200);
  }

  tick() {
    try {
      if (!canvas?.ready) return;
      const now = Date.now();
      if (now - this.canAt > 1000) { this.canAt = now; canOperate().then((v) => { this.can = v; }); }
      const keep = new Set();
      const w = this.can && !game.paused && !CraftWindow.current ? this.walker() : null;
      const hit = w && !cameraRuntime()?.state?.inputLocked ? this.nearest(w) : null;
      if (hit) {
        const id = hit.region.id;
        keep.add(id);
        const spot = spotOf(hit.region.document);
        const el = this.button(id, `Craft${spot?.name ? `: ${spot.name}` : ""}`);
        const head = w.mesh.getBounds();
        const half = (el.offsetHeight || 34) / 2;
        const l = `${Math.round(head.x + head.width / 2)}px`, t = `${Math.round(head.top - SPOT_LIFT_PX - half)}px`;
        if (el.style.left !== l) el.style.left = l;
        if (el.style.top !== t) el.style.top = t;
        el._anchor = hit.anchor;
      }
      for (const id of [...this.btns.keys()]) if (!keep.has(id)) this.drop(id);
    } catch (e) {
      const now = Date.now();
      if (now - (this._warn ?? 0) > 5000) { this._warn = now; console.warn(TAG, "spot tick:", e); }
    }
  }

  attach() {
    if (this.ticker || !canvas?.app?.ticker) return;
    this.ticker = () => this.tick();
    canvas.app.ticker.add(this.ticker, null, PIXI.UPDATE_PRIORITY.UTILITY);
  }
  detach() {
    if (this.ticker && canvas?.app?.ticker) canvas.app.ticker.remove(this.ticker);
    this.ticker = null;
    for (const id of [...this.btns.keys()]) this.drop(id);
  }

  interact() {
    const out = [];
    for (const [regionId, el] of this.btns) {
      if (!el._anchor) continue;
      out.push({ target: `craftSpot:${regionId}`, label: "Craft", icon: "fas fa-screwdriver-wrench", order: 34, anchor: el._anchor, el,
        run: () => { const r = canvas.regions?.get(regionId); if (r) return openForSpot(r.document); } });
    }
    return out;
  }
}

// Nearest point on a Region's outline (rectangles + polygons), as fishing-spot.js.
function edgeDist(regionDoc, p) {
  let best = null;
  const seg = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy }, d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || d < best.dist) best = { point: q, dist: d };
  };
  for (const s of regionDoc?.shapes ?? []) {
    if (s.hole) continue;
    let pts = null;
    if (s.type === "polygon" && s.points?.length >= 6) { pts = []; for (let i = 0; i < s.points.length; i += 2) pts.push({ x: s.points[i], y: s.points[i + 1] }); }
    else if (s.type === "rectangle") pts = [{ x: s.x, y: s.y }, { x: s.x + s.width, y: s.y }, { x: s.x + s.width, y: s.y + s.height }, { x: s.x, y: s.y + s.height }];
    else if (s.type === "ellipse") { pts = []; for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; pts.push({ x: s.x + Math.cos(a) * s.radiusX, y: s.y + Math.sin(a) * s.radiusY }); } }
    if (!pts) continue;
    for (let i = 0; i < pts.length; i++) seg(pts[i], pts[(i + 1) % pts.length]);
  }
  return best;
}

// ── Region Config: "Crafting spot" (Identity tab) ────────────────────────────
function buildRegionConfig(app, root) {
  const doc = app?.document;
  if (!doc || root.querySelector(".oni-craft-spot")) return;
  const host = root.querySelector('section[data-tab="identity"]') ?? root.querySelector("form") ?? root;
  const s = doc.getFlag(MODULE_ID, SPOT_FLAG) ?? {};
  const F = `flags.${MODULE_ID}.${SPOT_FLAG}`;
  const books = readConfig().books;
  const cur = String(s.bookId ?? "");
  const opts = books.map((b) => `<option value="${esc(b.id)}" ${b.id === cur ? "selected" : ""}>${esc(b.name)}</option>`).join("")
    + (cur && !books.some((b) => b.id === cur) ? `<option value="${esc(cur)}" selected>(missing book)</option>` : "");
  const fs = document.createElement("fieldset");
  fs.className = "oni-craft-spot";
  fs.innerHTML = `
    <legend>Crafting spot</legend>
    <div class="form-group"><label>Crafting spot</label>
      <div class="form-fields"><input type="checkbox" name="${F}.enabled" ${s.enabled ? "checked" : ""}></div>
      <p class="hint">A workbench, anvil or crafting table. Walking up shows the "!" and opens the crafting window. On a walk map the party leader crafts; in a camp, each player for their own character.</p></div>
    <div class="form-group"><label>Blueprint book</label>
      <div class="form-fields"><select name="${F}.bookId"><option value="">(none)</option>${opts}</select></div>
      <p class="hint">Which Blueprints this spot offers. Make books in Game Settings → Blueprint Editor.</p></div>
    <div class="form-group"><label>Name</label>
      <div class="form-fields"><input type="text" name="${F}.name" value="${esc(s.name ?? "")}" placeholder="Workbench"></div>
      <p class="hint">Shown in the window's title.</p></div>`;
  host.appendChild(fs);
  app.setPosition?.({ height: "auto" });
}

// ── Install ──────────────────────────────────────────────────────────────────
let _installed = false;
export function initCraftingOpen() {
  if (_installed) return;
  _installed = true;
  const npc = new NpcButtons();
  window.oni?.Interact?.register?.("craft", window.oni.Interact.tokenButtons(npc.btns, {
    label: "Craft", icon: "fas fa-screwdriver-wrench", order: 33, run: (tokenId) => npc.run(tokenId),
  }));
  npc.start();

  const spots = new SpotButtons();
  window.oni?.Interact?.register?.("craftSpot", () => spots.interact());
  Hooks.on("canvasReady", () => spots.attach());
  Hooks.on("canvasTearDown", () => spots.detach());
  if (canvas?.ready) spots.attach();

  Hooks.on("renderRegionConfig", (app, html) => {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (root) buildRegionConfig(app, root);
  });
  return { npc, spots };
}
