'use strict';

const { Plugin, ItemView, Modal, Setting, Notice, Menu, PluginSettingTab, TFile } = require('obsidian');

const VIEW_TYPE = 'cueflow-timeline-view';
const BLOCK_RE = /```cueflow\s*\r?\n([\s\S]*?)\r?\n```/m;
const DEFAULTS = {
  folder: 'CueFlow',
  snapSeconds: 1,
  pixelsPerMinute: 180,
  autoSchedule: true,
  lastProjectPath: '',
  laneDensity: 'standard',
  labelWidth: 182,
};
const LANES = [
  ['导播', '#5B78E5', 'personnel'], ['飞手 A', '#0F9C91', 'personnel'], ['飞手 B', '#D69332', 'personnel'],
  ['无人机', '#7E69CF', 'equipment'], ['地面机器人', '#CF7183', 'equipment'], ['演员/场控', '#637E94', 'personnel'],
];
const DEFAULT_GROUPS = [{ id: 'personnel', name: '执行人员' }, { id: 'equipment', name: '设备' }];
const COLORS = ['#5B78E5', '#0F9C91', '#D69332', '#7E69CF', '#CF7183', '#637E94', '#6E9E53'];
const LABEL_WIDTH = 182;
const HEADER_HEIGHT = 48;
const ROW_HEIGHT = 74;
const GROUP_HEIGHT = 36;
const MIN_CUE_SEC = 1;
const STEPS = [1, 5, 10, 30, 60];
const ZOOMS = [1, 10, 20, 40, 75, 120, 180, 300, 600, 900];

