# 项目文件与 AI 优化

[返回首页](../README.md) · [操作手册](USER_GUIDE.md) · [完整 JSON 示例](../examples/AI优化项目.cueflow.json)

完整文件用于在 CueFlow 与 AI 之间往返；CSV 适合查看排程，无法表达全部分组、关联与备注。

## 推荐操作流程

1. 在「导入 / 导出 → 导出完整项目 / AI 优化文件」填写目标，选择 JSON（推荐）或 Markdown；文件保存到当前项目所在目录。
2. 检查导出内容后，将完整文件交给自行选择的 AI 工具。插件不直接调用外部 AI。
3. 要求 AI 返回完整文件，保留 ID、引用和约束，并说明调整理由。
4. 在「导入 / 导出」选择导入文件或粘贴返回内容。
5. 在变化预览中检查动作增删、时间、依赖、同步、关键标记和资源变化；根据需要切换前后依赖顺延，确认最终时间与提示。
6. 「保存为新项目」，保留原方案，再排练核对实际资源和业务可行性。

### 可复制的 AI 提示词

```text
请优化附件中的 CueFlow 项目，目标是：减少同一执行人员/设备的时间重叠，缩短总时长，并保留全部关键动作。

请保留项目包结构与所有既有 ID，维护分组、泳道、备注、状态、关键标记和连线标注。
dependsOn 表示前置结束后才能开始，不得形成循环。
syncLinks.mode=start 表示两动作同时开始；mode=end 表示两动作同时结束。请同时满足这些约束。
relations 只表示关联/目标，不是时间依赖，不要改成 dependsOn。
所有时间为整数秒，开始不得小于 0，结束不得超过 86400，项目总时长需覆盖全部动作。
没有用户授权的情况下不要删除动作、资源或关系，也不要虚构执行能力。
如有无法同时满足的要求，请保留原数据并说明冲突，而不是悄悄移除约束。
请只针对项目内容优化，保留项目正文；返回完整可导入 JSON 文件，将调整理由和待人工确认事项写入 optimizationNotes 数组。
不要只返回建议、CSV、部分字段或代码差异。
```

可将目标改为“关键动作时间保持不变”“优先减少设备闲置”等。导入校验负责格式和排程约束，最终方案仍需用户确认。

## JSON 项目包

文件后缀为 `.cueflow.json`，根对象字段如下：

| 字段 | 含义 |
|---|---|
| format | 固定 `cueflow.project` |
| formatVersion | 包格式版本，当前为 1 |
| exportedAt | 导出时间 |
| aiGuide | 用户优化目标、时间单位、依赖语义、关键动作及返回要求 |
| project | 完整 CueFlow 项目，数据格式版本 5，是实际回导的数据来源 |
| markdownNotes | 数据块外的 Markdown 正文，分为 before / after；可为 null |
| optimizationNotes | AI 用中文说明优化结果的字符串数组 |

`project` 包括 name、durationSec、groups、lanes、cues、relations、syncLinks、dependencyLabels。每个 cue 包含 id、name、laneId、startSec、durationSec、critical、status、note、dependsOn。时间为相对整数秒；critical 为布尔值；status 为 planned、active、done。

AI 应保持 ID 与引用，保留关键标记，遵守前置动作完成后开始的依赖；relations 为展示关联，不是排期约束。`syncLinks` 包含 id、from、to、mode、label；mode 为 start 表示同时开始，为 end 表示同时结束（startSec + durationSec 相同），这是排程约束。默认 label 为空。AI 必须保持同步约束；相互矛盾的约束会被拒绝。AI 可修改 project，并将理由写入 optimizationNotes。文件中的 aiGuide 和说明仅作为数据展示，不会被插件执行。

## Markdown

包含优化目标、约束、可读排程表和一个完整 `cueflow` JSON 数据块，也保留原项目正文。AI 应返回完整 Markdown，保留唯一数据块。文件数据块以外的内容作为新项目备注保留。

## 导入与比较

支持选择 UTF-8 JSON / Markdown 文件或粘贴完整内容。先预览再保存为新项目；当前项目不被覆盖，重名文件自动增加编号。预览显示动作变化、依赖增删、资源/关联/同步变化、关键动作移除及时间冲突。

可选择按依赖自动顺延，并在预览中核对结果；超过 24 小时或无效引用会阻止导入。关闭顺延时，前置依赖时间可保持冲突并显示复核提示；同步约束始终生效，导入预览会调整相关动作或拒绝无法满足的约束。撤销历史、播放状态及本机显示偏好属于当前视图，不包含在可移植项目中。

上限为 5 MB / 3000 动作 / 500 泳道 / 10000 条关联与同步连线合计。JSON 包版本 1 与项目版本 5 分别管理文件结构和排程数据兼容性。

![AI 修改后的项目导入预览](images/ai-import.png)

## 动作剪贴板

Ctrl+C 生成 `cueflow.selection` / clipboardVersion 1 的 JSON，包含 sourceLaneOrder、cues、relations、syncLinks、dependencyLabels。仅包含所选动作之间的关系；外部依赖和外部标注不进入剪贴板。Ctrl+V 在当前鼠标位置映射时间和泳道，重新生成动作/连线 ID，保留内部关系与相对布局。此格式用于动作片段；完整文件交换使用上面的 cueflow.project。

## 原生 Markdown 中的数据块

下面是最小的双泳道、同步开始示例，可放在知识库项目文件的唯一 `cueflow` 数据块内：

```cueflow
{
  "version": 5,
  "name": "同步开始示例",
  "durationSec": 120,
  "groups": [{"id":"g1","name":"执行人员"}],
  "lanes": [
    {"id":"l1","name":"导播","groupId":"g1","color":"#5B78E5"},
    {"id":"l2","name":"场控","groupId":"g1","color":"#0F9C91"}
  ],
  "cues": [
    {"id":"a","name":"开场画面","laneId":"l1","startSec":0,"durationSec":20,"critical":true,"status":"planned","note":"确认画面","dependsOn":[]},
    {"id":"b","name":"开场提示","laneId":"l2","startSec":0,"durationSec":10,"critical":false,"status":"planned","note":"提示执行人员","dependsOn":[]}
  ],
  "relations": [],
  "syncLinks": [{"id":"s1","from":"a","to":"b","mode":"start","label":""}],
  "dependencyLabels": []
}
```

`dependencyLabels` 使用 `{from,to,label}` 标注已存在的前后依赖；`relations` 使用 `{id,from,to,fromPort,toPort,label}`，端口只允许 top / bottom；`syncLinks` 使用上表所述同步语义。动作、泳道和连线 ID 在各自范围内必须有效唯一，引用必须指向实际对象。

项目文件正文位于代码块前后，不应再添加第二个 `cueflow` 块。不要把完整 `cueflow.project` 包直接塞入原生数据块；导入菜单可识别项目包并提取其中的 `project`。
