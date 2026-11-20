/**
 * Removal gate for the defeat reactor's deferred defeats.
 *
 * A defeat scheduled during a settle pass plays its animation at once, alongside
 * the rest of the pass, but its token may only be deleted once the pass is done
 * writing. The same pass keeps running reactions after the kill — an on-hit rider
 * (Blanche's Muleta Bleed, Zarg's Lockdown), the next event's built-in reactors —
 * and those write to the dying creature's token actor. A delete sent while such a
 * write is still on its way loses the race on the server: the write lands on a
 * token that is gone and Foundry shows "Token <id> does not exist!" (or, when the
 * write starts after the local delete, "undefined id [<id>] does not exist in the
 * EmbeddedCollection collection"). Measured 2026-11-20 in the Nox Legion sims,
 * about 1 battle in 15.
 *
 * The settle pass opens the gate at its end (drainPendingDefeats), after every
 * reaction of the pass has been awaited, so removals land after those writes. A
 * removal that never sees its gate open (a settle cut short) goes ahead after
 * `maxWaitMs`, so a token is never left on the field.
 */

export function createRemovalGate({ maxWaitMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null;

  function fresh() {
    let open;
    const opened = new Promise((r) => { open = r; });
    return { opened, open, isOpen: false };
  }

  return {
    /** The gate removals scheduled now must wait for. */
    current() {
      if (!current) current = fresh();
      return current;
    },
    /** Open the gate the waiting removals hold; later ones get a new, closed one. */
    release() {
      const g = current;
      current = null;
      if (g && !g.isOpen) { g.isOpen = true; g.open(true); }
      return !!g;
    },
    /**
     * Wait for `gate` to open, or `maxWaitMs`. Resolves true when it opened,
     * false when the wait ran out.
     */
    async wait(gate) {
      if (!gate || gate.isOpen) return true;
      let timer = null;
      const timedOut = new Promise((r) => { timer = setTimer(() => r(false), maxWaitMs); });
      const res = await Promise.race([gate.opened, timedOut]);
      clearTimer(timer);
      return res === true;
    },
  };
}
