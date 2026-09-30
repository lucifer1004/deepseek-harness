#!/usr/bin/env bash
set -euo pipefail

# Install a pinned Jujutsu (jj) release on a Linux x86_64 runner, so the
# architecture package's jj tests and jj session snapshots run in CI instead of
# skipping. The musl build is static and needs no system packages.
readonly JJ_VERSION='0.45.1'
readonly JJ_SHA256='f35438350b5d61963aac5dd74ede510b31d6b9690769d1a6268cf058cc825f72'
readonly JJ_URL="https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz"

: "${RUNNER_TEMP:?prepare-ci-jj requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-jj requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-jj supports only Linux x86_64 runners' >&2
  exit 1
fi

archive="${RUNNER_TEMP}/jj-v${JJ_VERSION}.tar.gz"
root="${RUNNER_TEMP}/dsh-jj"

curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$JJ_URL"
printf '%s  %s\n' "$JJ_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$root"
tar -xzf "$archive" -C "$root" ./jj
printf '%s\n' "$root" >> "$GITHUB_PATH"
"$root/jj" --version
