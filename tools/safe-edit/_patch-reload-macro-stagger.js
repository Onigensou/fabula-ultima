// Widen the "Reload All Clients" macro stagger to ~one world-vend apart (12s) so
// clients reload one at a time and the host never serializes the world for more
// than one client at once — three concurrent reconnect-vends OOM the V12 desktop
// host (confirmed: "FATAL ERROR ... JavaScript heap out of memory").
const { getDoc, safeEdit } = require("./lib");
const UUID = "Macro.VzLoDAM7jRvWPTRN";

(async () => {
  const doc = await getDoc(UUID);
  let c = doc.command;
  const before = c;

  // 1) define STAGGER_MS up top, next to DELAY_MS
  c = c.replace(
    "  const DELAY_MS = 800;\n",
    "  const DELAY_MS = 800;\n" +
    "  // ms between each client's reload — ~one world-vend apart, so the host never\n" +
    "  // serializes the world for more than one client at a time. Three concurrent\n" +
    "  // reconnect-vends OOM the local Foundry V12 desktop host. Tune for party size.\n" +
    "  const STAGGER_MS = 12000;\n"
  );

  // 2) pass staggerMs through the broadcast so the receiver uses the same spacing
  c = c.replace(
    "      delayMs: DELAY_MS\n    });",
    "      delayMs: DELAY_MS,\n      staggerMs: STAGGER_MS\n    });"
  );

  // 3) drop the now-duplicate STAGGER_MS def + refresh the stale 600ms comment,
  //    and tell the GM how long the staggered reload will take.
  c = c.replace(
    "  // reload-broadcast.js staggers each non-GM client by 600 ms per index, starting\n" +
    "  // at index 0 = DELAY_MS.  The GM must reload AFTER all of them so no two clients\n" +
    "  // disconnect at the same millisecond — simultaneous mass-disconnect crashes the\n" +
    "  // local Foundry V12 Electron app.\n" +
    "  const STAGGER_MS = 600;\n" +
    "  const activePlayers = game.users.filter(u => u.active && u.id !== game.userId);\n" +
    "  const gmDelay = DELAY_MS + activePlayers.length * STAGGER_MS;\n" +
    "  ui.notifications.info(\"Reload broadcast sent — reloading you in a moment…\");\n" +
    "  setTimeout(() => location.reload(), gmDelay);",
    "  // reload-broadcast.js reloads each other client at DELAY_MS + index*STAGGER_MS\n" +
    "  // (ordered by user id), so clients reload one at a time ~a vend apart and the\n" +
    "  // host never serializes the world for more than one client at once. The GM\n" +
    "  // reloads AFTER all of them.\n" +
    "  const activePlayers = game.users.filter(u => u.active && u.id !== game.userId);\n" +
    "  const gmDelay = DELAY_MS + activePlayers.length * STAGGER_MS;\n" +
    "  const totalSecs = Math.ceil(gmDelay / 1000);\n" +
    "  ui.notifications.info(`Reload sent — clients reload one at a time; you reload in ~${totalSecs}s…`);\n" +
    "  setTimeout(() => location.reload(), gmDelay);"
  );

  const applied = [
    c.includes("const STAGGER_MS = 12000;"),
    c.includes("staggerMs: STAGGER_MS"),
    !c.includes("const STAGGER_MS = 600;"),
    (c.match(/const STAGGER_MS/g) || []).length === 1,
  ];
  console.log("checks (all must be true):", applied);
  if (applied.some(x => !x) || c === before) {
    console.log("ABORT — a replacement did not match cleanly; macro left untouched.");
    process.exit(1);
  }

  const r = await safeEdit({ uuid: UUID, patch: { command: c },
    note: "reload-all: stagger reloads ~12s apart to avoid concurrent-vend OOM" });
  console.log("Patched live macro. Journal:", r.entryId);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
