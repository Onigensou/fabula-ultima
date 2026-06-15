// Battle End Cleanup — resource reset for between-battle session fields.
//
// Resets RESET_KEYS (clock_brainwave, clock_adoration) to their template
// defaultValue on all party actors. PERSIST_KEYS are left untouched.
// Token deletion and AE sweeping are handled by boot.stop() — NOT here.

import { log, warn } from "../logger.js";

const RESET_KEYS   = ["clock_brainwave", "clock_adoration"];
const PERSIST_KEYS = new Set(["clock_trade"]);
const PERSIST_REGEX = /^resource_value_\d+$/i;

function isPersisted(key) {
  return PERSIST_KEYS.has(key) || PERSIST_REGEX.test(key);
}

function walkContents(contents) {
  if (!Array.isArray(contents)) return [];
  const fields = [];
  for (const node of contents) {
    if (!node || typeof node !== "object") continue;
    if (node.type === "numberField") fields.push(node);
    if (Array.isArray(node.contents)) fields.push(...walkContents(node.contents));
  }
  return fields;
}

export async function runBattleEndResourceReset(endCtx) {
  const { partyActorIds } = endCtx;
  if (!partyActorIds.length) return;

  for (const actorId of partyActorIds) {
    const actor = game.actors?.get?.(actorId);
    if (!actor) { warn(`[BattleEnd:Cleanup] Missing actor: ${actorId}`); continue; }

    const contents = actor.system?.body?.contents ?? [];
    const numberFields = walkContents(contents);
    const updateData = {};

    for (const field of numberFields) {
      const key = String(field.name ?? "");
      if (!RESET_KEYS.includes(key)) continue;
      if (isPersisted(key)) continue;

      const defaultValue = field.defaultValue ?? 0;
      const currentValue = actor.system?.props?.[key];
      if (currentValue === defaultValue) continue;

      updateData[`system.props.${key}`] = defaultValue;
    }

    if (!Object.keys(updateData).length) continue;

    try {
      await actor.update(updateData);
      log(`[BattleEnd:Cleanup] Reset resources on ${actor.name}:`, Object.keys(updateData));
    } catch (e) {
      warn(`[BattleEnd:Cleanup] update failed for ${actor.name}:`, e);
    }
  }
}
