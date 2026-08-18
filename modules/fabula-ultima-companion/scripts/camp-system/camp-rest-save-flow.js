// ============================================================================
// Camp System — Rest-Time Save Flow (orchestration)
//
// Runs on the PRIMARY GM only. Every decision and every write lives here; the
// other clients just render whatever phase the world setting says.
//
//   REST_SAVE_PROMPT ──yes──► REST_SAVING ──► REST_TITLE_PROMPT ──yes──► Title scene
//          └────────no────────────────────────────┘             └──no──► SET_OUT_LOBBY
//
// Why primary-GM-only rather than a party vote or an elected steward:
// SaveSystem.Core.save() already refuses anyone but the primary GM (two
// concurrent saves corrupt the party's embedded items), and the table wanted
// the console-JRPG reading — the game appears to save ITSELF. Adding a lobby to
// a Yes/No would be friction with no safety it doesn't already have.
// ============================================================================
(() => {
  const CAMP = globalThis.CampSystem ??= {};
  const TAG  = "[CampSystem][RestSaveFlow]";

  const isPrimaryGM = () => globalThis.FUCompanion?.isPrimaryGM?.() ?? false;

  // Re-entrancy guard. answerSave/answerTitle are reachable from a click AND a
  // keypress in the same tick, and each one advances a phase.
  let _busy = false;

  async function _guarded(fn) {
    if (!isPrimaryGM() || _busy) return;
    _busy = true;
    try { await fn(); }
    catch (e) { console.error(TAG, "flow step failed:", e); }
    finally { _busy = false; }
  }

  // ---------------------------------------------------------------------------
  // Save leg
  // ---------------------------------------------------------------------------

  /**
   * Open the save system's own file screen for the GM. Reusing it (rather than
   * drawing a slot list here) means the rest-time save menu IS the title-screen
   * save menu — same slot cards, same overwrite confirm, same feather cursor.
   *
   * The flow hook reports how that step ended:
   *   onSaved  → record the result, hold on it, then ask about the title screen
   *   onExit   → GM backed out without writing; treat it as "no save" and move on
   */
  function _openSlotPicker() {
    const SS = globalThis.SaveSystem;
    if (!SS?.UI) {
      console.error(TAG, "SaveSystem.UI unavailable — skipping the save leg.");
      _recordAndAdvance({ save: false, ok: null, error: "save system unavailable" });
      return;
    }

    SS.UI.openInMode("save", {
      onSaved: (slotId, res) => {
        _recordAndAdvance({
          save: true, slotId, ok: true, label: res?.label ?? null, error: null,
        }, { closeUI: true });
      },
      onExit: () => {
        // Backed out of the picker, or dismissed a failed write. Either way the
        // session was not written — say so on the title panel rather than
        // silently pretending the save leg never happened. (The specific failure
        // was already shown on the save system's own error line; all this panel
        // owes the table is "not saved".)
        const c = CAMP.State.getSaveChoice();
        if (c.ok === true) return;              // already recorded a success
        _recordAndAdvance({ save: true, ok: false, error: "not written" });
      },
    });
  }

  // Write the outcome, let it sit on screen for a beat, then advance.
  function _recordAndAdvance(patch, { closeUI = false } = {}) {
    _guarded(async () => {
      await CAMP.State.setSaveChoice({ asked: true, ...patch });
      // Close just BEFORE the save system's own 1300ms reset-to-file-screen
      // timer fires, or the GM gets a flash of the slot list on the way out.
      if (closeUI) {
        await new Promise(r => setTimeout(r, 1150));
        globalThis.SaveSystem?.UI?.close?.();
        await new Promise(r => setTimeout(r, 500));
      } else {
        await new Promise(r => setTimeout(r, 1400));
      }
      await CAMP.State.setPhase(CAMP.PHASE.REST_TITLE_PROMPT);
    });
  }

  // ---------------------------------------------------------------------------
  // Return to title
  // ---------------------------------------------------------------------------

  async function _returnToTitle() {
    // 1 — Kill the camp BGM resume the rest scheduled. It fires up to 35s out,
    //     on a path nobody is watching, and would start camp music over the
    //     title screen. See RestAPI.cancelBgmResume().
    CAMP.RestAPI?.cancelBgmResume?.();

    const scene = _findTitleScene();
    if (!scene) {
      console.error(TAG, "No scene in title mode found — staying in camp.");
      ui.notifications?.error?.("[Camp] No title-mode scene found; returning to Set Out.");
      await _settleCampState();
      return;
    }

    // 2 — Activate the title scene FIRST. Foundry pulls every player to the
    //     active scene, and title-bootstrap opens the menu on canvasReady.
    //
    //     Order matters: settling the camp phase first would fire
    //     _onPhaseChange(SET_OUT_LOBBY) while camp is still active, fading the
    //     screen back IN to the camp scene for a beat before the title loads —
    //     black, camp, title. Doing it after, every client has already run
    //     deactivateCamp() and the phase write is silent.
    console.log(TAG, `Returning the party to the title screen: "${scene.name}".`);
    try {
      await scene.activate();
      // Let the other clients tear camp down before the phase write lands.
      await new Promise(r => setTimeout(r, 600));
    } finally {
      // 3 — Leave the LIVE world resumable regardless. The save blob is
      //     normalised by campState's extractor, but the running world is not:
      //     without this the next session boots into a dead ceremony phase.
      await _settleCampState();
    }
  }

  function _findTitleScene() {
    const MOD  = CAMP.MODULE_ID;
    const mode = globalThis.TitleScreen?.SCENE_MODE ?? "title";
    return game.scenes?.find(s =>
      s.flags?.[MOD]?.oniFabula?.general?.sceneMode === mode) ?? null;
  }

  // Put the camp FSM where a returning party should find it: Set Out, with the
  // finished cycle's ready/selection maps cleared so the lobby opens clean.
  async function _settleCampState() {
    for (const name of CAMP.TRANSIENT_SETTINGS) {
      const key = CAMP.SETTING[name];
      if (!key) continue;
      try { await game.settings.set(CAMP.MODULE_ID, key, "{}"); }
      catch (e) { console.warn(TAG, `Could not clear ${key}:`, e.message); }
    }
    await CAMP.State.setPhase(CAMP.PHASE.SET_OUT_LOBBY);
  }

  // ---------------------------------------------------------------------------
  // Public API — the UI reports answers here
  // ---------------------------------------------------------------------------
  CAMP.RestSaveFlow = {
    /** Entering REST_SAVING: open the picker for the GM. */
    beginSave() {
      if (!isPrimaryGM()) return;
      _openSlotPicker();
    },

    /** Answer to "record your journey?". */
    answerSave(yes) {
      if (!isPrimaryGM()) return;
      if (yes) {
        _guarded(async () => {
          await CAMP.State.setSaveChoice({ ...CAMP.SAVE_CHOICE_EMPTY, asked: true, save: true });
          await CAMP.State.setPhase(CAMP.PHASE.REST_SAVING);
        });
        return;
      }
      _guarded(async () => {
        await CAMP.State.setSaveChoice({ ...CAMP.SAVE_CHOICE_EMPTY, asked: true, save: false });
        await CAMP.State.setPhase(CAMP.PHASE.REST_TITLE_PROMPT);
      });
    },

    /** Answer to "return to the title screen?". */
    answerTitle(yes) {
      if (!isPrimaryGM()) return;
      _guarded(async () => {
        if (yes) await _returnToTitle();
        else     await CAMP.State.setPhase(CAMP.PHASE.SET_OUT_LOBBY);
      });
    },
  };

  console.debug(TAG, "Rest save flow loaded.");
})();
