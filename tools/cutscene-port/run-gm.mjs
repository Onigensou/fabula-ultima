// Cutscene port · evaluate a script in a GM page over Chrome DevTools Protocol (Foundry started with --remote-debugging-port).
//   node tools/cutscene-port/run-gm.mjs --port 9226 --file <script.js>     prints the script's result as JSON
//   node tools/cutscene-port/run-gm.mjs --port 9226 --expr "game.user.name"
// The page must be the joined game (/game). Meant for a SANDBOX Foundry; for the real world use the test bridge.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const port = +opt("--port", 9226), file = opt("--file"), expr = opt("--expr"), timeout = +opt("--timeout", 120000);

export async function evaluate(port, expression, { timeout = 120000, match = "/game" } = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page" && t.url.includes(match));
  if (!page) throw new Error(`no page matching ${match} on CDP port ${port}: ${targets.map((t) => t.url).join(", ")}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("timed out")), timeout);
    ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id !== 1) return; clearTimeout(timer);
      if (msg.result?.exceptionDetails) rej(new Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
      else res(msg.result?.result?.value); };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
  });
  ws.close();
  return result;
}

if (process.argv[1].replace(/\\/g, "/").endsWith("/run-gm.mjs")) {
  if (!file && !expr) { console.error("usage: run-gm.mjs --port <cdp> (--file <js> | --expr <js>)"); process.exit(2); }
  const code = file ? readFileSync(file, "utf8") : expr;
  evaluate(port, code, { timeout }).then((v) => console.log(JSON.stringify(v, null, 2))).catch((e) => { console.error(e.message); process.exit(1); });
}
