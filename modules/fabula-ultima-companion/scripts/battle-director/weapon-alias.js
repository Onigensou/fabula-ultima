// [ONI] Weapon category ALIAS — "treat those weapons as also <categories>" (Blade Adept, 2026-11-22).
// ---------------------------------------------------------------------------
// An AE change `weapon_category_alias` on the bearer, value "<source>: <cat>, <cat>; <source>: …":
//   source = a weapon category ("dagger") or range + category ("melee_dagger")
//   cats   = the categories such a weapon ALSO counts as, for skills and effects
// Blade Adept: "melee_dagger: brawling, sword, thrown".
// Honoured by HAS_WEAPON_CATEGORY_<X> / USED_WEAPON_CATEGORY_IS_<X> (skill-formulas.js), the melee-vs-Flying exception
// (snapshot.js attackerCanMeleeFlying) and the equipment AE gate aeEquippedWhen (syntaxExtender-conditionalChangeGate.js,
// a classic script: it carries its own copy of parseAliases — keep the two in step).
// A GEAR carrier only counts while equipped (same rule as counts_as_weapon_category). Pure apart from reading the actor.

const KEY = "weapon_category_alias";

export function parseAliases(value) {
  const out = [];
  for (const part of String(value ?? "").split(";")) {
    const i = part.indexOf(":"); if (i < 0) continue;
    const source = part.slice(0, i).trim().toLowerCase().replace(/\s+/g, "_");
    const cats = part.slice(i + 1).split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (source && cats.length) out.push({ source, cats });
  }
  return out;
}

const GEAR = new Set(["accessory", "armor", "weapon", "shield"]);
function liveAliasChanges(actor) {
  const out = [];
  const effs = actor?.appliedEffects ?? actor?.effects?.contents ?? [];
  for (const ae of effs) {
    if (!ae || ae.disabled) continue;
    const item = ae.parent?.documentName === "Item" ? ae.parent : null;
    const itype = String(item?.system?.props?.item_type ?? "").toLowerCase();
    if (GEAR.has(itype) && item?.system?.props?.isEquipped !== true) continue;
    for (const ch of ae.changes ?? []) if (ch?.key === KEY) out.push(...parseAliases(ch.value));
  }
  return out;
}

// the extra categories a weapon of `family` (with `range`) counts as for this actor
export function aliasCategories(actor, family, range = "") {
  const fam = String(family ?? "").trim().toLowerCase(), rng = String(range ?? "").trim().toLowerCase();
  if (!fam) return [];
  const extra = new Set();
  for (const a of liveAliasChanges(actor)) if (a.source === fam || (rng && a.source === rng + "_" + fam)) for (const c of a.cats) extra.add(c);
  return [...extra];
}
