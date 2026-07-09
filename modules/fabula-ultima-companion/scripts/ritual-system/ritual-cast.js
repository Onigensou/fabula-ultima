// ============================================================================
// Ritual System — the cast step. GM-authoritative.
//
// Step 3 of the flowchart (core p. 119): spend the Mind Points, roll the Magic
// Check against the potency's Difficulty Level. Success delivers the effect;
// failure means the GM narrates how it twisted catastrophically.
//
// ── Why this runs on the GM ─────────────────────────────────────────────────
// Check Requester's interactiveRequest opens with a hard refusal off the GM
// client, and the MP debit is an actor write a player may not own (nor do they
// own the party actor whose material they may be offering). So the whole step
// runs GM-side; ritual-socket.js relays a player's click here.
//
// ── MP and material are spent on initiation, never refunded ─────────────────
// A failed ritual still cost you the Mind Points and the ingredient. That is
// the rule, and it is also why both are spent BEFORE the check rather than
// after: no code path can roll the dice, see a failure, and quietly skip
// payment.
//
// This module is exported separately from the window precisely so the deferred
// in-conflict flow (Ritual Clock → Objective actions → cast) can trigger the
// same step from a different place. Conflict rituals also pay at cast time —
// step 3 is step 3 — so no separate cost mode is needed.
// ============================================================================

import { RITUAL_TAG, disciplineById } from "./ritual-const.js";
import { computeCost, canAfford, attrsFor, currentMp } from "./ritual-cost.js";
import { disciplinesForActor } from "./ritual-actor.js";
import { resolveMaterial, consumeMaterial } from "./ritual-materials.js";
import { broadcastFeedback } from "./ritual-feedback.js";
import { debitCost } from "../battle-director/skill-cost.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

/** "an Entropism Ritual" / "a Spiritism Ritual" — read aloud in the banner. */
function articleFor(label) {
  return /^[AEIOU]/i.test(String(label)) ? "an" : "a";
}

/** A performer uuid may be a TokenDocument (GM, selected token) or an Actor. */
async function resolvePerformerActor(uuid) {
  const doc = await fromUuid(uuid).catch(() => null);
  if (!doc) return null;
  return doc.documentName === "Actor" ? doc : (doc.actor ?? null);
}

/** Party members other than the performer, for the Group Check lobby. */
async function resolveHelpers(performerActor) {
  try {
    const party = await globalThis.CampSystem?.Party?.resolve?.();
    if (!Array.isArray(party)) return [];
    return party.map((m) => m?.actor).filter((a) => a && a.id !== performerActor.id);
  } catch (e) {
    console.warn(RITUAL_TAG, "party resolve failed", e);
    return [];
  }
}

function outcomeCard({ performerImg, performerName, discipline, spec, cost, result, pass, helpers, material }) {
  const verdict = pass
    ? `<div class="ritual-verdict ok">The Ritual succeeds.</div>`
    : `<div class="ritual-verdict bad">The Ritual fails — its effects twist in a <b>catastrophic way</b>.</div>`;
  const total = Number.isFinite(result?.total) ? result.total : "—";

  // The description is optional. At the table you have usually just SAID what
  // you are doing, so an empty box is normal, not an omission to apologise for.
  const desc = spec.description?.trim()
    ? `<div class="ritual-desc">${escapeHtml(spec.description.trim())}</div>`
    : "";
  const helperLine = helpers?.length
    ? `<div class="ritual-row"><span>Assisted by</span><b>${escapeHtml(helpers.map((h) => h.name).join(", "))}</b></div>`
    : "";
  const materialLine = material
    ? `<div class="ritual-row"><span>Offered</span><b>${escapeHtml(material.name)} (${escapeHtml(material.rarity)}) — ${Math.round(cost.discount * 100)}% off</b></div>`
    : "";

  return `
<div class="oni-ritual-card">
  <header>
    <img src="${escapeHtml(performerImg)}" width="36" height="36" />
    <div>
      <div class="ritual-title">${escapeHtml(discipline.label)} Ritual</div>
      <div class="ritual-sub">${escapeHtml(performerName)}</div>
    </div>
  </header>
  ${desc}
  <div class="ritual-row"><span>Potency / Area</span><b>${escapeHtml(spec.potency)} · ${escapeHtml(spec.area)}</b></div>
  <div class="ritual-row"><span>Cost</span><b>${cost.mp} MP</b></div>
  ${materialLine}
  <div class="ritual-row"><span>Magic Check</span><b>${total} vs DL ${cost.dl}</b></div>
  ${helperLine}
  ${verdict}
</div>`;
}

