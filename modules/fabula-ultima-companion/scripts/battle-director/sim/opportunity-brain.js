// Opportunity Brain — spends the party's crits.
//
// A crit hands the party a free Opportunity, and the sim was DECLINING every one of
// them. That's not neutral: with focus fire concentrating damage, the party crits
// often, and each declined Opportunity is a +4 that never happened. It made every
// fight read harder than it is.
//
// Scope is deliberately narrow (the user's call): always take ADVANTAGE, on a random
// ally. Advantage grants a one-shot `check_mod_all: +4`, and an attack IS a check
// (see resolveAccuracyParts), so the same AE covers accuracy — no separate
// attack-specific key, and no double-counting.
//
// The other options (Affliction, Bonding, …) need judgement the sim doesn't have, so
// they are simply not chosen. That leaves value on the table, which is the honest
// direction to err: the party is stronger than before and still not stronger than a
// real table.
//
// We skip the effect's `pre` phase — that opens the JRPG targeting UI to pick the
// ally, and nothing would answer it — and call `post` directly with the pick already
// made. `post` is the half that actually applies the AE, so the mechanics are the
// real ones; only the prompt is bypassed.

import { log, warn } from "../logger.js";
import { SimMode } from "./sim-mode.js";

function director() {
  try { return globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.() ?? null; }
  catch { return null; }
}

// Which side is the crediting actor on? Only the PARTY takes Opportunities here —
// letting monsters cash theirs in is a separate decision, and not one to make by
// accident while wiring the player AI.
function sideOf(actorUuid) {
  const dc = director()?.dCombat;
  const c = (dc?.combatants ?? []).find(
    (x) => x.actorUuid === actorUuid || x.tokenUuid === actorUuid
  );
  return c?.side ?? null;
}

// A living party token on the canvas, at random (user's spec: "target a random ally").
function randomAllyToken() {
  const dc = director()?.dCombat;
  const allies = (dc?.combatants ?? []).filter((c) => c.side === "party" && !c.isDefeatedLive?.());
  if (!allies.length) return null;

  const shuffled = allies.slice().sort(() => Math.random() - 0.5);
  for (const a of shuffled) {
    const token = canvas?.tokens?.get(a.tokenId) ?? null;
    if (token?.document?.uuid) return token;
  }
  return null;
}

function advantageHandler() {
  try {
    const reg = window["oni.OppEffectRegistry"];
    const entry = reg?.getAll?.().find(([id]) => id === "advantage");
    return entry?.[1] ?? null;
  } catch { return null; }
}

// Replaces OpportunitySystem.offer for the duration of a run. Returns the same shape
// the real offer does: { optionId } on a pick, { cancelled: true } on a decline.
export async function simOpportunity({ actorUuid, actorName } = {}) {
  try {
    const side = sideOf(actorUuid);
    if (side !== "party") {
      SimMode.note("opportunity", `${actorName ?? "an enemy"} declines an Opportunity (sim only spends the party's)`);
      return { cancelled: true };
    }

    const handler = advantageHandler();
    if (!handler?.post) {
      warn("[SIM] Advantage effect not registered — declining the Opportunity");
      return { cancelled: true };
    }

    const token = randomAllyToken();
    if (!token) return { cancelled: true };

    await handler.post(
      { actorUuid, actorName, context: { source: "battle_director", sim: true } },
      { tokenId: token.id, tokenUuid: token.document.uuid },
    );

    SimMode.note("opportunity", `${actorName ?? "someone"} crits → Advantage (+4 to the next check) on ${token.name}`);
    log(`[SIM] Opportunity: Advantage → ${token.name}`);
    return { optionId: "advantage" };
  } catch (e) {
    warn("[SIM] simOpportunity threw — declining", e);
    return { cancelled: true };
  }
}
