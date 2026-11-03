// multiclient — drive N real Foundry clients at once, throttle them
// independently, and measure what each one actually receives.
//
// Why this exists
// ---------------
// The in-page emulation in the BD test suite proves CORRECTNESS (who receives
// which envelope) and gives exact byte counts, but it runs in one process, so it
// cannot measure the thing players actually complain about: how long it takes a
// card to appear on a slow connection. This rig connects real browsers as real
// player users, applies a per-client network profile, and records every
// battle-director envelope that arrives, with timings.
//
// Design constraints discovered the hard way (do not "simplify" these away):
//
//  1. The CDP **Network domain must not be enabled during world boot.** Enabling
//     it while the ~500MB world loads is the documented cause of the
//     ERR_STRING_TOO_LONG transport crash (see lib/foundry.js launch()). We
//     connect with the domain OFF, wait for game.ready, and only THEN enable
//     Network + apply throttling. Throttling after boot is fine — the traffic we
//     measure is all post-boot socket traffic.
//
//  2. Clients here are **observers**. They join, listen, and measure; they do not
//     take game actions. That keeps the rig safe to point at a live world (the
//     documented Playwright hazard is driving destructive writes, not joining).
//     If you later want clients to ACT, run it against a copied world first.
//
//  3. One browser per client. Contexts would be lighter, but Foundry keys a
//     session per browser context+user and sharing storage between them causes
//     session stealing; separate browsers is the boring, reliable option.
import { connect, loadConfig } from "./foundry.js";
import { startShapeProxy } from "./shape-proxy.js";

// Per-client network shaping, applied via CDP. Throughput is BYTES/sec (CDP's
// unit), latency is added RTT in ms. `null` profile = no shaping at all.
export const NETWORK_PROFILES = {
  lan:    { label: "LAN (unshaped)",      download: -1,                upload: -1,               latency: 0 },
  good:   { label: "good home (25/5)",    download: 25 * 1024 * 1024 / 8, upload: 5 * 1024 * 1024 / 8, latency: 25 },
  ok:     { label: "modest (8/2)",        download:  8 * 1024 * 1024 / 8, upload: 2 * 1024 * 1024 / 8, latency: 60 },
  weak:   { label: "weak (1.5/0.5)",      download: 1.5 * 1024 * 1024 / 8, upload: 512 * 1024 / 8,   latency: 200 },
  awful:  { label: "awful (0.4/0.128)",   download: 400 * 1024 / 8,     upload: 128 * 1024 / 8,   latency: 400 },
  mobile: { label: "bad mobile (1/0.3)",  download: 1024 * 1024 / 8,    upload: 300 * 1024 / 8,   latency: 300 },
};

const CHANNEL = "module.fabula-ultima-companion";
const MIRROR_ROOT_ID = "fud-bf-mirror-root";

