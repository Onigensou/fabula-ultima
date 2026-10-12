// Party Menu — the Status view's Active Effect list (data layer).
//
// Three things the raw `actor.appliedEffects` list does not tell a player:
//   - WHERE an effect comes from. Gear and passive skills keep their effects on
//     the item (v12 transfer), so most carry no description of their own; the
//     source item's description stands in.
//   - HOW MUCH it does. Amounts are read by DRY-APPLYING each change through the
//     effect's own (CSB + syntax-extender + conditional-gate patched) `apply()`
//     onto a throwaway copy of the actor, so this can never disagree with what
//     the game applies. Before each change its target key is reset to a neutral
//     value (0 for add, 1 for multiply, ±∞ for upgrade/downgrade), so the result
//     IS the change's own value rather than the post-effect total. Override and
//     custom keys keep their current value: Foundry casts the change to the
//     key's type, and a numeric placeholder turned "RS" into NaN.
//   - HOW LONG it lasts. AELifetime.describe (shared/ae-lifetime.js) — the same
//     markers the rest / scene-sweep / turn-tick machinery acts on.
//
// Same-named effects in the same lifetime group merge into one row (three DEF UP
// from three pieces of gear → "DEF UP +7" with a per-source breakdown). A source
// whose every change is a numeric no-op (the gear template stamps DEF UP and
// MDEF UP on every equippable, worth +0 on most) is inactive: it drops out of the
// row's total and breakdown, and a row with no active source is listed last.

import { MODULE_ID } from "./party-menu-core.js";
import { itemType } from "./party-menu-inventory.js";

const NS = MODULE_ID;
const GEAR_TEMPLATE = "ZoiV53VaLzeRsEps";
const GEAR_TYPES = new Set(["weapon", "armor", "shield", "accessory"]);
const MODES = CONST.ACTIVE_EFFECT_MODES;

const str = (v) => String(v ?? "").trim();
// Authored text only: an empty editor leaves "<p></p>", which is not a description.
const textOf = (html) => (str(html).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim() ? str(html) : "");
const ELEMENTS = ["Physical", "Air", "Bolt", "Dark", "Earth", "Fire", "Ice", "Light", "Poison"];
const AFFINITY = { RS: "Resistant", VU: "Vulnerable", IM: "Immune", AB: "Absorbs", NA: "Normal" };

const KEY_LABEL = {
  bonus_defense: "DEF", bonus_magic_defense: "M.DEF", defense: "DEF", magic_defense: "M.DEF",
  base_defense: "Base DEF", base_magic_defense: "Base M.DEF",
  override_defense: "DEF", override_magic_defense: "M.DEF",
  max_hp: "Max HP", max_mp: "Max MP", max_ip: "Max IP",
  dex_current: "DEX", ins_current: "INS", mig_current: "MIG", wlp_current: "WLP",
  bonus_dex: "DEX", bonus_ins: "INS", bonus_mig: "MIG", bonus_wlp: "WLP",
  override_dex: "DEX", override_ins: "INS", override_mig: "MIG", override_wlp: "WLP",
  check_mod_all: "All checks", check_mod_accuracy: "Accuracy", check_mod_magic: "Magic checks",
  check_mod_ranged: "Ranged checks", check_mod_dex: "DEX checks", bonus_check: "Checks",
  extra_damage_mod_all: "Damage", extra_damage_mod_item: "Item damage",
  item_restore_mod: "Item healing", ip_reduction_value: "IP cost", enmity: "Enmity",
  bonus_hp: "Bonus HP", bonus_mp: "Bonus MP", bonus_ip: "Bonus IP",
  override_attack_damage_type: "Attack damage type", override_damage_type: "Damage type",
  override_all_damage_type: "All damage type",
  cannot_target_uuids: "Can't target", must_include_applier: "Must include caster in",
  can_target_flying_with: "Hits flyers with",
};

const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const bareKey = (key) => String(key ?? "").replace(/^target\./, "").replace(/^system\.props\./, "").replace(/^props\./, "")
  .replace(`flags.${NS}.`, "");

