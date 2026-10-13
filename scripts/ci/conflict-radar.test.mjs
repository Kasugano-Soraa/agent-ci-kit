/**
 * 冲突雷达自测（phase 4，任务 A）——把「集成审查该看哪里」变成机械产出。
 *
 * 雷达只读分析 PR 变更 × main 新变更的交互面（同文件 / 共享接口 / 测试覆盖交叉），
 * 供 agent 自审前机械产出交互图（AGENTS 自审 gate 的输入，见 AGENTS.template.md）。
 * 仓库 CI 会执行本目录下所有 *.test.mjs（scripts/ci/run.mjs 的 runner-tests 步骤），
 * 因此这里用临时 git 仓库构造两棵树，断言四类产出与风险分级的行为不变量：
 *   1. 双侧同文件清单（high）
 *   2. 共享接口面：PR 触及的 export × main 新变更的引用点（high）
 *   3. 测试覆盖交叉：PR 变更文件对应的测试文件被 main 触及
 *   4. 风险分级（high=同行/同接口；medium=同模块/测试交叉；low=其余）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectChanges, analyzeRadar, riskLevel, runRadar, renderMarkdown } from './conflict-radar.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const GIT_IDENTITY = ['-c', 'user.email=radar@test', '-c', 'user.name=radar-test'];

/**
 * 构造两棵树的 fixture 仓库：
 *
 *   base ── main：改 src/a.ts、新增 src/c.ts（import x 的 export）、改 src/b.test.ts、改 packages/shared/src/y.ts
 *     └──── pr：  改 src/a.ts、改 packages/shared/src/x.ts（新增 export）、改 docs/guide.md
 *
 * 默认形状让每个分析维度（同文件/接口面/测试交叉/同模块）都有真实素材；
 * 单个测试可按需用返回的 git/writeFile 追加自己的提交。
 */
