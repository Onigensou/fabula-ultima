/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * Updated for merged same-window reaction contexts.
 * ---------------------------------------------------------------------------
 */
// ============================================================================
// ONI ReactionChooseSkill – Dialog + ActionDataFetch handoff (Foundry VTT v12)
// ---------------------------------------------------------------------------
// PURPOSE
// -------
// This script ONLY handles the UI/dialog part of choosing a Reaction skill,
// then feeds the chosen Item into your Action system (ActionDataFetch).
//
// It exposes a small API on window["oni.ReactionChooseSkill"]:
//
//   window["oni.ReactionChooseSkill"].openReactionDialog(ctx)
//
// where `ctx` is the same object ReactionManager builds:
//
//   {
//     combatant, actor, token,
//     reactions,   // array from collectReactionsForTrigger(...)
//     triggerKey,  // normalized trigger ("round_start", "creature_deals_damage", ...)
//     phasePayload // payload that came from oni:reactionPhase
//   }
//
// ReactionManager remains responsible for:
//   - Listening to oni:reactionPhase
//   - Finding which actors have Reactions
//   - Spawning the floating "Reaction" button
//
// This file is responsible for:
//   - UI of the "Choose Reaction" dialog
//   - Determining seed targets from reaction phase payload only
//   - Handing off to ActionDataFetch so the Action pipeline remains the
//     single authority for real target selection (JRPGTargeting)
// ============================================================================

