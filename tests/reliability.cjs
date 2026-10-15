'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const nativeLoad = Module._load, notices = [];
Module._load = function (name) {
  if (name === 'obsidian') return { Plugin: class {}, ItemView: class {}, Modal: class {}, Setting: class {}, Menu: class {},
    PluginSettingTab: class {}, TFile: class {}, Notice: class { constructor(text) { notices.push(text); } } };
  return nativeLoad.apply(this, arguments);
};
const t = require('../main.js').__test, clone = x => JSON.parse(JSON.stringify(x));
const fence = String.fromCharCode(96).repeat(3), blockRE = new RegExp(fence + 'cueflow\\s*\\r?\\n([\\s\\S]*?)\\r?\\n' + fence, 'm');
const results = [];
const test = async (name, action) => {
  try { await action(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message.slice(0, 240) }); }
};
function fixture() {
  const project = t.makeExample(), file = { path: 'QA/test.md' };
  let document = '保留前言\n' + t.safeMarkdown(project) + '\n保留后记', writes = 0, fail = false;
  const view = Object.create(t.CueFlowView.prototype);
  Object.assign(view, { app: { vault: { read: async () => document, modify: async (f, body) => {
    if (fail) { fail = false; throw new Error('simulated write failure'); } document = body; writes++;
  } } }, file, project, saveChain: Promise.resolve(), saveTimer: null, savedBlocks: new Map([[file.path, document.match(blockRE)[0]]]),
    collapsedGroups: new Set(), autoSchedule: true, snap: 1, selectedId: null, history: [JSON.stringify(project)], historyIndex: 0,
    queueSave() {}, render() {}, running: false });
  return { view, file, get document() { return document; }, set document(value) { document = value; },
    get writes() { return writes; }, failNext() { fail = true; }, data() { return JSON.parse(document.match(blockRE)[1]); } };
}
(async () => {
  await test('保存美元替换符及中文备注不会破坏 JSON', async () => {
    const f = fixture(), text = "$& / $' / " + '$' + String.fromCharCode(96) + ' / $$ / 中文\n第二行';
    f.view.project.cues[0].name = text; f.view.project.cues[0].note = text; await f.view.saveNow();
    assert.equal(f.data().cues[0].name, text); assert.equal(f.data().cues[0].note, text);
    assert.ok(f.document.startsWith('保留前言')); assert.ok(f.document.endsWith('保留后记'));
  });
  await test('外部删除数据块后保存不会覆盖整篇笔记', async () => {
    const f = fixture(); f.document = '# 已改成普通笔记\n必须保留'; const before = f.document;
    await f.view.saveNow(); assert.equal(f.document, before); assert.equal(f.writes, 0);
  });
  await test('外部更改排程时拒绝静默覆盖', async () => {
    const f = fixture(), other = clone(f.view.project); other.cues[0].name = '外部最新修改';
    f.document = t.safeMarkdown(other); const before = f.document;
    f.view.project.cues[0].name = '旧视图修改'; await f.view.saveNow(); assert.equal(f.document, before);
  });
  await test('外部修改正文可与时间轴保存共存', async () => {
    const f = fixture(); f.document = '新增正文\n' + f.document + '\n新增备注';
    f.view.project.cues[0].name = '新动作名'; await f.view.saveNow();
    assert.ok(f.document.startsWith('新增正文')); assert.ok(f.document.endsWith('新增备注'));
    assert.equal(f.data().cues[0].name, '新动作名');
  });
  await test('写入失败后可重试，保存状态真实', async () => {
    const f = fixture(); f.failNext(); f.view.project.cues[0].name = '待保存动作';
    const first = await f.view.saveNow(); assert.equal(first, false); assert.equal(f.writes, 0);
    assert.equal(await f.view.saveNow(), true); assert.equal(f.data().cues[0].name, '待保存动作');
  });
  await test('快速连续保存最终保留最新编辑', async () => {
    const f = fixture(); f.view.project.cues[0].name = '第一次'; const first = f.view.saveNow();
    f.view.project.cues[0].name = '第二次'; const second = f.view.saveNow(); await Promise.all([first, second]);
    assert.equal(f.data().cues[0].name, '第二次');
  });
  await test('关闭视图等待已开始的保存完成', async () => {
    const f = fixture(); let done = false;
    f.view.saveChain = new Promise(resolve => setTimeout(() => { done = true; resolve(true); }, 25));
    await f.view.onClose(); assert.equal(done, true);
  });
  await test('24 小时边界复制动作不产生隐藏排程', () => {
    const f = fixture(), cue = f.view.project.cues[0]; cue.startSec = 86390; cue.durationSec = 10; cue.dependsOn = [];
    const before = JSON.stringify(f.view.project); f.view.duplicateCue(cue);
    assert.equal(JSON.stringify(f.view.project), before);
  });
  await test('依赖顺延超过 24 小时时保留原排程', () => {
    const f = fixture(); f.view.project.cues = [
      { id: 'a', laneId: 'lane-1', name: '前置', startSec: 86390, durationSec: 10, dependsOn: [], status: 'planned', note: '' },
      { id: 'b', laneId: 'lane-2', name: '后置', startSec: 100, durationSec: 10, dependsOn: [], status: 'planned', note: '' }
    ];
    const before = JSON.stringify(f.view.project); f.view.addDependency('a', 'b');
    assert.equal(JSON.stringify(f.view.project), before);
  });
  await test('循环依赖的项目文件拒绝加载', () => {
    const project = t.makeExample(); project.cues[0].dependsOn = [project.cues[1].id]; project.cues[1].dependsOn = [project.cues[0].id];
    assert.throws(() => t.validateProject(project), /循环/);
  });
  await test('重复泳道 ID 的项目文件拒绝加载', () => {
    const project = t.makeExample(); project.lanes[1].id = project.lanes[0].id;
    assert.throws(() => t.validateProject(project), /重复/);
  });
  await test('动作结束超过 24 小时的文件拒绝加载', () => {
    const project = t.makeExample(); project.cues[0].startSec = 86399; project.cues[0].durationSec = 2;
    assert.throws(() => t.validateProject(project), /24/);
  });
  await test('排练时钟到终点自动停止且不越界', () => {
    const view = Object.create(t.CueFlowView.prototype);
    Object.assign(view, { elapsed: 60, running: true, timerBase: 59, timerOrigin: performance.now() - 2500,
      tickHandle: null, calculateDuration: () => 60, updateClockUI() {} });
    view.pauseClock(); assert.equal(view.running, false); assert.equal(view.elapsed, 60);
  });
  await test('无效时间输入拒绝，秒级吸附边界正确', () => {
    for (const value of ['', '-1', '00:60', '01:99', 'abc', '1.5']) assert.equal(t.parseTime(value), null);
    for (const snap of [1, 5, 10, 30, 60]) for (let sec = -10; sec <= 200; sec++) {
      const value = t.roundSnap(sec, snap); assert.ok(value >= 0 && value % snap === 0);
    }
  });
  await test('逆序长依赖链满足先完成后开始', () => {
    const cues = Array.from({ length: 100 }, (_, i) => ({ id: 'n' + i, startSec: 0, durationSec: 1,
      dependsOn: i ? ['n' + (i - 1)] : [] })).reverse();
    t.scheduleDependents({ cues }, true);
    for (const cue of cues) assert.equal(cue.startSec, Number(cue.id.slice(1)));
  });
  await test('设置目录支持中文与 Windows 分隔符并拒绝越界路径', () => {
    const slash = String.fromCharCode(92);
    assert.equal(t.normalizeFolder('CueFlow' + slash + '发布会' + slash + '排练'), 'CueFlow/发布会/排练');
    assert.equal(t.normalizeFolder(''), 'CueFlow');
    for (const path of ['../其他目录', 'CueFlow/../其他目录', 'D:' + slash + '演示', 'CueFlow/非法?目录'])
      assert.throws(() => t.normalizeFolder(path));
  });
  console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length, results }, null, 2));
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ results }, null, 2));
  if (results.some(r => !r.passed)) process.exitCode = 1;
})();
