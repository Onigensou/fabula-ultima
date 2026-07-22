/**
 * Character Creation — step 2: Attributes.
 *
 * Level, one of the three starting arrays (p.162), assignment of that array's
 * dice to MIG/DEX/INS/WLP, and — for characters created at level 20 or 40 — the
 * permanent die steps those milestones grant (p.227).
 *
 * ASSIGNMENT IS A PERMUTATION, NOT FOUR FREE CHOICES
 * --------------------------------------------------
 * The array is a fixed pool. Picking d10 for MIG when DEX holds it must MOVE
 * it, not clone it, or a player can quietly hand themselves four d10s. Every
 * change is therefore a swap, which makes an invalid spread unreachable rather
 * than merely rejected.
 *
 * MILESTONES
 * ----------
 * A character created above level 20 has already earned those advances and is
 * entitled to them at creation — an explicit table ruling. They are picked here
 * and written to the attribute system's own ledger at finalize, so the badge
 * does not later offer them a second time.
 *
 * The derived preview shows BASE values only. Class benefits (+5 HP / +5 MP /
 * +2 IP per class) are chosen in the next step and are called out as pending
 * rather than guessed at.
 */

import { CC, CC_ATTR_KEYS, CC_ATTR_LABEL, esc, num } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import { draftLevel, draftMilestones } from "./cc-draft.js";

const DIE_STEPS = [6, 8, 10, 12];
const nextDie = (die) => {
  const i = DIE_STEPS.indexOf(num(die, 0));
  return i >= 0 && i < DIE_STEPS.length - 1 ? DIE_STEPS[i + 1] : null;
};

/**
 * Base dice after milestone advances are applied on top of the array.
 * Steps that would push past d12 are dropped — the cap is real (p.227).
 */
export function effectiveBases(d) {
  const out = {};
  for (const k of CC_ATTR_KEYS) out[k] = num(d.attributes.assign[k], 0);
  for (const pick of d.attributes.milestonePicks ?? []) {
    if (!CC_ATTR_KEYS.includes(pick)) continue;
    const up = nextDie(out[pick]);
    if (up != null) out[pick] = up;
  }
  return out;
}

/** Base derived stats. Excludes class benefits and equipment, deliberately. */
export function previewDerived(d) {
  const b = effectiveBases(d);
  const lvl = draftLevel(d);
  const maxHp = lvl + 5 * num(b.mig, 0);
  const maxMp = lvl + 5 * num(b.wlp, 0);
  const avg = (die) => (num(die, 0) + 1) / 2;
  return {
    maxHp, maxMp,
    crisis: Math.floor(maxHp / 2),
    maxIp: CC.RULE.BASE_IP,
    def: num(b.dex, 0),
    mdef: num(b.ins, 0),
    init: avg(b.dex) + avg(b.ins),
  };
}

