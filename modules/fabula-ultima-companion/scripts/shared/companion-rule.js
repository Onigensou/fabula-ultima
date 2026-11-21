// One companion per character — the house rule (user ruling, 2026-11-21).
//
// "A player may only have ONE companion linked to them. This does not count
// summons, which are different." In the rulebook only the Wayfarer's Faithful
// Companion grants one; in this game gear can too (Hunter's Mantle → Spirit
// Hawk), so two sources can meet on one character (Blanche: King Gorger, plus a
// Mantle she might wear).
//
// A COMPANION is any creature whose summon kind is "companion":
//   - linked:  a standing world Actor stamped isPersistentSummon +
//              summonOwnerActorUuid + persistentSummonKind "companion"
//              (Faithful Companion's King Gorger — re-added every conflict by
//              reAddPersistentSummons);
//   - present: a live token spawned this conflict by a `summon` row with
//              summon_kind "companion" (token flags summonedBy +
//              persistentSummonKind "companion": the Mantle's Spirit Hawk).
// Every other summon kind (phantasm, Numen, minion, drakes, Decoy Doll, the
// unnamed bucket) is NOT a companion and is never gated here.
//
// THE GATE: every companion source asks `companionOf(owner)` before it adds
// one; when the owner already has a companion the new source does nothing.
// The companion already linked/present wins — Blanche keeps King Gorger and
// her Mantle's hawk never appears. Callers: applySummonEffect (summon_kind
// "companion"), reAddPersistentSummons (a second linked companion is not
// fielded), and the HAS_COMPANION formula identifier (skill availability).
//
// Plain globals (game / canvas / FUCompanion) plus the director's logger —
// nothing that imports back into the formula module, so no import cycle.

import { log } from "../battle-director/logger.js";

const NS = "fabula-ultima-companion";
export const COMPANION_KIND = "companion";

export function isCompanionKind(kind) {
  return String(kind ?? "").trim().toLowerCase() === COMPANION_KIND;
}

// Live battle tokens, the same precedence the targeting code uses: the
// director's roster first, then the Foundry combat, then the canvas.
function liveTokenDocs() {
  const dc = globalThis.FUCompanion?.api?.experimental?.battleDirector?.getActiveDirector?.()?.dCombat ?? null;
  if (dc?.combatants?.length) return dc.combatants.map((c) => c.tokenDoc).filter(Boolean);
  const combat = globalThis.game?.combat;
  if (combat?.combatants?.size) return [...combat.combatants].map((c) => c.token).filter(Boolean);
  return (globalThis.canvas?.tokens?.placeables ?? []).map((t) => t.document).filter(Boolean);
}

/**
 * The companion `ownerUuid` already has, or null.
 * @param {string} ownerUuid  the owner's ACTOR uuid (what summonedBy / summonOwnerActorUuid hold)
 * @param {object} [opts]
 * @param {string[]} [opts.ignore]  actor / token uuids to leave out (the candidate itself)
 * @param {boolean}  [opts.linkedOnly]  only standing (world-linked) companions
 * @returns {{ name:string, uuid:string, via:"linked"|"present" }|null}
 */
export function companionOf(ownerUuid, { ignore = [], linkedOnly = false } = {}) {
  const owner = String(ownerUuid ?? "").trim();
  if (!owner) return null;
  const skip = new Set((ignore ?? []).filter(Boolean).map(String));
  for (const a of (globalThis.game?.actors?.contents ?? [])) {
    const f = a?.flags?.[NS] ?? {};
    if (!f.isPersistentSummon || !isCompanionKind(f.persistentSummonKind)) continue;
    if (String(f.summonOwnerActorUuid ?? "") !== owner) continue;
    if (skip.has(a.uuid)) continue;
    return { name: a.name, uuid: a.uuid, via: "linked" };
  }
  if (linkedOnly) return null;
  for (const td of liveTokenDocs()) {
    const f = td?.flags?.[NS] ?? {};
    if (String(f.summonedBy ?? "") !== owner || !isCompanionKind(f.persistentSummonKind)) continue;
    if (skip.has(td.uuid) || skip.has(td.actor?.uuid) || skip.has(String(f.cloneActorUuid ?? ""))) continue;
    return { name: td.actor?.name ?? td.name ?? "companion", uuid: td.uuid, via: "present" };
  }
  return null;
}

// The short card + log line a refused companion source shows. Words only: a
// failure here must never break the chain that asked.
export async function announceCompanionRefused({ ownerName = "", held = null, casterToken = null, icon = null, quiet = false } = {}) {
  const line = `${ownerName || "This character"} already has a companion${held?.name ? ` (${held.name})` : ""} — a second companion source does nothing.`;
  log(`companion-rule: ${line}`);
  if (quiet) return line;
  try {
    const { enqueuePassiveCard } = await import("../battle-director/passive-card-ui/director-passive-card-ui.js");
    await enqueuePassiveCard({ title: "Already has a companion", casterToken, icon, mode: "force" });
  } catch { /* no card UI (headless) — the log line stands */ }
  return line;
}
