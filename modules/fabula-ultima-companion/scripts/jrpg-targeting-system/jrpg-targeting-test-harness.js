// ============================================
// JRPG Targeting System - Test Harness
// File: jrpg-targeting-test-harness.js
// Foundry VTT V12
// ============================================

import { MODULE_ID } from "./jrpg-targeting-constants.js";
import {
  createJRPGTargetingDebugger,
  makeJRPGTargetingRunId
} from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("TestHarness");

const HARNESS_GLOBAL_KEY = "__ONI_JRPG_TARGETING_TEST_HARNESS__";
const HARNESS_API_KEY = "JRPGTargetingTestHarness";

const PRESETS = Object.freeze([
  { label: "Free / Empty", value: "" },
  { label: "None / -", value: "-" },
  { label: "One Creature", value: "One Creature" },
  { label: "Two Creatures", value: "Two Creatures" },
  { label: "Up to Three Creature", value: "Up to Three Creature" },
  { label: "Up to Two Ally", value: "Up to Two Ally" },
  { label: "All Creature", value: "All Creature" },
  { label: "All Ally", value: "All Ally" },
  { label: "All Enemy", value: "All Enemy" }
]);

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function getTargetingAPI() {
  return game.modules.get(MODULE_ID)?.api?.JRPGTargeting ?? null;
}

