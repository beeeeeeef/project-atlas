#!/usr/bin/env node
// verify.mjs — 产物验证器。构建成功 ≠ 能交付；这里检查"打包层 + 渲染层"。
//
//   node src/cli/verify.mjs --file arch.html
//   node src/cli/verify.mjs --file arch.html --browser selftest.json
//
// --browser 接收在浏览器里执行 window.__archSelfTest() 得到的 JSON（agent 用 Playwright 取），
// 用来确认页面真的渲染出来了，而不只是"文件存在"。
//
// 退出码：0 通过 / 1 不通过。通过时打印一段可直接贴进汇报的 Markdown 证据块。

import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}

const file = args.file && args.file !== true ? args.file : null;
if (!file) {
  console.error('[verify] 用法: --file <产物.html> [--browser <selftest.json>]');
  process.exit(1);
}

const fails = [];
const notes = [];

if (!fs.existsSync(file)) {
  console.error(`[verify] ✗ 产物不存在: ${file}`);
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(html);

// ---- 打包层 ----
const leftover = /\/\*__VIEWER_\w+__\*\//.test(html);
if (leftover) fails.push('模板占位符未替换（产物里还有 /*__VIEWER_...*/）');

const extRefs = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:[^"']+)["']/gi)].map((m) => m[1]);
if (extRefs.length) fails.push(`产物引用了外部资源（离线不可用）：${extRefs.slice(0, 3).join(', ')}`);

const netCalls = (html.match(/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/g) || []).length;
if (netCalls) fails.push(`产物里有 ${netCalls} 处网络调用`);

if (!/window\.__archSelfTest\s*=/.test(html)) fails.push('缺少 __archSelfTest 自检钩子（无法验证渲染结果）');

if (bytes > 3 * 1024 * 1024) notes.push(`体积 ${(bytes / 1024 / 1024).toFixed(1)} MB，偏大，考虑调小 --max-files/--max-fns`);

// ---- 数据层：内嵌的 model 是否完整 ----
const dataMatch = html.match(/window\.__ARCH__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
let model = null;
if (!dataMatch) {
  fails.push('找不到内嵌的 window.__ARCH__ 数据');
} else {
  try {
    model = JSON.parse(dataMatch[1].replace(/<\\\//g, '</'));
  } catch (e) {
    fails.push('内嵌 data 不是合法 JSON：' + e.message);
  }
}
if (model) {
  const views = Object.values(model.views || {});
  const fnViews = views.filter((v) => v.kind === 'functions');
  const cards = fnViews.reduce((n, v) => n + (v.nodes || []).length, 0);
  if (!views.length) fails.push('model 里没有任何视图');
  if (!(model.intro && (model.intro.paragraphs || []).length)) fails.push('model 里没有概览介绍');
  if (!(model.flows || []).length) fails.push('model 里没有关键链路');
  notes.push(`视图 ${views.length} 屏 / 函数卡 ${cards} 张 / 链路 ${(model.flows || []).length} 条`);
  const warn = (model.meta && model.meta.warnings) || [];
  if (warn.length) notes.push(`产物自带 ${warn.length} 条警告（页面顶部可见）：${String(warn[0]).slice(0, 60)}`);
}

// ---- 渲染层（需要 agent 提供浏览器自检结果）----
let browserInfo = null;
if (args.browser && args.browser !== true) {
  try {
    const raw = JSON.parse(fs.readFileSync(args.browser, 'utf8'));
    const st = raw.self || raw;
    browserInfo = st;
    if (!st.ok) fails.push(`浏览器自检未通过：${st.reason || 'unknown'}（stage ${st.stage?.w}×${st.stage?.h}, k=${st.k}）`);
    if (st.stage && st.stage.h < 400) fails.push(`画布高度只有 ${st.stage.h}px，页面被压扁`);
    if (typeof st.k === 'number' && st.k < 0.45) fails.push(`首屏缩放 ${st.k} 过低，字号不可读`);
  } catch (e) {
    fails.push('--browser 文件解析失败：' + e.message);
  }
} else {
  notes.push('未提供 --browser 自检结果：渲染层未验证（交付时必须说明这一点）');
}

// ---- 输出 ----
const kb = (bytes / 1024).toFixed(1);
console.log(`[verify] ${path.basename(file)}  ${kb} KB`);
for (const n of notes) console.log('  · ' + n);

if (fails.length) {
  console.error('[verify] ✗ 未通过：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}

console.log('[verify] ✓ 通过');
console.log('');
console.log('<!-- 把下面这段贴进交付说明 -->');
console.log('| 检查项 | 结果 |');
console.log('| --- | --- |');
console.log(`| 单文件体积 | ${kb} KB |`);
console.log(`| 占位符残留 | 0 |`);
console.log(`| 外部资源引用 | 0 |`);
console.log(`| 网络调用 | 0 |`);
console.log(`| 内嵌数据 | ${model ? `${Object.keys(model.views || {}).length} 屏、${(model.flows || []).length} 条链路` : '缺失'} |`);
console.log(`| 浏览器自检 | ${browserInfo ? `stage ${browserInfo.stage?.w}×${browserInfo.stage?.h}，k=${browserInfo.k}` : '未验证'} |`);
