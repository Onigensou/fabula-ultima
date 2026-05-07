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

Hooks.once("ready", () => {
  (() => {
    const KEY = "oni.ReactionChooseSkill";
    if (window[KEY]) {
      console.log("[ReactionChooseSkill] Already installed.");
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

    async function openReactionDialog(ctx) {
      ensureReactionDialogStyles();

      const actor = ctx?.actor ?? null;
      const token = ctx?.token ?? null;
      const reactionsArr = Array.isArray(ctx?.reactions) ? ctx.reactions : [];
      const triggerKey = ctx?.triggerKey ?? "(unknown_trigger)";
      const triggerKeys = normalizeTriggerKeys(ctx);
      const phasePayload = (ctx?.phasePayload && typeof ctx.phasePayload === "object") ? ctx.phasePayload : {};
      const phasePayloadByTrigger = normalizePhasePayloadMap(ctx, triggerKeys);

      if (!actor) {
        ui.notifications.warn("[Reaction] No actor found in context.");
        console.warn("[ReactionChooseSkill] openReactionDialog: missing actor in ctx:", ctx);
        return;
      }

      if (!reactionsArr.length) {
        ui.notifications.warn("[Reaction] No reaction skills available for this trigger.");
        console.warn("[ReactionChooseSkill] openReactionDialog: ctx.reactions is empty:", ctx);
        return;
      }

      const groups = buildUniqueReactionItems(reactionsArr, triggerKeys.length ? triggerKeys : [triggerKey]);
      if (!groups.length) {
        ui.notifications.warn("[Reaction] No valid Item documents found in reaction list.");
        console.warn("[ReactionChooseSkill] openReactionDialog: items list empty. ctx.reactions =", reactionsArr);
        return;
      }

      const triggerChipHtml = (triggerKeys.length ? triggerKeys : [triggerKey])
        .map(k => `<div class="oni-react-trigger-chip">${esc(labelForTrigger(k))}</div>`)
        .join("");

      const rowsHtml = groups.map(group => {
        const it = group.item;
        const name = esc(it.name ?? "(Unnamed)");
        const uuid = esc(it.uuid ?? "");
        const img = esc(it.img || "icons/svg/explosion.svg");
        const descRaw = it.system?.description ?? it.system?.system?.description ?? "";
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

      if (!chosenGroup?.item) {
        console.log("[ReactionChooseSkill] Reaction dialog closed without choice.");
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
        sourceActionId: sourceActionRef.sourceActionId,
        sourceActionCardId: sourceActionRef.sourceActionCardId,
        sourceActionCardVersion: sourceActionRef.sourceActionCardVersion,
        sourceActionCardMessageId: sourceActionRef.sourceActionCardMessageId,
        sourceActionOwnerUserId: sourceActionRef.sourceActionOwnerUserId,
        sourceActionOwnerUserName: sourceActionRef.sourceActionOwnerUserName,
        meta: {
          executionMode: "reaction",
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

      window.__PAYLOAD = payload;
      await ADF.execute({ __AUTO: true, __PAYLOAD: payload });
    }

    window[KEY] = {
      openReactionDialog
    };

    console.log("[ReactionChooseSkill] Installed. Use window['oni.ReactionChooseSkill'].openReactionDialog(ctx)");
  })();
});