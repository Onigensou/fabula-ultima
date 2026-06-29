// Equipment SET BONUSES — fully data-driven via "Equipment Set" documents.
//
// Some gear belongs to a "set" and grants an extra bonus once you wear enough
// pieces (e.g. the aquatic set: Swimsuit + Diver Goggle → 2-piece "you're always
// Wet"). NOTHING about the bonus lives in code: both the membership AND the
// structured effect are authored as world data.
//
//   1. MEMBERSHIP — on each wearable piece's CSB sheet: tick `isSet` and type the
//      set's name into `set_name` ("Swift Swimmers"). The engine groups equipped
//      pieces by that name. ("<Set Name>" is the CSB empty sentinel, ignored.)
//
//   2. BONUSES — a dedicated, NON-equippable "Equipment Set" item (one per set,
//      kept in the "Set" folder, built on the `_Equipment Set Template`). It
//      carries the SAME `set_name` (so it joins to the pieces) and a
//      `set_bonus_table` dynamicTable whose rows are:
//         { pieces, bonus_label, bonus_ae_ref, bonus_skill_ref }
//      `pieces`         — the threshold (e.g. 2).
//      `bonus_ae_ref`   — name of an Active Effect to grant. Resolved from the
//                         Equipment Set's OWN effects first (self-contained),
//                         then any `activeEffectContainer` library by name.
//      `bonus_skill_ref`— name of a linked `_skill` (container = the Set
//                         Definition's id) to grant as a usable owned skill.
//      Both refs are optional and combinable. A status-granting AE ("Always Wet"
//      → statuses:["wet"]) is how the 2-piece "always Wet" works — a real status,
//      so its token icon + every Wet interaction light up, and the pieces' own
//      Wet-gated transfer AEs (Diver Goggle +3 Acc, Swimsuit DEX d12) follow free.
//
// On every equip reconcile (applyEquipmentSwap / reconcileEquip — and the
// item-CRUD hooks in set-bonus-hooks.js), `reconcileSetBonuses(actor)` counts
// equipped pieces per set and, for each met threshold, ensures the granted AE
// and/or skill exist; grants whose threshold is no longer met are removed.
// Managed grants are tagged so the sync is idempotent:
//   - AE:    flags["fabula-ultima-companion"].setBonus      = "<set>:<pieces>:ae"
//   - skill: flags["fabula-ultima-companion"].setBonusSkill = "<set>:<pieces>:skill"

import { log, warn } from "./logger.js";

const FLAG_NS = "fabula-ultima-companion";

// The CSB empty-field sentinels — ignore items still showing them.
const SET_NAME_EMPTY = "<Set Name>";
// CSB empty-container sentinel for a skill's `container` ("-" = standalone).
const CONTAINER_EMPTY = "-";

// ── BD orchestration guard ──────────────────────────────────────────────────
// A BD-controlled equip flow (applyEquipmentSwap / reconcileEquip) reconciles
// set bonuses ITSELF, synchronously, at the point it chooses — so the ambient
// item-CRUD hooks (set-bonus-hooks.js) must STAND DOWN for that actor while BD
// is driving. This keeps BD the orchestrator (it can run pre-steps before the
// equipment effect lands) and removes the double-fire / debounce race; the hooks
// then only fire for genuinely out-of-band equipment changes (sheet checkbox,
// inventory/warehouse moves, cross-actor transfers). BD wraps its flow in
// `withManagedEquip(actor, fn)`; the hooks gate on `isManagedEquip(actorId)`.
// Re-entrancy-counted, and try/finally-released so an aborted flow can't leave
// an actor permanently suppressed.
const _managedEquip = new Map(); // actorId -> nesting depth

export function isManagedEquip(actorId) {
  return !!actorId && (_managedEquip.get(actorId) ?? 0) > 0;
}

