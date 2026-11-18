// adapt.mjs — graphify graph.json → model.json（分层、聚合、预算、insight 合并）
// 契约见 references/model-schema.md。这里不做布局，布局在 layout.mjs。
import path from 'node:path';

// ---------- 分类 ----------

const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java',
  '.kt', '.kts', '.scala', '.groovy', '.gradle', '.c', '.h', '.cpp', '.cc',
  '.hpp', '.cu', '.cs', '.vb', '.rb', '.rake', '.php', '.swift', '.m', '.mm',
  '.lua', '.luau', '.zig', '.ex', '.exs', '.erl', '.hrl', '.ml', '.mli',
  '.jl', '.r', '.dart', '.vue', '.svelte', '.astro', '.sol', '.sh', '.bash',
  '.ps1', '.f90', '.pas', '.dpr', '.v', '.sv', '.cbl', '.cob', '.lisp', '.cl',
  '.cls', '.trigger',
]);

// 这些边构成函数级调用关系；其余（uses/references/rationale_for）是类型引用与文档关联，噪声大
const CALL_REL = new Set(['calls', 'indirect_call']);
const IMPORT_REL = new Set(['imports', 'imports_from']);
// 分组时默认丢弃的顶层目录：测试与文档不进架构图（可被 groups.json 的 skip 覆盖）
const DEFAULT_SKIP = [
  'node_modules', 'vendor', 'third_party', 'dist', 'build', 'target', '.git', '.github',
  'tests', 'test', '__tests__', 'spec', 'specs', 'docs', 'doc', 'examples', 'example',
  'benchmarks', 'bench', 'e2e', 'fixtures',
];

export function classify(n) {
  const label = n.label || '';
  if (n._callable_class === true) return 'class';
  if (n._py_property === true) return 'property';
  if (n._callable === true) return label.startsWith('.') ? 'method' : 'function';
  const src = n.source_file || '';
  if (src && label && path.basename(src) === label) return 'file';
  return 'other';
}

const isSymbol = (k) => k === 'function' || k === 'method' || k === 'property' || k === 'class';
const extOf = (p) => path.extname(p || '').toLowerCase();

// ---------- 主流程 ----------

/**
 * @param {object} graph  graphify 的 graph.json（已 parse）
 * @param {object} opts
 *   repo       仓库根（用于把绝对/相对路径归一）
 *   groups     groups.json 的内容（可空）
 *   insights   insights.json 的内容（可空）
 *   maxGroups / maxFiles / maxFns  预算
 *   warnings   追加告警的数组（就地 push）
 */
