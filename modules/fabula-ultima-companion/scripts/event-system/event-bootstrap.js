/**
 * [ONI] Event System — Bootstrap
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-bootstrap.js
 *
 * What this does:
 * - Verifies that all required Event System scripts are loaded
 * - Exposes a clean top-level API:
 *   window.oni.EventSystem
 * - Provides a quick console summary for debugging
 *
 * Notes:
 * - This file does NOT replace module.json load order.
 * - Your module.json should still load the Event System scripts
 *   in the correct order.
 * - This file is mainly a final sanity check / API organizer.
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][Bootstrap]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Bootstrap?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const ES = window.oni.EventSystem;

  // ------------------------------------------------------------
  // Required pieces
  // ------------------------------------------------------------
  const required = {
    Constants: ES.Constants,
    Debug: ES.Debug,
    ShowTextSpeakerResolver: ES.ShowText?.SpeakerResolver,
    ShowTextExecute: ES.ShowText?.Execute,
    EventRegistry: ES.EventRegistry,
    ConfigUI: ES.ConfigUI,
    Core: ES.Core
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  // ------------------------------------------------------------
  // Bootstrap API
  // ------------------------------------------------------------
  const Bootstrap = {
    installed: true,

    getStatus() {
      return {
        ok: missing.length === 0,
        missing: [...missing],
        loaded: Object.fromEntries(
          Object.entries(required).map(([key, value]) => [key, !!value])
        )
      };
    },

    logStatus() {
      const status = this.getStatus();

      console.log(INSTALL_TAG, "Status:", status);

      if (!status.ok) {
        console.warn(INSTALL_TAG, "Missing Event System pieces:", status.missing);
      } else {
        console.log(INSTALL_TAG, "All Event System pieces loaded correctly.");
      }

      return status;
    }
  };

  ES.Bootstrap = Bootstrap;

  // ------------------------------------------------------------
  // Startup summary
  // ------------------------------------------------------------
  const status = Bootstrap.getStatus();

  if (!status.ok) {
    console.warn(INSTALL_TAG, "Installed, but some required scripts are missing.", {
      missing: status.missing,
      loaded: status.loaded
    });
  } else {
    console.log(INSTALL_TAG, "Installed successfully.", {
      loaded: status.loaded
    });
  }
})();
