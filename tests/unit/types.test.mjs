// 类型字段抽取：每种语言一个最小夹具，断言字段名与类型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTypes } from '../../src/types/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, '..', 'fixtures', name);
const empty = { nodes: [], links: [] };

function items(repo) {
  const t = extractTypes(repo, empty);
  return t.groups.flatMap((g) => g.items);
}
const find = (list, name) => list.find((i) => i.name === name);

test('Go: struct 字段与 json tag', () => {
  const list = items(fx('go'));
  const u = find(list, 'User');
  assert.ok(u, '应抽到 User');
  assert.deepEqual(u.fields.map((f) => f.name), ['ID', 'Email', 'Roles']);
  assert.equal(u.fields[0].json, 'id');
  assert.ok(find(list, 'Hidden'), '未导出字段的结构体也要出现');
});

test('TypeScript: interface 字段与可选标记', () => {
  const list = items(fx('ts'));
  const req = find(list, 'ChatRequest');
  assert.ok(req);
  assert.deepEqual(req.fields.map((f) => f.name), ['message', 'conversationId', 'context']);
  assert.equal(req.fields[1].optional, true);
  const ctx = find(list, 'Context');
  assert.ok(ctx.fields.some((f) => f.name === 'data'), '内联对象字段要保留');
});

test('Python: 类级注解 + __init__ 参数', () => {
  const list = items(fx('python'));
  const pc = find(list, 'ProblemContext');
  assert.ok(pc);
  const names = pc.fields.map((f) => f.name);
  assert.ok(names.includes('site'), '类级注解');
  assert.ok(names.includes('code'), '__init__ 参数');
  assert.ok(names.includes('language'), '带默认值的参数');
  assert.ok(!names.includes('self'));
});

test('Java: class 字段 + record 组件', () => {
  const list = items(fx('java'));
  const dto = find(list, 'UserDto');
  assert.ok(dto);
  assert.deepEqual(dto.fields.map((f) => f.name), ['id', 'email', 'roles', 'active']);
  const rec = list.find((i) => i.kind === 'record');
  assert.ok(rec, 'record 也要抽');
  assert.equal(rec.fields.length, 2);
});

test('Rust: struct 字段与元组结构体', () => {
  const list = items(fx('rust'));
  const user = find(list, 'User');
  assert.ok(user);
  assert.deepEqual(user.fields.map((f) => f.name), ['id', 'email', 'roles', 'secret']);
  assert.ok(!user.fields[0].type.includes('pub'), '类型里不该带 pub');
  const pair = find(list, 'Pair');
  assert.ok(pair, '元组结构体');
  assert.equal(pair.fields.length, 2);
});

test('SQL: 建表列与外键', () => {
  const list = items(fx('sql'));
  const users = list.find((i) => i.name === 'users');
  assert.ok(users);
  assert.deepEqual(users.fields.map((f) => f.name), ['id', 'email', 'created_at']);
  const messages = list.find((i) => i.name === 'messages');
  const fk = messages.fields.find((f) => f.name === 'user_id');
  assert.match(String(fk.note || ''), /外键/, '外键要标出来');
});

test('不内嵌源码：产物里不带 snippet（避免体积与转发风险）', () => {
  const list = items(fx('go'));
  assert.ok(list.length > 0);
  for (const it of list) assert.equal('snippet' in it, false, `${it.name} 不该带 snippet`);
});

test('确定性：同一输入两次结果一致', () => {
  const a = JSON.stringify(extractTypes(fx('python'), empty));
  const b = JSON.stringify(extractTypes(fx('python'), empty));
  assert.equal(a, b);
});
