// ============================================================================
// Save System — Disk-backed Slot Storage
//
// Save blobs are stored as FILES on disk, NOT in world settings:
//   worlds/<world>/fu-saves/slot-<N>.json   full blob (only read on Load)
//   worlds/<world>/fu-saves/index.json      tiny per-slot preview (drives the UI)
//
// Why: world settings are serialized into the world-data payload vended to every
// client at login. A ~100 MB save blob in settings pushed the payload past V8's
// max-string limit, so two simultaneous logins OOM-crashed the host. Disk files
// are never part of that payload.
//
// API:
//   getSlot(i)       SYNC  → small preview (label/date/scene/party) for the UI
//   getSlotFull(i)   ASYNC → full blob, fetched from disk (used by load only)
//   setSlot(i, blob) ASYNC → write blob file + refresh index
//   deleteSlot(i)    ASYNC → clear index entry + blank the blob file
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const MOD = SS.MODULE_ID;
  const TAG = "[SaveSystem][Storage]";

  const saveDir   = () => `worlds/${game.world.id}/fu-saves`;
  const slotPath  = (i) => `${saveDir()}/slot-${i}.json`;
  const indexPath = () => `${saveDir()}/index.json`;

  // In-memory index cache ({ "1": preview|null, ... }). Loaded once on ready so
  // the synchronous getSlot() the UI relies on always has data available.
  SS._index = SS._index ?? {};
  let _indexLoaded = false;

  // MUST stay identical to buildPreview() in tools/safe-edit/_migrate-saves-to-disk.js
  function buildPreview(blob) {
    if (!blob) return null;
    const pa    = blob.data?.partyActorData ?? {};
    const props = pa.system?.props ?? {};
    const previewProps = {};
    if (props.game_name != null) previewProps.game_name = props.game_name;
    for (let i = 1; i <= 10; i++) {
      const k = `member_id_${i}`;
      if (props[k] != null) previewProps[k] = props[k];
    }
    return {
      label:   blob.label   ?? "",
      savedAt: blob.savedAt ?? "",
      version: blob.version ?? 1,
      data: {
        activeScene: {
          sceneId:   blob.data?.activeScene?.sceneId   ?? null,
          sceneName: blob.data?.activeScene?.sceneName ?? null,
        },
        partyActorData: {
          uuid:   pa.uuid ?? null,
          system: { props: previewProps },
        },
      },
    };
  }

  async function fetchJson(relPath) {
    try {
      const url  = foundry.utils.getRoute(relPath);
      const resp = await fetch(`${url}?t=${Date.now()}`); // cache-bust: files change in place
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn(TAG, `fetchJson failed for ${relPath}:`, e);
      return null;
    }
  }

  async function ensureDir() {
    try { await FilePicker.createDirectory("data", saveDir(), {}); }
    catch (e) { /* already exists — fine */ }
  }

  async function uploadJson(fileName, obj) {
    await ensureDir();
    const file = new File([JSON.stringify(obj)], fileName, { type: "application/json" });
    await FilePicker.upload("data", saveDir(), file, {}, { notify: false });
  }

  async function ensureIndex() {
    if (_indexLoaded) return;
    const idx = await fetchJson(indexPath());
    SS._index = (idx && typeof idx === "object") ? idx : {};
    _indexLoaded = true;
  }

  async function writeIndex() {
    await uploadJson("index.json", SS._index);
  }

  // ── Settings: only the NPC template id stays a (tiny) world setting ──────────
  Hooks.once("ready", async () => {
    try {
      game.settings.register(MOD, SS.SETTING.NPC_TEMPLATE, {
        scope:   "world",
        config:  true,
        type:    String,
        name:    "Save System: NPC Template Actor ID",
        hint:    "Short actor ID of the NPC/boss template. Linked actors built from this template are captured in saves. Change this when starting a new campaign with a different template.",
        default: "yegF6R8aaymhrvCg",
      });
    } catch { /* already registered */ }

    // Preload the slot index so the UI's synchronous getSlot() works immediately.
    try { await ensureIndex(); }
    catch (e) { console.warn(TAG, "index preload failed:", e); }

    console.debug(TAG, "Settings registered, index preloaded.");
  });

  SS.Storage = {
    // Synchronous preview for UI rendering (label/date/scene/party portraits).
    getSlot(i) {
      const p = SS._index?.[i] ?? SS._index?.[String(i)];
      return p ?? null;
    },

    // Full blob from disk — used only when actually loading a save.
    async getSlotFull(i) {
      const blob = await fetchJson(slotPath(i));
      return (blob && typeof blob === "object") ? blob : null;
    },

    async setSlot(i, blob) {
      if (!game.user?.isGM) { console.warn(TAG, "setSlot: GM only"); return; }
      await uploadJson(`slot-${i}.json`, blob);   // write the big blob first
      await ensureIndex();
      SS._index[String(i)] = buildPreview(blob);  // then the small preview
      await writeIndex();
    },

    async deleteSlot(i) {
      if (!game.user?.isGM) return;
      await ensureIndex();
      SS._index[String(i)] = null;
      await writeIndex();
      try { await uploadJson(`slot-${i}.json`, null); } catch { /* best-effort blank */ }
    },

    getNpcTemplateId() {
      try { return game.settings.get(MOD, SS.SETTING.NPC_TEMPLATE) || "yegF6R8aaymhrvCg"; }
      catch { return "yegF6R8aaymhrvCg"; }
    },
  };

  console.debug(TAG, "Storage loaded (disk-backed).");
})();
