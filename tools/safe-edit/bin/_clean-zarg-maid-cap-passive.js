// Zarg's "Maid cap (Passive)" (contained in his Maid cap accessory) was a stale copy
// of Deep Pockets: Deep Pockets' description, isHeroic + "mastered Tinkerer"
// requirement, and a second Deep Pockets AE (ip_reduction_value +1). The AE is
// dormant today (contained in a piece of gear, it never reaches appliedEffects;
// verified 11-10 on Staging, cap on or off, ip_reduction_value stays 1), but the
// sheet text was wrong and the AE would double the discount if it ever applied.
//
// Brought in line with the world item (Item.uaGIN00QQ5WoJRmI): its description,
// not heroic, no AE. The real cap discount (reaction row -> mc_disc adjust_cost)
// is left exactly as it is. The real Deep Pockets skill (h5VodYIZl8f6ZPM1) keeps
// its own AE (same AE id, different item key) and is not touched.
// Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");

const ACTOR = "Z4CFy505cD3nzl1W";
const ITEM = "gVovemTOophkXbck";
const AE = "Cv3qjVD4rtSDeihL";
const WORLD_ITEM = "uaGIN00QQ5WoJRmI";
const itemKey = `!actors.items!${ACTOR}.${ITEM}`;
const aeKey = `!actors.items.effects!${ACTOR}.${ITEM}.${AE}`;

run(async ({ changes, deletes }) => {
  const item = await getByKey("actors", itemKey);
  if (!item || item.name !== "Maid cap (Passive)") throw new Error(`unexpected item at ${itemKey}: ${item?.name}`);
  const ae = await getByKey("actors", aeKey);
  if (!ae || ae.name !== "Deep Pockets") throw new Error(`unexpected AE at ${aeKey}: ${ae?.name}`);
  const world = await getByKey("items", `!items!${WORLD_ITEM}`);
  if (!world || world.name !== "Maid cap (Passive)") throw new Error("world Maid cap (Passive) not found");

  const p = item.system.props;
  const before = { description: p.description, isHeroic: p.isHeroic, heroic_requirement: p.heroic_requirement, effects: item.effects };
  p.description = world.system.props.description;
  p.isHeroic = false;
  p.heroic_requirement = "";
  item.effects = (item.effects ?? []).filter((id) => id !== AE);
  changes.push([itemKey, item,
    `description -> world text; isHeroic ${before.isHeroic} -> false; heroic_requirement cleared; effects ${JSON.stringify(before.effects)} -> ${JSON.stringify(item.effects)}`]);
  deletes.push([aeKey, "stray Deep Pockets AE (ip_reduction_value +1) on the Maid cap passive copy"]);
}, "zarg: Maid cap (Passive) copy cleaned (stray Deep Pockets text + AE)", "actors");