export function buildModel(graph, opts = {}) {
  const warnings = opts.warnings || [];
  const maxGroups = opts.maxGroups ?? 12;
  const maxFiles = opts.maxFiles ?? 24;
  const maxFns = opts.maxFns ?? 24;

  const nodes = graph.nodes || [];
  const links = graph.links || graph.edges || [];

  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);

  const kindOf = new Map();
  for (const n of nodes) kindOf.set(n.id, classify(n));

  // graphify 的方法 label 是 ".send()"（不带类名），同文件多个类会撞名。
  // 用 method 关系找回归属类，统一成 "ClassName.send()"，id 也跟着唯一。
  const ownerOf = new Map();
  for (const l of links) if (l.relation === 'method') ownerOf.set(l.target, l.source);
  const dispLabel = (n) => {
    const k = classify(n);
    const raw = String(n.label || '');
    if (k !== 'method') return raw;
    const base = raw.replace(/^\./, '');
    const owner = ownerOf.get(n.id);
    const cls = owner ? byId.get(owner)?.label : null;
    return cls ? `${String(cls).replace(/\(\)$/, '')}.${base}` : base;
  };
  const fnIdOf = new Map(); // graphify node id -> 产物里的节点 id
  for (const n of nodes) {
    if (!isSymbol(kindOf.get(n.id)) || !n.source_file) continue;
    fnIdOf.set(n.id, `fn:${n.source_file}::${dispLabel(n)}`);
  }

  // ---- 文件集合：文件节点 ∪ 代码符号的 source_file ----
  const files = new Map(); // relPath -> {path, nodes:[], deg:0}
  const ensureFile = (p) => {
    if (!p) return null;
    let f = files.get(p);
    if (!f) { f = { path: p, nodes: [], deg: 0 }; files.set(p, f); }
    return f;
  };

  for (const n of nodes) {
    const k = kindOf.get(n.id);
    const p = n.source_file;
    if (!p) continue;
    if (k === 'file') { if (CODE_EXT.has(extOf(p))) ensureFile(p); continue; }
    if (!isSymbol(k)) continue;
    if (!CODE_EXT.has(extOf(p))) continue;
    ensureFile(p).nodes.push(n.id);
  }
  // 一个符号都没有的空文件节点去掉（多半是 yml/配置）
  for (const [p, f] of files) if (!f.nodes.length && !CODE_EXT.has(extOf(p))) files.delete(p);

  // ---- 函数/方法级边 ----
  const fnEdges = [];
  for (const l of links) {
    if (!CALL_REL.has(l.relation)) continue;
    const sk = kindOf.get(l.source), tk = kindOf.get(l.target);
    if (!isSymbol(sk) || !isSymbol(tk)) continue;
    const s = byId.get(l.source), t = byId.get(l.target);
    if (!s?.source_file || !t?.source_file) continue;
    fnEdges.push({
      from: l.source, to: l.target,
      fromFile: s.source_file, toFile: t.source_file,
      confidence: l.confidence || 'INFERRED',
      weight: l.weight || 1,
    });
    const fs = files.get(s.source_file), ft = files.get(t.source_file);
    if (fs) fs.deg++;
    if (ft) ft.deg++;
  }
  // 符号度数：截断时优先保留「被调用/调用别人最多」的那些，而不是按字母序
  const symDeg = new Map();
  const symOut = new Map();
  const symIn = new Map();
  for (const e of fnEdges) {
    symDeg.set(e.from, (symDeg.get(e.from) || 0) + 1);
    symDeg.set(e.to, (symDeg.get(e.to) || 0) + 1);
    symOut.set(e.from, (symOut.get(e.from) || 0) + 1);
    symIn.set(e.to, (symIn.get(e.to) || 0) + 1);
  }

  // ---- 文件级边（函数边聚合 + import）----
  const fileAgg = new Map(); // "a→b" -> {from,to,calls,imports,weak}
  const bump = (from, to, field, conf) => {
    if (!from || !to || from === to) return;
    const key = from + '\u0000' + to;
    let e = fileAgg.get(key);
    if (!e) { e = { from, to, calls: 0, imports: 0, weak: false }; fileAgg.set(key, e); }
    e[field]++;
    if (conf === 'INFERRED') e.weak = true;
  };
  for (const e of fnEdges) bump(e.fromFile, e.toFile, 'calls', e.confidence);
  for (const l of links) {
    if (!IMPORT_REL.has(l.relation)) continue;
    const s = byId.get(l.source), t = byId.get(l.target);
    if (!s?.source_file || !t?.source_file) continue;
    if (kindOf.get(l.source) !== 'file' || kindOf.get(l.target) !== 'file') continue;
    if (!files.has(s.source_file) || !files.has(t.source_file)) continue;
    bump(s.source_file, t.source_file, 'imports', l.confidence);
  }

  // ---- 分组（层）----
  // 跳过测试/文档等：它们不进架构图，但保留在 stats 里
  const skip = new Set([...(opts.groups?.skip || []), ...DEFAULT_SKIP]);
  for (const p of [...files.keys()]) if (skip.has(p.split('/')[0])) files.delete(p);

  const { groups: autoGrouped, mode } = makeGroups(files, fileAgg, {
    maxGroups,
    depth: opts.groups?.depth ?? 1,
    forced: opts.groups?.grouping,
    layerCfg: new Map((opts.groups?.layers || []).map((l) => [l.key, l])),
  }, warnings);

  // 极端扁平仓库（几乎无跨文件依赖）：分不出层，就直接按文件分屏，别硬造一个只有 1 个块的「系统全景」
  let groups = autoGrouped;
  if (groups.length < 2 && files.size > 1) {
    const top = [...files.values()].sort((a, b) => b.deg - a.deg).slice(0, maxGroups);
    groups = top.map((f, i) => ({
      key: 'f' + i,
      name: path.basename(f.path),
      files: new Set([f.path]),
      deg: f.deg,
      kind: 'layer',
      role: '',
      hint: f.path,
    }));
    warnings.push('代码之间几乎没有跨文件依赖，分不出层次，已改为按文件分屏');
  }


  if (mode === 'clusters') {
    warnings.push('顶层代码目录不足 3 个，改用「按调用关系聚类」分组；可在 groups.json 里重命名或改成按目录分组');
  }

  const groupOfFile = new Map();
  for (const g of groups) for (const p of g.files) groupOfFile.set(p, g.key);

  // ---- 渲染所需 id ----
  const layerId = (key) => `layer:${key}`;
  const fileId = (p) => `file:${p}`;
  const fnId = (p, label) => `fn:${p}::${label}`;

  const insFiles = opts.insights?.files || {};
  const insFns = opts.insights?.functions || {};
  const insLayers = opts.insights?.layers || {};
  let dropped = 0;
  const usedInsights = new Set();

  const applyFileInsight = (node, p) => {
    const v = insFiles[p];
    if (!v) return;
    if (typeof v === 'string') { node.summary = v; node.insight = { role: v }; }
    else { node.summary = v.summary || node.summary; node.insight = pick(v); }
    usedInsights.add('file:' + p);
  };
  const applyFnInsight = (node, p, label) => {
    const v = insFns[`${p}::${label}`] || insFns[`${p}:${label}`];
    if (!v) return;
    // 字符串 = 只写一句话职责的简写形态
    if (typeof v === 'string') { node.summary = v; node.insight = { role: v }; }
    else { node.summary = v.summary || node.summary; node.insight = pick(v); }
    usedInsights.add('fn:' + p + '::' + label);
  };

  // ---- View: L1 分层 ----
  const views = {};
  const rootNodes = [];
  for (const g of groups) {
    const symCount = [...g.files].reduce((s, p) => s + (files.get(p)?.nodes.length || 0), 0);
    const node = {
      id: layerId(g.key),
      label: g.name,
      kind: g.kind,
      sub: '',
      metrics: `${g.files.size} 文件 · ${symCount} 符号`,
      w: 220, h: 78,
    };
    if (g.role) { node.sub = g.role; node.summary = g.role; }
    if (insLayers[g.key]) {
      const v = insLayers[g.key];
      if (typeof v === 'string') node.summary = v;
      else { node.summary = v.summary || node.summary; node.insight = pick(v); }
      usedInsights.add('layer:' + g.key);
    }
    rootNodes.push(node);
  }

  const groupEdges = new Map();
  for (const e of fileAgg.values()) {
    const a = groupOfFile.get(e.from), b = groupOfFile.get(e.to);
    if (!a || !b || a === b) continue;
    const key = a + '\u0000' + b;
    let g = groupEdges.get(key);
    if (!g) { g = { from: a, to: b, n: 0, weak: false }; groupEdges.set(key, g); }
    g.n += e.calls + e.imports * 0.5;
    if (e.weak) g.weak = true;
  }
  const rootEdges = [...groupEdges.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, 60)
    .map((g) => ({
      from: layerId(g.from), to: layerId(g.to),
      kind: 'depends',
      label: `${Math.round(g.n)} 次调用`,
      weight: Math.max(1, Math.min(12, Math.round(Math.sqrt(g.n)))),
      confidence: g.weak ? 'MIXED' : 'EXTRACTED',
    }));

  views['v_root'] = {
    id: 'v_root', level: 1, kind: 'layers',
    title: '系统分层',
    breadcrumb: [],
    note: `${groups.length} 个模块，${files.size} 个文件。线是跨模块依赖，数字是调用/导入条数。点有角标的块可以下钻。`,
    nodes: rootNodes,
    edges: rootEdges,
  };

  // ---- View: L2 每层的文件 ----
  for (const g of groups) {
    const vId = 'v_grp_' + slug(g.key);
    const fileList = [...g.files]
      .map((p) => files.get(p))
      .filter(Boolean)
      .sort((a, b) => b.deg - a.deg || a.path.localeCompare(b.path));
    let shown = fileList;
    if (fileList.length > maxFiles) {
      shown = fileList.slice(0, maxFiles);
      warnings.push(`模块「${g.name}」有 ${fileList.length} 个文件，只画了度数最高的 ${maxFiles} 个（--max-files 可调）`);
    }
    const shownSet = new Set(shown.map((f) => f.path));
    const vNodes = shown.map((f) => {
      const fns = f.nodes.filter((id) => isSymbol(kindOf.get(id)) && (kindOf.get(id) === 'function' || kindOf.get(id) === 'method'));
      const node = {
        id: fileId(f.path),
        label: f.path,
        kind: 'file',
        sub: '',
        metrics: `${fns.length} 函数 · 度 ${f.deg}`,
        w: 240, h: 78,
        xref: `${f.path}:1`,
      };
      applyFileInsight(node, f.path);
      if (!node.sub) {
        node.sub = (node.insight && node.insight.role)
          || (node.summary ? String(node.summary) : '');
      }
      return node;
    });
    const vEdges = [];
    for (const e of fileAgg.values()) {
      if (!shownSet.has(e.from) || !shownSet.has(e.to)) continue;
      vEdges.push({
        from: fileId(e.from), to: fileId(e.to),
        kind: e.calls ? 'calls' : 'imports',
        label: e.calls ? `调用 ${e.calls}` : `导入 ${e.imports}`,
        weight: Math.max(1, Math.min(10, Math.round(Math.sqrt(e.calls + e.imports)))),
        confidence: e.weak ? 'MIXED' : 'EXTRACTED',
      });
    }
    // 每个文件建一个函数级 view
    for (const f of shown) {
      const fid = 'v_file_' + slug(f.path);
      const fnNodes = [];
      // 排序：有模型写的介绍优先，其次按调用度数——保证露出的卡片大多带「一句话功能」
      const hasIns = (id) => {
        const n = byId.get(id);
        if (!n) return 0;
        const lb = dispLabel(n);
        return (insFns[`${f.path}::${lb}`] || insFns[`${f.path}:${lb}`]) ? 1 : 0;
      };
      const ordered = [...f.nodes].sort(
        (a, b) =>
          hasIns(b) - hasIns(a) ||
          (symDeg.get(b) || 0) - (symDeg.get(a) || 0) ||
          String(byId.get(a)?.label || '').localeCompare(String(byId.get(b)?.label || ''))
      );
      for (const id of ordered) {
        const n = byId.get(id);
        const k = kindOf.get(id);
        if (!isSymbol(k)) continue;
        if (k === 'class' || k === 'property') continue; // 类与属性在函数屏里作为结构提示，先只画可调用符号
        const nn = {
          id: fnIdOf.get(id) || fnId(f.path, n.label),
          label: dispLabel(n),
          kind: 'function',
          sub: '',
          metrics: `${locShort(n.source_location) || '—'} · 度 ${symDeg.get(id) || 0}`,
          w: 230, h: 74,
          xref: `${f.path}:${locNum(n.source_location)}`,
        };
        applyFnInsight(nn, f.path, dispLabel(n));
        if (!nn.sub) {
          nn.sub = (nn.insight && nn.insight.role)
            || (nn.summary ? String(nn.summary) : '')
            || `调用了 ${symOut.get(id) || 0} 个函数 · 被 ${symIn.get(id) || 0} 处调用`;
        }
        fnNodes.push(nn);
      }
      let fnShown = fnNodes;
      if (fnNodes.length > maxFns) {
        fnShown = fnNodes.slice(0, maxFns);
        warnings.push(`${f.path} 有 ${fnNodes.length} 个函数，只画了 ${maxFns} 个`);
      }
      const idSet = new Set(fnShown.map((n) => n.id));
      const fnEdgesView = [];
      for (const e of fnEdges) {
        if (e.fromFile !== f.path || e.toFile !== f.path) continue;
        const a = fnIdOf.get(e.from);
        const b = fnIdOf.get(e.to);
        if (!idSet.has(a) || !idSet.has(b)) continue;
        fnEdgesView.push({ from: a, to: b, kind: 'calls', label: '调用', confidence: e.confidence });
      }
      // 只有 struct / 常量 / 纯类型定义的文件没有可调用符号，不建函数屏（否则是空屏）
      if (fnShown.length) {
        views[fid] = {
          id: fid, level: 3, kind: 'functions',
          title: `${path.basename(f.path)} · 函数`,
          breadcrumb: ['v_root', 'v_grp_' + slug(g.key), fileId(f.path)],
          note: `${fnNodes.length} 个可调用符号，${fnEdgesView.length} 条同文件调用边。跨文件调用在上一屏。`,
          nodes: fnShown,
          edges: fnEdgesView,
        };
        // 文件节点挂 drill
        const fileNode = vNodes.find((n) => n.id === fileId(f.path));
        if (fileNode) fileNode.drill = fid;
      }
    }
    const single = g.files.size === 1 && shown.length === 1;
    if (!single) {
      views[vId] = {
        id: vId, level: 2, kind: 'files',
        title: `${g.name} · 文件`,
        breadcrumb: ['v_root', layerId(g.key)],
        note: `${g.files.size} 个文件，画了 ${shown.length} 个。点有角标的文件看函数级调用。`,
        nodes: vNodes,
        edges: vEdges,
      };
    }
    // 层节点挂 drill（只有 1 个文件的层直接跳到函数屏，不设中间层）
    const ln = views['v_root'].nodes.find((n) => n.id === layerId(g.key));
    if (ln && shown.length) ln.drill = single ? 'v_file_' + slug(shown[0].path) : vId;
  }

  // ---- 幻觉门：未命中的 insight ----
  for (const k of Object.keys(insFiles)) if (!usedInsights.has('file:' + k)) dropped++;
  for (const k of Object.keys(insFns)) {
    const p = k.split('::')[0] || k.split(':')[0];
    if (![...usedInsights].includes('fn:' + k) && ![...usedInsights].includes('fn:' + k.replace(':', '::'))) dropped++;
    void p;
  }
  for (const k of Object.keys(insLayers)) if (!usedInsights.has('layer:' + k)) dropped++;
  if (dropped) warnings.push(`${dropped} 条 insight 的 key 在抽取结果里找不到，已丢弃（模型幻觉或路径写错）`);

  // ---- flows：每条链路生成一个独立 view（复用同一个渲染器）----
  const flows = [];
  for (const f of opts.insights?.flows || []) {
    const raw = f.steps || [];
    const steps = raw.filter((s) => views[s.view] && (views[s.view].nodes || []).some((n) => n.id === s.node));
    if (steps.length !== raw.length) {
      warnings.push(`链路「${f.title || f.id}」有 ${raw.length - steps.length} 步找不到对应节点，已丢弃这些步`);
    }
    if (steps.length < 2) continue;

    const fid = 'v_flow_' + slug(f.id || 'fl' + flows.length);
    const fnodes = [];
    const fedges = [];
    steps.forEach((s, i) => {
      const src = (views[s.view].nodes || []).find((n) => n.id === s.node);
      fnodes.push({
        id: 's' + i,
        label: src ? src.label : s.node,
        kind: 'step',
        sub: s.note || src?.sub || src?.summary || '',
        badge: String(i + 1),
        link: { view: s.view, node: s.node },
        w: 172, h: 56,
      });
      if (i > 0) fedges.push({ from: 's' + (i - 1), to: 's' + i, kind: 'calls', label: '下一步', confidence: 'EXTRACTED' });
    });
    views[fid] = {
      id: fid, level: 0, kind: 'flow',
      title: f.title || '关键链路',
      breadcrumb: [],
      note: f.note || '按执行顺序排列。点任一步跳到架构图对应位置。',
      nodes: fnodes, edges: fedges,
    };
    flows.push({ id: f.id || 'fl' + flows.length, title: f.title || '关键链路', note: f.note || '', view: fid, steps: fnodes.length });
  }

  // ---- startHere：从哪读起（确定性：按调用度数取前 3 个可见符号）----
  const startHere = [];
  {
    const deg = new Map();
    for (const e of fnEdges) {
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    }
    const ranked = [...deg.entries()].sort((a, b) => b[1] - a[1]);
    for (const [gid, d] of ranked) {
      const nid = fnIdOf.get(gid);
      if (!nid) continue;
      const view = Object.values(views).find((v) => v.kind === 'functions' && (v.nodes || []).some((n) => n.id === nid));
      if (!view) continue;
      const node = view.nodes.find((n) => n.id === nid);
      startHere.push({
        view: view.id, node: nid, label: node.label,
        why: `全图调用度数最高（${d} 条边）`,
      });
      if (startHere.length >= 3) break;
    }
    for (const hint of opts.insights?.startHere || []) {
      const hit = startHere.find((s) => s.node === hint.node);
      if (hit && hint.why) hit.why = hint.why;
    }
  }

  // ---- intro：连续文字介绍（模型写，带依据）----
  const introIn = opts.insights?.intro || {};
  const intro = {
    paragraphs: Array.isArray(introIn.paragraphs) ? introIn.paragraphs.filter((x) => typeof x === 'string' && x.trim()) : [],
    basis: Array.isArray(introIn.basis) ? introIn.basis : [],
  };

  // 介绍覆盖率：函数卡上「一句话介绍」有多少是模型写的、多少是事实兜底
  {
    let total = 0, covered = 0;
    for (const v of Object.values(views)) {
      if (v.kind !== 'functions') continue;
      for (const n of v.nodes || []) {
        if (!n.sub || /^调用了 \d+ 个函数/.test(n.sub)) { total++; continue; }
        total++;
        if (n.insight && n.insight.role) covered++;
      }
    }
    if (total && covered / total < 0.6) {
      warnings.push(`函数卡介绍覆盖率 ${Math.round((covered / total) * 100)}%（${covered}/${total}），建议在 insights.json 里补 functions`);
    }
  }

  const symbolCount = nodes.filter((n) => isSymbol(kindOf.get(n.id))).length;
  return {
    meta: {
      project: opts.project || path.basename(opts.repo || '.'),
      generatedAt: new Date().toISOString(),
      extractor: opts.extractor || { name: 'graphify', version: '?', mode: 'code-only' },
      techstack: opts.techstack || [],
      warnings: [...new Set(warnings)],
    },
    stats: {
      nodes: nodes.length,
      edges: links.length,
      files: files.size,
      functions: symbolCount,
      extracted: links.filter((l) => l.confidence === 'EXTRACTED').length,
      inferred: links.filter((l) => l.confidence === 'INFERRED').length,
    },
    rootView: 'v_root',
    views,
    flows,
    intro,
    startHere,
    techstack: opts.techstack || [],
    types: opts.types || null,
  };
}

