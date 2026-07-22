/**
 * Character Creation — step 1: Profile.
 *
 * Built like a JRPG name-entry screen: the portrait and the name are the page,
 * everything else sits underneath as supporting detail. A player arriving here
 * should know immediately that the one thing being asked of them is a name.
 *
 * The image squares ARE the picker — clicking one opens Foundry's FilePicker.
 * A separate Browse button next to a path field made the square look like
 * decoration, when it is the most obvious thing on the page to click.
 *
 * Field hints are deliberately short. The rulebook explains what a Trait is;
 * this window only has to say which box to type in.
 */

import { CC, esc } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";

const CSS = `
  .cc-pf { display: flex; flex-direction: column; gap: 16px; }

  /* ── the name-entry hero ── */
  .cc-pf-hero { display: flex; gap: 16px; align-items: center;
    padding: 16px 18px; border-radius: 10px;
    background: linear-gradient(180deg,#f7f0df,#efe4cd); border: 1px solid #cbb890; }
  .cc-pf-art { display: flex; gap: 8px; flex: 0 0 auto; align-items: flex-end; }
  .cc-pf-slot { display: flex; flex-direction: column; gap: 4px; align-items: center; }
  .cc-pf-pick { padding: 0; border-radius: 9px; cursor: pointer; display: block;
    border: 1px solid #b79c72; background: #efe4cd; overflow: hidden; position: relative; }
  .cc-pf-pick.big { width: 104px; height: 104px; }
  .cc-pf-pick.small { width: 68px; height: 68px; }
  .cc-pf-pick:hover { border-color: #8a6c45; box-shadow: 0 0 0 2px rgba(240,217,154,.7); }
  .cc-pf-pick img { width: 100%; height: 100%; object-fit: cover; display: block;
    border: 0 !important; outline: 0 !important; }
  .cc-pf-over { position: absolute; inset: auto 0 0 0; padding: 2px 0; font-size: 10px;
    font-weight: 700; text-align: center; background: rgba(45,35,20,.72); color: #f6ecd8;
    opacity: 0; transition: opacity .12s; }
  .cc-pf-pick:hover .cc-pf-over { opacity: 1; }
  .cc-pf-cap { font-size: 10.5px; font-weight: 700; opacity: .6; }
  .cc-pf-clear { font-family: inherit; font-size: 10px; cursor: pointer; padding: 0;
    background: none; border: 0; color: #8a6c45; text-decoration: underline; }

  .cc-pf-ask { flex: 1 1 auto; min-width: 0; }
  .cc-pf-prompt { font-size: 15px; font-weight: 800; margin-bottom: 9px; }
  .cc-pf-name { width: 100%; font-family: inherit; font-size: 22px; font-weight: 700;
    color: #2f2618; padding: 10px 14px; border-radius: 9px;
    background: #fdf6e4; border: 2px solid #cbb890; letter-spacing: .01em; }
  .cc-pf-name:focus { outline: none; border-color: #8a6c45; box-shadow: 0 0 0 3px rgba(240,217,154,.55); }
  .cc-pf-name::placeholder { color: #2f2618; opacity: .22; font-weight: 400; }

  /* ── traits ── */
  .cc-pf-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px 14px; }
  .cc-pf-field { display: flex; flex-direction: column; gap: 4px; }
  .cc-pf-field.is-wide { grid-column: 1 / -1; }
  .cc-pf-field textarea.cc-input { resize: vertical; min-height: 76px; line-height: 1.5; }
  .cc-pf-opt { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: .7; }
  .cc-pf-traits { font-size: 11px; opacity: .55; margin-top: -4px; }
`;

/**
 * Whether this is the first paint since the wizard opened.
 *
 * Only then is it right to grab focus for the name box; on every later render
 * the player is already somewhere and moving them is an interruption.
 */
let _firstBind = true;
export const resetUiState = () => { _firstBind = true; };

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

const slot = (field, label, src, size) => `
  <div class="cc-pf-slot">
    <button class="cc-pf-pick ${size}" data-pick="${field}" title="Click to choose an image">
      <img data-prev="${field}" src="${esc(src || CC.DEFAULT_IMG)}" alt="">
      <span class="cc-pf-over">Change</span>
    </button>
    <span class="cc-pf-cap">${esc(label)}</span>
    ${src ? `<button class="cc-pf-clear" data-clear="${field}">clear</button>` : ""}
  </div>`;

