// ============================================================================
// Out-of-Combat Healing — HUD styles (injected once).
//
// Warm parchment theme — palette matched to the camp/shop UIs
// (--camp-parchment / wood / gold / ink) so the heal menu reads as part of the
// same game.
// ============================================================================

const STYLE_ID = "oni-healing-hud-styles";

export function injectHealingStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.oni-heal-overlay {
  --hl-parch-1: #f6ebd3; --hl-parch-2: #efdfc3; --hl-parch-3: #e7d3b1;
  --hl-wood-1: #a87649; --hl-wood-2: #8d5f38; --hl-wood-3: #6f4526;
  --hl-gold-1: #f4d488; --hl-gold-2: #caa44d; --hl-gold-3: #9a7a2b;
  --hl-ink: #3b2a19; --hl-glow: rgba(250,230,160,.55);
  --hl-hp: #2f7d32; --hl-mp: #2f5fae; --hl-ip: #9a7a2b;
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  background: rgba(18, 10, 5, 0.66);
  font-family: "Signika","Noto Sans","Segoe UI",sans-serif; color: var(--hl-ink);
  opacity: 0; transition: opacity .18s ease;
}
.oni-heal-overlay.visible { opacity: 1; }

.oni-heal-frame {
  display: flex; flex-direction: column;
  width: min(1040px, 94vw); height: min(640px, 90vh);
  background: var(--hl-parch-1);
  border: 2.5px solid var(--hl-wood-2); border-radius: 14px;
  box-shadow: 0 0 0 1px var(--hl-wood-3), 0 18px 60px rgba(0,0,0,0.55), inset 0 0 26px rgba(160,118,73,0.18);
  overflow: hidden;
  opacity: 0; transform: translateY(34px) scale(0.985);
  transition: transform .30s cubic-bezier(.22,.8,.3,1), opacity .30s ease;
}
.oni-heal-overlay.visible .oni-heal-frame { opacity: 1; transform: translateY(0) scale(1); }
.oni-heal-overlay.closing { opacity: 0; }
.oni-heal-overlay.closing .oni-heal-frame { opacity: 0; transform: translateY(34px) scale(0.985); }

