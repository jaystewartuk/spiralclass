#!/usr/bin/env bash
# THE ONLY FILE IN THIS REPOSITORY THAT RUNS THE INFISICAL CLI. [D-169]
#
# Source it, then call one of four verbs:
#
#   infisical_secrets <env> KEY...        named secrets  → dotenv on stdout
#   infisical_env [--json] <env> [path…]  whole paths    → dotenv/json on stdout
#   infisical_exec <env> -- cmd…          inject and EXEC (replaces the process)
#   infisical_put <env> KEY=VALUE...      write
#
# WHY THIS EXISTS. Ten call sites implemented four operations five different
# ways, and each learned the same lessons separately — so not all of them
# learned all of them. Two guards below were each present in exactly one of the
# five:
#
#   * An empty result is an ERROR, never an empty export. Falling through to a
#     bare `export` on a failed fetch dumps the whole shell environment, and
#     leaked OPENAI_API_KEY into a terminal and a chat transcript the first time
#     a script here shipped with a bad flag.
#   * The environment name is a CLOSED LIST. A typo makes `infisical run`
#     inject nothing and the command then runs against whatever DATABASE_URL is
#     ambient — on a developer machine, the one environment nobody intended to
#     touch.
#
# And one that was in none of them: `infisical_secrets` proves every key the
# caller NAMED came back, because a fetch that quietly returns fewer secrets
# than asked for looks exactly like one that worked.
#
# ⚠️ THIS FILE SETS NO SHELL OPTIONS. A sourced library that turns on `set -e`
# changes the behaviour of every line its caller runs afterwards. Each verb
# returns non-zero instead.
#
# ⚠️ NOTHING REACHES THE DISK. Values go to stdout or into a process
# environment. stderr carries progress, stdout carries values only, so a caller
# can always pipe safely.

# shellcheck source=./project-id.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/project-id.sh"

_INFISICAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_INFISICAL_PROJECT_CACHE=""

# Resolved and VERIFIED lazily, then memoised: sourcing this file must never
# fail a caller's shell, and the check is worth running before the first fetch
# rather than at import time.
_infisical_project() {
  if [ -n "$_INFISICAL_PROJECT_CACHE" ]; then
    printf '%s\n' "$_INFISICAL_PROJECT_CACHE"; return 0
  fi
  command -v infisical >/dev/null || {
    echo "install the Infisical CLI: https://infisical.com/docs/cli/overview" >&2
    return 1
  }
  _INFISICAL_PROJECT_CACHE="$(infisical_project_id)" || return 1
  printf '%s\n' "$_INFISICAL_PROJECT_CACHE"
}

_infisical_check_env() {
  case "${1:-}" in
    preview | production) return 0 ;;
  esac
  echo "unknown environment '${1:-}' (expected: preview, production)" >&2
  return 1
}

# Named secrets. ⚠️ `secrets get` spells its format flag `--output`, where
# `export` spells it `--format` — the two subcommands genuinely differ.
#
#   infisical_secrets [--path=/config] [--plain] <env> KEY...
#
# --plain emits the bare value and takes exactly one key, for the callers that
# would otherwise strip `KEY=` off a dotenv line themselves.
infisical_secrets() {
  local path="/" plain=0
  while :; do
    case "${1:-}" in
      --path=*) path="${1#--path=}"; shift ;;
      --plain)  plain=1; shift ;;
      *) break ;;
    esac
  done
  local env="${1:-}"; shift 2>/dev/null || true
  _infisical_check_env "$env" || return 1
  [ "$#" -gt 0 ] || { echo "infisical_secrets: no secret names given" >&2; return 1; }
  if [ "$plain" = 1 ] && [ "$#" -ne 1 ]; then
    echo "infisical_secrets --plain takes exactly one key, got $#" >&2; return 1
  fi

  local proj out key
  proj="$(_infisical_project)" || return 1
  out="$(infisical secrets get "$@" --projectId="$proj" --env="$env" --path "$path" --output dotenv)" || return 1
  [ -n "$out" ] || {
    echo "infisical returned nothing for $* (env=$env) — refusing rather than risk an empty export" >&2
    return 1
  }
  # Every key the caller named, or none of them.
  for key in "$@"; do
    printf '%s\n' "$out" | grep -q "^${key}=" || {
      echo "infisical returned no value for ${key} (env=$env path=$path) — refusing a partial fetch" >&2
      return 1
    }
  done
  if [ "$plain" = 1 ]; then
    printf '%s\n' "$out" | sed -n "s/^${1}=//p"
  else
    printf '%s\n' "$out"
  fi
}

# Whole paths, emitted IN THE ORDER GIVEN — later paths win when a caller
# concatenates, which is why `/config` is passed last where it matters.
infisical_env() {
  local fmt="dotenv"
  if [ "${1:-}" = "--json" ]; then fmt="json"; shift; fi
  local env="${1:-}"; shift 2>/dev/null || true
  _infisical_check_env "$env" || return 1

  local proj out all="" path
  proj="$(_infisical_project)" || return 1
  [ "$#" -gt 0 ] || set -- /
  for path in "$@"; do
    out="$(infisical export --projectId="$proj" --env="$env" --path="$path" --format="$fmt")" || return 1
    all="${all}${out}"$'\n'
  done
  printf '%s' "$all" | grep -q '[^[:space:]]' || {
    echo "infisical returned nothing for env=$env paths=$* — refusing rather than report an empty environment" >&2
    return 1
  }
  printf '%s' "$all"
}

# ⚠️ REPLACES THE CURRENT PROCESS. Only an executed script should call this;
# from an interactive shell it would replace that shell.
infisical_exec() {
  local env="${1:-}"; shift 2>/dev/null || true
  _infisical_check_env "$env" || return 1
  [ "${1:-}" = "--" ] && shift
  [ "$#" -gt 0 ] || { echo "infisical_exec: no command given" >&2; return 1; }

  local proj
  proj="$(_infisical_project)" || return 1
  # --recursive is load-bearing: `/config` holds what is public by construction
  # and `/` holds the rest, and without it only `/` is injected.
  exec infisical run --projectId="$proj" --env="$env" --recursive -- "$@"
}

# ⚠️ THE ONE CALL THE PROJECT GUARD CANNOT FULLY COVER. `infisical secrets set`
# takes no project flag at all, so the project can only be selected by cwd. The
# guard still runs — it resolves through the same order the CLI's own upward
# search will — but this is a matching input, not a passed argument. Said out
# loud rather than papered over.
infisical_put() {
  local env="${1:-}"; shift 2>/dev/null || true
  _infisical_check_env "$env" || return 1
  [ "$#" -gt 0 ] || { echo "infisical_put: nothing to set" >&2; return 1; }

  _infisical_project >/dev/null || return 1
  ( cd "$_INFISICAL_DIR" && infisical secrets set "$@" --env="$env" )
}
