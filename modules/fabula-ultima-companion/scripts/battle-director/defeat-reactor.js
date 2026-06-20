/**
 * Built-in defeat reactor — the BD-native replacement for the detached
 * `auto-defeat.js` hook. When a creature's HP hits 0 during director combat,
 * this runs the same removal pipeline the legacy hook used to (death animation
 * → drop combatant → delete token), behind the SAME gates:
 *
 *   - DB option `option_autoDefeat` enabled
 *   - token disposition is enemy (-1)
 *   - actor carries `npc_rank` and it is Soldier or Elite (never Champion,
 *     never a PC with no rank)
 *   - `token_option_persist` is false
 *
 * Creatures that fail any gate (PCs, bosses/Champions, allies, persist-flagged
 * tokens, or anything when the option is off) are NOT removed — they stay on
 * the scene at 0 HP and are skipped from turn order by `isDefeatedLive()`, exactly
 * as before.
 *
 * Runs INSIDE settleInstance (registered via registerBuiltinReactor) so it is
 * fully supervised by the FSM — fires on every `hp` resource-ledger event from
 * any commit path (attack/effect damage at the RESOLVE tail, Burn ticks at
 * Start-of-Turn). A one-time sweepDefeat() at conflict_start handles creatures
 * that begin combat already at 0 HP. While the director is active the legacy
 * `auto-defeat.js` updateActor hook is suppressed (legacy-suppressor.js), so this
 * is the single owner of defeat removal — no double-delete.
 *
 * Removal goes through the GM-native `bd.removeCombatant({ tokenUuid })`, which
 * drops the director combatant AND deletes the token (mirrors destroy_summon).
 *
 * Scope note: like the legacy hook, this owns ONLY the physical-removal
 * pipeline. It does not emit a `creature_defeated` reaction event — that emit
 * was the (now director-suppressed) creature-defeated-emitter's job, except for
 * the explicit destroy_summon shatter path.
 */
import { log, warn } from "./logger.js";

// Property paths — kept identical to the legacy auto-defeat hook.
const PATH_DB_OPTION = "system.props.option_autoDefeat";
const PATH_HP = "system.props.current_hp";
const PATH_NPC_RANK = "system.props.npc_rank";
const PATH_TOKEN_PERSIST = "system.props.token_option_persist";

const DEATH_SFX_URL =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Enemy_Death.ogg";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function get(obj, path, fallback = undefined) {
  try {
    const v = foundry.utils.getProperty(obj, path);
    return v ?? fallback;
  } catch { return fallback; }
}

function parseDbOption(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === "on" || s === "true" || s === "1" || s === "yes" || s === "enabled";
}

function isAllowedRank(v) {
  const r = String(v ?? "").trim().toLowerCase();
  if (!r || r === "champion") return false;
  return r === "soldier" || r === "elite";
}

// Foundry-v12-safe disposition getter. tokenLike may be a TokenDocument or a
// placeable Token.
function getDisposition(tokenLike) {
  if (tokenLike?.documentName === "Token" && typeof tokenLike?.disposition !== "undefined") {
    return tokenLike.disposition;
  }
  if (tokenLike?.document && typeof tokenLike.document.disposition !== "undefined") {
    return tokenLike.document.disposition;
  }
  if (typeof tokenLike?.disposition !== "undefined") return tokenLike.disposition;
  return undefined;
}

// Resolve the option_autoDefeat flag off the current game's DB settings actor.
async function autoDefeatEnabled() {
  const api = globalThis?.FUCompanion?.api ?? window?.FUCompanion?.api;
  if (!api || typeof api.getCurrentGameDb !== "function") {
    warn("defeat-reactor: getCurrentGameDb() unavailable — treating option as OFF");
    return false;
  }
  try {
    const resolved = await api.getCurrentGameDb();
    const db = resolved?.db ?? null;
    if (!db) return false;
    return parseDbOption(get(db, PATH_DB_OPTION));
  } catch (e) {
    warn("defeat-reactor: getCurrentGameDb() failed", e);
    return false;
  }
}

// Gate check identical to legacy auto-defeat (minus the HP===0 test, done by
// the caller). Returns true only if this creature/token should be removed.
function passesActorGates(actor) {
  if (!actor) return false;
  if (Boolean(get(actor, PATH_TOKEN_PERSIST, false))) return false;
  const rank = get(actor, PATH_NPC_RANK, undefined);
  if (rank === undefined || rank === null || String(rank).trim() === "") return false;
  if (!isAllowedRank(rank)) return false;
  return true;
}

