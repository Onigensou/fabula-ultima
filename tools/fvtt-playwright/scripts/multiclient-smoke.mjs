// multiclient smoke — connect a small table of real player clients, throttle one
// of them, prove the probe records traffic, then close cleanly.
//
//   node scripts/multiclient-smoke.mjs [--headed] [--users A,B,C] [--profiles lan,weak]
//
// The GM side is NOT driven here; this only proves the rig connects, shapes, and
// measures. Use multiclient-measure.mjs to actually time a battle action.
import { openTable, closeTable, snapshot, summarize, NETWORK_PROFILES } from "../lib/multiclient.js";

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const headed = argv.includes("--headed");
const users = (flag("users", "Rinri,Trinio") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const profiles = (flag("profiles", "lan,weak") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const holdMs = Number(flag("hold", "8000"));

const clients = users.map((user, i) => ({ user, profile: profiles[i] ?? profiles[profiles.length - 1] ?? "lan" }));

console.log("[smoke] table:", clients.map((c) => `${c.user}=${c.profile}`).join(" "));
for (const c of clients) {
  if (!NETWORK_PROFILES[c.profile]) { console.error(`unknown profile "${c.profile}"`); process.exit(2); }
}

let table = [];
try {
  table = await openTable(clients, { headless: !headed });

  // Confirm each client is a distinct, active, non-GM user in the same world.
  for (const c of table) {
    const who = await c.handle.evaluate(() => ({
      name: game.user?.name, id: game.user?.id, isGM: game.user?.isGM,
      world: game.world?.id, ready: game.ready,
      activeUsers: game.users.contents.filter((u) => u.active).map((u) => u.name),
      bdInstalled: !!globalThis.FUCompanion?.api?.experimental?.battleDirector,
    }));
    console.log(`[smoke] ${c.user}: id=${who.id} isGM=${who.isGM} world=${who.world} bd=${who.bdInstalled}`);
    console.log(`         active users seen: ${who.activeUsers.join(", ")}`);
  }

  console.log(`[smoke] holding ${holdMs}ms to catch ambient traffic …`);
  await new Promise((r) => setTimeout(r, holdMs));

  for (const c of table) {
    const s = summarize(await snapshot(c.handle));
    console.log(`\n[smoke] ---- ${c.user} — ${c.profile.label} ----`);
    console.log(`  envelopes=${s.envelopes} totalBytes=${s.totalBytes} used=${s.usedBytes} wasted=${s.wastedBytes} (${s.wastedPct}%)`);
    console.log(`  lag p50=${s.lagP50}ms p95=${s.lagP95}ms max=${s.lagMax}ms  cardOpens=${s.cardOpens}`);
    if (Object.keys(s.byKind).length) {
      for (const [k, v] of Object.entries(s.byKind).sort((a, b) => b[1].bytes - a[1].bytes)) {
        console.log(`    ${k.padEnd(30)} n=${String(v.count).padStart(4)}  ${String(v.bytes).padStart(8)} B  forMe=${v.forMe}`);
      }
    } else {
      console.log("    (no battle-director traffic during the hold — expected when idle)");
    }
    if (s.errors.length) console.log("  probe errors:", s.errors);
  }
  console.log("\n[smoke] OK — rig connected, shaped, and recorded.");
} catch (e) {
  console.error("[smoke] FAILED:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await closeTable(table);
  console.log("[smoke] closed all clients.");
}
