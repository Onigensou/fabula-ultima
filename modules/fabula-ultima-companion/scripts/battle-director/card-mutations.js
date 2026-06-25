// scripts/battle-director/card-mutations.js
//
// In-flight action mutations driven by accepted pre-resolve reactions.
// Centralizes the "what changes when a third-party reaction is applied"
// logic so:
//   1. CONFIRM-stage write site mutates ar.targets / ar.perTargetResults
//      before RESOLVE applies damage. Damage lands on the redirected
//      target.
//   2. Action-card recompute hook reads the same mutations and patches
//      the per-target row DOM at Apply-click time so the player sees
//      the redirect before they confirm.
//
// First effect_kind handled: `redirect_target`. The structure is
// deliberately extensible — future card-mutation kinds (change-element,
// replace-damage, free-add-modifier, etc.) drop in as additional cases
// in `applyOneRow`. Order across kinds is intentional: redirect runs
// FIRST so the target identity is final before damage / element steps
// recompute against it.
//
// Why not run the reaction's effect_table directly? Two reasons:
//   - The legacy `redirect_target` handler in reaction-system/reaction-
//     grant.js targets Foundry ChatMessage cards via the `oni.Reaction
//     RedirectPendingAction` helper. BD action cards are DOM overlays
//     with their data in `director.ctx.actionResult` — different
//     surface, different mutation strategy.
//   - Authors specify the EFFECT (redirect_target) in the skill's
//     effect_table; the BD engine decides WHEN and HOW to apply the
//     in-card mutation. Centralizing it here keeps the per-skill
//     effect rows declarative.
//
// Author contract (effect_kind: "redirect_target"):
//   target_ref       — kept for forward-compat; currently unused (the
//                      subject slot is derived from the candidate's
//                      `subjectActorUuid` which the third-party
//                      dispatcher already stamped).
//   destination_ref  — kept for forward-compat; currently fixed to
//                      "self" (the reactor's actor). Future variants
//                      could redirect to a chosen ally.

import { log, warn } from "./logger.js";
import { resolveTargetRef as resolveBdTargetRef, makeChainContext as makeBdChainContext } from "./skill-targeting.js";

const FLAG_NS = "fabula-ultima-companion";

// Look up the effect_table associated with a pre-pass candidate.
// `carrierKind: "item"` → item.system.props.effect_table.
// `carrierKind: "ae"`   → ae.flags[FLAG_NS].reactionConfig.effect_table.
async function readEffectTableForCandidate(cand) {
  if (!cand?.carrierUuid) return null;
  try {
    const doc = await fromUuid(cand.carrierUuid);
    if (!doc) return null;
    if (cand.carrierKind === "ae") {
      // AE reactionConfigs use the legacy key `reaction_effect_table` (see
      // Acceleration et al.); newer ones may use `effect_table`. Accept both,
      // mirroring firePreAcceptedCandidate's fallback.
      const rc = doc?.flags?.[FLAG_NS]?.reactionConfig;
      return rc?.effect_table ?? rc?.reaction_effect_table ?? null;
    }
    // item carrier (default)
    return doc?.system?.props?.effect_table ?? null;
  } catch (e) {
    warn("card-mutations: readEffectTableForCandidate threw", e);
    return null;
  }
}

// Walk the chain reachable from the candidate's effect_ref. A `chain`
// row expands into its `chain_steps`; everything else is a leaf. Mirrors
// the recursive walk in skill-effects.applyChainEffect but reads-only.
function expandEffectChain(effectTable, startLabel) {
  const out = [];
  const byLabel = new Map();
  for (const r of Object.values(effectTable ?? {})) {
    if (!r || r.$deleted) continue;
    const lbl = String(r.effect_label ?? "").trim();
    if (lbl) byLabel.set(lbl, r);
  }
  const seen = new Set();
  (function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "chain") {
      const steps = String(row.chain_steps ?? "")
        .split(/[,\n]+/g).map((s) => s.trim()).filter(Boolean);
      for (const s of steps) walk(s);
      return;
    }
    out.push(row);
  })(startLabel);
  return out;
}

