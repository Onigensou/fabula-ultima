/**
 * [ONI] Journal System — MODULE CORE (v1.1)
 * Foundry VTT v12
 *
 * What it does:
 * - Auto-installs after Foundry is ready
 * - Reads Tile flags from flags.oni-journal-system.*
 * - Uses a proximity overlay button (same style as Treasure Chest system)
 * - Opens linked JournalEntry / JournalEntryPage with Foundry's built-in Journal.show()
 * - No tile macro needed
 *
 * Saved flags expected:
 * flags.oni-journal-system = {
 *   isJournalTile: true,
 *   journalUuid: "JournalEntry.xxx or JournalEntryPage.xxx",
 *   journalName: "Optional cached display name",
 *   journalType: "JournalEntry or JournalEntryPage",
 *   openMode: "ALL" | "CALLER",
 *   grantObserver: false,
 *   proximityPx: 120
 * }
 */

(() => {
  const TAG = "[ONI][JournalSystem]";
  const DEBUG = true;

  // ─────────────────────────────────────────────────────────────
  // Global namespace + guard
  // ─────────────────────────────────────────────────────────────
  window.oni = window.oni || {};
  window.oni.JournalSystem = window.oni.JournalSystem || {};

  const CORE_KEY = "Core";
  if (window.oni.JournalSystem[CORE_KEY]?.installed) {
    DEBUG && console.log(TAG, "Already installed; skipping.");
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────
  const SCOPE = "oni-journal-system";

  const CHANNELS = ["module.fabula-ultima-companion", "fabula-ultima-companion"];
  const MSG_OPEN_REQ = "ONI_JOURNAL_OPEN_REQ_V1";
  const MSG_OPEN_DONE = "ONI_JOURNAL_OPEN_DONE_V1";

  const POS_OVERRIDE_TTL_MS = 800;

  const BOOK_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book2.ogg";

  const REQUIRE_PROXIMITY = true;
  const DEFAULT_DISTANCE_PX = 120;
  const GM_BYPASS_DISTANCE = false;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────
  const worldToScreen = (x, y) => {
    const t = canvas?.stage?.worldTransform;
    if (!t) return { x, y };
    return { x: (t.a * x) + t.tx, y: (t.d * y) + t.ty };
  };

  const getTileCenter = (tile) => {
    const d = tile?.document ?? tile;
    const x = (d?.x ?? 0) + ((d?.width ?? 0) / 2);
    const y = (d?.y ?? 0) + ((d?.height ?? 0) / 2);
    return { x, y };
  };

  const getTokenCenterPx = (token, overrideXY = null) => {
    const doc = token?.document;
    const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
    const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
    const w = token?.w ?? 0;
    const h = token?.h ?? 0;
    return { x: baseX + (w / 2), y: baseY + (h / 2) };
  };

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const normalizeBoolean = (raw, fallback = false) => {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;

    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }
    return fallback;
  };

  const normalizeDistancePx = (raw, fallback = DEFAULT_DISTANCE_PX) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(40, Math.round(n));
  };

  const playBookSfx = () => {
    try {
      if (foundry?.audio?.AudioHelper?.play) {
        foundry.audio.AudioHelper.play({ src: BOOK_SFX, volume: 0.8, loop: false }, true);
        log("Book SFX played via foundry.audio.AudioHelper:", BOOK_SFX);
        return;
      }
    } catch (e) {
      warn("Book SFX failed on foundry.audio.AudioHelper:", e);
    }

    try {
      if (typeof AudioHelper !== "undefined" && AudioHelper?.play) {
        AudioHelper.play({ src: BOOK_SFX, volume: 0.8, autoplay: true, loop: false }, true);
        log("Book SFX played via legacy AudioHelper:", BOOK_SFX);
        return;
      }
    } catch (e) {
      warn("Book SFX failed on legacy AudioHelper:", e);
    }

    warn("No usable audio helper found for BOOK_SFX.");
  };

  // ─────────────────────────────────────────────────────────────
  // DB Resolver / party token
  // ─────────────────────────────────────────────────────────────
  const resolveCurrentDbContext = async () => {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) {
      ui.notifications?.error?.("DB Resolver missing: window.FUCompanion.api.getCurrentGameDb()");
      return { db: null, source: null };
    }

    const cache = await api.getCurrentGameDb();
    const db = cache?.db ?? null;
    const source = cache?.source ?? null;

    if (!db) ui.notifications?.warn?.("No current game DB Actor found.");

    log("DB resolve:", {
      dbName: db?.name,
      dbUuid: db?.uuid,
      sourceName: source?.name,
      sourceId: source?.id
    });

    return { db, source };
  };

  const resolvePartyToken = async () => {
    if (!canvas?.ready) return null;

    const controlled = canvas.tokens?.controlled?.[0];
    if (controlled) {
      log("Party token resolved from controlled token:", {
        tokenId: controlled.id,
        tokenName: controlled.name
      });
      return controlled;
    }

    const { db, source } = await resolveCurrentDbContext();
    if (!db) return null;

    const tokens = canvas.tokens?.placeables ?? [];

    const dbToken =
      tokens.find(t => t?.actor?.id === db.id) ??
      (source ? tokens.find(t => t?.actor?.id === source.id) : null) ??
      tokens.find(t => (t?.name === db.name) || (t?.actor?.name === db.name)) ??
      null;

    if (!dbToken) {
      warn("Party/DB token not found on current scene.", {
        dbId: db?.id,
        dbName: db?.name,
        sourceId: source?.id,
        sourceName: source?.name,
        sceneTokens: tokens.map(t => ({
          id: t.id,
          name: t.name,
          actorName: t.actor?.name,
          actorId: t.actor?.id
        }))
      });
      return null;
    }

    log("Party token resolved from DB resolver:", {
      tokenId: dbToken.id,
      tokenName: dbToken.name
    });

    return dbToken;
  };

  // ─────────────────────────────────────────────────────────────
  // Journal flags read
  // ─────────────────────────────────────────────────────────────
  const findJournalConfigObject = (tileDoc) => {
    const flags = tileDoc?.flags ?? {};

    for (const [scope, scopeObj] of Object.entries(flags)) {
      if (!scopeObj || typeof scopeObj !== "object") continue;

      for (const [key, val] of Object.entries(scopeObj)) {
        if (val && typeof val === "object" && ("isJournalTile" in val)) {
          return { scope, key, data: val };
        }
      }

      if ("isJournalTile" in scopeObj) {
        return { scope, key: null, data: scopeObj };
      }
    }

    return { scope: null, key: null, data: null };
  };

  const readJournalData = (tile) => {
    const doc = tile?.document ?? tile;
    const found = findJournalConfigObject(doc);
    const data = found?.data ?? {};

    return {
      isJournal: !!data?.isJournalTile,
      isHidden: !!doc?.hidden,
      journalUuid: String(data?.journalUuid ?? "").trim(),
      journalName: String(data?.journalName ?? "").trim(),
      journalType: String(data?.journalType ?? "").trim(),
      openMode: String(data?.openMode ?? "ALL").trim().toUpperCase() || "ALL",
      grantObserver: normalizeBoolean(data?.grantObserver, false),
      proximityPx: normalizeDistancePx(data?.proximityPx, DEFAULT_DISTANCE_PX),
      _scope: found?.scope ?? null,
      _raw: data
    };
  };

  const isValidJournalDoc = (doc) => {
    if (!doc) return false;
    return doc.documentName === "JournalEntry" || doc.documentName === "JournalEntryPage";
  };

  // ─────────────────────────────────────────────────────────────
  // Proximity check
  // ─────────────────────────────────────────────────────────────
  const checkProximityForTile = async (tileDoc, { notify = false } = {}) => {
    if (!REQUIRE_PROXIMITY) return true;

    if (game.user.isGM && GM_BYPASS_DISTANCE) {
      log("GM bypass enabled — skipping distance check.");
      return true;
    }

    const partyTok = await resolvePartyToken();
    if (!partyTok) {
      if (notify) ui.notifications?.warn?.(`${TAG} Party/DB token not found on this scene (distance check blocked).`);
      warn("Distance check blocked: no party token found.");
      return false;
    }

    const journalData = readJournalData(tileDoc);
    const maxDistancePx = normalizeDistancePx(journalData?.proximityPx, DEFAULT_DISTANCE_PX);

    const tileCenter = getTileCenter(tileDoc);
    const tokenCenter = partyTok.center ?? getTokenCenterPx(partyTok, null);
    const d = dist(tileCenter, tokenCenter);

    log("Distance check:", {
      max: maxDistancePx,
      dist: Math.round(d),
      token: { id: partyTok.id, name: partyTok.name },
      tile: { id: tileDoc.id, name: tileDoc.name }
    });

    if (d > maxDistancePx) {
      if (notify) ui.notifications?.warn?.(`${TAG} You are too far away to read this note.`);
      return false;
    }

    return true;
  };

  // ─────────────────────────────────────────────────────────────
  // Journal opening helpers
  // ─────────────────────────────────────────────────────────────
  const grantObserverPermission = async (entry, openMode, callerUserId) => {
    if (!entry || entry.documentName !== "JournalEntry") return;

    try {
      const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
      const next = foundry.utils.duplicate(entry.ownership ?? {});

      if (openMode === "ALL") {
        for (const u of game.users) {
          if (u.isGM) continue;
          if ((next[u.id] ?? 0) < OBSERVER) next[u.id] = OBSERVER;
        }
      } else {
        const caller = game.users.get(callerUserId);
        if (caller && !caller.isGM) {
          if ((next[caller.id] ?? 0) < OBSERVER) next[caller.id] = OBSERVER;
        } else {
          log("GrantObserver fallback reached in CALLER mode; no valid player caller found.");
        }
      }

      const changed = JSON.stringify(next) !== JSON.stringify(entry.ownership ?? {});
      if (changed) {
        await entry.update({ ownership: next });
        log("Observer permission updated:", {
          entry: entry.name,
          entryId: entry.id,
          openMode,
          callerUserId
        });
      } else {
        log("Observer permission unchanged:", { entry: entry.name });
      }
    } catch (e) {
      warn("Permission update failed:", e);
    }
  };

  const showJournalToPlayers = async (doc, openMode, callerUserId) => {
    try {
      if (openMode === "CALLER") {
        const caller = game.users.get(callerUserId);

        if (caller && !caller.isGM) {
          await Journal.show(doc, { force: true, users: [callerUserId] });
          log("Journal.show completed for CALLER:", {
            callerUserId,
            docName: doc?.name,
            docType: doc?.documentName
          });
        } else {
          log("CALLER mode was requested by GM or invalid caller; skipping player broadcast.", {
            callerUserId
          });
        }

        return;
      }

      await Journal.show(doc, { force: true });
      log("Journal.show completed for ALL players:", {
        docName: doc?.name,
        docType: doc?.documentName
      });
    } catch (e) {
      err("Journal.show failed:", e);
      ui.notifications?.warn?.(`${TAG} Could not show journal to players (see console).`);
    }
  };

  const openJournalLocallyForGM = async (doc) => {
    try {
      if (!doc) return;

      if (doc.documentName === "JournalEntryPage") {
        const parent = doc.parent;
        parent?.sheet?.render(true);

        setTimeout(() => {
          try {
            if (parent?.sheet?.goToPage) parent.sheet.goToPage(doc.id);
            else parent?.sheet?.render(true);
          } catch (e) {
            warn("Failed to go to JournalEntryPage locally for GM:", e);
          }
        }, 50);

        log("Opened JournalEntryPage locally for GM:", {
          pageId: doc.id,
          pageName: doc.name,
          parentName: parent?.name
        });
        return;
      }

      doc.sheet?.render(true);
      log("Opened JournalEntry locally for GM:", {
        entryId: doc.id,
        entryName: doc.name
      });
    } catch (e) {
      warn("Local GM open failed:", e);
    }
  };

  // ─────────────────────────────────────────────────────────────
  // UI overlay
  // ─────────────────────────────────────────────────────────────
  const CSS_ID = "oni-journal-system-style";

  const ensureCSS = () => {
    if (document.getElementById(CSS_ID)) return;

    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
#oni-journal-ui-layer {
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 60;
}

