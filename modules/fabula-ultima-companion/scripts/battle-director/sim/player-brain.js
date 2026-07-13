// Player Brain — decides a turn for a combatant with no Action Pattern (the PCs).
//
// Enemies think with ActionReader because they carry an `action_pattern_table`
// prop. PCs don't have one, so their ActionReader run yields nothing and the
// autopilot would hand back to the manual menu — which, with nobody at the
// keyboard, is a hang. This is what answers instead.
//
// The design: rather than write a bespoke AI, we feed the SAME ActionReader
// pipeline a rotation table injected from a profile ([[profiles.js]]). The
// injection point is `actorData.actionPatternRowsRaw` — the exact field
// readPatternTable reads — so the party inherits cost feasibility, affinity
// targeting, anti-repeat and debuff gating with ZERO changes to the action-reader.
//
// Decision order, each step falling through to the next:
//   1. profile.policy()  — pre-emptive code decisions (heal a dying ally). The
//                          rotation table cannot express these: every condition
//                          the engine supports is self-referential, so "an ally is
//                          hurt" is unsayable as a row.
//   2. rotation          — the profile's rows, through ActionReader.
//   3. basic attack      — affinity-aware: never swing an element the target
//                          ABSORBS, prefer one it is VULNERABLE to.
//   4. null              — caller (enemy-autopilot) terminally falls back to Guard.
//
// See [[project_action_pattern_ai]] and [[project_enemy_autopilot]].

import { log, warn } from "../logger.js";
import { profileFor, mpItemPolicy, hpItemPolicy, revivePolicy, refreshFocus, TUNING } from "./profiles.js";
import { SimMode } from "./sim-mode.js";
import { Journal } from "./sim-journal.js";
import { canAffordItem, parseCost } from "./cost.js";
import { protectExhausted } from "./reaction-brain.js";
import { resolveAttackerWeapon, resolveVirtualAttacks, resolvePrimaryAttackWeapon } from "../snapshot.js";

import { ActionReaderCore as AR } from "../../action-reader/actionReader-core.js";
import { resolveActionReaderPerformer } from "../../action-reader/actionReader-resolvePerformer.js";
import { buildActionReaderContext } from "../../action-reader/actionReader-buildContext.js";
import { readActionReaderPatternTable } from "../../action-reader/actionReader-readPatternTable.js";
import { evaluateActionReaderConditions } from "../../action-reader/actionReader-evaluateConditions.js";
import { matchAndPickActionReaderAction } from "../../action-reader/actionReader-matchAndPickAction.js";
import { parseActionReaderTargetRule } from "../../action-reader/actionReader-parseTargetRule.js";
import { buildAndPickActionReaderTargets } from "../../action-reader/actionReader-buildAndPickTargets.js";

// ── Board access ────────────────────────────────────────────────────────────
function selfCombatant(director, snap) {
  return director?.dCombat?.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;
}

// A summoned unit — a phantasm, a construct, a temporary body. Disposable by
// design: it exists to soak a hit or add an attack and then go away. Healing it,
// buffing it or stepping in front of it is a wasted turn, so it is excluded from
// every SUPPORT decision (heal / revive / Acceleration / Protect) while still
// counting as a combatant that fights and can be looked at.
export function isSummon(actorDoc) {
  const v = actorDoc?.system?.props?.isSummon;
  return v === true || v === "true" || v === 1 || v === "1";
}

