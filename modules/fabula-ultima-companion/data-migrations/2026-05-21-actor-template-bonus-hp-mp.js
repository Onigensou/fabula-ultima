/**
 * Migration: 2026-05-21-actor-template-bonus-hp-mp
 * ---------------------------------------------------------------------------
 * Adds the `bonus_hp` / `bonus_mp` template hooks that Hina's Prophetic
 * Defender Style (and any future skill that wants to grant flat HP/MP)
 * relies on:
 *
 *   1. Patches the actor template's `max_hp` / `max_mp` Label formulas to
 *      include `+ref('bonus_hp')` / `+ref('bonus_mp')`. Idempotent — the
 *      formula is only updated when the ref is missing.
 *
 *   2. Ensures `bonus_hp` / `bonus_mp` exist as computable props on the
 *      template. If a node with that key already exists ANYWHERE in
 *      header/body/hidden, we leave it alone (the local install may have
 *      placed it as a Label inside a visible container, which is fine).
 *      If it's missing, we add it to `system.hidden` with a literal value
 *      of "0" — that registers a SimpleComputableElement keyed by name,
 *      which behaves the same as a Label("0") for formula reads but
 *      requires no positioning in the visible layout.
 *
 * Why not add visible Labels: the visible layout differs across world
 * forks (column placements, container nesting). Forcing a specific
 * insertion path would either clobber custom layout or refuse to apply
 * cleanly. `system.hidden` is location-independent and the resolver
 * registers it as a real prop the AE writes target correctly.
 *
 * IDEMPOTENT — gated on observable state.
 *
 * SCOPE: every actor of type "_template". In this world that's just
 *        `_FabU Char Template v3.fire` (id OmwL5UqoVwjshkJo); matching by
 *        type instead of id makes the migration robust to renamed/forked
 *        templates on other worlds.
 */

export const key = "2026-05-21-actor-template-bonus-hp-mp";
export const description =
  "Actor template: patch max_hp / max_mp formulas to include " +
  "ref('bonus_hp') / ref('bonus_mp'); ensure both props exist via " +
  "system.hidden when not already present.";

const HOOKS = [
  { propKey: "bonus_hp", maxKey: "max_hp" },
  { propKey: "bonus_mp", maxKey: "max_mp" }
];

// Recursive search: does any node anywhere under `root` have node.key === want?
// Walks every object value, not just `contents` arrays, so it catches Labels
// that live deep inside the body layout's nested containers.
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
    // Skip Foundry plumbing that can't hold template nodes.
    if (k === "_id" || k === "permission" || k === "flags" || k === "ownership") continue;
    if (nodeExists(root[k], want, seen)) return true;
  }
  return false;
}

// Find the first node anywhere under `root` whose key matches `want`.
// Mutating its formula via the returned reference flows back through the
// deepClone we hold onto in patchTemplate.
function findNodeMutable(root, want, seen = new WeakSet()) {
  if (!root || typeof root !== "object") return null;
  if (seen.has(root)) return null;
  seen.add(root);
  if (root.key === want) return root;
  if (Array.isArray(root)) {
    for (const v of root) { const hit = findNodeMutable(v, want, seen); if (hit) return hit; }
    return null;
  }
  for (const k of Object.keys(root)) {
    if (k === "_id" || k === "permission" || k === "flags" || k === "ownership") continue;
    const hit = findNodeMutable(root[k], want, seen);
    if (hit) return hit;
  }
  return null;
}

// Idempotent formula patch: appends `+ref('<propKey>')` to a Label formula
// of shape `${EXPR}$` when the ref isn't already present.
//
// Guarded against destructive edits on placeholder templates:
//   - skip if the formula already contains the ref
//   - skip if the inner expression is empty (`${}$`) or trivially empty
//     parens (`${()}$`) — those are placeholder formulas on NPC / villain
//     templates where max_hp isn't computed; appending `+ref(...)` would
//     produce `${+ref(...)}$` or `${()+ref(...)}$`, both of which evaluate
//     to bonus_hp alone (typically 0) and silently break the template
//   - skip if the formula doesn't look like CSB's `${EXPR}$` shape — we
//     refuse to guess at non-canonical shapes
//
// Returns the patched formula, or null to indicate "leave it alone."
function patchFormulaAddRef(formula, propKey) {
  const text = String(formula ?? "");
  const needle = `ref('${propKey}')`;
  if (text.includes(needle)) return null;

  const m = text.match(/^(\$\{)(.*)(\}\$)\s*$/s);
  if (!m) return null; // non-canonical shape — refuse to guess

  const inner = String(m[2]).trim();
  if (inner === "" || inner === "()") return null; // placeholder; don't pollute

  return `${m[1]}${m[2]}+${needle}${m[3]}`;
}

async function patchTemplate(template, log) {
  const sysClone = foundry.utils.duplicate(template.system);
  let changed = false;

  for (const { propKey, maxKey } of HOOKS) {
    const maxNode = findNodeMutable(sysClone.header, maxKey)
                  ?? findNodeMutable(sysClone.body,  maxKey);
    if (!maxNode) {
      log(`  • template "${template.name}" has no ${maxKey} Label — skipping formula patch`);
    } else {
      const patched = patchFormulaAddRef(maxNode.value, propKey);
      if (patched !== null) {
        log(`  • patched ${maxKey} formula to include ref('${propKey}')`);
        maxNode.value = patched;
        changed = true;
      }
    }

    // Ensure the prop is registered somewhere computable. Hidden-list
    // insertion is location-independent.
    const hasNode = nodeExists(sysClone.header, propKey)
                 || nodeExists(sysClone.body,   propKey)
                 || (Array.isArray(sysClone.hidden) && sysClone.hidden.some(h => h?.name === propKey));
    if (!hasNode) {
      sysClone.hidden = Array.isArray(sysClone.hidden) ? sysClone.hidden : [];
      sysClone.hidden.push({ name: propKey, value: "0" });
      log(`  • added ${propKey} to system.hidden (value "0")`);
      changed = true;
    }
  }

  if (!changed) return false;
  await template.update({ system: sysClone });
  return true;
}

export async function migrate(game, log) {
  const templates = (game.actors?.contents ?? []).filter(a => a.type === "_template");
  if (!templates.length) {
    return { applied: true, summary: "no _template actors found" };
  }

  let touched = 0;
  for (const t of templates) {
    log(`scanning template "${t.name}" [${t.id}]`);
    try { if (await patchTemplate(t, log)) touched++; }
    catch (e) { log(`  • patch threw: ${e?.message ?? e}`); }
  }

  return {
    applied: true,
    summary: `${touched} template${touched === 1 ? "" : "s"} patched (max_hp/max_mp formula + bonus_hp/bonus_mp hidden)`
  };
}
