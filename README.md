# 🌊 AI Session Flow

A secure, cross-device session synchronizer for GitHub Copilot CLI and Claude Code.

AI Session Flow runs in the background, enforces local secret scanning, and keeps sanitized session snapshots synchronized to a private GitHub repository.

## ✨ Features

- **Seamless Hot-Reloading:** Restore sessions and load context through AI file-reading tools.
- **Universal Support:** Syncs GitHub Copilot CLI and Claude Code state paths.
- **Security First:** Gitleaks blocks syncs when potential secrets are detected.
- **Repo Naming:** Backups are pushed to a private GitHub repository named `.ai-session-flow` under your account.
- **Debounced Concurrency:** Lock file prevents rapid concurrent Git operations.

## 🚀 Installation

### Prerequisites
- [GitHub CLI (`gh`)](https://cli.github.com/)
- [`gitleaks`](https://github.com/gitleaks/gitleaks)
- Node.js 18+

```bash
copilot plugin install <YOUR_GITHUB_USERNAME>/ai-session-flow
```

## 📥 Usage

Restore a session:
```bash
/ai-session-flow restore my-session
```

Clean local data:
```bash
/ai-session-flow clean
```

## 🔐 Security Notes

- Every sync runs local `gitleaks detect --source . --no-git --redact` inside the backup workspace.
- If a secret is detected, sync aborts, staged state is reset, and a `SECURITY_BLOCK` event is logged.
- Audit logs are written to `~/.ai-session-flow/security-audit.log`.
