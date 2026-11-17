// Tests for the Show Text message box and the developer font option.
// No game required.
//
//   The font option: "default" | "pixelify" | a CSS font-family string,
//   resolved by one helper (dialog-ui.js resolveTextFont) and set as an
//   inline --oni-text-font on the one element drawn; it rides the payload.
//   Show Text "Show as": a row saved before it existed stays a bubble (with
//   the party-token fallback); a new row starts on Auto; Auto shows the box
//   when the speaker has no token here (and then no party-token fallback).
//   The box's portrait ("" default, "none", a path) and look (auto /
//   parchment / overPicture, auto = over a picture while one is up).
//   FU.SystemMessage lines carry the font (rules side).
//
// What this cannot check: anything drawn (the box on screen, its shake, the
// letterbox lift, the ▼ bob) and anything that crosses a socket between two
// clients. Those need a live look.
//
// Run: node <this file>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (path) => vm.runInThisContext(readFileSync(resolve(HERE, path), "utf8"), { filename: path });

const print = console.log.bind(console);
let fail = 0;
let count = 0;
const check = (name, ok, detail = "") => {
  count += 1;
  print(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) fail++;
};
const realLog = console.log, realWarn = console.warn;
const quiet = async (fn) => { console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = realLog; console.warn = realWarn; } };

// ---------------------------------------------------------------------------
// Stand-ins for Foundry
// ---------------------------------------------------------------------------
globalThis.window = globalThis;
console.debug = () => {};
console.groupCollapsed = () => {};
console.groupEnd = () => {};

const hooks = {};
globalThis.Hooks = {
  on: (name, fn) => { (hooks[name] ??= []).push(fn); },
  once: (name, fn) => { (hooks[name] ??= []).push(fn); },
  off: () => {},
  callAll: (name, ...args) => { for (const fn of hooks[name] ?? []) fn(...args); }
};

let idCounter = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `id${++idCounter}`,
    deepClone: (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
    mergeObject: (a, b) => ({ ...a, ...b })
  }
};

const actors = {
  hina: { id: "hina", name: "Hina", img: "art/hina.webp" },
  party: { id: "party", name: "Party", img: "art/party.webp" },
  ghost: { id: "ghost", name: "Ghost", img: "" }
};
// Tokens on the scene this client is looking at.
const placeable = (id, actor, src = "tok/" + id + ".webp") => ({
  id, actor, document: { id, name: actor.name, texture: { src } }, texture: { src }
});
const sceneTokens = new Map([
  ["tokHina", placeable("tokHina", actors.hina)],
  ["tokParty", placeable("tokParty", actors.party)]
]);

const emitted = [];
globalThis.game = {
  user: { id: "gm1", name: "GM", isGM: true },
  paused: false,
  actors: { get: (id) => Object.values(actors).find(a => a.id === id) ?? null },
  socket: { emit: (channel, packet) => emitted.push(packet), on: () => {} },
  settings: { register: () => {}, get: () => false }
};
globalThis.canvas = {
  ready: true,
  scene: { id: "scene1" },
  tokens: { get: (id) => sceneTokens.get(id) ?? null, placeables: [...sceneTokens.values()], controlled: [] }
};

// ---------------------------------------------------------------------------
// 1. The font option (dialog-ui.js)
// ---------------------------------------------------------------------------
load("dialog-ui.js");
const UI = globalThis.FU.DialogUI;

check("Font: nothing / empty / \"default\" = no override",
  UI.resolveTextFont(undefined) === null && UI.resolveTextFont(null) === null
  && UI.resolveTextFont("") === null && UI.resolveTextFont("  ") === null
  && UI.resolveTextFont("default") === null && UI.resolveTextFont("Default") === null);
check("Font: \"pixelify\" = the shipped pixel font's variable",
  UI.resolveTextFont("pixelify") === "var(--oni-text-font-pixelify)"
  && UI.resolveTextFont(" PIXELIFY ") === "var(--oni-text-font-pixelify)");
check("Font: any other string is a CSS font-family, kept",
  UI.resolveTextFont('"Signika", sans-serif') === '"Signika", sans-serif');
check("Font: characters that could end the declaration are dropped",
  UI.resolveTextFont("Arial; } body { color: red") === "Arial  body  color: red"
  && UI.resolveTextFont(";{}<>") === null);
