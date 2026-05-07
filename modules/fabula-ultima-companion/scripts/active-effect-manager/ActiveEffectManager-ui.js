// ============================================================================
// ActiveEffectManager-ui.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Clean polished UI version:
// - Target list auto-builds on open from party DB + selected token actors.
// - Selected Effects stays badge-style.
// - Apply Options is collapsed by default and sits below Selected Effects.
// - Debug tools/output are collapsed by default at the bottom.
// - Custom Active Effect Builder opens as a separate JRPG-style dialog.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const STYLE_ID = "oni-active-effect-manager-ui-style";
  const FALLBACK_IMG = "icons/svg/mystery-man.svg";

  let ACTIVE_DIALOG = null;
  let BUILDER_DIALOG = null;

  // --------------------------------------------------------------------------
  // API helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function getManagerApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
  }

  function getRegistryApi() {
    const root = globalThis.FUCompanion?.api ?? {};
    return (
      root.activeEffectManager?.registry ??
      root.activeEffectRegistry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.registry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectRegistry ??
      null
    );
  }

  function getFieldCatalogueApi() {
    const root = globalThis.FUCompanion?.api ?? {};
    return (
      root.activeEffectManager?.fieldCatalogue ??
      root.activeEffectManager?.fieldCatalog ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalogue ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalog ??
      null
    );
  }

  function getDbResolverApi() {
    return globalThis.FUCompanion?.api?.getCurrentGameDb ?? null;
  }

  // --------------------------------------------------------------------------
  // General helpers
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

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function uniq(values) {
    return Array.from(
      new Set(
        asArray(values)
          .filter(v => v != null && String(v).trim() !== "")
          .map(String)
      )
    );
  }

  function nowIso() {
    return new Date().toISOString();
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

  function shortSource(entry = {}) {
    return [entry.sourceType, entry.sourceName].filter(Boolean).join(" • ");
  }

  function modeValue(name) {
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};
    const fallback = {
      CUSTOM: 0,
      MULTIPLY: 1,
      ADD: 2,
      DOWNGRADE: 3,
      UPGRADE: 4,
      OVERRIDE: 5
    };

    return modes[name] ?? fallback[name] ?? 0;
  }

  function modeOptionsHtml(selected = modeValue("ADD")) {
    const modes = [
      ["CUSTOM", modeValue("CUSTOM")],
      ["MULTIPLY", modeValue("MULTIPLY")],
      ["ADD", modeValue("ADD")],
      ["DOWNGRADE", modeValue("DOWNGRADE")],
      ["UPGRADE", modeValue("UPGRADE")],
      ["OVERRIDE", modeValue("OVERRIDE")]
    ];

    return modes.map(([label, value]) => {
      const sel = Number(selected) === Number(value) ? "selected" : "";
      return `<option value="${Number(value)}" ${sel}>${escapeHtml(label)} (${Number(value)})</option>`;
    }).join("");
  }

  // --------------------------------------------------------------------------
  // Target helpers
  // --------------------------------------------------------------------------

  function normalizeActorRef(ref) {
    const raw = safeString(ref);
    if (!raw) return "";
    if (raw.startsWith("Actor.")) return raw;
    if (raw.startsWith("Scene.")) return raw;
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
    return Array.from(canvas?.tokens?.controlled ?? []).filter(t => t?.actor);
  }

  function makeTargetRow({ actor, actorUuid, actorName, img, source = "Target", selected = false, note = "" } = {}) {
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

    for (const row of rows) {
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
    const selected = new Set(state.targetActorUuids ?? []);
    state.targetRows = (state.targetRows ?? []).map(row => ({
      ...row,
      selected: selected.has(row.actorUuid)
    }));
  }

  function setSelectedTargetsFromRows(state, rows) {
    state.targetRows = mergeTargetRows(rows);
    state.targetActorUuids = state.targetRows
      .filter(r => r.selected)
      .map(r => r.actorUuid)
      .filter(Boolean);
  }

  async function loadSelectedTokenTargets() {
    const tokens = selectedCanvasTokens();

    return tokens.map(token => {
      return makeTargetRow({
        actor: token.actor,
        img: tokenTextureImg(token, actorTokenImg(token.actor)),
        source: "Selected Token",
        selected: true,
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
        img: actor ? actorTokenImg(actor, sprite || actorImg(actor)) : (sprite || FALLBACK_IMG),
        source: "Party Member",
        selected: false,
        note: name
      }));
    }

    return rows;
  }

  async function loadAvailableTargets() {
    const selectedRows = await loadSelectedTokenTargets();
    const partyRows = await loadPartyMemberTargets();
    return mergeTargetRows([...selectedRows, ...partyRows]);
  }

  async function reloadTargets(state) {
    const rows = await loadAvailableTargets();
    setSelectedTargetsFromRows(state, rows);
    state.targetSourceLabel = "Target list includes current party members and selected token actors.";
    return rows;
  }

  // --------------------------------------------------------------------------
  // Styling
  // --------------------------------------------------------------------------

  function injectStyle() {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-aem {
        color: #16130e;
        font-family: var(--font-primary);
      }

      .oni-aem * {
        box-sizing: border-box;
      }

      .oni-aem .aem-grid-main {
        display: grid;
        grid-template-columns: 0.9fr 1.45fr;
        gap: 10px;
      }

      .oni-aem .aem-card {
        background: rgba(255,255,255,.66);
        border: 1px solid rgba(60,45,25,.25);
        border-radius: 9px;
        padding: 8px;
        margin-bottom: 8px;
        box-shadow: 0 1px 2px rgba(0,0,0,.08);
      }

      .oni-aem h3 {
        margin: 0 0 7px 0;
        padding-bottom: 4px;
        font-size: 14px;
        border-bottom: 1px solid rgba(60,45,25,.25);
      }

      .oni-aem h4 {
        margin: 8px 0 5px 0;
        font-size: 12px;
      }

      .oni-aem label {
        display: block;
        font-weight: 700;
        font-size: 12px;
        margin: 5px 0 2px;
      }

      .oni-aem input,
      .oni-aem select,
      .oni-aem textarea {
        width: 100%;
      }

      .oni-aem button {
        cursor: pointer;
      }

      .oni-aem button:disabled {
        cursor: wait;
        opacity: .65;
      }

      .oni-aem .aem-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .oni-aem .aem-row > * {
        flex: 1;
      }

      .oni-aem .aem-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-actions-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-mini {
        font-size: 11px;
        opacity: .75;
        line-height: 1.25;
      }

      .oni-aem .aem-target-summary {
        margin: 6px 0;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(0,0,0,.06);
        font-size: 11px;
        line-height: 1.25;
      }

       .oni-aem .aem-target-grid {
        --aem-target-slot-size: 86px;

        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--aem-target-slot-size), 1fr));
        gap: 10px;
        max-height: 235px;
        overflow: auto;
        padding: 8px 4px;
        border: 0;
        border-radius: 8px;
        background: transparent;
      }

      .oni-aem .aem-target-card {
        position: relative;
        width: var(--aem-target-slot-size);
        height: var(--aem-target-slot-size);
        min-height: var(--aem-target-slot-size);
        padding: 0;
        margin: 0 auto;
        border: 0;
        border-radius: 0;
        background: transparent;
        cursor: pointer;
        display: grid;
        place-items: center;
        overflow: visible;
        isolation: isolate;

        transition:
          transform 140ms ease,
          opacity 140ms ease,
          filter 140ms ease;
      }

      .oni-aem .aem-target-card:hover {
        transform: translateY(-2px) scale(1.035);
      }

      .oni-aem .aem-target-card.selected {
        transform: translateY(-2px) scale(1.07);
      }

      .oni-aem .aem-target-card input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      /* Target token name tooltip */
