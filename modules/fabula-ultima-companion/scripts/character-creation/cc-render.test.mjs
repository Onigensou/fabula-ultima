/**
 * Render smoke test for every step.
 *
 * The steps build their markup as strings, so a typo, a missing helper or a
 * bad property access throws rather than producing subtly wrong HTML — which
 * makes them checkable offline against a stub of the handful of Foundry
 * globals they read. This is not a substitute for looking at the window; it
 * only proves no step can throw on the way to being drawn.
 *
 * Each step is rendered twice: once on an empty draft (the state the player
 * actually arrives in) and once on a fully populated one.
 */

// ── minimal Foundry stub, installed before the steps are imported ──────────
const folder = (id, name, parent = null) => ({ id, _id: id, name, type: "Actor", folder: parent });

const classFolder = folder("cls", "Classes");
const classicFolder = folder("classic", "Classic Classes", classFolder);
const weaponRoot = folder("w0", "Weapon");
const basicWeapon = folder("w1", "Basic Weapon", weaponRoot);
const swordFolder = folder("w2", "Sword", basicWeapon);
const basicArmor = folder("a1", "Basic Armor", folder("a0", "Armor"));
const pcRoot = folder("pc", "Player Character");

const item = (id, name, fldr, props) => ({
  id, _id: id, uuid: `Item.${id}`, name, img: "icons/x.webp", folder: fldr,
  system: { props },
});

globalThis.game = {
  user: { name: "Oni", id: "u1" },
  users: [{ name: "Oni", id: "u1" }],
  actors: [],
  items: [
    item("i1", "Bronze Sword", swordFolder, {
      item_cost: "200", isMartial: true, item_type: "weapon",
      hand_slots: "One-handed", weapon_range: "Melee", category: "Sword",
    }),
    item("i2", "Travel Garb", basicArmor, {
      item_cost: "100", isMartial: false, item_type: "armor", category: "Arcane",
    }),
  ],
  folders: [classFolder, classicFolder, weaponRoot, basicWeapon, swordFolder, basicArmor, pcRoot],
};
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };
globalThis.Hooks = { once() {}, on() {}, callAll() {} };

const { STEP_RENDERERS } = await import("./cc-app.js");
await import("./cc-step-profile.js");
await import("./cc-step-attributes.js");
await import("./cc-step-classes.js");
await import("./cc-step-equipment.js");
await import("./cc-step-bond.js");
await import("./cc-step-summary.js");

