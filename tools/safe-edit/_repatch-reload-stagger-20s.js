// Widen reload stagger 12s -> 20s so each reconnect-vend (which ran 12-15s under
// reload load) fully completes AND frees before the next client reloads — true
// serialization, peak stays ~1 vend instead of stacking to OOM.
const { getDoc, safeEdit } = require("./lib");
const UUID = "Macro.VzLoDAM7jRvWPTRN";
(async () => {
  const doc = await getDoc(UUID);
  if (!doc.command.includes("const STAGGER_MS = 12000;")) {
    console.log("Did not find 'const STAGGER_MS = 12000;' — current value:",
      (doc.command.match(/const STAGGER_MS = \d+;/) || ["?"])[0]); process.exit(1);
  }
  const c = doc.command.replace("const STAGGER_MS = 12000;", "const STAGGER_MS = 20000;");
  const r = await safeEdit({ uuid: UUID, patch: { command: c },
    note: "reload-all: widen stagger 12s->20s to fully serialize reconnect-vends" });
  console.log("Patched live macro to 20s. Journal:", r.entryId);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
