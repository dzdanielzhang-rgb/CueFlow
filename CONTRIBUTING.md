# 贡献指南

欢迎通过 [Issues](https://github.com/dzdanielzhang-rgb/CueFlow/issues) 反馈问题或建议，通过 Pull Request 提交代码、文档和通用示例。

## 反馈问题

提供插件版本、Obsidian 版本、系统、复现步骤、预期与实际结果。最好使用新建的最小项目复现；如需附项目，移除私人路径、业务机密及无关备注。说明是否启用依赖顺延、标准/紧凑模式、是否存在同步连线；保存问题请附保存状态和错误提示。

功能建议请描述实际场景、希望执行的操作与结果。现有边界见 [首页](README.md) 和 [常见问题](docs/TROUBLESHOOTING.md)。

## 本地开发

要求 Node.js 18+。本项目直接发布未压缩的 `main.js`，没有 npm 运行依赖，也没有额外构建步骤。建议在独立的 Obsidian 测试知识库安装三份运行文件，避免直接使用正式排程测试新代码。

| 文件 / 目录 | 用途 |
|---|---|
| `main.js` | 插件逻辑、数据校验、路由、交互、导入导出 |
| `styles.css` | 时间轴、动作、节点、连线和弹窗样式 |
| `manifest.json` | 插件 ID、版本、兼容性与描述 |
| `versions.json` | 已发布插件版本与最低 Obsidian 版本映射 |
| `tests/` | 本地逻辑与存储/导出检查；浏览器预览属于试验适配页 |
| `examples/` | 通用项目与 AI 文件示例 |
| `docs/` | 用户手册、格式说明、验收与维护指南 |
| `dist/` | 已归档的安装 ZIP 与校验值 |

## 验证与提交

按改动范围运行必要检查，记录实际执行的命令与结果；不要将局部检查描述成全量通过。纯文档修改检查链接、示例、术语与版本一致性即可。

```sh
node --check main.js
npm run test:sync-copy
npm run test:files
npm run test:selection
npm run test:alignment
npm run test:names
```

以上命令按需选择。`npm test` 包含全部本地检查；它不能代替 Obsidian 客户端交互验收。涉及拖动、焦点、键盘、保存或弹窗时，在真实客户端检查相应路径。保留内部引用、原子失败、撤销完整性与数据兼容性。

提交 PR 时说明具体问题、最终行为、相关验证和剩余限制。新增用户可见功能应同步更新操作手册；数据格式变化应有兼容说明。不要提交知识库、个人 `data.json`、原始私人验收记录、备份、凭据或 `node_modules`。

## 发布维护

版本、三文件资产、安装 ZIP 和 Git 标签必须一致，按 [维护者发布指南](docs/RELEASING.md) 操作。项目采用 [MIT 许可证](LICENSE)。
