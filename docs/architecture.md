# 架构说明

## 一句话

`抽取（事实） → 模型（分层与解释） → 布局（坐标） → 渲染（单文件）`，每一层都有可脚本化的闸门。

## 数据流

```
仓库
 │
 ├─(1) graphify extract --code-only ─────────────► graphify-out/graph.json
 │      函数/文件/调用边/置信度；没有字段信息            （客观事实层）
 │
 ├─(2) build propose ────────────────────────────► proposal.json
 │      顶层容器 + 度数最高的符号                        （给模型的最小决策输入）
 │
 ├─(3) 模型写 groups.json / insights.json ───────► 分层 + 解释 + 链路
 │      唯一需要"理解"的一步；只能引用已存在的节点 id
 │
 ├─(4) build ────────────────────────────────────► model.json + arch.html
 │      adapt：聚合出层/文件/函数三级视图
 │      types：抽取类型字段（数据页）
 │      layout：dagre / 网格算坐标
 │      check：质量门
 │
 └─(5) verify ───────────────────────────────────► 证据表
        打包层 + 数据层 + 渲染层（需浏览器自检）
```

## 模块职责

| 目录 | 职责 | 依赖 |
|---|---|---|
| `src/cli` | 命令编排、参数解析、错误提示 | 无 |
| `src/extract` | 调 graphify；无 graphify 时降级扫描 | 只用 Node 内置 |
| `src/model` | 图 → 视图、坐标、质量门 | dagre（构建期） |
| `src/types` | 六种语言的类型声明 → 字段 | 只用 Node 内置 |
| `assets/viewer` | 浏览器端渲染器（vanilla） | 无（离线、无 CDN） |

## 关键设计决策

### ADR-1 抽取交给 graphify，不自己写 AST 解析

- **理由**：graphify 用 tree-sitter 覆盖 100+ 扩展名，函数级调用边带置信度，离线可跑。
- **代价**：它只导出「符号 + 关系」，**不导出类型字段**；字段要我们自己补（`src/types`）。
- **替代方案**：自研全语言 AST（成本高）、调用 graphify 内部 API（耦合非公开接口，升版即坏）。

### ADR-2 模型只能解释，不能创造

- 节点 id、边、层级结构全部来自抽取与聚合。
- 模型输出中的未知 id 会被丢弃并计入 `meta.warnings`；覆盖率不足会让构建失败。
- **理由**：架构图一旦混入不存在的模块，用户会基于错误认知做决策，比没有图更糟。

### ADR-3 分层由模型判断，构建不做启发式兜底

- 没有 `groups.json` 直接拒绝构建（`--auto-groups` 是显式的降级开关，产物带警告）。
- **理由**：目录树 ≠ 架构。交给启发式等于放弃这个工具的核心价值。

### ADR-4 布局在构建期算好，运行时零布局库

- dagre 只在构建期跑，坐标写进 `model.json`；产物里没有图库。
- **理由**：单屏 6–45 个节点，塞 400KB 图库不值得；产物保持 100–250KB、可 diff、可快照测试。

### ADR-5 文字折行也在构建期

- 卡片宽度/高度/每行文字都在构建时算好，渲染器只按行绘制。
- **理由**：两处各算一套宽度必然对不齐（曾经因此出现文字溢出卡片）。

## 扩展点

### 加一门语言的类型解析

1. 在 `src/types/index.mjs` 的 `LANG_BY_EXT` 注册扩展名；
2. 写 `parseXxxTypes(source)`，返回 `[{ name, line, kind, fields: [{ name, type, note }] , start, end }]`；
3. 在 `extractTypes` 的 dispatch 里加一行；
4. 在 `tests/fixtures/<lang>/` 放最小夹具，加单元测试。

### 加一个页签

1. `model.json` 增加对应数据段（并更新 `schemas/model.schema.json`）；
2. `assets/viewer/viewer.html` 加容器 + 侧栏按钮；
3. `viewer.js` 加 `renderXxx()` 并在 `setTab` 里接线；
4. `check.mjs` 加质量判定（没有内容时是否应该失败）。
