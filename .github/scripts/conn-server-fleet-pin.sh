#!/usr/bin/env bash
set -euo pipefail

tag=${TAG:?}
[[ $tag =~ ^conn-server-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
branch="release/$tag"
orbit=hardimpactdev/orbit
conn=nckrtl/conn

pin_pr() {
  gh api --method GET "repos/$orbit/pulls" -f state=all -f base=main -f head="hardimpactdev:$branch" \
    --jq 'map(select(.user.login == "orbit-nckrtl[bot]")) | first // {}'
}

verify_app() {
  gh api /installation/repositories --jq '[.repositories[].full_name] | index("hardimpactdev/orbit") != null' | grep -qx true
  echo 'The GitHub App installation token can read hardimpactdev/orbit.'
}

case ${1:?} in
  verify-app)
    verify_app
    ;;
  propose)
    [[ ${SOURCE_SHA:?} =~ ^[a-f0-9]{40}$ ]]
    verify_app
    pr=$(pin_pr)
    git config user.name 'orbit-nckrtl[bot]'
    git config user.email '331678173+orbit-nckrtl[bot]@users.noreply.github.com'
    gh auth setup-git --hostname github.com
    git add -u
    git -c core.hooksPath=/dev/null commit -m "Pin $tag for Conn Server rollouts" -m "Conn-Source: $SOURCE_SHA"
    refs=$(git ls-remote --heads origin "refs/heads/$branch")
    if [[ -z "$refs" ]]; then
      jq -e 'length == 0' <<<"$pr" > /dev/null
      git push origin "HEAD:refs/heads/$branch"
    else
      history=()
      if [[ $(git rev-parse --is-shallow-repository) == true ]]; then
        history+=(--unshallow)
      fi
      existing="refs/remotes/origin/$branch"
      git fetch --no-tags "${history[@]}" origin "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$branch:$existing"
      git log -1 --format=%B "$existing" | grep -Fxq "Conn-Source: $SOURCE_SHA"
      base=$(git merge-base --all refs/remotes/origin/main "$existing")
      [[ "$base" != *$'\n'* ]]
      # GitHub's PR includes changes since the merge base, including earlier commits on the branch.
      existing_delta=$(git diff --raw --no-abbrev --no-renames "$base" "$existing")
      proposal_delta=$(git diff --raw --no-abbrev --no-renames HEAD^ HEAD)
      if [[ "$existing_delta" != "$proposal_delta" ]]; then
        echo '::error::The complete release branch diff does not match the generated pin proposal.' >&2
        exit 1
      fi
    fi
    if [[ $(jq -r '.html_url // empty' <<<"$pr") != '' ]]; then
      jq -e --arg sha "$SOURCE_SHA" '.body | contains("Conn-Source: " + $sha)' <<<"$pr" > /dev/null
      jq -er '.html_url' <<<"$pr" >> "$GITHUB_STEP_SUMMARY"
      jq -e '.state == "open" or .merged_at != null' <<<"$pr" > /dev/null
      exit
    fi

    # A successful create followed by a lost response is recovered by the next invocation.
    gh pr create --repo "$orbit" --base main --head "$branch" \
      --title "Pin $tag for Conn Server rollouts" --body-file "${PIN_BODY:?}" >> "$GITHUB_STEP_SUMMARY"
    ;;
  deadline)
    [[ ${PUBLISHED:?} =~ ^[0-9]+$ ]]
    deadline=$((PUBLISHED + 300))
    while (( $(date +%s) < deadline )); do
      pr=$(pin_pr)
      if [[ $(jq -r '.state' <<<"$pr") == open || $(jq -r '.merged_at' <<<"$pr") != null ]]; then
        exit 0
      fi
      sleep 10
    done

    pr=$(pin_pr)
    if jq -e --argjson deadline "$deadline" '
      (.state == "open" or .merged_at != null) and
      ((.created_at | fromdateiso8601) <= $deadline)
    ' <<<"$pr" > /dev/null; then
      exit 0
    fi
    title="Orbit pin PR missed its five-minute deadline for $tag"
    issues=$(gh api --paginate --slurp "repos/$conn/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100")
    existing=$(jq -r --arg title "$title" '[.[][] | select(.title == $title and .pull_request == null)] | first | .html_url // empty' <<<"$issues")
    if [[ -z "$existing" ]]; then
      printf '%s\n' "The Orbit pin PR was missing five minutes after [$tag](https://github.com/$conn/releases/tag/$tag) was published." \
        "" "@nckrtl Check the proposal job for the failure and retry it for this exact tag. Review and merge the pin through Orbit's merge queue." \
        "" "Run: https://github.com/$conn/actions/runs/${GITHUB_RUN_ID:?}" > "${RUNNER_TEMP:?}/conn-pin-alert.md"
      existing=$(gh issue create --repo "$conn" --title "$title" --assignee nckrtl --body-file "$RUNNER_TEMP/conn-pin-alert.md")
    fi
    echo "::error::Orbit pin PR missed its publication deadline. Owner alert: $existing"
    exit 1
    ;;
  *)
    exit 2
    ;;
esac
