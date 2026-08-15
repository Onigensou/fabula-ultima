// Guest Roster — the authoring surface for party Guests.
//
// A Guest is a party-side helper that fights alongside the party but is inert
// to every targeting and bookkeeping pass: it can never be targeted, counted as
// an ally/enemy for a condition, or defeated. The engine already understood the
// concept — `flags["fabula-ultima-companion"].bdGuest` is read by the action
// reader, the targeting resolver, the defeat reactor, the snapshot builder and
// the formula evaluator — but there was NO way to author one. The flag had to be
// set by hand and the guest had to be injected into a hand-built Battle Director
// payload. This module is the missing half: a roster on the party sheet.
//
// Source of truth is the DB actor's `system.props.guest_table` (a CSB dynamic
// table added to the Global_Database template). Rows carry:
//   guest_id      — the actor's id or "Actor.<id>" uuid, same contract as the
//                   sibling bench_id_* / away_id_* fields
//   guest_name    — display name, filled in from the actor by sync
//   guest_active  — deploys to battle? (unchecked = kept on the roster, benched)
//
// The bdGuest FLAG is derived, never authored: `syncGuestRoster()` stamps it on
// every rostered actor and clears it from any actor the roster previously owned.
// Ownership is tracked with a second flag (`bdGuestFromRoster`) so an actor that
// was flagged by hand — Kalina, before this existed — is never silently
// un-flagged by a roster it was never on.

// Own tag rather than the Battle Director's — this is a party-SHEET feature that
// the director happens to consume, and "[BD]" on a sheet write reads as a bug.
const TAG = "[GuestRoster]";
const log = (...a) => console.log(TAG, ...a);
const warn = (...a) => console.warn(TAG, ...a);

const MODULE_ID = "fabula-ultima-companion";
const FLAG_NS = MODULE_ID;

export const GUEST_TABLE_KEY = "guest_table";
const PROP_PATH = `system.props.${GUEST_TABLE_KEY}`;

const FLAG_GUEST = "bdGuest";
const FLAG_FROM_ROSTER = "bdGuestFromRoster";

// ── The Guest passive ───────────────────────────────────────────────────────
// Untargetability is NOT a bespoke engine rule keyed on the guest flag — it is a
// declaration in the shared targeting contract. The Guest passive is an
// ActiveEffect carrying `cannot_be_targeted_by: "any"`, the same key Guard's
// "Covered" uses for `"melee"`, and every target pool honours it:
// snapshot's eligible-target builders, skill-targeting's candidate pools,
// ActionReader's own pool, and the ENEMY_COUNT / ALLY_COUNT identifiers.
//
// Consequence worth knowing: this is DERIVED state, granted and revoked by the
// roster exactly like the flag. Do not hand-edit it — a sync will put it back.
// A creature that should be untargetable WITHOUT being a guest simply carries
// its own AE with the same change row; nothing here is Kalina-specific.
const GUEST_AE_NAME = "Guest";
const GUEST_AE_FLAG = "bdGuestPassive";      // marks the AE as roster-owned
const GUEST_AE_IMG = "icons/svg/eye.svg";

function guestPassiveData() {
  return {
    name: GUEST_AE_NAME,
    img: GUEST_AE_IMG,   // `img`, not the v12-deprecated `icon` — breaks on v13
    description: "<p><em>Guest:</em> fights alongside the party, but can never be "
      + "targeted, counted or defeated.</p>",
    disabled: false,
    transfer: false,
    changes: [
      // mode 5 = OVERRIDE, matching the existing cannot_be_targeted_by precedent.
      { key: "cannot_be_targeted_by", mode: 5, value: "any", priority: 0 },
    ],
    flags: { [FLAG_NS]: { [GUEST_AE_FLAG]: true } },
  };
}

function findGuestPassive(actor) {
  return (actor?.effects?.contents ?? []).find(
    (ae) => ae?.flags?.[FLAG_NS]?.[GUEST_AE_FLAG]
  ) ?? null;
}

/** Ensure the actor carries the Guest passive. Idempotent; repairs a disabled or
 *  drifted copy rather than stacking a second one. */
