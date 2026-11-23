// ============================================================================
// Gacha System — Bootstrap
// ----------------------------------------------------------------------------
// Single ESM entry point: everything else is reached through this import graph,
// so module.json only needs this one file listed.
//
// Two ways the machine opens:
//
//   * WALK-UP (2026-11-23): a player clicks Hako's Gachapon button (or picks it
//     from the Confirm menu). The machine opens on THAT client only, over the
//     current map, with its own opaque backdrop and its own local music. The
//     ← button / Esc / Cancel leaves. Browsing is private.
//   * SCENE MODE "gacha": the GM activates the Gacha Scene and the machine opens
//     for EVERY client, as before. Leaving is the GM's call (change scene).
//
// The pull is public either way: pressing Wish plays the reveal at the machine
// AND reaches every other client through gacha-watch.js (call-out, then the
// shared reveal; busy clients get a results card).
// ============================================================================

import { GACHA, log } from "./gacha-const.js";
import * as Net from "./gacha-net.js";
import * as UI from "./gacha-ui.js";
import { playReveal, beginReveal, isPlaying, stop as stopFx } from "./gacha-fx.js";
import { closePanel } from "./gacha-panels.js";
import * as Audio from "./gacha-audio.js";
import * as Presence from "./gacha-presence.js";
import * as Watch from "./gacha-watch.js";
import { installEntrance, setVendor } from "./gacha-entrance.js";
import { listBanners } from "./gacha-banners.js";

const MOVE_LOCK = "gacha-machine";

function isGachaScene(scene) {
  const mode = scene?.flags?.[GACHA.MODULE_ID]?.oniFabula?.general?.sceneMode;
  return mode === GACHA.SCENE_MODE;
}

const isSpectator = () => globalThis.FUCompanion?.api?.Spectator?.isSpectator?.() === true;
const runtime = () => globalThis.FUCompanion?.api?.MovementControlCameraRuntime ?? null;
const lockMove = (on) => { try { on ? runtime()?.lockMovement?.(MOVE_LOCK) : runtime()?.unlockMovement?.(MOVE_LOCK); } catch {} };

// ── open / leave ────────────────────────────────────────────────────────────

/**
 * Open the machine on this client.
 * @param {{source?: "vendor"|"scene"|"api"}} [opts]
 */
async function open({ source = "api" } = {}) {
  if (UI.isOpen()) return true;
  if (source !== "scene") {
    if (isSpectator()) return false;                      // watch-only account
    const busy = Watch.busyReason();
    if (busy) {
      ui.notifications?.info(`The Gachapon can wait until the ${busy === "event" ? "scene" : busy} is over.`);
      return false;
    }
    if (isPlaying()) return false;                         // watching someone's reveal
  }
  const ok = await UI.open({ source });
  if (!ok) return false;

  Audio.hold("machine");
  Presence.enter(listBanners()[0]?.id ?? null);
  lockMove(true);
  return true;
}

function leave() {
  const was = UI.isOpen();
  UI.close();
  closePanel({ silent: true });
  if (!was) return;
  Audio.release("machine");
  Presence.leave();
  lockMove(false);
}

UI.setLeaveHandler(() => leave());

function sync(scene) {
  if (isGachaScene(scene)) { open({ source: "scene" }); return; }
  if (UI.openedBy() === "scene") { stopFx(); leave(); }
}

// ── install ─────────────────────────────────────────────────────────────────

let _installed = false;

