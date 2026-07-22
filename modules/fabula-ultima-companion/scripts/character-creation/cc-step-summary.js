/**
 * Character Creation — step 6: Summary.
 *
 * Everything the player entered, laid out for one last read before the Actor
 * is written. Nothing here is editable: each panel carries a link back to the
 * step that owns it, which is the golden rule's backtracking expressed as the
 * shortest possible route rather than five clicks along the rail.
 *
 * Outstanding problems are listed in full, with the step that raised each one,
 * because "Create" being disabled is only useful if the reason is visible. The
 * shell owns the Create button and gates it on `validateAll`; this step's job
 * is to make the verdict legible.
 */

import { CC, esc, num, CC_ATTR_KEYS, CC_ATTR_LABEL, CC_EMOTION_PAIRS } from "./cc-const.js";
import { STEP_RENDERERS } from "./cc-app.js";
import {
  draftLevel, draftBudget, draftSpend, draftBudgetLeft,
  draftPointPool, draftClassLevels, draftMartial, validateAll,
} from "./cc-draft.js";
import { effectiveBases, previewDerived } from "./cc-step-attributes.js";
import { picks as equipPicks, martialNeed, advisories } from "./cc-step-equipment.js";
import { chosenEmotion, bondIsEmpty } from "./cc-step-bond.js";
import { previewFolder } from "./cc-folder.js";
import { resolveClass } from "../levelup-system/class-registry.js";

/**
 * The layout here is unchanged and still wants a proper pass; only the palette
 * has been brought into line with the rest of the window. Class names starting
 * `cc-sm-`/`cc-card`/`cc-attr` are local to this step.
 */
const CSS = `
  .cc-sm { display: grid; grid-template-columns: 240px 1fr; gap: 16px; }
  .cc-sm-id { display: flex; flex-direction: column; gap: 9px; }
  .cc-sm-port { width: 100%; aspect-ratio: 1; border-radius: 8px; object-fit: cover;
    border: 1px solid #b79c72; background: #f7f0df; }
  .cc-sm-name { font-size: 17px; font-weight: 800; line-height: 1.25; }
  .cc-sm-sub { font-size: 12px; opacity: .7; line-height: 1.5; }
  .cc-sm-dest { font-size: 11px; opacity: .75; line-height: 1.5; padding: 7px 9px;
    border-radius: 8px; background: #e6dabd; border: 1px solid #cbb890; }

  .cc-sm-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-content: start; }
  .cc-card { padding: 10px 12px; border-radius: 8px;
    border: 1px solid #cbb890; background: #f7f0df; }
  .cc-card.is-wide { grid-column: 1 / -1; }
  .cc-card-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px;
    font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; opacity: .65; }
  .cc-card-step { margin-left: auto; font-size: 10px; font-weight: 400; opacity: .7; }

  .cc-attr { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center; }
  .cc-attr div span { display: block; }
  .cc-attr .v { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .cc-attr .k { font-size: 10px; opacity: .65; }
  .cc-der { display: flex; flex-wrap: wrap; gap: 3px 12px; margin-top: 8px;
    font-size: 12px; opacity: .8; font-variant-numeric: tabular-nums; }

  .cc-rows { display: flex; flex-direction: column; gap: 4px; }
  .cc-row { display: flex; align-items: center; gap: 7px; font-size: 12px; }
  .cc-row img { width: 20px; height: 20px; border-radius: 4px; object-fit: contain;
    flex: 0 0 20px; border: 0 !important; }
  .cc-row .r { margin-left: auto; opacity: .7; white-space: nowrap; }
  .cc-sub { font-size: 11px; opacity: .65; padding-left: 4px; line-height: 1.45; }
  .cc-none { font-size: 12px; opacity: .6; font-style: italic; }
  .cc-prose { font-size: 12px; line-height: 1.5; white-space: pre-wrap; opacity: .85; }

  .cc-issues { margin-top: 14px; padding: 10px 13px; border-radius: 8px;
    border: 1px solid rgba(165,42,26,.35); background: rgba(165,42,26,.09); }
  .cc-issues-h { font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: #a3453a; margin-bottom: 5px; }
  .cc-issue { font-size: 12px; color: #8c3a24; line-height: 1.5; display: flex; gap: 7px; }
  .cc-issue-step { margin-left: auto; opacity: .7; font-size: 11px; white-space: nowrap; }
  .cc-ready { margin-top: 14px; padding: 10px 13px; border-radius: 8px;
    border: 1px solid #cbb890; background: rgba(240,217,154,.35);
    font-size: 12px; color: #6b4a1c; line-height: 1.5; }
`;

