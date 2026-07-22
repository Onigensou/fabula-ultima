/**
 * Character Creation — step 1: Profile.
 *
 * The two images come first, because a face is the thing a player most wants
 * to settle before writing prose about it. Both are optional; Foundry's stock
 * mystery-man stands in, exactly as a hand-made actor would get.
 *
 * The image squares ARE the picker — clicking one opens Foundry's FilePicker.
 * A separate Browse button next to a path field made the square look like
 * decoration, when it is the most obvious thing on the page to click.
 *
 * Origin keeps its datalist: it is a place in the group's own world and cannot
 * be enumerated by us, so the suggestions come from the world's existing PCs
 * and a player can match an established homeland without retyping it. Theme is
 * a plain text field — the rulebook's ten are suggestions, not a closed set,
 * and offering them as a list implied otherwise.
 */

import { CC, esc } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";

const CSS = `
  .cc-pf { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 18px; align-content: start; }
  .cc-pf-field { display: flex; flex-direction: column; gap: 4px; }
  .cc-pf-field.is-wide { grid-column: 1 / -1; }
  .cc-pf-opt { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: .8; }
  .cc-pf-req { color: #a3453a; }
  .cc-pf-hint { font-size: 11px; opacity: .6; line-height: 1.35; }
  .cc-pf textarea.cc-input { resize: vertical; min-height: 72px; line-height: 1.5; }

  /* ── images, first thing on the page ── */
  .cc-pf-art { grid-column: 1 / -1; display: flex; gap: 14px; align-items: flex-start;
    padding: 10px 12px; border-radius: 8px; background: #e6dabd; border: 1px solid #cbb890; }
  .cc-pf-slot { display: flex; flex-direction: column; gap: 5px; align-items: center; width: 96px; }
  .cc-pf-pick { width: 96px; height: 96px; padding: 0; border-radius: 8px; cursor: pointer;
    border: 1px solid #b79c72; background: #f7f0df; overflow: hidden; position: relative;
    display: block; }
  .cc-pf-pick:hover { border-color: #8a6c45; box-shadow: 0 0 0 2px rgba(240,217,154,.6); }
  .cc-pf-pick img { width: 100%; height: 100%; object-fit: cover; display: block;
    border: 0 !important; outline: 0 !important; }
  .cc-pf-pick .cc-pf-over { position: absolute; inset: auto 0 0 0; padding: 3px 0;
    font-size: 10px; font-weight: 700; text-align: center;
    background: rgba(45,35,20,.72); color: #f6ecd8; opacity: 0; transition: opacity .12s; }
  .cc-pf-pick:hover .cc-pf-over { opacity: 1; }
  .cc-pf-cap { font-size: 11px; font-weight: 700; opacity: .7; }
  .cc-pf-clear { font-family: inherit; font-size: 10px; cursor: pointer; padding: 0;
    background: none; border: 0; color: #8a6c45; text-decoration: underline; }
  .cc-pf-artnote { flex: 1 1 auto; font-size: 12px; opacity: .65; line-height: 1.5; padding-top: 4px; }
`;

/** Origins already in use in this world, so players can match an existing place. */
function knownOrigins() {
  const out = new Set();
  for (const a of game.actors ?? []) {
    if (a.type !== "character") continue;
    const o = String(a.system?.props?.origin ?? "").trim();
    if (o && o.length < 40) out.add(o);
  }
  return [...out].sort();
}

const slot = (field, label, src, note) => `
  <div class="cc-pf-slot">
    <button class="cc-pf-pick" data-pick="${field}" title="${esc(note)}">
      <img data-prev="${field}" src="${esc(src || CC.DEFAULT_IMG)}" alt="">
      <span class="cc-pf-over">Change</span>
    </button>
    <span class="cc-pf-cap">${esc(label)}</span>
    ${src ? `<button class="cc-pf-clear" data-clear="${field}">clear</button>` : ""}
  </div>`;

