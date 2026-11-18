---
name: project-atlas
description: Use when someone needs to get oriented in an unfamiliar repository and wants a map rather than a wall of text — onboarding to a new codebase, "这个项目是怎么组织的", "帮我快速看懂这个仓库", "出一张架构图", reviewing a large repo before changing it, or explaining a system to a teammate. Produces one self-contained offline HTML page with four tabs (overview / architecture / flows / data) that drill from system layers down to individual functions, where every node and edge carries its file:line evidence.
---

# Project Atlas

把「读一个陌生仓库」变成「看一张能钻到底的图」。

产物是**一个单文件 HTML**，四页签：

| 页签 | 回答什么 | 内容 |
|---|---|---|
| 概览 | 这是什么 | 连续几段介绍 + 技术栈 + 规模 + 「从这读起」①②③ |
| 架构 | 它由什么组成 | 分层图，由浅入深；每张卡有名字 + 一句话职责 + 规模指标 |
| 流程 | 它怎么跑起来 | 每条关键链路一屏，按执行顺序；点一步跳回架构 |
| 数据 | 数据长什么样 | 类型卡 + 字段 + 同名跨端连线（按仓库结构分列） |

**数据页支持哪些语言**（`src/types/index.mjs`，确定性解析，不调模型）：

| 语言 | 认什么 | 字段从哪来 |
|---|---|---|
| Go | `type X struct` | 结构体字段 + `json` tag |
| TypeScript | `interface X` / `type X = {}` | 字段、可选标记 |
| Python | `class X` | 类级注解 + `__init__` 签名参数 |
| Java | `class X` / `record X` | 字段声明 / record 组件 |
| Rust | `struct X` | 命名字段 / 元组结构体 |
| SQL | `CREATE TABLE` | 列定义 + 外键 |

分组规则：多端仓库（有 backend/frontend/extension）按语义分组；否则**按仓库真实顶层目录**分组。
解析不出来就标「见原文 Lnn」，**不做通用 parser、不做字段级跨端对齐**。

---

## 四条铁律

1. **图由抽取器定，模型只解释。** 函数、文件、调用边来自 AST；模型只能给**已存在**的节点写职责，
   不许新增节点、不许编边、不许改名字。写错 id 会被丢弃并计入警告。
2. **分层由模型判断，不能交给启发式。** 没有 `groups.json` 时构建直接失败——
   用目录结构或聚类冒充架构，是这个工具最没价值的形态。
3. **降级必须可见。** 跳过、截断、合并、推断，全部写进 `meta.warnings`，显示在页面顶部黄条。
4. **构建通过 ≠ 可以交付。** 必须跑 `verify`；有浏览器时还必须交出 `__archSelfTest()` 的结果。

---

## 流程：五道闸门，一道不过就停

> 只有一个入口。不要手动拆步骤、不要跳过任何一道。

```bash
ATLAS=<skill 目录>
node $ATLAS/src/cli/atlas.mjs doctor          # 环境自检
node $ATLAS/src/cli/atlas.mjs run --repo <仓库> \
  --groups <groups.json> --insights <insights.json> \
  --out <项目名>-架构图.html
```

### G1 环境
`src/cli/atlas.mjs doctor` 检查 graphify / node / 渲染资产 / dagre。
没有 graphify 就没有函数级调用边 → 走降级：`node $ATLAS/src/extract/scan.mjs --repo <仓库> --out <tmp>/graph.json`，
`run` 时用 `--graph` 指过去，页面会标注「函数级调用未解析」。

### G2 抽图
`graphify extract . --code-only`（离线、不调模型）。产物 `<repo>/graphify-out/graph.json`。
**不要把 graph.json 读进上下文**——它可能几 MB；需要判断时用 `proposal.json` 和 `graphify query/god-nodes`。

### G3 提案 + 模型输入（这一步只有模型能做）
`src/cli/atlas.mjs run` 会生成 `proposal.json`（顶层容器、度数最高的符号）。读它 + README + 入口文件，写两份 JSON：

**groups.json** —— 分层（4–8 层，每层必须有一句话职责）
```json
{ "layers": [
    { "key": "entry", "name": "公开入口", "match": ["pkg/__init__.py", "pkg/api.py"],
      "role": "对外暴露的模块级函数，全是薄封装。" }
  ], "skip": ["tests", "docs"] }
```
`match` 是 glob（`*` 不跨目录、`**` 跨目录），先声明先认领；没被认领的文件会告警。