async function grantGuestPassive(actor) {
  const existing = findGuestPassive(actor);
  if (!existing) {
    await actor.createEmbeddedDocuments("ActiveEffect", [guestPassiveData()]);
    return "created";
  }
  const change = (existing.changes ?? []).find((c) => c.key === "cannot_be_targeted_by");
  const ok = !existing.disabled
    && String(change?.value ?? "").trim().toLowerCase() === "any";
  if (ok) return "ok";
  await existing.update({ disabled: false, changes: guestPassiveData().changes });
  return "repaired";
}

/** Public: re-assert the passive on one actor. Called at battle start so a
 *  guest can never DEPLOY without it — see the note in resolveGuestMembers. */
export async function ensureGuestPassive(actor) {
  if (!actor || !game.user?.isGM) return null;
  try { return await grantGuestPassive(actor); }
  catch (e) { warn(`ensureGuestPassive failed for ${actor?.name}`, e); return null; }
}

async function revokeGuestPassive(actor) {
  const existing = findGuestPassive(actor);
  if (!existing) return false;
  await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id]);
  return true;
}

// ── DB actor ────────────────────────────────────────────────────────────────
// The roster lives on the world DB actor, NOT on the token override the
// resolver also hands back. The override exists for per-SCENE custom props; a
// guest roster is a property of the campaign, not of whichever scene is open.
export async function getRosterActor() {
  try {
    const { db } = (await globalThis.FUCompanion?.api?.getCurrentGameDb?.()) ?? {};
    return db ?? null;
  } catch (e) {
    warn("DB resolve failed", e);
    return null;
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────
const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";

/**
 * Raw rows, in table order, with CSB's soft-deleted rows dropped.
 * Row keys are the dynamic table's own indices — CSB deletes with `-=<idx>`
 * and never reindexes, so a key is a STABLE handle to a row (holes are normal).
 */
export function readGuestRows(rosterActor) {
  const table = foundry.utils.getProperty(rosterActor ?? {}, PROP_PATH) ?? {};
  const out = [];
  for (const [rowKey, row] of Object.entries(table)) {
    if (!row || typeof row !== "object") continue;
    if (row.$deleted) continue;
    out.push({
      rowKey,
      id: String(row.guest_id ?? "").trim(),
      name: String(row.guest_name ?? "").trim(),
      active: row.guest_active === undefined ? true : truthy(row.guest_active),
    });
  }
  // Numeric row keys, ordered — the sheet renders them in this order too.
  out.sort((a, b) => (Number(a.rowKey) || 0) - (Number(b.rowKey) || 0));
  return out;
}

async function resolveActorRef(ref) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  try {
    if (/^Actor\./i.test(raw)) return await fromUuid(raw);
    return game.actors?.get(raw) ?? (await fromUuid(`Actor.${raw}`).catch(() => null));
  } catch { return null; }
}

/**
 * The roster, resolved to real actors.
 * @param {object} [opts]
 * @param {boolean} [opts.activeOnly=true] drop rows whose "In Party" box is off
 * @returns {Promise<Array<{rowKey,actor,actorId,actorUuid,name,img,active}>>}
 */
export async function resolveGuestRoster({ activeOnly = true } = {}) {
  const rosterActor = await getRosterActor();
  if (!rosterActor) return [];
  const out = [];
  for (const row of readGuestRows(rosterActor)) {
    if (activeOnly && !row.active) continue;
    if (!row.id) continue;
    const actor = await resolveActorRef(row.id);
    if (!actor) { warn(`row ${row.rowKey}: unresolved actor ref "${row.id}"`); continue; }
    out.push({
      rowKey: row.rowKey,
      actor,
      actorId: actor.id,
      actorUuid: actor.uuid,
      // The row's name is an optional display alias; the actor's name is truth.
      name: row.name || actor.name,
      img: actor.img ?? null,
      active: row.active,
    });
  }
  return out;
}

/** Is this actor on the roster at all (active or benched)? */
export async function isRosteredGuest(actorOrId) {
  const id = actorOrId?.id ?? String(actorOrId ?? "");
  const roster = await resolveGuestRoster({ activeOnly: false });
  return roster.some((g) => g.actorId === id);
}

// ── Writing ─────────────────────────────────────────────────────────────────
// Next free row index. CSB's own _createRow does `Math.max(...keys) + 1`, which
// yields -Infinity on an EMPTY table; allocate defensively so the first row a
// drag-drop creates is "0" and not a broken key.
function nextRowKey(table) {
  const nums = Object.keys(table ?? {}).map(Number).filter((n) => Number.isFinite(n));
  return String(nums.length ? Math.max(...nums) + 1 : 0);
}

/**
 * Add an actor to the roster. Idempotent — an actor already rostered is
 * re-activated rather than duplicated.
 * @returns {Promise<{ok:boolean, rowKey?:string, reason?:string}>}
 */
export async function addGuest(actorRef, { active = true } = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "GM only" };
  const rosterActor = await getRosterActor();
  if (!rosterActor) return { ok: false, reason: "no DB actor" };

  const actor = actorRef?.documentName === "Actor" ? actorRef : await resolveActorRef(actorRef);
  if (!actor) return { ok: false, reason: "actor not resolved" };
  if (actor.id === rosterActor.id) return { ok: false, reason: "that is the party sheet itself" };

  const table = foundry.utils.getProperty(rosterActor, PROP_PATH) ?? {};
  const existing = readGuestRows(rosterActor).find((r) => {
    const raw = r.id.replace(/^Actor\./i, "");
    return raw === actor.id;
  });

  if (existing) {
    // Re-adding re-DEPLOYS; it does not re-author. Writing the actor's name
    // unconditionally here would silently discard a display alias the GM typed
    // ("The Masked Girl" -> "Kalina") with no warning and no undo — so only a
    // BLANK name gets filled, matching what syncGuestRoster does.
    const patch = { [`${PROP_PATH}.${existing.rowKey}.guest_active`]: active };
    if (!existing.name) patch[`${PROP_PATH}.${existing.rowKey}.guest_name`] = actor.name;
    await rosterActor.update(patch);
    return { ok: true, rowKey: existing.rowKey, existed: true };
  }

  const rowKey = nextRowKey(table);
  await rosterActor.update({
    [`${PROP_PATH}.${rowKey}`]: {
      $deleted: false,
      guest_id: actor.id,
      guest_name: actor.name,
      guest_active: active,
    },
  });
  log(`added "${actor.name}" as row ${rowKey}`);
  return { ok: true, rowKey };
}

