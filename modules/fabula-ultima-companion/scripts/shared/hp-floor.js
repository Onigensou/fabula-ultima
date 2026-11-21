// ============================================================================
// Shared - HP floor (AE change key `hp_floor`)
//
// An enabled Active Effect carrying `{ key: "hp_floor", value: "<n>" }` keeps its
// holder's current HP from ever being WRITTEN below n (Nox Servant: n = 1, so a
// Servant never drops to 0 from any source: damage card, raw sheet write, vital
// loss, Max-HP drop). Two parts:
//   1. pure helpers (no Foundry) - tested by hp-floor.test.mjs
//   2. a `preUpdateActor` hook that mutates the change set in place. It is
//      installed on EVERY client (this file is an esmodule), so a player's own
//      write is clamped on their client before it is sent.
// The floor never raises HP above Max and never writes HP up by itself: it only
// lifts a write that asked for LESS than the floor, and only for a holder whose
// current HP is already at or above it. Only test/cleanup may bypass it, with the
// update option `fuHpFloorBypass: true`.
// ============================================================================
export const HP_FLOOR_KEY = "hp_floor";
export const HP_FLOOR_BYPASS_OPTION = "fuHpFloorBypass";
const HP_PATH = "system.props.current_hp";
const MAX_PATH = "system.props.max_hp";

// Highest floor among the enabled, unsuppressed effects (0 = none). `effects`
// is any iterable of ActiveEffect-like { disabled, isSuppressed, changes[] }.
export function hpFloorFromEffects(effects) {
  let floor = 0;
  for (const e of effects ?? []) {
    if (!e || e.disabled || e.isSuppressed === true) continue;
    for (const c of e.changes ?? []) {
      if (c?.key !== HP_FLOOR_KEY) continue;
      const n = Number(c.value);
      if (Number.isFinite(n) && n > floor) floor = n;
    }
  }
  return floor;
}

// The live floor for an actor (0 = none). Reads change rows, not prepared data.
export function actorHpFloor(actor) {
  if (!actor) return 0;
  return hpFloorFromEffects(actor.appliedEffects ?? actor.effects);
}

// Post-floor HP for a damage path that computed `hp` from `curHp`. Never raises
// above `curHp` (a holder already below the floor stays put) or above `maxHp`.
export function floorHp(hp, { curHp, maxHp, floor }) {
  const f = Number(floor);
  if (!(f > 0) || !(Number(curHp) > 0) || !(Number(hp) < f)) return hp;
  let ceiling = Math.min(f, Number(curHp));
  if (Number(maxHp) > 0) ceiling = Math.min(ceiling, Number(maxHp));
  return Math.max(hp, ceiling);
}

function readKey(change, path) {
  if (change == null) return { found: false };
  if (Object.prototype.hasOwnProperty.call(change, path)) return { found: true, flat: true, value: change[path] };
  let o = change;
  for (const part of path.split(".")) {
    if (o == null || typeof o !== "object" || !(part in o)) return { found: false };
    o = o[part];
  }
  return { found: true, flat: false, value: o };
}

function writeKey(change, path, hit, value) {
  if (hit.flat) { change[path] = value; return; }
  const parts = path.split(".");
  let o = change;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

// Mutates `change` so a current_hp write is no lower than the floor.
// ctx = { curHp, maxHp, floor }. Returns { changed, from, to }.
export function clampHpChange(change, ctx) {
  const none = { changed: false };
  const hit = readKey(change, HP_PATH);
  if (!hit.found) return none;
  const want = Number(hit.value);
  if (hit.value === null || hit.value === "" || !Number.isFinite(want)) return none;
  const newMax = readKey(change, MAX_PATH);
  const maxFromChange = newMax.found ? Number(newMax.value) : NaN;
  const maxHp = Number.isFinite(maxFromChange) ? maxFromChange : Number(ctx?.maxHp);
  const to = floorHp(want, { curHp: Number(ctx?.curHp), maxHp, floor: ctx?.floor });
  if (to === want) return none;
  writeKey(change, HP_PATH, hit, to);
  return { changed: true, from: want, to };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : NaN; }

// preUpdateActor handler. Reads the actor only; never cancels the update.
export function hpFloorPreUpdate(actor, change, options) {
  if (options?.[HP_FLOOR_BYPASS_OPTION]) return;
  if (!change) return;
  const floor = actorHpFloor(actor);
  if (!(floor > 0)) return;
  const p = actor?.system?.props ?? {};
  clampHpChange(change, { curHp: num(p.current_hp), maxHp: num(p.max_hp), floor });
}

let _installed = false;
export function installHpFloorHook() {
  if (_installed || typeof Hooks === "undefined") return false;
  _installed = true;
  Hooks.on("preUpdateActor", (actor, change, options) => { hpFloorPreUpdate(actor, change, options); });
  return true;
}

// Classic scripts (apply-damage-core.js) cannot import; they read this at call time.
if (typeof globalThis !== "undefined") {
  globalThis.FUCompanionHpFloor = { actorHpFloor, floorHp, hpFloorFromEffects, HP_FLOOR_BYPASS_OPTION };
}
installHpFloorHook();
