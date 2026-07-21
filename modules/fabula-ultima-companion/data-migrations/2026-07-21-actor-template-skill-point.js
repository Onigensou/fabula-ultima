/**
 * Migration: 2026-07-21-actor-template-skill-point
 * ---------------------------------------------------------------------------
 * Adds the two props the Character Level-Up System spends against:
 *
 *   skill_point        visible to the player, GM-editable. Unspent points.
 *                      Minted by expAwarder when a level rolls over; spent in
 *                      the level-up window to buy a class level + skill level.
 *   skill_point_bonus  GM-only (role 4). Points granted or charged outside the
 *                      level economy — a quest reward, a story penalty. Exists
 *                      so the drift check stays meaningful:
 *                          expected = level + skill_point_bonus − Σ class levels
 *                      Without it, any GM gift would read as corruption forever.
 *
 * WHY EVERY INSTANCE IS PATCHED, AND WHY NOT reloadTemplate
 * ---------------------------------------------------------
 * Actor INSTANCES carry their own full copy of the template's header/body
 * (Hina's is 282kB, byte-for-byte the template's), and CSB renders an instance
 * against its OWN stamped copy — not against the live template. Patching the
 * template alone adds the field for future actors and leaves every existing
 * sheet unchanged.
 *
 * The obvious tool is `templateSystem.reloadTemplate()` — CSB's own resync,
 * the call behind the GM's right-click "Reload Template". It is the wrong tool
 * here, for a reason that only shows up when measured:
 *
 *   reloadTemplate PRUNES every prop missing from `getAllProperties()`
 *   (`props['-=' + key] = true`), and that prune IS persisted — the update at
 *   templateSystem.js:699 sends `props` with the deletion markers in it.
 *   But `getAllProperties()` returns only the 173 props that have declared
 *   defaults, while a played-in PC carries ~360; the remainder are computed
 *   labels CSB regenerates on render. So a reload marks ~200 props for
 *   deletion on every actor and leans on re-render to rebuild them.
 *
 * That may well be survivable — it is what the right-click does — but it is a
 * huge blast radius for what is, here, a two-node layout insert. So this
 * migration splices the same two nodes into each instance's own header and
 * touches `system.props` only for the back-fill. No prune, no version games,
 * no dependency on render-time reconstruction.
 *
 * ORDERING
 * --------
 * The back-fill is snapshotted BEFORE any layout write, so "does this actor
 * already have a skill_point prop" always means "was it migrated already"
 * rather than "did something seed a default underneath us".
 *
 * SCOPE: actor templates carrying BOTH a `level` and a `class_list` node —
 *        the PC-template signature. NPC and class templates have neither, and
 *        matching on shape rather than id keeps this correct on forked worlds.
 *        Instances are matched by `system.template`.
 *
 * IDEMPOTENT — every step is gated on observable state. The layout splice is
 * skipped where a `skill_point` node already exists, and an actor that already
 * has a `skill_point` prop is never re-back-filled, so a hand-corrected value
 * survives a re-run.
 *
 * v2 — v1 tried the reloadTemplate route and correctly refused to reload
 * anything once it measured the prune (see above), which left the template
 * patched and every sheet without the field. Re-keyed so it re-runs.
 */

export const key = "2026-07-21-actor-template-skill-point-v2";
export const description =
  "Character template + every instance: add visible `skill_point` + GM-only " +
  "`skill_point_bonus` beside LEVEL, and back-fill skill_point from " +
  "level − Σ class levels.";

const SKILL_POINT_NODE = {
  key: "skill_point",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: "0",
  editRole: 0,
  permission: "0",
  tooltip: "Unspent Skill Points — spend while resting at camp or on the title screen",
  visibilityFormula: null,
  type: "numberField",
  size: "m-small",
  label: "SP",
  defaultValue: "0",
  allowDecimal: false,
  minVal: "0",
  maxVal: "",
  allowRelative: false,
  showControls: true,
  controlsStyle: "hover",
  inputStyle: "text",
};

const SKILL_POINT_BONUS_NODE = {
  key: "skill_point_bonus",
  colSpan: 1,
  rowSpan: 1,
  cssClass: "",
  role: "4", // GM-only visibility, matching the skill template's `max_level`
  editRole: 0,
  permission: "0",
  tooltip: "GM-granted Skill Points not backed by a character level (may be negative)",
  visibilityFormula: null,
  type: "numberField",
  size: "m-small",
  label: "SP+",
  defaultValue: "0",
  allowDecimal: false,
  minVal: "",
  maxVal: "",
  allowRelative: false,
  showControls: true,
  controlsStyle: "hover",
  inputStyle: "text",
};

// ─── tree helpers ──────────────────────────────────────────────────────────

function nodeExists(root, want, seen = new WeakSet()) {
  if (!root || typeof root !== "object") return false;
  if (seen.has(root)) return false;
  seen.add(root);
  if (root.key === want) return true;
  if (Array.isArray(root)) {
    for (const v of root) if (nodeExists(v, want, seen)) return true;
    return false;
  }
  for (const k of Object.keys(root)) {
    if (k === "_id" || k === "permission" || k === "flags" || k === "ownership") continue;
    if (nodeExists(root[k], want, seen)) return true;
  }
  return false;
}

