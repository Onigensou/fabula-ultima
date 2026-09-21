// ============================================================================
// FabulaUltimaCompanion — Sprite Shadow (actor setting)
// File: scripts/sprite-shadow/sprite-shadow-config.js
// Foundry VTT v12
//
// A per-ACTOR toggle: "does this actor's sprite get a rendered ground shadow?"
//
// Why an actor FLAG and not a CSB template prop: the Fafnir Castle bestiary
// ships sprites with no baked-in shadow while the party / older bestiary art
// already carries one, so the choice is per actor — but it is presentation,
// not character data. `system.props` is owned by the CSB template (and
// `reloadTemplate()` prunes any key the template does not declare), so the
// setting lives in `flags.<module>.spriteShadow` on the Actor document.
//
// Surfaced in the Token Config's Appearance tab (both the Prototype Token
// config opened from the actor sheet and a placed token's config). Either
// entry point edits the BASE actor's flag, so it is one setting per actor,
// never a stale per-token copy. The renderer that draws the shadow is a
// separate module (sprite-shadow-renderer.js); this file only owns the
// setting + its UI + the API.
//
//   FUCompanion.api.spriteShadow.get(actor)        -> boolean
//   FUCompanion.api.spriteShadow.set(actor, bool)  -> Promise<Actor>
//   FUCompanion.api.spriteShadow.forToken(token)   -> boolean (placeable or doc)
// ============================================================================

const MODULE_ID = "fabula-ultima-companion";
const FLAG_KEY = "spriteShadow";          // flags.fabula-ultima-companion.spriteShadow
const DEFAULT = false;                    // most existing art already has a baked shadow
const TAG = "[FUC][SpriteShadow]";
const CSS = "fud-sprite-shadow";

const warn = (...a) => console.warn(TAG, ...a);
// v12 has no foundry.utils.escapeHTML (v13+); keep the actor name inert in markup.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Resolve the world (base) actor behind whatever we were handed. */
export function baseActorOf(thing) {
  if (!thing) return null;
  if (thing.documentName === "Actor") {
    // Synthetic token actor → the world actor it was spawned from.
    return thing.isToken ? (thing.token?.baseActor ?? game.actors?.get(thing.id) ?? thing) : thing;
  }
  if (thing.documentName === "Token") return thing.baseActor ?? thing.actor ?? null;
  if (thing.document?.documentName === "Token") return baseActorOf(thing.document);
  return null;
}

export function getActorSpriteShadow(actor) {
  const a = baseActorOf(actor);
  const v = a?.getFlag?.(MODULE_ID, FLAG_KEY);
  return typeof v === "boolean" ? v : DEFAULT;
}

export async function setActorSpriteShadow(actor, on) {
  const a = baseActorOf(actor);
  if (!a) throw new Error(`${TAG} setActorSpriteShadow: no actor resolved`);
  return a.setFlag(MODULE_ID, FLAG_KEY, !!on);
}

/** Token placeable or TokenDocument → does its sprite cast a shadow? */
export function tokenCastsSpriteShadow(token) {
  return getActorSpriteShadow(baseActorOf(token));
}

// ---------------------------------------------------------------------------
// Token Config injection (Appearance tab)
// ---------------------------------------------------------------------------

function resolveConfigActor(app) {
  // Prototype config: app.token is the PrototypeToken, whose parent is the actor.
  // Placed token: app.token is the TokenDocument → base actor.
  const tokenDoc = app?.token ?? app?.object ?? app?.document ?? null;
  if (!tokenDoc) return null;
  if (tokenDoc.documentName === "Token") return baseActorOf(tokenDoc);
  const parent = tokenDoc.parent ?? tokenDoc.actor ?? null;
  return parent?.documentName === "Actor" ? parent : null;
}

function injectSpriteShadowConfig(app, html) {
  try {
    const actor = resolveConfigActor(app);
    if (!actor) return;
    const $html = html instanceof jQuery ? html : $(html);
    const tab = $html.find('div.tab[data-tab="appearance"]');
    if (!tab.length || tab.find(`.${CSS}`).length) return;

    const isProto = app?.token?.documentName !== "Token";
    const scope = isProto
      ? "Actor setting — every token of this actor follows it."
      : `Actor setting on <b>${esc(actor.name)}</b> — every token of this actor follows it, not just this one.`;

    // No `name` attribute on purpose: TokenConfig submits named inputs onto the
    // TOKEN document, and this is an ACTOR flag. We write it ourselves on submit.
    tab.append(`
      <fieldset class="${CSS}">
        <legend>Sprite Shadow</legend>
        <div class="form-group">
          <label>Cast ground shadow</label>
          <div class="form-fields">
            <input type="checkbox" data-fud-sprite-shadow ${getActorSpriteShadow(actor) ? "checked" : ""}>
          </div>
          <p class="hint">Renders a soft ground shadow under the sprite. Turn OFF for art that already has a shadow painted in.</p>
        </div>
        <p class="notes">${scope}</p>
      </fieldset>
    `);

    const $form = $html.find("form");
    if ($form.length && !$form.attr("data-fud-sprite-shadow-bound")) {
      $form.attr("data-fud-sprite-shadow-bound", "1");
      $form.on("submit", async () => {
        try {
          const next = !!$form.find("[data-fud-sprite-shadow]").is(":checked");
          if (next !== getActorSpriteShadow(actor)) await setActorSpriteShadow(actor, next);
        } catch (e) {
          warn("submit failed", e);
        }
      });
    }
    app.setPosition?.({ height: "auto" });
  } catch (e) {
    warn("TokenConfig injection failed", e);
  }
}

Hooks.on("renderTokenConfig", injectSpriteShadowConfig);

Hooks.once("ready", () => {
  globalThis.FUCompanion = globalThis.FUCompanion || {};
  globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
  globalThis.FUCompanion.api.spriteShadow = {
    FLAG_KEY,
    DEFAULT,
    get: getActorSpriteShadow,
    set: setActorSpriteShadow,
    forToken: tokenCastsSpriteShadow,
  };
});
