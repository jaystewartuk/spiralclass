#!/bin/bash
# PostToolUse(Edit|Write) — format the one file that just changed.
#
# WHY. `format` is the first step of the gate and the cheapest one to fail, but
# it fails at PUSH time — after the commit is built, in a hook that deliberately
# CHECKS rather than fixes (a `pnpm format` there would rewrite the tree after
# the commit was made, leaving the fix unstaged while the push still carried the
# unformatted commit). So a stray blank line costs a full gate re-run and a
# second commit, minutes after the edit that caused it.
#
# Formatting the single file at the moment it is written costs a few hundred
# milliseconds and removes that class of failure entirely. It is the same
# prettier, with the same config and the same .prettierignore, so it can only
# agree with the gate.
#
# `--ignore-unknown` makes an unsupported extension a no-op rather than an
# error, and every failure path exits 0: a formatter that breaks the session is
# worse than an unformatted file the gate will catch anyway.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

file_path="$(
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        process.stdout.write(JSON.parse(s).tool_input?.file_path ?? "");
      } catch {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null
)" || exit 0

[[ -z "$file_path" || ! -f "$file_path" ]] && exit 0

# Only files inside this checkout. A scratchpad file elsewhere is not ours to
# reformat, and prettier would resolve the wrong config for it.
case "$file_path" in
"$PWD"/*) ;;
*) exit 0 ;;
esac

pnpm exec prettier --write --ignore-unknown --log-level warn "$file_path" >/dev/null 2>&1

exit 0
