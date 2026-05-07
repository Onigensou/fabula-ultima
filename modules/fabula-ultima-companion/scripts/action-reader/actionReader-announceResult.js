/* ========================================================================== *
 * ActionReader Announce Result
 * -------------------------------------------------------------------------- *
 * Module-compatible result announcer for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-announceResult.js
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_ANNOUNCE_RESULT_VERSION = "1.0.1";
export const ACTION_READER_ANNOUNCE_RESULT_STAGE = "AnnounceResult";

function getModuleApiContainer(moduleId) {
  const module = game.modules.get(moduleId);
  if (!module) return null;

  module.api ??= {};
  module.api.ActionReader ??= {};
  return module.api.ActionReader;
}

function getPerformerName(context) {
  return (
    context?.performer?.actorName ??
    context?.actorData?.identity?.actorName ??
    context?.performer?.actor?.name ??
    "Unknown Actor"
  );
}

function getChosenAction(context) {
  return context?.chosenAction ?? null;
}

function getChosenTargets(context) {
  return Array.isArray(context?.chosenTargets) ? context.chosenTargets : [];
}

function getActionName(context) {
  const chosenAction = getChosenAction(context);
  return (
    chosenAction?.name ??
    chosenAction?.itemSnapshot?.displayName ??
    chosenAction?.item?.name ??
    "Unknown Action"
  );
}

function getActionIcon(context) {
  const chosenAction = getChosenAction(context);
  return (
    chosenAction?.icon ??
    (chosenAction?.item ? AR.getActionTypeIcon(chosenAction.item) : "💥")
  );
}

function getTargetDisplayName(target) {
  return (
    target?.tokenName ??
    target?.actorName ??
    target?.token?.name ??
    target?.actor?.name ??
    "Unknown Target"
  );
}

function formatNameList(names = []) {
  const clean = names
    .map(name => AR.toString(name, "").trim())
    .filter(Boolean);

  if (!clean.length) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;

  return `${clean.slice(0, -1).join(", ")}, and ${clean.at(-1)}`;
}

function getTargetNames(context) {
  return getChosenTargets(context).map(getTargetDisplayName);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildPlainText(context) {
  const performerName = getPerformerName(context);
  const actionName = getActionName(context);
  const actionIcon = getActionIcon(context);
  const targetText = formatNameList(getTargetNames(context));

  if (!targetText) {
    return `${performerName} use ${actionIcon}${actionName}!`;
  }

  return `${performerName} use ${actionIcon}${actionName} on ${targetText}!`;
}

function buildHtmlText(context) {
  const performerName = esc(getPerformerName(context));
  const actionName = esc(getActionName(context));
  const actionIcon = esc(getActionIcon(context));
  const targetNames = getTargetNames(context).map(name => esc(name));
  const targetText = formatNameList(targetNames);

  if (!targetText) {
    return `<strong>${performerName}</strong> use ${actionIcon}<strong>${actionName}</strong>!`;
  }

  return `<strong>${performerName}</strong> use ${actionIcon}<strong>${actionName}</strong> on <strong>${targetText}</strong>!`;
}

function getChatSpeaker(context) {
  const token = context?.performer?.token ?? null;
  const actor = context?.performer?.actor ?? null;

  if (ChatMessage?.getSpeaker) {
    return ChatMessage.getSpeaker({ actor, token });
  }

  return {};
}

function getGmWhisperIds() {
  const recipients = ChatMessage?.getWhisperRecipients?.("GM") ?? [];
  return recipients.map(user => user.id).filter(Boolean);
}

async function createResultChatMessage(context, html, options = {}) {
  const speaker = getChatSpeaker(context);
  const whisperToGm = options?.whisperToGm !== false;
  const explicitWhisper = Array.isArray(options?.whisper) ? options.whisper.filter(Boolean) : null;

  const chatData = {
    speaker,
    content: html
  };

  if (explicitWhisper?.length) {
    chatData.whisper = explicitWhisper;
  } else if (whisperToGm) {
    chatData.whisper = getGmWhisperIds();
  }

  return ChatMessage.create(chatData);
}

function summarizeAnnouncement(context, plainText, options = {}) {
  return {
    performerName: getPerformerName(context),
    actionName: getActionName(context),
    targetNames: getTargetNames(context),
    plainText,
    showNotification: options?.showNotification !== false,
    showChatMessage: Boolean(options?.showChatMessage)
  };
}

export async function announceActionReaderResult(context, options = {}) {
  const stage = ACTION_READER_ANNOUNCE_RESULT_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      showNotification: options?.showNotification !== false,
      showChatMessage: Boolean(options?.showChatMessage),
      whisperToGm: options?.whisperToGm !== false
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const chosenAction = getChosenAction(context);
    if (!chosenAction) {
      ARD.addError(context, stage, "AnnounceResult requires a chosen action first.", {
        hasChosenAction: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const plainText = buildPlainText(context);
    const htmlText = buildHtmlText(context);

    context.finalText = plainText;
    context.finalHtml = htmlText;
    context.announceMeta = summarizeAnnouncement(context, plainText, options);

    if (options?.showNotification !== false) {
      ui.notifications.info(plainText);
    }

    if (options?.showChatMessage) {
      await createResultChatMessage(context, htmlText, options);
    }

    ARD.recordStage(context, stage, context.announceMeta);

    ARD.endStage(context, stage, {
      ok: true,
      finalText: context.finalText
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while announcing result.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][AnnounceResult] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

export function registerActionReaderAnnounceResult(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderAnnounceResult called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Announce Result.`);
    return;
  }

  api.AnnounceResult = {
    announceActionReaderResult
  };

  console.log(`[ActionReader] Announce Result registered to module API for "${moduleId}".`);
}
