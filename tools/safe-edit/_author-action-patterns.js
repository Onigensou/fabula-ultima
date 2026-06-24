/*
 * One-off: author action_pattern_table on the 10 Current-Dungeon monsters
 * + fix self-target skill_target. Run game-CLOSED from tools/safe-edit:
 *   node _author-action-patterns.js
 */
const SE = require("./lib");

const norm = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

// [searchTerm, condition, value1, value2, string, priority, focus]
const P = {
  // Burning Hand
  "xkjSsQ63gzlsBIJW": [
    ["grabby hand", "always", 0, 100, "", 5, "lowest_hp"],
    ["exploders hand", "mp", 40, 100, "", 4, "by_affinity"],
    ["fling", "always", 0, 100, "", 3, "auto"]
  ],
  // Centimare
  "WJvUVRpKl2vcXnmX": [
    ["bite", "always", 0, 100, "", 5, "auto"],
    ["scythe", "enemy_has_status", 0, 0, "Envenomed", 6, "auto"],
    ["sting", "always", 0, 100, "", 4, "auto"],
    ["hellfire", "mp", 50, 100, "", 4, "by_affinity"]
  ],
  // Centuaros
  "7FB6x9kD38cX5SGB": [
    ["blazing sweep", "always", 0, 100, "", 5, "by_affinity"],
    ["prepare to charge", "round", 1, 2, "", 4, "auto"],
    ["fiery onslaught", "mp", 40, 100, "", 4, "by_affinity"]
  ],
  // Creeps
  "5m6jyFCVzfBSzJvN": [
    ["shadow possession", "always", 0, 100, "", 5, "highest_hp"]
  ],
  // Dryad
  "RJECgM6oVt4UI4ds": [
    ["enkindle", "creature_has_status", 0, 0, "Burn", 6, "burn_spread"],
    ["mustard bomb", "always", 0, 100, "", 4, "by_affinity"],
    ["ignis finis", "mp", 50, 100, "", 4, "by_affinity"],
    ["dispel", "random", 25, 0, "", 3, "auto"]
  ],
  // Fire Slime
  "Q2SuQSgrAC2dZR2Y": [
    ["fire shot", "always", 0, 100, "", 5, "by_affinity"],
    ["tackle", "always", 0, 100, "", 3, "auto"]
  ],
  // Hellhound
  "STmBv9N66tZxSNCx": [
    ["bite", "always", 0, 100, "", 5, "lowest_hp"],
    ["pounce", "always", 0, 100, "", 4, "auto"],
    ["flame breath", "mp", 40, 100, "", 4, "by_affinity"]
  ],
  // Inferex
  "zODzgQipiH3nsimr": [
    ["chomp", "always", 0, 100, "", 5, "burn_focus"],
    ["blast breath", "always", 0, 100, "", 4, "by_affinity"],
    ["flamethrower", "mp", 40, 100, "", 4, "by_affinity"],
    ["dead branch", "ally_count", 1, 1, "", 3, "auto"]
  ],
  // Marigold
  "ZbCSKnZdB2cKlW9H": [
    ["blazing tether", "enemy_has_status", 0, 0, "Burn", 5, "auto"],
    ["thorn whip", "always", 0, 100, "", 4, "auto"],
    ["ignis finis", "mp", 50, 100, "", 4, "by_affinity"]
  ],
  // Salamander
  "gN89zV1htUeZWel0": [
    ["salamander breath", "effect_stacks", 2, 0, "Burn", 5, "by_affinity"],
    ["pyrophagy", "hp", 0, 40, "", 5, "auto"],
    ["tongue lash", "always", 0, 100, "", 4, "auto"]
  ]
};

// actorId -> [item search terms] whose skill_target should be "Self"
const SELF_TARGET_FIX = {
  "gN89zV1htUeZWel0": ["pyrophagy", "heat up"]
};

// doc.items is an array of item-ID strings; fetch each embedded item.
async function loadItems(aid, idList) {
  const items = [];
  for (const id of (idList || [])) {
    try {
      const it = await SE.getDoc(`Actor.${aid}.Item.${id}`);
      if (it) items.push(it);
    } catch (_e) { /* skip */ }
  }
  return items;
}

(async () => {
  const unresolved = [];

  for (const [aid, rows] of Object.entries(P)) {
    const doc = await SE.getDoc("Actor." + aid);
    const items = await loadItems(aid, doc.items);
    const tbl = {};

    rows.forEach((r, i) => {
      const [term, cond, v1, v2, str, pri, focus] = r;
      const it = items.find(x => norm(x.name).includes(term) && norm(x.system?.props?.skill_type) !== "passive")
        || items.find(x => norm(x.name).includes(term));
      const nm = it ? it.name : ("?" + term);
      if (!it) unresolved.push(doc.name + " :: " + term);
      tbl[i] = {
        "$deleted": false,
        action_pattern_name: nm,
        action_pattern_condition: cond,
        action_pattern_value_1: String(v1),
        action_pattern_value_2: String(v2),
        action_pattern_string: str || "",
        action_pattern_priority: String(pri),
        action_pattern_target_focus: focus || "",
        action_pattern_cooldown: "0"
      };
    });

    await SE.safeEdit({
      uuid: "Actor." + aid,
      patch: { "system.props.action_pattern_table": tbl },
      allowSystemKeyRemoval: true,
      note: "author action pattern table"
    });

    // read-back verify (authoritative)
    const back = await SE.getDoc("Actor." + aid);
    const names = Object.values(back.system?.props?.action_pattern_table || {})
      .filter(x => x && !x.$deleted).map(x => x.action_pattern_name);
    const bad = names.some(n => n.startsWith("?"));
    console.log(`${doc.name.padEnd(16)} ${bad ? "BAD" : "ok "}  [${names.join(", ")}]`);
  }

  for (const [aid, terms] of Object.entries(SELF_TARGET_FIX)) {
    const doc = await SE.getDoc("Actor." + aid);
    const items = await loadItems(aid, doc.items);
    for (const term of terms) {
      const it = items.find(x => norm(x.name).includes(term));
      if (!it) { console.log("  (no item for self-fix:", term, ")"); continue; }
      if (norm(it.system?.props?.skill_target) === "self") { console.log(`  skill_target already Self: ${it.name}`); continue; }
      await SE.safeEdit({
        uuid: "Actor." + aid + ".Item." + it._id,
        patch: { "system.props.skill_target": "Self" },
        note: "fix self target"
      });
      const chk = await SE.getDoc(`Actor.${aid}.Item.${it._id}`);
      console.log(`  skill_target -> ${chk.system?.props?.skill_target}: ${it.name}`);
    }
  }

  console.log("\nUNRESOLVED:", unresolved.length ? unresolved : "(none)");
})().catch(e => { console.error("ERROR:", e); process.exit(1); });
