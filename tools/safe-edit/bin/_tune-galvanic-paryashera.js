// Galvanic Paryashera, second pass after the user's live review (2026-10-31):
// bespoke animations (tools/anim-studio/paryashera-*.js), the form-change shot on
// Super Charge, a bigger token, and Supercharge's DEF/MDEF on keys that reach an NPC
// (`bonus_defense` is a PC sheet stat and does nothing on a monster).
//
// Idempotent. Run from tools/safe-edit; --apply to write.
const fs = require("fs");
const path = require("path");
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");
const { encode } = require("../../anim-studio/lib/encode");

const A = "ym6As1q7yG1EMl9M";
const I = { GALV: "F7gHvYczFw1y0OYj", SPIRAL: "GpSpiralDrillI01", VENT: "GpThunderVentI01", CHARGE: "mc5kTxNZqC62RxDd" };
const SCALE = 2.2;

const dir = path.join(__dirname, "../../anim-studio");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const spiral = read("paryashera-drill.js");
const swap = (s, from, to) => { if (!s.includes(from)) throw new Error(`no "${from}" in the drill shot`); return s.replace(from, to); };
// Galvanic Drill = the same shot, lightning instead of steam.
let galv = spiral;
for (const [from, to] of [
  ['look: "steam"', 'look: "bolt"'], ["bandColor: 0xe8e4f4", "bandColor: 0xeccbff"], ["rimColor: 0xb9a8dc", "rimColor: 0xb070ff"],
  ['trailClip: "smoke_anim12.webm"', 'trailClip: "spark_anim01.webm"'], ["trailTint: 0xd8d4e4", "trailTint: 0xc98cff"],
  ["burstTint: 0xf2eefa", "burstTint: 0xc98cff"], ["sparkTint: 0xffffff", "sparkTint: 0xe2bcff"], ['hitSfx: "Explosion2"', 'hitSfx: "Thunder7"'],
]) galv = swap(galv, from, to);

const GGS = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/Guilty%20Gear%20Strive/webm/";
const anim = (src, preload) => ({ skill_animation_mode: "custom", animation_script: encode(src), animation_damage_timing_options: "default", animation_damage_timing_offset: "0", animation_preload_urls: preload.join("\n") });
const PRE_DRILL = ["burst_anim02.webm", "spark_anim01.webm", "dashsmoke_anim01.webm", "smoke_anim12.webm"].map((f) => GGS + f);
const PRE_VENT = ["https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Animation/RPG%20Maker%20MV/076_thunder_one_1.webm", GGS + "spark_anim01.webm"];
const PRE_CHARGE = ["burst_anim02.webm", "burst_anim05.webm", "spark_anim01.webm"].map((f) => GGS + f);

const clone = (o) => JSON.parse(JSON.stringify(o));
async function need(coll, key) { const v = await getByKey(coll, key); if (!v) throw new Error(`missing ${key}`); return v; }

(async () => {
  await run(async ({ changes }) => {
    const ik = (id) => `!actors.items!${A}.${id}`;
    const put = async (id, fn, note) => { const d = clone(await need("actors", ik(id))); fn(d.system.props, d); changes.push([ik(id), d, note]); };
    await put(I.SPIRAL, (p) => Object.assign(p, anim(spiral, PRE_DRILL)), "Spiral Drill: silhouette drill ram");
    await put(I.GALV, (p) => Object.assign(p, anim(galv, PRE_DRILL)), "Galvanic Drill: silhouette drill ram, lightning");
    await put(I.VENT, (p) => Object.assign(p, anim(read("paryashera-thunder-vent.js"), PRE_VENT)), "Thunder Vent: own bolts, not Kirin's");
    await put(I.CHARGE, (p) => {
      Object.assign(p, anim(read("paryashera-supercharge.js"), PRE_CHARGE));
      const rx = p.reaction_config_table["0"];
      rx.reaction_effect_ref = "sc_chain";
      // The shot fires its gate at the flare's peak, so the AE, and with it the
      // Supercharged art, lands under the flare.
      p.effect_table = {
        "0": { $deleted: false, effect_kind: "chain", effect_label: "sc_chain", chain_steps: "sc_shot,sc_apply" },
        "1": { $deleted: false, effect_kind: "play_animation", effect_label: "sc_shot", action_ref: "Super Charge", target_ref: "self" },
        "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_apply", ae_template_ref: "Supercharge", target_ref: "self", ae_duplicate_mode: "skip" },
      };
    }, "Super Charge: form-change shot, then the AE");
    const actor = clone(await need("actors", `!actors!${A}`));
    actor.prototypeToken.texture.scaleX = SCALE; actor.prototypeToken.texture.scaleY = SCALE;
    changes.push([`!actors!${A}`, actor, `token scale ${SCALE}`]);
  }, "galvanic-paryashera: animations + scale", "actors");

  await run(async ({ changes }) => {
    const key = "!items.effects!0rfKFWTyPt7TfUvl.wPkGIdQeP7kpaw8n";
    const ae = clone(await need("items", key));
    for (const c of ae.changes) {
      if (c.key === "bonus_defense") c.key = "defense";
      if (c.key === "bonus_magic_defense") c.key = "magic_defense";
    }
    if (!ae.changes.some((c) => c.key === "defense") || !ae.changes.some((c) => c.key === "magic_defense")) throw new Error("Supercharge keys");
    changes.push([key, ae, "Supercharge: DEF/MDEF on keys an NPC honours"]);
  }, "galvanic-paryashera: Supercharge DEF keys", "items");
})().catch((e) => { console.error(e); process.exit(1); });
