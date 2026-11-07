// scripts/camp-system/camp-summons-bootstrap.js
//
// Wires Camp Summons into the running client: the socket, the GM-side phase /
// rest / sweep hooks, the walk follow and Q swap (camp-summons-core.js), then
// the camp row button (camp-summons-ui.js). The button loads separately so a
// UI failure can't take the GM side down with it.

import { installCampSummons } from "./camp-summons-core.js";

Hooks.once("ready", async () => {
  try { installCampSummons(); } catch (e) { console.error("[CampSummons] install failed", e); return; }
  try {
    const UI = await import("./camp-summons-ui.js");
    UI.initCampSummonsUI();
  } catch (e) { console.warn("[CampSummons] button failed to load (the GM side still works)", e); }
});