export function keyLabel(key) {
  const k = bareKey(key);
  if (KEY_LABEL[k]) return KEY_LABEL[k];
  const aff = /^affinity_(\d)$/.exec(k);
  if (aff) return `${ELEMENTS[Number(aff[1]) - 1] ?? "?"} affinity`;
  const cond = /^condition_(\w+)$/.exec(k);
  if (cond) return cond[1][0].toUpperCase() + cond[1].slice(1);
  const dmg = /^extra_damage_mod_(\w+)$/.exec(k);
  if (dmg) return `${dmg[1][0].toUpperCase()}${dmg[1].slice(1)} damage`;
  const chk = /^check_mod_(\w+)$/.exec(k);
  if (chk) return `${["dex", "ins", "mig", "wlp"].includes(chk[1]) ? chk[1].toUpperCase() : chk[1][0].toUpperCase() + chk[1].slice(1)} checks`;
  const red = /^damage_receiving_mod_(\w+)$/.exec(k);
  if (red) return `${cap(red[1] === "range" ? "ranged" : red[1])} damage taken`;
  const taken = /^damage_taken_increased_(\w+)$/.exec(k);
  if (taken) return `${taken[1][0].toUpperCase()}${taken[1].slice(1)} damage taken`;
  const sl = /^skill_level_bonus_(\w+)$/.exec(k);
  if (sl) return `${sl[1].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} SL`;
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b(Hp|Mp|Ip|Def|Mdef|Sl|Dex|Ins|Mig|Wlp)\b/g, (w) => w.toUpperCase());
}

// ── presentation ──────────────────────────────────────────────────────────────
// Stat first, then the change ("DEF +7"), the way FF menus write it. The card
// gets the full line; the list gets a chip { k, v, bad, el, grade } short enough
// to sit beside the effect name: element-typed stats drop the element word for
// its icon, and affinities/immunities use the same RS/VU/IM/AB badge as the
// Affinities strip. `bad` marks a penalty (shown red).

const ELEMENT_KEYS = new Set(ELEMENTS.map((e) => e.toLowerCase()));
const CHIP_LABEL = {
  check_mod_all: "All checks", extra_damage_mod_all: "Damage", extra_damage_mod_item: "Item damage",
  item_restore_mod: "Item healing", ip_reduction_value: "IP cost", damage_receiving_mod_all: "Dmg taken",
  bonus_hp: "HP", bonus_mp: "MP", bonus_ip: "IP",
  override_attack_damage_type: "Attack type", override_damage_type: "Damage type", override_all_damage_type: "Damage type",
};

function elementOf(k) {
  const aff = /^affinity_(\d)$/.exec(k);
  if (aff) return ELEMENTS[Number(aff[1]) - 1]?.toLowerCase() ?? null;
  const m = /_([a-z]+)$/.exec(k);
  return m && ELEMENT_KEYS.has(m[1]) && /^(extra_damage_mod|damage_receiving_mod|damage_taken_increased)_/.test(k) ? m[1] : null;
}

function chipLabel(k, label) {
  if (/^affinity_\d$/.test(k)) return "";
  if (/^extra_damage_mod_/.test(k) && elementOf(k)) return "Damage";
  if (/^(damage_receiving_mod|damage_taken_increased)_/.test(k)) return "Dmg taken";
  return CHIP_LABEL[k] ?? label;
}

const fmtNum = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100));
const signed = (x) => `${x < 0 ? "−" : "+"}${fmtNum(Math.abs(x))}`;

