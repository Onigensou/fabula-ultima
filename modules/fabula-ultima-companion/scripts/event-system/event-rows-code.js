/**
 * [ONI] Event System — Run Code
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-code.js
 *
 * What this does:
 * - Registers the "Run Code" event action: a box of JavaScript that runs on the
 *   GM who runs the event, awaited like any other row, for the odd job the other
 *   rows can't do.
 * - The code is the body of an async function with one argument, `ctx`:
 *     ctx.scene, ctx.party          the scene and the party's TokenDocument
 *     ctx.marker(name)              a marker token's centre { x, y } (hidden is fine)
 *     ctx.jump(who, to, opts)       one hop, the same jump as the Jump To row
 *     ctx.jumpPath(who, lines, opts) several hops: marker names or "x, y"
 *     ctx.wait(ms)                  a pause the GM chip can end
 *     ctx.sound(src, volume)        a sound on every client
 *     ctx.event                     { sceneId, tileId, tokenId }
 *   `who` is a TokenDocument or a list of them (ctx.party is the usual one).
 *
 * Rules:
 * - Only GMs edit events, so this carries the same trust as a world macro.
 * - The syntax is checked when the row is saved and by the event lint.
 * - A script that throws, or runs past the time limit, ends the event (movement
 *   is freed as for any event end) and the GM is told why.
 *
 * Requires:
 * - event-eventRegistry.js, event-client.js, event-flow.js, event-rows-jump.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsCode]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RunCode?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing EventRegistry or Client. Check load order.");
    return;
  }

  const TIME_LIMIT_MS = 120000;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  function syntaxError(code) {
    try {
      // eslint-disable-next-line no-new
      new AsyncFunction("ctx", String(code ?? ""));
      return null;
    } catch (e) {
      return e?.message ?? String(e);
    }
  }

  function makeCtx(scene, context) {
    const Jump = window.oni.EventSystem.Jump;
    const flow = window.oni.EventSystem.Flow;
    const sourceId = context?.tileId ?? null;
    const party = scene?.tokens?.get(context?.tokenId) ?? null;
    return {
      scene,
      party,
      event: { sceneId: scene?.id ?? null, tileId: sourceId, tokenId: context?.tokenId ?? null },
      marker: (name) => {
        const at = Jump?.resolvePoint?.(scene, String(name ?? ""));
        if (!at) throw new Error(`No marker named "${name}" on this scene.`);
        return { x: at.x, y: at.y };
      },
      jump: async (who, to, opts = {}) => {
        if (!Jump) throw new Error("Jump To is not loaded.");
        const ok = await Jump.hop(who, to, opts, sourceId);
        if (!ok) throw new EventEnded();
      },
      jumpPath: async (who, lines, opts = {}) => {
        if (!Jump) throw new Error("Jump To is not loaded.");
        const r = await Jump.path(who, lines, opts, sourceId);
        if (r.reason === "ended") throw new EventEnded();
        if (!r.ok) throw new Error(r.missing ? `No marker named ${r.missing.join(", ")} on this scene.` : `Jump failed (${r.reason}).`);
      },
      wait: async (ms) => {
        const ok = flow?.wait ? await flow.wait(sourceId, ms) : await new Promise(r => setTimeout(() => r(true), ms));
        if (ok === false) throw new EventEnded();
      },
      sound: (src, volume = 0.6) => Client.run(sourceId, "sound.play", { src: String(src ?? ""), volume })
    };
  }

  // Thrown inside ctx helpers when the GM ends the event, to unwind the script quietly.
  class EventEnded extends Error {
    constructor() { super("The event was ended."); this.name = "EventEnded"; }
  }

  EventRegistry.register({
    type: "runCode",
    label: "Run Code",
    category: "Flow",
    defaultData: { type: "runCode", code: "" },
    summary: (row) => {
      const lines = String(row?.code ?? "").split(/\r?\n/).filter(l => l.trim());
      const err = syntaxError(row?.code);
      return err ? `does not parse: ${err}` : `${lines.length} line${lines.length === 1 ? "" : "s"}, on the GM`;
    },
    execute: async (row, context) => {
      const code = String(row?.code ?? "");
      if (!code.trim()) return { ok: true, type: "runCode", skipped: true };
      const err = syntaxError(code);
      if (err) {
        ui.notifications?.error?.(`Event: Run Code does not parse (${err}). The event was ended.`);
        return { ok: false, type: "runCode", reason: "syntax", stop: true };
      }

      const scene = game.scenes?.get(context?.sceneId) ?? canvas?.scene ?? null;
      const fn = new AsyncFunction("ctx", code);
      let timer = null;
      try {
        await Promise.race([
          fn(makeCtx(scene, context)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`ran past ${TIME_LIMIT_MS / 1000} s`)), TIME_LIMIT_MS); })
        ]);
        return { ok: true, type: "runCode" };
      } catch (e) {
        if (e instanceof EventEnded) return { ok: true, type: "runCode", stop: true };
        console.error(INSTALL_TAG, "Run Code failed.", e);
        ui.notifications?.error?.(`Event: Run Code failed (${e?.message ?? e}). The event was ended.`);
        return { ok: false, type: "runCode", reason: "threw", stop: true };
      } finally {
        clearTimeout(timer);
      }
    },
    buildFields: (row, kit) => {
      const body = kit.fields(
        kit.field(
          "Code",
          `<textarea class="oni-event-textarea oni-event-row-code-src" rows="10" spellcheck="false" style="font-family: monospace; tab-size: 2;" placeholder="await ctx.jumpPath(ctx.party, [&quot;Stone 01&quot;, &quot;Stone 02&quot;]);">${kit.escapeHTML(row.code ?? "")}</textarea>`,
          "Runs on the GM running the event, awaited like any row. ctx: scene, party, marker(name), jump(who, to, opts), jumpPath(who, lines, opts), wait(ms), sound(src, volume), event. A throw ends the event."
        ),
        `<div class="oni-event-row-notes oni-event-row-code-status"></div>`
      );
      const area = body.querySelector(".oni-event-row-code-src");
      const status = body.querySelector(".oni-event-row-code-status");
      const check = () => {
        const err = syntaxError(area.value);
        status.textContent = err ? `Does not parse: ${err}` : "Parses.";
        status.style.color = err ? "#8a1f0c" : "";
      };
      area.addEventListener("input", check);
      area.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        const { selectionStart: s, selectionEnd: t } = area;
        area.value = `${area.value.slice(0, s)}  ${area.value.slice(t)}`;
        area.selectionStart = area.selectionEnd = s + 2;
      });
      check();
      return body;
    },
    collectFields: (rowEl, kit) => ({
      code: String(kit.own(rowEl, ".oni-event-row-code-src")?.value ?? "")
    })
  });

  window.oni.EventSystem.RunCode = { installed: true, syntaxError };
  console.debug(INSTALL_TAG, "Installed.");
})();
