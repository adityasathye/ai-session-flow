const { execSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const GIT_HOST = process.env.GIT_HOST || 'github.com';
const SYNC_DIR = path.join(os.homedir(), '.ai-session-flow');
const AUDIT_LOG = path.join(SYNC_DIR, 'security-audit.log');
const LOCK_FILE = path.join(SYNC_DIR, '.sync_lock');
const LOCK_WINDOW_MS = 10_000;

const SOURCES = [
  path.join(os.homedir(), '.config', 'github-copilot', 'sessions'),
  path.join(os.homedir(), '.copilot', 'sessions'),
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.claude', 'sessions')
];

function run(command, options = {}) {
  return execSync(command, { stdio: 'ignore', ...options });
}

function ensureSyncDir() {
  if (!fs.existsSync(SYNC_DIR)) {
    fs.mkdirSync(SYNC_DIR, { recursive: true, mode: 0o700 });
  }
}

function logAudit(level, message) {
  ensureSyncDir();
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(AUDIT_LOG, logEntry, { encoding: 'utf8', mode: 0o600 });

  if (level === 'ERROR' || level === 'SECURITY_BLOCK' || level === 'USER_ACTION') {
    console.log(logEntry.trim());
  }
}

function validateDependencies() {
  try {
    run('gh --version');
    run('gitleaks version');
  } catch {
    logAudit('ERROR', "Missing dependencies. Ensure 'gh' and 'gitleaks' are installed and on PATH.");
    process.exit(1);
  }
}

function getGhUsername() {
  try {
    return execSync('gh api user -q .login', { encoding: 'utf8' }).trim();
  } catch {
    logAudit('ERROR', 'Unable to resolve GitHub username via gh CLI. Are you authenticated?');
    process.exit(1);
  }
}

function bootstrapRepo() {
  // if the repo already exists locally, nothing to do
  if (fs.existsSync(path.join(SYNC_DIR, '.git'))) {
    return;
  }

  // remove any leftover directory (from prior failed attempt)
  if (fs.existsSync(SYNC_DIR)) {
    fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  }

  validateDependencies();
  const username = getGhUsername();
  const repoRef = `${username}/ai-session-flow-backup`;

  // attempt to create repository; ignore error if it already exists
  try {
    run(`gh repo create ${repoRef} --private`);
    console.log(`INFO: Created private repository ${repoRef}.`);
  } catch (err) {
    console.log(`INFO: Create request failed (repo may already exist): ${err.message}`);
    // in case logAudit wrote anything, remove it (unlikely now)
    if (fs.existsSync(SYNC_DIR)) {
      fs.rmSync(SYNC_DIR, { recursive: true, force: true });
    }
  }

  // now clone using git directly
  if (fs.existsSync(SYNC_DIR)) {
    const entries = fs.readdirSync(SYNC_DIR);
    console.log(`INFO: SYNC_DIR already exists before clone; entries=${entries.join(',')}`);
    // wipe again before clone
    fs.rmSync(SYNC_DIR, { recursive: true, force: true });
  }
  try {
    run(`git clone https://${GIT_HOST}/${repoRef}.git ${SYNC_DIR}`);
    logAudit('INFO', `Cloned backup repository ${repoRef} into ${SYNC_DIR}.`);
  } catch (cloneErr) {
    logAudit('ERROR', `Bootstrap clone failed: ${cloneErr.message}`);
    process.exit(1);
  }
}

function mapSourceToDest(sourcePath) {
  const rel = path.relative(os.homedir(), sourcePath).replace(/[\\/]+/g, '__');
  return path.join(SYNC_DIR, rel);
}

function copyRecursive(src, dest) {
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  if (stats.isFile()) {
    fs.copyFileSync(src, dest);
  }
}

function mirrorSourcesToSyncDir() {
  for (const source of SOURCES) {
    if (!fs.existsSync(source)) continue;
    const destRoot = mapSourceToDest(source);
    if (!fs.existsSync(destRoot)) fs.mkdirSync(destRoot, { recursive: true });

    for (const entry of fs.readdirSync(source)) {
      const srcPath = path.join(source, entry);
      const destPath = path.join(destRoot, entry);
      copyRecursive(srcPath, destPath);
    }
  }
}

function runSecurityGate() {
  try {
    run('gitleaks detect --source . --no-git --redact', { cwd: SYNC_DIR });
    return true;
  } catch {
    logAudit('SECURITY_BLOCK', 'Gitleaks detected a potential secret. Sync aborted and staged state reset.');

    try {
      run('git reset --hard', { cwd: SYNC_DIR });
      run('git clean -fd', { cwd: SYNC_DIR });
    } catch {
      // no-op best effort
    }

    for (const source of SOURCES) {
      const destRoot = mapSourceToDest(source);
      if (fs.existsSync(destRoot)) {
        fs.rmSync(destRoot, { recursive: true, force: true });
      }
    }

    return false;
  }
}

function syncToRemote() {
  run('git add .', { cwd: SYNC_DIR });
  const changes = execSync('git status --porcelain', { cwd: SYNC_DIR, encoding: 'utf8' }).trim();
  if (!changes) return;

  const dateStr = new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
  run(`git commit -m "Secure Auto-sync: ${dateStr}"`, { cwd: SYNC_DIR });

  try {
    run('git pull origin main -s recursive -X theirs --no-edit', { cwd: SYNC_DIR });
  } catch {
    logAudit('INFO', 'Pull had no mergeable updates or conflict strategy applied. Continuing push.');
  }

  run('git push origin main', { cwd: SYNC_DIR });
  logAudit('INFO', `Successfully synced AI session data to ${GIT_HOST}.`);

  const gitObjDir = path.join(SYNC_DIR, '.git', 'objects');
  if (fs.existsSync(gitObjDir)) {
    try {
      run('git gc --auto', { cwd: SYNC_DIR });
    } catch {
      // no-op
    }
  }
}

function shouldDebounce() {
  if (!fs.existsSync(LOCK_FILE)) return false;

  try {
    const stats = fs.statSync(LOCK_FILE);
    return Date.now() - stats.mtimeMs < LOCK_WINDOW_MS;
  } catch {
    return false;
  }
}

function scheduleDaemon() {
  ensureSyncDir();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), 'utf8');

  const child = spawn(process.execPath, [__filename, 'push', '--daemon'], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();
}

