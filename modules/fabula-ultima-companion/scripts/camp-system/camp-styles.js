// ============================================================================
// Camp System — CSS Injection
// ============================================================================
(() => {
  const STYLE_ID = "oni-camp-system-style";
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `

/* ── Theme tokens ───────────────────────────────────────────────────────────── */
:root {
  --camp-parchment-1: #f6ebd3;
  --camp-parchment-2: #efdfc3;
  --camp-parchment-3: #e7d3b1;
  --camp-wood-1: #a87649;
  --camp-wood-2: #8d5f38;
  --camp-wood-3: #6f4526;
  --camp-gold-1: #f4d488;
  --camp-gold-2: #caa44d;
  --camp-gold-3: #9a7a2b;
  --camp-ink: #3b2a19;
  --camp-shadow: rgba(0,0,0,.35);
  --camp-glow: rgba(250,230,160,.55);
  --camp-radius: 14px;
}

/* ── Animations ─────────────────────────────────────────────────────────────── */
@keyframes campFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes campFadeOut {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(8px); }
}
@keyframes campSlideIn {
  from { opacity: 0; transform: translateX(-16px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes campRowSlideIn {
  from { opacity: 0; transform: translateX(-22px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes campPulse {
  0%, 100% { box-shadow: 0 0 8px var(--camp-glow); }
  50%       { box-shadow: 0 0 20px var(--camp-glow), 0 0 40px rgba(250,230,160,.3); }
}
@keyframes campScreenDark {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes campPanelSlideUp {
  from { opacity: 0; transform: translateY(36px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes campLogSlideIn {
  from { opacity: 0; transform: translateX(28px); }
  to   { opacity: 1; transform: translateX(0); }
}

/* ── Parchment panel (base) ─────────────────────────────────────────────────── */
.oni-camp-panel {
  position: relative;
  padding: 18px 20px;
  border-radius: var(--camp-radius);
  background: var(--camp-parchment-1);   /* solid — no transparencies */
  color: var(--camp-ink);
  border: 2.5px solid var(--camp-wood-2);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.55),
    0 0 0 1px var(--camp-wood-3),
    0 0 0 6px rgba(90,60,34,.45),
    0 0 0 7px rgba(40,24,10,.6),
    0 18px 40px rgba(0,0,0,.65);
  font-family: "Signika","Noto Sans","Inter","Segoe UI",system-ui,-apple-system,sans-serif;
  animation: campFadeIn .25s ease both;
}

/* Solid wood outer frame — no stripes */
.oni-camp-panel::before {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 20px;
  background: linear-gradient(145deg, #9a6836 0%, #7a4e25 40%, #5c3618 70%, #7a4e25 100%);
  box-shadow: 0 0 0 1px rgba(30,16,6,.85), 0 10px 35px rgba(0,0,0,.55);
  z-index: -1;
}

/* Brass stud corner accent */
.oni-camp-panel::after {
  content: "";
  position: absolute;
  width: 9px; height: 9px;
  border-radius: 50%;
  top: 8px; left: 8px;
  background:
    radial-gradient(circle at 35% 35%, #fff8, #fff0 55%),
    linear-gradient(180deg, var(--camp-gold-1), var(--camp-gold-2) 60%, var(--camp-gold-3));
  box-shadow: 0 0 8px rgba(220,180,80,.5);
}

/* Panel title plaque */
.oni-camp-panel__title {
  margin: -10px 0 12px;
  padding: 6px 14px;
  display: inline-block;
  border-radius: 999px;
  border: 1px solid rgba(120,86,40,.5);
  background: linear-gradient(180deg, #fff7d5 0%, #f1dca2 60%, #e2c46e 100%);
  color: #5c421e;
  font-weight: 700;
  font-size: 1.05em;
  letter-spacing: .4px;
  text-shadow: 0 1px 0 rgba(255,255,255,.6);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.65),
    0 0 0 3px rgba(90,60,34,.25),
    0 6px 14px rgba(0,0,0,.18);
}

.oni-camp-panel hr {
  border: none; height: 1px; margin: 10px 0;
  background: linear-gradient(90deg, transparent, rgba(92,66,30,.55), transparent);
  opacity: .6;
}

/* ── Inner content panel (light inset for readable text) ───────────────────── */
.oni-camp-inner-panel {
  background: rgba(255, 248, 232, 0.88);
  border-radius: 10px;
  border: 1px solid rgba(120, 80, 40, 0.2);
  padding: 12px 16px;
  margin: 8px 0;
  color: var(--camp-ink);
}

/* ── JRPG Button ────────────────────────────────────────────────────────────── */
.oni-camp-btn {
  appearance: none;
  border: 1px solid rgba(90,60,34,.65);
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 700;
  font-size: .95em;
  cursor: pointer;
  background: linear-gradient(180deg, var(--camp-gold-1) 0%, var(--camp-gold-2) 60%, var(--camp-gold-3) 100%);
  color: #4b3517;
  text-shadow: 0 1px 0 rgba(255,255,255,.6);
  font-family: inherit;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.6),
    0 0 0 2px rgba(90,60,34,.28),
    0 8px 18px rgba(0,0,0,.2);
  transition: transform .06s ease, box-shadow .12s ease, filter .12s ease;
}
.oni-camp-btn:hover  { filter: brightness(1.08) saturate(1.05); }
.oni-camp-btn:active { transform: translateY(1px); box-shadow: inset 0 1px 0 rgba(0,0,0,.08), 0 0 0 2px rgba(90,60,34,.28), 0 4px 10px rgba(0,0,0,.25); }
.oni-camp-btn.ready  { background: linear-gradient(180deg, #a8e6a0 0%, #7ec87a 60%, #5aaa55 100%); color: #1a3a18; }
.oni-camp-btn.danger { background: linear-gradient(180deg, #e09090 0%, #c07070 60%, #a05050 100%); color: #3a1010; }

/* ── Full-screen overlay (dim backdrop) ─────────────────────────────────────── */
#oni-camp-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(18, 10, 5, 0.72);   /* semi-transparent — game still visible */
  display: flex;
  align-items: center;
  justify-content: center;
  animation: campFadeIn .35s ease both;
}
#oni-camp-overlay.out { animation: campFadeOut .25s ease both; }

/* ── Sleep screen ───────────────────────────────────────────────────────────── */
#oni-camp-sleep-screen {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: #000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 1.2s ease;
}
#oni-camp-sleep-screen.dark { opacity: 1; pointer-events: all; }

/* ── Activity Select UI — 2-column layout ────────────────────────────────────── */
.oni-camp-activity-panel {
  width: min(820px, 94vw);
  height: min(580px, 88vh);
  display: flex;
  flex-direction: column;
}

/* Body: list left + desc right */
.oni-camp-act-body {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  margin-top: 8px;
}

/* Left column */
.oni-camp-act-list-col {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.oni-camp-act-rows {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--camp-wood-2) var(--camp-parchment-3);
  padding-right: 4px;
  background: var(--camp-parchment-2);
  border-radius: 8px;
  border: 1px solid rgba(120,80,40,.25);
}

/* Row item */
.oni-camp-act-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1.5px solid transparent;
  margin-bottom: 2px;
  cursor: pointer;
  user-select: none;
  position: relative;
  transition: background .12s ease, border-color .12s ease;
}
.oni-camp-act-row:hover:not(.locked-other) {
  background: rgba(202,164,77,.14);
  border-color: rgba(202,164,77,.38);
}
.oni-camp-spectator .oni-camp-act-row {
  cursor: default;
}
.oni-camp-spectator .oni-camp-act-row:hover {
  background: transparent;
  border-color: transparent;
}
.oni-camp-act-row.act-focused {
  background: rgba(202,164,77,.1);
  border-color: rgba(202,164,77,.28);
}
.oni-camp-act-row.locked-self {
  background: rgba(100,190,95,.16);
  border-color: rgba(100,190,95,.55);
}
.oni-camp-act-row.locked-other {
  cursor: not-allowed;
}
.oni-camp-act-row.hov-self { border-color: var(--camp-gold-2); }

.act-row-icon {
  width: 20px;
  display: flex; align-items: center; justify-content: center;
  color: var(--camp-wood-2);
  font-size: .88em;
  flex-shrink: 0;
}
.act-row-name {
  flex: 1;
  font-size: .88em;
  font-weight: 600;
  color: var(--camp-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.act-row-tag {
  font-size: .68em;
  font-weight: 700;
  color: var(--camp-wood-3);
  white-space: nowrap;
  flex-shrink: 0;
}
.locked-self .act-row-tag  { color: #3a7a35; }
.locked-other .act-row-tag { color: #8a5020; }

/* Right column — description */
.oni-camp-act-desc-col {
  flex: 1;
  min-width: 0;
  background: var(--camp-parchment-3);   /* solid parchment shade */
  border: 1.5px solid var(--camp-wood-2);
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
#oni-camp-act-desc-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.act-desc-placeholder {
  font-size: .85em;
  opacity: .5;
  font-style: italic;
  text-align: center;
  margin-top: 48px;
  color: var(--camp-wood-2);
}
.act-desc-icon {
  font-size: 1.8em;
  color: var(--camp-wood-2);
}
.act-desc-name {
  font-size: 1.1em;
  font-weight: 700;
  color: var(--camp-ink);
}
.act-desc-target {
  font-size: .8em;
  font-style: italic;
  color: var(--camp-wood-2);
}
.act-desc-divider {
  height: 1px;
  background: var(--camp-wood-2);
  opacity: .3;
  margin: 4px 0;
}
.act-desc-body {
  font-size: .86em;
  line-height: 1.55;
  color: var(--camp-ink);
}

/* Activity confirm footer */
.oni-camp-act-confirm-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.oni-camp-act-lobby-dots {
  display: flex;
  gap: 5px;
  align-items: center;
  flex: 1;
}
#oni-camp-act-confirm {
  min-width: 140px;
}
#oni-camp-act-confirm.confirmed,
#oni-bond-confirm.confirmed {
  background: linear-gradient(180deg, #a8e6a0 0%, #7ec87a 60%, #5aaa55 100%);
  color: #1a3a18;
  border-color: rgba(60,140,55,.7);
}
#oni-camp-act-confirm:disabled {
  opacity: .4;
  cursor: not-allowed;
  filter: none;
}
.act-row-item.confirmed-locked { opacity: .55; cursor: not-allowed; }

/* Footer */
.oni-camp-act-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(92,66,30,.2);
  flex-wrap: wrap;
  gap: 6px;
}
.act-footer-status {
  font-size: .82em;
  opacity: .65;
}

/* GM override strip */
.oni-camp-gm-override {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  margin-top: 4px;
  border-radius: 8px;
  background: rgba(180,120,40,.12);
  border: 1px dashed rgba(180,120,40,.4);
  font-size: .78em;
  color: var(--camp-wood-2);
}
.oni-camp-gm-override .gm-override-label {
  flex: 1;
  opacity: .8;
}
.oni-camp-gm-btn {
  appearance: none;
  border: 1px solid rgba(180,120,40,.6);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: .8em;
  font-weight: 700;
  cursor: pointer;
  background: rgba(180,120,40,.18);
  color: #7a5010;
  font-family: inherit;
  transition: background .12s ease;
  white-space: nowrap;
}
.oni-camp-gm-btn:hover { background: rgba(180,120,40,.35); }

/* Activity resolve queue */
.oni-camp-resolve-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 6px;
  background: linear-gradient(180deg, rgba(255,255,255,.25), rgba(255,255,255,.05));
  border: 1px solid rgba(92,66,30,.3);
  animation: campSlideIn .2s ease both;
}
.oni-camp-resolve-item .ri-icon { font-size: 1.2em; color: var(--camp-wood-2); }
.oni-camp-resolve-item .ri-info { flex: 1; }
.oni-camp-resolve-item .ri-name { font-weight: 700; font-size: .9em; }
.oni-camp-resolve-item .ri-actor { font-size: .8em; opacity: .75; }
.oni-camp-resolve-item .ri-status {
  font-size: .8em; font-weight: 700; padding: 2px 8px;
  border-radius: 999px; border: 1px solid rgba(0,0,0,.15);
}
.ri-status.pending  { background: rgba(200,180,100,.6); color: #4a3a10; }
.ri-status.running  { background: rgba(100,160,240,.6); color: #102050; animation: campPulse 1s infinite; }
.ri-status.done     { background: rgba(100,190,95,.7);  color: #1a3a18; }

/* ── Bond Editor UI ─────────────────────────────────────────────────────────── */
.oni-camp-bond-panel {
  width: min(780px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.oni-camp-bond-panel .panel-body,
.oni-bond-summary-panel .panel-body {
  overflow-y: auto; flex: 1; margin-top: 0;
  scrollbar-width: thin; scrollbar-color: var(--camp-wood-2) transparent;
}

.oni-bond-section-title {
  font-weight: 700; font-size: .88em; letter-spacing: .5px;
  text-transform: uppercase; opacity: .65;
  margin: 12px 0 6px;
}

.oni-bond-slot {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1.5px solid rgba(92,66,30,.25);
  margin-bottom: 8px;
  background: rgba(255, 250, 238, 0.82);
  transition: border-color .15s ease, box-shadow .15s ease;
  animation: campRowSlideIn .24s ease both;
}
.oni-bond-slot:hover           { border-color: rgba(202,164,77,.5); }
.oni-bond-slot.modified        { border-color: rgba(126,200,122,.65); box-shadow: 0 0 0 2px rgba(126,200,122,.18); }
.oni-bond-slot.gate-active     { border-color: var(--camp-gold-2); box-shadow: 0 0 0 2px rgba(202,164,77,.2); }

/* Slot header: label left, hearts right */
.bond-slot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bond-slot-label {
  font-size: .74em; font-weight: 700; opacity: .6; letter-spacing: .3px;
}
.bond-hearts { display: flex; gap: 4px; font-size: .9em; }
.bond-heart.positive { color: #e8729a; }
.bond-heart.negative { color: #9b5fb5; }
.bond-heart.empty    { color: #bbb; opacity: .55; }

/* Name → Relationship row */
.bond-name-rel-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.bond-name-rel-row .bond-name-input { flex: 1; }
.bond-arrow {
  color: var(--camp-wood-2); opacity: .65;
  font-size: 1em; flex-shrink: 0; user-select: none;
}
.bond-name-rel-row .bond-rel-input { flex: 1.6; }

/* Emotion row */
.bond-em-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bond-em-row select { flex: 1; }
.slot-actions { display: flex; gap: 5px; flex-shrink: 0; }

/* Shared input/select */
.oni-bond-slot input[type="text"],
.oni-bond-slot select {
  width: 100%;
  padding: 4px 7px;
  border-radius: 6px;
  border: 1px solid rgba(92,66,30,.4);
  background: rgba(255,255,255,.6);
  color: var(--camp-ink);
  font-family: inherit;
  font-size: .82em;
}
.oni-bond-slot input[type="text"]:focus,
.oni-bond-slot select:focus {
  outline: none;
  border-color: var(--camp-gold-2);
  box-shadow: 0 0 0 2px rgba(202,164,77,.25);
}

/* Slot buttons */
.oni-bond-slot .slot-btn {
  font-size: .72em; padding: 3px 8px; white-space: nowrap;
  border-radius: 6px; border: 1px solid rgba(90,60,34,.4); cursor: pointer;
  background: rgba(255,255,255,.5); color: var(--camp-ink); font-family: inherit;
  transition: background .12s ease;
}
.oni-bond-slot .slot-btn:hover  { background: rgba(202,164,77,.5); }
.oni-bond-slot .slot-btn.to-mem { color: #7a4a10; }
.oni-bond-slot .slot-btn.clear  { color: #9a2020; }

/* Add Bond button */
.bond-add-new-btn {
  width: 100%;
  padding: 9px;
  margin-top: 2px;
  border: 1.5px dashed rgba(92,66,30,.45);
  border-radius: 8px;
  background: rgba(236, 226, 206, 0.90);
  color: var(--camp-wood-2);
  font-family: inherit;
  font-size: .84em;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: background .12s ease, border-color .12s ease;
}
.bond-add-new-btn:hover {
  background: rgba(202,164,77,.35);
  border-color: rgba(202,164,77,.65);
}

/* Bond subtitle */
.bond-subtitle {
  font-size: .8em; opacity: .65; margin-bottom: 8px;
}

/* Memory list */
.oni-memory-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1.5px solid rgba(92,66,30,.22);
  margin-bottom: 8px;
  background: rgba(236, 226, 206, 0.95);
  animation: campRowSlideIn .24s ease both;
}
.oni-memory-item input[type="text"],
.oni-memory-item select {
  width: 100%;
  padding: 4px 7px;
  border-radius: 6px;
  border: 1px solid rgba(92,66,30,.28);
  background: rgba(205,193,172,.55);
  color: var(--camp-ink);
  font-family: inherit;
  font-size: .82em;
  cursor: default;
  opacity: .88;
}
.oni-memory-item .slot-btn {
  font-size: .72em; padding: 3px 8px; white-space: nowrap;
  border-radius: 6px; border: 1px solid rgba(90,60,34,.4); cursor: pointer;
  background: rgba(255,255,255,.5); color: var(--camp-ink); font-family: inherit;
  transition: background .12s ease;
}
.oni-memory-item .slot-btn:hover { background: rgba(202,164,77,.5); }
.oni-memory-item .slot-btn.from-mem  { color: #2a6a18; }
.oni-memory-item .slot-btn.clear-mem { color: #9a2020; }

/* Bond summary */
.oni-bond-summary-panel {
  width: min(700px, 92vw);
  max-height: 82vh;
  display: flex; flex-direction: column;
  animation: campPanelSlideUp .52s cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* Actor group */
.oni-bond-log-group {
  margin-bottom: 16px;
}
.oni-bond-log-actor-header {
  padding: 6px 12px 5px;
  background: linear-gradient(90deg, var(--camp-wood-2), var(--camp-wood-3));
  color: #f5ebd3;
  font-weight: 700; font-size: .9em;
  border-radius: 6px 6px 0 0;
}
.oni-bond-log-item {
  font-size: .82em;
  padding: 5px 12px;
  border-bottom: 1px solid rgba(92,66,30,.12);
  display: flex; gap: 8px; align-items: flex-start;
  background: rgba(255,255,255,.22);
}
.oni-bond-log-item:last-child { border-bottom: none; border-radius: 0 0 6px 6px; }

/* Log entries start invisible; .visible triggers the slide-in */
.oni-bond-log-entry {
  opacity: 0;
  pointer-events: none;
}
.oni-bond-log-entry.visible {
  opacity: 1;
  pointer-events: auto;
  animation: campLogSlideIn .38s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.bse-log-icon { color: var(--camp-wood-2); width: 16px; flex-shrink: 0; margin-top: 1px; }
.bse-log-text { flex: 1; line-height: 1.45; }
.bse-log-text strong { color: #5c3a1a; }
.bse-log-text em { opacity: .72; font-style: italic; }

/* Legacy — keep for any existing code that references these */
.oni-bond-summary-entry {
  margin-bottom: 14px;
  border-radius: 8px;
  overflow: hidden;
}
.oni-bond-summary-entry .bse-header {
  padding: 7px 12px;
  background: linear-gradient(90deg, var(--camp-wood-2), var(--camp-wood-3));
  color: #f5ebd3;
  font-weight: 700; font-size: .9em;
}
.oni-bond-summary-entry .bse-changes {
  padding: 8px 12px;
  background: rgba(255,255,255,.2);
}
.oni-bond-summary-entry .bse-change {
  font-size: .82em; padding: 4px 0;
  border-bottom: 1px solid rgba(92,66,30,.15);
  display: flex; gap: 8px; align-items: flex-start;
}
.oni-bond-summary-entry .bse-change:last-child { border-bottom: none; }
.bse-change-icon { color: var(--camp-wood-2); width: 16px; flex-shrink: 0; }
.bse-change-text { flex: 1; line-height: 1.4; }
.bse-change-text strong { color: #5c3a1a; }
  `;

  document.head.appendChild(style);
  console.debug("[CampSystem]", "Styles injected.");
})();
