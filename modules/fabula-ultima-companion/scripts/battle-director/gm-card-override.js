// scripts/battle-director/gm-card-override.js
//
// Manual GM overrides for an in-flight Action Card — the surface the main GM and
// any support GM use to correct a roll at the table. Edited in a separate editor
// card (see openGmEditCard in action-card.js) and committed on Save.
//
// ── What can be overridden ───────────────────────────────────────────────────
//   roll      the accuracy check itself: each die's SIZE and rolled VALUE, plus
//             the flat bonus. Total, Highest Roll, crit and fumble are RE-DERIVED
//             from those through deriveCheck — never set directly — so a
//             hand-entered pair of dice obeys the same crit/fumble rules as a
//             real roll, including this actor's own crit range and fumble
//             threshold.
//   damage    the action's damage composition: base, whether Highest Roll is
//             added, and a flat bonus.
//   perTarget a specific target's verdict, final damage, or defence.
//   reactions whether a reaction candidate on this card fires at all — force one
//             the player skipped, or suppress one the engine auto-applied.
//
// ── Why source values, not results ───────────────────────────────────────────
// Overriding the DICE rather than the total means everything downstream stays
// consistent by construction: HR moves with the dice, so damage follows; crit
// follows the pair; per-target hit re-derives against each defence. Setting a
// total alone would leave HR (and therefore damage) describing dice nobody
// rolled.
//
// ── Two invariants that make this safe ───────────────────────────────────────
//
// 1. EVERY override is ABSOLUTE (set-to-value), never a delta. This makes the
//    layer IDEMPOTENT, so it is safe to run on the card-preview recompute (which
//    fires on every pill click) and again at the CONFIRM commit with no
//    double-counting. A delta design would silently double every edit that
//    survived a preview.
//
// 2. Overrides are threaded INTO the recompute, not patched on after it — with
//    one deliberate exception (per-target damage, a leaf; see
//    applyGmDamageOverrides). The engine derives hit/miss and damage TOGETHER in
//    buildPerTarget; a hit forced after the fact leaves damage stuck at 0, which
//    is the exact bug action-profile.js documents at its accuracy fold-in.
//
// The bag lives at `ar.gmOverride` so it rides the frozen actionResult through
// persistence and through every `{...ar}` projection that names it — see the
// arSnapshot projection in action-card.js, which must list the field explicitly
// (an unlisted field is silently dropped there).

const EDITOR_LOG_CAP = 12;

// Offered in the editor's die-size pickers. Fabula Ultima attributes run d6–d12;
// d4 and d20 are included because statuses shift a die down and a few effects
// push one past d12.
export const GM_DIE_SIZES = Object.freeze([4, 6, 8, 10, 12, 20]);

// Damage elements and weapon categories offered in the editor's dropdowns.
// Kept in step with AFFINITY_ELEMENTS (action-reader/actionReader-core.js) and
// the weapon set the encyclopedia + WEAPON_ICON map use, so a GM can only pick
// something the affinity and weapon-efficiency tables actually understand.
export const GM_DAMAGE_TYPES = Object.freeze([
  "physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison",
]);
export const GM_WEAPON_TYPES = Object.freeze([
  "arcane", "bow", "brawling", "dagger", "firearm", "flail", "heavy", "spear", "sword", "thrown",
]);
const oneOf = (v, list) => {
  const s = String(v ?? "").toLowerCase().trim();
  return s && list.includes(s) ? s : null;
};

export const EMPTY_GM_OVERRIDE = Object.freeze({
  version: 2,
  roll: null,
  damage: null,
  perTarget: Object.freeze({}),
  reactions: Object.freeze({}),
  targets: Object.freeze({ removed: Object.freeze([]), added: Object.freeze([]) }),
  editors: Object.freeze([]),
});

// Identity of a reaction candidate inside the bag. The card's own decision map
// keys on `rowKey:carrierUuid`; this uses a DOUBLE colon deliberately so the two
// namespaces can never be passed to each other by accident — a bag key handed to
// the decision map silently addresses nothing, and that failure is invisible.
export const gmReactionKey = (rowKey, carrierUuid) =>
  `${String(rowKey ?? "")}::${String(carrierUuid ?? "")}`;