// Panels are read-only. Backtracking is Back, all the way down -- the rail and
// the per-panel shortcuts are gone, so there is exactly one way to move.
const card = (title, stepId, body, wide = false) => `
  <div class="cc-card ${wide ? "is-wide" : ""}">
    <div class="cc-card-h"><span>${esc(title)}</span>
      ${stepId ? `<span class="cc-card-step">step ${esc(stepId)}</span>` : ""}</div>
    ${body}
  </div>`;

const none = (text) => `<div class="cc-none">${esc(text)}</div>`;

function profileCard(d) {
  const p = d.profile;
  const rows = [
    ["Identity", p.identity], ["Theme", p.theme], ["Origin", p.origin],
  ].filter(([, v]) => String(v ?? "").trim());
  const body = rows.length || String(p.backstory ?? "").trim()
    ? `<div class="cc-rows">${rows.map(([k, v]) =>
        `<div class="cc-row"><span>${esc(k)}</span><span class="r">${esc(v)}</span></div>`).join("")}</div>
       ${String(p.backstory ?? "").trim()
         ? `<div class="cc-prose" style="margin-top:8px">${esc(p.backstory)}</div>` : ""}`
    : none("Nothing recorded.");
  return card("Profile", "profile", body);
}

function attributeCard(d) {
  const b = effectiveBases(d);
  const der = previewDerived(d);
  const body = `
    <div class="cc-attr">
      ${CC_ATTR_KEYS.map((k) => `
        <div><span class="v">d${num(b[k], 0)}</span><span class="k">${esc(CC_ATTR_LABEL[k])}</span></div>`).join("")}
    </div>
    <div class="cc-der">
      <span>HP ${der.maxHp}</span><span>MP ${der.maxMp}</span><span>IP ${der.maxIp}</span>
      <span>DEF ${der.def}</span><span>M.DEF ${der.mdef}</span><span>Init ${der.init}</span>
    </div>`;
  return card(`Attributes — level ${draftLevel(d)}`, "attributes", body);
}

function classCard(d) {
  const levels = draftClassLevels(d);
  const keys = Object.keys(levels);
  if (!keys.length) return card("Classes & Skills", "classes", none("No classes chosen."));

  const BENEFIT = { hp: "+5 Max HP", mp: "+5 Max MP", ip: "+2 Max IP" };
  const body = keys.map((key) => {
    const rows = d.classes.filter((c) => c.classKey === key);
    const name = rows[0]?.className ?? key;
    const benefit = rows[0]?.benefit;
    // Skill levels within the class, in the order they were first taken.
    const skills = [];
    for (const r of rows) {
      const hit = skills.find((s) => s.uuid === r.skillUuid);
      if (hit) hit.n++;
      else skills.push({ uuid: r.skillUuid, name: r.skillName, n: 1 });
    }
    const facets = rows.flatMap((r) => r.facetUuids ?? []).length;
    return `
      <div class="cc-row" style="margin-top:6px">
        <strong style="color:#3a1e06">${esc(name)}</strong>
        <span class="r">level ${levels[key]}${benefit ? ` · ${esc(BENEFIT[benefit] ?? benefit)}` : ""}</span>
      </div>
      <div class="cc-sub">${skills.map((s) => `${esc(s.name)} ${s.n}`).join(" · ")}${
        facets ? ` · ${facets} learned` : ""}</div>`;
  }).join("");

  return card(`Classes & Skills — ${draftPointPool(d)} points`, "classes", body, true);
}

