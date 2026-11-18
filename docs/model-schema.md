# model.json 契约

`model.json` 是**抽取层**与**渲染层**之间唯一的接口。抽取脚本把 graphify 的
`graph.json` 压成这个形状；渲染器只认这个形状，对 graphify 一无所知。

改这个契约 = 同时改 `scripts/adapt.mjs` 和 `assets/viewer.js`。加字段安全，
改字段名或语义不安全。

---

## 1. 顶层

```jsonc
{
  "meta":   { "project": "httpx", "generatedAt": "ISO8601",
              "extractor": { "name": "graphify", "version": "0.9.103", "mode": "code-only" },
              "warnings": ["降级说明、跳过原因等，直接显示在页面上"] },
  "stats":  { "nodes": 1883, "edges": 3960, "files": 77, "functions": 1068,
              "extracted": 3590, "inferred": 370 },
  "rootView": "v_root",
  "views":  { "<viewId>": View, ... },
  "flows":  [ Flow, ... ]
}
```

`warnings` 非空时页面顶部必须显示可展开提示条——**降级必须可见**，不能静默。

## 2. View

一个 View = 一屏图。**每屏 6–45 个节点**；超过说明分层还不够细。

```jsonc
{
  "id": "v_file_api",
  "level": 3,                    // 1=系统/分层 2=模块/文件 3=文件/类 4=函数
  "kind": "functions",           // layers | modules | files | classes | functions
  "title": "_api.py · 函数",
  "breadcrumb": ["v_root", "n_api", "fn_api"],   // 祖先路径，存 nodeId，渲染时取 label
  "note": "一句话说明这屏在讲什么（可空）",
  "nodes": [ Node, ... ],
  "edges": [ Edge, ... ]
}
```

## 3. Node

```jsonc
{
  "id": "f_get",                 // 所属 view 内唯一
  "label": "get()",              // 显示文字，短
  "kind": "function",            // layer|module|file|class|function|external|data
  "sub": "L24",                  // 次要信息：行号/文件数/函数数，可空
  "x": 60, "y": 40,              // 左上角，构建期算好，单位 px
  "w": 170, "h": 56,
  "drill": "v_file_api",         // 有则点击下钻到该 view；无则点击只开详情面板
  "xref": "httpx/_api.py:24",    // 证据锚点，详情面板显示、可复制
  "summary": "一句话职责",        // 可空
  "insight": {                   // 模型补的解释，可空，见 §6
    "role": "薄封装：把参数透传给一次性 Client",
    "risk": "…",
    "why": "…"
  }
}
```

`x/y/w/h` 由构建期布局填入，渲染器**不做任何布局计算**。

## 4. Edge

```jsonc
{
  "from": "f_get", "to": "f_request",
  "kind": "calls",           // calls | imports | contains | inherits | uses | depends
  "label": "9",              // 边上文字，可空
  "weight": 9,               // 相对粗细，缺省 1
  "confidence": "EXTRACTED"  // EXTRACTED（源码直读）| INFERRED（推断）| MIXED（聚合）
}
```

`INFERRED` 必须虚线，图例说明。聚合边的 confidence 取组成边里最弱的那个，
不允许把推断边标成 EXTRACTED。

## 5. Flow（关键链路）

跨层端到端路径，回答「这个系统怎么跑起来的」，独立于分层。

```jsonc
{
  "id": "fl_get",
  "title": "一次 httpx.get() 的完整路径",
  "steps": [ { "view": "v_file_api", "node": "f_get", "note": "用户入口" }, ... ]
}
```

点一步 = 跳到对应 view 并高亮该节点。`view`/`node` 必须存在，构建期校验。

## 6. insight 从哪来（反幻觉门）

`insight` 是唯一允许模型写内容的地方，也是唯一可能出错的地方：

1. 模型只能对**已存在的 node id** 写 `insight`，不能新增节点、不能改 label、不能编造边。
2. 模型输出单独落 `insights.json`：`{ "viewId": { "nodeId": {role, risk, why} } }`。
3. 构建脚本合并前校验：viewId/nodeId 不存在则**丢弃并记入 warnings**，同时打印被丢的 key
   （这是模型幻觉的量化指标）。
4. 详情面板里 `insight` 与抽取事实（`xref`、边）分区显示，不混在一起。

## 7. 构建产物契约

`scripts/build.mjs` 输出单个 `.html`，内联所有数据与代码：

```
assets/viewer.html   ──┐
                       ├─ build.mjs 替换占位符 ─→ arch.html（单文件，离线，无 CDN）
assets/viewer.css    ──┤
assets/viewer.js     ──┤
model.json           ──┘
```

`viewer.html` 里只有三个占位符：

```html
<style>/*__VIEWER_CSS__*/</style>
<script>window.__ARCH__ = /*__ARCH_DATA__*/;</script>
<script>/*__VIEWER_JS__*/</script>
```

替换规则：CSS/JS 用文件原文；`__ARCH_DATA__` 用 `JSON.stringify(model)`，并把
`</script` 转义成 `<\/script`。替换后断言：产物不含 `/*__VIEWER_` 字样。

## 8. 渲染器硬要求

- 单文件、离线、无 CDN、无网络请求；只用系统字体。
- 产物 JS+CSS 目标 ≤ 150 KB；model 数据大时允许总产物超出，但 warnings 里要报。
- 一屏只画一个 view；切换 view 时相机重置。
- 交互：滚轮缩放、拖拽平移、双击空白复位、面包屑回退、搜索跳转、点击节点看详情、
  键盘 `←` 返回 / `/` 聚焦搜索 / `Esc` 关面板。
- `drill` 节点必须有明显可点提示（角标或光晕），否则用户不知道能点。


## 9. 四页签扩展字段（v2）

```jsonc
{
  "meta": { "techstack": [ { "name": "Go", "ver": "1.25", "from": "go.mod", "kind": "lang" } ] },
  "intro": { "paragraphs": ["…"], "basis": ["docs/architecture.md"] },
  "startHere": [ { "view": "v_file_x", "node": "fn:x.py::f()", "label": "f()", "why": "全图调用度数最高" } ],
  "types": {
    "groups": [ { "id": "frontend", "name": "前端 / 插件",
                  "items": [ { "id": "frontend:ProblemContext", "name": "ProblemContext",
                               "file": "src/api.ts", "line": 2, "kind": "interface",
                               "fields": [{ "name": "site", "type": "string", "note": null }],
                               "truncated": false } ] } ],
    "links": [ { "from": "frontend:ProblemContext", "to": "backend:ProblemContext", "kind": "same-name" } ],
    "usages": [ { "type": "backend:ChatRequest", "funcs": ["fn:pkg/svc.go::Svc.Chat()"] } ]
  },
  "flows": [ { "id": "fl_x", "title": "…", "view": "v_flow_fl_x", "steps": 6 } ]
}
```

`types` 由 `scripts/types.mjs` 产出，支持 Go / TypeScript / Python / Java / Rust / SQL 六种声明形态；
分组优先按多端语义（backend/frontend/extension），否则按仓库真实顶层目录。
解析不出的字段用 `note` 标明「见原文」，不猜。

流程不再是底部条带的 steps 数组，而是**每条链路一个 view**（`kind: "flow"`），复用同一个渲染器；
底部条带只做入口。`types` 缺失时数据页显示空态，不影响其它三页。
