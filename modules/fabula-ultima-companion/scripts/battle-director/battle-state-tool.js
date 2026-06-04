// Battle State control tool (GM only).
//
// A dev tool, bundled under the Developer Tools launcher, that drives the live
// battle forward without playing out every turn. Buttons call the GM-only
// control methods on FUCompanion.api.experimental.battleDirector:
//   - Next Turn          → forceNextTurn()      (skip the current turn)
//   - Next Round         → forceNextRound()      (end the round, advance to N+1)
//   - Refill Round Turns → refillRoundTurns()    (re-run the round)
// A live status line shows the current round / acting side / FSM state.
//
// Not a manifest entry — imported by director-boot.js and initialised from its
// ready hook, so it loads on a normal reload with no Setup-relaunch.

import { log, warn } from "./logger.js";
import { registerDevTool, devToolsAnchorBottom, devToolsAnchorLeft } from "./dev-tools-menu.js";

const PANEL_ID = "fud-battlestate-panel";
const STYLE_ID = "fud-battlestate-style";

let _booted = false;

export function initBattleStateTool() {
  try {
    if (_booted) return;
    if (!game.user?.isGM) return;
    ensureStyle();
    registerDevTool({ id: "battle-state", icon: "🎬", label: "Battle State", onClick: openPanel });
    _booted = true;
    log("battle-state-tool: registered as dev tool");
  } catch (e) {
    warn("initBattleStateTool threw", e);
  }
}

function api() {
  return globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; left: 16px; bottom: 70px; z-index: 100002; width: 232px;
  background: linear-gradient(180deg, rgba(24,26,32,.98), rgba(16,18,22,.98));
  color: #e8eaf0; border: 1px solid rgba(127,160,255,.3); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; font: 12px "Signika", system-ui, sans-serif;
}
#${PANEL_ID} .bst-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
#${PANEL_ID} .bst-title { font-weight: 800; color: #cfe0ff; font-size: 13px; }
#${PANEL_ID} .bst-close { cursor: pointer; opacity: .7; padding: 2px 6px; border-radius: 6px; }
#${PANEL_ID} .bst-close:hover { opacity: 1; background: rgba(255,255,255,.08); }
#${PANEL_ID} .bst-status {
  font-size: 11.5px; line-height: 1.5; padding: 7px 9px; margin-bottom: 10px;
  background: rgba(0,0,0,.28); border-radius: 7px; border: 1px solid rgba(255,255,255,.07);
}
#${PANEL_ID} .bst-status b { color: #ffd866; }
#${PANEL_ID} .bst-status .bst-off { opacity: .6; font-style: italic; }
#${PANEL_ID} .bst-btn {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; margin-top: 6px; border-radius: 7px;
  cursor: pointer; font-weight: 600; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05);
  transition: filter .12s ease, background .12s ease;
}
#${PANEL_ID} .bst-btn:hover { background: rgba(127,160,255,.16); filter: brightness(1.1); }
#${PANEL_ID} .bst-btn.disabled { opacity: .4; pointer-events: none; }
#${PANEL_ID} .bst-btn .bst-ic { width: 18px; text-align: center; }
#${PANEL_ID} .bst-hint { opacity: .55; font-size: 10.5px; margin-top: 10px; text-align: center; }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function renderStatus(statusEl) {
  const a = api();
  const info = a?.stateInfo?.() ?? { running: false };
  if (!info.running) {
    statusEl.innerHTML = `<span class="bst-off">No active battle.</span>`;
    return;
  }
  const current = info.current ? ` — <b>${escapeHtml(info.current)}</b>` : "";
  statusEl.innerHTML =
    `Round <b>${info.round}</b> · <b>${escapeHtml(info.currentSide)}</b> to act${current}` +
    `<br><span style="opacity:.6;">FSM: ${escapeHtml(String(info.fsmState ?? "?"))}</span>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openPanel() {
  document.getElementById(PANEL_ID)?.remove();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  try { panel.style.bottom = `${devToolsAnchorBottom()}px`; } catch (_e) {}
  try { panel.style.left = `${devToolsAnchorLeft()}px`; } catch (_e) {}

  const head = document.createElement("div"); head.className = "bst-head";
  const title = document.createElement("div"); title.className = "bst-title"; title.textContent = "🎬 Battle State";
  const close = document.createElement("div"); close.className = "bst-close"; close.textContent = "✕";
  close.addEventListener("click", () => panel.remove());
  head.append(title, close);

  const status = document.createElement("div"); status.className = "bst-status";

  const mkBtn = (icon, label, run) => {
    const b = document.createElement("div"); b.className = "bst-btn";
    const ic = document.createElement("span"); ic.className = "bst-ic"; ic.textContent = icon;
    const lb = document.createElement("span"); lb.textContent = label;
    b.append(ic, lb);
    b.addEventListener("click", async () => {
      const a = api();
      if (!a) { ui.notifications?.warn("Battle Director API not ready."); return; }
      let res;
      try { res = await run(a); }
      catch (e) { warn(`battle-state: "${label}" threw`, e); res = { ok: false, error: String(e?.message ?? e) }; }
      if (res && res.ok === false) ui.notifications?.warn(`${label}: ${res.error}`);
      // Re-read after the FSM settles (banner / picker may run async).
      setTimeout(() => renderStatus(status), 250);
    });
    return b;
  };

  const btnTurn   = mkBtn("⏭️", "Next Turn",          (a) => a.forceNextTurn?.());
  const btnRound  = mkBtn("🔁", "Next Round",          (a) => a.forceNextRound?.());
  const btnRefill = mkBtn("♻️", "Refill Round Turns",  (a) => a.refillRoundTurns?.());

  const hint = document.createElement("div"); hint.className = "bst-hint";
  hint.textContent = "Dev overrides — drives the live battle FSM.";

  panel.append(head, status, btnTurn, btnRound, btnRefill, hint);
  document.body.appendChild(panel);
  renderStatus(status);
}