.oni-aem .aem-target-tooltip {
  position: absolute;
  left: 50%;
  bottom: 2px;
  transform: translate(-50%, 5px);
  z-index: 8;

  max-width: 104px;
  padding: 4px 7px;
  border-radius: 999px;

  background: rgba(18, 14, 10, 0.88);
  border: 1px solid rgba(255, 218, 128, 0.42);
  box-shadow:
    0 4px 10px rgba(0, 0, 0, 0.32),
    0 0 10px rgba(255, 180, 48, 0.18);

  color: rgba(255, 244, 218, 0.96);
  font-size: 10px;
  font-weight: 850;
  line-height: 1.1;
  text-align: center;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;

  opacity: 0;
  pointer-events: none;

  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.oni-aem .aem-target-tooltip small {
  display: block;
  margin-top: 1px;
  font-size: 9px;
  font-weight: 650;
  opacity: 0.72;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.oni-aem .aem-target-card:hover .aem-target-tooltip {
  opacity: 1;
  transform: translate(-50%, 0);
}

.oni-aem .aem-target-card.selected .aem-target-tooltip {
  background: rgba(35, 24, 8, 0.92);
  border-color: rgba(255, 206, 72, 0.72);
}

      .oni-aem .aem-target-img-wrap {
        width: var(--aem-target-slot-size);
        height: var(--aem-target-slot-size);
        overflow: visible;
        background: transparent;
        display: grid;
        place-items: center;
        pointer-events: none;
      }

      /* Selected target soft glow only, no ring */
.oni-aem .aem-target-img-wrap {
  position: relative;
  border-radius: 999px;
}

.oni-aem .aem-target-img-wrap::before {
  content: "";
  position: absolute;
  inset: 4px;
  border-radius: 999px;
  background: radial-gradient(
    circle,
    rgba(255, 205, 72, 0.42) 0%,
    rgba(255, 177, 35, 0.26) 42%,
    rgba(255, 145, 20, 0.08) 68%,
    rgba(255, 145, 20, 0) 82%
  );
  opacity: 0;
  transform: scale(0.86);
  transition:
    opacity 140ms ease,
    transform 140ms ease;
  pointer-events: none;
  z-index: 0;
  filter: blur(8px);
}

.oni-aem .aem-target-img {
  position: relative;
  z-index: 1;
}

.oni-aem .aem-target-card.selected .aem-target-img-wrap::before {
  opacity: 1;
  transform: scale(1.08);
}

      .oni-aem .aem-target-img {
        display: block;
        width: 100%;
        height: 100%;
        max-width: var(--aem-target-slot-size);
        max-height: var(--aem-target-slot-size);

        object-fit: contain;
        object-position: center bottom;

        border: 0;
        background: transparent;
        pointer-events: none;

        opacity: .72;
        filter: grayscale(.35) brightness(.48) contrast(.95);
        transform: translateZ(0);
        transform-origin: center bottom;

        transition:
          opacity 140ms ease,
          filter 140ms ease,
          transform 140ms ease;
      }

      .oni-aem video.aem-target-img {
        display: block;
      }

      .oni-aem .aem-target-card:hover .aem-target-img {
        opacity: .86;
        filter: grayscale(.18) brightness(.62) contrast(1);
      }

      .oni-aem .aem-target-card.selected .aem-target-img {
        opacity: 1;
        filter: drop-shadow(0 8px 12px rgba(0,0,0,.26));
        transform: scale(1.04);
      }

      .oni-aem .aem-effect-list {
        max-height: 445px;
        overflow: auto;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-effect-row {
        display: grid;
        grid-template-columns: 30px 1fr;
        gap: 7px;
        align-items: center;
        padding: 7px 8px;
        border-bottom: 1px solid rgba(60,45,25,.12);
        cursor: pointer;
        user-select: none;
        transition: background 100ms ease, transform 100ms ease, border-color 100ms ease;
      }

      .oni-aem .aem-effect-row:last-child {
        border-bottom: none;
      }

      .oni-aem .aem-effect-row:hover {
        background: rgba(239, 225, 181, .45);
      }

      .oni-aem .aem-effect-row:active {
        transform: translateY(1px);
        background: rgba(239, 225, 181, .72);
      }

      .oni-aem .aem-icon {
        width: 26px;
        height: 26px;
        object-fit: cover;
        border: none;
        border-radius: 5px;
        background: rgba(0,0,0,.08);
      }

      .oni-aem .aem-effect-name {
        font-weight: 700;
        line-height: 1.1;
      }

      .oni-aem .aem-effect-meta {
        font-size: 10px;
        opacity: .65;
        line-height: 1.15;
      }

      .oni-aem .aem-category-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 5px;
        margin-bottom: 6px;
      }

      /* Small spacing between Effect Search bar and category tabs */
      .oni-aem .aem-category-tabs {
      margin-top: 9px;
      }

      .oni-aem .aem-category-tabs button.active {
        background: rgba(40,34,26,.88);
        color: white;
      }

      .oni-aem .aem-selected-list {
        min-height: 54px;
        max-height: 140px;
        overflow: auto;
        padding: 4px;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 2px;
        padding: 3px 6px;
        border-radius: 999px;
        background: rgba(0,0,0,.12);
        border: 1px solid rgba(0,0,0,.12);
        font-size: 11px;
      }

      .oni-aem .aem-pill img {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 3px;
      }

      .oni-aem .aem-pill button {
        width: 18px;
        height: 18px;
        min-height: 18px;
        line-height: 14px;
        padding: 0;
        border-radius: 50%;
      }

      .oni-aem .aem-empty {
        padding: 10px;
        opacity: .65;
        text-align: center;
      }

      .oni-aem .aem-builder-launch {
        margin-top: 8px;
      }

      .oni-aem .aem-apply-compact {
        padding: 0;
        overflow: hidden;
      }

      .oni-aem .aem-apply-details > summary {
        cursor: pointer;
        list-style: none;
        padding: 8px;
        font-weight: 850;
        border-radius: 8px;
        user-select: none;
      }

      .oni-aem .aem-apply-details > summary::-webkit-details-marker {
        display: none;
      }

      .oni-aem .aem-apply-details > summary::before {
        content: "▶";
        display: inline-block;
        margin-right: 6px;
        font-size: 10px;
        transform: translateY(-1px);
      }

      .oni-aem .aem-apply-details[open] > summary::before {
        content: "▼";
      }

      .oni-aem .aem-apply-details > summary:hover {
        background: rgba(0,0,0,.055);
      }

      .oni-aem .aem-apply-details-body {
        padding: 0 8px 8px 8px;
      }

      .oni-aem .aem-apply-grid {
        display: grid;
        grid-template-columns: 1.4fr 0.9fr;
        gap: 8px;
        align-items: end;
      }

      .oni-aem .aem-duration-mini {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
      }

      .oni-aem .aem-toggle-row {
        display: flex;
        gap: 6px;
        margin-top: 7px;
      }

      .oni-aem .aem-toggle-pill {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 5px 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.45);
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }

      .oni-aem .aem-toggle-pill input {
        width: auto;
        margin: 0;
      }

      .oni-aem .aem-inline-label {
        font-size: 11px;
        opacity: .82;
        margin-bottom: 2px;
      }

      .oni-aem .aem-apply-details-note {
        margin-top: 5px;
        font-size: 11px;
        opacity: .68;
        line-height: 1.25;
      }

      .oni-aem details.aem-debug {
        margin-top: 8px;
      }

      .oni-aem details.aem-debug > summary {
        cursor: pointer;
        font-weight: 700;
        padding: 4px 2px;
        user-select: none;
      }

      .oni-aem .aem-debug-inner {
        margin-top: 8px;
      }

      .oni-aem .aem-output {
        width: 100%;
        min-height: 105px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.82);
      }

      .oni-aem .aem-warning {
        background: rgba(120, 55, 0, .12);
        border: 1px solid rgba(120, 55, 0, .25);
        padding: 6px;
        border-radius: 7px;
        font-size: 11px;
      }

      /* JRPG-style custom builder dialog */
      .oni-aem .aem-builder-shell {
        display: grid;
        gap: 8px;
      }

      .oni-aem .aem-builder-hero {
        position: relative;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(80, 58, 30, .34);
        background:
          linear-gradient(135deg, rgba(48, 38, 28, .92), rgba(18, 16, 15, .94)),
          radial-gradient(circle at top left, rgba(255, 226, 142, .25), transparent 40%);
        color: #f7efe2;
        padding: 12px;
        box-shadow: 0 3px 10px rgba(0,0,0,.22);
      }

      .oni-aem .aem-builder-hero::after {
        content: "";
        position: absolute;
        inset: auto -30px -50px auto;
        width: 170px;
        height: 170px;
        border-radius: 999px;
        background: rgba(255,255,255,.055);
        pointer-events: none;
      }

      .oni-aem .aem-builder-hero-main {
        position: relative;
        display: grid;
        grid-template-columns: 58px 1fr;
        gap: 10px;
        align-items: center;
        z-index: 1;
      }

      .oni-aem .aem-builder-icon-preview {
        width: 58px;
        height: 58px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.22);
        background: rgba(255,255,255,.10);
        object-fit: cover;
        box-shadow: 0 2px 6px rgba(0,0,0,.28);
      }

      .oni-aem .aem-builder-title {
        font-size: 18px;
        font-weight: 900;
        letter-spacing: .02em;
        line-height: 1.05;
      }

      .oni-aem .aem-builder-subtitle {
        margin-top: 3px;
        color: rgba(247,239,226,.74);
        font-size: 11px;
        line-height: 1.25;
      }

      .oni-aem .aem-builder-type-row {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
      }

      .oni-aem .aem-builder-chip {
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.09);
        color: rgba(247,239,226,.86);
        padding: 5px 7px;
        text-align: center;
        font-size: 11px;
        font-weight: 800;
      }

      .oni-aem .aem-builder-chip.buff {
        border-color: rgba(108, 232, 135, .35);
        background: rgba(108, 232, 135, .13);
      }

      .oni-aem .aem-builder-chip.debuff {
        border-color: rgba(255, 116, 136, .35);
        background: rgba(255, 116, 136, .13);
      }

      .oni-aem .aem-builder-chip.other {
        border-color: rgba(255, 211, 106, .35);
        background: rgba(255, 211, 106, .13);
      }

      .oni-aem .aem-builder-section {
        border-radius: 11px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.62);
        padding: 9px;
      }

      .oni-aem .aem-builder-section-title {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 7px;
        padding-bottom: 5px;
        border-bottom: 1px solid rgba(60,45,25,.18);
        font-weight: 900;
        font-size: 13px;
      }

      .oni-aem .aem-builder-section-title .mark {
        width: 22px;
        height: 22px;
        display: inline-grid;
        place-items: center;
        border-radius: 7px;
        background: rgba(40,34,26,.86);
        color: white;
        font-size: 12px;
      }

      .oni-aem .aem-builder-form-grid {
        display: grid;
        grid-template-columns: 1.1fr .75fr;
        gap: 8px;
      }

      .oni-aem .aem-builder-dialog label {
        font-size: 11px;
        opacity: .88;
      }

      .oni-aem .aem-builder-dialog input,
      .oni-aem .aem-builder-dialog select,
      .oni-aem .aem-builder-dialog textarea {
        border-radius: 6px;
      }

      .oni-aem .aem-builder-dialog .aem-mod-row {
        display: grid;
        grid-template-columns: 1.25fr .75fr .65fr .5fr 28px;
        gap: 5px;
        align-items: end;
        margin-bottom: 5px;
        padding: 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.16);
        background: rgba(255,255,255,.46);
      }

      .oni-aem .aem-builder-command-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
        margin-top: 8px;
      }

      .oni-aem .aem-builder-command-row button {
        min-height: 32px;
        font-weight: 850;
      }

      .oni-aem .aem-builder-primary {
        background: rgba(48, 42, 34, .90);
        color: white;
        border-color: rgba(255,255,255,.22);
      }

      .oni-aem .aem-builder-primary:hover {
        background: rgba(68, 58, 44, .96);
      }

      .oni-aem .aem-builder-secondary {
        background: rgba(255,255,255,.55);
      }

      .oni-aem .aem-builder-preview-wrap {
        border-radius: 10px;
        border: 1px solid rgba(60,45,25,.18);
        background: rgba(0,0,0,.06);
        padding: 7px;
      }

      .oni-aem .aem-builder-preview {
        min-height: 92px;
        max-height: 180px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.86);
      }

      .oni-aem .aem-builder-hint {
        margin-top: 5px;
        font-size: 11px;
        opacity: .72;
        line-height: 1.25;
      }
    `;

    document.head.appendChild(style);
  }

    // --------------------------------------------------------------------------
  // Rendering helpers
  // --------------------------------------------------------------------------

  function categoryButtonHtml(category, label, state) {
    const active = state.categoryFilter === category ? "active" : "";
    return `<button type="button" class="${active}" data-aem-action="set-category" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`;
  }

function targetCardsHtml(state) {
  const rows = state.targetRows ?? [];

  if (!rows.length) {
    return `<div class="aem-empty">No available targets found.</div>`;
  }

  return rows.map(row => {
    const checked = row.selected ? "checked" : "";
    const selected = row.selected ? "selected" : "";

    // For selected scene tokens, row.note is the token name.
    // Example: "Mushroom A", "Mushroom B", etc.
    const tokenName = safeString(row.note, row.actorName || "Target");
    const actorName = safeString(row.actorName, tokenName);
    const source = safeString(row.source, "");

    const tooltipSub = tokenName !== actorName
      ? actorName
      : source;

    const titleText = tooltipSub
      ? `${tokenName} — ${tooltipSub}`
      : tokenName;

    return `
      <label
        class="aem-target-card ${selected}"
        data-aem-target-card
        data-target-actor-uuid="${escapeHtml(row.actorUuid)}"
        title="${escapeHtml(titleText)}"
        aria-label="${escapeHtml(titleText)}"
      >
        <input
          type="checkbox"
          name="targetActorUuids"
          value="${escapeHtml(row.actorUuid)}"
          ${checked}
        >

        <div class="aem-target-img-wrap">
          ${targetIconMediaHtml(row)}
        </div>

        <span class="aem-target-tooltip">
          ${escapeHtml(tokenName)}
          ${tooltipSub ? `<small>${escapeHtml(tooltipSub)}</small>` : ""}
        </span>
      </label>
    `;
  }).join("");
}

  function effectListHtml(state) {
    const q = String(state.search ?? "").trim().toLowerCase();
    const cat = state.categoryFilter;

    let rows = state.registryEntries ?? [];

    if (cat && cat !== "All") {
      rows = rows.filter(e => e.category === cat);
    }

    if (q) {
      rows = rows.filter(e => {
        const text = [
          e.name,
          e.category,
          e.sourceType,
          e.sourceName,
          ...(e.tags ?? []),
          ...(e.statuses ?? [])
        ].join(" ").toLowerCase();

        return text.includes(q);
      });
    }

    rows = rows.slice(0, 120);

    if (!rows.length) {
      return `<div class="aem-empty">No effects found.</div>`;
    }

    return rows.map(entry => {
      const img = entry.img || entry.icon || "icons/svg/aura.svg";
      const category = entry.category || "Other";
      const source = shortSource(entry);

      return `
        <div
          class="aem-effect-row"
          data-aem-action="add-registry-effect"
          data-aem-registry-row="1"
          data-registry-id="${escapeHtml(entry.registryId)}"
          title="Left-click to add. Right-click to remove one queued copy."
        >
          <img class="aem-icon" src="${escapeHtml(img)}">
          <div>
            <div class="aem-effect-name">${escapeHtml(entry.name)}</div>
            <div class="aem-effect-meta">${escapeHtml(category)}${source ? " • " + escapeHtml(source) : ""}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function selectedEffectsHtml(state) {
    if (!state.selectedEffects.length) {
      return `<div class="aem-empty">No selected effects yet.</div>`;
    }

    return state.selectedEffects.map(sel => {
      const img = sel.img || "icons/svg/aura.svg";
      const kind = sel.kind === "custom" ? "Custom" : "Preset";

      return `
                <span
          class="aem-pill"
          title="${escapeHtml(kind)} — right-click to remove"
          data-aem-selected-effect="1"
          data-selected-id="${escapeHtml(sel.id)}"
        >
          <img src="${escapeHtml(img)}">
          <b>${escapeHtml(sel.name)}</b>
          <small>${escapeHtml(sel.category || "Other")}</small>
          <button type="button" data-aem-action="remove-selected-effect" data-selected-id="${escapeHtml(sel.id)}">×</button>
        </span>
      `;
    }).join("");
  }

  function fieldDatalistHtml(entries = []) {
    return `
      <datalist id="aem-field-key-list-builder">
        ${entries.map(entry => {
          const label = `${entry.label || entry.key} — ${entry.category || "Other"} — ${entry.valueKind || "unknown"}`;
          return `<option value="${escapeHtml(entry.activeEffectKey || entry.key)}" label="${escapeHtml(label)}"></option>`;
        }).join("")}
      </datalist>
    `;
  }

  function modifierRowsHtml(rows = []) {
    const safeRows = rows.length
      ? rows
      : [{
          id: randomId("mod"),
          key: "",
          mode: modeValue("ADD"),
          value: "1",
          priority: 20
        }];

    return safeRows.map(row => `
      <div class="aem-mod-row" data-mod-row-id="${escapeHtml(row.id)}">
        <div>
          <label>Key</label>
          <input
            type="text"
            name="customChangeKey"
            list="aem-field-key-list-builder"
            value="${escapeHtml(row.key)}"
            data-row-field="key"
            placeholder="damage_receiving_mod_all"
          >
        </div>

        <div>
          <label>Mode</label>
          <select name="customChangeMode" data-row-field="mode">
            ${modeOptionsHtml(row.mode)}
          </select>
        </div>

        <div>
          <label>Value</label>
          <input
            type="text"
            name="customChangeValue"
            value="${escapeHtml(row.value)}"
            data-row-field="value"
            placeholder="1"
          >
        </div>

        <div>
          <label>Priority</label>
          <input
            type="number"
            name="customChangePriority"
            value="${escapeHtml(row.priority)}"
            data-row-field="priority"
          >
        </div>

        <button
          type="button"
          title="Remove row"
          data-aem-builder-action="remove-modifier-row"
          data-row-id="${escapeHtml(row.id)}"
        >×</button>
      </div>
    `).join("");
  }

  function renderApplyOptionsDetails(state) {
    return `
      <div class="aem-card aem-apply-compact">
        <details class="aem-apply-details">
          <summary>Apply Options</summary>

          <div class="aem-apply-details-body">
            <div class="aem-apply-grid">
              <div>
                <div class="aem-inline-label">Duplicate</div>
                <select name="duplicateMode">
                  <option value="skip" ${state.duplicateMode === "skip" ? "selected" : ""}>Skip existing</option>
                  <option value="replace" ${state.duplicateMode === "replace" ? "selected" : ""}>Replace existing</option>
                  <option value="stack" ${state.duplicateMode === "stack" ? "selected" : ""}>Stack duplicate</option>
                  <option value="remove" ${state.duplicateMode === "remove" ? "selected" : ""}>Remove instead</option>
                  <option value="ask" ${state.duplicateMode === "ask" ? "selected" : ""}>Ask each time</option>
                </select>
              </div>

              <div>
                <div class="aem-inline-label">Duration</div>
                <div class="aem-duration-mini">
                  <input
                    type="number"
                    name="durationRounds"
                    value="${escapeHtml(state.durationRounds)}"
                    title="Rounds"
                    placeholder="Rounds"
                  >
                  <input
                    type="number"
                    name="durationTurns"
                    value="${escapeHtml(state.durationTurns)}"
                    title="Turns"
                    placeholder="Turns"
                  >
                </div>
              </div>
            </div>

            <div class="aem-toggle-row">
              <label class="aem-toggle-pill">
                <input type="checkbox" name="overrideDuration" ${state.overrideDuration ? "checked" : ""}>
                Override Duration
              </label>

              <label class="aem-toggle-pill">
                <input type="checkbox" name="silent" ${state.silent ? "checked" : ""}>
                Silent
              </label>
            </div>

            <div class="aem-apply-details-note">
              These are advanced options. Default behavior is usually fine for normal use.
            </div>
          </div>
        </details>
      </div>
    `;
  }

  function renderMainContent(state) {
    const selectedCount = (state.targetActorUuids ?? []).length;

    return `
      <div class="oni-aem">
        <div class="aem-grid-main">
          <div>
            <div class="aem-card">
              <h3>Targets</h3>

              <div class="aem-target-summary">
                <b data-aem-selected-target-count>${selectedCount}</b>
                target<span data-aem-selected-target-plural>${selectedCount === 1 ? "" : "s"}</span> selected.
                <br>${escapeHtml(state.targetSourceLabel || "Target list loaded automatically.")}
              </div>

              <div class="aem-target-grid" data-aem-target-grid>
                ${targetCardsHtml(state)}
              </div>

              <div class="aem-mini">
Select one or more token icons. Selected scene token actors are included automatically when the window opens.
If you change token selection later, close and reopen this UI to refresh the list.
              </div>
            </div>

            <div class="aem-card">
              <h3>Selected Effects</h3>

              <div class="aem-selected-list" data-aem-selected-list>
                ${selectedEffectsHtml(state)}
              </div>

              <div class="aem-actions" style="margin-top:6px;">
                <button type="button" data-aem-action="apply-selected">Apply Selected</button>
                <button type="button" data-aem-action="clear-selected-effects">Clear Effects</button>
              </div>
            </div>

            ${renderApplyOptionsDetails(state)}
          </div>

          <div>
            <div class="aem-card">
              <h3>Effect Registry</h3>

              <label>Search</label>
              <input type="text" name="effectSearch" value="${escapeHtml(state.search)}" placeholder="Search effect name, source, tag...">

              <div class="aem-category-tabs">
                ${categoryButtonHtml("All", "All", state)}
                ${categoryButtonHtml("Buff", "Buff", state)}
                ${categoryButtonHtml("Debuff", "Debuff", state)}
                ${categoryButtonHtml("Other", "Other", state)}
              </div>

              <div class="aem-effect-list" data-aem-effect-list>
                ${effectListHtml(state)}
              </div>

              <div class="aem-builder-launch">
                <button type="button" data-aem-action="open-custom-builder">Open Custom Effect Builder</button>
              </div>

              <div class="aem-mini" style="margin-top:6px;">
                Left-click an effect to queue it. Right-click an effect to remove one queued copy.
              </div>
            </div>
          </div>
        </div>

        <div class="aem-card">
          <details class="aem-debug">
            <summary>Debug</summary>
            <div class="aem-debug-inner">
              <div class="aem-actions-3">
                <button type="button" data-aem-action="refresh-registry">Refresh</button>
                <button type="button" data-aem-action="refresh-registry-compendiums">Refresh + Compendiums</button>
                <button type="button" data-aem-action="debug-registry">Debug</button>
              </div>

              <label style="margin-top:8px;">Output</label>
              <textarea class="aem-output" readonly data-aem-output>${escapeHtml(state.outputText || "")}</textarea>
            </div>
          </details>
        </div>
      </div>
    `;
  }

 function updateOutput(root, state, data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    state.outputText = text;

    const out = root?.querySelector?.("[data-aem-output]");
    if (out) out.value = text;
  }

  function rerender(root, state) {
    const holder = root.querySelector("[data-aem-root-holder]");

    if (!holder) {
      console.warn(`${TAG} Could not rerender Active Effect Manager UI: root holder missing.`);
      return;
    }

    holder.innerHTML = renderMainContent(state);
  }

  function readCommonStateFromDom(root, state) {
    state.targetActorUuids = Array.from(root.querySelectorAll('[name="targetActorUuids"]:checked'))
      .map(el => el.value)
      .filter(Boolean);

    syncTargetRowsSelection(state);

    state.duplicateMode = root.querySelector('[name="duplicateMode"]')?.value ?? state.duplicateMode;
    state.overrideDuration = !!root.querySelector('[name="overrideDuration"]')?.checked;
    state.silent = !!root.querySelector('[name="silent"]')?.checked;

    state.durationRounds = root.querySelector('[name="durationRounds"]')?.value ?? state.durationRounds;
    state.durationTurns = root.querySelector('[name="durationTurns"]')?.value ?? state.durationTurns;

    state.search = root.querySelector('[name="effectSearch"]')?.value ?? state.search;
  }

 function rerenderEffectListOnly(root, state) {
    const list = root.querySelector("[data-aem-effect-list]");

    if (!list) {
      rerender(root, state);
      return;
    }

    list.innerHTML = effectListHtml(state);
    list.scrollTop = 0;
  }

    function updateTargetSelectionDom(root, state) {
    const selected = new Set(state.targetActorUuids ?? []);

    for (const card of root.querySelectorAll("[data-aem-target-card]")) {
      const uuid = card.dataset.targetActorUuid;
      const isSelected = selected.has(uuid);

      card.classList.toggle("selected", isSelected);

      const input = card.querySelector('input[name="targetActorUuids"]');
      if (input) input.checked = isSelected;
    }

    const count = selected.size;

    const countEl = root.querySelector("[data-aem-selected-target-count]");
    if (countEl) countEl.textContent = String(count);

    const pluralEl = root.querySelector("[data-aem-selected-target-plural]");
    if (pluralEl) pluralEl.textContent = count === 1 ? "" : "s";
  }

  function refreshFieldsQuietly(state) {
    refreshFields(state).catch(e => {
      warn("Quiet field refresh after target change failed.", e);
    });
  }

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  function isConfigStatusEffectEntry(entry = {}) {
    const sourceText = [
      entry.sourceType,
      entry.sourceName,
      entry.registryId,
      entry.effectUuid,
      entry.sourceUuid,
      entry.name
    ]
      .filter(Boolean)
      .map(String)
      .join(" ")
      .toLowerCase();

    return (
      sourceText.includes("config.statuseffects") ||
      sourceText.includes("config-status-effect")
    );
  }

  async function refreshRegistry(state, { includeCompendiums = false } = {}) {
    const registry = getRegistryApi();

    if (!registry) {
      state.registryEntries = [];
      return {
        ok: false,
        reason: "registry_api_not_found"
      };
    }

    const sampleActorUuid = state.targetActorUuids?.[0] ?? null;

    // For the polished GM Active Effect Manager UI, only show the official
    // CONFIG.statusEffects list. This prevents duplicate rows from world items,
    // actor-embedded effects, equipment effects, and compendiums.
    if (typeof registry.refresh === "function") {
      await registry.refresh({
        scanConfigStatusEffects: true,

        scanWorldItems: false,
        scanWorldActors: false,
        includeActorEffects: false,
        scanCompendiums: false,

        dedupe: true,
        sampleActorUuid
      });
    }

    const entries = typeof registry.getAll === "function"
      ? registry.getAll({ cloneResult: false })
      : [];

    const rawEntries = Array.isArray(entries) ? entries : [];

    // Extra safety filter in case the registry script keeps old cached rows
    // or ignores some scan options.
    state.registryEntries = rawEntries.filter(isConfigStatusEffectEntry);

    return {
      ok: true,
      source: "CONFIG.statusEffects only",
      count: state.registryEntries.length,
      rawCountBeforeFilter: rawEntries.length
    };
  }

  async function refreshFields(state) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      state.fieldEntries = [];
      return { ok: false, reason: "field_catalogue_api_not_found" };
    }

    const actorUuid = state.targetActorUuids?.[0] ?? null;

    if (typeof catalogue.refresh === "function") {
      await catalogue.refresh({
        actorUuid,
        includeLegacyConditionKeys: false,
        includeReadOnly: false,
        suggestionsOnly: false
      });
    }

    const entries =
      typeof catalogue.getRecommended === "function"
        ? catalogue.getRecommended({ cloneResult: false })
        : typeof catalogue.getAll === "function"
          ? catalogue.getAll({ cloneResult: false })
          : [];

    state.fieldEntries = Array.isArray(entries) ? entries : [];

    return { ok: true, count: state.fieldEntries.length };
  }

  function findRegistryEntry(state, registryId) {
    return (state.registryEntries ?? []).find(e => String(e.registryId) === String(registryId)) ?? null;
  }

  // --------------------------------------------------------------------------
  // Custom effect builder
  // --------------------------------------------------------------------------

  function parseStatuses(raw) {
    return String(raw ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function getGlobalDurationFromState(state) {
    if (!state.overrideDuration) return null;

    const rounds = Number(state.durationRounds);
    const turns = Number(state.durationTurns);

    const duration = {};
    if (Number.isFinite(rounds)) duration.rounds = rounds;
    if (Number.isFinite(turns)) duration.turns = turns;

    return duration;
  }

  function buildCustomEffectData(builderState, parentState, { includeChanges = true } = {}) {
    const name = safeString(builderState.customName, "Custom Active Effect");
    const img = safeString(builderState.customIcon, "icons/svg/aura.svg");
    const category = safeString(builderState.customCategory, "Other");

    const changes = includeChanges
      ? builderState.customRows
          .map(row => ({
            key: safeString(row.key),
            mode: Number(row.mode ?? modeValue("ADD")),
            value: String(row.value ?? ""),
            priority: Number(row.priority ?? 20)
          }))
          .filter(row => row.key)
      : [];

    const duration = getGlobalDurationFromState(parentState) ?? {
      rounds: 3,
      turns: 0
    };

    return {
      name,
      label: name,
      img,
      icon: img,
      disabled: false,
      transfer: false,
      description: builderState.customDescription ?? "",
      changes,
      statuses: parseStatuses(builderState.customStatuses),
      duration,
      flags: {
        [MODULE_ID]: {
          category,
          customActiveEffect: true,
          activeEffectManager: {
            managed: true,
            custom: true,
            sourceCategory: category,
            createdFromUi: true,
            createdAt: nowIso()
          }
        }
      }
    };
  }

  function addSelectedRegistryEffect(state, entry) {
    if (!entry) return;

    state.selectedEffects.push({
      id: randomId("selected"),
      kind: "registry",
      registryId: entry.registryId,
      name: entry.name,
      img: entry.img || entry.icon || "icons/svg/aura.svg",
      category: entry.category || "Other"
    });
  }

    function removeSelectedRegistryEffect(state, entry) {
    if (!entry) {
      return {
        ok: false,
        reason: "missing_registry_entry"
      };
    }

    const registryId = String(entry.registryId ?? "");
    const entryName = String(entry.name ?? "");
    const entryCategory = String(entry.category ?? "Other");

    let index = -1;

    // Prefer exact registry ID match.
    for (let i = state.selectedEffects.length - 1; i >= 0; i--) {
      const selected = state.selectedEffects[i];

      if (
        selected.kind === "registry" &&
        String(selected.registryId ?? "") === registryId
      ) {
        index = i;
        break;
      }
    }

    // Fallback: name + category match, useful if an older queued item lacks registryId.
    if (index < 0) {
      for (let i = state.selectedEffects.length - 1; i >= 0; i--) {
        const selected = state.selectedEffects[i];

        if (
          String(selected.name ?? "") === entryName &&
          String(selected.category ?? "Other") === entryCategory
        ) {
          index = i;
          break;
        }
      }
    }

    if (index < 0) {
      return {
        ok: false,
        reason: "not_in_selected_effects",
        effectName: entryName
      };
    }

    const [removed] = state.selectedEffects.splice(index, 1);

    return {
      ok: true,
      removed
    };
  }

  function addSelectedCustomEffect(state, effectData, category = "Other") {
    state.selectedEffects.push({
      id: randomId("selected"),
      kind: "custom",
      effectData,
      name: effectData.name,
      img: effectData.img || effectData.icon || "icons/svg/aura.svg",
      category
    });
  }

  function readBuilderStateFromDom(root, builderState) {
    builderState.customName = root.querySelector('[name="customName"]')?.value ?? builderState.customName;
    builderState.customCategory = root.querySelector('[name="customCategory"]')?.value ?? builderState.customCategory;
    builderState.customIcon = root.querySelector('[name="customIcon"]')?.value ?? builderState.customIcon;
    builderState.customStatuses = root.querySelector('[name="customStatuses"]')?.value ?? builderState.customStatuses;
    builderState.customDescription = root.querySelector('[name="customDescription"]')?.value ?? builderState.customDescription;

    const rows = Array.from(root.querySelectorAll("[data-mod-row-id]"));
    builderState.customRows = rows.map(row => {
      const id = row.dataset.modRowId || randomId("mod");
      const key = row.querySelector('[data-row-field="key"]')?.value ?? "";
      const mode = Number(row.querySelector('[data-row-field="mode"]')?.value ?? modeValue("ADD"));
      const value = row.querySelector('[data-row-field="value"]')?.value ?? "";
      const priority = Number(row.querySelector('[data-row-field="priority"]')?.value ?? 20);

      return { id, key, mode, value, priority };
    });

    if (!builderState.customRows.length) {
      builderState.customRows = [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }];
    }
  }

  function renderBuilderContent(builderState) {
    const previewIcon = safeString(builderState.customIcon, "icons/svg/aura.svg");
    const name = safeString(builderState.customName, "Custom Active Effect");
    const category = safeString(builderState.customCategory, "Other");
    const catClass = category.toLowerCase() === "buff"
      ? "buff"
      : category.toLowerCase() === "debuff"
        ? "debuff"
        : "other";

    return `
      <div class="oni-aem aem-builder-dialog">
        ${fieldDatalistHtml(builderState.fieldEntries ?? [])}

        <div class="aem-builder-shell">
          <div class="aem-builder-hero">
            <div class="aem-builder-hero-main">
              <img class="aem-builder-icon-preview" src="${escapeHtml(previewIcon)}">
              <div>
                <div class="aem-builder-title">${escapeHtml(name)}</div>
                <div class="aem-builder-subtitle">
                  Build a real Active Effect document. Add it to the main queue when ready.
                </div>
              </div>
            </div>

            <div class="aem-builder-type-row">
              <div class="aem-builder-chip ${escapeHtml(catClass)}">${escapeHtml(category)}</div>
              <div class="aem-builder-chip">Marker or Modifier</div>
              <div class="aem-builder-chip">${builderState.customRows?.length ?? 0} Modifier Row(s)</div>
            </div>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">1</span>
              Effect Identity
            </div>

            <div class="aem-builder-form-grid">
              <div>
                <label>Name</label>
                <input type="text" name="customName" value="${escapeHtml(builderState.customName)}" placeholder="Defense Boost">
              </div>

              <div>
                <label>Category</label>
                <select name="customCategory">
                  <option value="Buff" ${builderState.customCategory === "Buff" ? "selected" : ""}>Buff</option>
                  <option value="Debuff" ${builderState.customCategory === "Debuff" ? "selected" : ""}>Debuff</option>
                  <option value="Other" ${builderState.customCategory === "Other" ? "selected" : ""}>Other</option>
                </select>
              </div>
            </div>

            <label>Icon</label>
            <input type="text" name="customIcon" value="${escapeHtml(builderState.customIcon)}" placeholder="icons/svg/aura.svg">

            <label>Status IDs / Marker Tags</label>
            <input type="text" name="customStatuses" value="${escapeHtml(builderState.customStatuses)}" placeholder="Optional, comma-separated. Example: bleed, mark">

            <label>Description</label>
            <textarea name="customDescription" rows="2" placeholder="Optional description">${escapeHtml(builderState.customDescription)}</textarea>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">2</span>
              Modifier Rows
            </div>

            <div data-aem-builder-modifier-rows>
              ${modifierRowsHtml(builderState.customRows)}
            </div>

            <div class="aem-actions-3" style="margin-top:7px;">
              <button type="button" data-aem-builder-action="add-modifier-row">+ Add Row</button>
              <button type="button" data-aem-builder-action="refresh-fields">Refresh Fields</button>
              <button type="button" data-aem-builder-action="preview-custom">Preview</button>
            </div>

            <div class="aem-builder-hint">
              Modifier rows are optional if you are creating a marker effect. For stat changes, use the field suggestions.
            </div>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">3</span>
              Add to Queue
            </div>

            <div class="aem-builder-command-row">
              <button
                type="button"
                class="aem-builder-secondary"
                data-aem-builder-action="add-custom-marker"
              >
                Add Marker Effect
              </button>

              <button
                type="button"
                class="aem-builder-primary"
                data-aem-builder-action="add-custom-modifier"
              >
                Add Modifier Effect
              </button>
            </div>

            <div class="aem-warning" style="margin-top:7px;">
              Marker effects can have no changes. Modifier effects use the rows above.
              Legacy keys like <code>isSlow</code> are intentionally not suggested.
            </div>
          </div>

          <div class="aem-builder-section">
            <details>
              <summary><b>Preview / Debug</b></summary>
              <div class="aem-builder-preview-wrap" style="margin-top:7px;">
                <textarea class="aem-builder-preview" readonly data-aem-builder-preview>${escapeHtml(builderState.previewText || "")}</textarea>
              </div>
            </details>
          </div>
        </div>
      </div>
    `;
  }

  function rerenderBuilder(root, builderState) {
    const holder = root.querySelector("[data-aem-builder-root-holder]");
    if (!holder) return;
    holder.innerHTML = renderBuilderContent(builderState);
  }

  function setBuilderPreview(root, builderState, data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    builderState.previewText = text;

    const el = root.querySelector("[data-aem-builder-preview]");
    if (el) el.value = text;
  }

async function openCustomBuilderDialog(parentState, parentRoot) {
  // ==========================================================================
  // Native ActiveEffect Configuration builder — CSB-safe version
  // ==========================================================================
  // CSB's CustomActiveEffectConfig expects the ActiveEffect to have a real parent.
  // So instead of opening a parentless unsaved ActiveEffect, we create a temporary
  // disabled draft effect on a real actor, open its native sheet, intercept Submit,
  // capture the data, delete the draft, then queue the final effect in AEM.
  // ==========================================================================

  const SUGGESTION_STYLE_ID = "oni-aem-native-key-suggestion-style";
  const SUGGESTION_CLASS = "oni-aem-native-key-suggestion-dropdown";

  // "path" = system.props.defense
  // "short" = defense
  const NATIVE_SUGGESTION_VALUE = "short";

  if (BUILDER_DIALOG) {
    try {
      BUILDER_DIALOG.bringToTop?.();
      return BUILDER_DIALOG;
    } catch (_e) {
      BUILDER_DIALOG = null;
    }
  }

  function ensureNativeSuggestionStyle() {
    const old = document.getElementById(SUGGESTION_STYLE_ID);
    if (old) old.remove();

    const style = document.createElement("style");
    style.id = SUGGESTION_STYLE_ID;
    style.textContent = `
      .${SUGGESTION_CLASS} {
        position: fixed;
        z-index: 9999999;
        display: none;
        min-width: 260px;
        max-width: 460px;
        max-height: 260px;
        overflow: auto;
        padding: 5px;
        border: 1px solid rgba(40, 32, 24, .34);
        border-radius: 8px;
        background: rgba(248, 242, 224, .98);
        box-shadow: 0 10px 28px rgba(0,0,0,.28);
        color: #1f1a14;
        font-family: var(--font-primary, "Signika"), sans-serif;
      }

      .${SUGGESTION_CLASS} .aem-suggest-head {
        padding: 4px 6px 6px;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .04em;
        opacity: .62;
      }

      .${SUGGESTION_CLASS} .aem-suggest-row {
        display: grid;
        gap: 2px;
        padding: 6px 7px;
        border-radius: 6px;
        cursor: pointer;
      }

      .${SUGGESTION_CLASS} .aem-suggest-row:hover,
      .${SUGGESTION_CLASS} .aem-suggest-row.active {
        background: rgba(65, 50, 32, .14);
      }

      .${SUGGESTION_CLASS} .aem-suggest-key {
        font-family: monospace;
        font-size: 12px;
        font-weight: 900;
        color: #15110c;
        overflow-wrap: anywhere;
      }

      .${SUGGESTION_CLASS} .aem-suggest-meta {
        font-size: 10px;
        opacity: .7;
        line-height: 1.2;
      }
    `;
    document.head.appendChild(style);
  }

  function getSheetRoot(sheet) {
    return normalizeHtmlRoot(sheet?.element) ??
      document.getElementById(sheet?.id) ??
      document.querySelector(`[data-appid="${sheet?.appId}"]`) ??
      document.querySelector(`#app-${sheet?.appId}`) ??
      null;
  }

  function boolFromFormValue(value, fallback = false) {
    if (value === undefined || value === null) return fallback;
    if (value === true || value === false) return value;

    const s = String(value).trim().toLowerCase();
    if (["true", "1", "on", "yes", "checked"].includes(s)) return true;
    if (["false", "0", "off", "no", ""].includes(s)) return false;

    return !!value;
  }

  function deleteUnsafeCreateFields(effectData) {
    if (!effectData || typeof effectData !== "object") return effectData;

    delete effectData._id;
    delete effectData.id;
    delete effectData.folder;
    delete effectData.sort;
    delete effectData.ownership;
    delete effectData._stats;

    return effectData;
  }

  function normalizeNativeChanges(changes) {
    if (!changes) return [];

    if (Array.isArray(changes)) {
      return changes
        .filter(Boolean)
        .map(row => ({
          key: safeString(row.key),
          mode: Number(row.mode ?? modeValue("ADD")),
          value: String(row.value ?? ""),
          priority: Number(row.priority ?? 20)
        }))
        .filter(row => row.key);
    }

    if (typeof changes === "object") {
      return Object.entries(changes)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, row]) => row)
        .filter(Boolean)
        .map(row => ({
          key: safeString(row.key),
          mode: Number(row.mode ?? modeValue("ADD")),
          value: String(row.value ?? ""),
          priority: Number(row.priority ?? 20)
        }))
        .filter(row => row.key);
    }

    return [];
  }

  function readChangeRowsFromDom(root) {
    if (!root) return [];

    const rows = new Map();

    for (const el of root.querySelectorAll("input[name], textarea[name], select[name]")) {
      const name = String(el.name ?? "");
      const match = name.match(/^changes\.(\d+)\.(key|mode|value|priority)$/);
      if (!match) continue;

      const index = match[1];
      const field = match[2];

      if (!rows.has(index)) {
        rows.set(index, {
          key: "",
          mode: modeValue("ADD"),
          value: "",
          priority: 20
        });
      }

      rows.get(index)[field] = el.value;
    }

    return Array.from(rows.values())
      .map(row => ({
        key: safeString(row.key),
        mode: Number(row.mode ?? modeValue("ADD")),
        value: String(row.value ?? ""),
        priority: Number(row.priority ?? 20)
      }))
      .filter(row => row.key);
  }

  function normalizeNativeStatuses(statuses) {
    if (statuses instanceof Set) return Array.from(statuses);
    if (Array.isArray(statuses)) return statuses.map(String).filter(Boolean);

    if (typeof statuses === "string") {
      return statuses
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    }

    if (statuses && typeof statuses === "object") {
      return Object.values(statuses).map(String).filter(Boolean);
    }

    return [];
  }

  function inferCategoryFromNativeEffect(effectData, fallback = "Other") {
    const flags = effectData?.flags?.[MODULE_ID] ?? {};
    const existing =
      flags?.category ??
      flags?.activeEffectManager?.sourceCategory ??
      flags?.activeEffectManager?.category ??
      null;

    if (/^buff$/i.test(existing)) return "Buff";
    if (/^debuff$/i.test(existing)) return "Debuff";
    if (/^other$/i.test(existing)) return "Other";

    const text = [
      effectData?.name,
      effectData?.label,
      ...(effectData?.statuses ?? []),
      ...(effectData?.changes ?? []).map(c => c?.key)
    ].filter(Boolean).join(" ").toLowerCase();

    if (/slow|dazed|weak|shaken|enraged|poison|poisoned|bleed|burn|frozen|fatigue|wet|oil|petrify|hypothermia|turbulence|zombie|curse|stun|blind/.test(text)) {
      return "Debuff";
    }

    if (/swift|awake|strong|focus|clarity|energized|regen|regeneration|shield|barrier|protect|haste|bless|boost/.test(text)) {
      return "Buff";
    }

    return fallback;
  }

  function stampNativeEffectData(effectData, category) {
    const finalCategory = inferCategoryFromNativeEffect(effectData, category);

    effectData.flags = effectData.flags || {};
    effectData.flags[MODULE_ID] = effectData.flags[MODULE_ID] || {};

    effectData.flags[MODULE_ID] = foundry?.utils?.mergeObject
      ? foundry.utils.mergeObject(effectData.flags[MODULE_ID], {
          category: finalCategory,
          customActiveEffect: true,
          activeEffectManager: {
            managed: true,
            custom: true,
            sourceCategory: finalCategory,
            createdFromUi: true,
            createdFromNativeSheet: true,
            createdAt: nowIso()
          }
        }, {
          inplace: false,
          recursive: true,
          insertKeys: true,
          insertValues: true,
          overwrite: true
        })
      : {
          ...(effectData.flags[MODULE_ID] ?? {}),
          category: finalCategory,
          customActiveEffect: true,
          activeEffectManager: {
            ...(effectData.flags[MODULE_ID]?.activeEffectManager ?? {}),
            managed: true,
            custom: true,
            sourceCategory: finalCategory,
            createdFromUi: true,
            createdFromNativeSheet: true,
            createdAt: nowIso()
          }
        };

    return effectData;
  }

  function getFormDataExtendedClass() {
    return (
      foundry?.applications?.ux?.FormDataExtended ??
      foundry?.utils?.FormDataExtended ??
      globalThis.FormDataExtended ??
      null
    );
  }

  function readNativeFormData(sheet, fallbackEffectData = {}, category = "Other") {
    const root = getSheetRoot(sheet);
    const form = root?.querySelector?.("form") ?? sheet?.form ?? null;

    let formObject = {};

    try {
      if (form) {
        const FDE = getFormDataExtendedClass();

        if (FDE) {
          const fd = new FDE(form);
          formObject = fd.object ?? fd;
        } else {
          for (const [key, value] of new FormData(form).entries()) {
            if (formObject[key] === undefined) formObject[key] = value;
            else formObject[key] = asArray(formObject[key]).concat(value);
          }
        }
      }
    } catch (e) {
      warn("Could not read native ActiveEffect form data. Using fallback data.", e);
      formObject = {};
    }

    let expanded = formObject;

    try {
      expanded = foundry.utils.expandObject(formObject);
    } catch (_e) {}

    const base = clone(fallbackEffectData, {});
    const merged = foundry?.utils?.mergeObject
      ? foundry.utils.mergeObject(base, expanded, {
          inplace: false,
          recursive: true,
          insertKeys: true,
          insertValues: true,
          overwrite: true
        })
      : {
          ...base,
          ...expanded
        };

    merged.name = safeString(merged.name ?? merged.label, "Custom Active Effect");
    merged.label = merged.name;

    merged.img = safeString(merged.img ?? merged.icon, "icons/svg/aura.svg");
    merged.icon = merged.img;

    merged.description = String(merged.description ?? "");

    // Important:
    // The temporary draft is created disabled, but the final queued effect should
    // default to enabled unless the user checked Disabled in the native sheet.
    merged.disabled = boolFromFormValue(expanded.disabled, false);
    merged.transfer = boolFromFormValue(expanded.transfer, false);

    merged.changes = normalizeNativeChanges(merged.changes);

    if (!merged.changes.length) {
      merged.changes = readChangeRowsFromDom(root);
    }

    merged.statuses = normalizeNativeStatuses(merged.statuses);

    merged.duration = merged.duration && typeof merged.duration === "object"
      ? clone(merged.duration, {})
      : {};

    for (const key of ["rounds", "turns", "seconds", "startRound", "startTurn"]) {
      if (merged.duration[key] === "" || merged.duration[key] == null) {
        delete merged.duration[key];
        continue;
      }

      const n = Number(merged.duration[key]);
      if (Number.isFinite(n)) merged.duration[key] = n;
    }

    deleteUnsafeCreateFields(merged);
    stampNativeEffectData(merged, category);

    return merged;
  }

 function keyQueryFromFieldValue(value) {
  return safeString(value)
    .replace(/^system\.props\./i, "")
    .split(/[\s,;|]+/g)
    .pop()
    .trim();
}

