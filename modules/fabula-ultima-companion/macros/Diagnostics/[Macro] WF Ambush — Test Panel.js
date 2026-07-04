// ⭐ Wandering Flame — Ambush Test Panel  (GM story-gating control)
// ---------------------------------------------------------------------------
// Controls the Battle-End follow-up rule "wandering-flame-ambush": while the
// event is ACTIVE, winning a battle has an escalating (pity-driven) chance to
// be crashed by the Wandering Flame — the won fight ends and a new boss
// conflict begins in place with the same worn-down party.
//
//   Toggle On/Off ..... arm / disarm the event (setActive)
//   Force Next = 100% .. arm + push pity so the NEXT battle-end is guaranteed
//   Reset Pity ........ set the escalation counter back to 0
//   (status is shown at the top and refreshes after every action)
//
// SOURCE-CONTROLLED: seeded from
//   modules/fabula-ultima-companion/macros/Diagnostics/[Macro] WF Ambush — Test Panel.js
// (registered in macros/_manifest.json) so a fresh/pulled world re-creates it.
// See [[project_battle_end_followup]] / [[project_wandering_flame_boss]].

const MODULE_ID    = "fabula-ultima-companion";
const RULE_ID      = "wandering-flame-ambush";
const PITY_KEY     = "bdFollowupPity";
// Mirrors CHANCE_TABLE in wandering-flame-ambush.js — spawn chance by pity.
const CHANCE_TABLE = [0.10, 0.25, 0.50, 0.80, 1.00];
const FORCE_PITY   = CHANCE_TABLE.length - 1; // clamps to the 100% entry

if (!game.user?.isGM) {
  ui.notifications?.warn("WF Ambush panel is GM-only.");
  return;
}

const followups =
  globalThis.FUCompanion?.api?.experimental?.battleDirector?.followups
  ?? game.modules.get(MODULE_ID)?.api?.experimental?.battleDirector?.followups
  ?? null;
if (!followups) {
  ui.notifications?.error("Battle Director followups API not found — is the module loaded?");
  return;
}

// The public API exposes a pity GETTER only; force/reset write the world-setting
// map directly (same store evaluateFollowups reads/writes).
function readPity() {
  try { return Number((game.settings.get(MODULE_ID, PITY_KEY) ?? {})[RULE_ID] ?? 0) || 0; }
  catch { return 0; }
}
async function writePity(n) {
  let map = {};
  try { map = foundry.utils.duplicate(game.settings.get(MODULE_ID, PITY_KEY) ?? {}); } catch {}
  map[RULE_ID] = Math.max(0, Math.floor(n));
  await game.settings.set(MODULE_ID, PITY_KEY, map);
}
function chanceForPity(p) {
  const i = Math.max(0, Math.min(CHANCE_TABLE.length - 1, Math.floor(p || 0)));
  return CHANCE_TABLE[i];
}
function statusHTML() {
  const active = followups.isActive(RULE_ID);
  const pity   = readPity();
  const pct    = Math.round(chanceForPity(pity) * 100);
  return `
    <div style="line-height:1.6; padding-bottom:4px;">
      <p style="margin:.2em 0;"><b>Event:</b> ${active ? "🟢 ACTIVE" : "⚪ inactive"}</p>
      <p style="margin:.2em 0;"><b>Pity:</b> ${pity} &nbsp;→&nbsp; next-win spawn chance <b>${pct}%</b></p>
      <p style="opacity:.7; font-size:.9em; margin:.4em 0 0;">
        While ACTIVE, winning a battle rolls to have the ⭐ Wandering Flame crash
        the fight. Chance escalates each miss (10 → 25 → 50 → 80 → 100%), and
        resets to 10% once the boss spawns.
      </p>
    </div>`;
}

function openPanel() {
  new Dialog({
    title: "⭐ Wandering Flame — Ambush Panel",
    content: `<div id="wf-ambush-status">${statusHTML()}</div>`,
    buttons: {
      toggle: {
        icon: '<i class="fas fa-power-off"></i>',
        label: "Toggle On/Off",
        callback: async () => {
          const now = !followups.isActive(RULE_ID);
          await followups.setActive(RULE_ID, now);
          ui.notifications?.info(`WF Ambush ${now ? "ARMED 🟢" : "disarmed ⚪"}.`);
          openPanel();
        },
      },
      force: {
        icon: '<i class="fas fa-meteor"></i>',
        label: "Force Next = 100%",
        callback: async () => {
          await followups.setActive(RULE_ID, true);
          await writePity(FORCE_PITY);
          ui.notifications?.info("WF Ambush: the NEXT battle-end will spawn the boss (100%).");
          openPanel();
        },
      },
      reset: {
        icon: '<i class="fas fa-rotate-left"></i>',
        label: "Reset Pity",
        callback: async () => {
          await writePity(0);
          ui.notifications?.info("WF Ambush pity reset to 0.");
          openPanel();
        },
      },
      close: { icon: '<i class="fas fa-xmark"></i>', label: "Close" },
    },
    default: "close",
  }).render(true);
}

openPanel();
