'use strict';
const assert = require('node:assert/strict'), Module = require('node:module');
const original = Module._load, messages = [];
Module._load = function (name) {
  if (name === 'obsidian') return { Plugin:class{}, ItemView:class{}, Modal:class{}, Setting:class{}, Menu:class{},
    PluginSettingTab:class{}, TFile:class{}, Notice:class{constructor(message){messages.push(message);}} };
  return original.apply(this, arguments);
};
const t = require('../main.js').__test, copy = value => JSON.parse(JSON.stringify(value));
const fence = String.fromCharCode(96).repeat(3), re = new RegExp(fence + 'cueflow\\s*\\n([\\s\\S]*?)\\n' + fence);
function fixture() {
  const project = t.makeExample(), file = { path:'QA/duration.md' }, outputs = [];
  let body = '保留正文\n' + t.safeMarkdown(project) + '\n保留结尾';
  const view = Object.create(t.CueFlowView.prototype);
  Object.assign(view,{project,file,autoSchedule:true,snap:1,elapsed:0,running:false,history:[JSON.stringify(project)],historyIndex:0,
    saveChain:Promise.resolve(),savedBlocks:new Map([[file.path,body.match(re)[0]]]),editRevision:0,scale:3,
    queueSave(){},render(){},plugin:{settings:{folder:'QA'}},
    app:{vault:{read:async()=>body,modify:async(_,value)=>{body=value;},getAbstractFileByPath:()=>null,
      create:async(path,value)=>{outputs.push({path,value});return{path};}}}});
  return {view,outputs,data:()=>JSON.parse(body.match(re)[1]),body:()=>body};
}
(async()=>{
  let checks = 0;
  const f = fixture(), v = f.view, originalCues = copy(v.project.cues);
  assert.equal(v.setProjectDuration(1815),true);
  assert.equal(v.calculateDuration(),1815,'explicit total must preserve seconds instead of rounding to a minute'); checks++;
  assert.deepEqual(v.project.cues,originalCues,'changing total must not change action timing or dependencies'); checks++;
  v.undo(); assert.equal(v.project.durationSec,720);
  v.redo(); assert.equal(v.project.durationSec,1815); checks++;
  await v.saveNow();
  assert.equal(f.data().durationSec,1815);
  assert.equal(t.validateProject(f.data()).durationSec,1815);
  assert.ok(f.body().startsWith('保留正文')&&f.body().endsWith('保留结尾')); checks++;
  const before = JSON.stringify(v.project);
  for(const value of [null,NaN,Infinity,0,59,1.5,86401]) assert.equal(v.setProjectDuration(value),false);
  assert.equal(JSON.stringify(v.project),before); checks++;
  assert.equal(v.setProjectDuration(t.latestCueEnd(v.project)-1),false);
  assert.equal(JSON.stringify(v.project),before); checks++;
  const end = t.latestCueEnd(v.project);
  assert.equal(v.setProjectDuration(end),true); assert.equal(v.calculateDuration(),end); checks++;
  v.elapsed = end+100; v.setProjectDuration(end+1);
  assert.equal(v.elapsed,end+1); checks++;
  assert.equal(v.setProjectDuration(86400),true); assert.equal(v.calculateDuration(),86400); checks++;
  const g = fixture(), cue = {...g.view.project.cues[4],startSec:1700,durationSec:105};
  assert.equal(g.view.saveCue(cue),true);
  assert.equal(g.view.project.durationSec,1805); assert.equal(g.view.calculateDuration(),1805); checks++;
  const h = fixture();
  h.view.project.cues = [
    {id:'a',laneId:'lane-1',name:'前置',startSec:500,durationSec:500,status:'planned',note:'',dependsOn:[]},
    {id:'b',laneId:'lane-2',name:'后置',startSec:0,durationSec:600,status:'planned',note:'',dependsOn:[]}
  ];
  h.view.addDependency('a','b');
  assert.equal(h.view.project.cues[1].startSec,1000);
  assert.equal(h.view.project.durationSec,1600); checks++;
  const old = t.makeExample(); old.durationSec = 60;
  assert.equal(t.validateProject(old).durationSec,t.latestCueEnd(old)); checks++;
  v.setProjectDuration(1815);
  await v.exportCSV(); await v.exportSVG();
  const svg = f.outputs.find(o=>o.path.endsWith('.svg')).value;
  assert.equal(Number(svg.match(/width="(\d+)"/)[1]),190+1815*3+65);
  assert.ok(f.outputs.find(o=>o.path.endsWith('.csv')).value.includes('"开始(秒)"')); checks++;
  console.log('Duration PASS ('+checks+' checks: explicit seconds, action safety, undo/redo, persistence, bounds, clock, auto-extension and exports).');
})().catch(error=>{console.error(error);process.exitCode=1;});
