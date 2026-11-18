// 质量门：构造最小 model，验证该拦的能拦住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModel } from '../../src/model/check.mjs';

function node(id, x, y, extra = {}) {
  return { id, label: id, kind: 'function', x, y, w: 200, h: 70, sub: '一句话', ...extra };
}

function baseModel(over = {}) {
  return {
    rootView: 'v_root',
    intro: { paragraphs: ['第一段', '第二段'] },
    startHere: [{ view: 'v_f', node: 'a' }],
    flows: [{ id: 'f1', title: '链路', view: 'v_flow' }],
    views: {
      v_root: { id: 'v_root', kind: 'layers', level: 1, nodes: [node('l1', 0, 0, { drill: 'v_f' }), node('l2', 0, 200)], edges: [] },
      v_f: {
        id: 'v_f', kind: 'functions', level: 3, nodes: [
          node('a', 0, 0, { insight: { role: '干什么' } }),
          node('b', 400, 0, { insight: { role: '干什么' } }),
        ], edges: [{ from: 'a', to: 'b' }],
      },
    },
    types: { groups: [{ id: 'g', name: 'G', items: [{ id: 'x', fields: [] }] }], links: [], usages: [] },
    ...over,
  };
}

test('完整模型：无错误', () => {
  const r = checkModel(baseModel());
  assert.deepEqual(r.errors, []);
});

test('概览少于两段：拦住', () => {
  const m = baseModel({ intro: { paragraphs: ['只有一段'] } });
  const r = checkModel(m);
  assert.ok(r.errors.some((e) => e.includes('概览')));
});

test('没有从这读起：拦住', () => {
  const r = checkModel(baseModel({ startHere: [] }));
  assert.ok(r.errors.some((e) => e.includes('从这读起')));
});

test('没有关键链路：拦住', () => {
  const r = checkModel(baseModel({ flows: [] }));
  assert.ok(r.errors.some((e) => e.includes('链路')));
});

test('函数卡介绍覆盖率不足：拦住并点名', () => {
  const m = baseModel();
  m.views.v_f.nodes = [
    node('a', 0, 0, { insight: { role: '有' } }),
    node('b', 400, 0),
    node('c', 800, 0),
    node('d', 1200, 0),
  ];
  const r = checkModel(m);
  const hit = r.errors.find((e) => e.includes('覆盖率'));
  assert.ok(hit, '应报覆盖率不足');
  assert.match(hit, /b|c|d/, '应点名待补的函数');
});

test('空屏：拦住', () => {
  const m = baseModel();
  m.views.v_empty = { id: 'v_empty', kind: 'files', level: 2, nodes: [], edges: [] };
  m.views.v_flat = { id: 'v_flat', kind: 'files', level: 2, nodes: [node('only', 0, 0)], edges: [] };
  const r = checkModel(m);
  assert.ok(r.errors.some((e) => e.includes('v_empty')));
});

test('节点重叠：拦住', () => {
  const m = baseModel();
  m.views.v_f.nodes = [
    node('a', 0, 0, { insight: { role: 'x' } }),
    node('b', 10, 10, { insight: { role: 'y' } }),
  ];
  const r = checkModel(m);
  assert.ok(r.errors.some((e) => e.includes('重叠')));
});
