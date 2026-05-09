/**
 * Diagnostic: locate shop_price_multiplier in the template and report
 * exactly where it sits, plus which actors (if any) already have the prop.
 * Run as GM, then check the browser console.
 */
(async () => {
  const TAG        = "[diag-shop-price-multiplier]";
  const FIELD_KEY  = "shop_price_multiplier";
  const TMPL_NAME  = "_FabU Char Template v3.fire";

  // ── All actors with this name ─────────────────────────────────────────────
  const templates = game.actors.filter(a => a.name === TMPL_NAME);
  console.log(`${TAG} Actors named "${TMPL_NAME}":`,
    templates.map(a => ({ id: a.id, type: a.type, name: a.name }))
  );

  if (!templates.length) {
    ui.notifications.error(`${TAG} No actor named "${TMPL_NAME}" found.`);
    return;
  }

  // ── For each template: report path to field ───────────────────────────────
  for (const tmpl of templates) {
    const sys = tmpl.system;
    const path = [];
    let found = false;

    (function walk(node, trail) {
      if (!node || typeof node !== "object" || found) return;
      if (Array.isArray(node)) {
        node.forEach((c, i) => walk(c, [...trail, i]));
        return;
      }
      if (node.key === FIELD_KEY) {
        found = true;
        console.log(`${TAG} [${tmpl.id}] Field found at path:`, trail.join(" → "));
        console.log(`${TAG} [${tmpl.id}] Field node:`, foundry.utils.deepClone(node));

        // Walk back up to show the enclosing panel/table
        console.log(`${TAG} [${tmpl.id}] Parent context (trail):`, trail);
        return;
      }
      for (const [k, v] of Object.entries(node)) walk(v, [...trail, k]);
    })(sys, []);

    if (!found) {
      console.warn(`${TAG} [${tmpl.id}] Field NOT found — template may not have been saved correctly.`);
      ui.notifications.warn(`${TAG} Field missing from template ${tmpl.id} — check console.`);
    } else {
      console.log(`${TAG} [${tmpl.id}] ✓ Field is present in template.`);

      // Also check: is it inside a visible body section?
      const body = sys.body ?? sys.pages?.[0]?.system ?? null;
      const header = sys.header ?? null;
      let inBody = false, inHeader = false;
      (function chk(node, loc) {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(c => chk(c, loc)); return; }
        if (node.key === FIELD_KEY) { if (loc === "body") inBody = true; else inHeader = true; }
        for (const v of Object.values(node)) chk(v, loc);
      });
      if (body)   (function chk(node) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { node.forEach(chk); return; } if (node.key === FIELD_KEY) inBody = true; for (const v of Object.values(node)) chk(v); })(body);
      if (header) (function chk(node) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) { node.forEach(chk); return; } if (node.key === FIELD_KEY) inHeader = true; for (const v of Object.values(node)) chk(v); })(header);

      console.log(`${TAG} [${tmpl.id}] Location → inBody: ${inBody}, inHeader: ${inHeader}`);
      if (!inBody && !inHeader) {
        console.warn(`${TAG} [${tmpl.id}] Field is NOT inside body or header — it may be unreachable by CSB renderer.`);
      }
    }
  }

  // ── Check a sample character for the prop ────────────────────────────────
  const chars = game.actors.filter(a =>
    a.type !== "_template" &&
    a.type !== "_characterTemplate" &&
    !a.name.startsWith("_")
  ).slice(0, 3);

  for (const c of chars) {
    const val = foundry.utils.getProperty(c, `system.props.${FIELD_KEY}`);
    console.log(`${TAG} Character "${c.name}" → system.props.${FIELD_KEY} =`, val ?? "(missing — Reload from Template needed)");
  }
})();
