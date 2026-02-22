#!/bin/bash
set -euo pipefail

# Preflight checks
if ! command -v git >/dev/null 2>&1; then
  echo "❌ git is required. Install git and re-run."
  exit 1
fi

NO_GH=0
if ! command -v gh >/dev/null 2>&1; then
  echo "⚠️ gh CLI not found; remote creation will be skipped unless you install gh."
  NO_GH=1
fi

if [ ! -f "plugin.json" ]; then
  echo "❌ Error: Run this script from inside the ai-session-flow directory."
  exit 1
fi

echo "📦 Initializing local Git repository..."
if [ ! -d .git ]; then
  if git init -b main >/dev/null 2>&1; then
    :
  else
    git init
    git branch -m main
  fi
fi

echo "➕ Staging files..."
git add .

echo "💾 Committing codebase..."
if ! git diff --cached --quiet; then
  git commit -m "Initial release: Secure AI CLI Session Sync"
else
  echo "ℹ️ No changes to commit."
fi

echo "🌐 Creating GitHub repository and pushing code..."
if [ "$NO_GH" -eq 1 ]; then
  echo "⚠️ Skipping remote creation because gh CLI is not available. To push manually: gh repo create <owner>/ai-session-flow --public --source=. --remote=origin --push"
else
  if git remote get-url origin >/dev/null 2>&1; then
    if [ "${AUTO_PUSH:-0}" = "1" ]; then
      git push -u origin main
    else
      echo "AUTO_PUSH not set; skipping push. Set AUTO_PUSH=1 to push automatically."
    fi
  else
    if [ "${AUTO_PUSH:-0}" = "1" ]; then
      gh repo create ai-session-flow --public --source=. --remote=origin --push
    else
      echo "AUTO_PUSH not set; skipping remote creation/push. Set AUTO_PUSH=1 to enable."
    fi
  fi
fi

echo "✅ Success! Install via: copilot plugin install <YOUR_GITHUB_USERNAME>/ai-session-flow"