async function fixtureRepo(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'agent-ci-radar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = args => {
    const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
    return run.stdout;
  };
  const write = async (path, content) => {
    await mkdir(dirname(resolve(dir, path)), { recursive: true });
    await writeFile(resolve(dir, path), content);
  };
  const commit = message => {
    git(['add', '-A']);
    git([...GIT_IDENTITY, 'commit', '-m', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };

  git(['init', '-b', 'main']);
  // base：两侧共同的出发点
  await write('src/a.ts', 'export const a = 1;\n');
  await write('src/b.ts', 'export const b = 1;\n');
  await write('src/b.test.ts', "import { b } from './b';\n");
  await write('docs/guide.md', '# guide\n');
  await write('packages/shared/package.json', '{"name": "@demo/shared", "version": "0.0.0"}\n');
  await write('packages/shared/src/x.ts', 'export const x = 1;\n');
  await write('packages/shared/src/y.ts', 'export const y = 1;\n');
  commit('base');

  // main 分支推进
  await write('src/a.ts', 'export const a = 2;\n');
  await write('src/c.ts', "import { xWidget } from '@demo/shared';\nexport const c = xWidget;\n");
  await write('src/b.test.ts', "import { b } from './b';\n// main tightened expectations\n");
  await write('packages/shared/src/y.ts', "import { x } from './x';\nexport const y = x + 1;\n");
  const mainHead = commit('main moves');

  // pr 分支从 base 分叉
  git(['checkout', '-b', 'pr', 'main~1']);
  await write('src/a.ts', 'export const a = 3;\n');
  await write('packages/shared/src/x.ts', 'export const x = 1;\nexport const xWidget = () => 1;\n');
  await write('docs/guide.md', '# guide updated\n');
  const prHead = commit('pr changes');
  git(['checkout', 'main']);

  return { dir, git, write, commit, mainHead, prHead, base: git(['rev-parse', 'main~1']).trim() };
}

test('collectChanges 返回双侧变更集；since 缺省时 main 侧为 merge-base..base', async t => {
  const f = await fixtureRepo(t);

  const changes = await collectChanges(f.dir, { head: 'pr', base: 'main', since: null });

  assert.deepEqual(changes.prFiles.map(file => file.path).sort(),
    ['docs/guide.md', 'packages/shared/src/x.ts', 'src/a.ts']);
  assert.deepEqual(changes.mainFiles.map(file => file.path).sort(),
    ['packages/shared/src/y.ts', 'src/a.ts', 'src/b.test.ts', 'src/c.ts']);
  // 集成简报素材：main 侧新提交带 SHA 与 subject
  assert.equal(changes.mainCommits.length, 1);
  assert.match(changes.mainCommits[0].subject, /main moves/);
  assert.equal(changes.mainCommits[0].sha, f.mainHead);
  assert.equal(changes.mergeBase, f.base);
});

test('analyzeRadar 报告双侧同文件交集与两侧状态', async t => {
  const f = await fixtureRepo(t);
  const changes = await collectChanges(f.dir, { head: 'pr', base: 'main', since: null });

  const analysis = await analyzeRadar(f.dir, changes);

  assert.deepEqual(analysis.sameFiles, [{ path: 'src/a.ts', prStatus: 'M', mainStatus: 'M' }]);
});

test('analyzeRadar 找出共享接口面：PR export 被 main 新变更文件引用（包名与相对路径两种 import）', async t => {
  const f = await fixtureRepo(t);
  const changes = await collectChanges(f.dir, { head: 'pr', base: 'main', since: null });

  const analysis = await analyzeRadar(f.dir, changes);

  // 排序不稳定源：xWidget 经 c.ts（包说明符）、x 经 y.ts（同包相对路径 + 符号引用）
  const byFile = (p, q) => (`${p.mainFile}:${p.symbol}` < `${q.mainFile}:${q.symbol}` ? -1 : 1);
  assert.deepEqual(analysis.interfaceHits.sort(byFile), [
    { prFile: 'packages/shared/src/x.ts', symbol: 'x', mainFile: 'packages/shared/src/y.ts' },
    { prFile: 'packages/shared/src/x.ts', symbol: 'xWidget', mainFile: 'src/c.ts' },
  ]);
});

test('analyzeRadar 报告测试覆盖交叉：PR 变更源文件的测试文件被 main 触及', async t => {
  const f = await fixtureRepo(t);
  // fixture 默认 PR 未动 b.ts；追加提交使其测试（main 已改的 b.test.ts）进入交叉
  f.git(['checkout', 'pr']);
  await f.write('src/b.ts', 'export const b = 2;\n');
  f.commit('pr touches b');
  f.git(['checkout', 'main']);

  const changes = await collectChanges(f.dir, { head: 'pr', base: 'main', since: null });
  const analysis = await analyzeRadar(f.dir, changes);

  assert.deepEqual(analysis.testCoverageCross, [
    { prFile: 'src/b.ts', testFile: 'src/b.test.ts', mainStatus: 'M' },
  ]);
});

test('collectChanges 的 since 显式给出时，main 侧只含 since..base 的变更', async t => {
  const f = await fixtureRepo(t);
  f.git(['checkout', 'main']);
  await f.write('src/d.ts', 'export const d = 1;\n');
  const secondHead = f.commit('main moves again');

  const changes = await collectChanges(f.dir, { head: 'pr', base: 'main', since: f.mainHead });

  assert.deepEqual(changes.mainFiles.map(file => file.path), ['src/d.ts']);
  assert.equal(changes.mainSince, f.mainHead);
  assert.equal(changes.mainCommits[0].sha, secondHead);
});

test('riskLevel：同文件或共享接口命中 → high', () => {
  const files = path => [{ path, status: 'M' }];
  const same = { sameFiles: [{ path: 'src/a.ts', prStatus: 'M', mainStatus: 'M' }], interfaceHits: [], testCoverageCross: [] };
  assert.equal(riskLevel(same, { prFiles: files('src/a.ts'), mainFiles: files('src/a.ts') }).risk, 'high');
  const iface = { sameFiles: [], interfaceHits: [{ prFile: 'x.ts', symbol: 'f', mainFile: 'y.ts' }], testCoverageCross: [] };
  assert.equal(riskLevel(iface, { prFiles: files('x.ts'), mainFiles: files('y.ts') }).risk, 'high');
});

test('riskLevel：仅同模块双侧变更或测试交叉 → medium；无交集 → low', () => {
  const files = path => [{ path, status: 'M' }];
  const empty = { sameFiles: [], interfaceHits: [], testCoverageCross: [] };
  // 同模块（packages/shared）双侧变更，无直接交集
  const sharedBoth = { prFiles: files('packages/shared/src/x.ts'), mainFiles: files('packages/shared/src/y.ts') };
  assert.equal(riskLevel(empty, sharedBoth).risk, 'medium');
  // 测试交叉单独出现
  const cross = { ...empty, testCoverageCross: [{ prFile: 'src/b.ts', testFile: 'src/b.test.ts', mainStatus: 'M' }] };
  assert.equal(riskLevel(cross, { prFiles: files('src/b.ts'), mainFiles: files('src/b.test.ts') }).risk, 'medium');
  // 不同模块、无任何交集
  const apart = { prFiles: files('apps/api/src/a.ts'), mainFiles: files('docs/guide.md') };
  assert.equal(riskLevel(empty, apart).risk, 'low');
});

test('runRadar 端到端产出完整报告，renderMarkdown 渲染全部四节', async t => {
  const f = await fixtureRepo(t);

  const report = await runRadar(f.dir, { head: 'pr', base: 'main', since: null });
  const markdown = renderMarkdown(report);

  assert.equal(report.risk.risk, 'high');
  assert.match(markdown, /# 冲突雷达报告/);
  assert.match(markdown, /## 1\. 双侧同文件/);
  assert.match(markdown, /## 2\. 共享接口面/);
  assert.match(markdown, /## 3\. 测试覆盖交叉/);
  assert.match(markdown, /## 4\. 建议动作/);
  assert.match(markdown, /src\/a\.ts/);           // 同文件
  assert.match(markdown, /xWidget/);               // 接口面
  assert.match(markdown, /main moves/);            // main 新提交（集成简报素材）
  assert.match(markdown, /\*\*HIGH\*\*/);          // 风险分级
  // fixture 默认 PR 未改 b.ts → 第 3 节显式「（无）」，与「未跑」区分
  assert.match(markdown, /## 3\. 测试覆盖交叉[\s\S]*?\n- （无）/);
});

test('CLI：--head/--base 输出 markdown 报告，退出码 0', async t => {
  const f = await fixtureRepo(t);

  const run = spawnSync(process.execPath,
    [resolve(here, 'conflict-radar.mjs'), '--head', 'pr', '--base', 'main', '--repo', f.dir],
    { encoding: 'utf8' });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /# 冲突雷达报告/);
  assert.match(run.stdout, /src\/a\.ts/);
});

test('CLI：缺 --head 时 usage 进 stderr，退出码 2；坏 ref 退出码 1', async t => {
  const f = await fixtureRepo(t);
  const missing = spawnSync(process.execPath, [resolve(here, 'conflict-radar.mjs')], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--head/);

  const bad = spawnSync(process.execPath,
    [resolve(here, 'conflict-radar.mjs'), '--head', 'no-such-ref', '--base', 'main', '--repo', f.dir],
    { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /no-such-ref|bad revision|does not|Unknown/gi);
});