/** { text, chip } for one change. `n` is the numeric value (or null), `shown` the display text otherwise. */
function present(key, mode, n, shown) {
  const k = bareKey(key);
  const label = keyLabel(key);
  const el = elementOf(k);
  const ck = chipLabel(k, label);
  const graded = /^(affinity_\d|condition_\w+)$/.test(k);
  // A reduction is shown as the minus it is ("Dmg taken −4", "IP cost −1"); for
  // these and for "damage taken increased" a bigger shown number is the bad one.
  const reduces = /^damage_receiving_mod_/.test(k) || k === "ip_reduction_value";
  const worse = /^damage_taken_increased_/.test(k);
  if (mode === MODES.ADD && n != null) {
    const v = reduces ? -n : n;
    const bad = reduces || worse ? v > 0 : v < 0;
    return { text: `${label} ${signed(v)}`, chip: { k: ck, v: signed(v), bad, el } };
  }
  if (mode === MODES.MULTIPLY && n != null) return { text: `${label} ×${fmtNum(n)}`, chip: { k: ck, v: `×${fmtNum(n)}`, el } };
  if (mode === MODES.UPGRADE && n != null) return { text: `${label} at least ${fmtNum(n)}`, chip: { k: ck, v: fmtNum(n), el } };
  if (mode === MODES.DOWNGRADE && n != null) return { text: `${label} at most ${fmtNum(n)}`, chip: { k: ck, v: `≤ ${fmtNum(n)}`, el } };
  if (graded) {
    const g = String(shown ?? "").toUpperCase();
    return { text: `${label}: ${AFFINITY[g] ?? g}`, chip: { k: el ? "" : label, grade: g, el, bad: g === "VU" } };
  }
  if (n != null) return { text: `${label} set to ${fmtNum(n)}`, chip: { k: ck, v: fmtNum(n), el } };
  const list = String(shown ?? "").split(",").map((x) => x.trim()).filter(Boolean).join(", ");
  return { text: `${label}: ${list}`, chip: { k: ck, v: list, el } };
}

// ── source ────────────────────────────────────────────────────────────────────

function itemKind(item) {
  if (str(item?.system?.template) !== GEAR_TEMPLATE) return "skill";
  return GEAR_TYPES.has(itemType(item)) ? "gear" : "item";
}

function safeUuid(uuid) {
  if (!uuid) return null;
  try { return fromUuidSync(uuid) ?? null; } catch { return null; }
}

/** The document an effect comes from: the hosting item, the skill that applied it, or its origin. */
function sourceOf(eff, actor) {
  const parent = eff.parent;
  if (parent?.documentName === "Item") return describeSource(parent, true);
  const by = eff.flags?.[NS]?.directorAppliedBy;
  const skill = safeUuid(by?.skillUuid);
  if (skill?.documentName === "Item") {
    const s = describeSource(skill, false);
    const caster = safeUuid(by?.reactorActorUuid);
    if (caster && caster.id !== actor.id) s.by = caster.name;
    return s;
  }
  const origin = safeUuid(eff.origin);
  if (origin?.documentName === "Item") return describeSource(origin, false);
  if (origin?.documentName === "Actor" && origin.id !== actor.id) return { name: origin.name, kind: "actor", description: "" };
  return null;
}

function describeSource(item, hosted) {
  return { name: item.name, kind: itemKind(item), description: textOf(item.system?.props?.description), hosted };
}

// ── amounts (dry apply) ───────────────────────────────────────────────────────

/** The placeholder a key holds during its dry run; `undefined` = keep the current value. */
function neutralFor(mode, current) {
  // A key the actor lacks stays absent: Foundry then takes the change's value as-is
  // (a UUID list stays a string). A text prop — including an empty one — gets "".
  if (mode === MODES.ADD) {
    if (current == null) return undefined;
    return typeof current === "string" && (current.trim() === "" || !Number.isFinite(Number(current))) ? "" : 0;
  }
  if (mode === MODES.MULTIPLY) return 1;
  if (mode === MODES.UPGRADE) return -Infinity;
  if (mode === MODES.DOWNGRADE) return Infinity;
  return undefined;
}

/**
 * CSB's own key resolution, step for step (CustomActiveEffect.apply): a key may
 * be a formula (`extra_damage_mod_${find(...)}$`) and a comma list; `target.` is
 * stripped; bare keys live under system.props; and when the actor has no such
 * prop CSB falls back to the ORIGINAL key, untrimmed and still `target.`-prefixed.
 */
