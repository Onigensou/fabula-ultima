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
 * A failed check ends the turn in the engine (TURN_START → CLEANUP); Sleep's old
 * turn_start modify_turns row is removed.
 *
 * Writes:
 *   1. "Stunned" AE on the Debuff library (fixed id StunnedAE0000001, status
 *      StunnedStatId001 registered in csb-extra-status-effects.js).
 *   2. Sleep on the Debuff library AND every live copy (actors, their items,
 *      unlinked tokens): description, disable_action All, recovery flags, no-reapply,
 *      the wake row gated on SKILL_HAS_TAG_DREAM == 0. Library copy also: 3 charges.
 *   3. Nightmare (Hexer spell, world items + embedded copies): skill_tags += dream, and
 *      its "+ 15% of the target's Max HP" authored (it was text only): an outgoing
 *      adjust_damage row on its own will-deal-damage reaction (Scorched Claw's shape).
 *   4. Journals: Sleep's text page rewritten; a "Stunned" journal (StunnedKeyword01)
 *      created next to it in the same folder, shaped like Sleep's.
 *   5. Stunned holds the hurt pose (flag holdPose "hurt", battler-pose-rules.js).
 *   6. Panic gives Stun.png to Stunned: its AE (library + live copies) and journal
 *      icon become Eerie Soundwave (user pick on the mockup, 2026-11-27).
 *   7. Hypno Pendulum's Sleep spell: no fixed 1 charge any more, so it uses Sleep's
 *      own 3 rounds; "for 1 Round" dropped from its text (pendulum + spell).
 *
 * Idempotent: a second run reports nothing to do.
 */

export const key = "2026-11-27-stunned-sleep";
export const description = "Stunned (new) + Sleep rework: turn-start recovery check, no reactions, no reapply, held hurt pose; Nightmare = dream damage + 15% Max HP; Panic new icon; Hypno Sleep 3 rounds.";

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
const PANIC_AE = "owA4mhwuMM1Gh18f";
const PANIC_STATUS_ID = "8LN8tDQjON508Rqm";
const PANIC_JOURNAL = "vf421bQSPCjLAvBW";
const PANIC_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20Battle(PvE)/BLU/eerie_soundwave.png";

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
      holdPose: "hurt",
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
  // Rows found by trigger / label, not by index. The old turn_start "sleep_skip"
  // (modify_turns −1) goes: the engine now ends the turn itself on a failed check,
  // and modify_turns at turn start only cut a LATER activation (a multi-turn boss
  // lost an extra turn; nobody else lost anything).
  const rows = f.reactionConfig?.reaction_config_table ?? {};
  for (const [k, r] of Object.entries(rows)) {
    if (r?.reaction_trigger === "turn_start" && r?.reaction_effect_ref === "sleep_skip") {
      upd[`flags.${M}.reactionConfig.reaction_config_table.-=${k}`] = null;
      n++;
      continue;
    }
    if (r?.reaction_trigger !== "creature_lose_resource") continue;
    if (String(r.condition_formula ?? "").trim() !== WAKE_GATE) {
      upd[`flags.${M}.reactionConfig.reaction_config_table.${k}.condition_formula`] = WAKE_GATE;
      n++;
    }
  }
  for (const [k, row] of Object.entries(f.reactionConfig?.effect_table ?? {})) {
    if (row?.effect_label === "sleep_skip") { upd[`flags.${M}.reactionConfig.effect_table.-=${k}`] = null; n++; }
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

// "Deal 【HR + 15% of the target Max HP】 Dark damage": the HR part is the spell's own
// damage; the 15% rides an outgoing adjust_damage row fired by the spell's own
// will-deal-damage reaction, read per target (Scorched Claw's 25% uses the same shape).
const NM_LABEL = "nm_maxhp";
const NM_EFFECT = { effect_label: NM_LABEL, effect_kind: "adjust_damage", damage_operation: "add", damage_stage: "outgoing", damage_amount: "floor(TARGET_MAX_HP * 0.15)", $deleted: false };
const NM_REACTION = { reaction_trigger: "creature_will_deal_damage", reaction_source: "self", reaction_source_skill: "Nightmare", reaction_passive_mode: "force", reaction_effect_ref: NM_LABEL, $deleted: false };
const nextKey = (o) => String(Object.keys(o ?? {}).map(Number).filter(Number.isFinite).reduce((m, k) => Math.max(m, k + 1), 0));

async function tagNightmare(item, label, out) {
  if (item?.name !== "Nightmare" || String(item.system?.props?.skill_type ?? "").toLowerCase() !== "spell") return 0;
  const p = item.system?.props ?? {};
  const upd = {};
  const tags = String(p.skill_tags ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!tags.map((t) => t.toLowerCase()).includes("dream")) upd["system.props.skill_tags"] = [...tags, "dream"].join(", ");
  const fx = p.effect_table ?? {};
  if (!Object.values(fx).some((r) => r && !r.$deleted && r.effect_label === NM_LABEL)) upd[`system.props.effect_table.${nextKey(fx)}`] = { ...NM_EFFECT };
  const rx = p.reaction_config_table ?? {};
  if (!Object.values(rx).some((r) => r && !r.$deleted && r.reaction_effect_ref === NM_LABEL)) upd[`system.props.reaction_config_table.${nextKey(rx)}`] = { ...NM_REACTION };
  if (p.isReaction !== true) upd["system.props.isReaction"] = true;
  if (!Object.keys(upd).length) return 0;
  await item.update(upd);
  out.push(`Nightmare (dream tag, +15% Max HP row) ~ ${label}`);
  return 1;
}

// Panic: the new icon on its AE (library + every live copy still on Stun.png).
async function panicIcon(parent, label, out) {
  const updates = [];
  for (const e of parent?.effects ?? []) {
    const isPanic = e.id === PANIC_AE || e.name === "Panic" || new Set(Array.from(e.statuses ?? [])).has(PANIC_STATUS_ID);
    if (isPanic && String(e.img ?? "").endsWith("Stun.png")) updates.push({ _id: e.id, img: PANIC_ICON });
  }
  if (!updates.length) return 0;
  await parent.updateEmbeddedDocuments("ActiveEffect", updates);
  out.push(`Panic icon ~ ${label} (${updates.length})`);
  return updates.length;
}

// Hypno Pendulum's Sleep spell (row label hypno_sleep): drop the fixed 1 charge so
// the Sleep template's 3 rounds apply; the spell and pendulum text lose "for 1 Round".
const ONE_ROUND = " for 1 Round";
async function hypnoSleep(item, label, out) {
  const p = item?.system?.props ?? {};
  const upd = {};
  let isHypno = item?.name === "Hypno Pendulum";
  for (const [k, r] of Object.entries(p.effect_table ?? {})) {
    if (r?.effect_label !== "hypno_sleep") continue;
    isHypno = true;
    if (r.ae_initial_charges) upd[`system.props.effect_table.${k}.ae_initial_charges`] = "";
    if (r.ae_initial_charges_max) upd[`system.props.effect_table.${k}.ae_initial_charges_max`] = "";
    if (r.ae_duplicate_mode !== "skip") upd[`system.props.effect_table.${k}.ae_duplicate_mode`] = "skip";
  }
  if (!isHypno) return 0;
  for (const key of ["skill_description", "description"]) {
    const v = p[key];
    if (typeof v === "string" && v.includes(ONE_ROUND)) upd[`system.props.${key}`] = v.split(ONE_ROUND).join("");
  }
  for (const [k, r] of Object.entries(p.item_skill_active ?? {})) {
    const v = r?.skill_description;
    if (typeof v === "string" && v.includes(ONE_ROUND)) upd[`system.props.item_skill_active.${k}.skill_description`] = v.split(ONE_ROUND).join("");
  }
  if (!Object.keys(upd).length) return 0;
  await item.update(upd);
  out.push(`Hypno Sleep uses 3 rounds ~ ${label}`);
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
  const panicJ = game.journal.get(PANIC_JOURNAL);
  for (const p of panicJ?.pages ?? []) {
    const c = String(p.text?.content ?? "");
    if (p.type === "text" && c.includes(BF + "Stun.png")) {
      await p.update({ "text.content": c.split(BF + "Stun.png").join(PANIC_ICON) });
      out.push("Panic journal icon updated");
      n++;
    }
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
  const stunAe = box.effects.get(STUN_AE_ID) ?? box.effects.find((e) => e.name === "Stunned");
  if (stunAe && stunAe.flags?.[M]?.holdPose !== "hurt") {
    await stunAe.update({ [`flags.${M}.holdPose`]: "hurt" });
    out.push("Stunned holds the hurt pose");
    n++;
  }

  n += await patchSleep(box, "Debuff library", true, out);
  n += await panicIcon(box, "Debuff library", out);
  for (const item of game.items ?? []) {
    if (item.id !== DEBUFF_CONTAINER) {
      n += await patchSleep(item, `Item ${item.name}`, false, out);
      n += await panicIcon(item, `Item ${item.name}`, out);
    }
    n += await tagNightmare(item, `Item ${item.id}`, out);
    n += await hypnoSleep(item, `Item ${item.name}`, out);
  }
  for (const actor of game.actors ?? []) {
    n += await patchSleep(actor, `Actor ${actor.name}`, false, out);
    n += await panicIcon(actor, `Actor ${actor.name}`, out);
    for (const item of actor.items ?? []) {
      n += await patchSleep(item, `${actor.name} / ${item.name}`, false, out);
      n += await panicIcon(item, `${actor.name} / ${item.name}`, out);
      n += await tagNightmare(item, `${actor.name}`, out);
      n += await hypnoSleep(item, `${actor.name} / ${item.name}`, out);
    }
  }
  for (const scene of game.scenes ?? []) {
    for (const t of scene.tokens ?? []) {
      if (t.actorLink || !t.actor) continue;
      n += await patchSleep(t.actor, `${scene.name} / ${t.name}`, false, out);
      n += await panicIcon(t.actor, `${scene.name} / ${t.name}`, out);
    }
  }
  n += await journals(out);

  for (const l of out) log(l);
  return { applied: true, summary: `${n} write(s)` + (out.length ? ` | ${out.join(" | ")}` : "") };
}
