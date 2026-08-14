// Encyclopedia witness — the single writer-side entry point the director uses
// to mark a hostile NPC's ability as "the party has seen this".
//
// Extracted from state-handlers' `recordNpcActionWitness` (which was the only
// caller until passives were wired in) so the Action Card path and the passive
// /reaction path share ONE implementation of the gates. Before the extraction
// only card-driven actions (`ar.kind` Attack / Skill) were ever recorded, so
// every passive skill on every monster stayed `???` in the journal forever —
// including ones whose name the passive card had just broadcast to every
// client. See [[project_study_passive_witness]].
//
// The witness key is the embedded item `_id` — identical on the prototype and
// on linked/unlinked tokens, because Foundry copies embedded ids from the
// prototype at token creation. The encyclopedia page is keyed by the PROTOTYPE
// actor uuid so knowledge survives the token instance.
//
// GM-only: `recordWitnessedAction` refuses non-GM writes. Every director fire
// path is GM-side (player reaction picks route back through REACTION_CHOICE and
// the GM applies), so no socket relay is needed.
//
// Never throws — witnessing is bookkeeping and must not be able to break an
// action mid-resolve.

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

// The four `system.props` lists the encyclopedia renders, each witness-gated
// per row. An id that appears in none of them has nothing to reveal, so
// recording it would create/dirty a journal page for no visible effect.
// Keep in sync with renderPage's action block (encyclopedia-core.js).
const CATALOGUE_LISTS = [
  "attack_list",
  "skill_active_list",
  "normal_spell_list",
  "skill_passive_list",
];

function encApi() {
  return globalThis.FUCompanion?.api?.encyclopedia ?? null;
}

/**
 * True when `itemId` appears (undeleted) in one of the prototype actor's four
 * catalogued action lists.
 *
 * This gate is what keeps the witness set honest. Without it we would record
 * ids for things the journal never renders — AE carriers, equipment, skill
 * templates — and each one would `upsertPage` a journal page and re-render it
 * for a reveal that shows nothing. It also silently absorbs the stale list rows
 * whose uuid no longer resolves: those were already unrevealable, and now they
 * cost no write either.
 */
function isCatalogued(protoActor, itemId) {
  const props = protoActor?.system?.props ?? {};
  for (const key of CATALOGUE_LISTS) {
    const list = props[key];
    if (!list || typeof list !== "object") continue;
    for (const row of Object.values(list)) {
      if (!row || row.$deleted) continue;
      const uuid = String(row.uuid ?? "").trim();
      if (uuid && uuid.split(".").pop() === itemId) return true;
    }
  }
  return false;
}

/**
 * Read a token's disposition. Accepts a token uuid; tolerates an actor uuid by
 * falling back to the actor's first active token (an AE-carried reaction can
 * reach us with only the actor in hand).
 */
async function resolveDisposition(tokenUuid) {
  try {
    const doc = await fromUuid(tokenUuid);
    if (!doc) return { disposition: 0, tokenUuid: null };
    if (doc.documentName === "Token" || doc.documentName === "TokenDocument") {
      return { disposition: Number(doc.disposition ?? 0), tokenUuid: doc.uuid };
    }
    // Actor uuid — walk to a placed token for its disposition.
    const tok = doc.token ?? doc.getActiveTokens?.()?.[0]?.document ?? null;
    if (!tok) return { disposition: 0, tokenUuid: null };
    return { disposition: Number(tok.disposition ?? 0), tokenUuid: tok.uuid };
  } catch {
    return { disposition: 0, tokenUuid: null };
  }
}

/**
 * Record that the party witnessed `itemUuid` being used by the creature at
 * `tokenUuid`. No-ops (quietly) unless every gate passes:
 *
 *   1. the encyclopedia API is mounted
 *   2. the creature is HOSTILE (disposition -1) — PC and neutral abilities
 *      have no encyclopedia page to reveal
 *   3. the prototype actor uuid resolves (the page key)
 *   4. the item id is CATALOGUED in one of the four rendered lists
 *
 * Returns `{ wasNew }` from the encyclopedia on a successful record, or null
 * when any gate rejected. Callers should ignore the result — this is
 * fire-and-forget bookkeeping.
 */