function plainSuggestionText(value) {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\$\{[\s\S]*?\}\$/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function walkAemSheetNodes(value, visitor, path = [], ancestors = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkAemSheetNodes(v, visitor, [...path, i], ancestors));
    return;
  }

  if (!value || typeof value !== "object") return;

  visitor(value, path, ancestors);

  const nextAncestors = [...ancestors, value];

  for (const key of ["contents", "rowLayout", "options", "predefinedLines"]) {
    if (value[key] !== undefined) {
      walkAemSheetNodes(value[key], visitor, [...path, key], nextAncestors);
    }
  }
}

function isStatusTabNodeForSuggestions(node = {}) {
  const key = String(node.key ?? "").trim().toLowerCase();
  const name = plainSuggestionText(node.name ?? "").toLowerCase();
  const title = plainSuggestionText(node.title ?? "").toLowerCase();
  const label = plainSuggestionText(node.label ?? "").toLowerCase();
  const text = [key, name, title, label].join(" ");

  return node.type === "tab" && (
    key === "status" ||
    name.includes("status") ||
    title.includes("status") ||
    label.includes("status") ||
    text.includes("status")
  );
}

function isInsideStatusTabForSuggestions(ancestors = []) {
  return ancestors.some(isStatusTabNodeForSuggestions);
}

