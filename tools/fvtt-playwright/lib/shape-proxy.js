// shape-proxy — a TCP proxy that applies REAL bandwidth + latency shaping.
//
// WHY THIS EXISTS (measured, not assumed):
// Chromium's CDP `Network.emulateNetworkConditions` does NOT throttle WebSocket
// frames, and Foundry carries all of its game traffic over a WebSocket. The
// multiclient validity check proved it: a client shaped to 1.5 Mbps received a
// 512KB payload only ~0.7s slower than an unshaped one, when the link speed
// alone should have added ~2.8s. So CDP shaping is useless for this project.
//
// This proxy sits between the browser and the Foundry server at the TCP level,
// so it shapes EVERYTHING — HTTP, WebSocket upgrade, and every socket frame
// after it — because it never has to understand any of them.
//
// Per direction we model:
//   * bandwidth — a token bucket drained at bytesPerSec
//   * latency   — each chunk is held for latencyMs/2 per direction (so a
//                 round trip costs the full configured latency)
//
// Point a browser at http://127.0.0.1:<proxyPort> instead of the real port.
import net from "node:net";

/**
 * One shaped direction: accepts chunks, releases them subject to added latency
 * and a token-bucket rate limit. Order is always preserved.
 */
function makeShaper(write, limits, dir) {
  const queue = [];           // [{ buf, readyAt }]
  let tokens = 0;
  let lastRefill = Date.now();
  let timer = null;
  let closed = false;

  // Limits are read through a shared, MUTABLE ref on every pump so they can be
  // tightened after the client has booted. This is load-bearing: Foundry pushes
  // a ~493MB world snapshot on join, so booting through a 1.5 Mbps shaper would
  // take ~40 minutes. Boot unshaped, then clamp — which also models the real
  // case (a player already in the session whose link is slow during play).
  const rate = () => (dir === "down" ? limits.download : limits.upload) || 0;
  const lat = () => limits.latency || 0;

  const pump = () => {
    timer = null;
    if (closed) return;
    const now = Date.now();
    const bps = rate();
    const unlimited = bps <= 0;

    if (!unlimited) {
      const dt = (now - lastRefill) / 1000;
      lastRefill = now;
      tokens = Math.min(bps, tokens + dt * bps);
    } else {
      lastRefill = now;
    }

    while (queue.length) {
      const head = queue[0];
      if (head.readyAt > now) break;                 // still serving its latency
      if (unlimited) { write(queue.shift().buf); continue; }
      if (tokens < 1) break;                          // out of budget this tick
      const n = Math.min(head.buf.length, Math.floor(tokens));
      if (n <= 0) break;
      if (n === head.buf.length) { queue.shift(); write(head.buf); }
      else { write(head.buf.subarray(0, n)); head.buf = head.buf.subarray(n); }
      tokens -= n;
    }

    if (queue.length) schedule();
  };

  const schedule = () => {
    if (timer || closed || !queue.length) return;
    const now = Date.now();
    const bps = rate();
    const waitLatency = Math.max(0, queue[0].readyAt - now);
    // If we're rate-limited, wait long enough to accrue a useful budget.
    const waitTokens = bps <= 0 || tokens >= 1 ? 0 : Math.ceil((1 - tokens) / bps * 1000);
    timer = setTimeout(pump, Math.max(1, waitLatency, waitTokens));
  };

  return {
    push(buf) {
      if (closed) return;
      queue.push({ buf, readyAt: Date.now() + lat() / 2 });
      schedule();
    },
    close() { closed = true; if (timer) clearTimeout(timer); queue.length = 0; },
  };
}

/**
 * Start a shaping proxy.
 *   opts: { targetHost, targetPort, listenPort, download, upload, latency }
 *   download/upload are BYTES per second (0 / undefined = unlimited).
 * Returns { port, url, close() }.
 */
export function startShapeProxy({
  targetHost = "127.0.0.1", targetPort = 30000, listenPort = 0,
  download = 0, upload = 0, latency = 0, onLog = () => {},
} = {}) {
  const sockets = new Set();
  // Shared mutable limits — setLimits() retunes every live connection.
  const limits = { download, upload, latency };
  // Raw TCP byte counters, tallied BEFORE the shaper so they reflect what the
  // server actually put on the wire — i.e. compressed WebSocket frames
  // (permessage-deflate), not the payload sizes a page-side probe would see.
  // This is the whole point of measuring here: MULTICLIENT.md constraint 3.
  const counters = { down: 0, up: 0 };

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect({ host: targetHost, port: targetPort });
    sockets.add(upstream);

    // server -> browser is "download"; browser -> server is "upload".
    const toBrowser = makeShaper((b) => { if (!client.destroyed) client.write(b); }, limits, "down");
    const toServer = makeShaper((b) => { if (!upstream.destroyed) upstream.write(b); }, limits, "up");

    client.on("data", (b) => { counters.up += b.length; toServer.push(b); });
    upstream.on("data", (b) => { counters.down += b.length; toBrowser.push(b); });

    const shutdown = () => {
      toBrowser.close(); toServer.close();
      for (const s of [client, upstream]) { try { s.destroy(); } catch {} sockets.delete(s); }
    };
    client.on("close", shutdown);
    upstream.on("close", shutdown);
    client.on("error", shutdown);
    upstream.on("error", shutdown);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      const port = server.address().port;
      onLog(`[shape-proxy] :${port} -> ${targetHost}:${targetPort}  down=${download || "∞"}B/s up=${upload || "∞"}B/s lat=${latency}ms`);
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        limits,
        /** Cumulative raw TCP bytes through this proxy since boot. */
        bytes: () => ({ ...counters }),
        /**
         * Window helper: `const w = proxy.mark(); …; w.since()` -> bytes moved
         * during the window. Use it to bracket a measured battle rather than
         * subtracting boot traffic by hand.
         */
        mark() {
          const at = { ...counters };
          return { at, since: () => ({ down: counters.down - at.down, up: counters.up - at.up }) };
        },
        /** Retune live connections — used to clamp AFTER the world has booted. */
        setLimits({ download: d, upload: u, latency: l } = {}) {
          if (d !== undefined) limits.download = d;
          if (u !== undefined) limits.upload = u;
          if (l !== undefined) limits.latency = l;
          onLog(`[shape-proxy] :${port} retuned  down=${limits.download || "∞"}B/s up=${limits.upload || "∞"}B/s lat=${limits.latency}ms`);
          return { ...limits };
        },
        close: () => new Promise((res) => {
          for (const s of sockets) { try { s.destroy(); } catch {} }
          server.close(() => res());
        }),
      });
    });
  });
}
