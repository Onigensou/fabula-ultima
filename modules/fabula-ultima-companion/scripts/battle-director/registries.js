// Single-owner registries for Hooks and timers.
// See docs/battle-director-design.md §9 — every Hooks.on and every setTimeout
// in the director routes through these so disposeAll() guarantees cleanup.

import { log, warn } from "./logger.js";

export class HookRegistry {
  constructor() {
    // Array of { name, id, label, handler }.
    this._entries = [];
  }

  on(hookName, handler, { label = "" } = {}) {
    const id = Hooks.on(hookName, handler);
    this._entries.push({ name: hookName, id, label, handler });
    return () => this.off(id);
  }

  once(hookName, handler, { label = "" } = {}) {
    const id = Hooks.once(hookName, handler);
    this._entries.push({ name: hookName, id, label, handler });
    return () => this.off(id);
  }

  off(id) {
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const e = this._entries[idx];
    try { Hooks.off(e.name, e.id); } catch (err) { warn("HookRegistry.off failed", e, err); }
    this._entries.splice(idx, 1);
    return true;
  }

  disposeAll() {
    const n = this._entries.length;
    for (const e of this._entries) {
      try { Hooks.off(e.name, e.id); } catch (err) { warn("HookRegistry disposeAll failed", e, err); }
    }
    this._entries.length = 0;
    log(`HookRegistry disposed ${n} hooks`);
  }

  snapshot() {
    return this._entries.map(({ name, id, label }) => ({ name, id, label }));
  }
}

export class TimerRegistry {
  constructor() {
    // Array of { kind: "timeout" | "interval" | "raf", handle, label }.
    this._entries = [];
  }

  setTimeout(fn, ms, { label = "" } = {}) {
    const handle = setTimeout(() => {
      this._remove(handle);
      try { fn(); } catch (e) { warn("TimerRegistry setTimeout fn threw", label, e); }
    }, ms);
    this._entries.push({ kind: "timeout", handle, label });
    return handle;
  }

  setInterval(fn, ms, { label = "" } = {}) {
    const handle = setInterval(() => {
      try { fn(); } catch (e) { warn("TimerRegistry setInterval fn threw", label, e); }
    }, ms);
    this._entries.push({ kind: "interval", handle, label });
    return handle;
  }

  requestAnimationFrame(fn, { label = "" } = {}) {
    const handle = requestAnimationFrame((t) => {
      this._remove(handle, "raf");
      try { fn(t); } catch (e) { warn("TimerRegistry RAF fn threw", label, e); }
    });
    this._entries.push({ kind: "raf", handle, label });
    return handle;
  }

  clear(handle) {
    const idx = this._entries.findIndex((e) => e.handle === handle);
    if (idx < 0) return false;
    const e = this._entries[idx];
    try {
      if (e.kind === "timeout") clearTimeout(e.handle);
      else if (e.kind === "interval") clearInterval(e.handle);
      else if (e.kind === "raf") cancelAnimationFrame(e.handle);
    } catch (err) { warn("TimerRegistry.clear failed", e, err); }
    this._entries.splice(idx, 1);
    return true;
  }

  _remove(handle, kind = null) {
    const idx = this._entries.findIndex((e) => e.handle === handle && (kind === null || e.kind === kind));
    if (idx >= 0) this._entries.splice(idx, 1);
  }

  disposeAll() {
    const n = this._entries.length;
    for (const e of this._entries) {
      try {
        if (e.kind === "timeout") clearTimeout(e.handle);
        else if (e.kind === "interval") clearInterval(e.handle);
        else if (e.kind === "raf") cancelAnimationFrame(e.handle);
      } catch (err) { warn("TimerRegistry disposeAll failed", e, err); }
    }
    this._entries.length = 0;
    log(`TimerRegistry disposed ${n} timers`);
  }

  snapshot() {
    return this._entries.map(({ kind, label }) => ({ kind, label }));
  }
}
