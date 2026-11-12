// ============================================================================
// Terrarium — button, fan and tile picker (2026-11-12). Approved mockup v4:
// https://claude.ai/artifact/Sg95izKw5SLo32vd2E53wD
//
//   🌱 button   dungeon command row, HudDock slot 25 (after ❤️ Healing). Shows
//               the party's Terrarium count; grey when there are none or this
//               client is not the main controller.
//   Fan         one orb per Terrarium type the party holds, rising from the
//               button — the camp Summon picker's look (camp-summons-ui.js).
//               ←/→ (A/D) pick · Z/Enter choose · X/Esc close · click outside.
//               Sounds: BattleCursor_4 open, BattleCursor_2 move (user pick),
//               cursor_back2 close.
//   Picker      gold rings on the tiles next to the party, a lock badge on the
//               ones that can't change, a ghost of the new tile on the focused
//               one and a cream bubble ("Random Battle → Healing", or why not).
//               ←/→ cycle · Z place · X back to the fan. Place / Go Back
//               buttons (landing-panel style) with a new-day warning when the
//               tile resets on rest.
//   Watchers    everyone else sees the same fan / rings / panel read-only
//               (MirrorPrompt "dungeon.terrarium"), then the throw.
//
//   DP.TerrariumUI.isOpen          dp-bootstrap ignores dungeon clicks while true
//   DP.TerrariumUI.showButton() / hideButton()
//   DP.TerrariumUI.startWith({ kind, itemUuid })   Party Menu → Use
// ============================================================================

import { KINDS, KIND_NAME, KIND_SHORT, KIND_TEXTURE, kindBlock, typeLabel } from "./dp-terrarium-rules.js";

const DP  = (globalThis.DungeonPathing ??= {});
const TAG = "[DungeonPathing][TerrariumUI]";
const MIRROR_KIND = "dungeon.terrarium";
const FORGE = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb";
const SND = {
  open: [`${FORGE}/Sound/BattleCursor_4.wav`, 0.45],
  move: [`${FORGE}/Sound/BattleCursor_2.wav`, 0.6],
  back: [`${FORGE}/Sound/cursor_back2.wav`, 0.5],
  ok:   [`${FORGE}/Sound/Cursor_Confirm.mp3`, 0.45],
  buzz: [`${FORGE}/Sound/cursor_back2.wav`, 0.4],
};
const BTN_ID = "oni-dp-terrarium-btn";
const STYLE_ID = "oni-dp-terrarium-styles";
const Z_RINGS = 999995;

