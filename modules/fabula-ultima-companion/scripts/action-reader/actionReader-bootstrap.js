/* ========================================================================== *
 * ActionReader Bootstrap
 * -------------------------------------------------------------------------- *
 * Module bootstrap for the ActionReader system.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-bootstrap.js
 *
 * Purpose:
 *   1. Import all ActionReader module scripts.
 *   2. Register them onto:
 *        game.modules.get(MODULE_ID).api.ActionReader
 *   3. Make the launcher macro able to call the backend pipeline.
 * ========================================================================== */

import { registerActionReaderCore } from "./actionReader-core.js";
import { registerActionReaderDebug } from "./actionReader-debug.js";
import { registerActionReaderResolvePerformer } from "./actionReader-resolvePerformer.js";
import { registerActionReaderBuildContext } from "./actionReader-buildContext.js";
import { registerActionReaderReadPatternTable } from "./actionReader-readPatternTable.js";
import { registerActionReaderEvaluateConditions } from "./actionReader-evaluateConditions.js";
import { registerActionReaderMatchAndPickAction } from "./actionReader-matchAndPickAction.js";
import { registerActionReaderParseTargetRule } from "./actionReader-parseTargetRule.js";
import { registerActionReaderBuildAndPickTargets } from "./actionReader-buildAndPickTargets.js";
import { registerActionReaderAnnounceResult } from "./actionReader-announceResult.js";

const MODULE_ID = "fabula-ultima-companion";
const SYSTEM_KEY = "ActionReader";

function getModule() {
  return game.modules.get(MODULE_ID) ?? null;
}

function ensureApiRoot() {
  const module = getModule();
  if (!module) {
    console.warn(`[ActionReader] Could not find module "${MODULE_ID}" during bootstrap.`);
    return null;
  }

  module.api ??= {};
  module.api[SYSTEM_KEY] ??= {};
  return module.api[SYSTEM_KEY];
}

function registerActionReaderApi() {
  const apiRoot = ensureApiRoot();
  if (!apiRoot) return;

  registerActionReaderCore(MODULE_ID);
  registerActionReaderDebug(MODULE_ID);
  registerActionReaderResolvePerformer(MODULE_ID);
  registerActionReaderBuildContext(MODULE_ID);
  registerActionReaderReadPatternTable(MODULE_ID);
  registerActionReaderEvaluateConditions(MODULE_ID);
  registerActionReaderMatchAndPickAction(MODULE_ID);
  registerActionReaderParseTargetRule(MODULE_ID);
  registerActionReaderBuildAndPickTargets(MODULE_ID);
  registerActionReaderAnnounceResult(MODULE_ID);

  const module = getModule();
  const actionReaderApi = module?.api?.[SYSTEM_KEY] ?? {};

  console.log(`[ActionReader] Bootstrap complete for module "${MODULE_ID}".`, {
    registeredKeys: Object.keys(actionReaderApi)
  });
}

Hooks.once("ready", () => {
  registerActionReaderApi();
});
