#!/usr/bin/env node
// build.mjs — 唯一的构建入口。
//
//   node src/cli/build.mjs propose --repo <仓库> --graph <graph.json> --out proposal.json
//   node src/cli/build.mjs build   --repo <仓库> --graph <graph.json> \
//                                  [--groups groups.json] [--insights insights.json] \
//                                  --out arch.html
//
// 只读 graph.json，不调用 graphify；抽图是 SKILL.md 里单独一步。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, makeProposal } from '../model/adapt.mjs';
import { layoutModel } from '../model/layout.mjs';
import { checkModel } from '../model/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const A = (p) => path.join(here, '..', '..', p);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function die(msg) {
  console.error('[build] ' + msg);
  process.exit(2);
}

function readJson(p, label) {
  if (!p || p === true) return null;
  if (!fs.existsSync(p)) die(`${label} 不存在: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(`${label} 不是合法 JSON: ${p}\n${e.message}`);
  }
}

function resolveGraph(args) {
  const explicit = args.graph && args.graph !== true ? args.graph : null;
  if (explicit) return explicit;
  const repo = args.repo && args.repo !== true ? args.repo : '.';
  const guess = path.join(repo, 'graphify-out', 'graph.json');
  if (fs.existsSync(guess)) return guess;
  die(
    '找不到 graph.json。先抽图：\n' +
      '  graphify extract . --code-only      # 在仓库根执行\n' +
      '然后用 --graph <路径> 指过来（默认找 <repo>/graphify-out/graph.json）。'
  );
}

// ---------- propose ----------

function cmdPropose(args) {
  const graphPath = resolveGraph(args);
  const graph = readJson(graphPath, 'graph.json');
  const repo = args.repo && args.repo !== true ? args.repo : '.';
  const proposal = makeProposal(graph, { repo: path.resolve(repo) });
  const out = args.out && args.out !== true ? args.out : 'proposal.json';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(proposal, null, 2));
  const lines = proposal.containers.map((c) => `  ${c.key}  ${c.files} 文件 / ${c.symbols} 符号`);
  console.log(`[build] 图: ${proposal.totals.nodes} 节点 / ${proposal.totals.edges} 边`);
  console.log('[build] 顶层容器：\n' + lines.join('\n'));
  console.log(`[build] proposal 已写: ${out}`);
}

// ---------- build ----------

function stubViewer(model) {
  // 渲染器还没就位时的开发预览：把 model 里的盒子按算好的坐标画出来
  const views = Object.values(model.views);
  const svgFor = (v) => {
    const pad = 30;
    const W = Math.max(...v.nodes.map((n) => n.x + n.w)) + pad;
    const H = Math.max(...v.nodes.map((n) => n.y + n.h)) + pad;
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    const edges = (v.edges || [])
      .filter((e) => byId.has(e.from) && byId.has(e.to))
      .map((e) => {
        const a = byId.get(e.from), b = byId.get(e.to);
        const x1 = a.x + a.w / 2, y1 = a.y + a.h / 2, x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#555" marker-end="url(#a)"/>`;
      })
      .join('');
    const boxes = v.nodes
      .map(
        (n) =>
          `<g><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="#1b2230" stroke="#3d4a63"/>` +
          `<text x="${n.x + 10}" y="${n.y + 24}" fill="#dbe4f0" font-size="13">${esc(n.label)}</text>` +
          `<text x="${n.x + 10}" y="${n.y + 42}" fill="#7f8ea8" font-size="11">${esc(n.sub || '')}</text></g>`
      )
      .join('');
    return `<section><h2>${esc(v.title)} <small>${v.nodes.length}n/${(v.edges || []).length}e</small></h2>
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 z" fill="#555"/></marker></defs>${edges}${boxes}</svg></section>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>${esc(model.meta.project)} — dev preview</title>
<style>body{background:#0d1117;color:#c9d1d9;font:13px system-ui,sans-serif;padding:20px}
h2{font-size:14px;font-weight:600;margin:18px 0 8px;color:#8b98ad}small{color:#5a667a;font-weight:400}
section{overflow:auto;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:16px}</style>
<h1>${esc(model.meta.project)} — 开发预览（渲染器未就位）</h1>
<p>${model.stats.nodes} 节点 / ${model.stats.edges} 边 / ${Object.keys(model.views).length} 屏</p>
${views.map(svgFor).join('')}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function cmdBuild(args) {
  const graphPath = resolveGraph(args);
  const graph = readJson(graphPath, 'graph.json');
  const repo = args.repo && args.repo !== true ? args.repo : '.';
  const groups = readJson(args.groups, 'groups.json');
  const insights = readJson(args.insights, 'insights.json');
  if (!groups && !args['auto-groups']) {
    die(
      '缺少 groups.json：分层必须由你（模型）根据 propose 的输出写，不能交给启发式。\n' +
      '  先跑：node src/cli/build.mjs propose --repo <仓库> --out proposal.json\n' +
      '  再照 examples/ 里的格式写 groups.json，然后用 --groups 指过来。\n' +
      '  （确实只想看机器分层，加 --auto-groups，产物会带警告。）'
    );
  }
  if (!groups) warnings.push('未提供 groups.json，使用了启发式分层（不是真实架构）');
  if (!insights && !args['no-insights']) {
    die(
      '缺少 insights.json：概览介绍、卡片职责、关键链路都来自它，没有它四页签是三张空图。\n' +
      '  照 examples/*-insights.json 的格式写，然后用 --insights 指过来；\n' +
      '  （明确只做骨架图，加 --no-insights。）'
    );
  }
  if (!insights) warnings.push('未提供 insights.json，所有卡片将只显示机器指标');

  const warnings = [];
  const techstack = detectTechstack(repo);
  let types = null;
  try {
    const mod = await import('../types/index.mjs');
    if (typeof mod.extractTypes === 'function') {
      types = mod.extractTypes(path.resolve(repo), graph);
      const nTypes = (types.groups || []).reduce((a, g) => a + (g.items || []).length, 0);
      console.log(`[build] 数据结构: ${nTypes} 个类型 / ${(types.links || []).length} 条跨端连线`);
    }
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') console.warn('[build] 未找到 src/types/index.mjs，数据页将为空');
    else console.warn('[build] 数据结构抽取失败: ' + e.message);
  }
  if ((graph.graph || {}).graphify_version === 'scan-fallback') {
    warnings.push('本次使用降级抽取（--scan）：只有文件级 import 关系，没有函数级调用边');
  }
  const model = buildModel(graph, {
    repo,
    project: args.title && args.title !== true ? args.title : undefined,
    groups,
    insights,
    extractor: { name: 'graphify', version: args['extractor-version'] || '0.9.103', mode: 'code-only' },
    techstack,
    types,
    maxGroups: num(args['max-groups'], 12),
    maxFiles: num(args['max-files'], 24),
    maxFns: num(args['max-fns'], 24),
    warnings,
  });
  layoutModel(model);

  // 几何门禁：在写文件之前拦住「打开就扁/重叠/空屏」
  const geo = checkModel(model);
  for (const w of geo.warnings) warnings.push(w);
  if (geo.errors.length) {
    console.error('[build] 质量门槛未通过：');
    for (const e of geo.errors) console.error('  ✗ ' + e);
    if (!args.force) {
      die(
        '构建已中止（这是默认行为，防止产出"看着有、其实残缺"的页面）。\n' +
        '  修好上面的问题后重跑；如果确实要先看效果，加 --force 强行构建（会在产物 warnings 里留痕）。'
      );
    }
    console.error('[build] --force：强行继续，这些问题会写进页面顶部的黄条。');
    for (const e of geo.errors) warnings.push(e);
  }
  console.log(`[build] 几何: ${geo.info.views} 屏 / 最小缩放 ${geo.info.minK}` +
    (geo.errors.length ? ` / ✗ ${geo.errors.length} 个错误` : ' / ✓') +
    (geo.warnings.length ? ` / ⚠ ${geo.warnings.length} 个提示` : ''));

  const out = args.out && args.out !== true ? args.out : 'arch.html';
  const viewerHtml = fs.existsSync(A('assets/viewer/viewer.html')) ? fs.readFileSync(A('assets/viewer/viewer.html'), 'utf8') : null;
  const viewerCss = fs.existsSync(A('assets/viewer/viewer.css')) ? fs.readFileSync(A('assets/viewer/viewer.css'), 'utf8') : '';
  const viewerJs = fs.existsSync(A('assets/viewer/viewer.js')) ? fs.readFileSync(A('assets/viewer/viewer.js'), 'utf8') : '';

  let html;
  if (viewerHtml && viewerJs) {
    const data = JSON.stringify(model).replace(/<\/script/gi, '<\\/script');
    html = viewerHtml
      .replace('/*__VIEWER_CSS__*/', () => viewerCss)
      .replace('/*__ARCH_DATA__*/', () => data)
      .replace('/*__VIEWER_JS__*/', () => viewerJs);
    const leftover = html.match(/\/\*__VIEWER_\w+__\*\//g);
    if (leftover) die('模板占位符未替换: ' + leftover.join(', '));
    if (leftover === null && /<script[^>]+src=["']https?:/.test(html)) die('产物里有外链 <script src>，违反离线约束');
  } else {
    html = stubViewer(model);
    console.warn('[build] 未找到 assets/viewer/viewer.html|viewer.js，输出开发预览而非正式页面');
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  fs.writeFileSync(path.join(path.dirname(path.resolve(out)), 'model.json'), JSON.stringify(model, null, 2));

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`[build] 视图: ${Object.keys(model.views).length} 屏  |  ` +
    Object.entries(model.views).map(([k, v]) => `${k}:${v.nodes.length}n`).slice(0, 12).join(' '));
  console.log(`[build] 输出: ${out}  (${kb(Buffer.byteLength(html))})`);
  if (warnings.length) console.log('[build] 告警:\n  - ' + [...new Set(warnings)].join('\n  - '));
}

function detectTechstack(repo) {
  const out = [];
  const read = (p) => { try { return fs.readFileSync(path.resolve(repo, p), 'utf8'); } catch { return null; } };
  const push = (name, ver, from, kind) => {
    if (out.some((x) => x.name === name)) return;
    out.push({ name, ver: ver || '', from, kind: kind || 'framework' });
  };

  // 语言 / 运行时
  const gomod = read('backend/go.mod') || read('go.mod');
  if (gomod) {
    const v = /^go\s+([\d.]+)/m.exec(gomod);
    push('Go', v ? v[1] : '', 'go.mod', 'lang');
    if (/github\.com\/gin-gonic\/gin/.test(gomod)) push('Gin', '', 'go.mod');
    if (/jackc\/pgx|lib\/pq/.test(gomod)) push('pgx', '', 'go.mod');
  }
  for (const dir of ['frontend', 'extension', '.']) {
    const pkg = read(`${dir === '.' ? '' : dir + '/'}package.json`);
    if (!pkg) continue;
    let j; try { j = JSON.parse(pkg); } catch { continue; }
    const deps = { ...(j.dependencies || {}), ...(j.devDependencies || {}) };
    const pick = { react: 'React', vue: 'Vue', svelte: 'Svelte', next: 'Next.js', vite: 'Vite',
      typescript: 'TypeScript', zustand: 'Zustand', axios: 'axios', tailwindcss: 'Tailwind' };
    for (const [k, label] of Object.entries(pick)) {
      if (deps[k]) push(label, String(deps[k]).replace(/^[^\d]*/, ''), `${dir === '.' ? '' : dir + '/'}package.json`);
    }
  }
  const req = read('requirements.txt') || read('backend/requirements.txt');
  if (req) { push('Python', '', 'requirements.txt', 'lang'); if (/fastapi/i.test(req)) push('FastAPI', '', 'requirements.txt'); if (/django/i.test(req)) push('Django', '', 'requirements.txt'); }
  const pyproj = read('pyproject.toml');
  if (pyproj) { push('Python', '', 'pyproject.toml', 'lang'); if (/fastapi/i.test(pyproj)) push('FastAPI', '', 'pyproject.toml'); }
  if (read('Cargo.toml')) push('Rust', '', 'Cargo.toml', 'lang');

  // 数据库 / 中间件
  const compose = read('docker-compose.yml') || read('docker-compose.yaml') || read('compose.yml');
  if (compose) {
    if (/postgres/i.test(compose)) push('PostgreSQL', '', 'docker-compose.yml', 'db');
    if (/mysql/i.test(compose)) push('MySQL', '', 'docker-compose.yml', 'db');
    if (/mongo/i.test(compose)) push('MongoDB', '', 'docker-compose.yml', 'db');
    if (/redis/i.test(compose)) push('Redis', '', 'docker-compose.yml', 'db');
  }
  const env = read('.env.example') || read('backend/.env.example');
  if (env) {
    if (/DEEPSEEK|OPENAI|ANTHROPIC|GEMINI/i.test(env)) push('LLM API', '', '.env.example', 'service');
    if (/DATABASE_URL/.test(env) && !out.some((x) => x.kind === 'db')) push('PostgreSQL', '', '.env.example', 'db');
  }
  return out.slice(0, 8);
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || 'build';
if (cmd === 'propose') cmdPropose(args);
else if (cmd === 'build') await cmdBuild(args);
else die(`未知子命令: ${cmd}（可用: propose | build）`);
