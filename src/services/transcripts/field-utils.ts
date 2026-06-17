import { logger } from '../../utils/logger.js';
import type { FieldSpec, MatchRule, TranscriptSchema, WatchTarget } from './types.js';

interface ResolveContext {
  watch: WatchTarget;
  schema: TranscriptSchema;
  session?: Record<string, unknown>;
}

function parsePath(path: string): Array<string | number | { filterKey: string; filterValue: string; excludePrefix?: string }> {
  const cleaned = path.trim().replace(/^\$\.?/, '');
  if (!cleaned) return [];

  const tokens: Array<string | number | { filterKey: string; filterValue: string; excludePrefix?: string }> = [];
  const parts = cleaned.split('.');

  for (const part of parts) {
    // Filter syntax: [key=value] or [key=value,-prefix]
    //   [role=user]            â†?element[role]==="user"
    //   [role=user,-<]         â†?element[role]==="user" AND content doesn't start with "<"
    // The optional ,-prefix excludes elements whose resolved content starts with
    // that character (e.g. skip system-reminder injections that masquerade as
    // user messages).
    const filterMatch = part.match(/\[([^=\]]+)=([^\],]+)(?:,(-([^\]]+)))?\]/);
    if (filterMatch) {
      const propMatch = part.match(/^([^[\]]+)/);
      if (propMatch) tokens.push(propMatch[1]);
      tokens.push({
        filterKey: filterMatch[1],
        filterValue: filterMatch[2],
        ...(filterMatch[4] ? { excludePrefix: filterMatch[4] } : {}),
      });
      continue;
    }
    const regex = /([^[\]]+)|\[(\d+)\]|\[\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(part)) !== null) {
      if (match[1]) {
        tokens.push(match[1]);
      } else if (match[2]) {
        tokens.push(parseInt(match[2], 10));
      } else if (match[0] === '[]') {
        tokens.push('*');
      }
    }
  }

  return tokens;
}

export function getValueByPath(input: unknown, path: string): unknown {
  if (!path) return undefined;
  const tokens = parsePath(path);
  let current: any = input;

  for (let i = 0; i < tokens.length; i++) {
    if (current === null || current === undefined) return undefined;
    const token = tokens[i];
    if (token === '*') {
      const remaining = tokens.slice(i + 1);
      return findFirstNonEmptyInArray(current, remaining);
    }
    if (typeof token === 'object' && token !== null && 'filterKey' in token) {
      const remaining = tokens.slice(i + 1);
      return findFirstFilteredInArray(current, token.filterKey, token.filterValue, remaining, token.excludePrefix);
    }
    current = current[token as any];
  }

  return current;
}

/**
 * Find the LAST array element where element[filterKey]===filterValue, then
 * resolve remaining tokens from it. Used for extracting the user's latest
 * prompt from message history (the first role=user entry is often a
 * system-reminder; the real prompt is the last one).
 */
function findFirstFilteredInArray(
  arr: unknown,
  filterKey: string,
  filterValue: string,
  remainingTokens: Array<string | number | { filterKey: string; filterValue: string; excludePrefix?: string }>,
  excludePrefix?: string,
): unknown {
  if (!Array.isArray(arr)) return undefined;
  let lastMatch: unknown = undefined;
  for (const item of arr) {
    if (item && typeof item === 'object' && (item as any)[filterKey] === filterValue) {
      const value = resolveTokens(item, remainingTokens);
      if (value !== undefined && value !== null && value !== '') {
        if (excludePrefix && typeof value === 'string' && value.startsWith(excludePrefix)) continue;
        lastMatch = value;
      }
    }
  }
  return lastMatch;
}

