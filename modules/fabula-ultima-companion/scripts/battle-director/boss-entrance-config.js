// ============================================================================
// Boss Entrance — actor setting UI (Token Config → Appearance → Battle Entrance
// + Battle Defeat)
//
// Battle Defeat writes flags.fabula-ultima-companion.defeatStyle, read by
// defeat-reactor.js (styles: defeat-styles.js).
//
// Two per-ACTOR flags read by the director's entrance (director-init.js):
//
//   flags.fabula-ultima-companion.entranceStyle  — "fade" or a DESCENT_STYLES key
//       (or, on a party member, a PARTY_ENTRANCE_STYLES key: party-entrance-styles.js)
//   flags.fabula-ultima-companion.entranceQueue  — true: this entrance waits its
//       turn. Queued enemies play one at a time, in roster order, before anyone
//       else; the rest (plain fades + unqueued descents) then enter together,
//       and only after that does BATTLE START play.
//
// Flags, not system.props, for the reason given in director-init.js: CSB
// prunes undeclared props on a template reload. Same entry points and scope as
// sprite-shadow-config.js — both the Prototype Token config and a placed
// token's config edit the BASE actor, so it is one setting per actor.
// ============================================================================

import {
  DESCENT_STYLES,
  DEFAULT_ENTRANCE_STYLE,
  ENTRANCE_MODULE_ID,
  ENTRANCE_STYLE_FLAG,
  ENTRANCE_QUEUE_FLAG,
  entranceStyleFromFlags,
  entranceQueuedFromFlags,
} from "./boss-entrance-fx.js";
import {
  DEFEAT_STYLES,
  DEFAULT_DEFEAT_STYLE,
  DEFEAT_MODULE_ID,
  DEFEAT_STYLE_FLAG,
  defeatStyleFromFlags,
} from "./defeat-styles.js";
import { GATHER_STYLES } from "./gather-styles.js";
import { PARTY_ENTRANCE_STYLES, partyEntranceStyleFromFlags } from "./party-entrance-styles.js";
import { baseActorOf } from "../sprite-shadow/sprite-shadow-config.js";
import { warn } from "./logger.js";

const CSS = "fud-entrance-config";
// v12 has no foundry.utils.escapeHTML (v13+).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function resolveConfigActor(app) {
  const tokenDoc = app?.token ?? app?.object ?? app?.document ?? null;
  if (!tokenDoc) return null;
  if (tokenDoc.documentName === "Token") return baseActorOf(tokenDoc);
  const parent = tokenDoc.parent ?? tokenDoc.actor ?? null;
  return parent?.documentName === "Actor" ? parent : null;
}

