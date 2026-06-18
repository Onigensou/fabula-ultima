// ============================================================================
// Out-of-Combat Healing — HUD styles (injected once).
// ============================================================================

const STYLE_ID = "oni-healing-hud-styles";

export function injectHealingStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
.oni-heal-overlay {
  position: fixed; inset: 0; z-index: 120;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at center, rgba(8,12,24,0.78), rgba(4,6,14,0.92));
  font-family: "Signika", sans-serif; color: #e9eef7;
  opacity: 0; transition: opacity .18s ease;
}
.oni-heal-overlay.visible { opacity: 1; }

.oni-heal-frame {
  display: flex; flex-direction: column;
  width: min(1040px, 94vw); height: min(680px, 92vh);
  background: linear-gradient(180deg, rgba(20,26,44,0.97), rgba(14,18,32,0.98));
  border: 2px solid #3a4a78; border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(120,160,255,0.08);
  overflow: hidden; transform: translateY(8px) scale(0.99);
  transition: transform .18s ease;
}
.oni-heal-overlay.visible .oni-heal-frame { transform: translateY(0) scale(1); }

.oni-heal-header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px; border-bottom: 1px solid rgba(120,160,255,0.18);
  background: linear-gradient(90deg, rgba(40,60,110,0.5), rgba(20,28,52,0.2));
}
.oni-heal-header .title { font-size: 20px; font-weight: 700; letter-spacing: .5px; }
.oni-heal-header .title .heart { color: #ff7a93; margin-right: 6px; }
.oni-heal-header .caster { margin-left: auto; font-size: 13px; opacity: .8; }
.oni-heal-header .caster b { color: #ffd98a; }
.oni-heal-close {
  width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
  display: grid; place-items: center; font-size: 18px; line-height: 1;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
}
.oni-heal-close:hover { background: rgba(255,90,110,0.25); }

.oni-heal-body { display: flex; flex: 1; min-height: 0; }

/* ── Left: action list with tabs ── */
.oni-heal-left {
  width: 46%; display: flex; flex-direction: column;
  border-right: 1px solid rgba(120,160,255,0.15);
}
.oni-heal-tabs { display: flex; gap: 4px; padding: 10px 12px 0; }
.oni-heal-tab {
  flex: 1; text-align: center; padding: 9px 0; cursor: pointer;
  font-size: 14px; font-weight: 600; border-radius: 8px 8px 0 0;
  background: rgba(255,255,255,0.04); border: 1px solid transparent; border-bottom: none;
  opacity: .65; transition: all .12s ease;
}
.oni-heal-tab .count { font-size: 11px; opacity: .7; margin-left: 5px; }
.oni-heal-tab:hover { opacity: .9; }
.oni-heal-tab.active {
  opacity: 1; background: rgba(60,84,150,0.45);
  border-color: rgba(120,160,255,0.4); color: #fff;
}
.oni-heal-list {
  flex: 1; overflow-y: auto; padding: 8px 12px 12px;
  display: flex; flex-direction: column; gap: 6px;
  scrollbar-width: thin;
}
.oni-heal-row {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; border: 1px solid transparent;
  background: rgba(255,255,255,0.035); transition: all .1s ease;
}
.oni-heal-row:hover { background: rgba(255,255,255,0.07); }
.oni-heal-row.sel {
  border-color: #7aa2ff; background: rgba(80,120,220,0.28);
  box-shadow: 0 0 0 1px rgba(122,162,255,0.4), 0 0 14px rgba(80,120,220,0.25);
}
.oni-heal-row.disabled { opacity: .42; cursor: not-allowed; }
.oni-heal-row img { width: 38px; height: 38px; border-radius: 7px; object-fit: cover; flex: 0 0 auto; background: rgba(0,0,0,0.3); }
.oni-heal-row .meta { flex: 1; min-width: 0; }
.oni-heal-row .name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oni-heal-row .sub { font-size: 11px; opacity: .72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oni-heal-row .src-tag { color: #ffd98a; margin-right: 4px; }
.oni-heal-row .badges { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex: 0 0 auto; }
.oni-heal-row .heal-badge { font-size: 12px; font-weight: 700; color: #6fe08a; }
.oni-heal-row .cost-badge { font-size: 11px; opacity: .85; }
.oni-heal-row.disabled .cost-badge { color: #ff8a8a; }
.oni-heal-empty { opacity: .5; text-align: center; padding: 30px 10px; font-size: 13px; }

/* ── Right: 2×2 party panel ── */
.oni-heal-right { flex: 1; display: flex; flex-direction: column; padding: 12px; min-width: 0; }
.oni-heal-banner {
  text-align: center; font-size: 13px; padding: 8px; border-radius: 8px; margin-bottom: 10px;
  background: rgba(255,255,255,0.04); opacity: .8; min-height: 18px;
}
.oni-heal-banner.armed { background: rgba(80,200,120,0.18); color: #b7f5c8; opacity: 1; font-weight: 600; }
.oni-heal-grid {
  flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
  gap: 12px; min-height: 0;
}
.oni-heal-cell {
  display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border-radius: 12px; border: 1px solid rgba(120,160,255,0.18);
  background: linear-gradient(180deg, rgba(30,38,64,0.7), rgba(18,24,42,0.7));
  cursor: pointer; transition: all .12s ease; position: relative; overflow: hidden;
}
.oni-heal-cell.empty { opacity: .3; cursor: default; }
.oni-heal-cell.sel.targeting {
  border-color: #6fe08a; box-shadow: 0 0 0 2px rgba(111,224,138,0.5), 0 0 22px rgba(111,224,138,0.3);
  transform: translateY(-2px);
}
.oni-heal-cell .pc-head { display: flex; align-items: center; gap: 10px; }
.oni-heal-cell .pc-portrait { width: 46px; height: 46px; border-radius: 9px; object-fit: cover; background: rgba(0,0,0,0.3); flex: 0 0 auto; }
.oni-heal-cell .pc-name { font-size: 16px; font-weight: 700; }
.oni-heal-bars { display: flex; flex-direction: column; gap: 7px; margin-top: 2px; }
.oni-heal-bar { display: flex; align-items: center; gap: 8px; }
.oni-heal-bar .lbl { width: 22px; font-size: 11px; font-weight: 700; opacity: .85; }
.oni-heal-bar .track { flex: 1; height: 13px; border-radius: 7px; background: rgba(0,0,0,0.4); overflow: hidden; }
.oni-heal-bar .fill { height: 100%; border-radius: 7px; transition: width .35s cubic-bezier(.22,.8,.3,1); }
.oni-heal-bar .num { width: 74px; text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; opacity: .9; }
.oni-heal-cell .flash {
  position: absolute; inset: 0; background: rgba(111,224,138,0.35);
  opacity: 0; pointer-events: none;
}
.oni-heal-cell .flash.go { animation: oniHealFlash .55s ease; }
@keyframes oniHealFlash { 0% { opacity: .6; } 100% { opacity: 0; } }

.oni-heal-footer {
  display: flex; gap: 18px; justify-content: center; flex-wrap: wrap;
  padding: 9px; border-top: 1px solid rgba(120,160,255,0.15);
  font-size: 12px; opacity: .72;
}
.oni-heal-footer .k {
  display: inline-block; min-width: 18px; text-align: center; padding: 1px 6px; margin-right: 5px;
  border-radius: 5px; background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.18);
  font-weight: 700; font-size: 11px;
}
`;
  document.head.appendChild(s);
}
