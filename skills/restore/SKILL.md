---
name: restore-session
description: Restores a previous AI CLI session state from the backup repository into local CLI paths.
---

To restore a session, follow these steps:

1. Execute the restore router:
   - `node ./scripts/sync-engine.js restore`
2. List available synced session data:
   - `ls -la ~/.ai-session-flow`
3. Ask the user which session file or folder to restore.
4. Copy selected data into the matching local state folder.
5. Hot-reload context by reading the restored JSON file through your file-reading tool.
6. Parse and adopt the conversation context into active memory.
7. Confirm completion:
   - `✅ Session hot-loaded into active memory!`
