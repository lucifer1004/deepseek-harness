#!/bin/sh
# Refuse architecture-source changes made outside the primary checkout, and list
# the ones a commit range makes.
#
# Usage:
#   check-architecture.sh [--manifest <path>] staged
#   check-architecture.sh [--manifest <path>] working
#   check-architecture.sh [--manifest <path>] range <base> <head>
#
# The repository is jj when the nearest enclosing `.jj` or `.git` directory is
# `.jj`, so a colocated repository is checked through jj; otherwise it is git.
# Architecture sources change only in the primary checkout, on any branch: the
# primary git worktree, or the jj workspace that holds the repository.
#
# `staged` (git) checks the index of the current checkout, for a pre-commit hook.
# It fails when a staged path is the manifest or matches a manifest source, and
# the checkout is a linked worktree.
# `working` (jj) checks the changes of the working-copy commit `@` since its
# fork point with the manifest's `mainBranch` bookmark, or since `@-` when there
# is none. It fails when one of them is the manifest or matches a source, and
# the workspace is not the primary one.
# `range` lists the manifest and source paths the commits in <base>...<head>
# change, for review of a merge into the main branch, and does not fail on them.
# In a jj repository <base> and <head> are revsets naming one commit each.
#
# The manifest is read from the working tree in `staged` and `working` mode and
# from <head> in `range` mode. Only YAML block lists under `sources:` and
# `exclude:`, and a plain `mainBranch:` scalar, are read; any other non-comment
# line fails the check, so a manifest this script cannot read never passes silently. The local architecture
# directory is not checked: the architecture service writes Ruling records there
# from every checkout, and whether it is tracked is the user's choice.
#
# Exit status: 0 when no violation, 1 on a violation, 2 on a usage or manifest error.
set -eu

usage() {
  echo "usage: check-architecture.sh [--manifest <path>] (staged | working | range <base> <head>)" >&2
  exit 2
}

manifest='architecture.yml'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) [ "$#" -ge 2 ] || usage; manifest=$2; shift 2 ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ "$#" -ge 1 ] || usage
mode=$1
shift
case "$mode" in
  staged | working) [ "$#" -eq 0 ] || usage ;;
  range) [ "$#" -eq 2 ] || usage; base=$1; head=$2 ;;
  *) usage ;;
esac

vcs=''
dir=$(pwd -P)
while :; do
  if [ -d "$dir/.jj" ]; then vcs=jj; break; fi
  if [ -e "$dir/.git" ]; then vcs=git; break; fi
  [ "$dir" != / ] || break
  dir=$(dirname "$dir")
done
[ -n "$vcs" ] || { echo "check-architecture: not inside a git or jj checkout" >&2; exit 2; }

jj_run() { jj --no-pager --color=never "$@"; }
# A jj string literal: backslashes and double quotes escaped, then quoted.
jj_quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g')"; }

if [ "$vcs" = jj ]; then
  command -v jj >/dev/null 2>&1 || { echo "check-architecture: $dir is a jj repository, but jj is not installed" >&2; exit 2; }
  [ "$mode" != staged ] || { echo "check-architecture: jj has no staging area; run the working mode instead" >&2; exit 2; }
  cd "$dir"
else
  [ "$mode" != working ] || { echo "check-architecture: the working mode checks jj repositories; run the staged mode in git" >&2; exit 2; }
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "check-architecture: not inside a git checkout" >&2; exit 2; }
  cd "$(git rev-parse --show-toplevel)"
fi

if [ "$mode" != range ]; then
  if [ ! -f "$manifest" ]; then exit 0; fi
  manifest_text=$(cat "$manifest")
elif [ "$vcs" = jj ]; then
  # A missing path prints nothing and fails; a revset that is not one commit fails too, so check it first.
  jj_run log --ignore-working-copy --no-graph -r "$head" -T 'commit_id ++ "\n"' >/dev/null || exit 2
  manifest_text=$(jj_run file show --ignore-working-copy -r "$head" "root-file:$(jj_quote "$manifest")" 2>/dev/null) || exit 0
else
  if ! git cat-file -e "$head:$manifest" 2>/dev/null; then exit 0; fi
  manifest_text=$(git cat-file blob "$head:$manifest")
fi