// Strict integer coercion. Deliberately NOT `Number.isFinite(Number(v))`:
// Number(null), Number("") and Number(false) are all 0, so that test accepts
// every "no value" form and silently turns a CLEARED override into a hard 0 —
// i.e. "revert this damage" would read as "set this damage to 0". Since this
// runs on socket payloads from another GM's client, the distinction between
// absent and zero has to survive the trust boundary.
function toInt(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
const toBool = (v) => (v === true || v === false ? v : null);

// Keep only the fields that are actually set, so an all-null section normalizes
// back to `null` and `isGmOverrideEmpty` stays honest.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : null;
}

// Coerce anything (a persisted bag, a socket payload, undefined) into the
// canonical shape. Unknown keys are dropped — this is a trust boundary.
export function normalizeGmOverride(ov) {
  if (!ov || typeof ov !== "object") return EMPTY_GM_OVERRIDE;

  const r = ov.roll ?? {};
  const roll = compact({
    dA: clampDie(toInt(r.dA)), rA: toInt(r.rA),
    dB: clampDie(toInt(r.dB)), rB: toInt(r.rB),
    bonus: toInt(r.bonus),
  });

  const d = ov.damage ?? {};
  const damage = compact({
    base: toInt(d.base), useHR: toBool(d.useHR), bonus: toInt(d.bonus),
    // Whitelisted, not free text: these feed the affinity and weapon-efficiency
    // lookups, and an unknown value would silently resolve to "no affinity" /
    // "no efficiency" rather than failing visibly.
    element: oneOf(d.element, GM_DAMAGE_TYPES),
    weaponType: oneOf(d.weaponType, GM_WEAPON_TYPES),
  });

  const perTarget = {};
  for (const [uuid, raw] of Object.entries(ov.perTarget ?? {})) {
    if (!uuid || !raw || typeof raw !== "object") continue;
    const row = compact({
      hit: toBool(raw.hit), damage: toInt(raw.damage), defense: toInt(raw.defense),
    });
    if (row) perTarget[uuid] = row;
  }

  // Reactions — `key → true | false | "ask"` (force | suppress | un-decided).
  // Anything else is DROPPED rather than coerced: "no opinion" is a further
  // state, and it has to stay distinguishable from "suppress".
  //
  // `"ask"` records only ONE thing: do not let this candidate auto-fire again.
  // The un-deciding itself is the patch's `reopen` list (an action). Storing the
  // instruction is what makes it survive a card re-post — an F5 rebuilds the
  // decision map from scratch, and without this the `on`/`force` auto-apply at
  // spawn silently re-applied a reaction the GM had just un-applied.
  const reactions = {};
  for (const [key, raw] of Object.entries(ov.reactions ?? {})) {
    if (!key) continue;
    if (raw === "ask") { reactions[key] = "ask"; continue; }
    const v = toBool(raw);
    if (v !== null) reactions[key] = v;
  }

  // Targets — TWO absolute sets of token uuids, not a final target list and not
  // a sequence of edits.
  //
  // Absolute, so the layer stays idempotent: the recompute rebuilds the target
  // set from the engine's own every pass and re-applies these on top, so running
  // it twice cannot double-add or double-remove.
  //
  // Two SETS rather than one "final list" because a reaction can legitimately
  // rewrite a slot mid-flight (Protect redirects an attack onto the protector).
  // A stored final list would silently undo that redirect the next time it was
  // applied — the GM's snapshot of the target set, taken when they opened the
  // editor, would outrank an engine mutation that happened afterwards. Keyed by
  // token instead, the two survive together: the redirect rewrites its slot, and
  // the GM's add/remove applies on top of whatever the engine produced.
  //
  // "Change this target" is not a third operation: it is a remove plus an add,
  // which is exactly how the editor presents it.
  const t = ov.targets ?? {};
  const uuidList = (v) => [...new Set((Array.isArray(v) ? v : [])
    .filter((u) => typeof u === "string" && u.length))];
  const removedUuids = uuidList(t.removed);
  const addedSet = new Set(removedUuids);
  const targets = {
    removed: removedUuids,
    // A token cannot be both added and removed. Removal wins: it is the
    // destructive call, and letting the pair coexist would make the result
    // depend on which loop ran last.
    added: uuidList(t.added).filter((u) => !addedSet.has(u)),
  };

  return {
    version: 2,
    roll, damage, perTarget, reactions, targets,
    editors: Array.isArray(ov.editors)
      ? ov.editors.filter((e) => e && e.userId).slice(-EDITOR_LOG_CAP)
        .map((e) => ({ userId: String(e.userId), userName: String(e.userName ?? ""), at: Number(e.at) || 0 }))
      : [],
  };
}

