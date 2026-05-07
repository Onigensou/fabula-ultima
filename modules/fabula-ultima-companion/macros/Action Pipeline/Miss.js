// ──────────────────────────────────────────────────────────
//  Miss / Dodge  — Foundry V12
//  • Logs to Battle Log
//  • Plays FX/SFX
//  • For each target, calls Create Damage Card in "miss" mode
// ──────────────────────────────────────────────────────────
const LOGGER_MACRO_NAME = "BattleLog: Append";
const DMG_CARD_MACRO_NAME = "Create Damage Card";

// ---- Inputs from Create Action Card (headless) ----
let AUTO = false, PAYLOAD = {};
if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

const attackerName  = String(PAYLOAD.attackerName ?? "Unknown");
const attackerUuid  = String(PAYLOAD.attackerUuid ?? ""); // optional
const elementType   = String(PAYLOAD.elementType  ?? "physical").toLowerCase();
const isSpellish    = !!PAYLOAD.isSpellish;
const weaponTypeRaw = String(PAYLOAD.weaponType   ?? "");
const attackRange   = String(PAYLOAD.attackRange  ?? "—");
const accTotal      = Number(PAYLOAD.accuracyTotal ?? NaN);
const defenseUsed   = Number(PAYLOAD.defenseUsed   ?? NaN);

// Damage Card batching.
// ActionExecutionCore should pass this in, but we include fallbacks so old/manual
// miss calls still behave normally.
const ACTION_CONTEXT = PAYLOAD.actionContext ?? null;
const ACTION_CARD_MSG = PAYLOAD.actionCardMsgId ?? null;

const DAMAGE_BATCH_ID = String(
  PAYLOAD.damageBatchId ??
  PAYLOAD?.meta?.damageBatchId ??
  ACTION_CONTEXT?.damageBatchId ??
  ACTION_CONTEXT?.meta?.damageBatchId ??
  ""
).trim();

// BattleLog batching.
// Uses the same ID as Damage Card batching so miss logs flush together with
// the final grouped Damage Card.
const BATTLE_LOG_BATCH_ID = String(
  PAYLOAD.battleLogBatchId ??
  PAYLOAD.damageBatchId ??
  PAYLOAD?.meta?.battleLogBatchId ??
  PAYLOAD?.meta?.damageBatchId ??
  ACTION_CONTEXT?.battleLogBatchId ??
  ACTION_CONTEXT?.damageBatchId ??
  ACTION_CONTEXT?.meta?.battleLogBatchId ??
  ACTION_CONTEXT?.meta?.damageBatchId ??
  ""
).trim();

function getBattleLogBatchApi() {
  return (
    globalThis.FUCompanion?.api?.battleLogBatch ??
    game.modules?.get?.("fabula-ultima-companion")?.api?.battleLogBatch ??
    null
  );
}

// ---- Resolve targets (set by Create Action Card before calling this macro) ----
const foundryTargets = Array.from(game.user?.targets ?? []);
const selectedTokens = canvas.tokens?.controlled ?? [];
const tokens = (foundryTargets.length ? foundryTargets : selectedTokens);

if (!tokens.length) { ui.notifications.error("Select/target token(s) before applying Miss."); return; }

// Step 4 optimization: yield between multi-target miss cards.
// This prevents multi-target miss results from creating/capturing all cards
// in one uninterrupted browser frame.
const MISS_TARGET_LOOP_YIELD_ENABLED = true;
const MISS_TARGET_LOOP_YIELD_MIN_TARGETS = 2;
const MISS_TARGET_LOOP_YIELD_EVERY = 1;

function waitAfterNextPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
      return;
    }

    setTimeout(resolve, 0);
  });
}

async function maybeYieldBetweenMissTargets({
  index = 0,
  total = 0
} = {}) {
  if (!MISS_TARGET_LOOP_YIELD_ENABLED) return;
  if (total < MISS_TARGET_LOOP_YIELD_MIN_TARGETS) return;

  const completed = Number(index) + 1;

  if (completed >= total) return;

  if (MISS_TARGET_LOOP_YIELD_EVERY > 1 && completed % MISS_TARGET_LOOP_YIELD_EVERY !== 0) {
    return;
  }

  await waitAfterNextPaint();

  console.debug("[Miss] Yielded between miss targets.", {
    completed,
    total
  });
}

// ---- 1) Battle Log -------------------------------------------------------------
const rows = [];
const entries = [];

