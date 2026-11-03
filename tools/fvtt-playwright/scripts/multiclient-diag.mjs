// Isolate WHICH step of the multiclient rig hangs, with a hard timeout per step.
// Unbuffered logging (no pipes) so progress is visible live.
import { connect } from "../lib/foundry.js";
import { installProbe, snapshot } from "../lib/multiclient.js";

const say = (m) => { process.stdout.write(`[diag] ${m}\n`); };
const withTimeout = async (label, ms, fn) => {
  const t0 = Date.now();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms`)), ms); });
  try {
    const r = await Promise.race([fn(), timeout]);
    say(`  ✓ ${label} — ${Date.now() - t0}ms`);
    return r;
  } catch (e) {
    say(`  ✗ ${label} — ${Date.now() - t0}ms — ${e.message}`);
    throw e;
  } finally { clearTimeout(timer); }
};

const user = process.argv[2] ?? "Rinri";
let h;
try {
  say(`connecting as ${user} (headless, no CDP Network domain) …`);
  h = await withTimeout("connect", 180000, () => connect({ user, headless: true, autoStartServer: false }));

  const who = await withTimeout("evaluate(game.user)", 15000, () =>
    h.evaluate(() => ({ name: game.user.name, id: game.user.id, ready: game.ready })));
  say(`    joined as ${who.name} (${who.id})`);

  await withTimeout("installProbe", 20000, () => installProbe(h));

  const s1 = await withTimeout("snapshot (pre-Network)", 15000, () => snapshot(h));
  say(`    probe events so far: ${s1?.events?.length ?? "n/a"}`);

  // THE SUSPECT: enabling the CDP Network domain on this world.
  await withTimeout("Network.enable", 30000, () => h.client.send("Network.enable"));

  await withTimeout("emulateNetworkConditions", 15000, () => h.client.send("Network.emulateNetworkConditions", {
    offline: false, latency: 200, downloadThroughput: 1.5 * 1024 * 1024 / 8, uploadThroughput: 512 * 1024 / 8,
  }));

  const s2 = await withTimeout("evaluate after shaping", 20000, () => h.evaluate(() => game.user.name));
  say(`    page still responsive: ${s2}`);

  say("ALL STEPS OK");
} catch (e) {
  say(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (h) { try { await h.close(); say("closed"); } catch (e) { say(`close failed: ${e.message}`); } }
}