function resolvedKeys(eff, sandbox, rawKey) {
  let keys = [String(rawKey ?? "")];
  if (keys[0].includes("${") && globalThis.ComputablePhrase && eff.parent?.system?.props) {
    try {
      const props = { ...eff.parent.system.props, target: sandbox.system.props };
      keys = String(ComputablePhrase.computeMessageStatic(keys[0], props, {
        source: `activeEffect.${eff.name}.key`, triggerEntity: eff.parent.templateSystem,
      }).result).split(",");
    } catch { /* leave the raw key: apply() will throw and the amount reads as unknown */ }
  }
  return keys.map((key) => {
    const k = key.startsWith("target.") ? key.slice(7) : key;
    const full = k.startsWith("props") ? `system.${k}` : k.startsWith("system") ? k : `system.props.${k}`;
    return foundry.utils.getProperty(sandbox, full) === undefined ? key : full;
  });
}

/**
 * A throwaway stand-in for the actor. CSB's actor `system` is a DataModel, and
 * foundry.utils.deepClone hands a non-plain object back UNCHANGED — cloning
 * `actor.system` would write straight into the live prepared actor. Only plain
 * props / flags are copied, and the stand-in's `system` is a plain object, which
 * also routes Foundry's apply() through its legacy (setProperty) path.
 */
function sandboxOf(actor) {
  return {
    id: actor.id, uuid: actor.uuid, name: actor.name, type: actor.type,
    schema: actor.schema,
    system: { props: foundry.utils.deepClone({ ...(actor.system?.props ?? {}) }) },
    flags: foundry.utils.deepClone({ ...(actor.flags ?? {}) }),
  };
}

/**
 * One change's own value per resolved key, read through the effect's real apply().
 * `ctx` = { actor, sb }: everything a change writes is undone before the next one
 * runs, so it can't skew a later formula. Flat props and the keys we set are put
 * back directly; a write that reaches anything else (a nested path, an object
 * value merged in place, a key we did not predict) throws the stand-in away and
 * the next change gets a fresh copy.
 */
