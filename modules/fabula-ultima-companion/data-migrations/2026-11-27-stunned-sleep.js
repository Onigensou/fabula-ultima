/**
 * Migration: 2026-11-27-stunned-sleep  (new Stunned, reworked Sleep)
 * ---------------------------------------------------------------------------
 * User design 2026-11-26. Both statuses stop the creature from acting and from
 * performing reactions, and both give it a way out on its own turn:
 *
 *   Stunned  At turn start, MIG + WLP DL 10: pass = it ends and you act; fail = the
 *            turn is lost. Lasts until the end of your next turn (1 charge,
 *            bearer-turn-end). Cleansable like any debuff.
 *   Sleep    At turn start, INS + WLP DL 10: pass = it ends. Taking damage wakes you,
 *            except "dream" damage (skill tag `dream`, Nightmare). Lasts 3 rounds
 *            (was 1 charge). Cleansable.
 *   Both     Cannot be reapplied while active (no refresh either).
 *
 * The engine side is data-driven off flags on the status AE:
 *   recoveryCheck {attr1, attr2, dl}  status-recovery.js (TURN_START + turn-less summons)
 *   noReapply: true                   skill-effects apply_ae
 *   change disable_action = "All"     reaction gate + menus (snapshot.js expandAllLabels)
 *   turn_start force row modify_turns −1  skips the turn when the check failed
 *
 * Writes:
 *   1. "Stunned" AE on the Debuff library (fixed id StunnedAE0000001, status
 *      StunnedStatId001 registered in csb-extra-status-effects.js).
 *   2. Sleep on the Debuff library AND every live copy (actors, their items,
 *      unlinked tokens): description, disable_action All, recovery flags, no-reapply,
 *      the wake row gated on SKILL_HAS_TAG_DREAM == 0. Library copy also: 3 charges.
 *   3. Nightmare (Hexer spell, world items + embedded copies): skill_tags += dream.
 *   4. Journals: Sleep's text page rewritten; a "Stunned" journal (StunnedKeyword01)
 *      created next to it in the same folder, shaped like Sleep's.
 *
 * Idempotent: a second run reports nothing to do.
 */

export const key = "2026-11-27-stunned-sleep";
export const description = "Stunned (new) + Sleep rework: turn-start recovery check, no reactions, no reapply; Nightmare = dream damage.";

const M = "fabula-ultima-companion";
const DEBUFF_CONTAINER = "XVOWOq9oUmEECGrU";
const STUN_AE_ID = "StunnedAE0000001";
const STUN_STATUS_ID = "StunnedStatId001";
const SLEEP_STATUS_ID = "pDHAfDnaVU5wpzBO";
const SLEEP_JOURNAL = "rXZqaRSx0ctgqepa";
const STUN_JOURNAL = "StunnedKeyword01";
const STUN_PAGE = "StunnedDescPage1";
const DAZED_JOURNAL = "3nmUvPei3zrOJkEt";
const WEAK_JOURNAL = "KYehgac3Pw1fKC9S";
const BF = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Buff%20Icon/";

const ALL = "All";
const WAKE_GATE = "SKILL_HAS_TAG_DREAM == 0";

const STUN_DESC = "<p>Cannot act or perform reactions.</p>"
  + "<p>At the start of your turn, roll <strong>【MIG + WLP】</strong> DL 10. On a success, Stunned ends and you act normally.</p>"
  + "<p>Lasts until the end of your next turn. Cannot be reapplied while active.</p>";
const SLEEP_DESC = "<p>Cannot act or perform reactions.</p>"
  + "<p>At the start of your turn, roll <strong>【INS + WLP】</strong> DL 10. On a success, Sleep ends.</p>"
  + "<p>Taking damage ends Sleep.</p>"
  + "<p>Lasts 3 rounds. Cannot be reapplied while active.</p>";

const jlink = (id, label) => `<a class="content-link" draggable="true" data-link data-uuid="JournalEntry.${id}" data-id="${id}" data-type="JournalEntry" data-tooltip="Journal Entry">${label}</a>`;
const journalText = (icon, rules, basicId, basicLabel) =>
  `<p><img style="display:block;margin-left:auto;margin-right:auto" src="${BF}${icon}" alt="" width="21" height="21" /></p>\n${rules}\n`
  + `<p><strong>Basic Condition:</strong></p>\n<p>${jlink(basicId, basicLabel)}</p>`;

