// ============================================================================
// Polymorph — UI: the Form Plate (HUD) and the character-sheet banner.
//
// Works in EVERY mode, Theatre included (no token needed): the plate sits in
// the bottom-left HUD stack (HudDock member "polymorph-form-plate", order 25)
// and lists each transformed party member:
//
//   [monster art + PC face inset]  Keren · Inferex
//                                  Until the scene ends  /  2 turns left
//                                  Reverts to 63/85 HP            [Revert]
//
// Revert button: owner or GM, OUTSIDE a live battle only. In battle the free
// "Revert" Objective is the path, so it happens on that creature's own turn.
// The sheet banner (renderActorSheet) carries the same line + button.
// Read-only otherwise: every write goes through FUCompanion.api.polymorph.
// ============================================================================

import { scaleOutOfForm } from "./polymorph-math.js";

const NS = "fabula-ultima-companion";
const ROOT_ID = "oni-polymorph-plate";
const STYLE_ID = "oni-polymorph-plate-style";
const DOCK_ID = "polymorph-form-plate";
const hudDock = () => globalThis.oni?.HudDock ?? null;
const api = () => globalThis.FUCompanion?.api?.polymorph ?? null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isNpc = (a) => { const p = a?.system?.props ?? {}; return !!(String(p.npc_rank ?? "").trim() || String(p.species ?? "").trim()); };

function battleLive() {
  try { return !!globalThis.FUCompanion?.api?.experimental?.battleDirector?.isRunning?.(); } catch { return false; }
}

/** One plate row's data for a transformed actor (pure read). */
export function formLine(actor) {
  const f = api()?.getForm?.(actor);
  if (!f) return null;
  const p = actor.system?.props ?? {};
  const s = f.start ?? null;
  const hpBack = scaleOutOfForm(Number(p.current_hp ?? 0), f.form?.maxHp, f.own?.maxHp, s && { ownStart: s.ownHp, formStart: s.formHp });
  const left = f.counter?.turnsLeft;
  return {
    actor, formName: f.formName, formImg: f.formImg || f.formTokenImg || "icons/svg/mystery-man.svg",
    when: Number.isFinite(left) && battleLive() ? `${left} turn${left === 1 ? "" : "s"} left` : "Until the scene ends",
    reverts: `Reverts to ${hpBack}/${f.own?.maxHp ?? "?"} HP`,
    canRevert: !battleLive() && (game.user?.isGM || actor.isOwner),
  };
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
#${ROOT_ID} { position: fixed; z-index: 99996; left: 20px; display: flex; flex-direction: column; gap: 6px;
  font-family: Signika, sans-serif; pointer-events: none; }