// ---------- proposal：给模型看的最小决策输入 ----------

export function makeProposal(graph, opts = {}) {
  const nodes = graph.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kindOf = new Map(nodes.map((n) => [n.id, classify(n)]));

  const dirs = new Map();
  for (const n of nodes) {
    const k = kindOf.get(n.id);
    const p = n.source_file;
    if (!p || !CODE_EXT.has(extOf(p))) continue;
    if (k !== 'file' && !isSymbol(k)) continue;
    const parts = p.split('/');
    const key = parts.length > 1 ? parts[0] : '(root)';
    let d = dirs.get(key);
    if (!d) { d = { key, files: new Set(), symbols: 0 }; dirs.set(key, d); }
    d.files.add(p);
    if (isSymbol(k)) d.symbols++;
  }

  const deg = new Map();
  for (const l of graph.links || []) {
    if (!CALL_REL.has(l.relation)) continue;
    deg.set(l.source, (deg.get(l.source) || 0) + 1);
    deg.set(l.target, (deg.get(l.target) || 0) + 1);
  }
  const gods = [...deg.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([id, d]) => ({ id, label: byId.get(id)?.label, file: byId.get(id)?.source_file, degree: d }));

  const containers = [...dirs.values()].map((d) => ({
    key: d.key,
    files: d.files.size,
    symbols: d.symbols,
    topFiles: [...d.files].slice(0, 12),
  })).sort((a, b) => b.symbols - a.symbols);

  return {
    repo: opts.repo,
    totals: { nodes: nodes.length, edges: (graph.links || []).length, files: dirs.size },
    containers,
    godNodes: gods,
    hint: '写 groups.json 给 containers 起中文名与职责；写 insights.json 补关键节点的解释。格式见 SKILL.md。',
  };
}

