// scripts/linked-text/lt-terms.js
// Answers "what does this link point at?" for every linked term in item text.
//
// Keywords, statuses and damage types come from the static keyword registry
// (battle-director/keyword-registry.js) — the same list the Action Card and the
// editor suggestion box read, so a term has one name, icon and rules text
// everywhere. Skills, spells and items come from the live world.
//
// A resolved term is a plain object:
//   { kind, uuid, name, label, img, fa, color, glow, descHtml?, entry?, doc?, missing? }
// kind ∈ dmg | status | kw | skill | spell | passive | item | actor | doc

import { lookupTerm } from "../battle-director/keyword-registry.js";

// Damage types always use the party menu's element icons (party-menu-view-gear.js
// ELEMENT_ICON) and the shop's element colours (shopWindow-app.js DAMAGE_TYPES).
export const DAMAGE = Object.freeze({
  physical: { fa: "fa-hand-fist",         color: "#555555", glow: "#999999" },
  air:      { fa: "fa-wind",              color: "#48c774", glow: "#a8ffbb" },
  bolt:     { fa: "fa-bolt",              color: "#9b59b6", glow: "#d7a9ff" },
  dark:     { fa: "fa-moon",              color: "#4b0082", glow: "#b666d2" },
  earth:    { fa: "fa-mountain",          color: "#8b5e3c", glow: "#d2b48c" },
  fire:     { fa: "fa-fire",              color: "#e25822", glow: "#ffae00" },
  ice:      { fa: "fa-snowflake",         color: "#5ab3d4", glow: "#a6e3ff" },
  light:    { fa: "fa-sun",               color: "#a38b50", glow: "#cabd9a" },
  poison:   { fa: "fa-skull-crossbones",  color: "#2e8b57", glow: "#66ff99" },
});

// Same colours as the Treasure Roulette's item names.
export const RARITY_COLOR = Object.freeze({
  common: "#1b1b1b", uncommon: "#1f6fb2", rare: "#b8860b", legendary: "#7a3fb5",
});

// Fallback icon when a document has no image of its own.
export const KIND_FA = Object.freeze({
  skill: "fa-burst", spell: "fa-wand-sparkles", passive: "fa-shield-halved",
  item: "fa-flask", status: "fa-circle-down", actor: "fa-user", doc: "fa-book-open",
});
const ITEM_FA = Object.freeze({
  weapon: "fa-khanda", armor: "fa-shirt", shield: "fa-shield-halved", accessory: "fa-ring",
  consumable: "fa-flask", material: "fa-cubes", recipe: "fa-scroll", key: "fa-key",
});

export const REF_KINDS = new Set(["skill", "spell", "passive", "item"]);

const GENERIC_IMG = /^icons\/svg\/|mystery-man|item-bag\.svg$/;
const usableImg = (src) => (src && !GENERIC_IMG.test(String(src)) ? String(src) : null);

// ── Registry terms ────────────────────────────────────────────────────────────

function fromRegistry(entry, label) {
  if (!entry || entry.category === "actionType") return null;
  const kind = entry.category === "damage" ? "dmg" : entry.category === "status" ? "status" : "kw";
  const dmg = kind === "dmg" ? DAMAGE[entry.label.toLowerCase()] : null;
  return {
    kind, uuid: entry.key, name: entry.label, label: label || entry.label,
    img: kind === "dmg" ? null : usableImg(entry.icon),
    fa: dmg?.fa ?? null, color: dmg?.color ?? null, glow: dmg?.glow ?? null,
    descHtml: entry.descHtml || "", entry,
  };
}

// ── World documents ───────────────────────────────────────────────────────────

export function itemKind(doc) {
  const p = doc?.system?.props ?? {};
  if (p.item_type) return "item";
  const st = String(p.skill_type ?? "").toLowerCase();
  if (st === "spell") return "spell";
  if (st === "passive") return "passive";
  if (st === "item") return "item";
  return "skill";
}

function fromItem(doc, label) {
  const p = doc.system?.props ?? {};
  const kind = itemKind(doc);
  const dmg = DAMAGE[String(p.type_damage ?? "").toLowerCase()];
  const color = kind === "item"
    ? (RARITY_COLOR[String(p.item_rarity ?? "").toLowerCase()] ?? null)
    : (dmg?.color ?? null);
  return {
    kind, uuid: doc.uuid, name: doc.name, label: label || doc.name,
    img: usableImg(doc.img),
    fa: kind === "item" ? (ITEM_FA[p.item_type] ?? KIND_FA.item) : KIND_FA[kind],
    color, glow: null, doc,
  };
}

