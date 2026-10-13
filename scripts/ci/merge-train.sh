#!/usr/bin/env bash
# merge train driver（自托管 runner 上运行；workflow: merge-train.yml）
#
# 串行合并 + 组合树验证（自动化的 AGENTS merge-train 纪律）：
#   1. 取带 ready-to-merge label 的开放 PR，按 PR 号升序。
#   2. 每个 PR：base=main、无冲突、补 ci:remote label →
#      merge origin/main 进 PR 分支并 push（组合树，触发远端 CI check）→
#      等远端 CI check 在该 head 上变绿（默认 ≤45min，含门锁重试）→
#      （分支已含 main 且 head 从无真实 check 时，先推空提交触发远端 CI，
#      防对不存在的 check 死等 45min）→ 复核 head 未变 → gh pr merge --merge --delete-branch。
#   3. 红 check / 冲突 / 竞态：摘 ready-to-merge + PR 评论原因，继续下一个。
#
# 约束（详见 AGENTS.template.md / 你仓库的 AGENTS.md）：train 活跃期间禁止手工合并；train 只向 PR 分支
# 追加 merge commit（非强推，出问题可由 agent reset 恢复）。
set -uo pipefail

REPO=${1:-${GITHUB_REPOSITORY:?pass <owner/repo> as arg 1, or run inside Actions (GITHUB_REPOSITORY)}}
: "${GH_TOKEN:?GH_TOKEN must be set (use the workflow github.token)}"
WS=${GITHUB_WORKSPACE:-$PWD}
CHECK_NAME=${CHECK_NAME:-pinned-ci}
CHECK_TIMEOUT_S=${CHECK_TIMEOUT_S:-2700}
MAX_CYCLES=${MAX_CYCLES:-3}

note() { echo "[train $(date -u +%H:%M:%S)] $*"; }

git_in_ws() { git -C "$WS" "$@"; }
# 私有仓库的 fetch/push 用 x-access-token basic 头（与 actions/checkout 同形式；
# git 不认 bearer 头——2026-10-09 实测 bearer 会 fatal 回退到交互式认证）。
# checkout 用 persist-credentials:false，凭据不落盘，仅随命令传入。
ggit() {
  local auth
  auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
  git -C "$WS" -c "http.https://github.com/.extraheader=$auth" "$@"
}

release() { # $1=pr-number $2=reason —— 摘牌并评论
  gh api -X DELETE "repos/$REPO/issues/$1/labels/ready-to-merge" >/dev/null 2>&1 || true
  gh pr comment "$1" -R "$REPO" --body "🚂 merge-train：已摘除 ready-to-merge。原因：$2" >/dev/null 2>&1 || true
  note "released PR #$1: $2"
}

ensure_remote_ci_label() { # ci:remote 不在则补（保证 synchronize 触发远端 check）
  gh api -X POST "repos/$REPO/issues/$1/labels" -f 'labels[]=ci:remote' >/dev/null 2>&1 || true
}

pr_state() { # $1=pr-number → "state<TAB>base<TAB>branch<TAB>head<TAB>mergeable_state"
  gh api "repos/$REPO/pulls/$1" \
    --jq '[.state,.base.ref,.head.ref,.head.sha,(.mergeable_state // "unknown")] | @tsv' 2>/dev/null
}

check_state() { # $1=sha → "status<TAB>conclusion"（无 check-run 则 "missing<TAB>-"；API 失败则 "error\t-"，详情进 job log）
  # 同一 SHA 可能有多个同名 check-run（如 opened 触发的 SKIPPED 与 labeled 触发的
  # SUCCESS 各一条），必须取 started_at 最新的一条，否则可能误读旧结果。
  # conclusion=skipped 的 check-run 是 ci.yml if 条件未命中的占位记录（未执行），
  # 不算结论、不参与最新排序：2026-10-09 实测 ready-to-merge label 触发的
  # skipped run 比 ci:remote 触发的 SUCCESS 新，按 started_at 取最新会读到
  # skipped，train 把绿 PR 误释放（产出仓库实测：首次入队即复现，阻塞所有入队 PR）。
  # API 失败（如缺 checks:read 权限、限流）必须与"check 尚未创建"区分开，
  # 否则会静默空转轮询直到超时（2026-10-09 实测：缺权限 → 403 → 45min 空转）。
  local out
  if ! out=$(gh api "repos/$REPO/commits/$1/check-runs" \
    --jq '[.check_runs[] | select(.name == "'"$CHECK_NAME"'")] | map(select((.conclusion // "") != "skipped")) | if length == 0 then ["missing","-"] else (sort_by(.started_at) | last | [.status, (.conclusion // "")]) end | @tsv' 2>&1); then
    echo "check-runs API 失败：$(head -c 300 <<<"$out")" >&2
    printf 'error\t-\n'
    return 0
  fi
  printf '%s\n' "$out"
}

