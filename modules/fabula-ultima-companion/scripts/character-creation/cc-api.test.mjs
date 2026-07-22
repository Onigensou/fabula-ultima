/**
 * The document `buildActorData` hands to Actor.create, and the failure
 * messages the player is shown.
 *
 * The transaction itself needs a live world, so what is checkable offline is
 * the part that decides what gets WRITTEN: prop types, ownership, the seeded
 * point pool, and the milestone ledger that stops the attribute system handing
 * out the same advance twice.
 *
 * CSB type discipline is the point of most of these: user-entered fields are
 * strings, formula outputs are numbers. Getting it wrong hands CSB a string to
 * do arithmetic on, and nothing complains until a sheet renders wrong.
 */

// ── Foundry stub, before the imports that touch it ─────────────────────────
globalThis.CONST = {
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
};
globalThis.foundry = {
  utils: {
    duplicate: (o) => JSON.parse(JSON.stringify(o)),
    setProperty: (o, path, v) => {
      const parts = path.split(".");
      let cur = o;
      for (const k of parts.slice(0, -1)) cur = (cur[k] ??= {});
      cur[parts.at(-1)] = v;
      return true;
    },
    randomID: () => "id" + Math.random().toString(36).slice(2, 10),
  },
};
globalThis.Hooks = { once() {}, on() {}, callAll() {} };
globalThis.game = {
  user: { id: "u1", name: "Oni", isGM: false },
  users: [], actors: [], items: [], folders: [], scenes: {},
  socket: { emit() {}, on() {} },
  settings: { get: () => "" },
};
globalThis.ui = { notifications: { warn() {}, error() {}, info() {} } };

