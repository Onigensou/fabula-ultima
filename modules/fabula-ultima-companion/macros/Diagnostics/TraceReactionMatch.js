// [Diagnostic] Trace why Phantasmal Echo isn't firing.
//
// 1. Verify the summoner (Hina) has Phantasmal Echo as an owned item.
// 2. Build a synthetic creature_defeated payload as if the phantasm just died.
// 3. Call oni.ReactionTriggerCore.collectReactionsForTrigger directly with that
//    payload and report what matched.
// 4. Inspect Phantasmal Echo's reaction_config_table row 0 fields as the
//    triggerCore sees them.

const TAG = "[Diag][TraceReactionMatch]";
const payload = (typeof __PAYLOAD !== "undefined" && __PAYLOAD) ? __PAYLOAD : (globalThis.__PAYLOAD ?? {});
const summonerActorUuid = payload.summonerActorUuid ?? "Actor.dafTLBUscCDNgq8H";
const phantasmTokenUuid = payload.phantasmTokenUuid ?? "Scene.jvvy4FvYYmCJtLoz.Token.Ns1ruW3ICdYBAfeL";

const summonerActor = await fromUuid(summonerActorUuid);
const phantasmToken = await fromUuid(phantasmTokenUuid);

const ownedReactions = (summonerActor?.items?.contents ?? [])
  .filter(it => it?.system?.props?.isReaction)
  .map(it => ({
    uuid: it.uuid,
    name: it.name,
    triggers: (it.system?.props?.reaction_config_table
      ? Object.values(it.system.props.reaction_config_table)
      : []
    ).filter(r => r && !r.$deleted).map(r => ({
      trigger: r.reaction_trigger,
      source: r.reaction_source,
      subject_kind: r.reaction_subject_kind,
      ownership: r.reaction_ownership,
      effect_ref: r.reaction_effect_ref,
      isPassive: r.reaction_isPassive,
    })),
  }));

// Build a creature_defeated payload mirroring what the emitter produces.
const synthPayload = {
  trigger: "creature_defeated",
  tokenUuid: phantasmTokenUuid,
  targetUuid: phantasmTokenUuid,
  targets: [phantasmTokenUuid],
  actorUuid: phantasmToken?.actor?.uuid ?? null,
  targetActorUuid: phantasmToken?.actor?.uuid ?? null,
  defeatedTokenUuid: phantasmTokenUuid,
  defeatedActorUuid: phantasmToken?.actor?.uuid ?? null,
  source: "trace-diag",
};

const tc = window["oni.ReactionTriggerCore"] ?? null;
const collected = tc?.collectReactionsForTrigger
  ? tc.collectReactionsForTrigger("creature_defeated", synthPayload)
  : null;

// Test each filter individually against Phantasmal Echo's row 0
const phEchoItem = (summonerActor?.items?.contents ?? []).find(it => it.name === "Phantasmal Echo");
let filterTrace = null;
if (phEchoItem && tc) {
  const row0 = phEchoItem.system?.props?.reaction_config_table?.["0"] ?? null;
  const reactorToken = summonerActor.getActiveTokens?.(true, true)?.[0] ?? null;
  const combat = game.combat;
  filterTrace = {
    row0,
    sourceMatch: row0 ? tc.reactionSourceMatchesRow(row0.reaction_source, reactorToken, "creature_defeated", synthPayload, combat) : null,
    damageTypeMatch: row0 ? tc.reactionDamageTypeMatchesRow(row0.reaction_damage_type, "creature_defeated", synthPayload) : null,
    debuffCountMatch: row0 ? tc.reactionDebuffCountMatchesRow(row0.reaction_debuff_count_target, row0.reaction_debuff_count_min, reactorToken, "creature_defeated", combat) : null,
    subjectKindMatch: row0 && tc.reactionSubjectKindMatchesRow
      ? tc.reactionSubjectKindMatchesRow(row0.reaction_subject_kind, "creature_defeated", synthPayload, combat) : "(matcher not exposed)",
    ownershipMatch: row0 && tc.reactionOwnershipMatchesRow
      ? tc.reactionOwnershipMatchesRow(row0.reaction_ownership, reactorToken, "creature_defeated", synthPayload, combat) : "(matcher not exposed)",
    reactorTokenInfo: reactorToken ? { id: reactorToken.id, actorUuid: reactorToken.actor?.uuid } : null,
    phantasmTokenFlags: phantasmToken?.flags ?? {},
    phantasmIsPhantasmProp: !!phantasmToken?.actor?.system?.props?.isPhantasm,
  };
}

return {
  ok: true,
  summoner: { uuid: summonerActorUuid, name: summonerActor?.name ?? null },
  summonerOwnsReactions: ownedReactions.length,
  ownedReactions,
  hasPhantasmalEcho: !!phEchoItem,
  triggerCorePresent: !!tc,
  reactionsCollectedFromSynthEvent: collected ? collected.length : null,
  collected: (collected ?? []).map(r => ({
    tokenName: r.token?.name,
    actorName: r.actor?.name,
    skillNames: r.reactions?.map(rr => rr.item?.name),
  })),
  filterTrace,
};