.oni-journal-btn {
  position: absolute;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 999px;
  background: rgba(30,30,30,.85);
  border: 1px solid rgba(255,255,255,.18);
  box-shadow: 0 10px 22px rgba(0,0,0,.35);
  font-size: 20px;
  line-height: 1;
  opacity: 0;
  transform: translate(-50%,-50%) scale(.85);
  transition: opacity 180ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
}

.oni-journal-btn.is-visible {
  opacity: 1;
  transform: translate(-50%,-50%) scale(1);
}

.oni-journal-btn.is-hiding {
  opacity: 0;
  transform: translate(-50%,-50%) scale(.78);
}
    `;

    document.head.appendChild(style);
    log("Injected CSS:", CSS_ID);
  };

  class JournalUI {
    constructor(core) {
      this.core = core;
      this.layer = null;
      this.buttons = new Map();
      this.desired = new Set();
      this.opening = new Set();
    }

    start() {
      if (this.layer) return;

      ensureCSS();
      this.layer = document.createElement("div");
      this.layer.id = "oni-journal-ui-layer";
      document.body.appendChild(this.layer);
      log("UI layer created.");
    }

    stop() {
      for (const el of this.buttons.values()) el.remove();
      this.buttons.clear();
      this.desired.clear();
      this.opening.clear();
      this.layer?.remove();
      this.layer = null;
      log("UI layer removed.");
    }

    setDesired(desiredSet) {
      this.desired = new Set(desiredSet);

      for (const tileId of this.desired) {
        if (this.buttons.has(tileId)) continue;

        const tile = canvas.tiles?.get(tileId);
        const data = tile ? readJournalData(tile) : null;

        const btn = document.createElement("button");
        btn.className = "oni-journal-btn";
        btn.type = "button";
        btn.title = data?.journalName ? `Read: ${data.journalName}` : "Read Note";
        btn.textContent = "📖";

        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();

          if (this.opening.has(tileId)) return;
          this.opening.add(tileId);
          btn.disabled = true;

          try {
            await this.core.requestOpen(tileId);
          } finally {
            setTimeout(() => {
              this.opening.delete(tileId);
              btn.disabled = false;
            }, 350);
          }
        });

        this.layer.appendChild(btn);
        this.buttons.set(tileId, btn);
        requestAnimationFrame(() => btn.classList.add("is-visible"));

        log("UI button created for tile:", {
          tileId,
          journalName: data?.journalName ?? null
        });
      }

      for (const [tileId, btn] of Array.from(this.buttons.entries())) {
        if (this.desired.has(tileId)) continue;

        btn.classList.remove("is-visible");
        btn.classList.add("is-hiding");

        setTimeout(() => {
          btn.remove();
          this.buttons.delete(tileId);
          log("UI button removed for tile:", tileId);
        }, 220);
      }
    }

    repositionAll() {
      for (const [tileId, btn] of this.buttons.entries()) {
        const tile = canvas.tiles?.get(tileId);
        if (!tile) continue;

        const c = getTileCenter(tile);
        const s = worldToScreen(c.x, c.y);
        btn.style.left = `${s.x}px`;
        btn.style.top = `${s.y - 32}px`;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GM open logic
  // ─────────────────────────────────────────────────────────────
  const gmOpenJournal = async ({ sceneId, tileId, requesterId }) => {
    log("GM open request received:", { sceneId, tileId, requesterId });

    const scene = game.scenes?.get(sceneId);
    if (!scene) return warn("GM open: scene not found:", sceneId);

    const tileDoc = scene.tiles?.get(tileId);
    if (!tileDoc) return warn("GM open: tile not found:", tileId);

    if (tileDoc.hidden) {
      warn("GM open: blocked because tile is hidden.", { tileId });
      return;
    }

    const data = readJournalData(tileDoc);
    log("GM open: read journal data:", data);

    if (!data.isJournal) {
      warn("GM open: not a journal tile, aborting.", { tileId });
      return;
    }

    if (!data.journalUuid) {
      ui.notifications?.error?.(`${TAG} This journal tile has no linked journal UUID.`);
      warn("GM open: journalUuid missing.", { tileId, data });
      return;
    }

    const inRange = await checkProximityForTile(tileDoc, { notify: true });
    if (!inRange) {
      warn("GM open: blocked by distance check.", { tileId, proximityPx: data.proximityPx });
      return;
    }

    let doc = null;
    try {
      doc = await fromUuid(data.journalUuid);
      log("GM open: fromUuid resolved:", {
        uuid: data.journalUuid,
        docName: doc?.name,
        docType: doc?.documentName
      });
    } catch (e) {
      err("GM open: fromUuid failed:", e);
      ui.notifications?.error?.(`${TAG} Failed to resolve journal UUID. See console.`);
      return;
    }

    if (!isValidJournalDoc(doc)) {
      warn("GM open: resolved document is not a JournalEntry or JournalEntryPage.", {
        uuid: data.journalUuid,
        resolvedDocumentName: doc?.documentName
      });
      ui.notifications?.error?.(`${TAG} Linked document is not a JournalEntry or JournalEntryPage.`);
      return;
    }

    const entry = (doc.documentName === "JournalEntryPage") ? doc.parent : doc;

    if (data.grantObserver) {
      await grantObserverPermission(entry, data.openMode, requesterId);
    }

    playBookSfx();

    await showJournalToPlayers(doc, data.openMode, requesterId);
    await openJournalLocallyForGM(doc);

    for (const ch of CHANNELS) {
      try {
        game.socket.emit(ch, {
          type: MSG_OPEN_DONE,
          payload: {
            sceneId,
            tileId,
            requesterId,
            journalUuid: data.journalUuid
          }
        });
      } catch (e) {
        warn("GM open: failed to emit OPEN_DONE on socket:", { channel: ch, error: e });
      }
    }

    log("GM open completed.", {
      sceneId,
      tileId,
      requesterId,
      journalUuid: data.journalUuid,
      openMode: data.openMode,
      proximityPx: data.proximityPx
    });
  };

  // ─────────────────────────────────────────────────────────────
  // Core object
  // ─────────────────────────────────────────────────────────────
  const core = {
    installed: true,
    running: false,

    ui: null,
    _hooks: [],
    _socketFn: null,

    _posOverrides: new Map(),
    _scanQueued: false,

    _setOverride(tokenId, x, y) {
      this._posOverrides.set(tokenId, { x, y, ts: Date.now() });
      log("Pos override set:", { tokenId, x, y });
    },

    _getOverride(tokenId) {
      const o = this._posOverrides.get(tokenId);
      if (!o) return null;

      if ((Date.now() - o.ts) > POS_OVERRIDE_TTL_MS) {
        this._posOverrides.delete(tokenId);
        return null;
      }

      return o;
    },

    _cleanupOverrides() {
      const now = Date.now();
      for (const [tid, o] of this._posOverrides.entries()) {
        if ((now - o.ts) > POS_OVERRIDE_TTL_MS) this._posOverrides.delete(tid);
      }
    },

    _queueScan(reason = "unknown") {
      if (this._scanQueued) return;
      this._scanQueued = true;

      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          this._scanQueued = false;
          await this.scan(reason);
        });
      });
    },

    async scan(reason = "scan") {
      try {
        if (!canvas?.ready) return;
        if (!this.running) return;

        this._cleanupOverrides();

        const partyTok = await resolvePartyToken();
        if (!partyTok) {
          this.ui?.setDesired(new Set());
          warn("Scan aborted: no party token resolved.", { reason });
          return;
        }

        const ov = this._getOverride(partyTok.id);
        const partyCenter = getTokenCenterPx(partyTok, ov ? { x: ov.x, y: ov.y } : null);

        const tiles = canvas.tiles?.placeables ?? [];
        const desired = new Set();

        for (const t of tiles) {
          const jd = readJournalData(t);

          if (!jd.isJournal) continue;
          if (jd.isHidden) continue;
          if (!jd.journalUuid) continue;

          const tc = getTileCenter(t);
          const d = dist(partyCenter, tc);
          const rangePx = normalizeDistancePx(jd.proximityPx, DEFAULT_DISTANCE_PX);

          if (d <= rangePx) desired.add(t.id);
        }

        log("Scan result:", {
          reason,
          defaultRangePx: DEFAULT_DISTANCE_PX,
          desired: Array.from(desired),
          override: ov ?? null
        });

        this.ui?.setDesired(desired);
        this.ui?.repositionAll();
      } catch (e) {
        err("scan failed:", e);
      }
    },

    async requestOpen(tileId) {
      try {
        const sceneId = canvas.scene?.id;
        if (!sceneId) return;

        log("requestOpen called:", {
          tileId,
          sceneId,
          userId: game.user.id,
          isGM: game.user.isGM
        });

        if (game.user.isGM) {
          await gmOpenJournal({
            sceneId,
            tileId,
            requesterId: game.user.id
          });
          this._queueScan("after-gm-open");
          return;
        }

        const payload = {
          sceneId,
          tileId,
          requesterId: game.user.id
        };

        for (const ch of CHANNELS) {
          try {
            game.socket.emit(ch, { type: MSG_OPEN_REQ, payload });
            log("Socket emit:", { channel: ch, type: MSG_OPEN_REQ, payload });
            break;
          } catch (e) {
            warn("Socket emit failed on:", ch, e);
          }
        }
      } catch (e) {
        err("requestOpen failed:", e);
      }
    },

    async start() {
      if (this.running) return;

      if (!canvas?.ready) {
        warn("start() called but canvas is not ready yet.");
        return;
      }

      this.ui = new JournalUI(this);
      this.ui.start();

      this._socketFn = async (msg) => {
        try {
          if (!msg?.type) return;

          if (msg.type === MSG_OPEN_REQ) {
            log("Socket RX OPEN_REQ:", msg);
            if (!game.user.isGM) return;

            await gmOpenJournal(msg.payload);
            this._queueScan("after-socket-open");
          }

          if (msg.type === MSG_OPEN_DONE) {
            log("Socket RX OPEN_DONE:", msg);
            this._queueScan("after-open-done");
          }
        } catch (e) {
          err("socket handler error:", e);
        }
      };

      for (const ch of CHANNELS) {
        try {
          game.socket.on(ch, this._socketFn);
          log("Socket listener installed on:", ch);
        } catch (e) {
          warn("Socket listener failed on:", ch, e);
        }
      }

      const onUpdateToken = async (tokenDoc, changes) => {
        const moved = ("x" in changes) || ("y" in changes);
        if (!moved) return;

        const afterX = ("x" in changes) ? changes.x : tokenDoc.x;
        const afterY = ("y" in changes) ? changes.y : tokenDoc.y;

        const partyTok = await resolvePartyToken();
        if (!partyTok) return;
        if (tokenDoc.id !== partyTok.id) return;

        this._setOverride(tokenDoc.id, afterX, afterY);
        this._queueScan("updateToken(move)");
      };

      const onCreateToken = () => this._queueScan("createToken");
      const onDeleteToken = () => this._queueScan("deleteToken");
      const onCreateTile = () => this._queueScan("createTile");
      const onDeleteTile = () => this._queueScan("deleteTile");
      const onUpdateTile = () => this._queueScan("updateTile");
      const onCanvasPan = () => this.ui?.repositionAll();
      const onCanvasReady = () => this._queueScan("canvasReady");
      const onResize = () => this.ui?.repositionAll();

      Hooks.on("updateToken", onUpdateToken);
      Hooks.on("createToken", onCreateToken);
      Hooks.on("deleteToken", onDeleteToken);
      Hooks.on("createTile", onCreateTile);
      Hooks.on("deleteTile", onDeleteTile);
      Hooks.on("updateTile", onUpdateTile);
      Hooks.on("canvasPan", onCanvasPan);
      Hooks.on("canvasReady", onCanvasReady);
      window.addEventListener("resize", onResize);

      this._hooks.push(["updateToken", onUpdateToken]);
      this._hooks.push(["createToken", onCreateToken]);
      this._hooks.push(["deleteToken", onDeleteToken]);
      this._hooks.push(["createTile", onCreateTile]);
      this._hooks.push(["deleteTile", onDeleteTile]);
      this._hooks.push(["updateTile", onUpdateTile]);
      this._hooks.push(["canvasPan", onCanvasPan]);
      this._hooks.push(["canvasReady", onCanvasReady]);
      this._hooks.push(["resize", onResize]);

      this.running = true;

      await this.scan("start");

      log("Journal System started.", {
        defaultRangePx: DEFAULT_DISTANCE_PX,
        POS_OVERRIDE_TTL_MS,
        REQUIRE_PROXIMITY,
        GM_BYPASS_DISTANCE
      });
    },

    async stop() {
      if (!this.running) return;

      for (const ch of CHANNELS) {
        try {
          game.socket.off(ch, this._socketFn);
        } catch (_) {}
      }

      for (const [evt, fn] of this._hooks) {
        try {
          if (evt === "resize") window.removeEventListener("resize", fn);
          else Hooks.off(evt, fn);
        } catch (_) {}
      }

      this._hooks = [];
      this._posOverrides.clear();
      this._scanQueued = false;

      this.ui?.stop();
      this.ui = null;

      this.running = false;
      log("Journal System stopped.");
    }
  };

  // Publish API
  window.oni.JournalSystem[CORE_KEY] = core;

  // ─────────────────────────────────────────────────────────────
  // Self-install after Foundry ready
  // ─────────────────────────────────────────────────────────────
  function boot() {
    if (canvas?.ready) {
      core.start();
    } else {
      Hooks.once("canvasReady", () => core.start());
    }
  }

  Hooks.once("ready", () => {
    log("Boot on ready.");
    boot();
  });

  log("Core installed (module). API: window.oni.JournalSystem.Core");
})();