function sides(director, snap) {
  const dc = director?.dCombat;
  const mine = selfCombatant(director, snap)?.side ?? "party";
  const all = (dc?.combatants ?? []).filter((c) => !c.isDefeatedLive?.());
  const allies = all.filter((c) => c.side === mine);
  return {
    // `allies` is the SUPPORT-eligible list — real party members. Summons are
    // deliberately absent: the party does not spend its healing on something that is
    // meant to be spent.
    allies: allies.filter((c) => !isSummon(c.actorDoc)),
    // …but some decisions need the whole side (Keren checking whether her phantasm is
    // on the field, for one — it's a summon, and that's the point).
    alliesAll: allies,
    foes: all.filter((c) => c.side !== mine),
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const hpOf = (dc) => num(dc?.actorDoc?.system?.props?.current_hp) ?? Infinity;
const tokenUuidOf = (dc) => dc?.tokenUuid ?? dc?.tokenDoc?.uuid ?? null;

// ── How does this character actually SWING? ─────────────────────────────────
// Not everyone attacks with a weapon in their main hand.
//
// Blanche has Dual Shieldbearer: two shields, no weapon, and the engine grants her a
// VIRTUAL attack ("Twin Shields", Brawling) instead. The skill itself has no
// automation — it is pure descriptive text — so nothing about her sheet says "main
// hand" is unusable. `main_hand` reads "+4 Titanic Shield", which is a perfectly
// non-empty string, so the old check happily emitted attackMode "main"... and TARGET
// then found no weapon behind it and aborted the action with "no weapon detected".
// She was throwing away her turn every time she tried to attack.
//
// So ask the ENGINE what she can swing with, using the same resolvers TARGET uses,
// rather than guessing from a prop:
//     main weapon      → "main"
//     off-hand only    → "off"
//     virtual attack   → "virtual:N"   (Blanche's Twin Shields)
//     nothing at all   → null → Guard
function resolveAttackMode(actorDoc) {
  try {
    if (resolveAttackerWeapon(actorDoc, { which: "main" })) return "main";
    if (resolveAttackerWeapon(actorDoc, { which: "off" })) return "off";
    const virtual = resolveVirtualAttacks(actorDoc);
    if (virtual?.length) return "virtual:0";
  } catch (e) {
    warn(`[SIM] resolveAttackMode threw for ${actorDoc?.name}`, e);
  }
  return null;
}

// The element the swing will actually carry — read off the resolved weapon (virtual
// included), not the weapon1_damagetype prop, which is meaningless for a virtual attack.
function attackElement(actorDoc) {
  try {
    const w = resolvePrimaryAttackWeapon(actorDoc);
    const el = w?.damageType ?? actorDoc?.system?.props?.weapon1_damagetype;
    return String(el ?? "").trim().toLowerCase();
  } catch { return ""; }
}

// ── Is this an AUGMENT rather than an action? ────────────────────────────────
// Three times now a profile has tried to "cast" something that is not castable.
// Zarg's Barrage, Warning Shot and High Speed, and his Gadgets, are all AUGMENTS:
// they carry a reaction trigger and fire ON another action (or at conflict start),
// buffing it. Declaring one as a turn action burns the turn and does nothing — the
// exact symptom of "Zarg keeps casting Barrage and never attacks".
//
// The tell is structural, not a name list: a trigger-driven skill with NO target
// has nothing to be cast AT. A real castable skill always names a target ("Self",
// "One Enemy", "Up to three creatures"). So encode the rule once, here, and the
// next augment somebody adds can't fool a rotation either.
function isAugment(item) {
  const p = item?.system?.props ?? {};
  const target = String(p.skill_target ?? "").trim();
  if (target && target !== "-") return false;   // it has something to aim at → castable

  const rc = p.reaction_config_table;
  const rows = Array.isArray(rc) ? rc : Object.values(rc ?? {});
  return rows.some((r) => String(r?.reaction_trigger ?? "").trim() !== "");
}

// ── Does this item restore <resource>? ───────────────────────────────────────
// Identified by what it DOES, not what it's called — and the world uses TWO
// authoring styles for the same idea, so both are checked:
//
//   A) an effect_table grant row   — Apple Juice: { grant_resource:"hp", amount:30 }
//   B) type_damage names the pool  — Elixir: { type_damage:"MP", damage_bonus:50 }
//
// Matching on behaviour means Elixir, Grape Juice, Apple Juice and anything added
// later are all found automatically, with no name list to fall out of date.
//
// HOW MUCH does it restore? 0 = it doesn't. Used to pick the BIGGEST heal rather
// than the cheapest one — Zarg was reaching for a 30 HP Apple Juice when a 50 HP
// Elixir was one IP away, which wastes the turn as surely as not healing at all.
function itemRestoreAmount(item, resource) {
  const p = item?.system?.props ?? {};
  const want = String(resource).toLowerCase();

  const et = p.effect_table;
  const rows = Array.isArray(et) ? et : Object.values(et ?? {});
  const granted = rows
    .filter((r) =>
      String(r?.effect_kind ?? "").toLowerCase() === "grant"
      && String(r?.grant_resource ?? "").toLowerCase() === want
    )
    .reduce((max, r) => Math.max(max, Number(r?.grant_amount ?? 0) || 0), 0);
  if (granted > 0) return granted;

  // The other authoring style: type_damage names the pool, damage_bonus is the size.
  const td = String(p.type_damage ?? "").trim().toLowerCase();
  const matches = want === "mp" ? td === "mp" : (td === "hp" || td === "healing" || td === "heal");
  if (!matches) return 0;
  return Number(p.damage_bonus ?? 0) || 0;
}

const itemRestores = (item, resource) => itemRestoreAmount(item, resource) > 0;

// ── IP reserve ───────────────────────────────────────────────────────────────
// How much IP must this character keep in hand for their own attacks?
//
// IP is contested: it buys potions (Elixir 2 IP, Apple Juice 1 IP) AND it pays for
// damage augments (Zarg's Gadgets, 2 IP a shot). Zarg is the party's potion caddy, so
// he spent himself down to 0 IP buying Elixirs and then — silently — never infused
// another arrow for the rest of the fight. His own damage was being starved by his
// medic duties, and the transcript said so in as many words:
//     "Gadgets: holds Gadgets — only 0 IP left"
//
// So anyone who owns an IP-priced AUGMENT keeps a working reserve. Nobody else hoards:
// a character with no IP augment has nothing to save it for.
function reservedIpFor(actorDoc) {
  const hasIpAugment = (actorDoc?.items ?? []).some((item) => {
    if (!isAugment(item)) return false;
    return /\bip\b/i.test(String(item?.system?.props?.cost ?? ""));
  });
  return hasIpAugment ? TUNING.itemIpReserve : 0;
}

// The BIGGEST-healing consumable the actor is carrying (stock-limited; using it
// spends one). Distinct from a CREATABLE, which anyone can conjure by paying IP.
function findConsumableRestoring(actorDoc, resource) {
  let best = null;
  let bestAmt = 0;
  for (const item of actorDoc?.items ?? []) {
    const p = item?.system?.props ?? {};
    if (String(p.item_type ?? "").toLowerCase() !== "consumable") continue;
    if (Number(p.item_quantity ?? p.quantity ?? 0) <= 0) continue;
    const amt = itemRestoreAmount(item, resource);
    if (amt > bestAmt) { best = item; bestAmt = amt; }
  }
  return best;
}

// ── How many creatures can this weapon hit? ──────────────────────────────────
// Zarg's bow reads "Up to two creatures" — so every turn he spent shooting ONE
// enemy, he was throwing away half his output. A weapon's reach is authored on the
// item's skill_target, so read it instead of assuming everything is single-target.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

function weaponTargetCap(actorDoc) {
  const p = actorDoc?.system?.props ?? {};
  const hand = String(p.main_hand ?? "").trim().toLowerCase();
  if (!hand) return 1;

  const weapon = (actorDoc?.items ?? []).find(
    (i) => String(i.name ?? "").trim().toLowerCase() === hand
  );
  const text = String(weapon?.system?.props?.skill_target ?? "").trim().toLowerCase();
  if (!text) return 1;

  const m = text.match(/(?:up to\s+)?(\d+|one|two|three|four|five|six)\b/);
  if (!m) return 1;
  const n = NUM_WORDS[m[1]] ?? Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ── Affinity-aware target choice for the BASIC ATTACK ────────────────────────
// The first live run had the party plinking a boss with no regard for what it was
// immune to. A basic attack carries the weapon's damage type, so score every
// living foe by how that element lands, and break ties by who is closest to dying.
const AFFINITY_SCORE = { VU: 3, NA: 1, RS: 0.4, IM: 0, AB: -5 };

// Returns up to `cap` targets, best first. The party's called target leads (unless
// swinging at it would feed an absorb — then peel off), and any remaining swings go
// to the next best foes rather than being wasted.
function bestAttackTargets(actorDoc, foes, focusUuid = null, cap = 1) {
  const element = attackElement(actorDoc);

  const scored = foes.map((dc) => {
    // getAffinityForType takes the ACTOR (it resolves the map itself) and
    // normalizes the damage type for us.
    let aff = "NA";
    try {
      if (element) aff = AR.getAffinityForType(dc.actorDoc, element) ?? "NA";
    } catch { /* unknown element → treat as neutral */ }
    const affScore = AFFINITY_SCORE[String(aff).toUpperCase()] ?? 1;
    return { dc, aff: String(aff).toUpperCase(), affScore, hp: hpOf(dc) };
  });

  // Prefer anything we don't actively feed. Only if EVERY foe absorbs/ignores our
  // element do we accept the least-bad one — swinging is still better than idling.
  const viable = scored.filter((s) => s.affScore > 0);
  const pool = (viable.length ? viable : scored).slice();
  pool.sort((a, b) => (b.affScore - a.affScore) || (a.hp - b.hp));

  const out = [];
  const called = focusUuid ? pool.find((s) => s.dc.tokenUuid === focusUuid) : null;
  if (called) out.push(called);   // the call leads; it's already filtered for absorbs
  for (const s of pool) {
    if (out.length >= cap) break;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// ── Bundle builders (PC shapes) ──────────────────────────────────────────────
// A PC weapon attack is `attackMode: "main"` with NO item uuid — TARGET derives
// the weapon from the equipped hand. (An NPC attack is the other shape entirely:
// attackMode "npc" + npcAttackItemUuid. Don't cross the two.)
const attackBundle = (targetUuids, attackMode = "main") => ({ command: "Attack", attackMode, targetUuids });

function castBundle(item, targetUuids) {
  const st = String(item?.system?.props?.skill_type ?? "").trim().toLowerCase();
  const command = st === "spell" ? "Spell" : "Skill";
  // `_name` is carried for the re-declare guard + transcript. applyComposedBundle
  // ignores unknown keys, so it costs nothing downstream.
  return { command, skillUuid: item.uuid, sourceItemUuid: item.uuid, targetUuids, _name: item.name };
}

// ── Creatable items (the IP economy) ─────────────────────────────────────────
// The other half of "using an item", and the half that matters most: EVERYONE can
// spend IP to conjure Elixir / Remedy / Tonic / Apple Juice / Elemental Shard on
// the spot. Unlike a consumable there is no stock to run out of — the limit is IP —
// so this is the party's real answer to running dry, and it does not depend on who
// happens to be carrying what.
//
// gatherCreatables is async and the policies are sync, so the list is fetched once
// per turn and handed to them already resolved.
async function fetchCreatables(actorDoc) {
  try {
    const { gatherCreatables } = await import("../item-resource.js");
    const list = await gatherCreatables(actorDoc);
    const out = [];
    for (const c of list ?? []) {
      if (!c?.itemUuid) continue;
      const doc = await fromUuid(c.itemUuid).catch(() => null);
      if (!doc) continue;
      out.push({
        key: c.key,
        name: c.name,
        ipCost: Number(c.ipCost ?? 0) || 0,
        itemUuid: c.itemUuid,
        doc,
        // The consumable is just a carrier; its linked activation skill holds the
        // real targeting/effect (composeItem resolves the same field).
        linkedSkillUuid: doc.system?.props?.item_skill_active || null,
      });
    }
    return out;
  } catch (e) {
    warn("[SIM] fetchCreatables threw", e);
    return [];
  }
}

// ── The policy API handed to profile.policy() ────────────────────────────────
function makePolicyApi(director, snap, self, creatables = []) {
  const { allies, alliesAll, foes } = sides(director, snap);
  return {
    self: self?.actorDoc ?? null,
    round: director?.dCombat?.round ?? 0,
    allies: () => allies,            // support-eligible: summons excluded
    alliesAll: () => alliesAll,      // the whole side, summons included
    foes: () => foes,

    findItem(name) {
      const want = String(name).trim().toLowerCase();
      return self?.actorDoc?.items?.find?.((i) => String(i.name).trim().toLowerCase() === want) ?? null;
    },

    // This character's Zero Power. Identified by the item's own isZeroPower flag
    // (with a name fallback), so it works for anyone without a per-character list.
    findZeroPower() {
      return self?.actorDoc?.items?.find?.((i) => {
        const p = i?.system?.props ?? {};
        return p.isZeroPower === true || /^zero power\b/i.test(String(i.name ?? ""));
      }) ?? null;
    },

    castOn(item, targetDcs) {
      const uuids = targetDcs.map(tokenUuidOf).filter(Boolean);
      if (!item || !uuids.length) return null;
      // An augment fires ON an action; it cannot BE one. Same guard as the
      // rotation, so a hand-written policy can't make this mistake either.
      if (isAugment(item)) {
        warn(`[SIM] policy tried to cast the augment "${item.name}" — that is a reaction, not a turn action`);
        return null;
      }
      // Only offer an action we can actually pay for — feasibility upstream can't
      // price custom resources (see cost.js).
      if (!canAffordItem(self?.actorDoc, item).ok) return null;
      return castBundle(item, uuids);
    },

    // A combatant's affinity to an element ("VU"/"RS"/"IM"/"AB"/"NA").
    affinityOf(dc, element) {
      try { return String(AR.getAffinityForType(dc?.actorDoc, element) ?? "NA").toUpperCase(); }
      catch { return "NA"; }
    },

    // Does this combatant currently carry an Active Effect matching `re`?
    hasAe(dc, re) {
      const effects = dc?.actorDoc?.effects ?? [];
      for (const e of effects) {
        if (e?.disabled) continue;
        if (re.test(String(e?.name ?? ""))) return true;
      }
      return false;
    },

    // ── The two ways to use an item ────────────────────────────────────────
    // CREATE: pay IP, conjure it now. Universal — everyone can do this, and there
    // is no stock to exhaust. This is the party's real economy.
    findCreatableRestoring(resource) {
      const ip = Number(self?.actorDoc?.system?.props?.current_ip ?? 0) || 0;
      // Don't spend the last of the IP on potions if this character's DAMAGE rides on
      // it. Zarg is the party's potion caddy AND his shots are augmented by Gadgets
      // (2 IP each) — so he was buying Elixirs until he hit 0 IP and then quietly
      // never infused another arrow. A real player keeps enough back to keep swinging.
      const spendable = ip - reservedIpFor(self?.actorDoc);
      return creatables
        .filter((c) => c.ipCost <= spendable && itemRestores(c.doc, resource))
        // BIGGEST heal first, not cheapest. A turn spent restoring 30 HP when 50 was
        // affordable is a turn half-wasted; IP is only a tiebreak.
        .sort((a, b) =>
          itemRestoreAmount(b.doc, resource) - itemRestoreAmount(a.doc, resource)
          || a.ipCost - b.ipCost
        )[0] ?? null;
    },

    // USE: spend one from the pack. Stock-limited, classic JRPG style.
    findConsumableRestoring(resource) { return findConsumableRestoring(self?.actorDoc, resource); },
    allyCanRestore(dc, resource) {
      const ip = Number(dc?.actorDoc?.system?.props?.current_ip ?? 0) || 0;
      // A rough read for "could they do this job?" — we only have OUR creatables
      // list, but the recipe set is party-wide, so IP is the real gate.
      return ip >= 2 || !!findConsumableRestoring(dc?.actorDoc, resource);
    },

    // A consumable I hold, by name, with stock left. (Phoenix Feather — unlike an
    // MP potion there is no effect signature to match on, since "revive" is the
    // item's own logic, so this one is by name.)
    findItemByName(re) {
      for (const item of self?.actorDoc?.items ?? []) {
        const p = item?.system?.props ?? {};
        if (String(p.item_type ?? "").toLowerCase() !== "consumable") continue;
        if (Number(p.item_quantity ?? p.quantity ?? 0) <= 0) continue;
        if (re.test(item.name ?? "")) return item;
      }
      return null;
    },

    // Downed allies. sides() filters the defeated out (they can't act), but a KO'd
    // PC stays ON the field — defeat-reactor only removes enemies — so they remain
    // targetable, which is what makes a revive possible at all.
    koAllies() {
      const dc = director?.dCombat;
      const mine = selfCombatant(director, snap)?.side ?? "party";
      return (dc?.combatants ?? []).filter((c) => c.side === mine && c.isDefeatedLive?.() && !isSummon(c.actorDoc));
    },

    // USE a consumable from the pack — it is spent. Mirrors the item-picker's "use"
    // row: key = the item's id, cost 0.
    useItem(item, targetDcs) {
      const uuids = targetDcs.map(tokenUuidOf).filter(Boolean);
      if (!item || !uuids.length) return null;
      return {
        command: "Item",
        skillUuid: item.uuid,
        sourceItemUuid: item.uuid,
        linkedSkillUuid: item.system?.props?.item_skill_active || null,
        itemMode: "use",
        itemKey: item.id,
        itemCost: 0,
        targetUuids: uuids,
        _name: item.name,
      };
    },

    // CREATE it on the spot, paying IP. Mirrors the item-picker's "create" row:
    // key = the recipe key, cost = its IP price (state-handlers charges it).
    createItem(candidate, targetDcs) {
      const uuids = targetDcs.map(tokenUuidOf).filter(Boolean);
      if (!candidate || !uuids.length) return null;
      return {
        command: "Item",
        skillUuid: candidate.itemUuid,
        sourceItemUuid: candidate.itemUuid,
        linkedSkillUuid: candidate.linkedSkillUuid,
        itemMode: "create",
        itemKey: candidate.key,
        itemCost: candidate.ipCost,
        targetUuids: uuids,
        _name: candidate.name,
      };
    },

    budgetSpent(round, key) { return SimMode.spent(round, key); },
    spendBudget(round, key) { SimMode.spend(round, key); },

    // The party's called target — shared across all four brains.
    focusUuid() { return SimMode.focus(); },
    setFocus(uuid) { SimMode.setFocus(uuid); },

    // Down to the last enemy? Then the action-economy war is already won: four
    // actions against one. The fight is about closing it out safely, not racing.
    isEndgame() { return foes.length <= 1; },

    // Pre-answer the menu this action is about to open (Zarg's Gadgets element).
    // Consumed once, by the next picker.
    hintPick(hint) { SimMode.setPickHint(hint); },

    // Has the party's defensive answer already been spent this round? Hina's heal
    // is explicitly gated on this.
    protectExhausted(round) { return protectExhausted(round); },
  };
}

// ── Spending a FREE ACTION (Acceleration's charges) ─────────────────────────
// Acceleration hands its holder an AE with 2 charges and a `turn_end` reaction that
// grants a free action — "Attack,Spell", with the spell capped at max_mp_cost 10.
//
// The brain used to run its whole normal policy chain here, which is wrong twice: it
// would happily pick a heal or a utility spell (wasting a free damage action), and it
// had no idea about the MP CAP, so it would offer Iceberg (20 MP) into a 10 MP window,
// have the declaration bounce, and eventually Guard away the free turn entirely.
//
// A free action is a gift. Spend it on damage: the best damaging spell that fits under
// the cap, and failing that, a swing. (User's rule.)
function bestDamagingSpell(api, actorDoc, foes, maxMpCost) {
  const cap = Number.isFinite(Number(maxMpCost)) ? Number(maxMpCost) : Infinity;

  const candidates = [];
  for (const item of actorDoc?.items ?? []) {
    const p = item?.system?.props ?? {};
    if (String(p.skill_type ?? "").trim().toLowerCase() !== "spell") continue;

    // Must actually deal damage — a heal is not what a free action is for.
    const el = String(p.type_damage ?? "").trim().toLowerCase();
    if (!el || ["healing", "heal", "hp", "mp"].includes(el)) continue;

    const cost = parseCost(p.cost);
    if (!cost.free && cost.resource === "mp" && cost.amount > cap) continue;   // over the cap
    if (!canAffordItem(actorDoc, item).ok) continue;

    // Who does this land hardest on? A vulnerable target is worth more than a big spell.
    const vu = foes.find((f) => api.affinityOf(f, el) === "VU") ?? null;
    const usable = foes.filter((f) => !["IM", "AB"].includes(api.affinityOf(f, el)));
    if (!usable.length) continue;

    candidates.push({
      item,
      element: el,
      target: vu ?? usable.find((f) => f.tokenUuid === api.focusUuid()) ?? usable[0],
      vu: vu ? 1 : 0,
      power: cost.amount || 0,   // a pricier spell is a bigger spell, near enough
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.vu - a.vu) || (b.power - a.power));
  const best = candidates[0];
  return api.castOn(best.item, [best.target]);
}

// A free action that grants a SKILL (Blanche's Counter Pass, Zarg's Dance) rather than
// a Spell or an Attack. The brain used to have no answer for these, so it returned
// nothing, the FSM fell back to the manual Octopath menu, and a human had to click —
// which is exactly the "I still have to press buttons" the sim exists to remove.
//
// The grant may restrict WHICH skills are legal (`allowedSkillRefs`, matched by name or
// uuid — Counter Pass only permits Passes), and may lock the target (the enemy that
// triggered it). Both are honoured.
function bestFreeSkill(api, actorDoc, foes, { allowedSkillRefs = null, lockedTargetTokenUuid = null } = {}) {
  const allow = Array.isArray(allowedSkillRefs) && allowedSkillRefs.length
    ? new Set(allowedSkillRefs.map((r) => String(r).trim().toLowerCase()))
    : null;

  const permitted = (item) => {
    if (!allow) return true;
    return allow.has(String(item.name ?? "").trim().toLowerCase())
        || allow.has(String(item.uuid ?? "").trim().toLowerCase());
  };

  const locked = lockedTargetTokenUuid
    ? foes.find((f) => f.tokenUuid === lockedTargetTokenUuid) ?? null
    : null;

  const candidates = [];
  for (const item of actorDoc?.items ?? []) {
    const p = item?.system?.props ?? {};
    const type = String(p.skill_type ?? "").trim().toLowerCase();
    if (!["active", "skill", "spell"].includes(type)) continue;
    if (isAugment(item)) continue;              // can't be declared — it rides an action
    if (!permitted(item)) continue;
    if (!canAffordItem(actorDoc, item).ok) continue;

    const targetText = String(p.skill_target ?? "").trim().toLowerCase();
    const el = String(p.type_damage ?? "").trim().toLowerCase();
    const hurts = !!el && !["healing", "heal", "hp", "mp"].includes(el);

    let target = null;
    if (/self/.test(targetText)) {
      target = api.allies().find((a) => a.actorDoc?.uuid === actorDoc.uuid) ?? null;
    } else if (/ally|allies/.test(targetText)) {
      target = api.allies()
        .slice()
        .sort((a, b) =>
          pctOf(a.actorDoc, "current_hp", "max_hp") - pctOf(b.actorDoc, "current_hp", "max_hp"))[0] ?? null;
    } else {
      // Aim it at the enemy that triggered the grant if one is locked, else the
      // vulnerable one, else the party's called target.
      target = locked
        ?? (el ? foes.find((f) => api.affinityOf(f, el) === "VU") : null)
        ?? foes.find((f) => f.tokenUuid === api.focusUuid())
        ?? foes[0] ?? null;
    }
    if (!target) continue;

    candidates.push({ item, target, score: hurts ? 2 : 1, power: parseCost(p.cost).amount || 0 });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.score - a.score) || (b.power - a.power));
  const best = candidates[0];
  return api.castOn(best.item, [best.target]);
}

const pctOf = (actor, cur, max) => {
  const c = Number(actor?.system?.props?.[cur]);
  const m = Number(actor?.system?.props?.[max]);
  return (!Number.isFinite(c) || !Number.isFinite(m) || m <= 0) ? 1 : c / m;
};

// ── The rotation: profile rows through the real ActionReader ─────────────────
async function runRotation({ token, combat, combatant, actorDoc, rows, blocked }) {
  const rowName = (r) => String(r?.data?.action_pattern_name ?? "").trim();

  // Drop anything that already bounced this turn, and anything the actor cannot
  // PAY for. The affordability pass is ours because ActionReader's feasibility
  // check only prices mp/ip/zenit — see cost.js. Both filters run BEFORE the
  // engine sees the rows, so the priority window and weighted pick only ever
  // consider actions that can actually happen.
  const filteredRows = rows.filter((r) => {
    const name = rowName(r);
    if (blocked?.has(name.toLowerCase())) return false;

    const item = actorDoc?.items?.find?.((i) => String(i.name).trim().toLowerCase() === name.toLowerCase());
    if (!item) return true;   // not an item we own → let the engine drop it

    // An augment can't be declared as a turn action — it fires on one.
    if (isAugment(item)) {
      SimMode.note("rotation", `${actorDoc.name}: "${name}" is an augment, not an action — the reaction brain owns it`);
      return false;
    }

    const afford = canAffordItem(actorDoc, item);
    if (!afford.ok) {
      SimMode.note("cost", `${actorDoc.name} can't afford ${name} (${afford.have ?? 0}/${afford.need} ${afford.res})`);
      return false;
    }
    return true;
  });
  if (!filteredRows.length) return null;
  try {
    const ctx = AR.createBaseContext();

    await resolveActionReaderPerformer(ctx, { token, combat, combatant });
    if (!ctx.performer?.actor) return null;

    await buildActionReaderContext(ctx);
    if (!ctx.actorData) return null;

    // THE INJECTION. readPatternTable reads exactly this field; a PC has no
    // action_pattern_table prop, so we hand it the profile's rows instead. No
    // action-reader edit, and every downstream stage behaves as it does for a
    // monster.
    ctx.actorData.actionPatternRowsRaw = filteredRows;

    await readActionReaderPatternTable(ctx);
    await evaluateActionReaderConditions(ctx);
    await matchAndPickActionReaderAction(ctx);
    if (!ctx.chosenAction) return null;

    await parseActionReaderTargetRule(ctx);
    await buildAndPickActionReaderTargets(ctx);
    if (!ctx.chosenTargets?.length) return null;

    const item = ctx.chosenAction.item
      ?? (ctx.chosenAction.itemSnapshot?.uuid ? await fromUuid(ctx.chosenAction.itemSnapshot.uuid) : null);
    if (!item?.uuid) return null;

    const uuids = ctx.chosenTargets.map((t) => t?.tokenDocument?.uuid ?? t?.uuid).filter(Boolean);
    if (!uuids.length) return null;

    return { bundle: castBundle(item, uuids), name: item.name };
  } catch (e) {
    warn("[SIM] player-brain: rotation threw", e);
    return null;
  }
}

// ── Public ───────────────────────────────────────────────────────────────────
// Returns a compose bundle, or null to let the caller fall back to Guard.
// `blocked` = action names that already bounced this turn (SimMode's re-declare
// guard) — skip them at every layer, or we just re-offer the thing that failed.
export async function decidePlayerAction(director, snap, blocked = new Set(), grant = null) {
  const allowedLabels = grant?.enabledLabels ?? null;
  const maxMpCost = grant?.maxMpCost ?? null;
  const self = selfCombatant(director, snap);
  const actorDoc = self?.actorDoc ?? null;
  if (!actorDoc) return null;

  const profile = profileFor(actorDoc.name);
  const { foes } = sides(director, snap);
  const isBlocked = (name) => blocked.has(String(name ?? "").trim().toLowerCase());

  // A FREE ACTION grant restricts what may be declared (Zarg's Barrage grants a
  // free ATTACK; Counter Pass grants only Passes). The Octopath menu greys the
  // rest out, so the brain must honour the same allow-list — otherwise it offers
  // a Skill the free action can't be spent on, the declaration bounces, and the
  // granted attack is silently lost. Which is exactly what happened: Zarg cast
  // Barrage every turn and never once fired the shot it paid for.
  const allow = Array.isArray(allowedLabels) && allowedLabels.length
    ? new Set(allowedLabels.map((l) => String(l).trim().toLowerCase()))
    : null;
  const permits = (cmd) => !allow || allow.has(String(cmd).trim().toLowerCase());

  // The IP economy — what this character could CREATE right now. Fetched once per
  // turn because the API is async and the policies are not.
  const creatables = await fetchCreatables(actorDoc);
  const policyApi = makePolicyApi(director, snap, self, creatables);

  // Agree on a target before anyone swings. Re-checked every turn so a wounded
  // enemy pulls the whole party onto them mid-round, exactly as a table would.
  refreshFocus(policyApi);

  // A FREE ACTION (Acceleration) is a gift, and it is not the moment to heal or buff —
  // it is an extra chance to hurt something. Prefer the best damaging spell that fits
  // under the grant's MP cap; failing that, swing. This short-circuits the whole normal
  // chain, which would otherwise spend the free turn on a utility cast, or offer a
  // 20 MP Iceberg into a 10 MP window and bounce it away to nothing.
  if (allow) {
    if (permits("Spell")) {
      const spell = bestDamagingSpell(policyApi, actorDoc, foes, maxMpCost);
      if (spell && !isBlocked(spell._name)) {
        SimMode.note("free-action", `${snap?.name} spends it on ${spell._name}`);
        return spell;
      }
    }
    // A SKILL grant (Counter Pass, Dance) — the case the brain had no answer for, which
    // is why the manual menu kept appearing and a human had to click.
    if (permits("Skill")) {
      const skill = bestFreeSkill(policyApi, actorDoc, foes, {
        allowedSkillRefs: grant?.allowedSkillRefs ?? null,
        lockedTargetTokenUuid: grant?.lockedTargetTokenUuid ?? null,
      });
      if (skill && !isBlocked(skill._name)) {
        SimMode.note("free-action", `${snap?.name} spends it on ${skill._name}`);
        return skill;
      }
    }
    // …otherwise fall through to the basic attack below (if the grant permits one).
  }

  // The party's item economy, ahead of everybody's own plan. Each of these abstains
  // on its own when it isn't the right call, so ordering them first doesn't make
  // anyone reckless — it just means a party that is bleeding out, dry, or a member
  // down deals with that before it thinks about damage.
  const partyFirst = [
    ["revive", revivePolicy],    // a downed ally is a death spiral
    ["hp",     hpItemPolicy],    // somebody is about to join them
    ["mp",     mpItemPolicy],    // the casters have run dry
  ];

  for (const [kind, policy] of partyFirst) {
    try {
      const bundle = policy(policyApi);
      if (bundle && !isBlocked(bundle._name) && permits(bundle.command)) {
        const how = bundle.itemMode === "create" ? `created for ${bundle.itemCost} IP` : "from the pack";
        SimMode.note(kind, `${snap?.name} → ${bundle._name} (${how})`);
        return bundle;
      }
    } catch (e) {
      warn(`[SIM] player-brain: ${kind} policy threw`, e);
    }
  }

  // 1. Policy — the things a rotation table cannot say (heal a dying ally).
  if (typeof profile.policy === "function") {
    try {
      const bundle = profile.policy(policyApi);
      if (bundle && !isBlocked(bundle._name) && permits(bundle.command)) return bundle;
    } catch (e) {
      warn(`[SIM] player-brain: ${actorDoc.name} policy threw — falling through`, e);
    }
  }

  // 2. Rotation — the profile's rows, through the monsters' own AI engine.
  const token = canvas?.tokens?.get(snap?.tokenId) ?? null;
  const combat = director?.combat ?? game.combat ?? null;
  const combatant = combat?.combatants?.find?.((c) => c.tokenId === snap?.tokenId) ?? null;

  // Under a free-action grant that doesn't permit Skill/Spell (the common case:
  // "Attack"), skip the rotation entirely and go spend the granted attack.
  const rotationAllowed = permits("Skill") || permits("Spell");

  if (token && rotationAllowed) {
    const picked = await runRotation({ token, combat, combatant, actorDoc, rows: profile.rows, blocked });
    if (picked && permits(picked.bundle.command)) return picked.bundle;
  }

  // 3. Basic attack, aimed with its head up. Also the landing spot for a granted
  // free Attack.
  if (!permits("Attack")) return null;
  if (!foes.length) return null;

  const mode = resolveAttackMode(actorDoc);
  if (!mode) {
    log(`[SIM] player-brain: ${snap?.name} has nothing to attack with`);
    return null;
  }

  // A weapon that reaches two creatures should HIT two creatures. Anything less is
  // throwing away half the swing. (Only a real main weapon carries a reach — a virtual
  // attack is single-target.)
  const cap = mode === "main" ? weaponTargetCap(actorDoc) : 1;
  const picks = bestAttackTargets(actorDoc, foes, SimMode.focus(), cap);
  const uuids = picks.map((p) => tokenUuidOf(p.dc)).filter(Boolean);
  if (!uuids.length) return null;

  SimMode.note(
    "attack",
    `${snap?.name} swings at ${picks.map((p) => `${p.dc.name} [${p.aff}]`).join(" + ")}`
    + (mode.startsWith("virtual") ? " (virtual attack)" : "")
    + (cap > 1 ? ` (weapon reaches ${cap})` : "")
  );
  return attackBundle(uuids, mode);
}
