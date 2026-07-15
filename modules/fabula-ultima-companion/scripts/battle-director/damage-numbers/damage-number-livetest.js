// Damage-number LIVE test tool — fires the REAL Phase-1 production path, not
// just the local renderer.
//
// The audition tool (damage-number-audition.js) calls renderDamageNumberLocal
// directly — great for iterating on the number's LOOK, but it skips everything
// Phase 1 actually wired: the Sequencer impact webm, the affinity SFX, and the
// socketlib broadcast to other clients. This tool calls the director-vfx
// functions (playResourceLossVfx / playMissVfx / ...) exactly as
// applyDamageToTarget does in a real battle, so each button reproduces the FULL
// feedback — number + impact + sound — AND broadcasts it to every connected
// client. Use it to confirm the integration end-to-end without having to find
// an attack that triggers each affinity/crit/resource pattern.
//
// NOTE: unlike the audition tool, this BROADCASTS to players (that's the point —
// it verifies multi-client sync). It does NOT touch actor HP/MP; it only drives
// the cosmetic feedback layer.
//
// Registers into the Developer Tools launcher. Imported by director-boot.js +
// initialised on its ready hook — loads on a normal hard-reload, no relaunch.

import { log, warn } from "../logger.js";
import { registerDevTool } from "../dev-tools-menu.js";
import {
  playResourceLossVfx,
  playResourceGainVfx,
  playResourceSpendVfx,
  playMissVfx,
  playBlockVfx,
  playImmuneVfx,
  playAbsorbVfx,
} from "../director-vfx.js";
import { emitHurtReaction } from "./director-hurt-reaction.js";
import { emitNpcHpBar, emitNpcHpBarUnchecked } from "./director-hp-bar.js";

const PANEL_ID = "fud-dmgnum-livetest-panel";
const STYLE_ID = "fud-dmgnum-livetest-style";

// Each case drives the SAME function applyDamageToTarget would, on the target
// token. `fn(tokenUuid)` performs the call(s).
const CASES = [
  { label: "Hit — physical 48",     fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 48, element: "physical" }) },
  { label: "Hit — fire 120",        fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 120, element: "fire" }) },
  { label: "Hit — bolt 90 (purple)",fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 90, element: "bolt" }) },
  { label: "Hit — dark 90 (indigo)",fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 90, element: "dark" }) },
  { label: "WEAK! — fire 120",      fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 120, element: "fire", affinity: "VU" }) },
  { label: "RESIST — ice 30",       fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 30, element: "ice", affinity: "RS" }) },
  { label: "CRITICAL — dark 210",   fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 210, element: "dark", isCrit: true }) },
  { label: "CRIT + WEAK! — 260",    fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 260, element: "fire", affinity: "VU", isCrit: true }) },
  { label: "PIERCE — fire 80",      fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 80, element: "fire", pierce: true }) },
  { label: "IMMUNE",                fn: (t) => playImmuneVfx({ tokenUuid: t }) },
  { label: "ABSORB 64",             fn: (t) => playAbsorbVfx({ tokenUuid: t, amount: 64 }) },
  { label: "MISS",                  fn: (t) => playMissVfx({ tokenUuid: t }) },
  { label: "BLOCK (Ninja Log)",     fn: (t) => playBlockVfx({ tokenUuid: t }) },
  { label: "MP loss 22",            fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "mp", amount: 22 }) },
  { label: "Shield −35",            fn: (t) => playResourceLossVfx({ tokenUuid: t, resource: "shield", amount: 35, element: "fire" }) },
  { label: "Heal +88",              fn: (t) => playResourceGainVfx({ tokenUuid: t, resource: "hp", amount: 88 }) },
  { label: "MP gain +30",           fn: (t) => playResourceGainVfx({ tokenUuid: t, resource: "mp", amount: 30 }) },
  { label: "Spend MP −15",          fn: (t) => playResourceSpendVfx({ tokenUuid: t, resource: "mp", amount: 15 }) },
  {
    label: "Multi-hit burst ×5",
    fn: (t) => {
      const amts = [40, 35, 60, 28, 90];
      const els = ["fire", "ice", "bolt", "physical", "fire"];
      amts.forEach((a, i) => playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: a, element: els[i] }));
    },
  },
  { label: "Hurt reaction — normal",  fn: (t) => emitHurtReaction({ tokenUuid: t, intensity: "normal" }) },
  { label: "Hurt reaction — strong",  fn: (t) => emitHurtReaction({ tokenUuid: t, intensity: "strong" }) },
  {
    // Full intended live experience for a WEAK crit: number + impact + sound +
    // strong hurt flinch, all together.
    label: "FULL hit — WEAK crit",
    fn: (t) => {
      playResourceLossVfx({ tokenUuid: t, resource: "hp", amount: 260, element: "fire", affinity: "VU", isCrit: true });
      emitHurtReaction({ tokenUuid: t, intensity: "strong" });
    },
  },
  // ── Transient NPC HP bar ──
  // "Unchecked" cases skip the hostile/studied gates so the VISUAL can be
  // auditioned on any token. The GATED case runs the production emit exactly
  // as skill-effects does — use it to verify the study/disposition gating
  // (silence on an unstudied or friendly token is the CORRECT outcome).
  { label: "HP bar — hit 80%→55%",     fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.80, toFrac: 0.55 }) },
  { label: "HP bar — deep red 30%→8%", fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.30, toFrac: 0.08 }) },
  { label: "HP bar — heal 20%→45%",    fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.20, toFrac: 0.45 }) },
  { label: "HP bar — KO 15%→0%",       fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.15, toFrac: 0.00 }) },
  {
    // Multi-hit combo: successive emits while the bar is up RETARGET the live
    // fill (one bar stepping down), timed like a real multi-hit RESOLVE loop.
    label: "HP bar — multi-hit ×4",
    fn: (t) => {
      const steps = [[1.00, 0.86], [0.86, 0.71], [0.71, 0.52], [0.52, 0.40]];
      steps.forEach(([from, to], i) => {
        setTimeout(() => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: from, toFrac: to }), i * 260);
      });
    },
  },
  // Shield (temp HP) — the WHITE segment right of the green fill.
  { label: "HP bar — shield hit (HP safe)",  fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.60, toFrac: 0.60, fromShield: 0.30, toShield: 0.10 }) },
  { label: "HP bar — shield break + HP",     fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.60, toFrac: 0.45, fromShield: 0.15, toShield: 0.00 }) },
  { label: "HP bar — gain shield",           fn: (t) => emitNpcHpBarUnchecked({ tokenUuid: t, fromFrac: 0.50, toFrac: 0.50, fromShield: 0.00, toShield: 0.25 }) },
  {
    // Production path on the selected token's REAL HP (display only — no HP
    // write): shows a bar ONLY if the token is hostile AND studied.
    label: "HP bar — GATED (real HP, −25%)",
    fn: (t) => {
      const tokenId = String(t).split(".Token.").pop();
      const actor = canvas?.tokens?.get?.(tokenId)?.actor ?? null;
      const cur = Number(actor?.system?.props?.current_hp ?? 0) || 0;
      const max = Number(actor?.system?.props?.max_hp ?? 0) || 0;
      if (!max) { ui.notifications?.warn("HP bar livetest: token has no max_hp."); return; }
      emitNpcHpBar({ tokenUuid: t, actor, hpBefore: cur, hpAfter: Math.max(0, cur - Math.round(max * 0.25)), maxHp: max });
    },
  },
];

