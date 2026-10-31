// Galvanic Paryashera: Thunder Vent once per round, by a hidden marker.
//
// The row's cooldown did not hold in a live battle (two casts back to back), so the
// gate is explicit. Super Charge grants "Vent Ready" when it fires and again at each
// round start while Supercharged; casting spends it. 30 MP of 60 still caps it at two.
//
// Idempotent. Run from tools/safe-edit; --apply to write.
const { getByKey } = require("../lib/db");
const { run } = require("./_fafnir-util");
const A = "ym6As1q7yG1EMl9M", CHARGE = "mc5kTxNZqC62RxDd", VENT = "GpThunderVentI01", AE = "GpVentReadyMark1";
const NS = "fabula-ultima-companion";
const clone = (o) => JSON.parse(JSON.stringify(o));
const need = async (k) => { const v = await getByKey("actors", k); if (!v) throw new Error(`missing ${k}`); return v; };
const blankRow = (o) => ({ $deleted: false, reaction_passive_mode: "force", ...o });
(async () => {
  await run(async ({ changes }) => {
    const ik = (id) => `!actors.items!${A}.${id}`;
    const ch = clone(await need(ik(CHARGE)));
    const p = ch.system.props;
    p.effect_table = {
      "0": { $deleted: false, effect_kind: "chain", effect_label: "sc_chain", chain_steps: "sc_shot,sc_apply,sc_ready" },
      "1": { $deleted: false, effect_kind: "play_animation", effect_label: "sc_shot", action_ref: "Super Charge", target_ref: "self" },
      "2": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_apply", ae_template_ref: "Supercharge", target_ref: "self", ae_duplicate_mode: "skip" },
      "3": { $deleted: false, effect_kind: "apply_ae", effect_label: "sc_ready", ae_template_ref: "Vent Ready", target_ref: "self", ae_duplicate_mode: "skip" },
    };
    p.reaction_config_table["1"] = blankRow({ reaction_trigger: "round_start", reaction_source: "",
      condition_formula: "AE_COUNT_SUPERCHARGE > 0 && AE_COUNT_VENT_READY == 0", reaction_effect_ref: "sc_ready" });
    ch.effects = [AE];
    changes.push([ik(CHARGE), ch, "Super Charge: grants Vent Ready"]);

    const roper = await need("!actors.items!NlYBXQwmXIttrDod.iHiXf8OOFWXfVztS");
    const marker = clone(await need(`!actors.items.effects!NlYBXQwmXIttrDod.iHiXf8OOFWXfVztS.${roper.effects[0]}`));
    marker._id = AE; marker.name = "Vent Ready"; marker.description = "<p>Its vents have recharged this round.</p>";
    marker.flags = { ...marker.flags, [NS]: { lifetimeMode: "persistent_counter", hidden: true } };
    changes.push([`!actors.items.effects!${A}.${CHARGE}.${AE}`, marker, "marker AE: Vent Ready"]);

    const v = clone(await need(ik(VENT)));
    v.system.props.on_activate_effect_ref = "vent_spend";
    v.system.props.effect_table = { "0": { $deleted: false, effect_kind: "remove_ae", effect_label: "vent_spend", ae_template_ref: "Vent Ready", target_ref: "self", count: "all", include_persistent: true } };
    changes.push([ik(VENT), v, "Thunder Vent: spends Vent Ready"]);

    const a = clone(await need(`!actors!${A}`));
    const row = Object.values(a.system.props.action_pattern_table).find((r) => r.action_pattern_name === "Thunder Vent");
    row.action_pattern_string = "Vent Ready"; row.action_pattern_cooldown = "0";
    changes.push([`!actors!${A}`, a, "AI: Thunder Vent gated on Vent Ready"]);
  }, "galvanic-paryashera: Thunder Vent gate", "actors");
})().catch((e) => { console.error(e); process.exit(1); });
