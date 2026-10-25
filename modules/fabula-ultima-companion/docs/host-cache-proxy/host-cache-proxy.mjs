#!/usr/bin/env node
// host-cache-proxy — let players' browsers keep Foundry's static files between reloads.
//
// Foundry answers every static file with `Cache-Control: no-cache`, so each page
// load re-asks the host about every script, stylesheet, image and video: ~750
// files from this module alone, over HTTP/1.1. On a slow route that cost ~53 s per
// reload on 2026-10-24 (docs/player-reload-investigation-2026-10-24.md).
//
// This sits in front of Foundry and rewrites that header to
// `public, max-age=<MAX_AGE>` on successful GETs of static file types. A player
// who reloads within that window loads them from their own disk with no request.
// Everything else passes through untouched: pages, the API, uploads, and the
// game socket (websocket upgrades are piped as raw TCP).
//
// Players join on the proxy port; Foundry itself is unchanged, so the test
// bridge and local tools keep using :30000 directly. No dependencies beyond Node.
//
//   node host-cache-proxy.mjs                         listen :30080 → 127.0.0.1:30000, 6 h
//   PORT=30080 TARGET=http://127.0.0.1:30000 MAX_AGE=21600 node host-cache-proxy.mjs
//
// Trade-off: a code fix pushed MID-SESSION reaches a player only after MAX_AGE or
// a hard reload (Ctrl+Shift+R / Ctrl+F5). Restart nothing; just tell them.
import http from "node:http";
import net from "node:net";

const PORT    = Number(process.env.PORT ?? 30080);
const TARGET  = new URL(process.env.TARGET ?? "http://127.0.0.1:30000");
const MAX_AGE = Number(process.env.MAX_AGE ?? 21600);

// static file types only: no .json (world/api data could ride it) and no
// extensionless paths (/game, /join, /api/status, /socket.io/...)
const CACHEABLE = /\.(?:js|mjs|css|png|jpe?g|webp|gif|svg|avif|webm|mp4|m4v|ogg|oga|mp3|wav|flac|woff2?|ttf|otf)$/i;

const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

export function cacheHeaderFor(method, url, status) {
  // HEAD answers the same headers as GET, so `curl -I` shows what browsers get
  if ((method !== "GET" && method !== "HEAD") || status < 200 || status >= 300) return null;
  const path = url.split("?")[0];
  return CACHEABLE.test(decodeURIComponent(path)) ? `public, max-age=${MAX_AGE}` : null;
}

export function createProxy() {
  const server = http.createServer((req, res) => {
    const up = http.request({
      host: TARGET.hostname, port: TARGET.port, method: req.method, path: req.url,
      headers: req.headers, agent,
    }, upRes => {
      const headers = { ...upRes.headers };
      const cc = cacheHeaderFor(req.method, req.url, upRes.statusCode);
      if (cc) headers["cache-control"] = cc;
      res.writeHead(upRes.statusCode, upRes.statusMessage, headers);
      upRes.pipe(res);
    });
    up.on("error", err => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`host-cache-proxy: Foundry unreachable (${err.code ?? err.message})`);
    });
    req.pipe(up);
  });

  // the game socket: replay the upgrade request upstream, then splice the sockets
  server.on("upgrade", (req, client, head) => {
    const upstream = net.connect(Number(TARGET.port), TARGET.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const close = () => { client.destroy(); upstream.destroy(); };
    upstream.on("error", close);
    client.on("error", close);
  });

  return server;
}

if (process.argv[1]?.endsWith("host-cache-proxy.mjs")) {
  createProxy().listen(PORT, () => {
    console.log(`host-cache-proxy: :${PORT} → ${TARGET.origin}, static max-age ${MAX_AGE}s`);
  });
}
