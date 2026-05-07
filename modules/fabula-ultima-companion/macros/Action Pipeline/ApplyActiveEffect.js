// ──────────────────────────────────────────────────────────
// ApplyActiveEffect — Foundry V12 (headless friendly)
// Consumes: { directives[], attackerUuid, targetUUIDs[], trigger, accTotal, isSpellish, weaponType }
// Each directive = { effId, mode, target, trigger, percent, die1, die2, dl, effect:Object }
// Modes: percentage | opposed_check | target_check | owner_check | conquer
// Targets: enemy | ally | any | self
// Triggers: on_attack | on_hit
// ──────────────────────────────────────────────────────────
(async () => {
  const U = FUCompanion.Utilities;
  let AUTO = false, PAYLOAD = {};
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

  const {
    directives = [],
    attackerUuid = null,
    targetUUIDs = [],
    trigger = "on_attack",
    accTotal = 0,
    isSpellish = false,
    weaponType = ""
  } = PAYLOAD;

  if (!directives.length) return;
  if (!attackerUuid) return ui.notifications.warn("ApplyActiveEffect: Missing attackerUuid.");
  if (!Array.isArray(targetUUIDs) || !targetUUIDs.length) return;

  // ---------- helpers ----------
  async function getTokenFromUuid(u) {
    try {
      const doc = await fromUuid(u);
      return doc?.isEmbedded ? doc.object : (doc?.object ?? null);
    } catch { return null; }
  }
  function sameSide(attDisp, tgtDisp) {
    // Foundry: 1 = friendly, 0 = neutral, -1 = hostile
    if (attDisp === 0 || tgtDisp === 0) return false;
    return attDisp === tgtDisp;
  }
  // Die size resolver: tries several common CSB/FU patterns, defaults to d8
  function attrDieSize(actor, key) {
    if (!actor) return 8;
    const A = (String(key||"").toUpperCase());
    const props = actor.system?.props ?? actor.system ?? {};

    // Common patterns you’ve used
    const candidates = [
      props[`${A}_die_size`],
      props[`${A}_die`],
      props[`current_${A}_die`],
      props[`current_${A}`],
      props[A], // sometimes stores 6/8/10/12
    ];

    for (const c of candidates) {
      const n = U.numberish(String(c||"").replace(/[^0-9]/g,""), NaN);
      if (Number.isFinite(n) && n >= 4) return n;
    }
    return 8; // safe default
  }
  function roll2d(actor, aKey, bKey) {
    const d1 = attrDieSize(actor, aKey || "DEX");
    const d2 = attrDieSize(actor, bKey || "INS");
    const r = new Roll(`1d${d1} + 1d${d2}`).evaluate({async:false});
    return { total: r.total|0, d1, d2, roll: r };
  }
  function normalizeDirective(row) {
    return {
      effId  : String(row.effId||row.active_effect_id||""),
      application : String(row.application || row.active_effect_application || "add").toLowerCase().trim(),
      mode   : String(row.mode || row.active_effect_apply_mode || "").toLowerCase().trim(),
      target : String(row.target || row.active_effect_target || "any").toLowerCase().trim(),
      trigger: String(row.trigger|| row.active_effect_trigger||"on_hit").toLowerCase().trim(),
      percent: U.numberish(row.percent ?? row.active_effect_percent ?? 0, 0),
      die1   : String(row.die1 ?? row.active_effect_dice_1 ?? "").toLowerCase().trim(),
      die2   : String(row.die2 ?? row.active_effect_dice_2 ?? "").toLowerCase().trim(),
      dl     : U.numberish(row.dl ?? row.active_effect_dl ?? 0, 0),
      effect : row.effect ?? null
    };
  }
  async function defenseForUuid(uuid, preferMagic=false) {
    try {
      const d = await fromUuid(uuid);
      const a = d?.actor ?? (d?.type === "Actor" ? d : null);
      const props = a?.system?.props ?? a?.system ?? {};
      // robust reader copied from your Apply button pattern
      const hard = preferMagic ? ["magic_defense","current_mdef","mdef"] : ["defense","current_def","def"];
      const tryNum = (obj, keys)=>{ for (const k of keys){ const n=U.numberish(obj[k],NaN); if(Number.isFinite(n)) return n; } return NaN; };
      let v = tryNum(props, hard);
      if (!Number.isFinite(v)) {
        const rx = preferMagic
          ? /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i
          : /(^|_)(current_)?(def|guard|armor)($|_)/i;
        for (const [k,val] of Object.entries(props)) {
          if (/_mod($|_)/i.test(k)) continue;
          if (rx.test(k)) { const n = U.numberish(val,NaN); if (Number.isFinite(n)) { v=n; break; } }
        }
      }
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  }

  // --- NEW: duplicate guard (same name or same source effId) ---
function hasDuplicateEffect(actor, effectBase, sourceEffId) {
  if (!actor) return false;

  const wantName = String(effectBase?.name || effectBase?.label || "")
    .trim().toLowerCase();
  const wantId = String(sourceEffId ?? "").trim();

  // Iterate actor's existing, currently active effects
  for (const e of (actor.effects ?? [])) {
    if (!e || e.disabled) continue;

    // Same NAME?
    const eName = String(e.name || e.label || "").trim().toLowerCase();
    const sameName = (wantName && eName && eName === wantName);

    // Same SOURCE ID? (we'll store on a flag below when we create it)
    const sameId = wantId && (e.getFlag?.("fabula-ultima-companion", "sourceEffId") === wantId);

    if (sameName || sameId) return true;
  }
  return false;
}

  // ---------- resolve actors/tokens ----------
  const attackerActor = await FUCompanion.ActorResolver.fromUuid(attackerUuid);
  if (!attackerActor) return ui.notifications.warn("ApplyActiveEffect: Attacker not found.");
  const attackerToken = await getTokenFromUuid(attackerUuid);
  const attackerDisp  = attackerToken?.document?.disposition ?? 0;

  const targetTokens = (await Promise.all(targetUUIDs.map(getTokenFromUuid))).filter(Boolean);

  // ---------- filtering helpers ----------
  function filterByRowTarget(rowTarget, list) {
    if (rowTarget === "self") return [attackerToken].filter(Boolean);
    if (rowTarget === "any")  return list;
    return list.filter(t => {
      const disp = t?.document?.disposition ?? 0;
      const same = sameSide(attackerDisp, disp);
      return rowTarget === "ally" ? same : !same; // enemy = not same
    });
  }

  // ---------- apply effect doc to a single actor ----------
  // ---------- apply effect doc to a single actor (with duplicate guard) ----------
  //
  // Returns true if an effect was actually created on the target,
  // false if it was skipped (duplicate) or failed.
async function applyEffectToActor(actor, effectBase, originUuid, sourceEffId) {
  if (!actor) return false;

  // Skip if target already has this effect (by same name OR by same sourceEffId)
  if (hasDuplicateEffect(actor, effectBase, sourceEffId)) {
    // (Optional) toast once per actor:
    // ui.notifications.info(`${actor.name} already has ${effectBase?.name ?? "this effect"}.`);
    return false; // duplicate; nothing applied
  }

  const base = foundry.utils.duplicate(effectBase ?? {});
  const statuses = U.toArray(base.statuses).map(String).filter(Boolean);
  const duration = base.duration ?? {};
  const img = base.icon || base.img || "icons/svg/aura.svg";

  // Preserve any existing flags on the template and add our sourceEffId for future duplicate checks
  const flags = base.flags ?? {};
  flags["fabula-ultima-companion"] = {
    ...(flags["fabula-ultima-companion"] ?? {}),
    sourceEffId: String(sourceEffId ?? ""),  // <-- key for duplicate detection
    originItemId: String(sourceEffId ?? "")  // (alias for your future convenience)
  };

  const effData = {
    name: base.name || "Effect",
    img,
    tint: base.tint ?? null,
    disabled: !!base.disabled,
    description: base.description ?? base.system?.description ?? "",
    changes: Array.isArray(base.changes) ? base.changes : [],
    statuses,
    duration: {
      rounds: duration.rounds ?? null,
      seconds: duration.seconds ?? null
    },
    origin: originUuid || null,
    sourceName: base.sourceName || "Action",
    flags
  };

  await actor.createEmbeddedDocuments("ActiveEffect", [effData]);
  return true;
}

async function removeEffectFromActor(actor, effectBase, sourceEffId) {
  if (!actor) return;

  const wantName = String(effectBase?.name || effectBase?.label || "").trim().toLowerCase();
  const wantId   = String(sourceEffId ?? "").trim();

  // Collect effect IDs that match by our saved flag OR by name
  const toDeleteIds = [];
  for (const e of (actor.effects ?? [])) {
    if (!e) continue;
    const byFlag = wantId && (e.getFlag?.("fabula-ultima-companion", "sourceEffId") === wantId);
    const eName  = String(e.name || e.label || "").trim().toLowerCase();
    const byName = wantName && eName && (eName === wantName);

    if (byFlag || byName) {
      toDeleteIds.push(e.id);
    }
  }

  if (!toDeleteIds.length) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", toDeleteIds);
}

  // ---------- main per-row processor ----------
  for (const raw of directives) {
    const row = normalizeDirective(raw);
    if (!row.effId || !row.effect) continue;
    if (row.trigger !== trigger) continue;

    const recipients = filterByRowTarget(row.target, targetTokens);

    // Skip if nothing to do for this row on this trigger
    if (!recipients.length) continue;

    // Per-mode evaluation
    for (const tok of recipients) {
      try {
        const tgtActor = tok?.actor;
        if (!tgtActor) continue;

        let success = false;

        // --- NEW: Application = REMOVE (ignore mode/percent/checks; remove on-hit by default)
if (row.application === "remove") {
  // If the Skill row didn't specify a trigger (hidden in UI), treat as on_hit.
  const triggerOk = (row.trigger || "on_hit") === trigger;
  if (!triggerOk) continue;

  for (const tok of recipients) {
    try {
      const tgtActor = tok?.actor;
      if (!tgtActor) continue;
      await removeEffectFromActor(tgtActor, row.effect, row.effId);
      // (Optional) toast: ui.notifications.info(`Removed ${row.effect?.name ?? "Effect"} → ${tgtActor.name}`);
    } catch (e) {
      console.warn("[ApplyActiveEffect] Remove failed:", row, e);
    }
  }
  continue; // done with this row; skip add-mode handling
}

        switch (row.mode) {
          case "percentage": {
            const pct = Math.max(0, Math.min(100, row.percent||0));
            success = (Math.random()*100) < pct;
            break;
          }
          case "owner_check": {
            const r = roll2d(attackerActor, row.die1, row.die2);
            success = (r.total >= (row.dl||0));
            break;
          }
          case "target_check": {
            const r = roll2d(tgtActor, row.die1, row.die2);
            // Your spec: "if lower than DL → inflicted"
            success = (r.total < (row.dl||0));
            break;
          }
          case "opposed_check": {
            const rOwner = roll2d(attackerActor, row.die1, row.die2);
            const rTgt   = roll2d(tgtActor,    row.die1, row.die2);
            success = (rOwner.total >= rTgt.total);
            break;
          }
          case "conquer": {
            // Use global accuracy total vs target’s relevant defense
            const usedDef = await defenseForUuid(tok.document?.uuid, !!isSpellish);
            success = ((Number(accTotal)||0) - usedDef) >= (row.dl||0);
            break;
          }
          default: {
            // Unknown mode → skip (safe)
            success = false;
          }
        }

        if (success) {
          const applied = await applyEffectToActor(tgtActor, row.effect, attackerUuid, row.effId);

          // Reaction beacon: tell the reaction system that a status effect just landed.
          // Skipped on duplicates (applyEffectToActor returns false).
          if (applied) {
            try {
              const targetTokenUuid = tok?.document?.uuid ?? null;
              const targetActorUuid = tgtActor?.uuid ?? null;
              const reactionPayload = {
                trigger: "creature_status_applied",
                kind: "status_application",
                timestamp: Date.now(),

                // Source / attacker (filtered as "self/ally/enemy" against reactor)
                attackerUuid,
                sourceUuid: attackerUuid,
                sourceTokenUuid: attackerToken?.document?.uuid ?? attackerUuid,
                sourceActorUuid: attackerActor?.uuid ?? null,

                // Target = creature gaining the status
                targetUuid: targetTokenUuid,
                targetTokenUuid,
                targetActorUuid,
                targets: targetTokenUuid ? [targetTokenUuid] : [],
                targetTokenUuids: targetTokenUuid ? [targetTokenUuid] : [],
                targetActorUuids: targetActorUuid ? [targetActorUuid] : [],

                // Status metadata
                effectName: row.effect?.name ?? row.effect?.label ?? null,
                effectStatuses: Array.isArray(row.effect?.statuses) ? [...row.effect.statuses] : [],
                effId: row.effId ?? null,
                applicationTrigger: trigger ?? null,
                weaponType: weaponType ?? null,
                isSpellish: !!isSpellish
              };

              if (game.user?.isGM) {
                if (globalThis?.ONI?.emit) {
                  globalThis.ONI.emit("oni:reactionPhase", reactionPayload, { local: true, world: false });
                } else if (Hooks.callAll) {
                  Hooks.callAll("oni:reactionPhase", reactionPayload);
                }
              } else if (game.socket) {
                game.socket.emit("module.fabula-ultima-companion", {
                  type: "OniReactionPhaseRequest",
                  payload: {
                    ...reactionPayload,
                    requestedByUserId: game.user?.id ?? null,
                    requestedByUserName: game.user?.name ?? null
                  }
                });
              }
            } catch (emitErr) {
              console.warn("[ApplyActiveEffect] creature_status_applied emit failed (safe to ignore):", emitErr);
            }
          }
          // (Optional) toast per-application
          // ui.notifications.info(`Applied ${row.effect?.name || "Effect"} → ${tgtActor.name}`);
        }
      } catch (e) {
        console.warn("[ApplyActiveEffect] Row failed:", row, e);
      }
    } // per recipient
  } // per row
})();