**insights.json** —— 概览介绍 / 卡片职责 / 关键链路
```jsonc
{
  "intro": { "paragraphs": ["…", "…"], "basis": ["docs/architecture.md"] },  // 至少 2 段
  "layers":    { "core": "整个库最难的一块。" },
  "files":     { "pkg/client.py": "主入口，request() 四段式处理。" },
  "functions": { "pkg/client.py::Client.send()": "发送请求并返回响应。" },   // 字符串 = 只写职责的简写
  "flows": [ { "id": "fl_get", "title": "一次 get() 的完整路径",
               "steps": [ { "view": "v_file_pkg_api_py", "node": "fn:pkg/api.py::get()", "note": "用户入口" } ] } ]
}
```
- 节点 id 格式：`layer:<key>` / `file:<路径>` / `fn:<路径>::<标签>`。**先跑一次构建，从 `model.json` 里抄**，不要自己拼。
- 函数卡介绍覆盖率必须 **≥50%**，否则构建失败（质量门会列出还差哪些函数）。
- `flows` 至少 1 条；每条 4–8 步，从用户动作出发，不是按代码结构。

### G4 构建（质量门默认开启）
`src/cli/build.mjs` 会拦住这些问题，**默认直接失败**：

| 门 | 判定 |
|---|---|
| 概览介绍 | 少于 2 段 → 失败 |
| 从这读起 | 没有入口 → 失败 |
| 关键链路 | 少于 1 条 → 失败 |
| 函数卡覆盖率 | < 50% → 失败，并列出待补函数 |
| 空屏 / 节点重叠 / 单屏 >45 节点 / 重复 id | 失败 |
| 首屏缩放过低（<0.45） | 失败 |
| 有层没挂 drill | 警告（用户点不进去） |

真要先看效果：加 `--force`，问题会写进页面黄条，**但这种产物不能算交付**。

### G5 验证
```bash
node $ATLAS/src/cli/atlas.mjs verify --file <产物.html> [--browser selftest.json]
```
检查：占位符残留、外部资源、网络调用、内嵌数据完整性；给了 `--browser` 还会校验画布尺寸与缩放。
通过时打印一张 Markdown 证据表。

**浏览器自检怎么取**（有 Playwright/浏览器时必做）：
```js
await page.goto('file:///…/<产物>.html');
await page.locator('[data-tab="arch"]').click();
const st = await page.evaluate(() => window.__archSelfTest());  // 存成 selftest.json
// 期望 {ok:true, stage:{w,h}, k≥0.45, views:n}
```

---

## 交付话术（三句话 + 一张表）

1. 文件在哪、双击打开；
2. 四页签分别是什么、建议先看哪一屏（通常是概览的「从这读起」）；
3. **不确定项**：哪些边是推断的（虚线）、哪些文件/函数被截断（黄条）、渲染层有没有验证过。

然后贴 `verify` 打印的证据表。没跑 `verify` 就说「已完成」= 违约。

---

## 反模式

| 别做 | 为什么 |
|---|---|
| 把 `graph.json` 整个读进上下文 | 几 MB，一次烧穿预算，而且你不需要逐条看 |
| 用目录树当架构 | 目录是「文件放哪」，架构是「职责怎么切」 |
| 让模型生成节点/边 | 会得到源码里不存在的模块，无法验证 |
| 把所有 import 都画成边 | 图会变毛线团 |
| 一屏画 200 个节点 | 超过 45 个就没人看得清；该拆层 |
| 静默截断 / 静默降级 | 用户会以为图是完整的，然后基于错误认知做决策 |
| 只跑 build 就交付 | 打包全绿、页面照样可能是扁的或空的 |

## 排错

| 现象 | 处理 |
|---|---|
| `缺少 groups.json` | 这是设计如此。先 `propose`，读 proposal，再写分层 |
| `函数卡介绍覆盖率 xx%` | 按列出的函数补 `insights.functions`，或调小 `--max-fns` |
| `找不到 graph.json` | 没跑 `graphify extract`，或不在仓库根执行 |
| 顶层只有 1–2 个模块 | 单包仓库；写 `groups.json` 的 `match` 才能分出真实分层 |
| 画布被压扁 / 首屏缩放过低 | 检查 `#app` 四个条带是否显式钉了 `grid-row`；`__archSelfTest()` 会报 `reason` |
| Windows 中文路径报错 | 用绝对路径（`E:/…`）；MSYS 的 `/tmp` 与 Windows 程序不互通 |
