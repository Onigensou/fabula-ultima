// scripts/linked-text/lt-itemcard.js
// The one item card every player-facing view draws: the hover card, the pinned
// Item Window, and the small link panel. Players never see a Foundry item sheet;
// this card is how an item reads in game.
//
//   header   icon · name in rarity/element colour · type line · Zenit price
//   grid     the item's data (Accuracy / Damage / DEF …), with ▲▼ when comparing
//   effect   the description, linked text
//   skills   granted skills as small cards (for gear)
//   set      tier rows lit by the owner's equipped pieces (projected when comparing)
//   flavor   last
//
// Compare helpers live here too: which equipped item an item would replace, and
// the notes numbers cannot show (set breaks, two-handed swaps, damage type).

import { resolveUuid, DAMAGE } from "./lt-terms.js";
import { renderLinkedText, safeHtml, minimalLinkHTML } from "./lt-render.js";
import { setBonusHTML, parseSetTiers, equippedPieceNames } from "./lt-setbonus.js";

const ZENIT_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/GP.png";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const cap = (s) => String(s ?? "").replace(/^\w/, (c) => c.toUpperCase());
const numOf = (v) => { const n = Number(String(v ?? "").replace(/^\+/, "")); return Number.isFinite(n) ? n : 0; };

export const DAMAGE_DESC = "<p>Elemental damage. Each creature has an affinity to it: <strong>Vulnerable</strong> takes double, "
  + "<strong>Resistant</strong> takes half, <strong>Immune</strong> takes none, and <strong>Absorb</strong> heals instead.</p>";

// ── What a term says ──────────────────────────────────────────────────────────

export function subtitle(term) {
  const p = term.doc?.system?.props ?? {};
  switch (term.kind) {
    case "dmg": return "Damage type";
    case "status": return "Status";
    case "kw": return term.entry?.category === "equipment" ? "Equipment keyword" : "Keyword";
    case "skill": case "spell": case "passive":
      return [{ skill: "Skill", spell: "Spell", passive: "Passive" }[term.kind], p.class, p.cost].filter(Boolean).join(" · ");
    case "item":
      return [p.item_rarity, cap(p.item_type), p.category, p.item_type === "weapon" ? p.hand_slots : ""].filter(Boolean).join(" · ");
    case "actor": return "Companion";
    default: return "";
  }
}

/** Numbers an item brings, for display and comparison. */
export function itemNumbers(doc) {
  const p = doc?.system?.props ?? {};
  const t = p.item_type;
  const martialArmor = p.isMartial && t === "armor";
  return {
    dmg: t === "weapon" ? numOf(p.damage_bonus) : undefined,
    acc: t === "weapon" ? numOf(p.check_bonus) : undefined,
    def: t === "armor" || t === "shield" ? (martialArmor ? numOf(p.item_baseDef) : numOf(p.item_def_bonus)) : undefined,
    mdef: t === "armor" || t === "shield" ? (martialArmor ? numOf(p.item_baseMdef) : numOf(p.item_mdef_bonus)) : undefined,
  };
}

const check = (p) => (p.rolled_atr1 && p.rolled_atr2 ? `<strong>【${esc(p.rolled_atr1)} + ${esc(p.rolled_atr2)}】</strong>` : "");
export const dmgText = (type) => {
  const d = DAMAGE[String(type ?? "").toLowerCase()];
  return d ? ` <span class="fu-lt-dmgtxt" style="--fu-lt-c:${d.color};--fu-lt-glow:${d.glow}"><i class="fa-solid ${d.fa} fu-lt-fa"></i>${esc(cap(type))}</span>` : "";
};
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

/** Data grid rows [label, html, numberKey], in reading order. */
export function gridRows(term) {
  const p = term.doc?.system?.props ?? {};
  if (term.kind === "skill" || term.kind === "spell" || term.kind === "passive") {
    const vs = { def: "Defense", mdef: "Magic Defense" }[p.defense_target_type];
    return [
      ["Cost", esc(p.cost)], ["Target", esc(p.skill_target)], ["Range", esc(p.skill_range)],
      ["Duration", esc(p.duration)], ["Check", check(p)], ["vs", check(p) && vs ? vs : ""],
    ];
  }
  if (term.kind === "item") {
    const n = itemNumbers(term.doc);
    if (p.item_type === "weapon") {
      const acc = check(p) + (n.acc ? ` ${signed(n.acc)}` : "");
      return [["Accuracy", acc, "acc"], ["Damage", `<strong>【HR + ${n.dmg}】</strong>${dmgText(p.type_damage)}`, "dmg"],
        ["Range", esc(p.weapon_range)], ["Hands", esc(p.hand_slots)]];
    }
    if (p.item_type === "armor" || p.item_type === "shield") {
      return [["DEF", signed(n.def), "def"], ["M.DEF", signed(n.mdef), "mdef"]];
    }
  }
  return [];
}