function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function positive(n, fallback) { const value = Number(n); return Number.isFinite(value) && value > 0 ? value : fallback; }
function isInteger(n) { return Number.isInteger(n) && Number.isFinite(n); }
function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function parseTime(value) {
  const str = String(value ?? '').trim();
  if (!/^\d+(?::[0-5]?\d){0,2}$/.test(str)) return null;
  const parts = str.split(':').map(Number);
  let result = 0;
  for (const part of parts) result = result * 60 + part;
  return isInteger(result) && result >= 0 ? result : null;
}
function roundSnap(s, snap) { return Math.max(0, Math.round(s / snap) * snap); }
function latestCueEnd(project) {
  return project.cues.reduce((end, cue) => Math.max(end, cue.startSec + cue.durationSec), 0);
}
function normalizeFolder(value) {
  const folder = String(value || 'CueFlow').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'CueFlow';
  const parts = folder.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || /[:*?"<>|]/.test(part))) throw new Error('请填写知识库内的相对目录，例如 CueFlow/发布会');
  return parts.join('/');
}
function filenameFor(name) { return (name.trim().replace(/[\\/:*?"<>|#^\[\]]/g, '-').replace(/\s+/g, ' ').slice(0, 65) || '未命名演示'); }
function xmlEscape(t) { return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function makeExample() {
  const lanes = LANES.map(([name, color, groupId], i) => ({ id: 'lane-' + (i + 1), name, color, groupId }));
  const c = (name, lane, start, duration, details = '', depends = []) => ({ id: uid('cue'), name, laneId: lanes[lane].id, startSec: start, durationSec: duration, note: details, dependsOn: depends, status: 'planned' });
  const opening = c('开场画面 / 主持词', 0, 0, 75, '导播确认投屏和解说词。');
  const mesh = c('端侧 Mesh 组网确认', 1, 0, 95, '2 台遥控、4 架无人机与 1 台地面机器人完成组网。');
  const search = c('四机分区搜索', 1, 105, 180, '确认航线与画面稳定。', [mesh.id]);
  const cam = c('切换搜索画面', 0, 110, 35, '切至飞手 A 遥控画面。', [opening.id]);
  const flex = c('Flex 地面出动', 2, 190, 125, '提示地面机器人操作人员。');
  const actor = c('目标人员入场', 5, 195, 50, '场控通过耳返提示演员。');
  const mark = c('第一幕结束', 0, 330, 0, '里程碑：全部设备进入下一幕准备状态。', [search.id]);
  return { version: 5, syncLinks: [], relations: [], dependencyLabels: [], name: '无人机空地协同演示（示例）', durationSec: 720, groups: deepCopy(DEFAULT_GROUPS), lanes, cues: [opening, mesh, search, cam, flex, actor, mark] };
}
function validateProject(obj) {
  if (!obj || !Array.isArray(obj.lanes) || !Array.isArray(obj.cues)) throw new Error('文件中缺少 lanes 或 cues 数组');
  if (Number(obj.version) > 5) throw new Error('项目版本较新，请升级 CueFlow 后再打开');
  const laneIds = new Set(), actionIds = new Set();
  for (const lane of obj.lanes) {
    if (!lane || typeof lane.id !== 'string' || !lane.id.trim()) throw new Error('泳道缺少有效 ID');
    if (laneIds.has(lane.id)) throw new Error('泳道 ID 重复，请修复项目文件');
    laneIds.add(lane.id);
  }
  for (const cue of obj.cues) {
    if (!cue || typeof cue.id !== 'string' || !cue.id.trim()) throw new Error('动作缺少有效 ID');
    if (actionIds.has(cue.id)) throw new Error('动作 ID 重复，请修复项目文件');
    actionIds.add(cue.id);
    if (!laneIds.has(cue.laneId)) throw new Error('动作引用了不存在的泳道');
    if (!isInteger(cue.startSec) || !isInteger(cue.durationSec) || cue.startSec < 0 || cue.durationSec < 0 || cue.startSec + cue.durationSec > 86400)
      throw new Error('动作时间必须是非负整数秒，结束时间不能超过 24 小时');
  }
  for (const cue of obj.cues) for (const id of cue.dependsOn || []) {
    if (!actionIds.has(id)) throw new Error('前置动作不存在，请修复项目文件');
    if (id === cue.id) throw new Error('依赖关系会形成循环');
  }
  const legacy = !Array.isArray(obj.groups);
  const groupIds = new Set();
  obj.groups = (legacy ? deepCopy(DEFAULT_GROUPS) : obj.groups)
    .filter(g => g && typeof g.id === 'string' && g.id.trim() && !groupIds.has(g.id) && groupIds.add(g.id))
    .map(g => ({ id: g.id, name: String(g.name || '未命名分组').trim() || '未命名分组' }));
  obj.version = 5;
  obj.name = typeof obj.name === 'string' ? obj.name : '未命名项目';
  obj.durationSec = clamp(Math.ceil(positive(obj.durationSec, 1200)), 60, 86400);
  obj.lanes = obj.lanes.filter(l => l && typeof l.id === 'string').map((l, i) => {
    const fallbackGroup = legacy ? LANES.find(([name]) => name === l.name)?.[2] : '';
    const groupId = typeof l.groupId === 'string' ? l.groupId : fallbackGroup || '';
    return { id: l.id, name: String(l.name || '泳道'), color: /^#[\da-f]{6}$/i.test(l.color) ? l.color : COLORS[i % COLORS.length],
      groupId: groupIds.has(groupId) ? groupId : '' };
  });
  const ids = new Set();
  obj.cues = obj.cues.filter(c => c && typeof c.id === 'string' && typeof c.laneId === 'string' && !ids.has(c.id) && ids.add(c.id))
    .filter(c => obj.lanes.some(l => l.id === c.laneId))
    .map(c => ({
      id: c.id, laneId: c.laneId, name: String(c.name || '未命名动作'),
      startSec: clamp(Math.round(Number(c.startSec) || 0), 0, 86400),
      durationSec: clamp(Math.round(Number(c.durationSec) || 0), 0, 86400),
      note: String(c.note || ''), critical: c.critical === true,
      dependsOn: Array.isArray(c.dependsOn) ? c.dependsOn.filter(d => typeof d === 'string' && d !== c.id) : [],
      status: ['planned', 'active', 'done'].includes(c.status) ? c.status : 'planned'
    }));
  const cueIds = new Set(obj.cues.map(c => c.id));
  for (const c of obj.cues) c.dependsOn = Array.from(new Set(c.dependsOn)).filter(id => cueIds.has(id));
  const relationIds = new Set(), relationPairs = new Set();
  if (obj.syncLinks !== undefined && !Array.isArray(obj.syncLinks)) throw new Error('同步连线数据必须是数组');
  const syncPairs = new Set();
  obj.syncLinks = (obj.syncLinks || []).map(edge => {
    if (!edge || typeof edge.id !== 'string' || !edge.id.trim() || relationIds.has(edge.id)) throw new Error('同步连线 ID 无效或重复');
    if (!cueIds.has(edge.from) || !cueIds.has(edge.to) || edge.from === edge.to || !['start','end'].includes(edge.mode)) throw new Error('同步连线端点或类型无效');
    const key = JSON.stringify([[edge.from,edge.to].sort(),edge.mode]);
    if (syncPairs.has(key)) throw new Error('同步关系已存在');
    syncPairs.add(key); relationIds.add(edge.id);
    return {id:edge.id,from:edge.from,to:edge.to,mode:edge.mode,label:String(edge.label || '')};
  });
  if (obj.relations !== undefined && !Array.isArray(obj.relations)) throw new Error('关联线数据必须是数组');
  obj.relations = (obj.relations || []).map(edge => {
    if (!edge || typeof edge.id !== 'string' || !edge.id.trim() || relationIds.has(edge.id)) throw new Error('关联线缺少有效 ID 或 ID 重复');
    if (!cueIds.has(edge.from) || !cueIds.has(edge.to) || edge.from === edge.to) throw new Error('关联线引用了不存在的动作或自身');
    if (!['top', 'bottom'].includes(edge.fromPort) || !['top', 'bottom'].includes(edge.toPort)) throw new Error('关联线仅支持上、下节点');
    const key = JSON.stringify([edge.from, edge.fromPort, edge.to, edge.toPort]);
    if (relationPairs.has(key)) throw new Error('关联线重复');
    relationIds.add(edge.id); relationPairs.add(key);
    return { id: edge.id, from: edge.from, to: edge.to, fromPort: edge.fromPort, toPort: edge.toPort, label: String(edge.label || '') };
  });
  if (obj.dependencyLabels !== undefined && !Array.isArray(obj.dependencyLabels)) throw new Error('依赖标注数据必须是数组');
  const labelKeys = new Set();
  obj.dependencyLabels = (obj.dependencyLabels || []).filter(edge => edge && obj.cues.some(cue => cue.id === edge.to && cue.dependsOn.includes(edge.from)))
    .map(edge => {
      const key = JSON.stringify([edge.from, edge.to]); if (labelKeys.has(key)) throw new Error('依赖标注重复'); labelKeys.add(key);
      return { from: edge.from, to: edge.to, label: String(edge.label || '') };
    }).filter(edge => edge.label.trim());
  obj.durationSec = Math.max(obj.durationSec, latestCueEnd(obj));
  dependencyOrder(obj);
  if (obj.syncLinks.length) timingComponents(obj);
  return obj;
}
function laneGroupName(project, lane) {
  return project.groups?.find(g => g.id === lane?.groupId)?.name || '未分组';
}
// One row layout drives the timeline, dependency lines, drag targets and SVG export.
function buildLaneLayout(project, collapsed = new Set(), laneHeight = ROW_HEIGHT, groupHeight = GROUP_HEIGHT) {
  const groups = [...(project.groups || [])];
  const groupIds = new Set(groups.map(g => g.id));
  const ungrouped = project.lanes.filter(l => !groupIds.has(l.groupId));
  if (ungrouped.length || !groups.length) groups.push({ id: '', name: '未分组' });
  const rows = [], laneY = new Map();
  let height = 0;
  for (const group of groups) {
    const lanes = group.id ? project.lanes.filter(l => l.groupId === group.id) : ungrouped;
    rows.push({ kind: 'group', group, lanes, y: height, height: groupHeight });
    height += groupHeight;
    if (collapsed.has(group.id)) continue;
    for (const lane of lanes) {
      rows.push({ kind: 'lane', lane, y: height, height: laneHeight });
      laneY.set(lane.id, height); height += laneHeight;
    }
  }
  return { rows, laneY, height };
}
function laneAtY(layout, y) {
  return layout.rows.find(r => r.kind === 'lane' && y >= r.y && y < r.y + r.height);
}
function createsCycle(project, predecessorId, targetId) {
  if (predecessorId === targetId) return true;
  const byId = new Map(project.cues.map(c => [c.id, c]));
  const stack = [predecessorId], seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of byId.get(id)?.dependsOn || []) stack.push(parent);
  }
  return false;
}
function dependencyOrder(project) {
  const byId = new Map(project.cues.map(c => [c.id, c])), pending = new Map(), children = new Map();
  for (const cue of project.cues) {
    pending.set(cue.id, cue.dependsOn.length);
    for (const id of cue.dependsOn) {
      if (!byId.has(id)) throw new Error('前置动作不存在');
      if (!children.has(id)) children.set(id, []);
      children.get(id).push(cue.id);
    }
  }
  const order = project.cues.filter(c => !pending.get(c.id));
  for (let index = 0; index < order.length; index++) for (const id of children.get(order[index].id) || []) {
    pending.set(id, pending.get(id) - 1);
    if (!pending.get(id)) order.push(byId.get(id));
  }
  if (order.length !== project.cues.length) throw new Error('依赖关系会形成循环');
  return order;
}
function timingComponents(project) {
  const byId = new Map(project.cues.map(c => [c.id,c])), adjacent = new Map(project.cues.map(c => [c.id,[]]));
  for (const edge of project.syncLinks || []) {
    const a=byId.get(edge.from),b=byId.get(edge.to);if(!a || !b)throw new Error('同步连线动作不存在');
    const delta=edge.mode==='start'?0:a.durationSec-b.durationSec;
    adjacent.get(a.id).push([b.id,delta]);adjacent.get(b.id).push([a.id,-delta]);
  }
  const membership=new Map(),offset=new Map(),components=[];
  for(const cue of project.cues){
    if(membership.has(cue.id))continue;
    const members=[cue.id],index=components.length;membership.set(cue.id,index);offset.set(cue.id,0);
    for(let i=0;i<members.length;i++)for(const [next,delta] of adjacent.get(members[i])){
      const expected=offset.get(members[i])+delta;
      if(membership.has(next)){if(offset.get(next)!==expected)throw new Error('同时开始/结束关系相互冲突，请调整连线或持续时间');}
      else{membership.set(next,index);offset.set(next,expected);members.push(next);}
    }
    components.push(members);
  }
  return {components,membership,offset,byId};
}
function scheduleDependents(project, auto, anchorIds = []) {
  if ((project.syncLinks || []).length) {
    const {components,membership,offset,byId}=timingComponents(project),anchors=new Set(anchorIds);
    const lower=components.map(members=>Math.max(...members.map(id=>-offset.get(id))));
    const upper=components.map(members=>Math.min(...members.map(id=>86400-byId.get(id).durationSec-offset.get(id))));
    const bases=components.map((members,i)=>{const preferred=members.filter(id=>anchors.has(id));return Math.max(lower[i],...((preferred.length?preferred:members).map(id=>byId.get(id).startSec-offset.get(id))));});
    const edges=[];
    if(auto)for(const cue of project.cues)for(const parentId of cue.dependsOn){
      const from=membership.get(parentId),to=membership.get(cue.id),weight=offset.get(parentId)+byId.get(parentId).durationSec-offset.get(cue.id);
      if(from===to){if(weight>0)throw new Error('同步关系与前后依赖冲突，无法同时满足');}
      else edges.push([from,to,weight]);
    }
    for(let pass=0;pass<components.length;pass++){
      let changed=false;
      for(const [from,to,weight] of edges)if(bases[to]<bases[from]+weight){bases[to]=bases[from]+weight;changed=true;}
      if(!changed)break;
      if(pass===components.length-1)throw new Error('同步关系与依赖形成无法满足的约束循环');
    }
    if(bases.some((base,i)=>base>upper[i]))throw new Error('同步或依赖调整会超过 24 小时');
    for(const cue of project.cues)cue.startSec=bases[membership.get(cue.id)]+offset.get(cue.id);
    return;
  }
  if (!auto) return;
  const byId = new Map(project.cues.map(c => [c.id, c])), starts = new Map();
  for (const cue of dependencyOrder(project)) {
    let start = cue.startSec;
    for (const id of cue.dependsOn) start = Math.max(start, starts.get(id) + byId.get(id).durationSec);
    if (start + cue.durationSec > 86400) throw new Error('依赖顺延会超过 24 小时，请缩短动作或调整前置时间');
    starts.set(cue.id, start);
  }
  for (const cue of project.cues) cue.startSec = starts.get(cue.id);
}
function hasConflict(project, cue) {
  if (!cue.durationSec) return false;
  return project.cues.some(c => c.id !== cue.id && c.laneId === cue.laneId && c.durationSec && c.startSec < cue.startSec + cue.durationSec && cue.startSec < c.startSec + c.durationSec);
}
const PORTS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const CONNECTION_KINDS=['dependency','relation','sync-start','sync-end'];
function connectionIntent(from, fromPort, to, toPort) {
  if (!from || !to || from === to) return null;
  if (fromPort === 'right' && toPort === 'left') return { kind: 'dependency', from, to, fromPort: 'right', toPort: 'left' };
  if (fromPort === 'left' && toPort === 'right') return { kind: 'dependency', from: to, to: from, fromPort: 'right', toPort: 'left' };
  if (fromPort === toPort && ['left','right'].includes(fromPort)) return {kind:fromPort==='left'?'sync-start':'sync-end',from,to,fromPort,toPort};
  if (['top', 'bottom'].includes(fromPort) && ['top', 'bottom'].includes(toPort)) return { kind: 'relation', from, to, fromPort, toPort };
  return null;
}
function projectConnections(project) {
  const labels = new Map((project.dependencyLabels || []).map(edge => [JSON.stringify([edge.from, edge.to]), edge.label]));
  return [...project.cues.flatMap(cue => cue.dependsOn.map(id => ({ id: 'dep:' + JSON.stringify([id, cue.id]), kind: 'dependency', from: id, to: cue.id, fromPort: 'right', toPort: 'left', label: labels.get(JSON.stringify([id, cue.id])) || '' }))),
    ...(project.relations || []).map(edge => ({ ...edge, kind: 'relation' })),
    ...(project.syncLinks || []).map(edge=>({...edge,kind:'sync-'+edge.mode,fromPort:edge.mode==='start'?'left':'right',toPort:edge.mode==='start'?'left':'right'}))];
}
function connectionName(kind) {return kind==='dependency'?'前后依赖':kind==='sync-start'?'同时开始':kind==='sync-end'?'同时结束':'关联 / 目标';}
function appendConnectionMarker(defs,id,kind,size=10) {
  const ns='http://www.w3.org/2000/svg',marker=document.createElementNS(ns,'marker'),path=document.createElementNS(ns,'path');
  for(const [key,value] of Object.entries({id,markerWidth:size,markerHeight:size,viewBox:'0 0 10 10',refX:9,refY:5,orient:'auto-start-reverse',markerUnits:'userSpaceOnUse'}))marker.setAttribute(key,value);
  path.setAttribute('d',kind.startsWith('sync-')?'M1,5 L5,1 L9,5 L5,9 Z':'M1,1 L9,5 L1,9 Z');
  path.setAttribute('fill',kind==='dependency'?'var(--cueflow-dependency-color)':kind==='relation'?'var(--cueflow-relation-color)':'var(--cueflow-sync-color)');marker.append(path);defs.append(marker);return id;
}
function connectionRects(project, layout, scale, cueHeight, cueTop, override = null) {
  const boxes = new Map();
  for (let cue of project.cues) {
    if (override instanceof Map && override.has(cue.id)) cue = { ...cue, ...override.get(cue.id) };
    else if (cue.id === override?.id) cue = { ...cue, ...override };
    if (!layout.laneY.has(cue.laneId)) continue;
    boxes.set(cue.id, { id: cue.id, x: cue.startSec * scale, y: layout.laneY.get(cue.laneId) + cueTop,
      w: Math.max(cue.durationSec ? 20 : 18, cue.durationSec * scale), h: cueHeight });
  }
  return boxes;
}
function cuesInMarquee(boxes, rect) {
  return [...boxes].filter(([, b]) => b.x < rect.right && b.x + b.w > rect.left && b.y < rect.bottom && b.y + b.h > rect.top).map(([id]) => id);
}
// Transform shared endpoints so internal gaps and dependency boundaries scale together.
function transformCueSelection(project, ids, kind, deltaSec, laneDelta = 0, laneOrder = [], autoSchedule = false) {
  const chosen = new Set(ids), cues = project.cues.filter(cue => chosen.has(cue.id));
  if (!cues.length || !Number.isFinite(deltaSec)) return [];
  const first = Math.min(...cues.map(c => c.startSec)), last = Math.max(...cues.map(c => c.startSec + c.durationSec));
  if (kind === 'move') {
    let minimum = -first;
    if (autoSchedule) {
      const byId = new Map(project.cues.map(c => [c.id, c]));
      for (const cue of cues) for (const parentId of cue.dependsOn) if (!chosen.has(parentId)) {
        const parent = byId.get(parentId); if (parent) minimum = Math.max(minimum, parent.startSec + parent.durationSec - cue.startSec);
      }
    }
    const delta = clamp(Math.round(deltaSec), Math.min(minimum, 86400 - last), 86400 - last);
    const indices = cues.map(c => laneOrder.indexOf(c.laneId));
    const shift = laneOrder.length && indices.every(i => i >= 0) ? clamp(Math.round(laneDelta), -Math.min(...indices), laneOrder.length - 1 - Math.max(...indices)) : 0;
    return cues.map(c => ({ ...c, startSec: c.startSec + delta, laneId: shift ? laneOrder[laneOrder.indexOf(c.laneId) + shift] : c.laneId }));
  }
  const span = last - first;
  if (!span || !['resize-left', 'resize-right'].includes(kind)) return cues.map(c => ({ ...c }));
  const minimumSpan = Math.max(1,...cues.filter(c => c.durationSec).map(c => Math.ceil(span/c.durationSec)));
  const newFirst = kind === 'resize-left' ? clamp(first + Math.round(deltaSec), 0, last - minimumSpan) : first;
  const newLast = kind === 'resize-right' ? clamp(last + Math.round(deltaSec), first + minimumSpan, 86400) : last;
  const map = sec => Math.round(newFirst + (sec - first) * (newLast - newFirst) / span);
  return cues.map(c => {
    let startSec = map(c.startSec), end = map(c.startSec + c.durationSec);
    if (c.durationSec && end === startSec) { if (end < newLast) end++; else startSec--; }
    return { ...c, startSec, durationSec: c.durationSec ? end - startSec : 0 };
  });
}
function portPoint(rect, port, offset = 6) {
  const v = PORTS[port];
  return { x: rect.x + (port === 'left' ? 0 : port === 'right' ? rect.w : rect.w / 2) + v[0] * offset,
    y: rect.y + (port === 'top' ? 0 : port === 'bottom' ? rect.h : rect.h / 2) + v[1] * offset };
}
function makeCueClipboard(project, ids, laneOrder = buildLaneLayout(project).rows.filter(r=>r.kind==='lane').map(r=>r.lane.id)) {
  const chosen=new Set(ids),cues=project.cues.filter(c=>chosen.has(c.id)).map(c=>({...deepCopy(c),dependsOn:c.dependsOn.filter(id=>chosen.has(id))}));
  if(!cues.length)return null;
  const internal=edge=>chosen.has(edge.from)&&chosen.has(edge.to);
  return {format:'cueflow.selection',clipboardVersion:1,sourceLaneOrder:[...laneOrder],cues,
    relations:deepCopy((project.relations || []).filter(internal)),syncLinks:deepCopy((project.syncLinks || []).filter(internal)),dependencyLabels:deepCopy((project.dependencyLabels || []).filter(internal))};
}
function parseCueClipboard(value) {
  if(typeof value==='string'){
    if(value.length>MAX_PROJECT_FILE_BYTES)throw new Error('复制的动作数据超过 5 MB');
    try{value=JSON.parse(value);}catch{return null;}
  }
  if(value?.format!=='cueflow.selection')return null;
  if(value.clipboardVersion!==1 || !Array.isArray(value.sourceLaneOrder) || !Array.isArray(value.cues) || !value.cues.length)throw new Error('动作剪贴板格式无效');
  const p={version:5,name:'动作剪贴板',durationSec:60,groups:[],lanes:value.sourceLaneOrder.map(id=>({id,name:'源泳道',groupId:''})),
    cues:deepCopy(value.cues),relations:deepCopy(value.relations || []),syncLinks:deepCopy(value.syncLinks || []),dependencyLabels:deepCopy(value.dependencyLabels || [])};
  checkPortableLimits(p);validateProject(p);
  return {format:'cueflow.selection',clipboardVersion:1,sourceLaneOrder:[...value.sourceLaneOrder],cues:p.cues,relations:p.relations,syncLinks:p.syncLinks,dependencyLabels:p.dependencyLabels};
}
function pastedCueProject(project, fragment, position, laneOrder) {
  const clip=parseCueClipboard(fragment);if(!clip)throw new Error('剪贴板中没有 CueFlow 动作');
  if(!position || !Number.isFinite(position.seconds) || !laneOrder.includes(position.laneId))throw new Error('请把鼠标移到目标泳道后再粘贴');
  const sourceIndices=clip.cues.map(c=>clip.sourceLaneOrder.indexOf(c.laneId)),firstLane=Math.min(...sourceIndices),laneSpan=Math.max(...sourceIndices)-firstLane;
  if(laneSpan>=laneOrder.length)throw new Error('目标泳道不足，请先增加泳道后再粘贴');
  const requestedLane=laneOrder.indexOf(position.laneId),baseLane=Math.min(requestedLane,laneOrder.length-1-laneSpan);
  const first=Math.min(...clip.cues.map(c=>c.startSec)),last=Math.max(...clip.cues.map(c=>c.startSec+c.durationSec));
  const start=clamp(Math.round(position.seconds),0,86400-(last-first)),delta=start-first;
  const ids=new Map(clip.cues.map(c=>[c.id,uid('cue')]));
  const cues=clip.cues.map(c=>({...c,id:ids.get(c.id),laneId:laneOrder[baseLane+clip.sourceLaneOrder.indexOf(c.laneId)-firstLane],startSec:c.startSec+delta,dependsOn:c.dependsOn.map(id=>ids.get(id))}));
  const remap=(edge,prefix)=>({...edge,id:uid(prefix),from:ids.get(edge.from),to:ids.get(edge.to)});
  const candidate=deepCopy(project);candidate.cues.push(...cues);candidate.relations=[...(candidate.relations || []),...clip.relations.map(e=>remap(e,'relation'))];
  candidate.syncLinks=[...(candidate.syncLinks || []),...clip.syncLinks.map(e=>remap(e,'sync'))];
  candidate.dependencyLabels=[...(candidate.dependencyLabels || []),...clip.dependencyLabels.map(e=>({from:ids.get(e.from),to:ids.get(e.to),label:e.label}))];
  validateProject(candidate);candidate.durationSec=Math.max(candidate.durationSec,latestCueEnd(candidate));
  return {project:candidate,ids:cues.map(c=>c.id),clamped:baseLane!==requestedLane || start!==Math.round(position.seconds)};
}
function segmentHitsRect(a, b, rect, pad = 5) {
  const left = rect.x - pad, right = rect.x + rect.w + pad, top = rect.y - pad, bottom = rect.y + rect.h + pad;
  if (a.x === b.x) return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
}
function compactPoints(points) {
  const out = [];
  for (const p of points) {
    if (out.length && p.x === out.at(-1).x && p.y === out.at(-1).y) continue;
    while (out.length > 1) {
      const a = out.at(-2), b = out.at(-1);
      if ((a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) >= 0) ||
          (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) >= 0)) out.pop(); else break;
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}
function roundedPath(points) {
  const p = compactPoints(points); if (!p.length) return '';
  let d = 'M' + p[0].x + ',' + p[0].y;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const ab = Math.abs(a.x - b.x) + Math.abs(a.y - b.y), bc = Math.abs(c.x - b.x) + Math.abs(c.y - b.y), r = Math.min(5, ab / 2, bc / 2);
    const pre = { x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r };
    const post = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    d += ' L' + pre.x + ',' + pre.y + ' Q' + b.x + ',' + b.y + ' ' + post.x + ',' + post.y;
  }
  if (p.length > 1) d += ' L' + p.at(-1).x + ',' + p.at(-1).y;
  return d;
}
// Horizontal runs avoid cards. Vertical runs may pass underneath opaque action cards.
function routeConnection(edge, boxes, index = 0) {
  const from = boxes.get(edge.from), to = boxes.get(edge.to); if (!from || !to) return null;
  const facing = edge.fromPort==='right' && edge.toPort==='left';
  const gap = facing ? to.x-from.x-from.w : Infinity;
  const near = facing && gap>=0 && gap<30 && Math.abs(from.y-to.y)<2;
  const offset = near ? Math.min(6,gap/4) : 6;
  const start = portPoint(from, edge.fromPort,offset), end = portPoint(to, edge.toPort,offset);
  start.x=Math.max(0,start.x);end.x=Math.max(0,end.x);
  const spread = (index % 5) * 3, obstacles = [...boxes.values()];
  if(near && gap<1){
    const x=start.x,ys=[...new Set(obstacles.flatMap(r=>[r.y-12,r.y+r.h+12]))].filter(y=>y>=0);let best;
    for(const y of ys){
      const points=[start,{x,y},{x:x+12,y},{x:x+12,y:y+6},{x,y:y+6},end];let hits=0,underpasses=0;
      for(let i=1;i<points.length;i++)for(const rect of obstacles)if(segmentHitsRect(points[i-1],points[i],rect,3)){if(points[i-1].y===points[i].y)hits++;else underpasses++;}
      const cost=hits*100000+Math.abs(y-start.y)*2+underpasses*2;
      if(!best || cost<best.cost)best={points,y,cost,hits,underpasses};
    }
    return {points:best.points,d:roundedPath(best.points),hits:best.hits,underpasses:best.underpasses,near:true,arrowSize:4,arrowGuide:[{x:x+2,y:best.y},{x:x+10,y:best.y}]};
  }
  const lead = (point, port, id) => {
    const vector = PORTS[port]; let distance = near ? Math.min(6,gap/4) : 10 + spread;
    for (const rect of obstacles) {
      if (rect.id === id) continue;
      if(point.x>rect.x-3 && point.x<rect.x+rect.w+3 && point.y>rect.y-3 && point.y<rect.y+rect.h+3){distance=0;continue;}
      const horizontal = vector[0] !== 0;
      if (horizontal ? point.y <= rect.y - 5 || point.y >= rect.y + rect.h + 5 : point.x <= rect.x - 5 || point.x >= rect.x + rect.w + 5) continue;
      const gap = horizontal ? vector[0] > 0 ? rect.x - 5 - point.x : point.x - rect.x - rect.w - 5 : vector[1] > 0 ? rect.y - 5 - point.y : point.y - rect.y - rect.h - 5;
      if (gap >= 0) distance = Math.min(distance, Math.max(0, gap - 1));
    }
    return { x: Math.max(0,point.x + vector[0] * distance), y: point.y + vector[1] * distance };
  };
  const a = lead(start, edge.fromPort, edge.from), b = lead(end, edge.toPort, edge.to);
  const ys = [...new Set([a.y, b.y, from.y - 10 - spread, from.y + from.h + 10 + spread, to.y - 10 - spread, to.y + to.h + 10 + spread,
    ...obstacles.flatMap(rect => [rect.y - 8, rect.y + rect.h + 8])])];
  const middle = (a.x + b.x) / 2;
  const candidatesX = [...new Set([a.x, b.x, middle + spread, Math.min(from.x, to.x) - 18 - spread, Math.max(from.x + from.w, to.x + to.w) + 18 + spread,
    ...obstacles.flatMap(rect => [rect.x - 12, rect.x + rect.w + 12])])].sort((x, y) => Math.abs(x - middle) - Math.abs(y - middle));
  const xs = [...new Set([...candidatesX.slice(0, 18), Math.max(...obstacles.map(rect => rect.x + rect.w)) + 20, -20])];
  const routes = [[a, { x: b.x, y: a.y }, b], [a, { x: a.x, y: b.y }, b]];
  for (const y of ys) routes.push([a, { x: a.x, y }, { x: b.x, y }, b]);
  for (const x of xs) {
    routes.push([a, { x, y: a.y }, { x, y: b.y }, b]);
    for (const y1 of [from.y - 10 - spread, from.y + from.h + 10 + spread]) for (const y2 of [to.y - 10 - spread, to.y + to.h + 10 + spread])
      routes.push([a, { x: a.x, y: y1 }, { x, y: y1 }, { x, y: y2 }, { x: b.x, y: y2 }, b]);
  }
  const simpleCount = routes.length;
  for (const y of ys) for (const x1 of [a.x, from.x - 12, from.x + from.w + 12]) for (const x2 of [b.x, to.x - 12, to.x + to.w + 12])
    routes.push([a, { x: x1, y: a.y }, { x: x1, y }, { x: x2, y }, { x: x2, y: b.y }, b]);
  let best = null, bestHits = Infinity, bestCost = Infinity, bestUnderpasses = 0;
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
    if (routeIndex === simpleCount && bestHits === 0) break;
    const core = routes[routeIndex], points = compactPoints([start, ...core, end]); let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    let cost = length + points.length * 5 + points.filter(p => p.x < 0 || p.y < 0).length * 200;
    if (bestHits === 0 && cost >= bestCost) continue;
    let hits = 0, underpasses = 0;
    for (let i = 1; i < points.length && hits <= bestHits; i++) for (const rect of obstacles) {
      if ((i === 1 && rect.id === edge.from) || (i === points.length - 1 && rect.id === edge.to)) continue;
      if (segmentHitsRect(points[i - 1], points[i], rect,3)) {
        if(points[i-1].y===points[i].y){hits++;if(hits>bestHits)break;}
        else underpasses++;
      }
    }
    cost+=underpasses*4;
    if (hits < bestHits || (hits === bestHits && cost < bestCost)) { best = points; bestHits = hits; bestCost = cost; bestUnderpasses=underpasses; }
  }
  return { points: compactPoints(best), d: roundedPath(best), hits: bestHits, underpasses:bestUnderpasses, near, arrowSize:near?Math.max(3,Math.min(9,gap*.45)):9 };
}
function findAlignmentGuides(project, id, startSec, durationSec, scale, visibleLaneIds, kind = 'move') {
  const moving = kind === 'resize-left' ? [['start', startSec]] : kind === 'resize-right' ? [['end', startSec + durationSec]] : [['start', startSec], ['end', startSec + durationSec]];
  const tolerance = Math.min(3, 6 / scale), matches = [];
  for (const [edge, seconds] of moving) {
    let best = null;
    for (const cue of project.cues) {
      if (cue.id === id || !visibleLaneIds.has(cue.laneId)) continue;
      for (const [targetEdge, targetSec] of [['start', cue.startSec], ['end', cue.startSec + cue.durationSec]]) {
        const distance = Math.abs(targetSec - seconds);
        if (distance <= tolerance && (!best || distance < best.distance)) best = { edge, sec: targetSec, targetId: cue.id, targetEdge, distance };
      }
    }
    if (best && !matches.some(item => item.sec === best.sec)) matches.push(best);
  }
  return matches;
}
function safeMarkdown(obj) {
  return `# ${obj.name}\n\n> CueFlow 项目文件。可以在代码块外编写说明；代码块内是可编辑的调度数据，请保留 cueflow 标记和有效 JSON。\n\n\`\`\`cueflow\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\n## 导演备注\n\n`;
}
const PROJECT_FILE_FORMAT = 'cueflow.project';
const MAX_PROJECT_FILE_BYTES = 5 * 1024 * 1024;
function inspectProject(project) {
  const byId = new Map(project.cues.map(c => [c.id,c]));
  return {
    conflicts: project.cues.filter(c => hasConflict(project,c)).length,
    dependencyViolations: project.cues.filter(c => c.dependsOn.some(id => c.startSec < byId.get(id).startSec + byId.get(id).durationSec)).length,
    critical: project.cues.filter(c => c.critical).length,
    syncViolations:(project.syncLinks || []).filter(edge=>{const a=byId.get(edge.from),b=byId.get(edge.to);return edge.mode==='start'?a.startSec!==b.startSec:a.startSec+a.durationSec!==b.startSec+b.durationSec;}).length
  };
}
function summarizeProjectChanges(before, after) {
  const old = new Map((before?.cues || []).map(c => [c.id,c])), next = new Map(after.cues.map(c => [c.id,c]));
  const fields = ['name','laneId','startSec','durationSec','status','note','critical','dependsOn'];
  const changed = after.cues.filter(c => old.has(c.id) && fields.some(k => JSON.stringify(c[k] ?? null) !== JSON.stringify(old.get(c.id)[k] ?? null))).length;
  const timing = after.cues.filter(c => old.has(c.id) && (c.startSec !== old.get(c.id).startSec || c.durationSec !== old.get(c.id).durationSec)).length;
  const deps = p => new Set((p?.cues || []).flatMap(c => c.dependsOn.map(id => JSON.stringify([id,c.id]))));
  const previousDeps=deps(before), nextDeps=deps(after);
  const differences = (previous=[], current=[]) => {
    const oldItems=new Map(previous.map(item=>[item.id,JSON.stringify(item)])),newItems=new Map(current.map(item=>[item.id,JSON.stringify(item)]));
    return {added:[...newItems.keys()].filter(id=>!oldItems.has(id)).length,removed:[...oldItems.keys()].filter(id=>!newItems.has(id)).length,changed:[...newItems.keys()].filter(id=>oldItems.has(id)&&oldItems.get(id)!==newItems.get(id)).length};
  };
  const groups=differences(before?.groups,after.groups),lanes=differences(before?.lanes,after.lanes),relations=differences(before?.relations,after.relations);
  return {added:after.cues.filter(c=>!old.has(c.id)).length,removed:[...old.keys()].filter(id=>!next.has(id)).length,changed,timing,
    dependenciesAdded:[...nextDeps].filter(id=>!previousDeps.has(id)).length,dependenciesRemoved:[...previousDeps].filter(id=>!nextDeps.has(id)).length,
    criticalRemoved:[...old.values()].filter(c=>c.critical && !next.get(c.id)?.critical).length,
    groupsChanged:groups.added+groups.removed+groups.changed,lanesChanged:lanes.added+lanes.removed+lanes.changed,relations,syncLinks:differences(before?.syncLinks,after.syncLinks),
    dependencyLabelsChanged:JSON.stringify(before?.dependencyLabels || [])!==JSON.stringify(after.dependencyLabels || []),
    beforeDuration:before?.durationSec || 0,afterDuration:after.durationSec,...inspectProject(after)};
}
function checkPortableLimits(data) {
  if ((data.cues?.length || 0) > 3000 || (data.lanes?.length || 0) > 500 || (data.relations?.length || 0)+(data.syncLinks?.length || 0)>10000) throw new Error('项目文件最多支持 3000 个动作、500 条泳道和 10000 条关联/同步线');
}
function parseProjectBundle(value) {
  if (typeof value !== 'string') throw new Error('请选择 UTF-8 JSON 或 Markdown 项目文件');
  const raw = value.replace(/^\uFEFF/,'');let text = raw.trim();
  let markdownNotes = null, optimizationNotes = [];
  if (new TextEncoder().encode(raw).byteLength > MAX_PROJECT_FILE_BYTES) throw new Error('项目文件不能超过 5 MB');
  if (!text) throw new Error('项目文件为空');
  if (!text.startsWith('{')) {
    const blocks = [...raw.matchAll(/```cueflow\s*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length > 1) throw new Error('文件包含多个 cueflow 数据块，请只保留一个项目');
    if (blocks.length === 1) {
      markdownNotes = {before:raw.slice(0,blocks[0].index),after:raw.slice(blocks[0].index+blocks[0][0].length)};
      text = blocks[0][1];
    }
    else {
      const fenced = text.match(/^```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
      if (fenced) text = fenced[1]; else throw new Error('未找到完整项目 JSON 或 cueflow 数据块；CSV 不能恢复完整项目');
    }
  }
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error('项目 JSON 格式错误：' + err.message.slice(0,160)); }
  if (data?.format !== undefined) {
    if (data.format !== PROJECT_FILE_FORMAT || data.formatVersion !== 1) throw new Error('不支持该项目文件格式或版本');
    markdownNotes = data.markdownNotes ?? markdownNotes;
    optimizationNotes = Array.isArray(data.optimizationNotes) ? data.optimizationNotes.filter(note=>typeof note==='string') : typeof data.optimizationNotes === 'string' ? [data.optimizationNotes] : [];
    data = data.project;
  }
  if (markdownNotes !== null && (typeof markdownNotes !== 'object' || typeof markdownNotes.before !== 'string' || typeof markdownNotes.after !== 'string' || /```cueflow\s*\r?\n/.test(markdownNotes.before+markdownNotes.after))) throw new Error('项目备注格式错误，或备注中含有额外 cueflow 数据块');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('项目文件缺少有效 project 数据');
  checkPortableLimits(data);
  if(data.groups!==undefined){
    if(!Array.isArray(data.groups))throw new Error('groups 必须是分组数组');
    const ids=new Set();for(const group of data.groups){if(!group || typeof group.id!=='string' || !group.id.trim() || ids.has(group.id))throw new Error('分组 ID 无效或重复');ids.add(group.id);}
    for(const lane of Array.isArray(data.lanes)?data.lanes:[])if(lane?.groupId && !ids.has(lane.groupId))throw new Error('泳道引用了不存在的分组');
  }
  for(const cue of Array.isArray(data.cues)?data.cues:[]){
    if(cue?.critical!==undefined && typeof cue.critical!=='boolean')throw new Error('critical 关键标记必须是 true 或 false');
    if(cue?.status!==undefined && !['planned','active','done'].includes(cue.status))throw new Error('status 只能是 planned、active 或 done');
  }
  return {project:validateProject(data),markdownNotes,optimizationNotes};
}
function parseProjectFile(value) { return parseProjectBundle(value).project; }
function importedProjectMarkdown(project, notes = null) {
  if (!notes) return safeMarkdown(project);
  const before = notes.before && !notes.before.endsWith('\n') ? notes.before+'\n' : notes.before;
  const after = notes.after && !notes.after.startsWith('\n') ? '\n'+notes.after : notes.after;
  return before+'```cueflow\n'+JSON.stringify(project,null,2)+'\n```'+(after || '\n');
}
function buildProjectFile(project, format = 'json', goal = '', markdownNotes = null) {
  checkPortableLimits(project);
  const data = validateProject(deepCopy(project));
  const guide = {
    goal: String(goal || '在保留全部动作、关键标记和依赖关系的前提下，减少同泳道冲突并优化总时长。').trim(),
    rules: [
      '所有时间单位为整数秒，使用相对时间；总时长至少 60 秒，所有动作结束不超过 86400 秒。',
      '保持动作、泳道、分组和连线的 ID；除非用户明确要求，不删除动作、不取消 critical 关键标记、不更改 dependsOn 依赖。',
      'dependsOn 为前置动作 ID 数组，语义为前置结束后本动作开始；不得形成循环。',
      'relations 仅表示关联/目标，fromPort/toPort 为 top 或 bottom；这些箭头不参与排期。',
      'syncLinks 为同步约束：mode=start 时两动作开始时间相同，mode=end 时结束时间相同；保持这些约束及 ID。',
      'critical=true 为关键动作，优先保留并说明调整理由；durationSec=0 为里程碑，保持零时长。',
      '同 laneId 的非零动作尽量不重叠；无法消除的冲突需明确说明，不得虚构资源。',
      '保留 name、note、status、groups、lanes、relations、syncLinks、dependencyLabels 等完整数据；durationSec 应覆盖所有动作。',
      'critical 必须为 true/false 布尔值，status 只能是 planned、active 或 done；不要翻译字段名或 ID。',
      '只修改 project 内的项目数据；返回完整文件，并在 optimizationNotes 数组用中文说明修改、收益及未解决问题。'
    ],
    fields: {projectVersion:5,startSec:'相对开始秒数',durationSec:'持续秒数；项目顶层为总时长',laneId:'执行人员/设备泳道 ID',groupId:'泳道分组 ID',critical:'关键动作布尔值',dependsOn:'前置动作 ID 数组',relations:'不参与排期的关联箭头',syncLinks:'同时开始/同时结束的同步约束',dependencyLabels:'依赖箭头文字标注'},
    returnFormat:'返回同结构完整 JSON，或仅包含一个 cueflow 数据块的 Markdown；不要只返回 CSV、片段或修改建议。'
  };
  if (format === 'json') return JSON.stringify({format:PROJECT_FILE_FORMAT,formatVersion:1,exportedAt:new Date().toISOString(),aiGuide:guide,project:data,markdownNotes,optimizationNotes:[]},null,2)+'\n';
  if (format !== 'markdown') throw new Error('不支持的项目导出格式');
  const human = value => String(value).replace(/\r?\n/g,' ').replace(/`/g,'ˋ').replace(/\|/g,'\\|');
  const lanes = new Map(data.lanes.map(l=>[l.id,l.name])),names=new Map(data.cues.map(c=>[c.id,c.name]));
  const table = ['| 动作 | 人员/设备 | 开始 | 持续 | 关键 | 前置动作 |','|---|---|---|---|---|---|',...data.cues.map(c=>'| '+[c.name,lanes.get(c.laneId),fmtTime(c.startSec),fmtTime(c.durationSec),c.critical?'★':'',c.dependsOn.map(id=>names.get(id)).join('、')].map(human).join(' | ')+' |')].join('\n');
  return '# '+human(data.name)+' · AI 优化项目\n\n## 优化目标\n\n'+human(guide.goal)+'\n\n## 约束与返回要求\n\n'+guide.rules.map(rule=>'- '+rule).join('\n')+'\n\n'+guide.returnFormat+'\n\n## 排程概览\n\n'+table+'\n\n## 完整项目数据\n\n```cueflow\n'+JSON.stringify(data,null,2)+'\n```\n\n## 优化说明\n\n请 AI 在此说明调整结果和仍需人工确认的问题。\n'+(markdownNotes ? '\n## 原项目正文与备注\n\n'+markdownNotes.before+'\n'+markdownNotes.after : '');
}
function btn(parent, title, action, cls = '') {
  const el = parent.createEl('button', { text: title, cls: `cueflow-btn ${cls}` });
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}
function select(parent, choices, current, cb, title = '') {
  const el = parent.createEl('select', { cls: 'cueflow-select', attr: { 'aria-label': title || '选择' } });
  for (const [val, label] of choices) {
    const option = el.createEl('option', { text: String(label) });
    option.value = String(val);
    if (String(val) === String(current)) option.selected = true;
  }
  el.addEventListener('change', () => cb(el.value));
  return el;
}

class ProjectExportModal extends Modal {
  constructor(view) { super(view.app); this.view=view; this.project=view.project; }
  onOpen() {
    const root=this.contentEl;root.empty();root.addClass('cueflow-modal');root.createEl('h3',{text:'导出项目 / 交给 AI 优化'});
    root.createEl('p',{text:'导出完整动作、泳道、分组、依赖、关联、关键标记和项目备注。可将文件交给 AI，修改后再通过「导入项目」预览并生成新项目。'});
    let format='json', goal='在保留全部动作、关键标记和依赖关系的前提下，减少同泳道冲突并优化总时长。';
    new Setting(root).setName('文件格式').addDropdown(d=>d.addOption('json','完整 AI 项目（JSON，推荐）').addOption('markdown','AI 优化文档（Markdown）').setValue(format).onChange(v=>{format=v;}));
    new Setting(root).setName('优化目标').setDesc('说明需要优化的目标或必须保留的约束，随文件交给 AI。').addTextArea(t=>{t.setValue(goal).onChange(v=>{goal=v;});t.inputEl.rows=4;this.goalInput=t.inputEl;});
    root.createEl('p',{cls:'cueflow-muted',text:'AI 优化由你使用的 AI 工具完成；导出文件保存在当前知识库中。'});
    new Setting(root).addButton(b=>b.setButtonText('导出文件').setCta().onClick(async()=>{b.setDisabled(true);if(await this.view.exportProjectFile(format,this.goalInput.value,this.project))this.close();else b.setDisabled(false);})).addButton(b=>b.setButtonText('取消').onClick(()=>this.close()));
  }
}
class ProjectImportModal extends Modal {
  constructor(view,bundle,filename) { super(view.app);Object.assign(this,{view,bundle,filename,comparison:deepCopy(view.project),autoSchedule:!!view.autoSchedule}); }
  onOpen() {
    const root=this.contentEl;root.empty();root.addClass('cueflow-modal');root.createEl('h3',{text:'导入项目预览'});
    root.createEl('p',{text:this.filename+' · 导入后保存为新项目，保留当前项目。'});
    new Setting(root).setName('新项目名称').addText(t=>{t.setValue(this.bundle.project.name+'（导入）');this.nameInput=t.inputEl;});
    new Setting(root).setName('按依赖自动顺延').setDesc('按前置关系推后冲突动作，关闭则保留前后依赖的原始时间；同时开始/结束的同步关系始终对齐。').addToggle(t=>t.setValue(this.autoSchedule).onChange(v=>{this.autoSchedule=v;this.updatePreview();}));
    this.preview=root.createDiv({cls:'cueflow-import-preview'});
    if(this.bundle.optimizationNotes.length){root.createEl('h4',{text:'AI 优化说明'});const list=root.createEl('ul');for(const note of this.bundle.optimizationNotes.slice(0,20))list.createEl('li',{text:note.slice(0,3000)});}
    new Setting(root).addButton(b=>{this.importButton=b;b.setButtonText('保存为新项目').setCta().onClick(async()=>{const name=this.nameInput.value.trim();if(!name)return new Notice('项目名称不能为空');if(!this.candidate)return; b.setDisabled(true);if(await this.view.importProject(this.candidate,name,this.bundle.markdownNotes,this.bundle.optimizationNotes))this.close();else b.setDisabled(false);});}).addButton(b=>b.setButtonText('取消').onClick(()=>this.close()));
    this.updatePreview();
  }
  updatePreview() {
    this.preview.empty();this.candidate=null;
    try {
      const candidate=validateProject(deepCopy(this.bundle.project));scheduleDependents(candidate,this.autoSchedule);candidate.durationSec=Math.max(candidate.durationSec,latestCueEnd(candidate));
      this.candidate=candidate;const s=summarizeProjectChanges(this.comparison,candidate);
      this.preview.createEl('p',{text:`${candidate.groups.length} 个分组 · ${candidate.lanes.length} 条泳道 · ${candidate.cues.length} 个动作 · ${s.critical} 个关键动作 · 总时长 ${fmtTime(candidate.durationSec)}`});
      this.preview.createEl('p',{text:`相比当前项目：新增 ${s.added}、移除 ${s.removed}、修改 ${s.changed} 个动作，其中 ${s.timing} 个调整了时间；新增 ${s.dependenciesAdded}、移除 ${s.dependenciesRemoved} 条依赖。`});
      this.preview.createEl('p',{text:`总时长 ${fmtTime(s.beforeDuration)} → ${fmtTime(s.afterDuration)}；分组调整 ${s.groupsChanged}、泳道调整 ${s.lanesChanged}；关联新增 ${s.relations.added}、移除 ${s.relations.removed}、修改 ${s.relations.changed}。${s.dependencyLabelsChanged?'依赖标注也有变化。':''}`});
      this.preview.createEl('p',{text:`同步关系：新增 ${s.syncLinks.added}、移除 ${s.syncLinks.removed}、修改 ${s.syncLinks.changed}。`});
      if(s.criticalRemoved)this.preview.createEl('p',{cls:'cueflow-import-warning',text:`有 ${s.criticalRemoved} 个原关键动作被移除或取消关键标记，请核对 AI 修改。`});
      if(s.conflicts || s.dependencyViolations)this.preview.createEl('p',{cls:'cueflow-import-warning',text:`需复核：${s.conflicts} 个动作有同泳道时间重叠，${s.dependencyViolations} 个动作早于前置动作结束。`});
      else this.preview.createEl('p',{text:'未发现同泳道重叠或前置时间冲突。'});
      this.importButton?.setDisabled(false);
    }catch(err){this.preview.createEl('p',{cls:'cueflow-import-warning',text:err.message});this.importButton?.setDisabled(true);}
  }
}
class ProjectPasteModal extends Modal {
  constructor(view){super(view.app);this.view=view;}
  onOpen(){
    const root=this.contentEl;root.empty();root.addClass('cueflow-modal');root.createEl('h3',{text:'粘贴 AI 返回的项目'});
    root.createEl('p',{text:'粘贴完整 JSON 或包含一个 cueflow 数据块的 Markdown，下一步预览导入变化。'});
    const input=root.createEl('textarea',{cls:'cueflow-project-paste',attr:{'aria-label':'完整项目内容',placeholder:'粘贴完整项目 JSON 或 Markdown'}});input.rows=14;
    new Setting(root).addButton(b=>b.setButtonText('预览导入').setCta().onClick(()=>{try{const bundle=parseProjectBundle(input.value);this.close();new ProjectImportModal(this.view,bundle,'粘贴的 AI 项目').open();}catch(err){new Notice('无法导入项目：'+err.message,10000);}})).addButton(b=>b.setButtonText('取消').onClick(()=>this.close()));
  }
}
class StringModal extends Modal {
  constructor(app, title, label, initial, onSave, allowEmpty = false) { super(app); Object.assign(this, { titleText: title, label, initial, onSave, allowEmpty }); }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); contentEl.createEl('h3', { text: this.titleText });
    const setting = new Setting(contentEl).setName(this.label).addText(t => t.setValue(this.initial));
    if (this.allowEmpty) setting.setDesc('留空可以清除连线文字。');
    const input = setting.controlEl.querySelector('input');
    const save = () => {
      const value = input.value.trim();
      if (!value && !this.allowEmpty) { input.focus(); return new Notice('内容不能为空'); }
      this.close(); this.onSave(value);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); } });
    new Setting(contentEl).addButton(b => b.setButtonText('确定').setCta().onClick(save)).addButton(b => b.setButtonText('取消').onClick(() => this.close()));
    window.requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.select(); } });
  }
  onClose() { this.contentEl.empty(); }
}

