// layout.mjs — 构建期用 dagre 算好每个 view 的坐标，产物里不需要任何布局库。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dagre = require(path.join(here, '..', '..', 'assets', 'vendor', 'dagre.min.cjs'));

// 盒宽按文字长度估：CJK 按 2 个宽度单位
function measure(s) {
  let w = 0;
  for (const ch of String(s || '')) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

// 宽度单位：CJK 记 2，拉丁记 1；每单位约 6.6px（10.5px 字号下的实测均值）
const UNIT_PX = 6.6;
const BODY_W = 300;              // 介绍文字的折行宽度
const LINE_H = 15;

function units(s) {
  let w = 0;
  for (const ch of String(s || '')) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

const CJK_RE = /[\u3000-\u9fff\uff00-\uffef]/;

function tokenize(str) {
  const toks = [];
  let buf = '';
  for (const ch of String(str || '')) {
    if (CJK_RE.test(ch)) { if (buf) { toks.push(buf); buf = ''; } toks.push(ch); }
    else if (ch === ' ') { if (buf) { toks.push(buf); buf = ''; } toks.push(' '); }
    else buf += ch;
  }
  if (buf) toks.push(buf);
  return toks;
}

/** 按词换行：拉丁单词整体不拆，中文按字；只有单词本身超宽才硬切 */
function wrapByUnits(str, maxUnits) {
  const toks = tokenize(str);
  const lines = [];
  let cur = '', u = 0;
  const flush = () => { if (cur.trim()) lines.push(cur.replace(/\s+$/, '')); cur = ''; u = 0; };
  const NO_BREAK_BEFORE = /^[。，、；：！？）】」』%]$/;
  for (const t of toks) {
    const tu = units(t);
    // 收尾标点不另起一行（避免出现只有「。」的一行）
    if (NO_BREAK_BEFORE.test(t) && cur.trim()) { cur += t; u += tu; continue; }
    if (u + tu > maxUnits && cur.trim()) flush();
    if (tu > maxUnits) {
      for (const ch of t) {
        const cu = units(ch);
        if (u + cu > maxUnits && cur) flush();
        cur += ch; u += cu;
      }
    } else {
      if (t === ' ' && !cur) continue;   // 行首空格丢掉
      cur += t; u += tu;
    }
  }
  flush();
  return lines;
}

/**
 * 卡片尺寸 + 折行都在构建期算好，写进 model；
 * 渲染器只按给定的行渲染，避免两边各算一套导致文字掉出边框。
 */
function sizeFor(node, kindOfView) {
  const isFlow = kindOfView === 'flow';
  const bodyU = Math.floor(BODY_W / UNIT_PX);

  const subLines = node.sub ? wrapByUnits(node.sub, bodyU) : [];
  node.subLines = subLines;

  const labelU = units(node.label);
  const metaU = units(node.metrics);
  const maxLineU = Math.max(labelU, metaU, ...subLines.map(units));
  let width = Math.round(maxLineU * UNIT_PX + 42);
  width = Math.max(width, isFlow ? 190 : 220);
  width += node.drill ? 52 : 0;          // 给右上角角标留位
  width = Math.min(width, isFlow ? 420 : 560);

  // +8：给字体下沉部（g/y/p 的下缘）留余量，避免最后一行的 descender 贴到边框
  const height = 24 + subLines.length * LINE_H + (node.metrics ? 17 : 0) + (subLines.length ? 4 : 0) + 8;
  return { width, height: Math.max(height, 48) };
}

/**
 * 给 model.views 里每个 view 的节点写入 x/y/w/h。
 * 只在构建期跑，一次。
 */
export function layoutModel(model) {
  for (const view of Object.values(model.views || {})) {
    const kind = view.kind || 'layers';
    const n = view.nodes.length;

    // 函数多的屏：dagre 会排成一条长链，纵向拉到几千像素，缩放开到 0.2 就看不清了。
    // 这种屏改用网格：信息密度高、字能看清，调用边照样画。
    if (kind === 'functions' && n > 10) {
      const cols = Math.ceil(Math.sqrt(n * 1.5));
      const gapX = 40, gapY = 26;
      let maxW = 0, maxH = 0;
      for (const node of view.nodes) {
        const s = sizeFor(node, kind);
        node.w = s.width; node.h = s.height;
        maxW = Math.max(maxW, node.w); maxH = Math.max(maxH, node.h);
      }
      view.nodes.forEach((node, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        node.x = 20 + c * (maxW + gapX);
        node.y = 20 + r * (maxH + gapY);
      });
      continue;
    }

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      // 分层与文件按「从左到右」读：左边是入口/上游，右边是被依赖的下游
      rankdir: (kind === 'functions' || kind === 'flow') ? 'TB' : 'LR',
      nodesep: kind === 'functions' ? 22 : (kind === 'flow' ? 26 : 34),
      ranksep: kind === 'functions' ? 46 : (kind === 'flow' ? 44 : 78),
      marginx: 40,
      marginy: 30,
      acyclicer: 'greedy',
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));

    for (const n of view.nodes) {
      const s = sizeFor(n, kind);
      n.w = s.width;
      n.h = s.height;
      g.setNode(n.id, { width: n.w, height: n.h });
    }
    const ids = new Set(view.nodes.map((n) => n.id));
    for (const [i, e] of (view.edges || []).entries()) {
      if (!ids.has(e.from) || !ids.has(e.to)) continue;
      g.setEdge(e.from, e.to, {}, 'e' + i);
    }

    try {
      dagre.layout(g);
    } catch (err) {
      // 自环/异常图：退化成网格，至少别让流程挂掉
      const cols = Math.ceil(Math.sqrt(view.nodes.length)) || 1;
      view.nodes.forEach((n, i) => {
        n.x = 60 + (i % cols) * 260;
        n.y = 40 + Math.floor(i / cols) * 120;
      });
      continue;
    }

    for (const n of view.nodes) {
      const gn = g.node(n.id);
      if (!gn) continue;
      n.x = Math.round(gn.x - n.w / 2);
      n.y = Math.round(gn.y - n.h / 2);
    }
    // 归一化到原点附近，渲染器直接按最小外接框缩放
    const minX = Math.min(...view.nodes.map((n) => n.x));
    const minY = Math.min(...view.nodes.map((n) => n.y));
    for (const n of view.nodes) {
      n.x = Math.round(n.x - minX + 20);
      n.y = Math.round(n.y - minY + 20);
    }
  }
  return model;
}
