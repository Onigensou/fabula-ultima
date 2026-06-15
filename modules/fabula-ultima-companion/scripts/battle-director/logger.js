// Scoped console logger for the Battle Director.
// All director-side log lines start with `[BD]` so they're filterable.

const TAG = "[BD]";

// Diagnostic ring buffer — last N lines, readable via the test-bridge
// (window.__bdLog). Lightweight; safe to leave in.
const RING_MAX = 300;
function ring(level, args) {
  try {
    const g = globalThis;
    const buf = (g.__bdLog ??= []);
    const line = args.map((a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(" ");
    buf.push(`${level}: ${line}`);
    if (buf.length > RING_MAX) buf.splice(0, buf.length - RING_MAX);
  } catch { /* never let logging throw */ }
}

export function log(...args) { ring("log", args); console.log(TAG, ...args); }
export function warn(...args) { ring("warn", args); console.warn(TAG, ...args); }
export function err(...args) { ring("err", args); console.error(TAG, ...args); }
export function debug(...args) { console.debug(TAG, ...args); }
