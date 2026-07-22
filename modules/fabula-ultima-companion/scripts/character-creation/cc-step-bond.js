/**
 * Character Creation — step 5: Initial Bond.
 *
 * A house rule: by the book a character starts with no Bonds at all, but at
 * this table a new PC may begin with one Bond carrying one emotion.
 *
 * The slot is shaped like the camp Bond editor — hearts, a
 * `name → relationship` row, one control per emotion pair — because it is the
 * same record, and a player who has used the camp editor should not have to
 * learn a second way to say the same thing. What differs is the allowance:
 * camp permits one emotion per pair, creation permits one in total.
 *
 * The whole step is optional. Leaving it untouched is a valid character; what
 * is not valid is half a bond — a target with no feeling, or a feeling aimed
 * at nobody. `validateStep` enforces exactly that, and the emotion cap of one.
 *
 * Finalize hands these fields to `BondUpdater.writeSlot(actor, 1, {...})`
 * rather than writing the props directly.
 */

import { esc, CC_EMOTION_PAIRS } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";

// ── pure model (exported for tests) ────────────────────────────────────────

/** The emotion currently chosen, as { key, value }, or null. */
export function chosenEmotion(d) {
  for (const p of CC_EMOTION_PAIRS) {
    const v = String(d?.bond?.[p.key] ?? "").trim();
    if (v) return { key: p.key, value: v };
  }
  return null;
}

/** How many emotion fields are set. More than one is an invalid state. */
export const emotionCount = (d) =>
  CC_EMOTION_PAIRS.filter((p) => String(d?.bond?.[p.key] ?? "").trim()).length;

/**
 * Set the single starting emotion, clearing any other.
 *
 * Clicking the emotion already chosen unsets it, so the control toggles. That
 * only applies when it is the ONLY one set: a draft carrying two emotions is
 * incoherent (nothing in the UI can produce it, but a restored or
 * hand-edited draft can), and there the click means "make this the one" —
 * treating it as a toggle would clear the field and leave the bond broken in a
 * different way.
 */
export function setEmotion(d, pairKey, value) {
  const isOnly = emotionCount(d) === 1 && String(d.bond[pairKey] ?? "").trim() === value;
  for (const p of CC_EMOTION_PAIRS) d.bond[p.key] = "";
  if (!isOnly) d.bond[pairKey] = value;
  return chosenEmotion(d);
}

/** Is the step effectively untouched? */
export const bondIsEmpty = (d) =>
  !String(d?.bond?.name ?? "").trim() &&
  !String(d?.bond?.rel ?? "").trim() &&
  !chosenEmotion(d);

/** Clear the whole bond. */
export function clearBond(d) {
  d.bond.name = "";
  d.bond.rel = "";
  for (const p of CC_EMOTION_PAIRS) d.bond[p.key] = "";
}

// ── view ───────────────────────────────────────────────────────────────────

const CSS = `
  .cc-bd { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; }

  .cc-bd-slot { flex: 0 0 auto; border-radius: 10px; padding: 14px 16px;
    background: linear-gradient(180deg,#f7f0df,#efe4cd); border: 1px solid #cbb890; }
  .cc-bd-slot.is-set { border-color: #8a6c45;
    box-shadow: inset 0 0 0 1px rgba(240,217,154,.8); }

  .cc-bd-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .cc-bd-tag { font-size: 12px; font-weight: 800; letter-spacing: .06em;
    text-transform: uppercase; opacity: .55; }
  .cc-bd-hearts { display: flex; gap: 5px; font-size: 16px; }
  /* Red is warmth, purple is the darker feeling -- the table’s own coding. */
  .cc-bd-heart.positive { color: #c9403a; }
  .cc-bd-heart.negative { color: #7a4b9d; }
  .cc-bd-heart.empty { color: #c0a67c; opacity: .5; }
  .cc-bd-clear { margin-left: auto; font-family: inherit; font-size: 11.5px; cursor: pointer;
    padding: 4px 12px; border-radius: 7px; color: #8c3a24;
    border: 1px solid #cbb890; background: linear-gradient(180deg,#f7edd5,#e6d6b0); }
  .cc-bd-clear:hover:not(:disabled) { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-bd-clear:disabled { opacity: .3; cursor: default; }

  .cc-bd-row { display: flex; align-items: center; gap: 10px; }
  .cc-bd-row input { flex: 1; font-size: 15px; padding: 9px 12px; }
  .cc-bd-row input.cc-bd-rel { flex: 1.5; font-size: 13px; }
  .cc-bd-arrow { font-size: 17px; opacity: .45; flex: 0 0 auto; }

  /* The three pairs, side by side, filling the width. Each is a pair of
     buttons rather than a dropdown so both poles are readable at a glance —
     the pairing is the meaning, and a collapsed <select> hides it. */
  .cc-bd-pairs { flex: 1 1 auto; display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 12px; min-height: 0; }
  .cc-bd-pair { display: flex; flex-direction: column; border-radius: 10px; overflow: hidden;
    border: 1px solid #cbb890; background: #f7f0df; }
  .cc-bd-em { flex: 1 1 0; font-family: inherit; cursor: pointer; border: 0;
    background: none; color: #3b2a17; padding: 14px 10px; text-align: center;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
  .cc-bd-em + .cc-bd-em { border-top: 1px solid #cbb890; }
  .cc-bd-em:hover { background: rgba(240,217,154,.45); }
  .cc-bd-em i { font-size: 20px; opacity: .35; }
  .cc-bd-em .nm { font-size: 14px; font-weight: 700; }
  .cc-bd-em .pol { font-size: 10px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; opacity: .5; }
  .cc-bd-em.on { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-bd-em.on i { opacity: 1; }
  .cc-bd-em.on.pos i { color: #c9403a; }
  .cc-bd-em.on.neg i { color: #7a4b9d; }
  .cc-bd-em.on .pol { opacity: .75; }

  .cc-bd-foot { flex: 0 0 auto; font-size: 12.5px; opacity: .7; text-align: center; }
`;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Three hearts, filled by polarity — the camp editor's at-a-glance read. */
function heartsHTML(d) {
  return CC_EMOTION_PAIRS.map((p) => {
    const v = String(d.bond[p.key] ?? "");
    if (v === p.pos) return `<i class="fas fa-heart cc-bd-heart positive" title="${esc(v)}"></i>`;
    if (v === p.neg) return `<i class="fas fa-heart cc-bd-heart negative" title="${esc(v)}"></i>`;
    return `<i class="far fa-heart cc-bd-heart empty"></i>`;
  }).join("");
}

