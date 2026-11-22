"use strict";
// The Sonic Katar + Gunblade mockup page, built from the repo: every move from moves/sonic-katar (head, sonic, gunblade), the
// page's own parts from moves/sonic-katar/page (the HUD replica, the UI, the wielders' dice + balance panels, styles), the
// shared result picker, the move-engine mockup host. The ripped art / sounds and the review kit are read from E: (not in the repo).
//   build({ out, version: "v4", publish: true })  → the page you review (artifact JMwhSYL9JFS3F8i9sAg1oQ), review-kit page id kept
//   build({ out })                                 → a test page (its own review-kit page id, so tests never touch the review db)
const fs = require("fs");
const path = require("path");
const ME = require("../../build/mockup-parts.js");

const ANIM = "E:/Art(New Com)/DND/Fabula Ultima/Resource/Animation";
const ASSETS = path.join(ANIM, "Sonic Katar/src/assets");
const PAGE = path.join(__dirname, "page");
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// the page's own part: the wielders' dice + the balance panels (the moves live in head / sonic / gunblade)
function pagePart() {
  const ps = rd(path.join(PAGE, "part-sonic.js"));
  const i = ps.indexOf("// ───────── Sonic Blow helpers"), j = ps.indexOf("// ═════════ Balance panels");
  if (i < 0 || j < 0) throw new Error("part-sonic sections");
  const top = ps.slice(0, i).replace('const DIE_OPTS = ["d6", "d8", "d10", "d12"];\n', "");   // now in sonic.js
  return 'WIELD = "keren";   // Keren holds the weapons on this page (the chips switch it)\n' + top + ps.slice(j);
}

function build({ out, version = "test", publish = false, notes = "" } = {}) {
  const KITB = require(path.join(ANIM, "mockup-kit/kit-build.js"));
  let head = ME.pageHead();
  const rep = (a, b) => { if (typeof a === "string" ? !head.includes(a) : !a.test(head)) throw new Error("miss " + String(a).slice(0, 70)); head = head.replace(a, b); };
  rep("<title>Nox Legion Actions</title>", publish ? "<title>Sonic Blow Gunblade</title>" : "<title>Sonic Blow Gunblade (move-engine test)</title>");
  if (publish) {
    rep(/<div class="eyebrow">[^<]*<\/div>/, `<div class="eyebrow">Battle Director · item update · Rare dagger + Uncommon gunblade · mockup ${version}</div>`);
    rep("<h1>Nox Legion Actions</h1>", "<h1>Sonic Blow · Gunblade</h1>");
    rep(/<p>Every active move[^]*?<\/p>/, `<p>Sonic Katar's reworked <b>Sonic Blow</b> (one action card, 8 hits that each roll and can MISS, a Perfect bonus when all land) with Ragnarok Online's own effect and sound, and the new <b>Gunblade</b> that replaces Imperial Gunblade. Valley battle map, the real battle HUD at in-game size. Review each move: approve it, write a note, pause anywhere to comment on that moment, drag any slider, then press Send feedback.</p>`);
    rep("Valley_Battlemap004 · 3D stage", "Valley_Battlemap001 · 3D stage");
    rep(`<p class="muted" style="margin:0">Damage, heal and MP numbers are the game's own look. The real scripts won't draw text.</p>`,
      `<p class="muted" style="margin:0">HUD, numbers (incl. MISS), hit counter, NPC HP bar, namecard and cut-in are the game's own look. The Gunblade form badge is new.</p>`);
  }
  rep(/\.num \{[^\n]*\}\n\.num\.heal \{[^\n]*\}\n/, "");
  rep("</style>", ME.css(["hud", "dn", "hpbar", "namecard"]) + "\n" + rd(path.join(PAGE, "page.css")) + "\n</style>");

  const MIME = { webm: "video/webm", webp: "image/webp", png: "image/png", ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg" };
  const uri = (f) => { const ext = path.extname(f).slice(1).toLowerCase(); if (!MIME[ext]) throw new Error("mime " + f); return "data:" + MIME[ext] + ";base64," + fs.readFileSync(path.join(ASSETS, f)).toString("base64"); };
  const meta = JSON.parse(rd(path.join(ASSETS, "meta.json")));
  for (const k of Object.keys(meta.sprites)) meta.sprites[k] = uri(meta.sprites[k]);
  for (const k of Object.keys(meta.clips)) meta.clips[k].src = uri(meta.clips[k].src);
  for (const k of Object.keys(meta.sfx)) meta.sfx[k] = uri(meta.sfx[k]);

  const stage = ME.stageScript({ preset: ME.PRESETS.valley001, actors: { ...ME.PARTY_LINE, orc: { cx: 400, cy: 320, sc: 1.84, kind: "enemy" } }, seed: 2611,
    roles: "{ caster: () => ACT[WIELD], target: () => ACT.orc }" });
  const parts = [ME.engine(), ME.common(), rd(path.join(PAGE, "part-hud.js")), ME.fxMelee(), ME.moves(), ME.family("sonic-katar", "head"), pagePart(),
    ME.family("sonic-katar", "sonic"), ME.family("sonic-katar", "gunblade"), notes, ME.resultPicker(), rd(path.join(PAGE, "part-ui.js")),
    'mountResultPicker(document.querySelector(".panel"));'];
  const js = KITB.wrap(parts.join("\n"), publish ? { page: "sonic-katar-gunblade", version } : { page: "sonic-katar-gunblade-me", version: "me-test" });
  let lower = rd(path.join(PAGE, "page-lower.html"));
  if (publish) lower = lower.replace(/<footer>[^]*?<\/footer>/, `<footer>Sonic Katar · Sonic Blow + Gunblade · mockup ${version} · built on move-engine (tools/move-engine, the same move files the game runs). All 5 moves approved (round rmwqcke9s). Stage, battlers and hit feedback = the move-engine mockup host on Valley_Battlemap001.</footer>`);
  const html = head + "\n" + lower + "\n<script>\nwindow.META = " + JSON.stringify(meta) + ";\nwindow.HPBAR_T = " + ME.hpbarTiming() + ";\n" + stage + "\n</script>\n<script>\n" + js + "\n</script>\n";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return out;
}
module.exports = { build, pagePart, META: path.join(ASSETS, "meta.json") };
