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
 * Scope note: this owns the physical-removal pipeline AND (since the on-death
 * reaction work) the `creature_defeated` emit for normal HP→0 deaths. The emit
 * fires the dying creature's own + observer reactions INLINE, before removal,
 * so a self-targeted on-death passive (Fire Slime's Flame Burst) reacts while
 * the token still exists — see emitCreatureDefeated below. The legacy detached
 * creature-defeated-emitter stays director-suppressed; destroy_summon keeps its
 * own explicit shatter-path emit (observer-only, summoner reacts).
 */
import { log, warn } from "./logger.js";

// Property paths — kept identical to the legacy auto-defeat hook.
const PATH_DB_OPTION = "system.props.option_autoDefeat";
const PATH_HP = "system.props.current_hp";
const PATH_NPC_RANK = "system.props.npc_rank";
const PATH_TOKEN_PERSIST = "system.props.token_option_persist";
// Guest marker (Guest system) — a GM-owned, party-side NPC that has no HP and
// can never be defeated. A guest is skipped from BOTH removal (passesActorGates)
// and the Defeated-status applier (evaluateDefeatStatus), so it stays on the
// scene regardless of HP. Mirrors the token_option_persist opt-out.
const PATH_GUEST = "flags.fabula-ultima-companion.bdGuest";
function isGuest(actor) { return Boolean(get(actor, PATH_GUEST, false)); }

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

// Actor-level live-defeat signal (mirrors DirectorCombatant.isDefeatedLive but
// takes a raw actor). The canonical gate for "this creature is DOWN": HP <= 0.
// A downed creature forfeits turns (isDefeatedLive), takes NO free action, and
// triggers NO reaction — EXCEPT its own `creature_defeated` on-death emit. Kept
// here (the defeat domain module) and imported by free-actions + skill-effects so
// all three read one definition. `num` returns null on a bad read → not defeated.
export function isActorDefeated(actor) {
  const hp = num(get(actor, PATH_HP));
  return hp != null && hp <= 0;
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
  if (isGuest(actor)) return false;               // guests are never removed
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
  // Clone-actor cleanup (summon_clone_target). Capture the flags BEFORE removal —
  // the token is gone afterward. A cloned summon (reanimated minion, captured
  // monster) carries the persisted clone-actor uuid + a delete-on-despawn flag;
  // delete that Actor whenever the token despawns for ANY reason (0-HP defeat,
  // battle-end, GM reap), so the clone never leaks into the world folder. This is
  // the general twin of destroy_summon's own clone cleanup — that path only
  // covers explicit shatter (Detonate / manual destroy), while a minion killed by
  // damage flows through here. Mirrors destroy_summon's capture semantics.
  const _cf = tokenDoc?.flags?.["fabula-ultima-companion"] ?? {};
  const _cloneUuid = _cf.cloneActorUuid ?? null;
  // Reaching performDefeat means a real 0-HP defeat (removal gates passed), so a
  // persistent summon (deleteCloneOnDeath) is genuinely destroyed here → reclaim its
  // clone Actor, same as a within-battle clone (deleteCloneOnDespawn). A persistent
  // summon that merely LEAVES at battle end never flows through here, so it survives.
  const _delClone = !!_cloneUuid && (
    _cf.deleteCloneOnDespawn === true || String(_cf.deleteCloneOnDespawn) === "true"
    || _cf.deleteCloneOnDeath === true || String(_cf.deleteCloneOnDeath) === "true"
  );
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
    if (_delClone) {
      try {
        const ca = await fromUuid(_cloneUuid).catch(() => null);
        if (ca?.documentName === "Actor") await ca.delete();
      } catch (e) { warn("defeat-reactor: clone actor delete threw", e); }
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

  // Disposition gate — a rank-eligible (Soldier/Elite) minion of ANY allegiance
  // is removed on death: enemy (-1), neutral (0), or ally/friendly (1). The
  // creature_defeated on-death emit already fired in defeatReactor before this,
  // so their death reactions still resolve. Secret (-2) tokens are left in place.
  const disposition = getDisposition(tokenDoc);
  if (![-1, 0, 1].includes(disposition)) return false;

  await performDefeat(director, tokenDoc, actor);
  return true;
}

// Fire the dying creature's OWN (and observers') `creature_defeated` reactions
// BEFORE the physical removal below, so a self-targeted on-death passive (e.g.
// Fire Slime's Flame Burst) can react while its token still exists. The settle
// loop's normal authored dispatch can't cover this case: the builtin defeat
// removal runs first and `collectReactors` skips the removed/defeated subject,
// so a self-reaction on the dying creature would never be collected. Deduped
// per actor via the settle's shared `firedKeys` set so a multi-event kill (e.g.
// a multi-hit attack) only fires the death reaction once. Observer reactions
// (creature_defeated is observer-aware) fan out to every live combatant.
async function emitCreatureDefeated(director, actor, payload, firedKeys) {
  if (!actor) return;
  const key = `cdef:${actor.uuid}`;
  if (firedKeys?.has?.(key)) return;
  firedKeys?.add?.(key);

  const tokenDoc = await resolveDefeatedToken(actor, payload);
  // dispatchReactionMenu requires a live placeable token (menu anchor + owner
  // resolution). Prefer the ledger token's placeable, else find one by actor.
  const placeable =
    tokenDoc?.object
    ?? canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === actor.uuid)
    ?? null;

  // creature_defeated payload: subject = the defeated creature (reaction_source
  // self/ally/enemy keys off sourceActorUuid). `element` carries the killing
  // damage's type so a `TRIGGER_DAMAGE_IS_<ELEMENT>` gate (Flame Burst's
  // "non-Ice" condition) resolves; `cause`/`causeActorUuid` forward the killer.
  // `summonedBy`/`isPhantasm` mirror destroy_summon's explicit-shatter payload so
  // SUBJECT_IS_MY_PHANTASM also matches a phantasm shattered by DAMAGE (PV→0 from
  // an attack), not just by destroy_summon — powers Phantasmal Echo / Zero
  // Trigger: Shattered Phantasm on the common "enemy killed my phantasm" case.
  // Read from token flags + actor props exactly as skill-effects.destroy_summon.
  const NS = "fabula-ultima-companion";
  const tokenFlags = tokenDoc?.flags?.[NS] ?? {};
  const defeatedPayload = {
    trigger:          "creature_defeated",
    sourceActorUuid:  actor.uuid,
    sourceTokenUuid:  tokenDoc?.uuid ?? null,
    subjectActorUuid: actor.uuid,
    subjectTokenUuid: tokenDoc?.uuid ?? null,
    summonedBy:       tokenFlags.summonedBy ?? null,
    isPhantasm:       !!(actor?.system?.props?.isPhantasm || tokenFlags.isPhantasm),
    element:          payload?.element ?? null,
    cause:            payload?.cause ?? null,
    causeActorUuid:   payload?.causeActorUuid ?? null,
    causeTokenUuid:   payload?.causeTokenUuid ?? null,
  };

  try {
    const { collectReactors, dispatchReactionMenu } = await import("./standalone-reactions.js");
    const reactors = await collectReactors(director);   // observers (live combatants)
    // collectReactors skips `defeated` combatants — ensure the dying subject
    // ITSELF is in the list so its own creature_defeated reaction can fire.
    if (placeable && !reactors.some((r) => r.actor?.uuid === actor.uuid)) {
      reactors.push({ actor, token: placeable });
    }
    for (const { actor: ra, token } of reactors) {
      if (!ra || !token) continue;
      await dispatchReactionMenu({
        director, reactor: ra, token,
        trigger: "creature_defeated", payload: defeatedPayload,
      });
    }
  } catch (e) {
    warn(`defeat-reactor: emitCreatureDefeated dispatch threw for ${actor?.name}`, e);
  }
}

// ── KO / Defeated status (survivors kept on the scene at 0 HP) ────────────
// A visible, reversible marker for creatures that hit 0 HP but are NOT physically
// removed (PCs, Champions/bosses, persist tokens, and anything when auto-defeat is
// off). Mirrors the crisis-reactor reconcile: apply at HP ≤ 0, remove at HP > 0
// (revive). Carries `preventFreeAttack` so the existing free-action suppression
// also recognizes it, plus a `bdDefeated` marker other systems can gate on. The
// system's canonical "KO" status supplies the token overlay. Removed creatures
// never get it — the caller skips this when evaluateDefeat took the token.
//
// KO status (CONFIG.statusEffects id, name "KO", Incapacitate icon) is referenced
// by id, exactly as the Crisis AE references its own status id. This world has no
// core "dead" status.
const KO_STATUS_ID = "4g2B0rdJ3SiUQvUv";
const KO_STATUS_IMG = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/Incapacitate.png";
function isKoAE(e) {
  if (!e || e.disabled === true) return false;
  return e.flags?.["fabula-ultima-companion"]?.bdDefeated === true;
}
function findKoAEs(actor) {
  return (actor?.effects?.contents ?? []).filter(isKoAE);
}
function buildKoData() {
  return {
    name: "KO",
    img: KO_STATUS_IMG,
    statuses: [KO_STATUS_ID],            // renders the KO token overlay
    duration: {},                        // indefinite until HP recovers
    changes: [],                         // marker only — no computable changes
    flags: { "fabula-ultima-companion": { bdDefeated: true, preventFreeAttack: true } },
  };
}
// Reconcile ONE surviving actor's Defeated AE against current HP. Idempotent:
// applies once at HP ≤ 0, removes at HP > 0, collapses accidental duplicates.
async function evaluateDefeatStatus(actor) {
  if (!actor) return null;
  if (isGuest(actor)) return null;                // guests never show Defeated
  const hp = num(get(actor, PATH_HP));
  if (hp == null) return null;
  const down = hp <= 0;
  const existing = findKoAEs(actor);
  if (down && existing.length === 0) {
    await actor.createEmbeddedDocuments("ActiveEffect", [buildKoData()]);
    log(`defeat-reactor: applied Defeated status to ${actor.name} (hp ${hp})`);
    return "applied";
  }
  if (!down && existing.length > 0) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map((e) => e.id).filter(Boolean));
    log(`defeat-reactor: removed Defeated status from ${actor.name} (hp ${hp} > 0 — revived)`);
    return "removed";
  }
  if (down && existing.length > 1) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existing.slice(1).map((e) => e.id).filter(Boolean));
  }
  return null;
}