function ensureHarnessState() {
  if (!globalThis[HARNESS_GLOBAL_KEY]) {
    globalThis[HARNESS_GLOBAL_KEY] = {
      lastDialog: null,
      lastResult: null
    };
    dbg.log("HARNESS STATE CREATED");
  }

  return globalThis[HARNESS_GLOBAL_KEY];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getUserOptionsHtml(selectedUserId = "") {
  const users = Array.from(game.users ?? []);
  return users.map((user) => {
    const selected = user.id === selectedUserId ? "selected" : "";
    return `<option value="${escapeHtml(user.id)}" ${selected}>${escapeHtml(user.name)}</option>`;
  }).join("");
}

function getPresetOptionsHtml(selectedValue = "") {
  return PRESETS.map((preset) => {
    const selected = preset.value === selectedValue ? "selected" : "";
    return `<option value="${escapeHtml(preset.value)}" ${selected}>${escapeHtml(preset.label)}</option>`;
  }).join("");
}

function buildActionStub(skillTarget = "") {
  return {
    name: "JRPG Targeting Test Action",
    system: {
      props: {
        skill_target: String(skillTarget ?? "")
      }
    }
  };
}

function getResultSummaryHtml(result = null) {
  if (!result) {
    return `<div style="opacity:.75;">No result yet.</div>`;
  }

  const tokenLines = Array.isArray(result.tokens)
    ? result.tokens.map((token) => {
        const tokenName = token?.name ?? token?.tokenName ?? "(Unknown Token)";
        const actorName = token?.actorName ?? token?.actor?.name ?? "";
        const label = actorName && actorName !== tokenName
          ? `${tokenName} (${actorName})`
          : tokenName;
        return `<li>${escapeHtml(label)}</li>`;
      }).join("")
    : "";

  return `
    <div style="display:grid; gap:6px;">
      <div><strong>Status:</strong> ${escapeHtml(result.status ?? "unknown")}</div>
      <div><strong>Mode:</strong> ${escapeHtml(result.mode ?? "unknown")}</div>
      <div><strong>Category:</strong> ${escapeHtml(result.category ?? "unknown")}</div>
      <div><strong>Selected Count:</strong> ${escapeHtml(result.selectedCount ?? 0)}</div>
      <div><strong>Prompt:</strong> ${escapeHtml(result.promptText ?? "")}</div>
      <div><strong>Targets:</strong></div>
      <ul style="margin:0; padding-left:18px;">${tokenLines || "<li>(none)</li>"}</ul>
    </div>
  `;
}

function buildHarnessContent({
  selectedUserId = game.user?.id ?? "",
  selectedPreset = "One Creature",
  customText = "One Creature",
  parsed = null,
  lastResult = null
} = {}) {
  return `
    <form class="oni-jrpg-target-harness" autocomplete="off">
      <style>
        .oni-jrpg-target-harness {
          display: grid;
          gap: 12px;
        }
        .oni-jrpg-target-harness .oni-row {
          display: grid;
          gap: 6px;
        }
        .oni-jrpg-target-harness label {
          font-weight: 700;
        }
        .oni-jrpg-target-harness select,
        .oni-jrpg-target-harness input[type="text"] {
          width: 100%;
        }
        .oni-jrpg-target-harness .oni-box {
          border: 1px solid rgba(255,255,255,.15);
          border-radius: 8px;
          padding: 10px;
          background: rgba(0,0,0,.15);
        }
        .oni-jrpg-target-harness .oni-muted {
          opacity: .8;
          font-size: 12px;
        }
        .oni-jrpg-target-harness .oni-grid2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .oni-jrpg-target-harness pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 12px;
          line-height: 1.3;
        }
      </style>

      <div class="oni-grid2">
        <div class="oni-row">
          <label for="oni-jrpg-target-harness-user">Target User</label>
          <select id="oni-jrpg-target-harness-user" name="userId">
            ${getUserOptionsHtml(selectedUserId)}
          </select>
        </div>

        <div class="oni-row">
          <label for="oni-jrpg-target-harness-preset">Preset</label>
          <select id="oni-jrpg-target-harness-preset" name="preset">
            ${getPresetOptionsHtml(selectedPreset)}
          </select>
        </div>
      </div>

      <div class="oni-row">
        <label for="oni-jrpg-target-harness-skill-target">Skill Target Text</label>
        <input
          id="oni-jrpg-target-harness-skill-target"
          type="text"
          name="skillTarget"
          value="${escapeHtml(customText)}"
          placeholder="Example: Up to Three Ally"
        />
        <div class="oni-muted">This feeds directly into the parser / targeting request.</div>
      </div>

      <div class="oni-grid2">
        <div class="oni-row">
          <div class="oni-box">
            <div style="font-weight:700; margin-bottom:6px;">Parsed Preview</div>
            <pre>${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>
          </div>
        </div>

        <div class="oni-row">
          <div class="oni-box">
            <div style="font-weight:700; margin-bottom:6px;">Last Result</div>
            ${getResultSummaryHtml(lastResult)}
          </div>
        </div>
      </div>
    </form>
  `;
}

function readHarnessForm(html) {
  const root = html?.[0] ?? html;
  const userId = root?.querySelector?.('[name="userId"]')?.value ?? game.user?.id ?? "";
  const preset = root?.querySelector?.('[name="preset"]')?.value ?? "";
  const skillTarget = root?.querySelector?.('[name="skillTarget"]')?.value ?? "";

  return {
    userId,
    preset,
    skillTarget: String(skillTarget ?? "")
  };
}

async function renderHarnessDialog({
  selectedUserId = game.user?.id ?? "",
  selectedPreset = "One Creature",
  customText = "One Creature",
  lastResult = null
} = {}) {
  const api = getTargetingAPI();
  if (!api) {
    ui.notifications?.error?.("JRPG Targeting API not found.");
    return null;
  }

  const parsed = api.parseTargetingText(customText);
  const content = buildHarnessContent({
    selectedUserId,
    selectedPreset,
    customText,
    parsed,
    lastResult
  });

  const state = ensureHarnessState();

  state.lastDialog?.close?.();

  const dialog = new Dialog({
    title: "JRPG Targeting Test Harness",
    content,
    buttons: {
      parse: {
        label: "Parse Preview",
        callback: async (html) => {
          const data = readHarnessForm(html);
          await renderHarnessDialog({
            selectedUserId: data.userId,
            selectedPreset: data.preset,
            customText: data.skillTarget,
            lastResult: ensureHarnessState().lastResult
          });
        }
      },
      start: {
        label: "Start Targeting",
        callback: async (html) => {
          const data = readHarnessForm(html);
          await startHarnessTargeting({
            userId: data.userId,
            skillTarget: data.skillTarget
          });
        }
      },
      actionStub: {
        label: "Test Action Stub",
        callback: async (html) => {
          const data = readHarnessForm(html);
          await startHarnessTargetingFromAction({
            userId: data.userId,
            action: buildActionStub(data.skillTarget)
          });
        }
      },
      cancel: {
        label: "Close"
      }
    },
    default: "start",
    render: (html) => {
      const root = html?.[0];
      const presetSelect = root?.querySelector?.('#oni-jrpg-target-harness-preset');
      const skillInput = root?.querySelector?.('#oni-jrpg-target-harness-skill-target');

      if (presetSelect && skillInput) {
        presetSelect.addEventListener("change", () => {
          const value = presetSelect.value ?? "";
          skillInput.value = value;
        });
      }
    },
    close: () => {
      if (state.lastDialog === dialog) {
        state.lastDialog = null;
      }
    }
  }, {
    width: 820,
    height: "auto",
    resizable: true
  });

  state.lastDialog = dialog;
  dialog.render(true);

  return dialog;
}

function saveLastResult(result) {
  const state = ensureHarnessState();
  state.lastResult = result ?? null;
}

/* -------------------------------------------- */
/* Public harness actions                       */
/* -------------------------------------------- */

export async function startHarnessTargeting({
  userId = game.user?.id ?? null,
  skillTarget = "One Creature",
  uiSettings = {}
} = {}) {
  const runId = makeJRPGTargetingRunId("HARNESS-START");
  const api = getTargetingAPI();

  if (!api) {
    ui.notifications?.error?.("JRPG Targeting API not found.");
    return null;
  }

  dbg.logRun(runId, "START TARGETING", {
    userId,
    skillTarget
  });

  const result = await api.requestTargeting({
    userId,
    skillTarget,
    uiTitleText: api.parseTargetingText(skillTarget)?.promptText ?? null,
    uiSettings
  });

  saveLastResult(result);

  dbg.logRun(runId, "TARGETING RESULT", result);

  await renderHarnessDialog({
    selectedUserId: userId,
    selectedPreset: skillTarget,
    customText: skillTarget,
    lastResult: result
  });

  return result;
}

export async function startHarnessTargetingFromAction({
  userId = game.user?.id ?? null,
  action = null,
  uiSettings = {}
} = {}) {
  const runId = makeJRPGTargetingRunId("HARNESS-ACTION");
  const api = getTargetingAPI();

  if (!api) {
    ui.notifications?.error?.("JRPG Targeting API not found.");
    return null;
  }

  dbg.logRun(runId, "START TARGETING FROM ACTION", {
    userId,
    action
  });

  const result = await api.requestTargeting({
    userId,
    action,
    uiSettings
  });

  saveLastResult(result);

  dbg.logRun(runId, "TARGETING FROM ACTION RESULT", result);

  const parsed = api.parseTargetingFromAction(action);
  const skillTarget = api.getSkillTargetFromAction(action);

  await renderHarnessDialog({
    selectedUserId: userId,
    selectedPreset: skillTarget,
    customText: skillTarget,
    lastResult: result,
    parsed
  });

  return result;
}

export async function openJRPGTargetingTestHarness(options = {}) {
  return await renderHarnessDialog(options);
}

export function parseHarnessSkillTarget(skillTarget = "") {
  const api = getTargetingAPI();
  if (!api) return null;
  return api.parseTargetingText(skillTarget);
}

export function getJRPGTargetingHarnessLastResult() {
  return ensureHarnessState().lastResult ?? null;
}

/* -------------------------------------------- */
/* Installation                                 */
/* -------------------------------------------- */

function buildHarnessAPI() {
  return {
    open: openJRPGTargetingTestHarness,
    start: startHarnessTargeting,
    startFromAction: startHarnessTargetingFromAction,
    parse: parseHarnessSkillTarget,
    getLastResult: getJRPGTargetingHarnessLastResult,
    buildActionStub
  };
}

function installHarnessAPI() {
  const api = buildHarnessAPI();

  globalThis[HARNESS_GLOBAL_KEY] = {
    ...(ensureHarnessState()),
    api
  };

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = module.api || {};
    module.api[HARNESS_API_KEY] = api;
  }

  dbg.log("HARNESS API INSTALLED", {
    moduleId: MODULE_ID,
    apiKey: HARNESS_API_KEY
  });

  return api;
}

Hooks.once("ready", () => {
  installHarnessAPI();
});

export default {
  openJRPGTargetingTestHarness,
  startHarnessTargeting,
  startHarnessTargetingFromAction,
  parseHarnessSkillTarget,
  getJRPGTargetingHarnessLastResult,
  buildActionStub
};
