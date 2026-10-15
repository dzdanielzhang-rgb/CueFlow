'use strict';
const assert=require('node:assert/strict'),Module=require('node:module'),original=Module._load;
Module._load=function(name){if(name==='obsidian')return{Plugin:class{},ItemView:class{},Modal:class{},Setting:class{},
  Menu:class{},PluginSettingTab:class{},TFile:class{},Notice:class{}};return original.apply(this,arguments);};
const t=require('../main.js').__test;
function fixture(){
  const view=Object.create(t.CueFlowView.prototype),project=t.validateProject({version:2,name:'泳道移动测试',durationSec:600,
    groups:[{id:'a',name:'人员'},{id:'b',name:'设备'},{id:'empty',name:'备用'}],
    lanes:[{id:'a1',name:'人员一',groupId:'a'},{id:'b1',name:'设备一',groupId:'b'},
      {id:'a2',name:'人员二',groupId:'a'},{id:'b2',name:'设备二',groupId:'b'}],
    cues:[{id:'cue',name:'动作',laneId:'a1',startSec:10,durationSec:20,dependsOn:[]}]});
  Object.assign(view,{project,collapsedGroups:new Set(['b']),history:[JSON.stringify(project)],historyIndex:0,queueSave(){},render(){}});
  return view;
}
const ids=(v,g)=>t.buildLaneLayout(v.project).rows.filter(r=>r.kind==='lane'&&r.lane.groupId===g).map(r=>r.lane.id);
let checks=0,v=fixture(),beforeCues=JSON.stringify(v.project.cues);
assert.equal(v.moveLaneTo('a2','a','a1','before'),true);assert.deepEqual(ids(v,'a'),['a2','a1']);checks++;
assert.equal(v.moveLaneTo('a2','a','a1','after'),true);assert.deepEqual(ids(v,'a'),['a1','a2']);checks++;
assert.equal(v.moveLaneTo('a1','b','b1','before'),true);assert.deepEqual(ids(v,'b'),['a1','b1','b2']);checks++;
assert.equal(JSON.stringify(v.project.cues),beforeCues);assert.equal(v.collapsedGroups.has('b'),false);checks++;
assert.equal(v.moveLaneTo('a1','empty'),true);assert.deepEqual(ids(v,'empty'),['a1']);checks++;
assert.equal(v.moveLaneTo('a1','b'),true);assert.deepEqual(ids(v,'b'),['b1','b2','a1']);checks++;
assert.equal(v.moveLaneTo('a1',''),true);assert.deepEqual(ids(v,''),['a1']);checks++;
const before=JSON.stringify(v.project),history=v.history.length;
assert.equal(v.moveLaneTo('a1','','a1','before'),false);
assert.equal(v.moveLaneTo('a1','missing'),false);
assert.equal(v.moveLaneTo('a1','a','b1','after'),false);
assert.equal(JSON.stringify(v.project),before);assert.equal(v.history.length,history);checks++;
v.undo();assert.deepEqual(ids(v,'b'),['b1','b2','a1']);v.redo();assert.deepEqual(ids(v,''),['a1']);checks++;
const restored=t.validateProject(JSON.parse(JSON.stringify(v.project)));
assert.deepEqual(restored,v.project);assert.equal(restored.cues[0].laneId,'a1');checks++;
console.log('Lane move PASS ('+checks+' checks: up/down, interleaved groups, cross-group placement, empty/collapsed groups, action safety, undo/redo and persistence).');
