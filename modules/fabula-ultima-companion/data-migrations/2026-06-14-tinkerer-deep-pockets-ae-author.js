/**
 * Migration: 2026-06-14-tinkerer-deep-pockets-ae-author
 * ---------------------------------------------------------------------------
 * Ensure "Deep Pockets" (Tinkerer / Passive Heroic) carries its IP-reduction
 * Active Effect:
 *
 *   "When you spend Inventory Points, you spend 1 less Inventory Point
 *    (to a minimum of 1)."
 *
 * The Deep Pockets MASTER already exists in the world (it predates this work).
 * What was lost when we adopt the co-dev's world is the transfer:true AE that
 * feeds the centralized `ip_reduction_value` actor prop:
 *
 *   changes: [{ key: "ip_reduction_value", value: "1", mode: ADD, priority: 20 }]
 *
 * `ip_reduction_value` is read by both the BD item-creation IP cost
 * (buildReducedIpCost) and the `consume_resource "ip"` skill path
 * (skill-effects.js, committed 8f68c7d), so the discount applies everywhere IP
 * is spent.
 *
 * This migration ONLY touches the BD master at `Battle Director / Tinkerer /
 * Skill` — never the legacy `💥 Skill` copy. It is seed-only with respect to
 * the AE: it adds the AE solely when ABSENT (the lost-data case), so a co-dev's
 * own Deep Pockets AE is never overridden. When it adds the AE it also strips
 * the stale "Engine note: …" developer text from the master description
 * (developer notes must not appear in player-facing content).
 */

const MODULE_ID = "fabula-ultima-companion";
const BD_ROOT_NAME = "Battle Director";
const CLASS_NAME = "Tinkerer";
const SUBFOLDER = "Skill";
const SKILL_NAME = "Deep Pockets";

const DP_ICON =
  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Lithia/FortuneFinderPassive1.png";

const DP_CLEAN_DESCRIPTION =
  "<p>When you spend Inventory Points, you spend <strong>1 less Inventory " +
  "Point</strong> (to a minimum of 1).</p>";

const DP_AE_DESCRIPTION =
  "<p><em>Deep Pockets:</em> spend 1 less Inventory Point (minimum 1).</p>";

function makeDeepPocketsAe(iconUrl) {
  return {
    name: "Deep Pockets",
    icon: iconUrl ?? DP_ICON,
    description: DP_AE_DESCRIPTION,
    transfer: true,
    disabled: false,
    duration: {
      startTime: null, seconds: null, rounds: null, turns: null,
      startRound: null, startTurn: null, type: "none", duration: null,
    },
    statuses: [],
    changes: [
      { key: "ip_reduction_value", value: "1", mode: 2, priority: 20 },
    ],
    flags: { [MODULE_ID]: { category: "buff" } },
    system: { tags: ["buff"] },
  };
}

function bdFolderMaster(game) {
  // The BD master lives at Battle Director / Tinkerer / Skill — match by the
  // full folder path so the legacy 💥 Skill copy is never selected.
  return game.items?.contents?.find?.((i) => {
    if (i.name !== SKILL_NAME) return false;
    const path = [];
    let f = i.folder;
    while (f) { path.unshift(f.name); f = f.folder; }
    return path[0] === BD_ROOT_NAME && path[1] === CLASS_NAME && path[2] === SUBFOLDER;
  });
}

export const key = "2026-06-14-tinkerer-deep-pockets-ae-author";
export const description =
  "Ensure the BD Deep Pockets master carries the transfer ip_reduction_value " +
  "AE (added only when absent). Cleans the stale dev-note description.";

export async function migrate(game, log = () => {}) {
  const master = bdFolderMaster(game);
  if (!master) {
    log(`  Deep Pockets: BD master not found at ${BD_ROOT_NAME}/${CLASS_NAME}/${SUBFOLDER} — nothing to do`);
    return { applied: true, summary: "Deep Pockets BD master absent; skipped" };
  }

  const existing = master.effects?.contents?.find((e) => e.name === "Deep Pockets");
  if (existing) {
    log("  Deep Pockets: AE already present — seed-only; left untouched");
    return { applied: true, summary: "Deep Pockets AE already present; left untouched" };
  }

  await master.createEmbeddedDocuments("ActiveEffect", [makeDeepPocketsAe(master.img)]);
  log("  Deep Pockets: transfer ip_reduction_value AE created");

  // Strip the stale developer note from the description, if still present.
  const desc = String(master.system?.props?.description ?? "");
  if (/Engine note/i.test(desc)) {
    await master.update({ "system.props.description": DP_CLEAN_DESCRIPTION });
    log("  Deep Pockets: stripped stale dev-note from description");
  }

  return { applied: true, summary: "Deep Pockets AE seeded on BD master" };
}