// A die size the engine can actually roll. An arbitrary number off the wire (or
// a typo in the editor) would otherwise reach the crit/fumble derivation and the
// card's die labels.
function clampDie(n) {
  if (n == null) return null;
  return GM_DIE_SIZES.includes(n) ? n : null;
}

export function isGmOverrideEmpty(ov) {
  const n = normalizeGmOverride(ov);
  return !n.roll && !n.damage && Object.keys(n.perTarget).length === 0
    && Object.keys(n.reactions).length === 0
    && n.targets.removed.length === 0 && n.targets.added.length === 0;
}

// Fold a patch into the existing bag and stamp WHO edited.
//
// `patch.replace` — the editor card's Save. It carries the COMPLETE intended
// state of roll/damage/perTarget, so those three are replaced wholesale rather
// than merged. Merging would make it impossible to clear a field: an omitted key
// means "leave alone", and the editor has no way to say "leave alone" about a
// box the GM just emptied. `editors` is never replaced — it is an audit trail.
//
// `patch.reset` drops every override.
//
// Otherwise the patch merges field-by-field, where an explicit `null` CLEARS
// that field (reverting it to the engine's value) and an ABSENT key leaves it
// untouched.
export function mergeGmOverride(prev, patch, editor = null) {
  const base = normalizeGmOverride(prev);
  const editors = stampEditor(base.editors, editor);

  if (patch?.reset) return normalizeGmOverride({ ...EMPTY_GM_OVERRIDE, editors });

  if (patch?.replace) {
    const rep = normalizeGmOverride({ ...patch.replace, editors });
    return rep;
  }

  const next = {
    version: 2,
    roll: base.roll ? { ...base.roll } : {},
    damage: base.damage ? { ...base.damage } : {},
    perTarget: { ...base.perTarget },
    reactions: { ...base.reactions },
    targets: { removed: [...base.targets.removed], added: [...base.targets.added] },
    editors,
  };
  mergeSection(next.roll, patch?.roll, ["dA", "rA", "dB", "rB", "bonus"]);
  mergeSection(next.damage, patch?.damage, ["base", "useHR", "bonus", "element", "weaponType"]);
  // Same null-clears rule as every other section, applied per candidate key.
  for (const [key, raw] of Object.entries(patch?.reactions ?? {})) {
    if (!key) continue;
    if (raw == null) delete next.reactions[key];
    else next.reactions[key] = raw;
  }
  // Whole-set replacement per side — a target edit is a set membership, so
  // there is no per-key merge to do.
  if (patch?.targets?.removed) next.targets.removed = patch.targets.removed;
  if (patch?.targets?.added) next.targets.added = patch.targets.added;
  for (const [uuid, raw] of Object.entries(patch?.perTarget ?? {})) {
    if (!uuid) continue;
    const row = { ...(next.perTarget[uuid] ?? {}) };
    mergeSection(row, raw, ["hit", "damage", "defense"]);
    if (Object.keys(row).length) next.perTarget[uuid] = row;
    else delete next.perTarget[uuid];
  }
  return normalizeGmOverride(next);
}

function mergeSection(target, patch, fields) {
  if (!patch) return;
  for (const f of fields) {
    if (!(f in patch)) continue;
    if (patch[f] == null) delete target[f];
    else target[f] = patch[f];
  }
}

