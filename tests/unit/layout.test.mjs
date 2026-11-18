// 布局：每个节点都要有坐标和尺寸，且同屏不得重叠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutModel } from '../../src/model/layout.mjs';

function model() {
  return {
    views: {
      v_layers: {
        id: 'v_layers', kind: 'layers', level: 1,
        nodes: [
          { id: 'a', label: '浏览器插件', sub: '一句话职责', metrics: '6 文件 · 17 符号', drill: 'v_f' },
          { id: 'b', label: '后端接入层', sub: '一句话职责', metrics: '5 文件 · 14 符号' },
          { id: 'c', label: 'Web 前端', sub: '一句话职责', metrics: '4 文件 · 7 符号' },
        ],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
      },
      v_f: {
        id: 'v_f', kind: 'functions', level: 3,
        nodes: Array.from({ length: 14 }, (_, i) => ({
          id: 'f' + i, label: 'fn' + i + '()', sub: '做点什么', metrics: 'L' + i,
        })),
        edges: [],
      },
    },
  };
}

test('所有节点都有 x/y/w/h', () => {
  const m = layoutModel(model());
  for (const v of Object.values(m.views)) {
    for (const n of v.nodes) {
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.equal(typeof n[k], 'number', `${n.id}.${k} 缺失`);
        assert.ok(Number.isFinite(n[k]));
      }
      assert.ok(n.w >= 120, '卡片不能太窄');
    }
  }
});

test('同屏节点不重叠', () => {
  const m = layoutModel(model());
  for (const v of Object.values(m.views)) {
    const ns = v.nodes;
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!hit, `${v.id}: ${a.id} 与 ${b.id} 重叠`);
      }
    }
  }
});

test('函数多于一屏时走网格，不会被拉成超长单列', () => {
  const m = layoutModel(model());
  const v = m.views.v_f;
  const ys = new Set(v.nodes.map((n) => n.y));
  assert.ok(ys.size <= 5, `期望网格排布，实际纵向层数 ${ys.size}`);
});