// ── The in-page probe ────────────────────────────────────────────────────────
// Attaches an ADDITIONAL socket listener (socket.io supports many; the module's
// own handler is untouched) and records every battle-director envelope with its
// emit timestamp, arrival time and serialized size. Also watches for the mirror
// action-card node so we can time "envelope arrived -> card actually on screen".
function probeSource(channel, mirrorRootId) {
  const g = globalThis;
  if (g.__fudProbe) return "already-installed";
  const probe = {
    startedAt: Date.now(),
    events: [],           // { kind, event, bytes, emittedAt, arrivedAt, lagMs }
    cardOpens: [],        // { kind, arrivedAt, renderedAt, renderMs }
    pendingCard: null,
    errors: [],
  };
  g.__fudProbe = probe;

  try {
    g.game.socket.on(channel, (env) => {
      try {
        const arrivedAt = Date.now();
        let bytes = 0;
        try { bytes = JSON.stringify(env).length; } catch { bytes = -1; }
        const kind = env?.payload?.menuSpec?.kind ?? env?.payload?.patch?.kind ?? null;
        const emittedAt = typeof env?.timestamp === "number" ? env.timestamp : null;
        // Addressed to THIS client? Mirrors IntentChannel._isForMe.
        const me = g.game.user?.id ?? null;
        const many = env?.payload?.targetUserIds;
        const forMe = Array.isArray(many) ? many.includes(me) : env?.payload?.targetUserId === me;
        probe.events.push({
          event: env?.event ?? null, kind, bytes, forMe,
          emittedAt, arrivedAt, lagMs: emittedAt == null ? null : arrivedAt - emittedAt,
        });
        if (forMe && env?.event === "MENU_OPEN" && kind === "action-card") {
          probe.pendingCard = { kind, arrivedAt };
        }
      } catch (e) { probe.errors.push(String(e?.message ?? e)); }
    });
  } catch (e) { probe.errors.push("socket hook failed: " + String(e?.message ?? e)); }

  // Time the mirror card actually appearing in the DOM.
  try {
    const obs = new MutationObserver(() => {
      if (!probe.pendingCard) return;
      const el = document.getElementById(mirrorRootId);
      if (!el) return;
      const renderedAt = Date.now();
      probe.cardOpens.push({
        kind: probe.pendingCard.kind,
        arrivedAt: probe.pendingCard.arrivedAt,
        renderedAt,
        renderMs: renderedAt - probe.pendingCard.arrivedAt,
      });
      probe.pendingCard = null;
    });
    obs.observe(document.body, { childList: true, subtree: true });
    probe.observer = obs;
  } catch (e) { probe.errors.push("observer failed: " + String(e?.message ?? e)); }

  return "installed";
}

/** Install the recording probe in a connected client. */
export async function installProbe(handle) {
  return handle.page.evaluate(
    ({ ch, rid, src }) => {
      // eslint-disable-next-line no-new-func
      return new Function("channel", "mirrorRootId", `return (${src})(channel, mirrorRootId)`)(ch, rid);
    },
    { ch: CHANNEL, rid: MIRROR_ROOT_ID, src: probeSource.toString() }
  );
}

/**
 * Apply a network profile. MUST be called only after game.ready — see note 1.
 * Pass null/"lan" to leave the connection unshaped.
 */
export async function applyProfile(handle, profileName) {
  const p = NETWORK_PROFILES[profileName ?? "lan"];
  if (!p) throw new Error(`unknown network profile "${profileName}"`);
  await handle.client.send("Network.enable");
  await handle.client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: p.latency,
    downloadThroughput: p.download,
    uploadThroughput: p.upload,
  });
  return p;
}

/** Read the probe's accumulated data out of a client. */
export async function snapshot(handle) {
  return handle.page.evaluate(() => {
    const p = globalThis.__fudProbe;
    if (!p) return null;
    return {
      events: p.events, cardOpens: p.cardOpens, errors: p.errors,
      startedAt: p.startedAt, now: Date.now(),
    };
  });
}

/** Zero the counters without reconnecting — use between scenarios. */
export async function resetProbe(handle) {
  return handle.page.evaluate(() => {
    const p = globalThis.__fudProbe;
    if (!p) return false;
    p.events = []; p.cardOpens = []; p.errors = []; p.pendingCard = null; p.startedAt = Date.now();
    return true;
  });
}

/**
 * Connect a table of clients.
 *
 * clients: [{ user: "Rinri", profile: "weak" }, ...]
 * Connections are made SEQUENTIALLY on purpose: N simultaneous world boots of a
 * ~500MB world will thrash memory and produce misleading first-run timings.
 */
/**
 * `forceProxy` routes even an unshaped ("lan") client through the proxy, with
 * all limits left at 0. Costs a little overhead but makes `proxy.bytes()` /
 * `proxy.mark()` available for a client whose link is NOT being manipulated —
 * which is how you get honest wire-byte counts (compressed frames) to compare
 * against page-side payload sizes, without a shaper confounding the timing.
 */
