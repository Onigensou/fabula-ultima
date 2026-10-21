// Client options — each user's own display choices, edited from the Party
// Menu's Config page (party-menu-view-config.js).
//
// Every option is a CLIENT-scope Foundry setting: it lives in this browser,
// for this user, and changing it touches no world data. Options are grouped
// the way Config shows them (a group per tab, e.g. "Graphic").
//
// A system that reads an option listens for the hook below rather than
// polling: Hooks.on("fuClientOptionChanged", ({ key, value }) => …).

export const MODULE_ID = "fabula-ultima-companion";

export const OPTION_GROUPS = [
  {
    id: "graphic",
    label: "Graphic",
    icon: "fa-palette",
    options: [
      {
        key: "reactionUi",
        label: "Reaction UI",
        hint: "How your reactions show up during battle.",
        default: "card",
        choices: [
          { value: "card", label: "Card", hint: "Each reaction you can use is a card in your hand, behind your plate. Use plays it; one Pass answers the rest." },
          { value: "button", label: "Button", hint: "Each reaction is a row on the action card, with its own Apply and Skip." },
        ],
      },
    ],
  },
];

const ALL = OPTION_GROUPS.flatMap((g) => g.options);
const settingKey = (key) => `clientOption_${key}`;

Hooks.once("init", () => {
  for (const opt of ALL) {
    game.settings.register(MODULE_ID, settingKey(opt.key), {
      name: opt.label,
      hint: opt.hint,
      scope: "client",
      config: false,
      type: String,
      default: opt.default,
      choices: Object.fromEntries(opt.choices.map((c) => [c.value, c.label])),
      onChange: (value) => Hooks.callAll("fuClientOptionChanged", { key: opt.key, value }),
    });
  }
});

/** This user's value for option `key` (its default when unset or unknown). */
export function getClientOption(key) {
  const opt = ALL.find((o) => o.key === key);
  if (!opt) return undefined;
  let v;
  try { v = game.settings.get(MODULE_ID, settingKey(key)); } catch { v = opt.default; }
  return opt.choices.some((c) => c.value === v) ? v : opt.default;
}

/** Set this user's value for option `key`. Unknown keys or values are refused. */
export async function setClientOption(key, value) {
  const opt = ALL.find((o) => o.key === key);
  if (!opt || !opt.choices.some((c) => c.value === value)) return false;
  await game.settings.set(MODULE_ID, settingKey(key), value);
  return true;
}