# Emit one entry per line: `source:<glob>` and `exclude:<glob>`.
pathspecs=$(printf '%s\n' "$manifest_text" | awk -v manifest="$manifest" '
  function fail(message) { print "check-architecture: " manifest ":" NR ": " message > "/dev/stderr"; failed = 1; exit 2 }
  /^[[:space:]]*(#.*)?$/ { next }
  /^sources:[[:space:]]*(#.*)?$/ { list = "sources"; next }
  /^exclude:[[:space:]]*(#.*)?$/ { list = "exclude"; next }
  /^mainBranch:[[:space:]]*[^[:space:]#]/ {
    value = $0
    sub(/^mainBranch:[[:space:]]*/, "", value)
    sub(/[[:space:]]+#.*$/, "", value)
    sub(/[[:space:]]+$/, "", value)
    if (value ~ /^".*"$/ || value ~ /^\047.*\047$/) value = substr(value, 2, length(value) - 2)
    if (value == "" || value ~ /[[:space:]]/) fail("mainBranch must be one branch name")
    print "branch:" value
    list = ""
    next
  }
  /^[[:space:]]+-[[:space:]]+/ {
    if (list == "") fail("list item outside sources or exclude")
    item = $0
    sub(/^[[:space:]]+-[[:space:]]+/, "", item)
    sub(/[[:space:]]+#.*$/, "", item)
    sub(/[[:space:]]+$/, "", item)
    if (item ~ /^".*"$/ || item ~ /^\047.*\047$/) item = substr(item, 2, length(item) - 2)
    if (item == "") fail("empty glob")
    if (list == "sources") { print "source:" item; sources++ } else print "exclude:" item
    next
  }
  { fail("unsupported manifest syntax; only block lists under sources and exclude are read") }
  END { if (!failed && sources == 0) fail("no sources") }
') || exit 2

# The manifest's branch, when declared, is the base jj's `working` mode diffs from.
main_branch=$(printf '%s\n' "$pathspecs" | sed -n 's/^branch://p')

if [ "$vcs" = jj ]; then
  # One fileset: the manifest or any source, minus every exclude.
  fileset="root-file:$(jj_quote "$manifest")"
  excluded=''
  entries=$(printf '%s\n' "$pathspecs" | sed '/^branch:/d')
  while IFS= read -r entry; do
    glob="root-glob:$(jj_quote "${entry#*:}")"
    case "$entry" in
      source:*) fileset="$fileset | $glob" ;;
      exclude:*) excluded="$excluded | $glob" ;;
    esac
  done <<EOF
$entries
EOF
  [ -z "$excluded" ] || fileset="($fileset) ~ (${excluded# | })"
  if [ "$mode" = working ]; then
    # The primary workspace may change sources, so only a secondary one needs the diff.
    [ -f .jj/repo ] || exit 0
    bookmark="bookmarks(exact:$(jj_quote "$main_branch"))"
    changed=$(jj_run diff --name-only --from "fork_point($bookmark | @-)" --to @ -- "$fileset" 2>/dev/null) || exit 2
    [ -n "$changed" ] || exit 0
    echo "check-architecture: architecture sources change only in the primary workspace; this secondary workspace changes:" >&2
    printf '%s\n' "$changed" | sed 's/^/  /' >&2
    exit 1
  fi
  jj_run log --ignore-working-copy --no-graph -r "$base" -T 'commit_id ++ "\n"' >/dev/null || exit 2
  changed=$(jj_run diff --ignore-working-copy --name-only --from "fork_point(($base) | ($head))" --to "$head" -- "$fileset" 2>/dev/null) || exit 2
  [ -n "$changed" ] || exit 0
  echo "check-architecture: $base...$head changes architecture sources; review them before merging:"
  printf '%s\n' "$changed" | sed 's/^/  /'
  exit 0
fi

pathspecs=$(printf '%s\n' "$pathspecs" | sed -e '/^branch:/d' -e 's/^source:/:(glob)/' -e 's/^exclude:/:(exclude,glob)/')

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
  # The primary worktree may change sources, so only a linked one needs the diff.
  [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ] || exit 0
  changed=$(git diff --cached --name-only --no-renames -- "$@")
  [ -n "$changed" ] || exit 0
  echo "check-architecture: architecture sources change only in the primary worktree; this commit from a linked worktree changes:" >&2
  printf '%s\n' "$changed" | sed 's/^/  /' >&2
  exit 1
fi
changed=$(git diff --name-only --no-renames "$base...$head" -- "$@")
[ -n "$changed" ] || exit 0
echo "check-architecture: $base...$head changes architecture sources; review them before merging:"
printf '%s\n' "$changed" | sed 's/^/  /'
exit 0
