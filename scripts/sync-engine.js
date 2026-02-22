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
  console.log(`DEBUG: execute => ${command}`);
  try {
    return execSync(command, { stdio: 'inherit', ...options });
  } catch (err) {
    console.log(`DEBUG: command failed: ${command}`);
    throw err;
  }
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

function safeShellToken(s) {
  if (typeof s !== 'string') throw new Error('Invalid shell token');
  if (!/^[A-Za-z0-9._\/:-]+$/.test(s)) {
    throw new Error(`Unsafe shell token: ${s}`);
  }
  return s;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    // Move existing SYNC_DIR to a backup location instead of force-deleting
    const backup = `${SYNC_DIR}.bak.${Date.now()}`;
    try {
      fs.renameSync(SYNC_DIR, backup);
      logAudit('INFO', `Backed up existing SYNC_DIR to ${backup} instead of deleting`);
    } catch (err) {
      logAudit('ERROR', `Failed to backup existing SYNC_DIR: ${err.message}`);
      throw err;
    }
  }

  validateDependencies();
  const username = getGhUsername();
  // repository name on GitHub uses a leading dot as required by user
  const repoRef = `${username}/.ai-session-flow`;

  // attempt to create repository; ignore error if it already exists
  try {
    run(`gh repo create ${safeShellToken(repoRef)} --private`);
    console.log(`INFO: Created private repository ${repoRef}.`);
  } catch (err) {
    console.log(`INFO: Create request failed (repo may already exist): ${err.message}`);
    // in case logAudit wrote anything, move existing SYNC_DIR to a backup (avoid data loss)
    if (fs.existsSync(SYNC_DIR)) {
      const backup = `${SYNC_DIR}.bak.${Date.now()}`;
      try {
        fs.renameSync(SYNC_DIR, backup);
        logAudit('INFO', `Backed up existing SYNC_DIR to ${backup} after failed create attempt`);
      } catch (err2) {
        logAudit('ERROR', `Failed to backup SYNC_DIR after create failure: ${err2.message}`);
        throw err2;
      }
    }
  }

  // now clone using git directly
  if (fs.existsSync(SYNC_DIR)) {
    const entries = fs.readdirSync(SYNC_DIR);
    console.log(`INFO: SYNC_DIR already exists before clone; entries=${entries.join(',')}`);
    // move aside before clone to avoid destructive deletion
    const backup = `${SYNC_DIR}.bak.${Date.now()}`;
    try {
      fs.renameSync(SYNC_DIR, backup);
      logAudit('INFO', `Moved existing SYNC_DIR to ${backup} before clone`);
    } catch (err) {
      logAudit('ERROR', `Failed to move existing SYNC_DIR before clone: ${err.message}`);
      throw err;
    }
  }
  try {
    run(`git clone https://${safeShellToken(GIT_HOST)}/${safeShellToken(repoRef)}.git ${safeShellToken(SYNC_DIR)}`);
    logAudit('INFO', `Cloned backup repository ${repoRef} into ${SYNC_DIR}.`);
  } catch (cloneErr) {
    logAudit('ERROR', `Bootstrap clone failed: ${cloneErr.message}`);
    process.exit(1);
  }
}

function mapSourceToDest(sourcePath) {
  const rel = path.relative(os.homedir(), sourcePath);
  if (rel.startsWith('..')) {
    throw new Error(`Source path ${sourcePath} is outside home directory and will not be synced`);
  }
  const safeRel = rel.replace(/[\\/]+/g, '__');
  if (!safeRel) return SYNC_DIR;
  return path.join(SYNC_DIR, safeRel);
}

function copyRecursive(src, dest) {
  const lst = fs.lstatSync(src);
  if (lst.isSymbolicLink()) {
    logAudit('INFO', `Skipping symbolic link during copy: ${src}`);
    return;
  }
  if (lst.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  if (lst.isFile()) {
    // ensure dest is within SYNC_DIR
    const resolvedDest = path.resolve(dest);
    if (!resolvedDest.startsWith(path.resolve(SYNC_DIR) + path.sep) && resolvedDest !== path.resolve(SYNC_DIR)) {
      logAudit('ERROR', `Refusing to copy ${src} to destination outside SYNC_DIR: ${dest}`);
      return;
    }
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
        const backup = `${destRoot}.bak.${Date.now()}`;
        try {
          fs.renameSync(destRoot, backup);
          logAudit('INFO', `Moved destRoot ${destRoot} to backup ${backup} after security block`);
        } catch (err) {
          logAudit('ERROR', `Failed to backup destRoot ${destRoot}: ${err.message}`);
        }
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
    const data = fs.readFileSync(LOCK_FILE, 'utf8');
    const obj = JSON.parse(data);
    if (obj && obj.pid && isPidAlive(obj.pid)) {
      return true;
    }
    const stats = fs.statSync(LOCK_FILE);
    return Date.now() - stats.mtimeMs < LOCK_WINDOW_MS;
  } catch {
    return false;
  }
}

function scheduleDaemon() {
  ensureSyncDir();
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }), null, 'utf8');
    fs.closeSync(fd);
  } catch (err) {
    if (err.code === 'EEXIST') {
      logAudit('INFO', 'Lock file exists; another daemon may be running.');
      return;
    }
    throw err;
  }

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
  } finally {
    try {
      if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    } catch (err) {
      logAudit('ERROR', `Failed to remove lock file: ${err.message}`);
    }
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
        try {
          const lst = fs.lstatSync(entryPath);
          if (lst.isSymbolicLink()) {
            logAudit('INFO', `Skipping symbolic link during clean: ${entryPath}`);
            continue;
          }
          const real = fs.realpathSync(entryPath);
          if (!real.startsWith(path.resolve(source) + path.sep) && real !== path.resolve(source)) {
            logAudit('ERROR', `Skipping cleanup of ${entryPath} because it resolves outside source`);
            continue;
          }
          if (lst.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          } else if (lst.isFile()) {
            fs.unlinkSync(entryPath);
          }
        } catch (err) {
          logAudit('ERROR', `Error checking/removing ${entryPath}: ${err.message}`);
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
