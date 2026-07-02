// Boss "Super Armor" — the Domination / Ultima-action subsystem.
//
// Bosses (actor prop `isBoss`) bank 1 Dominance Point at the start of every
// 3rd round (capped at 1) and may spend 1 Ultima Point + 1 Dominance Point on
// their turn to enter DOMINATION STATE for the rest of the round: every
// action-gating debuff on them stays applied but stops working (Frightened,
// Silence, Berserk, Fatigue, Charmed, Provoked, Grappled, ...).
//
// The state is carried by a "Domination State" AE whose change row is the
// generic engine marker:
//
//   key "ignore_action_gating"   value "1"
//
// snapshot.js's gating readers (getBlockedActionLabels / getDisabledActionIntents
// / getMaxActionTargets / getCannotTargetReasons / getMustTargetReasons /
// getAllegianceOverrides) all early-out when the bearer carries this marker, so
// ANY current or future action-restriction expressed through those keys is
// covered without naming individual statuses. Mirrors the other pure
// change-row markers the BD reads itself (cannot_be_targeted_by etc.).
//
// The Dominance Point pool is a charge AE (chargeKey "dominance", cap 1,
// lifetimeMode "persistent_counter" so cleanses never touch it), applied
// engine-side at ROUND_START — see grantDominancePointsAtRoundStart, called
// from state-handlers' RoundStart. The spend is the "Domination" Ultima
// command on the boss's Octopath menu (compose-action / state-handlers).
//
// Both AE templates live embedded on the "Battle Director / Common" item
// tagged coreAction "domination" (same delivery as Guard's Guard/Covered
// templates), so resolveAeTemplate finds them by bare name during the
// item's effect_table walk.
//
// VFX (this file, socketlib-broadcast like director-impact-fx):
//   - emitDominationBurst : DOM particle energy burst + super_armor.wav
//   - persistent red outline (slow shimmer) on the boss token while the
//     Domination State AE is active — AE-replication-driven (hooks fire on
//     every client; no extra socket traffic), PIXI OutlineFilter on token.mesh
//   - emitEscapeFade : slow token fade-out for the Escape Ultima action

import { log, warn } from "./logger.js";
import { broadcastSfx } from "./director-sfx.js";

const MODULE_ID = "fabula-ultima-companion";
const FLAG_NS = "fabula-ultima-companion";

export const IGNORE_ACTION_GATING_KEY = "ignore_action_gating";
export const DOMINATION_STATE_AE_NAME = "Domination State";
export const DOMINANCE_POINT_AE_NAME = "Dominance Point";
export const DOMINANCE_CHARGE_KEY = "dominance";
export const DOMINANCE_ROUND_INTERVAL = 3;
export const DOMINANCE_POINT_CAP = 1;

export const DOMINATION_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/super_armor.wav";

// The three Ultima commands surfaced on the boss-only Octopath page. Kept OUT
// of GATEABLE_ACTION_LABELS on purpose: no debuff may ever lock them (using
// Domination while locked down is the whole point of the mechanic).
export const ULTIMA_COMMANDS = Object.freeze(["Domination", "Escape", "Recovery"]);
export const ULTIMA_PAGE_NAME = "Ultima";

// ── Gating-bypass marker ────────────────────────────────────────────────────

// True when the actor carries an active AE change `ignore_action_gating` with
// a truthy value. Read by every action-gating reader in snapshot.js.
export function hasIgnoreActionGating(actor) {
  const effects = actor?.appliedEffects
    ? Array.from(actor.appliedEffects)
    : (actor?.effects?.contents ?? actor?.effects ?? []);
  for (const ae of effects) {
    if (ae?.disabled) continue;
    for (const ch of (ae?.changes ?? [])) {
      if (ch?.key !== IGNORE_ACTION_GATING_KEY) continue;
      const v = String(ch.value ?? "").trim();
      if (v && v !== "0" && v.toLowerCase() !== "false") return true;
    }
  }
  return false;
}

