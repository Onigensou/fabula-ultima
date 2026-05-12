#!/usr/bin/env node
"use strict";

// One-shot patch script. Rewrites Phantasmal Echo's custom_logic_action
// gate to use the new isPhantasm + summonedBy conventions in place of the
// hardcoded REPLACE_ME UUID/name lists.
//
// Also accepts a CLI list of Phantasm NPC actor UUIDs and sets
// system.props.isPhantasm = true on each. Both passes are independent;
// either alone is fine.
//
// Usage:
//   node tools/safe-edit/bin/_apply-phantasmal-echo-patch.js \
//     --skill Item.YDzMWktTnD9J9Jun \
//     --phantasm Actor.AAA --phantasm Actor.BBB \
//     [--dry-run]
//
// Requires Foundry to be closed (safe-edit refuses to write otherwise).

const { safeEdit, getDoc } = require("../lib");

// ---------------- CLI parse ----------------
const args = process.argv.slice(2);
let skillUuid = "Item.YDzMWktTnD9J9Jun"; // Phantasmal Echo default
const phantasmUuids = [];
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--skill") { skillUuid = args[++i]; continue; }
  if (a === "--phantasm") { phantasmUuids.push(args[++i]); continue; }
  if (a === "--dry-run") { dryRun = true; continue; }
  if (a === "--help" || a === "-h") {
    console.log("Usage: --skill <UUID> [--phantasm <UUID>]... [--dry-run]");
    process.exit(0);
  }
}

// ---------------- The patched gate, as plain JS source ----------------
const PATCHED_JS = String.raw`const TAG = "[CL-ACT][PHANTASMAL_ECHO_GATE]";

const phase =
  __PAYLOAD?.meta?.reaction_phase_payload ??
  __PAYLOAD?.reaction_phase_payload ??
  {};
const phaseByTrigger =
  __PAYLOAD?.meta?.reaction_phase_payload_by_trigger ??
  __PAYLOAD?.reaction_phase_payload_by_trigger ??
  {};
const passiveTriggerKey =
  __PAYLOAD?.meta?.passiveTriggerKey ??
  __PAYLOAD?.reaction_trigger_key ??
  phase?.trigger ??
  null;
const triggerPayload =
  (passiveTriggerKey && phaseByTrigger?.[passiveTriggerKey])
    ? phaseByTrigger[passiveTriggerKey]
    : phase;

// Safety: only react to creature_defeated.
if ((triggerPayload?.trigger ?? passiveTriggerKey) !== "creature_defeated") {
  return context.skipPassive("", { notify: false });
}

// Resolve the defeated subject.
const defeatedActorUuid =
  triggerPayload?.defeatedActorUuid ??
  triggerPayload?.targetActorUuid ??
  triggerPayload?.subjectActorUuid ??
  triggerPayload?.actorUuid ??
  null;
const defeatedTokenUuid =
  triggerPayload?.defeatedTokenUuid ??
  triggerPayload?.targetUuid ??
  triggerPayload?.subjectTokenUuid ??
  triggerPayload?.tokenUuid ??
  (Array.isArray(triggerPayload?.targets) ? triggerPayload.targets[0] : null) ??
  null;

let defeatedDoc = null;
if (defeatedTokenUuid) defeatedDoc = await fromUuid(defeatedTokenUuid);
if (!defeatedDoc && defeatedActorUuid) defeatedDoc = await fromUuid(defeatedActorUuid);

const defeatedActor = defeatedDoc?.actor ?? defeatedDoc ?? null;
const defeatedTokenDoc = (defeatedDoc?.documentName === "Token") ? defeatedDoc : null;
const defeatedName = defeatedActor?.name ?? defeatedDoc?.name ?? "Unknown";

if (!defeatedActor) {
  console.warn(TAG, "Could not resolve defeated creature.", { defeatedActorUuid, defeatedTokenUuid, triggerPayload });
  return context.skipPassive("", { notify: false });
}

// Kind check: must be a Phantasm (system.props.isPhantasm).
const phantasmApi = globalThis?.FUCompanion?.api?.phantasm ?? null;
const kindOk = phantasmApi?.isPhantasm
  ? phantasmApi.isPhantasm(defeatedActor)
  : !!defeatedActor?.system?.props?.isPhantasm;

if (!kindOk) {
  context.log("Phantasmal Echo gate failed - defeated creature is not a Phantasm.", {
    defeatedName, defeatedActorUuid: defeatedActor?.uuid
  });
  return context.skipPassive("", { notify: false });
}

// Ownership check: Phantasm summonedBy must match the reactor's actor UUID.
const reactorUuid = context?.attackerUuid ?? "";
let reactorActorUuid = reactorUuid;
try {
  const reactorDoc = reactorUuid ? await fromUuid(reactorUuid) : null;
  reactorActorUuid =
    reactorDoc?.actor?.uuid ??
    (reactorDoc?.documentName === "Actor" ? reactorDoc.uuid : null) ??
    reactorUuid;
} catch (_e) { /* fall through to raw uuid */ }

const summonedBy = phantasmApi?.getSummoner
  ? phantasmApi.getSummoner(defeatedTokenDoc ?? defeatedDoc)
  : (defeatedTokenDoc?.getFlag?.("fabula-ultima-companion", "summonedBy") ?? null);

if (!summonedBy || summonedBy !== reactorActorUuid) {
  context.log("Phantasmal Echo gate failed - Phantasm not summoned by reactor.", {
    defeatedName, defeatedActorUuid: defeatedActor?.uuid, summonedBy, reactorActorUuid
  });
  return context.skipPassive("", { notify: false });
}

// Pass - let the passive continue into Resolution.
context.log("Phantasmal Echo gate passed.", {
  defeatedName, defeatedActorUuid: defeatedActor?.uuid, summonedBy, reactorActorUuid
});`;