const D = await import("./cc-draft.js");
const E = await import("./cc-step-equipment.js");
const B = await import("./cc-step-bond.js");
const { CC } = await import("./cc-const.js");

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split("\n")[0]}`); }
};
const eq = (name, got, want) => ok(name, () => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`got ${g}, want ${w}`);
});

// ── every step is registered ───────────────────────────────────────────────
eq("all six steps registered", CC.STEPS.map((s) => STEP_RENDERERS.has(s.id)),
  [true, true, true, true, true, true]);
eq("registration order is the step order",
  CC.STEPS.map((s) => s.id), ["profile", "attributes", "classes", "equipment", "bond", "summary"]);

// ── a populated draft ──────────────────────────────────────────────────────
function fullDraft() {
  const d = D.createDraft();
  d.profile.name = "Ashe";
  d.profile.identity = "Wandering duellist";
  d.profile.theme = "Justice";
  d.profile.origin = "Vaskell";
  d.profile.backstory = "Left home after the fire.\nStill looking for who set it.";
  d.attributes.level = 20;
  d.attributes.arrayKey = "average";
  d.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
  d.attributes.milestonePicks = ["dex"];
  for (let i = 0; i < 12; i++) {
    d.classes.push({
      classKey: "guardian", className: "Guardian", classImg: "",
      skillUuid: i % 2 ? "Item.s1" : "Item.s2",
      skillName: i % 2 ? "Bodyguard" : "Fortress",
      benefit: "hp", facetUuids: i === 0 ? ["Item.f1"] : [],
    });
  }
  for (let i = 0; i < 8; i++) {
    d.classes.push({
      classKey: "elementalist", className: "Elementalist", classImg: "",
      skillUuid: "Item.s3", skillName: "Elemental Magic",
      benefit: "mp", facetUuids: [`Item.f${i + 2}`],
    });
  }
  E.addPick(d, E.readEquip(game.items[0], "weapon"));
  E.addPick(d, E.readEquip(game.items[1], "armor"));
  d.bond.name = "Mira";
  d.bond.rel = "the sister he left behind";
  B.setEmotion(d, "e3", "affection");
  return d;
}

// ── render every step in both states ───────────────────────────────────────
for (const step of CC.STEPS) {
  const r = STEP_RENDERERS.get(step.id);

  ok(`${step.id}: renders an empty draft`, () => {
    const html = r.render(D.createDraft());
    if (typeof html !== "string" || !html.length) throw new Error("no markup produced");
    if (/undefined|\[object Object\]|NaN/.test(html)) {
      throw new Error(`leaked a placeholder: ${html.match(/.{0,40}(undefined|\[object Object\]|NaN).{0,40}/)[0]}`);
    }
  });

  ok(`${step.id}: renders a full draft`, () => {
    const html = r.render(fullDraft());
    if (typeof html !== "string" || !html.length) throw new Error("no markup produced");
    if (/undefined|\[object Object\]|NaN/.test(html)) {
      throw new Error(`leaked a placeholder: ${html.match(/.{0,40}(undefined|\[object Object\]|NaN).{0,40}/)[0]}`);
    }
  });
}

// ── the summary must actually show what was entered ────────────────────────
{
  const html = STEP_RENDERERS.get("summary").render(fullDraft());
  const shows = (label, needle) => eq(`summary shows ${label}`, html.includes(needle), true);
  shows("the name", "Ashe");
  shows("the identity", "Wandering duellist");
  shows("the origin", "Vaskell");
  shows("the level", "Level 20");
  shows("both classes", "Guardian");
  shows("the second class", "Elementalist");
  shows("a skill breakdown", "Bodyguard");
  shows("the equipment", "Bronze Sword");
  shows("the bond target", "Mira");
  shows("the emotion", "affection");
  // The apostrophe in "<Username>'s PC" is escaped, as any player-derived text
  // must be — asserting the escaped form is the point, not an inconvenience.
  shows("the destination folder", "Oni&#39;s PC");
  shows("that the folder will be created", "does not exist yet");

  // The milestone advance must reach the summary, not just the attribute step.
  eq("summary shows the milestone-raised die", /d10<\/span><span class="k">Dexterity/.test(html), true);

  // A complete draft offers creation rather than a list of problems.
  eq("a complete draft reports ready", html.includes("Ready."), true);
  eq("...and raises no issues", D.validateAll(fullDraft()).ok, true);
}

// ── an incomplete draft explains itself instead of going quiet ─────────────
{
  const d = D.createDraft();          // no name, no attributes, no classes
  const html = STEP_RENDERERS.get("summary").render(d);
  eq("an empty draft is not ready", html.includes("Ready."), false);
  eq("...and lists what is missing", html.includes("left to settle"), true);
  eq("...naming the actual problems",
    D.validateAll(d).issues.map((i) => i.code).sort(),
    ["milestones_unspent", "no_name", "points_unspent", "too_few_classes", "unassigned"].sort()
      .filter((c) => c !== "milestones_unspent"));   // level 5 needs no milestones
}

// ── escaping ───────────────────────────────────────────────────────────────
{
  const d = D.createDraft();
  d.profile.name = `<img src=x onerror="alert(1)">`;
  d.bond.name = `Mira & "friends"`;
  B.setEmotion(d, "e1", "admiration");
  const html = STEP_RENDERERS.get("summary").render(d);
  eq("player text cannot inject markup", html.includes("<img src=x onerror"), false);
  eq("...it is escaped instead", html.includes("&lt;img src=x"), true);
  eq("ampersands and quotes survive escaped", html.includes("Mira &amp; &quot;friends&quot;"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