for (const t of tokens) {
  const targetName = t.actor?.name ?? t.name ?? "Target";

  entries.push({
    ts: new Date().toISOString(),
    dealer: {
      name: attackerName,
      disposition: "?",
      range: attackRange,
      sourceType: isSpellish ? "Spell" : "Attack"
    },
    target: {
      name: targetName,
      disposition: "?"
    },
    inputs: {
      accuracy: Number.isFinite(accTotal) ? accTotal : null,
      defense: Number.isFinite(defenseUsed) ? defenseUsed : null,
      isSpell: isSpellish,
      elementType,
      weaponType: weaponTypeRaw
    },
    miss: true,
    summary: `${attackerName} misses ${targetName}`
  });

  rows.push({
    $deleted: false,
    attacker: attackerName,
    attack_target: targetName,
    value: "—",
    value_type: "HP",
    apply_mode: "Miss",
    damage_type: elementType.toUpperCase(),
    affinity: "—",
    efficiency: "—",
    weapon_type: (weaponTypeRaw && weaponTypeRaw !== "none_ef")
      ? String(weaponTypeRaw).split("_")[0].toUpperCase()
      : "—",
    range: attackRange
  });
}

try {
  if (entries.length || rows.length) {
    const battleLogBatchApi = getBattleLogBatchApi();

    if (battleLogBatchApi?.captureOrAppend) {
      const result = await battleLogBatchApi.captureOrAppend({
        batchId: BATTLE_LOG_BATCH_ID || null,
        damageBatchId: DAMAGE_BATCH_ID || null,
        entries,
        rows,
        source: "Miss",
        immediateIfNoBatch: true
      });

      if (!result?.ok) {
        console.warn("[Miss] BattleLog batch capture/append failed.", result);
      }
    } else {
      const logger = game.macros.getName(LOGGER_MACRO_NAME);

      if (!logger) {
        console.warn(`[Miss] Logger macro "${LOGGER_MACRO_NAME}" not found.`);
      } else {
        await logger.execute({
          __AUTO: true,
          __PAYLOAD: {
            entries,
            rows
          }
        });
      }
    }
  }
} catch (e) {
  console.warn("[Miss] logger failed:", e);
}

// ---- 2) FX/SFX -----------------------------------------------------------------
for (const t of tokens) {
  if (typeof Sequencer !== "undefined") {
    new Sequence()
      .effect().file("jb2a.ui.miss").attachTo(t).scaleToObject(1.0).opacity(0.9).duration(1200)
      .sound().file("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Miss.ogg").volume(0.4)
      .play();
  }
}

// ---- 3) Chat Card (delegated to Create Damage Card) ----------------------------
const createDmg = game.macros.getName(DMG_CARD_MACRO_NAME);
if (!createDmg) { console.warn(`[Miss] Macro "${DMG_CARD_MACRO_NAME}" not found.`); }

// One compact “miss” card per target (same as how damage cards are per-target)
for (let targetIndex = 0; targetIndex < tokens.length; targetIndex++) {
  const t = tokens[targetIndex];
  const targetName = t.actor?.name ?? t.name ?? "Target";
  const targetUuid = t.document?.uuid ?? "";

  if (createDmg) {
    await createDmg.execute({
      __AUTO: true,
            __PAYLOAD: {
        // Damage Card batch identity.
        // If a batch is open, Create Damage Card.js will capture this miss payload
        // instead of posting a separate Foundry ChatMessage.
        damageBatchId: DAMAGE_BATCH_ID || null,

        // ---- core identity (used by the renderer) ----
        mode: "miss",                 // << tells Create Damage Card to render MISS variant
        attackerName, attackerUuid,
        targetName,   targetUuid,
        sourceType: isSpellish ? "Spell" : "Attack",
        attackRange,
        elementType,                  // "physical" | "fire" | ...
        weaponType: weaponTypeRaw,    // "sword_ef" | "none_ef" | etc.

        // ---- display channels expected by the damage card ----
        valueType: "hp",
        displayedAmount: 0,           // no number roll-up on miss
        affected: false,              // signals no effect
        noEffectReason: "Miss",

        // Preserve upstream action context for reaction/passive systems and debugging.
        actionContext: ACTION_CONTEXT,
        actionCardMsgId: ACTION_CARD_MSG,

        // Small explicit meta object for systems that prefer payload.meta access.
        meta: {
          damageBatchId: DAMAGE_BATCH_ID || null
        },

        // (optional) show context in details if you want later
        accuracyTotal: Number.isFinite(accTotal)?accTotal:null,
        defenseUsed: Number.isFinite(defenseUsed)?defenseUsed:null
      }
        });
  }

  await maybeYieldBetweenMissTargets({
    index: targetIndex,
    total: tokens.length
  });
}
