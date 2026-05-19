// ============================================================================
// Save System — Settings Registration & Slot CRUD
//
// Slots are stored as JSON strings in world settings.
// NPC template ID is user-configurable so the system works across campaigns.
// ============================================================================
(() => {
  const SS  = globalThis.SaveSystem ??= {};
  const MOD = SS.MODULE_ID;
  const TAG = "[SaveSystem][Storage]";

  Hooks.once("ready", () => {
    for (let i = 1; i <= SS.SLOT_COUNT; i++) {
      try {
        game.settings.register(MOD, SS.SETTING.SLOT(i), {
          scope: "world", config: false, type: String, default: "",
        });
      } catch { /* already registered on hot-reload */ }
    }

    try {
      game.settings.register(MOD, SS.SETTING.NPC_TEMPLATE, {
        scope:   "world",
        config:  true,
        type:    String,
        name:    "Save System: NPC Template Actor ID",
        hint:    "Short actor ID of the NPC/boss template. Linked actors built from this template are captured in saves. Change this when starting a new campaign with a different template.",
        default: "yegF6R8aaymhrvCg",
      });
    } catch { /* already registered */ }

    console.debug(TAG, "Settings registered.");
  });

  SS.Storage = {
    getSlot(i) {
      const raw = game.settings.get(MOD, SS.SETTING.SLOT(i));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },

    async setSlot(i, blob) {
      if (!game.user?.isGM) { console.warn(TAG, "setSlot: GM only"); return; }
      await game.settings.set(MOD, SS.SETTING.SLOT(i), JSON.stringify(blob));
    },

    async deleteSlot(i) {
      if (!game.user?.isGM) return;
      await game.settings.set(MOD, SS.SETTING.SLOT(i), "");
    },

    getNpcTemplateId() {
      try { return game.settings.get(MOD, SS.SETTING.NPC_TEMPLATE) || "yegF6R8aaymhrvCg"; }
      catch { return "yegF6R8aaymhrvCg"; }
    },
  };

  console.debug(TAG, "Storage loaded.");
})();