// Built-in reactor — settleInstance invokes this per ledger event, passing the
// shared `firedKeys` dedup set as the third arg.
export async function defeatReactor(director, cfg, extra) {
  if (!director?.ctx) return;
  const payload = cfg?.payload ?? {};
  if (String(payload.resource ?? "").toLowerCase() !== "hp") return;   // defeat is HP-only
  const actor = cfg.casterActor;
  // On-death reactions fire FIRST (token still present), removal SECOND. Gated
  // on HP ≤ 0 (independent of the removal gates, so bosses/PCs that stay on the
  // scene still fire their on-death passives). `num` returns null on a bad read
  // — guard so a null doesn't coerce to 0 and false-trigger.
  const hp = num(get(actor, PATH_HP));
  if (actor && hp != null && hp <= 0) {
    await emitCreatureDefeated(director, actor, payload, extra?.firedKeys);
  }
  const removed = await evaluateDefeat(director, actor, payload);
  // Survivors (not physically removed) get the visible, reversible Defeated
  // status; recovery (HP > 0) reconciles it off on the same reactor. Removed
  // creatures are gone — skip.
  if (!removed) await evaluateDefeatStatus(actor);
}

// One-time sweep over all combatants — removes creatures that begin combat
// already at 0 HP (the event-driven reactor only fires on HP changes).
export async function sweepDefeat(director) {
  const combatants = director?.dCombat?.combatants ?? director?.dCombat?.turns ?? [];
  for (const c of combatants) {
    const actor = c.actor ?? (c.actorUuid ? await fromUuid(c.actorUuid).catch(() => null) : null);
    if (!actor) continue;
    const removed = await evaluateDefeat(director, actor, { subjectTokenUuid: c.tokenUuid ?? null });
    if (!removed) await evaluateDefeatStatus(actor);
  }
}
