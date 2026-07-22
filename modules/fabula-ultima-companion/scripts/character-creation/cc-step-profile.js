/**
 * Character Creation — step 1: Profile.
 *
 * Name, pronouns, and the three Traits (Identity, Theme, Origin — pp. 155-159),
 * plus backstory and the two images.
 *
 * Theme is offered as a datalist rather than a fixed dropdown: the rulebook's
 * ten are suggestions ("If this is your first character, it is strongly
 * suggested that you pick your Theme from the list below"), not a closed set,
 * and this table already runs custom ones. Same for Origin, which is a place in
 * the group's own world and cannot be enumerated by us at all — the suggestions
 * come from the world's existing PCs so a player can match an established
 * homeland without retyping it.
 *
 * Both images are optional. Foundry's stock mystery-man stands in, exactly as a
 * hand-made actor would get.
 */

import { CC, esc } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";

/** p.158 — the ten suggested Themes. */
const THEMES = [
  "Ambition", "Anger", "Belonging", "Doubt", "Duty",
  "Guilt", "Hope", "Justice", "Mercy", "Vengeance",
];

const CSS = `
  .cc-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
  .cc-field { display: flex; flex-direction: column; gap: 5px; }
  .cc-field.is-wide { grid-column: 1 / -1; }
  .cc-label {
    font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a6432;
    display: flex; align-items: baseline; gap: 6px;
  }
  .cc-label .cc-req { color: #a33; }
  .cc-label .cc-opt { color: #ab8a5c; text-transform: none; letter-spacing: 1px; font-size: 9px; }
  .cc-input, .cc-textarea {
    font-family: inherit; font-size: 12px; color: #2e1c08;
    background: rgba(255,252,240,0.72);
    border: 1px solid rgba(140,90,30,0.38); border-radius: 2px;
    padding: 7px 9px; width: 100%;
  }
  .cc-input:focus, .cc-textarea:focus {
    outline: none; border-color: #c9a44a; background: #fffdf4;
    box-shadow: 0 0 0 2px rgba(201,164,74,0.25);
  }
  .cc-textarea { resize: vertical; min-height: 76px; line-height: 1.5; }
  .cc-hint { font-size: 9px; color: #9b7040; letter-spacing: 0.5px; }

  .cc-img-row { display: flex; gap: 10px; align-items: flex-start; }
  .cc-img-prev {
    flex: 0 0 62px; height: 62px; border-radius: 2px;
    border: 1px solid rgba(140,90,30,0.38); background: rgba(255,252,240,0.72);
    object-fit: cover;
  }
  .cc-img-ctl { flex: 1; display: flex; flex-direction: column; gap: 5px; }
  .cc-btn-sm {
    font-family: inherit; font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    padding: 5px 12px; border-radius: 2px; cursor: pointer; color: #3a1e06;
    background: linear-gradient(155deg, #fdf6e0 0%, #e8d8a4 100%);
    border: 1px solid #c4a260; align-self: flex-start;
  }
  .cc-btn-sm:hover { background: linear-gradient(155deg, #fffbe8 0%, #f0e3b8 100%); }
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

function render(d) {
  const p = d.profile;
  const originList = knownOrigins();
  return `
    <style>${CSS}</style>
    <div class="cc-form">

      <div class="cc-field">
        <label class="cc-label" for="cc-name">Name <span class="cc-req">*</span></label>
        <input class="cc-input" id="cc-name" data-f="name" value="${esc(p.name)}"
               placeholder="Who are they?" autocomplete="off">
      </div>

      <div class="cc-field">
        <label class="cc-label" for="cc-pronouns">Pronouns <span class="cc-opt">optional</span></label>
        <input class="cc-input" id="cc-pronouns" data-f="pronouns" value="${esc(p.pronouns)}"
               placeholder="they/them" autocomplete="off">
      </div>

      <div class="cc-field is-wide">
        <label class="cc-label" for="cc-identity">Identity</label>
        <input class="cc-input" id="cc-identity" data-f="identity" value="${esc(p.identity)}"
               placeholder="A short sentence — &quot;The Last Princess of Platea&quot;" autocomplete="off">
        <div class="cc-hint">How they see themselves right now. Can be invoked to reroll. It may change as they grow.</div>
      </div>

      <div class="cc-field">
        <label class="cc-label" for="cc-theme">Theme</label>
        <input class="cc-input" id="cc-theme" data-f="theme" value="${esc(p.theme)}"
               list="cc-theme-list" placeholder="Hope" autocomplete="off">
        <datalist id="cc-theme-list">
          ${THEMES.map((t) => `<option value="${esc(t)}">`).join("")}
        </datalist>
        <div class="cc-hint">The ideal driving them. Suggestions listed; anything is allowed.</div>
      </div>

      <div class="cc-field">
        <label class="cc-label" for="cc-origin">Origin</label>
        <input class="cc-input" id="cc-origin" data-f="origin" value="${esc(p.origin)}"
               list="cc-origin-list" placeholder="Where are they from?" autocomplete="off">
        <datalist id="cc-origin-list">
          ${originList.map((o) => `<option value="${esc(o)}">`).join("")}
        </datalist>
        <div class="cc-hint">${originList.length
          ? `${originList.length} place${originList.length === 1 ? "" : "s"} already known in this world.`
          : "No origins recorded yet — name a new one."}</div>
      </div>

      <div class="cc-field is-wide">
        <label class="cc-label" for="cc-backstory">Backstory <span class="cc-opt">optional</span></label>
        <textarea class="cc-textarea" id="cc-backstory" data-f="backstory"
                  placeholder="Where they came from, and what it cost.">${esc(p.backstory)}</textarea>
      </div>

      <div class="cc-field">
        <label class="cc-label">Portrait <span class="cc-opt">optional</span></label>
        <div class="cc-img-row">
          <img class="cc-img-prev" data-prev="img" src="${esc(p.img || CC.DEFAULT_IMG)}" alt="">
          <div class="cc-img-ctl">
            <input class="cc-input" data-f="img" value="${esc(p.img)}" placeholder="${esc(CC.DEFAULT_IMG)}">
            <button class="cc-btn-sm" data-pick="img">Browse</button>
          </div>
        </div>
      </div>

      <div class="cc-field">
        <label class="cc-label">Token <span class="cc-opt">optional</span></label>
        <div class="cc-img-row">
          <img class="cc-img-prev" data-prev="tokenImg" src="${esc(p.tokenImg || CC.DEFAULT_IMG)}" alt="">
          <div class="cc-img-ctl">
            <input class="cc-input" data-f="tokenImg" value="${esc(p.tokenImg)}" placeholder="Falls back to the portrait">
            <button class="cc-btn-sm" data-pick="tokenImg">Browse</button>
          </div>
        </div>
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
      if (field === "img" || field === "tokenImg") {
        const prev = root.querySelector(`[data-prev="${field}"]`);
        if (prev) prev.src = el.value || CC.DEFAULT_IMG;
      }
    });
    el.addEventListener("change", () => {
      ctx.edit((dd) => { dd.profile[field] = el.value; });
    });
  });

  root.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const field = btn.dataset.pick;
      // FilePicker is Foundry's own browser; using it means players get the
      // same asset tree they see everywhere else, including S3/Forge buckets.
      const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      if (!FP) { ui.notifications?.warn("File browser unavailable — paste a path instead."); return; }
      new FP({
        type: "image",
        current: d.profile[field] || "",
        callback: (path) => ctx.edit((dd) => { dd.profile[field] = path; }),
      }).render(true);
    });
  });
}

STEP_RENDERERS.set("profile", { render, bind });