#${ROOT_ID} .pf-row { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 7px 10px 7px 8px;
  border-radius: 10px; background: linear-gradient(180deg,#3f3557,#2c2440); color: #efe8ff;
  border: 2px solid #7d68b3; box-shadow: 0 6px 18px rgba(0,0,0,.45); animation: oni-pf-in .9s cubic-bezier(.22,.68,.32,1); }
#${ROOT_ID} .pf-art { position: relative; width: 42px; height: 42px; flex: 0 0 auto; }
#${ROOT_ID} .pf-art > img.pf-form { width: 42px; height: 42px; object-fit: contain; border: none; }
#${ROOT_ID} .pf-art > img.pf-face { position: absolute; right: -4px; bottom: -4px; width: 20px; height: 20px;
  border-radius: 50%; object-fit: cover; border: 2px solid #efe8ff; background: #2c2440; }
#${ROOT_ID} .pf-t { font-size: 13px; font-weight: 700; line-height: 1.15; }
#${ROOT_ID} .pf-s { font-size: 11px; opacity: .85; }
#${ROOT_ID} .pf-btn, .oni-pf-banner .pf-btn { margin-left: 6px; padding: 3px 9px; border-radius: 7px; cursor: pointer;
  background: linear-gradient(180deg,#d9cdf7,#b7a6e6); color: #2c2440; font-weight: 800; font-size: 12px;
  border: 1px solid #7d68b3; }
#${ROOT_ID} .pf-btn:hover, .oni-pf-banner .pf-btn:hover { filter: brightness(1.08); }
@keyframes oni-pf-in { from { opacity: 0; transform: translateX(calc(-100% - 40px)); } 60% { opacity: 1; }
  to { opacity: 1; transform: translateX(0); } }
.oni-pf-banner { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; padding: 6px 10px; border-radius: 8px;
  background: linear-gradient(180deg,#3f3557,#2c2440); color: #efe8ff; border: 2px solid #7d68b3; font-family: Signika, sans-serif; }
.oni-pf-banner img { width: 32px; height: 32px; object-fit: contain; border: none; }
.oni-pf-banner .pf-t { font-weight: 700; font-size: 13px; }
.oni-pf-banner .pf-s { font-size: 11px; opacity: .85; }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .pf-row { animation: none; } }
`;
  document.head.appendChild(s);
}

async function doRevert(actorUuid) {
  const a = await fromUuid(actorUuid).catch(() => null);
  if (!a) return;
  const r = await api()?.revert?.(a, { reason: "voluntary" });
  if (!r?.ok) ui.notifications?.warn(`Couldn't revert ${a.name} (${r?.reason ?? "?"}).`);
}

const Plate = {
  el: null,
  _unreg: null,
  refresh() {
    // In a live battle the form shows in the battle UI's own language instead:
    // a buff pip with its turns left (status-classifier + AELifetime), and
    // Revert in the Objective menu. The plate would sit on the GM desk.
    if (battleLive()) return this.hide();
    const lines = (api()?.listTransformed?.() ?? [])
      .filter((a) => !isNpc(a) && (a.hasPlayerOwner || game.user?.isGM))
      .map(formLine).filter(Boolean);
    if (!lines.length) return this.hide();
    injectStyles();
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.id = ROOT_ID;
      this.el.addEventListener("click", (ev) => {
        const b = ev.target.closest?.("[data-pf-revert]");
        if (b) { ev.stopPropagation(); doRevert(b.dataset.pfRevert); }
      });
      document.body.appendChild(this.el);
      const dock = hudDock();
      if (dock?.register) {
        this._unreg = dock.register(DOCK_ID, {
          order: 25,
          height: () => (this.el ? Math.round(this.el.getBoundingClientRect().height) : 0),
          apply: (bottom) => { if (this.el) this.el.style.bottom = `${bottom}px`; },
        });
      } else this.el.style.bottom = "154px";
    }
    this.el.innerHTML = lines.map((l) => `
      <div class="pf-row" data-actor="${esc(l.actor.uuid)}">
        <span class="pf-art"><img class="pf-form" src="${esc(l.formImg)}" alt=""><img class="pf-face" src="${esc(l.actor.img)}" alt=""></span>
        <span><span class="pf-t">${esc(l.actor.name)} · ${esc(l.formName)}</span>
          <span class="pf-s" style="display:block">${esc(l.when)}</span>
          <span class="pf-s" style="display:block">${esc(l.reverts)}</span></span>
        ${l.canRevert ? `<span class="pf-btn" data-pf-revert="${esc(l.actor.uuid)}" title="Return to your own body">Revert</span>` : ""}
      </div>`).join("");
    try { hudDock()?.relayout?.({ defer: true }); } catch {}
  },
  hide() {
    if (!this.el) return;
    try { this._unreg?.(); } catch {}
    this._unreg = null;
    this.el.remove();
    this.el = null;
    try { hudDock()?.relayout?.({ defer: true }); } catch {}
  },
};

let _t = null;
const refreshSoon = () => { clearTimeout(_t); _t = setTimeout(() => { try { Plate.refresh(); } catch (e) { console.warn("[Polymorph UI]", e); } }, 60); };

function bannerHtml(actor) {
  const l = formLine(actor);
  if (!l) return null;
  return `<div class="oni-pf-banner"><img src="${esc(l.formImg)}" alt="">
    <span><span class="pf-t">Transformed: ${esc(l.formName)}</span>
      <span class="pf-s" style="display:block">${esc(l.when)} · ${esc(l.reverts)}</span></span>
    ${l.canRevert ? `<span class="pf-btn" data-pf-revert="${esc(actor.uuid)}">Revert</span>` : ""}</div>`;
}

Hooks.once("ready", () => {
  for (const h of ["fuPolymorphTransformed", "fuPolymorphReverted", "canvasReady", "deleteCombat", "fu-director-started", "fu-director-stopped"]) Hooks.on(h, refreshSoon);
  Hooks.on("updateActor", (a, ch) => { if (ch?.flags?.[NS] || ch?.system?.props?.current_hp !== undefined) refreshSoon(); });
  Hooks.on("renderActorSheet", (app, html) => {
    try {
      const actor = app?.actor ?? app?.document;
      const root = html?.[0] ?? html;
      root?.querySelector?.(".oni-pf-banner")?.remove();
      const b = actor && bannerHtml(actor);
      if (!b) return;
      injectStyles();
      const host = root?.querySelector?.(".window-content") ?? root;
      host?.insertAdjacentHTML?.("afterbegin", b);
      host?.querySelector?.("[data-pf-revert]")?.addEventListener("click", (ev) => { ev.preventDefault(); doRevert(actor.uuid); });
    } catch (e) { console.warn("[Polymorph UI] sheet banner failed", e); }
  });
  refreshSoon();
});
