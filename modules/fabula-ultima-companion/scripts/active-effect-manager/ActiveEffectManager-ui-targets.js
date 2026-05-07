// ============================================================================
// ActiveEffectManager-ui-targets.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Target helper module for the modular Active Effect Manager UI.
// - Owns only:
//     1. selected canvas token target loading
//     2. party DB target loading
//     3. token/actor image resolving
//     4. video image support for animated .webm/.mp4 token art
//     5. target row merging / selection syncing
//
// Public API:
//   FUCompanion.api.activeEffectManager.uiParts.targets.reloadTargets(state)
//   FUCompanion.api.activeEffectManager.uiParts.targets.loadAvailableTargets()
//   FUCompanion.api.activeEffectManager.uiParts.targets.loadSelectedTokenTargets()
//   FUCompanion.api.activeEffectManager.uiParts.targets.loadPartyMemberTargets()
//   FUCompanion.api.activeEffectManager.uiParts.targets.targetIconMediaHtml(row)
//
// Load order:
// - Load after ActiveEffectManager-ui-state.js.
// - Load before ActiveEffectManager-ui-core.js.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI:Targets]";
  const DEBUG = true;

  const FALLBACK_IMG = "icons/svg/mystery-man.svg";

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // Namespace helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};

    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function ensureUiPartsRoot() {
    const root = ensureApiRoot();
    root.uiParts = root.uiParts || {};
    return root.uiParts;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    const parts = ensureUiPartsRoot();

    parts.targets = api;

    // Friendly aliases for console testing.
    root.uiTargets = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.uiParts =
          mod.api.activeEffectManager.uiParts || {};

        mod.api.activeEffectManager.uiParts.targets = api;
        mod.api.activeEffectManager.uiTargets = api;
      }
    } catch (e) {
      warn("Could not expose targets API on module object.", e);
    }
  }

  function getStateApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager?.uiParts?.state ?? null;
  }

  function getDbResolverApi() {
    return (
      globalThis.FUCompanion?.api?.getCurrentGameDb ??
      game.modules?.get?.(MODULE_ID)?.api?.getCurrentGameDb ??
      null
    );
  }

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------

  function clone(value, fallback = null) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}

    try {
      return structuredClone(value);
    } catch (_e) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}

    return fallback;
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function randomId(prefix = "aem") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  // --------------------------------------------------------------------------
  // Actor resolving
  // --------------------------------------------------------------------------

  function normalizeActorRef(ref) {
    const raw = safeString(ref);
    if (!raw) return "";

    if (raw.startsWith("Actor.")) return raw;
    if (raw.startsWith("Scene.")) return raw;

    // Keep other valid UUID-ish values untouched.
    if (raw.includes(".")) return raw;

    return `Actor.${raw}`;
  }

  async function resolveActorFromRef(ref) {
    const uuid = normalizeActorRef(ref);
    if (!uuid) return null;

    try {
      const doc = await fromUuid(uuid);

      if (!doc) return null;
      if (doc.documentName === "Actor") return doc;
      if (doc.actor) return doc.actor;
      if (doc.object?.actor) return doc.object.actor;
      if (doc.document?.actor) return doc.document.actor;

      return null;
    } catch (_e) {
      return null;
    }
  }

  function actorImg(actor, fallback = FALLBACK_IMG) {
    return (
      actor?.img ??
      actor?.prototypeToken?.texture?.src ??
      actor?.token?.texture?.src ??
      fallback
    );
  }

  // --------------------------------------------------------------------------
  // Token image / video helpers
  // --------------------------------------------------------------------------

  function isVideoSrc(src) {
    return /\.(webm|mp4|m4v|ogv|ogg)(\?|#|$)/i.test(String(src ?? ""));
  }

  function targetIconMediaHtml(row = {}) {
    const src = row.img || FALLBACK_IMG;
    const safeSrc = escapeHtml(src);
    const safeName = escapeHtml(row.actorName || "Target");

    if (isVideoSrc(src)) {
      return `
        <video
          class="aem-target-img aem-target-video"
          src="${safeSrc}"
          title="${safeName}"
          autoplay
          muted
          loop
          playsinline
          preload="auto"
        ></video>
      `;
    }

    return `
      <img
        class="aem-target-img aem-target-image"
        src="${safeSrc}"
        title="${safeName}"
        alt=""
        draggable="false"
      >
    `;
  }

  function tokenTextureImg(token, fallback = FALLBACK_IMG) {
    return (
      token?.document?.texture?.src ??
      token?.texture?.src ??
      token?.mesh?.texture?.baseTexture?.resource?.url ??
      fallback
    );
  }

  function findSceneTokenForActor(actor) {
    if (!actor) return null;

    const tokens = Array.from(canvas?.tokens?.placeables ?? []);

    return (
      tokens.find(t => t?.actor?.uuid && t.actor.uuid === actor.uuid) ??
      tokens.find(t => t?.document?.actorId && t.document.actorId === actor.id) ??
      null
    );
  }

  function actorTokenImg(actor, fallback = FALLBACK_IMG) {
    const sceneToken = findSceneTokenForActor(actor);

    return tokenTextureImg(
      sceneToken,
      actor?.prototypeToken?.texture?.src ??
      actor?.token?.texture?.src ??
      actorImg(actor, fallback)
    );
  }

  function selectedCanvasTokens() {
    return Array.from(canvas?.tokens?.controlled ?? [])
      .filter(token => token?.actor);
  }

  function getSelectedTokenActorUuids() {
    return Array.from(
      new Set(
        selectedCanvasTokens()
          .map(token => token.actor?.uuid)
          .filter(Boolean)
      )
    );
  }

  // --------------------------------------------------------------------------
  // Target row helpers
  // --------------------------------------------------------------------------

  function makeTargetRow({
    actor,
    actorUuid,
    actorName,
    img,
    source = "Target",
    selected = false,
    note = ""
  } = {}) {
    const uuid = actorUuid ?? actor?.uuid ?? "";
    const name = actorName ?? actor?.name ?? "Unknown Actor";

    return {
      id: uuid || randomId("target"),
      actorUuid: uuid,
      actorName: name,
      img: img ?? actorImg(actor),
      source,
      note,
      selected: !!selected
    };
  }

  function mergeTargetRows(rows = []) {
    const byUuid = new Map();

    for (const row of asArray(rows)) {
      if (!row?.actorUuid) continue;

      const existing = byUuid.get(row.actorUuid);

      if (!existing) {
        byUuid.set(row.actorUuid, { ...row });
        continue;
      }

      existing.selected = existing.selected || row.selected;
      existing.img = existing.img || row.img;
      existing.note = existing.note || row.note;

      const sourceSet = new Set(
        String(`${existing.source || ""}|${row.source || ""}`)
          .split("|")
          .map(s => s.trim())
          .filter(Boolean)
      );

      existing.source = Array.from(sourceSet).join(" • ");
    }

    return Array.from(byUuid.values());
  }

  function syncTargetRowsSelection(state) {
    const stateApi = getStateApi();

    if (typeof stateApi?.syncTargetRowsSelection === "function") {
      return stateApi.syncTargetRowsSelection(state);
    }

    if (!state) return state;

    const selected = new Set(state.targetActorUuids ?? []);

    state.targetRows = (state.targetRows ?? []).map(row => ({
      ...row,
      selected: selected.has(row.actorUuid)
    }));

    return state;
  }

  function setSelectedTargetsFromRows(state, rows = []) {
    const stateApi = getStateApi();

    if (typeof stateApi?.setSelectedTargetsFromRows === "function") {
      return stateApi.setSelectedTargetsFromRows(state, rows);
    }

    if (!state) return state;

    state.targetRows = mergeTargetRows(rows);

    state.targetActorUuids = state.targetRows
      .filter(row => row.selected)
      .map(row => row.actorUuid)
      .filter(Boolean);

    return state;
  }

  function preserveSelectionOnRows(rows = [], previousActorUuids = []) {
    const previous = new Set(asArray(previousActorUuids).filter(Boolean));

    return asArray(rows).map(row => ({
      ...row,
      selected: row.selected || previous.has(row.actorUuid)
    }));
  }

  // --------------------------------------------------------------------------
  // Target loading
  // --------------------------------------------------------------------------

  async function loadSelectedTokenTargets() {
    const tokens = selectedCanvasTokens();

    return tokens.map(token => {
      return makeTargetRow({
        actor: token.actor,
        img: tokenTextureImg(token, actorTokenImg(token.actor)),
        source: "Selected Token",
        selected: true,

        // Important for your tooltip use case:
        // this lets identical monsters show token names like A/B/C/D.
        note: token.name ?? ""
      });
    });
  }

  async function loadPartyMemberTargets() {
    const getCurrentGameDb = getDbResolverApi();
    if (typeof getCurrentGameDb !== "function") return [];

    let resolved = null;

    try {
      resolved = await getCurrentGameDb();
    } catch (e) {
      warn("DB Resolver failed.", e);
      return [];
    }

    const db = resolved?.source ?? resolved?.db ?? null;
    const props = db?.system?.props ?? {};

    if (!db) return [];

    const rows = [];

    for (let i = 1; i <= 12; i++) {
      const name = safeString(props[`member_name_${i}`]);
      const id = safeString(props[`member_id_${i}`]);
      const sprite = safeString(props[`member_sprite_${i}`]);

      if (!id && !name) continue;

      const actor = await resolveActorFromRef(id);

      if (!actor && !id) continue;

      rows.push(makeTargetRow({
        actor,
        actorUuid: actor?.uuid ?? normalizeActorRef(id),
        actorName: actor?.name ?? name,
        img: actor
          ? actorTokenImg(actor, sprite || actorImg(actor))
          : (sprite || FALLBACK_IMG),
        source: "Party Member",
        selected: false,
        note: name
      }));
    }

    return rows;
  }

  async function loadAvailableTargets(options = {}) {
    const selectedRows = options.includeSelectedTokens === false
      ? []
      : await loadSelectedTokenTargets();

    const partyRows = options.includePartyMembers === false
      ? []
      : await loadPartyMemberTargets();

    return mergeTargetRows([
      ...selectedRows,
      ...partyRows
    ]);
  }

  async function reloadTargets(state, options = {}) {
    if (!state) {
      return {
        ok: false,
        reason: "missing_state"
      };
    }

    const previousSelection = clone(state.targetActorUuids ?? [], []);

    const rows = await loadAvailableTargets(options);

    const finalRows = options.preserveExistingSelection === true
      ? preserveSelectionOnRows(rows, previousSelection)
      : rows;

    setSelectedTargetsFromRows(state, finalRows);

    state.targetSourceLabel =
      options.targetSourceLabel ??
      "Target list includes current party members and selected token actors.";

    return finalRows;
  }

  async function reloadTargetsReport(state, options = {}) {
    try {
      const rows = await reloadTargets(state, options);

      if (Array.isArray(rows)) {
        return {
          ok: true,
          count: rows.length,
          selectedCount: state?.targetActorUuids?.length ?? 0,
          rows
        };
      }

      return rows;
    } catch (e) {
      return {
        ok: false,
        reason: "reload_targets_failed",
        error: compactError(e)
      };
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    FALLBACK_IMG,

    normalizeActorRef,
    resolveActorFromRef,

    actorImg,
    isVideoSrc,
    targetIconMediaHtml,
    tokenTextureImg,
    findSceneTokenForActor,
    actorTokenImg,
    selectedCanvasTokens,
    getSelectedTokenActorUuids,

    makeTargetRow,
    mergeTargetRows,
    syncTargetRowsSelection,
    setSelectedTargetsFromRows,
    preserveSelectionOnRows,

    loadSelectedTokenTargets,
    loadPartyMemberTargets,
    loadAvailableTargets,
    reloadTargets,
    reloadTargetsReport,

    _internal: {
      clone,
      safeString,
      escapeHtml,
      asArray,
      randomId,
      compactError,
      getDbResolverApi,
      getStateApi
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager UI Targets module installed.", {
      api: "FUCompanion.api.activeEffectManager.uiParts.targets"
    });
  });
})();