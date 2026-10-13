#!/usr/bin/env bash
# 双车道门锁重试驱动（被 .github/workflows/ci.yml 调用；也可手动复现 workflow 行为）。
#
# 按 lane 顺序传入 Redis 分配文件（lane1 在前）：门锁忙时切下一条 lane 立即
# 重跑，一整圈都忙才 sleep（单 lane 时退化为原有的 sleep 循环）。真实测试
# 失败直接红。后续 lane 的分配文件缺失时丢弃该 lane（初始化完成前的过渡期
# 自动退化为单车道），但第一个分配缺失是配置错误。
#
# 门锁忙的判别不看时长（pre-gate 的 install/self-tests 本身约 40s），
# 也不枚举错误串——准入路径至少三种失败串（"Gate lock unavailable" 锁竞争 /
# "Prior CI/formal owner is unresolved" 在途 owner / "Terminal lifecycle is
# not settled" cancel 残留收据），枚举漏一种就秒红一批 PR（产出仓库实测两轮：
# 七连发批量红 + lane-retry 修复 PR 自身被 Terminal 串打红）。
# 结构性判据：result.json 的 cleanup.redis.status == NOT_ADMITTED（从未借到
# 车道）= 忙/脏，轮换+等待；真实测试失败发生在准入之后，不可能是
# NOT_ADMITTED。等不到（MAX_ATTEMPTS 耗尽）才显式红。
#
# 用法: ci-lane-retry.sh <workspace> <lane1-allocation> [lane2-allocation ...]
# 环境: CI_RUNNER（必填：你的 pinned CI 入口脚本，接收 <workspace>
#       --redis-allocation <file> 参数）
#       CI_RETRY_MAX（默认 40）/ CI_RETRY_SLEEP（默认 60）
#       RUNNER_TEMP（重试日志目录，默认 /tmp）
set -uo pipefail

WORKSPACE=$1
shift
RUNNER=${CI_RUNNER:-}
MAX_ATTEMPTS=${CI_RETRY_MAX:-40}
SLEEP_S=${CI_RETRY_SLEEP:-60}
LOG_DIR=${RUNNER_TEMP:-/tmp}

if [ -z "$RUNNER" ]; then
  echo "::error::CI_RUNNER must point at your pinned CI entry script (see README → Operations)"
  exit 2
fi
if [ ! -f "$RUNNER" ]; then
  echo "::error::required file missing: $RUNNER (see README → Operations)"
  exit 2
fi

ALLOCATIONS=()
for a in "$@"; do
  if [ -f "$a" ]; then
    ALLOCATIONS+=("$a")
  elif [ ${#ALLOCATIONS[@]} -eq 0 ]; then
    echo "::error::required file missing: $a (see README → Operations)"
    exit 2
  else
    echo "lane allocation not initialized yet; skipping lane: $a"
  fi
done
if [ ${#ALLOCATIONS[@]} -eq 0 ]; then
  echo "::error::no usable gate lane allocation"
  exit 2
fi

attempt=1
index=0
busy_streak=0
count=${#ALLOCATIONS[@]}
gate_busy() { # $1=result.json —— 准入未完成（NOT_ADMITTED）= 车道忙/脏，可轮换等待
  [ -n "$1" ] && [ -f "$1" ] && python3 -c '
import json, sys
try:
    result = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if (result.get("cleanup", {}).get("redis", {}) or {}).get("status") == "NOT_ADMITTED" else 1)
' "$1" 2>/dev/null
}
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  alloc=${ALLOCATIONS[$(( index % count ))]}
  out="$LOG_DIR/ci-out-$attempt.log"
  "$RUNNER" "$WORKSPACE" --redis-allocation "$alloc" 2>&1 | tee "$out"
  rc=${PIPESTATUS[0]}
  if [ "$rc" -eq 0 ]; then
    exit 0
  fi
  rj=$(grep -o 'CI_RESULT_JSON=[^[:space:]]*' "$out" | tail -1 | cut -d= -f2-)
  if gate_busy "$rj"; then
    busy_streak=$(( busy_streak + 1 ))
    if [ "$busy_streak" -ge "$count" ]; then
      busy_streak=0
      echo "attempt $attempt/$MAX_ATTEMPTS: all $count gate lane(s) busy (rc=$rc); retry in ${SLEEP_S}s"
      sleep "$SLEEP_S"
    else
      echo "attempt $attempt/$MAX_ATTEMPTS: gate lane busy ($(basename "$alloc")); switching lane (rc=$rc)"
    fi
    index=$(( index + 1 ))
    attempt=$(( attempt + 1 ))
    continue
  fi
  echo "::error::CI failed for real (rc=$rc) — see your CI log directory (newest run)"
  exit "$rc"
done
echo "::error::exclusive gate lanes stayed busy for ${MAX_ATTEMPTS} attempts (~$(( MAX_ATTEMPTS / count * SLEEP_S / 60 ))min with both busy)"
exit 1
