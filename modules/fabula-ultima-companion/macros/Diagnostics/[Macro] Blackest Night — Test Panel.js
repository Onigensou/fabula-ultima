// 🌑 Geist — Blackest Night Test Panel  (GM dev/recovery control)
// ---------------------------------------------------------------------------
// Controls the undying revive "Zero Power: The Blackest Night" (Geist hits
// 0 HP with full ZP → fake-out victory cinematic → revives at a decaying HP
// cap). See [[undying]] / [[project_geist_blackest_night]].
//
//   Force Cinematic .... toggle the dev flag that routes LEAN test battles
//                        through the full claim → cinematic path (normally
//                        lean revives inline with no visuals). TURN OFF for
//                        production — real battles don't need it.
//   Fill Geist ZP ...... set zero_power_value to max (arms the revive)
//   Clear Pending ...... drop a stale pending claim (a stale claim would
//                        hijack the NEXT battle's end — this is the escape
//                        hatch)
//   (status refreshes after every action)
//
// SOURCE-CONTROLLED: seeded from
//   modules/fabula-ultima-companion/macros/Diagnostics/[Macro] Blackest Night — Test Panel.js
// (registered in macros/_manifest.json) so a fresh/pulled world re-creates it.

const MODULE_ID      = "fabula-ultima-companion";
const GEIST_ACTOR_ID = "UYAabJiUZJ1uKers";
const ZP_PATH        = "system.props.zero_power_value";

if (!game.user?.isGM) {
  ui.notifications?.warn("Blackest Night panel is GM-only.");
  return;
}

const und =
  globalThis.FUCompanion?.api?.experimental?.battleDirector?.undying
  ?? game.modules.get(MODULE_ID)?.api?.experimental?.battleDirector?.undying
  ?? null;
if (!und) {
  ui.notifications?.error("Battle Director undying API not found — is the module loaded?");
  return;
}

// Prefer the live combatant's actor (unlinked-token synthetic) so mid-battle
// reads/writes hit the same doc the damage pipeline uses; fall back to the
// world actor out of combat.
function geistActor() {
  const inCombat = (canvas?.tokens?.placeables ?? [])
    .find((t) => t.actor?.id === GEIST_ACTOR_ID)?.actor;
  return inCombat ?? game.actors.get(GEIST_ACTOR_ID) ?? null;
}

function statusHTML() {
  const a = geistActor();
  const p = a?.system?.props ?? {};
  const zp = Number(p.zero_power_value) || 0;
  const zpMax = Number(p.max_zero) || 6;
  const pending = und.pending();
  const force = und.isForceCinematic();
  return `
    <div style="line-height:1.6; padding-bottom:4px;">
      <p style="margin:.2em 0;"><b>Force Cinematic (dev):</b> ${force ? "🟢 ON — lean test battles play the fake-out" : "⚪ off (production)"}</p>
      <p style="margin:.2em 0;"><b>Geist:</b> ${a ? `HP ${p.current_hp}/${p.max_hp} · MP ${p.current_mp}/${p.max_mp} · ZP <b>${zp}/${zpMax}</b> ${zp >= zpMax ? "⚡ revive ARMED" : "(revive needs full ZP)"}` : "actor not found"}</p>
      <p style="margin:.2em 0;"><b>Revivals this battle:</b> ${und.triggers()}</p>
      <p style="margin:.2em 0;"><b>Pending claim:</b> ${pending ? `⚠️ ${pending.ruleId} (#${pending.triggerIndex})` : "none"}</p>
      <p style="opacity:.7; font-size:.9em; margin:.4em 0 0;">
        At 0 HP with full ZP Geist spends it all and rises at a decaying HP cap
        (70% → 49% → 34% → …). Below full ZP = true death; adds die with him
        either way.
      </p>
    </div>`;
}

function openPanel() {
  new Dialog({
    title: "🌑 Blackest Night — Test Panel",
    content: `<div id="bn-panel-status">${statusHTML()}</div>`,
    buttons: {
      force: {
        icon: '<i class="fas fa-film"></i>',
        label: "Force Cinematic",
        callback: async () => {
          const now = !und.isForceCinematic();
          await und.forceCinematic(now);
          ui.notifications?.info(`Blackest Night forceCinematic ${now ? "ON 🟢 (dev)" : "OFF ⚪ (production)"}.`);
          openPanel();
        },
      },
      fill: {
        icon: '<i class="fas fa-bolt"></i>',
        label: "Fill Geist ZP",
        callback: async () => {
          const a = geistActor();
          if (!a) { ui.notifications?.error("Geist actor not found."); return openPanel(); }
          const max = Number(a.system?.props?.max_zero) || 6;
          await a.update({ [ZP_PATH]: max });
          ui.notifications?.info(`Geist ZP set to ${max} — revive armed.`);
          openPanel();
        },
      },
      clear: {
        icon: '<i class="fas fa-broom"></i>',
        label: "Clear Pending",
        callback: async () => {
          await und.clearPending();
          ui.notifications?.info("Blackest Night pending claim cleared.");
          openPanel();
        },
      },
      close: { icon: '<i class="fas fa-times"></i>', label: "Close" },
    },
    default: "close",
  }).render(true);
}

openPanel();
