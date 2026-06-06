/**
 * Migration: 2026-06-06-charge-reaction-aes-on-activation-expiry
 * ---------------------------------------------------------------------------
 * Makes the long-implicit "charge-bearing reaction AE consumes one charge each
 * time it fires" behaviour EXPLICIT via the new `lifetimeMode: "on_activation"`
 * Expiry type.
 *
 * Background: `firePreAcceptedCandidate` used to consume a charge after ANY
 * charge-bearing AE reaction fired. That coupling meant you could not author a
 * charge-bearing AE that ticks WITHOUT consuming (e.g. a Poison whose stacks =
 * intensity and persist while it ticks). The engine now gates consume-on-fire
 * on `lifetimeMode === "on_activation"`, so this migration stamps that mode on
 * every AE that relied on the old implicit behaviour — preserving Burn,
 * Hawkeye's aim buff, Protect's charge refills, and the other charge skills.
 *
 * TARGET: any AE that carries BOTH a `reactionConfig` AND a charge flag
 * (`charges` / `chargesMax` / `chargeKey`) — i.e. exactly the set that was
 * consuming-on-fire before. Pure resource-pool charges (no reactionConfig) are
 * left alone; they were never consumed on fire and keep their own lifecycle.
 *
 * Walks masters (world items) + every applied copy (actor effects, actor-item
 * effects, scene-token actors), mirroring tag-standard-debuffs. IDEMPOTENT.
 */

export const key = "2026-06-06-charge-reaction-aes-on-activation-expiry";
export const description =
  "Set Expiry 'After effect activation' (lifetimeMode=on_activation) on every " +
  "charge-consuming reaction AE so consume-on-fire is explicit (Burn, Hawkeye, Protect, …).";

const NS = "fabula-ultima-companion";

function isChargeReactionAe(ae) {
  const f = ae?.flags?.[NS] ?? {};
  const hasReaction = !!f.reactionConfig && typeof f.reactionConfig === "object";
  const hasCharge =
    f.charges != null ||
    f.chargesMax != null ||
    (typeof f.chargeKey === "string" && f.chargeKey.trim() !== "");
  return hasReaction && hasCharge;
}

async function setOnActivation(ae, log, label) {
  const cur = String(ae.flags?.[NS]?.lifetimeMode ?? "").trim().toLowerCase();
  if (cur === "on_activation") return false;
  try {
    await ae.update({ [`flags.${NS}.lifetimeMode`]: "on_activation" });
    log?.(`  ${label}: "${ae.name}" → on_activation`);
    return true;
  } catch (e) {
    log?.(`  ${label}: "${ae.name}" update failed — ${e?.message ?? e}`);
    return false;
  }
}

export async function migrate(game, log) {
  let n = 0;

  for (const it of game.items?.contents ?? []) {
    for (const ae of it.effects?.contents ?? []) {
      if (isChargeReactionAe(ae) && await setOnActivation(ae, log, `world item "${it.name}"`)) n += 1;
    }
  }

  for (const a of game.actors?.contents ?? []) {
    for (const ae of a.effects?.contents ?? []) {
      if (isChargeReactionAe(ae) && await setOnActivation(ae, log, `actor "${a.name}"`)) n += 1;
    }
    for (const it of a.items?.contents ?? []) {
      for (const ae of it.effects?.contents ?? []) {
        if (isChargeReactionAe(ae) && await setOnActivation(ae, log, `actor "${a.name}" / item "${it.name}"`)) n += 1;
      }
    }
  }

  for (const sc of game.scenes?.contents ?? []) {
    for (const tk of sc.tokens?.contents ?? []) {
      const a = tk.actor;
      if (!a) continue;
      for (const ae of a.effects?.contents ?? []) {
        if (isChargeReactionAe(ae) && await setOnActivation(ae, log, `scene "${sc.name}" / token "${tk.name}"`)) n += 1;
      }
    }
  }

  return { applied: true, summary: `Set on_activation expiry on ${n} charge-reaction AE(s).` };
}
