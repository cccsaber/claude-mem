import { homedir } from 'os'
import path from 'path';
import { execFileSync } from 'child_process';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:[\\/]?$/;
const WINDOWS_UNC_PATH_RE = /^\\\\/;
const RELATIVE_PATH_RE = /^\.{1,2}([\\/]|$)/;

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  if (p.startsWith('~\\')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

function basenameCrossPlatform(p: string): string {
  if (
    WINDOWS_ABSOLUTE_PATH_RE.test(p)
    || WINDOWS_DRIVE_ROOT_RE.test(p)
    || WINDOWS_UNC_PATH_RE.test(p)
    || p.includes('\\')
  ) {
    return path.win32.basename(p);
  }
  return path.basename(p);
}

function looksLikePath(value: string): boolean {
  return value === '~'
    || value.startsWith('~/')
    || value.startsWith('~\\')
    || value.startsWith('/')
    || WINDOWS_ABSOLUTE_PATH_RE.test(value)
    || WINDOWS_DRIVE_ROOT_RE.test(value)
    || WINDOWS_UNC_PATH_RE.test(value)
    || RELATIVE_PATH_RE.test(value);
}

/**
 * Resolve the git repository ROOT for a directory, so a project's name is
 * stable across its subdirectories and worktrees (#2663). Returns the absolute
 * repo-root path, or null when `dir` is not inside a git repo (or git is
 * unavailable). `--show-toplevel` resolves to the working-tree root even when
 * invoked from a worktree or a nested subdirectory.
 */
function findGitRepoRoot(dir: string): string | null {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return root || null;
  } catch {
    // Not a git repo, git not installed, or dir does not exist — fall back to basename.
    return null;
  }
}

export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('PROJECT_NAME', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  const expanded = expandTilde(cwd)

  // #2663 — derive the project name from the git repo root when inside a repo so
  // the name is stable across subdirectories/worktrees. Fall back to the cwd
  // basename when not in a repo.
  const repoRoot = findGitRepoRoot(expanded);
  const nameSource = repoRoot ?? expanded;

  const basename = basenameCrossPlatform(nameSource);

  if (basename === '') {
    const isWindows = process.platform === 'win32';
    const driveMatch = cwd.match(/^([A-Z]):[\\/]?$/i);
    if (isWindows || driveMatch) {
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('PROJECT_NAME', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('PROJECT_NAME', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

export function normalizeProjectIdentifier(project: string | null | undefined): string | undefined {
  const trimmed = project?.trim();
  if (!trimmed) return undefined;
  return looksLikePath(trimmed) ? getProjectContext(trimmed).primary : trimmed;
}

export interface ProjectContext {
  primary: string;
  parent: string | null;
  isWorktree: boolean;
  allProjects: string[];
}

export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
  }

  const expandedCwd = expandTilde(cwd);
  const worktreeInfo = detectWorktree(expandedCwd);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const composite = `${worktreeInfo.parentProjectName}/${cwdProjectName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, composite]
    };
  }

  return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName] };
}
