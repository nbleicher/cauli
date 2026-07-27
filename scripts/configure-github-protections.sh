#!/usr/bin/env bash
set -euo pipefail

repository="${1:?usage: configure-github-protections.sh OWNER/REPOSITORY [BRANCH]}"
branch="${2:-main}"

visibility="$(gh repo view "$repository" --json visibility --jq .visibility)"
if [[ "$visibility" != "PUBLIC" ]]; then
  echo "Refusing to configure public-repository protections while $repository is $visibility." >&2
  echo "Complete runbook H24 through the public-visibility approval first." >&2
  exit 1
fi

gh api --method PUT "repos/$repository/vulnerability-alerts" >/dev/null
gh api --method PUT "repos/$repository/private-vulnerability-reporting" >/dev/null

jq -n '{
  security_and_analysis: {
    advanced_security: {status: "enabled"},
    secret_scanning: {status: "enabled"},
    secret_scanning_push_protection: {status: "enabled"}
  },
  delete_branch_on_merge: true
}' | gh api --method PATCH "repos/$repository" --input - >/dev/null

jq -n '{
  required_status_checks: {
    strict: true,
    contexts: ["verify", "secret-scan"]
  },
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
  required_linear_history: false,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: false,
  lock_branch: false,
  allow_fork_syncing: false
}' | gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  "repos/$repository/branches/$branch/protection" \
  --input - >/dev/null

echo "Configured dependency alerts, private reporting, secret scanning, push protection,"
echo "and required non-bypassable checks for $repository:$branch."