function _installReactionChooseSkill() {
  (() => {
    const KEY = "oni.ReactionChooseSkill";
    if (window[KEY]) {
      console.debug("[ReactionChooseSkill] Already installed.");
      return;
    }

    const REACT_SKILL_STYLE_ID = "oni-reaction-choose-skill-style";

    function ensureReactionDialogStyles() {
      if (document.getElementById(REACT_SKILL_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = REACT_SKILL_STYLE_ID;
      style.textContent = `
        .oni-react-skill-wrap {
          padding: 6px 8px 10px 8px;
        }
        .oni-react-trigger-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin: 4px 0 8px 0;
        }
        .oni-react-trigger-chip {
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid rgba(122,106,85,0.85);
          background: linear-gradient(180deg, #f4ecd8, #e6d5b4);
          box-shadow: 0 1px 0 rgba(255,255,255,0.55) inset;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 700;
        }
        .oni-react-skill-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 380px;
          overflow-y: auto;
        }
        .oni-react-skill-row {
          position: relative;
          display: grid;
          grid-template-columns: 32px 1fr;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          background: linear-gradient(180deg,#f6f1e6,#ebdfc7);
          border: 2px solid #7a6a55;
          box-shadow:
            0 3px 0 rgba(41,33,24,0.55),
            0 0 0 1px rgba(255,255,255,0.65) inset;
          cursor: pointer;
          transition: transform 120ms ease-out, box-shadow 120ms ease-out, filter 120ms ease-out;
        }
        .oni-react-skill-row:hover {
          transform: translateY(-1px);
          filter: brightness(1.03);
          box-shadow:
            0 4px 0 rgba(41,33,24,0.65),
            0 0 0 1px rgba(255,255,255,0.8) inset;
        }
        .oni-react-skill-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          overflow: hidden;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.2),
            0 2px 3px rgba(0,0,0,0.35);
        }
        .oni-react-skill-icon img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .oni-react-skill-main {
          display: flex;
          flex-direction: column;
          justify-content: center;
          min-width: 0;
        }
        .oni-react-skill-name {
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.03em;
          margin-bottom: 1px;
        }
        .oni-react-skill-sub {
          font-size: 11px;
          opacity: 0.8;
        }
        .oni-react-skill-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 4px;
        }
        .oni-react-skill-tag {
          padding: 2px 6px;
          border-radius: 999px;
          background: rgba(72, 56, 39, 0.12);
          border: 1px solid rgba(72, 56, 39, 0.18);
          font-size: 10px;
          line-height: 1.2;
          white-space: nowrap;
        }
        .oni-react-skill-tip {
          margin-top: 6px;
          padding: 6px 8px;
          border-radius: 6px;
          background: rgba(0,0,0,0.18);
          font-size: 11px;
          line-height: 1.35;
        }
        .oni-react-skill-tip b {
          color: #ffe38a;
        }
      `;
      document.head.appendChild(style);
    }

    function esc(s) {
      if (s == null) return "";
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function stripHtml(s) {
      return String(s ?? "").replace(/<[^>]*>/g, "");
    }

    function labelForTrigger(triggerKey) {
      return String(triggerKey ?? "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
    }

    function toArrayUnique(values) {
      return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
    }

    function normalizeTriggerKeys(ctx) {
      const keys = [];
      if (Array.isArray(ctx?.triggerKeys)) keys.push(...ctx.triggerKeys);
      if (ctx?.triggerKey) keys.push(ctx.triggerKey);
      return toArrayUnique(keys.map(k => String(k)));
    }

    function normalizePhasePayloadMap(ctx, triggerKeys) {
      const map = {};
      const srcMap = ctx?.phasePayloadByTrigger;
      if (srcMap && typeof srcMap === "object") {
        for (const [k, v] of Object.entries(srcMap)) {
          if (!k) continue;
          map[String(k)] = (v && typeof v === "object") ? v : {};
        }
      }

      if (ctx?.triggerKey && !(ctx.triggerKey in map)) {
        map[String(ctx.triggerKey)] = (ctx.phasePayload && typeof ctx.phasePayload === "object") ? ctx.phasePayload : {};
      }

      if ((!Object.keys(map).length || !triggerKeys.length) && ctx?.phasePayload && typeof ctx.phasePayload === "object") {
        const fallbackKey = String(ctx?.triggerKey ?? "(unknown_trigger)");
        map[fallbackKey] = ctx.phasePayload;
      }

      for (const key of triggerKeys) {
        if (!(key in map)) map[key] = {};
      }

      return map;
    }

    function buildUniqueReactionItems(reactionsArr, fallbackTriggerKeys) {
      const byUuid = new Map();

      for (const entry of reactionsArr) {
        const item = entry?.item;
        if (!item?.uuid) continue;

        const existing = byUuid.get(item.uuid) ?? {
          item,
          entries: [],
          triggerKeys: new Set()
        };

        existing.entries.push(entry);

        const entryTrigger =
          entry?.triggerKey ??
          entry?.matchedTrigger ??
          entry?.trigger ??
          entry?.row?.reaction_trigger ??
          null;

        if (entryTrigger) existing.triggerKeys.add(String(entryTrigger));
        byUuid.set(item.uuid, existing);
      }

      const out = [];
      for (const rec of byUuid.values()) {
        const triggerKeys = rec.triggerKeys.size
          ? [...rec.triggerKeys]
          : [...fallbackTriggerKeys];

        out.push({
          item: rec.item,
          entries: rec.entries,
          triggerKeys
        });
      }

      out.sort((a, b) => String(a.item?.name ?? "").localeCompare(String(b.item?.name ?? "")));
      return out;
    }

    function collectTargetsFromPayload(payload) {
      const out = [];
      if (!payload || typeof payload !== "object") return out;

      if (Array.isArray(payload.targets)) {
        out.push(...payload.targets.filter(Boolean));
      }
      if (payload.targetUuid) out.push(payload.targetUuid);
      if (payload.targetTokenUuid) out.push(payload.targetTokenUuid);
      if (payload.tokenUuid) out.push(payload.tokenUuid);
      if (payload.subjectTokenUuid) out.push(payload.subjectTokenUuid);
      if (payload.defeatedTokenUuid) out.push(payload.defeatedTokenUuid);

      return out.filter(Boolean);
    }

    function pickPreferredPayload(group, triggerKey, phasePayload, phasePayloadByTrigger) {
      const order = [];
      if (triggerKey) order.push(String(triggerKey));
      if (Array.isArray(group?.triggerKeys)) order.push(...group.triggerKeys.map(String));

      const seen = new Set();
      for (const key of order) {
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const payload = phasePayloadByTrigger?.[key];
        if (payload && typeof payload === "object" && Object.keys(payload).length) return { key, payload };
      }

      if (phasePayload && typeof phasePayload === "object") {
        return { key: String(triggerKey ?? "(unknown_trigger)"), payload: phasePayload };
      }

      return { key: String(triggerKey ?? "(unknown_trigger)"), payload: {} };
    }

    function resolveTargets({ preferredPayload, phasePayload, phasePayloadByTrigger }) {
      const collected = [];
      const pushAll = (arr) => collected.push(...(Array.isArray(arr) ? arr : []));

      pushAll(collectTargetsFromPayload(preferredPayload));
      pushAll(collectTargetsFromPayload(phasePayload));

      if (phasePayloadByTrigger && typeof phasePayloadByTrigger === "object") {
        for (const payload of Object.values(phasePayloadByTrigger)) {
          pushAll(collectTargetsFromPayload(payload));
        }
      }

      return toArrayUnique(collected);
    }

    function firstNonBlank(...values) {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        const s = String(value).trim();
        if (s) return s;
      }
      return "";
    }

    function extractActionCardRefFromPayload(payload) {
      const src = (payload && typeof payload === "object") ? payload : {};
      const nestedMeta = (src?.meta && typeof src.meta === "object") ? src.meta : {};
      const actionContext = (src?.actionContext && typeof src.actionContext === "object") ? src.actionContext : {};
      const actionContextMeta = (actionContext?.meta && typeof actionContext.meta === "object") ? actionContext.meta : {};

      const actionId = firstNonBlank(
        src?.sourceActionId,
        nestedMeta?.sourceActionId,
        src?.actionId,
        nestedMeta?.actionId,
        actionContext?.actionId,
        actionContextMeta?.actionId
      );

      const actionCardId = firstNonBlank(
        src?.sourceActionCardId,
        nestedMeta?.sourceActionCardId,
        src?.actionCardId,
        nestedMeta?.actionCardId,
        actionContext?.actionCardId,
        actionContextMeta?.actionCardId
      );

      const actionCardMessageId = firstNonBlank(
        src?.sourceActionCardMessageId,
        nestedMeta?.sourceActionCardMessageId,
        src?.actionCardMessageId,
        nestedMeta?.actionCardMessageId,
        actionContext?.actionCardMessageId,
        actionContextMeta?.actionCardMessageId
      );

      const ownerUserId = firstNonBlank(
        src?.sourceActionOwnerUserId,
        nestedMeta?.sourceActionOwnerUserId,
        src?.ownerUserId,
        nestedMeta?.ownerUserId,
        actionContextMeta?.ownerUserId
      );

      const ownerUserName = firstNonBlank(
        src?.sourceActionOwnerUserName,
        nestedMeta?.sourceActionOwnerUserName,
        src?.ownerUserName,
        nestedMeta?.ownerUserName,
        actionContextMeta?.ownerUserName
      );

      const versionRaw =
        src?.sourceActionCardVersion ??
        nestedMeta?.sourceActionCardVersion ??
        src?.actionCardVersion ??
        nestedMeta?.actionCardVersion ??
        actionContext?.actionCardVersion ??
        actionContextMeta?.actionCardVersion ??
        null;

      const actionCardVersion = Number(versionRaw);

      return {
        sourceActionId: actionId || null,
        sourceActionCardId: actionCardId || null,
        sourceActionCardVersion: Number.isFinite(actionCardVersion) ? actionCardVersion : null,
        sourceActionCardMessageId: actionCardMessageId || null,
        sourceActionOwnerUserId: ownerUserId || null,
        sourceActionOwnerUserName: ownerUserName || null
      };
    }

    function resolveSourceActionRef({ preferredPayload, phasePayload, phasePayloadByTrigger }) {
      const refs = [];
      refs.push(extractActionCardRefFromPayload(preferredPayload));
      refs.push(extractActionCardRefFromPayload(phasePayload));

      if (phasePayloadByTrigger && typeof phasePayloadByTrigger === "object") {
        for (const payload of Object.values(phasePayloadByTrigger)) {
          refs.push(extractActionCardRefFromPayload(payload));
        }
      }

      const pick = (key) => {
        for (const ref of refs) {
          if (!ref) continue;
          const value = ref[key];
          if (value === null || value === undefined) continue;
          if (typeof value === "number") {
            if (Number.isFinite(value)) return value;
            continue;
          }
          const s = String(value).trim();
          if (s) return s;
        }
        return null;
      };

      return {
        sourceActionId: pick("sourceActionId"),
        sourceActionCardId: pick("sourceActionCardId"),
        sourceActionCardVersion: pick("sourceActionCardVersion"),
        sourceActionCardMessageId: pick("sourceActionCardMessageId"),
        sourceActionOwnerUserId: pick("sourceActionOwnerUserId"),
        sourceActionOwnerUserName: pick("sourceActionOwnerUserName")
      };
    }

    // Normalize a raw context into the shape used by both the dialog and
    // direct-fire entry points. Returns null with a warning notification
    // when required fields are missing.
    function prepareReactionCtx(ctx, { quiet = false } = {}) {
      const actor = ctx?.actor ?? null;
      const token = ctx?.token ?? null;
      const reactionsArr = Array.isArray(ctx?.reactions) ? ctx.reactions : [];
      const triggerKey = ctx?.triggerKey ?? "(unknown_trigger)";
      const triggerKeys = normalizeTriggerKeys(ctx);
      const phasePayload = (ctx?.phasePayload && typeof ctx.phasePayload === "object") ? ctx.phasePayload : {};
      const phasePayloadByTrigger = normalizePhasePayloadMap(ctx, triggerKeys);

      if (!actor) {
        if (!quiet) ui.notifications.warn("[Reaction] No actor found in context.");
        console.warn("[ReactionChooseSkill] prepareReactionCtx: missing actor in ctx:", ctx);
        return null;
      }

      if (!reactionsArr.length) {
        if (!quiet) ui.notifications.warn("[Reaction] No reaction skills available for this trigger.");
        console.warn("[ReactionChooseSkill] prepareReactionCtx: ctx.reactions is empty:", ctx);
        return null;
      }

      const groups = buildUniqueReactionItems(reactionsArr, triggerKeys.length ? triggerKeys : [triggerKey]);
      if (!groups.length) {
        if (!quiet) ui.notifications.warn("[Reaction] No valid Item documents found in reaction list.");
        console.warn("[ReactionChooseSkill] prepareReactionCtx: items list empty. ctx.reactions =", reactionsArr);
        return null;
      }

      // Reaction chain id — sticky across this picker's lifetime. Read from
      // ctx (manager plumbed it in from the trigger payload); fall back to
      // the trigger payload directly in case a hand-built ctx skipped it.
      const reactionChainId =
        ctx?.reactionChainId ??
        ctx?.phasePayload?.reactionChainId ??
        ctx?.phasePayload?.meta?.reactionChainId ??
        ctx?.latestPhasePayload?.reactionChainId ??
        ctx?.latestPhasePayload?.meta?.reactionChainId ??
        null;

      return {
        ctx,
        actor,
        token,
        triggerKey,
        triggerKeys,
        phasePayload,
        phasePayloadByTrigger,
        groups,
        reactionChainId
      };
    }

    async function openReactionDialog(ctx) {
      ensureReactionDialogStyles();

      const prepared = prepareReactionCtx(ctx);
      if (!prepared) return;

      const { actor, token, triggerKey, triggerKeys, phasePayload, phasePayloadByTrigger, groups } = prepared;

      const triggerChipHtml = (triggerKeys.length ? triggerKeys : [triggerKey])
        .map(k => `<div class="oni-react-trigger-chip">${esc(labelForTrigger(k))}</div>`)
        .join("");

      const rowsHtml = groups.map(group => {
        const it = group.item;
        const name = esc(it.name ?? "(Unnamed)");
        const uuid = esc(it.uuid ?? "");
        const img = esc(it.img || "icons/svg/explosion.svg");
        const descRaw = it.system?.props?.description ?? it.system?.description ?? it.system?.system?.description ?? "";
        const desc = esc(stripHtml(descRaw)).substring(0, 240);
        const triggerTags = (group.triggerKeys?.length ? group.triggerKeys : [triggerKey])
          .map(k => `<span class="oni-react-skill-tag">${esc(labelForTrigger(k))}</span>`)
          .join("");

        return `
          <div class="oni-react-skill-row" data-uuid="${uuid}" data-desc="${desc}">
            <div class="oni-react-skill-icon">
              <img src="${img}" alt="">
            </div>
            <div class="oni-react-skill-main">
              <div class="oni-react-skill-name">${name}</div>
              <div class="oni-react-skill-sub">Reaction Skill</div>
              <div class="oni-react-skill-tags">${triggerTags}</div>
            </div>
          </div>
        `;
      }).join("");

      const triggerHeading = (triggerKeys.length > 1)
        ? "Active Triggers"
        : "Trigger";

      const content = `
        <div class="oni-react-skill-wrap">
          <div style="margin-bottom:6px;font-size:11px;opacity:0.9;">
            ${esc(triggerHeading)}:
            <div class="oni-react-trigger-list">${triggerChipHtml}</div>
            <span style="opacity:0.85;">Choose a Reaction to perform.</span>
          </div>
          <div class="oni-react-skill-list">
            ${rowsHtml}
          </div>
          <div class="oni-react-skill-tip" data-tip>
            <b>Tip:</b> Hover a Reaction to see its description here.
          </div>
        </div>
      `;

      const chosenGroup = await new Promise((resolve) => {
        let dlg = null;

        dlg = new Dialog({
          title: "Choose Reaction",
          content,
          buttons: {},
          close: () => resolve(null),
          render: (html) => {
            const $html = $(html);
            const tipEl = html[0].querySelector(".oni-react-skill-tip[data-tip]");
            const $rows = $html.find(".oni-react-skill-row");

            $rows.on("mouseenter", function () {
              if (!tipEl) return;
              const desc = this.dataset.desc || "";
              tipEl.innerHTML = desc
                ? `<b>Description:</b> ${desc}`
                : `<b>Description:</b> (No description)`;
            });

            $rows.on("click", function () {
              const uuid = this.dataset.uuid;
              const group = groups.find(g => g.item?.uuid === uuid);
              resolve(group ?? null);
              dlg.close();
            });
          }
        }, { width: 460 });

        dlg.render(true);
      });

      await executeChosenReaction(prepared, chosenGroup);
    }

    // Append a reactor's pre-action snapshot to the source action card's
    // `reactionsFiredOnThisCard` flag for later cascade-undo. Runs after
    // applyEffectsForGroup completes so that `redirect_target` (which
    // deletes the original chat message and creates a replacement) has
    // already produced the new card we should be writing to. See the
    // call site for the full rationale.
    async function appendReactorSnapshotToSourceCard({
      preSnap, dispatchResult, sourceActionRef, actor, token, chosenGroup, reactionChainId
    }) {
      const MODULE_NS = "fabula-ultima-companion";

      // Look for any redirect_target step in the dispatch chain; if one
      // ran, its result carries the post-redirect message id + actionCardId.
      let postRedirectMsgId = null;
      let postRedirectCardId = null;
      for (const step of (dispatchResult?.applied ?? [])) {
        const r = step?.result;
        if (r?.kind !== "redirect_target") continue;
        for (const a of (r.applied ?? [])) {
          if (a?.info?.newMessageId && !postRedirectMsgId) postRedirectMsgId = a.info.newMessageId;
          if (a?.info?.actionCardId && !postRedirectCardId) postRedirectCardId = a.info.actionCardId;
          if (postRedirectMsgId && postRedirectCardId) break;
        }
        if (postRedirectMsgId && postRedirectCardId) break;
      }

      // Try resolving to a live message: post-redirect id first, then
      // pre-dispatch id. Fall back to actionCardId walk if both miss
      // (handles the case where actionCardMessageId in the trigger
      // payload was null — already fixed in CreateActionCard, but the
      // fallback is cheap and keeps this robust).
      const candidateIds = [
        postRedirectMsgId,
        sourceActionRef?.sourceActionCardMessageId
      ].filter(Boolean);
      let sourceMsg = null;
      for (const id of candidateIds) {
        const m = game.messages?.get?.(id);
        if (m) { sourceMsg = m; break; }
      }
      if (!sourceMsg) {
        const candidateCardIds = [
          postRedirectCardId,
          sourceActionRef?.sourceActionCardId
        ].filter(Boolean);
        for (const cid of candidateCardIds) {
          const want = String(cid);
          for (const m of (game.messages?.contents ?? [])) {
            const f = m?.flags?.[MODULE_NS]?.actionCard;
            if (!f) continue;
            const cardId = f?.actionCardId ?? f?.payload?.meta?.actionCardId ?? null;
            if (cardId && String(cardId) === want) { sourceMsg = m; break; }
          }
          if (sourceMsg) break;
        }
      }

      if (!sourceMsg) {
        console.warn("[ReactionChooseSkill] no source action card resolved for reaction snapshot append — Undo on source card won't cascade-refund this reactor.", {
          sourceActionRef,
          postRedirectMsgId,
          postRedirectCardId,
          reactor: actor?.name,
          skill: chosenGroup?.item?.name
        });
        return;
      }

      const sourceFlag = foundry.utils.deepClone(sourceMsg.getFlag(MODULE_NS, "actionCard") ?? {});
      sourceFlag.reactionsFiredOnThisCard = Array.isArray(sourceFlag.reactionsFiredOnThisCard)
        ? sourceFlag.reactionsFiredOnThisCard
        : [];
      sourceFlag.reactionsFiredOnThisCard.push({
        reactorActorId: actor.id,
        reactorActorUuid: actor.uuid,
        reactorTokenUuid: token?.uuid ?? null,
        skillUuid: chosenGroup.item.uuid,
        skillName: chosenGroup.item.name,
        chainId: reactionChainId ?? null,
        firedAtMs: Date.now(),
        preSnapshot: preSnap
      });

      try {
        await sourceMsg.setFlag(MODULE_NS, "actionCard", sourceFlag, { render: false });
        console.log("[ReactionChooseSkill] appended reaction snapshot to source card", {
          sourceMsgId: sourceMsg.id,
          reactor: actor.name,
          skill: chosenGroup.item.name,
          effectCount: preSnap?.actor?.effects?.length ?? 0,
          postRedirect: !!postRedirectMsgId
        });
      } catch (e) {
        const errStr = String(e?.message ?? e);
        if (/does not exist/i.test(errStr)) {
          console.debug("[ReactionChooseSkill] source card disappeared during append — skipped.", { msgId: sourceMsg.id });
        } else {
          console.warn("[ReactionChooseSkill] could not append reaction snapshot to source card:", e);
        }
      }
    }

    // Fire path shared by the picker dialog and direct-fire (pill click).
    // Given a normalized `prepared` ctx and a pre-selected reaction group,
    // run the same downstream pipeline the dialog used to run after the
    // user clicked a row: subKey calc → applyEffectsForGroup → ADF.execute.
    async function executeChosenReaction(prepared, chosenGroup) {
      const { ctx, actor, token, triggerKey, triggerKeys, phasePayload, phasePayloadByTrigger, reactionChainId } = prepared;

      // Phase R Slice 1.5: compute the per-reactor sub-key for THIS
      // reactor's response. Notify the awaitable substrate on close /
      // pick so only this reactor's sub-window resolves — other reactors'
      // windows continue ticking independently. The local hook is
      // socket-forwarded to GM by reaction-window.js when this runs on a
      // player client.
      const _rsApi = globalThis.FUCompanion?.api?.reactionSystem ?? null;
      const _rsPayload = ctx?.latestPhasePayload ?? ctx?.phasePayload ?? null;
      const _rsReactorTokenId =
        ctx?.token?.id ??
        ctx?.combatant?.tokenId ??
        null;
      const _rsSubKey = (_rsApi?._internals?.buildSubKey && _rsPayload && _rsReactorTokenId)
        ? (() => {
            try {
              const bucket = _rsApi._internals.computeBucket(_rsPayload);
              const actionCardId = _rsPayload?.actionCardId ?? _rsPayload?.meta?.actionCardId ?? null;
              return _rsApi._internals.buildSubKey({
                bucket,
                actionCardId,
                reactorTokenId: _rsReactorTokenId
              });
            } catch { return null; }
          })()
        : null;
      const _fireRsHook = (event, extra = {}) => {
        if (!_rsSubKey) return;
        try { Hooks.callAll(event, { subKey: _rsSubKey, ...extra }); }
        catch (e) { console.warn(`[ReactionChooseSkill] ${event} hook failed:`, e); }
      };

      if (!chosenGroup?.item) {
        console.log("[ReactionChooseSkill] Reaction dialog closed without choice.");
        _fireRsHook("oni:reactionWindow:pickerClosed", { picked: false });
        return;
      }

      const attacker_uuid = actor?.uuid ?? token?.actor?.uuid ?? null;
      if (!attacker_uuid) {
        ui.notifications.error("[Reaction] Could not determine attacker_uuid for Reaction.");
        console.error("[ReactionChooseSkill] openReactionDialog: no attacker_uuid. ctx =", ctx);
        return;
      }

      const preferred = pickPreferredPayload(chosenGroup, triggerKey, phasePayload, phasePayloadByTrigger);
      const targets = resolveTargets({
        preferredPayload: preferred?.payload,
        phasePayload,
        phasePayloadByTrigger
      });
      const sourceActionRef = resolveSourceActionRef({
        preferredPayload: preferred?.payload,
        phasePayload,
        phasePayloadByTrigger
      });

      if (!targets.length) {
        console.log("[ReactionChooseSkill] No phase-derived targets found for Reaction; deferring target selection to Action pipeline/JRPGTargeting.", {
          chosenItem: chosenGroup.item,
          preferred,
          phasePayload,
          phasePayloadByTrigger,
          sourceActionRef
        });
      }

      const payload = {
        attacker_uuid,
        targets,
        skill_uuid: chosenGroup.item.uuid,
        skillUuid: chosenGroup.item.uuid,
        reaction_trigger_key: preferred?.key ?? String(triggerKey ?? "(unknown_trigger)"),
        reaction_trigger_keys: toArrayUnique((chosenGroup.triggerKeys?.length ? chosenGroup.triggerKeys : triggerKeys).map(String)),
        reaction_phase_payload: preferred?.payload ?? {},
        reaction_phase_payload_by_trigger: phasePayloadByTrigger,
        // Propagate the reaction chain id so any downstream action card
        // this reaction creates (Counterattack's attack card, etc.)
        // inherits the same chain — Create Damage Card.js reads it from
        // actionContext.meta.reactionChainId on its way out and re-uses
        // it instead of minting a new one. Without this propagation the
        // cascade resets the chain every hop and infinite-loop guards
        // stop working.
        reactionChainId: reactionChainId ?? null,
        sourceActionId: sourceActionRef.sourceActionId,
        sourceActionCardId: sourceActionRef.sourceActionCardId,
        sourceActionCardVersion: sourceActionRef.sourceActionCardVersion,
        sourceActionCardMessageId: sourceActionRef.sourceActionCardMessageId,
        sourceActionOwnerUserId: sourceActionRef.sourceActionOwnerUserId,
        sourceActionOwnerUserName: sourceActionRef.sourceActionOwnerUserName,
        meta: {
          executionMode: "reaction",
          // Reactions are by definition out of the reactor's turn — the
          // reactor is firing in response to someone else's action. The
          // ADF turn-gate would otherwise hard-block any reactor who
          // isn't the current combatant. This flag opts the payload out
          // of the gate (see ActionDataFetch.js _gateOutOfTurn).
          outOfTurn: true,
          reactionChainId: reactionChainId ?? null,
          skillTargetRaw: chosenGroup.item?.system?.skill_target ?? chosenGroup.item?.system?.system?.skill_target ?? null,
          skillTypeRaw: chosenGroup.item?.system?.skill_type ?? chosenGroup.item?.system?.system?.skill_type ?? null,
          sourceActionId: sourceActionRef.sourceActionId,
          sourceActionCardId: sourceActionRef.sourceActionCardId,
          sourceActionCardVersion: sourceActionRef.sourceActionCardVersion,
          sourceActionCardMessageId: sourceActionRef.sourceActionCardMessageId,
          sourceActionOwnerUserId: sourceActionRef.sourceActionOwnerUserId,
          sourceActionOwnerUserName: sourceActionRef.sourceActionOwnerUserName
        }
      };

      const ADF = game.macros.getName("ActionDataFetch");
      if (!ADF) {
        ui.notifications.error(`Macro "ActionDataFetch" not found or no permission.`);
        console.error("[ReactionChooseSkill] openReactionDialog: missing ActionDataFetch macro.");
        return;
      }

      console.log("[ReactionChooseSkill] Calling ActionDataFetch for Reaction:", {
        attacker_uuid,
        targets,
        skill_uuid: chosenGroup.item.uuid,
        triggerKey,
        triggerKeys,
        preferredTrigger: preferred?.key,
        sourceActionRef
      });

      // Pre-action snapshot for Undo. applyEffectsForGroup below eats
      // any charge AE (Protect's `consume_charge`) BEFORE the action
      // card is even created — so the runConfirm snapshot in
      // applyDamage-button.js can't capture the AE that needs to be
      // restored. Take it HERE so the card-creation pipeline (if a
      // card is created at all) can stash it on the card's flag.
      //
      // Also stash on payload.meta so any downstream action card built
      // from this reaction inherits it for the OWN-card undo path.
      //
      // NOTE: the SOURCE-card append (reactionsFiredOnThisCard) is
      // deliberately deferred until AFTER applyEffectsForGroup runs.
      // Some effect kinds (Protect's `redirect_target`) literally
      // delete the original chat message and create a replacement;
      // writing to the pre-dispatch source card races the delete and
      // (a) loses the snapshot, (b) surfaces a bare "ChatMessage X
      // does not exist" notification from Foundry's socket layer.
      let preSnap = null;
      try {
        const undoApi = globalThis.FUCompanion?.api?.actionCardUndo
          ?? window["oni.ActionCardUndo"];
        if (undoApi?.buildActorSnapshot && actor) {
          preSnap = undoApi.buildActorSnapshot(actor);
          if (preSnap) {
            payload.meta = payload.meta || {};
            payload.meta.preActionSnapshot = preSnap;
          }
        }
      } catch (snapErr) {
        console.warn("[ReactionChooseSkill] buildActorSnapshot threw (Undo for this card may be incomplete):", snapErr);
      }

      // Dispatch declarative effects (looked up by reaction_effect_ref) for
      // every matched row of the chosen reaction. Fires once per matched row
      // with a non-blank effect ref, before the skill runs through the
      // action pipeline. A row that returns `{ abort: true }` (e.g. a
      // `consume_charge` gate that found no charges) stops dispatch AND
      // skips the skill body entirely.
      //
      // A row that returns `{ skipBody: true }` (e.g. `open_action_menu`
      // for Acceleration) is self-contained: skip ADF.execute(synth) but
      // don't show an abort warning and don't fire pickerClosed (the
      // effect already fired pickerPicked).
      let dispatchAborted = false;
      let dispatchSkipBody = false;
      let dispatchResultOuter = null;
      try {
        const grantApi = window["oni.ReactionGrant"]
          ?? globalThis.FUCompanion?.api?.reactionGrant
          ?? null;
        if (grantApi?.applyEffectsForGroup) {
          const reactToken = token ?? actor?.getActiveTokens?.(true, true)?.[0] ?? null;
          // Pass the chosen-skill payload so action-mutation effect_kinds
          // (redirect_target, etc.) can find the source action card and the
          // reactor identity. Resource-only kinds ignore it.
          const dispatchResult = await grantApi.applyEffectsForGroup(chosenGroup, reactToken, game.combat, payload);
          dispatchResultOuter = dispatchResult;
          if (dispatchResult?.skipBody) dispatchSkipBody = true;
          if (dispatchResult?.aborted) {
            dispatchAborted = true;
            console.warn("[ReactionChooseSkill] Reaction aborted by effect-table gate.", dispatchResult.abortInfo);
            const label = dispatchResult.abortInfo?.itemName ?? "Reaction";
            ui.notifications?.warn(`${label} could not fire (no resource available).`);
          }
        }
      } catch (grantErr) {
        console.warn("[ReactionChooseSkill] Reaction effect dispatch threw; continuing with skill execution.", grantErr);
      }

      // Append the reactor's pre-action snapshot to the source action
      // card's flag (`reactionsFiredOnThisCard[]`). This MUST run AFTER
      // applyEffectsForGroup because effect kinds like `redirect_target`
      // (Protect) delete the original source chat message and create a
      // replacement — writing to the pre-dispatch source races the delete
      // and (a) loses the snapshot, (b) surfaces a bare "ChatMessage does
      // not exist" notification from Foundry's socket layer.
      //
      // After dispatch, scan the result for any `redirect_target` step and
      // use its `newMessageId` / `actionCardId` to locate the current
      // source card. Falls back to the original sourceActionRef when no
      // redirect ran.
      //
      // Runs even when dispatchAborted is true. The Protect chain marks
      // itself as "aborted" because the redirect step intentionally
      // short-circuits ADF.execute (the redirect IS the effect) — the
      // reaction DID fire and consumed the charge, so the snapshot still
      // needs to be persisted for cascade-undo to refund the charge.
      if (preSnap) {
        try {
          await appendReactorSnapshotToSourceCard({
            preSnap,
            dispatchResult: dispatchResultOuter,
            sourceActionRef,
            actor,
            token,
            chosenGroup,
            reactionChainId
          });
        } catch (e) {
          console.warn("[ReactionChooseSkill] reactor snapshot append threw (non-fatal):", e);
        }
      }

      if (dispatchResultOuter?.cancelled) {
        // User backed out of a targeting picker mid-dispatch. The
        // reaction did NOT fire; nothing was consumed; the sub-window
        // is still open. Re-spawn the reaction menu so they can pick
        // again (or hit Skip). Do NOT fire pickerClosed (would resolve
        // the sub-window as "skipped").
        console.log("[ReactionChooseSkill] Reaction cancelled at targeting picker — reopening reaction menu.", {
          itemName: chosenGroup?.item?.name ?? null,
          abortInfo: dispatchResultOuter?.abortInfo ?? null
        });
        try {
          const uiApi = window["oni.ReactionButtonUI"];
          if (typeof uiApi?.spawnButton === "function" && token) {
            uiApi.spawnButton(token, ctx);
          }
        } catch (e) {
          console.warn("[ReactionChooseSkill] re-spawn after cancel threw:", e);
        }
        return;
      }

      // After dispatch+ADF resolves OR a gate aborts, decide whether to
      // re-spawn the reaction menu (so the player can pick another skill
      // or hit Skip) or release the sub-window (no reactions left).
      // The chain tracker's markUsed call below ensures the just-fired
      // skill is now disabled in the recomputed group list, so a single-
      // reaction actor naturally falls through to release.
      const _respawnOrRelease = (eventItem) => {
        let remaining = [];
        try { remaining = getReactionGroupsForCtx(ctx) ?? []; }
        catch (e) { console.warn("[ReactionChooseSkill] getReactionGroupsForCtx threw during respawn check:", e); }
        const hasAvailable = remaining.some(g => !g.disabled);
        if (hasAvailable) {
          try {
            const uiApi = window["oni.ReactionButtonUI"];
            if (typeof uiApi?.spawnButton === "function" && token) {
              uiApi.spawnButton(token, ctx);
              return;
            }
          } catch (e) {
            console.warn("[ReactionChooseSkill] respawn after resolve threw:", e);
          }
        }
        // Nothing to re-spawn — release the sub-window.
        _fireRsHook("oni:reactionWindow:pickerPicked", { item: eventItem ?? null });
      };

      if (dispatchAborted) {
        // Aborted gate. Two real cases:
        //   - consume_charge with no charges → reaction did NOT fire
        //     (pill should've been pre-disabled though)
        //   - redirect_target's "abort on success" → reaction DID fire,
        //     intentionally short-circuits the rest of the chain so the
        //     skill body doesn't post a new card.
        // Either way: respawn if more reactions are available, else
        // release. The just-used skill is marked below so it falls out.
        const tracker = globalThis?.FUCompanion?.api?.reactionChainTracker;
        if (reactionChainId && tracker?.markUsed && actor?.id && chosenGroup?.item?.uuid) {
          tracker.markUsed(reactionChainId, actor.id, chosenGroup.item.uuid);
        }
        _respawnOrRelease(chosenGroup?.item ?? null);
        return;
      }

      // Past the abort gate — the reaction WILL fire (either via the
      // self-contained effect path below or via ADF.execute). Mark the
      // skill used in the current reaction chain so it can't be picked
      // again later in the same cascade. Applies to manual reactions
      // routed through this picker; auto-passive reactions have a
      // separate code path.
      const tracker = globalThis?.FUCompanion?.api?.reactionChainTracker;
      if (reactionChainId && tracker?.markUsed && actor?.id && chosenGroup?.item?.uuid) {
        tracker.markUsed(reactionChainId, actor.id, chosenGroup.item.uuid);
      }

      if (dispatchSkipBody) {
        // Self-contained effect (e.g. open_action_menu) already drove the
        // next step + fired its own pickerPicked. Skip ADF.
        // (Respawn after open_action_menu is out of scope here — the
        // free-action flow resolves on its own clock.)
        console.log("[ReactionChooseSkill] Reaction handled by effect (skipBody) — skipping ADF.execute.", {
          itemName: chosenGroup?.item?.name ?? null
        });
        return;
      }

      // Run the skill body. After it resolves, respawn the menu if more
      // reactions remain — otherwise release the sub-window via
      // pickerPicked. Doing this AFTER await keeps the lock + visual
      // menu engaged for the full resolution.
      window.__PAYLOAD = payload;
      try {
        await ADF.execute({ __AUTO: true, __PAYLOAD: payload });
      } finally {
        _respawnOrRelease(chosenGroup.item);
      }
    }

    // Public direct-fire entry. Used by buttonUI's pill row: when the
    // player clicks an inline reaction pill, fire that specific skill
    // straight away — no picker dialog. Same downstream pipeline as the
    // dialog (subKey hooks, effect dispatch, ADF.execute).
    async function fireReactionByItemUuid(ctx, itemUuid) {
      const prepared = prepareReactionCtx(ctx);
      if (!prepared) return;

      const group = prepared.groups.find(g => g?.item?.uuid === itemUuid);
      if (!group) {
        console.warn("[ReactionChooseSkill] fireReactionByItemUuid: no group matches itemUuid", { itemUuid, ctx });
        return;
      }

      await executeChosenReaction(prepared, group);
    }

    // Read the effect table from a reaction Item. Mirrors the helper in
    // reaction-grant.js; duplicated here to avoid a hard import dep just
    // for the once-per-conflict charge check below.
    function readItemEffectRows(item) {
      const sys = item?.system ?? {};
      const props = sys.props ?? sys;
      const tbl = props?.effect_table ?? props?.reaction_effect_table;
      if (!tbl) return [];
      if (Array.isArray(tbl)) return tbl.filter(r => r && typeof r === "object");
      if (typeof tbl === "object") return Object.values(tbl).filter(r => r && typeof r === "object");
      return [];
    }

    // Two-axis "this menu entry is unavailable" check. Returns a short
    // human-readable label or null. The renderer stamps the label across
    // the entry as an overlay (see turn-ui-manager.js `.is-used`).
    //
    //   "Used"      — the actor already fired this skill in the current
    //                 reaction chain. Tracked by reactionChainTracker;
    //                 prevents infinite Counterattack-style loops.
    //   "No Charge" — the skill has a `consume_charge` gate and the
    //                 reactor's charge AE has been spent. Until a refill
    //                 (e.g. start-of-conflict for Protect) puts the AE
    //                 back, the skill can't fire.
    //
    // The two are deliberately differentiated so players see *why* a
    // skill is greyed out: chain exhaustion vs. resource exhaustion.
    function computeDisabledReason(item, actor, reactionChainId) {
      if (!item || !actor) return null;

      // Axis 1 — chain exhaustion (highest priority: most recent player
      // intent). If the skill was just used, "Used" is the right label
      // even if the charge AE happens to also be missing.
      const tracker = globalThis?.FUCompanion?.api?.reactionChainTracker;
      if (reactionChainId && tracker?.isUsed?.(reactionChainId, actor.id, item.uuid)) {
        return "Used";
      }

      // Axis 2 — charge AE absent.
      const chargesApi = globalThis?.FUCompanion?.api?.charges;
      if (chargesApi?.findOnActor) {
        const rows = readItemEffectRows(item);
        for (const row of rows) {
          if (row?.effect_kind !== "consume_charge") continue;
          const key = String(row?.charge_key ?? "").trim();
          if (!key) continue;
          const hits = chargesApi.findOnActor(actor, { key });
          if (!hits?.length) return "No Charge";
        }
      }

      return null;
    }

    // Map a targeting row's `candidate_source` to a short role label for the
    // tooltip. Lives here (not in the resolver) because it's a pure
    // schema-shape transform, no payload reads. The resolver would need a
    // separate "preview" path to safely produce live names — deferred.
    function targetLabelForCandidateSource(source, category) {
      const s = String(source ?? "combat").trim().toLowerCase();
      switch (s) {
        case "self":            return "Self";
        case "trigger_actor":   return "Attacker";
        case "trigger_subject": return "Subject";
        case "action_targets":  return "Target";
        case "combat": {
          const cat = String(category ?? "").trim().toLowerCase();
          if (cat === "ally")     return "Allies";
          if (cat === "enemy")    return "Enemies";
          if (cat === "creature") return "Anyone";
          return "Anyone";
        }
        default:
          return "";
      }
    }

    // Walk effect chain from a reaction row's reaction_effect_ref → find the
    // first consumer effect with a target_ref → look up the targeting row
    // → format the role label. Returns "" if any link is missing.
    function targetLabelForReactionRow(item, reactionRow, effectByLabel) {
      const startRef = String(reactionRow?.reaction_effect_ref ?? "").trim();
      if (!startRef) return "";

      const seen = new Set();
      const queue = [startRef];
      while (queue.length) {
        const label = queue.shift();
        if (seen.has(label)) continue;
        seen.add(label);
        const row = effectByLabel.get(label);
        if (!row) continue;
        const kind = String(row.effect_kind ?? "").trim().toLowerCase();
        if (kind === "chain") {
          const steps = String(row.chain_steps ?? "").split(/[,\n]/).map(s => s.trim()).filter(Boolean);
          for (const s of steps) queue.push(s);
          continue;
        }
        if (kind === "targeting") continue;
        // Non-targeting effect that operates on tokens — read target_ref.
        const targetRef = String(row.target_ref ?? "").trim();
        if (!targetRef) continue;
        const tRow = effectByLabel.get(targetRef);
        if (!tRow || tRow.effect_kind !== "targeting") continue;
        const label2 = targetLabelForCandidateSource(tRow.candidate_source, tRow.category);
        if (label2) return label2;
      }
      return "";
    }

    function buildTriggerLinesFromRows(item, rows) {
      const effectByLabel = new Map();
      for (const r of readItemEffectRows(item)) {
        const lbl = String(r?.effect_label ?? "").trim();
        if (lbl) effectByLabel.set(lbl, r);
      }
      const seen = new Set();
      const lines = [];
      for (const row of rows ?? []) {
        const trigger = String(row?.reaction_trigger ?? "").trim();
        if (!trigger) continue;
        const triggerLabel = labelForTrigger(trigger);
        const target = targetLabelForReactionRow(item, row, effectByLabel);
        const key = `${triggerLabel}::${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({ trigger: triggerLabel, target });
      }
      return lines;
    }

    // Public inspection entry. Returns a flat array of renderable pill
    // descriptors derived from the same group-build path the picker
    // dialog uses. ButtonUI uses this to render one pill per unique
    // reaction skill. Returns [] if the ctx is invalid.
    function getReactionGroupsForCtx(ctx) {
      const prepared = prepareReactionCtx(ctx, { quiet: true });
      if (!prepared) return [];

      const actor = prepared.actor;
      const reactionChainId = prepared.reactionChainId ?? null;
      return prepared.groups.map(g => {
        const item = g.item;
        const descRaw = item?.system?.props?.description ?? item?.system?.description ?? item?.system?.system?.description ?? "";
        const disabledReason = computeDisabledReason(item, actor, reactionChainId);
        const rows = (g.entries ?? []).map(e => e?.row).filter(Boolean);
        return {
          itemUuid: item?.uuid ?? null,
          name: item?.name ?? "(Unnamed)",
          img: item?.img || "icons/svg/explosion.svg",
          description: stripHtml(descRaw),
          triggerKeys: Array.isArray(g.triggerKeys) ? [...g.triggerKeys] : [],
          triggerLabels: (Array.isArray(g.triggerKeys) ? g.triggerKeys : []).map(labelForTrigger),
          triggerLines: buildTriggerLinesFromRows(item, rows),
          disabled: !!disabledReason,
          disabledReason
        };
      }).filter(p => !!p.itemUuid);
    }

    window[KEY] = {
      openReactionDialog,
      fireReactionByItemUuid,
      getReactionGroupsForCtx
    };

    console.debug("[ReactionChooseSkill] Installed. Use window['oni.ReactionChooseSkill'].openReactionDialog(ctx)");
  })();
}

(() => {
  if (globalThis?.game?.ready) _installReactionChooseSkill();
  else Hooks.once("ready", _installReactionChooseSkill);
})();