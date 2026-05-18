#!/usr/bin/env node
/**
 * Reaction Exchange — scenario test driver
 * ---------------------------------------------------------------------------
 * Posts each JSON scenario in `scenarios/` to the running Foundry world's
 * test-bridge inbox and polls the outbox for the response. Reports
 * pass/fail per scenario.
 *
 * Usage:
 *   node tools/exchange-tests/run-scenarios.js                # all scenarios
 *   node tools/exchange-tests/run-scenarios.js 01-happy-path  # one by name
 *
 * Requires:
 *   - Foundry running with the `fabula-ultima-2` world loaded
 *   - test-bridge active (it auto-arms on world load)
 *
 * Prints a summary at the end. Exits non-zero on any failure.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WORLD = "fabula-ultima-2";
const INBOX = path.join(REPO_ROOT, "worlds", WORLD, "test-bridge", "inbox");
const OUTBOX = path.join(REPO_ROOT, "worlds", WORLD, "test-bridge", "outbox");
const SCENARIOS_DIR = path.join(__dirname, "scenarios");

const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDir(p) {
  if (!fs.existsSync(p)) {
    throw new Error(
      `test-bridge directory missing: ${p}\n` +
      `Start Foundry on world "${WORLD}" — the bridge auto-creates its dirs.`
    );
  }
}

async function postRequest(kind, args) {
  ensureDir(INBOX);
  ensureDir(OUTBOX);
  const id = `exch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const reqPath = path.join(INBOX, `req-${id}.json`);
  const resPath = path.join(OUTBOX, `res-${id}.json`);
  const req = { id, kind, args, submittedAt: new Date().toISOString() };
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2), "utf8");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(resPath)) {
      const raw = fs.readFileSync(resPath, "utf8");
      // Bridge protocol: requester deletes both files after consuming.
      try { fs.unlinkSync(reqPath); } catch (_) {}
      try { fs.unlinkSync(resPath); } catch (_) {}
      return JSON.parse(raw);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try { fs.unlinkSync(reqPath); } catch (_) {}
  throw new Error(`bridge timeout (${POLL_TIMEOUT_MS}ms): no response for ${id} kind=${kind}`);
}

async function pingBridge() {
  try {
    const res = await postRequest("ping", {});
    if (!res?.ok) throw new Error(`ping failed: ${res?.errorMessage || "no ok flag"}`);
    return res.result ?? res;
  } catch (e) {
    throw new Error(
      `bridge not responding: ${e.message}\n` +
      `Make sure Foundry is running with world "${WORLD}" loaded and the bridge active.`
    );
  }
}

function loadScenarios(filter) {
  if (!fs.existsSync(SCENARIOS_DIR)) {
    throw new Error(`scenarios dir not found: ${SCENARIOS_DIR}`);
  }
  const files = fs.readdirSync(SCENARIOS_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();
  const out = [];
  for (const f of files) {
    const full = path.join(SCENARIOS_DIR, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      console.error(`! malformed scenario ${f}: ${e.message}`);
      continue;
    }
    const name = parsed.name ?? path.basename(f, ".json");
    if (filter && !name.includes(filter)) continue;
    out.push({ file: f, name, description: parsed.description ?? "", scenario: parsed.scenario });
  }
  return out;
}

function summarizeFailures(scenarioResult) {
  const failures = scenarioResult?.failures ?? [];
  if (failures.length === 0) return "(no failures reported)";
  return failures.map((f, i) => `  ${i + 1}. ${f}`).join("\n");
}

async function runOne(s) {
  process.stdout.write(`▶ ${s.name} … `);
  let bridgeRes;
  try {
    bridgeRes = await postRequest("runExchangeScenario", { scenario: s.scenario });
  } catch (e) {
    console.log("✗ BRIDGE ERROR");
    console.log(`  ${e.message}`);
    return false;
  }
  if (!bridgeRes?.ok) {
    console.log("✗ BRIDGE NACK");
    console.log(`  error: ${bridgeRes?.errorMessage || "unknown"}`);
    if (bridgeRes?.errorStack) console.log(`  stack:\n${bridgeRes.errorStack}`);
    return false;
  }
  const result = bridgeRes.result;
  if (!result || typeof result !== "object") {
    console.log("✗ unexpected response shape");
    console.log(JSON.stringify(bridgeRes, null, 2));
    return false;
  }
  if (result.ok) {
    console.log("✓");
    return true;
  }
  console.log("✗");
  console.log(`  failedStep: ${result.failedStep}`);
  console.log(summarizeFailures(result));
  if (process.env.EXCHANGE_TEST_VERBOSE) {
    console.log("  log:");
    for (const l of result.log ?? []) {
      console.log(`    [${l.stepIndex}] ${l.op} ok=${l.ok}${l.error ? " err="+l.error : ""}`);
    }
  }
  return false;
}

async function main() {
  const filter = process.argv[2] || null;
  console.log(`Reaction Exchange test runner`);
  console.log(`  scenarios dir: ${SCENARIOS_DIR}`);
  console.log(`  world:         ${WORLD}`);
  if (filter) console.log(`  filter:        contains "${filter}"`);
  console.log();

  await pingBridge();
  console.log("✓ bridge alive\n");

  const scenarios = loadScenarios(filter);
  if (scenarios.length === 0) {
    console.log("(no scenarios matched)");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  for (const s of scenarios) {
    const ok = await runOne(s);
    if (ok) passed++;
    else failed++;
  }
  console.log();
  console.log(`Summary: ${passed} passed, ${failed} failed, ${scenarios.length} total.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("fatal:", e?.stack ?? e?.message ?? String(e));
  process.exit(2);
});
