// bench.mjs — 量化基准：在一次性副本上跑四种场景，打印可直接贴进文档的表格。
//
//   node tests/bench.mjs --repo <仓库> --groups <g.json> --insights <i.json>
//
// 只读原仓库：所有测量都在临时副本上进行（跳过 node_modules / .git / 产物目录）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
if (!args.repo || !args.groups || !args.insights) {
  console.error('用法: node tests/bench.mjs --repo <仓库> --groups <g.json> --insights <i.json>');
  process.exit(1);
}

// 先确认输入是能出图的：否则四个场景测到的只是"失败有多快"
const insightsDoc = JSON.parse(fs.readFileSync(path.resolve(args.insights), 'utf8'));
if (!insightsDoc.intro || !Array.isArray(insightsDoc.intro.paragraphs) || insightsDoc.intro.paragraphs.length === 0) {
  console.error('✗ 这份 insights 没有 intro.paragraphs（概览页文字），构建会立刻失败，基准无意义。');
  console.error('  先跑一次完整命令确认能出图：');
  console.error(`    node src/cli/atlas.mjs run --repo ${args.repo} --groups ${args.groups} --insights ${args.insights}`);
  process.exit(1);
}

const SKIP = new Set(['node_modules', '.git', '.atlas', 'graphify-out', 'dist', 'out', 'coverage', 'target', '.venv', '__pycache__', 'vendor']);

function copyRepo(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyRepo(from, to);
    else fs.copyFileSync(from, to);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bench-'));
const repo = path.join(tmp, 'repo');
copyRepo(path.resolve(args.repo), repo);

const run = (extra = []) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [
    path.join(root, 'src/cli/atlas.mjs'), 'run',
    '--repo', repo,
    '--groups', path.resolve(args.groups),
    '--insights', path.resolve(args.insights),
    ...extra,
  ], { encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
};

const secs = (ms) => (ms / 1000).toFixed(2) + ' s';

/** 场景失败就不该再报数字：失败可能是质量门、缺依赖、输入不合法 */
function mustSucceed(label, r) {
  if (r.status === 0) return;
  console.error(`\n✗ 场景「${label}」失败（exit ${r.status}）——基准测到的只是"失败有多快"，数字不可用。`);
  const detail = (r.stderr || '').split(/\r?\n/).filter(Boolean).slice(0, 8);
  if (detail.length) console.error(detail.map((l) => '  ' + l).join('\n'));
  console.error('\n  先手动跑一次，按提示修好输入再回来：');
  console.error(`    node src/cli/atlas.mjs run --repo ${args.repo} --groups ${args.groups} --insights ${args.insights}`);
  process.exit(1);
}

// A. 首次全量（冷缓存）
const first = run(['--fresh']);
mustSucceed('首次全量', first);

// B. 无变化复用
const reuse = run();
mustSucceed('无变化再跑', reuse);

// C. 只改 insights（跳过抽图）
const insightsAlt = path.join(tmp, 'insights-alt.json');
const ins = insightsDoc;
ins.intro.paragraphs[0] = ins.intro.paragraphs[0] + '（基准测试改动）';
fs.writeFileSync(insightsAlt, JSON.stringify(ins, null, 2));
const buildOnly = (() => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [
    path.join(root, 'src/cli/atlas.mjs'), 'run',
    '--repo', repo,
    '--groups', path.resolve(args.groups),
    '--insights', insightsAlt,
  ], { encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: r.status, stderr: r.stderr || '' };
})();
mustSucceed('只改 insights', buildOnly);

// D. 改一处代码（增量更新）
const srcFile = (function find(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = find(p); if (hit) return hit; }
    else if (/\.(go|py|ts|tsx|java|rs|js)$/.test(e.name)) return p;
  }
  return null;
})(repo);
if (srcFile) fs.appendFileSync(srcFile, '\n// bench touch\n');
const update = run();
mustSucceed('改一处代码', update);

// 产物与模型统计
const outFile = path.join(repo, '.atlas', 'atlas.html');
const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
if (!size) {
  console.error('\n✗ 四次运行都"成功"但产物不存在或为空——基准结果不可信。');
  process.exit(1);
}
const modelFile = path.join(repo, '.atlas', 'model.json');
let stats = { views: 0, types: 0, fnCards: 0 };
if (fs.existsSync(modelFile)) {
  const m = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  const views = Object.values(m.views || {});
  stats.views = views.length;
  stats.fnCards = views.filter((v) => v.kind === 'functions').reduce((n, v) => n + (v.nodes || []).length, 0);
  stats.types = ((m.types && m.types.groups) || []).reduce((n, g) => n + (g.items || []).length, 0);
}

console.log('\n## 基准结果\n');
console.log('| 场景 | 耗时 | 说明 |');
console.log('| --- | --- | --- |');
console.log(`| 首次全量（冷缓存） | ${secs(first.ms)} | 抽图 + 构建 + 验证 |`);
console.log(`| 无变化再跑 | ${secs(reuse.ms)} | 直接复用产物 |`);
console.log(`| 只改 insights | ${secs(buildOnly.ms)} | 跳过抽图 |`);
console.log(`| 改一处代码 | ${secs(update.ms)} | 增量更新 |`);
console.log('');
console.log('| 产物 | 值 |');
console.log('| --- | --- |');
console.log(`| HTML 体积 | ${(size / 1024).toFixed(1)} KB |`);
console.log(`| 视图数 | ${stats.views} |`);
console.log(`| 类型数 | ${stats.types} |`);
console.log(`| 函数卡 | ${stats.fnCards} |`);
console.log('');
console.log(`复现: node tests/bench.mjs --repo ${args.repo} --groups ${args.groups} --insights ${args.insights}`);

fs.rmSync(tmp, { recursive: true, force: true });
