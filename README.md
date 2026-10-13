# agent-ci-kit

AI agent 并发开发下的 CI 与合并纪律套件：**串行 pinned CI、label 驱动的
merge train、可审计的 durable Redis 门（gate）、集成冲突雷达、agent 自审
纪律模板**。

这套机制在一个多 agent（每天数十个 PR、多个 agent 同时开发）的真实生产仓库
里演化而来。它解决的是 AI agent 开发特有的故障模式，不是传统 CI 问题的重复发明。

## 为什么需要这套东西

agent 并发开发引入了四类新的、实测发生过的事故模式：

1. **组合失败（passes alone, fails together）**——每个 PR 单独 CI 全绿，合并
   到一起就坏。研究（arXiv:2609.25396）表明给审查者并发变更的描述可挽回
   ~82% 的组合失败。→ `conflict-radar.mjs` 把这个描述从自由裁量变成机械产出。
2. **共享宿主机过载**——多个 agent 会话同时本地跑全量 CI，16 核宿主机 load
   打到 48-70，下游服务负载 flake 反复打红无辜 PR。→ `ci.yml` 的 `ci-serial`
   全局串行 + 排队在 GitHub 侧等待，不占 runner 不占门。
3. **mid-gate cancel 留下未结算的锁**——取消一个持门锁的在途 run，owner 记录
   卡在非 RELEASED 态，全机 CI fail-closed 阻塞，需人工授权恢复。→
   `cancel-in-progress: false` + durable owner 记录 + parent 授权的
   `reset-gate-lane.mjs`。
4. **agent 凭旧信息自审**——merge train 只保证组合树 CI 绿（机器不合并坏
   代码），但 agent 的自审可能基于过时的 `main`。→ AGENTS 模板的六条自审纪律
   （集成简报 → 交互图 → 并行 reviewer → 增量重门 → 发现即测试 → 固定字段
   summary）。

## 组件

| 路径 | 是什么 |
|---|---|
| `AGENTS.template.md` | agent 协作纪律模板：git 工作流、自审六件套、merge train 协议。占位符已泛化，适配后并入你仓库的 `AGENTS.md` |
| `.github/workflows/ci.yml` | pinned CI workflow：`ci:remote` label 触发、`ci-serial` 全局串行、双车道重试 |
| `.github/workflows/merge-train.yml` | `ready-to-merge` label 入队的串行合并列车 |
| `scripts/ci/merge-train.sh` | 列车驱动：merge main 进 PR 分支（组合树）→ 等远端 check 绿 → 复核 head → 合并。红/冲突/竞态自动摘牌并评论原因 |
| `scripts/ci/conflict-radar.mjs` | 只读 git 分析：双侧同文件、共享接口面、测试覆盖交叉、风险分级（high/medium/low），产出 PR review 用的 markdown 报告 |
| `scripts/ci/redis.mjs` | durable Redis 门：借占式 DB13 独占使用、fail-closed 释放（只删白名单 key、分批 ACK、任何异常停止删除）、owner 续约与超时 |
| `scripts/ci/ci-lane-retry.sh` | 车道轮换重试驱动：门锁忙（结构性判据 `cleanup.redis.status == NOT_ADMITTED`，不枚举错误串）切下一条 lane，真失败直接红 |
| `scripts/ci/initialize-gate-lane.mjs` | 车道门的一次性初始化（`--lane 1\|2`；parent 授权，`--decision` 记录决策依据摘要） |
| `scripts/ci/reset-gate-lane.mjs` | 卡死车道的人工恢复（parent 授权；整个 durable root 归档为证据后重建） |

## 接入

1. **占位符替换**：check 名（`CHECK_NAME`，默认 `pinned-ci`，须与 ci.yml 的
   job 名一致）；两个 workflow 的 `runs-on` 换成你的 runner label 组。
2. **pinned CI 入口**：`ci.yml` 通过 `CI_RUNNER`（repo variable
   `CI_RUNNER_ENTRY` 或默认 `/opt/ci-env/bin/run-ci.sh`）调用你的全量 CI
   入口脚本，约定参数：`<workspace> --redis-allocation <file>`。你的入口负责
   准入（`BorrowedRedis`）、跑测试、结算（见 `redis.mjs` 导出）。
3. **门几何**：`redis.mjs` 头部 "Deployment facts" 块钉住路径/服务名/端口/
   DB 号——**示例值即作者原部署值，接入必改**；改完保持稳定。车道由运维
   一次性初始化（`initialize-gate-lane.mjs --lane 1`，见 Operations），agent
   不得自行授权初始化。
4. **夹具 key 白名单**：`redis.mjs` 的 `expectedFixtureKey` 是示例 key 形状
   白名单（fail-closed：不匹配则拒绝删除）。换成你测试实际写的 key 模式，
   保持严格；前缀长度与 `slice(18)` 偏移耦合，改前缀时一起改。
5. **radar 模块映射**：默认按顶级目录分组；设
   `RADAR_PACKAGE_ROOTS='{"api":"apps/api",...}'` 匹配你的 workspace。
