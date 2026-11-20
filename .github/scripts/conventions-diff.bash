#!/usr/bin/env bash
# Prints the pull request's diff with line numbers for the reviewer.
#
# Usage: conventions-diff.bash <base branch>
# Each added or context line gets its line number in the head revision in front, so the reviewer need not look it up.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: conventions-diff.bash <base branch>" >&2
  exit 2
fi

git diff "origin/$1...HEAD" | awk '
  /^diff --git /{print; inhunk=0; next}
  /^@@ /{split($3, head, ","); n=substr(head[1], 2)+0; inhunk=1; print; next}
  !inhunk{print; next}
  /^-/{printf "      %s\n", $0; next}
  /^\\/{print; next}
  {printf "%5d %s\n", n, $0; n++}'
