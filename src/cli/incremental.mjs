// incremental.mjs — 增量决策：判断哪些步骤可以跳过。
//
// 三份指纹：
//   codeFp   代码有没有变（git commit + 脏标记；非 git 仓库退回文件 size+mtime）
//   inputsFp 喂给构建的输入有没有变（groups / insights / 渲染资产 / 本工具源码）
//   state    上一次成功构建记下的现场
//
// 原则：只有"确认没变"才跳过；任何不确定都老老实实重跑。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const SKIP = new Set([
  'node_modules', '.git', '.atlas', 'graphify-out', 'dist', 'build', 'out',
  'coverage', 'vendor', 'target', '.next', '.nuxt', '.cache', '.venv',
  '__pycache__', 'site-packages', 'venv', 'tmp',
]);
const CODE_EXT = new Set(['.go', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.java', '.rs', '.sql']);

export function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// 这些目录是本工具/上游工具自己产生的，不算"代码改动"
const IGNORED_DIRTY = ['.atlas/', 'graphify-out/'];

/** 解析 git status --porcelain，忽略产物目录 */
export function dirtyEntries(repo) {
  const st = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
  const out = [];
  for (const line of String(st.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let file = line.slice(3).trim();
    // 重命名行形如 "R  old -> new"，取新路径
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4);
    file = file.replace(/^"|"$/g, '');
    if (IGNORED_DIRTY.some((p) => file.startsWith(p))) continue;
    out.push({ status: line.slice(0, 2), file });
  }
  return out;
}

export function gitInfo(repo) {
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0) return { git: false };
  const entries = dirtyEntries(repo);
  return { git: true, commit: head.stdout.trim(), dirty: entries.length > 0, entries };
}

/** 代码指纹：git 可用时用 commit+dirty；否则用源码文件签名 */
export function codeFingerprint(repo) {
  const g = gitInfo(repo);
  if (g.git) {
    if (!g.dirty) return { git: true, commit: g.commit, dirty: false, fp: `git:${g.commit}:clean` };
    // 脏工作区：commit 没变也要看具体文件有没有再动（size + mtime）
    const h = crypto.createHash('sha256');
    for (const e of g.entries.sort((a, b) => (a.file < b.file ? -1 : 1))) {
      let sig = 'gone';
      try {
        const st = fs.statSync(path.join(repo, e.file));
        sig = `${st.size}:${Math.floor(st.mtimeMs)}`;
      } catch { /* 删掉的文件 */ }
      h.update(`${e.status}\0${e.file}\0${sig}\n`);
    }
    return {
      git: true, commit: g.commit, dirty: true,
      fp: `git:${g.commit}:dirty:${g.entries.length}:${h.digest('hex').slice(0, 12)}`,
    };
  }

  const files = [];
  const walk = (abs, rel, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p, r, depth + 1);
      else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) files.push([r, p]);
    }
  };
  walk(repo, '', 0);

  const h = crypto.createHash('sha256');
  for (const [rel, p] of files.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    try {
      const st = fs.statSync(p);
      h.update(`${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
    } catch { /* 读不到就忽略，宁可重跑 */ }
  }
  return { git: false, commit: null, dirty: true, fp: 'fs:' + h.digest('hex').slice(0, 16) };
}

/** 输入指纹：这些文件任一变化，产物就必须重建 */
export function inputFingerprint(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.basename(f) + '\0');
    try { h.update(fs.readFileSync(f)); } catch { h.update('<missing>'); }
  }
  return h.digest('hex').slice(0, 16);
}

/** 本工具自身的源码与渲染资产：改了它们也要重建，否则用户看到旧界面 */
export function engineFiles(root) {
  const out = [];
  const add = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) add(p);
      else out.push(p);
    }
  };
  add(path.join(root, 'src'));
  add(path.join(root, 'assets', 'viewer'));
  out.push(path.join(root, 'assets', 'vendor', 'dagre.min.cjs'));
  return out;
}

/**
 * 决策：
 *   reuse-all  代码与输入都没变，产物还在 → 直接复用
 *   build-only 只有输入变了 → 跳过抽图
 *   update     代码变了但有旧图 → 增量更新
 *   extract    没有旧图或强制全量
 */
export function decide({ graphPath, statePath, state, codeFp, inputsFp, out, force }) {
  const hasGraph = fs.existsSync(graphPath);
  const hasOut = out && fs.existsSync(out);
  const graphFresh = hasGraph && state && state.graph && state.graph.codeFp === codeFp;
  const buildFresh = state && state.build && state.build.inputsFp === inputsFp && state.build.out === out && hasOut;

  if (force) return { action: 'extract', why: '--fresh 强制全量重抽' };
  if (!hasGraph) return { action: 'extract', why: '还没有代码图' };
  if (graphFresh && buildFresh) return { action: 'reuse-all', why: '代码与输入都没变' };
  if (graphFresh) return { action: 'build-only', why: '只有输入（groups/insights/资产）变了' };
  return { action: 'update', why: '代码变了，增量更新' };
}