6. **AGENTS.md**：把 `AGENTS.template.md` 适配进你仓库的 `AGENTS.md`；
   基础设施事实（IP/端口/路径/凭据）只放私有段，永不公开。

## Operations（runner 主机与门运维）

**runner 主机前置**（两个 workflow 的 job 都跑在上面）：

- 二进制：`git`、`gh`（merge-train）、`base64`、`python3`
  （ci-lane-retry 的 `gate_busy` 判别）、Node ≥22、`docker`（门脚本 inspect 容器）。
- canonical `.env`：`Provide canonical .env` 步骤从 `CI_ENV_FILE`
  （默认 `/opt/ci-env/env`，可经 runner 侧环境或改 workflow 注入）拷贝一份
  只读 env 到工作区。内容契约由你的 pinned CI 入口定义——CI 不经手 secrets。
- 分配文件目录：`CI_ALLOC_DIR`（repo variable 或默认
  `/opt/ci-env/allocations`）下应有 `lane1.json`（必需）与 `lane2.json`
  （可选，缺失自动退化为单车道）。
- repo variables：`CI_RUNNER_ENTRY`（pinned CI 入口脚本绝对路径）、
  `CI_ALLOC_DIR`（分配文件目录）。

**车道生命周期**（均由人工运维执行，`--decision` 记录决策依据）：

```sh
# 首发/重建初始化（lane1 必做；lane2 为故障切换备份）
node scripts/ci/initialize-gate-lane.mjs --lane 1 --decision /path/to/decision.md
node scripts/ci/initialize-gate-lane.mjs --lane 2 --decision /path/to/decision.md

# 卡死车道恢复（owner 卡非 RELEASED 态；旧 durable root 归档为证据）
node scripts/ci/reset-gate-lane.mjs --lane 1 --decision /path/to/incident.md [--dry-run]
```

初始化默认把分配写到 `$CI_ALLOC_DIR/laneN.json`（即
`/opt/ci-env/allocations/laneN.json`），可用 `--allocation-out` 覆盖——但
**输出路径必须与 ci.yml 读取的路径一致**，否则第一次 CI 即红。

**集成测试开关**（`redis.test.mjs` 跳过的那例，须在一次真实准入 run 内执行）：

- `AGENT_CI_REDIS_TESTS=1` 开启；
- `AGENT_CI_REDIS_URL`：指向已声明 boundary 的 redis URL（形如
  `redis://127.0.0.1:16379/13`）；
- `AGENT_CI_REDIS_EPOCH`：等于该 lane 上在途 ACTIVE owner 的 epoch；
- `AGENT_CI_REDIS_EVIDENCE`：结算回执的输出路径。

**适用范围**：同仓库分支的 PR（agent 工作流）。fork PR 上 `github.token`
只读，列车 push/merge 会失败——外部贡献需先推入同仓库分支。

## 测试与已知边界

```sh
npm install && npm test    # node --test scripts/ci/*.test.mjs
```

- `redis.test.mjs`（34 用例）与 `conflict-radar.test.mjs`（10 用例）随 kit
  自包含运行（临时目录 fixture，零外部服务）。
- **跳过的 1 例**：需真实 gate-redis + 分配文件 + durable root 的集成验证
  （`AGENT_CI_REDIS_TESTS=1`），在接入环境里跑。
- **不随 kit 转移的覆盖**：产出仓库另有 pinned runner（`run.mjs`/`plan.mjs`
  体系）与 lane 驱动（`runner.test.mjs`）的测试——那些深耦合业务仓库的
  workspace 布局。因此 kit 内 `merge-train.sh` 与 `ci-lane-retry.sh`
  **无自动化测试**，接入时首跑请盯列车空转日志。
- **依赖版本轴**：kit 测试在 ioredis 5.11.1 验证（lockfile 即证）；同 major
  其他小版本行为未逐个验证。
- **未被用例覆盖的差异保持未知**：本机 green 只证明 kit 夹具配置下的行为
  （Node 版本、mock 的 Redis wire、临时目录几何）；你的 runner 环境、真实
  Redis 语义、GitHub API 时序需在接入环境重新验证。

## 设计决策速记（全部来自实测事故）

- `ci-serial` concurrency + `cancel-in-progress: false`：并 发全量 CI 在共享
  宿主机上测试相位重叠（实测 load 48-70 打红无辜 PR）；取消持锁 run 会把
  gate owner 留在未结算态（实测两次，全机 CI 阻塞到人工授权恢复）。
- 门锁忙 vs 真失败的结构性判据（`NOT_ADMITTED`）：枚举错误串的判别漏一种
  就秒红一批 PR（实测：七连发 5 红 + 修复 PR 自身被第三种串打红）。
- `check_state` 取 `started_at` 最新且排除 `skipped` 占位：同名 check-run
  多条时读旧结果会误释放绿 PR（实测阻塞全部入队 PR）。
- 认证用 basic `x-access-token` 头而非 bearer：git 不认 bearer（实测 fatal
  回退交互式认证）。
- 分支已含 main 且无真实 check 时推空提交触发 CI：用 `GITHUB_TOKEN` 补
  label 不会创建 workflow run（实测死等 45min × 2）。

## License

MIT