// ---------- 分组 ----------

/**
 * 分层策略，三条路：
 * 1. groups.json 里带 `match` 的层 → 按 glob 认领文件（模型表达真实架构，最优先）
 * 2. 顶层代码目录 ≥3 → 按目录分
 * 3. 否则（单包仓库很常见）→ 按文件级调用关系聚类，避免「目录树冒充架构」
 */
function makeGroups(files, fileAgg, o, warnings) {
  const paths = [...files.keys()];
  const topOf = (p) => (p.includes('/') ? p.split('/')[0] : '(root)');
  const dirCount = new Set(paths.map(topOf).filter((d) => d !== '(root)')).size;

  let mode = o.forced || 'auto';
  if (mode === 'auto') mode = dirCount >= 3 ? 'dirs' : 'clusters';

  const autoGroups = (subset) => {
    if (!subset.length) return [];
    if (mode === 'dirs') {
      const m = new Map();
      for (const p of subset) {
        const key = topOf(p);
        if (!m.has(key)) m.set(key, { key, files: new Set(), hint: key });
        m.get(key).files.add(p);
      }
      return [...m.values()];
    }
    const sub = new Map(subset.map((p) => [p, files.get(p)]));
    let raw = clusterFiles(sub, fileAgg).map((set, i) => {
      const members = [...set];
      const d = new Map();
      for (const p of members) {
        const dir = p.includes('/') ? p.split('/').slice(0, -1).join('/') : '.';
        d.set(dir, (d.get(dir) || 0) + 1);
      }
      const topFile = members
        .map((p) => [p, files.get(p)?.deg || 0])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      const top = [...d.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      // 簇主要落在包根目录时，目录名无法区分，用簇内最高度数的文件当代称
      const dominantDir = top ? top[0] : '.';
      const useFile = dominantDir === '.' || !dominantDir.includes('/');
      return { key: 'c' + i, files: new Set(set), hint: useFile ? topFile || dominantDir : dominantDir };
    });
    // 单文件簇并进路径前缀最长的邻居，避免碎片
    const singles = raw.filter((g) => g.files.size === 1);
    let rest = raw.filter((g) => g.files.size > 1);
    if (!rest.length) rest = raw;
    for (const s of singles) {
      if (!rest.length) break;
      const p = [...s.files][0];
      let best = null, bl = -1;
      for (const g of rest) {
        const common = commonPrefix([...g.files][0] || '', p);
        if (common > bl) { bl = common; best = g; }
      }
      if (best) for (const q of s.files) best.files.add(q);
    }
    return rest;
  };

  const explicit = [...o.layerCfg.values()].filter((c) => Array.isArray(c.match) && c.match.length);
  let raw;
  if (explicit.length) {
    const claimed = new Map();
    for (const c of explicit) {
      const res = c.match.map(globToRe);
      for (const p of paths) {
        if (claimed.has(p)) continue;
        if (res.some((r) => r.test(p))) claimed.set(p, c.key);
      }
    }
    raw = explicit
      .map((c) => ({
        key: c.key,
        files: new Set(paths.filter((p) => claimed.get(p) === c.key)),
        hint: null, name: c.name, role: c.role,
      }))
      .filter((g) => g.files.size);
    const left = paths.filter((p) => !claimed.has(p));
    if (left.length) {
      for (const g of autoGroups(left)) {
        let k = g.key;
        while (raw.some((x) => x.key === k)) k += '_';
        raw.push({ ...g, key: k });
      }
      warnings.push(`${left.length} 个文件没有匹配到 groups.json 里的任何一层，已自动归入附加模块`);
    }
    mode = 'explicit';
  } else {
    raw = autoGroups(paths);
  }

  const degOf = (g) => [...g.files].reduce((s, p) => s + (files.get(p)?.deg || 0), 0);
  let groups = raw.map((g) => ({ ...g, deg: degOf(g) }));
  groups.sort((a, b) => b.deg - a.deg || b.files.size - a.files.size);

  if (groups.length > o.maxGroups) {
    const keep = groups.slice(0, o.maxGroups - 1);
    const tail = groups.slice(o.maxGroups - 1);
    const merged = { key: 'other', files: new Set(), deg: 0, hint: '' };
    for (const g of tail) {
      for (const p of g.files) merged.files.add(p);
      merged.deg += g.deg;
    }
    groups = [...keep, merged];
    warnings.push(`模块数超过 ${o.maxGroups} 个，${tail.length} 个次要模块已合并为「其他」（--max-groups 可调）`);
  }

  for (const g of groups) {
    const cfg = o.layerCfg.get(g.key) || (g.hint ? o.layerCfg.get(g.hint) : null) || {};
    g.name = g.name || cfg.name || prettify(g.hint || g.key);
    g.role = g.role || cfg.role || '';
    g.kind = cfg.kind || (g.key === 'other' ? 'data' : 'layer');
  }
  return { groups, mode };
}

/** 极简 glob：* 不跨目录，** 跨目录 */
function globToRe(g) {
  const s = String(g)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + s + '$');
}