function stampEditor(editors, editor) {
  if (!editor?.userId) return editors;
  const kept = (editors ?? []).filter((e) => e.userId !== editor.userId);
  return [...kept, { userId: String(editor.userId), userName: String(editor.userName ?? ""), at: Number(editor.at) || Date.now() }]
    .slice(-EDITOR_LOG_CAP);
}

// ── Composition into the engine ─────────────────────────────────────────────

// Build the REPLACEMENT accuracy roll from the GM's dice, or return null when no
// roll field is set. Mirrors what check_reroll produces, so the card's existing
// replaced-roll path renders and commits it with no new plumbing.
//
// Every unset field falls back to the engine's own value, so editing one die
// leaves the other exactly as rolled. `deriveCheck` owns total/HR/crit/fumble —
// this function only chooses the inputs.
export function composeGmRoll(ar, gmOverride, deriveCheckFn, attackerProps = null, fumbleThreshold = 1) {
  const gm = normalizeGmOverride(gmOverride);
  const eng = ar?.roll;
  if (!gm.roll || !eng) return null;
  const rA = gm.roll.rA ?? Number(eng.rA) ?? 0;
  const rB = gm.roll.rB ?? Number(eng.rB) ?? 0;
  const dA = gm.roll.dA ?? Number(eng.dA) ?? 0;
  const dB = gm.roll.dB ?? Number(eng.dB) ?? 0;
  // `bonus` is an ADJUSTMENT, added on top of whatever the action already
  // carries — the same shape as the damage adjustment, so the two read the
  // same way. It replaced the action's own bonus once, which meant a GM nudging
  // accuracy by +1 silently deleted an existing +8. The editor shows the
  // existing bonus as a separate read-only fact so the sum is never a guess.
  const checkBonus = (Number(eng.checkBonus) || 0) + (gm.roll.bonus ?? 0);
  const derived = deriveCheckFn({ rA, rB, props: attackerProps, fumbleThreshold, checkBonus });
  return {
    ...eng,
    ...derived,
    dA, dB,
    // Marks this roll as GM-authored for the card's accuracy fieldset, which
    // otherwise cannot tell a hand-set roll from a rerolled one.
    gmSet: true,
  };
}

// The damage inputs buildPerTarget and the headline damage object both consult.
// Returns null when untouched, which keeps the engine on its exact default path.
export function gmDamageInput(gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  if (!gm.damage) return null;
  return {
    base: gm.damage.base ?? null,          // null = keep the engine's composed base
    useHR: gm.damage.useHR ?? null,        // null = keep the engine's HR behaviour
    bonus: gm.damage.bonus ?? 0,
    element: gm.damage.element ?? null,    // null = keep the action's own element
    weaponType: gm.damage.weaponType ?? null,
  };
}

// Apply the GM's element / weapon-category choice to the computed `primary`
// descriptor, IN PLACE, before per-target derivation.
//
// One mutation point rather than patching results: `primary.element` drives the
// target's affinity lookup, damage-reduction-by-element and the Hex element,
// while `primary.weaponKey` drives weapon efficiency. Setting the row's element
// after the fact would relabel the damage without re-running any of that, so a
// fire attack retyped as ice would still be resisted like fire.
//
// Every field in the element read-ladder is set, because a reaction's own
// element override sits at the front of it and the GM has to outrank it.
export function applyGmPrimaryOverrides(primary, gmDamage) {
  if (!primary || !gmDamage) return primary;
  if (gmDamage.element) {
    primary.element = gmDamage.element;
    primary.nativeElement = gmDamage.element;
    primary.overriddenElement = gmDamage.element;
    primary.gmElementSet = true;
  }
  if (gmDamage.weaponType) {
    primary.weaponKey = gmDamage.weaponType;
    primary.weaponType = gmDamage.weaponType;
    primary.gmWeaponSet = true;
  }
  return primary;
}

