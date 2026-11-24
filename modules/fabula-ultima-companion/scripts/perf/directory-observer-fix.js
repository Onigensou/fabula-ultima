/**
 * [ONI] Sidebar directory observer fix — fabula-ultima-companion
 * ---------------------------------------------------------------------------
 * Works around a Foundry 12.343 core leak. DocumentDirectory#activateListeners
 * (foundry.js ~73162) makes a NEW IntersectionObserver for the lazy thumbnails
 * on every render of a sidebar directory (Actors, Items, Scenes, Journal, ...)
 * and never disconnects it. An observer only lets go of an entry once that
 * entry has scrolled into view, so every re-render leaves the old observer
 * holding the old (detached) <li> rows. The GM re-renders these directories
 * all session (every actor/item update), so the dead rows pile up: 62,754
 * dead targets after a few test battles (measured 2026-11-24).
 *
 * The fix: remember the observer each directory made, and disconnect it at the
 * start of the next render's activateListeners. Only the observer Foundry
 * creates inside that call is captured; nothing else is touched. Memory only;
 * no visible change.
 *
 * Stats: globalThis.__fuDirObserverFix ({ on, disconnected }).
 *
 * Classic script: everything stays inside the IIFE (module.json scripts share
 * one global lexical scope).
 */

(() => {
    const TAG = '[FU-DirObserverFix]';
    const stats = (globalThis.__fuDirObserverFix = { on: false, disconnected: 0 });

    // eslint-disable-next-line no-undef
    const DD = typeof DocumentDirectory === 'function' ? DocumentDirectory : null;
    const NativeIO = globalThis.IntersectionObserver;
    if (typeof DD?.prototype?.activateListeners !== 'function' || typeof NativeIO !== 'function') {
        console.warn(`${TAG} DocumentDirectory#activateListeners not found; left as is.`);
        return;
    }
    const OBS = Symbol('fuDirLazyObservers');
    const original = DD.prototype.activateListeners;

    DD.prototype.activateListeners = function (...args) {
        // The previous render's observers hold only rows that are gone now.
        const old = this[OBS];
        if (old?.length) {
            for (const o of old) { try { o.disconnect(); stats.disconnected++; } catch { /* already gone */ } }
        }
        const made = [];
        this[OBS] = made;
        // Capture the observer(s) core creates inside this call. Subclasses
        // (ActorDirectory, ...) call super.activateListeners, so they land here.
        const Capturing = class extends NativeIO {
            constructor(...a) { super(...a); made.push(this); }
        };
        globalThis.IntersectionObserver = Capturing;
        try {
            return original.apply(this, args);
        } finally {
            globalThis.IntersectionObserver = NativeIO;
        }
    };
    stats.on = true;
})();