// Run the death animation then remove the combatant + token via the director.
async function performDefeat(director, tokenDoc, actor) {
  if (!game.user?.isGM) return;            // director removal is GM-only
  const tokenUuid = tokenDoc?.uuid;
  if (!tokenUuid) return;
  const placeable = tokenDoc?.object ?? null;   // for Sequencer .on(token)
  const name = tokenDoc?.name ?? actor?.name ?? "Creature";

  const bd = globalThis.FUCompanion?.api?.experimental?.battleDirector;
  const remove = async () => {
    if (typeof bd?.removeCombatant === "function") {
      const res = await bd.removeCombatant({ tokenUuid });
      if (!res?.ok) {
        warn(`defeat-reactor: removeCombatant failed — ${res?.error}`);
        try { await tokenDoc.delete(); } catch (e) { warn("defeat-reactor: token delete fallback threw", e); }
      }
    } else {
      try { await tokenDoc.delete(); } catch (e) { warn("defeat-reactor: token delete threw", e); }
    }
  };

  // Mirror the legacy auto-defeat animation chain. If Sequencer or the placeable
  // is unavailable (token off-canvas / inactive scene), skip straight to removal.
  try {
    if (typeof Sequence === "function" && placeable) {
      await new Sequence()
        .sound(DEATH_SFX_URL)
        .animation().on(placeable).tint("#ff0000").waitUntilFinished()
        .animation().on(placeable).fadeOut(1000).waitUntilFinished()
        .thenDo(async () => {
          await remove();
          ChatMessage.create({ content: `<b>${name}</b> was defeated!` });
        })
        .play();
    } else {
      await remove();
      ChatMessage.create({ content: `<b>${name}</b> was defeated!` });
    }
    log(`defeat-reactor: removed ${name} (HP 0, gates passed)`);
  } catch (e) {
    warn("defeat-reactor: performDefeat animation threw — removing without animation", e);
    try { await remove(); } catch (e2) { warn("defeat-reactor: fallback remove threw", e2); }
  }
}

// Resolve a TokenDocument for the defeated actor: prefer the ledger payload's
// token, fall back to the actor's first active enemy token.
async function resolveDefeatedToken(actor, payload) {
  const uuid = payload?.subjectTokenUuid ?? payload?.sourceTokenUuid ?? null;
  if (uuid) {
    const doc = await fromUuid(uuid).catch(() => null);
    if (doc) return doc?.document ?? doc;     // normalize Token → TokenDocument
  }
  const tokens = actor?.getActiveTokens?.(true, true) ?? [];
  return tokens[0]?.document ?? tokens[0] ?? null;
}

// Evaluate ONE actor at HP 0 and remove it if the gates pass.
async function evaluateDefeat(director, actor, payload) {
  if (!actor) return false;
  if (num(get(actor, PATH_HP)) !== 0) return false;     // only at exactly 0
  if (!passesActorGates(actor)) return false;
  if (!(await autoDefeatEnabled())) return false;

  const tokenDoc = await resolveDefeatedToken(actor, payload);
  if (!tokenDoc) { warn(`defeat-reactor: ${actor.name} at HP 0 but no token found — skip`); return false; }

  // Enemy disposition gate (-1).
  const disposition = getDisposition(tokenDoc);
  if (disposition !== -1) return false;

  await performDefeat(director, tokenDoc, actor);
  return true;
}

// Built-in reactor — settleInstance invokes this per ledger event.
export async function defeatReactor(director, cfg) {
  if (!director?.ctx) return;
  const payload = cfg?.payload ?? {};
  if (String(payload.resource ?? "").toLowerCase() !== "hp") return;   // defeat is HP-only
  await evaluateDefeat(director, cfg.casterActor, payload);
}

// One-time sweep over all combatants — removes creatures that begin combat
// already at 0 HP (the event-driven reactor only fires on HP changes).
export async function sweepDefeat(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  for (const c of combatants) {
    const actor = c.actor ?? (c.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor) continue;
    await evaluateDefeat(director, actor, { subjectTokenUuid: c.tokenUuid ?? null });
  }
}
