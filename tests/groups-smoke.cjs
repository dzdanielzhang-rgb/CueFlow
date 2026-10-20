'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'obsidian') return { Plugin: class {}, ItemView: class {}, Modal: class {}, Setting: class {}, Notice: class {}, Menu: class {}, PluginSettingTab: class {}, TFile: class {} };
  return originalLoad.apply(this, arguments);
};
const { validateProject, makeExample, buildLaneLayout, laneAtY, CueFlowView, safeMarkdown } = require('../main.js').__test;
const copy = obj => JSON.parse(JSON.stringify(obj));
const legacy = makeExample();
delete legacy.groups;
legacy.version = 1;
for (const lane of legacy.lanes) delete lane.groupId;
legacy.lanes.push({ id: 'custom-old', name: '自定义岗位', color: '#123456' });
const originalCues = copy(legacy.cues);
const migrated = validateProject(legacy);
assert.equal(migrated.version, 5);
assert.equal(migrated.lanes.find(l => l.name === '无人机').groupId, 'equipment');
assert.equal(migrated.lanes.find(l => l.name === '飞手 A').groupId, 'personnel');
assert.equal(migrated.lanes.at(-1).groupId, '');
assert.deepEqual(migrated.cues, originalCues, 'migration must preserve every action and dependency');
const project = validateProject({
  name: '分组测试', durationSec: 600,
  groups: [{ id: 'pilots', name: '飞手组' }, { id: 'drones', name: '无人机组' }, { id: 'empty', name: '备用组' }],
  lanes: [{ id: 'drone', name: '无人机 1', groupId: 'drones' }, { id: 'pilot-a', name: '飞手 A', groupId: 'pilots' },
    { id: 'pilot-b', name: '飞手 B', groupId: 'pilots' }, { id: 'orphan', name: '临时岗位', groupId: 'missing' }],
  cues: [{ id: 'action', name: '起飞', laneId: 'drone', startSec: 10, durationSec: 20, dependsOn: [] }]
});
assert.equal(project.lanes.at(-1).groupId, '');
const layout = buildLaneLayout(project);
assert.deepEqual(layout.rows.filter(r => r.kind === 'lane').map(r => r.lane.id), ['pilot-a', 'pilot-b', 'drone', 'orphan']);
assert.equal(layout.laneY.get('pilot-a'), 36);
assert.equal(layout.laneY.get('drone'), 36 + 74 * 2 + 36);
assert.equal(laneAtY(layout, 0), undefined, 'group headers must never be drag destinations');
assert.equal(laneAtY(layout, 36).lane.id, 'pilot-a');
assert.equal(laneAtY(layout, 36 + 74).lane.id, 'pilot-b');
assert.equal(laneAtY(layout, 36 + 74 * 2), undefined);
assert.equal(laneAtY(layout, layout.height), undefined);
const collapsed = buildLaneLayout(project, new Set(['pilots']));
assert.equal(collapsed.laneY.has('pilot-a'), false);
assert.equal(collapsed.laneY.get('drone'), 72);
assert.equal(buildLaneLayout(project).laneY.has('pilot-a'), true, 'export must include collapsed lanes');
const view = Object.create(CueFlowView.prototype);
Object.assign(view, { project, collapsedGroups: new Set(['drones']), history: [JSON.stringify(project)], historyIndex: 0,
  queueSave() {}, render() {} });
view.saveLane({ id: 'new-lane', name: '  机长  ', groupId: 'drones', color: '#112233' });
assert.equal(project.lanes.at(-1).name, '机长');
assert.equal(view.collapsedGroups.has('drones'), false);
view.undo();
assert.equal(view.project.lanes.some(l => l.id === 'new-lane'), false);
view.redo();
assert.equal(view.project.lanes.at(-1).groupId, 'drones');
view.saveLane({ ...view.project.lanes.find(l => l.id === 'drone'), groupId: 'pilots', name: '无人机改名' });
assert.equal(view.project.cues[0].laneId, 'drone', 'reassignment must not move or delete actions');
view.moveLane('pilot-a', 1);
assert.deepEqual(view.project.lanes.filter(l => l.groupId === 'pilots').map(l => l.id), ['drone', 'pilot-b', 'pilot-a']);
view.moveGroup('drones', -1);
assert.equal(view.project.groups[0].id, 'drones');
const preservedCues = copy(view.project.cues), preservedIds = view.project.lanes.map(l => l.id);
global.window = { confirm: () => true };
view.removeGroup(view.project.groups.find(g => g.id === 'pilots'));
assert.deepEqual(view.project.cues, preservedCues);
assert.deepEqual(view.project.lanes.map(l => l.id), preservedIds);
assert.equal(view.project.lanes.find(l => l.id === 'drone').groupId, '');
const fence = String.fromCharCode(96).repeat(3);
const roundtrip = validateProject(JSON.parse(safeMarkdown(view.project).split(fence + 'cueflow\n')[1].split('\n' + fence)[0]));
assert.deepEqual(roundtrip, view.project, 'group edits must survive Markdown save and reopen');
assert.deepEqual(validateProject({ groups: [{ id: '', name: 'bad' }, { id: 'x', name: 'first' }, { id: 'x', name: 'duplicate' }, null], lanes: [], cues: [] }).groups,
  [{ id: 'x', name: 'first' }]);
console.log('Groups PASS (legacy migration, custom groups, collapse, drag targets, lane naming, reassignment, ordering, undo/redo and persistence).');