// Apply the GM damage inputs to an engine-composed (flatBase, hr) pair. Single
// helper so buildPerTarget and the headline damage object cannot drift on what
// "base + HR + bonus" means.
//
// `bonus` is an ADJUSTMENT on top of whichever base is in force — matching the
// accuracy adjustment exactly, so a GM learns one behaviour rather than two.
// `base` is the separate "the base itself was wrong" override, and still
// replaces.
export function applyGmDamageInput(gmDamage, flatBase, hr) {
  if (!gmDamage) return { flat: flatBase, hr };
  const flat = (gmDamage.base ?? flatBase) + (gmDamage.bonus ?? 0);
  const useHr = gmDamage.useHR == null ? true : !!gmDamage.useHR;
  return { flat, hr: useHr ? hr : 0 };
}

// GM per-target defense → appended to the engine's defenseOverrides list. The GM
// entry goes LAST so it wins on a slot a reaction also bumped.
export function composeGmDefenseOverrides(gmOverride, engineOverrides, perTargets) {
  const gm = normalizeGmOverride(gmOverride);
  const out = Array.isArray(engineOverrides) ? [...engineOverrides] : [];
  for (const [tokenUuid, row] of Object.entries(gm.perTarget)) {
    if (toInt(row?.defense) == null) continue;
    const pt = (perTargets ?? []).find((p) => p?.tokenUuid === tokenUuid);
    out.push({
      tokenUuid, actorUuid: pt?.actorUuid ?? null,
      from: Number(pt?.defense ?? 10), to: Number(row.defense),
      via: "GM adjustment", gm: true,
    });
  }
  return out;
}

// GM forced hit/miss → a plain { tokenUuid: bool } map consumed by
// resolveTargetOutcome inside buildPerTarget, so the forced verdict is known
// BEFORE damage is derived. Null when nothing is forced.
export function gmHitOverrideMap(gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  const map = {};
  for (const [tokenUuid, row] of Object.entries(gm.perTarget)) {
    if (row?.hit === true || row?.hit === false) map[tokenUuid] = row.hit;
  }
  return Object.keys(map).length ? map : null;
}

// GM absolute per-target damage → applied AFTER the recompute, unlike hit and
// defence. Safe here precisely because per-target damage is a LEAF: nothing
// downstream re-derives from it (hit is decided, affinity folded). Threading it
// into buildPerTarget would instead mean fighting the affinity/DR pipeline to
// make the result land on the exact number the GM typed — their figure is final,
// not an input to further math.
export function applyGmDamageOverrides(perTargetResults, gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  const rows = Array.isArray(perTargetResults) ? perTargetResults : [];
  if (!rows.length) return rows;
  let touched = false;
  const out = rows.map((row) => {
    const ov = row?.tokenUuid ? gm.perTarget[row.tokenUuid] : null;
    const dmg = ov ? toInt(ov.damage) : null;
    if (dmg == null) return row;
    touched = true;
    return { ...row, damage: dmg, rawDamage: dmg, gmDamageSet: true };
  });
  return touched ? out : rows;
}

// Recompute the hit list from the FINAL rows. The engine builds hitTokenUuids
// before the GM layer runs, so a forced verdict must be reflected here or on-hit
// rider AEs land on the pre-override victim set.
export function recomputeHitTokenUuids(perTargetResults, fallback = null) {
  const rows = Array.isArray(perTargetResults) ? perTargetResults : null;
  if (!rows) return fallback;
  return rows.filter((r) => r?.hit && r?.tokenUuid).map((r) => r.tokenUuid);
}

// ── Reactions ───────────────────────────────────────────────────────────────
//
// The GM's verdict on ONE candidate: "apply" (force it to fire), "skip"
// (suppress it), or null (no opinion — leave the engine and the player alone).
export function gmReactionDecision(gmOverride, rowKey, carrierUuid) {
  const gm = normalizeGmOverride(gmOverride);
  const v = gm.reactions[gmReactionKey(rowKey, carrierUuid)];
  // "ask" is NOT a verdict — it deliberately returns null so the ordinary
  // `want = gm ?? base` computation falls through to whatever has been decided
  // SINCE. That is what stops it replaying: once a player answers the reopened
  // question, their answer stands, and the stored "ask" only goes on suppressing
  // the auto-fire at spawn (see gmReactionBlocksAutoFire).
  return v === true ? "apply" : v === false ? "skip" : null;
}

