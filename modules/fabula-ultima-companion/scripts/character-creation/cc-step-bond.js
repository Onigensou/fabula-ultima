/**
 * Character Creation — step 5: Initial Bond.
 *
 * A house rule: by the book a character starts with no Bonds at all, but at
 * this table a new PC may begin with one Bond carrying one emotion.
 *
 * The slot is shaped like the camp Bond editor — header with hearts, a
 * `name → relationship` row, and one dropdown per emotion pair — because it is
 * the same record, and a player who has used the camp editor should not have
 * to learn a second way to say the same thing. What differs is the allowance:
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
  .cc-bd { max-width: 660px; }
  .cc-bd-intro { font-size: 12px; line-height: 1.55; opacity: .75; margin-bottom: 12px; }
  .cc-bd-intro b { opacity: 1; }

  .cc-bd-slot { border-radius: 8px; background: #f7f0df; border: 1px solid #cbb890;
    padding: 10px 12px; }
  .cc-bd-slot.is-set { border-color: #8a6c45; background: #fdf6e4;
    box-shadow: inset 0 0 0 1px rgba(240,217,154,.7); }

  .cc-bd-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cc-bd-tag { font-size: 11px; font-weight: 800; letter-spacing: .04em;
    text-transform: uppercase; opacity: .65; }
  .cc-bd-hearts { display: flex; gap: 4px; font-size: 13px; }
  .cc-bd-heart.positive { color: #c98b2a; }
  .cc-bd-heart.negative { color: #a3453a; }
  .cc-bd-heart.empty { color: #c0a67c; opacity: .55; }
  .cc-bd-clear { margin-left: auto; font-family: inherit; font-size: 11px; cursor: pointer;
    padding: 3px 10px; border-radius: 6px; color: #8c3a24;
    border: 1px solid #cbb890; background: linear-gradient(180deg,#f7edd5,#e6d6b0); }
  .cc-bd-clear:hover:not(:disabled) { background: linear-gradient(180deg,#f0d99a,#e0c179); }
  .cc-bd-clear:disabled { opacity: .3; cursor: default; }

  .cc-bd-row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .cc-bd-row input { flex: 1; }
  .cc-bd-row input.cc-bd-rel { flex: 1.6; }
  .cc-bd-arrow { font-size: 15px; opacity: .5; flex: 0 0 auto; }

  .cc-bd-ems { display: flex; gap: 8px; }
  .cc-bd-ems select { flex: 1; font-family: inherit; font-size: 12.5px; padding: 6px 8px;
    border-radius: 7px; background: #fdf6e4; border: 1px solid #cbb890; color: #2f2618; }
  .cc-bd-ems select:focus { outline: none; border-color: #8a6c45; }
  .cc-bd-ems select.is-on { border-color: #8a6c45; font-weight: 700;
    background: linear-gradient(180deg,#f0d99a,#e0c179); }

  .cc-bd-foot { margin-top: 10px; font-size: 12px; opacity: .75; line-height: 1.45; }
`;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Three hearts, filled by polarity — the camp editor's own at-a-glance read. */
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
  if (bondIsEmpty(d)) return "No starting bond — that is perfectly fine.";
  if (named && chosen) return `${named} — ${cap(chosen.value)}.`;
  if (!named && chosen) return "Name who or what this bond is toward.";
  if (named && !chosen) return "Choose one emotion for this bond.";
  return "A bond needs both a target and an emotion.";
}

function render(d) {
  const b = d.bond;

  const selects = CC_EMOTION_PAIRS.map((p) => {
    const v = String(b[p.key] ?? "");
    return `
      <select data-em="${esc(p.key)}" class="${v ? "is-on" : ""}"
              title="${esc(p.pos)} / ${esc(p.neg)}">
        <option value="">—</option>
        <option value="${esc(p.pos)}" ${v === p.pos ? "selected" : ""}>${esc(cap(p.pos))}</option>
        <option value="${esc(p.neg)}" ${v === p.neg ? "selected" : ""}>${esc(cap(p.neg))}</option>
      </select>`;
  }).join("");

  return `
    <style>${CSS}</style>
    <div class="cc-bd">
      <div class="cc-bd-intro">
        By the book a character begins with no Bonds. <b>At this table you may start with one</b>,
        carrying a single emotion. Leave this blank if you would rather your character's
        first Bond form in play.
      </div>

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
                 placeholder="How do you know them? (optional)" autocomplete="off">
        </div>

        <div class="cc-bd-ems">${selects}</div>
      </div>

      <div class="cc-bd-foot">${esc(stateLine(d))}</div>
    </div>`;
}

function bind(root, d, ctx) {
  // Typing uses `touch` so the shell does not re-render mid-word and drop the
  // caret; the state line and hearts are refreshed by hand instead.
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
  // others. The dropdowns still show all three pairs because the pairs are what
  // give each emotion its meaning.
  root.querySelectorAll("[data-em]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.em;
      const value = sel.value;
      ctx.edit((dd) => {
        for (const p of CC_EMOTION_PAIRS) dd.bond[p.key] = "";
        if (value) dd.bond[key] = value;
      });
    });
  });

  root.querySelector("[data-clear]")?.addEventListener("click", () => {
    ctx.edit((dd) => clearBond(dd));
  });
}

STEP_RENDERERS.set("bond", { render, bind });