function install() {
  if (_installed) return;
  _installed = true;

  Watch.registerSettings();

  Net.setup({
    // Someone pressed Wish. At the machine, the chest drops on the same beat;
    // anywhere else, the watch party decides (call-out / join / results card).
    onStart: (payload) => {
      if (payload?.byUserId === game.user.id) return;
      if (UI.isOpen()) {
        UI.setMachine(true, payload?.byUserId);
        beginReveal(payload?.count ?? 1);
        Watch.decorate(payload?.byUserId);
      } else {
        Watch.onRemoteStart(payload);
      }
    },
    onReveal: (payload) => {
      if (payload?.byUserId === game.user.id || UI.isOpen()) {
        playReveal(payload);
        Watch.decorate(payload?.byUserId);
        return;
      }
      Watch.onRemoteReveal(payload);
    },
    onPool:     (payload) => UI.refreshPool(payload?.pool),
    onEnd:      (msg) => { UI.setMachine(false); Watch.onRemoteEnd(msg); },
    onPresence: (msg) => Presence.onPresence(msg),
    onCheer:    (msg) => Watch.onCheer(msg),
  });

  // The roller's own reveal ended: the machine is free for the next wish.
  Hooks.on("fuGachaRevealEnd", ({ byUserId } = {}) => {
    if (byUserId && byUserId === game.user.id) Net.announceEnd();
  });

  installEntrance();

  // Diagnostics + the walk-up API.
  const api = (globalThis.FUCompanion ??= {}).api ??= {};
  api.gacha = {
    installed: true,
    isOpen: UI.isOpen,
    open: (opts) => open(opts),
    close: () => leave(),
    replay: playReveal,
    watchReplay: Watch.replay,
    setVendor,
    debug: () => ({ open: UI.isOpen(), openedBy: UI.openedBy(), audio: Audio.audioDebug(), watch: Watch.watchDebug(), here: Presence.here() }),
  };

  // A reload while already standing on the scene still has to open the screen —
  // canvasReady has usually fired before this point.
  if (isGachaScene(canvas?.scene)) open({ source: "scene" });

  log("Ready.");
}

// `Hooks.once("ready")` never fires for a module evaluated after ready has
// already gone by, which silently left the reveal handler uninstalled while the
// overlay itself still opened from canvasReady — the screen worked, the
// animation simply never played. Check the flag first and only wait if we must.
if (globalThis.game?.ready) install();
else Hooks.once("ready", install);

Hooks.on("canvasReady", () => sync(canvas?.scene));

// Keep the overlay inside Foundry's chrome when that chrome moves.
Hooks.on("collapseSidebar", () => { if (UI.isOpen()) setTimeout(() => UI.relayout(), 260); });
window.addEventListener("resize", () => { if (UI.isOpen()) UI.relayout(); });

// Changing maps closes a walk-up machine; the party has moved on.
Hooks.on("canvasTearDown", () => { if (UI.openedBy() !== "scene") stopFx(); leave(); });

// A scene, battle or duel starting takes the screen back from a walk-up machine.
// (Never mid-reveal from here: a reveal belongs to everyone watching it.)
const yieldTo = () => { if (UI.isOpen() && UI.openedBy() !== "scene" && !isPlaying()) leave(); };
Hooks.on("oniEventExecuteStart", yieldTo);
Hooks.on("fuBattleFocusChanged", (b) => { if (b) yieldTo(); });
Hooks.on("fabulaArcanaWindow", ({ open: o } = {}) => { if (o) yieldTo(); });

Hooks.on("updateScene", (scene) => {
  if (!canvas?.scene || scene.id !== canvas.scene.id) return;
  sync(scene);
});

// Currency and pity live on the party actor; when they change underneath us
// (another player's purchase, a GM edit) the counters should follow.
//
// Scoped to the party actor on purpose. A wish grants several items and
// decrements the coupon in one burst, and an unfiltered hook would repaint the
// whole overlay once per document touched, mid-animation.
const touchesParty = (doc) => {
  const partyId = UI.partyActorId();
  if (!partyId) return false;
  return doc?.id === partyId || doc?.parent?.id === partyId;
};

Hooks.on("updateActor", (actor) => {
  if (UI.isOpen() && touchesParty(actor)) UI.refreshPool();
});

Hooks.on("updateItem", (item) => {
  if (UI.isOpen() && touchesParty(item)) UI.refreshPool();
});

Hooks.on("createItem", (item) => {
  if (UI.isOpen() && touchesParty(item)) UI.refreshPool();
});
