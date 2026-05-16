/**
 * [ONI] Console Tap — ring-buffered capture of console + window errors.
 * ---------------------------------------------------------------------------
 * Installed FIRST in module.json so it catches errors thrown during the rest
 * of the module's script-load phase (notably _module-boot.js macro sync, CSB
 * patches, and any other script that throws during init). The test-bridge
 * reads from this buffer via the `getLogs` request kind.
 *
 * Silent at load time on purpose — the visible boot marker comes from
 * _module-boot.js's `Module scripts loaded @ ...` line. We just install
 * hooks here; no console output.
 *
 * Exposes `globalThis.__FUConsoleTap`:
 *   - logs                 → live ring buffer (read-only by convention; do
 *                            NOT mutate from outside)
 *   - snapshot({sinceSeq, levels, grep, limit}) → filtered copy + cursors
 *   - clear()              → reset buffer (testing only)
 *
 * The buffer is bounded (LOG_BUFFER_MAX). Older entries fall off; `dropped`
 * in the snapshot tells you how many were lost since the start of the
 * session. Sequence numbers monotonically increase across the whole session
 * regardless of eviction, so `sinceSeq` cursors stay valid until reload.
 *
 * Patching behaviour:
 *   - console.{log,info,warn,error,debug} are wrapped; the originals are
 *     still called, so devtools output is unaffected.
 *   - `window` error + unhandledrejection are captured with `[window.error]`
 *     / `[unhandledrejection]` prefixes so they're greppable.
 *
 * Reload clears the buffer (it lives only in memory). For persistent capture
 * across reloads, the bridge would need to flush to disk on a cadence — out
 * of scope for now.
 */
(() => {
  const LOG_BUFFER_MAX = 500;
  const MAX_MSG_LENGTH = 8 * 1024;
  const logs = [];
  let seq = 0;
  let dropped = 0;

  function safeStringify(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Error) {
      const stack = v.stack ? `\n${v.stack}` : "";
      return `${v.name ?? "Error"}: ${v.message}${stack}`;
    }
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === "function") return `[fn ${val.name || "anon"}]`;
        if (typeof val === "bigint") return `${val}n`;
        if (val && typeof val === "object") {
          if (seen.has(val)) return "[circular]";
          seen.add(val);
        }
        return val;
      });
    } catch (e) {
      try { return String(v); } catch { return "[unstringifiable]"; }
    }
  }

  function push(level, args) {
    try {
      let msg = Array.from(args).map(safeStringify).join(" ");
      if (msg.length > MAX_MSG_LENGTH) msg = msg.slice(0, MAX_MSG_LENGTH) + `…[truncated +${msg.length - MAX_MSG_LENGTH}]`;
      logs.push({ seq: ++seq, ts: Date.now(), level, msg });
      while (logs.length > LOG_BUFFER_MAX) { logs.shift(); dropped++; }
    } catch {
      // Never let the tap throw — would corrupt every console call site.
    }
  }

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    console[level] = function (...args) {
      push(level, args);
      try { orig(...args); } catch {}
    };
  }

  window.addEventListener("error", (e) => {
    const where = e.filename ? `${e.filename}:${e.lineno ?? "?"}:${e.colno ?? "?"}` : "";
    push("error", [`[window.error] ${e.message ?? "(no message)"}${where ? " @ " + where : ""}`, e.error ?? null]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    push("error", [`[unhandledrejection]`, e.reason]);
  });

  function snapshot({ sinceSeq = 0, levels, grep, limit = 200 } = {}) {
    let out = logs.filter(e => e.seq > sinceSeq);
    if (Array.isArray(levels) && levels.length) out = out.filter(e => levels.includes(e.level));
    if (grep) {
      let re;
      try { re = new RegExp(grep, "i"); }
      catch { re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      out = out.filter(e => re.test(e.msg));
    }
    if (out.length > limit) out = out.slice(-limit);
    return {
      logs: out,
      headSeq: logs[0]?.seq ?? 0,
      tailSeq: logs[logs.length - 1]?.seq ?? 0,
      bufferSize: logs.length,
      bufferMax: LOG_BUFFER_MAX,
      dropped
    };
  }

  function clear() {
    logs.length = 0;
    dropped = 0;
    // seq deliberately NOT reset — preserves cursor semantics for any caller
    // holding a sinceSeq from before the clear.
  }

  globalThis.__FUConsoleTap = Object.freeze({
    snapshot,
    clear,
    get logs() { return logs; },
    get seq()  { return seq; },
    get dropped() { return dropped; }
  });
})();
