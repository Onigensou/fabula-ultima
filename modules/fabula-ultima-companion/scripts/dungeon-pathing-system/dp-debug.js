// ============================================================================
// Dungeon Pathing System — Debug Bridge
//
// Captures structured log entries and (optionally) writes them to a JSON file
// that external tools can read without needing browser console access.
//
// Activation (browser console):
//   window.__DP_DEBUG_FILE__ = true          — enable auto-write on every entry
//   DungeonPathing.Debug.dump()              — manual write at any time
//   DungeonPathing.Debug.clear()             — wipe the buffer
//   DungeonPathing.Debug.entries             — read the in-memory buffer
//
// Output file: Data/dp-debug.json  (FoundryVTT data root)
// File path:   C:\Users\Oni\AppData\Local\FoundryVTT\Data\dp-debug.json
//
// Only GMs can write files via FilePicker; non-GM clients buffer in memory.
// ============================================================================
(() => {
  const DP  = globalThis.DungeonPathing ??= {};
  const TAG = "[DungeonPathing][Debug]";
  const FILE_NAME = "dp-debug.json";
  const MAX_ENTRIES = 300;

  const _buf = [];

  // ── Internal push ─────────────────────────────────────────────────────────
  function _push(level, source, msg) {
    _buf.push({ ts: Date.now(), level, source, msg });
    if (_buf.length > MAX_ENTRIES) _buf.shift();
    if (window.__DP_DEBUG_FILE__) _scheduleWrite();
  }

  // Debounce: coalesce rapid entries into a single FilePicker write
  let _writeTimer = null;
  function _scheduleWrite() {
    if (_writeTimer) return;
    _writeTimer = setTimeout(() => {
      _writeTimer = null;
      DP.Debug.dump().catch(() => {});
    }, 200);
  }

  function _serialize(...args) {
    return args.map(a => {
      if (a === null || a === undefined) return String(a);
      if (typeof a !== "object") return String(a);
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  DP.Debug = {
    /** Add a debug entry to the buffer (also written to file if __DP_DEBUG_FILE__ is set). */
    log(source, ...args)  { _push("debug", source, _serialize(...args)); },
    info(source, ...args) { _push("info",  source, _serialize(...args)); },
    warn(source, ...args) { _push("warn",  source, _serialize(...args)); },

    /** Write the current buffer to Data/dp-debug.json via FilePicker. GM-only. */
    async dump() {
      if (!game.user?.isGM) return; // FilePicker writes require GM role
      try {
        const payload = JSON.stringify({
          writtenAt: new Date().toISOString(),
          totalEntries: _buf.length,
          entries: _buf,
        }, null, 2);
        const file = new File([payload], FILE_NAME, { type: "application/json" });
        await FilePicker.upload("data", "", file, {}, { notify: false });
      } catch (e) {
        console.warn(TAG, "dump() failed:", e?.message ?? e);
      }
    },

    /** Clear the buffer and delete the output file. */
    async clear() {
      _buf.length = 0;
      await this.dump();
    },

    /** Read-only snapshot of the current buffer. */
    get entries() { return [..._buf]; },
  };

  // ── Startup message ────────────────────────────────────────────────────────
  Hooks.once("ready", () => {
    console.debug(TAG, `Debug bridge ready.`);
    console.debug(TAG, `  Enable file output : window.__DP_DEBUG_FILE__ = true`);
    console.debug(TAG, `  Manual dump        : DungeonPathing.Debug.dump()`);
    console.debug(TAG, `  Output file        : Data/${FILE_NAME}`);
  });
})();