/** 文件级标签传播聚类（确定性遍历顺序，结果可复现） */
function clusterFiles(files, fileAgg) {
  const adj = new Map();
  const add = (a, b, w) => {
    if (!files.has(a) || !files.has(b) || a === b) return;
    if (!adj.has(a)) adj.set(a, new Map());
    const m = adj.get(a);
    m.set(b, (m.get(b) || 0) + w);
  };
  for (const e of fileAgg.values()) {
    const w = e.calls + e.imports * 0.5;
    if (!w) continue;
    add(e.from, e.to, w);
    add(e.to, e.from, w);
  }

  const order = [...files.keys()].sort();
  const label = new Map(order.map((p) => [p, p]));
  for (let it = 0; it < 24; it++) {
    let changed = false;
    for (const p of order) {
      const nb = adj.get(p);
      if (!nb) continue;
      const score = new Map();
      for (const [q, w] of nb) {
        const l = label.get(q);
        if (l === undefined) continue;
        score.set(l, (score.get(l) || 0) + w);
      }
      if (!score.size) continue;
      let best = null, bw = -1;
      for (const [l, w] of [...score.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
        if (w > bw) { bw = w; best = l; }
      }
      if (best && best !== label.get(p)) {
        label.set(p, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const buckets = new Map();
  for (const [p, l] of label) {
    if (!buckets.has(l)) buckets.set(l, new Set());
    buckets.get(l).add(p);
  }
  return [...buckets.values()];
}

function commonPrefix(a, b) {
  const x = a.split('/'), y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
}

// ---------- 小工具 ----------

function pick(v) {
  const out = {};
  if (v.role) out.role = v.role;
  if (v.risk) out.risk = v.risk;
  if (v.why) out.why = v.why;
  return Object.keys(out).length ? out : undefined;
}
function prettify(key) {
  if (!key || key === '(root)') return '根目录';
  const seg = key.split('/').filter(Boolean).pop() || key;
  if (/\.\w+$/.test(seg)) return seg.replace(/\.\w+$/, '').replace(/^_+/, '') || seg;
  return seg;
}
function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
}
function locShort(loc) {
  const m = /L(\d+)/.exec(loc || '');
  return m ? 'L' + m[1] : '';
}
function locNum(loc) {
  const m = /L(\d+)/.exec(loc || '');
  return m ? m[1] : '1';
}
