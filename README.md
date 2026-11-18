# project-atlas

**让 agent 把一个陌生代码仓库，变成一张能点开、能钻到底的架构图。**

面向 agent 使用（一个 skill + 一套 CLI），产物给人看（一个离线 HTML，四个页签）。

```
你：帮我快速看懂 ~/code/some-repo，出一张架构图
agent：抽图 → 出提案 → 写分层与解释 → 构建 → 验证
你：得到 some-repo-架构图.html —— 双击即开，断网可用
```

<!-- 截图放这里：docs/assets/screenshot.png -->
<!-- ![screenshot](docs/assets/screenshot.png) -->

## 它解决什么问题

接手一个陌生仓库，通常要花几小时翻目录、读入口、猜模块职责。`project-atlas` 把这件事压成：

| 页签 | 回答的问题 |
|---|---|
| **概览** | 这是什么、给谁用、技术栈、从哪开始读 |
| **架构** | 分几层、谁依赖谁、每层/每个文件/每个函数在干什么（可下钻） |
| **流程** | 一次操作从用户点击到落库，依次经过哪些函数 |
| **数据** | 前端 / 后端 / 数据库各有哪些结构，字段是什么，谁在用 |

每个节点都带 `file:line`，每条边都带置信度（源码直读 / 解析器推断）。

## 为什么不是"让模型直接画图"

- **图由抽取器定，模型只解释。** 函数、文件、调用边来自 AST 静态解析；模型只负责"这层是干嘛的"。它不能新增节点、不能编边。
- **分层由模型判断，不交给启发式。** 用目录树冒充架构是这个工具的典型失败态，所以没有 `groups.json` 时构建直接拒绝。
- **构建通过 ≠ 可交付。** 产物要过 `verify`；有浏览器还要过 `__archSelfTest()`。

## 快速开始

### 方式一：作为 agent skill

```bash
git clone https://github.com/beeeeeeef/project-atlas.git ~/.dsh/skills/project-atlas
# Claude Code: ~/.claude/skills/project-atlas
```

然后对 agent 说："帮我快速看懂这个仓库，出一张架构图"。

### 方式二：自己跑 CLI

```bash
node bin/atlas.mjs doctor                 # 环境自检
node bin/atlas.mjs run \
  --repo /path/to/repo \
  --groups ./my-groups.json \
  --insights ./my-insights.json \
  --out atlas.html
```

`run` 五步串行：环境 → 抽图 → 提案 → 检查输入 → 构建 → 验证。任一步不过就停，并告诉你下一步做什么。

> `--groups` / `--insights` 是 **agent 读代码后生成的产物，不是给人手写的**。
> 人的输入只有仓库路径；这两份文件的存在是为了让 agent 的判断可校验、可复现、可 diff。

## 依赖

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| **Node.js ≥ 18** | 必需 | 零 npm 依赖（dagre 已随包内置） |
| **graphify** | **强烈建议** | 唯一能提供函数级调用边的抽取器。`uv tool install graphifyy` |
| 浏览器 | 只看产物时需要 | 产物无 CDN、无网络请求 |

**没有 graphify 会怎样？** 走降级路径 `src/extract/scan.mjs`：文件、符号、import 关系仍在，
但**函数级调用边完全没有**，架构图里函数屏会变成孤立方块。页面顶部会有黄条明确标注，
构建也不会假装完整。

## 产物

- **单个 HTML 文件**，所有数据和代码内联，断网可用
- 无外部字体、无 CDN、无网络请求
- 典型体积 100–250 KB

## 产物与中间文件

**不会写进被分析的仓库。** 所有中间产物都在当前目录的 `.atlas/`：

```
.atlas/
├── graph.json       抽出来的代码图（复用：存在就跳过抽图）
├── proposal.json    给 agent 的决策输入
├── cache/           graphify 的 AST 缓存
└── manifest.json
架构图.html          最终产物（--out 指定，默认当前目录 atlas.html）
```

| 想改什么 | 用什么 |
|---|---|
| 中间文件位置 | `--workdir <目录>` |
| 产物位置 | `--out <文件>` |
| 复用已有 graph.json | `--graph <文件>` |

想重新抽图就删掉 `.atlas/graph.json`。`.atlas/` 已写进 `.gitignore`。

## 仓库结构

```
bin/atlas.mjs        CLI 薄入口
src/cli/             run / doctor / verify / build
src/extract/         抽图适配（graphify）+ 降级扫描
src/model/           模型构建：分层聚合、布局、质量门
src/types/           数据结构抽取（Go/TS/Python/Java/Rust/SQL）
src/render 相关        assets/viewer/ 下的 vanilla 渲染器
assets/vendor/       dagre（构建期布局，MIT）
schemas/             groups / insights / model 的 JSON Schema
tests/               单元测试 + 夹具 + 端到端冒烟
docs/                架构说明、数据契约、贡献指南
SKILL.md             agent 入口
```

## 已知限制

- **类型字段是自研解析**（非 graphify）：graphify 解析到 AST 但不导出字段。当前用针对性块解析，
  覆盖常见写法；复杂泛型/继承/内联结构会标"见原文"而不展开。
- **调用边只到静态可达**：反射、DI 容器注入追不到。
- **大仓库会截断**：单屏节点数有上限，超出按调用度数截断并在页面标注。
- **跨仓库契约**：暂未支持（设计见 roadmap）。

## Roadmap

- [x] 四页签（概览 / 架构 / 流程 / 数据）
- [x] 质量门与可脚本化验证
- [x] 六种语言的类型声明解析
- [ ] 增量更新（按 commit 比对，跳过重复抽图）
- [ ] 调用链追踪（函数到入口的完整路径）
- [ ] 变更影响分析（改这个符号会波及什么）
- [ ] 多仓库地图（跨仓 API 契约）

## License

MIT
