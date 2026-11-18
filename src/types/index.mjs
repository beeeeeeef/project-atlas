// types.mjs — 确定性数据结构抽取器（Go struct / TS interface|type / SQL table）
//
// 只认本文件注释里写明的三种结构，不做通用 parser；不调模型、不联网、不猜。
// 同样输入必然输出同样的结果：文件按路径排序，items / links / usages 全部显式排序。
// 任何文件解析异常都会被跳过，不影响其它文件。
//
// 输入：repoRoot（仓库根绝对路径）、graph（graph.json 已 parse 的对象）
// 输出：{ groups, links, usages }，见 references/ 里的数据页契约。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 分组（先认约定布局，否则按真实顶层目录） ----------

// 约定布局：多端仓库（backend / frontend / extension）。命中就沿用语义分组。
const LEGACY_TOPS = ['backend', 'extension', 'frontend'];
const LEGACY_ORDER = ['frontend', 'backend', 'database'];
const LEGACY_NAMES = { frontend: '前端 / 插件', backend: '后端', database: '数据库' };

// 不当作分组的顶层目录（测试、文档、脚本不是"数据的生产/消费方"）
const SKIP_TOPS = new Set([
  'tests', 'test', '__tests__', 'spec', 'specs', 'docs', 'doc', 'examples',
  'example', 'benchmarks', 'bench', 'scripts', 'tools', 'fixtures', '.github',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  'target', '.next', '.nuxt', '.cache', '.venv', '__pycache__', 'tmp',
  'site-packages', 'venv', 'graphify-out', '.atlas',
]);

// 认的语言：扩展名 → 解析器标记
const LANG_BY_EXT = {
  '.go': 'go',
  '.ts': 'ts', '.tsx': 'ts',
  '.py': 'python',
  '.java': 'java',
  '.rs': 'rust',
  '.sql': 'sql',
};
const SOURCE_EXT = new Set(Object.keys(LANG_BY_EXT));

const MAX_FIELDS = 15; // 超过则截断，truncated: true
const SNIPPET_LINES = 12; // 「见原文」兜底：前 12 行

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const normFile = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const posixDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/[^/]*$/, '');

// ---------- 文件枚举 ----------

/**
 * 决定这个仓库怎么分组：
 *  - 有多端布局（backend/frontend/extension 里至少两个）→ 语义分组（保持老项目行为不变）
 *  - 否则 → 按真实顶层目录分组（单包仓库就是"这个包"一个组）
 * 返回 { order, names, tops, groupOf(rel) }
 */
function resolveGrouping(root) {
  const isDir = (d) => {
    try { return fs.statSync(path.join(root, d)).isDirectory(); } catch { return false; }
  };
  const legacy = LEGACY_TOPS.filter(isDir);

  if (legacy.length >= 2) {
    return {
      kind: 'legacy',
      order: LEGACY_ORDER,
      names: LEGACY_NAMES,
      tops: legacy,
      groupOf(rel) {
        const seg = rel.split('/');
        const top = seg[0];
        const ext = path.extname(rel).toLowerCase();
        if (ext === '.sql') return top === 'backend' && seg[1] === 'migration' ? 'database' : null;
        if (ext === '.go') return top === 'backend' ? 'backend' : null;
        if (ext === '.ts' || ext === '.tsx') {
          return top === 'frontend' || top === 'extension' ? 'frontend' : null;
        }
        // 非约定语言：按目录归到 backend（Python/Java/Rust 通常在这）
        if (LANG_BY_EXT[ext] && (ext === '.py' || ext === '.java' || ext === '.rs')) {
          return top === 'backend' ? 'backend' : null;
        }
        return null;
      },
    };
  }

  // 通用模式：每个顶层目录一个组
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.') && !SKIP_DIRS.has(n) && !SKIP_TOPS.has(n));
  } catch { dirs = []; }
  dirs.sort(cmp);

  const hasSource = (d) => {
    let found = false;
    const walk = (abs, depth) => {
      if (found || depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (found) return;
        if (e.isDirectory()) {
          if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
          walk(path.join(abs, e.name), depth + 1);
        } else if (SOURCE_EXT.has(path.extname(e.name).toLowerCase())) {
          found = true;
        }
      }
    };
    walk(path.join(root, d), 0);
    return found;
  };
  let tops = dirs.filter(hasSource).slice(0, 4);

  // 仓库本身就是平的（源码直接放在根目录）：整仓当一个组
  if (tops.length === 0) {
    const rootFiles = (() => {
      try {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isFile() && SOURCE_EXT.has(path.extname(e.name).toLowerCase()));
      } catch { return []; }
    })();
    if (rootFiles.length) {
      const name = path.basename(root) || 'root';
      return {
        kind: 'flat',
        order: ['(root)', 'database'],
        names: { '(root)': name, database: '数据库' },
        tops: ['.'],
        groupOf(rel) {
          return path.extname(rel).toLowerCase() === '.sql' ? 'database' : '(root)';
        },
      };
    }
  }

  const order = [...tops, 'database'];
  const names = {};
  for (const d of tops) names[d] = d;
  names.database = '数据库';

  return {
    kind: 'dirs',
    order,
    names,
    tops,
    groupOf(rel) {
      const ext = path.extname(rel).toLowerCase();
      if (ext === '.sql') return 'database';
      const top = rel.split('/')[0];
      return tops.includes(top) ? top : null;
    },
  };
}