const CSS = `
  .cc-attr-wrap { display: grid; grid-template-columns: 1fr 300px; gap: 22px; align-items: start; }

  .cc-row { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .cc-row label { font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #8a6432; }
  .cc-lvl {
    font-family: inherit; font-size: 13px; color: #2e1c08; width: 78px;
    background: rgba(255,252,240,0.72); border: 1px solid rgba(140,90,30,0.38);
    border-radius: 2px; padding: 6px 8px; text-align: center;
  }
  .cc-lvl:focus { outline: none; border-color: #c9a44a; background: #fffdf4; }

  .cc-arrays { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 18px; }
  .cc-array {
    cursor: pointer; border-radius: 3px; padding: 10px 11px; text-align: left;
    border: 1px solid rgba(140,90,30,0.35); background: rgba(255,252,240,0.55);
    font-family: inherit; color: #5c3a12; transition: background .12s, border-color .12s;
  }
  .cc-array:hover { background: rgba(255,252,240,0.9); }
  .cc-array.is-on { border-color: #c9a44a; background: rgba(201,164,74,0.26); }
  .cc-array-name { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #3a1e06; }
  .cc-array-dice { font-size: 13px; letter-spacing: 1px; color: #7a5428; margin: 5px 0 4px; }
  .cc-array-blurb { font-size: 9px; line-height: 1.4; color: #9b7040; }

  .cc-attr-list { display: flex; flex-direction: column; gap: 7px; }
  .cc-attr {
    display: grid; grid-template-columns: 108px 1fr auto; gap: 10px; align-items: center;
    padding: 8px 11px; border-radius: 3px;
    border: 1px solid rgba(140,90,30,0.28); background: rgba(255,252,240,0.5);
  }
  .cc-attr-name { font-size: 11px; letter-spacing: 2px; color: #3a1e06; text-transform: uppercase; }
  .cc-attr-sel {
    font-family: inherit; font-size: 12px; color: #2e1c08; padding: 5px 8px;
    background: rgba(255,255,250,0.9); border: 1px solid rgba(140,90,30,0.38); border-radius: 2px;
  }
  .cc-attr-sel:focus { outline: none; border-color: #c9a44a; }
  .cc-attr-eff { font-size: 11px; color: #7a5428; letter-spacing: 1px; min-width: 74px; text-align: right; }
  .cc-attr-eff .cc-up { color: #1f7a3d; }

  .cc-ms { margin-top: 18px; padding: 12px 14px; border-radius: 3px;
    border: 1px solid rgba(140,90,30,0.35); background: rgba(201,164,74,0.13); }
  .cc-ms-title { font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: #3a1e06; margin-bottom: 4px; }
  .cc-ms-hint { font-size: 9px; color: #8a6432; margin-bottom: 9px; line-height: 1.45; }
  .cc-ms-pick { display: flex; align-items: center; gap: 9px; margin-bottom: 6px; }
  .cc-ms-lbl { font-size: 10px; color: #7a5428; letter-spacing: 1px; min-width: 74px; }

  .cc-prev { border: 1px solid rgba(140,90,30,0.35); border-radius: 3px;
    background: rgba(255,252,240,0.6); padding: 14px 16px; }
  .cc-prev-title { font-size: 10px; letter-spacing: 3px; text-transform: uppercase;
    color: #3a1e06; margin-bottom: 11px; }
  .cc-prev-row { display: flex; justify-content: space-between; align-items: baseline;
    font-size: 11px; color: #5c3a12; padding: 4px 0; border-bottom: 1px dotted rgba(140,90,30,0.22); }
  .cc-prev-row:last-of-type { border-bottom: 0; }
  .cc-prev-k { letter-spacing: 1px; color: #8a6432; font-size: 10px; }
  .cc-prev-v { font-size: 13px; color: #2e1c08; }
  .cc-prev-note { margin-top: 11px; font-size: 9px; line-height: 1.45; color: #9b7040; }
`;

function arraysHTML(d) {
  return Object.values(CC.ARRAYS).map((a) => `
    <button class="cc-array ${d.attributes.arrayKey === a.key ? "is-on" : ""}"
            data-array="${esc(a.key)}">
      <div class="cc-array-name">${esc(a.label)}</div>
      <div class="cc-array-dice">${a.dice.map((x) => "d" + x).join(" · ")}</div>
      <div class="cc-array-blurb">${esc(a.blurb)}</div>
    </button>`).join("");
}

function attrListHTML(d) {
  const arr = CC.ARRAYS[d.attributes.arrayKey] ?? CC.ARRAYS.average;
  const eff = effectiveBases(d);
  // Distinct die values, so the select shows each size once; duplicates in the
  // pool are handled by the swap, not by listing d8 twice.
  const options = [...new Set(arr.dice)].sort((a, b) => b - a);

  return CC_ATTR_KEYS.map((k) => {
    const cur = num(d.attributes.assign[k], 0);
    const bumped = eff[k] > cur && cur > 0;
    return `
      <div class="cc-attr">
        <div class="cc-attr-name">${esc(CC_ATTR_LABEL[k])}</div>
        <select class="cc-attr-sel" data-attr="${k}">
          <option value="">— assign —</option>
          ${options.map((o) => `<option value="${o}" ${cur === o ? "selected" : ""}>d${o}</option>`).join("")}
        </select>
        <div class="cc-attr-eff">${
          cur ? (bumped ? `d${cur} → <span class="cc-up">d${eff[k]}</span>` : `d${cur}`) : "—"
        }</div>
      </div>`;
  }).join("");
}

function milestoneHTML(d) {
  const n = draftMilestones(d);
  if (!n) return "";
  const eff = effectiveBases(d);
  const picks = d.attributes.milestonePicks ?? [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const at = CC.MILESTONES[i];
    const sel = picks[i] ?? "";
    rows.push(`
      <div class="cc-ms-pick">
        <span class="cc-ms-lbl">Level ${at}</span>
        <select class="cc-attr-sel" data-ms="${i}">
          <option value="">— choose —</option>
          ${CC_ATTR_KEYS.map((k) => {
            // A d12 cannot go higher, so offering it would promise nothing.
            const capped = num(eff[k], 0) >= 12 && sel !== k;
            return `<option value="${k}" ${sel === k ? "selected" : ""} ${capped ? "disabled" : ""}>
              ${esc(CC_ATTR_LABEL[k])}${capped ? " (at d12)" : ""}
            </option>`;
          }).join("")}
        </select>
      </div>`);
  }
  return `
    <div class="cc-ms">
      <div class="cc-ms-title">Milestone Advances</div>
      <div class="cc-ms-hint">
        Starting at level ${CC.MILESTONES[0]} or above means these advances are already earned.
        Each raises one attribute's base die by one step, to a maximum of d12.
      </div>
      ${rows.join("")}
    </div>`;
}

