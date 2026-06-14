// Test Battle dev tool (GM only).
//
// A dev tool, bundled under the Developer Tools launcher, that starts a LEAN
// live battle with hand-picked participants — for exercising a skill end-to-end
// without the full Battle Prompt / cinematics. The GM configures:
//   - Main player : a real PC, OR a generated "class test actor" carrying all
//                   implemented BD skills of a chosen class.
//   - Main enemy  : a real actor, OR a generated dummy with massive HP.
//   - Ally        : optional, for support-skill testing.
//   - Extra enemies: optional copies of the main enemy, for AOE testing.
//
// The launch goes through the real director FSM
// (FUCompanion.api.experimental.battleDirector.start({ payload })) with a
// `context.lean` flag so runDirectorInit skips the cinematic steps (curtain,
// entrance, BGM, preload, banner) but still resolves the encounter/party,
// spawns tokens, builds the DirectorCombat, and runs turns/reactions for real.
//
// Generated scratch actors live in a "BD Dev Test" folder and are regenerated
// in place on each launch (find-or-create + wipe-and-refill), so they never
// accumulate. Spawned tokens carry the directorSpawned flag and are swept by
// the director's normal end-of-battle cleanup.
//
// Not a manifest entry — imported by director-boot.js and initialised from its
// ready hook, so it loads on a normal reload with no Setup-relaunch.

import { log, warn } from "./logger.js";
import { registerDevTool, devToolsAnchorBottom, devToolsAnchorLeft } from "./dev-tools-menu.js";
import { applyEquipmentSwap, reconcileEquip } from "./equipment-swap.js";

const PANEL_ID = "fud-testbattle-panel";
const STYLE_ID = "fud-testbattle-style";

const SCRATCH_FOLDER = "BD Dev Test";
const MASSIVE_HP = 999999;
const SCENE_NAME = "Training Ground";
const MODULE_ID = "fabula-ultima-companion";
const NO_ACTIONS_FLAG = "testBattleNoActions";

// CSB template ids decide an actor's sheet + derivation. We pick the base
// actor to clone by template id (not by name or a prop heuristic) so the
// generated player/dummy always render against the correct template. Shipping
// the full actor data isn't viable — a single CSB actor is ~3 MB because every
// item embeds the whole template — so we clone a live reference of the right
// template instead.
//
// Player template default = Hina's template in this world. The npc template is
// read from the Save System setting (authoritative), falling back to the same
// default the Save System uses. Both have a discovery fallback so a renamed /
// re-id'd template still resolves.
const PLAYER_TEMPLATE_ID = "OmwL5UqoVwjshkJo";
const NPC_TEMPLATE_FALLBACK = "yegF6R8aaymhrvCg";

let _booted = false;
let _soloMode = false; // when true, live-added combatants also get 0 actions

export function initTestBattleTool() {
  try {
    if (_booted) return;
    if (!game.user?.isGM) return;
    ensureStyle();
    registerDevTool({ id: "test-battle", icon: "⚔️", label: "Test Battle", onClick: openPanel });
    // Ephemeral cleanup: when a battle ENDS, delete the scratch test actors so
    // nothing accumulates and no test data lingers. The director sweeps its
    // spawned tokens before firing this, so the actors are safe to delete.
    //
    // CRITICAL: skip this on the rewind path. `rewindTo` calls
    // stop({ reason: "rewind" }) purely to tear the live instance down before
    // reconstructing it a beat later — the battle is NOT over. Deleting the
    // generated player/dummy actors here would orphan their tokens (the
    // reconstruct step re-resolves combatant actors via fromUuid and finds
    // nothing), so the rewound combatants lose their actor → targets become
    // un-targetable and the turn breaks. Same re-mount gate `stop()` uses for
    // its own token/AE sweeps (cleanupTokens=false on rewind).
    Hooks.on("fu-director-stopped", ({ reason } = {}) => {
      if (reason === "rewind") return;
      _soloMode = false;
      removeNoActionsAEs().catch((e) => warn("no-actions AE cleanup threw", e));
      cleanupScratchActors().catch((e) => warn("scratch cleanup threw", e));
    });
    _booted = true;
    log("test-battle-tool: registered as dev tool");
  } catch (e) {
    warn("initTestBattleTool threw", e);
  }
}

// Delete every actor in the "BD Dev Test" folder (the generated class/dummy
// shells). Idempotent — a no-op when nothing was generated.
async function cleanupScratchActors() {
  const folder = game.folders?.find((f) => f.type === "Actor" && f.name === SCRATCH_FOLDER);
  if (!folder) return;
  const ids = game.actors.filter((a) => a.folder?.id === folder.id).map((a) => a.id);
  if (ids.length) {
    await Actor.deleteDocuments(ids);
    log(`test-battle: cleaned up ${ids.length} scratch actor(s)`);
  }
}

function api() {
  return globalThis.FUCompanion?.api?.experimental?.battleDirector ?? null;
}

// ─── Classification helpers ─────────────────────────────────────────────

// NPCs carry npc_rank / species props; PCs don't. (CSB makes every actor the
// Foundry "character" type, so we discriminate by props, not document type.)
function isNPC(a) {
  const p = a?.system?.props ?? {};
  return p.npc_rank != null || p.species != null;
}

// A true skill/spell item has skill_type set and NO item_type. Equipment
// (weapons incl. Arc Wand, armor, accessories, consumables) carries item_type
// and no skill_type — those must survive the skill wipe.
function isSkillItem(i) {
  const p = i?.system?.props ?? {};
  const hasSkillType = p.skill_type != null && p.skill_type !== "";
  const hasItemType = p.item_type != null && p.item_type !== "";
  return hasSkillType && !hasItemType;
}

function inScratch(a) {
  return a?.folder?.name === SCRATCH_FOLDER;
}

function npcTemplateId() {
  try {
    return globalThis.SaveSystem?.Storage?.getNpcTemplateId?.() || NPC_TEMPLATE_FALLBACK;
  } catch (_e) {
    return NPC_TEMPLATE_FALLBACK;
  }
}