class LaneModal extends Modal {
  constructor(view, lane = null, groupId = null) {
    super(view.app); this.view = view; this.originalId = lane?.id;
    this.draft = lane ? deepCopy(lane) : { id: uid('lane'), name: '', color: COLORS[view.project.lanes.length % COLORS.length],
      groupId: groupId ?? view.project.groups[0]?.id ?? '' };
    this.project = view.project;
  }
  onOpen() {
    const { contentEl } = this, d = this.draft;
    contentEl.empty(); contentEl.addClass('cueflow-modal');
    contentEl.createEl('h3', { text: this.originalId ? '编辑泳道' : '新建泳道' });
    let input, dropdown;
    new Setting(contentEl).setName('泳道名称').setDesc('填写执行人员或设备名称。')
      .addText(t => { input = t.inputEl; t.setPlaceholder('例如：飞手 A、无人机 1').setValue(d.name); });
    new Setting(contentEl).setName('所属分组').setDesc('可通过时间轴顶部的「+ 分组」创建自定义分组。')
      .addDropdown(dd => {
        dropdown = dd.selectEl;
        for (const group of this.project.groups) dd.addOption(group.id, group.name);
        dd.addOption('', '未分组').setValue(d.groupId);
      });
    const colorSetting = new Setting(contentEl).setName('泳道颜色');
    const color = colorSetting.controlEl.createEl('input', { type: 'color', attr: { 'aria-label': '泳道颜色' } });
    color.value = d.color;
    const save = () => {
      d.name = input.value.trim(); d.groupId = dropdown.value; d.color = color.value;
      if (!d.name) { input.focus(); return new Notice('请填写泳道名称'); }
      if (this.view.project !== this.project) return new Notice('项目已切换，请在当前项目重新创建泳道');
      this.view.saveLane(d); this.close();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); }
    });
    new Setting(contentEl).addButton(b => b.setButtonText(this.originalId ? '保存泳道' : '创建泳道').setCta().onClick(save))
      .addButton(b => b.setButtonText('取消').onClick(() => this.close()));
    window.requestAnimationFrame(() => { if (input.isConnected) { input.focus(); if (this.originalId) input.select(); } });
  }
  onClose() { this.contentEl.empty(); }
}

