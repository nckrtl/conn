#!/usr/bin/env bash
# Wait for the canonical results that after-CI publishes on the tested push.
set -euo pipefail
sha=${1:?commit required}
[[ $sha =~ ^[0-9a-f]{40}$ ]]
attempts=${2:-60}
[[ $attempts =~ ^[1-9][0-9]*$ ]]
for ((attempt=1; attempt<=attempts; attempt++)); do
  checks=$(gh api --paginate --slurp "repos/nckrtl/conn/commits/$sha/check-runs?per_page=100&filter=all")
  result=$(jq -r --arg sha "$sha" '
    [.[].check_runs[] | select(.head_sha == $sha and .app.slug == "github-actions")] as $runs |
    [ ["Conn Server checks","checks"], ["Linux musl release build","musl"] ] |
    map(. as [$name,$gate] | [$runs[] | select(.name == $name and
        ((.external_id // "") | test("^conn-server-after-ci:[0-9]+:" + $gate + "$")))] |
        max_by(.id) | .conclusion // "pending") | join(" ")' <<<"$checks")
  echo "$sha: $result"
  [[ $result == 'success success' ]] && exit 0
  [[ $result =~ ^(pending|success)\ (pending|success)$ ]] || exit 1
  if ((attempt < attempts)); then sleep 30; fi
done
exit 1
