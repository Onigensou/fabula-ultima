/**
 * Character Creation — step 5: Initial Bond.
 *
 * A house rule: by the book a character starts with no Bonds at all, but at
 * this table a new PC may begin with one Bond carrying one emotion.
 *
 * The whole step is optional. Leaving it untouched is a valid character; what
 * is not valid is half a bond — a target with no feeling, or a feeling aimed
 * at nobody. `validateStep` enforces exactly that, and the emotion cap of one.
 *
 * The three emotion fields are pairs (admiration/inferiority,
 * loyalty/mistrust, affection/hatred) and a bond may hold at most one from
 * each. Since the starting allowance is a single emotion overall, picking any
 * emotion here clears whatever was picked before — the pairs are presented for
 * their meaning, not because more than one may be chosen.
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
  .cc-bd { max-width: 640px; }
  .cc-bd-intro { font-size: 10px; line-height: 1.6; color: #8a6432; margin-bottom: 16px; }
  .cc-bd-intro em { color: #6b4a1c; font-style: normal; }
  .cc-bd-f { margin-bottom: 14px; }
  .cc-bd-l {
    display: block; font-size: 9px; letter-spacing: 2px; text-transform: uppercase;
    color: #8a6432; margin-bottom: 4px;
  }
  .cc-bd-h { font-size: 9px; color: #9b7040; font-style: italic; margin-top: 3px; }
  .cc-bd-in {
    width: 100%; font-family: inherit; font-size: 12px; color: #2e1c08; padding: 7px 10px;
    background: rgba(255,252,240,0.72); border: 1px solid rgba(140,90,30,0.38); border-radius: 2px;
  }
  .cc-bd-in:focus { outline: none; border-color: #c9a44a; }
  .cc-bd-pairs { display: flex; flex-direction: column; gap: 7px; }
  .cc-bd-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .cc-bd-e {
    font-family: inherit; font-size: 11px; padding: 8px 12px; border-radius: 2px; cursor: pointer;
    color: #5c3a12; text-align: left;
    background: rgba(255,252,240,0.72); border: 1px solid rgba(140,90,30,0.32);
  }
  .cc-bd-e:hover { background: rgba(201,164,74,0.18); }
  .cc-bd-e.is-on { background: #c9a22a; border-color: #a07818; color: #fff; }
  .cc-bd-e small { display: block; font-size: 8px; letter-spacing: 1px;
    text-transform: uppercase; opacity: 0.65; margin-bottom: 1px; }
  .cc-bd-foot { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  .cc-bd-state { font-size: 10px; color: #8a6432; }
`;

function render(d) {
  const b = d.bond;
  const chosen = chosenEmotion(d);

  const pairs = CC_EMOTION_PAIRS.map((p) => `
    <div class="cc-bd-pair">
      ${[["pos", p.pos], ["neg", p.neg]].map(([kind, value]) => `
        <button class="cc-bd-e ${String(b[p.key] ?? "") === value ? "is-on" : ""}"
                data-emotion="${esc(p.key)}" data-value="${esc(value)}">
          <small>${kind === "pos" ? "positive" : "negative"}</small>${esc(value)}
        </button>`).join("")}
    </div>`).join("");

  return `
    <style>${CSS}</style>
    <div class="cc-bd">
      <div class="cc-bd-intro">
        By the book a character begins with no Bonds. <em>At this table you may start with one</em>,
        carrying a single emotion. Leave this step blank if you would rather your
        character's first Bond form in play.
      </div>

      <div class="cc-bd-f">
        <label class="cc-bd-l">Bond toward</label>
        <input class="cc-bd-in" data-name placeholder="A person, a place, an ideal…"
               value="${esc(b.name ?? "")}">
        <div class="cc-bd-h">Who or what does your character feel strongly about?</div>
      </div>

      <div class="cc-bd-f">
        <label class="cc-bd-l">Relationship</label>
        <input class="cc-bd-in" data-rel placeholder="Optional — how do you know them?"
               value="${esc(b.rel ?? "")}">
      </div>

      <div class="cc-bd-f">
        <label class="cc-bd-l">Emotion — choose one</label>
        <div class="cc-bd-pairs">${pairs}</div>
        <div class="cc-bd-h">A starting Bond carries exactly one emotion. Click it again to unset it.</div>
      </div>

      <div class="cc-bd-foot">
        <button class="cc-btn is-ghost" data-clear ${bondIsEmpty(d) ? "disabled" : ""}>Clear bond</button>
        <span class="cc-bd-state">${
          bondIsEmpty(d) ? "No starting bond — that is fine."
          : chosen && String(b.name ?? "").trim()
            ? `${esc(b.name)} — ${esc(chosen.value)}`
            : "Incomplete: a bond needs both a target and an emotion."
        }</span>
      </div>
    </div>`;
}

function bind(root, d, ctx) {
  // Typing uses `touch` so the shell does not re-render mid-word and drop the
  // caret; the footer summary is refreshed by hand instead.
  const live = (sel, field) => {
    const el = root.querySelector(sel);
    if (!el) return;
    el.addEventListener("input", () => {
      ctx.touch((dd) => { dd.bond[field] = el.value; });
      const state = root.querySelector(".cc-bd-state");
      if (state) {
        const chosen = chosenEmotion(d);
        state.textContent = bondIsEmpty(d) ? "No starting bond — that is fine."
          : chosen && String(d.bond.name ?? "").trim() ? `${d.bond.name} — ${chosen.value}`
          : "Incomplete: a bond needs both a target and an emotion.";
      }
      ctx.syncFoot();
    });
    el.addEventListener("change", () => ctx.edit((dd) => { dd.bond[field] = el.value; }));
  };
  live("[data-name]", "name");
  live("[data-rel]", "rel");

  root.querySelectorAll("[data-emotion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.edit((dd) => setEmotion(dd, btn.dataset.emotion, btn.dataset.value));
    });
  });

  root.querySelector("[data-clear]")?.addEventListener("click", () => {
    ctx.edit((dd) => clearBond(dd));
  });
}

STEP_RENDERERS.set("bond", { render, bind });
