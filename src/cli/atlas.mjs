#!/usr/bin/env node
// atlas.mjs — 单一入口。按固定顺序跑完整条流水线，任何一步不过就停，并把「下一步该做什么」打出来。
//
//   node src/cli/atlas.mjs run --repo <仓库> [--out <产物.html>] [--groups g.json] [--insights i.json]
//   node src/cli/atlas.mjs doctor                     # 检查环境（graphify / node / 资产）
//   node src/cli/atlas.mjs verify --file <产物.html> [--browser s.json]
//
// 设计意图：让「跳过某一步也能出图」变得不可能。
//   - 没抽图 → 停下来告诉你怎么抽
//   - 没写 groups/insights → 构建拒绝执行（见 build.mjs）
//   - 质量不达标 → 构建失败（见 check.mjs）
//   - 产物不合格 → verify 失败

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = (f) => path.join(here, f);
const ASSET = (...p) => path.join(here, '..', '..', 'assets', ...p);

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

function node(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  return r.status;
}

function step(n, total, title) {
  console.log(`\n\x1b[36m[${n}/${total}] ${title}\x1b[0m`);
}

const args = parse(process.argv.slice(2));
const cmd = args._[0] || 'run';
const repo = path.resolve(args.repo && args.repo !== true ? args.repo : '.');

// ---------- doctor ----------
if (cmd === 'doctor') {
  const checks = [];
  const which = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' });
  const g = which('graphify');
  checks.push(['graphify', g.status === 0, g.status === 0 ? (g.stdout || '').trim().split('\n')[0] : '未安装（可 uv tool install graphifyy）']);
  checks.push(['node', true, process.version]);
  checks.push(['viewer assets', fs.existsSync(ASSET('viewer', 'viewer.html')) && fs.existsSync(ASSET('viewer', 'viewer.js')), ASSET()]);
  checks.push(['dagre (构建期布局)', fs.existsSync(ASSET('vendor', 'dagre.min.cjs')), 'vendored']);
  let ok = true;
  for (const [name, pass, detail] of checks) {
    console.log(`${pass ? '✓' : '✗'} ${name}  ${detail}`);
    if (!pass && name === 'graphify') ok = false;
  }
  if (!ok) {
    console.log('\n没有 graphify = 没有函数级调用边。可以先用降级路径：');
    console.log('  node src/extract/scan.mjs --repo <仓库> --out <tmp>/graph.json');
    console.log('  然后 build 时用 --graph 指过去（页面会明确标注"函数级调用未解析"）。');
  }
  process.exit(ok ? 0 : 0);
}

// ---------- verify ----------
if (cmd === 'verify') {
  const a = ['--file', args.file];
  if (args.browser && args.browser !== true) a.push('--browser', args.browser);
  process.exit(node(CLI('verify.mjs'), a) === 0 ? 0 : 1);
}

// ---------- run ----------
const TOTAL = 5;
const out = args.out && args.out !== true ? args.out : path.join(process.cwd(), 'atlas.html');
const graphPath = args.graph && args.graph !== true
  ? path.resolve(args.graph)
  : path.join(repo, 'graphify-out', 'graph.json');

// 1. 抽图
step(1, TOTAL, '抽取代码图');
if (fs.existsSync(graphPath)) {
  console.log(`  已有 ${path.relative(process.cwd(), graphPath)}（复用；要重抽就删掉它）`);
} else {
  console.log(`  运行 graphify extract（目标 ${repo}）…`);
  const r = spawnSync('graphify', ['extract', '.', '--code-only'], { cwd: repo, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(graphPath)) {
    console.error('\n  ✗ 抽图失败。两条路：');
    console.error('    a) 装好 graphify 后重跑：uv tool install graphifyy');
    console.error('    b) 走降级：node src/extract/scan.mjs --repo <仓库> --out <tmp>/graph.json');
    console.error('       然后重跑本命令并加 --graph <tmp>/graph.json（页面会标注函数级调用未解析）');
    process.exit(2);
  }
}

// 2. 出提案
step(2, TOTAL, '生成提案（proposal.json）');
const proposal = path.join(process.cwd(), 'proposal.json');
if (node(CLI('build.mjs'), ['propose', '--repo', repo, '--graph', graphPath, '--out', proposal]) !== 0) process.exit(3);
console.log('\n  ⚠ 下一步需要你（模型）读 proposal.json + README/入口文件，写两份输入：');
console.log('    groups.json   —— 分层：哪些文件属于哪层、层叫什么、一句话职责');
console.log('    insights.json —— 概览介绍 / 卡片职责 / 关键链路');
console.log('    格式见 schemas/*.schema.json 与 SKILL.md §4');

// 3. 检查输入
step(3, TOTAL, '检查模型输入');
const groups = args.groups && args.groups !== true ? path.resolve(args.groups) : null;
const insights = args.insights && args.insights !== true ? path.resolve(args.insights) : null;
if (!groups || !fs.existsSync(groups)) {
  console.error('  ✗ 缺 groups.json。没有它，构建会拒绝执行——分层必须由你判断，不能交给启发式。');
  console.error('    写好后重跑：node src/cli/atlas.mjs run --repo <仓库> --groups <g.json> --insights <i.json>');
  process.exit(4);
}
if (!insights || !fs.existsSync(insights)) {
  console.error('  ✗ 缺 insights.json。没有它，四页签会是空壳（概览无字、卡片无职责、流程页空）。');
  process.exit(4);
}
for (const [label, p] of [['groups.json', groups], ['insights.json', insights]]) {
  try { JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`  ✗ ${label} 不是合法 JSON：${e.message}`); process.exit(4); }
}
console.log('  ✓ groups.json / insights.json 就绪');

// 4. 构建（严格）
step(4, TOTAL, '构建（质量门默认开启）');
if (node(CLI('build.mjs'), ['build', '--repo', repo, '--graph', graphPath, '--groups', groups, '--insights', insights, '--out', out]) !== 0) {
  console.error('\n  ✗ 构建未通过质量门。按上面的 ✗ 逐条修，再重跑。');
  console.error('    （只想先看效果：加 --force，但产物会带黄条，且不能算交付。）');
  process.exit(5);
}

// 5. 验证
step(5, TOTAL, '验证产物');
const va = ['--file', out];
if (args.browser && args.browser !== true) va.push('--browser', args.browser);
if (node(CLI('verify.mjs'), va) !== 0) process.exit(6);

console.log('\n\x1b[32m完成\x1b[0m  产物: ' + out);
if (!args.browser) {
  console.log('渲染层仍未验证。有浏览器时执行：');
  console.log('  await page.evaluate(() => window.__archSelfTest())  → 存成 selftest.json');
  console.log('  node src/cli/atlas.mjs verify --file ' + path.basename(out) + ' --browser selftest.json');
}
