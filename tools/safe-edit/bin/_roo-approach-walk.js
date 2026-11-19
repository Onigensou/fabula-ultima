// Roo Approach rework (2026-11-19, user-approved mockup
// https://claude.ai/artifact/YPPLLyxxw33Kt1RF6D82uc).
//
// Writes ONLY:
//   - Approach item: system.props.animation_script (the walk), nothing else.
//   - Two embedded AE templates on Approach: flags.fabula-ultima-companion.hidden
//     = true on "Marked" (who it wants) and "Approach" (how many steps). The
//     user wants the target to be a secret read from the walk alone, with no
//     visible clock. The flag is the existing convention: status-classifier
//     puts it in the HIDDEN tier and effectRowsOf (party menu, battle HUD,
//     unit inspect) drops it. Formulas still read the charges.
//
// Reaction / effect rows on Approach belong to _players-only-targeting.js
// (foundryvtt-cc, v1.0.634) and are NOT touched here: the item doc is read from
// disk and only the one prop is replaced.
//
// The walk:
//   - Planned in FLOOR space from the 2D document position (feet = bottom
//     centre). token.center is NOT used: on a 3D-stage battle it reports where
//     the body is DRAWN, and writing that back as a 2D spot put the Roo on the
//     wrong row at the wrong size (the bug this fixes).
//   - Aims at a spot BESIDE the victim on the victim's own floor row, at a reach
//     scaled by the depth factor there, so the third step always ends in the
//     same pose for Chef's Knife.
//   - Travels 1/(4 - charges) of what is left (1/3, 1/2, all), so a victim who
//     moves is still handled.
//   - The turn cue (turn-start-cue.js) walks a stepped battler back to its
//     saved turnStepHome at turn end, which undid the walk every turn in a
//     real fight (found 2026-11-19 in the sandbox). The last stride moves that
//     saved home to where the Roo stopped.
//   - Four short strides, each its own animated token move (replicated by
//     Foundry, resized every frame by depth-index), with a footstep on every
//     client as each lands. No tether, no marker, no text.
//
// Run from tools/safe-edit:  node bin/_roo-approach-walk.js [--apply]
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const A = "VwClo606KbQSK6aQ";            // Roo
const APPROACH = "5nRPZWogdOXD6n2I";      // Approach (passive)
const AE_APPROACH = "Ak2LIIUCiOnuOXLJ";   // step counter on the Roo
const AE_MARKED = "kvcIK8H8f8jmk4Mc";     // on the victim
const ik = (i) => `!actors.items!${A}.${i}`;
const aek = (i, ae) => `!actors.items.effects!${A}.${i}.${ae}`;

const CFG = {
  strides: 4,          // footsteps per turn
  strideMs: 520,       // each stride's token move
  pauseMs: 180,        // still between strides (the shuffle)
  reachPx: 125,        // centre-to-centre gap at arrival, at depth factor 1
  stepSfx: "SE_BTL_FootStepNormal_1",
  stepVol: 0.6,
  failsafeMs: 9000,
};

// Runs on every client through game.ONI.pseudo.play: footsteps only.
function inner(ctx) {
  const P = ctx.params || {};
  const cfg = P.cfg || {};
  const fire = () => { try { Hooks.callAll(P.doneHook); } catch (e) {} };
  let suppressed = false;
  try {
    const api = globalThis.FUCompanion && globalThis.FUCompanion.api;
    suppressed = !!(api && typeof api.vfxSuppressed === "function" && api.vfxSuppressed());
  } catch (e) {}
  const strides = cfg.strides || 4;
  const period = (cfg.strideMs || 520) + (cfg.pauseMs || 180);
  if (!suppressed) {
    let url = null;
    try { url = globalThis.ONI_SFX ? globalThis.ONI_SFX(cfg.stepSfx) : null; } catch (e) {}
    if (url) {
      for (let i = 0; i < strides; i++) {
        setTimeout(() => {
          try { const a = new Audio(url); a.volume = cfg.stepVol == null ? 0.6 : cfg.stepVol; a.play().catch(() => {}); } catch (e) {}
        }, i * period + (cfg.strideMs || 520));
      }
    }
  }
  setTimeout(fire, strides * period);
}

