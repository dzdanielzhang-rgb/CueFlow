# 安装、升级与回退

[返回首页](../README.md) · [操作手册](USER_GUIDE.md) · [故障处理](TROUBLESHOOTING.md)

适用于 CueFlow Timeline 0.10.0。插件 ID 为 `cueflow-timeline`，仅面向 Obsidian 桌面端。manifest 声明最低版本为 Obsidian 1.5.0，当前已验证环境为 Windows / Obsidian 1.14.4。

## 下载哪个文件

打开 [v0.10.0 发布页](https://github.com/dzdanielzhang-rgb/CueFlow/releases/tag/0.10.0)，在 Assets 中选择：

| 文件 | 用途 |
|---|---|
| `cueflow-plugin-v0.10.0.zip` | 推荐给普通用户，包含可直接安装的插件文件夹 |
| `main.js`、`manifest.json`、`styles.css` | 手动替换或检查插件运行文件；必须使用同一版本的三份文件 |
| `SHA256SUMS.txt` | 核对下载文件的 SHA-256 |
| GitHub 自动提供的 Source code | 源码快照，供开发者使用 |

备用下载：[仓库中的安装包](../dist/cueflow-plugin-v0.10.0.zip)。插件无需 Node.js、npm、API Key 或其他任务插件。

## 首次安装

1. 找到准备安装的 Obsidian 知识库。每个知识库分别安装插件。
2. 退出 Obsidian，解压安装包。得到的文件夹应叫 `cueflow-timeline`。
3. 将这个文件夹放入知识库的 `.obsidian/plugins/` 目录；目录不存在时可创建。
4. 确认最终结构如下，三个文件必须直接位于插件目录内：

   ```text
   <你的知识库>/
   └─ .obsidian/
      └─ plugins/
         └─ cueflow-timeline/
            ├─ main.js
            ├─ manifest.json
            └─ styles.css
   ```

5. 重新打开 Obsidian，进入「设置 → 第三方插件」，允许使用第三方插件后启用 **CueFlow Timeline**。
6. 点击左侧时钟图标，或打开命令面板（通常 Ctrl+P）搜索「打开演示脚本时间轴」。
7. 首次打开时会在知识库 `CueFlow/` 目录创建演示项目。可以直接试用，也可点击「+ 项目」新建自己的方案。

知识库的 `.obsidian` 目录可能在文件管理器中被隐藏。这里的「知识库」指存放笔记的文件夹，不是 Obsidian 应用安装目录。不要形成 `cueflow-timeline/cueflow-timeline/` 双层目录。

## 安装后确认

- 插件列表能看到并启用 CueFlow Timeline。
- 时间轴正常显示演示项目；可选择动作、双击改标题、拖动后保存。
- 项目右下角显示「已保存」；关闭再打开后修改仍在。
- 如需验证版本，在插件目录查看 `manifest.json`，其中 `version` 应为 `0.10.0`。

## 从旧版本升级

1. 等待当前项目显示「已保存」，停止排练并退出 Obsidian。
2. 备份整个 `CueFlow/` 项目目录（如修改过保存目录，备份实际目录）。同时备份 `.obsidian/plugins/cueflow-timeline/`，包括其中的 `data.json`（若存在）。
3. 下载新安装包，用同一版本的 `main.js`、`manifest.json`、`styles.css` 替换旧文件。保留现有 `data.json`。
4. 重新打开 Obsidian，确认插件启用，检查项目名称、动作、连线与保存状态。

v0.10.0 读取旧项目，并在保存时升级到**项目数据格式 5**，以保留同时开始/结束关系。完整项目包格式仍为 `cueflow.project` / 1。更新插件不会自动改动已有项目文件名。

## 回退到旧版本

退出 Obsidian，将升级前备份的插件文件和项目文件一并恢复，再启动 Obsidian。格式 5 项目不应交给 0.9.1 或更早插件继续编辑；只替换旧插件文件不足以完整回退。

## 项目与设置保存在哪里

| 内容 | 默认位置 | 说明 |
|---|---|---|
| 项目排程与正文 | `CueFlow/<项目名>.md` | 也可在插件设置指定知识库内的相对目录 |
| 项目导出文件 | 当前项目所在目录 | JSON、Markdown、CSV、SVG |
| 显示偏好与插件设置 | `.obsidian/plugins/cueflow-timeline/data.json` | 由 Obsidian 管理；不需要手动创建 |
| 撤销历史 | 当前视图内存 | 最多 60 次快照，关闭视图后不保留 |

修改「项目保存目录」影响之后的新建项目与项目查找；原文件不会自动搬迁。升级前备份实际项目目录。

## 卸载

先确认项目已保存，再在第三方插件设置中停用或卸载 CueFlow Timeline。项目 Markdown 文件保留在知识库中，可备份或以文本方式查看。需要再次使用时，重新安装兼容版本即可。

## 发布渠道

本仓库提供 GitHub Release 与手动安装方式。公开仓库与 GitHub Release 是项目发布渠道；Obsidian 社区插件目录的提交和审核是独立流程，请以实际可用的安装入口为准。
