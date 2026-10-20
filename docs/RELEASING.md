# 维护者发布指南

[返回首页](../README.md) · [贡献指南](../CONTRIBUTING.md)

本项目直接发布 `main.js`、`manifest.json`、`styles.css`，无需构建依赖。GitHub Release 是面向用户的版本下载入口。

## 发布前准备

1. 确认最终改动已提交，工作区清晰，相关检查及客户端验证有实际记录。
2. 更新 `manifest.json` 和 `package.json` 的版本，并在 `versions.json` 加入版本与最低 Obsidian 版本映射。最低版本声明与实测环境分别记录。
3. 更新 CHANGELOG、首页、安装说明、发布说明和兼容性说明；项目数据升级时写明备份及回退方式。
4. 确认公开文件仅包含源码、通用示例、文档和安装包；保留 MIT LICENSE。
5. 将三份运行文件压缩为 `cueflow-plugin-v<版本>.zip`，包内只有 `cueflow-timeline/` 及三份运行文件。对照已验证的运行文件逐项核对内容。
6. 更新 `dist/` 的安装包与 SHA-256 清单。Release 另附本版本三份运行文件及 ZIP 的 `SHA256SUMS.txt`。

## GitHub Release

标签使用与 `manifest.version` **完全相同**的版本号，例如 `0.10.0`。在预定发布提交上创建标签，Release 标题可使用 `CueFlow Timeline v0.10.0`。

应上传这些独立资产：

```text
main.js
manifest.json
styles.css
cueflow-plugin-v0.10.0.zip
SHA256SUMS.txt
```

三份运行文件需直接作为 Release 资产提供，安装 ZIP 方便手动安装。GitHub 的 Source code ZIP / tar.gz 是额外的源码快照。说明中给出安装入口、主要改动、项目格式、已验证环境、实际测试范围和回退步骤。

这些文件与标签约定参考 [Obsidian 官方发布说明](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin) 与 [官方示例插件](https://github.com/obsidianmd/obsidian-sample-plugin#releasing-new-releases)。GitHub 公开发布与 Obsidian 社区插件目录审核是独立步骤。

## 发布后核对

- 仓库可见性为 Public，首页、用户手册、图片和示例链接可打开。
- Release 已公开，标签指向预期提交，版本与 manifest / versions.json 一致。
- 资产数量、名称与 SHA-256 正确，ZIP 解压结构正确；三份独立资产与 ZIP 内对应内容一致。
- 首页下载入口指向公开 Release，仓库 About 说明与主题准确。
- 在未登录的公开访问路径复核文档与下载。只需按实际变化做验证，文档发布无需重跑所有功能测试。

## v0.10.0 说明

这是当前仓库的首个正式 GitHub Release，插件此前的开发历史保留在 CHANGELOG。项目格式为 5；回退到 0.9.1 或更早插件时，恢复升级前插件和项目两份备份。GitHub 发布不额外承诺移动端、多人协作、设备控制或长期无人值守场景。
