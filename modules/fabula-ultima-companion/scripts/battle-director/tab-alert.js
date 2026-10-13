// tab-alert.js — the browser tab calls you back to the battle.
//
// While this window is in the background (another tab, another app on top),
// a decision that waits on THIS user puts a call to act in the page title:
// "★ Your turn · <world>", alternating with the normal title once a second.
// Showing the window again restores the title at once.
//
//   tabAlert(key, text)   a decision opened (no-op while the window is in front)
//   tabAlertClear(key)    that decision closed before the user came back
//
// The first title change happens immediately, so a hidden tab whose timers the
// browser throttles still shows the call.

const _keys = new Map();      // key → text (insertion order: the newest wins)
let _timer = null;
let _base = null;
let _on = false;

function away() {
  if (typeof document === "undefined") return false;
  return document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus());
}
function text() { return [..._keys.values()].pop() ?? ""; }
function show(on) {
  _on = on;
  try { document.title = on && _keys.size ? `${text()} · ${_base}` : _base; } catch { /* */ }
}
function start() {
  if (_timer) { show(true); return; }
  _base = document.title;
  show(true);
  _timer = setInterval(() => show(!_on), 1000);
}
function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (_base != null) { try { document.title = _base; } catch { /* */ } }
  _base = null;
  _on = false;
}

export function tabAlert(key, label) {
  if (!key || !away()) return;
  const want = String(label ?? "★ Your turn");
  if (_keys.get(key) === want && _timer) return;
  _keys.delete(key);
  _keys.set(key, want);
  start();
}

export function tabAlertClear(key) {
  if (!_keys.delete(key)) return;
  if (!_keys.size) stop();
}

function back() {
  if (away()) return;
  _keys.clear();
  stop();
}
if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
}