function previewHTML(d) {
  const p = previewDerived(d);
  const row = (k, v) => `<div class="cc-prev-row"><span class="cc-prev-k">${k}</span><span class="cc-prev-v">${v}</span></div>`;
  return `
    <div class="cc-prev">
      <div class="cc-prev-title">Derived</div>
      ${row("Max HP", p.maxHp)}
      ${row("Crisis", p.crisis)}
      ${row("Max MP", p.maxMp)}
      ${row("Max IP", p.maxIp)}
      ${row("Defense", p.def)}
      ${row("M. Defense", p.mdef)}
      ${row("Initiative", p.init.toFixed(1))}
      <div class="cc-prev-note">
        Base values only. Class benefits (+5 HP / +5 MP / +2 IP each) and equipment
        are applied after the next steps.
      </div>
    </div>`;
}

function render(d) {
  return `
    <style>${CSS}</style>
    <div class="cc-attr-wrap">
      <div>
        <div class="cc-row">
          <label for="cc-level">Starting Level</label>
          <input class="cc-lvl" id="cc-level" type="number"
                 min="${CC.RULE.MIN_LEVEL}" max="${CC.RULE.MAX_LEVEL}"
                 value="${esc(draftLevel(d))}">
          <span class="cc-hint" style="font-size:9px;color:#9b7040;">
            Sets the Skill Point pool and the equipment budget.
          </span>
        </div>
        <div class="cc-arrays">${arraysHTML(d)}</div>
        <div class="cc-attr-list">${attrListHTML(d)}</div>
        ${milestoneHTML(d)}
      </div>
      <div data-prev-panel>${previewHTML(d)}</div>
    </div>`;
}

function bind(root, d, ctx) {
  // Level: live preview while typing (no re-render, so the caret survives),
  // full commit on change so reconcile can trim downstream picks.
  const lvl = root.querySelector("#cc-level");
  lvl?.addEventListener("input", () => {
    const v = Number(lvl.value);
    if (!Number.isFinite(v)) return;
    ctx.touch((dd) => { dd.attributes.level = v; });
    const panel = root.querySelector("[data-prev-panel]");
    if (panel) panel.innerHTML = previewHTML(d);
    ctx.syncFoot();
  });
  lvl?.addEventListener("change", () => {
    const v = Math.max(CC.RULE.MIN_LEVEL, Math.min(CC.RULE.MAX_LEVEL, Number(lvl.value) || CC.RULE.START_LEVEL));
    ctx.edit((dd) => { dd.attributes.level = v; });
  });

  root.querySelectorAll("[data-array]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.array;
      if (d.attributes.arrayKey === key) return;
      // reconcile() clears an assignment whose pool no longer matches.
      ctx.edit((dd) => { dd.attributes.arrayKey = key; });
    });
  });

  // Assignment: always a swap, so the pool is conserved by construction.
  root.querySelectorAll("[data-attr]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const key = sel.dataset.attr;
      const want = sel.value === "" ? 0 : Number(sel.value);
      ctx.edit((dd) => {
        const a = dd.attributes.assign;
        if (!want) { delete a[key]; return; }
        const holder = CC_ATTR_KEYS.find((k) => k !== key && num(a[k], 0) === want);
        const had = num(a[key], 0);
        a[key] = want;
        if (holder) {
          // Give the other attribute what this one was holding. If this one held
          // nothing, it loses its die rather than gaining a phantom duplicate.
          if (had) a[holder] = had; else delete a[holder];
        }
      });
    });
  });

  root.querySelectorAll("[data-ms]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const i = Number(sel.dataset.ms);
      ctx.edit((dd) => {
        const picks = dd.attributes.milestonePicks ?? (dd.attributes.milestonePicks = []);
        while (picks.length <= i) picks.push("");
        picks[i] = sel.value;
      });
    });
  });
}

STEP_RENDERERS.set("attributes", { render, bind });