function handlePush() {
  if (process.argv[3] !== '--daemon') {
    try {
      if (shouldDebounce()) process.exit(0);
      scheduleDaemon();
      process.exit(0);
    } catch {
      process.exit(0);
    }
  }

  try {
    bootstrapRepo();
    mirrorSourcesToSyncDir();
    const ok = runSecurityGate();
    if (!ok) process.exit(1);
    syncToRemote();
  } catch (error) {
    logAudit('ERROR', `Daemon push failed: ${error.message}`);
  }
}

function handleRestore() {
  try {
    bootstrapRepo();
    logAudit('USER_ACTION', 'Initiating session restore pull from remote.');
    run('git pull origin main -s recursive -X theirs --no-edit', { cwd: SYNC_DIR });
    console.log(`\nRestore complete. Sanitized sessions are located in: ${SYNC_DIR}\n`);
  } catch (error) {
    logAudit('ERROR', `Restore failed: ${error.message}`);
  }
}

function handleClean() {
  try {
    logAudit('USER_ACTION', 'User requested local session state cleanup.');

    for (const source of SOURCES) {
      if (!fs.existsSync(source)) continue;

      for (const entry of fs.readdirSync(source)) {
        const entryPath = path.join(source, entry);
        const stats = fs.statSync(entryPath);
        if (stats.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else if (stats.isFile()) {
          fs.unlinkSync(entryPath);
        }
      }
    }

    console.log('Local AI CLI session state has been securely cleaned.');
  } catch (error) {
    logAudit('ERROR', `Clean failed: ${error.message}`);
  }
}

const action = process.argv[2] || 'push';

if (action === 'push') {
  handlePush();
} else if (action === 'restore') {
  handleRestore();
} else if (action === 'clean') {
  handleClean();
} else {
  console.error(`Unknown action: ${action}`);
  process.exit(1);
}