// Does the bag forbid this candidate auto-applying at card spawn?
//
// The `on`/`force` auto-apply runs every time a card is built, including a
// re-post after an F5. A reaction the GM sent back to undecided must not quietly
// re-arm itself there — that would undo the un-decision with no trace, which is
// the one outcome "put it back to the table" cannot survive.
export function gmReactionBlocksAutoFire(gmOverride, rowKey, carrierUuid) {
  const gm = normalizeGmOverride(gmOverride);
  return gm.reactions[gmReactionKey(rowKey, carrierUuid)] === "ask";
}

// Which reaction candidates the editor offers a control for.
//
// Excluded, both for the same reason — the control would be a lie:
//   • CONDITION-unavailable rows. Their trigger does not apply to this action at
//     all, so "force" would run a chain against a situation it was never written
//     for. (COST-unavailable rows ARE offered: the trigger fired, the reactor
//     merely can't pay, and overruling a cost is a normal table call.)
//   • `_addTarget` rows (Barrage). Their Apply already spliced targets into the
//     live payload at click time — a later "suppress" cannot un-splice them, so
//     the control would silently do half of what it says. Adding and removing
//     targets is its own editor surface.
export function isGmEditableReaction(p) {
  if (!p) return false;
  // ── ADD_TARGET, in any form ────────────────────────────────────────────────
  // `_addTarget` (Barrage) splices at Apply-click. But `usesAddTarget` alone is
  // just as dangerous: state-handlers PRE-SPLICES every force/`on` add_target
  // candidate into the live actionResult BEFORE the card is even posted
  // (state-handlers.js, "force add_target pre-splice" — Grappling's shared-space
  // splash), and NOTHING removes a target again: applyTargetSetMutation only
  // ever starts from ar.targets and dedups additions.
  //
  // Gating on `_addTarget` alone therefore offered a Skip over a splice that had
  // already happened — the pill flipped to "Suppressed" while the extra target
  // stayed on the card, in the CONFIRM mutation and in hitTokenUuids, and took
  // damage at RESOLVE. Silent, and exactly backwards from what the control said.
  if (p._addTarget || p.usesAddTarget) return false;
  // ── UNAVAILABLE ────────────────────────────────────────────────────────────
  // Condition-unavailable: the trigger never applied, so forcing would run a
  // chain against a situation it was not written for.
  //
  // COST-unavailable is now blocked too, reversing an earlier call of mine. It
  // looked like "overruling a price is a normal table call", but the two halves
  // of a reaction are gated in different places: the card-mutation half
  // (redirect / adjust_damage / adjust_accuracy) applies at preview and COMMITS
  // at CONFIRM without ever consulting affordability, while the cost lives in
  // the chain and aborts at RESOLVE (`on_empty: "abort"`). Forcing an unpayable
  // reaction therefore banks the benefit and never pays the price — a
  // half-applied reaction, which is precisely what "they still have to go
  // through the process of the skill" forbids.
  if (p.available === false) return false;
  return true;
}

