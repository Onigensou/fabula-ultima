// Battle Inspect — the data behind one unit's card.
//
// Pure read: never writes. Everything a player may see about a creature comes
// through here, so the knowledge rules live in ONE place:
//
//   ally / party / companion   everything, live
//   enemy                      gated by the Monster Encyclopedia page of its
//                              PROTOTYPE (shared by every token of that creature):
//     Study 7+  Identity  level, rank, species, traits, DEF/M.DEF, HP/MP numbers
//     Study 8+  Stats     attribute dice
//     Study 13+ Details   every affinity, status immunities, inert passives
//     hit by X            that ONE element's affinity (learn-by-hitting)
//     witnessed           that action's name; a passive's effect row
//   GM                         sees everything; what players can't see is flagged
//                              `gmOnly` so the card can mark it.
//
// Effect rows reuse the Party Menu's effectRowsOf (dry-applied amounts, merged
// sources, AELifetime durations) and only regroup them for battle:
// Buffs / Debuffs / Counters on the Effects tab, always-on gear + passives on
// their own tab (allies) or behind the witness/Details gate (enemies).

import { effectRowsOf } from "../../party-menu/party-menu-effects.js";
import { readUnitInfo } from "../director-player-hud.js";
import { resolveAffinity } from "../snapshot.js";

const NS = "fabula-ultima-companion";
export const HP_RULE_SETTING = "unitInspectEnemyHp";

export const ELEMENTS = [
  ["physical", "Physical", "fa-hand-fist"], ["air", "Air", "fa-wind"], ["bolt", "Bolt", "fa-bolt"],
  ["dark", "Dark", "fa-moon"], ["earth", "Earth", "fa-mountain"], ["fire", "Fire", "fa-fire"],
  ["ice", "Ice", "fa-snowflake"], ["light", "Light", "fa-sun"], ["poison", "Poison", "fa-skull-crossbones"],
];
const ELEMENT_ICON = Object.fromEntries(ELEMENTS.map(([k, , i]) => [k, i]));
const GRADE_WORD = { VU: "Weak", RS: "Resist", IM: "Immune", AB: "Absorb" };
const GRADE_LONG = { VU: "vulnerable", RS: "resistant", IM: "immune", AB: "absorbs it", NA: "normal damage" };
const RAW_DEBUFFS = new Set(["weak", "dazed", "shaken", "slow", "enraged", "poisoned"]);
const ATTRS = [["MIG", "mig"], ["DEX", "dex"], ["INS", "ins"], ["WLP", "wlp"]];

