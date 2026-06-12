// Adds cooking-system fields to the _Item Template's cooking_panel (status tab).
const { getDoc, safeEdit } = require("./lib/edit");

const TASTE_OPTIONS = [
  { key: "", value: "—" },
  { key: "bitter", value: "Bitter" },
  { key: "salty", value: "Salty" },
  { key: "sour", value: "Sour" },
  { key: "sweet", value: "Sweet" },
  { key: "umami", value: "Umami" },
  { key: "weird", value: "Weird" },
];

function findNode(root, key) {
  let hit = null;
  const walk = (node) => {
    if (hit || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.key === key) { hit = node; return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") walk(v);
    }
  };
  walk(root);
  return hit;
}

(async () => {
  const tpl = await getDoc("Item.ZoiV53VaLzeRsEps");
  if (!tpl) throw new Error("Template not found");
  const body = structuredClone(tpl.system.body);

  const selectBase = structuredClone(findNode(body, "item_rarity") ?? findNode(tpl.system.header, "item_rarity"));
  const textBase = structuredClone(findNode(body, "set_name"));
  const panel = findNode(body, "cooking_panel");
  if (!selectBase || !textBase || !panel) {
    throw new Error(`Missing base nodes: select=${!!selectBase} text=${!!textBase} panel=${!!panel}`);
  }

  const mkSelect = (over) => ({
    ...selectBase,
    role: 0, editRole: 4, permission: 0, cssClass: "",
    size: "medium", selectedOptionType: "custom",
    ...over,
  });
  const mkText = (over) => ({
    ...textBase,
    role: 0, editRole: 4, permission: 0, cssClass: "",
    ...over,
  });

  const VIS_ING = "or(equalText(item_type, ''), isIngredient)";
  const VIS_RECIPE = "or(equalText(item_type, ''), equalText(item_type, 'recipe'))";

  panel.visibilityFormula = "or(equalText(item_type, ''), isIngredient, equalText(item_type, 'recipe'))";
  panel.contents = [
    mkSelect({
      key: "ingredient_taste",
      label: "Taste",
      tooltip: "Primary taste this ingredient contributes to the pot",
      visibilityFormula: VIS_ING,
      defaultValue: "",
      options: structuredClone(TASTE_OPTIONS),
    }),
    mkSelect({
      key: "ingredient_taste2",
      label: "Taste (2nd)",
      tooltip: "Secondary taste (leave blank in v1; counts at half weight when enabled)",
      visibilityFormula: VIS_ING,
      defaultValue: "",
      options: structuredClone(TASTE_OPTIONS),
    }),
    mkSelect({
      key: "recipe_kind",
      label: "Recipe Kind",
      tooltip: "Blank = Crafting (IP expansion, legacy default). Cooking = hot-pot recipe.",
      visibilityFormula: VIS_RECIPE,
      defaultValue: "",
      options: [
        { key: "", value: "— (Crafting)" },
        { key: "crafting", value: "Crafting (IP)" },
        { key: "cooking", value: "Cooking" },
      ],
    }),
    mkText({
      key: "recipe_dish_uuid",
      label: "Dish UUID",
      tooltip: "Item UUID of the dish this cooking recipe produces (ingredients via Related Items list)",
      visibilityFormula:
        "or(equalText(item_type, ''), and(equalText(item_type, 'recipe'), equalText(recipe_kind, 'cooking')))",
      defaultValue: "",
    }),
  ];

  const res = await safeEdit({
    uuid: "Item.ZoiV53VaLzeRsEps",
    patch: { "system.body": body },
    note: "cooking-system: add taste + recipe fields to cooking_panel (re-apply after bloat rollback)",
  });
  console.log("OK", res.entryId);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
