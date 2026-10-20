"use strict";
//
// Mindscape — strip a loaded combat model down to what the engine reads, for embedding in
// a web page (the Balance Board's in-page simulator). The party alone is ~2 MB of
// animation scripts, descriptions and sheet tables the engine never touches.
//
// Fidelity is a test, not an assumption: bin/balance-board-build.js re-runs fights on the
// slim copy and refuses to build if any battle differs from the full model.

const ITEM_PROP_DROP = [
  "animation_script", "description", "attack_description", "custom_logic_resolution", "custom_logic_action",
  "passive_logic_resolution", "related_item_list", "item_skill_active", "skill_information", "img",
];
// Raw sheet fields the engine reads (engine.js init_penalty, stances.js action_pattern_table),
// plus the affinity / weapon-efficiency columns tuning tools rewrite.
const RAW_KEEP = /^(init_penalty|action_pattern_table|affinity_\d|[a-z]+_ef)$/;

function slimModel(model) {
  const m = JSON.parse(JSON.stringify(model));
  if (m._rawProps) m._rawProps = Object.fromEntries(Object.entries(m._rawProps).filter(([k]) => RAW_KEEP.test(k)));
  for (const it of m.items ?? []) {
    delete it.flags;
    for (const k of ITEM_PROP_DROP) if (it.props) delete it.props[k];
  }
  return m;
}

module.exports = { slimModel, ITEM_PROP_DROP };
