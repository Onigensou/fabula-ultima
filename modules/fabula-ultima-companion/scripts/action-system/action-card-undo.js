/**
 * [ONI] Action Card — Undo (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * GM-only Undo button on FU Action Cards. Reverts a card that was issued by
 * mistake (wrong skill, wrong target, miss-clicked confirm). Two paths:
 *
 *   • Pending state (created, not yet confirmed):
 *       - No actor mutations happened yet (consumption fires at Confirm).
 *       - Just delete the card, close any reaction sub-windows tied to it,
 *         and re-open the appropriate menu (turn-action for normal cards,
 *         reaction trigger for reaction cards) so the player can re-issue.
 *
 *   • Resolved state (post-confirm):
 *       - Read the refund snapshot captured by applyDamage-button.js right
 *         before the executor ran.
 *       - Restore actor.system.props (MP/HP/IP/FP), recreate any AEs that
 *         were present pre-confirm but are missing now (charge AEs etc.),
 *         restore the combatant's spent activation via the Fabula Initiative
 *         API, and replay any free-action / bonus-action grant state.
 *       - Cascade-delete every chat message tagged as a damage card from
 *         this action.
 *       - Delete this card.
 *       - Re-open the source menu (turn-action or reaction trigger).
 *
 * Click flow:
 *   1. Click ↶ Undo button on a card you authored or as GM.
 *   2. Confirm dialog shows summary of what will be refunded / deleted /
 *      re-opened. Cancel or confirm.
 *   3. On confirm, refunds + cascade + delete + reopen run in sequence.
 *
 * Limits / out of scope (intentional for v1):
 *   - Damage already applied to TARGETS is NOT reversed (HP changes stay).
 *     Only the damage CARD chat messages are deleted. The card's snapshot
 *     could be extended to cover targets too, but that's invasive and the
 *     GM can manually restore target HP.
 *   - Doesn't try to roll back reactions that fired in response to this
 *     card — those have their own cards and undo lifecycles.
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ActionCardUndo";
    if (window[KEY]) {
      console.debug("[ActionCardUndo] Already installed.");
      return;
    }

    const MODULE_NS = "fabula-ultima-companion";
    const FLAG_KEY  = "actionCard";
    const TAG = "[ONI][ActionCardUndo]";

    function getMessageIdFromEvent(ev) {
      const msgEl = ev.target.closest?.(".chat-message, .message");
      return msgEl?.dataset?.messageId || msgEl?.dataset?.messageid || null;
    }

    function esc(s) {
      const str = String(s ?? "");
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function safeAwait(p) {
      return Promise.resolve(p).catch((e) => {
        console.warn(TAG, "step threw (continuing):", e?.message ?? e);
        return null;
      });
    }

    async function resolveActor(uuid) {
      if (!uuid) return null;
      try {
        const doc = await fromUuid(uuid);
        return (
          doc?.actor ??
          (doc?.documentName === "Actor" ? doc : null) ??
          (doc?.documentName === "Token" ? doc.actor : null) ??
          (doc?.documentName === "TokenDocument" ? doc.actor : null)
        );
      } catch { return null; }
    }

    function safeCall(fn) {
      try { return fn(); } catch { return null; }
    }

    // Pure snapshot builder. Captures actor + combatant + free/bonus
    // action state at the moment of call. The undo handler will restore
    // from this snapshot later.
    //
    // Centralized here so call sites that run BEFORE the action card
    // exists (reaction-chooseSkill, before applyEffectsForGroup eats
    // the charge AE) can snapshot at the same level of completeness as
    // applyDamage-button.js's runConfirm path. Without this, reactions
    // that consume charges via the pre-confirm effect dispatch could
    // never have their charge AE restored — by the time runConfirm took
    // its own snapshot the AE was already gone.
    function buildActorSnapshot(actor) {
      if (!actor) return null;
      const combat = game.combat ?? null;
      const combatant = combat?.combatants?.find?.(c => c.actorId === actor.id) ?? null;
      const freeActionsApi = globalThis.FUCompanion?.api?.freeActions ?? null;
      const bonusActionsApi = globalThis.FUCompanion?.api?.bonusActions ?? null;

      return {
        takenAtMs: Date.now(),
        capturedByUserId: game.userId,
        actor: {
          uuid: actor.uuid,
          id: actor.id,
          name: actor.name,
          props: foundry.utils.deepClone(actor.system?.props ?? {}),
          effects: (actor.effects?.contents ?? []).map(e => e.toObject())
        },
        combatant: combatant ? {
          id: combatant.id,
          actorId: combatant.actorId,
          flags: foundry.utils.deepClone(combatant.flags ?? {}),
          initiative: combatant.initiative
        } : null,
        freeActionsForActor: (freeActionsApi?.snapshotForActor)
          ? safeCall(() => freeActionsApi.snapshotForActor(actor.id))
          : (freeActionsApi?.peek
              ? { hasPending: !!safeCall(() => freeActionsApi.peek(actor.id)) }
              : null),
        bonusActionsForActor: (bonusActionsApi?.snapshotForActor)
          ? safeCall(() => bonusActionsApi.snapshotForActor(actor))
          : null
      };
    }

    // ------------------------------------------------------------------
    // Refund execution
    // ------------------------------------------------------------------

    // Recreate any AEs that existed before confirm but are missing now.
    // Compared by AE id (Foundry's `_id`) so an AE that simply changed
    // state (e.g. duration tick) is left alone — only fully-removed AEs
    // come back.
    async function restoreMissingEffects(actor, snapshotEffects, log) {
      if (!actor || !Array.isArray(snapshotEffects) || !snapshotEffects.length) return [];
      const liveIds = new Set((actor.effects?.contents ?? []).map(e => e.id));
      const toCreate = snapshotEffects.filter(snap => snap?._id && !liveIds.has(snap._id));
      if (!toCreate.length) {
        log("no AEs to restore (none missing)");
        return [];
      }
      // Strip flags Foundry doesn't accept on create — keep _id so the
      // restored AE has its original identity (matters for references
      // from other docs / charge lookups).
      const sanitized = toCreate.map(o => {
        const clone = foundry.utils.duplicate(o);
        return clone;
      });
      try {
        const created = await actor.createEmbeddedDocuments("ActiveEffect", sanitized, { keepId: true });
        log(`restored ${created.length} AE(s)`, created.map(e => e.name));
        return created;
      } catch (e) {
        // keepId may fail if Foundry refuses the id collision. Retry
        // without keepId — restored AE has fresh id but same data, which
        // is the right compromise.
        console.warn(TAG, "createEmbeddedDocuments(keepId) failed, retrying without keepId", e?.message ?? e);
        try {
          const created = await actor.createEmbeddedDocuments("ActiveEffect", sanitized);
          log(`restored ${created.length} AE(s) (without keepId)`, created.map(e => e.name));
          return created;
        } catch (e2) {
          console.error(TAG, "AE restore failed twice; some charges may not be refunded", e2);
          return [];
        }
      }
    }

    async function restoreActorProps(actor, snapshotProps, log) {
      if (!actor || !snapshotProps) return null;
      try {
        await actor.update({ "system.props": foundry.utils.duplicate(snapshotProps) });
        log("restored actor.system.props (MP/HP/IP/FP and other resources)");
        return true;
      } catch (e) {
        console.warn(TAG, "restoreActorProps failed", e?.message ?? e);
        return false;
      }
    }

    async function restoreCombatantActivation(combatantSnap, log) {
      if (!combatantSnap?.id) return null;
      const combat = game.combat;
      if (!combat) return null;
      const combatant = combat.combatants?.get?.(combatantSnap.id);
      if (!combatant) {
        log("combatant from snapshot not found in current combat — skip activation restore");
        return null;
      }
      // Fabula Initiative tracks spent activations as a flag value; the
      // controller exposes liAddValue but it's internal. Restoring via
      // raw flag write is equivalent and avoids module-internal API
      // coupling. Walk the snapshot's flags and overwrite the live ones.
      try {
        await combatant.update({ flags: foundry.utils.duplicate(combatantSnap.flags ?? {}) });
        log("restored combatant flags (turn activation budget)");
        return true;
      } catch (e) {
        console.warn(TAG, "restoreCombatantActivation failed", e?.message ?? e);
        return false;
      }
    }

    async function restoreFreeAction(snapshot, log) {
      if (!snapshot) return null;
      const api = globalThis.FUCompanion?.api?.freeActions;
      if (!api) return null;
      // We don't know the exact shape of freeActions state — best effort
      // restoreFromSnapshot if the API exposes it, else log + skip.
      if (typeof api.restoreFromSnapshot === "function") {
        try { await api.restoreFromSnapshot(snapshot); log("restored free-action state"); return true; }
        catch (e) { console.warn(TAG, "restoreFromSnapshot threw", e?.message ?? e); return false; }
      }
      log("freeActions API has no restoreFromSnapshot — skipped");
      return null;
    }

    async function restoreBonusAction(snapshot, log) {
      if (!snapshot) return null;
      const api = globalThis.FUCompanion?.api?.bonusActions;
      if (!api) return null;
      if (typeof api.restoreFromSnapshot === "function") {
        try { await api.restoreFromSnapshot(snapshot); log("restored bonus-action state"); return true; }
        catch (e) { console.warn(TAG, "restoreFromSnapshot threw", e?.message ?? e); return false; }
      }
      log("bonusActions API has no restoreFromSnapshot — skipped");
      return null;
    }

    // ------------------------------------------------------------------
    // Cascade delete — find chat messages tagged as damage cards from
    // this action card and delete them.
    // ------------------------------------------------------------------
    function findDownstreamDamageCardMessageIds(actionCardId) {
      if (!actionCardId) return [];
      const out = [];
      const messages = game.messages?.contents ?? [];
      for (const msg of messages) {
        // Two flag shapes: per-target `damageCard` and batched
        // `groupedDamageCard`. Both carry the parent action card id under
        // payload.meta.actionCardId (see create-damage-card.js
        // postDamageChatMessage).
        const dcFlag = msg.getFlag?.(MODULE_NS, "damageCard")
          ?? msg.getFlag?.(MODULE_NS, "groupedDamageCard")
          ?? null;
        if (!dcFlag) continue;
        const dcCardId =
          dcFlag?.payload?.meta?.actionCardId ??
          dcFlag?.payload?.actionCardId ??
          dcFlag?.actionCardId ??
          null;
        if (dcCardId && String(dcCardId) === String(actionCardId)) out.push(msg.id);
      }
      return out;
    }

    async function cascadeDeleteDownstream(actionCardId, log) {
      const ids = findDownstreamDamageCardMessageIds(actionCardId);
      if (!ids.length) {
        log("no downstream damage cards to delete");
        return [];
      }
      try {
        await ChatMessage.deleteDocuments(ids);
        log(`deleted ${ids.length} downstream damage card(s)`);
        return ids;
      } catch (e) {
        console.warn(TAG, "cascadeDeleteDownstream failed", e?.message ?? e);
        return [];
      }
    }

    // ------------------------------------------------------------------
    // Menu re-open (post-undo)
    // ------------------------------------------------------------------

    async function reopenSourceMenu(payload, log) {
      const meta = payload?.meta ?? {};
      const executionMode = String(meta?.executionMode ?? "").toLowerCase();
      const attackerUuid = meta?.attackerUuid ?? null;

      if (executionMode === "reaction") {
        // Re-emit the trigger so the reaction window opens fresh. The
        // chain tracker's unmark was done before this, so the just-undone
        // skill is selectable again. We re-emit the original phase
        // payload — passives are idempotent (apply_ae skips if AE is
        // already present), so re-emit is safe.
        const phasePayload = payload?.reaction_phase_payload ?? null;
        if (!phasePayload || typeof phasePayload !== "object") {
          log("reaction undo: no reaction_phase_payload to re-emit — skipped");
          return false;
        }
        const rs = globalThis.FUCompanion?.api?.reactionSystem;
        if (!rs?.emitPhaseSequential) {
          log("reaction undo: reactionSystem.emitPhaseSequential unavailable — skipped");
          return false;
        }
        // Fire-and-forget. Reopening doesn't block undo completion.
        rs.emitPhaseSequential(phasePayload, { reason: "undo_reopen" })
          .catch(e => console.warn(TAG, "reopen reaction emit rejected", e));
        log("reaction undo: re-emitted phase to reopen menu");
        return true;
      }

      // Default: turn-action menu (manualCard etc.). Spawn TurnUI for
      // the attacker's token.
      //
      // TurnUI consumes Token *placeables* (uses token.center, .w, .h,
      // .document.id, etc.), NOT TokenDocuments. getActiveTokens(linked,
      // document) defaults document=false → Token placeables, which is
      // what we need here.
      const actor = await resolveActor(attackerUuid);
      const tokens = actor?.getActiveTokens?.(true) ?? actor?.getActiveTokens?.() ?? [];
      const token = tokens[0] ?? null;
      const TurnUI = globalThis.TurnUI;
      if (!token || !TurnUI?.spawnButtonsForToken) {
        log("turn-action undo: TurnUI or token unavailable — skipped re-open", {
          haveActor: !!actor,
          tokenCount: tokens.length,
          haveTurnUI: !!TurnUI?.spawnButtonsForToken
        });
        return false;
      }
      try {
        TurnUI.spawnButtonsForToken(token);
        log("turn-action undo: re-opened TurnUI action menu", { tokenName: token?.name });
        return true;
      } catch (e) {
        console.warn(TAG, "TurnUI.spawnButtonsForToken threw", e?.message ?? e);
        return false;
      }
    }

    // ------------------------------------------------------------------
    // Confirm dialog
    // ------------------------------------------------------------------

    function buildSummaryHtml({ payload, snapshot, downstreamCount, isResolved, reactionsFired }) {
      const meta = payload?.meta ?? {};
      const skillName = payload?.core?.skillName ?? meta?.skillName ?? "(unknown skill)";
      const actorName = snapshot?.actor?.name ?? meta?.attackerName ?? "(unknown actor)";
      const executionMode = String(meta?.executionMode ?? "manualCard").toLowerCase();
      const reopenLabel = executionMode === "reaction" ? "the reaction menu" : "their action menu";

      const lines = [];

      if (isResolved && snapshot) {
        const before = snapshot.actor?.props ?? {};
        // Best-effort resource diffs — show only fields the GM would expect
        // to see changed (MP, HP, IP, FP). All numeric.
        const resourceFields = ["current_mp", "current_hp", "current_ip", "fp"];
        for (const key of resourceFields) {
          if (before[key] !== undefined) {
            lines.push(`<li>Restore ${esc(key.replace(/^current_/, "").toUpperCase())} → <b>${esc(String(before[key]))}</b></li>`);
          }
        }
        const aeCount = (snapshot.actor?.effects ?? []).length;
        lines.push(`<li>Recreate any of the ${aeCount} pre-action AE(s) that the action consumed</li>`);
        if (snapshot.combatant) lines.push(`<li>Restore combatant turn activation</li>`);
        if (downstreamCount > 0) {
          lines.push(`<li>Delete <b>${downstreamCount}</b> downstream damage card(s) <span style="opacity:.7">(damage already applied to targets is not reversed)</span></li>`);
        }
      } else {
        lines.push(`<li><span style="opacity:.85">Card not yet confirmed — no resources to refund.</span></li>`);
      }

      // Cascade-refund preview: reactions fired in response to this card
      // (e.g. Blanche's Protect) will have their pre-action snapshot
      // refunded too.
      if (Array.isArray(reactionsFired) && reactionsFired.length) {
        const items = reactionsFired
          .map(r => `<b>${esc(r.skillName ?? "(reaction)")}</b> by ${esc(r?.preSnapshot?.actor?.name ?? "(reactor)")}`)
          .join(", ");
        lines.push(`<li>Refund <b>${reactionsFired.length}</b> reaction(s) that fired against this card: ${items}</li>`);
      }

      lines.push(`<li>Delete this Action Card</li>`);
      lines.push(`<li>Re-open ${reopenLabel} for ${esc(actorName)}</li>`);

      return `
        <div style="font-family: Signika, sans-serif; font-size:13px; line-height:1.45;">
          <p style="margin: 0 0 8px 0;">
            Undo <b>${esc(skillName)}</b> by <b>${esc(actorName)}</b>?
          </p>
          <p style="margin: 0 0 6px 0; opacity:.85;">This will:</p>
          <ul style="margin: 0 0 8px 18px; padding: 0;">${lines.join("")}</ul>
          <p style="margin: 0; font-size:11px; opacity:.7;">
            <i>Damage already applied to other actors will remain in place.</i>
          </p>
        </div>
      `;
    }

    function showConfirmDialog({ payload, snapshot, downstreamCount, isResolved, reactionsFired }) {
      return new Promise((resolve) => {
        let dlg = null;
        dlg = new Dialog({
          title: "Undo Action Card",
          content: buildSummaryHtml({ payload, snapshot, downstreamCount, isResolved, reactionsFired }),
          buttons: {
            cancel: {
              icon: '<i class="fa-solid fa-xmark"></i>',
              label: "Cancel",
              callback: () => resolve(false)
            },
            undo: {
              icon: '<i class="fa-solid fa-rotate-left"></i>',
              label: "Undo",
              callback: () => resolve(true)
            }
          },
          default: "cancel",
          close: () => resolve(false)
        }, { width: 460 });
        dlg.render(true);
      });
    }

    // ------------------------------------------------------------------
    // Main click handler
    // ------------------------------------------------------------------

    async function onUndoClick(ev) {
      const btn = ev.target.closest?.("[data-fu-undo]");
      if (!btn) return;

      ev.preventDefault();
      ev.stopPropagation();

      if (!game.user?.isGM) {
        ui.notifications?.warn?.("Undo is GM only.");
        return;
      }

      const msgId = getMessageIdFromEvent(ev);
      if (!msgId) {
        ui.notifications?.warn?.("Could not resolve chat message.");
        return;
      }
      const chatMsg = game.messages?.get?.(msgId);
      if (!chatMsg) {
        ui.notifications?.warn?.("Chat message not found.");
        return;
      }

      const flag = chatMsg.getFlag(MODULE_NS, FLAG_KEY) ?? null;
      const payload = flag?.payload ?? null;
      if (!payload) {
        ui.notifications?.warn?.("This message does not contain an Action Card payload.");
        return;
      }

      const state = String(flag?.actionCardState ?? payload?.meta?.actionCardState ?? "pending").toLowerCase();
      const isResolved = state === "resolved" || state === "confirming";
      const snapshot = flag?.refundSnapshot ?? null;
      const actionCardId =
        payload?.meta?.actionCardId ??
        payload?.actionCardId ??
        null;
      const downstreamIds = findDownstreamDamageCardMessageIds(actionCardId);

      if (isResolved && !snapshot) {
        const proceed = await Dialog.confirm({
          title: "Undo — No Snapshot Available",
          content: `<p>This Action Card was confirmed before the Undo feature shipped, so no refund snapshot was saved. Continuing will just delete the card${downstreamIds.length ? ` and its ${downstreamIds.length} downstream damage card(s)` : ""}, without restoring MP / turn / charges.</p><p>Continue anyway?</p>`,
          yes: () => true,
          no: () => false,
          defaultYes: false
        });
        if (!proceed) return;
      } else {
        const reactionsFired = Array.isArray(flag?.reactionsFiredOnThisCard)
          ? flag.reactionsFiredOnThisCard
          : [];
        const ok = await showConfirmDialog({
          payload,
          snapshot,
          downstreamCount: downstreamIds.length,
          isResolved,
          reactionsFired
        });
        if (!ok) return;
      }

      btn.disabled = true;

      const stepLog = [];
      const log = (m, extra) => {
        stepLog.push(m);
        console.log(TAG, m, extra ?? "");
      };

      try {
        // 1) Restore actor state from snapshot (if resolved & we have one).
        if (isResolved && snapshot) {
          const actor = await resolveActor(snapshot.actor?.uuid);
          if (actor) {
            await safeAwait(restoreActorProps(actor, snapshot.actor?.props, log));
            await safeAwait(restoreMissingEffects(actor, snapshot.actor?.effects, log));
          } else {
            log("snapshot actor uuid unresolvable; skipping props + AE restore");
          }
          await safeAwait(restoreCombatantActivation(snapshot.combatant, log));
          await safeAwait(restoreFreeAction(snapshot.freeActionsForActor, log));
          await safeAwait(restoreBonusAction(snapshot.bonusActionsForActor, log));
        }

        // 1b) Cascade-refund every reaction that fired in response to
        // this card. Reactions like Protect that don't create their own
        // action card recorded their pre-action snapshot on this card's
        // flag at fire time; iterate them and restore each reactor.
        const reactionsFired = Array.isArray(flag?.reactionsFiredOnThisCard)
          ? flag.reactionsFiredOnThisCard
          : [];
        if (reactionsFired.length) {
          log(`cascading refund across ${reactionsFired.length} reaction(s) fired on this card`);
          for (const r of reactionsFired) {
            const rActor = await resolveActor(r?.reactorActorUuid);
            if (rActor && r?.preSnapshot) {
              await safeAwait(restoreActorProps(rActor, r.preSnapshot.actor?.props, log));
              await safeAwait(restoreMissingEffects(rActor, r.preSnapshot.actor?.effects, log));
              log(`  refunded ${r.skillName ?? "(unknown reaction)"} on ${rActor.name}`);
            } else {
              log(`  skipped cascade entry — actor or snapshot missing`, {
                reactor: r?.reactorActorUuid,
                skill: r?.skillName,
                hasSnapshot: !!r?.preSnapshot
              });
            }
            // Un-mark in the chain tracker so the reactor can re-pick.
            const tracker = globalThis.FUCompanion?.api?.reactionChainTracker;
            if (tracker?.unmarkUsed && r?.chainId && r?.reactorActorId && r?.skillUuid) {
              tracker.unmarkUsed(r.chainId, r.reactorActorId, r.skillUuid);
            }
          }
        }

        // 2) Reaction-specific: un-mark the skill in the chain tracker
        // so the actor can re-pick the same reaction skill if they
        // want to choose differently on the re-opened menu.
        const executionMode = String(payload?.meta?.executionMode ?? "").toLowerCase();
        if (executionMode === "reaction") {
          const tracker = globalThis.FUCompanion?.api?.reactionChainTracker;
          const chainId =
            payload?.reactionChainId ??
            payload?.meta?.reactionChainId ??
            null;
          const skillUuid = payload?.skill_uuid ?? payload?.skillUuid ?? null;
          // Resolve actor id (not uuid) since markUsed keys on actor.id
          const reactor = await resolveActor(payload?.attacker_uuid);
          const actorId = reactor?.id ?? null;
          if (tracker?.unmarkUsed && chainId && actorId && skillUuid) {
            tracker.unmarkUsed(chainId, actorId, skillUuid);
            log(`unmarked chain skill use`, { chainId, actorId, skillUuid });
          } else {
            log("chain tracker unmark skipped (missing chainId/actorId/skillUuid or tracker)");
          }
        }

        // 3) Close any reaction sub-windows still pending for this card.
        const rs = globalThis.FUCompanion?.api?.reactionSystem;
        if (actionCardId && rs?.closeWindowsForActionCard) {
          await safeAwait(rs.closeWindowsForActionCard(actionCardId, "card_undone"));
          log("closed reaction sub-windows tied to this card");
        }

        // 4) Cascade-delete downstream damage cards (already collected).
        if (downstreamIds.length) {
          await safeAwait(cascadeDeleteDownstream(actionCardId, log));
        }

        // 5) Delete this card.
        await safeAwait(chatMsg.delete());
        log("deleted Action Card chat message");

        // 6) Re-open the source menu so the actor is back at choice time.
        await safeAwait(reopenSourceMenu(payload, log));

        ui.notifications?.info?.(`Undid Action Card (${stepLog.length} step${stepLog.length === 1 ? "" : "s"} — see console for detail).`);
      } catch (err) {
        console.error(TAG, "undo handler threw:", err);
        ui.notifications?.error?.("Undo failed — see console.");
      } finally {
        // btn is gone (card deleted) but defensive enable in case the
        // delete didn't go through.
        try { btn.disabled = false; } catch {}
      }
    }

    // Delegated click handler — single document-level listener; survives
    // chat re-renders (no per-message bind needed). data-gm-only is set
    // on the button HTML so non-GM clients never see it.
    document.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("[data-fu-undo]");
      if (!btn) return;
      onUndoClick(ev);
    }, true);

    window[KEY] = { onUndoClick, buildActorSnapshot };

    // Mirror on FUCompanion.api for the reaction picker (which lives in
    // a different IIFE / install order) to use as a pre-action snapshot.
    const root = (globalThis.FUCompanion = globalThis.FUCompanion ?? {});
    root.api = root.api ?? {};
    root.api.actionCardUndo = {
      buildActorSnapshot
    };

    console.debug("[ActionCardUndo] Installed. Listens for [data-fu-undo] clicks on chat cards.");
  })();
});