function fromDoc(doc, label) {
  if (doc.documentName === "Item") return fromItem(doc, label);
  if (doc.documentName === "Actor") {
    return { kind: "actor", uuid: doc.uuid, name: doc.name, label: label || doc.name,
      img: usableImg(doc.prototypeToken?.texture?.src) ?? usableImg(doc.img), fa: KIND_FA.actor, doc };
  }
  return { kind: "doc", uuid: doc.uuid, name: doc.name, label: label || doc.name,
    img: usableImg(doc.img ?? doc.icon), fa: KIND_FA.doc, doc };
}

// Players cannot read world items they have no permission on (about a fifth of
// the world). Fall back to a copy the viewer owns — an item on one of their
// actors with the same id or name — so the link still shows its icon and card.
function findItem(idOrName) {
  const ref = String(idOrName ?? "").trim();
  if (!ref) return null;
  const id = ref.replace(/^Item\./, "");
  let doc = game.items?.get(id) ?? game.items?.getName?.(ref) ?? null;
  if (doc) return doc;
  for (const actor of game.actors ?? []) {
    if (!actor.isOwner) continue;
    doc = actor.items.get(id) ?? actor.items.getName(ref);
    if (doc) return doc;
  }
  return null;
}

function syncDoc(uuid) {
  try { return fromUuidSync(uuid) ?? null; } catch { return null; }
}

// ── Search (editor suggestion box) ────────────────────────────────────────────

/**
 * Skills, spells and items whose name matches `query`, for the `@` trigger in
 * the editor suggestion box. Prefix matches rank first, then substrings.
 * Templates, effect containers and the damage-type items (the registry already
 * offers those as damage types) are left out.
 * @returns {{ uuid, name, kind, img, fa, folder }[]}
 */
export function searchItems(query, limit = 8) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q.length < 2) return [];
  const scored = [];
  for (const doc of game.items ?? []) {
    if (doc.type !== "equippableItem") continue;
    // CSB keeps internal copies of embedded items in its own folder.
    if (/^CSB - Embedded Items/i.test(doc.folder?.name ?? "")) continue;
    const name = String(doc.name ?? "");
    const n = name.toLowerCase();
    if (DAMAGE[n]) continue;
    const score = n === q ? 100 : n.startsWith(q) ? 80 : n.includes(q) ? 40 : 0;
    if (!score) continue;
    scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.name.length - b.doc.name.length || a.doc.name.localeCompare(b.doc.name));
  return scored.slice(0, limit).map(({ doc }) => {
    const t = fromItem(doc, "");
    return { uuid: doc.uuid, name: doc.name, kind: t.kind, img: t.img, fa: t.fa, folder: doc.folder?.name ?? "" };
  });
}

// ── Public resolvers ──────────────────────────────────────────────────────────

/**
 * Resolve an existing link by its document uuid. `text` is the link's own label
 * ("Ice Shield" shares the base Shield uuid; "Pillage" links Thievery) and wins
 * as the displayed label.
 */
export function resolveUuid(uuid, text = "") {
  if (!uuid) return null;
  const label = String(text ?? "").trim();
  const byName = label ? lookupTerm(label) : null;
  const entry = byName && byName.key === uuid ? byName : lookupTerm(uuid);
  const reg = fromRegistry(entry, label);
  if (reg) return reg;
  const doc = syncDoc(uuid) ?? (/^Item\./.test(uuid) ? findItem(label) : null);
  if (doc) return fromDoc(doc, label);
  return null;
}

/**
 * Resolve a short tag: @Dmg[Fire], @Status[Burn], @Kw[Crisis] by name;
 * @Skill[id]{Name}, @Spell[id]{Name}, @Item[id]{Name} by id (or name).
 */
export function resolveTag(tag, ref, label = "") {
  const t = String(tag ?? "").toLowerCase();
  const r = String(ref ?? "").trim();
  const lbl = String(label ?? "").trim();
  if (t === "dmg" || t === "status" || t === "kw") {
    // The tag type is a hint, not a filter: the registry files some terms
    // differently than authors expect (Crisis is a status there), and the link
    // should still work. The term's own category decides how it looks.
    return fromRegistry(lookupTerm(r), lbl);
  }
  if (t === "skill" || t === "spell" || t === "item") {
    const doc = findItem(r) ?? (lbl ? findItem(lbl) : null);
    if (doc) return fromItem(doc, lbl);
    // Known kind, document not visible to this viewer: keep the label.
    return { kind: t, uuid: null, name: lbl || r, label: lbl || r, img: null,
      fa: KIND_FA[t] ?? KIND_FA.item, missing: true };
  }
  return null;
}