function injectEntranceConfig(app, html) {
  try {
    if (!game.user?.isGM) return;
    const actor = resolveConfigActor(app);
    if (!actor) return;
    const $html = html instanceof jQuery ? html : $(html);
    const tab = $html.find('div.tab[data-tab="appearance"]');
    if (!tab.length || tab.find(`.${CSS}`).length) return;

    // A party style is read by its own reader: the enemy one sees it as
    // "fade", and saving the dialog would then wipe it.
    const currentStyle = () => partyEntranceStyleFromFlags(actor.flags) ?? entranceStyleFromFlags(actor.flags);
    const style = currentStyle();
    const queued = entranceQueuedFromFlags(actor.flags);
    const opt = (v, label) => `<option value="${esc(v)}" ${style === v ? "selected" : ""}>${esc(label)}</option>`;
    const defeat = defeatStyleFromFlags(actor.flags);
    const dOpt = (v, label) => `<option value="${esc(v)}" ${defeat === v ? "selected" : ""}>${esc(label)}</option>`;
    const isProto = app?.token?.documentName !== "Token";
    const scope = isProto
      ? "Actor setting — every token of this actor follows it."
      : `Actor setting on <b>${esc(actor.name)}</b> — every token of this actor follows it, not just this one.`;

    // No `name` attributes: TokenConfig submits named inputs onto the TOKEN,
    // and these are ACTOR flags. Written on submit below.
    tab.append(`
      <fieldset class="${CSS}">
        <legend>Battle Entrance</legend>
        <div class="form-group">
          <label>Style</label>
          <div class="form-fields">
            <select data-fud-entrance-style>
              ${opt(DEFAULT_ENTRANCE_STYLE, "Fade (basic)")}
              ${Object.keys(DESCENT_STYLES).map((k) => opt(k, k)).join("")}
              ${Object.entries(GATHER_STYLES).map(([k, g]) => opt(k, g.label ?? k)).join("")}
              <optgroup label="Party (replaces the run-in dash at battle start)">
                ${Object.entries(PARTY_ENTRANCE_STYLES).map(([k, g]) => opt(k, g.label ?? k)).join("")}
              </optgroup>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Queue</label>
          <div class="form-fields">
            <input type="checkbox" data-fud-entrance-queue ${queued ? "checked" : ""}>
          </div>
          <p class="hint">Plays alone, one at a time with any other queued enemy (in spawn order).
            Everyone else enters together after the queue, then BATTLE START.
            Tick it for entrances that move the camera.</p>
          <p class="hint">The style also plays when this creature joins a battle already running (a companion or summon arriving).</p>
        </div>
        <p class="notes">${scope}</p>
      </fieldset>
      <fieldset class="${CSS}-defeat">
        <legend>Battle Defeat</legend>
        <div class="form-group">
          <label>Style</label>
          <div class="form-fields">
            <select data-fud-defeat-style>
              ${dOpt(DEFAULT_DEFEAT_STYLE, "Standard (red flash / KO fall, then fade)")}
              ${Object.entries(DEFEAT_STYLES).map(([k, s]) => dOpt(k, s.label ?? k)).join("")}
            </select>
          </div>
          <p class="hint">Plays when this monster is removed at 0 HP (Soldier / Elite, with Auto Defeat on).
            Bosses that stay on the field are not affected yet.</p>
        </div>
      </fieldset>
    `);

    const $form = $html.find("form");
    if ($form.length && !$form.attr("data-fud-entrance-bound")) {
      $form.attr("data-fud-entrance-bound", "1");
      $form.on("submit", async () => {
        try {
          const nextStyle = String($form.find("[data-fud-entrance-style]").val() ?? DEFAULT_ENTRANCE_STYLE);
          const nextQueued = !!$form.find("[data-fud-entrance-queue]").is(":checked");
          // Compare against the NORMALISED read so saving the dialog never
          // rewrites a flag the user did not touch.
          if (nextStyle !== currentStyle()) {
            if (nextStyle === DEFAULT_ENTRANCE_STYLE) await actor.unsetFlag(ENTRANCE_MODULE_ID, ENTRANCE_STYLE_FLAG);
            else await actor.setFlag(ENTRANCE_MODULE_ID, ENTRANCE_STYLE_FLAG, nextStyle);
          }
          if (nextQueued !== entranceQueuedFromFlags(actor.flags)) {
            if (nextQueued) await actor.setFlag(ENTRANCE_MODULE_ID, ENTRANCE_QUEUE_FLAG, true);
            else await actor.unsetFlag(ENTRANCE_MODULE_ID, ENTRANCE_QUEUE_FLAG);
          }
          const nextDefeat = String($form.find("[data-fud-defeat-style]").val() ?? DEFAULT_DEFEAT_STYLE);
          if (nextDefeat !== defeatStyleFromFlags(actor.flags)) {
            if (nextDefeat === DEFAULT_DEFEAT_STYLE) await actor.unsetFlag(DEFEAT_MODULE_ID, DEFEAT_STYLE_FLAG);
            else await actor.setFlag(DEFEAT_MODULE_ID, DEFEAT_STYLE_FLAG, nextDefeat);
          }
        } catch (e) {
          warn("entrance-config: submit failed", e);
        }
      });
    }
    app.setPosition?.({ height: "auto" });
  } catch (e) {
    warn("entrance-config: TokenConfig injection failed", e);
  }
}

let _installed = false;
// Idempotent — called from director-boot's ready hook.
export function initEntranceConfig() {
  if (_installed) return;
  _installed = true;
  Hooks.on("renderTokenConfig", injectEntranceConfig);
}
