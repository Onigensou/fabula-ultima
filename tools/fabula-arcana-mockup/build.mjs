// Build the Fabula Arcana design mockup from the GAME's own duel page (standalone vs-AI mode) + the challenge panel.
// Everything inlined (art, sounds, board) so the page works as a shareable artifact. Re-run after any duel.html change.
//   node build.mjs <worktree module dir> <out.html>
import fs from "node:fs";
import path from "node:path";
const MOD = process.argv[2], OUT = process.argv[3];
const MIRROR = "C:/Users/Oni/AppData/Local/FoundryVTT/Data/forge-mirror/";
const FORGE = "https://assets.forge-vtt.com/";
const A = (p) => path.join(MOD, p);
const read = (p) => fs.readFileSync(A(p), "utf8");
const mime = (f) => ({ ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg" }[path.extname(f).toLowerCase()] || "application/octet-stream");
async function dataUri(url) {
  const rel = decodeURIComponent(url.replace(FORGE, ""));
  const local = MIRROR + rel;
  let buf;
  if (fs.existsSync(local)) buf = fs.readFileSync(local);
  else { const r = await fetch(url); if (!r.ok) throw new Error("fetch " + url + " " + r.status); buf = Buffer.from(await r.arrayBuffer()); }
  return `data:${mime(rel)};base64,${buf.toString("base64")}`;
}
// evaluate duel-assets.js to get ART / SFXURL
const assetsSrc = read("assets/fabula-arcana/duel-assets.js");
const { ART, SFXURL } = new Function(assetsSrc + "; return { ART, SFXURL };")();
const EXTRA = {   // sound choices to audition in the demo panel + the challenge-panel sounds (fa-client.js UI_SFX)
  inv_appear: "Sound/Soundboard/Bell3.ogg", inv_accept: "Sound/Soundboard/Item1.ogg", inv_decline: "Sound/Soundboard/Down1.ogg",
  alt_item3: "Sound/Soundboard/Item3.ogg", alt_chest1: "Sound/Soundboard/Chest1.ogg", alt_decision2: "Sound/Soundboard/Decision2.ogg", alt_close1: "Sound/Soundboard/Close1.ogg",
  alt_wind3: "Sound/Soundboard/Wind3.ogg", alt_wind4: "Sound/Soundboard/Wind4.ogg", alt_wind7: "Sound/Soundboard/Wind7.ogg",
};
const base = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/";
const art = {}, sfx = {};
for (const [k, u] of Object.entries(ART)) art[k] = await dataUri(u);
for (const [k, u] of Object.entries(SFXURL)) sfx[k] = await dataUri(u);
for (const [k, p] of Object.entries(EXTRA)) sfx[k] = await dataUri(base + p);
const board = `data:image/webp;base64,${fs.readFileSync(A("assets/fabula-arcana/board.webp")).toString("base64")}`;

let h = read("assets/fabula-arcana/duel.html");
const must = (a, b) => { if (!h.includes(a)) throw new Error("MISSING " + a.slice(0, 80)); h = h.replace(a, b); };
must(`<script src="../../scripts/fabula-arcana/fa-catalog.js"></script>`, `<script>\n${read("scripts/fabula-arcana/fa-catalog.js")}\n</script>`);
must(`<script src="duel-assets.js"></script>`, `<script>\nconst ART = ${JSON.stringify(art)};\nconst SFXDATA = ${JSON.stringify(sfx)};\nconst SFXURL = {};\n</script>`);
must(`url("board.webp")`, `url("${board}")`);
const invite = read("scripts/fabula-arcana/fa-invite-ui.js").replace(/^export /gm, "");
const demo = fs.readFileSync(new URL("./demo.js", import.meta.url), "utf8");
h += `\n<script>\n(() => {\n${invite}\nwindow.showInvitePanel = showInvitePanel;\n})();\n</script>\n<script>\n${demo}\n</script>\n`;
fs.writeFileSync(OUT, h);
console.log("wrote", OUT, (fs.statSync(OUT).size / 1048576).toFixed(2), "MB");
