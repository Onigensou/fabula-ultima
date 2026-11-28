// scripts/battle-director/invoke/invoke-confirm-lock.js
// Confirm lock while an Invoke Trait / Invoke Bond window is open (to-do #22).
//
// The bug: a player opened Invoke, picked a die or a bond, then pressed the
// card's own Confirm with the Invoke window still up. The action resolved and
// the invoke was silently dropped. Now Confirm is locked, with the label
// "Apply or close Invoke first", until the invoke is applied or the window
// is closed.
//
// The lock is DERIVED, never counted, so it cannot be stranded:
//   - data-fud-invoke-hud  : mirrors invoke-hud's singleton. invoke-hud calls
//     syncInvokeHudLock() on EVERY change of its active HUD (open, apply,
//     cancel, supersede, spectator teardown, reroll end), so whenever no HUD
//     is up the attribute is gone. "own" = this client's interactive HUD
//     (hard lock). "remote" = a read-only spectator HUD: someone else is
//     deciding (a GM may still force Confirm with the padlock, the same way it
//     passes over open reactions, so an AFK player can't stall the table).
//   - data-fud-invoke-applying : the short gap between "invoke chosen" and
//     "card patched" (payment, reroll, the host's answer). Set and cleared in
//     try/finally by the code that runs the invoke; the player-side flag also
//     drops on the host's update, on a failed-invoke teardown and on the
//     no-response timer.
// Both live on the card element, so a card teardown (confirm, cancel, battle
// end, card replace) takes them with it.

export const INVOKE_LOCK_LABEL = "Apply or close Invoke first";
export const INVOKE_HUD_ATTR = "data-fud-invoke-hud";
export const INVOKE_APPLYING_ATTR = "data-fud-invoke-applying";

// The two action-card roots: the host's own card and a client's mirror.
// (Literal ids, kept in step with ROOT_ID / MIRROR_ROOT_ID in action-card.js.)
const CARD_SELECTORS = [
  "#fud-battlefield-card-root .fud-bf-card",
  "#fud-bf-mirror-root .fud-bf-card",
];

// ── Pure ────────────────────────────────────────────────────────────────────

// invoke-hud's active record → the lock mode it implies for this client.
export function invokeLockFromHud(active) {
  const t = active?.type ?? null;
  if (t === "trait" || t === "bond") return "own";
  if (t === "spectator") return "remote";
  return null;
}

// Single decision for the card's Confirm. Invoke outranks reactions in the
// reason (its label is the one shown), and only the GM padlock can pass a
// REMOTE invoke or open reactions. Never an own HUD or an invoke mid-apply:
// those resolve on this client within moments, by apply or by close.
export function confirmLockState({
  reactionsPending = false,
  invokeHud = null,
  invokeApplying = false,
  isGM = false,
  gmUnlocked = false,
} = {}) {
  if (invokeHud === "own" || invokeApplying) return { locked: true, reason: "invoke" };
  const override = !!(isGM && gmUnlocked);
  if (invokeHud === "remote" && !override) return { locked: true, reason: "invoke" };
  if (reactionsPending && !override) return { locked: true, reason: "reactions" };
  return { locked: false, reason: null };
}

// ── DOM ─────────────────────────────────────────────────────────────────────

export function readConfirmLock(cardEl, { isGM = false } = {}) {
  if (!cardEl?.hasAttribute) return { locked: false, reason: null };
  return confirmLockState({
    reactionsPending: cardEl.hasAttribute("data-fud-reactions-pending"),
    invokeHud: cardEl.getAttribute(INVOKE_HUD_ATTR) || null,
    invokeApplying: cardEl.hasAttribute(INVOKE_APPLYING_ATTR),
    isGM,
    gmUnlocked: cardEl.hasAttribute("data-fud-gm-unlocked"),
  });
}

// Called by invoke-hud on every change of its singleton.
export function syncInvokeHudLock(active, doc = globalThis.document) {
  if (!doc?.querySelectorAll) return;
  const mode = invokeLockFromHud(active);
  for (const sel of CARD_SELECTORS) {
    for (const card of doc.querySelectorAll(sel)) {
      if (mode) card.setAttribute(INVOKE_HUD_ATTR, mode);
      else card.removeAttribute(INVOKE_HUD_ATTR);
    }
  }
}

export function setInvokeApplying(cardEl, on) {
  if (!cardEl?.setAttribute) return;
  if (on) cardEl.setAttribute(INVOKE_APPLYING_ATTR, "1");
  else cardEl.removeAttribute(INVOKE_APPLYING_ATTR);
}
