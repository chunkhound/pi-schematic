#!/usr/bin/env bash
# Reports a convention's verdicts as error annotations and fails unless they are complete and free of violations.
#
# Usage: conventions-report.bash <slug> <name> <verdict file>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: conventions-report.bash <slug> <name> <verdict file>" >&2
  exit 2
fi
slug="$1"
name="$2"
verdict="$3"
convention="docs/conventions/$slug.md"
for file in "$convention" "$verdict"; do
  if [ ! -r "$file" ]; then
    echo "conventions-report.bash: cannot read $file" >&2
    exit 2
  fi
done

# The schema checks each verdict's shape, not that every statement sentence has one. The statement is the
# text after the H1 up to a Why: or Tooling: paragraph; a sentence ends at a full stop outside backticks
# that whitespace or the end of the statement follows.
sentences="$(awk '
  /^# / && !seen { seen = 1; paragraph_start = 1; next }
  !seen { next }
  /^[ \t\r]*$/ { paragraph_start = 1; next }
  paragraph_start && /^(Why|Tooling):/ { exit }
  { paragraph_start = 0; text = text " " $0 }
  END {
    gsub(/[ \t\r]+/, " ", text); sub(/^ /, "", text); sub(/ $/, "", text)
    length_of_text = length(text); start = 1; code = 0
    for (i = 1; i <= length_of_text; i++) {
      character = substr(text, i, 1)
      if (character == "`") code = !code
      else if (character == "." && !code && (i == length_of_text || substr(text, i + 1, 1) == " ")) {
        sentence = substr(text, start, i - start + 1); sub(/^ /, "", sentence); print sentence; start = i + 1
      }
    }
    sentence = substr(text, start); sub(/^ /, "", sentence); if (sentence != "") print sentence
  }' "$convention")"

# A violation without a file, such as a missing entry, is reported at the convention it breaks.
annotations="$(jq -r --arg sentences "$sentences" --arg convention "$convention" --arg name "$name" '
  def data: gsub("%"; "%25") | gsub("\r"; "%0D") | gsub("\n"; "%0A");
  def property: data | gsub(":"; "%3A") | gsub(","; "%2C");
  ( .results[] | select(.verdict == "violation")
    | [ "file=\(.file // $convention | property)",
        (if .file and .line then "line=\(.line)" else empty end),
        "title=\($name | property)" ] as $properties
    | "::error \($properties | join(","))::\(.sentence + "\nReason: " + .reason + (if .quote then "\nQuote: " + .quote else "" end) | data)" ),
  ( ($sentences | split("\n") | map(select(. != ""))) as $expected
    | [.results[].sentence | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "")] as $given
    | ($expected - $given) as $missing
    | ($given - $expected) as $unexpected
    | select(($expected | length) == 0 or ($given | length) != ($expected | length) or ($missing | length) > 0 or ($unexpected | length) > 0)
    | [ "The verdicts must cover each statement sentence once: \($expected | length) sentences, \($given | length) verdicts." ]
      + ($missing | map("Missing: " + .)) + ($unexpected | map("Unexpected: " + .))
    | "::error file=\($convention | property),title=\($name | property)::\(join("\n") | data)" )
' "$verdict")"

if [ -n "$annotations" ]; then
  printf '%s\n' "$annotations"
  exit 1
fi