// Reconcile a card's live decision state against the bag.
//
// This is the WHOLE of how a GM reaction edit reaches the engine. The card's
// decision map is the single upstream of both the preview's `accepted` list and
// snapshotReactionDecisions() — which in turn feeds CONFIRM's mutation pass and
// RESOLVE's firePreAcceptedCandidate — so rewriting that map is the same
// "thread INTO the recompute, never patch results after it" rule the roll and
// damage sections follow. Nothing here touches a result.
//
//   candidates  the card's live cardReactions list
//   currentOf   (cand) → "apply" | "skip" | null — what the map holds NOW
//   baseOf      (cand) → "apply" | "skip" | null — what it would hold with no
//               GM opinion at all (auto-fire at spawn, or the player's click)
//
// Returns ONLY the candidates whose decision must change, so a save that
// re-states an override repaints and broadcasts nothing. `decision: null` means
// "delete the entry" — the GM cleared their override and no baseline exists, so
// the pill goes back to undecided rather than to a fabricated verdict.
// `reopenedKeys` — bag keys the GM has just sent back to UNDECIDED this pass.
// Their decision is null by construction (the caller has already cleared the
// base), and they are flagged so the pill repaint and the mirror broadcast can
// tell "the GM reopened this" from "an override was cleared and there was
// nothing underneath". The two look identical in the data and are not the same
// event: only the first has to re-arm a pill and tell the table why.
export function gmReactionDecisionChanges(candidates, gmOverride, currentOf, baseOf = () => null, reopenedKeys = null) {
  const out = [];
  for (const cand of (candidates ?? [])) {
    if (!isGmEditableReaction(cand)) continue;
    const reopened = !!reopenedKeys?.has?.(gmReactionKey(cand.rowKey, cand.carrierUuid));
    const gm = gmReactionDecision(gmOverride, cand.rowKey, cand.carrierUuid);
    const want = reopened ? null : (gm ?? baseOf(cand) ?? null);
    const cur = currentOf(cand) ?? null;
    if (want === cur) continue;
    out.push({
      rowKey: cand.rowKey, carrierUuid: cand.carrierUuid,
      carrierName: cand.carrierName ?? null,
      decision: want, from: cur, byGm: reopened || gm != null, reopened,
    });
  }
  return out;
}

// The reopen keys carried on an editor patch, validated.
//
// Reopen is an ACTION, not a stored verdict: "put this back to undecided" is an
// event, and a bag that recorded it would keep re-firing it on every later
// recompute — wiping whatever decision was made in the meantime. Keeping it off
// the bag is what lets every stored override stay absolute and idempotent.
export function readGmReopenKeys(patch) {
  const raw = Array.isArray(patch?.reopen) ? patch.reopen : [];
  return [...new Set(raw.filter((k) => typeof k === "string" && k.includes("::")))];
}

// ── Targets ─────────────────────────────────────────────────────────────────

// Drop the GM's removed tokens from a (targets, perTargets) pair, keeping the
// two parallel arrays in step.
//
// Returns fresh arrays and never mutates the inputs: `freezeActionResult`
// deep-freezes every target object, so writing one throws in strict mode — the
// same trap shield_redirect documents, where a single throw aborted a whole
// recompute pass and the card silently stopped repainting.
export function applyGmTargetRemovals(targets, perTargets, gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  if (!gm.targets.removed.length) return { targets, perTargets, removed: 0 };
  const drop = new Set(gm.targets.removed);
  const keptTargets = [], keptPer = [];
  const rows = Array.isArray(perTargets) ? perTargets : [];
  let removed = 0;
  for (let i = 0; i < (targets?.length ?? 0); i++) {
    const t = targets[i];
    if (t?.tokenUuid && drop.has(t.tokenUuid)) { removed++; continue; }
    keptTargets.push(t);
  }
  // The per-target rows are filtered by their OWN tokenUuid rather than by
  // index: a reaction can already have spliced the two arrays (add_target,
  // shield_redirect), so position is not a reliable join.
  for (const p of rows) {
    if (p?.tokenUuid && drop.has(p.tokenUuid)) continue;
    keptPer.push(p);
  }
  return { targets: keptTargets, perTargets: keptPer, removed };
}

// Reduce the editor's target-list ROWS to the bag's two sets.
//
// Pure, and exported rather than living inside the editor closure, because this
// reduction is where the whole target feature is decided and a DOM-bound
// version of it is untestable. Each descriptor is one row:
//
//   token      the creature is in the action NOW (an engine target)
//   addToken   the GM put it there
//   dropped    staged for removal
//
export function reduceGmTargetRows(rows) {
  const added = [], removed = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    if (!r.dropped) {
      if (r.addToken) added.push(r.addToken);
      continue;
    }
    // Dropped, and the action HAS this creature — so it goes to `removed`,
    // whatever put it there. That includes a GM add the engine has since
    // adopted: a Protect redirect can move the protector into the engine's own
    // target set, and merely un-adding it would then leave it targeted while
    // the editor had just shown the GM a removal. `normalizeGmOverride` strips
    // it from `added` on the way in (removal wins), so the pair cannot persist.
    if (r.token) { removed.push(r.token); continue; }
    // Dropped with no `token`: a staged add discarded before it ever existed.
    // Contributes to neither set.
  }
  return { added, removed };
}