// Locate the container whose `contents` array directly holds `want`, so a
// sibling can be spliced in beside it rather than appended somewhere generic.
function findHolder(node, want, seen = new WeakSet()) {
  if (!node || typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node.contents)) {
    const i = node.contents.findIndex((c) => c && c.key === want);
    if (i >= 0) return { holder: node, index: i };
  }
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findHolder(v, want, seen); if (hit) return hit; }
    return null;
  }
  for (const k of Object.keys(node)) {
    if (k === "_id" || k === "permission" || k === "flags" || k === "ownership") continue;
    const hit = findHolder(node[k], want, seen);
    if (hit) return hit;
  }
  return null;
}

const isPcTemplate = (t) =>
  (nodeExists(t.system?.header, "level") || nodeExists(t.system?.body, "level")) &&
  (nodeExists(t.system?.header, "class_list") || nodeExists(t.system?.body, "class_list"));

// ─── domain helpers ────────────────────────────────────────────────────────

const num = (v, d = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};

function sumClassLevels(actor) {
  const table = actor.system?.props?.class_list ?? {};
  let total = 0;
  for (const row of Object.values(table)) {
    if (!row || row.$deleted) continue;
    total += num(row.level, 0);
  }
  return total;
}

// ─── template surgery ──────────────────────────────────────────────────────

// Splice the two nodes into a system clone, immediately after `level`.
// `level` and `exp_meter` share a horizontal panel in the header; inserting
// between them keeps the small numeric fields together and still lets the
// full-size EXP meter take the remaining width.
//
// Returns the mutated clone, or null when there was nothing to do (no `level`
// anchor, or both nodes already present) so the caller can skip the write.
function spliceSkillPointNodes(system, label, log) {
  const clone = foundry.utils.duplicate(system);

  const spot = findHolder(clone.header, "level") ?? findHolder(clone.body, "level");
  if (!spot) {
    log(`  • ${label}: no \`level\` anchor — skipped`);
    return null;
  }

  let changed = false;
  let at = spot.index + 1;

  for (const node of [SKILL_POINT_NODE, SKILL_POINT_BONUS_NODE]) {
    if (nodeExists(clone.header, node.key) || nodeExists(clone.body, node.key)) continue;
    spot.holder.contents.splice(at, 0, foundry.utils.duplicate(node));
    at += 1;
    changed = true;
  }

  return changed ? clone : null;
}

// ─── main ──────────────────────────────────────────────────────────────────

export async function migrate(game, log) {
  const templates = (game.actors?.contents ?? []).filter(
    (a) => a.type === "_template" && isPcTemplate(a)
  );
  if (!templates.length) {
    return { applied: true, summary: "no PC-shaped actor template found" };
  }

  let templatesPatched = 0;
  let instancesPatched = 0;
  let backfilled = 0;

  for (const template of templates) {
    log(`template "${template.name}" [${template.id}]`);

    const instances = (game.actors?.contents ?? []).filter(
      (a) => a.type !== "_template" && a.system?.template === template.id
    );

    // 1. Snapshot the back-fill before any write, so "already has the prop"
    //    unambiguously means "already migrated".
    const wanted = new Map();
    for (const actor of instances) {
      if (actor.system?.props?.skill_point !== undefined) continue;
      const level = num(actor.system?.props?.level, 0);
      const bonus = num(actor.system?.props?.skill_point_bonus, 0);
      wanted.set(actor.id, Math.max(0, level + bonus - sumClassLevels(actor)));
    }
    log(`  • ${instances.length} instance(s), ${wanted.size} awaiting back-fill`);

    // 2. Template layout — governs actors created from here on.
    const patchedTemplate = spliceSkillPointNodes(template.system, `template "${template.name}"`, log);
    if (patchedTemplate) {
      await template.update({ system: patchedTemplate });
      templatesPatched += 1;
      log(`  • template layout patched`);
    }

    // 3. Every existing instance's OWN header copy — this is what actually
    //    renders on a sheet. Layout only; props are left untouched.
    for (const actor of instances) {
      const patched = spliceSkillPointNodes(actor.system, `"${actor.name}"`, log);
      if (!patched) continue;
      try {
        await actor.update({ system: { header: patched.header } });
        instancesPatched += 1;
        log(`  • patched layout on "${actor.name}"`);
      } catch (e) {
        log(`  • layout patch threw for "${actor.name}": ${e?.message ?? e}`);
      }
    }

    // 4. Back-fill the snapshotted values.
    for (const [actorId, value] of wanted) {
      const actor = game.actors.get(actorId);
      if (!actor) continue;
      try {
        await actor.update({ "system.props.skill_point": value });
        backfilled += 1;
        if (value > 0) log(`  • back-filled "${actor.name}" → ${value} SP`);
      } catch (e) {
        log(`  • back-fill threw for "${actor.name}": ${e?.message ?? e}`);
      }
    }
  }

  return {
    applied: true,
    summary:
      `${templatesPatched} template(s) + ${instancesPatched} instance layout(s) patched, ` +
      `${backfilled} back-filled`,
  };
}
