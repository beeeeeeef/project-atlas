// check.mjs — 几何门禁：在构建期就拦住「打开后不好看/看不清」这类问题。
// 零依赖，只读 model。build.mjs 每次都会跑；--strict 时发现问题直接失败。
import path from 'node:path';

const STAGE = { w: 1440, h: 900 };
const PAD = 52;
const HEAD_H = 79;      // 悬浮标题区高度（与 viewer.css 的实际值对齐）
const PAD_BOT = 46;
const MIN_K = 0.45;     // 低于这个缩放，字就看不清了
const MIN_INTRO_PARAS = 2;    // 概览页至少两段介绍，否则等于没有概览
const MIN_FLOWS = 1;          // 至少一条端到端链路
const MIN_FN_COVERAGE = 0.5;  // 函数卡里「模型写了一句话功能」的比例下限
const MIN_NODES = 2;    // 少于 2 个节点的屏没有意义
const MAX_NODES = 45;   // 超过这个数一屏放不下

/** 复刻 viewer.js 里 fitView 的缩放公式，估算首屏观感 */
function estimateK(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + (n.w || 160)); y1 = Math.max(y1, n.y + (n.h || 56));
  }
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const padTop = HEAD_H + 10;
  const avW = Math.max(80, STAGE.w - PAD * 2);
  const avH = Math.max(80, STAGE.h - padTop - PAD_BOT);
  return Math.min(avW / bw, avH / bh, 1.45);
}

function overlaps(nodes) {
  let n = 0;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const ax2 = a.x + (a.w || 160), ay2 = a.y + (a.h || 56);
      const bx2 = b.x + (b.w || 160), by2 = b.y + (b.h || 56);
      if (a.x < bx2 && b.x < ax2 && a.y < by2 && b.y < ay2) n++;
    }
  }
  return n;
}

/**
 * @returns {{errors: string[], warnings: string[], info: object}}
 */
export function checkModel(model) {
  const errors = [];
  const warnings = [];
  const views = Object.values(model.views || {});
  const kinds = {};

  for (const v of views) {
    const nodes = v.nodes || [];
    const where = `${v.id}「${v.title}」`;
    kinds[v.kind] = (kinds[v.kind] || 0) + 1;

    if (!nodes.length) { errors.push(`${where} 没有节点（空屏会被渲染成纯背景）`); continue; }
    if (nodes.length < MIN_NODES) warnings.push(`${where} 只有 ${nodes.length} 个节点，建议合并到上一层`);
    if (nodes.length > MAX_NODES) errors.push(`${where} 有 ${nodes.length} 个节点，超过 ${MAX_NODES} 上限，一屏放不下`);

    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { errors.push(`${where} 的节点「${n.label}」没有坐标（布局漏了）`); break; }
      if (!n.w || !n.h) { errors.push(`${where} 的节点「${n.label}」没有尺寸`); break; }
    }

    const dup = nodes.length - new Set(nodes.map((n) => n.id)).size;
    if (dup) errors.push(`${where} 有 ${dup} 个重复节点 id`);

    const bad = (v.edges || []).filter((e) => !nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to));
    if (bad.length) warnings.push(`${where} 有 ${bad.length} 条边的端点不在本屏`);

    const k = estimateK(nodes);
    if (k < MIN_K) {
      warnings.push(`${where} 在 1440×900 下约缩放到 ${k.toFixed(2)}（低于 ${MIN_K}），字会很小；考虑拆层或精简节点`);
    }
    const ov = overlaps(nodes);
    if (ov) errors.push(`${where} 有 ${ov} 对节点重叠`);
  }

  // ---- 内容完备性：这四项缺了，四页签就是"空壳" ----
  const intro = model.intro || {};
  if ((intro.paragraphs || []).length < MIN_INTRO_PARAS) {
    errors.push(`概览页只有 ${(intro.paragraphs || []).length} 段介绍（至少要 ${MIN_INTRO_PARAS} 段），等于没有概览`);
  }
  if (!(model.startHere || []).length) {
    errors.push('没有「从这读起」的入口，新人不知道先点哪里');
  }
  if ((model.flows || []).length < MIN_FLOWS) {
    errors.push(`没有关键链路（至少 ${MIN_FLOWS} 条），流程页是空的`);
  }

  // ---- 函数卡介绍覆盖率：卡上有字还是只有行号 ----
  let fnTotal = 0, fnCovered = 0, fallback = [];
  for (const v of views) {
    if (v.kind !== 'functions') continue;
    for (const node of v.nodes || []) {
      fnTotal++;
      if (node.insight && node.insight.role) fnCovered++;
      else fallback.push(node.label);
    }
  }
  const coverage = fnTotal ? fnCovered / fnTotal : 1;
  if (fnTotal && coverage < MIN_FN_COVERAGE) {
    errors.push(
      `函数卡介绍覆盖率 ${Math.round(coverage * 100)}%（${fnCovered}/${fnTotal}），低于 ${Math.round(MIN_FN_COVERAGE * 100)}%；` +
      `先在 insights.json 的 functions 里补：${fallback.slice(0, 5).join('、')}${fallback.length > 5 ? ' …' : ''}`
    );
  }
  if (!(model.types && (model.types.groups || []).length)) {
    warnings.push('没有抽到任何数据结构，数据页会是空的（只支持 Go struct / TS interface / SQL 建表）');
  }

  if (!views.some((v) => v.id === model.rootView)) errors.push('rootView 指向的 view 不存在');
  const drilled = new Set();
  for (const v of views) for (const n of v.nodes || []) if (n.drill) drilled.add(n.drill);
  for (const v of views) if (v.level >= 2 && !drilled.has(v.id) && views.length > 3) {
    // 只是提示：孤立子屏说明它不可达
    warnings.push(`${v.id} 没有被任何上层节点 drill 到，用户点不进去`);
  }

  return {
    errors,
    warnings,
    info: {
      coverage: Math.round(coverage * 100),
      fnTotal,
      views: views.length,
      kinds,
      nodes: views.reduce((s, v) => s + (v.nodes || []).length, 0),
      minK: Math.min(...views.filter((v) => (v.nodes || []).length).map((v) => estimateK(v.nodes))).toFixed(2),
    },
  };
}

export const CHECK_LIMITS = { MIN_K, MAX_NODES, STAGE };