export function descriptionOf(term) {
  if (term.kind === "dmg") return DAMAGE_DESC;
  if (term.descHtml) return term.descHtml;
  const p = term.doc?.system?.props ?? {};
  return p.description || p.consumable_description || p.skill_description || "";
}

export function flavorOf(term) {
  const p = term.doc?.system?.props ?? {};
  return p.flavor_text || p.consumable_flavor || "";
}

export function badgeHTML(term) {
  if (term.img) return `<img class="fu-ltc-badge" src="${esc(term.img)}" alt="">`;
  const c = term.kind === "status" ? "#9b3a24" : term.color || "#7a4e20";
  if (term.kind === "kw") return `<div class="fu-ltc-badge is-kw" aria-hidden="true"><i></i></div>`;
  return `<div class="fu-ltc-badge" style="--fu-lt-c:${c}" aria-hidden="true"><i class="fa-solid ${esc(term.fa || "fa-link")}"></i></div>`;
}

export function priceHTML(term) {
  const cost = Number(term.doc?.system?.props?.item_cost);
  if (term.kind !== "item" || !cost) return "";
  return `<div class="fu-ltc-price" title="Value"><img src="${ZENIT_ICON}" alt="Zenit">${cost.toLocaleString()}</div>`;
}

// Skills a piece of gear grants (CSB item container), as small cards.
function grantedSkillsHTML(term) {
  const p = term.doc?.system?.props ?? {};
  if (term.kind !== "item") return "";
  const seen = new Set();
  const rows = [];
  for (const s of Object.values(p.item_skill_active ?? {})) {
    if (!s?.name || seen.has(s.name)) continue;
    seen.add(s.name);
    const uuid = String(s.uuid ?? "");
    const link = uuid ? renderLinkedText(minimalLinkHTML(uuid, s.name)) : `<strong>${esc(s.name)}</strong>`;
    const cost = String(s.skill_cost ?? "").trim();
    const desc = s.skill_description ? renderLinkedText(safeHtml(s.skill_description)) : "";
    rows.push(`<div class="fu-iw-mini"><div class="fu-iw-mini-head">${link}${cost ? `<span class="fu-ltc-pill">${esc(cost)}</span>` : ""}</div>${desc ? `<div class="fu-iw-mini-body">${desc}</div>` : ""}</div>`);
  }
  return rows.length ? `<div class="fu-ltc-label">Grants</div>${rows.join("")}` : "";
}

/**
 * The full card for a resolved term.
 * @param {object} term     from resolveUuid
 * @param {object} [opts]
 * @param {Item}   [opts.vs]       equipped item to compare against (▲▼ on the grid, set projection)
 * @param {Actor}  [opts.actor]    whose equipped pieces light the set rows
 * @param {boolean}[opts.compact]  equipped column: no skills / set / flavor
 */