function getActorPropsForSuggestions() {
  return actor?.system?.props ?? {};
}

function getSuggestionCurrentValue(key) {
  const props = getActorPropsForSuggestions();

  if (Object.prototype.hasOwnProperty.call(props, key)) {
    return props[key];
  }

  return undefined;
}

function readableLabelFromKey(key) {
  return String(key ?? "")
    .replace(/^_+/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, m => m.toUpperCase());
}

function makeSuggestionEntry(key, options = {}) {
  const cleanKey = safeString(key);
  if (!cleanKey) return null;

  const currentValue = getSuggestionCurrentValue(cleanKey);

  return {
    key: cleanKey,
    activeEffectKey: cleanKey,
    propPath: `system.props.${cleanKey}`,

    label: options.label ?? readableLabelFromKey(cleanKey),
    category: options.category ?? inferSuggestionCategory(cleanKey),
    valueKind: options.valueKind ?? inferSuggestionValueKind(cleanKey, currentValue),
    source: options.source ?? "native-status-suggestion",

    currentValue,
    isRecommended: true
  };
}

function inferSuggestionValueKind(key, currentValue) {
  if (typeof currentValue === "boolean") return "boolean";
  if (typeof currentValue === "number") return "number";

  const s = String(currentValue ?? "");
  if (s !== "" && Number.isFinite(Number(s))) return "number";

  const text = String(key ?? "").toLowerCase();

  if (
    /hp|mp|ip|zero|zp|current|max|def|mdef|defense|accuracy|damage|reduction|mod|bonus|penalty|critical|initiative|clock|resource|affinity|efficiency|percentage|percent|multiplier|rate/.test(text)
  ) {
    return "number";
  }

  return "text";
}