// The turn_start "skip this turn" row (runs only if the recovery check failed — a
// pass deleted the AE before the turn_start window) and Sleep's wake row.
function skipRow(label) {
  return {
    condition_formula: "", reaction_action_intent: "", reaction_action_kind: "", reaction_action_target: "",
    reaction_cause_filter: "", reaction_damage_source: "", reaction_effect_ref: label, reaction_max_per_round: "",
    reaction_max_scope: "", reaction_origin_filter: "", reaction_ownership: "", reaction_passive_mode: "force",
    reaction_passive_target: "", reaction_requires_weapon_used: false, reaction_resource_filter: "", reaction_responder: "",
    reaction_source: "self", reaction_source_skill: "", reaction_status_filter: "", reaction_subject_kind: "",
    reaction_trigger: "turn_start", requires_skill: "",
  };
}

const STUNNED = {
  _id: STUN_AE_ID,
  name: "Stunned",
  img: BF + "Stun.png",
  transfer: false, disabled: false, tint: "#ffffff",
  changes: [{ key: "disable_action", mode: 5, priority: 0, value: ALL }],
  statuses: [STUN_STATUS_ID],
  duration: { rounds: 1, turns: null, seconds: null },
  description: STUN_DESC,
  system: { tags: ["debuff"] },
  flags: {
    [M]: {
      charges: 1, chargesMax: 1, lifetimeMode: "target_turn_end",
      recoveryCheck: { attr1: "MIG", attr2: "WLP", dl: 10 },
      noReapply: true,
      reactionConfig: {
        effect_table: { 0: { effect_kind: "modify_turns", effect_label: "stun_skip", turns_delta: "-1", turns_floor: "0" } },
        reaction_config_table: { 0: skipRow("stun_skip") },
      },
    },
    // Same shape as Corroded / Armor Break: CSB keeps the fixed id only with these,
    // and Convenient Effects resolves the status through them.
    "custom-system-builder": {
      isFromTemplate: false, isPredefined: true, originalId: STUN_AE_ID, originalParentId: DEBUFF_CONTAINER,
      originalUuid: `Item.${DEBUFF_CONTAINER}.ActiveEffect.${STUN_AE_ID}`,
    },
    "dfreds-convenient-effects": { ceEffectId: "ce-stunned", isBackup: false, isConvenient: true, isDynamic: false, isTemporary: false, isViewable: true },
    statuscounter: { config: { multiplyEffect: true, type: "default" }, value: 1, visible: false },
  },
};

const isSleep = (e) => e?.name === "Sleep" || new Set(Array.from(e?.statuses ?? [])).has(SLEEP_STATUS_ID);

// The Sleep update for one effect (null = already done). `library` = the template
// on the Debuff library (also gets the 3-round charges; live copies keep theirs).
function sleepUpdate(e, library) {
  const f = e.flags?.[M] ?? {};
  const upd = { _id: e.id };
  let n = 0;
  if (e.description !== SLEEP_DESC) { upd.description = SLEEP_DESC; n++; }
  const changes = foundry.utils.deepClone(e.changes ?? []);
  if (!changes.some((c) => c.key === "disable_action" && String(c.value).trim().toLowerCase() === "all")) {
    upd.changes = [...changes.filter((c) => c.key !== "disable_action"), { key: "disable_action", mode: 5, priority: 0, value: ALL }];
    n++;
  }
  const rc = f.recoveryCheck ?? {};
  if (rc.attr1 !== "INS" || rc.attr2 !== "WLP" || Number(rc.dl) !== 10) { upd[`flags.${M}.recoveryCheck`] = { attr1: "INS", attr2: "WLP", dl: 10 }; n++; }
  if (f.noReapply !== true) { upd[`flags.${M}.noReapply`] = true; n++; }
  // Wake row: find the creature_lose_resource row by trigger, not by index.
  const rows = f.reactionConfig?.reaction_config_table ?? {};
  for (const [k, r] of Object.entries(rows)) {
    if (r?.reaction_trigger !== "creature_lose_resource") continue;
    if (String(r.condition_formula ?? "").trim() !== WAKE_GATE) {
      upd[`flags.${M}.reactionConfig.reaction_config_table.${k}.condition_formula`] = WAKE_GATE;
      n++;
    }
  }
  if (library) {
    if (Number(f.charges) !== 3) { upd[`flags.${M}.charges`] = 3; n++; }
    if (Number(f.chargesMax) !== 3) { upd[`flags.${M}.chargesMax`] = 3; n++; }
    if (Number(e.duration?.rounds) !== 3) { upd["duration.rounds"] = 3; n++; }
  }
  return n ? upd : null;
}

