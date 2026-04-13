#!/bin/bash
USER="lnieuwenhuis"

repos=$(gh repo list $USER --limit 100 --json name -q '.[].name')

for repo in $repos; do
  echo "Processing $repo..."
  
  # Clear the description
  gh api repos/$USER/$repo -X PATCH -f description="" && echo "✅ $repo description cleared"
  
  # Get the current default branch name
  default=$(gh api repos/$USER/$repo --jq '.default_branch')
  
  # If default is already main, skip branch rename
  if [ "$default" = "main" ]; then
    echo "✅ $repo already on main, skipping rename"
  else
    # Rename whatever the default branch is to main
    gh api repos/$USER/$repo/branches/$default/rename \
      -f new_name="main" && echo "✅ $repo renamed $default -> main"
  fi
  
  # Delete all non-main branches
  branches=$(gh api repos/$USER/$repo/branches --jq '.[].name' | grep -v "^main$")
  for branch in $branches; do
    gh api repos/$USER/$repo/git/refs/heads/$branch -X DELETE && echo "🗑️ deleted $branch"
  done
  
  echo "---"
done
