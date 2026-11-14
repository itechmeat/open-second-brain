#!/usr/bin/env bash
# Run the test suite with a wall-clock bound, and when the bound is hit,
# name what was still running before stopping it.
#
# Usage: test-watchdog.sh <seconds> <command> [args...]
#
# A test that blocks its process synchronously (a busy loop, or a runtime
# call that never returns) cannot be stopped by bun's per-test timeout (the
# timer runs on the blocked thread), and under
# `--parallel` the run then waits on that worker in silence until the job
# timeout cancels it, with nothing in the log that says which file it was.
# This wrapper:
#
#   1. points O2B_TEST_INFLIGHT_DIR at a fresh directory, where the test
#      preload (`tests/helpers/inflight-recorder.ts`) keeps one line per
#      test process: the file and the test number it is running;
#   2. runs the command in a session of its own (bun's `--parallel`
#      workers take process groups of their own, but stay in the session);
#   3. past <seconds>, prints those lines and the process tree of the
#      session (so a stuck `tar` or a worker blocked in a wait shows up),
#      stops every process of the session, and exits 124.
#
# The exit status is otherwise the command's own, so the gate is unchanged.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <seconds> <command> [args...]" >&2
  exit 2
fi
limit="$1"
shift
case "$limit" in
  '' | *[!0-9]*)
    echo "test-watchdog: the bound must be a whole number of seconds, got '$limit'" >&2
    exit 2
    ;;
esac

dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/test-inflight"
rm -rf "$dir"
mkdir -p "$dir" || echo "::warning::cannot create the in-flight record directory $dir" >&2
export O2B_TEST_INFLIGHT_DIR="$dir"

report() {
  echo "::error::the test suite was still running after ${limit}s; stopping it"
  echo "Test processes and what each was doing last (pid: state):"
  local found=0
  for record in "$dir"/*.txt; do
    [ -e "$record" ] || continue
    found=1
    local pid line
    pid="$(basename "$record" .txt)"
    line="$(cat "$record")"
    # Only processes still alive matter: a finished worker's last line is
    # history, not the hang.
    if kill -0 "$pid" 2>/dev/null; then
      case "$line" in
        running* | loading*) echo "::error::still running in pid $pid: $line" ;;
        *) echo "  pid $pid (alive): $line" ;;
      esac
    fi
  done
  [ "$found" = 1 ] || echo "  (no records: the preload never ran)"
  echo "Process tree of the run (session $pid_run):"
  ps -eo pid,ppid,sid,etimes,stat,wchan:32,args --forest \
    | awk -v s="$pid_run" 'NR == 1 || $3 == s'
}

session_pids() {
  ps -eo pid=,sid= | awk -v s="$pid_run" '$2 == s { print $1 }'
}

stop_session() {
  local pids
  pids="$(session_pids)"
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086 # one pid per word
  kill -TERM $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pids="$(session_pids)"
    [ -n "$pids" ] || return 0
    sleep 1
  done
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null
}

# A non-interactive shell does not make background jobs group leaders, so
# setsid starts the command as the leader of a new session without forking:
# $! is the command itself and its pid is the session id.
setsid "$@" &
pid_run=$!
# A cancelled step signals this shell only; pass it on to the session.
trap 'stop_session; exit 143' INT TERM

deadline=$((SECONDS + limit))
while kill -0 "$pid_run" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    report
    stop_session
    wait "$pid_run" 2>/dev/null
    exit 124
  fi
  sleep 5
done
wait "$pid_run"