export async function withManagedEquip(actor, fn) {
  const id = actor?.id;
  if (id) _managedEquip.set(id, (_managedEquip.get(id) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    if (id) {
      const n = (_managedEquip.get(id) ?? 1) - 1;
      if (n <= 0) _managedEquip.delete(id);
      else _managedEquip.set(id, n);
    }
  }
}

// ── Membership ─────────────────────────────────────────────────────────────

// Count equipped pieces per CSB set_name for one actor (gated by isSet).
function countEquippedSetPieces(actor) {
  const counts = {};
  for (const it of actor.items ?? []) {
    if (it.type !== "equippableItem") continue;
    const p = it.system?.props ?? {};
    if (!p.isEquipped || !p.isSet) continue;
    const name = String(p.set_name ?? "").trim();
    if (!name || name === SET_NAME_EMPTY) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

// ── Equipment Sets (the data-authored bonus tables) ───────────────────────

// A CSB dynamicTable's value is stored as an object keyed by row index
// ({ "0": {...}, "1": {...} }) or occasionally an array. Normalize to an array
// of row objects, dropping CSB bookkeeping keys.
function tableRows(tableValue) {
  if (!tableValue || typeof tableValue !== "object") return [];
  const raw = Array.isArray(tableValue) ? tableValue : Object.values(tableValue);
  return raw.filter((r) => r && typeof r === "object");
}

// Discover every Equipment Set in the world: any item carrying a non-empty
// `set_bonus_table`. Returns set_name → { setName, defItem, rows:[{pieces,label,
// aeRef, skillRef}] }. (Built per reconcile; world item count is small.)
export function getEquipmentSets() {
  const defs = new Map();
  for (const it of game.items ?? []) {
    const p = it.system?.props ?? {};
    const rows = tableRows(p.set_bonus_table)
      .map((r) => ({
        pieces: Number(r.pieces),
        label: String(r.bonus_label ?? "").trim(),
        aeRef: String(r.bonus_ae_ref ?? "").trim(),
        skillRef: String(r.bonus_skill_ref ?? "").trim(),
      }))
      .filter((r) => Number.isFinite(r.pieces) && r.pieces > 0 && (r.aeRef || r.skillRef));
    if (!rows.length) continue;
    const setName = String(p.set_name ?? "").trim();
    if (!setName || setName === SET_NAME_EMPTY) {
      warn(`set-bonus: "${it.name}" has a set_bonus_table but no set_name — skipped.`);
      continue;
    }
    if (defs.has(setName)) {
      warn(`set-bonus: multiple Equipment Sets for "${setName}" — using "${defs.get(setName).defItem.name}".`);
      continue;
    }
    defs.set(setName, { setName, defItem: it, rows });
  }
  return defs;
}

// Resolve a `bonus_ae_ref` to an AE template object. Self-contained first (the
// Equipment Set's own effects), then the canonical status library
// (`activeEffectContainer` items, the same source skills use for "Slow" etc.).
function resolveSetAe(defItem, aeRef) {
  if (!aeRef) return null;
  for (const eff of defItem.effects ?? []) {
    if (eff.name === aeRef || eff.id === aeRef) return eff.toObject();
  }
  for (const it of game.items ?? []) {
    if (it.type !== "activeEffectContainer") continue;
    for (const eff of it.effects ?? []) {
      if (eff.name === aeRef) return eff.toObject();
    }
  }
  warn(`set-bonus: AE ref "${aeRef}" (set "${defItem.system?.props?.set_name}") not found.`);
  return null;
}

// Resolve a `bonus_skill_ref` to a linked `_skill` template object: a world item
// whose `system.container` is the Equipment Set's id and whose name matches.
function resolveSetSkill(defItem, skillRef) {
  if (!skillRef) return null;
  for (const it of game.items ?? []) {
    if (it.id === defItem.id) continue;
    if (String(it.system?.container ?? "") !== defItem.id) continue;
    if (it.name === skillRef) return it.toObject();
  }
  warn(`set-bonus: skill ref "${skillRef}" (set "${defItem.system?.props?.set_name}") not found as a linked _skill.`);
  return null;
}

// ── Grant builders ─────────────────────────────────────────────────────────

// Build-time content SIGNATURES. Stamped into each grant's flags at creation,
// then recomputed from the current definition every reconcile. A mismatch means
// the grant is STALE — the definition was edited, the resolved template / name /
// protection changed, or it predates signatures — so reconcile REFRESHES it
// (delete + recreate) instead of keeping it merely because the tag matches.
// (Excludes the tag and the signature itself; normalizes change rows so Foundry's
// default `priority`/field churn doesn't cause spurious refreshes.)
function aeGrantSig(obj) {
  const fu = obj.flags?.[FLAG_NS] ?? {};
  return JSON.stringify({
    n: obj.name ?? null,
    s: [...(obj.statuses ?? [])].map(String).sort(),
    c: (obj.changes ?? []).map((ch) => ({ k: ch.key, m: ch.mode, v: ch.value })),
    di: !!obj.disabled,
    du: obj.duration ?? {},
    dp: !!fu.directorPermanent,
    cs: !!fu.crossScene,
  });
}

function skillGrantSig(obj) {
  return JSON.stringify({
    n: obj.name ?? null,
    t: obj.type ?? null,
    p: obj.system?.props ?? {},
  });
}

// Build the managed-AE create payload from a resolved template + tag. The
// template is often a canonical status AE from the hub (e.g. "Wet") that ships
// with a finite combat duration; a set bonus is equip-managed (persists while
// the threshold is met, not for N rounds), so the grant is forced PERMANENT —
// the duration is stripped and any combat-counter/charge bookkeeping dropped.
function buildAeGrant(template, tag, label) {
  const obj = foundry.utils.deepClone(template);
  delete obj._id;
  delete obj.origin;
  // Keep the resolved template's OWN name (e.g. the canonical "Wet"): downstream
  // detection like ae("Wet") matches by effect NAME, so renaming the grant to the
  // row's label would silently break Wet-gated gear. `bonus_label` is only a
  // human descriptor for the table; fall back to it only if the template is
  // unnamed.
  obj.name = obj.name || label || tag;
  obj.disabled = false;
  obj.transfer = false;   // actor-direct managed effect, not item-carried
  obj.duration = {};      // permanent — lifecycle is the equip threshold, not time
  obj.flags = obj.flags ?? {};
  // A set bonus is a PERMANENT, equipment-managed effect: ONLY the equip
  // threshold (via reconcile) may remove it. So it must survive the battle-end
  // transient-AE sweep, scene changes, Rest, and Cleanse. `directorPermanent` +
  // `crossScene` are the EXISTING exemption flags those mechanics honor
  // (isTransientAE in skill-effects.js already skips them; Rest + Cleanse are
  // taught to honor them too). Generic — no per-status / per-"Wet" code.
  obj.flags[FLAG_NS] = {
    ...(obj.flags[FLAG_NS] ?? {}),
    setBonus: tag,
    directorPermanent: true,
    crossScene: true,
  };
  obj.flags[FLAG_NS].setBonusSig = aeGrantSig(obj);
  return obj;
}

// Build the managed-skill create payload from a resolved `_skill` template + tag.
// container "-" so the skill-picker primary-walks it as an owned skill (the
// proven equipped-gear grant shape); `helperSkill` if the bonus is reaction-only.
function buildSkillGrant(template, tag) {
  const obj = foundry.utils.deepClone(template);
  delete obj._id;
  obj.system = obj.system ?? {};
  obj.system.container = CONTAINER_EMPTY;
  obj.flags = obj.flags ?? {};
  obj.flags[FLAG_NS] = { ...(obj.flags[FLAG_NS] ?? {}), setBonusSkill: tag };
  obj.flags[FLAG_NS].setBonusSkillSig = skillGrantSig(obj);
  return obj;
}

// ── Reconcile ──────────────────────────────────────────────────────────────

// Reconcile an actor's managed set-bonus grants (AEs + skills) to its currently
// equipped pieces. Idempotent: creates missing grants whose threshold is met,
// deletes managed grants whose threshold is no longer met, leaves everything
// else untouched. Safe on any actor (no set pieces → no-op). Returns a summary.
export async function reconcileSetBonuses(actor) {
  if (!actor?.items) return { counts: {}, aeCreated: 0, aeDeleted: 0, skillCreated: 0, skillDeleted: 0 };

  const counts = countEquippedSetPieces(actor);
  const defs = getEquipmentSets();

  // Tags that SHOULD exist now, with their resolved create payloads.
  const wantedAe = new Map();    // tag -> aeObject
  const wantedSkill = new Map(); // tag -> skillObject
  for (const { setName, defItem, rows } of defs.values()) {
    const have = counts[setName] ?? 0;
    for (const row of rows) {
      if (have < row.pieces) continue;
      if (row.aeRef) {
        const tag = `${setName}:${row.pieces}:ae`;
        const tpl = resolveSetAe(defItem, row.aeRef);
        if (tpl) wantedAe.set(tag, buildAeGrant(tpl, tag, row.label));
      }
      if (row.skillRef) {
        const tag = `${setName}:${row.pieces}:skill`;
        const tpl = resolveSetSkill(defItem, row.skillRef);
        if (tpl) wantedSkill.set(tag, buildSkillGrant(tpl, tag));
      }
    }
  }

  // ── AE grants ──
  const existingAe = (actor.effects?.contents ?? []).filter((e) => e.flags?.[FLAG_NS]?.setBonus);
  const aeDelete = [];
  const aePresent = new Set();
  for (const e of existingAe) {
    const tag = e.flags[FLAG_NS].setBonus;
    const want = wantedAe.get(tag);
    // Keep ONLY if still wanted AND unchanged (signature match). A no-longer-wanted
    // grant, a stale one (definition/template/name/protection changed), or a
    // pre-signature legacy grant is deleted here and recreated below with the
    // current payload — so authoring edits propagate to actors automatically.
    if (want && e.flags[FLAG_NS].setBonusSig === want.flags[FLAG_NS].setBonusSig) {
      aePresent.add(tag);
    } else {
      aeDelete.push(e.id);
    }
  }
  const aeCreate = [];
  for (const [tag, obj] of wantedAe) if (!aePresent.has(tag)) aeCreate.push(obj);

  // ── Skill grants ──
  const existingSkill = (actor.items?.contents ?? []).filter((i) => i.flags?.[FLAG_NS]?.setBonusSkill);
  const skillDelete = [];
  const skillPresent = new Set();
  for (const i of existingSkill) {
    const tag = i.flags[FLAG_NS].setBonusSkill;
    const want = wantedSkill.get(tag);
    // Same signature refresh as AE grants: a changed/stale/legacy skill grant is
    // dropped here and recreated below from the current definition.
    if (want && i.flags[FLAG_NS].setBonusSkillSig === want.flags[FLAG_NS].setBonusSkillSig) {
      skillPresent.add(tag);
    } else {
      skillDelete.push(i.id);
    }
  }
  const skillCreate = [];
  for (const [tag, obj] of wantedSkill) if (!skillPresent.has(tag)) skillCreate.push(obj);

  // ── Commit (deletes first, then creates) ──
  if (aeDelete.length) {
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", aeDelete); }
    catch (e) { warn("reconcileSetBonuses: AE delete failed", e); }
  }
  if (skillDelete.length) {
    try { await actor.deleteEmbeddedDocuments("Item", skillDelete); }
    catch (e) { warn("reconcileSetBonuses: skill delete failed", e); }
  }
  if (aeCreate.length) {
    try { await actor.createEmbeddedDocuments("ActiveEffect", aeCreate); }
    catch (e) { warn("reconcileSetBonuses: AE create failed", e); }
  }
  if (skillCreate.length) {
    try {
      const made = await actor.createEmbeddedDocuments("Item", skillCreate);
      // Granted skills self-reference via system.uniqueId; heal the projection.
      for (const sk of made) {
        try { await sk.update({ "system.uniqueId": sk.id }); sk.prepareData?.(); }
        catch (e) { warn(`reconcileSetBonuses: skill heal failed for ${sk.name}`, e); }
      }
    } catch (e) { warn("reconcileSetBonuses: skill create failed", e); }
  }

  const touched = aeCreate.length + aeDelete.length + skillCreate.length + skillDelete.length;
  if (touched) {
    log(`reconcileSetBonuses: ${actor.name} AE +${aeCreate.length}/-${aeDelete.length} skill +${skillCreate.length}/-${skillDelete.length} (counts ${JSON.stringify(counts)})`);
  }
  return {
    counts,
    aeCreated: aeCreate.length, aeDeleted: aeDelete.length,
    skillCreated: skillCreate.length, skillDeleted: skillDelete.length,
  };
}

// ── Membership validator (typo guard for the string `set_name` join) ───────
//
// Membership is a free-text `set_name` shared between the wearable pieces and
// the Equipment Set doc (an exact-string join). That's the right model — using
// CSB's `container` would hide pieces from inventory (CustomActor excludes
// container'd items) — but it's typo-fragile (the "Spirit of Vengeance" vs
// "Vengence" class of bug, where a mismatch silently grants no bonus). This
// read-only audit surfaces those mismatches; it powers both the GM startup
// console audit (set-bonus-hooks.js) and the CI lint (lint/equipment-set-lint.js).

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Every wearable set piece (CSB `isSet`) across world items + actor inventories.
// Excludes Equipment Set docs themselves (they carry set_bonus_table, not isSet).
function collectSetPieces() {
  const pieces = [];
  const add = (item, location) => {
    if (item.type !== "equippableItem") return;
    const p = item.system?.props ?? {};
    if (!p.isSet) return;
    if (p.set_bonus_table && Object.keys(p.set_bonus_table).length) return;
    pieces.push({ name: String(p.set_name ?? "").trim(), location, itemName: item.name });
  };
  for (const it of game.items ?? []) add(it, `Item "${it.name}"`);
  for (const a of game.actors ?? []) for (const it of a.items ?? []) add(it, `Actor "${a.name}" › "${it.name}"`);
  return pieces;
}

// Cross-check piece membership against the authored Equipment Set docs.
// Returns { findings:[{severity,code,location,message}], summary }.
export function auditEquipmentSetMembership() {
  const defs = getEquipmentSets();
  const defNames = [...defs.keys()];
  const pieces = collectSetPieces();
  const findings = [];

  // 1. isSet ticked but no usable set_name.
  for (const pc of pieces) {
    if (!pc.name || pc.name === SET_NAME_EMPTY) {
      findings.push({ severity: "warning", code: "SET_PIECE_NO_NAME",
        location: pc.location, message: `${pc.location} has isSet but an empty set_name.` });
    }
  }

  // 2. set_name with no matching Equipment Set doc — grouped, with a near-miss.
  const named = pieces.filter((pc) => pc.name && pc.name !== SET_NAME_EMPTY);
  const byBadName = new Map();
  for (const pc of named) {
    if (defNames.includes(pc.name)) continue;
    if (!byBadName.has(pc.name)) byBadName.set(pc.name, new Set());
    byBadName.get(pc.name).add(pc.itemName);
  }
  for (const [bad, itemNames] of byBadName) {
    let suggest = null, best = Infinity;
    for (const dn of defNames) {
      const d = levenshtein(bad.toLowerCase(), dn.toLowerCase());
      if (d < best) { best = d; suggest = dn; }
    }
    // A close existing doc name => likely a typo (warn). No near-miss => the set
    // just isn't authored yet (info), like skill-raw-drift's intentional gaps.
    const isTypo = suggest && best <= Math.max(2, Math.ceil(bad.length / 4));
    const hint = isTypo ? ` — did you mean "${suggest}"?` : "";
    findings.push({ severity: isTypo ? "warning" : "info", code: "SET_PIECE_NO_DEF",
      location: [...itemNames].join(", "),
      message: `set_name "${bad}" has no Equipment Set doc${hint} (on: ${[...itemNames].join(", ")}).` });
  }

  // 3. Equipment Set doc that matches no pieces (orphan definition).
  const live = new Set(named.map((pc) => pc.name));
  for (const [name, { defItem }] of defs) {
    if (!live.has(name)) {
      findings.push({ severity: "info", code: "SET_DEF_ORPHAN",
        location: `Item "${defItem.name}"`, message: `Equipment Set "${defItem.name}" (set "${name}") matches no equipped/world pieces.` });
    }
  }

  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return {
    findings,
    summary: {
      total: findings.length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      info: findings.filter((f) => f.severity === "info").length,
      byCode,
    },
  };
}