export async function witnessNpcAbility({ tokenUuid, itemUuid, actionName = null } = {}) {
  try {
    const api = encApi();
    if (!api?.recordWitnessedAction || !api?.resolveActorPrototypeUuid) return null;
    if (!tokenUuid || !itemUuid) return null;

    const { disposition, tokenUuid: resolvedTokenUuid } = await resolveDisposition(tokenUuid);
    if (disposition !== -1) return null;

    const protoUuid = await api.resolveActorPrototypeUuid(resolvedTokenUuid ?? tokenUuid);
    if (!protoUuid) return null;

    const itemId = String(itemUuid).split(".").pop();
    if (!itemId) return null;

    let protoActor = null;
    try { protoActor = await fromUuid(protoUuid); } catch { /* tolerate */ }
    if (!protoActor) return null;
    if (!isCatalogued(protoActor, itemId)) return null;

    const item = protoActor.items?.get?.(itemId) ?? null;
    const name = actionName ?? item?.name ?? "???";

    const result = await api.recordWitnessedAction({
      actorUuid:   protoUuid,
      itemId,
      actionName:  name,
      actionImg:   item?.img ?? "",
      monsterName: protoActor.name ?? "Monster",
    });
    if (result?.wasNew) log(`Encyclopedia: witnessed ${protoActor.name ?? "?"} → ${name} (${itemId})`);
    return result;
  } catch (e) {
    warn("witnessNpcAbility failed", e);
    return null;
  }
}

/**
 * Witness the ability behind a fired reaction/passive candidate.
 *
 * Item carriers witness themselves. AE carriers can't: an AE's id matches no
 * list row, so recording it would reveal nothing. Instead we credit the skill
 * that APPLIED the AE (`directorAppliedBy.skillUuid`) — so a Searing-Brand-style
 * detonation reveals the monster skill that planted it rather than the bearer's
 * status effect.
 *
 * A PC-applied AE firing on a monster is rejected without an explicit
 * ownership test: witnessNpcAbility's catalogue gate only accepts ids present
 * in THIS prototype's own lists, and a PC skill's id is not one of them. That
 * is deliberately the only ownership check — resolveActorPrototypeUuid returns
 * null for an unlinked token's synthetic actor uuid, so comparing prototypes
 * through the skill's `parent` would silently reject legitimate unlinked-token
 * monsters (which is most of them).
 *
 * `reactorTokenUuid` is the CARRIER OWNER's token — the creature whose ability
 * this is — not the action-taker. For a third-party reaction (a PC Protect
 * riding on a monster's attack) those differ, and using the action-taker would
 * write a PC's skill onto the monster's page.
 */
export async function witnessFiredCandidate({ candidate, reactorTokenUuid } = {}) {
  try {
    if (!candidate || !reactorTokenUuid) return null;

    if (candidate.carrierKind === "item") {
      return await witnessNpcAbility({
        tokenUuid:  reactorTokenUuid,
        itemUuid:   candidate.carrierUuid,
        actionName: candidate.carrierName ?? null,
      });
    }

    if (candidate.carrierKind === "ae") {
      const ae = await fromUuid(candidate.carrierUuid).catch(() => null);
      const originSkillUuid = ae?.flags?.[FLAG_NS]?.directorAppliedBy?.skillUuid ?? null;
      if (!originSkillUuid) return null;

      return await witnessNpcAbility({
        tokenUuid: reactorTokenUuid,
        itemUuid:  originSkillUuid,
      });
    }

    return null;
  } catch (e) {
    warn("witnessFiredCandidate failed", e);
    return null;
  }
}
