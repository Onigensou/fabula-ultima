/**
 * Character Creation — finalize.
 *
 * Turns a finished draft into a real Actor. Runs on the acting GM (players
 * cannot create Actors, set ownership, or make folders), reached through the
 * shared advancement transport so there is still exactly one writer.
 *
 * ROLLBACK IS DELETION
 * --------------------
 * Every write after `Actor.create` lands on an Actor that did not exist a
 * moment ago and that nobody has touched. So the compensation for a failure
 * anywhere in the sequence is to delete it — no unwinding of partial spends, no
 * half-granted items, no possibility of restoring the wrong prior state. That
 * is the entire reason the order below is "create the actor first, then do
 * everything else to it".
 *
 * The one thing not rolled back is the destination FOLDER, which is created
 * before the actor. An empty folder named after the player is harmless and will
 * be reused by their next attempt.
 *
 * SKILL POINTS GO THROUGH THE LEVEL-UP SYSTEM
 * -------------------------------------------
 * The class picks are replayed as real `spendPoint` calls rather than written
 * as props. That system already knows how to build a class row, revive a
 * `$deleted` tombstone, grant the skill item from the class actor, hand out
 * facets, set the martial-armor flag and debit the point last. Reimplementing
 * any of it here would be a second copy to keep in step with CSB.
 *
 * It also means the actor must HOLD the points before they can be spent:
 * `unspentPoints` reads the stored `skill_point` prop, so creation seeds it
 * with the character's level and the spends draw it down to zero.
 */

import { CC, log, warn, err, num, CC_ATTR_KEYS } from "./cc-const.js";
import { registerHandler, request, isActingGM } from "../advancement/advancement-net.js";
import { ensureFolder } from "./cc-folder.js";
import {
  validateAll, draftLevel, draftBudgetLeft, draftMartial,
} from "./cc-draft.js";
import { applyMilestones } from "./cc-step-attributes.js";
import { martialNeed } from "./cc-step-equipment.js";
import { chosenEmotion, bondIsEmpty } from "./cc-step-bond.js";
import { spendPoint } from "../levelup-system/levelup-api.js";
import { gateState } from "../levelup-system/levelup-gate.js";
import { resolveClass } from "../levelup-system/class-registry.js";

const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

/** The attribute system's ledger flag. Mirrors ATTR.FLAG_* in attribute-const. */
const ATTR_FLAG_SCOPE = "fabula-ultima-companion";
const ATTR_FLAG_KEY = "attributeAdvance";

// ── creation data ──────────────────────────────────────────────────────────

/**
 * Build the Actor document from the blank seed plus the draft.
 *
 * Exported so the shape can be asserted without writing anything.
 *
 * CSB TYPES MATTER: user-entered fields are stored as STRINGS and formula
 * outputs as NUMBERS. Writing the wrong side of that split hands CSB a string
 * to do arithmetic on. `skill_point` is a number because that is what
 * `applySpend` writes back when it debits.
 */