/**
 * Remove a row. Uses CSB's own deletion form (`-=<idx>`), so the sheet and the
 * table agree about what a removed row means.
 */
export async function removeGuest(rowKey) {
  if (!game.user?.isGM) return { ok: false, reason: "GM only" };
  const rosterActor = await getRosterActor();
  if (!rosterActor) return { ok: false, reason: "no DB actor" };

  const table = foundry.utils.getProperty(rosterActor, PROP_PATH) ?? {};
  if (!(rowKey in table)) return { ok: false, reason: `row ${rowKey} not present` };

  await rosterActor.update({ [PROP_PATH]: { [`-=${rowKey}`]: true } });
  log(`removed row ${rowKey}`);
  return { ok: true };
}

/** Flip a row's "In Party" box without removing it from the roster. */
export async function setGuestActive(rowKey, active) {
  if (!game.user?.isGM) return { ok: false, reason: "GM only" };
  const rosterActor = await getRosterActor();
  if (!rosterActor) return { ok: false, reason: "no DB actor" };
  await rosterActor.update({ [`${PROP_PATH}.${rowKey}.guest_active`]: !!active });
  return { ok: true };
}

// ── Derived flag sync ───────────────────────────────────────────────────────
/**
 * Make `bdGuest` agree with the roster.
 *
 * Sets the flag on every rostered actor (active OR benched — a benched guest is
 * still a guest; "In Party" governs DEPLOYMENT, not the creature's nature), and
 * clears it from any actor this roster previously owned but no longer lists.
 *
 * An actor carrying bdGuest WITHOUT the ownership marker was flagged by hand and
 * is left strictly alone — the roster only ever un-flags what it flagged.
 */