// Which of the GM's added tokens are not already in the set. Callers resolve and
// derive them (the engine's own add_target path), which needs Foundry.
export function gmTargetsToAdd(targets, gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  if (!gm.targets.added.length) return [];
  const present = new Set((targets ?? []).map((t) => t?.tokenUuid).filter(Boolean));
  return gm.targets.added.filter((u) => !present.has(u));
}

// Which per-target rows the editor offers controls for.
//
// Grant/heal rows are excluded — they carry no hit check, defence or damage.
//
// UNSTUDIED rows are deliberately INCLUDED. `studied === false` masks a row to
// "DEF ???" because the *player* attacker has not identified the target; it says
// nothing about what the GM may do. Honouring the player-facing mask here made
// the commonest case — an unidentified enemy — silently uneditable.
export function isGmEditableRow(r) {
  return !!r && typeof r.grantAmount !== "number";
}

// Serializable rows describing what the GM changed per target, for the card
// delta. Shaped like the engine's defenseOverrides rows so the shared patcher
// repaints GM edits on the host card AND every mirror through one code path.
export function gmOverrideDeltaRows(perTargetResults, gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  const rows = [];
  for (const row of (perTargetResults ?? [])) {
    const ov = row?.tokenUuid ? gm.perTarget[row.tokenUuid] : null;
    if (!ov) continue;
    rows.push({
      tokenUuid: row.tokenUuid ?? null, actorUuid: row.actorUuid ?? null,
      defense: row.defense, hit: !!row.hit, crit: !!row.crit,
      damage: row.damage, affinity: row.affinity ?? null,
      fields: {
        hit: ov.hit === true || ov.hit === false,
        damage: toInt(ov.damage) != null,
        defense: toInt(ov.defense) != null,
      },
    });
  }
  return rows;
}

// One-line "who edited this card" credit for the card footer.
export function describeGmEditors(gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  if (!gm.editors.length) return null;
  const names = [...new Set(gm.editors.map((e) => e.userName).filter(Boolean))];
  return names.length ? `Edited by ${names.join(", ")}` : null;
}

// Short human summary of what is currently overridden — shown on the launch
// button so a GM can see at a glance that this card carries manual edits.
export function summarizeGmOverride(gmOverride) {
  const gm = normalizeGmOverride(gmOverride);
  const bits = [];
  if (gm.roll) bits.push("accuracy");
  if (gm.damage?.element) bits.push(gm.damage.element);
  if (gm.damage?.weaponType) bits.push(gm.damage.weaponType);
  if (gm.damage && (gm.damage.base != null || gm.damage.bonus != null || gm.damage.useHR != null)) bits.push("damage");
  const n = Object.keys(gm.perTarget).length;
  if (n) bits.push(`${n} target${n === 1 ? "" : "s"}`);
  // Forced and suppressed are counted apart: they are opposite table calls, and
  // "2 reactions" would leave a GM unable to tell which way a card was bent
  // without opening the editor.
  const rx = Object.values(gm.reactions);
  const forced = rx.filter((v) => v === true).length;
  const off = rx.filter((v) => v === false).length;
  const reopened = rx.filter((v) => v === "ask").length;
  if (forced) bits.push(`${forced} forced`);
  if (off) bits.push(`${off} suppressed`);
  if (reopened) bits.push(`${reopened} reopened`);
  if (gm.targets.removed.length) bits.push(`−${gm.targets.removed.length} target`);
  if (gm.targets.added.length) bits.push(`+${gm.targets.added.length} target`);
  return bits.length ? bits.join(" · ") : null;
}
