// 调用链：产物里的 calls 图必须与原始 calls 边一致，且 id 能与视图节点对上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../../src/model/adapt.mjs';

function graph() {
  const nodes = [
    { id: 'a_main', label: 'main()', source_file: 'cmd/main.go', source_location: 'L1', _callable: true },
    { id: 'b_run', label: 'run()', source_file: 'pkg/run.go', source_location: 'L10', _callable: true },
    { id: 'c_send', label: '.send()', source_file: 'pkg/client.go', source_location: 'L20', _callable: true },
  ];
  const links = [
    { source: 'a_main', target: 'b_run', relation: 'calls', confidence: 'EXTRACTED' },
    { source: 'b_run', target: 'c_send', relation: 'calls', confidence: 'INFERRED' },
    { source: 'c_send', target: 'c_send', relation: 'calls', confidence: 'EXTRACTED' }, // 自环应被剔除
  ];
  return { directed: true, nodes, links };
}

test('calls 图：剔除自环，保留跨文件边', () => {
  const m = buildModel(graph(), { repo: '/tmp/x', groups: { layers: [{ key: 'core', name: '核心', role: '核心逻辑', match: ['**'] }] } });
  assert.ok(m.calls, '应生成 calls');
  assert.equal(m.calls.edges.length, 2, '自环被剔除，余 2 条');
  assert.equal(m.calls.pool.length, 3);
});

test('calls 图：id 规则与视图节点一致，可直接跳转', () => {
  const m = buildModel(graph(), { repo: '/tmp/x', groups: { layers: [{ key: 'core', name: '核心', role: '核心逻辑', match: ['**'] }] } });
  const ids = m.calls.pool.map((p) => `fn:${p[1]}::${p[0]}`);
  assert.ok(ids.includes('fn:pkg/run.go::run()'), 'id 应为 fn:<file>::<label>');

  // 视图里出现的函数节点 id 必须能从 pool 还原出来
  const fnNodeIds = new Set(
    Object.values(m.views).filter((v) => v.kind === 'functions').flatMap((v) => v.nodes.map((n) => n.id))
  );
  const overlap = [...fnNodeIds].filter((id) => ids.includes(id));
  assert.ok(overlap.length > 0, '至少有一个函数卡能对上调用图');
});

test('函数卡带 callUp / callDown，且与 calls 边一致', () => {
  const m = buildModel(graph(), { repo: '/tmp/x', groups: { layers: [{ key: 'core', name: '核心', role: '核心逻辑', match: ['**'] }] } });
  const fn = Object.values(m.views).filter((v) => v.kind === 'functions').flatMap((v) => v.nodes);
  const run = fn.find((n) => n.label === 'run()');
  assert.ok(run, '应有 run() 卡片');
  assert.equal(run.callUp, 1, 'run 被 main 调用');
  assert.equal(run.callDown, 1, 'run 调了 send');
});
