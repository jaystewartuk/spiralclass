#!/bin/bash
# PreToolUse(Bash) — the rules that must not depend on a model remembering them.
#
# WHY THIS EXISTS, GIVEN .claude/settings.json ALREADY HAS A DENY LIST.
# A permission rule matches a command PREFIX. That covers `pnpm promote` and
# `gh pr merge` well, and covers the two shapes that actually matter here not at
# all:
#
#   SKIP_GATE=1 git push        an environment assignment in front of the command
#   git push --no-verify        a flag in the middle of one
#
# Both are the gate bypass CLAUDE.md forbids, and both are exactly what a model
# reaches for when a push looks stuck — which, on this machine, it usually is,
# because the gate queues on a lock shared with every other worktree. The cost of
# guessing wrong is red code leaving the machine and a pull request that cannot
# merge, so the rule is enforced here where the whole command line is visible.
#
# It also covers reads of the credential-bearing files, which the `Read` deny
# rules cannot: `cat config/env/production.local.env` is a Bash call, not a Read.
#
# CONTRACT. stdin is the hook payload as JSON. Exit 0 to allow, exit 2 to block
# with the reason on stderr. Anything else is treated as a non-blocking error, so
# every failure path below FAILS OPEN on purpose — a guard that breaks the
# session when `node` is briefly unavailable is a guard that gets removed.
set -uo pipefail

# Extract the command properly rather than grepping the raw payload: a session
# that runs `grep -rn "pnpm promote" docs/` is asking a question, not deploying,
# and a guard that cannot tell the difference trains people to work around it.
command_line="$(
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        process.stdout.write(JSON.parse(s).tool_input?.command ?? "");
      } catch {
        process.stdout.write("");
      }
    });
  ' 2>/dev/null
)" || exit 0

[[ -z "$command_line" ]] && exit 0

block() {
  echo "BLOCKED by .claude/hooks/guard-bash.sh: $1" >&2
  echo "" >&2
  echo "$2" >&2
  exit 2
}

# ── Credential-bearing files ─────────────────────────────────────────────────
# FIRST, and before the read-only exemption below. This check was written after
# it, and putting it second was a real hole for exactly as long as it took to
# run the hook against `cat config/env/production.local.env`: the exemption saw
# a `cat` and allowed it. Reading a secret IS a read, so an exemption for
# readers has to come after the rule about what may not be read.
if [[ "$command_line" =~ (config/env/[^[:space:]]*\.local\.env|/\.env($|[[:space:]])|[[:space:]]\.env($|[[:space:]])|terraform\.tfvars|backend\.hcl|apps/web/\.auth/) ]]; then
  block "That file holds real credentials or a real session." \
    "The committed, non-secret templates are the ones to read: apps/web/.env.example,
config/env/*.env, and the *.example files under infra/."
fi

# A command that only READS is never blocked for what it happens to CONTAIN.
# This is what keeps `grep -rn "fly deploy" docs/` working — a session asking a
# question about the deploy path is not deploying, and a guard that cannot tell
# the difference is one people learn to work around.
if [[ "$command_line" =~ ^[[:space:]]*(grep|rg|ag|cat|head|tail|less|wc|find|ls|file|git[[:space:]]+grep)[[:space:]] ]]; then
  exit 0
fi

# ── The gate bypasses ────────────────────────────────────────────────────────
if [[ "$command_line" == *SKIP_GATE* ]]; then
  block "SKIP_GATE bypasses the pre-push gate." \
    "Red code must not leave the machine. If the push looks stuck it is queuing on the
machine lock and says so — wait, or run 'pnpm gate:lock' to see who holds it. If the
gate is red, fix it and report what failed."
fi

if [[ "$command_line" =~ (git[[:space:]]+push|git[[:space:]]+commit).*(--no-verify|[[:space:]]-n[[:space:]]|[[:space:]]-n$) ]]; then
  block "--no-verify skips the hook that IS the gate (D-119)." \
    "The pre-push hook is what posts the 'local-gate' status branch protection requires.
A push without it leaves a pull request that cannot merge."
fi

if [[ "$command_line" =~ git[[:space:]]+push.*(--force([[:space:]]|=|$)|[[:space:]]-f([[:space:]]|$)) ]]; then
  block "A force-push rewrites a branch other sessions and the gate may be reading." \
    "Use '--force-with-lease' deliberately and with the operator's say-so, or rebase and
push normally."
fi

# ── The operator's decisions, not a session's ────────────────────────────────
if [[ "$command_line" =~ (^|[[:space:]&|;])(pnpm[[:space:]]+promote|gh[[:space:]]+pr[[:space:]]+merge) ]]; then
  block "Merging and promoting are the operator's call, taken per change." \
    "A session's job ends at an open, green pull request ('pnpm pr'). Timing matters here:
CLAUDE.md forbids risky-path merges during lesson hours, and a promote fast-forwards
'production' and triggers a real deploy."
fi

if [[ "$command_line" == *fly-deploy.sh* ]] || [[ "$command_line" =~ (^|[[:space:]&|;])fly[[:space:]]+(deploy|secrets|ssh) ]]; then
  block "This deploys to, or reads secrets from, a live Fly app." \
    "Production only ever ships through 'pnpm promote', run by the operator."
fi

if [[ "$command_line" == *migrate:prod* ]] || [[ "$command_line" == *migrate:preview* ]]; then
  block "This runs migrations against a shared database." \
    "Production migrations run inside the deploy, behind a Neon checkpoint (D-95).
Locally, use 'pnpm --filter spiralclass-web prisma:migrate'."
fi

if [[ "$command_line" =~ (^|[[:space:]&|;])infisical([[:space:]]|$) ]] || [[ "$command_line" == *infra/infisical/run.sh* ]]; then
  block "Infisical hands out real credentials for a live environment." \
    "Local work runs from config/env/*.env and needs none of them."
fi

# ── The shared stash stack ───────────────────────────────────────────────────
# Several worktrees share one stash stack, so a bare pop can take another
# session's work. This is a warning, not a block: exit 0 still allows it.
if [[ "$command_line" =~ git[[:space:]]+stash([[:space:]]+(pop|apply))?([[:space:]]*$|[[:space:]]-) ]]; then
  echo "note: the stash stack is shared with every other worktree on this machine." >&2
  echo "      Prefer a WIP commit; if you must stash, use 'git stash push -u -m <tag>'" >&2
  echo "      and recover with 'git stash apply <sha>' rather than a bare pop." >&2
fi

exit 0