export async function openTable(clients, { headless = true, onLog = console.log, shaper = "proxy", baseURL = null, forceProxy = false } = {}) {
  const table = [];
  const cfgBase = (baseURL ?? loadConfig().baseURL).replace(/\/+$/, "");
  const m = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(cfgBase);
  const targetHost = m?.[1] ?? "127.0.0.1";
  const targetPort = Number(m?.[2] ?? 80);

  for (const spec of clients) {
    const profileName = spec.profile ?? "lan";
    const profile = NETWORK_PROFILES[profileName];
    if (!profile) throw new Error(`unknown network profile "${profileName}"`);

    // Real shaping happens at the TCP layer (CDP cannot touch WebSocket frames —
    // proven by multiclient-measure's validity check). Unshaped clients connect
    // straight to the server so we don't pay proxy overhead for the baseline.
    let proxy = null, url = cfgBase;
    const wantsShaping = shaper === "proxy" && profileName !== "lan";
    if (wantsShaping || (forceProxy && shaper === "proxy")) {
      // Start UNSHAPED. Foundry pushes a ~493MB world snapshot on join, so
      // booting through the target profile would take tens of minutes (and
      // trips waitReady's timeout). We clamp to the profile once the world is
      // live — which is also the realistic case we care about: a connected
      // player whose link is slow during play, not during initial load.
      proxy = await startShapeProxy({ targetHost, targetPort, download: 0, upload: 0, latency: 0, onLog });
      url = proxy.url;
    }

    onLog(`[multiclient] connecting ${spec.user} via ${url} …`);
    const handle = await connect({ user: spec.user, headless, autoStartServer: false, baseURL: url });
    await installProbe(handle);
    if (proxy) {
      proxy.setLimits({
        download: profile.download > 0 ? profile.download : 0,
        upload: profile.upload > 0 ? profile.upload : 0,
        latency: profile.latency ?? 0,
      });
    }
    if (shaper === "cdp") await applyProfile(handle, profileName);
    onLog(`[multiclient]   ${spec.user} ready — ${profile.label}${proxy ? " (TCP-shaped, clamped post-boot)" : ""}`);
    // Keep the NAME and the resolved profile OBJECT under distinct keys —
    // spreading spec would otherwise leave `profile` as the name string for
    // some entries and the object for others.
    table.push({ ...spec, handle, profileName, profile, proxy });
  }
  return table;
}

export async function closeTable(table, { onLog = console.log } = {}) {
  for (const c of table) {
    try { await c.handle.close(); } catch (e) { onLog(`[multiclient] close ${c.user} failed: ${e?.message}`); }
    try { await c.proxy?.close(); } catch (e) { onLog(`[multiclient] proxy close ${c.user} failed: ${e?.message}`); }
  }
}

/** Roll a snapshot up into per-client totals + per-kind breakdown. */
export function summarize(snap) {
  if (!snap) return null;
  const byKind = {};
  let total = 0, used = 0, wasted = 0, n = 0;
  for (const e of snap.events) {
    const k = e.kind ?? `(${e.event})`;
    const b = Math.max(0, e.bytes);
    byKind[k] ??= { count: 0, bytes: 0, forMe: 0 };
    byKind[k].count++; byKind[k].bytes += b; if (e.forMe) byKind[k].forMe++;
    total += b; n++;
    if (e.forMe) used += b; else wasted += b;
  }
  const lags = snap.events.filter((e) => e.forMe && typeof e.lagMs === "number").map((e) => e.lagMs).sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
  return {
    envelopes: n, totalBytes: total, usedBytes: used, wastedBytes: wasted,
    wastedPct: total ? Math.round((wasted / total) * 100) : 0,
    lagP50: pct(lags, 0.5), lagP95: pct(lags, 0.95), lagMax: lags.length ? lags[lags.length - 1] : null,
    cardOpens: snap.cardOpens.length,
    renderP50: pct(snap.cardOpens.map((c) => c.renderMs).sort((a, b) => a - b), 0.5),
    byKind,
    errors: snap.errors,
  };
}