// Runs once, on the client that plays the action.
async function outer(payload, CFG, INNER) {
  const doneHook = "roo-approach-" + foundry.utils.randomID();
  const onceHook = (h, ms) => new Promise((res) => {
    let fired = false;
    const id = Hooks.once(h, () => { if (!fired) { fired = true; res(true); } });
    setTimeout(() => { if (!fired) { fired = true; try { Hooks.off(h, id); } catch (e) {} res(false); } }, ms);
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const casterUuid = payload.casterTokenUuid
    || (canvas.tokens.controlled[0] && canvas.tokens.controlled[0].document.uuid);
  const casterTok = canvas.tokens.placeables.find((t) => t.document.uuid === casterUuid);
  const victimTok = Array.from(game.user.targets)[0]
    || canvas.tokens.placeables.find((t) => (payload.targetTokenUuids || []).includes(t.document.uuid));
  if (!casterTok || !victimTok) return;

  Hooks.callAll("oni:animationStart", { skill: "Approach" }, { local: true, world: false });
  try {
    // The Approach counter has already ticked: 1, 2 or 3.
    let charges = 1;
    try {
      const ae = casterTok.actor.effects.find((e) => !e.disabled && String(e.name).toLowerCase() === "approach");
      charges = Math.max(1, Math.min(3, Number(ae?.flags?.["fabula-ultima-companion"]?.charges ?? 1) || 1));
    } catch (e) {}

    // Floor space: feet = bottom centre of the 2D footprint. Never token.center.
    const feet = (t) => ({ x: t.document.x + t.w / 2, y: t.document.y + t.h });
    const depthAt = (y) => {
      try { const f = globalThis.__ONI_DEPTH_INDEX__?.factorAtY?.(y); return Number.isFinite(f) && f > 0 ? f : 1; }
      catch (e) { return 1; }
    };
    const c = feet(casterTok), v = feet(victimTok);
    const side = Math.sign(v.x - c.x) || 1;
    const arrive = { x: v.x - side * CFG.reachPx * depthAt(v.y), y: v.y };
    const frac = 1 / (4 - charges);
    const dest = { x: c.x + (arrive.x - c.x) * frac, y: c.y + (arrive.y - c.y) * frac };

    // Footsteps on every client (the token moves replicate by themselves).
    // scriptId is REQUIRED even with scriptSource, or the emit is dropped.
    const vfx = game.ONI.pseudo.play({
      scriptId: "roo-approach",
      scriptSource: INNER,
      casterTokenUuid: casterTok.document.uuid,
      targetTokenUuids: [victimTok.document.uuid],
      params: { doneHook, cfg: CFG },
    });
    const done = onceHook(doneHook, CFG.failsafeMs);

    const n = CFG.strides, period = CFG.strideMs + CFG.pauseMs;
    const t0 = performance.now();
    for (let i = 1; i <= n; i++) {
      const p = { x: c.x + (dest.x - c.x) * i / n, y: c.y + (dest.y - c.y) * i / n };
      const lag = (i - 1) * period - (performance.now() - t0);
      if (lag > 0) await wait(lag);
      const change = { x: Math.round(p.x - casterTok.w / 2), y: Math.round(p.y - casterTok.h) };
      // The turn cue steps the active battler out and saves its spot in
      // turnStepHome; at turn end it walks it back there, which would undo the
      // whole Approach. Where the Roo stops IS its new home.
      if (i === n && casterTok.document.getFlag("fabula-ultima-companion", "turnStepHome")) {
        change["flags.fabula-ultima-companion.turnStepHome"] = { x: change.x, y: change.y };
      }
      await casterTok.document.update(change, { animation: { duration: CFG.strideMs, easing: "easeInOutCosine" } });
    }
    const rest = n * period - (performance.now() - t0);
    if (rest > 0) await wait(rest);
    await Promise.all([vfx, done]);
  } catch (e) {
    console.error("Roo Approach animation:", e);
  } finally {
    Hooks.callAll("oni:animationEnd", { skill: "Approach" }, { local: true, world: false });
  }
}

const bodyOf = (fn) => { const s = fn.toString(); return s.slice(s.indexOf("{") + 1, s.lastIndexOf("}")); };

function buildScript() {
  const INNER = bodyOf(inner);
  return [
    "// Roo Approach: a slow, depth-correct walk toward its victim. No tether, no marker:",
    "// the party reads the target from the steps. Source: tools/safe-edit/bin/_roo-approach-walk.js",
    "(async () => {",
    "  const payload = globalThis.__PAYLOAD || {};",
    "  const CFG = " + JSON.stringify(CFG) + ";",
    "  const INNER = " + JSON.stringify(INNER) + ";",
    "  await (" + outer.toString() + ")(payload, CFG, INNER);",
    "})();",
  ].join("\n");
}

// The field is rich text: one <p> per line, HTML-escaped (director-animation
// _stripHtml turns </p> back into newlines before reading textContent).
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toStored = (src) => src.split("\n").map((l) => `<p>${esc(l)}</p>`).join("");

if (require.main === module) {
  run(async ({ changes }) => {
    const script = buildScript();
    // Compile check before anything is written.
    new Function(script); // eslint-disable-line no-new-func
    new Function("ctx", JSON.parse(JSON.stringify(bodyOf(inner)))); // eslint-disable-line no-new-func

    const item = await getByKey("actors", ik(APPROACH));
    if (!item || item.name !== "Approach") throw new Error("Approach item not found on the Roo");
    item.system.props.animation_script = toStored(script);
    changes.push([ik(APPROACH), item, `Approach: animation_script = depth-correct 4-stride walk, no tether (${script.length} chars)`]);

    for (const [id, name] of [[AE_MARKED, "Marked"], [AE_APPROACH, "Approach"]]) {
      const ae = await getByKey("actors", aek(APPROACH, id));
      if (!ae || ae.name !== name) throw new Error(`AE ${name} (${id}) not found on Approach`);
      ae.flags = ae.flags || {};
      ae.flags["fabula-ultima-companion"] = Object.assign({}, ae.flags["fabula-ultima-companion"], { hidden: true });
      changes.push([aek(APPROACH, id), ae, `AE ${name}: flags.hidden = true (kept from players: who / how many steps)`]);
    }
  }, "roo-approach-walk").catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildScript, toStored, CFG };