class CueModal extends Modal {
  constructor(view, original) { super(view.app); this.view = view; this.original = original; this.draft = deepCopy(original); }
  onOpen() {
    const { contentEl } = this, view = this.view, d = this.draft, project = view.project;
    contentEl.empty(); contentEl.addClass('cueflow-modal'); contentEl.createEl('h3', { text: view.project.cues.some(c => c.id === d.id) ? '编辑调度动作' : '添加调度动作' });
    const fields = {}, dependencies = new Map();
    new Setting(contentEl).setName('动作名称').addText(t => { fields.name = t.inputEl; t.setPlaceholder('如：四机区域搜索').setValue(d.name); });
    new Setting(contentEl).setName('执行角色 / 设备').addDropdown(dd => {
      fields.lane = dd.selectEl;
      for (const row of buildLaneLayout(project).rows) if (row.kind === 'lane') dd.addOption(row.lane.id, laneGroupName(project, row.lane) + ' / ' + row.lane.name);
      dd.setValue(d.laneId);
    });
    new Setting(contentEl).setName('开始时间（T+分:秒）').setDesc('例如 03:15 或 00:03:15')
      .addText(t => { fields.start = t.inputEl; t.setValue(fmtTime(d.startSec)); });
    new Setting(contentEl).setName('持续时间（分:秒）').setDesc('00:00 表示里程碑')
      .addText(t => { fields.duration = t.inputEl; t.setValue(fmtTime(d.durationSec)); });
    new Setting(contentEl).setName('执行状态').addDropdown(dd => { fields.status = dd.selectEl;
      dd.addOption('planned', '待执行').addOption('active', '进行中').addOption('done', '已完成').setValue(d.status); });
    new Setting(contentEl).setName('关键动作').setDesc('显示星标，便于识别需要重点关注的动作。').addToggle(t => { fields.critical = t.toggleEl; t.setValue(!!d.critical); t.onChange(value => { d.critical = value; }); });
    new Setting(contentEl).setName('操作备注').addTextArea(t => { fields.note = t.inputEl;
      t.setPlaceholder('动作、口令、设备、注意事项等').setValue(d.note); t.inputEl.rows = 4; });
    contentEl.createEl('h4', { text: '前置动作（可多选，结束后才允许本任务开始）' });
    const container = contentEl.createDiv({ cls: 'cueflow-dependencies' });
    const candidates = project.cues.filter(c => c.id !== d.id);
    if (!candidates.length) container.createDiv({ text: '尚无其他动作，可保存后再添加依赖。', cls: 'cueflow-muted' });
    for (const other of candidates) {
      const item = container.createEl('label', { cls: 'cueflow-checkbox' });
      const checkbox = item.createEl('input', { type: 'checkbox' });
      checkbox.checked = d.dependsOn.includes(other.id);
      dependencies.set(other.id, checkbox);
      item.createSpan({ text: `${other.name} · T+${fmtTime(other.startSec)}` });
    }
    contentEl.createEl('h4', { text: '关联 / 目标（不参与排期）' });
    const relationInputs = new Map(), removedRelations = new Set();
    const related = (project.relations || []).filter(edge => edge.from === d.id || edge.to === d.id);
    if (!related.length) contentEl.createDiv({ cls: 'cueflow-muted', text: '拖动动作的上、下节点可建立关联或目标箭头。' });
    for (const edge of related) {
      const from = project.cues.find(cue => cue.id === edge.from), to = project.cues.find(cue => cue.id === edge.to);
      const row = new Setting(contentEl).setName(from.name + ' → ' + to.name).setDesc('仅展示关联，不影响依赖和时间。');
      row.addText(t => { relationInputs.set(edge.id, t.inputEl); t.setValue(edge.label).setPlaceholder('关联或目标说明'); })
        .addButton(b => b.setButtonText('移除关联').onClick(() => { removedRelations.add(edge.id); row.settingEl.remove(); }));
    }
    contentEl.createEl('h4',{text:'同时开始 / 同时结束'});
    const syncInputs=new Map(),removedSyncs=new Set();
    const synced=(project.syncLinks || []).filter(edge=>edge.from===d.id || edge.to===d.id);
    if(!synced.length)contentEl.createDiv({cls:'cueflow-muted',text:'拖动左节点至左节点同步开始，右节点至右节点同步结束。'});
    for(const edge of synced){
      const other=project.cues.find(c=>c.id===(edge.from===d.id?edge.to:edge.from));
      const row=new Setting(contentEl).setName((edge.mode==='start'?'同时开始':'同时结束')+' · '+other.name);
      row.addText(t=>{syncInputs.set(edge.id,t.inputEl);t.setValue(edge.label).setPlaceholder('可选标注');}).addButton(b=>b.setButtonText('移除同步').onClick(()=>{removedSyncs.add(edge.id);row.settingEl.remove();}));
    }
    const save = () => {
      if (view.project !== project) return new Notice('项目已切换，请重新打开动作编辑');
      d.name = fields.name.value.trim(); d.laneId = fields.lane.value; d.status = fields.status.value; d.note = fields.note.value;
      d.dependsOn = [...dependencies].filter(([, input]) => input.checked).map(([id]) => id);
      const start = parseTime(fields.start.value), duration = parseTime(fields.duration.value);
      if (!d.name) return new Notice('动作名称不能为空');
      if (start === null || duration === null) return new Notice('时间格式错误：请填写 03:15 这样的分:秒格式');
      if (start + duration > 86400) return new Notice('单场演示最多支持 24 小时');
      d.startSec = start; d.durationSec = duration;
      for (const prevId of d.dependsOn) {
        if (createsCycle(project, prevId, d.id)) return new Notice('依赖关系会形成循环，请调整选择');
      }
      if (view.saveCue(d, { relationLabels: Object.fromEntries([...relationInputs].map(([id, input]) => [id, input.value])), removeRelationIds: [...removedRelations],syncLabels:Object.fromEntries([...syncInputs].map(([id,input])=>[id,input.value])),removeSyncIds:[...removedSyncs] })) this.close();
    };
    new Setting(contentEl).addButton(b => b.setButtonText('保存动作').setCta().onClick(save))
      .addButton(b => b.setButtonText('取消').onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

class ProjectDurationModal extends Modal {
  constructor(view, editProject = false) { super(view.app); this.view = view; this.project = view.project; this.editProject = editProject; }
  onOpen() {
    const { contentEl } = this, view = this.view;
    contentEl.empty(); contentEl.createEl('h3', { text: this.editProject ? '项目设置' : '时间轴总时长' });
    let input, nameInput;
    if (this.editProject) new Setting(contentEl).setName('项目名称')
      .addText(t => { nameInput = t.inputEl; t.setValue(this.project.name); });
    new Setting(contentEl).setName('总时长').setDesc('分:秒或时:分:秒，例如 30:00、01:30:00；精确到秒。')
      .addText(t => { input = t.inputEl; t.setValue(fmtTime(view.calculateDuration())).setPlaceholder('例如 30:00'); });
    contentEl.createDiv({ cls: 'cueflow-muted',
      text: '最后一个动作结束于 T+' + fmtTime(latestCueEnd(this.project)) + '。缩短时间轴时会保留全部动作。' });
    new Setting(contentEl).setName('快捷增加').addButton(b => b.setButtonText('+1 分钟').onClick(() => add(60)))
      .addButton(b => b.setButtonText('+5 分钟').onClick(() => add(300)))
      .addButton(b => b.setButtonText('+10 分钟').onClick(() => add(600)));
    const add = seconds => {
      const current = parseTime(input.value);
      if (current === null) return new Notice('请填写有效时长，例如 30:00 或 01:30:00');
      if (current + seconds > 86400) return new Notice('单场演示最多支持 24 小时');
      input.value = fmtTime(current + seconds);
    };
    const save = () => {
      if (view.project !== this.project) return new Notice('项目已切换，请重新打开总时长设置');
      const seconds = parseTime(input.value);
      if (seconds === null) { input.focus(); return new Notice('请填写有效时长，例如 30:00 或 01:30:00'); }
      const saved = this.editProject ? view.updateProjectSettings({ name: nameInput.value, durationSec: seconds }) : view.setProjectDuration(seconds);
      if (saved) this.close();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); save(); }
    });
    new Setting(contentEl).addButton(b => b.setButtonText(this.editProject ? '保存项目设置' : '保存总时长').setCta().onClick(save))
      .addButton(b => b.setButtonText('取消').onClick(() => this.close()));
    window.setTimeout(() => { if (input.isConnected) { input.focus(); input.select(); } }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

class DisplaySettingsModal extends Modal {
  constructor(view) { super(view.app); this.view = view; }
  onOpen() {
    const { contentEl } = this, view = this.view;
    contentEl.empty(); contentEl.createEl('h3', { text: '显示设置' });
    new Setting(contentEl).setName('时间轴总时长').setDesc('设置本项目的时间范围，后续动作超出时自动延长。')
      .addButton(b => b.setButtonText(fmtTime(view.calculateDuration())).onClick(() => { this.close(); view.openDurationSettings(); }));
    new Setting(contentEl).setName('时间轴缩放').setDesc('向右放大，便于逐秒调整；向左缩小，查看完整排程。')
      .addSlider(s => s.setLimits(1, 900, 1).setValue(view.scale * 60).setDynamicTooltip().onChange(v => view.setPixelsPerMinute(v)));
    new Setting(contentEl).setName('快速缩放')
      .addButton(b => b.setButtonText('适应窗口').onClick(() => { view.fitTimeline(); this.close(); }))
      .addButton(b => b.setButtonText('恢复默认').onClick(() => { view.setPixelsPerMinute(180); this.close(); }));
    new Setting(contentEl).setName('人员 / 设备列宽').setDesc('也可拖动左栏右侧的分隔线；双击分隔线恢复默认。')
      .addSlider(s => s.setLimits(160, 600, 1).setValue(view.labelWidth).setDynamicTooltip().onChange(v => view.setLabelWidth(v)));
    new Setting(contentEl).setName('人员 / 设备显示').setDesc('紧凑显示会缩小泳道高度，让更多人员和设备同时显示。')
      .addDropdown(d => d.addOption('standard', '标准显示').addOption('compact', '紧凑显示').setValue(view.density || 'standard').onChange(v => view.setDensity(v)));
    new Setting(contentEl).addButton(b => b.setButtonText('完成').setCta().onClick(() => this.close()));
  }
  onClose() { this.contentEl.empty(); }
}

class CueFlowSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl('h2', { text: 'CueFlow Timeline 设置' });
    new Setting(containerEl).setName('项目保存目录').setDesc('Vault 内的 Markdown 文件夹，修改后新项目存到新目录；原有文件不会移动。')
      .addText(t => t.setValue(this.plugin.settings.folder).onChange(async v => {
        try { this.plugin.settings.folder = normalizeFolder(v); await this.plugin.saveSettings(); }
        catch (err) { new Notice(err.message); }
      }));
    new Setting(containerEl).setName('默认时间吸附').addDropdown(d => {
      for (const s of STEPS) d.addOption(String(s), `${s} 秒`);
      d.setValue(String(this.plugin.settings.snapSeconds)).onChange(async v => {
        this.plugin.settings.snapSeconds = Number(v);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) { leaf.view.snap = Number(v); if (leaf.view.project) leaf.view.render(true); }
        await this.plugin.saveSettings();
      });
    });
    new Setting(containerEl).setName('默认缩放比例').setDesc('每分钟占用的横向像素。')
      .addSlider(s => s.setLimits(1, 900, 1).setValue(this.plugin.settings.pixelsPerMinute).setDynamicTooltip()
        .onChange(async v => {
          this.plugin.settings.pixelsPerMinute = v;
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.setPixelsPerMinute(v, false);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName('人员 / 设备默认显示').setDesc('立即应用到当前时间轴，并用于下次打开。')
      .addDropdown(d => d.addOption('standard', '标准显示').addOption('compact', '紧凑显示').setValue(this.plugin.settings.laneDensity)
        .onChange(async v => {
          this.plugin.settings.laneDensity = v;
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.setDensity(v, false);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName('人员 / 设备列宽').setDesc('左栏宽度，单位像素。也可直接拖动时间轴左栏的右边界。')
      .addSlider(s => s.setLimits(160, 600, 1).setValue(this.plugin.settings.labelWidth).setDynamicTooltip()
        .onChange(async value => {
          this.plugin.settings.labelWidth = value;
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.setLabelWidth(value, false);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName('启用依赖自动顺延').setDesc('仅当后置动作与前置动作发生时间冲突时，向后顺延。')
      .addToggle(t => t.setValue(this.plugin.settings.autoSchedule).onChange(async v => {
        this.plugin.settings.autoSchedule = v;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) { leaf.view.autoSchedule = v; if (leaf.view.project) leaf.view.render(true); }
        await this.plugin.saveSettings();
      }));
  }
}

class CueFlowView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.project = null; this.file = null;
    this.scale = plugin.settings.pixelsPerMinute / 60;
    this.snap = plugin.settings.snapSeconds;
    this.autoSchedule = plugin.settings.autoSchedule;
    this.density = plugin.settings.laneDensity || 'standard';
    this.railWidth = clamp(positive(plugin.settings.labelWidth, LABEL_WIDTH), 160, 600);
    this.history = []; this.historyIndex = -1;
    this.selectedId = null; this.selectedIds = new Set(); this.pendingLinkId = null;
    this.elapsed = 0; this.running = false; this.tickHandle = null;
    this.timerOrigin = 0; this.timerBase = 0;
    this.saveChain = Promise.resolve(); this.saveTimer = null;
    this.collapsedGroups = new Set();
    this.savedBlocks = new Map(); this.dirty = false; this.saveError = ''; this.editRevision = 0;
  }
  get labelWidth() { return clamp(positive(this.railWidth ?? this.plugin?.settings?.labelWidth, LABEL_WIDTH), 160, 600); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return this.project ? `CueFlow · ${this.project.name}` : 'CueFlow 时间轴'; }
  getIcon() { return 'calendar-clock'; }
  async onOpen() {
    this.contentEl.addClass('cueflow-root');
    if(!this.clipboardCopyHandler){
      this.clipboardCopyHandler=e=>{
        if(!this.canvasClipboardScope(e))return;
        const data=this.copySelectedCues();if(data && e.clipboardData){e.clipboardData.setData('text/plain',JSON.stringify(data));e.preventDefault();}
      };
      this.clipboardPasteHandler=e=>{
        if(!this.canvasClipboardScope(e))return;
        try{
          const text=e.clipboardData?.getData('text/plain'),data=text?parseCueClipboard(text):this.plugin.cueClipboard;
          if(data){e.preventDefault();this.pasteCues(data);}
        }catch(err){e.preventDefault();new Notice(err.message);}
      };
      this.contentEl.addEventListener('copy',this.clipboardCopyHandler);this.contentEl.addEventListener('paste',this.clipboardPasteHandler);
    }
    if (!this.canvasClickHandler) {
      this.canvasClickHandler = event => {
        if (this.swallowGestureClick(event)) return;
        const target = event.target;
        if (target?.closest && this.contentEl.contains(target) && target.closest('.cueflow-cue,.cueflow-link-hit,.cueflow-selection-handle')) return;
        this.clearCanvasSelection();
      };
      this.canvasBlurHandler = () => this.clearCanvasSelection();
      document.addEventListener('click', this.canvasClickHandler); window.addEventListener('blur', this.canvasBlurHandler);
    }
    await this.refreshFiles();
    const saved = this.files.find(f => f.path === this.plugin.settings.lastProjectPath);
    if (saved) await this.openFile(saved);
    else if (this.files.length) await this.openFile(this.files[0]);
    else await this.createProject('无人机空地协同演示（示例）', true);
  }
  async onClose() {
    if(this.clipboardCopyHandler)this.contentEl.removeEventListener('copy',this.clipboardCopyHandler);
    if(this.clipboardPasteHandler)this.contentEl.removeEventListener('paste',this.clipboardPasteHandler);
    this.clipboardCopyHandler=null;this.clipboardPasteHandler=null;
    if (this.canvasClickHandler) document.removeEventListener('click', this.canvasClickHandler);
    if (this.canvasBlurHandler) window.removeEventListener('blur', this.canvasBlurHandler);
    this.canvasClickHandler = null; this.canvasBlurHandler = null;
    this.inlineEdit?.finish(true, true); this.projectNameCommit?.(true);
    this.pauseClock(); this.pointerCleanup?.();
    const pending = this.dirty || !!this.saveTimer;
    if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (pending) await this.saveNow();
    await this.saveChain;
    if (this.dirty) await this.saveRecoveryCopy(false);
  }
  async refreshFiles() {
    const folder = this.plugin.settings.folder;
    this.files = this.app.vault.getFiles().filter(f => f.path.startsWith(`${folder}/`) && f.extension === 'md').sort((a,b) => a.basename.localeCompare(b.basename, 'zh-CN'));
    this.projectTitles ||= new Map();
    const paths = new Set(this.files.map(f => f.path));
    for (const path of this.projectTitles.keys()) if (!paths.has(path)) this.projectTitles.delete(path);
    await Promise.allSettled(this.files.map(async file => {
      const cached = this.projectTitles.get(file.path);
      if (file.stat && cached?.mtime === file.stat.mtime && cached?.size === file.stat.size) return;
      try {
        const raw = await this.app.vault.read(file), match = raw.match(BLOCK_RE), name = match && JSON.parse(match[1]).name;
        this.cacheProjectTitle(file, typeof name === 'string' && name.trim() ? name.trim() : file.basename);
      } catch { this.projectTitles.delete(file.path); }
    }));
  }
  cacheProjectTitle(file, name) {
    this.projectTitles ||= new Map();
    this.projectTitles.set(file.path, { name, mtime: file.stat?.mtime, size: file.stat?.size });
  }
  projectOptions() {
    const entries = (this.files || []).map(file => [file.path, file.path === this.file?.path && this.project ? this.project.name : this.projectTitles?.get(file.path)?.name || file.basename]);
    const counts = new Map(); for (const [, name] of entries) counts.set(name, (counts.get(name) || 0) + 1);
    return entries.map(([path, name]) => [path, counts.get(name) > 1 ? name + '（' + path + '）' : name]);
  }
  syncProjectTitleUI() {
    const labels = new Map(this.projectOptions());
    this.projectPickerEl?.querySelectorAll('option').forEach(option => { option.textContent = labels.get(option.value) || option.textContent; });
    if (this.projectNameInput && document.activeElement !== this.projectNameInput) this.projectNameInput.value = this.project.name;
    this.contentEl?.querySelector('.cueflow-project-title')?.setText(this.project.name);
  }
  renameProject(value) {
    const name = String(value ?? '').trim();
    if (!name) { new Notice('项目名称不能为空'); return false; }
    if (name !== this.project.name) { this.project.name = name; this.recordChange(false); }
    this.syncProjectTitleUI(); return true;
  }
  async ensureFolder() {
    this.plugin.settings.folder = normalizeFolder(this.plugin.settings.folder);
    const segments = this.plugin.settings.folder.split('/').filter(Boolean); let path = '';
    for (const seg of segments) { path = path ? `${path}/${seg}` : seg; if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path); }
  }
  async createProject(name, example = false) {
    try {
      if (this.dirty && !(await this.saveNow())) return;
      await this.ensureFolder();
      const folder = this.plugin.settings.folder;
      const base = filenameFor(name);
      let path = `${folder}/${base}.md`, i = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${base}-${i++}.md`;
      const proj = example ? makeExample() : { version: 5, syncLinks: [], relations: [], dependencyLabels: [], name, durationSec: 1200, groups: deepCopy(DEFAULT_GROUPS),
        lanes: LANES.map(([n, color, groupId]) => ({ id: uid('lane'), name: n, color, groupId })), cues: [] };
      proj.name = name;
      const file = await this.app.vault.create(path, safeMarkdown(proj));
      await this.refreshFiles();
      await this.openFile(file);
    } catch (err) { new Notice(`创建项目失败：${err.message}`); }
  }
  async openFile(file, discardUnsaved = false) {
    try {
      this.inlineEdit?.finish(true, true); this.projectNameCommit?.(true);
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      if (this.dirty && !discardUnsaved && !(await this.saveNow())) return false;
      await this.saveChain;
      if (this.dirty && !discardUnsaved) return false;
      const raw = await this.app.vault.read(file), match = raw.match(BLOCK_RE);
      if (!match) throw new Error('没有找到 ```cueflow 数据块');
      const project = validateProject(JSON.parse(match[1]));
      this.cacheProjectTitle(file, project.name);
      this.pointerCleanup?.(); this.file = file; this.project = project; this.selectedId = null; this.selectedIds = new Set(); this.selectedConnectionId = null; this.pendingLinkId = null;
      this.savedBlocks.set(file.path, match[0]); this.dirty = false; this.saveError = '';
      this.collapsedGroups = new Set();
      this.pauseClock(); this.elapsed = 0; this.history = [JSON.stringify(this.project)]; this.historyIndex = 0;
      this.plugin.settings.lastProjectPath = file.path;
      await this.plugin.saveSettings();
      this.render(); return true;
    } catch (err) { new Notice(`无法打开项目：${err.message}`); return false; }
  }
  recordChange(render = true) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(JSON.stringify(this.project));
    if (this.history.length > 60) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.queueSave(); if (render) this.render(true);
  }
  undo() {
    if (this.historyIndex <= 0) return;
    this.pointerCleanup?.();
    this.historyIndex--; this.project = JSON.parse(this.history[this.historyIndex]); this.queueSave(); this.render(true);
  }
  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.pointerCleanup?.();
    this.historyIndex++; this.project = JSON.parse(this.history[this.historyIndex]); this.queueSave(); this.render(true);
  }
  queueSave() {
    this.dirty = true; this.editRevision++; this.updateSaveStatus();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 280);
  }
  updateSaveStatus() {
    if (this.saveStatusEl) {
      this.saveStatusEl.setText(this.saveError ? '未保存：' + this.saveError : this.dirty ? '待保存…' : '已保存');
      this.saveStatusEl.classList.toggle('cueflow-save-error', !!this.saveError);
    }
    if (this.recoveryActions) this.recoveryActions.hidden = !this.saveError;
  }
  async saveNow() {
    if (!this.file || !this.project) return true;
    const file = this.file, snapshot = deepCopy(this.project), revision = this.editRevision;
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      const current = await this.app.vault.read(file), match = current.match(BLOCK_RE);
      if (!match) throw new Error('文件中的 CueFlow 数据块已移除，请保存为副本或重新读取');
      if ((current.match(new RegExp(BLOCK_RE.source, 'gm')) || []).length !== 1) throw new Error('文件中必须只有一个 CueFlow 数据块');
      const expected = this.savedBlocks?.get(file.path);
      if (expected !== undefined && match[0] !== expected) throw new Error('排程已被外部修改，请保存为副本或重新读取');
      const block = '```cueflow\n' + JSON.stringify(snapshot, null, 2) + '\n```';
      const result = current.replace(BLOCK_RE, () => block);
      if (current !== result) await this.app.vault.modify(file, result);
      if (!this.savedBlocks) this.savedBlocks = new Map();
      this.savedBlocks.set(file.path, block);
      this.cacheProjectTitle(file, snapshot.name); this.syncProjectTitleUI();
      if (this.file?.path === file.path && this.editRevision === revision) { this.dirty = false; this.saveError = ''; this.updateSaveStatus(); }
      return true;
    }).catch(err => {
      this.dirty = true; this.saveError = err.message; this.updateSaveStatus();
      new Notice('CueFlow 保存失败：' + err.message); return false;
    });
    return this.saveChain;
  }
  async saveRecoveryCopy(open = true) {
    try {
      const project = deepCopy(this.project), parent = this.file.path.slice(0, this.file.path.lastIndexOf('/'));
      project.name += '（恢复副本）';
      const base = parent + '/' + filenameFor(project.name);
      let path = base + '.md', index = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = base + '-' + index++ + '.md';
      const file = await this.app.vault.create(path, safeMarkdown(project));
      new Notice('当前修改已保存为 ' + path);
      if (open) { await this.refreshFiles(); await this.openFile(file, true); }
      return file;
    } catch (err) { new Notice('恢复副本保存失败：' + err.message, 12000); return null; }
  }
  saveCue(cue, options = {}) {
    try {
      const draft = deepCopy(cue); draft.name = draft.name.trim();
      if (!draft.name) throw new Error('动作名称不能为空');
      const candidate = deepCopy(this.project), index = candidate.cues.findIndex(c => c.id === draft.id);
      if (index < 0) candidate.cues.push(draft); else candidate.cues[index] = draft;
      candidate.relations = (candidate.relations || []).filter(edge => !(options.removeRelationIds || []).includes(edge.id))
        .map(edge => ({ ...edge, label: options.relationLabels?.[edge.id] ?? edge.label }));
      candidate.syncLinks=(candidate.syncLinks || []).filter(edge=>!(options.removeSyncIds || []).includes(edge.id)).map(edge=>({...edge,label:options.syncLabels?.[edge.id] ?? edge.label}));
      validateProject(candidate); scheduleDependents(candidate, this.autoSchedule,[draft.id]);
      candidate.durationSec = Math.max(candidate.durationSec, latestCueEnd(candidate));
      const existing = new Map(this.project.cues.map(c => [c.id, c]));
      this.project.cues = candidate.cues.map(c => existing.has(c.id) ? Object.assign(existing.get(c.id), c) : c);
      this.project.durationSec = candidate.durationSec; this.project.version = candidate.version; this.project.relations = candidate.relations; this.project.dependencyLabels = candidate.dependencyLabels; this.project.syncLinks=candidate.syncLinks;
      this.selectedConnectionId = null; this.selectedId = draft.id; this.selectedIds = new Set([draft.id]); this.recordChange(); return true;
    } catch (err) { new Notice(err.message); return false; }
  }
  saveCueBatch(drafts, lockTiming = false) {
    try {
      const byId = new Map(drafts.map(cue => [cue.id, deepCopy(cue)]));
      if (!byId.size || [...byId.keys()].some(id => !this.project.cues.some(c => c.id === id))) return false;
      const candidate = deepCopy(this.project); candidate.cues = candidate.cues.map(c => byId.get(c.id) || c);
      validateProject(candidate); scheduleDependents(candidate, this.autoSchedule,[...byId.keys()]);
      if (lockTiming && candidate.cues.some(c => byId.has(c.id) && c.startSec !== byId.get(c.id).startSec)) throw new Error('依赖或同步限制了整体调整，请一并选择相关动作，或调整连线/持续时间');
      candidate.durationSec = Math.max(candidate.durationSec, latestCueEnd(candidate));
      if (JSON.stringify(candidate) === JSON.stringify(this.project)) return true;
      const existing = new Map(this.project.cues.map(c => [c.id, c]));
      this.project.cues = candidate.cues.map(c => Object.assign(existing.get(c.id), c));
      this.project.durationSec = candidate.durationSec; this.project.version = candidate.version;
      this.project.syncLinks=candidate.syncLinks;
      this.recordChange(); return true;
    } catch (err) { new Notice(err.message); return false; }
  }
  setSelectionCritical(value) {
    const ids = this.getSelectedCueIds(), cues = this.project.cues.filter(c => ids.has(c.id));
    if (!cues.length) return false;
    const next = value === undefined ? !cues.every(c => c.critical) : !!value;
    if (cues.every(c => !!c.critical === next)) return true;
    cues.forEach(c => { c.critical = next; }); this.project.version = 5; this.recordChange(); return true;
  }
  deleteCue(id, confirm = true) { return this.deleteCues([id], confirm); }
  deleteCues(ids, confirm = true) {
    const chosen = new Set(ids), cues = this.project.cues.filter(c => chosen.has(c.id)); if (!cues.length) return;
    if (confirm && !window.confirm(cues.length === 1 ? `删除动作「${cues[0].name}」？` : `删除选中的 ${cues.length} 个动作？`)) return;
    this.pointerCleanup?.();
    if (chosen.has(this.inlineEdit?.id)) this.inlineEdit.finish(false);
    if (chosen.has(this.pendingLinkId)) this.pendingLinkId = null;
    this.project.cues = this.project.cues.filter(c => !chosen.has(c.id));
    this.project.relations = (this.project.relations || []).filter(edge => !chosen.has(edge.from) && !chosen.has(edge.to));
    this.project.syncLinks = (this.project.syncLinks || []).filter(edge => !chosen.has(edge.from) && !chosen.has(edge.to));
    this.project.dependencyLabels = (this.project.dependencyLabels || []).filter(edge => !chosen.has(edge.from) && !chosen.has(edge.to));
    this.selectedConnectionId = null;
    for (const c of this.project.cues) c.dependsOn = c.dependsOn.filter(d => !chosen.has(d));
    this.selectedId = null; this.selectedIds = new Set(); this.recordChange();
  }
  addCue(laneId, startSec = 0, durationSec = 60) {
    const cue = { id: uid('cue'), name: '新动作', laneId, startSec: Math.round(startSec), durationSec: Math.round(durationSec), note: '', dependsOn: [], status: 'planned' };
    new CueModal(this, cue).open();
  }
  createCueAt(laneId, seconds) {
    if (!this.project.lanes.some(lane => lane.id === laneId) || !Number.isFinite(seconds)) return null;
    const startSec = clamp(roundSnap(seconds, this.snap), 0, 86399);
    const cue = { id: uid('cue'), name: '新动作', laneId, startSec, durationSec: Math.min(60, 86400 - startSec), note: '', dependsOn: [], status: 'planned' };
    const pending = this.pendingLinkId; this.pendingLinkId = null;
    if (!this.saveCue(cue)) { this.pendingLinkId = pending; return null; }
    this.beginInlineCueName(cue.id);
    return this.project.cues.find(item => item.id === cue.id);
  }
  renameCueName(id, value, project = this.project) {
    const name = String(value ?? '').trim(), cue = this.project.cues.find(item => item.id === id);
    if (this.project !== project || !cue || !name) return false;
    if (cue.name !== name) { cue.name = name; this.recordChange(false); }
    return true;
  }
  beginInlineCueName(id) {
    this.inlineEdit?.finish(true, true);
    this.selectCue(id);
    const project = this.project, cue = project.cues.find(item => item.id === id);
    const el = [...this.board.querySelectorAll('.cueflow-cue')].find(node => node.dataset.id === id);
    if (!cue || !el) return;
    const title = el.querySelector('.cueflow-cue-title'); title.empty(); el.classList.add('cueflow-editing');
    const input = title.createEl('input', { type: 'text', cls: 'cueflow-inline-editor', attr: { 'aria-label': '任务名称', placeholder: '输入任务名称' } });
    input.value = cue.name;
    let finished = false;
    const finish = (commit = true, fromBlur = false) => {
      if (finished) return true;
      if (commit && !input.value.trim() && !fromBlur) { new Notice('动作名称不能为空'); input.focus(); return false; }
      finished = true; this.inlineEdit = null; input.removeEventListener('blur', blur);
      if (commit && input.value.trim()) this.renameCueName(id, input.value, project);
      el.classList.remove('cueflow-editing'); title.setText(cue.durationSec === 0 ? '◆ ' + cue.name : cue.name);
      el.setAttribute('title', cue.name + '\nT+' + fmtTime(cue.startSec) + ' 至 T+' + fmtTime(cue.startSec + cue.durationSec) + '\n' + cue.note);
      if (fromBlur) window.setTimeout(() => { if (this.project === project && this.footerEl?.isConnected && !this.inlineEdit) this.renderFooter(); }, 0);
      else if (this.project === project) this.renderFooter();
      if (!fromBlur && this.scroller.isConnected) this.scroller.focus({ preventScroll: true });
      return true;
    };
    const blur = () => finish(true, true);
    this.inlineEdit = { id, input, finish };
    for (const type of ['pointerdown', 'click', 'dblclick']) input.addEventListener(type, e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', blur);
    input.focus({ preventScroll: true }); input.select();
  }
  handleCanvasKeydown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.target?.closest?.('input,textarea,select,button,[role="button"],[role="separator"],[contenteditable]:not([contenteditable="false"])')) return;
    const mod = e.ctrlKey || e.metaKey;
    if(mod && e.key.toLowerCase()==='c'){this.copySelectedCues();return;}
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (e.key === 'Escape') { e.preventDefault(); this.clearCanvasSelection(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectCues(this.project.cues.filter(c => this.laneLayout.laneY.has(c.laneId)).map(c => c.id)); return; }
    if (!mod && !e.altKey && e.key === 'Delete') {
      if (this.selectedId) { e.preventDefault(); this.deleteCues(this.getSelectedCueIds(), false); }
      else if (this.selectedConnectionId) { e.preventDefault(); this.removeConnection(this.selectedConnectionId); }
    }
  }
  duplicateCue(cue) {
    const copy = deepCopy(cue); copy.id = uid('cue'); copy.name += '（副本）'; copy.startSec = cue.startSec + Math.max(cue.durationSec, this.snap); copy.dependsOn = [];
    this.saveCue(copy);
  }
  canvasClipboardScope(event) {
    const editable='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
    return !event.defaultPrevented && this.contentEl.isConnected && this.scroller?.contains(document.activeElement) && !event.target?.closest?.(editable) && !document.activeElement?.closest?.(editable);
  }
  copySelectedCues(writeSystem = false) {
    try{
      const order=this.laneLayout?.rows.filter(r=>r.kind==='lane').map(r=>r.lane.id),data=makeCueClipboard(this.project,this.getSelectedCueIds(),order);
      if(!data)return null;parseCueClipboard(data);this.plugin.cueClipboard=data;
      if(writeSystem && typeof navigator!=='undefined' && navigator.clipboard?.writeText)navigator.clipboard.writeText(JSON.stringify(data)).catch(()=>{});
      return data;
    }catch(err){new Notice('复制失败：'+err.message);return null;}
  }
  getPastePosition() {
    if(!this.canvasPointer || !this.rowsEl || !this.scroller)return null;
    const {x,y}=this.canvasPointer,bounds=this.rowsEl.getBoundingClientRect(),viewport=this.scroller.getBoundingClientRect();
    if(x<viewport.left+this.labelWidth || x>=viewport.right || y<viewport.top+HEADER_HEIGHT || y>=viewport.bottom)return null;
    const target=laneAtY(this.laneLayout,y-bounds.top);if(!target)return null;
    return {laneId:target.lane.id,seconds:roundSnap((x-bounds.left-this.labelWidth)/this.scale,this.snap)};
  }
  pasteCues(fragment=this.plugin.cueClipboard,position=this.getPastePosition()) {
    try{
      this.pointerCleanup?.();this.inlineEdit?.finish(true,true);
      const order=this.laneLayout.rows.filter(r=>r.kind==='lane').map(r=>r.lane.id),result=pastedCueProject(this.project,fragment,position,order);
      Object.assign(this.project,result.project);this.selectedIds=new Set(result.ids);this.selectedId=result.ids[0];this.selectedConnectionId=null;
      this.recordChange();this.scroller.focus({preventScroll:true});
      if(result.clamped)new Notice('已在时间轴/泳道边界内粘贴，保持动作相对位置');
      return result.ids;
    }catch(err){new Notice('粘贴失败：'+err.message);return null;}
  }
  addDependency(predecessorId, dependentId) {
    return this.addConnection(predecessorId, 'right', dependentId, 'left');
  }
  connectionError(edge) {
    if (!edge || !this.project.cues.some(cue => cue.id === edge.from) || !this.project.cues.some(cue => cue.id === edge.to)) return '请连接不同动作：左右为依赖，同侧为同步，上下为关联';
    if (edge.kind === 'dependency') {
      if (createsCycle(this.project, edge.from, edge.to)) return '不能添加循环依赖';
      if (this.project.cues.find(cue => cue.id === edge.to).dependsOn.includes(edge.from)) return '依赖关系已存在';
    } else if(edge.kind.startsWith('sync-')){
      if((this.project.syncLinks || []).some(item=>item.mode===edge.kind.slice(5)&&[item.from,item.to].includes(edge.from)&&[item.from,item.to].includes(edge.to)))return '同步关系已存在';
    } else if ((this.project.relations || []).some(item => item.from === edge.from && item.to === edge.to && item.fromPort === edge.fromPort && item.toPort === edge.toPort)) return '关联线已存在';
    if(edge.kind!=='relation')try{
      const candidate=deepCopy(this.project);
      if(edge.kind==='dependency')candidate.cues.find(c=>c.id===edge.to).dependsOn.push(edge.from);
      else candidate.syncLinks=[...(candidate.syncLinks || []),{id:'preview-sync',from:edge.from,to:edge.to,mode:edge.kind.slice(5),label:''}];
      scheduleDependents(candidate,this.autoSchedule,[edge.from]);
    }catch(err){return err.message;}
    return '';
  }
  addConnection(from, fromPort, to, toPort) {
    const edge = connectionIntent(from, fromPort, to, toPort), error = this.connectionError(edge);
    if (error) { new Notice(error); return false; }
    if (edge.kind === 'dependency') {
      const target = deepCopy(this.project.cues.find(cue => cue.id === edge.to)); target.dependsOn.push(edge.from);
      return this.saveCue(target);
    }
    if(edge.kind.startsWith('sync-')){
      try{
        const candidate=deepCopy(this.project),link={id:uid('sync'),from:edge.from,to:edge.to,mode:edge.kind.slice(5),label:''};
        candidate.syncLinks=[...(candidate.syncLinks || []),link];validateProject(candidate);scheduleDependents(candidate,this.autoSchedule,[edge.from]);
        candidate.durationSec=Math.max(candidate.durationSec,latestCueEnd(candidate));
        const existing=new Map(this.project.cues.map(c=>[c.id,c]));candidate.cues=candidate.cues.map(c=>Object.assign(existing.get(c.id),c));
        Object.assign(this.project,candidate);this.selectedId=null;this.selectedIds=new Set();this.selectedConnectionId=link.id;this.recordChange();return true;
      }catch(err){new Notice(err.message);return false;}
    }
    const relation = { id: uid('relation'), from: edge.from, to: edge.to, fromPort, toPort, label: '' };
    this.project.relations = [...(this.project.relations || []), relation]; this.selectedId = null; this.selectedIds = new Set(); this.selectedConnectionId = relation.id;
    this.recordChange(); return true;
  }
  removeConnection(id) {
    const edge = projectConnections(this.project).find(item => item.id === id); if (!edge) return false;
    this.selectedConnectionId = null;
    if (edge.kind === 'dependency') {
      const cue = deepCopy(this.project.cues.find(item => item.id === edge.to)); cue.dependsOn = cue.dependsOn.filter(parent => parent !== edge.from);
      return this.saveCue(cue);
    }
    if(edge.kind.startsWith('sync-'))this.project.syncLinks=this.project.syncLinks.filter(item=>item.id!==id);
    else this.project.relations = this.project.relations.filter(item => item.id !== id);
    this.recordChange(); return true;
  }
  setConnectionLabel(id, value) {
    const edge = projectConnections(this.project).find(item => item.id === id); if (!edge) return false;
    const label = String(value ?? '').trim(); if (edge.label === label) return true;
    if (edge.kind === 'dependency') {
      this.project.dependencyLabels = (this.project.dependencyLabels || []).filter(item => item.from !== edge.from || item.to !== edge.to);
      if (label) this.project.dependencyLabels.push({ from: edge.from, to: edge.to, label });
    } else if(edge.kind.startsWith('sync-'))this.project.syncLinks.find(item=>item.id===id).label=label;
    else this.project.relations.find(item => item.id === id).label = label;
    this.selectedId = null; this.selectedIds = new Set(); this.selectedConnectionId = id; this.recordChange(); return true;
  }
  editConnection(id) {
    const edge = projectConnections(this.project).find(item => item.id === id); if (!edge) return;
    const project = this.project;
    new StringModal(this.app, '连线文字标注', '标注文字', edge.label, label => {
      if (this.project === project) this.setConnectionLabel(id, label);
    }, true).open();
  }
  clearCanvasSelection() {
    this.pointerCleanup?.(); this.inlineEdit?.finish(true, true);
    this.selectedId = null; this.selectedIds = new Set(); this.selectedConnectionId = null; this.pendingLinkId = null;
    this.board?.querySelectorAll('.cueflow-selected,.cueflow-connection-target,.cueflow-connection-invalid').forEach(el => el.classList.remove('cueflow-selected', 'cueflow-connection-target', 'cueflow-connection-invalid'));
    this.updateConnectionFocus(); this.renderSelectionBox(); if (this.project) this.renderFooter();
  }
  selectConnection(id) {
    this.inlineEdit?.finish(true, true); this.selectedId = null; this.selectedIds = new Set(); this.selectedConnectionId = id;
    this.board.querySelectorAll('.cueflow-cue').forEach(el => el.classList.remove('cueflow-selected'));
    this.scroller.focus({ preventScroll: true }); this.updateConnectionFocus(); this.renderSelectionBox(); this.renderFooter();
  }
  updateConnectionFocus() {
    const selected = this.getSelectedCueIds();
    this.rowsEl?.querySelectorAll('.cueflow-connection').forEach(el => {
      const focus = el.dataset.id === this.selectedConnectionId || selected.has(el.dataset.from) || selected.has(el.dataset.to);
      el.classList.toggle('cueflow-link-focused', focus);
      el.classList.toggle('cueflow-link-dimmed', !!(this.selectedId || this.selectedConnectionId) && !focus);
    });
  }
  getConnectionRects(override = null) {
    return connectionRects(this.project, this.laneLayout, this.scale, this.density === 'compact' ? 24 : 36, this.density === 'compact' ? 8 : 19, override);
  }
  beginConnectionDrag(event, cue, port) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.inlineEdit?.finish(true, true); this.pointerCleanup?.();
    this.scroller.focus({ preventScroll: true }); this.selectCue(cue.id);
    const project = this.project, boxes = this.getConnectionRects(), from = portPoint(boxes.get(cue.id), port), svg = this.rowsEl.querySelector('.cueflow-links');
    const ns = 'http://www.w3.org/2000/svg', group = document.createElementNS(ns, 'g'); group.classList.add('cueflow-connection-preview');
    const halo = document.createElementNS(ns, 'path'), path = document.createElementNS(ns, 'path'),nearGuide=document.createElementNS(ns,'path');
    halo.classList.add('cueflow-link-halo'); path.classList.add('cueflow-link-main');nearGuide.classList.add('cueflow-link-main'); group.append(halo, path,nearGuide); svg.append(group);
    const kind = ['left', 'right'].includes(port) ? 'dependency' : 'relation'; group.classList.add('cueflow-link-' + kind);
    path.setAttribute('marker-end', 'url(#' + this.connectionMarkerId + '-' + kind + ')');
    let active = false, destination = null, hint = null, timer = null, last = { x: event.clientX, y: event.clientY };
    const clearTarget = () => this.board.querySelectorAll('.cueflow-connection-target,.cueflow-connection-invalid').forEach(el => el.classList.remove('cueflow-connection-target', 'cueflow-connection-invalid'));
    const paint = () => {
      const root = document.elementFromPoint(last.x, last.y), node = root?.closest?.('.cueflow-port'), card = root?.closest?.('.cueflow-cue');
      const opposite = { right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
      const to = card?.dataset.id, toPort = node?.dataset.port || opposite[port], intent = connectionIntent(cue.id, port, to, toPort);
      const error = to ? this.connectionError(intent) : ''; destination = to && !error ? { to, toPort } : null; clearTarget();
      const paintKind=intent?.kind || kind;
      group.classList.remove(...CONNECTION_KINDS.map(value=>'cueflow-link-'+value));group.classList.add('cueflow-link-'+paintKind);
      path.setAttribute('marker-end','url(#'+this.connectionMarkerId+'-'+paintKind+')');
      if(paintKind.startsWith('sync-'))path.setAttribute('marker-start','url(#'+this.connectionMarkerId+'-'+paintKind+')');else path.removeAttribute('marker-start');
      if (card) card.classList.add(destination ? 'cueflow-connection-target' : 'cueflow-connection-invalid');
      group.classList.toggle('cueflow-connection-invalid', !!to && !!error);
      const bounds = this.rowsEl.getBoundingClientRect(), end = { x: last.x - bounds.left - this.labelWidth, y: last.y - bounds.top };
      let d,route;
      if (intent && boxes.has(to)) {
        route=routeConnection(intent,boxes);d=route?.d;
      }
      if (!d) {
        const points = [from, { x: from.x + PORTS[port][0] * 18, y: from.y + PORTS[port][1] * 18 }, { x: end.x, y: from.y + PORTS[port][1] * 18 }, end];
        d = roundedPath(port === 'left' ? points.reverse() : points);
      }
      halo.setAttribute('d', d); path.setAttribute('d', d);
      nearGuide.setAttribute('d',route?.arrowGuide?roundedPath(route.arrowGuide):'');nearGuide.setAttribute('marker-end','url(#'+this.connectionMarkerId+'-'+paintKind+')');
      hint.setText(to && error ? error : destination ? '松开建立'+connectionName(paintKind) : kind==='dependency'?'异侧节点连接前后依赖；左左同时开始，右右同时结束':'拖向另一个动作的上 / 下节点（不参与排期）');
      hint.style.left = Math.max(8, Math.min(last.x + 14, window.innerWidth - hint.offsetWidth - 8)) + 'px'; hint.style.top = Math.max(8, Math.min(last.y + 16, window.innerHeight - 45)) + 'px';
    };
    const autoScroll = () => {
      const r = this.scroller.getBoundingClientRect(); let dx = 0, dy = 0;
      if (last.x > r.right - 24) dx = 20; else if (last.x < r.left + this.labelWidth + 20) dx = -20;
      if (last.y > r.bottom - 24) dy = 16; else if (last.y < r.top + HEADER_HEIGHT + 18) dy = -16;
      if (dx || dy) { this.scroller.scrollLeft += dx; this.scroller.scrollTop += dy; paint(); }
    };
    const move = e => {
      last = { x: e.clientX, y: e.clientY };
      if (!active && Math.hypot(last.x - event.clientX, last.y - event.clientY) < 4) return;
      if (!active) {
        active = true; this.contentEl.classList.add('cueflow-connecting');
        hint = document.body.createDiv({ cls: 'cueflow-connection-hint' });
        timer = window.setInterval(autoScroll, 40);
      }
      paint();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      if (timer) window.clearInterval(timer); group.remove(); hint?.remove(); clearTarget();
      this.contentEl.classList.remove('cueflow-connecting'); this.pointerCleanup = null;
    };
    const end = () => { const target = destination; cleanup(); if (active && target && this.project === project) this.addConnection(cue.id, port, target.to, target.toPort); };
    const cancel = () => cleanup();
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    this.pointerCleanup = cancel;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
  }
  renameLane(lane) { new LaneModal(this, lane).open(); }
  addLane(groupId = null) { new LaneModal(this, null, groupId).open(); }
  saveLane(lane) {
    const draft = deepCopy(lane); draft.name = draft.name.trim();
    if (!draft.name) return new Notice('请填写泳道名称');
    if (!this.project.groups.some(g => g.id === draft.groupId)) draft.groupId = '';
    const index = this.project.lanes.findIndex(l => l.id === draft.id);
    if (index < 0) this.project.lanes.push(draft); else this.project.lanes[index] = draft;
    this.collapsedGroups.delete(draft.groupId); this.recordChange();
  }
  addGroup() {
    new StringModal(this.app, '新建分组', '分组名称', '', name => {
      this.project.groups.push({ id: uid('group'), name }); this.recordChange();
    }).open();
  }
  renameGroup(group) {
    new StringModal(this.app, '修改分组名称', '分组名称', group.name, name => { group.name = name; this.recordChange(); }).open();
  }
  moveGroup(id, delta) {
    const groups = this.project.groups, index = groups.findIndex(g => g.id === id), target = index + delta;
    if (index < 0 || target < 0 || target >= groups.length) return;
    [groups[index], groups[target]] = [groups[target], groups[index]]; this.recordChange();
  }
  moveGroupTo(id, anchorId, placement = 'before') {
    const groups = this.project.groups, group = groups.find(item => item.id === id);
    if (!group || id === anchorId) return false;
    const rest = groups.filter(item => item.id !== id), anchorIndex = rest.findIndex(item => item.id === anchorId);
    if (anchorIndex < 0) return false;
    const index = anchorIndex + (placement === 'after' ? 1 : 0);
    const next = [...rest.slice(0, index), group, ...rest.slice(index)];
    if (next.every((item, i) => item === groups[i])) return false;
    // Reorder only group IDs. Lane IDs, action times and dependency edges stay intact.
    this.project.groups = next; this.recordChange(); return true;
  }
  beginGroupDrag(event, group) {
    if (event.button !== 0 || !group.id) return;
    event.preventDefault(); event.stopPropagation(); this.pointerCleanup?.();
    this.scroller.focus({ preventScroll: true });
    const project = this.project, startX = event.clientX, startY = event.clientY;
    const headers = this.laneLayout.rows.filter(row => row.kind === 'group');
    const sections = headers.map((row, index) => ({ ...row, end: headers[index + 1]?.y ?? this.laneLayout.height }));
    const source = sections.find(row => row.group.id === group.id);
    const laneIds = new Set(source.lanes.map(lane => lane.id));
    const sourceNodes = [...this.rowsEl.children].filter(el =>
      el.classList.contains('cueflow-group-row') ? el.dataset.groupId === group.id :
      el.classList.contains('cueflow-lane-row') && laneIds.has(el.dataset.laneId));
    let active = false, destination = null, preview = null;
    const indicator = this.rowsEl.createDiv({ cls: 'cueflow-group-drop-line' }); indicator.hidden = true;
    const move = e => {
      if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      if (!active) {
        active = true; sourceNodes.forEach(el => el.classList.add('cueflow-group-reordering'));
        preview = document.body.createDiv({ cls: 'cueflow-group-drag-preview', attr: { 'aria-hidden': 'true' } });
        preview.classList.toggle('cueflow-compact', this.density === 'compact');
        const cues = project.cues.filter(cue => laneIds.has(cue.laneId)).length;
        preview.createDiv({ cls: 'cueflow-group-drag-summary', text: group.name + ' · ' + source.lanes.length + ' 条泳道 · ' + cues + ' 个动作' });
        const fullWidth = parseFloat(this.board.style.width), height = source.end - source.y;
        const scale = Math.min(1, 680 / fullWidth, 260 / height);
        const frame = preview.createDiv({ cls: 'cueflow-group-drag-frame' });
        frame.style.width = (fullWidth * scale) + 'px'; frame.style.height = (height * scale) + 'px';
        const content = frame.createDiv({ cls: 'cueflow-group-drag-content' });
        content.style.cssText = 'width:' + fullWidth + 'px;height:' + height + 'px;transform:scale(' + scale + ');transform-origin:top left';
        sourceNodes.forEach(el => { const clone = el.cloneNode(true); clone.classList.remove('cueflow-group-reordering'); content.appendChild(clone); });
        const links = this.rowsEl.querySelector('.cueflow-links').cloneNode(true);
        links.style.top = -source.y + 'px';
        for (const marker of links.querySelectorAll('marker')) {
          const oldId = marker.id, markerId = uid('group-preview-arrow'); marker.id = markerId;
          for(const attr of ['marker-start','marker-end'])links.querySelectorAll('['+attr+']').forEach(path => { if (path.getAttribute(attr) === 'url(#' + oldId + ')') path.setAttribute(attr, 'url(#' + markerId + ')'); });
        }
        content.appendChild(links);
      }
      preview.style.left = Math.max(8, Math.min(e.clientX + 12, window.innerWidth - preview.offsetWidth - 8)) + 'px';
      preview.style.top = Math.max(8, Math.min(e.clientY + 12, window.innerHeight - preview.offsetHeight - 8)) + 'px';
      const bounds = this.scroller.getBoundingClientRect();
      if (e.clientY < bounds.top + HEADER_HEIGHT + 18) this.scroller.scrollTop -= 16;
      else if (e.clientY > bounds.bottom - 24) this.scroller.scrollTop += 16;
      const y = e.clientY - this.rowsEl.getBoundingClientRect().top;
      const target = sections.find(row => y >= row.y && y < row.end);
      destination = null; indicator.hidden = true;
      if (!target?.group.id || target.group.id === group.id) return;
      const placement = y < (target.y + target.end) / 2 ? 'before' : 'after';
      destination = { id: target.group.id, placement };
      indicator.style.top = (placement === 'before' ? target.y : target.end) + 'px'; indicator.hidden = false;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      sourceNodes.forEach(el => el.classList.remove('cueflow-group-reordering')); preview?.remove(); indicator.remove();
      this.pointerCleanup = null;
    };
    const cancel = () => cleanup();
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    const end = () => {
      const target = destination; cleanup();
      if (active && target && this.project === project) this.moveGroupTo(group.id, target.id, target.placement);
    };
    this.pointerCleanup = cancel;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
  }
  removeGroup(group) {
    if (!window.confirm('删除分组「' + group.name + '」？其中的泳道和动作会保留，泳道移至「未分组」。')) return;
    this.project.groups = this.project.groups.filter(g => g.id !== group.id);
    for (const lane of this.project.lanes) if (lane.groupId === group.id) lane.groupId = '';
    this.collapsedGroups.delete(''); this.collapsedGroups.delete(group.id); this.recordChange();
  }
  toggleGroup(id) {
    if (this.collapsedGroups.has(id)) this.collapsedGroups.delete(id); else this.collapsedGroups.add(id);
    this.render(true);
  }
  removeLane(lane) {
    if (this.project.lanes.length === 1) return new Notice('至少保留一条泳道');
    if (this.project.cues.some(c => c.laneId === lane.id)) return new Notice('该泳道有动作，请先移动或删除这些动作');
    if (!window.confirm(`删除泳道「${lane.name}」？`)) return;
    this.project.lanes = this.project.lanes.filter(l => l.id !== lane.id); this.recordChange();
  }
  moveLane(id, delta) {
    const arr = this.project.lanes, idx = arr.findIndex(l => l.id === id);
    if (idx < 0) return;
    const peers = arr.filter(l => l.groupId === arr[idx].groupId), peerIndex = peers.findIndex(l => l.id === id), target = peers[peerIndex + delta];
    if (!target) return;
    const dest = arr.indexOf(target);
    [arr[idx], arr[dest]] = [arr[dest], arr[idx]]; this.recordChange();
  }
  moveLaneTo(id, groupId, anchorId = null, placement = 'after') {
    const lanes = this.project.lanes, lane = lanes.find(item => item.id === id);
    if (!lane || anchorId === id) return false;
    if (groupId && !this.project.groups.some(group => group.id === groupId)) return false;
    const rest = lanes.filter(item => item.id !== id);
    let index;
    if (anchorId !== null) {
      const anchorIndex = rest.findIndex(item => item.id === anchorId && item.groupId === groupId);
      if (anchorIndex < 0) return false;
      index = anchorIndex + (placement === 'before' ? 0 : 1);
    } else {
      index = rest.reduce((last, item, i) => item.groupId === groupId ? i + 1 : last, -1);
      if (index < 0) index = rest.length;
    }
    const next = [...rest.slice(0, index), lane, ...rest.slice(index)];
    if (lane.groupId === groupId && next.every((item, i) => item === lanes[i])) return false;
    lane.groupId = groupId; this.project.lanes = next;
    this.collapsedGroups.delete(groupId); this.recordChange(); return true;
  }
  beginLaneDrag(event, lane) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.pointerCleanup?.();
    this.scroller.focus({ preventScroll: true });
    const project = this.project, startX = event.clientX, startY = event.clientY;
    let active = false, destination = null, ghost = null;
    const row = [...this.rowsEl.querySelectorAll('.cueflow-lane-row')].find(el => el.dataset.laneId === lane.id);
    const indicator = this.rowsEl.createDiv({ cls: 'cueflow-lane-drop-line' }); indicator.hidden = true;
    const clearGroupHighlight = () => this.rowsEl.querySelectorAll('.cueflow-group-drop-target').forEach(el => el.classList.remove('cueflow-group-drop-target'));
    const preview = e => {
      if (!active && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      if (!active) {
        active = true; row?.classList.add('cueflow-lane-reordering');
        ghost = document.body.createDiv({ cls: 'cueflow-lane-drag-preview', text: lane.name });
        ghost.style.width = (this.labelWidth - 12) + 'px';
      }
      ghost.style.left = (e.clientX + 12) + 'px'; ghost.style.top = (e.clientY + 10) + 'px';
      const bounds = this.scroller.getBoundingClientRect();
      if (e.clientY < bounds.top + HEADER_HEIGHT + 18) this.scroller.scrollTop -= 16;
      else if (e.clientY > bounds.bottom - 24) this.scroller.scrollTop += 16;
      const y = e.clientY - this.rowsEl.getBoundingClientRect().top;
      const target = this.laneLayout.rows.find(item => y >= item.y && y < item.y + item.height);
      clearGroupHighlight(); indicator.hidden = true; destination = null;
      if (!target) return;
      if (target.kind === 'group') {
        destination = { groupId: target.group.id, anchorId: null, placement: 'after' };
        const header = [...this.rowsEl.querySelectorAll('.cueflow-group-row')].find(el => el.dataset.groupId === target.group.id);
        header?.classList.add('cueflow-group-drop-target');
      } else if (target.lane.id !== lane.id) {
        const placement = y < target.y + target.height / 2 ? 'before' : 'after';
        destination = { groupId: target.lane.groupId, anchorId: target.lane.id, placement };
        indicator.style.top = (target.y + (placement === 'after' ? target.height : 0)) + 'px'; indicator.hidden = false;
      }
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', preview); window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      row?.classList.remove('cueflow-lane-reordering'); clearGroupHighlight(); ghost?.remove(); indicator.remove();
      this.pointerCleanup = null;
    };
    const cancel = () => cleanup();
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    const end = () => {
      const target = destination; cleanup();
      if (active && target && this.project === project) this.moveLaneTo(lane.id, target.groupId, target.anchorId, target.placement);
    };
    this.pointerCleanup = cancel;
    window.addEventListener('pointermove', preview); window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
  }
  openDurationSettings() { new ProjectDurationModal(this).open(); }
  setProjectDuration(seconds) { return this.updateProjectSettings({ name: this.project.name, durationSec: seconds }); }
  updateProjectSettings({ name, durationSec: seconds }) {
    const title = String(name ?? '').trim();
    if (!title) { new Notice('项目名称不能为空'); return false; }
    if (!isInteger(seconds) || seconds < 60 || seconds > 86400) {
      new Notice('总时长请设置为 1 分钟到 24 小时之间'); return false;
    }
    if (seconds < latestCueEnd(this.project)) {
      new Notice('总时长不能早于最后一个动作的结束时间 T+' + fmtTime(latestCueEnd(this.project))); return false;
    }
    if (this.project.durationSec === seconds && this.project.name === title) return true;
    this.project.name = title; this.project.durationSec = seconds;
    if (this.elapsed > seconds) { this.pauseClock(); this.elapsed = seconds; }
    this.recordChange(); return true;
  }
  calculateDuration() {
    return Math.max(this.project.durationSec, latestCueEnd(this.project), 60);
  }
  pauseClock() {
    if (!this.running) return;
    this.elapsed = Math.min(this.calculateDuration(), this.timerBase + (performance.now() - this.timerOrigin) / 1000);
    this.running = false;
    if (this.tickHandle) window.clearInterval(this.tickHandle);
    this.tickHandle = null; this.updateClockUI();
  }
  toggleClock() {
    if (this.running) { this.pauseClock(); return; }
    this.running = true; this.timerBase = this.elapsed; this.timerOrigin = performance.now();
    this.tickHandle = window.setInterval(() => {
      this.elapsed = this.timerBase + (performance.now() - this.timerOrigin) / 1000;
      if (this.elapsed >= this.calculateDuration()) { this.elapsed = this.calculateDuration(); this.pauseClock(); }
      this.updateClockUI();
    }, 100);
    this.updateClockUI();
  }
  updateClockUI() {
    if (this.clockText) this.clockText.setText(`T+${fmtTime(this.elapsed)}`);
    if (this.playBtn) this.playBtn.setText(this.running ? 'Ⅱ 暂停' : '▶ 排练');
    if (this.playhead) this.playhead.style.left = `${this.labelWidth + this.elapsed * this.scale}px`;
    if (this.rulerPlayhead) this.rulerPlayhead.style.left = `${this.elapsed * this.scale}px`;
    if (this.board) {
      this.board.querySelectorAll('.cueflow-cue').forEach(el => {
        const cue = this.project.cues.find(c => c.id === el.dataset.id);
        el.classList.toggle('cueflow-now', !!cue && this.running && cue.durationSec > 0 && this.elapsed >= cue.startSec && this.elapsed < cue.startSec + cue.durationSec);
      });
    }
  }
  resetClock() { this.pauseClock(); this.elapsed = 0; this.updateClockUI(); }
  getProjectFolder() {
    return this.file?.path.includes('/') ? this.file.path.slice(0, this.file.path.lastIndexOf('/')) : this.plugin.settings.folder;
  }
  openProjectFiles(event) {
    const menu=new Menu();
    menu.addItem(i=>i.setTitle('导入项目文件（JSON / Markdown）').setIcon('file-up').onClick(()=>this.chooseProjectFile()));
    menu.addItem(i=>i.setTitle('粘贴 AI 返回的项目').setIcon('clipboard-paste').onClick(()=>new ProjectPasteModal(this).open()));
    menu.addItem(i=>i.setTitle('导出完整项目 / AI 优化文件').setIcon('file-down').onClick(()=>new ProjectExportModal(this).open()));
    menu.showAtMouseEvent(event);
  }
  chooseProjectFile() {
    const input=document.createElement('input');input.type='file';input.accept='.json,.md,.markdown';input.style.display='none';document.body.append(input);
    input.addEventListener('cancel',()=>input.remove(),{once:true});
    input.addEventListener('change',async()=>{
      const file=input.files?.[0];input.remove();if(!file)return;
      try{if(file.size>MAX_PROJECT_FILE_BYTES)throw new Error('项目文件不能超过 5 MB');this.previewProjectImport(await file.text(),file.name);}
      catch(err){new Notice('读取项目文件失败：'+err.message);}
    },{once:true});input.click();
  }
  previewProjectImport(text,filename='项目文件') {
    try {const bundle=parseProjectBundle(text);new ProjectImportModal(this,bundle,filename).open();return true;}
    catch(err){new Notice('无法导入项目：'+err.message,10000);return false;}
  }
  async importProject(project,name,markdownNotes=null,optimizationNotes=[]) {
    try {
      const candidate=validateProject(deepCopy(project));candidate.name=String(name || '').trim();if(!candidate.name)throw new Error('项目名称不能为空');
      const active=this.project;
      this.inlineEdit?.finish(true,true);this.pointerCleanup?.();
      if(this.dirty && !(await this.saveNow()))return false;
      await this.ensureFolder();
      if(this.project!==active)throw new Error('当前项目已切换，请重新导入');
      const folder=this.plugin.settings.folder,base=folder+'/'+filenameFor(candidate.name);let path=base+'.md',index=2;
      while(this.app.vault.getAbstractFileByPath(path))path=base+'-'+(index++)+'.md';
      let content=importedProjectMarkdown(candidate,markdownNotes);
      if(optimizationNotes.length)content+='\n\n## AI 优化说明\n\n'+optimizationNotes.filter(note=>typeof note==='string').map(note=>'- '+note.replace(/`/g,'ˋ').replace(/\r?\n/g,'\n  ')).join('\n')+'\n';
      const file=await this.app.vault.create(path,content);
      await this.refreshFiles();
      const opened=this.project===active && await this.openFile(file);
      new Notice(opened?'项目已导入并保存为新项目':'项目已保存为 '+path+'，可在项目列表打开');return file;
    }catch(err){new Notice('导入项目失败：'+err.message,10000);return false;}
  }
  async exportProjectFile(format='json',goal='',expectedProject=this.project) {
    try {
      if(this.project!==expectedProject)throw new Error('项目已切换，请重新打开导出窗口');
      const snapshot=deepCopy(expectedProject),source=this.file,folder=this.getProjectFolder();let notes=null;
      if(source){const raw=await this.app.vault.read(source),bundle=parseProjectBundle(raw);notes=bundle.markdownNotes;}
      if(this.project!==expectedProject)throw new Error('项目已切换，请重新导出');
      const content=buildProjectFile(snapshot,format,goal,notes);
      if(new TextEncoder().encode(content).byteLength>MAX_PROJECT_FILE_BYTES)throw new Error('导出文件超过 5 MB，请减少项目备注或拆分项目');
      const base=folder+'/'+filenameFor(snapshot.name)+'-AI项目',ext=format==='json'?'.cueflow.json':'.md';let path=base+ext,index=2;
      while(this.app.vault.getAbstractFileByPath(path))path=base+'-'+(index++)+ext;
      const file=await this.app.vault.create(path,content);new Notice('已导出 '+path+'；可交给 AI 优化，再导入返回的完整文件。');return file;
    }catch(err){new Notice('项目导出失败：'+err.message,10000);return false;}
  }
  async exportCSV() {
    try {
      const csv = [['分组', '角色/设备', '动作', '开始(秒)', '结束(秒)', '持续(秒)', '状态', '前置动作', '备注', '关联/目标', '连线标注', '关键动作']];
      const byId = new Map(this.project.cues.map(c => [c.id, c.name]));
      const laneMap = new Map(this.project.lanes.map(l => [l.id, l]));
      for (const c of [...this.project.cues].sort((a, b) => a.startSec - b.startSec)) csv.push([laneGroupName(this.project, laneMap.get(c.laneId)), laneMap.get(c.laneId)?.name, c.name, c.startSec, c.startSec + c.durationSec, c.durationSec, c.status, c.dependsOn.map(id => byId.get(id) || id).join('; '), c.note, (this.project.relations || []).filter(edge => edge.from === c.id || edge.to === c.id).map(edge => (edge.from === c.id ? '→ ' + byId.get(edge.to) : '← ' + byId.get(edge.from)) + (edge.label ? '：' + edge.label : '')).join('; '), projectConnections(this.project).filter(edge => edge.from === c.id && edge.label).map(edge => (edge.kind === 'dependency' ? '依赖 → ' : '关联 → ') + byId.get(edge.to) + '：' + edge.label).join('; ')]);
      const exportedCues = [...this.project.cues].sort((a,b) => a.startSec-b.startSec);
      csv.slice(1).forEach((row,index) => row.push(exportedCues[index].critical ? '是' : '否'));
      csv[0].push('同步关系');csv.slice(1).forEach((row,index)=>{const cue=exportedCues[index];row.push((this.project.syncLinks || []).filter(e=>e.from===cue.id || e.to===cue.id).map(e=>(e.mode==='start'?'同时开始':'同时结束')+' ↔ '+byId.get(e.from===cue.id?e.to:e.from)+(e.label?'：'+e.label:'')).join('; '));});
      const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const content = '\ufeff' + csv.map(row => row.map(escape).join(',')).join('\r\n');
      const base = `${this.getProjectFolder()}/${filenameFor(this.project.name)}-调度表`;
      let path = `${base}.csv`, i = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${base}-${i++}.csv`;
      await this.app.vault.create(path, content); new Notice(`已导出 ${path}`);
    } catch (err) { new Notice(`导出失败：${err.message}`); }
  }
  async exportSVG() {
    try {
      const scale = Math.max(1.4, Math.min(6, this.scale)), startX = 190, topY = 120, rowH = 72;
      const duration = this.calculateDuration();
      const layout = buildLaneLayout(this.project, new Set(), rowH);
      const w = Math.ceil(startX + duration * scale + 65), h = topY + layout.height + 38;
      const fragments = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
        `<rect width="100%" height="100%" fill="#fff"/>`,
        `<text x="24" y="38" font-family="sans-serif" font-size="24" font-weight="bold" fill="#1c2734">${xmlEscape(this.project.name)}</text>`,
        `<text x="24" y="62" font-family="sans-serif" font-size="13" fill="#697688">CueFlow · 相对时间调度 · T+00:00</text>`];
      const timeStep = [5, 10, 15, 30, 60, 120, 300, 600].find(t => t * scale >= 65) || 600;
      for (let sec=0;sec<=duration;sec+=timeStep) {
        const x = startX + sec * scale;
        fragments.push(`<line x1="${x}" y1="${topY-18}" x2="${x}" y2="${h-30}" stroke="#e6ebf1"/>`,
          `<text x="${x+5}" y="${topY-25}" font-size="12" font-family="sans-serif" fill="#607083">${fmtTime(sec)}</text>`);
      }
      const laneMap = new Map(this.project.lanes.map(lane => [lane.id, lane]));
      for (const row of layout.rows) {
        const y = topY + row.y;
        if (row.kind === 'group') {
          fragments.push(`<rect x="0" y="${y}" width="${w}" height="${row.height}" fill="#e8edf5"/>`,
            `<text x="22" y="${y+24}" font-size="14" font-weight="bold" font-family="sans-serif" fill="#334155">${xmlEscape(row.group.name)} · ${row.lanes.length}</text>`);
          continue;
        }
        const lane = row.lane;
        fragments.push(`<rect x="0" y="${y}" width="${w}" height="${rowH}" fill="#ffffff"/>`,
          `<line x1="0" y1="${y+rowH}" x2="${w}" y2="${y+rowH}" stroke="#e4e9ef"/>`,
          `<rect x="21" y="${y+19}" width="6" height="30" rx="3" fill="${lane.color}"/>`,
          `<text x="39" y="${y+39}" font-size="14" font-family="sans-serif" fill="#1f2937">${xmlEscape(lane.name)}</text>`);
      }
      for (let sec=0;sec<=duration;sec+=timeStep) {
        const x = startX+sec*scale;
        fragments.push(`<line x1="${x}" y1="${topY}" x2="${x}" y2="${topY+layout.height}" stroke="#e6ebf1"/>`);
      }
      const cardFragments=[];
      for (const c of this.project.cues) {
        const y = topY+layout.laneY.get(c.laneId)+23, x=startX+c.startSec*scale;
        const lane = laneMap.get(c.laneId);
        cardFragments.push('<g><title>' + xmlEscape(c.name + ' · T+' + fmtTime(c.startSec) + ' · ' + c.note) + '</title>');
        if (!c.durationSec) {
          cardFragments.push(`<polygon points="${x+9},${y+2} ${x+18},${y+15} ${x+9},${y+28} ${x},${y+15}" fill="${lane.color}"/>`,
            `<text x="${x+15}" y="${y+18}" font-size="12" font-family="sans-serif" fill="#283442">${xmlEscape(c.name)}</text>`);
        } else {
          const bw=Math.max(20,c.durationSec*scale);
          cardFragments.push(`<rect x="${x}" y="${y}" width="${bw}" height="30" rx="5" fill="${lane.color}"/>`,
            `<text x="${x+6}" y="${y+19}" font-size="12" font-family="sans-serif" fill="#fff">${xmlEscape(c.name.length > Math.max(4,Math.floor(bw/13)) ? c.name.slice(0,Math.max(3,Math.floor(bw/13))-1)+'…' : c.name)}</text>`);
        }
        if (c.critical) cardFragments.push(`<text x="${x+3}" y="${y-2}" font-size="14" font-family="sans-serif" fill="#9a6700" stroke="#fff" stroke-width="3" paint-order="stroke"><title>关键动作</title>★</text>`);
        cardFragments.push('</g>');
      }
      const boxes = connectionRects(this.project, layout, scale, 30, 23);
      const exportColors={dependency:'#5742c7',relation:'#087f87','sync-start':'#b87312','sync-end':'#b87312'};
      const svgMarker=(id,kind,size=10)=>'<marker id="'+id+'" markerWidth="'+size+'" markerHeight="'+size+'" viewBox="0 0 10 10" refX="9" refY="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="'+(kind.startsWith('sync-')?'M1,5 L5,1 L9,5 L5,9 Z':'M1,1 L9,5 L1,9 Z')+'" fill="'+exportColors[kind]+'"/></marker>';
      fragments.push('<defs>',...CONNECTION_KINDS.map(kind=>svgMarker('export-'+kind,kind)),'</defs>');
      fragments.push('<g data-layer="connections" transform="translate(' + startX + ',' + topY + ')">');
      projectConnections(this.project).forEach((edge, index) => {
        const route = routeConnection(edge, boxes, index); if (!route) return;
        const related = edge.kind === 'relation', color = exportColors[edge.kind],markerId='export-'+edge.kind+'-'+index;
        fragments.push('<defs>'+svgMarker(markerId,edge.kind,route.arrowSize<9?route.arrowSize+1:10)+'</defs>');
        fragments.push('<g data-kind="' + edge.kind + '"><path d="' + route.d + '" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>',
          '<path d="' + route.d + '" fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' + (related ? ' stroke-dasharray="6 4"' : '') + ' marker-end="url(#' + markerId + ')"'+(edge.kind.startsWith('sync-')?' marker-start="url(#'+markerId+')"':'')+'/>');
        if(route.arrowGuide)fragments.push('<path d="'+roundedPath(route.arrowGuide)+'" fill="none" stroke="'+color+'" stroke-width="2" marker-end="url(#'+markerId+')"/>');
        if (edge.label) {
          const a = route.points[Math.floor((route.points.length - 1) / 2)];
          fragments.push('<text x="' + (a.x + 6) + '" y="' + (a.y - 6) + '" font-size="11" font-family="sans-serif" fill="' + color + '" stroke="#fff" stroke-width="4" paint-order="stroke">' + xmlEscape(edge.label) + '</text>');
        }
        fragments.push('</g>');
      });
      fragments.push('</g>');
      fragments.push('<g data-layer="actions">',...cardFragments,'</g>');
      fragments.push('</svg>');
      const base = `${this.getProjectFolder()}/${filenameFor(this.project.name)}-甘特图`;
      let path = `${base}.svg`, n=2;
      while (this.app.vault.getAbstractFileByPath(path)) path=`${base}-${n++}.svg`;
      await this.app.vault.create(path, fragments.join('\n'));
      new Notice(`已导出 ${path}，可作为矢量图插入演示文稿`);
    } catch (err) { new Notice(`SVG 导出失败：${err.message}`); }
  }
  render(preserveScroll = false) {
    if (!this.project) return;
    this.projectNameCommit?.(true);
    this.pointerCleanup?.();
    this.inlineEdit?.finish(true, true);
    if (this.selectedId && !this.project.cues.some(cue => cue.id === this.selectedId)) this.selectedId = null;
    this.selectedIds = this.getSelectedCueIds();
    if (this.selectedConnectionId && !projectConnections(this.project).some(edge => edge.id === this.selectedConnectionId)) this.selectedConnectionId = null;
    const prev = this.scroller, x = preserveScroll ? prev?.scrollLeft || 0 : 0, y = preserveScroll ? prev?.scrollTop || 0 : 0;
    const focused = document.activeElement === this.scroller;
    const root = this.contentEl; root.empty(); root.addClass('cueflow-root');
    const compact = this.density === 'compact';
    root.classList.toggle('cueflow-compact', compact);
    this.rowHeight = compact ? 40 : ROW_HEIGHT; this.groupHeight = compact ? 28 : GROUP_HEIGHT;
    this.scale = clamp(this.scale, ZOOMS[0]/60, ZOOMS[ZOOMS.length - 1]/60);
    const top = root.createDiv({ cls: 'cueflow-toolbar' });
    const brand = top.createDiv({ cls: 'cueflow-brand' }); brand.createSpan({ text: '◈', cls: 'cueflow-brand-symbol' }); brand.createSpan({ text: 'CueFlow' });
    const picker = top.createDiv({ cls: 'cueflow-project-picker' }); this.projectPickerEl = picker;
    const nameInput = picker.createEl('input', { type:'text', cls:'cueflow-project-name', attr:{'aria-label':'项目名称',title:'直接编辑项目名称；Enter 或移开焦点保存，Esc 取消'} });
    this.projectNameInput = nameInput; nameInput.value = this.project.name;
    const namingProject = this.project; let committedName = this.project.name;
    const commitName = fromBlur => {
      if (this.project !== namingProject || nameInput.value === committedName) return true;
      if (this.renameProject(nameInput.value)) { nameInput.value = this.project.name; committedName = this.project.name; return true; }
      if (fromBlur) { nameInput.value = this.project.name; committedName = this.project.name; }
      return false;
    };
    this.projectNameCommit = commitName;
    nameInput.addEventListener('blur', () => commitName(true));
    nameInput.addEventListener('keydown', e => {
      e.stopPropagation(); if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); if (commitName(false)) this.scroller.focus({preventScroll:true}); }
      if (e.key === 'Escape') { e.preventDefault(); nameInput.value = this.project.name; this.scroller.focus({preventScroll:true}); }
    });
    const switcher = select(picker, this.projectOptions(), this.file?.path, async path => {
      const file = this.files.find(f => f.path === path); if (file && !(await this.openFile(file))) switcher.value = this.file?.path || '';
    }, '切换项目'); switcher.addClass('cueflow-project-switch');
    btn(top, '+ 项目', () => new StringModal(this.app, '新建脚本项目', '项目名称', '新演示脚本', n => this.createProject(n)).open());
    btn(top, '项目设置', () => new ProjectDurationModal(this, true).open());
    btn(top, '显示设置', () => new DisplaySettingsModal(this).open());
    btn(top, '+ 分组', () => this.addGroup());
    btn(top, '+ 泳道', () => this.addLane());
    btn(top, '+ 动作', () => {
      const lane = buildLaneLayout(this.project).rows.find(r => r.kind === 'lane')?.lane;
      if (lane) this.addCue(lane.id, 0, 60); else new Notice('请先新建泳道');
    }, 'cueflow-primary');
    const second = root.createDiv({ cls: 'cueflow-subbar' });
    btn(second, '总时长 ' + fmtTime(this.calculateDuration()), () => this.openDurationSettings(), 'cueflow-small cueflow-duration');
    second.createSpan({ text: this.project.name, cls: 'cueflow-project-title' });
    second.createSpan({ text: `${this.project.groups.length} 个分组 · ${this.project.lanes.length} 条泳道 · ${this.project.cues.length} 个动作`, cls: 'cueflow-muted' });
    second.createSpan({ cls: 'cueflow-space' });
    second.createSpan({ text: '吸附', cls: 'cueflow-muted' });
    select(second, STEPS.map(s => [s, `${s}秒`]), this.snap, val => { this.snap = Number(val); this.plugin.settings.snapSeconds = this.snap; void this.plugin.saveSettings(); }, '拖拽吸附步长');
    btn(second, '−', () => this.setZoom(-1), 'cueflow-small');
    second.createSpan({ text: `${Math.round(this.scale * 60)}px/分`, cls: 'cueflow-zoom-text' });
    btn(second, '+', () => this.setZoom(1), 'cueflow-small');
    btn(second, '适应窗口', () => this.fitTimeline(), 'cueflow-small');
    btn(second, compact ? '紧凑显示 ✓' : '紧凑显示', () => this.setDensity(compact ? 'standard' : 'compact'), 'cueflow-small');
    btn(second, '撤销', () => this.undo(), 'cueflow-small');
    btn(second, '重做', () => this.redo(), 'cueflow-small');
    btn(second, this.autoSchedule ? '依赖顺延 ✓' : '手动排期', () => { this.autoSchedule = !this.autoSchedule; this.plugin.settings.autoSchedule = this.autoSchedule; void this.plugin.saveSettings(); this.render(true); }, 'cueflow-small');
    btn(second, '导出 CSV', () => this.exportCSV(), 'cueflow-small');
    btn(second, '导出 SVG', () => this.exportSVG(), 'cueflow-small');
    btn(second, '导入 / 导出', e => this.openProjectFiles(e), 'cueflow-small');
    const clock = root.createDiv({ cls: 'cueflow-clockbar' });
    this.clockText = clock.createEl('strong', { text: `T+${fmtTime(this.elapsed)}`, cls: 'cueflow-clock' });
    this.playBtn = btn(clock, this.running ? 'Ⅱ 暂停' : '▶ 排练', () => this.toggleClock(), 'cueflow-primary');
    btn(clock, '↺ 归零', () => this.resetClock());
    clock.createSpan({ text: '空白拖框多选 · Ctrl+C 复制 / Ctrl+V 在鼠标位置粘贴 · 左左同时开始 / 右右同时结束 · 双击改标题', cls: 'cueflow-help' });
    const legend = clock.createSpan({ cls: 'cueflow-link-legend' });
    legend.createSpan({ cls: 'cueflow-legend-dependency', text: '实线 → 依赖' }); legend.createSpan({ cls: 'cueflow-legend-relation', text: '虚线 ⇢ 关联 / 目标' });
    legend.createSpan({cls:'cueflow-legend-sync',text:'橙线 ↔ 同步'});
    const scroll = root.createDiv({ cls: 'cueflow-scroller', attr: { tabindex: '0', 'aria-label': 'CueFlow 调度时间轴' } });
    this.scroller = scroll;
    this.duration = this.calculateDuration();
    const width = Math.ceil(this.duration * this.scale); this.timelineWidth = width;
    const board = scroll.createDiv({ cls: 'cueflow-board' }); this.board = board;
    board.style.width = `${this.labelWidth + width}px`;
    const topRow = board.createDiv({ cls: 'cueflow-heading' }); topRow.style.height = `${HEADER_HEIGHT}px`;
    const first = topRow.createDiv({ cls: 'cueflow-heading-left', text: '执行人员 / 设备' }); first.style.width = `${this.labelWidth}px`;
    const resizer = first.createDiv({ cls: 'cueflow-column-resizer', attr: {
      role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': '调整执行人员和设备列宽',
      'aria-valuemin': '160', 'aria-valuemax': '600', 'aria-valuenow': String(this.labelWidth), title: '左右拖动调整列宽；双击恢复默认' } });
    resizer.addEventListener('pointerdown', e => this.beginColumnResize(e));
    resizer.addEventListener('dblclick', e => { e.preventDefault(); this.setLabelWidth(LABEL_WIDTH); });
    resizer.addEventListener('keydown', e => {
      let value;
      if (e.key === 'ArrowLeft') value = this.labelWidth - (e.shiftKey ? 50 : 10);
      if (e.key === 'ArrowRight') value = this.labelWidth + (e.shiftKey ? 50 : 10);
      if (e.key === 'Home') value = 160;
      if (e.key === 'End') value = 600;
      if (value !== undefined) { e.preventDefault(); this.setLabelWidth(value); }
    });
    const ruler = topRow.createDiv({ cls: 'cueflow-ruler' }); ruler.style.width = `${width}px`;
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const tickStep = candidates.find(n => n * this.scale >= 67) || 3600;
    for (let sec = 0; sec <= this.duration; sec += tickStep) {
      const tick = ruler.createDiv({ cls: 'cueflow-tick', text: `T+${fmtTime(sec)}` }); tick.style.left = `${sec * this.scale}px`;
    }
    this.rulerPlayhead = ruler.createDiv({ cls: 'cueflow-ruler-now' });
    const rows = board.createDiv({ cls: 'cueflow-rows' }); this.rowsEl = rows;
    const layout = buildLaneLayout(this.project, this.collapsedGroups, this.rowHeight, this.groupHeight); this.laneLayout = layout;
    this.selectedIds = new Set([...this.selectedIds].filter(id => layout.laneY.has(this.project.cues.find(c => c.id === id)?.laneId)));
    if (!this.selectedIds.has(this.selectedId)) this.selectedId = this.selectedIds.values().next().value || null;
    rows.style.minHeight = layout.height + 'px';
    for (const item of layout.rows) {
      if (item.kind === 'group') {
        const group = item.group;
        const row = rows.createDiv({ cls: 'cueflow-group-row' }); row.style.height = this.groupHeight + 'px';
        row.dataset.groupId = group.id;
        const label = row.createDiv({ cls: 'cueflow-group-label' }); label.style.width = this.labelWidth + 'px';
        if (group.id) {
          const handle = label.createSpan({ cls: 'cueflow-group-drag-handle', text: '⠿',
            attr: { role: 'button', tabindex: '0', title: '拖动整个分组及其全部泳道和动作', 'aria-label': '拖动分组 ' + group.name } });
          handle.addEventListener('pointerdown', e => this.beginGroupDrag(e, group));
          handle.addEventListener('keydown', e => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.moveGroup(group.id, e.key === 'ArrowUp' ? -1 : 1); }
          });
        }
        const toggle = btn(label, (this.collapsedGroups.has(group.id) ? '▸ ' : '▾ ') + group.name, () => this.toggleGroup(group.id), 'cueflow-group-toggle');
        toggle.setAttribute('aria-expanded', String(!this.collapsedGroups.has(group.id)));
        toggle.setAttribute('title', group.name + ' · ' + item.lanes.length + ' 条泳道');
        label.createSpan({ text: String(item.lanes.length), cls: 'cueflow-group-count' });
        const add = btn(label, '+', () => this.addLane(group.id), 'cueflow-iconbtn'); add.setAttribute('title', '在此分组新建泳道');
        if (group.id) {
          const options = btn(label, '⋯', e => this.openGroupMenu(group, e), 'cueflow-iconbtn'); options.setAttribute('title', '分组选项');
        }
        const band = row.createDiv({ cls: 'cueflow-group-band' }); band.style.width = width + 'px';
        continue;
      }
      const lane = item.lane;
      const row = rows.createDiv({ cls: 'cueflow-lane-row' }); row.style.height = `${this.rowHeight}px`; row.dataset.laneId = lane.id;
      const label = row.createDiv({ cls: 'cueflow-lane-label' }); label.style.width = `${this.labelWidth}px`;
      const handle = label.createSpan({ cls: 'cueflow-lane-drag-handle', text: '⠿',
        attr: { role: 'button', tabindex: '0', title: '拖动泳道上下排序或跨组移动；拖到分组标题可移入组末', 'aria-label': '拖动泳道 ' + lane.name } });
      handle.addEventListener('pointerdown', e => this.beginLaneDrag(e, lane));
      handle.addEventListener('keydown', e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.moveLane(lane.id, e.key === 'ArrowUp' ? -1 : 1); }
      });
      const color = label.createSpan({ cls: 'cueflow-lane-color' }); color.style.backgroundColor = lane.color;
      const name = label.createSpan({ text: lane.name, cls: 'cueflow-lane-name' }); name.setAttribute('title', '双击编辑名称和分组：' + lane.name);
      name.addEventListener('dblclick', () => this.renameLane(lane));
      const options = label.createSpan({ cls: 'cueflow-lane-buttons' });
      btn(options, '+', () => this.addCue(lane.id, this.elapsed, 60), 'cueflow-iconbtn');
      const settingsButton = btn(options, '⋯', e => this.openLaneMenu(lane, e), 'cueflow-iconbtn');
      settingsButton.setAttribute('title', '泳道选项');
      const track = row.createDiv({ cls: 'cueflow-track' }); track.style.width = `${width}px`;
      track.style.setProperty('--cueflow-grid', `${tickStep * this.scale}px`);
      track.addEventListener('dblclick', e => {
        if (e.button !== 0 || e.target !== track) return;
        e.preventDefault(); e.stopPropagation();
        this.createCueAt(lane.id, (e.clientX - track.getBoundingClientRect().left) / this.scale);
      });
      for (const cue of this.project.cues.filter(c => c.laneId === lane.id).sort((a, b) => a.startSec - b.startSec)) this.renderCue(track, cue, lane);
    }
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('cueflow-links');
    svg.style.cssText = `left:${this.labelWidth}px;top:0px;width:${width}px;height:${layout.height}px`;
    svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(1, layout.height)}`);
    svg.setAttribute('aria-hidden', 'true'); rows.appendChild(svg);
    this.drawLinks(svg);
    this.renderSelectionBox();
    this.playhead = board.createDiv({ cls: 'cueflow-playhead' });
    this.playhead.style.height = `${HEADER_HEIGHT + layout.height}px`;
    this.footerEl = root.createDiv({ cls: 'cueflow-footer' }); this.renderFooter();
    scroll.scrollLeft = x; scroll.scrollTop = y;
    if (focused) scroll.focus({ preventScroll: true });
    scroll.addEventListener('keydown', e => this.handleCanvasKeydown(e));
    scroll.addEventListener('pointermove',e=>{this.canvasPointer={x:e.clientX,y:e.clientY};});
    scroll.addEventListener('pointerleave',()=>{this.canvasPointer=null;});
    scroll.addEventListener('pointerdown', e => this.beginMarquee(e));
    scroll.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); this.setZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.updateClockUI();
  }
  renderFooter() {
    const footer = this.footerEl; if (!footer) return; footer.empty();
    const selected = this.getSelectedCueIds(), selectedCues = this.project.cues.filter(c => selected.has(c.id));
    const current = this.project.cues.find(c => c.id === this.selectedId);
    if (selectedCues.length > 1) {
      const start = Math.min(...selectedCues.map(c => c.startSec)), end = Math.max(...selectedCues.map(c => c.startSec + c.durationSec));
      footer.createEl('strong', { text: '已选中 ' + selectedCues.length + ' 个动作' });
      footer.createSpan({ text: `T+${fmtTime(start)} – ${fmtTime(end)} · 拖动作整体移动，拖选框两端等比例拉伸` });
      btn(footer, selectedCues.every(c => c.critical) ? '★ 取消关键标记' : '☆ 标为关键动作', e => { e.stopPropagation(); this.setSelectionCritical(); });
      btn(footer, '删除所选', () => this.deleteCues(selected));
    } else if (current) {
      footer.createEl('strong', { text: current.name });
      footer.createSpan({ text: `T+${fmtTime(current.startSec)} – ${fmtTime(current.startSec + current.durationSec)} · ${fmtTime(current.durationSec)} · ${this.project.lanes.find(l => l.id === current.laneId)?.name || ''}` });
      btn(footer, '编辑详情', () => new CueModal(this, current).open());
      btn(footer, current.critical ? '★ 取消关键标记' : '☆ 标为关键动作', e => { e.stopPropagation(); this.setSelectionCritical(); });
      btn(footer, '删除', () => this.deleteCue(current.id));
    } else if (this.selectedConnectionId && projectConnections(this.project).some(edge => edge.id === this.selectedConnectionId)) {
      const edge = projectConnections(this.project).find(item => item.id === this.selectedConnectionId);
      const names = new Map(this.project.cues.map(cue => [cue.id, cue.name]));
      footer.createEl('strong', { text: connectionName(edge.kind) + '：' + names.get(edge.from) + (edge.kind.startsWith('sync-')?' ↔ ':' → ') + names.get(edge.to) });
      if (edge.label) footer.createSpan({ text: edge.label });
      btn(footer, '文字标注', () => this.editConnection(edge.id));
      btn(footer, '删除连线', () => this.removeConnection(edge.id));
    } else footer.createSpan({ text: '提示：空白拖框多选，Ctrl/Shift 加选；点击空白或 Esc 取消选中；双击改标题，右键编辑详情；Ctrl+Z 撤销。' });
    this.saveStatusEl = footer.createSpan({ cls: 'cueflow-save-status' });
    this.recoveryActions = footer.createSpan({ cls: 'cueflow-recovery-actions' });
    btn(this.recoveryActions, '重试保存', () => this.saveNow(), 'cueflow-small');
    btn(this.recoveryActions, '保存为副本', () => this.saveRecoveryCopy(), 'cueflow-small');
    btn(this.recoveryActions, '重新读取', () => {
      if (window.confirm('重新读取会放弃当前未保存的修改。需要保留时，请先保存为副本。')) this.openFile(this.file, true);
    }, 'cueflow-small');
    this.updateSaveStatus();
  }
  getSelectedCueIds() {
    if (!this.selectedId || !this.project) return new Set();
    const ids = new Set(this.selectedIds || []); ids.add(this.selectedId);
    return new Set([...ids].filter(id => this.project.cues.some(c => c.id === id)));
  }
  selectCue(id, mode = 'replace') {
    const ids = mode === 'replace' ? new Set() : this.getSelectedCueIds();
    if (mode === 'toggle' && ids.has(id)) ids.delete(id); else ids.add(id);
    this.selectCues(ids, ids.has(id) ? id : null);
  }
  selectCues(ids, primary = null) {
    this.selectedIds = new Set([...ids].filter(id => this.project.cues.some(c => c.id === id)));
    this.selectedId = this.selectedIds.has(primary) ? primary : this.selectedIds.values().next().value || null;
    this.selectedConnectionId = null;
    this.board?.querySelectorAll('.cueflow-cue').forEach(el => el.classList.toggle('cueflow-selected', this.selectedIds.has(el.dataset.id)));
    this.updateConnectionFocus(); this.renderSelectionBox(); this.renderFooter();
  }
  swallowGestureClick(event) {
    const last = this.gestureClick; this.gestureClick = null;
    return !!last && Date.now() < last.until && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 6;
  }
  renderSelectionBox(override = null) {
    this.rowsEl?.querySelector('.cueflow-selection-box')?.remove();
    const selected = this.getSelectedCueIds(); if (selected.size < 2 || !this.rowsEl) return;
    const boxes = [...this.getConnectionRects(override)].filter(([id]) => selected.has(id)).map(([, box]) => box);
    if (boxes.length < 2) return;
    const left = Math.min(...boxes.map(b => b.x)), right = Math.max(...boxes.map(b => b.x + b.w));
    const top = Math.min(...boxes.map(b => b.y)), bottom = Math.max(...boxes.map(b => b.y + b.h));
    const box = this.rowsEl.createDiv({ cls: 'cueflow-selection-box' });
    box.style.cssText = `left:${this.labelWidth + left - 5}px;top:${top - 5}px;width:${right-left+10}px;height:${bottom-top+10}px`;
    box.createSpan({ cls: 'cueflow-selection-count', text: selected.size + ' 个动作' });
    const span = this.project.cues.filter(c => selected.has(c.id));
    if (Math.max(...span.map(c => c.startSec+c.durationSec)) <= Math.min(...span.map(c => c.startSec))) return;
    for (const side of ['left', 'right']) {
      const handle = box.createSpan({ cls: 'cueflow-selection-handle cueflow-selection-' + side, attr: { role:'button', tabindex:'-1', title:'拖动整体' + (side === 'left' ? '起点' : '终点') + '，等比例拉伸所选动作', 'aria-label':'整体拉伸' + (side === 'left' ? '起点' : '终点') } });
      handle.addEventListener('pointerdown', e => this.beginMultiMove(e, 'resize-' + side));
      handle.addEventListener('click', e => { e.stopPropagation(); this.swallowGestureClick(e); });
      handle.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); });
    }
  }
  startCanvasAutoScroll(point, update) {
    const timer = window.setInterval(() => {
      const p = point(); if (!p) return;
      const r = this.scroller.getBoundingClientRect(), oldX = this.scroller.scrollLeft, oldY = this.scroller.scrollTop;
      if (p.clientX > r.right - 28) this.scroller.scrollLeft += 18;
      else if (p.clientX < r.left + this.labelWidth + 28) this.scroller.scrollLeft -= 18;
      if (p.clientY > r.bottom - 28) this.scroller.scrollTop += 14;
      else if (p.clientY < r.top + HEADER_HEIGHT + 28) this.scroller.scrollTop -= 14;
      if (oldX !== this.scroller.scrollLeft || oldY !== this.scroller.scrollTop) update(p);
    }, 40);
    return () => window.clearInterval(timer);
  }
  beginMarquee(event) {
    if (event.button !== 0 || event.target?.closest?.('.cueflow-cue,.cueflow-link-hit,.cueflow-selection-handle,button,input,select,.cueflow-lane-label,.cueflow-group-label,.cueflow-heading')) return;
    const rect = this.rowsEl.getBoundingClientRect();
    if (event.clientX < this.scroller.getBoundingClientRect().left + this.labelWidth || event.clientY < rect.top) return;
    event.preventDefault(); event.stopPropagation(); this.inlineEdit?.finish(true, true); this.pointerCleanup?.(); this.scroller.focus({preventScroll:true});
    const initial = this.getSelectedCueIds(), additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const point = e => { const r = this.rowsEl.getBoundingClientRect(); return { x:clamp(e.clientX-r.left-this.labelWidth,0,this.timelineWidth), y:clamp(e.clientY-r.top,0,this.laneLayout.height) }; };
    const start = point(event), boxes = this.getConnectionRects(); let moved = false, frame = null, last = null;
    const move = e => {
      if (!moved && Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY) < 4) return;
      moved = true; last = {clientX:e.clientX,clientY:e.clientY};
      if (!frame) frame = this.rowsEl.createDiv({cls:'cueflow-marquee',attr:{'aria-hidden':'true'}});
      const end = point(e), area = {left:Math.min(start.x,end.x),right:Math.max(start.x,end.x),top:Math.min(start.y,end.y),bottom:Math.max(start.y,end.y)};
      frame.style.cssText = `left:${this.labelWidth+area.left}px;top:${area.top}px;width:${area.right-area.left}px;height:${area.bottom-area.top}px`;
      this.selectCues([...(additive ? initial : []),...cuesInMarquee(boxes,area)]);
    };
    const stopScroll = this.startCanvasAutoScroll(() => last, move);
    const cleanup = () => { stopScroll(); window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',end); window.removeEventListener('pointercancel',cancel); window.removeEventListener('keydown',key); frame?.remove(); this.pointerCleanup = null; };
    const end = e => { cleanup(); if (moved) this.gestureClick = {x:e.clientX,y:e.clientY,until:Date.now()+350}; };
    const cancel = () => { cleanup(); this.selectCues(initial); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    this.pointerCleanup = cancel; window.addEventListener('pointermove',move); window.addEventListener('pointerup',end); window.addEventListener('pointercancel',cancel); window.addEventListener('keydown',key);
  }
  beginMultiMove(event, kind = 'move', anchorId = this.selectedId) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.pointerCleanup?.(); this.inlineEdit?.finish(true,true); this.scroller.focus({preventScroll:true});
    const ids = this.getSelectedCueIds(), project = this.project, original = project.cues.filter(c => ids.has(c.id));
    if (original.length < 2) return;
    const laneOrder = this.laneLayout.rows.filter(r => r.kind === 'lane').map(r => r.lane.id), anchor = original.find(c => c.id === anchorId) || original[0];
    const startX = event.clientX-this.rowsEl.getBoundingClientRect().left;
    const cards = [...this.rowsEl.querySelectorAll('.cueflow-cue')].filter(el => ids.has(el.dataset.id));
    const styles = new Map(cards.map(el => [el.dataset.id,{css:el.style.cssText,title:el.getAttribute('title')}]));
    let moved = false, last = null, drafts = original, guides = null;
    const move = e => {
      if (!moved && Math.hypot(e.clientX-event.clientX,kind === 'move' ? e.clientY-event.clientY : 0) < 4) return;
      moved = true; last = {clientX:e.clientX,clientY:e.clientY};
      const delta = Math.round(((e.clientX-this.rowsEl.getBoundingClientRect().left-startX)/this.scale)/this.snap)*this.snap;
      const target = laneAtY(this.laneLayout,e.clientY-this.rowsEl.getBoundingClientRect().top);
      const laneDelta = kind === 'move' && target ? laneOrder.indexOf(target.lane.id)-laneOrder.indexOf(anchor.laneId) : 0;
      drafts = transformCueSelection(project,ids,kind,delta,laneDelta,laneOrder,this.autoSchedule);
      const preview = new Map(drafts.map(c => [c.id,c]));
      for (const card of cards) {
        const cue = preview.get(card.dataset.id), old = original.find(c => c.id === cue.id);
        card.classList.add('cueflow-dragging'); card.style.left = cue.startSec*this.scale+'px'; card.style.width = Math.max(cue.durationSec ? 20 : 18,cue.durationSec*this.scale)+'px';
        card.style.transform = `translateY(${this.laneLayout.laneY.get(cue.laneId)-this.laneLayout.laneY.get(old.laneId)}px)`;
        card.setAttribute('title',cue.name+' · T+'+fmtTime(cue.startSec)+' / '+fmtTime(cue.durationSec));
      }
      this.drawLinks(this.rowsEl.querySelector('.cueflow-links'),preview); this.renderSelectionBox(preview);
      if (!guides) guides = this.rowsEl.createDiv({cls:'cueflow-alignment-guides',attr:{'aria-hidden':'true'}});
      this.drawAlignmentGuides(preview.get(anchor.id),kind,guides,ids);
    };
    const stopScroll = this.startCanvasAutoScroll(() => last,move);
    const cleanup = () => { stopScroll(); window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',end); window.removeEventListener('pointercancel',cancel); window.removeEventListener('keydown',key); guides?.remove(); this.pointerCleanup = null; };
    const restore = () => { for (const card of cards) { card.classList.remove('cueflow-dragging'); card.style.cssText = styles.get(card.dataset.id).css; card.setAttribute('title',styles.get(card.dataset.id).title); } this.drawLinks(this.rowsEl.querySelector('.cueflow-links')); this.renderSelectionBox(); };
    const end = e => { cleanup(); if (moved) { this.gestureClick = {x:e.clientX,y:e.clientY,until:Date.now()+350}; const changed = drafts.some(c => { const old = original.find(o => o.id === c.id); return c.startSec !== old.startSec || c.durationSec !== old.durationSec || c.laneId !== old.laneId; }); if (!changed || !this.saveCueBatch(drafts,true)) restore(); } };
    const cancel = () => { cleanup(); restore(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    this.pointerCleanup = cancel; window.addEventListener('pointermove',move); window.addEventListener('pointerup',end); window.addEventListener('pointercancel',cancel); window.addEventListener('keydown',key);
  }
  setLabelWidth(value, persist = true) {
    const requested = Number(value);
    this.railWidth = Math.round(clamp(Number.isFinite(requested) ? requested : LABEL_WIDTH, 160, 600));
    if (this.board) {
      this.board.style.width = (this.labelWidth + this.timelineWidth) + 'px';
      this.board.querySelectorAll('.cueflow-heading-left,.cueflow-group-label,.cueflow-lane-label').forEach(el => el.style.width = this.labelWidth + 'px');
      const links = this.rowsEl.querySelector('.cueflow-links'); if (links) links.style.left = this.labelWidth + 'px';
      this.board.querySelector('.cueflow-column-resizer')?.setAttribute('aria-valuenow', String(this.labelWidth));
      this.updateClockUI();
    }
    this.renderSelectionBox();
    if (persist) {
      this.plugin.settings.labelWidth = this.labelWidth;
      for (const leaf of this.app.workspace?.getLeavesOfType(VIEW_TYPE) || []) if (leaf.view !== this && leaf.view.plugin === this.plugin) leaf.view.setLabelWidth(this.labelWidth, false);
      void this.plugin.saveSettings();
    }
  }
  beginColumnResize(event) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); this.pointerCleanup?.();
    const initial = this.labelWidth, x = event.clientX;
    this.contentEl.classList.add('cueflow-column-resizing');
    const move = e => this.setLabelWidth(initial + e.clientX - x, false);
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      this.contentEl.classList.remove('cueflow-column-resizing'); this.pointerCleanup = null;
    };
    const end = () => { cleanup(); this.setLabelWidth(this.labelWidth); };
    const cancel = () => { cleanup(); this.setLabelWidth(initial, false); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    this.pointerCleanup = cancel;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
  }
  setPixelsPerMinute(value, persist = true) {
    const ppm = clamp(Number(value) || 180, 1, 900), old = this.scale;
    if (!this.scroller || !this.project) { this.scale = ppm / 60; return; }
    const center = (this.scroller.scrollLeft + this.scroller.clientWidth / 2 - this.labelWidth) / old;
    this.scale = ppm / 60; this.render(true);
    this.scroller.scrollLeft = Math.max(0, center * this.scale + this.labelWidth - this.scroller.clientWidth / 2);
    if (persist) { this.plugin.settings.pixelsPerMinute = ppm; void this.plugin.saveSettings(); }
  }
  fitTimeline() {
    const available = Math.max(1, this.scroller.clientWidth - this.labelWidth - 100);
    this.setPixelsPerMinute(Math.max(1, available * 60 / this.calculateDuration()));
    this.scroller.scrollLeft = 0;
  }
  setDensity(value, persist = true) {
    this.density = value === 'compact' ? 'compact' : 'standard'; this.render(true);
    if (persist) { this.plugin.settings.laneDensity = this.density; void this.plugin.saveSettings(); }
  }
  setZoom(direction) {
    const current = this.scale * 60;
    let index = ZOOMS.reduce((best, val, i) => Math.abs(val-current) < Math.abs(ZOOMS[best]-current) ? i : best, 0);
    index = clamp(index + direction, 0, ZOOMS.length - 1);
    this.setPixelsPerMinute(ZOOMS[index]);
  }
  openLaneMenu(lane, e) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('编辑名称 / 分组 / 颜色').setIcon('pencil').onClick(() => this.renameLane(lane)));
    menu.addItem(i => i.setTitle('在组内上移').setIcon('arrow-up').onClick(() => this.moveLane(lane.id, -1)));
    menu.addItem(i => i.setTitle('在组内下移').setIcon('arrow-down').onClick(() => this.moveLane(lane.id, 1)));
    menu.addSeparator(); menu.addItem(i => i.setTitle('删除空泳道').setIcon('trash').onClick(() => this.removeLane(lane)));
    menu.showAtMouseEvent(e);
  }
  openGroupMenu(group, e) {
    const menu = new Menu();
    menu.addItem(i => i.setTitle('修改分组名称').setIcon('pencil').onClick(() => this.renameGroup(group)));
    menu.addItem(i => i.setTitle('新增泳道').setIcon('plus').onClick(() => this.addLane(group.id)));
    menu.addItem(i => i.setTitle('上移分组').setIcon('arrow-up').onClick(() => this.moveGroup(group.id, -1)));
    menu.addItem(i => i.setTitle('下移分组').setIcon('arrow-down').onClick(() => this.moveGroup(group.id, 1)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle('删除分组（保留泳道）').setIcon('trash').onClick(() => this.removeGroup(group)));
    menu.showAtMouseEvent(e);
  }
  renderCue(track, cue, lane) {
    const milestone = cue.durationSec === 0;
    const el = track.createDiv({ cls: `cueflow-cue ${milestone ? 'cueflow-milestone' : ''} ${cue.critical ? 'cueflow-critical' : ''} ${cue.status === 'done' ? 'cueflow-done' : ''} ${hasConflict(this.project, cue) ? 'cueflow-conflict' : ''} ${this.selectedIds?.has(cue.id) ? 'cueflow-selected' : ''}` });
    el.dataset.id = cue.id; el.style.left = `${cue.startSec * this.scale}px`;
    el.style.width = `${Math.max(milestone ? 18 : cue.durationSec * this.scale, milestone ? 18 : 20)}px`;
    el.style.setProperty('--cueflow-color', lane.color);
    el.setAttribute('title', `${cue.critical ? '★ 关键动作 · ' : ''}${cue.name}\nT+${fmtTime(cue.startSec)} 至 T+${fmtTime(cue.startSec + cue.durationSec)}\n${cue.note}`);
    if (cue.critical) el.createSpan({cls:'cueflow-critical-badge',text:'★',attr:{title:'关键动作','aria-label':'关键动作'}});
    if (!milestone) {
      const left = el.createDiv({ cls: 'cueflow-resize cueflow-resize-left' });
      left.addEventListener('pointerdown', e => this.beginMove(e, cue, el, 'resize-left'));
    }
    const text = el.createSpan({ text: milestone ? `◆ ${cue.name}` : cue.name, cls: 'cueflow-cue-title' });
    el.addEventListener('pointerdown', e => this.beginMove(e, cue, el, 'move'));
    if (!milestone) {
      const right = el.createDiv({ cls: 'cueflow-resize cueflow-resize-right' });
      right.addEventListener('pointerdown', e => this.beginMove(e, cue, el, 'resize-right'));
    }
    for (const port of ['left', 'right', 'top', 'bottom']) {
      const label = port === 'left' ? '左接左同时开始；左接右为前后依赖' : port === 'right' ? '右接右同时结束；右接左为前后依赖' : (port === 'top' ? '上' : '下') + '方关联 / 目标：不影响排期';
      const node = el.createSpan({ cls: 'cueflow-port cueflow-port-' + port, attr: { title: label, 'aria-label': label, role: 'button', tabindex: '-1' } });
      node.dataset.port = port;
      node.addEventListener('pointerdown', e => this.beginConnectionDrag(e, cue, port));
      node.addEventListener('click', e => e.stopPropagation());
      node.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); });
    }
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (this.swallowGestureClick(e) || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!this.getSelectedCueIds().has(cue.id)) this.selectCue(cue.id);
    });
    el.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); this.beginInlineCueName(cue.id); });
    el.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation(); const menu = new Menu();
      if (!this.getSelectedCueIds().has(cue.id)) this.selectCue(cue.id);
      menu.addItem(i => i.setTitle('修改标题').setIcon('pencil').onClick(() => this.beginInlineCueName(cue.id)));
      menu.addItem(i => i.setTitle('编辑详情').setIcon('list').onClick(() => { this.selectCue(cue.id); new CueModal(this, cue).open(); }));
      const allCritical = this.project.cues.filter(c => this.getSelectedCueIds().has(c.id)).every(c => c.critical);
      menu.addItem(i => i.setTitle(allCritical ? '取消关键动作标记' : '标记为关键动作').setIcon('star').onClick(() => this.setSelectionCritical(!allCritical)));
      menu.addItem(i => i.setTitle(this.getSelectedCueIds().size>1?'复制所选动作':'复制动作').setIcon('copy').onClick(() => this.copySelectedCues(true)));
      menu.addItem(i => i.setTitle('设为里程碑').setIcon('flag').onClick(() => this.saveCue({...cue,durationSec:0})));
      menu.addItem(i => i.setTitle('切换完成状态').setIcon('check').onClick(() => { cue.status = cue.status === 'done' ? 'planned' : 'done'; this.recordChange(); }));
      menu.addSeparator(); menu.addItem(i => i.setTitle(this.getSelectedCueIds().size > 1 ? '删除所选动作' : '删除动作').setIcon('trash').onClick(() => this.deleteCues(this.getSelectedCueIds())));
      menu.showAtMouseEvent(e);
    });
  }
  drawAlignmentGuides(cue, kind, layer, excludeIds = new Set()) {
    layer.empty();
    const visible = new Set(this.laneLayout.laneY.keys());
    const source = excludeIds.size ? {...this.project,cues:this.project.cues.filter(c => !excludeIds.has(c.id))} : this.project;
    const guides = findAlignmentGuides(source, cue.id, cue.startSec, cue.durationSec, this.scale, visible, kind);
    for (const match of guides) {
      const line = layer.createDiv({ cls: 'cueflow-align-vertical' }); line.dataset.sec = String(match.sec); line.dataset.edge = match.edge;
      line.style.left = (this.labelWidth + match.sec * this.scale) + 'px';
      const label = line.createSpan({ cls: 'cueflow-align-label', text: (match.distance === 0 ? '对齐 ' : '接近 ') + 'T+' + fmtTime(match.sec) });
      label.style.top = (Math.max(0, this.scroller.scrollTop) + 4) + 'px';
    }
    if (kind === 'move' && this.laneLayout.laneY.has(cue.laneId)) {
      const line = layer.createDiv({ cls: 'cueflow-align-horizontal' });
      line.style.left = this.labelWidth + 'px'; line.style.top = (this.laneLayout.laneY.get(cue.laneId) + this.rowHeight / 2) + 'px';
    }
  }
  beginMove(e, cue, el, kind) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.shiftKey) { this.pointerCleanup?.(); this.scroller.focus({preventScroll:true}); this.selectCue(cue.id,e.shiftKey ? 'add' : 'toggle'); return; }
    if (this.getSelectedCueIds().has(cue.id) && this.getSelectedCueIds().size > 1) { this.beginMultiMove(e,kind,cue.id); return; }
    this.pointerCleanup?.();
    this.scroller.focus({ preventScroll: true }); this.selectCue(cue.id);
    const pointerX = e.clientX, pointerY = e.clientY;
    const oldStart = cue.startSec, oldDuration = cue.durationSec, oldLaneId = cue.laneId;
    const startRowY = this.laneLayout.laneY.get(cue.laneId), oldTitle = el.getAttribute('title');
    let lastStart = oldStart, lastDuration = oldDuration, lastLaneId = oldLaneId, moved = false, guides = null;
    const move = event => {
      if (!moved && Math.hypot(event.clientX - pointerX, kind === 'move' ? event.clientY - pointerY : 0) < 4) return;
      moved = true; el.classList.add('cueflow-dragging');
      if (!guides) guides = this.rowsEl.createDiv({ cls: 'cueflow-alignment-guides', attr: { 'aria-hidden': 'true' } });
      const deltaSec = (event.clientX - pointerX) / this.scale;
      if (kind === 'move') lastStart = clamp(roundSnap(oldStart + deltaSec, this.snap), 0, 86400-oldDuration);
      else if (kind === 'resize-right') lastDuration = clamp(Math.round((oldDuration+deltaSec) / this.snap)*this.snap, MIN_CUE_SEC, 86400-oldStart);
      else {
        const end = oldStart + oldDuration;
        lastStart = clamp(roundSnap(oldStart+deltaSec, this.snap), 0, end - MIN_CUE_SEC);
        lastDuration = end-lastStart;
      }
      if (kind === 'move') {
        const target = laneAtY(this.laneLayout, event.clientY - this.rowsEl.getBoundingClientRect().top);
        lastLaneId = target?.lane.id || oldLaneId;
        el.style.transform = 'translateY(' + (target ? target.y - startRowY : 0) + 'px)';
      }
      el.style.left = `${lastStart*this.scale}px`;
      el.style.width = `${Math.max(20, lastDuration*this.scale)}px`;
      el.setAttribute('title', `T+${fmtTime(lastStart)} / ${fmtTime(lastDuration)}`);
      this.drawLinks(this.rowsEl.querySelector('.cueflow-links'), { ...cue, startSec: lastStart, durationSec: lastDuration, laneId: lastLaneId });
      this.drawAlignmentGuides({ ...cue, startSec: lastStart, durationSec: lastDuration, laneId: lastLaneId }, kind, guides);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key);
      this.pointerCleanup = null; el.classList.remove('cueflow-dragging'); guides?.remove();
    };
    const restore = () => {
      el.style.left = (oldStart * this.scale) + 'px'; el.style.width = Math.max(cue.durationSec ? 20 : 18, oldDuration * this.scale) + 'px';
      el.style.transform = ''; el.setAttribute('title', oldTitle);
      if (moved) this.drawLinks(this.rowsEl.querySelector('.cueflow-links'));
    };
    const end = () => {
      cleanup();
      if (moved && (lastStart !== oldStart || lastDuration !== oldDuration || lastLaneId !== oldLaneId)) {
        if (!this.saveCue({ ...cue, startSec: lastStart, durationSec: lastDuration, laneId: lastLaneId })) this.render(true);
      } else { restore(); this.selectCue(cue.id); }
    };
    const cancel = () => { cleanup(); restore(); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    this.pointerCleanup = cancel;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key);
  }
  drawLinks(svg, override = null) {
    svg.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg', boxes = this.getConnectionRects(override);
    const defs = document.createElementNS(ns, 'defs'); this.connectionMarkerId = uid('cueflow-arrow');
    for (const kind of CONNECTION_KINDS)appendConnectionMarker(defs,this.connectionMarkerId+'-'+kind,kind);
    svg.append(defs);
    projectConnections(this.project).forEach((edge, index) => {
      const route = routeConnection(edge, boxes, index); if (!route) return;
      const group = document.createElementNS(ns, 'g'); group.classList.add('cueflow-connection', 'cueflow-link-' + edge.kind);
      group.dataset.id = edge.id; group.dataset.from = edge.from; group.dataset.to = edge.to;
      const title = document.createElementNS(ns, 'title');
      const names = new Map(this.project.cues.map(cue => [cue.id, cue.name]));
      title.textContent = connectionName(edge.kind)+'：' + names.get(edge.from) + (edge.kind.startsWith('sync-')?' ↔ ':' → ') + names.get(edge.to) + (edge.label ? ' · ' + edge.label : ''); group.append(title);
      group.classList.toggle('cueflow-link-near',route.near);
      const markerId=route.arrowSize<9?appendConnectionMarker(defs,uid('near-arrow'),edge.kind,route.arrowSize+1):this.connectionMarkerId+'-'+edge.kind;
      for (const cls of ['cueflow-link-halo', 'cueflow-link-main', 'cueflow-link-hit']) {
        const path = document.createElementNS(ns, 'path'); path.classList.add(cls); path.setAttribute('d', route.d); path.setAttribute('fill', 'none');
        if (cls === 'cueflow-link-main') {path.setAttribute('marker-end', 'url(#' + markerId + ')');if(edge.kind.startsWith('sync-'))path.setAttribute('marker-start','url(#'+markerId+')');}
        group.append(path);
      }
      if(route.arrowGuide){const guide=document.createElementNS(ns,'path');guide.classList.add('cueflow-link-main');guide.setAttribute('d',roundedPath(route.arrowGuide));guide.setAttribute('marker-end','url(#'+markerId+')');group.append(guide);}
      if (edge.label) {
        const pairs = route.points.slice(1).map((point, i) => [route.points[i], point]);
        pairs.sort((a, b) => (Math.abs(b[1].x - b[0].x) || Math.abs(b[1].y - b[0].y) * .5) - (Math.abs(a[1].x - a[0].x) || Math.abs(a[1].y - a[0].y) * .5));
        const [a, b] = pairs[0], label = document.createElementNS(ns, 'text');
        label.classList.add('cueflow-link-label');
        label.setAttribute('x', (a.x + b.x) / 2 + (a.x === b.x ? 8 : 0)); label.setAttribute('y', (a.y + b.y) / 2 - 5);
        label.setAttribute('text-anchor', a.y === b.y ? 'middle' : 'start'); label.textContent = edge.label; group.append(label);
      }
      const hit = group.querySelector('.cueflow-link-hit');
      hit.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
      hit.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.selectConnection(edge.id); });
      hit.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); this.selectConnection(edge.id); this.editConnection(edge.id); });
      hit.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation(); this.selectConnection(edge.id);
        const menu = new Menu(); menu.addItem(item => item.setTitle('编辑文字标注').setIcon('pencil').onClick(() => this.editConnection(edge.id)));
        if (edge.kind === 'dependency') menu.addItem(item => item.setTitle('编辑依赖详情').setIcon('list').onClick(() => new CueModal(this, this.project.cues.find(cue => cue.id === edge.to)).open()));
        menu.addItem(item => item.setTitle('删除连线').setIcon('trash').onClick(() => this.removeConnection(edge.id))); menu.showAtMouseEvent(e);
      });
      svg.append(group);
    });
    this.updateConnectionFocus();
  }

}

module.exports = class CueFlowPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.labelWidth = Math.round(clamp(positive(this.settings.labelWidth, LABEL_WIDTH), 160, 600));
    this.registerView(VIEW_TYPE, leaf => new CueFlowView(leaf, this));
    this.addRibbonIcon('calendar-clock', '打开 CueFlow 时间轴', () => this.activate());
    this.addCommand({ id: 'open-timeline', name: '打开演示脚本时间轴', callback: () => this.activate() });
    this.addSettingTab(new CueFlowSettingTab(this.app, this));
  }
  async saveSettings() {
    const snapshot = deepCopy(this.settings);
    this.settingsSaveChain = (this.settingsSaveChain || Promise.resolve()).catch(() => {}).then(() => this.saveData(snapshot));
    return this.settingsSaveChain;
  }
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
};

// Export non-Obsidian pure helpers for local smoke tests (Obsidian ignores this).
module.exports.__test = { fmtTime, parseTime, validateProject, createsCycle, scheduleDependents, hasConflict, makeExample, roundSnap, CueFlowView, safeMarkdown, xmlEscape, laneGroupName, buildLaneLayout, laneAtY, LaneModal, StringModal, CueModal, CueFlowSettingTab, dependencyOrder, DisplaySettingsModal, normalizeFolder, latestCueEnd, ProjectDurationModal, connectionIntent, projectConnections, connectionRects, portPoint, segmentHitsRect, routeConnection, roundedPath, findAlignmentGuides, cuesInMarquee, transformCueSelection, parseProjectFile, parseProjectBundle, buildProjectFile, importedProjectMarkdown, summarizeProjectChanges, inspectProject, ProjectImportModal, ProjectExportModal, ProjectPasteModal };
Object.assign(module.exports.__test,{timingComponents,makeCueClipboard,parseCueClipboard,pastedCueProject,connectionName});
