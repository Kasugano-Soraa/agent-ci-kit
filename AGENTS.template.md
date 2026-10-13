# AGENTS.md 模板 —— AI agent 协作开发纪律

> 本文件是从一个真实生产仓库的 `AGENTS.md` 剥离出的**方法论部分**：git 工作流、
> agent 自审纪律与 merge train 协议。基础设施事实（主机、IP、凭据、内部路径）
> 已全部剥离——你的仓库应在自己的 `AGENTS.md` 里维护那些事实，并把本模板的
> 纪律部分适配后并入。唯一占位符：`<ci-check-name>`（你的 pinned CI check
> 名，默认 `pinned-ci`）；runner label、repo 名等由你的实际部署取值。

## Git 工作流规则

默认工作流——除非用户明确要求直接在 `main` 上改或另有指示：

- **分支**：同步本地 `main` 与 `origin/main`，从其新建分支（工作树忙时用专用
  worktree）。命名：`fix/<topic>` 修 bug，`feat/<topic>` 新功能，`chore/<topic>`
  维护。**永不直接向 `main` 提交**。
- **提交**：聚焦单一主题，conventional 消息（`fix:` / `feat:` / `chore:` …）。
- **验证基线**：最终 CI 与自审前，fetch 最新 `origin/main` 并合入 PR 分支
  （即使无冲突也要合——合并无冲突 ≠ 行为兼容），对合并后的组合代码跑全部 gate。

### 基线 gate（每个 PR 必须）

1. **CI gate**：推送分支，确保 PR 带 `ci:remote` label，要求远端
   `<ci-check-name>` check 在 PR head 上通过。本机不跑全量 pinned CI——
   并发的 agent 本地全量 run 在共享宿主机上不受控，会互相打红。
2. **自审 gate**：对照 `origin/main` 最新代码审查完整 PR diff 与相关既有代码，
   评估合并后行为（正确性/范围/兼容性/副作用/测试覆盖），结论必须是
   "approve / 建议通过"。六条固定纪律：
   1. **集成简报（前置条件）**：审查前摄取自上次 gate 以来 `main` 的变化
      （`git log --oneline <last-gate-SHA>..origin/main` + 各已合并 PR 的摘要），
      作为集成审查的必要上下文。依据：arXiv:2609.25396（"Passes Alone,
      Fails Together"）——给 agent 并发变更的描述可挽回 ~82% 的组合失败。
   2. **交互图（审查输入）**：运行
      `node scripts/ci/conflict-radar.mjs --head <PR-head> --base origin/main [--since <last-gate-SHA>]`
      并把报告附进 PR review；审查输入是 radar 报告 + 人给的调用链与数据流。
      追踪受影响的调用方、依赖、接口、数据流与共享行为——**无冲突的 git
      merge 不能建立行为兼容性**。
   3. **并行 reviewer**：radar 报 HIGH 风险（同文件或共享接口面）时，集成
      审查另需至少一个**独立** subagent reviewer（语义密集的 claim 优先选
      跨厂商观察者）。给 reviewer 目标、待验证 claim 与证据路径——**绝不给
      主张者的论证**；输出的是 reviewer 的 findings，不是它的批准。
   4. **增量重门**：`main` 越过上次 gate 后，对组合代码重跑全部基线 gate
      （CI + 本自审）再入队——全量重门是默认；merge train 的组合树验证是
      兜底，不是替代。
   5. **发现即测试（硬规则）**：审查发现的每个集成风险，要么在同一个 PR 里
      落成针对性回归测试，要么记录明确的不落地理由。
   6. **PR review summary（固定字段）**：审查的 PR head SHA 与 `origin/main`
      SHA；radar 报告或其结论；检查过的交互清单；每个交互的验证结果；
      reviewer 身份（self，或独立 subagent + lens）。
3. **浏览器 gate（仅用户可见变更）**：触及 UI/样式/布局/i18n 文案/表单交互
   等用户所见时，合并前在真实浏览器走一遍受影响流程，验证渲染、翻译与交互
   （截图为证）。

### 推送与 PR

推送分支到 origin，`gh pr create` 开 PR 到 `main`。PR body 说明改了什么、
为什么、如何验证（含浏览器测试），并引用相关 issue。

### 合并与清理：merge train

所有 gate 通过后**不手工合并**——给 PR 加 `ready-to-merge` label。merge-train
workflow（`.github/workflows/merge-train.yml` + `scripts/ci/merge-train.sh`）
按 PR 号升序逐个处理：把 `origin/main` merge 进 PR 分支并 push（组合树，触发
远端 CI）→ 等远端 check 在该 head 变绿 → 复核 head 未变 → merge 并删除远端
分支。PR 合并后：删本地分支与 worktree，同步本地 `main`。

- train 活跃期间**永不手工合并**、永不向带 `ready-to-merge` 的 PR 分支 push；
  train 合并前会复核 head，中途变化的 PR 会被释放（push 稳定后重新打 label）。
- 红 check / 冲突 / 竞态：train 摘 `ready-to-merge` 并评论原因——在分支上修、
  push、gate 重跑、再打 label。
- stacked PR（base ≠ main）不入列车：底 PR 合并后 retarget 到 `main`，重跑
  gate，再打 label。
- **回退（train 或 runner 不可用）**：手工 merge-train 纪律——全仓库同时至多
  合并一个 PR（先 `gh pr list --state open`）；任一 PR 合并进 `main` 的瞬间，
  其余在途 PR 的 gate 全部失效，各自合入最新 `origin/main`、重跑全部 CI 与
  自审 gate、合并前即刻复核 PR head 与 `origin/main`。回退窗口保持短并在 PR
  里注明。
- 他人 PR 合并后再入队（重新 label 或回退重门）前，对新 `origin/main` 应用
  自审纪律第 1 条（集成简报）并记入 PR review。

### 例外

仅当用户明确要求直接改 `main`（或指定其他工作流）时可跳过本流程，遵用户指示。

## 基础设施事实段（自维护，勿开源）

在生产仓库的 `AGENTS.md` 里，紧接本方法论维护一段**仅私有**的事实：主机别名
与 IP、SSH 规则、内部域名、CI 容器端口、分配文件路径、runner 布局。经验法则：
方法论（为什么/怎么协作）可以公开；事实（哪里/哪个端口/哪台机器）永不公开。