function stateLine(d) {
  const chosen = chosenEmotion(d);
  const named = String(d.bond.name ?? "").trim();
  if (bondIsEmpty(d)) return "No starting bond — that is fine. Continue when ready.";
  if (named && chosen) return `${named} — ${cap(chosen.value)}`;
  if (!named && chosen) return "Name who or what this bond is toward.";
  return "Choose one emotion.";
}

function render(d) {
  const b = d.bond;

  const pairs = CC_EMOTION_PAIRS.map((p) => {
    const v = String(b[p.key] ?? "");
    const btn = (value, polarity, label) => `
      <button class="cc-bd-em ${polarity} ${v === value ? "on" : ""}"
              data-em="${esc(p.key)}" data-val="${esc(value)}">
        <i class="${v === value ? "fas" : "far"} fa-heart"></i>
        <span class="nm">${esc(cap(value))}</span>
        <span class="pol">${label}</span>
      </button>`;
    return `<div class="cc-bd-pair">
      ${btn(p.pos, "pos", "positive")}
      ${btn(p.neg, "neg", "negative")}
    </div>`;
  }).join("");

  return `
    <style>${CSS}</style>
    <div class="cc-bd">
      <div class="cc-bd-slot ${bondIsEmpty(d) ? "" : "is-set"}">
        <div class="cc-bd-head">
          <span class="cc-bd-tag">Bond 1</span>
          <span class="cc-bd-hearts">${heartsHTML(d)}</span>
          <button class="cc-bd-clear" data-clear ${bondIsEmpty(d) ? "disabled" : ""}>Clear</button>
        </div>
        <div class="cc-bd-row">
          <input class="cc-input" data-f="name" value="${esc(b.name ?? "")}"
                 placeholder="A person, a place, an ideal…" autocomplete="off">
          <span class="cc-bd-arrow">→</span>
          <input class="cc-input cc-bd-rel" data-f="rel" value="${esc(b.rel ?? "")}"
                 placeholder="How do you know them?" autocomplete="off">
        </div>
      </div>

      <div class="cc-bd-pairs">${pairs}</div>

      <div class="cc-bd-foot">${esc(stateLine(d))}</div>
    </div>`;
}

function bind(root, d, ctx) {
  // Typing uses `touch` so the shell does not re-render mid-word and drop the
  // caret; the state line is refreshed by hand instead.
  root.querySelectorAll("[data-f]").forEach((el) => {
    const field = el.dataset.f;
    el.addEventListener("input", () => {
      ctx.touch((dd) => { dd.bond[field] = el.value; });
      const foot = root.querySelector(".cc-bd-foot");
      if (foot) foot.textContent = stateLine(d);
    });
    el.addEventListener("change", () => ctx.edit((dd) => { dd.bond[field] = el.value; }));
  });

  // A starting bond carries ONE emotion, so choosing in any pair clears the
  // others; clicking the chosen one again unsets it.
  root.querySelectorAll("[data-em]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.edit((dd) => setEmotion(dd, btn.dataset.em, btn.dataset.val));
    });
  });

  root.querySelector("[data-clear]")?.addEventListener("click", () => {
    ctx.edit((dd) => clearBond(dd));
  });
}

STEP_RENDERERS.set("bond", { render, bind });
