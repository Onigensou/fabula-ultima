// ============================================================================
// Confirm lock while an Invoke window is open (to-do #22).
//
//     node scripts/battle-director/invoke/invoke-confirm-lock.test.mjs
//
// A player opened Invoke, picked, then hit the card's Confirm with the window
// still up: the invoke was dropped. Confirm now waits ("Apply or close Invoke
// first"), and the lock must always come off again.
// ============================================================================

const {
  confirmLockState, invokeLockFromHud, readConfirmLock, syncInvokeHudLock,
  setInvokeApplying, INVOKE_LOCK_LABEL, INVOKE_HUD_ATTR, INVOKE_APPLYING_ATTR,
} = await import("./invoke-confirm-lock.js");

let failed = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const OPEN = { locked: false, reason: null };
const INV = { locked: true, reason: "invoke" };
const RX = { locked: true, reason: "reactions" };

check("label", INVOKE_LOCK_LABEL, "Apply or close Invoke first");

// ── HUD record → mode ───────────────────────────────────────────────────────
check("no HUD", invokeLockFromHud(null), null);
check("trait HUD = own", invokeLockFromHud({ type: "trait" }), "own");
check("bond HUD = own", invokeLockFromHud({ type: "bond" }), "own");
check("committing trait = own", invokeLockFromHud({ type: "trait", committing: true }), "own");
check("spectator = remote", invokeLockFromHud({ type: "spectator", kind: "bond" }), "remote");
check("unknown type", invokeLockFromHud({ type: "x" }), null);

// ── decision ────────────────────────────────────────────────────────────────
check("nothing open", confirmLockState({}), OPEN);
check("own HUD locks player", confirmLockState({ invokeHud: "own" }), INV);
check("own HUD: GM padlock does NOT pass it", confirmLockState({ invokeHud: "own", isGM: true, gmUnlocked: true }), INV);
check("applying locks", confirmLockState({ invokeApplying: true }), INV);
check("applying: GM padlock does NOT pass it", confirmLockState({ invokeApplying: true, isGM: true, gmUnlocked: true }), INV);
check("remote HUD locks", confirmLockState({ invokeHud: "remote" }), INV);
check("remote HUD: GM padlock passes it", confirmLockState({ invokeHud: "remote", isGM: true, gmUnlocked: true }), OPEN);
check("remote HUD: unlocked flag on a player does nothing", confirmLockState({ invokeHud: "remote", isGM: false, gmUnlocked: true }), INV);
check("reactions alone", confirmLockState({ reactionsPending: true }), RX);
check("reactions + GM padlock", confirmLockState({ reactionsPending: true, isGM: true, gmUnlocked: true }), OPEN);
check("invoke label wins over reactions", confirmLockState({ reactionsPending: true, invokeHud: "own" }), INV);
check("remote + reactions + padlock = open", confirmLockState({ reactionsPending: true, invokeHud: "remote", isGM: true, gmUnlocked: true }), OPEN);
check("no args", confirmLockState(), OPEN);

// ── DOM: the lock follows the HUD, so it always comes off ─────────────────────
function fakeCard() {
  const attrs = new Map();
  return {
    attrs,
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  };
}
const hostCard = fakeCard();
const mirrorCard = fakeCard();
const doc = {
  querySelectorAll: (sel) => (sel.startsWith("#fud-battlefield-card-root") ? [hostCard]
    : sel.startsWith("#fud-bf-mirror-root") ? [mirrorCard] : []),
};

syncInvokeHudLock({ type: "trait" }, doc);
check("open trait → host card own", hostCard.getAttribute(INVOKE_HUD_ATTR), "own");
check("open trait → mirror card own", mirrorCard.getAttribute(INVOKE_HUD_ATTR), "own");
check("player reads locked", readConfirmLock(mirrorCard, { isGM: false }), INV);
syncInvokeHudLock(null, doc);
check("closed → attr gone (host)", hostCard.hasAttribute(INVOKE_HUD_ATTR), false);
check("closed → attr gone (mirror)", mirrorCard.hasAttribute(INVOKE_HUD_ATTR), false);
check("closed → unlocked", readConfirmLock(mirrorCard), OPEN);

syncInvokeHudLock({ type: "spectator", kind: "trait" }, doc);
check("spectator → remote", hostCard.getAttribute(INVOKE_HUD_ATTR), "remote");
hostCard.setAttribute("data-fud-gm-unlocked", "");
check("GM padlock passes remote", readConfirmLock(hostCard, { isGM: true }), OPEN);
setInvokeApplying(hostCard, true);
check("applying beats padlock", readConfirmLock(hostCard, { isGM: true }), INV);
setInvokeApplying(hostCard, false);
check("applying cleared", hostCard.hasAttribute(INVOKE_APPLYING_ATTR), false);
hostCard.removeAttribute("data-fud-gm-unlocked");
syncInvokeHudLock(null, doc);
check("all clear", readConfirmLock(hostCard, { isGM: true }), OPEN);

hostCard.setAttribute("data-fud-reactions-pending", "2");
check("reactions still read from the card", readConfirmLock(hostCard), RX);
hostCard.removeAttribute("data-fud-reactions-pending");

// Safe on missing pieces (card gone, no document).
check("null card", readConfirmLock(null), OPEN);
syncInvokeHudLock({ type: "trait" }, null);
setInvokeApplying(null, true);
check("no-throw on null doc/card", true, true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
