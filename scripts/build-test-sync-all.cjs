#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const pluginDir = path.join(rootDir, 'plugin');
const packageJson = require(path.join(rootDir, 'package.json'));
const version = packageJson.version;
const homeDir = os.homedir();

const args = new Set(process.argv.slice(2));
const skipChecks = args.has('--skip-checks');
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const skipCodexHookTrust = args.has('--no-codex-hook-trust');

function commandName(name) {
  if (process.platform === 'win32' && ['npm', 'npx'].includes(name)) {
    return `${name}.cmd`;
  }
  return name;
}

function run(command, commandArgs, options = {}) {
  const shown = [command, ...commandArgs].join(' ');
  if (dryRun) {
    console.log(`[dry-run] ${shown}`);
    return;
  }

  console.log(`\n> ${shown}`);
  execFileSync(commandName(command), commandArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    ...options,
  });
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside target root: ${resolvedTarget}`);
  }
}

function assertVersionTarget(root, target) {
  assertInside(root, target);
  if (path.basename(path.resolve(target)) !== version) {
    throw new Error(`Refusing to sync non-version target: ${target}`);
  }
}

function removeEntry(targetRoot, entryPath) {
  assertInside(targetRoot, entryPath);
  if (dryRun) {
    console.log(`[dry-run] remove ${entryPath}`);
    return;
  }
  fs.rmSync(entryPath, { recursive: true, force: true });
}

function copyFile(sourcePath, targetPath) {
  if (dryRun) {
    console.log(`[dry-run] copy ${sourcePath} -> ${targetPath}`);
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function ensureDir(dirPath) {
  if (dryRun) {
    console.log(`[dry-run] mkdir ${dirPath}`);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function mirrorDir(sourceDir, targetDir, targetRoot, options = {}, relativeDir = '') {
  const preserveNames = options.preserveNames ?? new Set();
  const shouldSkip = options.shouldSkip ?? (() => false);
  ensureDir(targetDir);

  const sourceNames = new Set(fs.readdirSync(sourceDir));
  if (fs.existsSync(targetDir)) {
    for (const name of fs.readdirSync(targetDir)) {
      const relativePath = normalizeRelativePath(relativeDir ? path.join(relativeDir, name) : name);
      if (preserveNames.has(name) || shouldSkip(relativePath, name)) {
        continue;
      }
      if (!sourceNames.has(name)) {
        removeEntry(targetRoot, path.join(targetDir, name));
      }
    }
  }

  for (const name of sourceNames) {
    const relativePath = normalizeRelativePath(relativeDir ? path.join(relativeDir, name) : name);
    if (preserveNames.has(name) || shouldSkip(relativePath, name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, name);
    const targetPath = path.join(targetDir, name);
    const sourceStat = fs.lstatSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);
    const targetStat = targetExists ? fs.lstatSync(targetPath) : null;

    if (sourceStat.isDirectory()) {
      if (targetStat && !targetStat.isDirectory()) {
        removeEntry(targetRoot, targetPath);
      }
      mirrorDir(sourcePath, targetPath, targetRoot, options, relativePath);
      continue;
    }

    if (targetStat && targetStat.isDirectory()) {
      removeEntry(targetRoot, targetPath);
    }
    copyFile(sourcePath, targetPath);
  }
}

function syncPluginCache({ name, root, target }) {
  assertVersionTarget(root, target);
  ensureDir(root);
  ensureDir(target);

  console.log(`\nSyncing ${name}`);
  console.log(`  from: ${pluginDir}`);
  console.log(`  to:   ${target}`);

  mirrorDir(pluginDir, target, target, { preserveNames: new Set(['node_modules']) });

  if (fs.existsSync(path.join(target, 'package.json'))) {
    run('bun', ['install'], { cwd: target });
  }
}

function codexHookStateEventName(eventName) {
  return eventName.replace(/[A-Z]/g, (match, index) => `${index ? '_' : ''}${match.toLowerCase()}`);
}

function hookCommandHash(command) {
  return `sha256:${crypto.createHash('sha256').update(command).digest('hex')}`;
}

function tomlQuotedKey(key) {
  return key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function upsertTomlHookTrustedHash(configText, key, hash) {
  const header = `[hooks.state."${tomlQuotedKey(key)}"]`;
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionPattern = new RegExp(`(^|\\r?\\n)${escapedHeader}\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`);
  const match = configText.match(sectionPattern);

  if (!match) {
    const separator = configText.endsWith('\n') ? '' : '\n';
    return `${configText}${separator}\n${header}\ntrusted_hash = "${hash}"\n`;
  }

  const sectionBody = match[2];
  const nextBody = /^trusted_hash\s*=.*$/m.test(sectionBody)
    ? sectionBody.replace(/^trusted_hash\s*=.*$/m, `trusted_hash = "${hash}"`)
    : `trusted_hash = "${hash}"\n${sectionBody}`;
  return configText.replace(sectionPattern, `${match[1]}${header}\n${nextBody}`);
}

function refreshCodexHookTrust() {
  if (skipCodexHookTrust) return;

  const codexConfigPath = path.join(homeDir, '.codex', 'config.toml');
  const hooksPath = path.join(pluginDir, 'hooks', 'codex-hooks.json');
  if (!fs.existsSync(codexConfigPath) || !fs.existsSync(hooksPath)) {
    return;
  }

  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')).hooks ?? {};
  const trustEntries = [];
  for (const [eventName, groups] of Object.entries(hooks)) {
    for (const [groupIndex, group] of groups.entries()) {
      for (const [hookIndex, hook] of (group.hooks ?? []).entries()) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') continue;
        trustEntries.push({
          key: `claude-mem@claude-mem-local:hooks/codex-hooks.json:${codexHookStateEventName(eventName)}:${groupIndex}:${hookIndex}`,
          hash: hookCommandHash(hook.command),
        });
      }
    }
  }

  if (trustEntries.length === 0) return;

  console.log('\nRefreshing Codex claude-mem hook trust hashes');
  console.log(`  config: ${codexConfigPath}`);
  if (dryRun) {
    for (const entry of trustEntries) {
      console.log(`[dry-run] trust ${entry.key} = ${entry.hash}`);
    }
    return;
  }

  let configText = fs.readFileSync(codexConfigPath, 'utf-8');
  for (const entry of trustEntries) {
    configText = upsertTomlHookTrustedHash(configText, entry.key, entry.hash);
  }
  fs.writeFileSync(codexConfigPath, configText, 'utf-8');
}

function getCurrentBranch(installedPath) {
  try {
    if (!fs.existsSync(path.join(installedPath, '.git'))) {
      return null;
    }
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: installedPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const ROOT_EXCLUDE_NAMES = new Set([
  '.git',
  '.cursor',
  '.idea',
  '.octo',
  '.scratch',
  '.venv-swebench',
  'Auto Run Docs',
  'datasets',
  'dist',
  'node_modules',
  'private',
  'reports',
]);

const ROOT_EXCLUDE_RELATIVE = new Set([
  '.DS_Store',
  '.env',
  '.env.local',
  '.install-version',
  '.mcp.json',
  'AGENTS.md',
  'CONTRIB_NOTES.md',
  'bun.lock',
  'package-lock.json',
  'plugin/.cli-installed',
  'plugin/scripts/claude-mem',
  'scripts/package.json',
  'src/ui/viewer.html',
]);

const ROOT_EXCLUDE_PREFIXES = [
  '.claude/agents/',
  '.claude/plans/',
  '.claude/skills/',
  '.claude/worktrees/',
  '.claude-octopus/',
  '.docker-blowout-data/',
  '.docker-claude-mem-data/',
  'docker/install-test/',
  'evals/swebench/runs/',
  'logs/run_evaluation/',
  'plugin/data/',
  'plugin/data.backup/',
  'scripts/node_modules/',
];

const ROOT_EXCLUDE_SUFFIXES = [
  '.log',
  '.temp',
  '.tmp',
];

function shouldSkipRootSync(relativePath, name) {
  if (ROOT_EXCLUDE_NAMES.has(name) || ROOT_EXCLUDE_RELATIVE.has(relativePath)) {
    return true;
  }
  if (relativePath === '.claude/settings.local.json' ||
      relativePath === '.claude/session-intent.md' ||
      relativePath === '.claude/session-plan.md' ||
      relativePath === '.claude/scheduled_tasks.lock') {
    return true;
  }
  if (ROOT_EXCLUDE_PREFIXES.some(prefix => relativePath.startsWith(prefix))) {
    return true;
  }
  if (ROOT_EXCLUDE_SUFFIXES.some(suffix => relativePath.endsWith(suffix))) {
    return true;
  }
  return /^claude-opus-4-7\+claude-mem\..*\.json$/.test(relativePath);
}

function syncClaudeCode() {
  const marketplaceRoot = path.join(homeDir, '.claude', 'plugins', 'marketplaces');
  const marketplaceTarget = path.join(marketplaceRoot, 'thedotmack');
  const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem');
  const cacheTarget = path.join(cacheRoot, version);

  const branch = getCurrentBranch(marketplaceTarget);
  if (branch && branch !== 'main' && !force) {
    throw new Error(
      `Installed Claude Code marketplace is on branch "${branch}". Re-run with --force if you really want to overwrite it.`
    );
  }

  ensureDir(marketplaceRoot);
  ensureDir(marketplaceTarget);

  console.log('\nSyncing Claude Code marketplace');
  console.log(`  from: ${rootDir}`);
  console.log(`  to:   ${marketplaceTarget}`);
  mirrorDir(rootDir, marketplaceTarget, marketplaceTarget, { shouldSkip: shouldSkipRootSync });

  if (fs.existsSync(path.join(marketplaceTarget, 'package.json'))) {
    run('bun', ['install'], { cwd: marketplaceTarget });
  }

  syncPluginCache({
    name: 'Claude Code cache',
    root: cacheRoot,
    target: cacheTarget,
  });
}

if (!fs.existsSync(pluginDir)) {
  throw new Error(`Missing plugin directory: ${pluginDir}`);
}

if (!skipChecks) {
  run('npm', ['run', 'build']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
}

syncClaudeCode();

const cacheTargets = [
  {
    name: 'Codex',
    root: path.join(homeDir, '.codex', 'plugins', 'cache', 'claude-mem-local', 'claude-mem'),
    target: path.join(homeDir, '.codex', 'plugins', 'cache', 'claude-mem-local', 'claude-mem', version),
  },
  {
    name: 'ZCode claude-mem',
    root: path.join(homeDir, '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugins-official', 'claude-mem'),
    target: path.join(homeDir, '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugins-official', 'claude-mem', version),
  },
];

for (const target of cacheTargets) {
  syncPluginCache(target);
}

refreshCodexHookTrust();

console.log('\nAll plugin targets are up to date.');