function inferSuggestionCategory(key) {
  const k = String(key ?? "").toLowerCase();

  if (/^(dex|ins|mig|wlp)_(base|current)$/.test(k)) return "Attribute";
  if (/hp|mp|ip|zero|zp|resource|clock|shield/.test(k)) return "Resource";
  if (/accuracy/.test(k)) return "Accuracy";
  if (/damage_receiving|reduction|receiving/.test(k)) return "Damage Reduction";
  if (/extra_damage|damage_mod|damage_outgoing|attack_damage|damage_bonus/.test(k)) return "Damage Bonus";
  if (/critical|crit/.test(k)) return "Critical";
  if (/affinity|physical|air|bolt|dark|earth|fire|ice|light|poison/.test(k)) return "Type Affinity";
  if (/weapon|arcane|bow|brawling|dagger|firearm|flail|heavy|spear|sword|thrown|melee|ranged|spell|magic/.test(k)) return "Weapon / Attack Type";

  return "Status";
}

function isAllowedStatusModifierKey(key) {
  const k = String(key ?? "").trim();

  if (!k) return false;

  // Keep old CSB condition booleans out of the suggestion list.
  if (/^is[A-Z]/.test(k)) return false;

  // These are the combat/status modifier families shown in the Status tab.
  return (
    /^(attack_accuracy_mod_|extra_damage_mod_|damage_receiving_mod_)/.test(k) ||
    /^damage_.*_mod_/.test(k) ||
    /_(damage|accuracy|critical|crit|reduction|receiving|affinity|efficiency|mod|bonus|penalty|multiplier|percentage|percent)$/.test(k) ||
    /(damage|accuracy|critical|crit|reduction|receiving|affinity|efficiency|weapon|melee|ranged|spell|magic|physical|air|bolt|dark|earth|fire|ice|light|poison)/.test(k)
  );
}