/**
 * Perform a ritual, authoritatively. Must run on the GM client.
 *
 * Every input is re-validated here — eligibility, the offered material and its
 * rarity, cost, affordability — because the caller may be a player's socket
 * message. The window's gating is a courtesy, not a guarantee.
 *
 * @param {object} p
 * @param {string} p.performerUuid   Actor or TokenDocument uuid
 * @param {object} p.spec            { discipline, potency, area, material?: {actorUuid,itemId}, description, useAltAttrs, groupCheck }
 * @param {boolean} [p.override]     GM fiat: cast despite insufficient MP
 * @returns {Promise<{ok:boolean, pass?:boolean, reason?:string}>}
 */
export async function performCast({ performerUuid, spec, override = false } = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "performCast must run on the GM client." };

  const actor = await resolvePerformerActor(performerUuid);
  if (!actor) return { ok: false, reason: "Performer actor not found." };

  const discipline = disciplineById(spec?.discipline);
  if (!discipline) return { ok: false, reason: `Unknown discipline "${spec?.discipline}".` };

  // Re-verify eligibility GM-side. A crafted socket message cannot cast a
  // discipline its actor never learned.
  const eligible = disciplinesForActor(actor).some((d) => d.id === discipline.id);
  if (!eligible) return { ok: false, reason: `${actor.name} cannot perform ${discipline.label}.` };

  // Re-read the material and its rarity from the world. The client sends only
  // a pointer; a crafted message cannot claim a Common twig is Legendary.
  let material = null;
  if (spec.material) {
    material = await resolveMaterial(spec.material);
    if (!material) return { ok: false, reason: "The offered material is gone." };
  }

  const cost = computeCost({ ...spec, materialRarity: material?.rarity ?? null });
  if (!cost) return { ok: false, reason: "Invalid potency or area." };

  if (!canAfford(actor, cost) && !override) {
    return { ok: false, reason: `${actor.name} has ${currentMp(actor)} MP; the Ritual costs ${cost.mp}.` };
  }

  // Spend first. See the header: a failure must never be able to skip payment.
  const debit = await debitCost(actor, new Map([["mp", cost.mp]]));
  if (!debit.ok) return { ok: false, reason: "Could not deduct Mind Points." };
  if (material) await consumeMaterial(material);

  const [attrA, attrB] = attrsFor(discipline.id, { useAlt: Boolean(spec.useAltAttrs) });
  const label = `${discipline.label} Ritual — DL ${cost.dl}`;

  broadcastFeedback({
    kind: "perform", performerName: actor.name,
    discipline: discipline.label, mp: cost.mp, article: articleFor(discipline.label),
  });

  let result = null;
  let pass = false;
  let helpers = [];

  try {
    if (spec.groupCheck) {
      // Rituals as Group Checks (p. 120): the performer is the leader, and any
      // character may help even without ritual training of their own.
      helpers = await resolveHelpers(actor);
      const gc = await globalThis.ONI?.GroupCheck?.request?.({
        leaderUuid: actor.uuid,
        participantMode: "open",
        allActorUuids: helpers.map((h) => h.uuid),
        leaderDl: cost.dl,
        helperDl: cost.dl,
        attrA, attrB,
        label,
      });
      result = gc?.leaderResult ?? null;
      pass = Boolean(gc?.leaderPass);
    } else {
      result = await globalThis.ONI?.CheckRequester?.requestOne?.(actor, {
        attrA, attrB, dl: cost.dl, label,
        context: { ritual: true, discipline: discipline.id },
      });
      pass = Boolean(result?.pass);
    }
  } catch (e) {
    console.error(RITUAL_TAG, "check failed", e);
    return { ok: false, reason: "The Magic Check could not be rolled (MP already spent)." };
  }

  if (!result) return { ok: false, reason: "The Magic Check was cancelled (MP already spent)." };

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: outcomeCard({
      performerImg: actor.img ?? "", performerName: actor.name,
      discipline, spec, cost, result, pass, helpers, material,
    }),
  });

  return { ok: true, pass };
}
