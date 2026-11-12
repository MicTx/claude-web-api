#!/usr/bin/env bash
# The Release builder embeds the verified installer below. This development copy refuses consumption.
set +x
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js >=22 is required; install it before running this installer.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  printf '%s\n' 'Node.js >=22 is required.' >&2
  exit 1
fi
# ccw:bundled-release-installer
printf '%s\n' 'Use install.sh from a verified Release, not the development worktree.' >&2
exit 64
