'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const original = Module._load;
class Plugin { constructor() { this.app = {}; } }
class ItemView { constructor(leaf) { this.app = leaf.app; this.contentEl = {}; } }
class Modal {}
class Setting {}
class Menu {}
class PluginSettingTab {}
class TFile {}
Module._load = function(request, parent, isMain) {
  if (request === 'obsidian') return { Plugin, ItemView, Modal, Setting, Notice: class {}, Menu, PluginSettingTab, TFile };
  return original.apply(this, arguments);
};
const PluginClass = require('../main.js');
const { fmtTime, parseTime, makeExample, validateProject, createsCycle, scheduleDependents, hasConflict, roundSnap } = PluginClass.__test;
assert.equal(fmtTime(0), '00:00');
assert.equal(fmtTime(75), '01:15');
assert.equal(fmtTime(3600), '01:00:00');
assert.equal(parseTime('01:12'), 72);
assert.equal(parseTime('01:10:30'), 4230);
assert.equal(parseTime('00:75'), null);
assert.equal(parseTime('1:ab'), null);
assert.equal(parseTime(''), null);
assert.equal(roundSnap(13, 1), 13);
assert.equal(roundSnap(13, 5), 15);
let project = validateProject(makeExample());
assert.equal(project.lanes.length, 6);
assert.equal(project.cues.length, 7);
const first = project.cues[1], second = project.cues[2];
assert.ok(second.dependsOn.includes(first.id));
assert.equal(createsCycle(project, first.id, second.id), false);
assert.equal(createsCycle(project, second.id, first.id), true);
first.durationSec += 80;
const oldStart = second.startSec;
scheduleDependents(project, true);
assert.ok(second.startSec >= first.startSec + first.durationSec);
assert.ok(second.startSec > oldStart);
const changed = JSON.parse(JSON.stringify(project));
scheduleDependents(changed, false);
assert.deepEqual(changed, project);
const a = project.cues[0], b = project.cues[3];
assert.equal(hasConflict(project, a), false);
const originalLane = b.laneId;
b.laneId = a.laneId; b.startSec = a.startSec + 5; b.durationSec = 15;
assert.equal(hasConflict(project, b), true);
b.laneId = originalLane;
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
assert.equal(manifest.id, 'cueflow-timeline');
console.log('CueFlow smoke test PASS (time parsing, 1s snap, project, cycles, auto-schedule, conflicts, manifest).');
