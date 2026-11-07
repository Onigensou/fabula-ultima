// ============================================================================
// HUD Dock — the bottom-left control stack
// ----------------------------------------------------------------------------
// window.oni.HudDock owns the VERTICAL position of everything stacked in the
// bottom-left corner. From the floor up:
//
//   Foundry hotbar              (Foundry's own, not managed)
//   button row                  bottom 80, 64 tall: dungeon mode buttons, camp
//                               button, summons, scion, upgrade. A RESERVED
//                               slot: its members keep their own bottom: 80
//                               and their left offsets per scene mode.
//   ── members, bottom-up by `order`, 10px apart, starting at 154 ──
//   20 Skill Point badge        (levelup-badge.js)      when points are unspent
//   21 Attribute Point badge    (attribute-badge.js)    when advances are unspent
//   30 controller badge + Pass  (movementControl-controllerBadge.js)  walk maps
//   ── above everything ──
//   Party Talk                  reads stackTop()
//
// Before this file each layer copied 80 + 64 + 10 and measured the layers
// below it by element id. Now a layer registers once and calls relayout() when
// it appears, disappears or changes height; the dock hands every member its
// bottom. A member hidden or absent reports height 0 and takes no room.
//
//   HudDock.register(id, { order, height: () => px, apply: (bottomPx, present) => void })
//   HudDock.registerRow(id, () => visible)   // a button-row member, for stackTop only
//   HudDock.relayout()
//   HudDock.stackTop()                       // px from the screen bottom to the top of the stack
//   HudDock.onChange(fn)                     // fn({ stackTop }) after a relayout that moved it
//   HudDock.layout(items, opts)              // pure math, for tests
//
// Classic script, loaded early in module.json "scripts", so it exists before
// any ES module or later script registers.
// ============================================================================
(() => {
  const root = typeof window !== "undefined" ? window : globalThis;
  root.oni = root.oni || {};
  if (root.oni.HudDock?.installed) return;

  const TAG = "[ONI][HudDock]";
  const ROW_BOTTOM = 80;   // the button row's floor (dp-scan-mode.js SCAN_BUTTON.BOTTOM)
  const ROW_SIZE = 64;     // its button height (SCAN_BUTTON.SIZE)
  const GAP = 10;

  /** Row geometry, read from the Dungeon Pathing constants when they exist (as before). */
  function rowGeometry() {
    const btn = root.DungeonPathing?.UI?.SCAN_BUTTON;
    return { bottom: Number(btn?.BOTTOM ?? ROW_BOTTOM), size: Number(btn?.SIZE ?? ROW_SIZE) };
  }

  /**
   * Pure stacking. items: [{ id, order, h }] (h <= 0 = absent).
   * Returns { bottoms: { id: px }, top: px | null } — top of the highest present
   * member, or null when none is present. Absent members are handed the slot
   * they would take, so they appear in the right place when they come back.
   */
  function layout(items, { base, gap = GAP } = {}) {
    const g = rowGeometry();
    let y = base ?? (g.bottom + g.size + gap);
    let top = null;
    const bottoms = {};
    for (const it of [...items].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)))) {
      bottoms[it.id] = y;
      const h = Math.round(Number(it.h) || 0);
      if (h > 0) { top = y + h; y += h + gap; }
    }
    return { bottoms, top };
  }

  const members = new Map();   // id -> { order, height, apply }
  const rows = new Map();      // id -> visible()
  const listeners = new Set();
  let lastTop = null;
  let pending = false;

  const safe = (fn, fallback) => { try { return fn(); } catch (e) { console.warn(TAG, e); return fallback; } };

  function relayoutNow() {
    pending = false;
    const items = [...members].map(([id, m]) => ({ id, order: m.order, h: safe(() => m.height?.() ?? 0, 0) }));
    const { bottoms } = layout(items);
    for (const it of items) {
      const m = members.get(it.id);
      safe(() => m.apply?.(bottoms[it.id], it.h > 0), null);
    }
    const t = stackTop();
    if (t !== lastTop) {
      lastTop = t;
      for (const fn of [...listeners]) safe(() => fn({ stackTop: t }), null);
      safe(() => root.Hooks?.callAll?.("oniHudDockChanged", { stackTop: t }), null);
    }
  }

  /**
   * Re-stack. Synchronous by default, so a member that calls it right after
   * showing lands in the same frame (no visible jump); { defer: true } batches
   * several calls into one on the next frame.
   */
  function relayout({ defer = false } = {}) {
    if (!defer) return relayoutNow();
    if (pending) return;
    pending = true;
    (root.requestAnimationFrame ?? ((f) => setTimeout(f, 16)))(relayoutNow);
  }

  function register(id, { order = 50, height, apply } = {}) {
    members.set(String(id), { order: Number(order) || 0, height, apply });
    relayout();
    return () => unregister(id);
  }
  function unregister(id) { members.delete(String(id)); relayout(); }

  function registerRow(id, visible) {
    rows.set(String(id), visible);
    return () => rows.delete(String(id));
  }

  /** px from the screen bottom to the top of the stack (0 when nothing is there). */
  function stackTop() {
    const items = [...members].map(([id, m]) => ({ id, order: m.order, h: safe(() => m.height?.() ?? 0, 0) }));
    const { top } = layout(items);
    if (top != null) return top;
    const g = rowGeometry();
    for (const vis of rows.values()) if (safe(() => !!vis(), false)) return g.bottom + g.size;
    return 0;
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  root.oni.HudDock = {
    installed: true,
    GAP,
    register, unregister, registerRow, relayout, stackTop, onChange, layout, rowGeometry,
    _members: members,
  };

  if (root.Hooks?.on) {
    root.Hooks.on("canvasReady", () => relayout({ defer: true }));
    root.addEventListener?.("resize", () => relayout({ defer: true }));
  }
})();