function dryApply(eff, change, ctx) {
  const sb = ctx.sb;
  const keys = resolvedKeys(eff, sb, change.key);
  const propsBefore = { ...sb.system.props };
  const had = new Map(keys.map((k) => [k, foundry.utils.getProperty(sb, k)]));
  const neutral = new Map();
  for (const k of keys) {
    const n = neutralFor(change.mode, had.get(k));
    neutral.set(k, n);
    if (n !== undefined) foundry.utils.setProperty(sb, k, n);
  }
  const c = foundry.utils.deepClone(change);
  c.effect = eff;
  c.priority ??= c.mode * 10;
  let res = null;
  try { res = eff.apply(sb, c) ?? {}; } catch { res = null; }
  const out = keys.map((k) => {
    let value;
    if (res && k in res) value = res[k];
    // Custom mode is resolved by hooks; when none answers, the authored literal is what it means.
    else if (res && change.mode === MODES.CUSTOM && !/[$(]/.test(String(change.value ?? ""))) value = change.value;
    else if (res) value = foundry.utils.getProperty(sb, k);
    return { key: k, value, neutral: neutral.get(k), failed: !res };
  });
  const clean = Object.entries(res ?? {}).every(([k, v]) =>
    (v === null || typeof v !== "object") && (/^system\.props\.[^.]+$/.test(k) || had.has(k)));
  if (!clean || !res) { ctx.sb = sandboxOf(ctx.actor); return out; }
  sb.system.props = propsBefore;
  for (const k of keys) if (!k.startsWith("system.props.")) foundry.utils.setProperty(sb, k, had.get(k));
  return out;
}

/**
 * `aeAffinityStep(n)` moves an affinity n rungs from what the bearer has at that
 * point of the pass. A dry run can't reproduce "that point": the conditional gate
 * reads the LIVE actor (the stand-in is not an Actor document), whose affinity
 * already includes this very step, so it would be counted twice. The step itself
 * is what the player needs to know, so it is shown as one.
 */
function affinityStep(change) {
  if (change.mode !== MODES.OVERRIDE) return null;
  const m = /aeAffinityStep\s*\(\s*['"]?([-+]?\d+)['"]?\s*\)/i.exec(String(change.value ?? ""));
  return m ? Number(m[1]) : null;
}

/** UUIDs ("Actor.abc,Actor.def") read as names. */
function namesFor(raw) {
  const parts = String(raw).split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || !parts.every((x) => /^(Actor|Scene|Item|Compendium|Token)\./.test(x))) return null;
  return parts.map((u) => safeUuid(u)?.name ?? "someone").join(", ");
}

function amountsOf(eff, change, ctx) {
  const step = affinityStep(change);
  if (step != null) {
    const label = keyLabel(change.key);
    const el = elementOf(bareKey(change.key));
    const n = Math.abs(step);
    const word = step < 0 ? "weaker" : "stronger";
    return [{ key: change.key, label, mode: change.mode, active: step !== 0,
      text: `${label}: ${n} step${n === 1 ? "" : "s"} ${word}`,
      chip: { k: el ? "" : label, v: `${n} ${word}`, el, bad: step < 0 } }];
  }
  return dryApply(eff, change, ctx).map(({ key, value, neutral, failed }) => {
    const label = keyLabel(key);
    if (failed) return { key, label, mode: change.mode, text: `${label}: ?`, chip: { k: label, v: "?" }, active: true };
    const n = typeof value === "number" ? value : Number(value);
    const numeric = value !== "" && value != null && typeof value !== "boolean" && Number.isFinite(n);
    const shown = namesFor(value) ?? str(value);
    const base = { key, label, mode: change.mode };
    switch (change.mode) {
      case MODES.ADD:
        if (!numeric) return { ...base, ...present(key, change.mode, null, shown), active: value != null && str(value) !== "" && !Number.isNaN(value) };
        return { ...base, add: n, ...present(key, change.mode, n), active: n !== 0 };
      case MODES.MULTIPLY:
        return { ...base, ...present(key, change.mode, numeric ? n : null, str(value)), active: !(numeric && n === 1) };
      case MODES.UPGRADE: {
        // Raising a floor to 0 (or nothing) changes nothing: the gear template's
        // `isEquipped ? (isMartial ? base : 0) : 0`.
        const noop = !numeric || n === neutral || n <= 0;
        return { ...base, ...present(key, change.mode, numeric ? n : null, str(value)), active: !noop };
      }
      case MODES.DOWNGRADE: {
        // A cap of 0 is real (Geo Suits: M.DEF 0 while equipped); the "off" value
        // gated rows use is a huge one (`isEquipped ? 0 : 999`).
        const noop = !numeric || n === neutral || n >= 999;
        return { ...base, ...present(key, change.mode, numeric ? n : null, str(value)), active: !noop };
      }
      default: {
        const raw = str(value);
        // Affinity / condition keys take NA|RS|VU|IM|AB. Overriding one to NA is how
        // a gated row says "not now" (`isEquipped ? 'RS' : 'NA'`, aeWhen outside its
        // condition), so NA there is a no-op, not "set to Normal".
        const graded = /^(affinity_\d|condition_\w+)$/.test(bareKey(key));
        const noop = raw === "" || (numeric && n === 0) || (graded && raw === "NA");
        return { ...base, ...present(key, change.mode, graded || !numeric ? null : n, graded ? raw : shown), active: !noop };
      }
    }
  });
}

/** Test seam: the amounts one (possibly unsaved) effect contributes to `actor`. */
export function effectAmounts(eff, actor) {
  const ctx = { actor, sb: sandboxOf(actor) };
  return {
    amounts: (eff.changes ?? []).flatMap((ch) => amountsOf(eff, ch, ctx)),
    marker: isMarker(eff),
  };
}

// ── rows ──────────────────────────────────────────────────────────────────────

const _cache = new Map();   // actor.uuid → { sig, rows }

function isMarker(eff) {
  const f = eff.flags?.[NS] ?? {};
  const statuses = eff.statuses instanceof Set ? eff.statuses.size : (eff.statuses?.length ?? 0);
  return statuses > 0 || !!f.reactionConfig || f.charges != null;
}

function signature(actor, effects) {
  const t = (d) => d?._stats?.modifiedTime ?? 0;
  return [t(actor), ...effects.map((e) => `${e.uuid}:${t(e)}:${t(e.parent)}`)].join("|");
}

/**
 * The Status view's effect rows, in display order: temporary, then permanent,
 * then inactive. Each row: { key, name, img, temporary, inactive, sources[],
 * totals[] (summed adds per stat), chips[] (what the list shows beside the
 * name), short (duration or counter chip), lifetime }.
 */
export function effectRowsOf(actor) {
  if (!actor) return [];
  const effects = [...(actor.appliedEffects ?? [])].filter((e) => !e.disabled && !e.flags?.[NS]?.hidden);
  const sig = signature(actor, effects);
  const hit = _cache.get(actor.uuid);
  if (hit?.sig === sig) return hit.rows;

  const describe = globalThis.FUCompanion?.AELifetime?.describe;
  const ctx = { actor, sb: sandboxOf(actor) };
  const groups = new Map();
  for (const eff of effects) {
    const lifetime = describe?.(eff) ?? { temporary: false, kind: "unknown", label: "", short: "", counter: null };
    const amounts = (eff.changes ?? []).flatMap((ch) => amountsOf(eff, ch, ctx));
    const source = sourceOf(eff, actor);
    if (lifetime.kind === "item" && source?.kind === "gear") lifetime.label = `While ${source.name} is equipped`;
    else if (lifetime.kind === "item" && source?.kind === "skill") lifetime.label = `Passive from ${source.name}`;
    else if (lifetime.kind === "item" && source) lifetime.label = `While ${source.name} is carried`;
    const entry = {
      eff, id: eff.id, uuid: eff.uuid, lifetime, source, amounts,
      description: textOf(eff.description),
      // Markers work without changes — a status (Airborne), a reactionConfig, a
      // counter — so they are always active. Inactive = it has changes, none do
      // anything, and nothing else about it does either.
      active: !amounts.length || amounts.some((a) => a.active) || isMarker(eff),
    };
    const gkey = `${lifetime.temporary ? "t" : "p"}|${eff.name}`;
    if (!groups.has(gkey)) groups.set(gkey, { key: gkey, name: eff.name, img: eff.img || eff.icon || "icons/svg/aura.svg", temporary: lifetime.temporary, entries: [] });
    groups.get(gkey).entries.push(entry);
  }

  const rows = [...groups.values()].map((g) => {
    const live = g.entries.filter((e) => e.active);
    const sources = live.length ? live : g.entries;
    // Adds on the same stat sum (DEF UP ×3 → DEF +7); everything else is listed once.
    const sums = new Map();
    const others = new Map();
    for (const s of live) for (const a of s.amounts) {
      if (!a.active) continue;
      if (typeof a.add === "number") sums.set(a.key, (sums.get(a.key) ?? 0) + a.add);
      else if (!others.has(a.text)) others.set(a.text, a.chip);
    }
    const totalList = [...sums.entries()].map(([key, n]) => ({ key, n, ...present(key, MODES.ADD, n) }));
    const chips = [...totalList.map((t) => t.chip), ...others.values()].filter(Boolean);
    const first = sources[0];
    let lifetime = first.lifetime;
    if (sources.length > 1 && new Set(sources.map((s) => s.lifetime.label)).size > 1) {
      lifetime = { ...first.lifetime, label: sources.every((s) => s.source?.kind === "gear")
        ? "While the gear is equipped"
        : first.lifetime.kind === "item" ? "While its sources are held" : "Varies by source (see below)" };
    }
    return {
      key: g.key, name: g.name, img: g.img, temporary: g.temporary,
      inactive: live.length === 0,
      count: sources.length,
      sources,
      totals: totalList,
      chips,
      lifetime,
      short: g.temporary
        ? (new Set(sources.map((s) => s.lifetime.short)).size > 1 ? "Varies" : first.lifetime.short)
        : (first.lifetime.counter ?? ""),
      description: sources.map((s) => s.description).find(Boolean) ?? "",
    };
  });
  const rank = (r) => (r.inactive ? 2 : r.temporary ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b));   // stable: keeps appliedEffects order within a group
  _cache.set(actor.uuid, { sig, rows });
  return rows;
}