const API = await import("./cc-api.js");
const APP = await import("./cc-app.js");
const D = await import("./cc-draft.js");
const B = await import("./cc-step-bond.js");
const { CC } = await import("./cc-const.js");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n         got  ${g}\n         want ${w}`); }
};

/** Stands in for the blank seed actor's toObject(). */
const seed = () => ({
  _id: "CCBlankPC000Seed",
  name: "_CC Blank PC",
  img: "icons/svg/mystery-man.svg",
  type: "character",
  folder: "Qpc6ITpm60JVdwXF",
  ownership: { default: 0 },
  prototypeToken: { name: "_CC Blank PC", texture: { src: "icons/svg/mystery-man.svg" }, actorLink: false },
  system: { template: "OmwL5UqoVwjshkJo", props: {
    level: "5", zenit: "0", skill_point: 5, fabula_point: "3",
    mig_base: "8", dex_base: "8", ins_base: "8", wlp_base: "8",
    char_identity: "", theme: "", origin: "", backstory: "",
    off_hand: "Unarmed Strike",
  } },
  items: [],
});

const draft = (fn) => {
  const d = D.createDraft();
  d.profile.name = "Ashe";
  d.attributes.level = 5;
  d.attributes.assign = { mig: 10, dex: 8, ins: 8, wlp: 6 };
  fn?.(d);
  return d;
};
const build = (d) => API.buildActorData(seed(), d, { userId: "u1", folderId: "f1" });

// ── identity and placement ─────────────────────────────────────────────────
{
  const a = build(draft());
  eq("the seed's id is dropped", a._id, undefined);
  eq("named from the profile", a.name, "Ashe");
  eq("the prop name matches the document", a.system.props.name, "Ashe");
  eq("placed in the resolved folder", a.folder, "f1");
  eq("the seed's own folder is not inherited", a.folder === seed().folder, false);
  eq("the template link survives", a.system.template, "OmwL5UqoVwjshkJo");
  eq("no items are carried over", a.items, []);
}

// ── ownership (decision 3) ─────────────────────────────────────────────────
{
  const a = build(draft());
  eq("the requester owns it", a.ownership.u1, 3);
  eq("nobody else does", a.ownership.default, 0);
}

// ── images fall back rather than blanking ──────────────────────────────────
{
  const bare = build(draft());
  eq("no portrait means the Foundry default", bare.img, CC.DEFAULT_IMG);
  eq("no token art falls back to the portrait", bare.prototypeToken.texture.src, CC.DEFAULT_IMG);

  const arted = build(draft((d) => { d.profile.img = "worlds/x/ashe.webp"; }));
  eq("the portrait is used", arted.img, "worlds/x/ashe.webp");
  eq("...and the token borrows it", arted.prototypeToken.texture.src, "worlds/x/ashe.webp");

  const both = build(draft((d) => {
    d.profile.img = "worlds/x/ashe.webp";
    d.profile.tokenImg = "worlds/x/ashe-token.webp";
  }));
  eq("a separate token image wins", both.prototypeToken.texture.src, "worlds/x/ashe-token.webp");
  eq("...without changing the portrait", both.img, "worlds/x/ashe.webp");
  eq("the token is named and linked", [both.prototypeToken.name, both.prototypeToken.actorLink], ["Ashe", true]);

  // Whitespace is not a picture.
  const blank = build(draft((d) => { d.profile.img = "   "; }));
  eq("whitespace is treated as unset", blank.img, CC.DEFAULT_IMG);
}

// ── CSB types: strings for entered fields, numbers for formula outputs ─────
{
  const a = build(draft((d) => { d.attributes.level = 12; }));
  const p = a.system.props;
  eq("level is a string", [p.level, typeof p.level], ["12", "string"]);
  eq("zenit is a string", typeof p.zenit, "string");
  eq("fabula points are a string", [p.fabula_point, typeof p.fabula_point], ["3", "string"]);
  eq("attribute bases are strings",
    CC_TYPES(p, ["mig_base", "dex_base", "ins_base", "wlp_base"]), ["string", "string", "string", "string"]);
  // skill_point is the exception: applySpend writes it back as a NUMBER when
  // it debits, so seeding it as a string would flip its type on first spend.
  eq("skill_point is a number", typeof p.skill_point, "number");
}
function CC_TYPES(p, keys) { return keys.map((k) => typeof p[k]); }

// ── the point pool must equal the level, or the spends cannot run ──────────
{
  for (const lvl of [5, 10, 20, 41, 50]) {
    const p = build(draft((d) => { d.attributes.level = lvl; })).system.props;
    eq(`level ${lvl} is seeded with ${lvl} points`, p.skill_point, lvl);
    eq(`...and no bonus points`, p.skill_point_bonus, "0");
  }
}

// ── leftover zenit carries over ────────────────────────────────────────────
{
  const spent = draft((d) => {
    d.equipment.picks.push({ uuid: "Item.a", name: "Bronze Sword", cost: 200, slot: "weapon" });
    d.equipment.picks.push({ uuid: "Item.b", name: "Travel Garb", cost: 100, slot: "armor" });
  });
  eq("unspent budget becomes starting zenit", build(spent).system.props.zenit, "200");
  eq("buying nothing keeps the whole budget", build(draft()).system.props.zenit, "500");

  // Over budget is rejected upstream, but the document must never carry a
  // negative purse if one ever slips through.
  const over = draft((d) => {
    d.equipment.picks.push({ uuid: "Item.c", name: "Absurd", cost: 9999, slot: "weapon" });
  });
  eq("an over-budget draft cannot produce negative zenit", build(over).system.props.zenit, "0");
}

// ── profile text reaches the sheet ─────────────────────────────────────────
{
  const p = build(draft((d) => {
    d.profile.identity = "Wandering duellist";
    d.profile.theme = "Justice";
    d.profile.origin = "Vaskell";
    d.profile.backstory = "Left home after the fire.";
  })).system.props;
  eq("identity", p.char_identity, "Wandering duellist");
  eq("theme", p.theme, "Justice");
  eq("origin", p.origin, "Vaskell");
  eq("backstory", p.backstory, "Left home after the fire.");
}

// ── milestones are baked into the bases (decision 6) ───────────────────────
{
  const below = build(draft((d) => { d.attributes.level = 19; })).system.props;
  eq("below 20 the array is untouched",
    [below.mig_base, below.dex_base, below.ins_base, below.wlp_base], ["10", "8", "8", "6"]);

  const at20 = build(draft((d) => {
    d.attributes.level = 20;
    d.attributes.milestonePicks = ["wlp"];
  })).system.props;
  eq("one advance at 20 raises the die", at20.wlp_base, "8");
  eq("...and only that one", [at20.mig_base, at20.dex_base, at20.ins_base], ["10", "8", "8"]);

  const at41 = build(draft((d) => {
    d.attributes.level = 41;
    d.attributes.milestonePicks = ["wlp", "wlp"];
  })).system.props;
  eq("both advances stack on one attribute", at41.wlp_base, "10");
  eq("the advance is still a string", typeof at41.wlp_base, "string");
}

// ── failure messages are actionable ────────────────────────────────────────
{
  const say = (res) => APP.describeFailure(res);
  eq("a closed gate explains where creation is allowed",
    /title screen or at camp/.test(say({ reason: "gate_closed" })), true);
  eq("a missing seed points at the GM",
    /Ask your GM/.test(say({ reason: "missing_seed" })), true);
  eq("a timeout promises nothing was made",
    /Nothing was created/.test(say({ reason: "timeout" })), true);
  eq("an invalid draft repeats the first real issue",
    say({ reason: "invalid_draft", issues: [{ message: "A character needs a name." }] }),
    "A character needs a name.");

  // The distinction that matters: rolled back cleanly vs left a mess behind.
  eq("a rolled-back failure says nothing was kept",
    /rolled back — nothing was kept/.test(
      say({ reason: "finalize_failed", rolledBack: true, message: "boom" })), true);
  eq("a failed rollback names the orphan",
    /could not be removed/.test(
      say({ reason: "finalize_failed", rolledBack: false, orphanId: "abc123", message: "boom" })), true);
  eq("...and includes the id so a GM can find it",
    /abc123/.test(say({ reason: "finalize_failed", rolledBack: false, orphanId: "abc123", message: "boom" })), true);
  eq("an unknown reason still says something", say({ reason: "weird_thing" }), "Creation failed: weird_thing");
}

// ── the bond survives the round trip into writeSlot's shape ────────────────
{
  const d = draft((x) => { x.bond.name = "Mira"; x.bond.rel = "sister"; });
  B.setEmotion(d, "e3", "affection");
  eq("the emotion sits in its own field", [d.bond.e1, d.bond.e2, d.bond.e3], ["", "", "affection"]);
  eq("writeSlot receives every field it expects",
    Object.keys({ name: d.bond.name, rel: d.bond.rel, e1: d.bond.e1, e2: d.bond.e2, e3: d.bond.e3 }),
    ["name", "rel", "e1", "e2", "e3"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