function render(d) {
  const p = d.profile;
  const origins = knownOrigins();

  return `
    <style>${CSS}</style>
    <div class="cc-pf">

      <div class="cc-pf-hero">
        <div class="cc-pf-art">
          ${slot("img", "Portrait", p.img, "big")}
          ${slot("tokenImg", "Token", p.tokenImg, "small")}
        </div>
        <div class="cc-pf-ask">
          <div class="cc-pf-prompt">Please enter your name.</div>
          <input class="cc-pf-name" data-f="name" value="${esc(p.name)}"
                 maxlength="40" autocomplete="off" spellcheck="false">
        </div>
      </div>

      <div class="cc-pf-grid">
        <div class="cc-pf-field is-wide">
          <label class="cc-label" for="cc-identity">Identity</label>
          <input class="cc-input" id="cc-identity" data-f="identity" value="${esc(p.identity)}"
                 placeholder="The Last Princess of Platea" autocomplete="off">
        </div>

        <div class="cc-pf-field">
          <label class="cc-label" for="cc-theme">Theme</label>
          <input class="cc-input" id="cc-theme" data-f="theme" value="${esc(p.theme)}"
                 placeholder="Hope" autocomplete="off">
        </div>

        <div class="cc-pf-field">
          <label class="cc-label" for="cc-origin">Origin</label>
          <input class="cc-input" id="cc-origin" data-f="origin" value="${esc(p.origin)}"
                 list="cc-origin-list" placeholder="Vaskell" autocomplete="off">
          <datalist id="cc-origin-list">
            ${origins.map((o) => `<option value="${esc(o)}">`).join("")}
          </datalist>
        </div>

        <div class="cc-pf-field">
          <label class="cc-label">&nbsp;</label>
          <div class="cc-pf-traits">Your three Traits. Any can be invoked to reroll.</div>
        </div>

        <div class="cc-pf-field is-wide">
          <label class="cc-label" for="cc-backstory">Backstory <span class="cc-pf-opt">optional</span></label>
          <textarea class="cc-input" id="cc-backstory" data-f="backstory"
                    placeholder="Where they came from, and what it cost.">${esc(p.backstory)}</textarea>
        </div>
      </div>

    </div>`;
}

function bind(root, d, ctx) {
  // Typing uses `touch` so the caret survives. The name is the one field that
  // gates the step, so it re-renders on `input` too — otherwise Next would stay
  // greyed out until the box lost focus, which reads as the button being broken.
  root.querySelectorAll("[data-f]").forEach((el) => {
    const field = el.dataset.f;
    el.addEventListener("input", () => {
      if (field === "name") {
        const before = !!String(d.profile.name ?? "").trim();
        const after = !!el.value.trim();
        ctx.touch((dd) => { dd.profile.name = el.value; });
        ctx.syncFoot();
        // Only redraw when the gate actually flips, so a re-render does not
        // land on every keystroke and steal the caret.
        if (before !== after) {
          ctx.refresh();
          const box = root.querySelector("[data-f='name']");
          if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        }
        return;
      }
      ctx.touch((dd) => { dd.profile[field] = el.value; });
    });
    el.addEventListener("change", () => ctx.edit((dd) => { dd.profile[field] = el.value; }));
  });

  root.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      pickImage(d, btn.dataset.pick, ctx);
    });
  });

  root.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ctx.edit((dd) => { dd.profile[btn.dataset.clear] = ""; });
    });
  });

  // The name is what this page is for — but only put the caret there on
  // ARRIVAL. Focusing on every bind meant any re-render (committing another
  // field, clearing an image) yanked the caret out of whatever the player was
  // actually typing in and back up to the name box.
  if (_firstBind) {
    _firstBind = false;
    root.querySelector("[data-f='name']")?.focus();
  }
}

/**
 * Choose a portrait or token image.
 *
 * FilePicker has moved around between Foundry versions and is namespaced
 * differently in v13, so it is looked up in several places rather than assumed.
 * If none of them answers, the player still gets a box to paste a path or URL
 * into — refusing outright left "input an image link" with no route at all.
 */
function pickImage(d, field, ctx) {
  const commit = (path) => ctx.edit((dd) => { dd.profile[field] = String(path ?? "").trim(); });
  const current = d.profile[field] || "";

  const FP = foundry?.applications?.apps?.FilePicker?.implementation
    ?? globalThis.FilePicker
    ?? foundry?.applications?.apps?.FilePicker;

  if (typeof FP === "function") {
    try {
      new FP({ type: "image", current, callback: commit }).render(true);
      return;
    } catch (e) {
      console.warn("[ONI][CharCreate] FilePicker failed, falling back to a path box:", e);
    }
  }
  promptForPath(current, commit);
}

/** Last resort: type or paste a path. Always available. */
function promptForPath(current, commit) {
  const content = `
    <p style="margin:0 0 6px">Paste an image path or URL.</p>
    <input type="text" name="path" value="${esc(current)}"
           placeholder="worlds/my-world/art/hero.webp"
           style="width:100%;padding:6px 8px">`;
  new Dialog({
    title: "Image",
    content,
    buttons: {
      ok: {
        label: "Use",
        callback: (html) => commit(html[0]?.querySelector?.("[name=path]")?.value ?? ""),
      },
      cancel: { label: "Cancel" },
    },
    default: "ok",
  }).render(true);
}

STEP_RENDERERS.set("profile", { render, bind, reset: resetUiState });