function collectStatusTabSuggestionEntries() {
  const bodyContents = actor?.system?.body?.contents ?? [];
  const byKey = new Map();

  walkAemSheetNodes(bodyContents, (node, _path, ancestors) => {
    if (!isInsideStatusTabForSuggestions(ancestors)) return;

    const key = safeString(node.key);
    if (!key) return;
    if (!isAllowedStatusModifierKey(key)) return;

    const label =
      safeString(node.tooltip) ||
      safeString(node.label) ||
      safeString(node.colName) ||
      safeString(node.title) ||
      readableLabelFromKey(key);

    const entry = makeSuggestionEntry(key, {
      label: plainSuggestionText(label) || readableLabelFromKey(key),
      category: inferSuggestionCategory(key),
      source: "actor-status-tab"
    });

    if (entry) byKey.set(key, entry);
  });

  return Array.from(byKey.values());
}

function collectCoreSuggestionEntries() {
  const props = getActorPropsForSuggestions();

  const coreKeys = [
    // Attribute dice
    "dex_current",
    "ins_current",
    "mig_current",
    "wlp_current",

    // Include base too because sometimes an effect may need to alter the source die.
    "dex_base",
    "ins_base",
    "mig_base",
    "wlp_base",

    // Actor resources
    "current_hp",
    "max_hp",
    "current_mp",
    "max_mp",
    "current_ip",
    "max_ip",

    // Optional but useful resource families if your sheet has them.
    "zero_power_value",
    "max_zero",
    "current_zero",
    "current_zp",
    "max_zp",
    "shield_value"
  ];

  return coreKeys
    .filter(key => {
      // Always allow the main requested names.
      if ([
        "dex_current",
        "ins_current",
        "mig_current",
        "wlp_current",
        "current_hp",
        "max_hp",
        "current_mp",
        "max_mp",
        "current_ip",
        "max_ip"
      ].includes(key)) {
        return true;
      }

      // Optional keys only appear if the actor actually has them.
      return Object.prototype.hasOwnProperty.call(props, key);
    })
    .map(key => makeSuggestionEntry(key, {
      category: inferSuggestionCategory(key),
      source: "core-actor-resource"
    }))
    .filter(Boolean);
}

const BUILTIN_GAMEPLAY_MODIFIER_KEYS = [
  // Accuracy
  "attack_accuracy_mod_all",
  "attack_accuracy_mod_melee",
  "attack_accuracy_mod_ranged",
  "attack_accuracy_mod_magic",

  // Extra Damage — attack range / action type
  "extra_damage_mod_all",
  "extra_damage_mod_melee",
  "extra_damage_mod_ranged",
  "extra_damage_mod_spell",

  // Extra Damage — element
  "extra_damage_mod_physical",
  "extra_damage_mod_air",
  "extra_damage_mod_bolt",
  "extra_damage_mod_dark",
  "extra_damage_mod_earth",
  "extra_damage_mod_fire",
  "extra_damage_mod_ice",
  "extra_damage_mod_light",
  "extra_damage_mod_poison",

  // Extra Damage — weapon type
  "extra_damage_mod_arcane",
  "extra_damage_mod_bow",
  "extra_damage_mod_brawling",
  "extra_damage_mod_dagger",
  "extra_damage_mod_firearm",
  "extra_damage_mod_flail",
  "extra_damage_mod_heavy",
  "extra_damage_mod_spear",
  "extra_damage_mod_sword",
  "extra_damage_mod_thrown",

  // Flat Damage Reduction
  "damage_receiving_mod_all",
  "damage_receiving_mod_melee",
  "damage_receiving_mod_range",
  "damage_receiving_mod_physical",
  "damage_receiving_mod_air",
  "damage_receiving_mod_bolt",
  "damage_receiving_mod_dark",
  "damage_receiving_mod_earth",
  "damage_receiving_mod_fire",
  "damage_receiving_mod_ice",
  "damage_receiving_mod_light",
  "damage_receiving_mod_poison",

  // Percentage Damage Reduction
  "damage_receiving_percentage_all",
  "damage_receiving_percentage_melee",
  "damage_receiving_percentage_range",
  "damage_receiving_percentage_physical",
  "damage_receiving_percentage_air",
  "damage_receiving_percentage_bolt",
  "damage_receiving_percentage_dark",
  "damage_receiving_percentage_earth",
  "damage_receiving_percentage_fire",
  "damage_receiving_percentage_ice",
  "damage_receiving_percentage_light",
  "damage_receiving_percentage_poison",

  // Critical / special combat modifiers
  "minimum_critical_dice",
  "critical_dice_range",
  "critical_damage_bonus",
  "critical_damage_multiplier",

  // Sustain / drain
  "lifesteal_percentage",
  "lifesteal_value",
  "manadrain_percentage",
  "manadrain_value",

  // Misc gameplay modifiers
  "ip_reduction_value",
  "character_exp_multiplier",
  "character_zenit_multiplier",
  "enmity",
  "activation",

  // Type affinity
  "affinity_1",
  "affinity_2",
  "affinity_3",
  "affinity_4",
  "affinity_5",
  "affinity_6",
  "affinity_7",
  "affinity_8",
  "affinity_9",

  // Weapon efficiency
  "arcane_ef",
  "bow_ef",
  "brawling_ef",
  "dagger_ef",
  "firearm_ef",
  "flail_ef",
  "heavy_ef",
  "spear_ef",
  "sword_ef",
  "thrown_ef"
];

function collectBuiltinGameplayModifierEntries() {
  return BUILTIN_GAMEPLAY_MODIFIER_KEYS
    .map(key => makeSuggestionEntry(key, {
      category: inferSuggestionCategory(key),
      source: "builtin-gameplay-modifier"
    }))
    .filter(Boolean);
}

function buildNativeSuggestionPool() {
  const byKey = new Map();

  // 1. Built-in known gameplay modifier keys.
  // This makes the list reliable even if CSB's sheet body scanner misses
  // collapsed tabs, table nodes, or formula-only label fields.
  for (const entry of collectBuiltinGameplayModifierEntries()) {
    byKey.set(entry.key, entry);
  }

  // 2. Status tab scan from the current actor.
  // This keeps the system extensible if you add more keys to the sheet later.
  for (const entry of collectStatusTabSuggestionEntries()) {
    byKey.set(entry.key, {
      ...(byKey.get(entry.key) ?? {}),
      ...entry,
      source: "actor-status-tab"
    });
  }

  // 3. Core actor stat/resource keys outside the Status tab.
  for (const entry of collectCoreSuggestionEntries()) {
    byKey.set(entry.key, entry);
  }

  return Array.from(byKey.values());
}

function suggestionValueFromEntry(entry = {}) {
  // Foundry CSB ActiveEffect keys only need the short data key:
  // extra_damage_mod_all, dex_current, current_hp, etc.
  return safeString(entry.activeEffectKey ?? entry.key);
}

function scoreNativeSuggestion(query, entry) {
  const q = keyQueryFromFieldValue(query).toLowerCase();
  const key = String(entry.key ?? "").toLowerCase();
  const label = String(entry.label ?? "").toLowerCase();
  const cat = String(entry.category ?? "").toLowerCase();

  if (!q) {
    if (entry.source === "core-actor-resource") return 900;
    if (entry.source === "builtin-gameplay-modifier") return 800;
    if (entry.source === "actor-status-tab") return 750;
    return 300;
  }

  let score = 0;

  // Exact and normal matching.
  if (key === q) score += 5000;
  if (key.startsWith(q)) score += 3500;
  if (key.includes(q)) score += 2400;
  if (label.includes(q)) score += 800;
  if (cat.includes(q)) score += 400;

  // Friendly alias matching.
  // Typing "damage_mod" should find extra_damage_mod_*.
  if (q.includes("damage_mod") && key.startsWith("extra_damage_mod_")) score += 3200;

  // Typing "damage_reduction" should find damage_receiving_*.
  if (
    (q.includes("damage_reduction") || q.includes("reduction") || q.includes("receiving")) &&
    key.startsWith("damage_receiving_")
  ) {
    score += 3200;
  }

  // Typing "accuracy_mod" should find attack_accuracy_mod_*.
  if (
    (q.includes("accuracy_mod") || q.includes("accuracy")) &&
    key.startsWith("attack_accuracy_mod_")
  ) {
    score += 3000;
  }

  // Typing "crit" should find critical keys.
  if ((q.includes("crit") || q.includes("critical")) && key.includes("critical")) {
    score += 2600;
  }

  // Typing "weapon" should show weapon efficiency.
  if (
    q.includes("weapon") &&
    /^(arcane|bow|brawling|dagger|firearm|flail|heavy|spear|sword|thrown)_ef$/.test(key)
  ) {
    score += 2200;
  }

  // Split matching for things like "damage all", "fire damage", "melee mod".
  const parts = q.split(/[\s._-]+/g).filter(Boolean);

  for (const part of parts) {
    if (key.includes(part)) score += 220;
    if (label.includes(part)) score += 100;
    if (cat.includes(part)) score += 60;
  }

  // Priority nudges.
  if (entry.source === "builtin-gameplay-modifier") score += 180;
  if (entry.source === "actor-status-tab") score += 160;
  if (entry.source === "core-actor-resource") score += 120;

  // When user is clearly searching gameplay modifier keys, don't let core
  // resources like dex_current crowd the result list.
  const wantsModifier =
    /damage|accuracy|crit|critical|reduction|receiving|mod|bonus|affinity|efficiency|weapon|melee|ranged|spell|magic|physical|air|bolt|dark|earth|fire|ice|light|poison/.test(q);

  if (wantsModifier && entry.source === "core-actor-resource") {
    score -= 1000;
  }

  return score;
}

