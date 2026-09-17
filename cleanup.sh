#!/bin/bash
# Safe branch-pruning helper (OPS-02).
#
# History: this script previously enumerated up to 100 repos for a hardcoded
# account, cleared descriptions, renamed default branches to "main", and
# deleted every non-main branch without merge checks or pagination.
# That account-administration behavior was removed: description clearing and
# default-branch renames are intentionally unsupported, branch listing is
# paginated, and deletions require an explicit repo allowlist plus --apply
# plus a merged-into-default check. Protected branches are never deleted.
#
# Usage:
#   cleanup.sh [--user USER] [--repo OWNER/REPO ...] [--apply]
#
#   No flags (discovery mode): read-only `gh repo list`, prints how to
#     allowlist targets. Performs zero mutations.
#   --repo OWNER/REPO (repeatable): restrict work to these repos. Without
#     --apply this is a dry run: prints what would be deleted.
#   --apply: actually delete merged, non-protected, non-default branches
#     in the allowlisted repos only. Never deletes unmerged branches.
#
# Safety contract (regression-tested with a fake `gh`):
#   - Default invocation performs no PATCH/POST/PUT/DELETE and no renames.
#   - Without --apply, no DELETE is issued.
#   - Without --repo, no per-branch DELETE is issued.
#   - Protected branches (main, master, dev, staging) and the repo's current
#     default branch are never deleted, even with --apply.
#   - Branches whose compare status against the default is not "identical"
#     or "behind" (i.e. ahead/diverged/unknown) are never deleted.
#
# Never run with real credentials to test it. Tests must use a fake `gh`
# executable that records arguments.
set -euo pipefail

USER="${GH_USER:-lnieuwenhuis}"
APPLY=0
REPOS=()

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--user USER] [--repo OWNER/REPO ...] [--apply]

Discovery (default): lists repos read-only, deletes nothing.
Prune (dry run):  cleanup.sh --repo OWNER/REPO [...]
Prune (apply):    cleanup.sh --repo OWNER/REPO [...] --apply
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --repo)
      if [ "$#" -lt 2 ]; then
        echo "error: --repo requires an OWNER/REPO argument" >&2
        usage >&2
        exit 2
      fi
      REPOS+=("$2")
      shift 2
      ;;
    --repo=*)
      REPOS+=("${1#--repo=}")
      shift
      ;;
    --user)
      if [ "$#" -lt 2 ]; then
        echo "error: --user requires an argument" >&2
        usage >&2
        exit 2
      fi
      USER="$2"
      shift 2
      ;;
    --user=*)
      USER="${1#--user=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

is_protected_branch() {
  case "$1" in
    main|master|dev|staging) return 0 ;;
    *) return 1 ;;
  esac
}

# Discovery mode: read-only listing only. No mutations by construction:
# this path contains no `gh api -X` mutating call.
if [ "${#REPOS[@]}" -eq 0 ]; then
  echo "Discovery mode for user '${USER}': listing repos (read-only, no mutations)."
  # Paginated-capable listing; read-only.
  gh repo list "$USER" --limit 1000 --json name -q '.[].name'
  echo "No --repo allowlist given: nothing to prune. Re-run with --repo OWNER/REPO [--apply]."
  echo "Without --apply this is a dry run. Protected branches (main, master, dev, staging) and each repo's default branch are never deleted."
  exit 0
fi

# Validate allowlist entries before any per-branch work.
for repo_full in "${REPOS[@]}"; do
  case "$repo_full" in
    */*/*|/*|*/)
      echo "error: invalid --repo '${repo_full}': expected OWNER/REPO" >&2
      exit 2
      ;;
    "$USER"/*)
      ;;
    *)
      echo "error: refusing --repo '${repo_full}': owner must be '${USER}' (override with --user)" >&2
      exit 2
      ;;
  esac
done

if [ "$APPLY" -eq 1 ]; then
  echo "APPLY mode: will delete only merged, non-protected, non-default branches in: ${REPOS[*]}"
else
  echo "Dry-run mode: no deletions will be performed. Add --apply to delete (merged branches only) in: ${REPOS[*]}"
fi

for repo_full in "${REPOS[@]}"; do
  echo "Processing ${repo_full}..."

  default_branch=""
  if ! default_branch="$(gh api "repos/${repo_full}" --jq '.default_branch')"; then
    echo "warning: could not read default branch for ${repo_full}; skipping repo" >&2
    echo "---"
    continue
  fi
  if [ -z "$default_branch" ]; then
    echo "warning: empty default branch for ${repo_full}; skipping repo" >&2
    echo "---"
    continue
  fi
  echo "Default branch for ${repo_full} is '${default_branch}' (never deleted)."

  branches=""
  if ! branches="$(gh api "repos/${repo_full}/branches --paginate --jq '.[].name'")"; then
    echo "warning: could not list branches for ${repo_full}; skipping repo" >&2
    echo "---"
    continue
  fi

  # Iterate line-wise so branch names with slashes survive.
  while IFS= read -r branch || [ -n "$branch" ]; do
    if [ -z "$branch" ]; then
      continue
    fi
    if [ "$branch" = "$default_branch" ]; then
      echo "skip '${branch}': current default branch"
      continue
    fi
    if is_protected_branch "$branch"; then
      echo "skip '${branch}': protected branch"
      continue
    fi

    compare_status=""
    if ! compare_status="$(gh api "repos/${repo_full}/compare/${default_branch}...${branch}" --jq '.status')"; then
      echo "skip '${branch}': could not verify merged status; refusing to delete"
      continue
    fi
    case "$compare_status" in
      identical|behind)
        ;;
      *)
        echo "skip '${branch}': not merged into '${default_branch}' (status: ${compare_status})"
        continue
        ;;
    esac

    if [ "$APPLY" -eq 0 ]; then
      echo "would delete '${branch}' in ${repo_full} (merged into '${default_branch}', dry run)"
      continue
    fi

    gh api "repos/${repo_full}/git/refs/heads/${branch}" -X DELETE && echo "deleted '${branch}' in ${repo_full}"
  done <<< "$branches"

  echo "---"
done
