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
 * WHY THE LAYOUT INSERT, AND WHY reloadTemplate
 * ---------------------------------------------
 * Actor INSTANCES carry their own full copy of the template's header/body
 * (Hina's is 282kB, byte-for-byte the template's), and CSB renders an instance
 * against its OWN stamped copy — not against the live template. Patching the
 * template alone would add the field for future actors and leave every existing
 * sheet unchanged. So each instance must be resynced.
 *
 * `templateSystem.reloadTemplate()` is CSB's own sanctioned resync — the same
 * call behind the GM's right-click "Reload Template". It copies header/body/
 * version down, seeds newly-added props with their defaults, and PRUNES any
 * prop the template no longer defines (`props['-=' + key] = true`).
 *
 * That prune is the hazard, so this migration refuses to guess: it asks CSB for
 * the real `getAllProperties()` key set, computes exactly what each actor would
 * lose, and only reloads actors whose loss is small (≤ PRUNE_LIMIT). Anything
 * heavier — stale test actors, backups — is reported and left alone for a human.
 * Measured on this world at authoring time: the four party actors prune 0, 0, 0
 * and 2 (Hina's `check_mod_dex` / `check_mod_ins`, both zero-valued orphans of
 * an older template revision); the heavy sets are all on test/backup actors.
 *
 * ORDERING
 * --------
 * The back-fill is computed BEFORE the reload. reloadTemplate seeds
 * `skill_point` with its defaultValue, so after a reload "does this actor
 * already have the prop" can no longer distinguish a fresh actor from a
 * migrated one. Snapshot first, write after.
 *
 * SCOPE: actor templates carrying BOTH a `level` and a `class_list` node —
 *        the PC-template signature. NPC and class templates have neither, and
 *        matching on shape rather than id keeps this correct on forked worlds.
 *
 * IDEMPOTENT — gated on observable state; an actor that already has a
 * `skill_point` prop is never re-back-filled, so a hand-corrected value
 * survives a re-run.
 */

export const key = "2026-07-21-actor-template-skill-point";
export const description =
  "Character template: add visible `skill_point` + GM-only `skill_point_bonus` " +
  "beside LEVEL; resync instances via CSB reloadTemplate (prune-guarded) and " +
  "back-fill skill_point from level − Σ class levels.";

// An actor losing more props than this is left for a human to look at.
const PRUNE_LIMIT = 10;

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

function patchTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);

  // `level` and `exp_meter` share a horizontal panel in the header. Insert
  // directly after `level` so the two small numeric fields sit together and
  // the full-size EXP meter still takes the remaining width.
  const spot = findHolder(sysClone.header, "level") ?? findHolder(sysClone.body, "level");
  if (!spot) {
    log(`  • no \`level\` node found in "${template.name}" — skipping insert`);
    return null;
  }

  let changed = false;
  let at = spot.index + 1;

  for (const node of [SKILL_POINT_NODE, SKILL_POINT_BONUS_NODE]) {
    if (nodeExists(sysClone.header, node.key) || nodeExists(sysClone.body, node.key)) {
      log(`  • \`${node.key}\` already present — leaving it alone`);
      continue;
    }
    spot.holder.contents.splice(at, 0, foundry.utils.duplicate(node));
    log(`  • inserted \`${node.key}\` at contents[${at}]`);
    at += 1;
    changed = true;
  }

  return changed ? sysClone : null;
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
  let reloaded = 0;
  let backfilled = 0;
  const skipped = [];

  for (const template of templates) {
    log(`template "${template.name}" [${template.id}]`);

    // 1. Snapshot which instances still lack the prop, and what they should get.
    //    Must happen BEFORE any reload — reloadTemplate seeds defaults and would
    //    make every actor look like it already had one.
    const instances = (game.actors?.contents ?? []).filter(
      (a) => a.type !== "_template" && a.system?.template === template.id
    );
    const wanted = new Map();
    for (const actor of instances) {
      if (actor.system?.props?.skill_point !== undefined) continue;
      const level = num(actor.system?.props?.level, 0);
      const bonus = num(actor.system?.props?.skill_point_bonus, 0);
      wanted.set(actor.id, Math.max(0, level + bonus - sumClassLevels(actor)));
    }
    log(`  • ${instances.length} instance(s), ${wanted.size} awaiting back-fill`);

    // 2. Patch the template layout.
    const patched = patchTemplate(template, log);
    if (patched) {
      await template.update({ system: patched });
      templatesPatched += 1;
    }

    // 3. Resync instances, refusing any actor that would lose real data.
    let availableKeys;
    try {
      availableKeys = new Set(Object.keys(template.templateSystem.getAllProperties()));
    } catch (e) {
      log(`  • getAllProperties() threw (${e?.message ?? e}) — skipping all reloads`);
      availableKeys = null;
    }

    if (availableKeys) {
      for (const actor of instances) {
        const orphans = Object.keys(actor.system?.props ?? {}).filter(
          (p) => !availableKeys.has(p)
        );
        if (orphans.length > PRUNE_LIMIT) {
          skipped.push(`${actor.name} (${orphans.length} props)`);
          log(`  • SKIP reload "${actor.name}" — would prune ${orphans.length} props`);
          continue;
        }
        try {
          await actor.reloadTemplate();
          reloaded += 1;
          if (orphans.length) {
            log(`  • reloaded "${actor.name}" (pruned: ${orphans.join(", ")})`);
          } else {
            log(`  • reloaded "${actor.name}"`);
          }
        } catch (e) {
          log(`  • reload threw for "${actor.name}": ${e?.message ?? e}`);
        }
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

  const tail = skipped.length
    ? `; ${skipped.length} actor(s) left for manual reload: ${skipped.join(", ")}`
    : "";

  return {
    applied: true,
    summary:
      `${templatesPatched} template(s) patched, ${reloaded} instance(s) resynced, ` +
      `${backfilled} back-filled${tail}`,
  };
}
