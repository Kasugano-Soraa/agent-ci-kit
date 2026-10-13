#!/usr/bin/env node
/**
 * 冲突雷达（phase 4，任务 A）——机械产出「PR 变更 × main 新变更」的集成审查交互面。
 *
 * 动机：merge-train 只保证组合树 CI 绿（机器不合并坏代码），agent 自审仍可能凭旧信息
 * 做坏判断。研究（arXiv:2609.25396, "Passes Alone, Fails Together"）表明给 agent 并发
 * 变更的描述可挽回 ~82% 的组合失败——本脚本把该描述从自由裁量变成机械产出：
 *   1. 双侧同文件清单（PR 变更 ∩ main 自上次 gate/分叉以来的新变更）
 *   2. 共享接口面：PR 触及的 export × main 新变更文件里的引用点（粗粒度文本匹配）
 *   3. 测试覆盖交叉：PR 变更文件对应的测试文件是否被 main 新变更触及
 *   4. 风险分级：high=同文件/同接口；medium=同模块/测试交叉；low=其余
 *
 * 只读分析、零副作用：仅执行只读 git 命令（rev-parse / merge-base / diff / log / show），
 * 永不触碰 gate/redis，也从不写仓库。用法（自审 gate 前本地跑，报告贴 PR review）：
 *
 *   node scripts/ci/conflict-radar.mjs --head <PR-head> [--base origin/main] [--since <last-gate-SHA>]
 *
 * --since 是上次 gate 时的 main SHA；缺省时 main 侧取 merge-base(head, base)..base。
 */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);

/** 执行一条只读 git 命令；失败时抛带 stderr 的错误（CLI 层转 exit 1）。 */
async function execGit(repo, args) {
  const { stdout } = await execFile('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * `git diff --name-status --no-renames -z from..to` → [{path, status}]。
 * rename 显示为 D+A 的组合（粗粒度分析刻意不检测 rename：交集按路径判定不受影响）。
 */
async function diffNameStatus(repo, from, to) {
  const raw = await execGit(repo, ['diff', '--name-status', '--no-renames', '-z', `${from}..${to}`]);
  const fields = raw.split('\0');
  const files = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    files.push({ status: fields[index], path: fields[index + 1] });
  }
  return files;
}

/** main 侧新提交列表（集成简报素材）：[{sha, subject}]，最新在前。 */
async function logCommits(repo, from, to) {
  const raw = await execGit(repo, ['log', '--format=%H%x00%s', `${from}..${to}`]);
  return raw.split('\n').filter(Boolean).map(line => {
    const [sha, subject] = line.split('\0');
    return { sha, subject };
  });
}

/**
 * 采集双侧变更。head/base 是任意 git ref；since 缺省时 main 侧为
 * merge-base(head, base)..base，显式给出时为 since..base（自上次 gate 以来 main 的移动）。
 */
export async function collectChanges(repo, { head, base, since }) {
  const mergeBase = (await execGit(repo, ['merge-base', head, base])).trim();
  const prFiles = await diffNameStatus(repo, mergeBase, head);
  const mainSince = since ?? mergeBase;
  const mainFiles = await diffNameStatus(repo, mainSince, base);
  const mainCommits = await logCommits(repo, mainSince, base);
  return { head, base, since: since ?? null, mergeBase, mainSince, prFiles, mainFiles, mainCommits };
}

// ---- 共享接口面（粗粒度文本匹配：同 workspace + import 关系，勿过度工程）----

const SOURCE_FILE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const EXTENSION = /\.[cm]?[jt]sx?$/;
const EXPORT_DECLARATION = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST = /export\s*\{([^}]*)\}/g;
const IMPORT_STATEMENT = /(?:^|\n)\s*(?:import\s+[^;]*?from\s*['"][^'"]*['"]|import\s*['"][^'"]*['"]|export\s+[^;]*?from\s*['"][^'"]*['"]);?/g;
const IMPORT_SPECIFIER = /(?:import\s+[^;]*?from\s*|import\s*|export\s+[^;]*?from\s*)['"]([^'"]+)['"]/g;