export function buildActorData(seedData, draft, { userId, folderId }) {
  const data = foundry.utils.duplicate(seedData);
  delete data._id;

  const p = draft.profile;
  const level = draftLevel(draft);
  const { bases } = applyMilestones(draft);
  const img = String(p.img ?? "").trim() || CC.DEFAULT_IMG;
  const tokenImg = String(p.tokenImg ?? "").trim() || img;
  const name = String(p.name ?? "").trim() || "Unnamed";

  data.name = name;
  data.img = img;
  data.folder = folderId ?? null;

  // The player owns their own character outright; everyone else keeps the
  // world default. Setting OWNER for the requester was decision 3.
  data.ownership = {
    default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE,
    [userId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
  };

  data.prototypeToken = data.prototypeToken ?? {};
  data.prototypeToken.name = name;
  data.prototypeToken.texture = data.prototypeToken.texture ?? {};
  data.prototypeToken.texture.src = tokenImg;
  data.prototypeToken.actorLink = true;

  const props = data.system.props;
  props.name = name;
  props.level = String(level);
  props.skill_point = level;              // number — spent down by applySpend
  props.skill_point_bonus = "0";
  props.fabula_point = String(CC.RULE.START_FABULA);
  props.zenit = String(Math.max(0, draftBudgetLeft(draft)));

  props.char_identity = String(p.identity ?? "");
  props.theme = String(p.theme ?? "");
  props.origin = String(p.origin ?? "");
  props.backstory = String(p.backstory ?? "");

  for (const k of CC_ATTR_KEYS) props[`${k}_base`] = String(num(bases[k], 8));

  return data;
}

// ── the transaction ────────────────────────────────────────────────────────

async function applyCreate({ draft, requesterUserId }) {
  // The gate is checked ONCE, up front. Each `spendPoint` re-checks it too, so
  // without this a GM switching scenes mid-run could fail the third spend of
  // twenty — which the rollback would survive, but only after doing all the
  // work. Better to refuse before anything exists.
  const gate = gateState();
  if (!gate.open) return fail("gate_closed", { gate });

  if (!draft || typeof draft !== "object") return fail("no_draft");

  // Re-validated here, not trusted from the client: the window enforces these
  // rules for the player's benefit, but this is the only place that is
  // authoritative.
  const v = validateAll(draft);
  if (!v.ok) return fail("invalid_draft", { issues: v.issues });

  const seed = game.actors?.get(CC.BLANK_PC_ID) ?? null;
  if (!seed) return fail("missing_seed", { seedId: CC.BLANK_PC_ID });

  const user = game.users?.get(requesterUserId) ?? null;
  if (!user) return fail("unknown_user", { requesterUserId });

  let folder = null;
  try {
    folder = await ensureFolder(user);
  } catch (e) {
    err("folder creation failed", e);
    return fail("folder_failed", { message: String(e?.message ?? e) });
  }

  let actor = null;
  try {
    const data = buildActorData(seed.toObject(), draft, {
      userId: user.id,
      folderId: folder?.id ?? null,
    });
    actor = await Actor.create(data);
    if (!actor) return fail("create_failed");
  } catch (e) {
    err("Actor.create threw", e);
    return fail("create_failed", { message: String(e?.message ?? e) });
  }

  // From here on the actor exists, so every failure must delete it.
  try {
    const spends = await replaySpends(actor, draft, requesterUserId);
    const granted = await grantEquipment(actor, draft);
    await writeBond(actor, draft);
    await writeAttributeLedger(actor, draft);
    await syncResources(actor);

    log(`created ${actor.name} (${actor.id}) for ${user.name}: ` +
        `${spends} spends, ${granted} items`);

    return {
      ok: true,
      actorId: actor.id,
      actorUuid: actor.uuid,
      name: actor.name,
      folder: folder?.name ?? null,
      spends,
      granted,
    };
  } catch (e) {
    err("finalize failed, rolling back", e);
    const rolledBack = await rollback(actor);
    return fail("finalize_failed", {
      message: String(e?.message ?? e),
      rolledBack,
      // If deletion ALSO failed the actor is orphaned, and the player needs to
      // be told which one so a GM can clear it up by hand.
      orphanId: rolledBack ? null : actor.id,
    });
  }
}

/** Delete the half-built actor. Returns whether it actually went. */
async function rollback(actor) {
  try {
    await actor.delete();
    return true;
  } catch (e) {
    err("ROLLBACK FAILED — actor left behind:", actor?.id, e);
    return false;
  }
}

/**
 * Replay every class pick as a real Skill Point spend.
 *
 * Sequential on purpose: each spend reads the actor's current class rows and
 * point total, so running them together would race on the same document.
 */
async function replaySpends(actor, draft, requesterUserId) {
  let n = 0;
  for (const pick of draft.classes ?? []) {
    const res = await spendPoint({
      actorUuid: actor.uuid,
      classKey: pick.classKey,
      skillUuid: pick.skillUuid,
      benefit: pick.benefit ?? null,
      facetUuids: pick.facetUuids ?? [],
      requesterUserId,
    });
    if (!res?.ok) {
      throw new Error(
        `spend ${n + 1}/${draft.classes.length} failed (${pick.className} → ` +
        `${pick.skillName}): ${res?.reason ?? "unknown"}`
      );
    }
    n++;
  }
  return n;
}

/**
 * Copy the chosen equipment onto the actor.
 *
 * Gear the character has no training for is still granted — it was bought and
 * paid for. `isEquipped` is left false on it, which is the difference between
 * owning a thing and using it.
 *
 * The hand/shield dropdowns on the sheet are NOT set here. In this world they
 * are plain props whose options CSB rebuilds from the actor's items, so writing
 * a value before that table exists would set a name that is not yet in the
 * option set.
 */
async function grantEquipment(actor, draft) {
  const list = draft.equipment?.picks ?? [];
  if (!list.length) return 0;

  const martial = draftMartial(draft, resolveClass);
  const create = [];
  const sources = [];
  for (const pick of list) {
    const source = await fromUuid(pick.uuid);
    if (!source) {
      warn(`equipment source missing, skipping: ${pick.name} (${pick.uuid})`);
      continue;
    }
    const data = source.toObject();
    delete data._id;
    const need = martialNeed(pick);
    foundry.utils.setProperty(data, "system.props.isEquipped", !need || !!martial[need]);
    create.push(data);
    sources.push(source);
  }
  if (!create.length) return 0;
  const created = await actor.createEmbeddedDocuments("Item", create);

  // A bare embedded create yields a CHILDLESS parent — CSB only walks
  // `data.items` in its own static create — so starting gear would arrive
  // without its linked `_skill`. Same primitive the shop/trade transfers use.
  // Best-effort: a child that fails to copy must not fail the whole creation.
  const core = window["oni.ItemTransferCore"];
  if (typeof core?.copySubItemTree === "function") {
    for (const [i, parent] of (created ?? []).entries()) {
      if (!parent || !sources[i]) continue;
      try {
        await core.copySubItemTree({ sourceItem: sources[i], receiverActor: actor, receiverParent: parent });
      } catch (e) {
        warn(`equipment sub-item copy failed for ${parent.name}`, e);
      }
    }
  }
  return create.length;
}

/**
 * Set the character's bonds to EXACTLY what the wizard collected.
 *
 * Creation offers one starting bond, in slot 1; every other slot must be empty.
 * So all six slots are written unconditionally — the draft's bond into slot 1,
 * blanks into the rest — rather than only touching slot 1 when a bond exists.
 *
 * That "unconditionally" is the fix for a real bug: the blank seed the actor is
 * cloned from carried stray emotions in slots 2–4, and a writer that only ever
 * touched slot 1 left them in place, so every created character inherited
 * feelings toward nobody. The created character's bonds now depend on the
 * draft alone, whatever the seed happens to hold.
 *
 * `BondUpdater` is a globalThis IIFE rather than a module, so it is reached
 * through the global. If it is absent the bonds are skipped with a warning
 * rather than failing the whole creation.
 *
 * @returns {number} how many slots were given a bond (0 or 1)
 */
/**
 * The full six-slot bond payload for a draft.
 *
 * Exported and pure so the "every slot is named" guarantee — the thing that
 * stops the seed leaking stale bonds — is testable without a live actor. Only
 * slot 1 may carry a bond; the rest are explicit blanks.
 */
export function bondSlots(draft, max = 6) {
  const b = draft?.bond ?? {};
  const chosen = chosenEmotion(draft);
  const hasBond = !bondIsEmpty(draft) && !!String(b.name ?? "").trim() && !!chosen;

  const slots = [];
  for (let i = 1; i <= max; i++) {
    slots.push(i === 1 && hasBond
      ? { idx: 1, name: b.name, rel: b.rel ?? "", e1: b.e1 ?? "", e2: b.e2 ?? "", e3: b.e3 ?? "" }
      : { idx: i, name: "", rel: "", e1: "", e2: "", e3: "" });
  }
  return slots;
}

async function writeBond(actor, draft) {
  const BU = globalThis.BondUpdater;
  if (typeof BU?.writeBonds !== "function") {
    warn("BondUpdater.writeBonds unavailable — bonds not normalised");
    return 0;
  }
  const slots = bondSlots(draft, BU.MAX_BONDS ?? 6);
  await BU.writeBonds(actor, slots);
  return slots[0].name ? 1 : 0;
}

/**
 * Record the milestone advances that are already baked into the bases.
 *
 * A character created at level 20 or 40 starts with their advances spent (user
 * decision 6). Without this ledger the attribute window would compute
 * `milestonesReached - claimed` and offer them all over again.
 */
async function writeAttributeLedger(actor, draft) {
  const { entries } = applyMilestones(draft);
  if (!entries.length) return 0;
  await actor.update({
    [`flags.${ATTR_FLAG_SCOPE}.${ATTR_FLAG_KEY}`]: {
      claimed: entries.length,
      log: entries,
    },
  });
  return entries.length;
}

/**
 * Fill HP/MP/IP to their maxima.
 *
 * Done LAST because the maxima are CSB formula outputs that only settle after
 * the class benefits have been applied — a Guardian's +5 HP per level is part
 * of `max_hp`, so reading it before the spends would start the character
 * wounded.
 */
async function syncResources(actor) {
  const p = actor.system?.props ?? {};
  const update = {};
  for (const [maxKey, curKey] of [["max_hp", "current_hp"], ["max_mp", "current_mp"], ["max_ip", "current_ip"]]) {
    const max = num(p[maxKey], 0);
    if (max > 0) update[`system.props.${curKey}`] = String(max);
  }
  if (Object.keys(update).length) await actor.update(update);
  return update;
}

// ── transport ──────────────────────────────────────────────────────────────

registerHandler(CC.MSG.CREATE_REQ, CC.MSG.CREATE_RES, applyCreate);

/**
 * Create the character. Callable from any client.
 *
 * A player's request crosses the socket to the acting GM; a GM's request is
 * handled in place. Either way exactly one client writes.
 */
export function createCharacter(draft) {
  return request(
    CC.MSG.CREATE_REQ,
    { draft: foundry.utils.duplicate(draft), requesterUserId: game.user.id },
    { timeoutMs: CC.REQUEST_TIMEOUT_MS }
  );
}

export { applyCreate, isActingGM };
