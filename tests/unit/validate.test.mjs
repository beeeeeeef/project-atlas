// 校验器：只测我们真正依赖的那几个 keyword。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../src/model/validate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = (name) =>
  JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'schemas', name), 'utf8'));

const groupsSchema = schema('groups.schema.json');
const insightsSchema = schema('insights.schema.json');

const okGroups = { layers: [{ key: 'core', name: '核心', role: '核心逻辑' }] };

test('合法的 groups.json 通过', () => {
  assert.deepEqual(validate(okGroups, groupsSchema).errors, []);
});

test('拼错顶层字段：既报缺失也报未知', () => {
  const { errors } = validate({ layer: [] }, groupsSchema);
  const paths = errors.map((e) => e.path);
  assert.ok(paths.includes('/layers'), '应报 /layers 缺失');
  assert.ok(paths.includes('/layer'), '应报 /layer 未知');
});

test('缺必填 role：报出精确路径', () => {
  const bad = { layers: [{ key: 'core', name: '核心' }] };
  const { errors } = validate(bad, groupsSchema);
  assert.equal(errors[0].path, '/layers/0/role');
});

test('类型错：name 写成数字', () => {
  const bad = { layers: [{ key: 'core', name: 123, role: '核心逻辑' }] };
  const { errors } = validate(bad, groupsSchema);
  assert.ok(errors.some((e) => e.path === '/layers/0/name' && e.message.includes('字符串')));
});

test('枚举错：kind 只允许 layer/data', () => {
  const bad = { layers: [{ key: 'core', name: '核心', role: '核心逻辑', kind: 'layerr' }] };
  const { errors } = validate(bad, groupsSchema);
  assert.ok(errors.some((e) => e.path === '/layers/0/kind' && e.message.includes('之一')));
});

test('minItems：layers 不能为空', () => {
  const { errors } = validate({ layers: [] }, groupsSchema);
  assert.ok(errors.some((e) => e.path === '/layers' && e.message.includes('至少')));
});

test('insights：字符串简写与对象两种形态都接受（oneOf）', () => {
  const good = {
    intro: { paragraphs: ['第一段够长的介绍文字，说明这是什么项目。', '第二段也要够长，说明它由哪几部分组成、各部分怎么协作。'] },
    layers: { core: '核心逻辑' },
    files: { 'a.py': { summary: '文件职责' } },
    functions: { 'a.py::f()': { role: '干什么' } },
    flows: [{ id: 'f1', title: '链路', steps: [{ view: 'v', node: 'a' }, { view: 'v', node: 'b' }] }],
  };
  assert.deepEqual(validate(good, insightsSchema).errors, []);
});

test('insights：介绍太短会被指出来', () => {
  const bad = { intro: { paragraphs: ['太短'] }, flows: [{ id: 'f', title: 't', steps: [{ view: 'v', node: 'a' }, { view: 'v', node: 'b' }] }] };
  const { errors } = validate(bad, insightsSchema);
  assert.ok(errors.some((e) => e.path === '/intro/paragraphs/0'));
});