/** 提取文件的导出符号名（声明式 + `export { a as b }` 列表）。粗粒度：`export *` 取不到名字，靠 import 关系兜不住则漏报。 */
export function extractExportedNames(content) {
  const names = new Set();
  for (const match of content.matchAll(EXPORT_DECLARATION)) names.add(match[1]);
  for (const list of content.matchAll(EXPORT_LIST)) {
    for (const entry of list[1].split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** 相对说明符（./ ../）按 main 文件位置归一化后是否指向 PR 变更文件（扩展名与 ?query 可省略）。 */
function resolvesTo(specifier, fromFile, targetFile) {
  if (!specifier.startsWith('.')) return false;
  const resolved = normalize(join(dirname(fromFile), specifier)).replaceAll('\\', '/')
    .replace(/\?.*$/, '').replace(EXTENSION, '');
  return resolved === targetFile.replace(EXTENSION, '');
}

/** 读 ref 下某文件内容；不存在（如已删除）返回 null。 */
async function showFile(repo, ref, path) {
  try {
    return await execGit(repo, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** 源文件在 vitest 默认发现模式下的候选测试路径（同目录与 __tests__/，.test/.spec 两种后缀）。 */
function testFileCandidates(path) {
  const directory = dirname(path);
  const stem = path.replace(EXTENSION, '');
  const name = stem.split('/').pop();
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].flatMap(ext => [
    `${stem}.test${ext}`, `${stem}.spec${ext}`,
    `${directory}/__tests__/${name}.test${ext}`, `${directory}/__tests__/${name}.spec${ext}`,
  ]);
}

// ---- 风险分级 ----

// 模块归属映射：文件路径前缀 → 模块名（报告分组用）。设 RADAR_PACKAGE_ROOTS
// 为 {"模块名":"相对路径",...} 的 JSON 以匹配你的 workspace 布局（产出仓库把它
// 钉在自己的 CI 计划模块里，避免两处漂移）；缺省为空——所有文件按顶级目录
// 归类（scripts/ docs/ .github/ ...）。
const packageRoots = JSON.parse(process.env.RADAR_PACKAGE_ROOTS ?? '{}');
const MODULE_PREFIXES = Object.entries(packageRoots).map(([name, root]) => [`${root}/`, name]);

function moduleOf(path) {
  for (const [prefix, name] of MODULE_PREFIXES) if (path.startsWith(prefix)) return name;
  return path.split('/')[0];
}

/**
 * 风险分级：high=同文件/共享接口（机械组合冲突面）；medium=同模块双侧变更或
 * 测试交叉（无直接交集但语义可能交互）；low=其余（main 未动或完全不相干）。
 * reasons 供 PR review 直接引用。
 */
export function riskLevel(analysis, changes) {
  const reasons = [];
  if (analysis.sameFiles.length) {
    reasons.push(`双侧同文件变更 ${analysis.sameFiles.length} 处（如 ${analysis.sameFiles[0].path}）`);
  }
  if (analysis.interfaceHits.length) {
    reasons.push(`共享接口面命中 ${analysis.interfaceHits.length} 处（如 ${analysis.interfaceHits[0].prFile} 的 ${analysis.interfaceHits[0].symbol}）`);
  }
  if (reasons.length) return { risk: 'high', reasons };

  if (analysis.testCoverageCross.length) {
    reasons.push(`PR 变更文件的测试被 main 触及 ${analysis.testCoverageCross.length} 处（如 ${analysis.testCoverageCross[0].testFile}）`);
  }
  const prModules = new Set(changes.prFiles.map(file => moduleOf(file.path)));
  const sharedModules = [...new Set(changes.mainFiles
    .map(file => moduleOf(file.path))
    .filter(module => prModules.has(module)))].sort();
  if (sharedModules.length) reasons.push(`同模块双侧变更：${sharedModules.join(', ')}`);
  return { risk: reasons.length ? 'medium' : 'low', reasons };
}

/**
 * 分析交互面。
 *
 * sameFiles 是两侧按路径的交集（组合冲突的机械定义：无论语义，同路径双侧变更必须在
 * 集成审查里显式覆盖——冲突-free 的 git merge 不代表行为兼容）。
 *
 * interfaceHits 只在 main 变更文件与 PR 变更文件存在 import 关系（相对说明符指向该文件，
 * 或说明符命中该文件所属的 workspace 包）时才做导出符号的词边界匹配——先限定关系再匹配
 * 符号，避免同包内同名巧合（如两侧都引用 useMemo）造成噪音；同路径文件已由 sameFiles
 * 覆盖，不重复报。
 *
 * testCoverageCross 是 PR 变更源文件的测试被 main 同时触及——两侧对同一行为的预期
 * 各自漂移，组合后测试可能红或（更糟）静默放行。
 */
export async function analyzeRadar(repo, changes) {
  const prByPath = new Map(changes.prFiles.map(file => [file.path, file]));
  const mainByPath = new Map(changes.mainFiles.map(file => [file.path, file]));
  const sameFiles = [...prByPath.keys()]
    .filter(path => mainByPath.has(path))
    .sort()
    .map(path => ({ path, prStatus: prByPath.get(path).status, mainStatus: mainByPath.get(path).status }));

  const packageCache = new Map();
  const packageNameFor = async (ref, path) => {
    const segments = path.split('/');
    if (segments.length < 2) return null;
    const manifest = `${segments[0]}/${segments[1]}/package.json`;
    if (!packageCache.has(manifest)) {
      const text = await showFile(repo, ref, manifest);
      try {
        packageCache.set(manifest, JSON.parse(text).name ?? null);
      } catch {
        packageCache.set(manifest, null);
      }
    }
    return packageCache.get(manifest);
  };

  const prExports = [];
  for (const { path, status } of changes.prFiles) {
    if (status === 'D' || !SOURCE_FILE.test(path) || TEST_FILE.test(path)) continue;
    const content = await showFile(repo, changes.head, path);
    if (content == null) continue;
    const names = extractExportedNames(content);
    if (names.length) prExports.push({ path, names, pkg: await packageNameFor(changes.head, path) });
  }

  const interfaceHits = [];
  for (const { path, status } of changes.mainFiles) {
    if (status === 'D' || !SOURCE_FILE.test(path) || TEST_FILE.test(path)) continue;
    const content = await showFile(repo, changes.base, path);
    if (content == null) continue;
    const specifiers = [...content.matchAll(IMPORT_SPECIFIER)].map(match => match[1]);
    const body = content.replace(IMPORT_STATEMENT, '');
    for (const target of prExports) {
      if (target.path === path) continue; // 同路径已由 sameFiles 覆盖
      const related = specifiers.some(spec => resolvesTo(spec, path, target.path))
        || (target.pkg && specifiers.some(spec => spec === target.pkg || spec.startsWith(`${target.pkg}/`)));
      if (!related) continue;
      for (const name of target.names) {
        if (new RegExp(`\\b${name.replaceAll(/[$]/g, '[$&]')}\\b`).test(body)) {
          interfaceHits.push({ prFile: target.path, symbol: name, mainFile: path });
        }
      }
    }
  }

  const isSource = file => file.status !== 'D' && SOURCE_FILE.test(file.path) && !TEST_FILE.test(file.path);
  const testCoverageCross = changes.prFiles
    .filter(isSource)
    .flatMap(file => {
      const hit = testFileCandidates(file.path).find(candidate => mainByPath.has(candidate));
      return hit ? [{ prFile: file.path, testFile: hit, mainStatus: mainByPath.get(hit).status }] : [];
    })
    .sort((p, q) => (p.prFile < q.prFile ? -1 : 1));

  return { sameFiles, interfaceHits, testCoverageCross };
}

// ---- 报告组合与渲染 ----

/** 组合采集与分析，产出完整报告（headSha/baseSha 供 PR review summary 记录）。 */
export async function runRadar(repo, { head, base, since }) {
  const changes = await collectChanges(repo, { head, base, since });
  const analysis = await analyzeRadar(repo, changes);
  const risk = riskLevel(analysis, changes);
  const [headSha, baseSha] = await Promise.all([
    execGit(repo, ['rev-parse', head]).then(sha => sha.trim()),
    execGit(repo, ['rev-parse', base]).then(sha => sha.trim()),
  ]);
  return { head, base, since: changes.since, mergeBase: changes.mergeBase, headSha, baseSha, risk, ...changes, ...analysis };
}

/** 渲染 markdown 报告（贴 PR review 用）；空节显式标「无」，避免与「未跑」混淆。 */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# 冲突雷达报告', '');
  lines.push(`- PR head \`${report.headSha}\` × base \`${report.baseSha}\`（自 merge-base \`${report.mergeBase}\`；since ${report.since ? `\`${report.since}\`` : '未指定（= merge-base）'}）`);
  lines.push(`- main 侧新提交 ${report.mainCommits.length} 个；PR 变更 ${report.prFiles.length} 个文件，main 变更 ${report.mainFiles.length} 个文件`);
  lines.push(`- 风险分级 **${report.risk.risk.toUpperCase()}**${report.risk.reasons.length ? ` — ${report.risk.reasons.join('；')}` : '（两侧无机械可检交集）'}`, '');

  lines.push('## main 侧新提交（集成简报素材：自审前先读）');
  if (report.mainCommits.length) {
    for (const commit of report.mainCommits) lines.push(`- \`${commit.sha.slice(0, 8)}\` ${commit.subject}`);
  } else lines.push('- （无——main 未移动）');
  lines.push('');

  lines.push('## 1. 双侧同文件（high：逐处集成审查，git 合并干净 ≠ 行为兼容）');
  if (report.sameFiles.length) {
    lines.push('| 文件 | PR | main |', '|---|---|---|');
    for (const file of report.sameFiles) lines.push(`| \`${file.path}\` | ${file.prStatus} | ${file.mainStatus} |`);
  } else lines.push('- （无）');
  lines.push('');

  lines.push('## 2. 共享接口面（high：PR 触及的 export × main 新变更的引用点）');
  if (report.interfaceHits.length) {
    for (const hit of report.interfaceHits) {
      lines.push(`- \`${hit.prFile}\` 的 \`${hit.symbol}\` ← main 变更的 \`${hit.mainFile}\` 引用`);
    }
  } else lines.push('- （无）');
  lines.push('');

  lines.push('## 3. 测试覆盖交叉（medium：两侧对同一行为的预期各自漂移）');
  if (report.testCoverageCross.length) {
    for (const cross of report.testCoverageCross) {
      lines.push(`- PR 改 \`${cross.prFile}\`，main 改了其测试 \`${cross.testFile}\`（${cross.mainStatus}）`);
    }
  } else lines.push('- （无）');
  lines.push('');

  lines.push('## 4. 建议动作');
  if (report.risk.risk === 'high') {
    lines.push('- 同文件与接口面命中：逐处读 main 侧变更语义，组合行为写进自审记录；发现的每个风险点转化为回归测试（AGENTS 自审 gate）。');
  } else if (report.risk.risk === 'medium') {
    lines.push('- 同模块/测试交叉：确认无隐性交互后，在 PR review summary 记录检查结论。');
  } else {
    lines.push('- 无机械交集：常规自审即可，本报告附入 PR review summary。');
  }
  return lines.join('\n');
}

// ---- CLI（只读分析，零副作用）----

const USAGE = `usage: node scripts/ci/conflict-radar.mjs --head <PR-head> [--base origin/main] [--since <last-gate-SHA>] [--repo <path>]

  --head   PR 分支或 SHA（必填）
  --base   基线 ref，默认 origin/main
  --since  上次 gate 时的 main SHA；缺省 = merge-base(head, base)
  --repo   仓库路径，默认当前目录`;

function parseArgs(argv) {
  const options = { base: 'origin/main', repo: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--head' || argument === '--base' || argument === '--since' || argument === '--repo') {
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${USAGE}\n${error.message}\n`);
    process.exit(2);
  }
  if (options.help || !options.head) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(options.help ? 0 : 2);
  }
  try {
    process.stdout.write(`${renderMarkdown(await runRadar(options.repo, options))}\n`);
  } catch (error) {
    process.stderr.write(`conflict-radar: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
