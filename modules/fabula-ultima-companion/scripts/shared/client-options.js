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
      {
        key: "allyWatch",
        label: "Ally's turn",
        hint: "What you see while another player chooses their character's action.",
        default: "panel",
        choices: [
          { value: "panel", label: "Watch", hint: "A read-only panel above their card follows their menu live, and rings on the field show who they pick." },
          { value: "off", label: "Off", hint: "Only their card's glow, as before." },
        ],
      },
      {
        key: "battleStage3d",
        setting: "battleStage3d",   // keeps the setting name it had before it moved here
        label: "Battle depth",
        hint: "Depth on the painted battle backdrops (Training Ground, the Overworld and the Valley of the Dragon).",
        default: "camera",
        choices: [
          { value: "full", label: "Full", hint: "Battlers further back are drawn smaller, and the scenery shifts gently with the camera." },
          { value: "camera", label: "3D", hint: "Experimental: the battlefield becomes a real 3D set. Backdrops without a 3D model use Full." },
          { value: "scale", label: "Depth only", hint: "Battlers further back are drawn smaller; the scenery stays still. Lighter on slower machines." },
          { value: "off", label: "Off", hint: "The flat battle view, as before." },
        ],
      },
      {
        key: "walkParallax",
        label: "Walk-map parallax",
        hint: "Depth on painted walk maps that support it (map-system/exploration-parallax.js).",
        default: "on",
        choices: [
          { value: "on", label: "On", hint: "Far scenery scrolls slower and near rocks faster as the camera follows the party." },
          { value: "off", label: "Off", hint: "The painting scrolls flat, as before. Lighter on slower machines." },
        ],
      },
    ],
  },
];

const ALL = OPTION_GROUPS.flatMap((g) => g.options);
const settingKey = (opt) => opt.setting ?? `clientOption_${opt.key}`;

Hooks.once("init", () => {
  for (const opt of ALL) {
    game.settings.register(MODULE_ID, settingKey(opt), {
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
  try { v = game.settings.get(MODULE_ID, settingKey(opt)); } catch { v = opt.default; }
  return opt.choices.some((c) => c.value === v) ? v : opt.default;
}

/** Set this user's value for option `key`. Unknown keys or values are refused. */
export async function setClientOption(key, value) {
  const opt = ALL.find((o) => o.key === key);
  if (!opt || !opt.choices.some((c) => c.value === value)) return false;
  await game.settings.set(MODULE_ID, settingKey(opt), value);
  return true;
}
