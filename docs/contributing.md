# 贡献指南

## 本地开发

```bash
git clone <repo> && cd project-atlas
node bin/atlas.mjs doctor        # 环境自检（graphify 可选）
node --test                      # 单元测试（零依赖，无需 npm install）
node tests/e2e/smoke.mjs         # 端到端冒烟（不需要 graphify）
```

## 提交前

- `node --test` 全绿
- `node tests/e2e/smoke.mjs` 通过
- 改了渲染器 → 用真实项目出一版图并截图对比（`docs/assets/`）
- 改了 `model.json` 结构 → 同步 `schemas/model.schema.json` 与 `docs/model-schema.md`

## 代码约定

- **零运行时依赖**是硬约束：新增 JS 依赖前先讨论。构建期依赖（如 dagre）必须 vendored 进 `assets/vendor/` 并在 package.json 的 files 里。
- 只用 Node 内置模块（`fs` / `path` / `node:test`）。
- 新增解析逻辑必须是**确定性**的：同样输入 → 同样输出，且不得联网、不得调模型。
- 解析不出来的东西**留空并标注**，不要猜。

## 报告问题

架构图错了，通常分三类，请分开描述：

1. **事实错**：节点/边和源码不符 → 属于 `src/extract` 或 graphify
2. **聚合错**：分层、截断、合并不符合预期 → 属于 `src/model`
3. **渲染错**：溢出、重叠、点不开 → 属于 `assets/viewer`

附上：项目规模、命令、`model.json` 的相关片段（不要贴整个文件）。
