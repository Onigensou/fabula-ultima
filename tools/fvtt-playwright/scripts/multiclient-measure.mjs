// multiclient-measure — send controlled-size payloads from the GM to a table of
// real clients and measure per-client arrival latency.
//
//   node scripts/multiclient-measure.mjs [--headed] [--users A,B] [--profiles lan,weak] [--reps 5]
//
// This isolates TRANSPORT from game logic: it broadcasts a benign `__perf-probe`
// menuSpec that no player handler acts on, so nothing renders and no game state
// changes — only the socket path is exercised. That is exactly the axis we are
// optimizing (payload size vs. per-client downlink).
//
// STEP 0 is a validity check, and it is not optional: Chromium's CDP network
// throttling is documented NOT to apply to WebSocket frames, and Foundry runs
// its socket over WebSocket. If shaping is a no-op here, every latency number
// below would be fiction — so we prove shaping bites BEFORE reporting anything.
import { openTable, closeTable, snapshot, resetProbe, NETWORK_PROFILES } from "../lib/multiclient.js";
import { evalGM } from "./bridge.mjs";

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const headed = argv.includes("--headed");
const users = (flag("users", "Rinri,Trinio")).split(",").map((s) => s.trim()).filter(Boolean);
const profiles = (flag("profiles", "lan,weak")).split(",").map((s) => s.trim()).filter(Boolean);
const reps = Number(flag("reps", "5"));
const SIZES = (flag("sizes", "1024,8192,65536,262144")).split(",").map(Number);

const clients = users.map((user, i) => ({ user, profile: profiles[i] ?? profiles.at(-1) ?? "lan" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : null);

// Broadcast one padded probe envelope to the given user ids, from the GM.
//
// The padding MUST be incompressible. Foundry's socket applies permessage-
// deflate, so `"x".repeat(n)` collapses to a few bytes on the wire and a
// bandwidth-shaped link shows no effect at all — which is exactly the false
// negative this test produced on its first run. Random base36 keeps the wire
// size close to the nominal size, so payload-size effects are real.
async function broadcast(ids, kind, padBytes) {
  const res = await evalGM(`
    const ch = FUCompanion.api.experimental.battleDirector.intentChannel.get();
    if (!ch) return "no-channel";
    let pad = "";
    while (pad.length < ${padBytes}) pad += Math.random().toString(36).slice(2);
    pad = pad.slice(0, ${padBytes});
    ch.broadcastMenuOpen({
      targetUserIds: ${JSON.stringify(ids)},
      menuSpec: { kind: ${JSON.stringify(kind)}, pad },
    });
    return "sent";
  `, 60000);
  if (!res?.ok) throw new Error(`broadcast failed: ${res?.error ?? "unknown"}`);
  return res.result;
}

// Remove the probe kinds from the GM's replay cache so a later reconnect can't
// replay megabytes of test padding at a real player.
async function cleanupCache(ids, kinds) {
  await evalGM(`
    const ch = FUCompanion.api.experimental.battleDirector.intentChannel.get();
    if (ch) for (const k of ${JSON.stringify(kinds)}) {
      try { ch.broadcastMenuClose({ targetUserIds: ${JSON.stringify(ids)}, kind: k, reason: "perf-cleanup" }); } catch {}
    }
    return "cleaned";
  `);
}

let table = [];
const usedKinds = [];
try {
  table = await openTable(clients, { headless: !headed });
  const ids = [];
  for (const c of table) {
    c.userId = await c.handle.evaluate(() => game.user.id);
    ids.push(c.userId);
  }

  // ── STEP 0: does shaping actually bite on the WebSocket? ──────────────────
  console.log("\n=== validity check: is shaping actually reaching the socket? ===");
  const shaped = table.find((c) => c.profileName !== "lan");
  const unshaped = table.find((c) => c.profileName === "lan");
  if (!shaped || !unshaped) {
    console.log("  SKIPPED — need one 'lan' client and one shaped client to compare.");
  } else {
    for (const c of table) await resetProbe(c.handle);
    const kind = "__perf-probe:validity";
    usedKinds.push(kind);
    for (let i = 0; i < Math.max(3, reps); i++) { await broadcast(ids, kind, 512 * 1024); await sleep(900); }
    await sleep(1500);
    const lag = {};
    for (const c of table) {
      const s = await snapshot(c.handle);
      lag[c.user] = pct(s.events.filter((e) => e.kind === kind && e.forMe).map((e) => e.lagMs), 0.5);
    }
    console.log(`  512KB payload, median arrival lag:`);
    for (const c of table) console.log(`    ${c.user.padEnd(12)} ${String(lag[c.user]).padStart(6)} ms   (${c.profile.label})`);
    const a = lag[unshaped.user], b = lag[shaped.user];
    if (a == null || b == null) {
      console.log("  INCONCLUSIVE — no samples arrived.");
    } else if (b > a * 1.5 + 50) {
      console.log(`  ✓ shaping IS effective (shaped client ${(b / Math.max(a, 1)).toFixed(1)}x slower) — numbers below are meaningful.`);
    } else {
      console.log(`  ✗ shaping is NOT reaching the socket (${b}ms vs ${a}ms).`);
      console.log("    Two known causes, in order of likelihood:");
      console.log("      1. compressible payload — permessage-deflate shrinks it so the");
      console.log("         bandwidth limit never binds (use incompressible padding);");
      console.log("      2. shaper:'cdp' — CDP throttling does not touch WebSocket frames.");
      console.log("    => latency numbers below are NOT trustworthy until this passes.");
    }
  }

  // ── payload-size sweep ────────────────────────────────────────────────────
  console.log("\n=== payload size sweep ===");
  for (const c of table) await resetProbe(c.handle);
  for (const size of SIZES) {
    const kind = `__perf-probe:${size}`;
    usedKinds.push(kind);
    for (let i = 0; i < reps; i++) { await broadcast(ids, kind, size); await sleep(500); }
  }
  await sleep(2000);

  for (const c of table) {
    const s = await snapshot(c.handle);
    console.log(`\n---- ${c.user} — ${c.profile.label} ----`);
    console.log(`  ${"payload".padEnd(10)} ${"n".padStart(3)}  ${"p50".padStart(7)} ${"p95".padStart(7)}  ${"bytes/env".padStart(10)}`);
    for (const size of SIZES) {
      const kind = `__perf-probe:${size}`;
      const ev = s.events.filter((e) => e.kind === kind && e.forMe);
      const lags = ev.map((e) => e.lagMs).filter((x) => typeof x === "number");
      const avgB = ev.length ? Math.round(ev.reduce((t, e) => t + e.bytes, 0) / ev.length) : 0;
      console.log(`  ${String(size).padEnd(10)} ${String(ev.length).padStart(3)}  ${String(pct(lags, 0.5) ?? "-").padStart(5)}ms ${String(pct(lags, 0.95) ?? "-").padStart(5)}ms  ${String(avgB).padStart(10)}`);
    }
    if (s.errors.length) console.log("  probe errors:", s.errors);
  }
  console.log("\n[measure] done.");
} catch (e) {
  console.error("[measure] FAILED:", e?.stack ?? e?.message ?? e);
  process.exitCode = 1;
} finally {
  try {
    const ids = table.map((c) => c.userId).filter(Boolean);
    if (ids.length && usedKinds.length) await cleanupCache(ids, usedKinds);
  } catch (e) { console.error("[measure] cache cleanup failed:", e?.message); }
  await closeTable(table);
}