check("Font: a non-string (object) is no font", UI.resolveTextFont({ a: 1 }) === null);

const fakeEl = () => {
  const props = new Map();
  return { props, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
};
{
  const el = fakeEl();
  UI.applyTextFont(el, "pixelify");
  check("applyTextFont: sets --oni-text-font inline on that element (plus the family reading it, no ligatures)",
    el.props.get("--oni-text-font") === "var(--oni-text-font-pixelify)"
    && el.props.get("font-family") === "var(--oni-text-font)"
    && el.props.get("font-variant-ligatures") === "none");
  UI.applyTextFont(el, "default");
  check("applyTextFont: \"default\" clears it again (a reused element)", el.props.size === 0);
}

// ---------------------------------------------------------------------------
// 2. The box look
// ---------------------------------------------------------------------------
check("Box look: parchment / overPicture are kept",
  UI.resolveBoxLook("parchment", true) === "parchment" && UI.resolveBoxLook("overPicture", false) === "overPicture");
check("Box look: auto = parchment with no picture up, overPicture with one",
  UI.resolveBoxLook("auto", false) === "parchment" && UI.resolveBoxLook("auto", true) === "overPicture"
  && UI.resolveBoxLook(undefined, false) === "parchment");
check("Box look: no Pictures API = no picture up", UI.picturesShown() === false);

// ---------------------------------------------------------------------------
// 3. FU.Dialog.show: the box payload, the font on every kind of line
// ---------------------------------------------------------------------------
const rendered = [];
UI.renderFromPayload = async (payload) => { rendered.push(payload); return { finished: Promise.resolve() }; };
load("dialog-core.js");
const Dialog = globalThis.FU.Dialog;

{
  emitted.length = 0; rendered.length = 0;
  const p = await Dialog.show({ actorId: "hina", text: "Hello.", box: true, font: "pixelify", broadcast: true });
  check("show({ box }): a box payload with no token needed",
    p.box?.look === "parchment" && p.screenAnchor === true && p.tokenId === null && p.name === "Hina",
    JSON.stringify({ box: p.box, tokenId: p.tokenId, name: p.name }));
  check("show({ box }): the actor's picture is the default portrait", p.portraitSrc === "art/hina.webp");
  check("show({ font }): the font rides the payload, drawn here and sent to every client",
    p.font === "pixelify" && rendered[0]?.font === "pixelify" && emitted[0]?.payload?.font === "pixelify");

  const none = await Dialog.show({ actorId: "hina", text: "Hm.", box: true, portraitSrc: "none", broadcast: false });
  check("show({ box, portraitSrc: \"none\" }): no portrait", none.portraitSrc === null);

  // A video token: the actor has no picture, the token is a .webm.
  sceneTokens.set("tokGhost", placeable("tokGhost", actors.ghost, "anim/ghost.webm"));
  const ghost = await Dialog.show({ tokenId: "tokGhost", text: "Boo.", box: true, broadcast: false });
  check("show({ box }): a video token gives no portrait (an <img> cannot show it)", ghost.portraitSrc === null);
  sceneTokens.delete("tokGhost");

  canvas.tokens.controlled = [sceneTokens.get("tokParty")];
  const voice = await Dialog.show({ text: "Who goes there?", name: "Voice", box: true, broadcast: false });
  check("show({ box }): never borrows the selected token",
    voice.tokenId === null && voice.actorId === null && voice.name === "Voice" && voice.portraitSrc === null);
  canvas.tokens.controlled = [];

  window.oni = { EventSystem: { Pictures: { anyShown: () => true } } };
  const over = await Dialog.show({ text: "...", name: "", box: true, broadcast: false });
  const forced = await Dialog.show({ text: "...", box: true, boxLook: "parchment", broadcast: false });
  check("show({ box }): look auto = overPicture while a picture is up; an explicit look wins",
    over.box.look === "overPicture" && forced.box.look === "parchment");
  delete window.oni;

  const bubble = await Dialog.show({ tokenId: "tokHina", text: "Hi.", font: '"Signika", serif', broadcast: false });
  check("show() bubble: unchanged shape (no box), carries the font",
    !bubble.box && bubble.tokenId === "tokHina" && bubble.font === '"Signika", serif');
  const plain = await Dialog.show({ tokenId: "tokHina", text: "Hi.", broadcast: false });
  check("show() bubble without a font: font null (the game font)", plain.font === null);

  const fl = await Dialog.showFloating({ text: "A voice...", font: "pixelify", broadcast: false });
  check("showFloating({ font }): carried on the floating line's payload", fl.font === "pixelify");
}

// ---------------------------------------------------------------------------
// 4. Show Text rules (event-showText-execute.js)
// ---------------------------------------------------------------------------
load("../event-system/event-logic.js");
load("../event-system/event-constants.js");
let nextSpeaker = { ok: false };
const shown = [];
globalThis.oni.EventSystem.ShowText = { SpeakerResolver: { resolve: async () => nextSpeaker } };
Dialog.show = async (opts) => { shown.push(opts); return { bubbleId: null }; };
load("../event-system/event-showText-execute.js");
const Execute = globalThis.oni.EventSystem.ShowText.Execute;
const R = Execute.rules;

check("showAs: a row with no showAs (saved before it existed) is a bubble",
  R.normalizeShowAs(undefined) === "bubble" && R.normalizeShowAs("") === "bubble" && R.normalizeShowAs("nonsense") === "bubble");
check("showAs: auto / bubble / box are kept",
  R.normalizeShowAs("auto") === "auto" && R.normalizeShowAs("bubble") === "bubble" && R.normalizeShowAs("box") === "box");
check("showAs auto: the box when the speaker has no token here, the bubble when it has",
  R.resolveShowAs("auto", false) === "box" && R.resolveShowAs("auto", true) === "bubble");
check("showAs bubble / box: always that, token or not",
  R.resolveShowAs("bubble", false) === "bubble" && R.resolveShowAs("box", true) === "box"
  && R.resolveShowAs(undefined, false) === "bubble");
check("boxLook: auto by default; parchment / overPicture kept",
  R.normalizeBoxLook(undefined) === "auto" && R.normalizeBoxLook("parchment") === "parchment"
  && R.normalizeBoxLook("overPicture") === "overPicture" && R.normalizeBoxLook("x") === "auto");
check("portrait: \"none\" = no portrait column", R.resolveBoxPortrait("none", { actorImg: "a.webp" }) === null
  && R.resolveBoxPortrait("NONE", { actorImg: "a.webp" }) === null);
check("portrait: a path is used", R.resolveBoxPortrait("art/x.png", { actorImg: "a.webp" }) === "art/x.png");
check("portrait: empty = the actor's picture, then the token's",
  R.resolveBoxPortrait("", { actorImg: "a.webp", tokenSrc: "t.webp" }) === "a.webp"
  && R.resolveBoxPortrait("", { actorImg: "", tokenSrc: "t.webp" }) === "t.webp"
  && R.resolveBoxPortrait("", {}) === null);
check("portrait: a video never goes in the <img> (path or token)",
  R.resolveBoxPortrait("anim/x.webm", { actorImg: "a.webp" }) === "a.webp"
  && R.resolveBoxPortrait("", { actorImg: "", tokenSrc: "t.webm" }) === null);
{
  const legacy = R.normalizeRow({ type: "showText", speaker: "Hina", text: "Hi" });
  check("normalizeRow: an old row = bubble, default portrait, auto look, no font",
    legacy.showAs === "bubble" && legacy.portrait === "" && legacy.boxLook === "auto" && legacy.font === null);
  const full = R.normalizeRow({ type: "showText", text: "Hi", showAs: "box", portrait: "none", boxLook: "overPicture", font: " pixelify " });
  check("normalizeRow: the new fields are kept",
    full.showAs === "box" && full.portrait === "none" && full.boxLook === "overPicture" && full.font === "pixelify");
}

// ---------------------------------------------------------------------------
// 5. Show Text end to end (the registry, then the executor)
// ---------------------------------------------------------------------------
load("../event-system/event-configKit.js");
load("../event-system/event-eventRegistry.js");
const { EventRegistry } = globalThis.oni.EventSystem;

{
  const fresh = EventRegistry.makeDefaultRow("showText");
  check("Registry: a new Show Text row starts on Auto, default portrait, auto look",
    fresh.showAs === "auto" && fresh.portrait === "" && fresh.boxLook === "auto" && fresh.bubbleMode === "normal");
  const [old] = EventRegistry.normalizeRows([{ type: "showText", speaker: "Hina", text: "Hi" }]);
  check("Registry: normalizing a saved row does NOT fill in showAs (it stays a bubble)",
    old.showAs === undefined && R.normalizeRow(old).showAs === "bubble");
}

const ctx = (extra = {}) => ({ sceneId: "scene1", tileId: "tile1", userId: "gm1", ...extra });
const partyCtx = () => ctx({ partyToken: sceneTokens.get("tokParty"), partyActor: actors.party });

async function run(row, speaker, context) {
  nextSpeaker = speaker;
  shown.length = 0;
  await quiet(() => Execute.execute({ type: "showText", text: "Line.", ...row }, context));
  return shown[0];
}

const noTokenSpeaker = { ok: true, mode: "name", speakerName: "Mysterious Voice", token: null, actor: null };
const hinaOnScene = { ok: true, mode: "name", speakerName: "Hina", token: sceneTokens.get("tokHina"), actor: actors.hina };
const hinaOffScene = { ok: true, mode: "name", speakerName: "Hina", token: null, actor: actors.hina };

{
  const legacy = await run({ speaker: "Mysterious Voice" }, noTokenSpeaker, partyCtx());
  check("Old row, speaker with no token: a bubble over the party token, exactly as before",
    !legacy.box && legacy.tokenId === "tokParty" && legacy.screen === false && legacy.name === "Mysterious Voice",
    JSON.stringify({ box: legacy.box, tokenId: legacy.tokenId, screen: legacy.screen }));
  check("Old row: no font, no box options added", !("font" in legacy) && !("boxLook" in legacy));

  const auto = await run({ speaker: "Mysterious Voice", showAs: "auto" }, noTokenSpeaker, partyCtx());
  check("Auto, speaker with no token: the box, with NO party-token fallback",
    auto.box === true && auto.tokenId === null && auto.actorId === null && auto.name === "Mysterious Voice"
    && auto.portraitSrc === "none" && auto.boxLook === "auto",
    JSON.stringify({ box: auto.box, tokenId: auto.tokenId, portraitSrc: auto.portraitSrc }));

  const autoHere = await run({ speaker: "Hina", showAs: "auto" }, hinaOnScene, partyCtx());
  check("Auto, speaker with a token here: the bubble over that token",
    !autoHere.box && autoHere.tokenId === "tokHina" && autoHere.screen === false);

  const autoAway = await run({ speaker: "Hina", showAs: "auto", boxLook: "overPicture" }, hinaOffScene, partyCtx());
  check("Auto, an actor with no token here: the box with the actor's picture and the chosen look",
    autoAway.box === true && autoAway.actorId === "hina" && autoAway.portraitSrc === "art/hina.webp"
    && autoAway.boxLook === "overPicture");

  const forced = await run({ speaker: "Hina", showAs: "box", portrait: "none", bubbleMode: "shout", font: "pixelify" }, hinaOnScene, partyCtx());
  check("Box: always the box, even with a token here; no portrait; shout kept; font passed",
    forced.box === true && forced.portraitSrc === "none" && forced.mode === "shout" && forced.font === "pixelify"
    && forced.tokenId === "tokHina");

  const custom = await run({ speaker: "Hina", showAs: "box", portrait: "art/hina-sad.png" }, hinaOnScene, partyCtx());
  check("Box: a portrait path is used", custom.portraitSrc === "art/hina-sad.png");

  const bubble = await run({ speaker: "Hina", showAs: "bubble", portrait: "none" }, hinaOffScene, partyCtx());
  check("Bubble: the party-token fallback still applies; the box fields are ignored",
    !bubble.box && bubble.tokenId === "tokParty" && bubble.portraitSrc !== "none");

  const fontBubble = await run({ speaker: "Hina", font: '"Signika"' }, hinaOnScene, partyCtx());
  check("Bubble with a font in the row data: passed on", fontBubble.font === '"Signika"' && !fontBubble.box);

  const self = await run({ speaker: "Self", showAs: "auto" },
    { ok: true, mode: "self", speakerName: globalThis.oni.EventSystem.Constants.SPECIAL_SPEAKER_SELF, token: null, actor: null }, ctx());
  check("Box: the \"Self\" placeholder of a party with no token prints no name", self.box === true && self.name === "");
}

// ---------------------------------------------------------------------------
// 6. Editor: the Show Text fields are collected, the font is kept
// ---------------------------------------------------------------------------
{
  const def = EventRegistry.peek("showText");
  const values = {
    ".oni-event-row-speaker": "Hina", ".oni-event-row-text": "Hi", ".oni-event-row-text-style": "think",
    ".oni-event-row-text-speed": "normal", ".oni-event-row-show-as": "box", ".oni-event-row-portrait": " art/p.png ",
    ".oni-event-row-box-look": "parchment"
  };
  const checks = { ".oni-event-row-no-portrait": false };
  const kit = {
    own: (rowEl, sel) => (sel in checks ? { checked: checks[sel] } : (sel in values ? { value: values[sel] } : null)),
    readText: (rowEl, sel, fallback) => (sel in values ? values[sel] : fallback)
  };
  const rowEl = { _rawRow: { font: "pixelify" } };
  const got = def.collectFields(rowEl, kit);
  check("Editor: Show as, portrait and box look are collected",
    got.showAs === "box" && got.portrait === "art/p.png" && got.boxLook === "parchment" && got.bubbleMode === "think");
  check("Editor: saving keeps the developer font (no field for it)", got.font === "pixelify");
  checks[".oni-event-row-no-portrait"] = true;
  check("Editor: No portrait is stored as \"none\"", def.collectFields({ _rawRow: {} }, kit).portrait === "none"
    && !("font" in def.collectFields({ _rawRow: {} }, kit)));
}

// ---------------------------------------------------------------------------
// 7. Floating Text row: the font (no editor field)
// ---------------------------------------------------------------------------
load("../event-system/event-rows-float.js");
{
  const def = EventRegistry.peek("floatingText");
  const [kept] = EventRegistry.normalizeRows([{ type: "floatingText", text: "A voice", font: "pixelify" }]);
  const [dropped] = EventRegistry.normalizeRows([{ type: "floatingText", text: "A voice", font: "  " }]);
  check("Floating Text: a row's font is kept; an empty one is dropped", kept.font === "pixelify" && !("font" in dropped));

  const kit = { readText: (el, sel, f) => f, readNumber: (el, sel, f) => f, own: () => null };
  check("Floating Text editor: saving keeps the font",
    def.collectFields({ _rawRow: { font: "pixelify" } }, kit).font === "pixelify"
    && !("font" in def.collectFields({ _rawRow: {} }, kit)));

  const floats = [];
  Dialog.showFloating = async (opts) => { floats.push(opts); return { bubbleId: "f1", finished: Promise.resolve() }; };
  UI.renderFloat = async () => ({});
  UI.isFloating = () => false;
  await quiet(() => def.execute({ ...kept }, { sceneId: "scene1", tileId: "tile1", nextRowType: "floatingText" }));
  check("Floating Text: the row's font reaches the floating line", floats[0]?.font === "pixelify");
}

// ---------------------------------------------------------------------------
// 8. FU.SystemMessage rules: the font
// ---------------------------------------------------------------------------
{
  const SM = await import("../shared/system-message-rules.js");
  check("SystemMessage: a line's font is kept, empty = none",
    SM.normalizeMessage({ text: "x", font: "pixelify" }).font === "pixelify"
    && SM.normalizeMessage("x").font === null && SM.normalizeMessage({ text: "x", font: " " }).font === null);
  const lines = SM.withFont(["a", { text: "b", font: "Georgia" }], "pixelify");
  check("SystemMessage: a call-wide font fills lines without their own (so a broadcast carries it)",
    lines[0].font === "pixelify" && lines[0].text === "a" && lines[1].font === "Georgia");
  const untouched = SM.withFont("a", null);
  check("SystemMessage: no font = the lines as given", untouched.length === 1 && untouched[0] === "a");
}

print(fail ? `\n${fail} of ${count} FAILED` : `\nall ${count} passed`);
if (fail) process.exit(1);
