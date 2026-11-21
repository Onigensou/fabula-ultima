// ============================================================================
// Battle opening styles — a boss can own the whole battle start (pure registry; no Foundry, Node-testable).
//
// The usual start is: the shatter breaks, a beat on the empty stage, the party run in, the enemies enter, the HUD,
// BATTLE START. An enemy whose actor carries
//
//     flags["fabula-ultima-companion"].battleOpening = "<style>"
//
// claims the opening instead, when that style is registered here: the shatter's break is replaced by the style's
// crack-out, and the entrance by the style's show (battle-opening.js runs both, on every client). First user:
// Nidhogg ("nidhogg-awakening", sealing-crystal/nidhogg-awakening-show.js), the user's direction 2026-11-19.
//
// A style (registerBattleOpening(name, spec)):
//   crackOut(ctx) -> Promise   OPTIONAL. Replaces the glass break; plays over the cracked frame and resolves on
//                              black. ctx: battle-transition/shatter-transition.js CRACK_OUT_CONTRACT. Absent = the
//                              screen simply goes black where the glass would have broken.
//   crackOutMs                 how long the crack-out lasts (ms): the bound a client that could not play it (hidden
//                              window, no shatter) waits before its show starts, and part of the GM's bound
//   play(ctx) -> { arrived, done }   REQUIRED. The show, on THIS client, from the black. ctx (battle-opening.js):
//                              { spec, scene, boss (Token|null), party (Token[]: party + guests), others (Token[]:
//                              every other enemy), cover (the black DOM cover: set(level, { vignette }) / fadeTo /
//                              drop), fadeIn(tokens) -> Promise }. `arrived` resolves once the camera is back at
//                              the battle position and the party has faded in (the GM then persists the tokens and
//                              the usual start goes on: HUD, BATTLE START); `done` when everything of it is over.
//   spanMs(spec) -> number     REQUIRED. ms from the black until `arrived` (the GM's bound, and what a GM that draws
//                              nothing waits).
//
// The pick is the GM's: the first enemy, in roster order, whose flag names a registered style.
// ============================================================================

export const FLAG_NS = "fabula-ultima-companion";
export const FLAG_KEY = "battleOpening";

const STYLES = new Map();

/** Register (or replace) a battle opening style. */
export function registerBattleOpening(name, spec) {
  const key = String(name ?? "").trim();
  if (!key) throw new Error("battle-opening: a style needs a name");
  if (typeof spec?.play !== "function") throw new Error(`battle-opening: "${key}" needs play(ctx)`);
  if (typeof spec?.spanMs !== "function") throw new Error(`battle-opening: "${key}" needs spanMs(spec)`);
  STYLES.set(key, Object.freeze({ crackOutMs: 0, ...spec, name: key }));
  return key;
}
export function battleOpeningStyle(name) { return STYLES.get(String(name ?? "").trim()) ?? null; }
export function battleOpeningNames() { return [...STYLES.keys()]; }
/** Tests: forget a style. */
export function unregisterBattleOpening(name) { return STYLES.delete(String(name ?? "").trim()); }

/** The style an actor's flags name (a trimmed string), or null. Registered or not: see pickBattleOpening. */
export function battleOpeningFromFlags(flags) {
  const v = flags?.[FLAG_NS]?.[FLAG_KEY];
  if (typeof v !== "string") return null;
  const k = v.trim();
  return k && k !== "none" && k !== "off" ? k : null;
}

/**
 * The opening for an encounter. enemies: [{ id, flags }] in roster order (flags = the token's actor flags).
 * -> { key, bossId } for the first enemy naming a REGISTERED style, else null (an unknown name is skipped, so a typo
 * or a style that failed to load falls back to the usual start).
 */
export function pickBattleOpening(enemies = [], has = (k) => STYLES.has(k)) {
  for (const e of Array.isArray(enemies) ? enemies : []) {
    const key = battleOpeningFromFlags(e?.flags);
    if (key && has(key)) return { key, bossId: e?.id ?? null };
  }
  return null;
}
