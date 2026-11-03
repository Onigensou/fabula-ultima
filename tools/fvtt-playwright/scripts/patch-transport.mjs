// Idempotent patcher for playwright-core's PipeTransport.
//
// WHY: Foundry pushes the ENTIRE world snapshot over its WebSocket on join.
// Playwright's internal Network domain mirrors that socket frame as a single
// `Network.webSocketFrameReceived` CDP message — for the FU world that frame is
// ~600MB, past V8's max string length (0x1fffffe8 ≈ 512MB). PipeTransport's
// `Buffer.concat(...).toString()` then throws ERR_STRING_TOO_LONG and kills the
// node process the instant the world reaches game.ready. This is what made the
// Playwright control-plane "dead" for this world.
//
// THE FIX: drop CDP frames over a safe threshold (they're only the giant socket
// mirror / console / exception payloads we never need) instead of crashing.
// node_modules is gitignored, so this re-applies the patch after any reinstall.
// Run: node scripts/patch-transport.mjs   (also wired as an npm "postinstall").
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, "../node_modules/playwright-core/lib/coreBundle.js");

let src = readFileSync(target, "utf8");
if (src.includes("[fvtt-patch")) {
  console.log("[patch-transport] already patched — nothing to do.");
  process.exit(0);
}

const NEEDLE = `      _dispatch(buffer) {
        let end = buffer.indexOf("\\0");
        if (end === -1) {
          this._pendingBuffers.push(buffer);
          return;
        }
        this._pendingBuffers.push(buffer.slice(0, end));
        const message = Buffer.concat(this._pendingBuffers).toString();
        this._waitForNextTask(() => {
          if (this.onmessage)
            this.onmessage.call(null, JSON.parse(message));
        });
        let start3 = end + 1;
        end = buffer.indexOf("\\0", start3);
        while (end !== -1) {
          const message2 = buffer.toString(void 0, start3, end);
          this._waitForNextTask(() => {
            if (this.onmessage)
              this.onmessage.call(null, JSON.parse(message2));
          });
          start3 = end + 1;
          end = buffer.indexOf("\\0", start3);
        }
        this._pendingBuffers = [buffer.slice(start3)];`;

const REPLACEMENT = `      _dispatch(buffer) {
        // [fvtt-patch] FU world boot emits a single >512MB CDP frame (the world
        // snapshot mirrored via Network.webSocketFrameReceived) → toString()
        // throws ERR_STRING_TOO_LONG. Drop oversized frames; log a head.
        const __FVTT_MAX = 300 * 1024 * 1024;
        const __fvttEmit = (msg) => {
          this._waitForNextTask(() => {
            if (this.onmessage)
              this.onmessage.call(null, JSON.parse(msg));
          });
        };
        let end = buffer.indexOf("\\0");
        if (end === -1) {
          this._pendingBuffers.push(buffer);
          return;
        }
        this._pendingBuffers.push(buffer.slice(0, end));
        const __concat = Buffer.concat(this._pendingBuffers);
        if (__concat.length > __FVTT_MAX) {
          console.error("[fvtt-patch] dropped oversized CDP frame:", __concat.length, "bytes — head:", __concat.toString("utf8", 0, 400));
        } else {
          __fvttEmit(__concat.toString());
        }
        let start3 = end + 1;
        end = buffer.indexOf("\\0", start3);
        while (end !== -1) {
          if (end - start3 > __FVTT_MAX) {
            console.error("[fvtt-patch] dropped oversized CDP frame (inline):", end - start3, "bytes — head:", buffer.toString("utf8", start3, start3 + 400));
          } else {
            __fvttEmit(buffer.toString(void 0, start3, end));
          }
          start3 = end + 1;
          end = buffer.indexOf("\\0", start3);
        }
        this._pendingBuffers = [buffer.slice(start3)];`;

if (!src.includes(NEEDLE)) {
  console.error("[patch-transport] FAILED: PipeTransport._dispatch signature not found — playwright-core may have changed. Patch manually.");
  process.exit(1);
}
src = src.replace(NEEDLE, REPLACEMENT);
writeFileSync(target, src, "utf8");
console.log("[patch-transport] patched", target);