function sfx(key) {
  const [src, volume] = SND[key] ?? [];
  if (!src) return;
  try { (foundry?.audio?.AudioHelper ?? globalThis.AudioHelper)?.play?.({ src, volume, autoplay: true, loop: false }, false); } catch {}
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const toast = (msg) => ui.notifications?.warn?.(msg);
const reasonText = (res) => res?.why || DP.Terrarium?.REASON?.[res?.reason] || "That didn't work.";

function viewEl() { return canvas?.app?.view ?? canvas?.app?.renderer?.view ?? null; }
function worldToClient(x, y) {
  const t = canvas?.stage?.worldTransform, el = viewEl();
  if (!t || !el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  const rx = t.a * x + t.c * y + t.tx, ry = t.b * x + t.d * y + t.ty;
  return { x: rect.left + (rx / (el.width || rect.width || 1)) * rect.width, y: rect.top + (ry / (el.height || rect.height || 1)) * rect.height };
}
function tileGeom(tileId) {
  const td = canvas?.scene?.tiles?.get(tileId);
  if (!td) return null;
  const w = Number(td.width) || 50, h = Number(td.height) || 50;
  return { x: Number(td.x), y: Number(td.y), w, h, cx: Number(td.x) + w / 2, cy: Number(td.y) + h / 2 };
}

// ── styles ─────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${BTN_ID} .oni-tr-cnt { position: absolute; bottom: -4px; right: -4px; min-width: 22px; height: 22px; padding: 0 5px; box-sizing: border-box;
  border-radius: 11px; display: grid; place-items: center; font: 800 12px/1 "Signika","Noto Sans",system-ui,sans-serif; color: #3b2a19;
  background: linear-gradient(180deg,#f4d488,#caa44d); border: 1.5px solid #6f4526; text-shadow: none; }
#${BTN_ID}.oni-tr-on { background: radial-gradient(circle at 40% 35%, rgba(30,110,60,0.93) 0%, rgba(15,60,30,0.97) 100%);
  border-color: rgba(140,230,150,.8); box-shadow: 0 0 20px rgba(120,230,140,.4), 0 2px 8px rgba(0,0,0,.5); }

/* Fan — the camp Summon picker (camp-summons-ui.js) */
.oni-tr-fan { position: fixed; z-index: 99999; bottom: 160px; display: flex; gap: 12px; align-items: flex-end; pointer-events: auto; }
.oni-tr-fan.is-watching { pointer-events: none; }
.oni-tr-fan .oni-tr-item { appearance: none; background: none; border: 0; padding: 0; margin: 0; width: auto; height: auto; line-height: normal; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; gap: 6px; font-family: "Signika","Noto Sans",system-ui,sans-serif;
  animation: oniTrIn .26s cubic-bezier(.3,1.4,.5,1) both; }
.oni-tr-fan .oni-tr-item:focus, .oni-tr-fan .oni-tr-item:hover { box-shadow: none; outline: none; }
.oni-tr-fan.is-out .oni-tr-item { animation: oniTrOut .18s ease both; }
@keyframes oniTrIn { from { opacity: 0; transform: translateY(26px) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes oniTrOut { to { opacity: 0; transform: translateY(14px) scale(.8); } }
.oni-tr-fan .oni-tr-orb { position: relative; width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; box-sizing: border-box;
  border: 2px solid rgba(200,160,80,0.65); background: radial-gradient(circle at 40% 35%, rgba(90,65,30,0.92) 0%, rgba(45,32,14,0.96) 100%);
  box-shadow: 0 0 14px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12);
  transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; }
.oni-tr-fan .oni-tr-orb img { width: 40px; height: 40px; border: 0; }
.oni-tr-fan .oni-tr-key { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 5px;
  background: #f6ebd3; color: #3b2a19; border: 1px solid #8d5f38; font: 700 10.5px/16px "Signika","Noto Sans",system-ui,sans-serif; text-align: center; }
.oni-tr-fan .oni-tr-name { font-size: 11px; font-weight: 700; letter-spacing: .3px; white-space: nowrap; padding: 2px 9px; border-radius: 999px;
  background: #f6ebd3; color: #3b2a19; border: 1px solid #8d5f38; box-shadow: 0 2px 6px rgba(0,0,0,.45); transition: background .15s ease; }
.oni-tr-fan .oni-tr-item:hover .oni-tr-orb, .oni-tr-fan .oni-tr-item.is-focus .oni-tr-orb {
  transform: translateY(-4px) scale(1.06); border-color: rgba(244,212,136,.95);
  box-shadow: 0 0 18px rgba(244,212,136,.5), 0 2px 6px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.12); }
.oni-tr-fan .oni-tr-item.is-focus .oni-tr-name { background: linear-gradient(180deg, #f4d488, #caa44d); color: #4b3517; }
.oni-tr-fan .oni-tr-item.is-off .oni-tr-orb { filter: grayscale(.85); opacity: .55; }
.oni-tr-wait { position: fixed; z-index: 99999; font: italic 600 13px "Signika",sans-serif; color: #f4e8c0; text-shadow: 0 1px 3px rgba(0,0,0,.95);
  white-space: nowrap; pointer-events: none; }

/* bubble (DP.Tooltip look) + hint + panel */
.oni-tr-bubble { position: fixed; z-index: 99999; transform: translate(-50%, -100%); padding: 6px 12px; border-radius: 12px; pointer-events: none;
  background: #fbf3dc; color: #3b2a19; font: 600 14px/1.3 "Signika",sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.45); white-space: nowrap; text-align: center; }
.oni-tr-bubble::after { content: ""; position: absolute; left: 50%; bottom: -7px; margin-left: -7px; border: 7px solid transparent; border-bottom: 0; border-top-color: #fbf3dc; }
.oni-tr-bubble .arw { color: #8a4b22; margin: 0 6px; }
.oni-tr-bubble .warn { display: block; margin-top: 2px; font-size: 12.5px; color: #9b2a1f; }
.oni-tr-bubble.bad { background: #f6e1d9; color: #6d1f14; }
.oni-tr-bubble.bad::after { border-top-color: #f6e1d9; }
.oni-tr-hint { position: fixed; z-index: 99998; left: 50%; bottom: 26px; transform: translateX(-50%); display: flex; gap: 16px; align-items: center;
  padding: 8px 18px; border-radius: 10px; background: rgba(20,12,6,.88); border: 1px solid rgba(200,160,80,.55); color: #f4e8c0;
  font: 600 14px "Signika",sans-serif; white-space: nowrap; pointer-events: none; }
.oni-tr-hint kbd { font: 700 11px "Signika",sans-serif; padding: 1px 6px; border-radius: 4px; background: #f6ebd3; color: #3b2a19; margin-right: 4px; border: 0; box-shadow: none; }
.oni-tr-panel { position: fixed; z-index: 99999; display: flex; flex-direction: column; gap: 5px; pointer-events: auto; user-select: none;
  animation: oniTrPop .18s cubic-bezier(.3,.8,.4,1.2); }
.oni-tr-panel.is-watching .oni-dp-btn { pointer-events: none; cursor: default; }
@keyframes oniTrPop { from { transform: scale(.85); opacity: 0; } }
.oni-tr-panel .oni-dp-btn { width: 130px; height: 42px; font-size: 13px; gap: 6px; padding-left: 8px; }
.oni-tr-panel .oni-dp-btn img { width: 20px; height: 20px; border: 0; }
.oni-tr-panel .oni-tr-warn { width: 220px; padding: 7px 10px; border-radius: 8px; background: #f6e1d9; color: #6d1f14; border: 1.5px solid #9b2a1f;
  font: 600 12.5px/1.3 "Signika",sans-serif; box-shadow: 0 4px 12px rgba(0,0,0,.45); }
@media (prefers-reduced-motion: reduce) { .oni-tr-fan .oni-tr-item, .oni-tr-panel { animation: none !important; } }
`;
  document.head.appendChild(s);
}

// ── board layer: rings, locks, ghost ──────────────────────────────────────────
const Board = {
  root: null, items: new Map(), ghost: null, tick: null,
  draw(armed, targets, selId) {
    this.clear();
    if (!canvas?.ready) return;
    const root = new PIXI.Container();
    root.zIndex = Z_RINGS; root.name = "oniTerrariumRings";
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(root);
    this.root = root;
    for (const t of targets) {
      const g = tileGeom(t.id); if (!g) continue;
      const r = Math.max(g.w, g.h) * 0.62;
      const c = new PIXI.Container(); c.position.set(g.cx, g.cy);
      if (t.ok) {
        const ring = new PIXI.Graphics();
        ring.lineStyle(3, 0xffe08c, 1).drawCircle(0, 0, r);
        c.addChild(ring); c._ring = ring;
      } else {
        const badge = new PIXI.Graphics();
        badge.lineStyle(1.5, 0xd5b67a, 1).beginFill(0x9b2a1f, 1).drawCircle(0, 0, 10).endFill();
        badge.position.set(g.w * 0.45, -g.h * 0.45);
        const lock = new PIXI.Text("🔒", { fontSize: 11 }); lock.anchor.set(0.5); lock.position.copyFrom(badge.position);
        const dim = new PIXI.Graphics(); dim.beginFill(0x000000, 0.35).drawRoundedRect(-g.w / 2, -g.h / 2, g.w, g.h, 6).endFill();
        c.addChild(dim, badge, lock);
      }
      root.addChild(c);
      this.items.set(t.id, c);
    }
    if (armed) {
      loadTexture(KIND_TEXTURE[armed]).then((tex) => {
        if (!tex || this.root !== root) return;
        const s = new PIXI.Sprite(tex); s.anchor.set(0.5); s.alpha = 0; s.visible = false;
        root.addChild(s); this.ghost = s; this.select(this._sel);
      }).catch(() => {});
    }
    this._sel = selId;
    const t0 = performance.now();
    const reduce = !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.tick = () => {
      const k = reduce ? 0.5 : (Math.sin((performance.now() - t0) / 1250 * Math.PI * 2) + 1) / 2;
      for (const c of this.items.values()) if (c._ring) { c._ring.scale.set(0.95 + 0.17 * k); c._ring.alpha = 0.65 + 0.35 * k; }
      if (this.ghost?.visible) this.ghost.y = this._gy - (reduce ? 0 : Math.sin((performance.now() - t0) / 600 * Math.PI) * 3);
    };
    canvas.app.ticker.add(this.tick);
    this.select(selId);
  },
  select(id) {
    this._sel = id;
    const ok = !!this.items.get(id)?._ring;
    if (!this.ghost) return;
    const g = id && ok ? tileGeom(id) : null;
    this.ghost.visible = !!g;
    if (g) { this.ghost.width = g.w; this.ghost.height = g.h; this.ghost.x = g.cx; this._gy = g.cy; this.ghost.y = g.cy; this.ghost.alpha = 0.62; }
  },
  clear() {
    if (this.tick) canvas?.app?.ticker?.remove(this.tick);
    this.tick = null;
    if (this.root) { if (this.root.parent) this.root.parent.removeChild(this.root); this.root.destroy({ children: true }); }
    this.root = null; this.ghost = null; this.items.clear();
  },
};

// ── DOM pieces shared by the operator and watchers ────────────────────────────
const View = {
  fan: null, bubble: null, hint: null, panel: null, wait: null, raf: null,
  buttonLeft() { return document.getElementById(BTN_ID)?.style.left || "168px"; },
  // Above everything HudDock stacks over the button row (the controller badge
  // sits there on dungeon maps, unlike camp), never lower than the camp fan's 160.
  fanBottom() {
    let top = 0;
    try { top = Number(globalThis.oni?.HudDock?.stackTop?.()) || 0; } catch {}
    return Math.max(160, Math.round(top + 10));
  },

  showFan(list, focus, { watching = false, onPick = null, onFocus = null } = {}) {
    injectStyles();
    this.hideFan(false);
    const el = document.createElement("div");
    el.className = "oni-tr-fan" + (watching ? " is-watching" : "");
    el.setAttribute("role", "menu"); el.setAttribute("aria-label", "Terrarium");
    el.style.left = this.buttonLeft();
    el.style.bottom = `${this.fanBottom()}px`;
    el.innerHTML = list.map((o, i) => `
      <button type="button" class="oni-tr-item${o.block ? " is-off" : ""}" role="menuitem" data-k="${o.kind}" style="animation-delay:${i * 45}ms"
        aria-label="${esc(KIND_NAME[o.kind])}" title="${esc(o.block || KIND_NAME[o.kind])}">
        <span class="oni-tr-orb"><img src="${KIND_TEXTURE[o.kind]}" alt=""><span class="oni-tr-key">×${o.qty}</span></span>
        <span class="oni-tr-name">${esc(KIND_SHORT[o.kind])}</span>
      </button>`).join("");
    if (!watching) el.querySelectorAll(".oni-tr-item").forEach((b) => {
      b.addEventListener("pointerenter", () => onFocus?.(b.dataset.k));
      b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); onPick?.(b.dataset.k); });
    });
    document.body.appendChild(el);
    this.fan = el;
    this.focusFan(focus);
  },
  focusFan(kind) { this.fan?.querySelectorAll(".oni-tr-item").forEach((b) => b.classList.toggle("is-focus", b.dataset.k === kind)); },
  hideFan(animated = true) {
    const el = this.fan; this.fan = null;
    if (!el) return;
    if (!animated) { el.remove(); return; }
    el.classList.add("is-out"); setTimeout(() => el.remove(), 200);
  },

  showWait(text) {
    injectStyles();
    this.wait?.remove();
    const w = document.createElement("div"); w.className = "oni-tr-wait"; w.textContent = text;
    w.style.left = this.buttonLeft(); w.style.bottom = `${this.fanBottom() + 98}px`;
    document.body.appendChild(w); this.wait = w;
  },

  showHint(html) {
    injectStyles();
    this.hint?.remove();
    const h = document.createElement("div"); h.className = "oni-tr-hint"; h.innerHTML = html;
    document.body.appendChild(h); this.hint = h;
  },

  // bubble + panel follow the camera
  bubbleFor(target, armed) {
    this.bubble?.remove(); this.bubble = null;
    if (!target) return;
    const cur = typeLabel(DP.TileState?.getCurrentType?.(canvas.scene, target.id));
    const b = document.createElement("div");
    b.className = "oni-tr-bubble" + (target.ok ? "" : " bad");
    b.innerHTML = target.ok
      ? `${esc(cur)}<span class="arw">→</span>${esc(typeLabel(armed))}${target.warn ? `<span class="warn">⚠ ${esc(target.warn)}</span>` : ""}`
      : `🔒 ${esc(target.why)}`;
    b._tileId = target.id;
    document.body.appendChild(b); this.bubble = b;
    this.track();
  },
  showPanel(target, armed, { watching = false, onPlace = null, onBack = null } = {}) {
    injectStyles();
    this.panel?.remove();
    const p = document.createElement("div");
    p.className = "oni-tr-panel" + (watching ? " is-watching" : "");
    p.innerHTML = `${target.warn ? `<div class="oni-tr-warn">⚠ ${esc(target.warn)}<br>The Terrarium change will be lost.</div>` : ""}
      <div class="oni-dp-btn oni-dp-btn-use" role="button" data-a="place"><img src="${KIND_TEXTURE[armed]}" alt="">Place</div>
      <div class="oni-dp-btn oni-dp-btn-revert" role="button" data-a="back">Go Back</div>`;
    if (!watching) p.addEventListener("pointerdown", (ev) => {
      const a = ev.target.closest("[data-a]")?.dataset.a; if (!a) return;
      ev.preventDefault(); ev.stopPropagation();
      if (a === "place") onPlace?.(); else onBack?.();
    });
    p._tileId = target.id;
    document.body.appendChild(p); this.panel = p;
    this.track();
  },
  hidePanel() { this.panel?.remove(); this.panel = null; },
  track() {
    if (this.raf) return;
    const loop = () => {
      this.raf = null;
      let live = false;
      for (const el of [this.bubble, this.panel]) {
        if (!el?.isConnected) continue;
        const g = tileGeom(el._tileId); if (!g) continue;
        live = true;
        if (el === this.bubble) { const c = worldToClient(g.cx, g.y - 6); el.style.left = `${Math.round(c.x)}px`; el.style.top = `${Math.round(c.y)}px`; }
        else { const c = worldToClient(g.x + g.w, g.cy); el.style.left = `${Math.round(c.x + 14)}px`; el.style.top = `${Math.round(c.y - el.offsetHeight / 2)}px`; }
      }
      if (live) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },
  clearAll() {
    this.hideFan(false); Board.clear();
    for (const k of ["bubble", "hint", "panel", "wait"]) { this[k]?.remove(); this[k] = null; }
    if (this.raf) cancelAnimationFrame(this.raf); this.raf = null;
  },
};

// ── operator state ────────────────────────────────────────────────────────────
const S = {
  open: false, stage: null, stock: null, list: [], focus: null,
  armed: null, itemUuid: null, targets: [], sel: -1, mirror: null, keyH: null, outsideH: null, busy: false,
};
const sendMirror = () => S.mirror?.patch?.({
  stage: S.stage, list: S.list, focus: S.focus, armed: S.armed,
  targets: S.targets.map((t) => ({ id: t.id, ok: t.ok, why: t.why ?? null, warn: t.warn ?? null })),
  sel: S.targets[S.sel]?.id ?? null,
});

async function fanList() {
  const st = await DP.Terrarium.stock();
  const info = DP.Terrarium.sceneInfo(canvas.scene);
  S.stock = st;
  return KINDS.filter((k) => st[k]?.length).map((k) => ({
    kind: k, qty: st[k].reduce((a, e) => a + e.qty, 0), block: kindBlock(k, info),
  }));
}

function installKeys() {
  if (S.keyH) return;
  S.keyH = (ev) => {
    if (!S.open || S.busy) return;
    const k = ev.code; let used = true;
    if (S.stage === "fan") {
      if (["ArrowLeft", "KeyA", "ArrowUp", "KeyW"].includes(k)) stepFan(-1);
      else if (["ArrowRight", "KeyD", "ArrowDown", "KeyS"].includes(k)) stepFan(1);
      else if (k === "KeyZ" || k === "Enter" || k === "NumpadEnter") pickKind(S.focus);
      else if (k === "KeyX" || k === "Escape") { sfx("back"); close(); }
      else used = false;
    } else if (S.stage === "target") {
      if (["ArrowLeft", "KeyA", "ArrowUp", "KeyW"].includes(k)) selectTarget((S.sel + S.targets.length - 1) % S.targets.length);
      else if (["ArrowRight", "KeyD", "ArrowDown", "KeyS"].includes(k)) selectTarget((S.sel + 1) % S.targets.length);
      else if (k === "KeyZ" || k === "Enter" || k === "NumpadEnter") openPanel();
      else if (k === "KeyX" || k === "Escape") backToFan();
      else used = false;
    } else if (S.stage === "confirm") {
      if (k === "KeyZ" || k === "Enter" || k === "NumpadEnter") place();
      else if (k === "KeyX" || k === "Escape") { sfx("back"); View.hidePanel(); S.stage = "target"; sendMirror(); }
      else used = false;
    } else used = false;
    if (used) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }
  };
  window.addEventListener("keydown", S.keyH, true);

  // board: hover / click the targets; click elsewhere on the board does nothing
  const view = viewEl();
  S.moveH = (ev) => {
    if (S.stage !== "target" || S.busy) return;
    const i = hitTarget(ev); if (i >= 0 && i !== S.sel) selectTarget(i);
  };
  S.downH = (ev) => {
    if (!S.open || S.busy || ev.button !== 0) return;
    if (S.stage !== "target" && S.stage !== "confirm") return;
    const i = hitTarget(ev);
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    if (i < 0) return;
    if (S.stage === "confirm") { View.hidePanel(); S.stage = "target"; }
    selectTarget(i, false);
    openPanel();
  };
  view?.addEventListener("pointermove", S.moveH, true);
  view?.addEventListener("pointerdown", S.downH, true);
  // fan: a click anywhere else closes it (as in camp)
  S.outsideH = (ev) => {
    if (S.stage !== "fan" || S.busy) return;
    if (ev.target.closest?.(`.oni-tr-fan, #${BTN_ID}`)) return;
    sfx("back"); close();
  };
  document.addEventListener("pointerdown", S.outsideH, true);
}
function removeKeys() {
  if (S.keyH) window.removeEventListener("keydown", S.keyH, true);
  const view = viewEl();
  if (S.moveH) view?.removeEventListener("pointermove", S.moveH, true);
  if (S.downH) view?.removeEventListener("pointerdown", S.downH, true);
  if (S.outsideH) document.removeEventListener("pointerdown", S.outsideH, true);
  S.keyH = S.moveH = S.downH = S.outsideH = null;
}

function hitTarget(ev) {
  const p = DP.Graph?.clientToWorld?.(ev.clientX, ev.clientY);
  if (!p) return -1;
  return S.targets.findIndex((t) => {
    const g = tileGeom(t.id); if (!g) return false;
    const pad = 8;
    return p.x >= g.x - pad && p.x <= g.x + g.w + pad && p.y >= g.y - pad && p.y <= g.y + g.h + pad;
  });
}

// ── operator flow ─────────────────────────────────────────────────────────────
async function openFan() {
  const why = await DP.Terrarium.clientRefusal();
  if (why) { sfx("buzz"); toast(DP.Terrarium.REASON[why]); return; }
  if (DP.Runtime?.busy || DP.ConfirmDialog?.isOpen) { sfx("buzz"); toast(DP.Terrarium.REASON.busy); return; }
  S.list = await fanList();
  if (!S.list.length) { sfx("buzz"); toast("The party has no Terrarium."); return; }
  S.open = true; S.stage = "fan";
  if (!S.list.some((o) => o.kind === S.focus)) S.focus = (S.list.find((o) => !o.block) ?? S.list[0]).kind;
  View.showFan(S.list, S.focus, { onPick: pickKind, onFocus: (k) => setFocus(k) });
  setButtonActive(true);
  installKeys();
  S.mirror?.close?.();
  S.mirror = globalThis.FUCompanion?.api?.MirrorPrompt?.open?.(MIRROR_KIND, {}, {}) ?? null;
  sendMirror();
  sfx("open");
}
function setFocus(k, snd = true) {
  if (!k || k === S.focus) return;
  S.focus = k; View.focusFan(k); sendMirror();
  if (snd) sfx("move");
}
function stepFan(dir) {
  const i = S.list.findIndex((o) => o.kind === S.focus);
  setFocus(S.list[(i + dir + S.list.length) % S.list.length]?.kind);
}
function pickKind(kind) {
  const o = S.list.find((x) => x.kind === kind);
  if (!o) return;
  if (o.block) { sfx("buzz"); toast(o.block); return; }
  const entry = S.stock?.[kind]?.[0];
  if (!entry) { sfx("buzz"); toast(DP.Terrarium.REASON["no-item"]); return; }
  S.focus = kind;
  View.hideFan();
  startTarget(kind, entry.item.uuid);
}

function startTarget(kind, itemUuid) {
  const ids = [...(DP.Runtime?.neighborIds ?? [])];
  S.armed = kind; S.itemUuid = itemUuid; S.stage = "target";
  S.targets = ids.map((id) => ({ id, ...DP.Terrarium.checkTile(canvas.scene, id, kind) }))
    .filter((t) => tileGeom(t.id))
    .sort((a, b) => tileGeom(a.id).cx - tileGeom(b.id).cx);   // ←/→ walk left to right
  if (!S.targets.length) { toast("There is no tile next to the party."); close(); return; }
  S.sel = Math.max(0, S.targets.findIndex((t) => t.ok));
  Board.draw(kind, S.targets, S.targets[S.sel]?.id);
  View.bubbleFor(S.targets[S.sel], kind);
  View.showHint(`<span>${esc(KIND_NAME[kind])} · choose a tile next to the party</span><span><kbd>←→</kbd>Cycle</span><span><kbd>Z</kbd>Place</span><span><kbd>X</kbd>Back</span>`);
  sendMirror();
  sfx("ok");
}
function selectTarget(i, snd = true) {
  if (!S.targets[i]) return;
  S.sel = i;
  Board.select(S.targets[i].id);
  View.bubbleFor(S.targets[i], S.armed);
  sendMirror();
  if (snd) sfx("move");
}
function openPanel() {
  const t = S.targets[S.sel];
  if (!t) return;
  if (!t.ok) { sfx("buzz"); return; }
  S.stage = "confirm";
  View.showPanel(t, S.armed, { onPlace: place, onBack: () => { sfx("back"); View.hidePanel(); S.stage = "target"; sendMirror(); } });
  sendMirror();
  sfx("ok");
}
function backToFan() {
  sfx("back");
  Board.clear(); View.bubble?.remove(); View.bubble = null; View.hint?.remove(); View.hint = null; View.hidePanel();
  S.stage = "fan"; S.armed = null; S.targets = []; S.sel = -1;
  fanList().then((list) => {
    if (!S.open) return;
    S.list = list;
    if (!list.length) { close(); return; }
    View.showFan(S.list, S.focus, { onPick: pickKind, onFocus: (k) => setFocus(k) });
    sendMirror();
  });
}
async function place() {
  const t = S.targets[S.sel];
  if (!t?.ok || S.busy) return;
  S.busy = true;
  sfx("ok");
  const req = { tileId: t.id, kind: S.armed, itemUuid: S.itemUuid };
  // Clear the picker before the throw; stay "open" (movement blocked) until the GM answers.
  View.clearAll();
  S.mirror?.close?.("placed"); S.mirror = null;
  S.stage = "throwing";
  let res;
  try { res = await DP.Terrarium.request(req); }
  catch (e) { console.error(TAG, e); res = { ok: false, reason: "write-failed" }; }
  S.busy = false;
  close(false);
  if (!res?.ok) { sfx("buzz"); toast(reasonText(res)); }
}
function close(clearView = true) {
  if (clearView) View.clearAll();
  removeKeys();
  S.mirror?.close?.(); S.mirror = null;
  S.open = false; S.stage = null; S.armed = null; S.targets = []; S.sel = -1; S.busy = false;
  setButtonActive(false);
  refreshButton();
}

/** Party Menu → Use: go straight to the tile picker with this item armed. */
async function startWith({ kind, itemUuid }) {
  const why = await DP.Terrarium.clientRefusal();
  if (why) return { ok: false, reason: why };
  if (DP.Runtime?.busy || DP.ConfirmDialog?.isOpen) return { ok: false, reason: "busy" };
  const block = kindBlock(kind, DP.Terrarium.sceneInfo(canvas.scene));
  if (block) return { ok: false, reason: "rule", why: block };
  if (S.open) close();
  S.list = await fanList();
  S.open = true; S.focus = kind;
  setButtonActive(true);
  installKeys();
  S.mirror = globalThis.FUCompanion?.api?.MirrorPrompt?.open?.(MIRROR_KIND, {}, {}) ?? null;
  startTarget(kind, itemUuid);
  return { ok: true };
}

// ── watchers (MirrorPrompt) ───────────────────────────────────────────────────
function installMirror() {
  globalThis.FUCompanion?.api?.MirrorPrompt?.register?.(MIRROR_KIND, {
    show(ctx) {
      if (S.open) return null;   // this client is operating something itself
      let last = {};
      const apply = (st) => {
        if (!canvas?.ready) return;
        const stage = st.stage;
        if (stage === "fan") {
          if (last.stage !== "fan" || JSON.stringify(last.list) !== JSON.stringify(st.list)) {
            Board.clear(); View.bubble?.remove(); View.bubble = null; View.hint?.remove(); View.hint = null; View.hidePanel();
            View.showFan(st.list ?? [], st.focus, { watching: true });
          } else View.focusFan(st.focus);
        } else if (stage === "target" || stage === "confirm") {
          View.hideFan(false);
          const targets = st.targets ?? [];
          if (last.armed !== st.armed || JSON.stringify(last.targets) !== JSON.stringify(targets)) Board.draw(st.armed, targets, st.sel);
          else Board.select(st.sel);
          const t = targets.find((x) => x.id === st.sel);
          if (last.sel !== st.sel || last.stage !== stage) View.bubbleFor(t, st.armed);
          if (stage === "confirm" && t?.ok) { if (last.stage !== "confirm" || last.sel !== st.sel) View.showPanel(t, st.armed, { watching: true }); }
          else View.hidePanel();
        }
        last = st;
      };
      View.showWait(`${ctx.operatorName} is choosing a Terrarium…`);
      apply(ctx.state ?? {});
      return {
        patch(st) { apply({ ...last, ...st }); },
        close() { View.clearAll(); },
      };
    },
  });
}

// ── the 🌱 button ─────────────────────────────────────────────────────────────
let _btn = null, _refreshT = null;
function setButtonActive(on) { _btn?.classList.toggle("oni-tr-on", !!on); }

async function refreshButton() {
  if (!_btn) return;
  const why = await DP.Terrarium?.clientRefusal?.().catch(() => "not-dungeon");
  const st = await DP.Terrarium?.stock?.().catch(() => null);
  const total = DP.Terrarium?.totalOf?.(st) ?? 0;
  if (!_btn) return;
  _btn.querySelector(".oni-tr-cnt").textContent = String(total);
  const off = !!why || total === 0;
  _btn.classList.toggle("dp-btn-disabled", off);
  _btn.title = why === "not-controller" ? `Terrarium — only the main controller can use this (${total} held)`
    : total === 0 ? "No Terrarium"
    : why ? `Terrarium — ${DP.Terrarium.REASON[why]}`
    : `Terrarium — change a tile next to the party (${total} held)`;
}
const refreshSoon = () => { clearTimeout(_refreshT); _refreshT = setTimeout(() => refreshButton(), 150); };

function showButton() {
  if (_btn?.isConnected) { refreshSoon(); return; }
  injectStyles();
  const b = document.createElement("div");
  b.id = BTN_ID;
  b.className = "oni-dp-mode-btn";
  b.setAttribute("role", "button"); b.setAttribute("aria-label", "Terrarium"); b.tabIndex = 0;
  b.style.cssText = "width:64px;height:64px;bottom:80px;left:168px;font-size:28px";
  b.innerHTML = `🌱<span class="oni-tr-cnt">0</span>`;
  b.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    if (S.busy) return;
    if (S.open) { sfx("back"); close(); return; }
    openFan();
  });
  document.body.appendChild(b);
  _btn = b;
  try { globalThis.oni?.HudDock?.relayoutRow?.(); } catch {}
  requestAnimationFrame(() => _btn?.classList.add("dp-scan-visible"));
  refreshButton();
}
function hideButton() {
  if (S.open) close();
  if (!_btn) return;
  const b = _btn; _btn = null;
  b.classList.remove("dp-scan-visible");
  setTimeout(() => { b.remove(); try { globalThis.oni?.HudDock?.relayoutRow?.(); } catch {} }, 200);
}

// ── install ───────────────────────────────────────────────────────────────────
try { globalThis.oni?.HudDock?.registerSlot?.("dp-terrarium", { order: 25, el: () => _btn }); } catch {}

Hooks.once("ready", () => {
  if (!globalThis.oni?.HudDock?._slots?.has?.("dp-terrarium")) {
    try { globalThis.oni?.HudDock?.registerSlot?.("dp-terrarium", { order: 25, el: () => _btn }); } catch {}
  }
  installMirror();
  for (const h of ["createItem", "updateItem", "deleteItem"]) Hooks.on(h, (item) => { if (_btn && item?.parent) refreshSoon(); });
  for (const h of ["updateActor", "updateUser", "dungeonPathing.terrariumPlaced"]) Hooks.on(h, () => { if (_btn) refreshSoon(); });
  Hooks.on("canvasTearDown", () => { if (S.open) close(); View.clearAll(); });
});

DP.TerrariumUI = {
  get isOpen() { return S.open; },
  showButton, hideButton, startWith, refresh: refreshButton,
  close: () => close(),
};