const str = (v) => String(v ?? "").trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (v, m) => (m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0);
const plain = (html) => str(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

function encApi() { return globalThis.FUCompanion?.api?.encyclopedia ?? null; }

/** The world actor this token was made from: the key of its Encyclopedia page. */
export function prototypeUuidOf(token) {
  const doc = token?.document ?? token;
  const a = doc?.actor;
  if (a?.uuid?.startsWith?.("Actor.")) return a.uuid;
  const id = doc?._source?.actorId ?? doc?.actorId ?? null;
  return id ? `Actor.${id}` : null;
}

/** Enemy HP display rule (world setting): "identity" | "bar" | "crisis". */
export function enemyHpRule() {
  try { return game.settings.get(NS, HP_RULE_SETTING) || "identity"; } catch { return "identity"; }
}

// ── effect rows → battle groups ─────────────────────────────────────────────

function chipText(c) {
  if (!c) return "";
  if (c.grade) return `${c.el ? cap(c.el) : (c.k || "")} ${c.grade}`.trim();
  return `${c.k ?? ""} ${c.v ?? ""}`.trim();
}

function isCounter(row) {
  if (row.lifetime?.counter) return true;
  if (/tracker/i.test(row.lifetime?.label ?? "")) return true;
  return /^\d+\s*\/\s*\d+$|\buses?\b/i.test(str(row.short));
}

function isDebuff(row) {
  if ((row.chips ?? []).some((c) => c?.bad)) return true;
  const aem = globalThis.FUCompanion?.api?.activeEffectManager;
  for (const s of row.sources ?? []) {
    const eff = s.eff;
    if (!eff) continue;
    try { if (String(aem?.inferCategory?.(eff) ?? "").toLowerCase() === "debuff") return true; } catch { /* */ }
    if (String(eff.flags?.[NS]?.category ?? "").toLowerCase() === "debuff") return true;
    const tags = eff.system?.tags;
    if (Array.isArray(tags) && tags.map((t) => String(t).toLowerCase()).includes("debuff")) return true;
    for (const st of eff.statuses ?? []) if (RAW_DEBUFFS.has(String(st).toLowerCase())) return true;
  }
  return false;
}

/** "buffs" | "debuffs" | "other" (counters & neutral timed) | "passive" (always-on). */
function groupOf(row) {
  if (row.inactive) return "passive";
  if (isDebuff(row)) return "debuffs";
  if (isCounter(row)) return "other";
  return row.temporary ? "buffs" : "passive";
}

/** Item ids behind a row (the item it lives on, or the skill that applied it). */
function sourceItemIds(row) {
  const ids = new Set();
  for (const s of row.sources ?? []) {
    const eff = s.eff;
    if (eff?.parent?.documentName === "Item") ids.add(eff.parent.id);
    const by = eff?.flags?.[NS]?.directorAppliedBy?.skillUuid;
    if (by) ids.add(String(by).split(".").pop());
  }
  return ids;
}

function rowView(row, group, gmOnly) {
  const chips = (row.chips ?? []).map(chipText).filter(Boolean);
  let chip = "";
  let tone = "neutral";
  if (group === "other") chip = str(row.lifetime?.counter) || str(row.short);
  else if (chips.length) chip = chips[0] + (chips.length > 1 ? ` +${chips.length - 1}` : "");
  else if (row.temporary) chip = str(row.short);
  if (group === "debuffs") tone = "bad";
  else if (group === "buffs" || (group === "passive" && chips.length && !(row.chips ?? []).some((c) => c?.bad))) tone = "good";
  const firstChip = (row.chips ?? [])[0];
  return {
    name: row.name, img: row.img, chip, tone,
    chipEl: firstChip?.el && ELEMENT_ICON[firstChip.el] ? ELEMENT_ICON[firstChip.el] : null,
    life: row.inactive ? "Inactive right now" : str(row.lifetime?.label),
    title: [row.name, chips.join(" · "), str(row.lifetime?.label), plain(row.description)].filter(Boolean).join("\n"),
    count: row.count > 1 ? row.count : 0,
    inactive: !!row.inactive, gmOnly: !!gmOnly,
  };
}

// ── vitals ──────────────────────────────────────────────────────────────────

function vitalsOf(actor, { exact = true, showMp = true, crisisOnly = false, isPc = false, showZp = true }) {
  const info = readUnitInfo(actor) ?? {};
  const rows = [];
  const hp = info.hp;
  const crisis = !!hp && hp.v <= hp.m / 2;
  if (hp && !crisisOnly) {
    rows.push({ k: "HP", kind: "bar", pct: pct(hp.v, hp.m), cls: hp.v <= 0 ? "is-ko" : crisis ? "is-crisis" : "is-hp", text: exact ? `${hp.v} / ${hp.m}` : (crisis ? "Crisis" : "") });
  }
  if (info.mp && showMp && !crisisOnly) rows.push({ k: "MP", kind: "bar", pct: pct(info.mp.v, info.mp.m), cls: "is-mp", text: exact ? `${info.mp.v} / ${info.mp.m}` : "" });
  if (isPc && info.ip) rows.push({ k: "IP", kind: "pips", pips: Array.from({ length: info.ip.m }, (_, i) => i < info.ip.v), text: `${info.ip.v} / ${info.ip.m}` });
  if (showZp && info.zp && info.zpName) rows.push({ k: "ZP", kind: "bar", pct: pct(info.zp.v, info.zp.m), cls: "is-zp", text: info.zp.v >= info.zp.m ? "Ready" : `${info.zp.v} / ${info.zp.m}`, sub: info.zpName });
  return { rows, crisis, crisisOnly, hp };
}

// ── the model ──────────────────────────────────────────────────────────────

/**
 * @param {Token} token        a placed token (canvas object)
 * @param {object} [o]
 * @param {"enemy"|"party"|"ally"} [o.side]  from the battle roster; else disposition
 * @returns view model, or null when the token has no actor
 */
export function buildInspectModel(token, { side = null, asPlayer = false } = {}) {
  const actor = token?.actor;
  if (!actor) return null;
  // `asPlayer`: a GM previewing exactly what the table sees.
  const gm = !!game.user?.isGM && !asPlayer;
  const p = actor.system?.props ?? {};
  const disposition = Number(token.document?.disposition ?? 0);
  const enemy = side ? side === "enemy" : disposition === -1;
  // CSB gives every actor the same type, so "a PC" = someone at the table owns it.
  const isPc = !enemy && !!actor.hasPlayerOwner;
  const sideLabel = enemy ? "Enemy" : (isPc ? "Party" : "Ally");

  // ── knowledge (enemies) ──
  let entry = null;
  if (enemy) {
    try {
      const enc = encApi();
      const page = enc?.getPageForActor?.(prototypeUuidOf(token));
      entry = page ? enc.getEntryData(page, { reveal: gm }) : null;
    } catch { entry = null; }
  }
  const tiers = enemy ? (entry?.tiers ?? { identity: false, stats: false, details: false }) : { identity: true, stats: true, details: true };
  const idOK = tiers.identity || gm, stOK = tiers.stats || gm, dtOK = tiers.details;
  const tierN = tiers.details ? 3 : tiers.stats ? 2 : tiers.identity ? 1 : 0;

  // ── header ──
  let sub;
  if (!enemy) {
    const lv = str(p.level);
    sub = lv ? `Lv ${lv}` : "";
  } else if (idOK) {
    sub = [str(p.level) ? `Lv ${str(p.level)}` : "", cap(str(p.npc_rank)), cap(str(p.species)), str(p.traits)].filter(Boolean).join(" · ");
  } else sub = "Unknown creature. Study it to learn more.";

  // ── vitals ──
  const rule = enemyHpRule();
  const vit = enemy && !gm
    ? vitalsOf(actor, { exact: rule === "identity" && tiers.identity, showMp: tiers.identity || rule === "bar", crisisOnly: rule === "crisis", isPc: false, showZp: false })
    : vitalsOf(actor, { isPc });
  const vitalsNote = enemy && !gm && rule === "identity" && !tiers.identity ? "Exact HP and MP show once the party identifies it (Study 7+)." : "";

  // ── defense & dice ──
  const stats = [];
  if (idOK) {
    for (const [k, key] of [["DEF", "defense"], ["M.DEF", "magic_defense"]]) {
      const v = num(p[key]);
      stats.push({ k, v: v == null ? "–" : String(v), was: "", cls: enemy && !tiers.identity ? "is-gmonly" : "" });
    }
  }
  if (stOK) {
    for (const [k, key] of ATTRS) {
      const now = num(p[`${key}_current`]) ?? num(p[`${key}_base`]);
      const base = num(p[`${key}_base`]);
      const changed = now != null && base != null && now !== base;
      stats.push({ k, v: now == null ? "–" : `d${now}`, was: changed ? `${enemy ? "was" : "base"} d${base}` : "",
        cls: [changed ? (now > base ? "is-up" : "is-down") : "", enemy && !tiers.stats ? "is-gmonly" : ""].filter(Boolean).join(" ") });
    }
  }
  const statsLock = !idOK ? "Study 7+ reveals DEF and M.DEF; 8+ reveals the attribute dice."
    : !stOK ? "Study 8+ reveals the attribute dice." : "";

  // ── affinities (live code: a Wet target really is Weak to bolt) ──
  const row = entry?.affinityRow ?? null;
  const affs = ELEMENTS.map(([key, label, icon], i) => {
    const playersKnow = !enemy || !!row?.[i]?.playersKnow;
    const known = playersKnow || gm;
    let code = "NA";
    try { code = String(resolveAffinity(actor, key) ?? "NE").toUpperCase(); } catch { /* */ }
    if (code === "NE" || code === "") code = "NA";
    const learned = enemy && !!row?.[i]?.learned && !gm;
    return {
      key, el: label, icon, code, known, learned, gmOnly: gm && enemy && !playersKnow,
      text: known ? (GRADE_WORD[code] ?? label) : "?",
      cls: known ? `aff-${code.toLowerCase()}` : "aff-unk",
      title: known ? `${label}: ${GRADE_LONG[code] ?? code}${learned ? " (learned by hitting it)" : ""}`
        : `${label}: unknown. Hit it with ${label.toLowerCase()}, or Study it (13+), to find out.`,
    };
  });
  const unknown = affs.filter((a) => !a.known).length;
  const learnedNames = affs.filter((a) => a.learned).map((a) => a.el);
  const affNote = !enemy || dtOK || gm ? "" : learnedNames.length
    ? `${learnedNames.join(" & ")} learned by hitting it (gold dot). ${unknown} unknown: hit it with them, or Study 13+.`
    : `${unknown} unknown. Hit it with an element to learn that one, or Study 13+.`;
  const condsKnown = !enemy || dtOK || gm;
  const conds = condsKnown
    ? Object.entries(p).filter(([k, v]) => k.startsWith("condition_") && String(v).toUpperCase() === "IM").map(([k]) => cap(k.slice(10))).join(", ")
    : "";

  // ── effects ──
  let rows = [];
  try { rows = effectRowsOf(actor); } catch { rows = []; }
  const seenIds = new Set((entry?.actions ?? []).filter((a) => a.known && !a.hidden).map((a) => a.id));
  const groups = { buffs: [], debuffs: [], other: [], passive: [] };
  for (const r of rows) {
    const g = groupOf(r);
    // An enemy's always-on effects come from its passives: hidden until that
    // passive is witnessed or the creature is fully studied.
    // Battle-applied (temporary) effects are visible to all; anything always-on
    // betrays an unseen passive, so it waits until that passive is witnessed.
    // At Details, `entry.actions` already marks the INERT passives as known — the
    // same rule the Bestiary uses — so reactive ones stay hidden until seen.
    let gmOnly = false;
    if (enemy && !r.temporary) {
      const ids = sourceItemIds(r);
      const seen = [...ids].some((id) => seenIds.has(id));
      if (!seen) { if (!gm) continue; gmOnly = true; }
    }
    groups[g].push(rowView(r, g, gmOnly));
  }

  // ── actions (enemies) ──
  const KIND = { attack: "Attack", skill: "Skill", spell: "Spell", passive: "Passive" };
  const actions = enemy ? (entry?.actions ?? []).map((a) => ({
    name: a.known || gm ? (a.name ?? "???") : "???", kind: KIND[a.kind] ?? "Action", known: !!a.known && !a.hidden, gmOnly: gm && a.hidden,
  })) : [];
  const seen = actions.filter((a) => a.known).length;

  return {
    tokenId: token.id, tokenUuid: token.document?.uuid ?? null, actorUuid: actor.uuid,
    name: token.document?.name || actor.name, img: actor.img,
    enemy, isPc, gm, sideLabel, sideCls: enemy ? "side-enemy" : isPc ? "side-party" : "side-ally",
    sub,
    tierN, tierShort: ["Unstudied", "Identified", "Stats known", "Fully studied"][tierN],
    tierTitle: ["Not studied yet", "Study 7+: identity", "Study 8+: attribute dice", "Study 13+: everything"][tierN],
    vitals: vit.rows, crisisOnly: vit.crisisOnly, crisis: vit.crisis, vitalsNote,
    stats, statsLock,
    affs, affNote, conds,
    groups,
    actions, seenText: `${seen} of ${actions.length}`,
    hint: enemy ? (idOK ? (entry?.identity?.description ?? "") : "") : "",
    steps: [[7, "Identity: level, rank, HP, DEF, traits"], [8, "Attribute dice"], [13, "Affinities, immunities, passives"]]
      .map(([n, text], i) => ({ n: `${n}+`, text, done: tierN > i })),
    hasEntry: !!entry,
    // Hover peek: up to five timed effects, debuffs first.
    peekIcons: [...groups.debuffs, ...groups.buffs].slice(0, 5).map((e) => ({ img: e.img, name: e.name })),
  };
}
