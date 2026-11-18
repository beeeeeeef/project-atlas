#!/usr/bin/env node
// scan.mjs — 零依赖降级抽取器：Graphify 装不上时用。
//
//   node src/extract/scan.mjs --repo <仓库> --out <tmp>/graph.json
//
// 产出与 graphify 的 graph.json **同构**（nodes/links/包含关系/import 边），
// 所以 adapt.mjs 不用改。区别：没有函数级调用边，node 也少一些字段。
// 页面上会通过 warnings 明确告知「函数级调用未解析」。

import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
const repo = path.resolve(args.repo || '.');
const out = args.out || path.join(repo, 'graphify-out', 'graph.json');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.next', '.cache']);
const LANGS = {
  py: 'python', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js',
  go: 'go', rs: 'rust', java: 'java', kt: 'java', cs: 'java', scala: 'java',
  rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c',
};
const MAX_FILE_BYTES = 512 * 1024;

const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (LANGS[ext]) files.push(p);
  }
})(repo);

const nodes = [];
const links = [];
const seen = new Set();
const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');

function addNode(n) {
  if (seen.has(n.id)) return null;
  seen.add(n.id);
  nodes.push(n);
  return n;
}

const fileNodeId = (rf) => 'f_' + slug(rf);

for (const abs of files) {
  const rf = rel(abs);
  let src;
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
    src = fs.readFileSync(abs, 'utf8');
  } catch { continue; }
  const lines = src.split(/\r?\n/);
  const lang = LANGS[path.extname(abs).slice(1).toLowerCase()];

  addNode({
    id: fileNodeId(rf), label: path.basename(rf), source_file: rf, source_location: 'L1',
    file_type: 'code', _origin: 'scan', community: 0, norm_label: path.basename(rf),
  });

  const add = (label, kind, line, owner) => {
    const id = 's_' + slug(rf) + '_' + slug(label.replace(/[()]/g, ''));
    const n = addNode({
      id, label, source_file: rf, source_location: 'L' + line, file_type: 'code',
      _origin: 'scan', community: 0, norm_label: label,
      _callable: kind !== 'class', _callable_class: kind === 'class',
    });
    if (!n) return id;
    links.push({ source: fileNodeId(rf), target: id, relation: 'contains', _origin: 'scan', confidence: 'EXTRACTED', confidence_score: 1, weight: 1, source_file: rf, source_location: 'L' + line });
    if (owner) links.push({ source: owner, target: id, relation: 'method', _origin: 'scan', confidence: 'EXTRACTED', confidence_score: 1, weight: 1, source_file: rf, source_location: 'L' + line });
    return id;
  };

  let currentClass = null;
  let classIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    const indent = (line.match(/^\s*/) || [''])[0].length;
    if (currentClass && line.trim() && indent <= classIndent) currentClass = null;

    let m;
    if (lang === 'python') {
      if ((m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line))) {
        currentClass = add(m[1], 'class', ln, null);
        classIndent = indent;
      } else if ((m = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line))) {
        add((currentClass ? '.' : '') + m[1] + '()', 'function', ln, currentClass);
      }
    } else if (lang === 'js') {
      if ((m = /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line))) {
        currentClass = add(m[1], 'class', ln, null);
        classIndent = indent;
      } else if ((m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line))) {
        add(m[1] + '()', 'function', ln, null);
      } else if ((m = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(line))) {
        add(m[1] + '()', 'function', ln, null);
      } else if (currentClass && (m = /^\s*(?:async\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line)) && !/^(if|for|while|switch|catch|return)$/.test(m[1])) {
        add('.' + m[1] + '()', 'function', ln, currentClass);
      }
    } else if (lang === 'go') {
      if ((m = /^func\s+\((?:\w+\s+)?\*?(\w+)\)\s*(\w+)\s*\(/.exec(line))) add('.' + m[2] + '()', 'function', ln, add(m[1], 'class', ln, null));
      else if ((m = /^func\s+(\w+)\s*\(/.exec(line))) add(m[1] + '()', 'function', ln, null);
      else if ((m = /^type\s+(\w+)\s+(?:struct|interface)/.exec(line))) add(m[1], 'class', ln, null);
    } else if (lang === 'rust') {
      if ((m = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line))) add((currentClass ? '.' : '') + m[1] + '()', 'function', ln, currentClass);
      else if ((m = /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/.exec(line))) currentClass = add(m[1], 'class', ln, null);
    } else if (lang === 'java') {
      if ((m = /^\s*(?:public|private|protected|internal|abstract|final|open|data|sealed)?\s*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/.exec(line))) {
        currentClass = add(m[1], 'class', ln, null);
        classIndent = indent;
      } else if ((m = /^\s*(?:public|private|protected|internal|static|final|override|suspend|async)?\s*[\w<>\[\],.?\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/.exec(line)) && !/^(if|for|while|switch|catch|return|new)$/.test(m[1])) {
        add((currentClass ? '.' : '') + m[1] + '()', 'function', ln, currentClass);
      }
    } else if (lang === 'ruby') {
      if ((m = /^\s*class\s+([A-Za-z_]\w*)/.exec(line))) currentClass = add(m[1], 'class', ln, null);
      else if ((m = /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/.exec(line))) add((currentClass ? '.' : '') + m[1] + '()', 'function', ln, currentClass);
    }
  }

  // import 边（只做同仓库内的相对导入，解析不出来就跳过，不猜）
  const importRe = {
    python: [/^\s*from\s+([.\w]+)\s+import/gm, /^\s*import\s+([.\w]+)/gm],
    js: [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g],
    go: [/^\s*"([^"]+)"/gm],
    rust: [/^\s*use\s+([\w:]+)/gm],
    java: [/^\s*import\s+([\w.]+);/gm],
    ruby: [/require\s+['"]([^'"]+)['"]/g],
    c: [/^\s*#include\s+"([^"]+)"/gm],
    php: [/(?:require|include)(?:_once)?\s*['"]([^'"]+)['"]/g],
  }[lang] || [];

  const dir = path.dirname(abs);
  const resolved = new Set();
  for (const re of importRe) {
    let mm;
    while ((mm = re.exec(src))) {
      const spec = mm[1];
      let cand = null;
      if (spec.startsWith('.')) {
        const base = path.resolve(dir, spec);
        for (const ext of ['', '.py', '.js', '.ts', '.json', '/index.js', '/__init__.py']) {
          const p = base + ext;
          if (fs.existsSync(p) && fs.statSync(p).isFile()) { cand = rel(p); break; }
        }
      } else if (lang === 'python') {
        const parts = spec.replace(/^\.+/, '').split('.');
        const guess = parts.reduce((acc, seg) => (acc ? path.join(acc, seg) : seg), '');
        for (const p of [guess + '.py', path.join(guess, '__init__.py')]) {
          if (fs.existsSync(path.join(repo, p))) { cand = p.split(path.sep).join('/'); break; }
        }
      }
      if (cand && cand !== rf && !resolved.has(cand)) {
        resolved.add(cand);
        links.push({
          source: fileNodeId(rf), target: fileNodeId(cand), relation: 'imports',
          _origin: 'scan', confidence: 'EXTRACTED', confidence_score: 1, weight: 1,
          source_file: rf, source_location: 'L1',
        });
      }
    }
  }
}

// 去掉指向不存在文件的 import 边（目标文件没被扫描到）
const nodeIds = new Set(nodes.map((n) => n.id));
const finalLinks = links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));

const graph = {
  directed: false,
  multigraph: false,
  graph: { schema_version: 1, graphify_version: 'scan-fallback' },
  nodes,
  links: finalLinks,
  hyperedges: [],
  built_at_commit: null,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(graph));
console.log(`[scan] ${files.length} 文件 → ${nodes.length} 节点 / ${finalLinks.length} 边（无函数级调用边）`);
console.log(`[scan] 写出: ${out}`);
