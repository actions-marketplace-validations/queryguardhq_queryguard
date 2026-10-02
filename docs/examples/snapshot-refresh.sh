#!/bin/sh
# Example: refresh the production snapshot from a bastion (cron or a systemd timer) and propose it
# as a pull request. The same guard rails as snapshot-refresh.yml apply: only this machine holds
# the read-only production credentials, the PR check never does, and every refresh is reviewed.
#
# Needs: git with push access to the repository, the GitHub CLI (gh) logged in, Node.js 20+,
# a pg_dump at least as new as the server, and the libpq environment for the read-only role,
# e.g. in ~/.pgpass plus PGHOST/PGDATABASE/PGUSER/PGSSLMODE=verify-full in the service unit.
#
#   0 6 * * 1  cd /srv/app-repo && ./docs/examples/snapshot-refresh.sh >> /var/log/queryguard-snapshot.log 2>&1
set -eu

QUERYGUARD="npx --yes @queryguardhq/queryguard@1.4.0"   # pin an exact version
branch=queryguard/snapshot-refresh

git fetch origin
git switch -C "$branch" "origin/$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"

set +e
$QUERYGUARD snapshot --label production --sample-window 5m
code=$?
set -e
# 0 COMPLETE, 2 PARTIAL (still proposed; the reasons are in the PR), 1 failed (nothing written).
[ "$code" -eq 1 ] && exit 1

git add .queryguard/snapshot
if git diff --cached --quiet; then
  echo "Snapshot unchanged."
  exit 0
fi
git commit -m "chore: refresh production snapshot ($(date -u +%F))"
git push --force origin "$branch"

body=$(mktemp)
{
  echo '`queryguard snapshot inspect` for this refresh. Review checklist: docs/snapshot-security.md.'
  echo
  echo '```'
  $QUERYGUARD snapshot inspect .queryguard/snapshot || true
  echo '```'
} > "$body"
gh pr create --head "$branch" --title 'Refresh production snapshot' --body-file "$body" \
  || gh pr edit "$branch" --body-file "$body"
rm -f "$body"