export function cardHTML(term, { vs = null, actor, compact = false } = {}) {
  const other = vs ? itemNumbers(vs) : null;
  const mine = term.kind === "item" ? itemNumbers(term.doc) : null;
  const rows = gridRows(term).filter(([, v]) => v);
  const delta = (key) => {
    if (!other || !mine || !key || mine[key] === undefined) return "";
    const d = mine[key] - (other[key] ?? 0);
    return d ? `<span class="fu-iw-dlt ${d > 0 ? "is-up" : "is-down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : "";
  };
  const grid = rows.length
    ? `<div class="fu-ltc-grid">${rows.map(([k, v, key]) => `<div><span>${esc(k)}</span>${v}${delta(key)}</div>`).join("")}</div>`
    : "";
  const desc = descriptionOf(term);
  const body = desc
    ? `<div class="fu-ltc-body">${renderLinkedText(safeHtml(desc))}</div>`
    : (term.missing ? `<div class="fu-ltc-body fu-ltc-muted">No details available.</div>` : "");
  const set = !compact && term.kind === "item" && term.doc ? setBonusHTML(term.doc, { actor, project: !!vs }) : "";
  const flavor = compact ? "" : flavorOf(term);
  return `<div class="fu-iw-card">
    <div class="fu-ltc-head">${badgeHTML(term)}
      <div class="fu-ltc-title"><div class="fu-ltc-name" style="${term.color ? `--fu-lt-c:${term.color}` : ""}">${esc(term.name)}</div><div class="fu-ltc-sub">${esc(subtitle(term))}</div></div>
      ${priceHTML(term)}
    </div>
    ${grid}${body}
    ${compact ? "" : grantedSkillsHTML(term)}
    ${set ? `<div class="fu-ltc-label">Set bonus</div>${safeHtml(set)}` : ""}
    ${flavor ? `<div class="fu-ltc-flavor">${safeHtml(flavor)}</div>` : ""}
  </div>`;
}

// ── Compare ───────────────────────────────────────────────────────────────────

const SLOTS = new Set(["weapon", "shield", "armor", "accessory"]);

/** The character whose gear an item is compared with: its owner, else the viewer's own character. */
export function compareActor(doc) {
  const owner = doc?.parent?.documentName === "Actor" ? doc.parent : null;
  return owner ?? game.user?.character ?? null;
}

/** Equipped items in the same slot (accessories can be two). Empty when the item is itself worn. */
export function equippedFor(doc, actor) {
  const p = doc?.system?.props ?? {};
  if (!actor || !SLOTS.has(p.item_type) || p.isEquipped) return [];
  return actor.items.filter((it) => it.id !== doc.id && it.system?.props?.isEquipped && it.system.props.item_type === p.item_type);
}

/** What the numbers cannot say: damage type, two-handed swaps, broken set tiers. */
export function swapNotesHTML(doc, vs, actor) {
  const a = doc.system?.props ?? {}, b = vs.system?.props ?? {};
  const rows = [];
  if (a.item_type === "weapon" && a.type_damage && b.type_damage && a.type_damage !== b.type_damage) {
    rows.push(`<div class="fu-iw-note"><span>Damage type</span><span>${dmgText(b.type_damage)} →${dmgText(a.type_damage)}</span></div>`);
  }
  if (a.item_type === "weapon" && /two/i.test(a.hand_slots ?? "")) {
    const offhand = actor?.items.find((it) => it.system?.props?.isEquipped && it.system.props.item_type === "shield");
    if (offhand) rows.push(`<div class="fu-iw-note is-warn"><span>Two-handed</span><span>also unequips ${esc(offhand.name)}</span></div>`);
  }
  const vsSet = String(b.set_name ?? "").trim();
  if (b.isSet && vsSet && vsSet !== "<Set Name>" && vsSet !== String(a.set_name ?? "").trim() && actor) {
    const worn = equippedPieceNames(actor, vsSet).size;
    const tiers = parseSetTiers(renderLinkedText(b.set_description ?? ""))?.tiers ?? [];
    for (const t of tiers.filter((t) => worn >= t.pieces && worn - 1 < t.pieces)) {
      rows.push(`<div class="fu-iw-note is-warn"><span>Breaks ${esc(vsSet)} ${t.pieces}-Piece</span><span>${t.html}</span></div>`);
    }
  }
  if (!rows.length) return "";
  return `<div class="fu-iw-notes"><div class="fu-ltc-label">Equipping this instead of ${esc(vs.name)}</div>${rows.join("")}</div>`;
}

/** Everything a compare view needs, or null when there is nothing worn to compare with. */
export function compareFor(doc) {
  const actor = compareActor(doc);
  const worn = equippedFor(doc, actor);
  if (!worn.length) return null;
  return {
    actor,
    vs: worn[0],
    left: worn.map((w) => `<div class="fu-iw-col"><span class="fu-iw-tag is-eq">Equipped</span>${cardHTML(resolveUuid(w.uuid, w.name), { compact: true, actor })}</div>`).join(""),
    notes: worn.map((w) => swapNotesHTML(doc, w, actor)).join(""),
  };
}
