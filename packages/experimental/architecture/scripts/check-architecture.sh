#!/bin/sh
# Refuse architecture-source changes made outside the main branch's primary checkout.
#
# Usage:
#   check-architecture.sh [--main-branch <branch>] [--manifest <path>] staged
#   check-architecture.sh [--main-branch <branch>] [--manifest <path>] working
#   check-architecture.sh [--main-branch <branch>] [--manifest <path>] range <base> <head>
#
# The repository is jj when the nearest enclosing `.jj` or `.git` directory is
# `.jj`, so a colocated repository is checked through jj; otherwise it is git.
# The main branch is the manifest's top-level `mainBranch:` scalar, a git branch
# or a jj bookmark; --main-branch names it for a manifest that declares none.
# Without either, `staged` and `working` refuse every architecture-source
# change, because no branch may make it.
#
# `staged` (git) checks the index of the current checkout, for a pre-commit hook.
# It fails when a staged path is the manifest or matches a manifest source, and
# the checkout is a linked worktree or is not on <branch>.
# `working` (jj) checks the changes from the fork point of <branch> and `@-` to
# the working-copy commit `@`. It fails when one of them is the manifest or
# matches a source, and the workspace is not the primary one or neither `@` nor
# `@-` carries the <branch> bookmark.
# `range` checks the commits in <base>...<head>, for CI on a branch that is not
# <branch>. It fails when any of those commits changes the manifest or a source.
# In a jj repository <base> and <head> are revsets naming one commit each.
#
# The manifest is read from the working tree in `staged` and `working` mode and
# from <head> in `range` mode. Only YAML block lists under `sources:` and
# `exclude:`, and a plain `mainBranch:` scalar, are read; any other non-comment
# line fails the check, so a manifest this script cannot read never passes silently. The local architecture
# directory is not checked: the architecture service writes Ruling records there
# from every branch, and whether it is tracked is the user's choice.
#
# Exit status: 0 when no violation, 1 on a violation, 2 on a usage or manifest error.
set -eu

usage() {
  echo "usage: check-architecture.sh [--main-branch <branch>] [--manifest <path>] (staged | working | range <base> <head>)" >&2
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

# The manifest's branch line, when present, overrides --main-branch.
declared=$(printf '%s\n' "$pathspecs" | sed -n 's/^branch://p')
[ -z "$declared" ] || main_branch=$declared

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
  bookmark="bookmarks(exact:$(jj_quote "${main_branch:-}"))"
  if [ "$mode" = working ]; then
    changed=$(jj_run diff --name-only --from "fork_point($bookmark | @-)" --to @ -- "$fileset" 2>/dev/null) || exit 2
    [ -n "$changed" ] || exit 0
    if [ -f .jj/repo ]; then
      where="a secondary workspace"
    elif [ -z "$main_branch" ]; then
      echo "check-architecture: $manifest declares no mainBranch and --main-branch is not given, so no bookmark may change architecture sources; the working copy changes:" >&2
      printf '%s\n' "$changed" | sed 's/^/  /' >&2
      exit 1
    elif [ -z "$(jj_run log --ignore-working-copy --no-graph -r "$bookmark & (@ | @-)" -T 'commit_id ++ "\n"')" ]; then
      where="a working copy that is neither $main_branch nor its child"
    else
      exit 0
    fi
    echo "check-architecture: architecture sources change only on bookmark $main_branch in the primary workspace; this is $where, and it changes:" >&2
  else
    jj_run log --ignore-working-copy --no-graph -r "$base" -T 'commit_id ++ "\n"' >/dev/null || exit 2
    changed=$(jj_run diff --ignore-working-copy --name-only --from "fork_point(($base) | ($head))" --to "$head" -- "$fileset" 2>/dev/null) || exit 2
    [ -n "$changed" ] || exit 0
    echo "check-architecture: architecture sources change only on ${main_branch:-the main bookmark the manifest declares}; $base...$head changes:" >&2
  fi
  printf '%s\n' "$changed" | sed 's/^/  /' >&2
  exit 1
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
  changed=$(git diff --cached --name-only --no-renames -- "$@")
  [ -n "$changed" ] || exit 0
  branch=$(git symbolic-ref --quiet --short HEAD || true)
  if [ "$(git rev-parse --git-dir)" != "$(git rev-parse --git-common-dir)" ]; then
    where="a linked worktree"
  elif [ -z "$main_branch" ]; then
    echo "check-architecture: $manifest declares no mainBranch and --main-branch is not given, so no branch may change architecture sources; this commit changes:" >&2
    printf '%s\n' "$changed" | sed 's/^/  /' >&2
    exit 1
  elif [ "$branch" != "$main_branch" ]; then
    where="branch ${branch:-(detached HEAD)}"
  else
    exit 0
  fi
  echo "check-architecture: architecture sources change only on $main_branch in the primary worktree; this commit is on $where and changes:" >&2
else
  changed=$(git diff --name-only --no-renames "$base...$head" -- "$@")
  [ -n "$changed" ] || exit 0
  echo "check-architecture: architecture sources change only on ${main_branch:-the main branch the manifest declares}; $base...$head changes:" >&2
fi
printf '%s\n' "$changed" | sed 's/^/  /' >&2
exit 1