function findFirstNonEmptyInArray(arr: unknown, remainingTokens: Array<string | number | { filterKey: string; filterValue: string; excludePrefix?: string }>): unknown {
  if (!Array.isArray(arr)) return undefined;
  for (const item of arr) {
    const value = resolveTokens(item, remainingTokens);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function resolveTokens(input: unknown, tokens: Array<string | number | { filterKey: string; filterValue: string; excludePrefix?: string }>): unknown {
  let current: any = input;
  for (let i = 0; i < tokens.length; i++) {
    if (current === null || current === undefined) return undefined;
    const token = tokens[i];
    if (token === '*') {
      const remaining = tokens.slice(i + 1);
      return findFirstNonEmptyInArray(current, remaining);
    }
    if (typeof token === 'object' && token !== null && 'filterKey' in token) {
      const remaining = tokens.slice(i + 1);
      return findFirstFilteredInArray(current, token.filterKey, token.filterValue, remaining, token.excludePrefix);
    }
    current = current[token as any];
  }
  return current;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function resolveFromContext(path: string, ctx: ResolveContext): unknown {
  if (path.startsWith('$watch.')) {
    const key = path.slice('$watch.'.length);
    return (ctx.watch as any)[key];
  }
  if (path.startsWith('$schema.')) {
    const key = path.slice('$schema.'.length);
    return (ctx.schema as any)[key];
  }
  if (path.startsWith('$session.')) {
    const key = path.slice('$session.'.length);
    return ctx.session ? (ctx.session as any)[key] : undefined;
  }
  if (path === '$cwd') return ctx.watch.workspace;
  if (path === '$project') return ctx.watch.project;
  return undefined;
}

export function resolveFieldSpec(
  spec: FieldSpec | undefined,
  entry: unknown,
  ctx: ResolveContext
): unknown {
  if (spec === undefined) return undefined;

  if (typeof spec === 'string') {
    const fromContext = resolveFromContext(spec, ctx);
    if (fromContext !== undefined) return fromContext;
    return getValueByPath(entry, spec);
  }

  let resolved: unknown;

  if (spec.coalesce && Array.isArray(spec.coalesce)) {
    for (const candidate of spec.coalesce) {
      const value = resolveFieldSpec(candidate, entry, ctx);
      if (!isEmptyValue(value)) {
        resolved = value;
        break;
      }
    }
  }

  if (resolved === undefined && spec.path) {
    const fromContext = resolveFromContext(spec.path, ctx);
    if (fromContext !== undefined) {
      resolved = fromContext;
    } else {
      const value = getValueByPath(entry, spec.path);
      if (!isEmptyValue(value)) resolved = value;
    }
  }

  if (resolved === undefined && spec.value !== undefined) resolved = spec.value;

  // extract: regex applied to the resolved string value to pull out a
  // substring (first capture group). Lets a schema reach a value embedded in
  // free-text (e.g. ZCode's "Primary working directory: D:\code" line in a
  // system-prompt block) when no structured field holds it. Falls through to
  // default/undefined when the value doesn't match.
  if (spec.extract && typeof resolved === 'string' && resolved.length > 0) {
    const extracted = applyExtract(resolved, spec.extract);
    if (extracted !== undefined) return extracted;
    // No match: fall through to default rather than returning the raw text.
    resolved = undefined;
  }

  if (resolved !== undefined) return resolved;

  if (spec.default !== undefined) return spec.default;

  return undefined;
}

/**
 * Apply a regex to a resolved string value and return the first capture group
 * (trimmed). Returns undefined when there is no match or no capture group, so
 * the caller can fall through to default. An invalid regex logs a debug warning
 * and returns undefined (matching the matchesRule regex-error discipline).
 */
function applyExtract(value: string, pattern: string): string | undefined {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error: unknown) {
    logger.debug('WORKER', 'CWD_DIAG applyExtract invalid-regex', { diag: 'applyExtract', pattern });
    logger.debug('WORKER', 'Invalid regex in FieldSpec extract', { pattern }, error instanceof Error ? error : undefined);
    return undefined;
  }
  const match = value.match(regex);
  // CWD_DIAG: the cwd lives in free-text and is extracted via regex. If the
  // regex doesn't match (system block index shifted, line wording changed), the
  // cwd silently becomes undefined and the project falls back to the worker's
  // startup dir. Log the match outcome and the value slice being tested.
  logger.debug('WORKER', 'CWD_DIAG applyExtract', {
    diag: 'applyExtract',
    pattern,
    valueLen: value.length,
    matched: !!match,
    captured: match && match[1] !== undefined ? String(match[1]).trim().slice(0, 200) : null,
    valuePreview: value.slice(0, 160),
  });
  if (!match || match[1] === undefined) return undefined;
  const captured = String(match[1]).trim();
  return captured.length > 0 ? captured : undefined;
}

export function resolveFields(
  fields: Record<string, FieldSpec> | undefined,
  entry: unknown,
  ctx: ResolveContext
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  if (!fields) return resolved;

  for (const [key, spec] of Object.entries(fields)) {
    resolved[key] = resolveFieldSpec(spec, entry, ctx);
  }

  return resolved;
}

export function matchesRule(
  entry: unknown,
  rule: MatchRule | undefined,
  schema: TranscriptSchema
): boolean {
  if (!rule) return true;

  const path = rule.path || schema.eventTypePath || 'type';
  const value = path ? getValueByPath(entry, path) : undefined;
  const isAbsent = value === undefined || value === null || value === '';

  // Every operator present on the rule must pass (logical AND). This lets a
  // single rule combine positive and negative conditions (e.g. match a tool
  // event but exclude guardian/subagent sessions via `not_equals`/`not_in`).
  if (rule.exists !== undefined) {
    // exists:true â†?field must be present; exists:false â†?field must be absent.
    if (rule.exists && isAbsent) return false;
    if (!rule.exists && !isAbsent) return false;
  }

  if (rule.equals !== undefined) {
    if (value !== rule.equals) return false;
  }

  if (rule.not_equals !== undefined) {
    if (value === rule.not_equals) return false;
  }

  if (rule.in && Array.isArray(rule.in)) {
    if (!rule.in.includes(value)) return false;
  }

  if (rule.not_in && Array.isArray(rule.not_in)) {
    if (rule.not_in.includes(value)) return false;
  }

  if (rule.contains !== undefined) {
    if (typeof value !== 'string' || !value.includes(rule.contains)) return false;
  }

  if (rule.not_contains !== undefined) {
    if (typeof value === 'string' && value.includes(rule.not_contains)) return false;
  }

  if (rule.regex) {
    try {
      const regex = new RegExp(rule.regex);
      if (!regex.test(String(value ?? ''))) return false;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Invalid regex in match rule', { regex: rule.regex }, error instanceof Error ? error : undefined);
      return false;
    }
  }

  return true;
}