function listSourceFiles(root, grouping) {
  const out = [];
  const walk = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(rel);
      }
    }
  };
  for (const top of grouping.tops) {
    const abs = path.join(root, top);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) walk(abs, top);
  }
  return out.sort(cmp);
}

// ---------- 词法小工具（只用于数括号 / 去注释，不是 parser） ----------

// 去掉注释并把字符串字面量内容清空，避免注释和字符串里的括号干扰计数。
function codeOnly(line, markers) {
  const stops = markers || ['//'];
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (stops.some((m) => line.startsWith(m, i))) break;
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\' && quote !== '`') {
          i += 2;
          continue;
        }
        if (line[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += quote + quote;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// 去掉行注释，保留字符串原文（解析标签 / 类型时用）。
function stripComments(line, markers) {
  const stops = markers || ['//'];
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (stops.some((m) => line.startsWith(m, i))) break;
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < line.length) {
        out += line[i];
        if (line[i] === '\\' && quote !== '`') {
          i += 1;
          if (i < line.length) out += line[i];
          i += 1;
          continue;
        }
        if (line[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function braceDelta(line, markers) {
  let depth = 0;
  for (const ch of codeOnly(line, markers)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

function parenDelta(line, markers) {
  let depth = 0;
  for (const ch of codeOnly(line, markers)) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
  }
  return depth;
}

// 前 12 行原文，去掉行首缩进（“去掉缩进过多者”），去掉行尾空白
function makeSnippet(lines, start, end, maxLines) {
  const limit = maxLines || SNIPPET_LINES;
  const chunk = lines.slice(start, Math.min(end + 1, start + limit));
  return chunk
    .map((line) => (line.trim() === '' ? '' : line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n+$/, '');
}

// ---------- Go struct ----------

function parseGoFieldLine(text) {
  const t = text.trim();
  if (!t) return null;
  const tagged = /^([A-Za-z_]\w*)\s+(.+?)\s+`([^`]*)`$/.exec(t);
  if (tagged) return { name: tagged[1], type: tagged[2].trim(), tag: tagged[3] };
  const embedded = /^(\*?[A-Za-z_][\w.]*)$/.exec(t);
  if (embedded) return { embedded: true, name: embedded[1] };
  const plain = /^([A-Za-z_]\w*)\s+(.+)$/.exec(t);
  if (plain) return { name: plain[1], type: plain[2].trim() };
  return null;
}

function goJsonKey(tag) {
  if (!tag) return null;
  const m = /(?:^|\s)json:"([^"]*)"/.exec(tag);
  if (!m) return null;
  const name = m[1].split(',')[0];
  if (name === '-') return '-';
  return name || null;
}

function goFieldOf(raw) {
  if (!raw) return null;
  const json = 'tag' in raw ? goJsonKey(raw.tag) : null;
  if (json === '-') return null; // json:"-"：跳过该字段（不参与序列化）
  if (raw.embedded) {
    return {
      name: raw.name,
      type: raw.name,
      json,
      optional: false,
      note: '嵌入字段，字段见被嵌入类型',
    };
  }
  const note = /struct\s*\{/.test(raw.type) ? '内联结构，见原文' : null;
  return { name: raw.name, type: raw.type, json, optional: false, note };
}

function parseGoStructs(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\s*type\s+([A-Za-z_]\w*)\s+struct\s*\{/.exec(lines[i]);
    if (!head) continue;
    let depth = braceDelta(lines[i], ['//']);
    let end = i;
    while (depth > 0 && end + 1 < lines.length) {
      end += 1;
      depth += braceDelta(lines[end], ['//']);
    }
    if (depth > 0) {
      // 括号没闭合：文件有问题，跳过整个声明
      i = end;
      continue;
    }
    const fields = [];
    for (let j = i + 1; j < end; j += 1) {
      const clean = stripComments(lines[j], ['//']);
      const trimmed = clean.trim();
      if (!trimmed) continue;
      const delta = braceDelta(lines[j], ['//']);
      if (delta > 0) {
        // 多行内联 struct 字段（如 Choices []struct { ... } `json:"choices"`）：
        // 只记外层字段，内部字段不展开。
        let open = delta;
        let k = j + 1;
        while (open > 0 && k < end) {
          open += braceDelta(lines[k], ['//']);
          k += 1;
        }
        const closeLine = lines[k - 1] || '';
        const tagM = /`([^`]*)`/.exec(closeLine);
        const first = /^([A-Za-z_]\w*)\s+([\s\S]*?)\s*\{\s*$/.exec(trimmed);
        if (first) {
          const field = goFieldOf({
            name: first[1],
            type: first[2].trim(),
            tag: tagM ? tagM[1] : '',
          });
          if (field) {
            field.note = '内联结构，见原文';
            fields.push(field);
          }
        }
        j = k - 1;
      } else if (delta < 0) {
        continue; // 不应出现；保守跳过
      } else {
        const field = goFieldOf(parseGoFieldLine(clean));
        if (field) fields.push(field);
      }
    }
    decls.push({ name: head[1], line: i + 1, kind: 'struct', fields, start: i, end });
    i = end;
  }
  return decls;
}

// ---------- TS interface / type = { } ----------

function parseTsFields(lines, start, end) {
  const fields = [];
  for (let i = start + 1; i < end; i += 1) {
    const clean = stripComments(lines[i], ['//']);
    const trimmed = clean.trim();
    if (!trimmed || trimmed.startsWith('}')) continue;
    const m = /^([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*(\?)?\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const name = m[1].replace(/^['"]|['"]$/g, '');
    const optional = Boolean(m[2]);
    const rest = m[3].trim();
    if (!rest) continue;
    if (rest.startsWith('{')) {
      // 内联对象类型：type 写 {…}，不展开内部字段
      let depth = braceDelta(rest, ['//']);
      let k = i;
      while (depth > 0 && k + 1 < end) {
        k += 1;
        depth += braceDelta(lines[k], ['//']);
      }
      fields.push({ name, type: '{…}', json: name, optional, note: '内联结构，见原文' });
      i = k;
      continue;
    }
    const type = rest.replace(/[;,]\s*$/, '').trim();
    if (!type) continue;
    fields.push({ name, type, json: name, optional, note: null });
  }
  return fields;
}

function parseTsDecls(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    let head = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\{/.exec(lines[i]);
    if (!head) {
      head = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*=\s*\{/.exec(lines[i]);
    }
    if (!head) continue;
    let depth = braceDelta(lines[i], ['//']);
    let end = i;
    while (depth > 0 && end + 1 < lines.length) {
      end += 1;
      depth += braceDelta(lines[end], ['//']);
    }
    if (depth > 0) {
      i = end;
      continue;
    }
    const fields = parseTsFields(lines, i, end);
    decls.push({ name: head[1], line: i + 1, kind: 'interface', fields, start: i, end });
    i = end;
  }
  return decls;
}

// ---------- SQL CREATE TABLE ----------

const SQL_STOP_WORDS = new Set(['NOT', 'PRIMARY', 'REFERENCES', 'CHECK', 'DEFAULT', 'NULL', 'UNIQUE']);
const SQL_TABLE_CONSTRAINT = /^(PRIMARY|UNIQUE|KEY|CONSTRAINT|FOREIGN|CHECK)\b/i;

function sqlTypeOf(rest) {
  const words = [];
  let cur = '';
  let depth = 0;
  for (const ch of rest) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) words.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  const typeWords = [];
  for (const word of words) {
    if (SQL_STOP_WORDS.has(word.toUpperCase())) break;
    typeWords.push(word);
  }
  return typeWords.join(' ').trim();
}

function parseSqlTables(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z_][\w$]*)`?\s*\(/i.exec(lines[i]);
    if (!head) continue;
    let depth = parenDelta(lines[i], ['--']);
    let end = i;
    while (depth > 0 && end + 1 < lines.length) {
      end += 1;
      depth += parenDelta(lines[end], ['--']);
    }
    if (depth > 0) {
      i = end;
      continue;
    }
    const fields = [];
    for (let j = i + 1; j < end; j += 1) {
      const clean = stripComments(lines[j], ['--']).trim();
      if (!clean) continue;
      if (SQL_TABLE_CONSTRAINT.test(clean)) continue; // 表级约束，不是列
      const m = /^`?([A-Za-z_][\w$]*)`?\s+(.+)$/.exec(clean);
      if (!m) continue;
      const rest = m[2].replace(/,\s*$/, '').trim();
      const type = sqlTypeOf(rest);
      if (!type) continue;
      const fk = /\bREFERENCES\s+`?([A-Za-z_][\w$]*)`?\s*\(\s*`?([A-Za-z_][\w$]*)`?\s*\)/i.exec(rest);
      const notNull = /\bNOT\s+NULL\b/i.test(rest);
      const primaryKey = /\bPRIMARY\s+KEY\b/i.test(rest);
      fields.push({
        name: m[1],
        type,
        json: null,
        optional: !notNull && !primaryKey,
        note: fk ? `外键 → ${fk[1]}(${fk[2]})` : null,
      });
    }
    decls.push({ name: head[1], line: i + 1, kind: 'table', fields, start: i, end });
    i = end;
  }
  return decls;
}

// ---------- Python（类级注解 + __init__ 签名） ----------

function pyIndent(line) {
  return (line.match(/^[ \t]*/) || [''])[0].length;
}

/** 按顶层分隔符切分，忽略括号/引号内部的分隔符 */
function splitTopLevel(text, sep) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function pyParamToField(raw) {
  const t = String(raw || '').replace(/\n/g, ' ').trim();
  if (!t) return null;
  if (t.startsWith('*')) return null; // *args / **kwargs 不是字段
  const eq = splitTopLevel(t, '=');
  const colon = splitTopLevel(eq[0], ':');
  const name = colon[0].trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  const type = colon.length > 1 ? colon.slice(1).join(':').trim() : '';
  return { name, type: type || '（未标注）', json: null, optional: eq.length > 1, note: null };
}

function parsePythonTypes(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(lines[i]);
    if (!m) continue;
    const baseIndent = m[1].length;
    let end = i + 1;
    let bodyIndent = null;
    for (; end < lines.length; end += 1) {
      const ln = lines[end];
      if (!ln.trim()) continue;
      const ind = pyIndent(ln);
      if (ind <= baseIndent) break;
      if (bodyIndent === null) bodyIndent = ind;
    }
    const bodyEnd = end;
    const fields = [];
    const seen = new Set();
    const add = (f) => {
      if (!f || seen.has(f.name)) return;
      seen.add(f.name);
      fields.push(f);
    };

    // 1) 类级注解：name: Type 或 name: Type = default（dataclass / Pydantic 常见）
    for (let j = i + 1; j < bodyEnd; j += 1) {
      if (bodyIndent !== null && pyIndent(lines[j]) !== bodyIndent) continue;
      const trimmed = lines[j].trim();
      const a = /^([A-Za-z_]\w*)\s*:\s*([^=#]+?)\s*(?:=\s*.+)?$/.exec(trimmed);
      if (a) add({ name: a[1], type: a[2].trim(), json: null, optional: /=\s*.+/.test(trimmed), note: null });
    }

    // 2) __init__ 签名里的参数（httpx 这类直接用构造参数声明字段）
    for (let j = i + 1; j < bodyEnd; j += 1) {
      if (!/^\s*def\s+__init__\s*\(/.test(lines[j])) continue;
      let text = lines[j];
      let depth = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
      let k = j;
      while (depth > 0 && k + 1 < bodyEnd) {
        k += 1;
        text += '\n' + lines[k];
        depth += (lines[k].match(/\(/g) || []).length - (lines[k].match(/\)/g) || []).length;
      }
      const open = text.indexOf('(');
      const close = text.lastIndexOf(')');
      if (open >= 0 && close > open) {
        for (const raw of splitTopLevel(text.slice(open + 1, close), ',')) {
          const f = pyParamToField(raw);
          if (f && f.name !== 'self' && f.name !== 'cls') {
            if (f.optional) f.note = '有默认值';
            add(f);
          }
        }
      }
      break;
    }

    decls.push({
      name: m[2], line: i + 1, kind: 'class', fields,
      start: i, end: Math.max(i, bodyEnd - 1),
    });
    i = bodyEnd - 1;
  }
  return decls;
}

// ---------- Java（class 字段 / record 组件） ----------

const JAVA_NOT_A_TYPE = new Set([
  'package', 'import', 'return', 'throw', 'if', 'for', 'while', 'switch',
  'catch', 'new', 'class', 'interface', 'enum', 'record', 'try', 'do', 'else',
]);

function parseJavaTypes(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*(?:(?:public|private|protected|abstract|final|static|sealed|open|data)\s+)*(class|record)\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m) continue;

    if (m[1] === 'record') {
      const rm = /record\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(lines[i]);
      const fields = [];
      if (rm) {
        for (const p of splitTopLevel(rm[2], ',')) {
          const bits = p.trim().split(/\s+/);
          if (bits.length >= 2) {
            fields.push({
              name: bits[bits.length - 1], type: bits.slice(0, -1).join(' '),
              json: null, optional: false, note: null,
            });
          }
        }
      }
      decls.push({ name: m[2], line: i + 1, kind: 'record', fields, start: i, end: i });
      continue;
    }

    let depth = braceDelta(lines[i], ['//']);
    let end = i;
    while (depth > 0 && end + 1 < lines.length) {
      end += 1;
      depth += braceDelta(lines[end], ['//']);
    }
    if (depth > 0) { i = end; continue; }

    const fields = [];
    for (let j = i + 1; j < end; j += 1) {
      const clean = stripComments(lines[j], ['//']).trim();
      if (!clean || !clean.endsWith(';')) continue;
      // 只看「= 号左边」：有括号说明是方法/构造器，不是字段
      const decl = clean.split('=')[0].trim();
      if (decl.includes('(')) continue;
      const fm = /^(?:(?:private|public|protected|static|final|transient|volatile)\s+)*([A-Za-z_][\w.<>\[\]?, ]*?)\s+([A-Za-z_]\w*)\s*(?:=.*)?;$/.exec(clean);
      if (!fm) continue;
      if (JAVA_NOT_A_TYPE.has(fm[1].split(/\s+/)[0])) continue;
      fields.push({ name: fm[2], type: fm[1].trim(), json: null, optional: false, note: null });
    }
    decls.push({ name: m[2], line: i + 1, kind: 'class', fields, start: i, end });
    i = end;
  }
  return decls;
}

// ---------- Rust（struct 命名字段 / 元组结构体） ----------

function parseRustTypes(source) {
  const lines = source.split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (!m) continue;

    if (!lines[i].includes('{')) {
      const tm = /struct\s+\w+\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(lines[i]);
      const fields = [];
      if (tm) {
        splitTopLevel(tm[1], ',').forEach((t, idx) => {
          const v = t.trim();
          if (v) fields.push({
            name: String(idx),
            type: v.replace(/^pub(\([^)]*\))?\s+/, ''),
            json: null, optional: false, note: '元组结构体字段',
          });
        });
      }
      decls.push({ name: m[1], line: i + 1, kind: 'struct', fields, start: i, end: i });
      continue;
    }

    let depth = braceDelta(lines[i], ['//']);
    let end = i;
    while (depth > 0 && end + 1 < lines.length) {
      end += 1;
      depth += braceDelta(lines[end], ['//']);
    }
    if (depth > 0) { i = end; continue; }

    const fields = [];
    for (let j = i + 1; j < end; j += 1) {
      const clean = stripComments(lines[j], ['//']).trim();
      if (!clean) continue;
      const fm = /^(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*(.+?),?$/.exec(clean);
      if (fm) fields.push({ name: fm[1], type: fm[2].trim().replace(/,$/, ''), json: null, optional: false, note: null });
    }
    decls.push({ name: m[1], line: i + 1, kind: 'struct', fields, start: i, end });
    i = end;
  }
  return decls;
}

// ---------- 跨端同名连线 ----------

function buildLinks(groups) {
  const links = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const later = new Map(groups[j].items.map((item) => [item.name, item]));
      for (const item of groups[i].items) {
        // 同名但来源有歧义（同组内有重名）时不连线，避免造出语义不成立的连线
        if (item.ambiguous) continue;
        const other = later.get(item.name);
        if (other && !other.ambiguous) links.push({ from: item.id, to: other.id, kind: 'same-name' });
      }
    }
  }
  links.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  const seen = new Set();
  return links.filter((link) => {
    const key = `${link.from}\u0000${link.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- usages：graph 里 references 边 + 既有 fn id 规则 ----------
// 与 adapt.mjs 的 classify / dispLabel / fnIdOf 保持一致：
//   fn:<source_file>::<label>，方法 label 用 method 关系补回类名（.Chat() -> Service.Chat()）

function classify(n) {
  const label = n.label || '';
  if (n._callable_class === true) return 'class';
  if (n._py_property === true) return 'property';
  if (n._callable === true) return label.startsWith('.') ? 'method' : 'function';
  const src = n.source_file || '';
  if (src && label && path.basename(src) === label) return 'file';
  return 'other';
}

function buildUsages(graph, rawItems) {
  const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph && graph.links)
    ? graph.links
    : Array.isArray(graph && graph.edges)
      ? graph.edges
      : [];
  const byId = new Map();
  for (const n of nodes) if (n && n.id) byId.set(n.id, n);

  // graphify 的方法 label 是 ".Chat()"（不带类名），用 method 关系找回归属类
  const ownerOf = new Map();
  for (const edge of edges) {
    if (edge && edge.relation === 'method') ownerOf.set(edge.target, edge.source);
  }
  const dispLabel = (n) => {
    const kind = classify(n);
    const raw = String(n.label || '');
    if (kind !== 'method') return raw;
    const base = raw.replace(/^\./, '');
    const owner = ownerOf.get(n.id);
    const cls = owner ? byId.get(owner)?.label : null;
    return cls ? `${String(cls).replace(/\(\)$/, '')}.${base}` : base;
  };

  const itemByKey = new Map();
  for (const entry of rawItems) {
    itemByKey.set(`${normFile(entry.item.file)}\u0000${entry.item.name}`, entry.item);
  }
  const canonicalTypes = nodes.filter(
    (n) => n && n._callable_class === true && n.label && n.source_file,
  );

  const funcs = new Map(); // 类型 id -> Set<fn id>
  for (const edge of edges) {
    if (!edge || edge.relation !== 'references') continue;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    // source 必须是函数/方法（不是 struct/class）
    if (source._callable !== true || source._callable_class === true || !source.source_file) continue;
    if (!target.label) continue;

    let typeNode = null;
    if (target._callable_class === true && target.source_file) {
      typeNode = target;
    } else {
      // graphify 会给「跨文件/未解析」引用建 stub 节点（source_file 为空）。
      // 只按 label 找 canonical 类型节点；优先同目录（Go 同包）且唯一，否则全图唯一才认，
      // 都不满足就跳过 —— 宁缺勿错。
      const candidates = canonicalTypes.filter((n) => n.label === target.label);
      const dir = posixDir(source.source_file);
      const sameDir = candidates.filter((n) => posixDir(n.source_file) === dir);
      if (sameDir.length === 1) typeNode = sameDir[0];
      else if (candidates.length === 1) typeNode = candidates[0];
    }
    if (!typeNode) continue;
    const item = itemByKey.get(`${normFile(typeNode.source_file)}\u0000${typeNode.label}`);
    if (!item) continue;
    const fnId = `fn:${source.source_file}::${dispLabel(source)}`;
    if (!funcs.has(item.id)) funcs.set(item.id, new Set());
    funcs.get(item.id).add(fnId);
  }

  return [...funcs.keys()]
    .sort(cmp)
    .map((typeId) => ({ type: typeId, funcs: [...funcs.get(typeId)].sort(cmp) }));
}

// ---------- 主入口 ----------

/**
 * 从源码抽取数据结构（Go struct / TS interface|type / SQL table），
 * 生成数据页需要的 groups / links / usages。
 *
 * @param {string} repoRoot 仓库根的绝对路径
 * @param {object} graph    graph.json 已 parse 的对象（用于 usages）
 * @param {object} [opts]
 * @param {number} [opts.maxFields]    单个类型保留的最大字段数，默认 15
 * @param {number} [opts.snippetLines] 单个类型 snippet 的最大行数，默认 12
 * @returns {{groups: Array, links: Array, usages: Array}}
 */
export function extractTypes(repoRoot, graph, opts = {}) {
  const maxFields = Number.isInteger(opts.maxFields) && opts.maxFields > 0 ? opts.maxFields : MAX_FIELDS;
  const snippetLines =
    Number.isInteger(opts.snippetLines) && opts.snippetLines > 0 ? opts.snippetLines : SNIPPET_LINES;
  const root = path.resolve(String(repoRoot || '.'));

  const grouping = resolveGrouping(root);
  const rawItems = []; // { group, item }
  let files = [];
  try {
    files = listSourceFiles(root, grouping);
  } catch {
    files = [];
  }

  for (const rel of files) {
    try {
      const group = grouping.groupOf(rel);
      if (!group) continue;
      const source = fs.readFileSync(path.join(root, rel), 'utf8');
      const ext = path.extname(rel).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      let decls;
      if (lang === 'go') decls = parseGoStructs(source);
      else if (lang === 'ts') decls = parseTsDecls(source);
      else if (lang === 'python') decls = parsePythonTypes(source);
      else if (lang === 'java') decls = parseJavaTypes(source);
      else if (lang === 'rust') decls = parseRustTypes(source);
      else if (lang === 'sql') decls = parseSqlTables(source);
      else continue;
      const lines = source.split(/\r?\n/);
      for (const decl of decls) {
        if (!decl.name) continue;
        const fields = decl.fields.map((f) => ({
          name: f.name,
          type: f.type,
          json: f.json,
          optional: f.optional,
          note: f.note,
        }));
        const truncated = fields.length > maxFields;
        const item = {
          id: `${group}:${decl.name}`,
          name: decl.name,
          file: rel,
          line: decl.line,
          kind: decl.kind,
          fields: truncated ? fields.slice(0, maxFields) : fields,
          truncated,
          snippet: makeSnippet(lines, decl.start, decl.end, snippetLines),
        };
        rawItems.push({ group, item });
      }
    } catch {
      // 单个文件解析失败：跳过该文件，继续
    }
  }

  const byGroup = new Map(grouping.order.map((gid) => [gid, []]));
  for (const entry of rawItems) {
    if (byGroup.has(entry.group)) byGroup.get(entry.group).push(entry.item);
  }
  for (const gid of grouping.order) {
    const items = byGroup.get(gid) || [];
    items.sort((a, b) => cmp(a.name, b.name) || cmp(a.file, b.file) || a.line - b.line);

    // 同一组内可能真的有同名类型（Go 里 chat.Handler 和 analyze.Handler）。
    // 丢一个会让人以为项目里只有一个 Handler —— 那是骗人。
    // 所以：同名的用「@包名」区分并标记 ambiguous；跨端连线跳过 ambiguous 的名字。
    const nameCount = new Map();
    for (const it of items) nameCount.set(it.name, (nameCount.get(it.name) || 0) + 1);

    for (const it of items) {
      if (nameCount.get(it.name) > 1) {
        const dir = (it.file || '').split('/').slice(-2, -1)[0] || 'root';
        it.ambiguous = true;
        it.id = `${gid}:${it.name}@${dir}`;
      }
    }

    const seen = new Set();
    byGroup.set(
      gid,
      items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }),
    );
  }

  const groups = grouping.order.filter((gid) => byGroup.get(gid).length > 0).map((gid) => ({
    id: gid,
    name: grouping.names[gid] || gid,
    items: byGroup.get(gid),
  }));

  const links = buildLinks(groups);
  const usages = buildUsages(graph, rawItems);

  return { groups, links, usages, grouping: { kind: grouping.kind, tops: grouping.tops } };
}

export default extractTypes;
