/**
 * [ONI] Event System — Lightning Reveal
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-rows-lightning.js
 *
 * What this does:
 * - Registers the "Lightning Reveal" event action: a stutter of light over the
 *   map, and for that split second the named tokens show a lit image instead of
 *   their silhouette. Then the shadow falls back.
 *
 * How it fits together:
 * - Every client plays it locally. Nothing is written: the lit image is a copy
 *   laid over the token, so the token's own art never changes.
 * - The light is a brief filter on the whole map layer. The GM keeps their view
 *   of the map, as with screen effects, but sees the lit images.
 * - A reduced-motion player gets neither; a flicker is what they asked to avoid.
 *
 * Requires:
 * - event-logic.js, event-eventRegistry.js, event-client.js, event-flow.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][RowsLightning]";

  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.RowsLightning?.installed) {
    console.debug(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const Logic = window.oni.EventSystem.Logic;
  const EventRegistry = window.oni.EventSystem.EventRegistry;
  const Client = window.oni.EventSystem.Client;
  if (!Logic || !EventRegistry || !Client) {
    console.error(INSTALL_TAG, "Missing Logic, EventRegistry or Client. Check load order.");
    return;
  }

  const KIND_REVEAL = "lightning.reveal";

  // [ms, light]: not one flash but a stutter, as a real strike.
  const FLICKER = [[0, 1], [70, 0.28], [125, 0.95], [210, 0.35], [290, 0.7], [520, 0]];
  const TOTAL_MS = FLICKER[FLICKER.length - 1][0];
  const MAP_BRIGHTEN = 0.45;
  // The lit image reaches full strength a little before the light does.
  const LIT_GAIN = 1.25;

  function lightAt(ms) {
    for (let i = 1; i < FLICKER.length; i += 1) {
      const [t0, a] = FLICKER[i - 1];
      const [t1, b] = FLICKER[i];
      if (ms <= t1) return a + ((b - a) * ((ms - t0) / (t1 - t0)));
    }
    return 0;
  }

  const reducedMotion = () => {
    try { return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
  };

  // "Token name = image", one per line.
  function parseLit(raw) {
    return String(raw ?? "").split("\n").map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? null : { name: line.slice(0, at).trim(), src: line.slice(at + 1).trim() };
    }).filter((entry) => entry?.name && entry.src);
  }

  function tokensNamed(name) {
    const wanted = String(name ?? "").trim().toLowerCase();
    return (canvas.tokens?.placeables ?? []).filter(t =>
      String(t.document?.name ?? "").trim().toLowerCase() === wanted
      || String(t.actor?.name ?? "").trim().toLowerCase() === wanted
    );
  }

  async function makeCopies(lit) {
    const copies = [];
    for (const { name, src } of lit) {
      let texture = null;
      try { texture = await loadTexture(src); } catch (_) {}
      if (!texture) {
        console.warn(INSTALL_TAG, `Lightning Reveal could not load "${src}".`);
        continue;
      }

      for (const token of tokensNamed(name)) {
        const mesh = token.mesh;
        if (!mesh || token.document.hidden) continue;
        const copy = new PrimarySpriteMesh({ texture, name: "oniEventLit" });
        copy.anchor.set(mesh.anchor.x, mesh.anchor.y);
        copy.position.set(mesh.x, mesh.y);
        copy.width = mesh.width;
        copy.height = mesh.height;
        copy.elevation = mesh.elevation;
        copy.sortLayer = mesh.sortLayer;
        copy.sort = mesh.sort + 0.5;
        copy.alpha = 0;
        canvas.primary.addChild(copy);
        copies.push(copy);
      }
    }
    return copies;
  }

  Client.register(KIND_REVEAL, async (data, info) => {
    if (!canvas?.ready || reducedMotion()) return;
    if (globalThis.FUCompanion?.api?.vfxSuppressed?.() === true) return;

    const copies = await makeCopies(parseLit(data.lit));
    if (!canvas?.ready) return;

    const map = canvas.primary?.sprite;
    const filter = info.presents && map ? new PIXI.ColorMatrixFilter() : null;
    if (filter) map.filters = [...(map.filters ?? []), filter];

    const ticker = canvas.app.ticker;
    const startedAt = performance.now();
    let ended = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      ticker.remove(tick);
      Client.removeCleanup(info.sourceId, KIND_REVEAL);
      if (filter && map && !map.destroyed) map.filters = (map.filters ?? []).filter((f) => f !== filter);
      for (const copy of copies) {
        try { if (!copy.destroyed) copy.destroy(); } catch (_) {}
      }
    };

    // A throw here would stop PIXI's whole frame loop.
    const tick = () => {
      try {
        const elapsed = performance.now() - startedAt;
        if (elapsed >= TOTAL_MS) return finish();
        const light = lightAt(elapsed);
        filter?.brightness(1 + (light * MAP_BRIGHTEN), false);
        for (const copy of copies) copy.alpha = Math.min(1, light * LIT_GAIN);
      } catch (e) {
        console.warn(INSTALL_TAG, "A frame failed; dropping the effect.", e);
        finish();
      }
    };

    Client.addCleanup(info.sourceId, KIND_REVEAL, finish);
    ticker.add(tick);
  });

  EventRegistry.register({
    type: "lightningReveal",
    label: "Lightning Reveal",
    category: "Screen",
    defaultData: { type: "lightningReveal", lit: "", wait: false },
    summary: (row) => {
      const count = parseLit(row?.lit).length;
      return count ? `${count} lit token${count === 1 ? "" : "s"}` : "light only";
    },
    mediaOf: (row) => parseLit(row?.lit).map((entry) => entry.src),
    execute: async (row, context) => {
      Client.run(context?.tileId, KIND_REVEAL, { lit: String(row?.lit ?? "") });
      if (row?.wait === true) await window.oni.EventSystem.Flow?.wait?.(context?.tileId, TOTAL_MS);
      return { ok: true, type: "lightningReveal" };
    },
    buildFields: (row, kit) => kit.fields(
      kit.field(
        "Lit images",
        `<textarea class="oni-event-row-lightning-lit oni-event-textarea" style="min-height:70px"
           placeholder="Token name = path of its lit image">${kit.escapeHTML(String(row.lit ?? ""))}</textarea>`,
        "One per line. The image must be drawn on the same canvas as the token's art. Hidden tokens are left out. Empty: the light only."
      ),
      kit.waitField(row, false, `On: the next event waits for the flicker (${TOTAL_MS / 1000} s). Off: it starts straight away.`)
    ),
    collectFields: (rowEl, kit) => ({
      lit: kit.readText(rowEl, ".oni-event-row-lightning-lit", "").trim(),
      wait: kit.readWait(rowEl, false)
    })
  });

  window.oni.EventSystem.RowsLightning = { installed: true };
  console.debug(INSTALL_TAG, "Installed.");
})();