async function patchSleep(parent, label, library, out) {
  const updates = [];
  for (const e of parent?.effects ?? []) {
    if (!isSleep(e)) continue;
    const u = sleepUpdate(e, library);
    if (u) updates.push(u);
  }
  if (!updates.length) return 0;
  await parent.updateEmbeddedDocuments("ActiveEffect", updates);
  out.push(`Sleep ~ ${label} (${updates.length})`);
  return updates.length;
}

async function tagNightmare(item, label, out) {
  if (item?.name !== "Nightmare" || String(item.system?.props?.skill_type ?? "").toLowerCase() !== "spell") return 0;
  const tags = String(item.system?.props?.skill_tags ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (tags.map((t) => t.toLowerCase()).includes("dream")) return 0;
  await item.update({ "system.props.skill_tags": [...tags, "dream"].join(", ") });
  out.push(`Nightmare tagged dream ~ ${label}`);
  return 1;
}

async function journals(out) {
  const sleepJ = game.journal.get(SLEEP_JOURNAL);
  if (!sleepJ) { out.push("Sleep journal missing, skipped journals"); return 0; }
  let n = 0;
  const sleepText = journalText("Sleep.png", SLEEP_DESC, DAZED_JOURNAL, "Dazed");
  const sleepPage = sleepJ.pages.find((p) => p.type === "text");
  if (sleepPage && sleepPage.text?.content !== sleepText) {
    await sleepPage.update({ "text.content": sleepText });
    out.push("Sleep journal text updated");
    n++;
  }
  const stunText = journalText("Stun.png", STUN_DESC, WEAK_JOURNAL, "Weak");
  const stunJ = game.journal.get(STUN_JOURNAL);
  if (!stunJ) {
    await JournalEntry.implementation.create({
      _id: STUN_JOURNAL, name: "Stunned", folder: sleepJ.folder?.id ?? null,
      ownership: foundry.utils.deepClone(sleepJ.ownership ?? { default: 2 }),
      pages: [{ _id: STUN_PAGE, name: sleepPage?.name ?? "Description", type: "text", text: { format: 1, content: stunText } }],
    }, { keepId: true });
    out.push("Stunned journal created");
    n++;
  } else {
    const p = stunJ.pages.find((x) => x.type === "text");
    if (p && p.text?.content !== stunText) { await p.update({ "text.content": stunText }); out.push("Stunned journal text updated"); n++; }
  }
  return n;
}

export async function migrate(game, log = () => {}) {
  const out = [];
  let n = 0;
  const box = game.items.get(DEBUFF_CONTAINER);
  if (!box) return { applied: false, summary: "Debuff library missing" };

  if (!box.effects.get(STUN_AE_ID) && !box.effects.find((e) => e.name === "Stunned")) {
    await ActiveEffect.implementation.create(foundry.utils.deepClone(STUNNED), { parent: box, keepId: true });
    out.push("Stunned added to the Debuff library");
    n++;
  }

  n += await patchSleep(box, "Debuff library", true, out);
  for (const item of game.items ?? []) {
    if (item.id !== DEBUFF_CONTAINER) n += await patchSleep(item, `Item ${item.name}`, false, out);
    n += await tagNightmare(item, `Item ${item.id}`, out);
  }
  for (const actor of game.actors ?? []) {
    n += await patchSleep(actor, `Actor ${actor.name}`, false, out);
    for (const item of actor.items ?? []) {
      n += await patchSleep(item, `${actor.name} / ${item.name}`, false, out);
      n += await tagNightmare(item, `${actor.name}`, out);
    }
  }
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorLink || !t.actor) continue;
      n += await patchSleep(t.actor, `${scene.name} / ${t.name}`, false, out);
    }
  }
  n += await journals(out);

  for (const l of out) log(l);
  return { applied: true, summary: `${n} write(s)` + (out.length ? ` | ${out.join(" | ")}` : "") };
}
