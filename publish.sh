#!/bin/bash
set -euo pipefail

if [ ! -f "plugin.json" ]; then
  echo "❌ Error: Run this script from inside the ai-session-flow directory."
  exit 1
fi

echo "📦 Initializing local Git repository..."
if [ ! -d .git ]; then
  git init -b main
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
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create ai-session-flow --public --source=. --remote=origin --push
fi

echo "✅ Success! Install via: copilot plugin install <YOUR_GITHUB_USERNAME>/ai-session-flow"