// The player template id: the baked default if any actor uses it, else the
// most common template among non-NPC actors (discovery fallback).
function playerTemplateId() {
  const actors = (game.actors?.contents ?? []).filter((a) => !inScratch(a));
  if (actors.some((a) => a.system?.template === PLAYER_TEMPLATE_ID)) return PLAYER_TEMPLATE_ID;
  const npcTid = npcTemplateId();
  const counts = new Map();
  for (const a of actors) {
    const t = a.system?.template;
    if (!t || t === npcTid) continue;
    if (isNPC(a)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
  return best;
}

// Clone-source for a given template id: a real instance of that template
// (skip the template-definition actor, whose own id equals the template id),
// else any actor on that template.
function pickByTemplate(tid) {
  if (!tid) return null;
  const actors = (game.actors?.contents ?? []).filter((a) => !inScratch(a));
  return actors.find((a) => a.id !== tid && a.system?.template === tid)
      ?? actors.find((a) => a.system?.template === tid)
      ?? null;
}

// Base PC to clone for a class test actor — selected by player template id so
// the generated actor uses the correct sheet/derivation. Falls back to any
// non-NPC actor only if no actor on the player template exists.
function pickBasePC() {
  const actors = (game.actors?.contents ?? []).filter((a) => !inScratch(a));
  return pickByTemplate(playerTemplateId())
      ?? actors.find((a) => !isNPC(a))
      ?? actors[0]
      ?? null;
}

// Base NPC to clone for the dummy — selected by npc template id.
function pickBaseNPC() {
  const actors = (game.actors?.contents ?? []).filter((a) => !inScratch(a));
  return pickByTemplate(npcTemplateId())
      ?? actors.find((a) => isNPC(a))
      ?? actors[0]
      ?? null;
}

// ─── BD class-skill discovery ───────────────────────────────────────────

// Walk an item's Folder parents → ["Battle Director", "<Class>", "<Leaf>"].
function folderPathNames(item) {
  const out = [];
  let f = item?.folder;
  while (f) { out.unshift(f.name); f = f.folder; }
  return out;
}

const SKILL_LEAVES = new Set(["Skill", "Heroic Skill", "Spell"]);

// All implemented BD skill Items for a class, scanned from the world Item
// folders `Battle Director / <Class> / {Skill|Heroic Skill|Spell}`. ONLY the
// BD-folder masters — never the CSB `💥 Skill` legacy copies — so a generated
// actor always gets the canonical (current) version of each skill. Deduped by
// name (a stray duplicate master in the BD tree would otherwise grant twice).
function collectClassSkillItems(cls) {
  const matches = (game.items?.contents ?? []).filter((i) => {
    const p = folderPathNames(i);
    return p[0] === "Battle Director" && p[1] === cls && SKILL_LEAVES.has(p[2]);
  });
  const byName = new Map();
  for (const i of matches) if (!byName.has(i.name)) byName.set(i.name, i);
  return [...byName.values()];
}

// Hybrid (cross-class) heroics live in the class-less hub folder
// `Battle Director / Hybrid Heroic Skill` (e.g. Double Arrow = Commander/
// Sharpshooter, Hoplite = Commander/Guardian). They carry NO class field —
// only a `heroic_requirement` naming the eligible classes ("…among Commander
// and Sharpshooter."). Match the generated actor's class against that text so
// the dummy also gets the hybrid heroics it qualifies for. Deduped by name.
function collectHybridHeroicsForClass(cls) {
  if (!cls) return [];
  const re = new RegExp(`\\b${String(cls).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const matches = (game.items?.contents ?? []).filter((i) => {
    const p = folderPathNames(i);
    if (!(p[0] === "Battle Director" && p[1] === "Hybrid Heroic Skill")) return false;
    return re.test(String(i.system?.props?.heroic_requirement ?? ""));
  });
  const byName = new Map();
  for (const i of matches) if (!byName.has(i.name)) byName.set(i.name, i);
  return [...byName.values()];
}

// What loadout a class's skills GATE on, so a generated test actor is
// combat-ready instead of inert. Scans the raw skill data for the loadout
// formula identifiers (HAS_*_WEAPON / HAS_SHIELD / HAS_MARTIAL_ARMOR) — e.g.
// Sharpshooter's Barrage/RWM/Warning Shot need HAS_RANGED_WEAPON; Guardian's
// Rampart needs HAS_SHIELD || HAS_MARTIAL_ARMOR. An unequipped backpack item
// leaves those gates false. Returns
//   { weaponFamily: "ranged"|"melee"|"arcane"|null, needsShield, needsMartialArmor }.
function loadoutNeedsFromSkillData(skillDatas) {
  const txt = JSON.stringify(skillDatas ?? []).toUpperCase();
  let weaponFamily = null;
  if (txt.includes("HAS_RANGED_WEAPON")) weaponFamily = "ranged";
  else if (txt.includes("HAS_MELEE_WEAPON"))  weaponFamily = "melee";
  else if (txt.includes("HAS_ARCANE_WEAPON")) weaponFamily = "arcane";
  return {
    weaponFamily,
    needsShield: txt.includes("HAS_SHIELD"),
    needsMartialArmor: txt.includes("HAS_MARTIAL_ARMOR"),
  };
}

// Choose a weapon from the actor's inventory to equip — one matching the class's
// gate hint when possible, else the first weapon. Returns the live item or null.
function pickWeaponToEquip(actor, hint) {
  const weapons = (actor.items ?? []).filter(
    (i) => String(i.system?.props?.item_type ?? "").toLowerCase() === "weapon");
  if (!weapons.length) return null;
  if (hint === "ranged" || hint === "melee") {
    const m = weapons.find((w) => new RegExp(hint, "i").test(String(w.system?.props?.weapon_range ?? "")));
    if (m) return m;
  }
  if (hint === "arcane") {
    const m = weapons.find((w) => /arcane/i.test(String(w.system?.props?.category ?? w.system?.props?.weapon_type ?? "")));
    if (m) return m;
  }
  return weapons[0];
}

// Choose a shield from the actor's inventory (item_type "shield") to equip in
// the off-hand — satisfies HAS_SHIELD (e.g. Guardian's Rampart). `martial`
// prefers a martial shield when available, else any shield. Returns the live
// item or null.
function pickShieldToEquip(actor, { martial = false } = {}) {
  const shields = (actor.items ?? []).filter(
    (i) => String(i.system?.props?.item_type ?? "").toLowerCase() === "shield");
  if (!shields.length) return null;
  if (martial) {
    const m = shields.find((s) => !!s.system?.props?.isMartial);
    if (m) return m;
  }
  return shields[0];
}

// Best-effort: equip a martial armor item the actor already owns so
// HAS_MARTIAL_ARMOR reads true. Armor is NOT handled by applyEquipmentSwap
// (RAW forbids mid-combat armor swaps, and HAS_MARTIAL_ARMOR only reads the
// per-item isEquipped flag), so flip it directly + enable its item-resident
// AEs. No-op when the actor has no martial armor item. Returns the equipped
// item or null.
async function ensureMartialArmorEquipped(actor) {
  const armor = (actor.items ?? []).find(
    (i) => String(i.system?.props?.item_type ?? "").toLowerCase() === "armor"
      && !!i.system?.props?.isMartial);
  if (!armor) return null;
  if (!armor.system?.props?.isEquipped) {
    try {
      await armor.update({ "system.props.isEquipped": true });
      const fx = (armor.effects?.contents ?? []).filter((e) => e.disabled).map((e) => ({ _id: e.id, disabled: false }));
      if (fx.length) await armor.updateEmbeddedDocuments("ActiveEffect", fx);
    } catch (e) { warn(`test-battle: equip martial armor "${armor.name}" failed`, e); }
  }
  return armor;
}

// All basic weapons + basic shields (the world's RAW basic-equipment set),
// scanned from the dedicated `… / Basic Weapon / *` and `… / Basic Shield`
// folders. Added to a class test actor's backpack (unequipped) so the player
// can equip them via the Equipment action mid-battle.
function collectBasicEquipment() {
  return (game.items?.contents ?? []).filter((i) => {
    const p = folderPathNames(i);
    return p.includes("Basic Weapon") || p.includes("Basic Shield");
  });
}

// Classes that actually have implemented BD skill Items (excludes the
// class-less "Hybrid Heroic Skill" hub).
function implementedClasses() {
  const set = new Set();
  for (const i of (game.items?.contents ?? [])) {
    const p = folderPathNames(i);
    if (p[0] === "Battle Director" && p[1] && p[1] !== "Hybrid Heroic Skill" && SKILL_LEAVES.has(p[2])) {
      set.add(p[1]);
    }
  }
  return [...set].sort();
}

// ─── Scratch actor generation ───────────────────────────────────────────

async function getScratchFolder() {
  let f = game.folders?.find((x) => x.type === "Actor" && x.name === SCRATCH_FOLDER);
  if (!f) f = await Folder.create({ name: SCRATCH_FOLDER, type: "Actor" });
  return f;
}

// Apply a "No Actions" Active Effect that overrides the actor's `activation`
// stat to 0, so the director's live activation read gives it 0 turns/round.
// Used to make dummies (and, in solo mode, allies/extra enemies) non-acting via
// the real stat path — the token's activation bar reads 0 too. Idempotent.
async function applyNoActionsAE(actor) {
  if (!actor || actor.documentName !== "Actor") return;
  if ((actor.effects?.contents ?? []).some((e) => e.getFlag?.(MODULE_ID, NO_ACTIONS_FLAG))) return;
  try {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "No Actions",
      img: "icons/svg/downgrade.svg",
      changes: [{ key: "activation", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: "0", priority: 20 }],
      transfer: false,
      statuses: ["fud-no-actions"],
      flags: { [MODULE_ID]: { [NO_ACTIONS_FLAG]: true } },
    }]);
  } catch (e) { warn("applyNoActionsAE threw", e); }
}

// Strip every "No Actions" AE we applied (real actors; scratch actors are
// deleted wholesale on battle end). Called from the stop cleanup.
async function removeNoActionsAEs() {
  for (const actor of (game.actors?.contents ?? [])) {
    const ids = (actor.effects?.contents ?? []).filter((e) => e.getFlag?.(MODULE_ID, NO_ACTIONS_FLAG)).map((e) => e.id);
    if (ids.length) { try { await actor.deleteEmbeddedDocuments("ActiveEffect", ids); } catch (_e) {} }
  }
}

// Find-or-create a `BD Test — <Class>` shell, then strip it to a content-free
// blank and load only the chosen class's implemented BD skills.
//
// We clone a real instance of the player template rather than building from
// scratch: CSB only materializes computed props (current_hp/max_hp/…) when an
// actor's sheet renders, so a from-scratch blank has no HP and breaks combat.
// Cloning a live template instance gives valid cached props; we then strip ALL
// items and refill skills so nothing of the source character remains. The
// shell lives in the "BD Dev Test" folder and is deleted on battle end
// (fu-director-stopped) — it never touches canon data.
// `withBasicGear` loads all basic weapons + shields into the backpack (so the
// player can Equipment-action them). Mid-battle adds pass false — bulk item
// creation is slow while a battle is live (~14s for 34 items; skills-only ~3s),
// and a dropped-in ally is for skill testing, not weapon swapping.
async function genClassActor(className, { withBasicGear = true } = {}) {
  const name = `BD Test — ${className}`;
  let actor = game.actors?.find((a) => a.name === name);
  if (!actor) {
    const base = pickBasePC();
    if (!base) {
      ui.notifications?.error("Test Battle: no base PC actor found to clone for a class test actor.");
      return null;
    }
    const folder = await getScratchFolder();
    const data = base.toObject();
    delete data._id;
    data.name = name;
    data.folder = folder.id;
    data.items = []; // create an empty shell (fast; avoids create-then-delete churn)
    actor = await Actor.create(data);
  } else {
    // Existing scratch actor — clear items so we re-fill cleanly.
    const ids = actor.items.map((i) => i.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  }
  if (!actor) {
    ui.notifications?.error(`Test Battle: failed to create "${name}".`);
    return null;
  }

  // Load the class's implemented BD skills (+ optionally all basic weapons &
  // shields, unequipped, for Equipment-action testing).
  const mkData = (i) => { const o = i.toObject(); delete o._id; return o; };
  // Class-folder skills + any hybrid (cross-class) heroics this class qualifies
  // for. Class-folder wins on a name clash (dedupe by name across both).
  const classSkillDocs = collectClassSkillItems(className);
  const seenNames = new Set(classSkillDocs.map((i) => i.name));
  const hybridDocs = collectHybridHeroicsForClass(className).filter((i) => !seenNames.has(i.name));
  const skillItems = [...classSkillDocs, ...hybridDocs].map(mkData);
  if (!skillItems.length) ui.notifications?.warn(`Test Battle: no implemented BD skills found for "${className}".`);
  else if (hybridDocs.length) log(`test-battle: +${hybridDocs.length} hybrid heroic(s) for "${className}": ${hybridDocs.map((i) => i.name).join(", ")}`);
  const gearItems = withBasicGear ? collectBasicEquipment().map((i) => {
    const o = mkData(i);
    if (o.system?.props) o.system.props.isEquipped = false; // backpack, not equipped
    return o;
  }) : [];
  const toAdd = [...skillItems, ...gearItems];
  if (toAdd.length) await actor.createEmbeddedDocuments("Item", toAdd);

  // Auto-equip the loadout the class can actually USE. Basic gear is added
  // unequipped (backpack), but most class skills/attacks need equipped gear —
  // and gated passives stay inert without it: Sharpshooter's Barrage/RWM/
  // Warning Shot need HAS_RANGED_WEAPON; Guardian's Rampart needs
  // HAS_SHIELD || HAS_MARTIAL_ARMOR. Derive the need from the skill data and
  // equip a matching weapon (main) + shield (off) via the real equip path so
  // main_hand/off_hand + isEquipped + derived props all persist (the two-level
  // equip model). Martial armor is a separate direct flip (not swappable).
  try {
    const need = loadoutNeedsFromSkillData(skillItems);
    const weapon = pickWeaponToEquip(actor, need.weaponFamily);
    const shield = need.needsShield ? pickShieldToEquip(actor) : null;
    const selections = {};
    if (weapon) selections.main = weapon.id;
    if (shield) selections.off = shield.id;
    if (weapon || shield) {
      await applyEquipmentSwap(actor, selections);
      const bits = [
        weapon ? `"${weapon.name}" (${need.weaponFamily ?? "default"}) main` : null,
        shield ? `"${shield.name}" off` : null,
      ].filter(Boolean).join(" + ");
      log(`test-battle: equipped ${bits} on ${name}`);
    }
    if (need.needsShield && !shield) {
      warn(`test-battle: ${name} skills need HAS_SHIELD but no shield item is in inventory`);
    }
    // HAS_MARTIAL_ARMOR — best-effort (armor isn't swap-handled). A shield
    // already satisfies Rampart's OR gate; this covers any armor-only need.
    if (need.needsMartialArmor) {
      const armor = await ensureMartialArmorEquipped(actor);
      if (armor) log(`test-battle: equipped martial armor "${armor.name}" on ${name}`);
      else if (!shield) warn(`test-battle: ${name} skills need HAS_MARTIAL_ARMOR but no martial armor item is in inventory`);
    }
    // Reconcile isEquipped to the slots so loadout gates (HAS_RANGED_WEAPON,
    // HAS_SHIELD, …) read correctly on the generated actor — even if no gear
    // was auto-equipped (lean mode) or the cloned base PC left stale state.
    await reconcileEquip(actor);
  } catch (e) { warn("test-battle: auto-equip threw", e); }

  // Start at full HP (the cloned shell carries the template's default stats),
  // and rename the prototype token so spawned tokens read as the test actor,
  // not the source character we cloned.
  try {
    const max = actor.system?.props?.max_hp;
    const upd = { "prototypeToken.name": name };
    if (max != null) upd["system.props.current_hp"] = max;
    await actor.update(upd);
  } catch (_e) {}

  log(`test-battle: class actor "${name}" ready — ${skillItems.length} skills + ${gearItems.length} basic weapons/shields`);
  return actor;
}

// Find-or-create a `BD Dummy Enemy` shell cloned from an npc-template instance,
// stripped to a blank (no items) with current_hp overridden to a massive value.
// We override current_hp (not max_hp, which CSB derives) because damage is
// `Math.max(0, curHp - dmg)` and is never re-clamped up — so the dummy survives
// any AOE / sustained beating. Deleted on battle end; never touches canon.
async function genDummyEnemy() {
  const name = "BD Dummy Enemy";
  let dummy = game.actors?.find((a) => a.name === name);
  if (!dummy) {
    const src = pickBaseNPC();
    if (!src) {
      ui.notifications?.error("Test Battle: no base NPC actor found to clone for a dummy.");
      return null;
    }
    const folder = await getScratchFolder();
    const data = src.toObject();
    delete data._id;
    data.name = name;
    data.folder = folder.id;
    data.items = []; // a dummy needs no items — create empty (fast)
    dummy = await Actor.create(data);
  } else {
    const ids = dummy.items.map((i) => i.id);
    if (ids.length) await dummy.deleteEmbeddedDocuments("Item", ids);
  }
  if (!dummy) {
    ui.notifications?.error(`Test Battle: failed to create "${name}".`);
    return null;
  }

  // Override HP and rename the prototype token so copies read as the dummy,
  // not the source monster we cloned.
  await dummy.update({ "system.props.current_hp": MASSIVE_HP, "prototypeToken.name": name });
  // Best-effort max_hp bump (likely derived & ignored — harmless if so).
  try { await dummy.update({ "system.props.max_hp": MASSIVE_HP }); } catch (_e) {}
  // The "No Actions" AE is NOT baked in here. It's applied to the chosen enemy
  // (dummy OR real) only in solo mode ("Only main player acts"), so when that's
  // unchecked the dummy takes turns like any other unit. See launchTestBattle.
  log(`test-battle: dummy enemy "${name}" ready (current_hp=${MASSIVE_HP}, blank shell)`);
  return dummy;
}

// A clean PC shell — correct player template, valid stats, NO items. Instant to
// create (no bulk item write). Populate it with the "Add item" tool.
async function genCleanActor() {
  const name = "BD Clean Character";
  let actor = game.actors?.find((x) => x.name === name);
  if (!actor) {
    const base = pickBasePC();
    if (!base) { ui.notifications?.error("Test Battle: no base PC actor found to clone."); return null; }
    const folder = await getScratchFolder();
    const data = base.toObject();
    delete data._id; data.name = name; data.folder = folder.id; data.items = [];
    actor = await Actor.create(data);
  } else {
    const ids = actor.items.map((i) => i.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  }
  if (!actor) return null;
  try {
    const max = actor.system?.props?.max_hp;
    const upd = { "prototypeToken.name": name };
    if (max != null) upd["system.props.current_hp"] = max;
    await actor.update(upd);
  } catch (_e) {}
  return actor;
}

// ─── Add-item tool ──────────────────────────────────────────────────────
// Catalog of items worth dropping onto a test actor: BD skills (by class),
// basic weapons, basic shields, consumables. Each entry is tagged with a
// `type` so the tool can filter. One-at-a-time adds avoid the slow bulk write.
const ITEM_TYPES = [
  { value: "all", label: "All types" },
  { value: "skill", label: "🎓 Skills" },
  { value: "weapon", label: "⚔️ Weapons" },
  { value: "shield", label: "🛡️ Shields" },
  { value: "consumable", label: "⚗️ Consumables" },
];

function addableItems() {
  const out = [];
  for (const i of (game.items?.contents ?? [])) {
    const p = folderPathNames(i);
    if (p[0] === "Battle Director" && SKILL_LEAVES.has(p[p.length - 1])) out.push({ value: i.id, label: `🎓 ${p[1] ?? "?"} · ${i.name}`, type: "skill" });
    else if (p.includes("Basic Weapon")) out.push({ value: i.id, label: `⚔️ ${i.name}`, type: "weapon" });
    else if (p.includes("Basic Shield")) out.push({ value: i.id, label: `🛡️ ${i.name}`, type: "shield" });
    else if (i.system?.props?.item_type === "consumable" && p.some((s) => /consumable/i.test(s))) out.push({ value: i.id, label: `⚗️ ${i.name}`, type: "consumable" });
  }
  return out.sort((x, y) => x.label.localeCompare(y.label));
}

// Actors that make sense as add-item targets: live combatants + scratch actors.
function targetActorOptions() {
  const out = [];
  const seen = new Set();
  const push = (uuid, label) => { if (uuid && !seen.has(uuid)) { seen.add(uuid); out.push({ value: uuid, label }); } };
  const a = api();
  if (a?.isRunning?.()) for (const c of (a.listCombatants?.() ?? [])) push(c.actorUuid, `${c.name} (${c.side})`);
  const folder = game.folders?.find((f) => f.type === "Actor" && f.name === SCRATCH_FOLDER);
  if (folder) for (const x of (game.actors?.contents ?? [])) if (x.folder?.id === folder.id) push(x.uuid, x.name);
  return out;
}

async function addItemToActor(actorUuid, itemId) {
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  const item = itemId ? game.items?.get(itemId) : null;
  if (!actor || actor.documentName !== "Actor") return { ok: false, error: "actor not found" };
  if (!item) return { ok: false, error: "item not found" };
  const o = item.toObject(); delete o._id;
  const it = o.system?.props?.item_type;
  if (o.system?.props && (it === "weapon" || it === "shield" || it === "armor" || it === "accessory")) o.system.props.isEquipped = false;
  await actor.createEmbeddedDocuments("Item", [o]);
  return { ok: true, name: item.name, actor: actor.name };
}

// ─── Launch ─────────────────────────────────────────────────────────────

async function launchTestBattle({ playerActorUuid, enemyActorUuid, allyActorUuid, extraEnemies, soloPlayer = false }) {
  const a = api();
  if (!a?.start) { ui.notifications?.warn("Battle Director API not ready."); return; }
  if (a.isRunning?.()) {
    ui.notifications?.warn("A battle is already running — End Battle first.");
    return;
  }

  const scene = game.scenes?.find((s) => s.name === SCENE_NAME)
    ?? game.scenes?.active
    ?? canvas?.scene
    ?? null;
  if (!scene) { ui.notifications?.error("Test Battle: no scene available to launch on."); return; }
  if (scene.name !== SCENE_NAME) {
    ui.notifications?.info(`Test Battle: "${SCENE_NAME}" not found — using "${scene.name}".`);
  }

  const pc = playerActorUuid ? await fromUuid(playerActorUuid) : null;
  if (!pc) { ui.notifications?.error("Test Battle: no main player actor resolved."); return; }
  const enemy = enemyActorUuid ? await fromUuid(enemyActorUuid) : null;
  if (!enemy) { ui.notifications?.error("Test Battle: no main enemy actor resolved."); return; }

  const allyActor = allyActorUuid ? await fromUuid(allyActorUuid) : null;
  const members = [{ actorUuid: pc.uuid, actorId: pc.id, name: pc.name, slot: 1, img: pc.img }];
  if (allyActor) members.push({ actorUuid: allyActor.uuid, actorId: allyActor.id, name: allyActor.name, slot: 2, img: allyActor.img });

  // Solo mode ("Only main player acts"): give the non-player combatants 0 actions
  // via the No Actions AE — the chosen enemy (dummy OR real) and the ally. When
  // it's unchecked, nobody gets it, so every unit takes turns. Tracked so
  // live-added combatants get it too.
  _soloMode = !!soloPlayer;
  if (soloPlayer) {
    await applyNoActionsAE(enemy);
    if (allyActor) await applyNoActionsAE(allyActor);
  }

  const quantity = 1 + Math.max(0, Number(extraEnemies) | 0);
  const payload = {
    context: { battleSceneUuid: scene.uuid, sourceSceneId: scene.id, lean: true },
    encounterPlan: { mode: "manual", manualPicks: [{ actorUuid: enemy.uuid, name: enemy.name, quantity }] },
    party: { members },
  };

  log(`test-battle: launching — player=${pc.name} enemy=${enemy.name}×${quantity} ally=${allyActor ? "yes" : "no"} solo=${soloPlayer}`);
  try {
    await a.start({ payload });
    ui.notifications?.info("Test Battle launching (lean) on Training Ground.");
  } catch (e) {
    warn("test-battle: start threw", e);
    ui.notifications?.error(`Test Battle failed to start: ${e?.message ?? e}`);
  }
}

// ─── UI ─────────────────────────────────────────────────────────────────

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
#${PANEL_ID} {
  position: fixed; left: 16px; bottom: 70px; z-index: 100002; width: 300px;
  background: linear-gradient(180deg, rgba(24,26,32,.98), rgba(16,18,22,.98));
  color: #e8eaf0; border: 1px solid rgba(255,150,120,.32); border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,.6); padding: 12px; font: 12px "Signika", system-ui, sans-serif;
}
#${PANEL_ID} .tbt-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
#${PANEL_ID} .tbt-title { font-weight: 800; color: #ffcdb8; font-size: 13px; }
#${PANEL_ID} .tbt-close { cursor: pointer; opacity: .7; padding: 2px 6px; border-radius: 6px; }
#${PANEL_ID} .tbt-close:hover { opacity: 1; background: rgba(255,255,255,.08); }
#${PANEL_ID} .tbt-field { margin-bottom: 9px; }
#${PANEL_ID} .tbt-label { display: block; font-size: 10.5px; font-weight: 700; opacity: .75; margin-bottom: 3px; letter-spacing: .02em; text-transform: uppercase; }
#${PANEL_ID} select, #${PANEL_ID} input[type="number"] {
  width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px;
  background: #1b1e25; color: #e8eaf0; border: 1px solid rgba(255,255,255,.12); font: 12px "Signika", system-ui, sans-serif;
}
#${PANEL_ID} select option { background: #1b1e25; color: #e8eaf0; }
#${PANEL_ID} select:disabled { opacity: .55; }
#${PANEL_ID} .tbt-row { display: flex; gap: 6px; }
#${PANEL_ID} .tbt-row > * { flex: 1; min-width: 0; }
#${PANEL_ID} .tbt-launch {
  display: flex; align-items: center; justify-content: center; gap: 8px; padding: 9px 10px; margin-top: 12px; border-radius: 7px;
  cursor: pointer; font-weight: 800; border: 1px solid rgba(255,170,120,.4); background: rgba(255,140,90,.18); color: #ffe3d2;
  transition: filter .12s ease, background .12s ease;
}
#${PANEL_ID} .tbt-launch:hover { background: rgba(255,140,90,.3); filter: brightness(1.08); }
#${PANEL_ID} .tbt-launch.disabled { opacity: .5; pointer-events: none; }
#${PANEL_ID} .tbt-hint { opacity: .5; font-size: 10px; margin-top: 9px; text-align: center; }
#${PANEL_ID} input.tbt-num { width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px; background: #1b1e25; color: #e8eaf0; border: 1px solid rgba(255,255,255,.12); font: 12px "Signika", system-ui, sans-serif; }
#${PANEL_ID} select.tbt-num { width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px; background: #1b1e25; color: #e8eaf0; border: 1px solid rgba(255,255,255,.12); font: 12px "Signika", system-ui, sans-serif; }
#${PANEL_ID} select.tbt-num option { background: #1b1e25; color: #e8eaf0; }
#${PANEL_ID} .tbt-section { font-weight: 800; color: #cfe0ff; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; opacity: .8; margin: 12px 0 6px; }
#${PANEL_ID} .tbt-checkrow { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11.5px; cursor: pointer; user-select: none; }
#${PANEL_ID} .tbt-chk { width: 14px; height: 14px; accent-color: #ff9b6b; cursor: pointer; }
/* Searchable combobox */
#${PANEL_ID} .tbt-combo { position: relative; }
#${PANEL_ID} .tbt-combo-input { width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 6px; background: #1b1e25; color: #e8eaf0; border: 1px solid rgba(255,255,255,.12); font: 12px "Signika", system-ui, sans-serif; }
#${PANEL_ID} .tbt-combo-input:focus { outline: none; border-color: rgba(255,170,120,.6); }
#${PANEL_ID} .tbt-combo-list { position: absolute; left: 0; right: 0; top: 100%; z-index: 6; max-height: 190px; overflow-y: auto; margin-top: 3px; background: #15181f; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; box-shadow: 0 10px 24px rgba(0,0,0,.55); }
#${PANEL_ID} .tbt-combo-item { padding: 5px 9px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11.5px; }
#${PANEL_ID} .tbt-combo-item:hover { background: rgba(127,160,255,.2); }
#${PANEL_ID} .tbt-combo-empty { padding: 5px 9px; opacity: .5; font-size: 11.5px; }
/* Live roster */
#${PANEL_ID} .tbt-roster { display: flex; flex-direction: column; gap: 4px; }
#${PANEL_ID} .tbt-rrow { display: flex; align-items: center; gap: 7px; padding: 4px 7px; border-radius: 6px; background: rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.06); }
#${PANEL_ID} .tbt-rname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
#${PANEL_ID} .tbt-side-enemy { color: #ff9b9b; font-size: 10px; text-transform: uppercase; opacity: .85; }
#${PANEL_ID} .tbt-side-party { color: #9bd0ff; font-size: 10px; text-transform: uppercase; opacity: .85; }
#${PANEL_ID} .tbt-x { cursor: pointer; opacity: .55; padding: 0 3px; font-weight: 700; }
#${PANEL_ID} .tbt-x:hover { opacity: 1; color: #ff8080; }
#${PANEL_ID} .tbt-addrow { display: flex; gap: 6px; align-items: center; }
#${PANEL_ID} .tbt-addrow.tbt-addrow-end { justify-content: flex-end; }
#${PANEL_ID} .tbt-addrow .tbt-combo { flex: 1; min-width: 0; }
#${PANEL_ID} .tbt-addrow > select.tbt-num { flex: 1; min-width: 0; }
#${PANEL_ID} .tbt-mini { padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 700; white-space: nowrap; border: 1px solid rgba(255,170,120,.4); background: rgba(255,140,90,.16); color: #ffe3d2; }
#${PANEL_ID} .tbt-mini:hover { background: rgba(255,140,90,.28); }
#${PANEL_ID} .tbt-mini.disabled { opacity: .5; pointer-events: none; }
`.trim();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

function actorLabel(a) {
  const p = a?.system?.props ?? {};
  const hp = p.current_hp != null ? ` (${p.current_hp}/${p.max_hp ?? "?"} HP)` : "";
  return `${a.name}${hp}`;
}

function field(labelText, control) {
  const wrap = document.createElement("div");
  wrap.className = "tbt-field";
  if (labelText) {
    const lbl = document.createElement("label");
    lbl.className = "tbt-label";
    lbl.textContent = labelText;
    wrap.append(lbl);
  }
  wrap.append(control);
  return wrap;
}

// ── Source options (shared by launch + live-add) ────────────────────────
// A "source" is one searchable picker entry resolving to an actor uuid:
//   dummy            → generate a massive-HP dummy
//   class:<Class>    → generate a class test actor
//   uuid:<actorUuid> → an existing actor
function buildSourceOptions({ includeNone = false, includeDummy = false, includeClean = false, includeClasses = true, scope = "all" } = {}) {
  const actors = (game.actors?.contents ?? []).filter((a) => !inScratch(a));
  const pcs = actors.filter((a) => !isNPC(a));
  const npcs = actors.filter((a) => isNPC(a));
  const out = [];
  if (includeNone) out.push({ value: "", label: "(none)" });
  if (includeDummy) out.push({ value: "dummy", label: "🎯 Dummy (massive HP)" });
  if (includeClean) out.push({ value: "clean", label: "🧙 Clean character (no items)" });
  if (includeClasses) for (const c of implementedClasses()) out.push({ value: `class:${c}`, label: `🎓 Class: ${c}` });
  let list = scope === "pc" ? pcs : scope === "npc" ? npcs : actors;
  if (!list.length) list = actors; // permissive fallback
  for (const a of list) out.push({ value: `uuid:${a.uuid}`, label: actorLabel(a) });
  return out;
}

async function resolveSource(value, { liveAdd = false } = {}) {
  if (!value) return null;
  if (value === "dummy") return (await genDummyEnemy())?.uuid ?? null;
  if (value === "clean") return (await genCleanActor())?.uuid ?? null;
  // Mid-battle class adds skip basic gear (bulk item writes are slow live).
  if (value.startsWith("class:")) return (await genClassActor(value.slice(6), { withBasicGear: !liveAdd }))?.uuid ?? null;
  if (value.startsWith("uuid:")) return value.slice(5);
  return null;
}

// ── Searchable combobox ─────────────────────────────────────────────────
function makeCombo({ placeholder = "Search…", options = [], value = null } = {}) {
  const wrap = document.createElement("div"); wrap.className = "tbt-combo";
  const input = document.createElement("input"); input.type = "text"; input.className = "tbt-combo-input"; input.placeholder = placeholder;
  const list = document.createElement("div"); list.className = "tbt-combo-list"; list.style.display = "none";
  wrap.append(input, list);

  let opts = options.slice();
  let selected = null;

  const render = (filter = "") => {
    list.replaceChildren();
    const f = filter.trim().toLowerCase();
    const matches = opts.filter((o) => o.label.toLowerCase().includes(f)).slice(0, 80);
    if (!matches.length) {
      const e = document.createElement("div"); e.className = "tbt-combo-empty"; e.textContent = "no matches"; list.append(e);
    }
    for (const o of matches) {
      const item = document.createElement("div"); item.className = "tbt-combo-item"; item.textContent = o.label;
      item.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(o); });
      list.append(item);
    }
  };
  const show = () => { list.style.display = "block"; };
  const hide = () => { list.style.display = "none"; };
  const pick = (o) => { selected = o; input.value = o.label; input.dataset.value = o.value; hide(); };

  input.addEventListener("focus", () => { render(""); show(); });
  input.addEventListener("input", () => { selected = null; delete input.dataset.value; render(input.value); show(); });
  input.addEventListener("blur", () => setTimeout(hide, 130));

  const apiObj = {
    el: wrap,
    getValue: () => selected?.value ?? null,
    setOptions: (n) => { opts = (n ?? []).slice(); },
    setValue: (v) => { const o = opts.find((x) => x.value === v); if (o) { selected = o; input.value = o.label; } },
    clear: () => { selected = null; input.value = ""; },
  };
  if (value != null) apiObj.setValue(value);
  return apiObj;
}

function mkButton(cls, text, onClick) {
  const b = document.createElement("div"); b.className = cls; b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function sectionLabel(text) {
  const d = document.createElement("div"); d.className = "tbt-section"; d.textContent = text; return d;
}

// ── Setup view (no battle running) ──────────────────────────────────────
function renderSetup(body) {
  const classes = implementedClasses();
  const playerCombo = makeCombo({ placeholder: "Search player / class / clean…", options: buildSourceOptions({ scope: "pc", includeClean: true }), value: classes.length ? `class:${classes[0]}` : null });
  const enemyCombo = makeCombo({ placeholder: "Search enemy / dummy…", options: buildSourceOptions({ scope: "npc", includeDummy: true }), value: "dummy" });
  const allyCombo = makeCombo({ placeholder: "Search ally…", options: buildSourceOptions({ scope: "all", includeNone: true, includeClean: true }), value: "" });

  const extra = document.createElement("input"); extra.type = "number"; extra.min = "0"; extra.value = "0"; extra.className = "tbt-num";

  const soloChk = document.createElement("input"); soloChk.type = "checkbox"; soloChk.checked = true; soloChk.className = "tbt-chk";
  const soloRow = document.createElement("label"); soloRow.className = "tbt-checkrow";
  soloRow.append(soloChk, document.createTextNode(" Only main player acts (others get 0 turns)"));

  const launch = document.createElement("div");
  launch.className = "tbt-launch";
  launch.innerHTML = `<span>▶</span><span>Launch Test Battle</span>`;
  launch.addEventListener("click", async () => {
    if (launch.classList.contains("disabled")) return;
    launch.classList.add("disabled");
    const lbl = launch.querySelector("span:last-child"); lbl.textContent = "Launching…";
    try {
      const playerActorUuid = await resolveSource(playerCombo.getValue());
      const enemyActorUuid = await resolveSource(enemyCombo.getValue());
      const allyActorUuid = await resolveSource(allyCombo.getValue());
      if (!playerActorUuid) { ui.notifications?.warn("Test Battle: pick a main player."); throw new Error("no player"); }
      if (!enemyActorUuid) { ui.notifications?.warn("Test Battle: pick a main enemy."); throw new Error("no enemy"); }
      await launchTestBattle({ playerActorUuid, enemyActorUuid, allyActorUuid, extraEnemies: extra.value, soloPlayer: soloChk.checked });
      return; // the roster view will render on fu-director-started
    } catch (e) {
      if (!/no (player|enemy)/.test(String(e?.message))) warn("test-battle: launch threw", e);
    }
    launch.classList.remove("disabled"); lbl.textContent = "Launch Test Battle";
  });

  const hint = document.createElement("div"); hint.className = "tbt-hint";
  hint.textContent = "Lean launch on Training Ground — no cinematics.";

  body.append(
    field("Main player", playerCombo.el),
    field("Main enemy", enemyCombo.el),
    field("Ally (optional)", allyCombo.el),
    field("Extra enemies (AOE)", extra),
    soloRow,
    launch,
    hint,
  );
  renderItemTool(body);
}

// ── Live view (battle running) ──────────────────────────────────────────
function renderLive(body) {
  const a = api();
  try { a?.pruneGhostCombatants?.(); } catch (_e) {} // drop tokenless ghosts on open
  const roster = a?.listCombatants?.() ?? [];

  body.append(sectionLabel("Combatants"));
  const list = document.createElement("div"); list.className = "tbt-roster";
  if (!roster.length) {
    const e = document.createElement("div"); e.className = "tbt-hint"; e.textContent = "(none)"; list.append(e);
  }
  for (const c of roster) {
    const row = document.createElement("div"); row.className = "tbt-rrow";
    const nm = document.createElement("span"); nm.className = "tbt-rname";
    nm.textContent = (c.isCurrent ? "▶ " : "") + c.name + (c.defeated ? " 💀" : "") + (c.hasToken === false ? " ⚠" : "");
    if (c.hasToken === false) { row.title = "No token on canvas (ghost) — ✕ to remove"; nm.style.opacity = ".6"; }
    const sd = document.createElement("span"); sd.className = c.side === "enemy" ? "tbt-side-enemy" : "tbt-side-party";
    sd.textContent = c.side === "enemy" ? "enemy" : "party";
    const x = document.createElement("span"); x.className = "tbt-x"; x.textContent = "✕"; x.title = "Remove combatant";
    x.addEventListener("click", async () => {
      const res = await a.removeCombatant?.({ combatantId: c.id });
      if (res && res.ok === false) ui.notifications?.warn(`Remove: ${res.error}`);
    });
    row.append(nm, sd, x);
    list.append(row);
  }
  body.append(list);

  // Add / switch row
  body.append(sectionLabel("Add combatant"));
  const sideSel = document.createElement("select"); sideSel.className = "tbt-num";
  const oP = document.createElement("option"); oP.value = "party"; oP.textContent = "Ally";
  const oE = document.createElement("option"); oE.value = "enemy"; oE.textContent = "Enemy";
  sideSel.append(oE, oP);
  const srcCombo = makeCombo({ placeholder: "Search actor / class / dummy / clean…", options: buildSourceOptions({ includeDummy: true, includeClean: true, scope: "all" }) });

  const addBtn = mkButton("tbt-mini", "+ Add", async () => {
    if (addBtn.classList.contains("disabled")) return;
    addBtn.classList.add("disabled"); addBtn.textContent = "Adding…";
    try {
      const actorUuid = await resolveSource(srcCombo.getValue(), { liveAdd: true });
      if (!actorUuid) ui.notifications?.warn("Pick a source to add.");
      else {
        // Solo mode: a live-added combatant is non-player → 0 actions too.
        if (_soloMode) { try { await applyNoActionsAE(await fromUuid(actorUuid)); } catch (_e) {} }
        const res = await a.addCombatant?.({ actorUuid, side: sideSel.value });
        if (res && res.ok === false) ui.notifications?.warn(`Add: ${res.error}`);
        else srcCombo.clear();
      }
    } catch (e) { warn("live add threw", e); ui.notifications?.error(`Add failed: ${e?.message ?? e}`); }
    addBtn.classList.remove("disabled"); addBtn.textContent = "+ Add";
  });

  // Source picker on its own full-width row; disposition + Add below.
  body.append(field("", srcCombo.el));
  const ctlRow = document.createElement("div"); ctlRow.className = "tbt-addrow";
  ctlRow.append(sideSel, addBtn);
  body.append(ctlRow);

  const hint = document.createElement("div"); hint.className = "tbt-hint";
  hint.textContent = "Switch = remove one (✕) then add another.";
  body.append(hint);

  renderItemTool(body);
}

// ── Add-item tool (works pre- and mid-battle) ───────────────────────────
// One item at a time onto a chosen actor — avoids the slow bulk write.
function renderItemTool(body) {
  body.append(sectionLabel("Add item to actor"));
  const targetCombo = makeCombo({ placeholder: "Target actor…", options: targetActorOptions() });

  const allItems = addableItems();
  const itemsForType = (t) => (t === "all" ? allItems : allItems.filter((i) => i.type === t));

  const typeSel = document.createElement("select"); typeSel.className = "tbt-num";
  for (const t of ITEM_TYPES) { const o = document.createElement("option"); o.value = t.value; o.textContent = t.label; typeSel.append(o); }

  const itemCombo = makeCombo({ placeholder: "Search item…", options: allItems });
  typeSel.addEventListener("change", () => { itemCombo.setOptions(itemsForType(typeSel.value)); itemCombo.clear(); });

  const btn = mkButton("tbt-mini", "+ Item", async () => {
    if (btn.classList.contains("disabled")) return;
    btn.classList.add("disabled"); btn.textContent = "Adding…";
    try {
      const res = await addItemToActor(targetCombo.getValue(), itemCombo.getValue());
      if (!res?.ok) ui.notifications?.warn(`Add item: ${res?.error ?? "pick a target + item"}`);
      else { ui.notifications?.info(`Added ${res.name} → ${res.actor}`); itemCombo.clear(); }
    } catch (e) { warn("add item threw", e); ui.notifications?.error(`Add item failed: ${e?.message ?? e}`); }
    btn.classList.remove("disabled"); btn.textContent = "+ Item";
  });

  body.append(field("Target", targetCombo.el));
  body.append(field("Item type", typeSel));
  body.append(field("Item", itemCombo.el));
  const row = document.createElement("div"); row.className = "tbt-addrow tbt-addrow-end";
  row.append(btn);
  body.append(row);
}

function renderBody(body) {
  body.replaceChildren();
  if (api()?.isRunning?.()) renderLive(body);
  else renderSetup(body);
}

function openPanel() {
  document.getElementById(PANEL_ID)?.remove();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  try { panel.style.bottom = `${devToolsAnchorBottom()}px`; } catch (_e) {}
  try { panel.style.left = `${devToolsAnchorLeft()}px`; } catch (_e) {}

  const head = document.createElement("div"); head.className = "tbt-head";
  const title = document.createElement("div"); title.className = "tbt-title"; title.textContent = "⚔️ Test Battle";
  const close = document.createElement("div"); close.className = "tbt-close"; close.textContent = "✕";
  head.append(title, close);

  const body = document.createElement("div"); body.className = "tbt-body";
  panel.append(head, body);
  document.body.appendChild(panel);

  let lastRunning = !!api()?.isRunning?.();
  renderBody(body);

  const refresh = () => {
    if (!document.body.contains(panel)) return;
    renderBody(body);
    lastRunning = !!api()?.isRunning?.();
  };
  // Roster/stop changes re-render immediately. The Setup→Live transition,
  // though, happens at the END of PREP (dCombat built) — well after the
  // fu-director-started hook fires — so we also poll the running-state and
  // re-render only when it actually flips (no disruption mid-steady-state).
  const hooks = [
    ["fu-director-stopped", Hooks.on("fu-director-stopped", refresh)],
    ["fu-director-roster-changed", Hooks.on("fu-director-roster-changed", refresh)],
  ];
  const tick = setInterval(() => {
    if (!document.body.contains(panel)) { clearInterval(tick); return; }
    if (!!api()?.isRunning?.() !== lastRunning) refresh();
  }, 1000);

  close.addEventListener("click", () => {
    clearInterval(tick);
    for (const [name, id] of hooks) { try { Hooks.off(name, id); } catch (_e) {} }
    panel.remove();
  });
}