function render(d) {
  const p = d.profile;
  const originList = knownOrigins();

  return `
    <style>${CSS}</style>
    <div class="cc-pf">

      <div class="cc-pf-art">
        ${slot("img", "Portrait", p.img, "Click to choose a portrait")}
        ${slot("tokenImg", "Token", p.tokenImg, "Click to choose a token image")}
        <div class="cc-pf-artnote">
          Both are optional. Leave them and your character gets Foundry's default silhouette;
          set only a portrait and the token borrows it.
        </div>
      </div>

      <div class="cc-pf-field">
        <label class="cc-label" for="cc-name">Name <span class="cc-pf-req">*</span></label>
        <input class="cc-input" id="cc-name" data-f="name" value="${esc(p.name)}" autocomplete="off">
      </div>

      <div class="cc-pf-field">
        <label class="cc-label" for="cc-theme">Theme</label>
        <input class="cc-input" id="cc-theme" data-f="theme" value="${esc(p.theme)}"
               placeholder="Hope, Vengeance, Duty…" autocomplete="off">
        <div class="cc-pf-hint">The ideal driving them. Anything you like.</div>
      </div>

      <div class="cc-pf-field is-wide">
        <label class="cc-label" for="cc-identity">Identity</label>
        <input class="cc-input" id="cc-identity" data-f="identity" value="${esc(p.identity)}"
               placeholder="The Last Princess of Platea" autocomplete="off">
        <div class="cc-pf-hint">How they see themselves right now. Can be invoked to reroll, and may change as they grow.</div>
      </div>

      <div class="cc-pf-field">
        <label class="cc-label" for="cc-origin">Origin</label>
        <input class="cc-input" id="cc-origin" data-f="origin" value="${esc(p.origin)}"
               list="cc-origin-list" placeholder="Where are they from?" autocomplete="off">
        <datalist id="cc-origin-list">
          ${originList.map((o) => `<option value="${esc(o)}">`).join("")}
        </datalist>
        <div class="cc-pf-hint">${originList.length
          ? `${originList.length} place${originList.length === 1 ? "" : "s"} already known in this world.`
          : "No origins recorded yet — name a new one."}</div>
      </div>

      <div class="cc-pf-field">
        <label class="cc-label">&nbsp;</label>
        <div class="cc-pf-hint">Identity, Theme and Origin are your character's three Traits (pp. 155–159).
          Any of them can be invoked to reroll a check.</div>
      </div>

      <div class="cc-pf-field is-wide">
        <label class="cc-label" for="cc-backstory">Backstory <span class="cc-pf-opt">optional</span></label>
        <textarea class="cc-input" id="cc-backstory" data-f="backstory"
                  placeholder="Where they came from, and what it cost.">${esc(p.backstory)}</textarea>
      </div>

    </div>`;
}

function bind(root, d, ctx) {
  // Typing uses `touch` so the caret survives; `change` (blur / enter) commits
  // with a full re-render so validation and the rail catch up.
  root.querySelectorAll("[data-f]").forEach((el) => {
    const field = el.dataset.f;
    el.addEventListener("input", () => {
      ctx.touch((dd) => { dd.profile[field] = el.value; });
      if (field === "name") ctx.syncFoot();
    });
    el.addEventListener("change", () => ctx.edit((dd) => { dd.profile[field] = el.value; }));
  });

  root.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const field = btn.dataset.pick;
      // FilePicker is Foundry's own browser, so players get the same asset tree
      // they see everywhere else, including S3 and Forge buckets.
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      if (!FP) { ui.notifications?.warn("File browser unavailable."); return; }
      new FP({
        type: "image",
        current: d.profile[field] || "",
        callback: (path) => ctx.edit((dd) => { dd.profile[field] = path; }),
      }).render(true);
    });
  });

  root.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ctx.edit((dd) => { dd.profile[btn.dataset.clear] = ""; });
    });
  });
}

STEP_RENDERERS.set("profile", { render, bind });