function equipmentCard(d) {
  const list = equipPicks(d);
  const martial = draftMartial(d, resolveClass);
  const left = draftBudgetLeft(d);
  const body = list.length
    ? `<div class="cc-rows">${list.map((p) => {
        const need = martialNeed(p);
        const untrained = need && !martial[need];
        return `<div class="cc-row">
          <img src="${esc(p.img || CC.DEFAULT_IMG)}" alt="">
          <span>${esc(p.name)}${untrained ? ` <span class="cc-tag">untrained</span>` : ""}</span>
          <span class="r">${p.cost ? `${p.cost}z` : "free"}</span>
        </div>`;
      }).join("")}</div>
      <div class="cc-der" style="margin-top:8px">
        <span>${draftSpend(d)} of ${draftBudget(d)} zenit spent</span>
        <span>${left < 0 ? `${Math.abs(left)} over` : `${left} carried over`}</span>
      </div>`
    : `${none("Nothing bought.")}
       <div class="cc-der" style="margin-top:8px"><span>${draftBudget(d)} zenit carried over</span></div>`;
  return card("Starting Equipment", "equipment", body, true);
}

function bondCard(d) {
  if (bondIsEmpty(d)) return card("Initial Bond", "bond", none("No starting bond."));
  const chosen = chosenEmotion(d);
  const pair = CC_EMOTION_PAIRS.find((p) => p.key === chosen?.key);
  const body = `
    <div class="cc-rows">
      <div class="cc-row"><span>Toward</span><span class="r">${esc(d.bond.name || "—")}</span></div>
      <div class="cc-row"><span>Emotion</span><span class="r">${
        chosen ? `${esc(chosen.value)}${pair ? ` (${chosen.value === pair.pos ? "positive" : "negative"})` : ""}` : "—"
      }</span></div>
      ${String(d.bond.rel ?? "").trim()
        ? `<div class="cc-row"><span>Relationship</span><span class="r">${esc(d.bond.rel)}</span></div>` : ""}
    </div>`;
  return card("Initial Bond", "bond", body);
}

function render(d) {
  const p = d.profile;
  const { issues } = validateAll(d);
  const notes = advisories(d, draftMartial(d, resolveClass));
  const folder = previewFolder();

  return `
    <style>${CSS}</style>
    <div class="cc-sm">
      <div class="cc-sm-id">
        <img class="cc-sm-port" src="${esc(p.img || CC.DEFAULT_IMG)}" alt="">
        <div>
          <div class="cc-sm-name">${esc(p.name || "Unnamed")}</div>
          <div class="cc-sm-sub">Level ${draftLevel(d)}</div>
        </div>
        <div class="cc-sm-dest">
          Will be created in <strong>Actors ▸ ${esc(CC.PC_ROOT_FOLDER)} ▸ ${esc(folder.name)}</strong>,
          owned by you.${folder.exists ? "" : " That folder does not exist yet and will be made."}
        </div>
      </div>

      <div class="cc-sm-cols">
        ${profileCard(d)}
        ${attributeCard(d)}
        ${classCard(d)}
        ${equipmentCard(d)}
        ${bondCard(d)}
      </div>
    </div>

    ${issues.length ? `
      <div class="cc-issues">
        <div class="cc-issues-h">${issues.length} thing${issues.length === 1 ? "" : "s"} left to settle</div>
        ${issues.map((i) => `<div class="cc-issue">
          <span>${esc(i.message)}</span>
          <span class="cc-issue-step">${esc(i.step)}</span>
        </div>`).join("")}
      </div>` : `
      <div class="cc-ready">
        Ready. Creating the character writes the Actor, spends every Skill Point through the
        level-up system, grants the equipment and sets the bond.
        ${notes.length ? `<br><br>${notes.map(esc).join("<br>")}` : ""}
      </div>`}`;
}

// Nothing on this page is interactive; Create lives in the shell footer.
function bind() {}

STEP_RENDERERS.set("summary", { render, bind });