// CSB stores rich-text fields as HTML: each line wrapped in <p>...</p>,
// with &, <, > entity-encoded.
function jsToHtmlField(src) {
  const htmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return src
    .split("\n")
    .map((line) => `<p>${line === "" ? "" : htmlEscape(line)}</p>`)
    .join("");
}

const PATCHED_HTML = jsToHtmlField(PATCHED_JS);

// ---------------- Run ----------------
(async () => {
  console.log(`[apply] dryRun=${dryRun}, skill=${skillUuid}, phantasms=${phantasmUuids.length}`);

  // Pass 1: Phantasmal Echo gate rewrite.
  console.log(`\n[apply] Phantasmal Echo: patching system.props.custom_logic_action...`);
  try {
    const before = await getDoc(skillUuid);
    if (!before) {
      console.error(`[apply] Skill not found: ${skillUuid}`);
      process.exit(1);
    }
    const result = await safeEdit({
      uuid: skillUuid,
      patch: { "system.props.custom_logic_action": PATCHED_HTML },
      note: "Phantasmal Echo: convention-based gate (isPhantasm + summonedBy)",
      dryRun,
    });
    if (dryRun) {
      console.log(`[apply] DRY RUN - would write ${PATCHED_HTML.length} chars`);
    } else {
      console.log(`[apply] OK entryId=${result.entryId} backup=${result.backupPath}`);
    }
  } catch (e) {
    console.error(`[apply] Phantasmal Echo patch FAILED:`, e.message);
    process.exit(1);
  }

  // Pass 2: isPhantasm flag on each NPC.
  for (const uuid of phantasmUuids) {
    console.log(`\n[apply] ${uuid}: setting system.props.isPhantasm = true...`);
    try {
      const before = await getDoc(uuid);
      if (!before) {
        console.warn(`[apply] Actor not found, skipping: ${uuid}`);
        continue;
      }
      if (before?.system?.props?.isPhantasm === true) {
        console.log(`[apply] Already isPhantasm:true, skipping: ${uuid}`);
        continue;
      }
      const result = await safeEdit({
        uuid,
        patch: { "system.props.isPhantasm": true },
        note: "Mark as Phantasm (kind marker for reaction filter)",
        dryRun,
      });
      if (dryRun) {
        console.log(`[apply] DRY RUN - would set isPhantasm on ${uuid}`);
      } else {
        console.log(`[apply] OK entryId=${result.entryId} backup=${result.backupPath}`);
      }
    } catch (e) {
      console.error(`[apply] ${uuid} FAILED:`, e.message);
      // Continue with remaining UUIDs.
    }
  }

  console.log(`\n[apply] Done.`);
})();
