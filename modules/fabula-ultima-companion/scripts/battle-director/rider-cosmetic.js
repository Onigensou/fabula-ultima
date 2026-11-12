// rider-cosmetic.js — a damage rider's own shot, played at impact.
//
// A creature_will_deal_damage rider (adjust_damage) folds into the action card:
// it never reaches a chain, so a play_animation row can't show it. This plays a
// cosmetic for it from RESOLVE, right after the struck creature's damage write.
//
// DATA (opt-in, per carrier):
//   flags.fabula-ultima-companion.riderCosmetic = { variant: "<take>" }
// on the rider's CARRIER: the item (Giant Killer) or the ActiveEffect (Lockdown's
// debuff). The shot is the carrier item's animation_script, or for an AE carrier
// the script of the skill that applied it (directorAppliedBy.skillUuid, else the
// AE's parent item). The script gets payload.variant and payload.amount (the
// rider's own number on this target, e.g. +4 / -4); caster = the attacker's token,
// target = the struck creature's token.
//
// Matched by the op `source`, which computeSenderDamageBonuses stamps with the
// carrier's name. Display only: GM-side call, the script itself broadcasts
// (pseudo.play), nothing waits on it, a failure never touches the hit.

import { log, warn } from "./logger.js";

const NS = "fabula-ultima-companion";

function carrierFor(actor, source) {
  if (!actor || !source) return null;
  const item = actor.items?.find?.((i) => i.name === source && i.flags?.[NS]?.riderCosmetic) ?? null;
  if (item) return { kind: "item", doc: item, spec: item.flags[NS].riderCosmetic };
  const effs = [...(actor.appliedEffects ?? []), ...(actor.effects?.contents ?? [])];
  const ae = effs.find((e) => e?.name === source && !e.disabled && e.flags?.[NS]?.riderCosmetic) ?? null;
  if (ae) return { kind: "ae", doc: ae, spec: ae.flags[NS].riderCosmetic };
  return null;
}

async function scriptItemOf(c) {
  if (c.kind === "item") return c.doc;
  const by = c.doc.flags?.[NS]?.directorAppliedBy?.skillUuid;
  const applied = by ? await fromUuid(by).catch(() => null) : null;
  if (applied) return applied;
  if (c.doc.parent?.documentName === "Item") return c.doc.parent;
  const origin = c.doc.origin ? await fromUuid(c.doc.origin).catch(() => null) : null;
  return origin?.documentName === "Item" ? origin : null;
}

/** Play every opted-in rider cosmetic that changed this target row's damage. */
export async function playRiderCosmetics({ attackerActor, attackerTokenUuid, row } = {}) {
  const ops = row?.bonusBreakdown?.ops ?? [];
  if (!ops.length || !row?.tokenUuid) return;
  const bySource = new Map();
  for (const o of ops) {
    if (!o?.source || o.op === "keyword" || o.op === "element") continue;
    const amt = Number(o.amount) || 0;
    if (!amt) continue;
    bySource.set(o.source, (bySource.get(o.source) ?? 0) + (o.op === "subtract" ? -Math.abs(amt) : amt));
  }
  if (!bySource.size) return;
  const anim = await import("./director-animation.js");
  for (const [source, amount] of bySource) {
    try {
      const c = carrierFor(attackerActor, source);
      if (!c) continue;
      const item = await scriptItemOf(c);
      if (!item) continue;
      const res = await anim.playCarrierAnimation({
        item, casterTokenUuid: attackerTokenUuid, targetTokenUuids: [row.tokenUuid],
        variant: c.spec?.variant ?? null, amount,
      });
      log(`[rider-cosmetic] ${source} → ${row.name ?? row.tokenUuid} (${amount}): ${res?.played ? "played" : res?.reason}`);
    } catch (e) { warn("[rider-cosmetic] threw", source, e); }
  }
}