let _booted = false;

function targetTokenUuid() {
  const controlled = canvas?.tokens?.controlled ?? [];
  const tok = controlled[0] ?? canvas?.tokens?.placeables?.[0] ?? null;
  return tok?.document?.uuid ?? null;
}

function fireCase(c) {
  const tokenUuid = targetTokenUuid();
  if (!tokenUuid) {
    ui.notifications?.warn("Damage FX: no token on canvas to anchor on.");
    return;
  }
  try { c.fn(tokenUuid); }
  catch (e) { warn("damage-number-livetest fireCase threw", e); }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; left: 70px; bottom: 70px; z-index: 100003;
  width: 250px; max-height: 72vh; overflow-y: auto;
  padding: 10px; border-radius: 10px;
  background: rgba(26,18,18,.96); border: 1px solid rgba(255,140,120,.22);
  box-shadow: 0 10px 30px rgba(0,0,0,.5); color: #f0e7e7;
  font-family: "Inter","Segoe UI",system-ui,sans-serif;
}
#${PANEL_ID} h4 { margin: 0 0 6px; font-size: 13px; letter-spacing: .3px; }
#${PANEL_ID} .fud-lt-hint { font-size: 10px; opacity: .72; margin-bottom: 8px; line-height: 1.35; }
#${PANEL_ID} button {
  display: block; width: 100%; text-align: left; margin: 3px 0;
  padding: 6px 9px; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
  color: #f0e7e7; font-size: 12px;
}
#${PANEL_ID} button:hover { background: rgba(255,140,120,.18); }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function togglePanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) { existing.remove(); return; }
  ensureStyle();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const h = document.createElement("h4");
  h.textContent = "💢 Damage FX (live path)";
  panel.appendChild(h);

  const hint = document.createElement("div");
  hint.className = "fud-lt-hint";
  hint.textContent = "Fires the REAL production VFX (number + impact + sound) on your selected token and BROADCASTS to all clients. Does not change HP/MP.";
  panel.appendChild(hint);

  for (const c of CASES) {
    const b = document.createElement("button");
    b.textContent = c.label;
    b.addEventListener("click", () => fireCase(c));
    panel.appendChild(b);
  }

  document.body.appendChild(panel);
}

export function initDamageNumberLivetest() {
  if (_booted) return;
  try {
    registerDevTool({ id: "damage-fx-live", icon: "💢", label: "Damage FX (live)", onClick: togglePanel });
    _booted = true;
    log("damage-number-livetest: registered as dev tool");
  } catch (e) {
    warn("initDamageNumberLivetest threw", e);
  }
}
