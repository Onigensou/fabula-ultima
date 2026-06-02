// ============================================================================
// BattleInit — Battle Initialization: Step 1) Battle Prompt (Foundry VTT v12)
// ----------------------------------------------------------------------------
// New in this version:
// - Manual Enemy List uses dropdowns built from the SCENE's "Enemies Table" RollTable
//   (NOT the Encounter Table)
// - Encounter Table header changes when Manual mode is selected
// - Battle Type includes: Default / Random / Boss
//   - Boss auto-switches BGM to Boss BGM default (if set), unless user edited BGM
//
// Storage (Scene Flag):
//   scope: "world"
//   key  : "battleInit.latestPayload"
//
// Verify after running:
//   canvas.scene.getFlag("world", "battleInit.latestPayload")
// ============================================================================

(async () => {
  const DEBUG = true;

  // -----------------------------
  // Guards
  // -----------------------------
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("BattleInit: GM only.");
    return;
  }
  if (!canvas?.scene) {
    ui.notifications?.error?.("BattleInit: No active scene (canvas.scene is null).");
    return;
  }

  // -----------------------------
  // Scopes + Keys
  // -----------------------------
  const MODULE_SCOPE = "fabula-ultima-companion"; // where your Dungeon UI currently stores
  const WORLD_SCOPE  = "world";                   // fallback
  const DUNGEON_ROOT = "oniDungeon";

  // Store payload under WORLD (safe even if module disabled)
  const PAYLOAD_SCOPE = "world";
  const PAYLOAD_KEY   = "battleInit.latestPayload";

  
  // Prompt session marker (used so Manager can stop polling when user cancels/closes)
  const PROMPT_MARKER_KEY = "battleInit.promptMarker";
const log = (...args) => DEBUG && console.log("[BattleInit:BattlePrompt:Step1]", ...args);
  const scene = canvas.scene;

  // -----------------------------
  // Helpers: pick flags (module first, fallback to world)
  // -----------------------------
  function pickFlag(path) {
    const fromModule = scene.getFlag(MODULE_SCOPE, path);
    if (fromModule !== undefined && fromModule !== null && String(fromModule).trim?.() !== "") {
      return { value: fromModule, scope: MODULE_SCOPE };
    }
    const fromWorld = scene.getFlag(WORLD_SCOPE, path);
    if (fromWorld !== undefined && fromWorld !== null && String(fromWorld).trim?.() !== "") {
      return { value: fromWorld, scope: WORLD_SCOPE };
    }
    return { value: "", scope: "(missing)" };
  }

  // -----------------------------
  // Helpers: resolve UUID -> Document
  // -----------------------------
  async function safeFromUuid(uuid) {
    const u = String(uuid ?? "").trim();
    if (!u) return null;
    try {
      return await fromUuid(u);
    } catch (err) {
      console.warn("[BattleInit:BattlePrompt:Step1] fromUuid failed:", u, err);
      return null;
    }
  }

  function pickDocImage(doc) {
    if (!doc) return "icons/svg/question-mark.svg";
    if (doc.documentName === "RollTable") return doc.img || "icons/svg/d20.svg";
    if (doc.documentName === "Scene") return doc.thumb || doc.background?.src || doc.img || "icons/svg/map.svg";
    return doc.img || "icons/svg/book.svg";
  }

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // -----------------------------
  // Prompt Marker (for Manager cancel/close detection)
  // -----------------------------
  function nowIso() {
    return new Date().toISOString();
  }

  function buildPromptRunId() {
    const t = Date.now();
    const r = Math.random().toString(36).slice(2, 8);
    return `bi_prompt_${t}_${r}`;
  }

  async function writePromptMarker(status, extra = {}) {
    const marker = {
      status: String(status ?? "missing"),
      at: nowIso(),
      ...extra
    };
    await scene.setFlag(PAYLOAD_SCOPE, PROMPT_MARKER_KEY, marker);
    return marker;
  }

  // Preview row (image + name) that we can update live
    // Preview row (image + name) that we can update live
  function renderPreviewRow({ kind, label, doc, uuid, emptyText }) {
    const name = doc?.name || (uuid ? uuid : emptyText);
    const img  = uuid ? pickDocImage(doc) : "icons/svg/cancel.svg";

    return `
      <div style="display:flex; gap:10px; align-items:flex-start; margin-top:6px;">
        <img data-bi-img="${kind}" src="${esc(img)}"
             style="width:34px; height:34px; border-radius:6px; border:1px solid var(--color-border-light-primary); object-fit:cover;" />
        <div style="flex:1;">
          <div style="font-weight:900;" data-bi-label="${kind}">${esc(label)}</div>
          <div data-bi-name="${kind}" style="font-size:13px; opacity:0.95; line-height:1.25; word-break:break-word;">
            ${uuid ? esc(name) : `<i>${esc(emptyText)}</i>`}
          </div>
          <div data-bi-meta="${kind}" style="font-size:12px; opacity:0.75; margin-top:2px;">
            ${uuid ? "UUID is set" : "No UUID set"}
          </div>
        </div>
      </div>
    `;
  }

  // Read-only Party list UI (4 slots)
  function renderPartyList({ partyMembers, partyMissing, partyGameName }) {
    const bySlot = new Map((partyMembers ?? []).map(m => [Number(m.slot), m]));
    const missingBySlot = new Map((partyMissing ?? []).map(m => [Number(m.slot), m]));

    const rows = [];
    for (let slot = 1; slot <= 4; slot++) {
      const m = bySlot.get(slot);
      const miss = missingBySlot.get(slot);

      if (m) {
        rows.push(`
          <div style="display:flex; gap:10px; align-items:center; padding:6px 8px; border:1px solid var(--color-border-light-primary); border-radius:10px;">
            <img src="${esc(m.img || "icons/svg/mystery-man.svg")}"
                 style="width:34px; height:34px; border-radius:8px; border:1px solid var(--color-border-light-primary); object-fit:cover;" />
            <div style="flex:1;">
              <div style="font-weight:900;">Slot ${slot}</div>
              <div style="font-size:13px; opacity:0.95;">${esc(m.name || "(unnamed)")}</div>
              <div style="font-size:12px; opacity:0.75;">Resolved</div>
            </div>
          </div>
        `);
      } else {
        const detail = miss?.raw
          ? `Unresolved: ${esc(miss.raw)}`
          : "(empty)";
        rows.push(`
          <div style="display:flex; gap:10px; align-items:center; padding:6px 8px; border:1px solid var(--color-border-light-primary); border-radius:10px; opacity:0.9;">
            <img src="icons/svg/question-mark.svg"
                 style="width:34px; height:34px; border-radius:8px; border:1px solid var(--color-border-light-primary); object-fit:cover;" />
            <div style="flex:1;">
              <div style="font-weight:900;">Slot ${slot}</div>
              <div style="font-size:13px; opacity:0.95;"><i>${detail}</i></div>
              <div style="font-size:12px; opacity:0.75;">Not ready</div>
            </div>
          </div>
        `);
      }
    }

    return `
      <div style="margin-top:8px;">
        <div style="font-size:12px; opacity:0.8;">
          Read-only: pulled from Global DB (${esc(partyGameName || "Current Game")}) → system.props.member_id_1..member_id_4
        </div>
        <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          ${rows.join("")}
        </div>
      </div>
    `;
  }

  // -----------------------------
  // Read defaults from Scene "Dungeon Configuration" flags
  // -----------------------------
  const encounterTablePick = pickFlag(`${DUNGEON_ROOT}.encounterTable`); // groups / encounter roll
  const enemiesTablePick   = pickFlag(`${DUNGEON_ROOT}.enemiesTable`);   // all possible enemies (for manual dropdown)
  const battleMapPick      = pickFlag(`${DUNGEON_ROOT}.battleMap`);
  const battleBGMPick      = pickFlag(`${DUNGEON_ROOT}.battleBGM`);
  const bossBGMPick        = pickFlag(`${DUNGEON_ROOT}.bossBGM`);

  const encounterTableUuidDefault = String(encounterTablePick.value || "");
  const enemiesTableUuidDefault   = String(enemiesTablePick.value || "");
  const battleSceneUuidDefault    = String(battleMapPick.value || "");
  const battleBGMDefault          = String(battleBGMPick.value || "");
  const bossBGMDefault            = String(bossBGMPick.value || "");

  const encounterTableDocDefault = await safeFromUuid(encounterTableUuidDefault);
  const enemiesTableDocDefault   = await safeFromUuid(enemiesTableUuidDefault);
  const battleSceneDocDefault    = await safeFromUuid(battleSceneUuidDefault);

  log("Defaults:", {
    encounterTableUuidDefault,
    enemiesTableUuidDefault,
    battleSceneUuidDefault,
    battleBGMDefault,
    bossBGMDefault
  });

  // -----------------------------
  // Build monster dropdown list from Enemies Table (NOT Encounter Table)
  // -----------------------------
  function buildMonsterListFromEnemiesTable(rt) {
    // Expect RollTable document
    const set = new Set();

    const results = rt?.results?.contents ?? [];
    for (const r of results) {
      const name = String(r?.text ?? "").trim();
      if (!name) continue;
      set.add(name);
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  const enemiesTableMonsterList = enemiesTableDocDefault?.documentName === "RollTable"
    ? buildMonsterListFromEnemiesTable(enemiesTableDocDefault)
    : [];

  // Build HTML for options
  function buildMonsterOptionsHtml(list) {
    if (!list.length) {
      return `<option value="" selected>(No Enemies Table / No entries)</option>`;
    }
    return [
      `<option value="" selected>(Empty)</option>`,
      ...list.map(name => `<option value="${esc(name)}">${esc(name)}</option>`)
    ].join("");
  }

  const monsterOptionsHtml = buildMonsterOptionsHtml(enemiesTableMonsterList);

  // -----------------------------
  // UI Definitions
  // -----------------------------
const DEFAULT_FORMATION_PRESET = "party_line__enemy_rows"; // hidden backend

// Pull default random battle % from your resolved game DB (token-override 'source' preferred)
const FALLBACK_RANDOM_CHANCE = 35;

// Pull default random battle % from your resolved game DB (token-override 'source' preferred)
async function getDbRandomBattleChanceOrNull() {
  const api = window.FUCompanion?.api;
  if (!api?.getCurrentGameDb) return null;

  const { source, db } = await api.getCurrentGameDb();
  const raw =
    source?.system?.props?.random_battle_percentage ??
    db?.system?.props?.random_battle_percentage;

  if (raw === undefined || raw === null || String(raw).trim() === "") return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;

  // clamp to 0..100 (percentage)
  return Math.max(0, Math.min(100, n));
}

// Resolve Actor from "Actor.<id>", raw id, or Compendium uuid
async function resolveActorRef(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // UUID form
  if (/^(Actor|Compendium)\./i.test(s)) {
    const doc = await safeFromUuid(s);
    return (doc?.documentName === "Actor") ? doc : null;
  }

  // Raw actor id in world
  const a1 = game.actors?.get?.(s);
  if (a1) return a1;

  // Try Actor.<id>
  const doc = await safeFromUuid(`Actor.${s}`);
  return (doc?.documentName === "Actor") ? doc : null;
}

// Pull party members from DB: system.props.member_id_1..member_id_4
async function getDbPartyMembersOrEmpty() {
  const api = window.FUCompanion?.api;
  if (!api?.getCurrentGameDb) {
    return { gameName: null, members: [], missing: [], resolvedAt: new Date().toISOString() };
  }

  const { source, db, gameName } = await api.getCurrentGameDb();

  const memberRaw = [];
  for (let i = 1; i <= 4; i++) {
    const k = `member_id_${i}`;
    const v =
      source?.system?.props?.[k] ??
      db?.system?.props?.[k] ??
      "";
    memberRaw.push({ slot: i, key: k, raw: String(v ?? "").trim() });
  }

  const members = [];
  const missing = [];

  for (const row of memberRaw) {
    if (!row.raw) {
      missing.push({ slot: row.slot, key: row.key, raw: "" });
      continue;
    }

    const actor = await resolveActorRef(row.raw);
    if (!actor) {
      missing.push({ slot: row.slot, key: row.key, raw: row.raw });
      continue;
    }

    members.push({
      slot: row.slot,
      actorUuid: actor.uuid,
      actorId: actor.id,
      name: actor.name,
      img: actor.img ?? null
    });
  }

  return {
    gameName: gameName ?? null,
    members,
    missing,
    resolvedAt: new Date().toISOString()
  };
}

const DB_RANDOM_CHANCE = await getDbRandomBattleChanceOrNull();
const DEFAULT_RANDOM_CHANCE = (DB_RANDOM_CHANCE ?? FALLBACK_RANDOM_CHANCE);

const PARTY_DB = await getDbPartyMembersOrEmpty();
const PARTY_MEMBERS_DEFAULT = PARTY_DB.members;
const PARTY_MISSING_DEFAULT = PARTY_DB.missing;

log("Party Defaults (DB):", {
  gameName: PARTY_DB.gameName,
  members: PARTY_MEMBERS_DEFAULT,
  missing: PARTY_MISSING_DEFAULT
});

  const BATTLE_TYPES = [
    { id: "default", label: "Default Battle" },
    { id: "random",  label: "Random Battle" },
    { id: "boss",    label: "Boss Battle" }
  ];

  const ENEMY_SETTINGS = [
  { id: "rollRevealTable", label: "Roll Encounter Table", hint: "Uses Battle Configuration: Encounter Table" },
  { id: "manual",          label: "Manual List",          hint: "Paste Actor UUIDs (one per line). Each line = 1 enemy." }
];

  // Initial BGM prefill
  const initialBattleType = "default";
  const initialBgmValue = battleBGMDefault || "";

  // -----------------------------
  // Dialog HTML
  // -----------------------------
  const content = `
  <form class="battleinit-battleprompt" style="display:flex; flex-direction:column; gap:12px;">

    <div style="padding:10px 12px; border:1px solid var(--color-border-light-primary); border-radius:10px;">
      <div style="font-weight:900; margin-bottom:6px;">Battle Configuration</div>

      <!-- Encounter Table -->
      <div style="padding:8px 10px; border:1px solid var(--color-border-light-primary); border-radius:10px; margin-top:8px;">
        ${renderPreviewRow({
          kind: "encounter",
          label: "Encounter Table",
          doc: encounterTableDocDefault,
          uuid: encounterTableUuidDefault,
          emptyText: "(empty)"
        })}

        <div data-bi-encounter-hint style="font-size:12px; opacity:0.8; margin-top:6px;">
          Used when Enemy Setting = Roll Encounter Table.
        </div>

        <div style="margin-top:8px;">
          <input type="text"
                 name="encounterTableUuid"
                 value="${esc(encounterTableUuidDefault)}"
                 placeholder="RollTable UUID (e.g. RollTable.xxxxx)"
                 style="width:100%;"
                 data-bi-input="encounter" />
          <div style="font-size:12px; opacity:0.8; margin-top:4px;">
            Pre-filled from Scene config. Paste a new RollTable UUID to override.
          </div>
        </div>
      </div>

      <!-- Battle Map Scene -->
      <div style="padding:8px 10px; border:1px solid var(--color-border-light-primary); border-radius:10px; margin-top:10px;">
        ${renderPreviewRow({
          kind: "battleScene",
          label: "Battle Map Scene",
          doc: battleSceneDocDefault,
          uuid: battleSceneUuidDefault,
          emptyText: "(empty)"
        })}
        <div style="margin-top:8px;">
          <input type="text"
                 name="battleSceneUuid"
                 value="${esc(battleSceneUuidDefault)}"
                 placeholder="Scene UUID (e.g. Scene.xxxxx)"
                 style="width:100%;"
                 data-bi-input="battleScene" />
          <div style="font-size:12px; opacity:0.8; margin-top:4px;">
            Pre-filled from Scene config. Paste a new Scene UUID to override.
          </div>
        </div>
      </div>

            <!-- BGM (single field) -->
      <div style="padding:8px 10px; border:1px solid var(--color-border-light-primary); border-radius:10px; margin-top:10px;">
        <div style="font-weight:900;">BGM</div>
        <div style="font-size:12px; opacity:0.8; margin-top:2px;">
          The BGM we’ll use for this battle.
        </div>

        <div style="margin-top:8px;">
          <input type="text"
                 name="bgm"
                 value="${esc(initialBgmValue)}"
                 placeholder="Sound name (string)"
                 style="width:100%;"
                 data-bi-bgm />
          <div data-bi-bgmhint style="font-size:12px; opacity:0.8; margin-top:4px;">
            Default/Random: uses Battle BGM from Scene (unless you override).
          </div>
        </div>
      </div>

      <!-- Party Members (read-only) -->
      <div style="padding:8px 10px; border:1px solid var(--color-border-light-primary); border-radius:10px; margin-top:10px;">
        <div style="font-weight:900;">Party Members</div>
        ${renderPartyList({
          partyMembers: PARTY_MEMBERS_DEFAULT,
          partyMissing: PARTY_MISSING_DEFAULT,
          partyGameName: PARTY_DB.gameName
        })}
      </div>

      <!-- Info: Enemies Table (used for Manual dropdown) -->
      <details style="margin-top:10px;">
        <summary style="cursor:pointer; font-weight:800;">Advanced: Manual List Source (Enemies Table)</summary>
        <div style="margin-top:8px; font-size:12px; opacity:0.85; line-height:1.35;">
          <div><b>Enemies Table UUID:</b> ${enemiesTableUuidDefault || "<i>(empty)</i>"}</div>
          <div><b>Enemies Table Name:</b> ${esc(enemiesTableDocDefault?.name || "(missing)")}</div>
          <div><b>Entries loaded:</b> ${enemiesTableMonsterList.length}</div>
        </div>
      </details>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
      <div>
        <label style="font-weight:900;">Battle Type</label>
        <select name="battleType" style="width:100%;" data-bi-battletype>
          ${BATTLE_TYPES.map(b => `<option value="${b.id}" ${b.id === initialBattleType ? "selected" : ""}>${esc(b.label)}</option>`).join("")}
        </select>

        <div data-bi-randomblock style="margin-top:8px; display:none;">
          <label style="font-weight:800;">Random Battle Chance (%)</label>
          <input type="number" name="randomChance" value="${DEFAULT_RANDOM_CHANCE}" min="0" max="100" step="1" style="width:100%;" />
          <div style="font-size:12px; opacity:0.8; margin-top:4px;">
            Step 2 will roll this chance to decide if battle happens.
          </div>
        </div>
      </div>

      <div>
        <label style="font-weight:900;">Enemy Setting</label>
        <select name="enemySetting" style="width:100%;" data-bi-enemysetting>
          ${ENEMY_SETTINGS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join("")}
        </select>
        <div style="font-size:12px; opacity:0.8; margin-top:4px;">
          Roll uses Encounter Table above. Manual uses the Enemies Table dropdown list.
        </div>
      </div>
    </div>

   <!-- Manual List UI: 5 slots (each slot = 1 enemy) -->
<div data-bi-manualblock style="display:none; padding:10px 12px; border:1px solid var(--color-border-light-primary); border-radius:10px;">
  <div style="font-weight:900; margin-bottom:6px;">Manual Enemy List</div>
  <div style="font-size:12px; opacity:0.8; margin-bottom:10px;">
    Pick up to 5 enemies from the Enemies Table list (Scene Dungeon Config). Each slot represents 1 enemy.
  </div>

  ${Array.from({ length: 5 }, (_, i) => {
    const idx = i + 1;
    return `
      <div style="margin-top:${i === 0 ? 0 : 8}px;">
        <label style="font-weight:800;">Slot ${idx}</label>
        <select name="manualSlot${idx}" style="width:100%;">
          ${monsterOptionsHtml}
        </select>
      </div>
    `;
  }).join("")}

  <div style="font-size:12px; opacity:0.8; margin-top:10px;">
    Step 3 will validate/resolve these into real Actors/Tokens. Step 1 stores your picks.
  </div>
</div>

        <details>
      <summary style="cursor:pointer; font-weight:900;">Options</summary>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;">
        <div>
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="debugEnabled" checked />
            Debug trace (recommended while building)
          </label>
        </div>

        <div>
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="optClearBattleLog" checked />
            Clear Battle Log
          </label>
          <div style="font-size:12px; opacity:0.8; margin:2px 0 8px 26px;">
            Runs FUCompanion.api.clearBattleLog() before creating the payload.
          </div>

          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="optAutoStartCombat" checked />
            Auto-create & start Combat (Step 6)
          </label>
          <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <input type="checkbox" name="optRunUnleash" checked />
            Run Unleash Detector (Step 7)
          </label>
          <label style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <input type="checkbox" name="optAnimations" checked />
            Play spawn animations (Step 5b)
          </label>
        </div>
      </div>
    </details>

  </form>
  `;

  // -----------------------------
  // Build payload from form
  // -----------------------------
  function readManualSlots(fd) {
  const picks = [];
  for (let i = 1; i <= 5; i++) {
    const name = String(fd.get(`manualSlot${i}`) ?? "").trim();
    if (!name) continue;

    // Each slot is exactly 1 enemy
    const actor = game.actors?.getName?.(name) ?? null;
    picks.push({
      name,
      quantity: 1,
      actorUuid: actor?.uuid || null
    });
  }
  return picks;
}

    async function buildAndStorePayload(html) {
    const form = html[0].querySelector("form.battleinit-battleprompt");
    const fd = new FormData(form);

    const encounterTableUuid = String(fd.get("encounterTableUuid") ?? "").trim();
    const battleSceneUuid    = String(fd.get("battleSceneUuid") ?? "").trim();

    const battleType = String(fd.get("battleType") ?? "default");

// If the field is blank, use DB default; otherwise use the user's override.
const rawRandomChance = String(fd.get("randomChance") ?? "").trim();
const parsedRandomChance = (rawRandomChance === "") ? DEFAULT_RANDOM_CHANCE : Number(rawRandomChance);
const randomChance = Math.max(0, Math.min(100, Number.isFinite(parsedRandomChance) ? parsedRandomChance : DEFAULT_RANDOM_CHANCE));


    const isBoss = (battleType === "boss");

    const enemySettingRaw = String(fd.get("enemySetting") ?? "rollEncounterTable");
    const enemySetting = isBoss ? "manual" : enemySettingRaw;

    const bgm = String(fd.get("bgm") ?? "").trim();

    const debugEnabled = Boolean(fd.get("debugEnabled"));

    const manualPicks = readManualSlots(fd);

    const optClearBattleLog = Boolean(fd.get("optClearBattleLog"));
    const optAutoStartCombat = Boolean(fd.get("optAutoStartCombat"));
    const optRunUnleash      = Boolean(fd.get("optRunUnleash"));
    const optAnimations      = Boolean(fd.get("optAnimations"));

    // If enabled, clear battle log NOW (before payload is created)
    let clearBattleLogReport = null;
    if (optClearBattleLog) {
      const fn = window.FUCompanion?.api?.clearBattleLog;
      if (typeof fn !== "function") {
        clearBattleLogReport = { ok: false, reason: "FUCompanion.api.clearBattleLog() is missing (module not loaded?)" };
        console.warn("[BattleInit:BattlePrompt:Step1] Clear Battle Log requested, but API is missing.");
        ui.notifications?.warn?.("BattleInit: Clear Battle Log is enabled, but clearBattleLog() API is missing.");
      } else {
        try {
          clearBattleLogReport = await fn({ notify: true });
        } catch (err) {
          clearBattleLogReport = { ok: false, reason: String(err?.message ?? err) };
          console.warn("[BattleInit:BattlePrompt:Step1] clearBattleLog() failed:", err);
          ui.notifications?.warn?.("BattleInit: Clear Battle Log failed (see console).");
        }
      }
    }

    const battleId = foundry.utils.randomID(16);
    const nowIso = new Date().toISOString();

    const payload = {
      meta: {
        schemaVersion: 1,
        battleId,
        createdAt: nowIso,
        debug: { enabled: debugEnabled, trace: [] }
      },
      context: {
        sourceSceneUuid: scene.uuid,
        sourceSceneId: scene.id,
        sourceSceneName: scene.name,
        battleSceneUuid: battleSceneUuid,
        return: { enabled: true }
      },
      battleConfig: {
        encounterTableUuid: encounterTableUuid,
        enemiesTableUuid: enemiesTableUuidDefault,
        battleSceneUuid: battleSceneUuid,
        bgm: bgm
      },
      battleConfigDefaults: {
        encounterTableUuidDefault,
        enemiesTableUuidDefault,
        battleSceneUuidDefault,
        battleBgmDefault: battleBGMDefault,
        bossBgmDefault: bossBGMDefault
      },
            party: {
        mode: "dbPartyMembers",
        source: {
          gameName: PARTY_DB.gameName ?? null,
          resolvedAt: PARTY_DB.resolvedAt ?? nowIso
        },
        members: Array.isArray(PARTY_MEMBERS_DEFAULT) ? PARTY_MEMBERS_DEFAULT : [],
        missing: Array.isArray(PARTY_MISSING_DEFAULT) ? PARTY_MISSING_DEFAULT : []
      },
      battlePlan: {
        type: battleType,                 // "default" | "random" | "boss"
        randomChancePercent: randomChance,
        isBoss
      },
      encounterPlan: {
        mode: enemySetting,               // "rollEncounterTable" | "manual"
        difficultyTag: isBoss ? "boss" : null,
        isBoss,
        // Manual picks now come from dropdowns (name + qty + optional actorUuid)
        manualPicks: manualPicks,
        roll: {}
      },
      encounterResolved: { enemies: [] },
      options: {
        battleLog: {
          clearOnCreate: optClearBattleLog,
          report: clearBattleLogReport
        },
        animations: { enabled: optAnimations },
        combat: { autoStart: optAutoStartCombat },
        unleash: { enabled: optRunUnleash }
      },
      layout: {
        preset: "party_line__enemy_rows",
        spawnZones: {},
        placements: {}
      },
      spawnResult: {
        partyTokenIds: [],
        enemyTokenIds: [],
        tokenIdByActorUuid: {}
      },
      combat: {
        combatId: null,
        combatUuid: null,
        started: false
      },
      unleash: {
        checked: false,
        triggers: []
      },
      rewards: {
        exp: { total: 0, byEnemy: [] },
        notes: []
      },
      phases: {
        prompt: { status: "ok", at: nowIso }
      }
    };

    if (payload.meta?.debug?.enabled) {
      payload.meta.debug.trace.push({
        phase: "prompt",
        at: nowIso,
        note: "Created initial BattlePayload from GM prompt."
      });

      if (optClearBattleLog) {
        payload.meta.debug.trace.push({
          phase: "prompt",
          at: nowIso,
          note: `Clear Battle Log: ${clearBattleLogReport?.ok ? "ok" : "failed"}`
        });
      }
    }

    log("Payload created:", payload);

    await scene.setFlag(PAYLOAD_SCOPE, PAYLOAD_KEY, payload);
    window.__BATTLEINIT_PAYLOAD_LATEST = payload;

        return payload;
  }

  // -----------------------------
  // Open Dialog + wire behaviors
  // -----------------------------

  // -----------------------------
  // Create a "prompt session marker" so BattleInit Manager can detect:
  // - GM confirmed (ok)
  // - GM cancelled / closed the window (cancelled)
  // This avoids infinite polling when payload was never created.
  // -----------------------------
  const promptRunId = buildPromptRunId();
  let promptResult = "none"; // "none" | "ok" | "cancelled" | "blocked"

  await writePromptMarker("running", {
    runId: promptRunId,
    sceneId: scene.id,
    sceneName: scene.name
  });

  const dlg = new Dialog({
    title: "BattleInit — Battle Prompt (Step 1)",
    content,
    buttons: {
      create: {
        icon: '<i class="fas fa-swords"></i>',
        label: "Create Payload",
        callback: async (html) => {
          promptResult = "confirming";

          try {
            const payload = await buildAndStorePayload(html);
            const battleId = String(payload?.meta?.battleId ?? "");

            promptResult = "ok";
            await writePromptMarker("ok", {
              runId: promptRunId,
              battleId
            });

          } catch (err) {
            promptResult = "blocked";
            console.error("[BattleInit:BattlePrompt:Step1] Failed to build/store payload:", err);
            ui.notifications?.error?.("BattleInit: Failed. Check console for details.");

            await writePromptMarker("blocked", {
              runId: promptRunId,
              error: String(err?.message ?? err)
            });
          }
        }
      },
      cancel: {
        icon: '<i class="fas fa-times"></i>',
        label: "Cancel",
        callback: async () => {
          promptResult = "cancelled";
          await writePromptMarker("cancelled", { runId: promptRunId });
        }
      }
    },
    default: "create",
    close: async () => {
      // Covers the "X" close button.
      if (promptResult === "none") {
        promptResult = "cancelled";
        try {
          await writePromptMarker("cancelled", { runId: promptRunId, via: "close-x" });
        } catch (_) {}
      }
    }
  });

  Hooks.once("renderDialog", (app, html) => {
    if (app !== dlg) return;

    const root = html[0];

    // Controls
    const battleTypeSel   = root.querySelector("[data-bi-battletype]");
    const enemySettingSel = root.querySelector("[data-bi-enemysetting]");
    const randomBlock     = root.querySelector("[data-bi-randomblock]");
    const manualBlock     = root.querySelector("[data-bi-manualblock]");

    // Encounter header swapping
    const encounterLabelEl = root.querySelector(`[data-bi-label="encounter"]`);
    const encounterHintEl  = root.querySelector(`[data-bi-encounter-hint]`);

    // BGM
    const bgmInput = root.querySelector("[data-bi-bgm]");
    const bgmHint  = root.querySelector("[data-bi-bgmhint]");

    // Track if user manually edited BGM (so we don't overwrite their override)
    let bgmTouched = false;

    // Live preview update when user edits UUID inputs
    async function updatePreview(kind, uuid) {
      const imgEl  = root.querySelector(`[data-bi-img="${kind}"]`);
      const nameEl = root.querySelector(`[data-bi-name="${kind}"]`);
      const metaEl = root.querySelector(`[data-bi-meta="${kind}"]`);

      const u = String(uuid ?? "").trim();
      if (!u) {
        if (imgEl) imgEl.src = "icons/svg/cancel.svg";
        if (nameEl) nameEl.innerHTML = "<i>(empty)</i>";
        if (metaEl) metaEl.textContent = "No UUID set";
        return;
      }

      const doc = await safeFromUuid(u);
      if (!doc) {
        if (imgEl) imgEl.src = "icons/svg/hazard.svg";
        if (nameEl) nameEl.textContent = u;
        if (metaEl) metaEl.textContent = "UUID not found (check paste)";
        return;
      }

      if (imgEl) imgEl.src = pickDocImage(doc);
      if (nameEl) nameEl.textContent = doc.name || u;
      if (metaEl) metaEl.textContent = `${doc.documentName} resolved`;
    }

    const encounterInput   = root.querySelector(`[data-bi-input="encounter"]`);
    const battleSceneInput = root.querySelector(`[data-bi-input="battleScene"]`);

    const wireUuidPreview = (inputEl, kind) => {
      if (!inputEl) return;
      inputEl.addEventListener("blur", () => updatePreview(kind, inputEl.value));
      inputEl.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          updatePreview(kind, inputEl.value);
        }
      });
    };

    wireUuidPreview(encounterInput, "encounter");
    wireUuidPreview(battleSceneInput, "battleScene");

        function enforceBossEnemySettingLock() {
      const bt = String(battleTypeSel?.value ?? "default");
      if (!enemySettingSel) return;

      if (bt === "boss") {
        if (enemySettingSel.value !== "manual") enemySettingSel.value = "manual";
        enemySettingSel.disabled = true;
        enemySettingSel.title = "Boss Battle locks Enemy Setting to Manual List.";
      } else {
        enemySettingSel.disabled = false;
        enemySettingSel.title = "";
      }
    }

    function syncVisibility() {
      const bt = String(battleTypeSel?.value ?? "default");

      // Boss Battle forces manual, so we enforce BEFORE reading enemySetting value
      enforceBossEnemySettingLock();

      const es = String(enemySettingSel?.value ?? "rollEncounterTable");

      if (randomBlock) randomBlock.style.display = (bt === "random") ? "" : "none";
      if (manualBlock) manualBlock.style.display = (es === "manual") ? "" : "none";
    }

    function syncEncounterHeader() {
      const es = String(enemySettingSel?.value ?? "rollEncounterTable");
      if (!encounterLabelEl) return;

      if (es === "manual") {
        encounterLabelEl.textContent = "Encounter Source: Manual List";
        if (encounterHintEl) {
          encounterHintEl.textContent = "Manual List selected — Encounter Table will NOT be used for this battle.";
        }
      } else {
        encounterLabelEl.textContent = "Encounter Table";
        if (encounterHintEl) {
          encounterHintEl.textContent = "Used when Enemy Setting = Roll Encounter Table.";
        }
      }
    }

    function syncBgmAutoSwitch() {
      const bt = String(battleTypeSel?.value ?? "default");

      // Update hint text always
      if (bgmHint) {
        if (bt === "boss") {
          bgmHint.textContent = bossBGMDefault
            ? "Boss Battle: auto-uses Boss BGM from Scene (unless you override)."
            : "Boss Battle: no Boss BGM set in Scene, so BGM will stay as-is unless you type one.";
        } else {
          bgmHint.textContent = battleBGMDefault
            ? "Default/Random: auto-uses Battle BGM from Scene (unless you override)."
            : "Default/Random: no Battle BGM set in Scene. Type one if you want music.";
        }
      }

      // Only auto-switch if user has NOT edited BGM manually
      if (bgmTouched) return;
      if (!bgmInput) return;

      if (bt === "boss") {
        if (bossBGMDefault) bgmInput.value = bossBGMDefault;
      } else {
        if (battleBGMDefault) bgmInput.value = battleBGMDefault;
        else bgmInput.value = "";
      }
    }

        // Wiring
    battleTypeSel?.addEventListener("change", () => {
      syncVisibility();
      syncEncounterHeader(); // Boss forces Manual, so header must update too
      syncBgmAutoSwitch();
    });

    enemySettingSel?.addEventListener("change", () => {
      syncVisibility();
      syncEncounterHeader();
    });

    bgmInput?.addEventListener("input", () => {
      bgmTouched = true;
    });

    // Initial sync (on open)
    syncVisibility();
    syncEncounterHeader();
    syncBgmAutoSwitch();
  });

  dlg.render(true);

})();