// Like expandEffectChain, but ALSO descends into the player's CHOSEN
// open_action_menu option(s), matched by display label from `picks`
// (cand.chosenMenuPicks). Mirrors the menu-follow in
// skill-effects.computeSenderDamageBonuses so a picked menu OPTION's effect is
// reachable at the card-mutation phase — used to fold an overcharge tier's
// adjust_cost into the spell's cost (Cataclysm). With no picks it descends into
// no menus, so the menu-only rows are exactly the chosen option's chain.
function expandEffectChainWithPicks(effectTable, startLabel, picks) {
  const out = [];
  const byLabel = new Map();
  for (const r of Object.values(effectTable ?? {})) {
    if (!r || r.$deleted) continue;
    const lbl = String(r.effect_label ?? "").trim();
    if (lbl) byLabel.set(lbl, r);
  }
  const pickSet = (Array.isArray(picks) ? picks : []).map((p) => String(p).trim().toLowerCase());
  const splitRefs = (raw) => String(raw ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  (function walk(label) {
    if (!label || seen.has(label)) return;
    seen.add(label);
    const row = byLabel.get(label);
    if (!row) return;
    const kind = String(row.effect_kind ?? "").trim().toLowerCase();
    if (kind === "chain") {
      for (const s of splitRefs(row.chain_steps)) walk(s);
      return;
    }
    if (kind === "open_action_menu" && pickSet.length) {
      const optRefs = splitRefs(row.menu_option_refs);
      const optLabels = (row.menu_option_labels == null || String(row.menu_option_labels).trim() === "")
        ? [] : String(row.menu_option_labels).split("|").map((s) => s.trim());
      const labelToRef = new Map();
      for (let oi = 0; oi < optRefs.length; oi++) {
        const oref = optRefs[oi];
        const orow = byLabel.get(oref);
        const lbl = (optLabels[oi] && optLabels[oi] !== "")
          ? optLabels[oi] : String(orow?.menu_label ?? orow?.effect_label ?? oref);
        labelToRef.set(String(lbl).trim().toLowerCase(), oref);
      }
      for (const pk of pickSet) {
        const oref = labelToRef.get(pk);
        if (oref) walk(oref);
      }
      return;
    }
    out.push(row);
  })(startLabel);
  return out;
}

// Map damage element names → affinity slot index on PC/NPC templates.
// PC v3 + NPC v.2 templates store affinities as `affinity_1` (Physical)
// through `affinity_9` (Poison). Mirrors the order used by every other
// engine site that reads element-based affinities.
const ELEMENT_TO_AFFINITY_SLOT = {
  physical: 1,
  air:      2,
  bolt:     3,
  dark:     4,
  earth:    5,
  fire:     6,
  ice:      7,
  light:    8,
  poison:   9,
};

// Recompute hit + damage for a new target slot, using the action's
// existing roll context. Mirrors the Attack DECLARE branch's per-target
// math (state-handlers.js ~line 2566). Spells / skills with isCheck=false
// don't have a defense check; their hit defaults to true.
function recomputePerTargetForRedirect({ ar, reactor, reactorTok, applyAffinityToDamage }) {
  // Defense prop: CSB stores the final derived `defense` (and
  // `magic_defense`). Spells + MDEF-tagged Skills target MDEF; others
  // target DEF.
  const props = reactor.system?.props ?? {};
  const isMagicCheck =
    String(ar.kind ?? "").toLowerCase() === "spell" ||
    String(ar.skillType ?? "").toLowerCase() === "spell" ||
    String(ar.defenseTargetType ?? "").toLowerCase() === "mdef";
  const newDef = Number(
    isMagicCheck
      ? (props.magic_defense ?? props.base_magic_defense ?? 10)
      : (props.defense ?? props.base_defense ?? 10)
  );

  const total = Number(ar.roll?.total ?? 0);
  const isFumble = !!ar.roll?.isFumble;
  const isCrit   = !!ar.roll?.isCrit;
  const hasRoll  = ar.roll && typeof ar.roll?.total === "number";

  // For unchecked actions (heals, status-only) the redirect doesn't
  // re-roll — keep hit=true (the original would-be effect lands on
  // the reactor).
  const newHit = !hasRoll
    ? true
    : isCrit ? true : (!isFumble && total >= newDef);

  const elementKey = String(ar.damage?.element ?? "Physical").toLowerCase();
  const slot = ELEMENT_TO_AFFINITY_SLOT[elementKey];
  const rawAff = slot ? String(props[`affinity_${slot}`] ?? "NA") : "NA";
  // CSB stores "NA" for "no special affinity"; the rest of the engine
  // reads "NE" (Neutral). Normalize.
  const affinityCode = (rawAff === "NA" || rawAff === "" || rawAff == null) ? "NE" : rawAff;

  const damageBonus = Number(ar.damage?.base ?? 0);
  const ignoreHR   = !!ar.damage?.ignoreHR;
  const hr = isCrit
    ? Math.max(0, total - Number(ar.roll?.checkBonus ?? 0))
    : (ignoreHR ? 0 : Math.max(0, total - newDef));
  const rawDamage = newHit ? (hr + damageBonus) : 0;
  const finalDamage = newHit ? applyAffinityToDamage(rawDamage, affinityCode) : 0;

  return {
    tokenUuid: reactorTok.uuid,
    actorUuid: reactor.uuid,
    name: reactor.name,
    tokenImg: reactorTok.texture?.src ?? reactor.img,
    disposition: reactorTok.disposition,
    defense: newDef,
    hit: newHit,
    crit: isCrit && newHit,
    rawDamage,
    damage: finalDamage,
    affinity: affinityCode,
    studied: false,
  };
}

// Re-derive ONE target's per-target row through the REAL per-target pipeline
// (buildPerTarget, via computeActionProfile) so a redirected hit respects the
// reactor's DR / crit scaling / weapon efficiency / affinity exactly like a
// direct hit — instead of recomputePerTargetForRedirect's simplified clone
// (which skipped DR/crit/efficiency). Single source of truth = buildPerTarget.
//
// `targetSnap` is a snapshotTargetForToken() snapshot for the destination.
// Reaction damage ops are NOT folded here (no acceptedReactions): the caller's
// add_damage pass (recomputePerTargetDamages) folds them uniformly across ALL
// rows, so folding here too would double-count. Returns a flat perTargetResults
// row, or null if the profile can't be rebuilt (caller falls back to the clone).
async function rederiveTargetRow(ar, targetSnap) {
  try {
    if (!ar || !targetSnap) return null;
    const ap = await import("./action-profile.js");
    const isAttack = String(ar.kind ?? "").toLowerCase() === "attack";
    let view;
    if (isAttack) {
      view = { kind: "Attack", check_mode: "opposed", effect_table: {}, fire_points: {}, source: null };
    } else {
      const skill = ar.skillUuid ? await fromUuid(ar.skillUuid).catch(() => null) : null;
      if (skill) {
        const sr = await import("./skill-recipes.js");
        view = sr.getRuntimeActionView(skill);
      } else {
        view = { kind: ar.kind ?? "Skill", effect_table: {}, fire_points: {}, source: null };
      }
    }
    const dice = (ar.roll && typeof ar.roll.rA === "number")
      ? { rA: ar.roll.rA, rB: ar.roll.rB }
      : null;
    const profile = await ap.computeActionProfile({
      view, ar, attacker: ar.attacker, weapon: ar.weapon ?? null,
      targets: [targetSnap], dice,
      ctx: { round: ar.round ?? 0, attackMode: ar.attackMode },
    });
    const delta = ap.projectProfileToActionResult(profile, ar, [targetSnap]);
    const row = Array.isArray(delta?.perTargetResults) ? delta.perTargetResults[0] : null;
    return row ?? null;
  } catch (e) {
    warn("card-mutations.rederiveTargetRow threw — falling back to redirect clone", e);
    return null;
  }
}

// Resolve the redirect's "source slots" — which targets on the action
// card get moved to the reactor. Reads `target_ref` from the redirect_target
// row, looks up the corresponding targeting row on the carrier item, and
// runs it through the **BD-native** resolver (`skill-targeting.js`).
// The resolver honors:
//   - auto_confirm_when_obvious (1 valid candidate → auto-pick)
//   - exclude_self (the reactor isn't a valid source slot for themselves)
//   - **BD-native target picker** prompt when multiple candidates match
//     and `mode: "exact"` with a count constraint (same UI as Attack's
//     TARGET state). `mode: "all"` resolves to every matching target
//     automatically without a picker — Prophetic Defender's "take the
//     place of all threatened allies" rides on this.
// Returns an ARRAY of actor uuids:
//   - Protect's single-target targeting row → [oneActorUuid]
//   - Prophetic Defender's mode:"all" targeting row → [...allUuids]
// Results are cached on the candidate (`pickedSubjectActorUuids`) so a
// re-recompute (e.g. another pill toggled afterwards) doesn't re-prompt.
// The legacy single-uuid cache (`pickedSubjectActorUuid`) is preserved
// for snapshotReactionDecisions round-trip when N === 1.
async function resolveRedirectSubjects({ cand, row, reactor, reactorTok, ctx }) {
  if (Array.isArray(cand.pickedSubjectActorUuids) && cand.pickedSubjectActorUuids.length) {
    return cand.pickedSubjectActorUuids;
  }
  if (cand.pickedSubjectActorUuid) {
    // Backwards-compat: prior session cached a single-target pick.
    return [cand.pickedSubjectActorUuid];
  }
  const targetRef = String(row?.target_ref ?? "").trim();
  if (!targetRef) {
    warn(`redirect: row "${row?.effect_label}" missing target_ref; falling back to scan-time subject`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  const item = await fromUuid(cand.carrierUuid);
  if (!item) {
    warn(`redirect: cannot resolve carrier item ${cand.carrierUuid}; falling back`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  // Build a BD-native chain ctx. `action_targets` candidate_source reads
  // ctx.actionTargetUuids; we feed the action's full target list from
  // arSnapshot. isPassive:false → the resolver prompts when multiple
  // valid candidates exist and mode requires a pick. `skill` carries the
  // carrier item so the picker title can show the skill name.
  const allTargetTokenUuids = (ctx.ar?.targets ?? [])
    .map((t) => t?.tokenUuid)
    .filter(Boolean);
  const chainCtx = makeBdChainContext({
    reactorActor: reactor,
    reactorToken: reactorTok,
    skill: item,
    actionTargetUuids: allTargetTokenUuids,
    payload: {
      targetTokenUuids: allTargetTokenUuids,
      sourceActorUuid: ctx.ar?.attackerActorRef ?? null,
    },
    isPassive: false,
    remotePrompt: ctx.remotePrompt ?? null,
  });
  const resolved = await resolveBdTargetRef(targetRef, chainCtx);
  if (!resolved?.ok || !resolved.tokens?.length) {
    if (resolved?.cancelled) {
      log(`redirect: player cancelled target pick for ${cand.carrierName}`);
      cand._pickerCancelled = true;
      return [];
    }
    warn(`redirect: BD target resolver failed (${resolved?.reason}); falling back to scan-time subject`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  const pickedUuids = resolved.tokens
    .map((t) => t?.actor?.uuid)
    .filter(Boolean);
  if (!pickedUuids.length) {
    warn(`redirect: resolver returned tokens with no actor uuids`);
    return cand.subjectActorUuid ? [cand.subjectActorUuid] : [];
  }
  // Cache so the next recompute pass doesn't re-prompt. Mirror the
  // single-uuid field when N === 1 so snapshotReactionDecisions'
  // existing round-trip continues to work for Protect.
  cand.pickedSubjectActorUuids = pickedUuids;
  if (pickedUuids.length === 1) cand.pickedSubjectActorUuid = pickedUuids[0];
  return pickedUuids;
}

// Apply a single redirect_target mutation to ctx.
//
// redirect_target is ONE symmetric operation: replace the slot(s) of SOURCE with
// DESTINATION. Both are DECLARED by the row's refs — the direction is never
// inferred from "who happens to be a target" (that proxy mis-fired on an
// all-target AoE, where a reactor-owned Protect's protector is ALSO a target):
//   - SOURCE  = `target_ref` resolved → the action slot(s) to move. Absent → the
//               REACTOR is the source (a target-owned reaction whose answering
//               target redirects its OWN slot — Condemn/Torment).
//   - DEST    = `destination_ref` resolved → the replacement creature. Absent →
//               the REACTOR ("you take their place" — plain Protect shorthand).
// So Protect (target_ref = the protected ally, dest = protect_self → the Guardian)
// moves the ally's slot to the Guardian whether or not the Guardian is also caught
// in the AoE; Torment (no target_ref, dest = a chosen ally) moves the answering
// target's own slot to that ally. No branching, no discriminator.
//
// Returns "applied" | "cancelled" (player aborted a picker) | "failed".
async function applyRedirectTargetMutation(ctx, cand, row) {
  const reactorUuid = cand.reactorActorUuid;
  if (!reactorUuid) { warn(`redirect: missing reactor on candidate`); return "failed"; }
  const reactor = await fromUuid(reactorUuid);
  if (!reactor) { warn(`redirect: reactor actor ${reactorUuid} not resolvable`); return "failed"; }
  const reactorTok = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === reactor.uuid)?.document
    ?? reactor?.getActiveTokens?.()?.[0]?.document
    ?? null;
  if (!reactorTok) { warn(`redirect: no token for reactor ${reactor.name}`); return "failed"; }

  const targetRef = String(row?.target_ref ?? "").trim();
  const destRef   = String(row?.destination_ref ?? "").trim();

  // ── SOURCE: which slot(s) to move ──
  // target_ref → the chosen/auto-resolved subject(s); absent → the reactor's own
  // slot (target-owned reaction). resolveRedirectSubjects caches the pick so a
  // re-recompute pass doesn't re-prompt.
  let sourceActorUuids;
  if (targetRef) {
    cand._pickerCancelled = false;
    sourceActorUuids = await resolveRedirectSubjects({ cand, row, reactor, reactorTok, ctx });
    if (cand._pickerCancelled) return "cancelled";
  } else {
    sourceActorUuids = [reactorUuid];
  }
  if (!sourceActorUuids.length) return "failed";

  // ── DESTINATION: the replacement creature ──
  // destination_ref → resolved (cached); absent → the reactor.
  let destActor = reactor, destTokDoc = reactorTok;
  if (destRef) {
    let destActorUuid = cand.pickedDestActorUuid ?? null;
    if (!destActorUuid) {
      const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
      const chainCtx = makeBdChainContext({
        reactorActor: reactor,
        reactorToken: reactorTok,
        skill: carrier,
        actionTargetUuids: (ctx.ar?.targets ?? []).map((t) => t?.tokenUuid).filter(Boolean),
        payload: { sourceActorUuid: ctx.ar?.attackerActorRef ?? null },
        isPassive: false,   // a real choice — prompt when ambiguous
        remotePrompt: ctx.remotePrompt ?? null,
      });
      const resolved = await resolveBdTargetRef(destRef, chainCtx);
      if (resolved?.cancelled) { cand._pickerCancelled = true; return "cancelled"; }
      const destTok = resolved?.tokens?.[0];
      if (!resolved?.ok || !destTok?.actor) {
        log(`redirect: no destination for ${cand.carrierName} (${resolved?.reason ?? "empty"})`);
        return "failed";
      }
      destActorUuid = destTok.actor.uuid;
      destTokDoc = destTok.document ?? destTok;
      cand.pickedDestActorUuid = destActorUuid;
    } else {
      destTokDoc = null;   // resolve from the cached uuid below
    }
    const a = await fromUuid(destActorUuid).catch(() => null);
    if (a) destActor = a;
    if (!destTokDoc) {
      destTokDoc = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === destActorUuid)?.document
        ?? destActor?.getActiveTokens?.()?.[0]?.document ?? null;
    }
    if (!destActor || !destTokDoc) { warn(`redirect: destination actor/token unresolved`); return "failed"; }
  }

  // ── SWAP each source slot → destination ──
  // Re-derive the destination's row ONCE through buildPerTarget (its defense/
  // affinity/DR is identical across slots); clone per slot (redirectedFrom differs
  // so the card can show "via Protect, originally targeting Hina"). Fall back to
  // the legacy clone only if the profile can't be rebuilt.
  const { applyAffinityToDamage, snapshotTargetForToken } = await import("./snapshot.js");
  const destSnap = snapshotTargetForToken(destTokDoc);
  const destRowBase = (destSnap && await rederiveTargetRow(ctx.ar, destSnap)) ?? null;

  let touchedSlots = 0;
  for (const srcUuid of sourceActorUuids) {
    const idx = ctx.targets.findIndex((t) => t?.actorUuid === srcUuid);
    if (idx === -1) {
      warn(`redirect: source ${srcUuid} not found in ar.targets — skipping slot`);
      continue;
    }
    const originalName = ctx.targets[idx]?.name ?? "?";
    const per = destRowBase
      ? { ...destRowBase }
      : recomputePerTargetForRedirect({ ar: ctx.ar, reactor: destActor, reactorTok: destTokDoc, applyAffinityToDamage });
    per.redirectedFrom = { actorUuid: srcUuid, name: originalName, via: cand.carrierName ?? "redirect", reactorName: destActor.name };
    ctx.targets[idx] = {
      ...(destSnap ?? {
        actorUuid: destActor.uuid, tokenUuid: destTokDoc.uuid, name: destActor.name,
        tokenImg: destTokDoc.texture?.src ?? destActor.img, disposition: destTokDoc.disposition, defense: per.defense,
      }),
      redirectedFrom: { actorUuid: srcUuid, name: originalName, via: cand.carrierName ?? "redirect" },
    };
    ctx.perTargets[idx] = per;
    touchedSlots += 1;
    log(`redirect: slot ${idx} ${originalName} → ${destActor.name} (via ${cand.carrierName})`);
  }

  if (touchedSlots === 0) {
    warn(`redirect: no matching source slots for [${sourceActorUuids.join(", ")}]`);
    return "failed";
  }
  return "applied";
}

// ── Shield redirect (effect_kind: "shield_redirect") — Illusory Shield ────────
// A Phantasm "takes the place" of a threatened ally. Unlike redirect_target
// (which REPLACES the victim's slot), this ADDS the phantasm as a new target
// slot (re-derived vs its own affinity, like add_target) AND keeps the defended
// slot, recording a `shieldLink` between them. The actual PV-capped split —
// phantasm soaks damage up to its remaining PV (= current HP), overflow passes
// to the defended creature, and the defended creature's on-hit statuses are
// nullified — is applied in applyShieldSplit AFTER the per-target recompute,
// because it depends on the recomputed phantasm damage (its affinity/DR).
//   row: { effect_kind: "shield_redirect",
//          target_ref: <threatened ally>, destination_ref: <own_summons phantasm> }
// Returns "applied" | "cancelled" (player aborted a picker) | "failed".
async function applyShieldRedirectMutation(ctx, cand, row) {
  const reactorUuid = cand.reactorActorUuid;
  if (!reactorUuid) { warn("shield_redirect: missing reactor on candidate"); return "failed"; }
  const reactor = await fromUuid(reactorUuid);
  if (!reactor) { warn(`shield_redirect: reactor ${reactorUuid} not resolvable`); return "failed"; }
  const reactorTok = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === reactor.uuid)?.document
    ?? reactor?.getActiveTokens?.()?.[0]?.document ?? null;

  const targetRef = String(row?.target_ref ?? "").trim();
  const destRef   = String(row?.destination_ref ?? "").trim();
  if (!targetRef || !destRef) {
    warn(`shield_redirect: row "${row?.effect_label}" needs both target_ref (defended) and destination_ref (phantasm)`);
    return "failed";
  }

  // ── DEFENDED: the threatened ally (the slot we shield). Reuse the redirect
  // subject resolver (caches the pick so a re-recompute pass doesn't re-prompt). ──
  cand._pickerCancelled = false;
  const defendedUuids = await resolveRedirectSubjects({ cand, row, reactor, reactorTok, ctx });
  if (cand._pickerCancelled) return "cancelled";
  const defendedUuid = defendedUuids[0];
  if (!defendedUuid) return "failed";
  const defIdx = ctx.targets.findIndex((t) => t?.actorUuid === defendedUuid);
  if (defIdx === -1) { warn(`shield_redirect: defended ${defendedUuid} not in target set`); return "failed"; }

  // ── PHANTASM: pick one own summon (cache on the candidate like redirect dest). ──
  let phantActorUuid = cand.pickedShieldPhantasmUuid ?? null;
  let phantTokDoc = null;
  if (!phantActorUuid) {
    const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
    const chainCtx = makeBdChainContext({
      reactorActor: reactor,
      reactorToken: reactorTok,
      skill: carrier,
      actionTargetUuids: (ctx.ar?.targets ?? []).map((t) => t?.tokenUuid).filter(Boolean),
      payload: { sourceActorUuid: ctx.ar?.attackerActorRef ?? null },
      isPassive: false,   // a real choice — prompt when more than one phantasm
      remotePrompt: ctx.remotePrompt ?? null,
    });
    const resolved = await resolveBdTargetRef(destRef, chainCtx);
    if (resolved?.cancelled) { cand._pickerCancelled = true; return "cancelled"; }
    const tok = resolved?.tokens?.[0];
    if (!resolved?.ok || !tok?.actor) {
      log(`shield_redirect: no phantasm available for ${cand.carrierName} (${resolved?.reason ?? "empty"})`);
      return "failed";
    }
    phantActorUuid = tok.actor.uuid;
    phantTokDoc = tok.document ?? tok;
    cand.pickedShieldPhantasmUuid = phantActorUuid;
  }
  if (!phantTokDoc) {
    phantTokDoc = canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === phantActorUuid)?.document
      ?? (await fromUuid(phantActorUuid).catch(() => null))?.getActiveTokens?.()?.[0]?.document ?? null;
  }
  const phantActor = await fromUuid(phantActorUuid).catch(() => null);
  if (!phantActor || !phantTokDoc) { warn("shield_redirect: phantasm actor/token unresolved"); return "failed"; }

  // Don't interpose the same phantasm twice (e.g. a re-recompute pass, or the
  // phantasm is itself an action target).
  if (ctx.targets.some((t) => t?.tokenUuid === phantTokDoc.uuid)) {
    log(`shield_redirect: ${phantActor.name} already in the target set — skipping`);
    return "failed";
  }

  // remaining PV = the phantasm's current HP.
  const pv = Math.max(0, Number(phantActor?.system?.props?.current_hp ?? 0));

  // ── ADD the phantasm as a new slot, re-derived vs its own affinity/DR ──
  const { applyAffinityToDamage, snapshotTargetForToken } = await import("./snapshot.js");
  const phantSnap = snapshotTargetForToken(phantTokDoc);
  const per = (phantSnap && await rederiveTargetRow(ctx.ar, phantSnap))
    ?? recomputePerTargetForRedirect({ ar: ctx.ar, reactor: phantActor, reactorTok: phantTokDoc, applyAffinityToDamage });
  const defendedName = ctx.targets[defIdx]?.name ?? "?";
  const shieldedVia = { via: cand.carrierName ?? "Illusory Shield", reactorName: reactor.name, shielding: defendedName };
  per.shieldedVia = shieldedVia;
  ctx.targets.push({
    ...(phantSnap ?? {
      actorUuid: phantActor.uuid, tokenUuid: phantTokDoc.uuid, name: phantActor.name,
      tokenImg: phantTokDoc.texture?.src ?? phantActor.img, disposition: phantTokDoc.disposition, defense: per.defense,
    }),
    shieldedVia,
  });
  ctx.perTargets.push(per);

  (ctx.shieldLinks ??= []).push({
    phantasmTokenUuid: phantTokDoc.uuid,
    phantasmActorUuid: phantActor.uuid,
    phantasmName: phantActor.name,
    defendedTokenUuid: ctx.targets[defIdx]?.tokenUuid ?? null,
    defendedActorUuid: defendedUuid,
    defendedName,
    pv,
    via: cand.carrierName ?? "Illusory Shield",
  });
  log(`shield_redirect: ${phantActor.name} (PV ${pv}) interposes for ${defendedName}; overflow → ${defendedName} forced (via ${shieldedVia.via})`);
  return "applied";
}

// PV-capped split for every shield_redirect link, applied AFTER the per-target
// recompute (it needs the recomputed phantasm damage). For each link:
//   - the phantasm takes the hit NORMALLY (its DEF/MDEF + affinity already applied
//     by the recompute) and soaks min(incoming, PV); overflow = max(0, incoming −
//     PV). It stays in the hit list, so as the new hit target it can take the
//     attack's on-hit statuses.
//   - the OVERFLOW passes to the DEFENDED creature ("remaining damage goes to the
//     defended creature"), applied FORCED: a forced hit (bypasses the defended
//     creature's own DEF/MDEF — the attack rolled against the phantasm, not it) +
//     neutral affinity (raw — no resist/vulnerable/absorb on the passthrough).
//     The defended creature is dropped from the hit list so the attack's on-hit
//     statuses are nullified for it (only-defended-escapes-statuses).
// Returns fresh { perTargetResults, hitTokenUuids }.
// Exported for the headless unit harness (pure function — no Foundry deps).
export function applyShieldSplit(perTargetResults, hitTokenUuids, shieldLinks) {
  const rows = Array.isArray(perTargetResults) ? perTargetResults.map((r) => ({ ...r })) : [];
  let hits = Array.isArray(hitTokenUuids) ? [...hitTokenUuids] : null;
  for (const link of shieldLinks ?? []) {
    const phantRow = rows.find((r) => r.tokenUuid === link.phantasmTokenUuid);
    if (!phantRow) continue;
    const incoming = phantRow.hit ? Math.max(0, Number(phantRow.damage) || 0) : 0;
    const absorbed = Math.min(incoming, Math.max(0, Number(link.pv) || 0));
    const overflow = Math.max(0, incoming - absorbed);
    // Phantasm soaks up to its PV (stays in the hit list → can take statuses).
    phantRow.damage = absorbed;
    phantRow.shieldAbsorbed = absorbed;
    // Defended creature: takes the overflow, FORCED (bypasses its DEF/MDEF) and
    // RAW (neutral affinity); statuses nullified (dropped from the hit list).
    const defRow = rows.find((r) => r.tokenUuid === link.defendedTokenUuid);
    if (defRow) {
      defRow.damage = overflow;
      defRow.affinity = "NE";         // raw passthrough — no resist/vulnerable/absorb
      defRow.hit = overflow > 0;      // forced hit bypasses the defended's DEF/MDEF
      defRow.element = phantRow.element ?? defRow.element;
      defRow.shieldedBy = { name: link.phantasmName, absorbed, overflow, via: link.via };
      if (hits) hits = hits.filter((u) => u !== link.defendedTokenUuid);
    }
    log(`shield_redirect split: ${link.phantasmName} soaks ${absorbed}/${link.pv}; overflow ${overflow} → ${link.defendedName} (forced, raw); statuses nullified`);
  }
  return { perTargetResults: rows, hitTokenUuids: hits };
}

// ── Accuracy adjustment (effect_kind: "adjust_accuracy") ─────────────────
// Action-level mutation: rewrite the in-flight Accuracy Check total, then
// recompute every target's hit/miss against the new total. The accuracy
// equivalent of `adjust_damage`, but action-scoped (one roll) rather than
// per-target. Crossfire `set`s it to 0 so a ranged attack "fails
// automatically against all targets".
//   { effect_kind: "adjust_accuracy",
//     accuracy_operation: "set" | "add" | "subtract",   // default "set"
//     accuracy_amount:    <number | formula> }          // the operand
const ACCURACY_OPS = new Set(["set", "add", "subtract"]);
function applyAccuracyOp(total, op, amount) {
  switch (op) {
    case "add":      return total + amount;
    case "subtract": return total - amount;
    case "set":      return amount;
    default:         return total;
  }
}

// Resolve the reactor + carrier SKILL for a performer/self OR third-party
// card-mutation reaction, so a formula in the row (`SL`, payload-derived ids)
// evaluates against the right actor + skill. Performer-side (self) reactions
// carry NO `reactorActorUuid` (only the third-party scan stamps it) — the
// reactor IS the action-taker. The carrier is an Item (skill/weapon reaction)
// or an AE; an AE-carried reaction resolves its origin skill via
// `directorAppliedBy.skillUuid` (then the AE's parent item). Mirrors
// firePreAcceptedCandidate's skill resolution. Shared by adjust_accuracy +
// adjust_grant so `SL` doesn't fall back to 1.
async function resolveReactionReactorSkill(ctx, cand) {
  let reactor = cand?.reactorActorUuid
    ? await fromUuid(cand.reactorActorUuid).catch(() => null)
    : null;
  if (!reactor) {
    const takerUuid = ctx?.ar?.attackerActorRef ?? ctx?.ar?.attacker?.actorUuid ?? null;
    if (takerUuid) reactor = await fromUuid(takerUuid).catch(() => null);
  }
  const carrier = cand?.carrierUuid
    ? await fromUuid(cand.carrierUuid).catch(() => null)
    : null;
  let skill = null;
  if (carrier?.documentName === "Item") {
    skill = carrier;
  } else if (carrier?.documentName === "ActiveEffect") {
    const sUuid = carrier.flags?.["fabula-ultima-companion"]?.directorAppliedBy?.skillUuid;
    skill = (sUuid ? await fromUuid(sUuid).catch(() => null) : null)
      ?? (carrier.parent?.documentName === "Item" ? carrier.parent : null);
  }
  return { reactor, skill };
}

// Override the action's Accuracy total and recompute hit/miss for every
// existing target against its own defense. Damage is only re-derived on the
// MISS side (zeroed) — Crossfire's `set 0` makes everything miss, which is the
// only operation in use today. (A future `add`/positive that flips a miss to a
// hit would need full HR/damage recompute; left out until a skill needs it.)
// Records `ctx.accuracyOverride` so the caller + card UI can show "Blocked".
async function applyAdjustAccuracyMutation(ctx, cand, row) {
  const { readAdjustment } = await import("./skill-formulas.js");
  const { op, amountFormula } = readAdjustment(row, "accuracy", { defaultOp: "set" });
  if (!ACCURACY_OPS.has(op)) {
    warn(`adjust_accuracy: unknown accuracy_operation "${op}" — skipping`);
    return "failed";
  }

  // Resolve the operand. A bare number short-circuits; otherwise evaluate the
  // formula against the reactor + the candidate's fire-time payload (so e.g.
  // SL / payload-derived values work).
  let amount = Number(amountFormula);
  if (!Number.isFinite(amount)) {
    try {
      const { reactor, skill: skillForResolver } = await resolveReactionReactorSkill(ctx, cand);
      const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
      const resolver = buildSkillResolver({
        actor: reactor,
        payload: cand?.payloadAtFire ?? null,
        skill: skillForResolver,
        round: ctx.ar?.round ?? 0,
      });
      amount = Number(evaluateFormula(amountFormula, resolver)) || 0;
    } catch (e) {
      warn("adjust_accuracy: formula eval threw — treating amount as 0", e);
      amount = 0;
    }
  }

  // Compose with any prior adjust_accuracy this card-mutation pass: the op
  // applies to the RUNNING total (prior `to`), not the raw roll, so multiple
  // sources stack. `from` stays the original roll total; `parts` itemizes each
  // source so the hover breakdown renders them like checkBonusParts / damage
  // bonus. (A `set`/block op — Crossfire — isn't an additive part.)
  const prev = ctx.accuracyOverride;
  const baseTotal = Number(prev?.from ?? ctx.ar?.roll?.total ?? 0);
  const runningTotal = Number(prev?.to ?? ctx.ar?.roll?.total ?? 0);
  const newTotal = applyAccuracyOp(runningTotal, op, amount);
  const stepDelta = newTotal - runningTotal;
  const via = cand?.carrierName ?? cand?.reactorActorName ?? "reaction";
  const isCrit = !!ctx.ar?.roll?.isCrit;
  const isFumble = !!ctx.ar?.roll?.isFumble;

  for (let i = 0; i < ctx.perTargets.length; i++) {
    const pt = ctx.perTargets[i];
    if (!pt) continue;
    const def = Number(pt.defense ?? 10);
    // Crit always hits, fumble always misses; otherwise compare the new total
    // to this target's defense. (Crossfire's condition gate already excludes
    // crits, but keep the rule here so the primitive is self-consistent.)
    const newHit = isCrit ? true : (!isFumble && newTotal >= def);
    ctx.perTargets[i] = {
      ...pt,
      hit: newHit,
      crit: isCrit && newHit,
      rawDamage: newHit ? pt.rawDamage : 0,
      damage: newHit ? pt.damage : 0,
      accuracyBlocked: !newHit,
    };
  }

  const parts = Array.isArray(prev?.parts) ? [...prev.parts] : [];
  if (op !== "set" && stepDelta !== 0) parts.push({ source: via, amount: stepDelta });
  ctx.accuracyOverride = {
    from: baseTotal,
    to: newTotal,
    blocked: newTotal <= 0,
    via,
    reactorName: cand?.reactorActorName ?? null,
    parts,
  };
  log(`adjust_accuracy: ${op} ${amount} — total ${runningTotal} → ${newTotal} (via ${via})`);
  return "applied";
}

// Memoized reroll results. check_reroll's rerollDice is RANDOM, and the mutation
// runs at least twice for one reaction — once for the card PREVIEW (each pill
// toggle) and again at the CONFIRM COMMIT. Rolling fresh each time makes the card
// show one result and the target take another. We cache the first rolled result
// per (action-instance, reaction) and reuse it for every later pass, so preview ==
// commit == applied. Key = actionResult._instanceId (stable across re-freezes) +
// the reaction's identity. Entries are self-retiring (a resolved card's _instanceId
// never recurs); a hard cap bounds the map as a backstop. Reusing it on a
// decline→re-accept is also correct RAW — one reroll yields one result, no
// re-rolling until you like it.
// Stored on globalThis so it is SHARED across module instances: the preview and the
// commit each dynamic-import card-mutations.js with a different `?cb=<Date.now()>`
// (the BD live-edit cache-bust pattern), so a plain module-scoped Map would give each
// pass its OWN cache and defeat the memo. The global survives the re-imports.
const _checkRerollCache = (globalThis.__fudCheckRerollCache ??= new Map());
const CHECK_REROLL_CACHE_CAP = 128;
function checkRerollKey(ctx, cand) {
  const inst = ctx?.ar?._instanceId ?? "";
  return `${inst}::${cand?.rowKey ?? ""}::${cand?.carrierUuid ?? ""}::${cand?.reactorActorUuid ?? ""}`;
}

// ── Check reroll (effect_kind: "check_reroll") ───────────────────────────
// Divination (Entropist): a reactor forces the ACTION-TAKER to reroll BOTH
// accuracy dice. Its ONE job is to reroll the Check and reflect the new result —
// it swaps the action's roll, recomputes each target's hit/miss against the new
// total, and reports the change through the SAME `accuracyOverride` channel as
// adjust_accuracy (so the card re-renders identically — now showing the REAL new
// dice, carried on `newRoll`). It deliberately does NOTHING else: charges are the
// carrier AE's concern (its lifetimeMode "on_activation" tick in
// firePreAcceptedCandidate is the sole consumer — one tick per accepted reroll),
// not this mutation's. RAW gate: cannot reroll a Critical or a Fumble (self-guarded
// → "failed"; the pill's condition also hides it, so it's never accepted there). NB:
// damage/HR is NOT recomputed from the new dice (the hit→miss flip is the meaningful
// effect); a still-hitting reroll keeps the original HR.
async function applyCheckRerollMutation(ctx, cand, row) {
  const roll = ctx.ar?.roll;
  if (!roll) { warn("check_reroll: no accuracy roll on this action — skipping"); return "failed"; }
  if (roll.isCrit || roll.isFumble) { log("check_reroll: roll is a Critical/Fumble — cannot reroll (RAW)"); return "failed"; }

  // The action-taker owns the dice being rerolled (fumble threshold etc.).
  const attackerUuid = ctx.ar?.attackerActorRef ?? ctx.ar?.attacker?.actorUuid ?? null;
  let attacker = null;
  try { attacker = attackerUuid ? await fromUuid(attackerUuid) : null; } catch {}

  // Roll ONCE per (action-instance, reaction) and reuse — see _checkRerollCache.
  // The preview and the commit are separate calls; a fresh random roll in each
  // would desync the card from what's applied.
  const cacheKey = checkRerollKey(ctx, cand);
  const haveInstance = !!ctx?.ar?._instanceId;
  let newRoll = haveInstance ? _checkRerollCache.get(cacheKey) : null;
  if (!newRoll) {
    try {
      const { rerollDice } = await import("./invoke/invoke-core.js");
      newRoll = await rerollDice({ roll, choice: "AB", actor: attacker });
    } catch (e) {
      warn("check_reroll: rerollDice threw — skipping", e);
      return "failed";
    }
    if (haveInstance) {
      if (_checkRerollCache.size >= CHECK_REROLL_CACHE_CAP) {
        const oldest = _checkRerollCache.keys().next().value;
        if (oldest !== undefined) _checkRerollCache.delete(oldest);
      }
      _checkRerollCache.set(cacheKey, newRoll);
    }
  }

  const newTotal = Number(newRoll?.total ?? 0);
  const via      = cand?.carrierName ?? cand?.reactorActorName ?? "Divination";

  // Swap the action's roll to the rerolled one — and stop there. applyTargetSetMutation
  // feeds THIS roll into recomputeActionProfile (the shared, built-in recalc), which
  // re-derives total / HR / crit / fumble / hit / damage for EVERY target from the new
  // dice. So we deliberately do NOT touch ctx.perTargets here — the recompute owns the
  // result, exactly like an accuracy adjustment; a reroll just hands it different dice.
  // accuracyOverride carries `newRoll` for the accuracy fieldset display + `to` for the
  // blocked/negated check. A reroll REPLACES the dice (not an additive modifier), so it
  // has no `parts`.
  ctx.ar = { ...ctx.ar, roll: newRoll };
  ctx.accuracyOverride = {
    from: Number(roll.total ?? 0),
    to: newTotal,
    blocked: newTotal <= 0,
    via,
    reactorName: cand?.reactorActorName ?? null,
    rerolled: true,
    newRoll,
  };

  log(`check_reroll: ${roll.rA}+${roll.rB}=${roll.total} → ${newRoll.rA}+${newRoll.rB}=${newTotal} (via ${via})`);
  return "applied";
}

// ── Defense adjustment (effect_kind: "adjust_defense") ───────────────────
// The DEFENDER-side twin of adjust_accuracy: a `creature_targeted_by_action`
// reaction on the TARGET raises ITS OWN effective defense for the in-flight
// action, then recomputes only ITS hit/miss against the (possibly accuracy-
// adjusted) roll total. Per-target — only the reactor's slot — unlike accuracy,
// which rewrites the action-wide total. Raising defense can only flip a hit→miss
// (never a miss→hit), so no HR/damage re-derivation is needed. The bumped
// `defense` is whatever the action checks against (DEF for an attack, MDEF for a
// spell), so it works for any action kind. First user: Matador "Verónica".
//   { effect_kind: "adjust_defense",
//     defense_operation: "add" | "subtract" | "set",   // default "add"
//     defense_amount:    <number | formula> }
const DEFENSE_OPS = new Set(["set", "add", "subtract"]);
function applyDefenseOp(def, op, amount) {
  switch (op) {
    case "add":      return def + amount;
    case "subtract": return def - amount;
    case "set":      return amount;
    default:         return def;
  }
}

async function applyAdjustDefenseMutation(ctx, cand, row) {
  // Resolve the reactor (the creature raising its OWN defense). Third-party
  // reactions (Protect/Grappling, reaction_source ally/enemy) carry a stamped
  // `reactorActorUuid`; a SELF reaction (Verónica, reaction_source "self") comes
  // through the target's own item/AE scan and has NO stamp — the reactor is then
  // the carrier's owning actor (the item/AE bearer). Verónica is the first self
  // card-mutation, so this fallback is new.
  let reactorUuid = cand?.reactorActorUuid ?? null;
  if (!reactorUuid) {
    const carrier = cand?.carrierUuid ? await fromUuid(cand.carrierUuid).catch(() => null) : null;
    reactorUuid = carrier?.parent?.uuid ?? null;
  }
  if (!reactorUuid) { warn("adjust_defense: could not resolve reactor — skipping"); return "failed"; }

  const { readAdjustment } = await import("./skill-formulas.js");
  const { op, amountFormula } = readAdjustment(row, "defense", { defaultOp: "add" });
  if (!DEFENSE_OPS.has(op)) {
    warn(`adjust_defense: unknown defense_operation "${op}" — skipping`);
    return "failed";
  }

  // Resolve the operand (a bare number short-circuits; otherwise evaluate the
  // formula against the reactor + the candidate's fire-time payload so SL etc. work).
  let amount = Number(amountFormula);
  if (!Number.isFinite(amount)) {
    try {
      const { reactor, skill: skillForResolver } = await resolveReactionReactorSkill(ctx, cand);
      const { buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
      const resolver = buildSkillResolver({
        actor: reactor,
        payload: cand?.payloadAtFire ?? null,
        skill: skillForResolver,
        round: ctx.ar?.round ?? 0,
      });
      amount = Number(evaluateFormula(amountFormula, resolver)) || 0;
    } catch (e) {
      warn("adjust_defense: formula eval threw — treating amount as 0", e);
      amount = 0;
    }
  }

  // Locate the reactor's own per-target slot (targets / perTargets are parallel).
  const idx = ctx.targets.findIndex((t) => t?.actorUuid === reactorUuid);
  if (idx < 0) {
    log(`adjust_defense: reactor ${reactorUuid} not among the action's targets — no-op`);
    return "failed";
  }
  const pt = ctx.perTargets[idx];
  if (!pt) return "failed";

  // Compare the (possibly accuracy-adjusted) roll total to the NEW defense.
  const accuracyTotal = Number(ctx.accuracyOverride?.to ?? ctx.ar?.roll?.total ?? 0);
  const isCrit = !!ctx.ar?.roll?.isCrit;
  const isFumble = !!ctx.ar?.roll?.isFumble;
  const oldDef = Number(pt.defense ?? 10);
  const newDef = applyDefenseOp(oldDef, op, amount);
  const newHit = isCrit ? true : (!isFumble && accuracyTotal >= newDef);
  const via = cand?.carrierName ?? cand?.reactorActorName ?? "reaction";

  ctx.perTargets[idx] = {
    ...pt,
    defense: newDef,
    hit: newHit,
    crit: isCrit && newHit,
    rawDamage: newHit ? pt.rawDamage : 0,
    damage: newHit ? pt.damage : 0,
    defenseOverride: { from: oldDef, to: newDef, via, reactorName: cand?.reactorActorName ?? null },
  };
  log(`adjust_defense: ${op} ${amount} on ${pt.name ?? reactorUuid} — DEF ${oldDef} → ${newDef}; hit ${pt.hit ? "Y" : "N"}→${newHit ? "Y" : "N"} (via ${via})`);
  return "applied";
}

// ── Cost adjustment (effect_kind: "adjust_cost", card-mutation path) ──────
// Performer/self reaction that reduces the in-flight SPELL's resource cost
// (Hypercognition: "−SL MP, −SL×2 if the focus is the only target"). Action-level
// (cost is not per-target): records ctx.costOverride as a per-resource signed
// DELTA map (negative = discount), composing across sources. RESOLVE applies the
// delta to BOTH the in-chain consume_resource debit (skill-effects) AND the
// native-cost debit (resolveAction), each clamped >= 0. Unlike accuracy/grant the
// override changes a COST, consumed at resolve rather than read off perTargets.
//   { effect_kind: "adjust_cost", cost_resource: "mp", cost_operation: "add",
//     cost_amount: "-(SL + SL * FOCUS_IS_ONLY_TARGET)" }
async function applyAdjustCostMutation(ctx, cand, row) {
  const { readAdjustment, buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
  const { op, amountFormula } = readAdjustment(row, "cost");
  const resource = String(row.cost_resource ?? "mp").trim().toLowerCase();
  const { reactor, skill } = await resolveReactionReactorSkill(ctx, cand);
  const resolver = buildSkillResolver({
    actor: reactor,
    payload: cand?.payloadAtFire ?? null,
    skill,
    round: ctx.ar?.round ?? 0,
  });
  // Optional secondary gate on the effect row itself (the reaction row already
  // gates firing; this is a safety / extra scoping hook).
  const cond = String(row.condition_formula ?? "").trim();
  if (cond) {
    let pass = 0;
    try { pass = Number(evaluateFormula(cond, resolver, 0)) || 0; } catch { pass = 0; }
    if (!pass) return "skipped";
  }
  // The operand is a signed delta added to the cost (a discount is negative).
  let delta = 0;
  try { delta = Number(evaluateFormula(amountFormula, resolver, 0)) || 0; } catch { delta = 0; }
  if (op === "subtract") delta = -Math.abs(delta);
  else if (op !== "add") warn(`adjust_cost: unsupported cost_operation "${op}" — treating as add`);
  if (delta === 0) return "skipped";
  const via = cand?.carrierName ?? cand?.reactorActorName ?? "reaction";
  const ov = ctx.costOverride ?? (ctx.costOverride = { _parts: [] });
  ov[resource] = (Number(ov[resource]) || 0) + delta;
  ov._parts.push({ source: via, resource, amount: delta });
  log(`adjust_cost: ${resource} ${op} ${delta} (via ${via}) — running ${ov[resource]}`);
  return "applied";
}

// ── Grant adjustment (effect_kind: "adjust_grant", card-mutation path) ───
// The heal/restore counterpart of adjust_accuracy: a performer/self reaction
// (Cognitive Focus "+SL×2 healing to my focus") adjusts the in-flight action's
// PER-TARGET grant amount on the card, so RESOLVE applies the boosted heal from
// the frozen profile (Phase 4 — no re-exec). `scope: per_target` (default) gates
// each target by the row's condition_formula (the focus target only); `per_action`
// boosts every grant target. Composes across sources via ctx.grantOverride; the
// boosted amount surfaces in the per-target "HEALED N" chip like a damage chip.
//   { effect_kind: "adjust_grant",
//     grant_operation: "add"|"multiply"|"set"|"cap"|"floor",  // default add
//     grant_amount:    <number|formula>,                       // operand (e.g. "SL * 2")
//     grant_scope:     "per_target"|"per_action",              // default per_target
//     grant_resource:  "hp"|"mp"|""|"all",                     // optional resource filter
//     condition_formula: "TARGET_HAS_MY_FOCUS == 1" }          // per-target gate
async function applyAdjustGrantMutation(ctx, cand, row) {
  const { readAdjustment, applyGrantAdjust, buildSkillResolver, evaluateFormula } = await import("./skill-formulas.js");
  const { op, amountFormula, scope, round } = readAdjustment(row, "grant");
  const { reactor, skill } = await resolveReactionReactorSkill(ctx, cand);
  const resFilter = String(row.grant_resource ?? "").trim().toLowerCase();
  const cond = String(row.condition_formula ?? "").trim();
  const via = cand?.carrierName ?? cand?.reactorActorName ?? "reaction";

  // The operand formula (e.g. "SL * 2") is target-independent — resolve it ONCE
  // against the reactor + carrier skill. The per-target gate (condition_formula)
  // is what varies per target, evaluated below with the target as subject.
  let amount = Number(amountFormula);
  if (!Number.isFinite(amount)) {
    try {
      const resolver = buildSkillResolver({
        actor: reactor, payload: cand?.payloadAtFire ?? null, skill, round: ctx.ar?.round ?? 0,
      });
      amount = Number(evaluateFormula(amountFormula, resolver)) || 0;
    } catch (e) { warn("adjust_grant: amount formula eval threw — treating as 0", e); amount = 0; }
  }

  const prevOv = ctx.grantOverride ?? { perToken: {} };
  const perToken = { ...prevOv.perToken };
  let mutated = 0;
  for (let i = 0; i < ctx.perTargets.length; i++) {
    const pt = ctx.perTargets[i];
    if (!pt || typeof pt.grantAmount !== "number") continue;        // grant/heal targets only
    const ptRes = String(pt.grantResource ?? "").trim().toLowerCase();
    if (resFilter && resFilter !== "all" && ptRes && resFilter !== ptRes) continue;
    // per_target: gate each candidate by the row condition with the TARGET as
    // subject (TARGET_HAS_MY_FOCUS reads payload.subjectActorUuid). per_action:
    // every grant target qualifies.
    if (scope !== "per_action" && cond) {
      try {
        const gateResolver = buildSkillResolver({
          actor: reactor, skill, round: ctx.ar?.round ?? 0,
          payload: { ...(cand?.payloadAtFire ?? {}), subjectActorUuid: pt.actorUuid, sourceActorUuid: reactor?.uuid ?? null },
        });
        if (!(Number(evaluateFormula(cond, gateResolver, 0)) > 0)) continue;
      } catch { continue; }
    }
    const from = Number(pt.grantAmount) || 0;
    const to = Math.max(0, applyGrantAdjust(from, { op, value: amount, round }));
    if (to === from) continue;
    // REPLACE the row (the frozen actionResult's rows are read-only — mutating in
    // place throws, exactly like adjust_accuracy replaces rather than mutates).
    // The recompute re-applies the op authoritatively; this is the card-mutation-
    // time value + the fallback when recompute returns nothing.
    ctx.perTargets[i] = { ...pt, grantAmount: to };
    const prevTok = perToken[pt.tokenUuid];
    const parts = Array.isArray(prevTok?.parts) ? [...prevTok.parts] : [];
    parts.push({ source: via, amount: to - from });
    perToken[pt.tokenUuid] = { from: prevTok?.from ?? from, to, op, value: amount, round, parts };
    mutated += 1;
  }
  ctx.grantOverride = { perToken };
  log(`adjust_grant: ${op} ${amount} (scope ${scope}) — boosted ${mutated} grant target(s) (via ${via})`);
  return mutated ? "applied" : "skipped";
}

// Phase dispatch — orchestrates accepted card-mutations against an
// action's targets / perTargetResults. Returns NEW arrays (caller
// re-freezes ar with them) and a count for diagnostics.
//
// Ordering:
//   1. redirect_target — rewrites target identity
//   2. (future) change_damage_element / replace_damage / etc.
//   3. (future) add_damage handled separately via computeSenderDamageBonuses
//      so element / damage adjustments compose with Cheap Shot-style
//      bonuses computed against the (possibly redirected) target.
// ── Add target (effect_kind: "add_target", card-mutation path) ───────────
// Grappled "shared space" splash (rule #1): the grappler's "Grappling" AE
// hosts a creature_targeted_by_action reaction whose add_target row resolves
// `grappled_by_self` and APPENDS the grappled victim(s) to the action. They
// share the attacker's already-locked roll, each recomputed against its own
// defense/affinity (same per-target math as a redirect). The collector
// excludes the attacker, so a grappled unit attacking its own grappler doesn't
// splash onto itself. See [[project_grappled_advanced_debuff]].
//
// NOTE: distinct from Barrage's add_target, which is an ATTACKER-side
// (creature_performs_action) reaction committed at Apply-click via
// onAddTargetApply + the _preRoll sink — those candidates are tagged
// `_addTarget` and excluded from the card-mutation `applied` list, so they
// never reach here. This path handles TARGET-side add_target only.
async function applyAddTargetMutation(ctx, cand, row, effectTable) {
  const reactorUuid = cand.reactorActorUuid;
  if (!reactorUuid) { warn("add_target: missing reactor on candidate"); return "failed"; }
  const reactor = await fromUuid(reactorUuid);
  if (!reactor) { warn(`add_target: reactor ${reactorUuid} not resolvable`); return "failed"; }

  // target_ref may be a labelled targeting row OR an inline object (sugar).
  // For an AE-carried reaction the labelled row lives in the AE's effect_table
  // (flags.reactionConfig.effect_table), NOT system.props — pass it as
  // runtimeEffectTable so the resolver can find a string label.
  const rawRef = row?.target_ref;
  const isObjRef = !!rawRef && typeof rawRef === "object";
  const targetRef = isObjRef ? rawRef : String(rawRef ?? "").trim();
  if (!isObjRef && !targetRef) { warn(`add_target: row "${row?.effect_label}" missing target_ref`); return "failed"; }

  // The grappler's EXACT token = the slot being attacked (precise for unlinked
  // NPC tokens that share a base actor); fall back to a canvas lookup.
  const slot = ctx.targets.find((t) => t?.actorUuid === reactorUuid);
  const reactorTok = (slot?.tokenUuid ? await fromUuid(slot.tokenUuid).catch(() => null) : null)
    ?? canvas?.tokens?.placeables?.find((t) => t.actor?.uuid === reactor.uuid)?.document
    ?? reactor?.getActiveTokens?.()?.[0]?.document
    ?? null;

  // Feed the attacker into the payload so candidate_source "grappled_by_self"
  // can drop a victim who IS the attacker (the spec's "someone OTHER than the
  // grappled unit" clause).
  const attackerActorUuid = ctx.ar?.attackerActorRef ?? ctx.ar?.attacker?.actorUuid ?? null;
  const attackerTokenUuid = ctx.ar?.attacker?.tokenUuid ?? null;
  const carrier = await fromUuid(cand.carrierUuid).catch(() => null);
  const chainCtx = makeBdChainContext({
    reactorActor: reactor,
    reactorToken: reactorTok,
    skill: carrier,
    runtimeEffectTable: effectTable ?? null,
    payload: { attackerActorUuid, attackerTokenUuid },
    isPassive: true,
    remotePrompt: ctx.remotePrompt ?? null,
  });
  const resolved = await resolveBdTargetRef(targetRef, chainCtx);
  const tokens = resolved?.tokens ?? [];
  if (!resolved?.ok || !tokens.length) {
    log(`add_target: no extra targets for ${cand.carrierName ?? "?"} (${resolved?.reason ?? "empty"})`);
    return "failed";
  }

  const { applyAffinityToDamage, snapshotTargetForToken } = await import("./snapshot.js");
  let added = 0;
  for (const tok of tokens) {
    const victim = tok?.actor;
    if (!victim) continue;
    // Dedup — skip a victim already in the target list (incl. the original).
    if (ctx.targets.some((t) => t?.tokenUuid === tok.uuid || t?.actorUuid === victim.uuid)) continue;
    // Re-derive the splashed victim's row through buildPerTarget (full pipeline);
    // fall back to the legacy clone if the profile can't be rebuilt.
    const victimSnap = snapshotTargetForToken(tok);
    const per = (victimSnap && await rederiveTargetRow(ctx.ar, victimSnap))
      ?? recomputePerTargetForRedirect({ ar: ctx.ar, reactor: victim, reactorTok: tok, applyAffinityToDamage });
    const addedVia = { via: cand.carrierName ?? "Grappling", reactorName: reactor.name };
    per.addedVia = addedVia;
    ctx.targets.push({
      ...(victimSnap ?? {
        actorUuid: victim.uuid, tokenUuid: tok.uuid, name: victim.name,
        tokenImg: tok.texture?.src ?? victim.img, disposition: tok.disposition, defense: per.defense,
      }),
      addedVia,
    });
    ctx.perTargets.push(per);
    added += 1;
    log(`add_target: +${victim.name} splashed in (via ${cand.carrierName ?? "Grappling"})`);
  }
  return added ? "applied" : "failed";
}

// Shared add_target dispatch — append every accepted candidate's add_target
// victims into ctx (targets + perTargets). Returns the count applied. Used by
// both the full card-mutation pipeline (post-confirm) and applyAddTargetSplices
// (the pre-card pre-splice for FORCE add_target, so the card shows the victim).
async function runAddTargetPhase(ctx, cands) {
  let count = 0;
  for (const cand of cands ?? []) {
    if (!cand?.reactorActorUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "add_target") {
        const result = await applyAddTargetMutation(ctx, cand, row, effectTable);
        if (result === "applied") count += 1;
      }
    }
  }
  return count;
}

// Pre-card splice for FORCE add_target reactions (the Grappled shared-space
// splash). CONFIRM calls this BEFORE postActionCard so the spliced victim(s)
// render as normal target rows on the card. Idempotent vs the post-confirm
// pass: applyAddTargetMutation dedups against ctx.targets, so re-running over
// the same accepted candidates adds nothing. Returns
// { targets, perTargetResults, mutationsApplied }.
export async function applyAddTargetSplices(arSnapshot, cands) {
  const targets = Array.isArray(arSnapshot.targets) ? [...arSnapshot.targets] : [];
  const perTargets = Array.isArray(arSnapshot.perTargetResults) ? [...arSnapshot.perTargetResults] : [];
  const ctx = { ar: arSnapshot, targets, perTargets };
  const mutationsApplied = await runAddTargetPhase(ctx, cands);
  return { targets: ctx.targets, perTargetResults: ctx.perTargets, mutationsApplied };
}

// ── Single target-set mutation entrypoint ────────────────────────────────────
// The ONE place a card's target set + per-target rows are mutated post-decision.
// Composes the three steps that BOTH recompute callers (action-card preview +
// CONFIRM) previously ran inline, so they can't drift in order or arguments:
//   1. applyAcceptedCardMutations — redirect / accuracy / add_target rewrite the
//      target SLOTS (which actor is in each slot, redirectedFrom, accuracyOverride).
//   2. refreshReactionSubjects — re-resolve each accepted will_deal_damage
//      reaction's subject list against the MUTATED target set (so element/damage
//      ops reach an add_target/redirect slot added after the original dispatch).
//   3. recomputeActionProfile — re-derive ALL per-target rows for the mutated set
//      with the accepted reactions folded in, through buildPerTarget (the single
//      per-target math path). The accuracy override is re-applied inside.
//
// Returns the FINAL { targets, perTargetResults, accuracyOverride, negated,
// cancelled, mutationsApplied, hitTokenUuids }. `cancelled` (a picker cancel)
// short-circuits before any recompute so the caller can revert the pill decision.
// `negated` returns the real (display-only) rows — RESOLVE honors ar.negated.
// The per-target rebuild is adopted only when non-empty; a pure no-damage skill
// keeps the mutated rows (which still carry the redirect markers).
// `_cb` is a TEST-ONLY cache-bust token for the dynamic imports (headless
// harness iteration). Production callers omit it → plain boot-cached imports.
export async function applyTargetSetMutation({ ar, accepted, attackerActor = null, round = 0, _cb = null, remotePrompt = null } = {}) {
  const sfx = _cb ? `?cb=${_cb}` : "";
  const mut = await applyAcceptedCardMutations(ar, accepted, remotePrompt);
  if (mut.cancelled) return { cancelled: true };
  const mutatedTargets = mut.targets;
  let perTargetResults = mut.perTargetResults;
  if (mut.negated) {
    // Spread the core result so every override bag it produced (accuracy/grant/
    // cost/…) flows through; only the fields THIS layer transforms are overridden.
    return {
      ...mut,
      targets: mutatedTargets, perTargetResults,
      accuracyOverride: null, hitTokenUuids: null,
      negated: true, cancelled: false,
    };
  }
  const accuracyOverride = mut.accuracyOverride ?? null;
  const grantOverride = mut.grantOverride ?? null;
  // Per-target defense overrides (adjust_defense / Verónica): collected from the
  // core mutation and THREADED INTO the recompute (like accuracyOverride), so the
  // recompute itself honors them — one place re-derives hit/miss for every override
  // kind, instead of patching the result after the recompute clobbers it.
  const defenseOverrides = (mut.perTargetResults ?? [])
    .filter((p) => p?.defenseOverride)
    .map((p) => ({ tokenUuid: p.tokenUuid, actorUuid: p.actorUuid, ...p.defenseOverride }));
  let hitTokenUuids = null;
  // The recomputed action-level (headline) damage. When a mutation changed the roll
  // (check_reroll), the COMPUTE-time payload.damage has the STALE HR baked into
  // finalIfHit — the card must show THIS instead, sourced from the same recompute as
  // the per-target rows so headline + per-target agree.
  let recomputedDamage = null;
  try {
    // GUARDRAIL: recompute from the POST-mutation action state, never the raw input.
    // Targets + perTargets already come from `mut`; the ROLL must too — otherwise a
    // mutation that changed the dice (check_reroll) would re-derive the whole card
    // (total / HR / crit / hit / damage) from the STALE original dice, so the value
    // updates but the result doesn't. Sourcing the roll from `mut.roll` makes the
    // single shared recompute (recomputeActionProfile) honor any roll change by
    // construction — a new roll-mutating effect just writes ctx.ar and gets correct
    // recalculation for free, no per-effect recompute logic.
    const mutatedAr = { ...ar, roll: mut.roll ?? ar.roll, targets: mutatedTargets, perTargetResults };
    if (attackerActor) {
      const { refreshReactionSubjects } = await import("./skill-effects.js" + sfx);
      try { await refreshReactionSubjects({ acceptedPrePassives: accepted, ar: mutatedAr, attackerActor }); }
      catch (e) { warn("applyTargetSetMutation: refreshReactionSubjects threw", e); }
    }
    const { recomputeActionProfile } = await import("./action-profile.js" + sfx);
    const delta = await recomputeActionProfile({
      ar: mutatedAr, targets: mutatedTargets, acceptedReactions: accepted, round, accuracyOverride, grantOverride, defenseOverrides,
    });
    if (Array.isArray(delta?.perTargetResults) && delta.perTargetResults.length) {
      perTargetResults = delta.perTargetResults;
      hitTokenUuids = delta.hitTokenUuids ?? null;
    }
    // Forward the recomputed headline damage (new HR + reactions + element folded
    // in by projectProfileToActionResult). The card uses it when the roll changed.
    recomputedDamage = delta?.damage ?? null;
  } catch (e) { warn("applyTargetSetMutation: recompute threw", e); }
  // Illusory Shield PV-split — applied AFTER the recompute because it depends on
  // the recomputed phantasm damage (its affinity/DR). Caps each interposing
  // phantasm at its remaining PV, spills the overflow to the defended creature,
  // and drops the defended creature from the hit list (nullifying the attack's
  // on-hit statuses for it; the phantasm, as the new hit target, can still get
  // them). See applyShieldRedirectMutation + applyShieldSplit.
  if (Array.isArray(mut.shieldLinks) && mut.shieldLinks.length) {
    const split = applyShieldSplit(perTargetResults, hitTokenUuids, mut.shieldLinks);
    perTargetResults = split.perTargetResults;
    hitTokenUuids = split.hitTokenUuids;
  }
  // Itemized accuracy roll — computed ONCE here, the single mutation entry every
  // card recompute funnels through, so EVERY consumer (GM card, player mirror,
  // any reaction-driven update) renders the same composed accuracy. Mirrors how
  // perTargetResults flows. A NON-blocking adjust_accuracy (Cognitive Focus
  // "+SL vs my focus") folds its `parts` into the base roll's checkBonus /
  // checkBonusParts / total; the card re-renders the accuracy fieldset from it
  // via the SAME builder the initial card uses. Blocking overrides (Crossfire)
  // carry no parts → null → the "Negated" treatment owns the display.
  let accuracyRoll = null;
  if (accuracyOverride?.rerolled && accuracyOverride.newRoll) {
    // check_reroll REPLACES the dice — render the new roll directly (new rA/rB +
    // total), keeping its modifier breakdown (a reroll leaves checkBonus untouched).
    // The SAME builder the initial card uses then repaints the fieldset, so a reroll
    // displays exactly like an accuracy adjustment, only with the real new dice.
    accuracyRoll = { ...accuracyOverride.newRoll };
  } else if (accuracyOverride && !accuracyOverride.blocked
      && Array.isArray(accuracyOverride.parts) && accuracyOverride.parts.length && ar?.roll) {
    const sumParts = accuracyOverride.parts.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    accuracyRoll = {
      ...ar.roll,
      checkBonus: (Number(ar.roll.checkBonus) || 0) + sumParts,
      checkBonusParts: [...(ar.roll.checkBonusParts ?? []), ...accuracyOverride.parts],
      total: Number(accuracyOverride.to),
    };
  }
  const accuracyIsSpellish = String(ar?.skillType ?? "").toLowerCase() === "spell";
  // Spread the core mutation result FIRST so every override bag it returns
  // (accuracyOverride, grantOverride, costOverride, mutationsApplied, and any
  // future kind) is forwarded automatically — then override only the fields this
  // layer genuinely transforms (recomputed perTargets, the assembled accuracyRoll
  // display object, hit list). Avoids the "added an override to the core but the
  // wrapper silently dropped it" footgun.
  return {
    ...mut,
    targets: mutatedTargets,
    perTargetResults,
    accuracyRoll, accuracyIsSpellish,
    // Recomputed headline damage (used by the card when the roll changed — reroll).
    // `mut.roll` (post-mutation roll) rides through the `...mut` spread for HR.
    recomputedDamage,
    hitTokenUuids,
    negated: false, cancelled: false,
  };
}

export async function applyAcceptedCardMutations(arSnapshot, acceptedPrePassives, remotePrompt = null) {
  const targets = Array.isArray(arSnapshot.targets) ? [...arSnapshot.targets] : [];
  const perTargets = Array.isArray(arSnapshot.perTargetResults) ? [...arSnapshot.perTargetResults] : [];
  // `remotePrompt` rides on the mutation ctx so the redirect/add_target chain
  // ctxs (makeBdChainContext below) route their target picks to the reaction
  // owner's client. Null = local (GM/NPC). See remote-pick.js.
  const ctx = { ar: arSnapshot, targets, perTargets, remotePrompt };
  let mutationsApplied = 0;
  let cancelled = false;

  // Phase 0: negate_action — a performer/self reaction (Shadow Possession's
  // Creeped block variant) nullifies the WHOLE action: no hit, no damage, no
  // effects, no reactions. Scans EVERY accepted candidate (not just third-party
  // reactorActorUuid ones — the negate reaction is the actor's OWN). When found,
  // mark `negated`, zero every per-target hit/damage, and set a Blocked accuracy
  // override for the card UI. RESOLVE honors `ar.negated` to skip the outcome +
  // effect/reaction firing. Short-circuits the other phases (they're moot).
  let negated = false;
  for (const cand of acceptedPrePassives ?? []) {
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    if (rows.some((r) => String(r.effect_kind ?? "").trim().toLowerCase() === "negate_action")) {
      negated = true;
      break;
    }
  }
  if (negated) {
    ctx.negated = true;
    // Keep the REAL accuracy / damage / per-target results on the card — the UI
    // shows them dimmed with a red "Negated" overlay (NOT "Blocked"/zeroed). The
    // outcome is still fully nullified at RESOLVE via ar.negated, so these values
    // are display-only. No accuracyOverride (that drives the "Blocked" treatment).
    return {
      targets: ctx.targets,
      perTargetResults: ctx.perTargets,
      mutationsApplied: 1,
      cancelled: false,
      accuracyOverride: null,
      negated: true,
    };
  }

  // Phase 1: redirect_target (only third-party candidates produce these
  // today — `reactorActorUuid` is the discriminator). A cancelled
  // picker short-circuits the whole pipeline so the caller can revert
  // the provisional pill decision.
  for (const cand of acceptedPrePassives ?? []) {
    if (!cand?.reactorActorUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "redirect_target") {
        const result = await applyRedirectTargetMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
        else if (result === "cancelled") { cancelled = true; break; }
      } else if (kind === "shield_redirect") {
        // Illusory Shield — a Phantasm interposes for a threatened ally. Adds the
        // phantasm slot + records a shieldLink; the PV-capped split runs in
        // applyShieldSplit (post-recompute, in applyTargetSetMutation).
        const result = await applyShieldRedirectMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
        else if (result === "cancelled") { cancelled = true; break; }
      }
    }
    if (cancelled) break;
  }

  // Phase 2: adjust_accuracy. Action-level — overrides the roll total and
  // recomputes hit/miss for every target. Runs AFTER redirect so it recomputes
  // against the final target identities. BOTH third-party (Crossfire, defender-
  // side `creature_targeted_by_action`) AND performer-side (Cognitive Focus,
  // `creature_performs_action` on the attacker's own action) reactions apply
  // here — the latter carry no `reactorActorUuid` (only a carrier), so gate on
  // having a carrier and let the reactor fall back to the action-taker inside
  // applyAdjustAccuracyMutation.
  for (const cand of acceptedPrePassives ?? []) {
    if (!cand?.reactorActorUuid && !cand?.carrierUuid) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const rows = expandEffectChain(effectTable, cand.ref);
    for (const row of rows) {
      const kind = String(row.effect_kind ?? "").trim().toLowerCase();
      if (kind === "adjust_accuracy") {
        const result = await applyAdjustAccuracyMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      } else if (kind === "check_reroll") {
        // Divination: reroll the action-taker's accuracy dice, recompute hits.
        const result = await applyCheckRerollMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      } else if (kind === "adjust_defense") {
        // Defender-side: the targeted creature raises its own DEF for this action
        // (Verónica). Per-target; only the reactor's slot recomputes hit/miss.
        const result = await applyAdjustDefenseMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      } else if (kind === "adjust_grant") {
        // Performer/self reaction heal-boost (Cognitive Focus). Reaction-context
        // adjust_grant ONLY — Potion Rain's in-chain adjust_grant never appears as
        // an accepted reaction candidate, so the two paths never collide.
        const result = await applyAdjustGrantMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      } else if (kind === "adjust_cost") {
        // Performer/self reaction cost discount (Hypercognition). Records a signed
        // per-resource delta on ctx.costOverride; consumed at RESOLVE by the
        // consume_resource + native-cost debit paths.
        const result = await applyAdjustCostMutation(ctx, cand, row);
        if (result === "applied") mutationsApplied += 1;
      }
    }
  }

  // Phase 2b: menu-option cost adjustment (Cataclysm-style overcharge). A picked
  // open_action_menu option's adjust_cost is NOT reached by Phase 2 above
  // (expandEffectChain stops at the menu row), so walk the player's CHOSEN
  // option(s) and fold the surcharge into ctx.costOverride — the same override
  // Hypercognition's discount writes, applied to the spell's single cost debit at
  // RESOLVE (so the overcharge becomes part of the spell's MP cost, not a side
  // debit). ONLY adjust_cost is taken from the menu expansion — the picked
  // option's adjust_damage is handled by computeSenderDamageBonuses, and rows
  // already reachable via the plain chain were handled in Phase 2 (skipped here).
  for (const cand of acceptedPrePassives ?? []) {
    if (!Array.isArray(cand?.chosenMenuPicks) || !cand.chosenMenuPicks.length) continue;
    const effectTable = await readEffectTableForCandidate(cand);
    if (!effectTable) continue;
    const plainLabels = new Set(expandEffectChain(effectTable, cand.ref).map((r) => r.effect_label));
    const rows = expandEffectChainWithPicks(effectTable, cand.ref, cand.chosenMenuPicks);
    for (const row of rows) {
      if (plainLabels.has(row.effect_label)) continue;   // already handled in Phase 2
      if (String(row.effect_kind ?? "").trim().toLowerCase() !== "adjust_cost") continue;
      const result = await applyAdjustCostMutation(ctx, cand, row);
      if (result === "applied") mutationsApplied += 1;
    }
  }

  // Phase 3: add_target (Grappled "shared space" splash). Runs AFTER redirect
  // + accuracy so the appended victims reflect the final target identities and
  // the locked roll. The grappler's Grappling AE (self reaction on
  // creature_targeted_by_action) is the only producer today; Barrage's
  // attacker-side add_target is tagged `_addTarget` and excluded upstream.
  mutationsApplied += await runAddTargetPhase(ctx, acceptedPrePassives);

  return {
    targets: ctx.targets,
    perTargetResults: ctx.perTargets,
    mutationsApplied,
    cancelled,
    accuracyOverride: ctx.accuracyOverride ?? null,
    grantOverride: ctx.grantOverride ?? null,
    costOverride: ctx.costOverride ?? null,
    shieldLinks: ctx.shieldLinks ?? null,
    // The POST-mutation roll. A mutation that changes the dice (check_reroll)
    // reassigns ctx.ar, so this is the authoritative roll the recompute must read
    // — NOT the caller's original `ar`. Surfacing it here is what lets
    // applyTargetSetMutation re-derive total/HR/crit/hit/damage from the new dice
    // via the SAME recomputeActionProfile every other mutation uses. Any future
    // roll-changing mutation is reflected automatically by writing ctx.ar.
    roll: ctx.ar?.roll ?? null,
    negated: false,
  };
}