// ── Boss / point readers (snapshot bundle) ──────────────────────────────────

export function actorIsBoss(actor) {
  const v = actor?.system?.props?.isBoss;
  return v === true || String(v ?? "").trim().toLowerCase() === "true";
}

export function readUltimaPoints(actor) {
  return Number(actor?.system?.props?.ultima_point ?? 0) || 0;
}

// The Dominance Point AE on the bearer (charge identity, not name — matches
// how consume_charge finds pools). Returns the ActiveEffect doc or null.
export function findDominancePointAe(actor) {
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  for (const ae of effects) {
    if (ae?.disabled) continue;
    const f = ae?.flags?.[FLAG_NS] ?? {};
    if (String(f.chargeKey ?? "").trim().toLowerCase() === DOMINANCE_CHARGE_KEY) return ae;
    if (String(ae?.name ?? "").trim() === DOMINANCE_POINT_AE_NAME) return ae;
  }
  return null;
}

export function readDominancePoints(actor) {
  const ae = findDominancePointAe(actor);
  if (!ae) return 0;
  return Number(ae.flags?.[FLAG_NS]?.charges ?? 0) || 0;
}

// Frozen snapshot slice merged into snapshotDirectorCombatant / snapshotCombatant.
export function snapshotUltimaBundle(actor) {
  const isBoss = actorIsBoss(actor);
  return {
    isBoss,
    ultimaPoints: isBoss ? readUltimaPoints(actor) : 0,
    dominancePoints: isBoss ? readDominancePoints(actor) : 0,
    isDominating: isBoss ? hasIgnoreActionGating(actor) : false,
  };
}

// ── Common item / AE template resolution ────────────────────────────────────

// The "Battle Director / Common" item that carries the Domination effect_table
// + both AE templates. Same lookup contract as state-handlers'
// getCoreActionSkill (duplicated here to keep this module import-light).
export function findUltimaCommonItem(command) {
  const cmd = String(command ?? "").trim().toLowerCase();
  if (!cmd) return null;
  const matches = (game.items ?? []).filter((it) =>
    it.type === "equippableItem" &&
    (it.flags?.[FLAG_NS]?.coreAction ?? null) === cmd
  );
  if (!matches.length) return null;
  return matches.find((it) =>
    String(it.system?.props?.action_command ?? "").trim().toLowerCase() === cmd
  ) ?? matches[0];
}

function dominancePointTemplate() {
  const item = findUltimaCommonItem("domination");
  for (const eff of item?.effects ?? []) {
    if (String(eff.name ?? "").trim() === DOMINANCE_POINT_AE_NAME) return eff.toObject();
  }
  return null;
}

// ── Round-start accrual ─────────────────────────────────────────────────────

// Called from RoundStart.onEnter (GM/FSM side — single-writer by construction).
// Every enemy boss gains 1 Dominance Point on rounds 3, 6, 9, ... capped at
// DOMINANCE_POINT_CAP. The pool AE is created from the Common item's embedded
// template so icon / tags / statuscounter flags stay authored data.
export async function grantDominancePointsAtRoundStart(director) {
  try {
    const round = Number(director?.dCombat?.round ?? 0) || 0;
    if (round <= 0 || round % DOMINANCE_ROUND_INTERVAL !== 0) return;
    const combatants = director?.dCombat?.combatants ?? [];
    for (const c of combatants) {
      if (c?.side !== "enemy" || !c?.isBoss) continue;
      if (c?.defeated) continue;
      const actor = c.actorDoc ?? c.tokenDoc?.actor ?? null;
      if (!actor) continue;
      if (readDominancePoints(actor) >= DOMINANCE_POINT_CAP) {
        log(`Domination: ${c.name} already at Dominance cap (${DOMINANCE_POINT_CAP}) — no accrual`);
        continue;
      }
      const existing = findDominancePointAe(actor);
      if (existing) {
        // Below cap with an existing pool (cap > 1 futures): bump charges.
        const cur = Number(existing.flags?.[FLAG_NS]?.charges ?? 0) || 0;
        const next = Math.min(DOMINANCE_POINT_CAP, cur + 1);
        await existing.update({ [`flags.${FLAG_NS}.charges`]: next });
        log(`Domination: ${c.name} Dominance ${cur} -> ${next} (round ${round})`);
      } else {
        const tpl = dominancePointTemplate();
        if (!tpl) {
          warn("Domination: Dominance Point AE template not found on the Common item — accrual skipped");
          return;
        }
        delete tpl._id;
        tpl.flags = tpl.flags ?? {};
        tpl.flags[FLAG_NS] = {
          ...(tpl.flags[FLAG_NS] ?? {}),
          charges: 1,
          chargesMax: DOMINANCE_POINT_CAP,
          chargeKey: DOMINANCE_CHARGE_KEY,
          lifetimeMode: "persistent_counter",
        };
        await actor.createEmbeddedDocuments("ActiveEffect", [tpl]);
        log(`Domination: ${c.name} gains 1 Dominance Point (round ${round})`);
      }
      try { ui.notifications?.info(`${c.name} gains a Dominance Point!`); } catch {}
    }
  } catch (e) {
    warn("grantDominancePointsAtRoundStart threw", e);
  }
}

