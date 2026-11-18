// 增量决策：纯函数，覆盖四种动作。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide } from '../../src/cli/incremental.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-inc-'));
const graph = path.join(tmp, 'graph.json');
const out = path.join(tmp, 'atlas.html');
const state = path.join(tmp, 'state.json');

const touch = (p) => fs.writeFileSync(p, '{}');

test('没有代码图 → 全量抽取', () => {
  fs.rmSync(graph, { force: true });
  const r = decide({ graphPath: graph, state: null, codeFp: 'a', inputsFp: 'x', out, force: false });
  assert.equal(r.action, 'extract');
});

test('--fresh → 强制全量，即使图存在', () => {
  touch(graph); touch(out);
  const st = { graph: { codeFp: 'a' }, build: { inputsFp: 'x', out } };
  const r = decide({ graphPath: graph, state: st, codeFp: 'a', inputsFp: 'x', out, force: true });
  assert.equal(r.action, 'extract');
});

test('代码与输入都没变 → 复用产物', () => {
  touch(graph); touch(out);
  const st = { graph: { codeFp: 'a' }, build: { inputsFp: 'x', out } };
  const r = decide({ graphPath: graph, state: st, codeFp: 'a', inputsFp: 'x', out, force: false });
  assert.equal(r.action, 'reuse-all');
});

test('只有输入变了 → 跳过抽图，只重建', () => {
  touch(graph); touch(out);
  const st = { graph: { codeFp: 'a' }, build: { inputsFp: 'old', out } };
  const r = decide({ graphPath: graph, state: st, codeFp: 'a', inputsFp: 'new', out, force: false });
  assert.equal(r.action, 'build-only');
});

test('代码变了 → 增量更新', () => {
  touch(graph); touch(out);
  const st = { graph: { codeFp: 'old' }, build: { inputsFp: 'x', out } };
  const r = decide({ graphPath: graph, state: st, codeFp: 'new', inputsFp: 'x', out, force: false });
  assert.equal(r.action, 'update');
});

test('产物不在了 → 即便输入没变也要重建', () => {
  touch(graph);
  fs.rmSync(out, { force: true });
  const st = { graph: { codeFp: 'a' }, build: { inputsFp: 'x', out } };
  const r = decide({ graphPath: graph, state: st, codeFp: 'a', inputsFp: 'x', out, force: false });
  assert.equal(r.action, 'build-only');
});
