import assert from 'node:assert/strict';
import { guardPatternChange, stripPaths, widenerStatus } from './csb-pattern-condition-guard.js';

const P = 'system.props.action_pattern_table';
const table = {
  r1: { action_pattern_name: 'CotM', action_pattern_condition: 'formula', action_pattern_string: 'HP < 5', action_pattern_target_focus: 'highest_max_hp', action_pattern_priority: 1 },
  r2: { action_pattern_name: 'Empty', action_pattern_condition: 'formula', action_pattern_string: '  ', action_pattern_target_focus: 'auto' },
};
const flatten = (o, p = '', r = {}) => { for (const [k, v] of Object.entries(o)) { const q = p ? `${p}.${k}` : k; (v && typeof v === 'object' && !Array.isArray(v)) ? flatten(v, q, r) : (r[q] = v); } return r; };
const t = (name, fn) => { fn(); console.log('ok  ' + name); };

t('formula->always with text is stripped', () => {
  const g = guardPatternChange({ [`${P}.r1.action_pattern_condition`]: 'always' }, table);
  assert.deepEqual(g.strip, [`${P}.r1.action_pattern_condition`]);
});
t('same change with EMPTY formula text passes', () => {
  assert.equal(guardPatternChange({ [`${P}.r2.action_pattern_condition`]: 'always' }, table).strip.length, 0);
});
t('focus off widened value to default is stripped', () => {
  const g = guardPatternChange({ [`${P}.r1.action_pattern_target_focus`]: 'auto' }, table);
  assert.equal(g.strip.length, 1);
});
t('focus to another real value passes', () => {
  assert.equal(guardPatternChange({ [`${P}.r1.action_pattern_target_focus`]: 'lowest_hp' }, table).strip.length, 0);
});
t('unrelated column edit on same row passes', () => {
  assert.equal(guardPatternChange({ [`${P}.r1.action_pattern_priority`]: 5 }, table).strip.length, 0);
});
t('keeping formula passes', () => {
  assert.equal(guardPatternChange({ [`${P}.r1.action_pattern_condition`]: 'formula' }, table).strip.length, 0);
});
t('full-table shape (flattened nested) works and stripPaths removes only those fields', () => {
  const change = { system: { props: { action_pattern_table: { r1: { action_pattern_condition: 'always', action_pattern_target_focus: 'auto', action_pattern_priority: 9 }, r2: { action_pattern_condition: 'always' } } } } };
  const g = guardPatternChange(flatten(change), table);
  assert.equal(g.strip.length, 2);
  stripPaths(change, g.strip);
  assert.deepEqual(change.system.props.action_pattern_table.r1, { action_pattern_priority: 9 });
  assert.deepEqual(change.system.props.action_pattern_table.r2, { action_pattern_condition: 'always' });
});
t('partial dotted shape: stripPaths on dotted keys', () => {
  const change = { [`${P}.r1.action_pattern_condition`]: 'always', keep: 1 };
  const g = guardPatternChange(change, table);
  stripPaths(change, g.strip);
  assert.deepEqual(change, { keep: 1 });
});
t('unknown row / row delete key ignored', () => {
  assert.equal(guardPatternChange({ [`${P}.zz.action_pattern_condition`]: 'always', [`${P}.-=r1`]: null }, table).strip.length, 0);
});
t('widener installed: nothing stripped', () => {
  assert.equal(guardPatternChange({ [`${P}.r1.action_pattern_condition`]: 'always', [`${P}.r1.action_pattern_target_focus`]: 'auto' }, table, { installed: true }).strip.length, 0);
});
t('widenerStatus reads marker + reason', () => {
  assert.equal(widenerStatus({}).installed, false);
  assert.equal(widenerStatus({ __fuPatternConditionOptions: { installed: false, reason: 'x' } }).reason, 'x');
  assert.equal(widenerStatus({ __fuPatternConditionOptions: { installed: true } }).installed, true);
});