// Consume one Dominance Point off the boss. Returns true when a point was
// spent. The pool AE stays at 0 charges (persistent counter, statuscounter
// shows 0) so the player can see the gauge refill on the next 3rd round.
export async function consumeDominancePoint(actor) {
  const ae = findDominancePointAe(actor);
  if (!ae) return false;
  const cur = Number(ae.flags?.[FLAG_NS]?.charges ?? 0) || 0;
  if (cur < 1) return false;
  await ae.update({ [`flags.${FLAG_NS}.charges`]: cur - 1 });
  return true;
}

// ── Ultima Octopath page ────────────────────────────────────────────────────

// Build the boss-only "Ultima" page spec from the acting snapshot. Returns
// null for non-bosses. `entries` feed the extra Octopath page; unaffordable
// commands arrive pre-disabled with the shortfall as the blade stamp.
export function buildUltimaPageSpec(snap) {
  if (!snap?.isBoss) return null;
  const up = Number(snap.ultimaPoints ?? 0) || 0;
  const dp = Number(snap.dominancePoints ?? 0) || 0;
  const noUp = up < 1 ? "No Ultima Point" : null;
  const entries = [
    {
      label: "Domination",
      disabledReason: snap.isDominating ? "Already Dominating"
        : (noUp ?? (dp < 1 ? "No Dominance Point" : null)),
    },
    { label: "Escape",   disabledReason: noUp },
    { label: "Recovery", disabledReason: noUp },
  ];
  return { name: ULTIMA_PAGE_NAME, entries };
}

// ── VFX: socket plumbing ────────────────────────────────────────────────────

const ACTION_BURST = "FU_DOMINATION_BURST";
const ACTION_ESCAPE_FADE = "FU_DOMINATION_ESCAPE_FADE";

let _socket = null;

// Idempotent — called on every client from director-boot's ready hook.
export function initDominationFx() {
  try {
    if (typeof socketlib !== "undefined" && game.modules.get("socketlib")?.active) {
      _socket = socketlib.registerModule(MODULE_ID);
      _socket.register(ACTION_BURST, playDominationBurstLocal);
      _socket.register(ACTION_ESCAPE_FADE, playEscapeFadeLocal);
    } else {
      warn("domination-fx: socketlib unavailable — VFX stay local-only");
    }
  } catch (e) {
    warn("domination-fx: socket init failed", e);
  }
  initDominationOutlineWatcher();
}

// ── VFX: DOM particle energy burst (enter Domination State) ────────────────

function canvasTokenFromUuid(tokenUuid) {
  const tokenId = String(tokenUuid ?? "").split(".Token.").pop();
  return tokenId ? (canvas?.tokens?.get?.(tokenId) ?? null) : null;
}

