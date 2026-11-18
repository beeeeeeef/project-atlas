// 端到端冒烟：不需要 graphify，用降级扫描跑通「抽图 → 提案 → 构建被质量门拦住」。
// CI 里跑这个，能证明主流程接线完整、闸门真实生效。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const node = (script, args) =>
  spawnSync(process.execPath, [path.join(root, script), ...args], { encoding: 'utf8' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-smoke-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo, { recursive: true });
fs.copyFileSync(path.join(root, 'tests/fixtures/python/models.py'), path.join(repo, 'app.py'));

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failed++;
};

const graph = path.join(tmp, 'graph.json');
const scan = node('src/extract/scan.mjs', ['--repo', repo, '--out', graph]);
ok('scan 生成 graph.json', scan.status === 0 && fs.existsSync(graph), scan.stderr);

const proposal = path.join(tmp, 'proposal.json');
const prop = node('src/cli/build.mjs', ['propose', '--repo', repo, '--graph', graph, '--out', proposal]);
ok('propose 生成提案', prop.status === 0 && fs.existsSync(proposal), prop.stderr);
if (fs.existsSync(proposal)) {
  const p = JSON.parse(fs.readFileSync(proposal, 'utf8'));
  ok('提案里有容器', Array.isArray(p.containers) && p.containers.length > 0);
}

const groups = path.join(tmp, 'groups.json');
fs.writeFileSync(groups, JSON.stringify({
  layers: [{ key: 'app', name: '应用', match: ['app.py'], role: '演示用最小仓库' }],
}));

const missingInsights = node('src/cli/build.mjs', [
  'build', '--repo', repo, '--graph', graph, '--groups', groups, '--out', path.join(tmp, 'x.html'),
]);
ok('缺 insights 时构建被拒绝', missingInsights.status !== 0);
ok('拒绝原因说清楚了', /insights/.test(missingInsights.stderr || ''), missingInsights.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n冒烟通过');
process.exit(failed ? 1 : 0);
