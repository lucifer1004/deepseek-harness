#!/bin/sh
# Refuse architecture-source changes made outside the main branch's primary worktree.
#
# Usage:
#   check-architecture.sh --main-branch <branch> [--manifest <path>] staged
#   check-architecture.sh --main-branch <branch> [--manifest <path>] range <base> <head>
#
# `staged` checks the index of the current checkout, for a pre-commit hook. It
# fails when a staged path is the manifest or matches a manifest source, and the
# checkout is a linked worktree or is not on <branch>.
# `range` checks the commits in <base>..<head>, for CI on a branch that is not
# <branch>. It fails when any of those commits changes the manifest or a source.
#
# The manifest is read with git from the checkout's working tree in `staged` mode
# and from <head> in `range` mode. Only YAML block lists under `sources:` and
# `exclude:` are read; any other non-comment line fails the check, so a manifest
# this script cannot read never passes silently. The local architecture
# directory is not checked: the architecture service writes Ruling records there
# from every branch, and whether it is tracked is the user's choice.
#
# Exit status: 0 when no violation, 1 on a violation, 2 on a usage or manifest error.
set -eu

usage() {
  echo "usage: check-architecture.sh --main-branch <branch> [--manifest <path>] (staged | range <base> <head>)" >&2
  exit 2
}

main_branch=''
manifest='architecture.yml'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --main-branch) [ "$#" -ge 2 ] || usage; main_branch=$2; shift 2 ;;
    --manifest) [ "$#" -ge 2 ] || usage; manifest=$2; shift 2 ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ -n "$main_branch" ] || usage
[ "$#" -ge 1 ] || usage
mode=$1
shift
case "$mode" in
  staged) [ "$#" -eq 0 ] || usage ;;
  range) [ "$#" -eq 2 ] || usage; base=$1; head=$2 ;;
  *) usage ;;
esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "check-architecture: not inside a git checkout" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)"

if [ "$mode" = staged ]; then
  if [ ! -f "$manifest" ]; then exit 0; fi
  manifest_text=$(cat "$manifest")
else
  if ! git cat-file -e "$head:$manifest" 2>/dev/null; then exit 0; fi
  manifest_text=$(git cat-file blob "$head:$manifest")
fi

# Emit one pathspec per line: `:(glob)<source>` and `:(exclude,glob)<pattern>`.
pathspecs=$(printf '%s\n' "$manifest_text" | awk -v manifest="$manifest" '
  function fail(message) { print "check-architecture: " manifest ":" NR ": " message > "/dev/stderr"; failed = 1; exit 2 }
  /^[[:space:]]*(#.*)?$/ { next }
  /^sources:[[:space:]]*(#.*)?$/ { list = "sources"; next }
  /^exclude:[[:space:]]*(#.*)?$/ { list = "exclude"; next }
  /^[[:space:]]+-[[:space:]]+/ {
    if (list == "") fail("list item outside sources or exclude")
    item = $0
    sub(/^[[:space:]]+-[[:space:]]+/, "", item)
    sub(/[[:space:]]+#.*$/, "", item)
    sub(/[[:space:]]+$/, "", item)
    if (item ~ /^".*"$/ || item ~ /^\047.*\047$/) item = substr(item, 2, length(item) - 2)
    if (item == "") fail("empty glob")
    if (list == "sources") { print ":(glob)" item; sources++ } else print ":(exclude,glob)" item
    next
  }
  { fail("unsupported manifest syntax; only block lists under sources and exclude are read") }
  END { if (!failed && sources == 0) fail("no sources") }
') || exit 2

# Pathspecs never contain newlines (each is one manifest list item), so a
# newline-separated list is split into arguments safely.
# Globbing is off so the shell passes each glob to git unexpanded.
set -f
old_ifs=$IFS
IFS='
'
# shellcheck disable=SC2086
set -- "$manifest" $pathspecs
IFS=$old_ifs
set +f

if [ "$mode" = staged ]; then
  changed=$(git diff --cached --name-only --no-renames -- "$@")
  [ -n "$changed" ] || exit 0
  branch=$(git symbolic-ref --quiet --short HEAD || true)
  if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
    where="a linked worktree"
  elif [ "$branch" != "$main_branch" ]; then
    where="branch ${branch:-(detached HEAD)}"
  else
    exit 0
  fi
  echo "check-architecture: architecture sources change only on $main_branch in the primary worktree; this commit is on $where and changes:" >&2
else
  changed=$(git diff --name-only --no-renames "$base...$head" -- "$@")
  [ -n "$changed" ] || exit 0
  echo "check-architecture: architecture sources change only on $main_branch; $base...$head changes:" >&2
fi
printf '%s\n' "$changed" | sed 's/^/  /' >&2
exit 1