function worldToClient(ax, ay) {
  const wt = canvas.stage.worldTransform;
  const out = new PIXI.Point();
  wt.apply({ x: ax, y: ay }, out);
  const rect = canvas.app.view.getBoundingClientRect();
  return { x: rect.left + out.x, y: rect.top + out.y };
}

const BURST_STYLE_ID = "fud-domination-burst-style";
function ensureBurstStyle() {
  if (document.getElementById(BURST_STYLE_ID)) return;
  const css = `
.fud-dom-burst-layer {
  position: fixed; left: 0; top: 0; width: 0; height: 0;
  z-index: 99986; pointer-events: none;
}
.fud-dom-burst-p {
  position: absolute; left: 0; top: 0; border-radius: 50%;
  mix-blend-mode: screen; will-change: transform, opacity;
  /* Defensive: the game stylesheet borders media/box elements; never on our FX. */
  border: 0 !important; outline: 0 !important; box-shadow: none !important;
}
.fud-dom-burst-ring {
  position: absolute; left: 0; top: 0; border-radius: 50%;
  border: 3px solid rgba(255, 64, 40, 0.95) !important;
  box-shadow: 0 0 24px rgba(255, 80, 40, 0.8), inset 0 0 18px rgba(255, 120, 60, 0.6) !important;
  mix-blend-mode: screen; will-change: transform, opacity;
  transform: translate(-50%, -50%);
}
`.trim();
  const style = document.createElement("style");
  style.id = BURST_STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

// Render the burst on THIS client. ~1.5s of radial embers + a shockwave ring,
// anchored to the token's current screen position (screen-space DOM, exactly
// like director-impact-fx).
export function playDominationBurstLocal({ tokenUuid } = {}) {
  try {
    if (typeof PIXI === "undefined" || !canvas?.ready) return;
    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) { log("domination burst: token not on canvas, skipping"); return; }
    ensureBurstStyle();

    const c = token.center ?? { x: (token.x ?? 0) + (token.w ?? 100) / 2, y: (token.y ?? 0) + (token.h ?? 100) / 2 };
    const pt = worldToClient(c.x, c.y);
    const zoom = canvas.stage?.scale?.x ?? 1;
    const radius = Math.max(60, (token.w ?? 100) * zoom * 1.1);

    const layer = document.createElement("div");
    layer.className = "fud-dom-burst-layer";
    layer.style.left = `${pt.x}px`;
    layer.style.top = `${pt.y}px`;
    document.body.appendChild(layer);

    const DURATION = 1500;
    const parts = [];

    // Shockwave ring — expands past the token edge and thins out.
    const ring = document.createElement("div");
    ring.className = "fud-dom-burst-ring";
    layer.appendChild(ring);

    // Radial embers — red/orange energy motes flung outward, easing to a stop.
    const N = 26;
    for (let i = 0; i < N; i++) {
      const p = document.createElement("div");
      p.className = "fud-dom-burst-p";
      const hot = Math.random() < 0.35;
      const size = hot ? 5 + Math.random() * 6 : 3 + Math.random() * 4;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.background = hot
        ? "radial-gradient(circle, #fff3d6 0%, #ffb347 45%, rgba(255,80,30,0) 75%)"
        : "radial-gradient(circle, #ffd0a0 0%, #ff5a2a 50%, rgba(200,20,10,0) 78%)";
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.5;
      const dist = radius * (0.7 + Math.random() * 0.9);
      const delay = Math.random() * 120;
      layer.appendChild(p);
      parts.push({ el: p, ang, dist, delay, size });
    }

    const t0 = performance.now();
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    function frame(now) {
      const el = now - t0;
      if (el >= DURATION || !document.body.contains(layer)) { try { layer.remove(); } catch {} return; }
      const ringP = Math.min(1, el / (DURATION * 0.6));
      const ringR = radius * 1.6 * easeOutCubic(ringP);
      ring.style.width = `${ringR * 2}px`;
      ring.style.height = `${ringR * 2}px`;
      ring.style.opacity = String(Math.max(0, 1 - ringP));
      for (const p of parts) {
        const pe = Math.max(0, Math.min(1, (el - p.delay) / (DURATION - p.delay)));
        const d = p.dist * easeOutCubic(pe);
        const x = Math.cos(p.ang) * d;
        const y = Math.sin(p.ang) * d - pe * 14; // slight upward drift
        p.el.style.transform = `translate(${x - p.size / 2}px, ${y - p.size / 2}px)`;
        p.el.style.opacity = String(pe < 0.15 ? pe / 0.15 : 1 - (pe - 0.15) / 0.85);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  } catch (e) {
    warn("playDominationBurstLocal threw", e);
  }
}

// GM-side emit: burst on every client + the super-armor SFX.
export function emitDominationBurst({ tokenUuid } = {}) {
  try { playDominationBurstLocal({ tokenUuid }); }
  catch (e) { warn("emitDominationBurst: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_BURST, { tokenUuid }); }
  catch (e) { warn("emitDominationBurst: broadcast failed", e); }
  try { broadcastSfx(DOMINATION_SFX_URL, 0.8); }
  catch (e) { warn("emitDominationBurst: sfx failed", e); }
}

// ── VFX: persistent red outline while Domination State is active ───────────
//
// AE-replication-driven: createActiveEffect / deleteActiveEffect fire on every
// client when the Domination State AE lands on or leaves an actor, so each
// client applies its own local PIXI OutlineFilter — no socket traffic, and a
// mid-battle F5 recovers via the canvasReady rescan.

const _outlines = new Map(); // tokenId -> { filter, token, fading }
let _outlineTickerOn = false;
let _outlineHooksOn = false;

function outlineTick() {
  if (!_outlines.size) return;
  const now = performance.now();
  for (const [tokenId, rec] of _outlines) {
    const live = canvas?.tokens?.get?.(tokenId);
    if (!live || live.destroyed || !live.mesh) { _dropOutline(tokenId, rec); continue; }
    // Token placeables get rebuilt on canvas redraws — re-attach if the live
    // mesh lost our filter instance.
    if (rec.token !== live || !(live.mesh.filters ?? []).includes(rec.filter)) {
      rec.token = live;
      live.mesh.filters = [...(live.mesh.filters ?? []), rec.filter];
    }
    // Slow shimmer: ~2.4s sine pulse between thin and thick.
    const pulse = 0.5 + 0.5 * Math.sin((now / 2400) * Math.PI * 2 + rec.phase);
    let k = 1;
    if (rec.fading) {
      k = Math.max(0, 1 - (now - rec.fadeStart) / rec.fadeMs);
      if (k <= 0) { _dropOutline(tokenId, rec); continue; }
    }
    rec.filter.thickness = (2 + pulse * 2.5) * k;
    try { rec.filter.alpha = (0.75 + pulse * 0.25) * k; } catch { /* older pixi-filters: no alpha */ }
  }
  if (!_outlines.size && _outlineTickerOn) {
    try { PIXI.Ticker.shared.remove(outlineTick); } catch {}
    _outlineTickerOn = false;
  }
}

function _dropOutline(tokenId, rec) {
  try {
    const live = canvas?.tokens?.get?.(tokenId);
    const mesh = live?.mesh ?? rec.token?.mesh;
    if (mesh?.filters) mesh.filters = mesh.filters.filter((f) => f !== rec.filter);
  } catch {}
  _outlines.delete(tokenId);
}

function applyDominationOutline(token) {
  try {
    if (!token?.mesh || typeof PIXI?.filters?.OutlineFilter !== "function") return;
    if (_outlines.has(token.id)) return;
    const filter = new PIXI.filters.OutlineFilter(3, 0xff2b1a, 0.35);
    filter.padding = 8;
    token.mesh.filters = [...(token.mesh.filters ?? []), filter];
    _outlines.set(token.id, { filter, token, phase: Math.random() * Math.PI * 2, fading: false });
    if (!_outlineTickerOn) {
      PIXI.Ticker.shared.add(outlineTick);
      _outlineTickerOn = true;
    }
  } catch (e) {
    warn("applyDominationOutline threw", e);
  }
}

// Fade the outline out (~900ms) instead of popping it off.
function releaseDominationOutline(tokenId) {
  const rec = _outlines.get(tokenId);
  if (!rec || rec.fading) return;
  rec.fading = true;
  rec.fadeStart = performance.now();
  rec.fadeMs = 900;
}

function actorHasDominationState(actor) {
  const effects = actor?.effects?.contents ?? actor?.effects ?? [];
  return effects.some((ae) => !ae?.disabled && String(ae?.name ?? "").trim() === DOMINATION_STATE_AE_NAME);
}

function tokensForActor(actor) {
  if (!actor) return [];
  try { return actor.getActiveTokens?.(true) ?? []; } catch { return []; }
}

function syncActorOutline(actor) {
  const want = actorHasDominationState(actor);
  for (const token of tokensForActor(actor)) {
    if (want) {
      const rec = _outlines.get(token.id);
      if (rec?.fading) { rec.fading = false; }  // re-applied mid-fade
      applyDominationOutline(token);
    } else {
      releaseDominationOutline(token.id);
    }
  }
}

function rescanCanvasOutlines() {
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token?.actor && actorHasDominationState(token.actor)) applyDominationOutline(token);
  }
}

function initDominationOutlineWatcher() {
  if (_outlineHooksOn) return;
  _outlineHooksOn = true;
  const isDomState = (effect) => String(effect?.name ?? "").trim() === DOMINATION_STATE_AE_NAME;
  Hooks.on("createActiveEffect", (effect) => {
    if (isDomState(effect) && effect.parent?.documentName === "Actor") syncActorOutline(effect.parent);
  });
  Hooks.on("deleteActiveEffect", (effect) => {
    if (isDomState(effect) && effect.parent?.documentName === "Actor") syncActorOutline(effect.parent);
  });
  Hooks.on("updateActiveEffect", (effect) => {
    if (isDomState(effect) && effect.parent?.documentName === "Actor") syncActorOutline(effect.parent);
  });
  Hooks.on("canvasReady", () => {
    _outlines.clear(); // placeables were destroyed with the old canvas
    rescanCanvasOutlines();
  });
  // Catch tokens already dominating when this client loads mid-battle.
  if (canvas?.ready) rescanCanvasOutlines();
}

// ── VFX: Escape fade-out ────────────────────────────────────────────────────

// Slow alpha fade of the whole token placeable (sprite + bars + nameplate).
// Local-only render; the GM emit broadcasts + awaits the duration so the
// combatant/token removal happens after the sprite has faded everywhere.
export function playEscapeFadeLocal({ tokenUuid, durationMs = 2600 } = {}) {
  try {
    const token = canvasTokenFromUuid(tokenUuid);
    if (!token || token.destroyed) return;
    const t0 = performance.now();
    const startAlpha = token.alpha ?? 1;
    function frame(now) {
      const live = canvasTokenFromUuid(tokenUuid);
      if (!live || live.destroyed) return; // token removed — done
      const p = Math.min(1, (now - t0) / durationMs);
      live.alpha = startAlpha * (1 - p);
      if (live.mesh) live.mesh.alpha = startAlpha * (1 - p);
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  } catch (e) {
    warn("playEscapeFadeLocal threw", e);
  }
}

export async function emitEscapeFade({ tokenUuid, durationMs = 2600 } = {}) {
  try { playEscapeFadeLocal({ tokenUuid, durationMs }); }
  catch (e) { warn("emitEscapeFade: local render threw", e); }
  try { _socket?.executeForOthers?.(ACTION_ESCAPE_FADE, { tokenUuid, durationMs }); }
  catch (e) { warn("emitEscapeFade: broadcast failed", e); }
  await new Promise((res) => setTimeout(res, durationMs + 100));
}
