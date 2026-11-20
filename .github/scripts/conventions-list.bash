#!/usr/bin/env bash
# Lists the conventions in docs/conventions/ whose paths match a file the pull request changes.
#
# Usage: conventions-list.bash <base branch>
# Writes conventions=<JSON array of {name, slug}> to $GITHUB_OUTPUT and fails on a malformed convention file.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: conventions-list.bash <base branch>" >&2
  exit 2
fi
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must name the file the conventions output is appended to}"
base="$1"
matrix='[]'
for file in docs/conventions/*.md; do
  [ "$file" = docs/conventions/README.md ] && continue
  # Git glob pathspecs have no brace alternation, so a paths item with a brace would match nothing.
  if ! awk '
    NR == 1 { if ($0 != "---") bad = 1; next }
    NR == 2 { if ($0 != "paths:") bad = 1; next }
    !closed { if ($0 == "---") closed = 1; else if ($0 !~ /^  - "[^"]+"$/ || $0 ~ /[{}]/) bad = 1; next }
    /^```/ { fence = !fence; next }
    !fence && /^# / { h1++ }
    END { exit (bad || !closed || h1 != 1) }' "$file"; then
    printf 'Convention file %q is malformed: it needs frontmatter holding only double-quoted paths items without braces, and exactly one H1.\n' "$file"
    exit 1
  fi
  # The runner ends a line at a carriage return, so one in the name could start a workflow command.
  name="$(sed -n 's/^# //p' "$file" | head -n 1 | tr -d '\r')"
  # "glob" becomes ":(glob)glob" and "!glob" becomes ":(glob,exclude)glob".
  mapfile -t specs < <(sed -n '2,/^---$/s/^  - "\(.*\)"$/\1/p' "$file" | sed -e 's/^!\(.*\)$/:(glob,exclude)\1/' -e t -e 's/^/:(glob)/')
  # With no including glob, git would match every changed file outside the excludes.
  if ! printf '%s\n' "${specs[@]}" | grep -q '^:(glob)'; then
    printf 'Convention file %q has no including glob in its paths.\n' "$file"
    exit 1
  fi
  changed="$(git diff --name-only "origin/$base...HEAD" -- "${specs[@]}")"
  if [ -n "$changed" ]; then
    matrix="$(jq -c --arg name "$name" --arg slug "$(basename "$file" .md)" '. + [{name: $name, slug: $slug}]' <<< "$matrix")"
  else
    echo "::notice::Skipping convention $name: no changed file matches its paths"
  fi
done
echo "conventions=$matrix" >> "$GITHUB_OUTPUT"