function getNativeSuggestions(query) {
  const pool = buildNativeSuggestionPool();
  const q = keyQueryFromFieldValue(query);

  return pool
    .map(entry => ({
      ...entry,
      score: scoreNativeSuggestion(q, entry)
    }))
    .filter(entry => {
      if (!q) return true;
      return entry.score > 0;
    })
    .sort((a, b) => {
      const score = b.score - a.score;
      if (score) return score;

      const sourcePriority = {
        "builtin-gameplay-modifier": 3,
        "actor-status-tab": 2,
        "core-actor-resource": 1
      };

      const sp =
        (sourcePriority[b.source] ?? 0) -
        (sourcePriority[a.source] ?? 0);

      if (sp) return sp;

      return String(a.key ?? "").localeCompare(String(b.key ?? ""));
    })
    .slice(0, 16);
}

  function findNativeAttributeKeyFields(root) {
    if (!root) return [];

    return Array.from(root.querySelectorAll(`
      input[name^="changes."][name$=".key"],
      textarea[name^="changes."][name$=".key"],
      input[name*="changes"][name$="key"],
      textarea[name*="changes"][name$="key"]
    `)).filter(el => !el.dataset.oniAemNativeSuggestBound);
  }

  function bindSuggestionDropdownToField(field, dropdown) {
    field.dataset.oniAemNativeSuggestBound = "1";
    field.setAttribute("autocomplete", "off");
    field.title = field.title || "Type to search actor data keys.";

    let activeIndex = -1;
    let currentRows = [];

    const hide = () => {
      dropdown.style.display = "none";
      activeIndex = -1;
    };

    const position = () => {
      const rect = field.getBoundingClientRect();

      dropdown.style.left = `${Math.max(8, rect.left)}px`;
      dropdown.style.top = `${Math.min(window.innerHeight - 40, rect.bottom + 4)}px`;
      dropdown.style.width = `${Math.max(260, rect.width)}px`;
    };

    const render = () => {
      currentRows = getNativeSuggestions(field.value)
        .map(entry => ({
          entry,
          value: suggestionValueFromEntry(entry)
        }))
        .filter(row => safeString(row.value));

      if (!currentRows.length) {
        hide();
        return;
      }

      position();

      dropdown.innerHTML = `
        <div class="aem-suggest-head">Smart Key Suggestions</div>
        ${currentRows.map((row, index) => {
          const entry = row.entry ?? {};
          const active = index === activeIndex ? " active" : "";
          const meta = [
            entry.label,
            entry.category,
            entry.valueKind,
            entry.currentValue !== undefined ? `current: ${entry.currentValue}` : ""
          ].filter(Boolean).join(" • ");

          return `
            <div class="aem-suggest-row${active}" data-suggest-index="${index}">
              <div class="aem-suggest-key">${escapeHtml(row.value)}</div>
              <div class="aem-suggest-meta">${escapeHtml(meta)}</div>
            </div>
          `;
        }).join("")}
      `;

      dropdown.style.display = "block";
    };

    const choose = (index) => {
      const row = currentRows[index];
      if (!row) return;

      field.value = row.value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      hide();
      field.focus();
    };

    field.addEventListener("focus", render);
    field.addEventListener("input", render);
    field.addEventListener("click", render);

    field.addEventListener("keydown", ev => {
      if (dropdown.style.display !== "block") return;

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        activeIndex = Math.min(currentRows.length - 1, activeIndex + 1);
        render();
        return;
      }

      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        activeIndex = Math.max(0, activeIndex - 1);
        render();
        return;
      }

      if (ev.key === "Enter" && activeIndex >= 0) {
        ev.preventDefault();
        choose(activeIndex);
        return;
      }

      if (ev.key === "Escape") {
        hide();
      }
    });

    dropdown.addEventListener("mousedown", ev => {
      const row = ev.target.closest?.(".aem-suggest-row");
      if (!row) return;

      ev.preventDefault();
      ev.stopPropagation();

      choose(Number(row.dataset.suggestIndex));
    });
  }

  async function resolveNativeBuilderParentActor() {
    const targetActorUuids = Array.isArray(parentState.targetActorUuids)
      ? parentState.targetActorUuids.filter(Boolean)
      : [];

    for (const uuid of targetActorUuids) {
      const actor = await resolveActorFromRef(uuid);
      if (actor?.documentName === "Actor") return actor;
    }

    const selectedTokenActor = Array.from(canvas?.tokens?.controlled ?? [])
      .map(t => t.actor)
      .find(Boolean);

    if (selectedTokenActor?.documentName === "Actor") return selectedTokenActor;

    if (game.user?.character?.documentName === "Actor") return game.user.character;

    return Array.from(game.actors ?? []).find(actor => {
      try {
        return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
      } catch (_e) {
        return false;
      }
    }) ?? null;
  }

  async function refreshNativeFieldCatalogue(actor) {
    try {
      const catalogue = getFieldCatalogueApi();

      if (catalogue?.refresh) {
        await catalogue.refresh({
          actorUuid: actor?.uuid ?? null,
          includeLegacyConditionKeys: false,
          includeReadOnly: false,
          suggestionsOnly: false
        });
        return;
      }

      await refreshFields(parentState);
    } catch (e) {
      warn("Native sheet field catalogue refresh failed.", e);
    }
  }

  const actor = await resolveNativeBuilderParentActor();

  if (!actor) {
    const report = {
      ok: false,
      reason: "no_parent_actor",
      hint: "Select at least one target actor first. CSB's native Active Effect sheet needs a real actor parent."
    };

    updateOutput(parentRoot, parentState, report);
    ui.notifications?.warn?.("Select at least one target actor before opening the native Active Effect builder.");
    return report;
  }

  const builderState = {
    customName: parentState.customName ?? "Custom Active Effect",
    customCategory: parentState.customCategory ?? "Other",
    customIcon: parentState.customIcon ?? "icons/svg/aura.svg",
    customStatuses: parentState.customStatuses ?? "",
    customDescription: parentState.customDescription ?? "",
    customRows: clone(parentState.customRows, []) ?? []
  };

  const initialEffectData = buildCustomEffectData(builderState, parentState, {
    includeChanges: true
  });

  // Draft is disabled so it does not affect mechanics while the sheet is open.
  const draftData = clone(initialEffectData, {});
  draftData.name = `[AEM Draft] ${safeString(draftData.name, "Custom Active Effect")}`;
  draftData.label = draftData.name;
  draftData.disabled = true;
  draftData.flags = draftData.flags || {};
  draftData.flags[MODULE_ID] = draftData.flags[MODULE_ID] || {};
  draftData.flags[MODULE_ID].aemNativeDraft = true;

  let draft = null;

  try {
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [draftData], {
      render: false
    });

    draft = created?.[0] ?? null;
  } catch (e) {
    const report = {
      ok: false,
      reason: "draft_create_failed",
      actor: actor.name,
      error: compactError(e)
    };

    updateOutput(parentRoot, parentState, report);
    ui.notifications?.error?.("Active Effect Manager: could not create temporary native sheet draft.");
    return report;
  }

  if (!draft) {
    const report = {
      ok: false,
      reason: "draft_not_created",
      actor: actor.name
    };

    updateOutput(parentRoot, parentState, report);
    return report;
  }

  const sheet = draft.sheet;

  if (!sheet?.render) {
    try {
      await draft.delete({ render: false });
    } catch (_e) {}

    const report = {
      ok: false,
      reason: "active_effect_sheet_not_found",
      actor: actor.name
    };

    updateOutput(parentRoot, parentState, report);
    return report;
  }

  BUILDER_DIALOG = sheet;

  return await new Promise(resolve => {
    let resolved = false;
    let observer = null;
    let dropdown = null;
    let renderTimer = null;
    let renderTries = 0;

    const hookIds = [];
    const originalClose = sheet.close?.bind(sheet);

    const cleanup = () => {
      if (renderTimer) {
        clearInterval(renderTimer);
        renderTimer = null;
      }

      for (const h of hookIds) {
        try {
          Hooks.off(h.name, h.id);
        } catch (_e) {}
      }

      try {
        observer?.disconnect?.();
      } catch (_e) {}

      try {
        dropdown?.remove?.();
      } catch (_e) {}

      if (BUILDER_DIALOG === sheet) BUILDER_DIALOG = null;
    };

    const deleteDraft = async () => {
      try {
        if (draft && !draft.deleted) {
          await draft.delete({ render: false });
        }
      } catch (e) {
        warn("Could not delete AEM native draft effect.", e);
      }
    };

    const finish = async (payload, { closeSheet = true, deleteTheDraft = true } = {}) => {
      if (resolved) return;
      resolved = true;

      cleanup();

      if (deleteTheDraft) {
        await deleteDraft();
      }

      if (closeSheet && originalClose) {
        try {
          await originalClose();
        } catch (_e) {}
      }

      resolve(payload);
    };

    const handleSubmit = async (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      ev?.stopImmediatePropagation?.();

      try {
        const finalEffectData = readNativeFormData(
          sheet,
          initialEffectData,
          parentState.customCategory ?? "Other"
        );

        // Remove draft prefix if the native form kept it.
        finalEffectData.name = String(finalEffectData.name ?? "")
          .replace(/^\[AEM Draft\]\s*/i, "")
          .trim() || "Custom Active Effect";

        finalEffectData.label = finalEffectData.name;

        const finalCategory = inferCategoryFromNativeEffect(
          finalEffectData,
          parentState.customCategory ?? "Other"
        );

        parentState.customName = finalEffectData.name;
        parentState.customCategory = finalCategory;
        parentState.customIcon = finalEffectData.img ?? finalEffectData.icon ?? "icons/svg/aura.svg";
        parentState.customStatuses = Array.isArray(finalEffectData.statuses)
          ? finalEffectData.statuses.join(", ")
          : "";
        parentState.customDescription = finalEffectData.description ?? "";
        parentState.customRows = (clone(finalEffectData.changes, []) ?? []).map(row => ({
          id: randomId("mod"),
          key: row.key ?? "",
          mode: Number(row.mode ?? modeValue("ADD")),
          value: String(row.value ?? ""),
          priority: Number(row.priority ?? 20)
        }));

        addSelectedCustomEffect(parentState, finalEffectData, finalCategory);
        rerender(parentRoot, parentState);

        const report = {
          ok: true,
          action: "custom_native_effect_queued",
          actorParent: actor.name,
          effectName: finalEffectData.name,
          category: finalCategory,
          changes: finalEffectData.changes ?? []
        };

        updateOutput(parentRoot, parentState, report);
        ui.notifications?.info?.(`Queued custom effect: ${finalEffectData.name}`);

        await finish(report, {
          closeSheet: true,
          deleteTheDraft: true
        });
      } catch (e) {
        console.error(`${TAG} Native custom effect submit failed.`, e);

        const report = {
          ok: false,
          reason: "native_custom_effect_submit_failed",
          error: compactError(e)
        };

        updateOutput(parentRoot, parentState, report);
        ui.notifications?.error?.("Active Effect Manager: native sheet submit failed. Check console.");
      }
    };

    const installIntoSheet = async () => {
      const root = getSheetRoot(sheet);
      if (!root) return false;

      ensureNativeSuggestionStyle();
      await refreshNativeFieldCatalogue(actor);

      // Visually default the final queued effect to enabled, while the real draft
      // document remains disabled in the background.
      const disabledBox = root.querySelector('input[name="disabled"]');
      if (disabledBox && !disabledBox.dataset.oniAemNativeDefaulted) {
        disabledBox.dataset.oniAemNativeDefaulted = "1";
        disabledBox.checked = false;
      }

      const nameInput = root.querySelector('input[name="name"]');
      if (nameInput && /^\[AEM Draft\]\s*/i.test(nameInput.value)) {
        nameInput.value = nameInput.value.replace(/^\[AEM Draft\]\s*/i, "");
      }

      const form = root.querySelector("form") ?? sheet.form ?? null;

      if (form && !form.dataset.oniAemSubmitCaptured) {
        form.dataset.oniAemSubmitCaptured = "1";
        form.addEventListener("submit", handleSubmit, true);
      }

      if (!root.dataset.oniAemSubmitButtonCaptured) {
        root.dataset.oniAemSubmitButtonCaptured = "1";

        root.addEventListener("click", ev => {
          const btn = ev.target.closest?.('button[data-action="submit"], button[data-action="save"], button[type="submit"]');
          if (!btn) return;

          if (String(btn.getAttribute("type") ?? "").toLowerCase() === "submit") return;

          handleSubmit(ev);
        }, true);
      }

      if (!dropdown) {
        dropdown = document.createElement("div");
        dropdown.className = SUGGESTION_CLASS;
        dropdown.dataset.sheetId = String(sheet.appId ?? sheet.id ?? "native");
        document.body.appendChild(dropdown);

        document.addEventListener("mousedown", ev => {
          if (dropdown.contains(ev.target)) return;
          dropdown.style.display = "none";
        });
      }

      const bindFields = () => {
        const fields = findNativeAttributeKeyFields(root);
        for (const field of fields) {
          bindSuggestionDropdownToField(field, dropdown);
        }
      };

      bindFields();

      if (!observer) {
        observer = new MutationObserver(() => bindFields());
        observer.observe(root, {
          childList: true,
          subtree: true
        });
      }

      return true;
    };

    const hookNames = [
      "renderActiveEffectConfig",
      "renderCustomActiveEffectConfig"
    ];

    for (const name of hookNames) {
      const id = Hooks.on(name, app => {
        if (app !== sheet) return;
        installIntoSheet();
      });

      hookIds.push({ name, id });
    }

    if (originalClose && !sheet.__oniAemNativeBuilderClosePatched) {
      sheet.__oniAemNativeBuilderClosePatched = true;

      sheet.close = async (...args) => {
        if (!resolved) {
          await finish({
            ok: false,
            reason: "closed"
          }, {
            closeSheet: false,
            deleteTheDraft: true
          });
        }

        return await originalClose(...args);
      };
    }

    try {
      sheet.render(true);

      renderTimer = setInterval(async () => {
        renderTries += 1;

        if (resolved) {
          clearInterval(renderTimer);
          return;
        }

        const ok = await installIntoSheet();

        if (ok) {
          clearInterval(renderTimer);
          renderTimer = null;
          return;
        }

        // Prevent the manager button from staying grey forever if Foundry/CSB
        // throws during render before our sheet hook can finish.
        if (renderTries >= 30) {
          const report = {
            ok: false,
            reason: "native_sheet_render_timeout",
            actor: actor.name,
            hint: "The native sheet did not finish rendering. Check the console error above."
          };

          updateOutput(parentRoot, parentState, report);
          ui.notifications?.error?.("Active Effect Manager: native sheet failed to render.");

          await finish(report, {
            closeSheet: true,
            deleteTheDraft: true
          });
        }
      }, 100);
    } catch (e) {
      finish({
        ok: false,
        reason: "sheet_render_failed",
        actor: actor.name,
        error: compactError(e)
      }, {
        closeSheet: false,
        deleteTheDraft: true
      });
    }
  });
}

  // --------------------------------------------------------------------------
  // Apply action
  // --------------------------------------------------------------------------

  async function applySelected(root, state) {
    const manager = getManagerApi();

    if (!manager?.applyEffects) {
      updateOutput(root, state, {
        ok: false,
        reason: "active_effect_manager_api_not_found"
      });
      return;
    }

    if (!state.targetActorUuids.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_target_actors",
        hint: "Choose at least one target portrait first."
      });
      return;
    }

    if (!state.selectedEffects.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_selected_effects",
        hint: "Add at least one effect first."
      });
      return;
    }

    const effects = state.selectedEffects.map(sel => {
      if (sel.kind === "registry") return sel.registryId;
      return { effectData: clone(sel.effectData, {}) };
    });

    const duration = getGlobalDurationFromState(state);

    const result = await manager.applyEffects({
      actorUuids: state.targetActorUuids,
      effects,
      duplicateMode: state.duplicateMode,
      duration,
      silent: state.silent,
      renderChat: true,
      playFx: true
    });

    updateOutput(root, state, result);
  }

  // --------------------------------------------------------------------------
  // Main open function
  // --------------------------------------------------------------------------

  async function open() {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Active Effect Manager UI is GM-only.");
      return null;
    }

    injectStyle();

    if (ACTIVE_DIALOG) {
      try {
        ACTIVE_DIALOG.bringToTop?.();
        return ACTIVE_DIALOG;
      } catch (_e) {}
    }

    const state = {
      targetRows: [],
      targetActorUuids: [],
      targetSourceLabel: "",

      registryEntries: [],
      fieldEntries: [],

      selectedEffects: [],

      categoryFilter: "All",
      search: "",

      duplicateMode: "skip",
      overrideDuration: true,
      durationRounds: 3,
      durationTurns: 0,
      silent: false,

      customName: "Custom Active Effect",
      customCategory: "Buff",
      customIcon: "icons/svg/aura.svg",
      customStatuses: "",
      customDescription: "",
      customRows: [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }],

      outputText: ""
    };

    try {
      await reloadTargets(state);
    } catch (e) {
      warn("Initial target load failed.", e);
      state.targetSourceLabel = `Target load failed: ${compactError(e)}`;
    }

    try {
      await refreshRegistry(state, { includeCompendiums: false });
    } catch (e) {
      warn("Initial registry refresh failed.", e);
      state.outputText = JSON.stringify({ registryRefreshFailed: compactError(e) }, null, 2);
    }

    try {
      await refreshFields(state);
    } catch (e) {
      warn("Initial field catalogue refresh failed.", e);
    }

    const dialog = new Dialog({
      title: "Active Effect Manager",
      content: `
        <div data-aem-root-holder>
          ${renderMainContent(state)}
        </div>
      `,
      buttons: {
        close: {
          label: "Close"
        }
      },
      default: "close",
      render: (html) => {
        const root = normalizeHtmlRoot(html);
        if (!root) return;

        const holder = root.querySelector("[data-aem-root-holder]");
        if (!holder) return;

holder.addEventListener("input", (ev) => {
  const target = ev.target;
  if (!target) return;

  readCommonStateFromDom(root, state);

  if (target.name === "effectSearch") {
    rerenderEffectListOnly(root, state);
  }
});

        holder.addEventListener("change", async (ev) => {
          const target = ev.target;
          if (!target) return;

          readCommonStateFromDom(root, state);

          if (target.name === "targetActorUuids") {
            updateTargetSelectionDom(root, state);

            // Refresh field suggestions in the background.
            // Important: do not rerender the full UI here, or target videos/images blink.
            refreshFieldsQuietly(state);
          }
        });

                holder.addEventListener("contextmenu", (ev) => {
          const selectedBadge = ev.target.closest?.("[data-aem-selected-effect]");
          const registryRow = ev.target.closest?.("[data-aem-registry-row]");

          if (!selectedBadge && !registryRow) return;

          ev.preventDefault();
          ev.stopPropagation();

          readCommonStateFromDom(root, state);

          // Right-click selected badge = remove that exact queued effect.
          if (selectedBadge) {
            const id = selectedBadge.dataset.selectedId;
            state.selectedEffects = state.selectedEffects.filter(e => e.id !== id);
            rerender(root, state);
            return;
          }

          // Right-click registry row = remove one matching queued copy.
          const entry = findRegistryEntry(state, registryRow.dataset.registryId);
          const result = removeSelectedRegistryEffect(state, entry);

          if (!result.ok) {
            ui.notifications?.info?.(`${entry?.name ?? "That effect"} is not currently queued.`);
            return;
          }

          rerender(root, state);
        });

        holder.addEventListener("click", async (ev) => {
          const btn = ev.target.closest?.("[data-aem-action]");
          if (!btn) return;

          ev.preventDefault();
          ev.stopPropagation();

          const action = btn.dataset.aemAction;

          try {
            btn.disabled = true;
            readCommonStateFromDom(root, state);

            if (action === "set-category") {
              state.categoryFilter = btn.dataset.category || "All";
              rerender(root, state);
              return;
            }

            if (action === "refresh-registry") {
              const result = await refreshRegistry(state, { includeCompendiums: false });
              updateOutput(root, state, result);
              rerender(root, state);
              return;
            }

            if (action === "refresh-registry-compendiums") {
              const result = await refreshRegistry(state, { includeCompendiums: true });
              updateOutput(root, state, result);
              rerender(root, state);
              return;
            }

            if (action === "debug-registry") {
              const registry = getRegistryApi();
              const report = registry?.getLastReport?.() ?? {
                ok: false,
                reason: "registry_api_not_found"
              };

              console.groupCollapsed(`${TAG} Registry Debug`);
              console.log(report);
              console.groupEnd();

              updateOutput(root, state, report);
              return;
            }

            if (action === "add-registry-effect") {
              const entry = findRegistryEntry(state, btn.dataset.registryId);
              addSelectedRegistryEffect(state, entry);
              rerender(root, state);
              return;
            }

            if (action === "remove-selected-effect") {
              const id = btn.dataset.selectedId;
              state.selectedEffects = state.selectedEffects.filter(e => e.id !== id);
              rerender(root, state);
              return;
            }

            if (action === "clear-selected-effects") {
              state.selectedEffects = [];
              rerender(root, state);
              return;
            }

            if (action === "open-custom-builder") {
              await openCustomBuilderDialog(state, root);
              return;
            }

            if (action === "apply-selected") {
              await applySelected(root, state);
              return;
            }
          } catch (e) {
            err("UI action failed.", { action, error: e });

            updateOutput(root, state, {
              ok: false,
              action,
              error: compactError(e)
            });
          } finally {
            btn.disabled = false;
          }
        });
      },
      close: () => {
        ACTIVE_DIALOG = null;
      }
    }, {
      width: 980,
      height: "auto",
      resizable: true
    });

    ACTIVE_DIALOG = dialog;
    dialog.render(true);

    return dialog;
  }

  // --------------------------------------------------------------------------
  // Expose API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.4.0",
    open,
    reopen: () => {
      try {
        ACTIVE_DIALOG?.close?.();
      } catch (_e) {}
      ACTIVE_DIALOG = null;
      return open();
    },
    getActiveDialog: () => ACTIVE_DIALOG,
    reloadTargets
  };

  const root = ensureApiRoot();
  root.ui = api;
  root.openUI = open;

  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.activeEffectManager = mod.api.activeEffectManager || {};
      mod.api.activeEffectManager.ui = api;
      mod.api.activeEffectManager.openUI = open;
    }
  } catch (e) {
    warn("Could not expose UI API on module object.", e);
  }

  Hooks.once("ready", () => {
    const root = ensureApiRoot();
    root.ui = api;
    root.openUI = open;

    log("Ready. Active Effect Manager UI installed.", {
      open: "FUCompanion.api.activeEffectManager.ui.open()"
    });
  });
})();