export async function syncGuestRoster() {
  if (!game.user?.isGM) return { ok: false, reason: "GM only" };
  const rosterActor = await getRosterActor();
  if (!rosterActor) return { ok: false, reason: "no DB actor" };

  const rows = readGuestRows(rosterActor);
  const rostered = new Map();   // actorId -> { actor, row }
  const nameFixes = {};

  for (const row of rows) {
    if (!row.id) continue;
    const actor = await resolveActorRef(row.id);
    if (!actor) continue;
    rostered.set(actor.id, { actor, row });
    // Keep the displayed name honest when an actor is renamed. Only fill a
    // BLANK cell — a GM who typed an alias keeps it.
    if (!row.name) nameFixes[`${PROP_PATH}.${row.rowKey}.guest_name`] = actor.name;
  }
  if (Object.keys(nameFixes).length) await rosterActor.update(nameFixes);

  let flagged = 0;
  let cleared = 0;

  let passives = 0;

  for (const { actor } of rostered.values()) {
    // The PASSIVE is checked every sync, not only on first flagging: it is what
    // actually makes the creature untargetable, and it can drift independently
    // of the flag (disabled by hand, deleted with the effects panel, lost to a
    // sheet operation). Repairing it is the whole point of the Sync button.
    const state = await grantGuestPassive(actor);
    if (state !== "ok") passives++;

    const has = !!actor.getFlag(FLAG_NS, FLAG_GUEST);
    const owned = !!actor.getFlag(FLAG_NS, FLAG_FROM_ROSTER);
    if (has && owned) continue;
    await actor.setFlag(FLAG_NS, FLAG_GUEST, true);
    await actor.setFlag(FLAG_NS, FLAG_FROM_ROSTER, true);
    flagged++;
  }

  // Anything we own that fell off the roster gives BOTH back.
  for (const actor of game.actors ?? []) {
    if (rostered.has(actor.id)) continue;
    if (!actor.getFlag(FLAG_NS, FLAG_FROM_ROSTER)) continue;   // never ours -> never touched
    await actor.unsetFlag(FLAG_NS, FLAG_GUEST);
    await actor.unsetFlag(FLAG_NS, FLAG_FROM_ROSTER);
    // Revoke only the roster-OWNED passive (flagged bdGuestPassive). A creature
    // that carries its own hand-authored cannot_be_targeted_by AE keeps it.
    await revokeGuestPassive(actor);
    cleared++;
  }

  if (flagged || cleared || passives) {
    log(`sync: ${flagged} flagged, ${cleared} cleared, ${passives} passive(s) granted/repaired, ${rostered.size} on roster`);
  }
  return { ok: true, rostered: rostered.size, flagged, cleared, passives };
}

// ── Keeping the flag honest ─────────────────────────────────────────────────
// The roster is editable by routes this module does not own: CSB's own per-row
// trash icon, and typing a different id straight into the Actor ID cell. Both
// change who is a guest without going through addGuest/removeGuest, so a sync
// driven only from those functions would leave the flag stranded on an actor
// that is no longer rostered. Watch the table itself instead.
let _syncing = false;

async function onRosterTableChanged(actor, changed) {
  if (!game.user?.isGM) return;
  if (_syncing) return;                                   // our own writes
  if (foundry.utils.getProperty(changed, PROP_PATH) === undefined) return;

  const rosterActor = await getRosterActor();
  if (!rosterActor || actor.id !== rosterActor.id) return;

  _syncing = true;
  try { await syncGuestRoster(); }
  catch (e) { warn("auto-sync failed", e); }
  finally { _syncing = false; }
}

// ── API surface ─────────────────────────────────────────────────────────────
Hooks.once("ready", () => {
  Hooks.on("updateActor", (actor, changed) => {
    onRosterTableChanged(actor, changed).catch((e) => warn("updateActor hook threw", e));
  });

  globalThis.FUCompanion ??= { api: {} };
  globalThis.FUCompanion.api ??= {};
  Object.assign(globalThis.FUCompanion.api, {
    resolveGuestRoster,
    readGuestRoster: readGuestRows,
    addGuest,
    removeGuest,
    setGuestActive,
    syncGuestRoster,
    isRosteredGuest,
  });
});