.oni-heal-header {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 18px; border-bottom: 2px solid var(--hl-wood-2);
  background: linear-gradient(180deg, var(--hl-gold-1) 0%, var(--hl-gold-2) 60%, var(--hl-gold-3) 100%);
  color: #4b3517;
}
.oni-heal-header .title { font-size: 20px; font-weight: 700; letter-spacing: .5px; text-shadow: 0 1px 0 rgba(255,255,255,.35); }
.oni-heal-header .title .heart { color: #b8392f; margin-right: 6px; }
.oni-heal-header .caster { margin-left: auto; font-size: 13px; }
.oni-heal-header .caster b { color: #5a3800; }
.oni-heal-close {
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
  display: grid; place-items: center; font-size: 18px; line-height: 1; color: #4b3517;
  background: rgba(255,255,255,0.25); border: 1px solid rgba(90,60,34,0.5);
}
.oni-heal-close:hover { background: rgba(180,57,47,0.85); color: #fff; }

.oni-heal-body { display: flex; flex: 1; min-height: 0; }

/* ── Left: action list with tabs ── */
.oni-heal-left {
  width: 34%; min-width: 300px; display: flex; flex-direction: column;
  border-right: 2px solid var(--hl-wood-2); background: var(--hl-parch-2);
}
.oni-heal-tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
.oni-heal-tab {
  flex: 1; text-align: center; padding: 9px 0; cursor: pointer;
  font-size: 14px; font-weight: 700; border-radius: 8px 8px 0 0; color: var(--hl-wood-3);
  background: var(--hl-parch-3); border: 1.5px solid rgba(120,86,40,.4); border-bottom: none;
  opacity: .8; transition: all .12s ease;
}
.oni-heal-tab .count { font-size: 11px; opacity: .7; margin-left: 5px; }
.oni-heal-tab:hover { opacity: 1; }
.oni-heal-tab.active {
  opacity: 1; color: #4b3517;
  background: linear-gradient(180deg, var(--hl-gold-1), var(--hl-gold-2));
  border-color: var(--hl-wood-2);
}
.oni-heal-list {
  flex: 1; overflow-y: auto; padding: 8px 12px 12px;
  display: flex; flex-direction: column; gap: 6px;
  scrollbar-width: thin; scrollbar-color: var(--hl-wood-2) var(--hl-parch-3);
}
.oni-heal-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; border: 1.5px solid rgba(120,86,40,.35);
  background: var(--hl-parch-1); transition: all .1s ease;
}
.oni-heal-row:hover { border-color: var(--hl-gold-2); background: #fff7e2; }
.oni-heal-row.sel {
  border-color: var(--hl-wood-2); background: #fff3d4;
  box-shadow: 0 0 0 1px var(--hl-gold-2), 0 0 12px var(--hl-glow);
}
.oni-heal-row.disabled { opacity: .5; cursor: not-allowed; }
.oni-heal-row img { width: 38px; height: 38px; border-radius: 7px; object-fit: cover; flex: 0 0 auto; background: rgba(120,86,40,.18); border: 1px solid rgba(90,60,34,.4); }
.oni-heal-row .meta { flex: 1; min-width: 0; }
.oni-heal-row .name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oni-heal-row .sub { font-size: 11px; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oni-heal-row .src-tag { color: var(--hl-wood-2); margin-right: 4px; }
.oni-heal-row .badges { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: 0 0 auto; }
.oni-heal-row .heal-badge { font-size: 12px; font-weight: 800; color: var(--hl-hp); }
.oni-heal-row .cost-badge { font-size: 11px; opacity: .85; color: var(--hl-wood-3); }
.oni-heal-row.disabled .cost-badge { color: #a83232; }
.oni-heal-empty { opacity: .55; text-align: center; padding: 30px 10px; font-size: 13px; }

/* ── Right: 2×2 party panel ── */
.oni-heal-right { flex: 1; display: flex; flex-direction: column; padding: 12px; min-width: 0; }
.oni-heal-banner {
  text-align: center; font-size: 13px; padding: 8px; border-radius: 8px; margin-bottom: 10px;
  background: var(--hl-parch-3); border: 1px solid rgba(120,86,40,.3); min-height: 18px;
}
.oni-heal-banner.armed { background: linear-gradient(180deg,#d8f0c4,#bfe3a6); border-color: #6fa04a; color: #1f4a14; font-weight: 700; }
.oni-heal-grid {
  flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-auto-rows: 112px;
  align-content: start; gap: 22px 16px; min-height: 0; padding: 24px 6px 6px 12px;
  overflow: visible;
}
/* Rectangle cell: short + wide. Left area is reserved (padding-left) for the
   floating battle sprite that pops out beyond the panel edge. */
.oni-heal-cell {
  display: flex; align-items: center; height: 112px;
  padding: 10px 16px 10px 118px;
  border-radius: 12px; border: 1.5px solid rgba(120,86,40,.45);
  background: var(--hl-parch-1);
  box-shadow: inset 0 0 18px rgba(160,118,73,0.12);
  cursor: pointer; transition: border-color .12s ease, box-shadow .12s ease, background .12s ease, transform .12s ease;
  position: relative; overflow: visible;
}
.oni-heal-cell.empty { opacity: .35; cursor: default; }
.oni-heal-cell.sel.targeting {
  border-color: var(--hl-wood-2);
  box-shadow: 0 0 0 2px var(--hl-gold-2), 0 0 22px var(--hl-glow);
  transform: translateY(-2px); background: #fff5db;
}
/* Floating, detached battle sprite — larger than the cell, anchored to the
   bottom-left and overflowing the top so it "pops out" of the panel. */
.oni-heal-sprite-wrap {
  position: absolute; left: -10px; bottom: -2px; width: 130px; height: 150px;
  display: flex; align-items: flex-end; justify-content: center;
  pointer-events: none; z-index: 3;
}
.oni-heal-sprite {
  max-width: 100%; max-height: 100%; width: auto; height: auto;
  object-fit: contain; object-position: bottom;
  filter: drop-shadow(0 5px 6px rgba(40,24,10,.55));
}
.oni-heal-cell .pc-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.oni-heal-cell .pc-name { font-size: 18px; font-weight: 800; color: var(--hl-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.oni-heal-res { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.oni-heal-res .rlabel { width: 28px; font-size: 12px; font-weight: 800; letter-spacing: .5px; }
.oni-heal-res .rval { font-size: 15px; font-weight: 700; color: var(--hl-ink); }
.oni-heal-res.hp .rlabel { color: var(--hl-hp); }
.oni-heal-res.mp .rlabel { color: var(--hl-mp); }
.oni-heal-res.ip .rlabel { color: var(--hl-ip); }
.oni-heal-cell .flash {
  position: absolute; inset: 0; background: rgba(120,200,90,0.45);
  opacity: 0; pointer-events: none; border-radius: 12px;
}
.oni-heal-cell .flash.go { animation: oniHealFlash .55s ease; }
@keyframes oniHealFlash { 0% { opacity: .65; } 100% { opacity: 0; } }

/* Staggered cell entrance / exit (slide + fade). Per-cell delay is set inline
   by the controller; the closing overlay reverses the slide direction. */
@keyframes oniHealCellIn  { from { opacity: 0; transform: translateX(38px); } to { opacity: 1; transform: translateX(0); } }
@keyframes oniHealCellOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(38px); } }
.oni-heal-cell.intro-cell { animation: oniHealCellIn .34s cubic-bezier(.22,.8,.3,1) both; }
.oni-heal-overlay.closing .oni-heal-cell { animation: oniHealCellOut .26s ease both; }

.oni-heal-footer {
  display: flex; gap: 18px; justify-content: center; flex-wrap: wrap;
  padding: 9px; border-top: 2px solid var(--hl-wood-2); background: var(--hl-parch-2);
  font-size: 12px; color: var(--hl-wood-3);
}
.oni-heal-footer .k {
  display: inline-block; min-width: 18px; text-align: center; padding: 1px 6px; margin-right: 5px;
  border-radius: 5px; background: linear-gradient(180deg, var(--hl-gold-1), var(--hl-gold-2));
  border: 1px solid var(--hl-wood-2); color: #4b3517; font-weight: 800; font-size: 11px;
}
`;
  document.head.appendChild(s);
}