wait_check_green() { # $1=pr-number $2=sha
  local deadline=$(( $(date +%s) + CHECK_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local state conclusion
    IFS=$'\t' read -r state conclusion < <(check_state "$2")
    if [ "$state" = "error" ]; then
      note "PR #$1 check-runs 查询失败（详见上方 stderr）"
      return 1
    fi
    if [ "$state" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        return 0
      fi
      note "PR #$1 check conclusion=$conclusion on ${2:0:7}"
      return 1
    fi
    sleep 30
  done
  note "PR #$1 check 未在 ${CHECK_TIMEOUT_S}s 内完成"
  return 1
}

process() { # $1=pr-number
  local num=$1
  local state base branch head merge_state
  IFS=$'\t' read -r state base branch head merge_state < <(pr_state "$num")
  if [ -z "${state:-}" ]; then note "PR #$num 状态不可读"; return; fi
  if [ "$state" != "open" ]; then note "PR #$num 非 open（$state）"; return; fi
  if [ "$base" != "main" ]; then
    release "$num" "base=$base（stacked PR 不入列车；base PR 合并后 retarget 到 main 再重新打 label）"
    return
  fi
  if [ "$merge_state" = "dirty" ]; then
    release "$num" "与 main 冲突（mergeable_state=dirty），解决冲突后重新打 label"
    return
  fi

  ensure_remote_ci_label "$num"

  local ferr=/tmp/train-fetch-$num.err
  if ! ggit fetch origin main "$branch" 2>"$ferr"; then
    release "$num" "train fetch 失败：$(head -c 200 "$ferr")"
    rm -f "$ferr"
    return
  fi
  rm -f "$ferr"
  local main_now
  main_now=$(git_in_ws rev-parse origin/main) || { release "$num" "无法解析 origin/main"; return; }
  git_in_ws checkout --quiet -B "train-$num" "origin/$branch" \
    || { release "$num" "checkout origin/$branch 失败（分支可能已被删除）"; return; }

  local new_head="$head"
  if ! git_in_ws merge-base --is-ancestor "$main_now" HEAD 2>/dev/null; then
    if ! git_in_ws merge --no-ff -m "Merge branch 'main' into $branch (merge-train combined-tree validation)" "$main_now"; then
      git_in_ws merge --abort 2>/dev/null || true
      release "$num" "train 合并 main 进 $branch 失败（冲突）"
      return
    fi
    new_head=$(git_in_ws rev-parse HEAD)
    local err=/tmp/train-push-$num.err
    if ! ggit push origin "HEAD:refs/heads/$branch" 2>"$err"; then
      release "$num" "train push 失败：$(head -c 200 "$err")"
      rm -f "$err"
      return
    fi
    rm -f "$err"
    note "PR #$num: pushed 组合树 ${new_head:0:7}（main ${main_now:0:7} → $branch），等待 $CHECK_NAME check"
  else
    note "PR #$num: head ${head:0:7} 已包含 main ${main_now:0:7}，验证现有 check"
    # head 可能从无真实 check：push 早于 ci:remote label 时，synchronize 触发的
    # ci run 被 ci.yml 的 if 条件跳过（只剩 skipped 占位）；之后 train 用
    # GITHUB_TOKEN 补 label 也不会触发新 run——GITHUB_TOKEN 产生的事件不创建
    # workflow run（产出仓库实测：两轮各死等 45min 后被摘牌）。
    # 此时推空提交主动触发 synchronize→ci：train 的 push 能触发远端 run
    # （产出仓库实测：组合树 push 均产生了真实 ci run），等价于
    # 上面的组合树 push 路径。check_state=error（API 失败）不盲推，交给
    # wait_check_green 的既有错误路径处理。
    local c_state c_conclusion
    IFS=$'\t' read -r c_state c_conclusion < <(check_state "$head")
    if [ "$c_state" = "missing" ]; then
      if ! git_in_ws commit --allow-empty \
          -m "chore: trigger remote CI (merge-train): no real check existed on ${head:0:7}" \
        || ! ggit push origin "HEAD:refs/heads/$branch"; then
        release "$num" "train 空提交触发远端 CI 失败（commit/push）"
        return
      fi
      new_head=$(git_in_ws rev-parse HEAD)
      note "PR #$num: head ${head:0:7} 无真实 check，已推空提交 ${new_head:0:7} 触发远端 CI"
    fi
  fi

  if ! wait_check_green "$num" "$new_head"; then
    release "$num" "远端 CI 未在组合树 ${new_head:0:7} 上转绿（check 详情与你的 CI 日志目录最新 run）"
    return
  fi

  # 合并前复核：head 未变、PR 仍 open（防止 agent 推新提交/手工合并的竞态）
  local f_state f_head
  IFS=$'\t' read -r f_state f_head < <(pr_state "$num" | cut -f1,4)
  if [ "$f_state" != "open" ] || [ "$f_head" != "$new_head" ]; then
    release "$num" "head 在列车验证期间变化（${f_head:0:7} ≠ ${new_head:0:7}）或状态=$f_state；新 head 的 gate 全绿后重新打 ready-to-merge"
    return
  fi

  if gh pr merge "$num" -R "$REPO" --merge --delete-branch; then
    note "merged PR #$num（组合树 ${new_head:0:7} 已验证）"
  else
    note "PR #$num merge 命令失败（保留 label，下一轮重试）"
  fi
}

list_queue() {
  gh pr list -R "$REPO" --label ready-to-merge --state open \
    --json number --jq '.[].number' | sort -n
}

main() {
  git_in_ws config user.name "merge-train-bot"
  git_in_ws config user.email "train@invalid.invalid"

  local cycle queue prev_queue
  for cycle in $(seq 1 "$MAX_CYCLES"); do
    queue=$(list_queue)
    [ -z "$queue" ] && { note "队列为空"; break; }
    note "cycle $cycle: queue = $(echo "$queue" | tr '\n' ' ')"
    local num
    for num in $queue; do
      process "$num"
    done
    prev_queue=$queue
    queue=$(list_queue)
    if [ "$queue" = "$prev_queue" ] || [ -z "$queue" ]; then
      [ -n "$queue" ] && note "队列未变化，结束本轮（剩 ${queue//$'\n'/ }）"
      break
    fi
  done

  # 清理工作区里的临时 train 分支（不影响远端）
  git_in_ws branch --list 'train-*' | sed 's/^[* ]*//' | while read -r b; do
    git_in_ws branch -D "$b" >/dev/null 2>&1 || true
  done
  note "done"
}
main "$@"
