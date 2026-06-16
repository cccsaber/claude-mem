import path from 'path';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { fileEditHandler } from '../../cli/handlers/file-edit.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { getProjectContext } from '../../utils/project-name.js';
import { writeAgentsMd } from '../../utils/agents-md-utils.js';
import { resolveFieldSpec, resolveFields, matchesRule } from './field-utils.js';
import { expandHomePath, shouldSuppressNativeCodexAgentsContext } from './config.js';
import type { TranscriptSchema, WatchTarget, SchemaEvent } from './types.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { ingestObservation } from '../worker/http/shared.js';

interface SessionState {
  sessionId: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pendingTools?: Map<string, { toolName: string; toolInput: unknown }>;
  /** IDs of tool calls whose observation has already been sent. Prevents
   *  duplicates when rollout records replay full conversation history. */
  processedToolUseIds?: Set<string>;
  /** True once session_end has fired for this session. */
  sessionEnded?: boolean;
}

export class TranscriptEventProcessor {
  private sessions = new Map<string, SessionState>();

  async processEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string | null
  ): Promise<void> {
    const entryType = (entry as any)?.type ?? '(no type)';
    logger.debug('TRANSCRIPT_DEBUG', `processEntry start`, { watch: watch.name, schema: schema.name, entryType, eventCount: schema.events.length });
    for (const event of schema.events) {
      const matched = matchesRule(entry, event.match, schema);
      logger.debug('TRANSCRIPT_DEBUG', `event "${event.name}" match=${matched}`, { match: event.match, entryType });
      if (!matched) continue;
      await this.handleEvent(entry, watch, schema, event, sessionIdOverride ?? undefined);
    }
  }

  /**
   * Pre-populate a session's cwd BEFORE any record is processed. Used by the
   * watcher when startAtEnd skips a file's history: the cwd (and thus project)
   * for a ZCode rollout lives in the FIRST record's system prompt, but the
   * watcher only tails NEW records — which for a resumed session are follow-up
   * turns that OMIT the system block. Without this prime, session.cwd stays
   * empty, session-init attributes the session to the wrong project, and every
   * observation lands under the worker's startup dir (the cross-project bug).
   *
   * Idempotent: only sets cwd when the session doesn't already have one, so a
   * later session_context event (if the record happens to carry a system block)
   * can still refresh it.
   */
  primeSessionContext(
    watch: WatchTarget,
    sessionId: string,
    cwd: string
  ): void {
    if (!cwd || !cwd.trim()) return;
    const session = this.getOrCreateSession(watch, sessionId);
    if (!session.cwd) {
      session.cwd = cwd;
      logger.debug('TRANSCRIPT', 'Primed session cwd from file head', {
        sessionId, cwd, watch: watch.name,
      });
    }
  }

  /**
   * Extract the cwd from a single rollout entry using the schema's session-level
   * cwd resolution. Public so the watcher can call it when priming a session's
   * cwd from the file head (the first records carry the system block; later
   * follow-up turns that the tailer actually sees do not). Returns undefined
   * when the entry has no resolvable cwd.
   */
  extractCwdFromEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema
  ): string | undefined {
    const ctx = { watch, schema, session: {} as SessionState } as any;
    // Schema-level cwdPath (structured field).
    if (schema.cwdPath) {
      const resolved = resolveFieldSpec({ path: schema.cwdPath }, entry, ctx);
      logger.debug('TRANSCRIPT', 'CWD_DIAG extractCwdFromEntry schema-cwdPath', {
        diag: 'extractCwd-schema', watch: watch.name, cwdPath: schema.cwdPath,
        resolvedType: typeof resolved, resolvedValue: typeof resolved === 'string' ? resolved.slice(0, 200) : resolved,
      });
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
    }
    // Event-level cwd (ZCode pattern: cwd lives in a session_context event's
    // field spec, possibly with an `extract` regex against free-text).
    for (const event of schema.events) {
      if (event.action !== 'session_context' || !event.fields?.cwd) continue;
      const resolved = resolveFieldSpec(event.fields.cwd, entry, ctx);
      logger.debug('TRANSCRIPT', 'CWD_DIAG extractCwdFromEntry event-cwd', {
        diag: 'extractCwd-event', watch: watch.name, event: event.name,
        resolvedType: typeof resolved, resolvedValue: typeof resolved === 'string' ? resolved.slice(0, 200) : resolved,
      });
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
    }
    logger.debug('TRANSCRIPT', 'CWD_DIAG extractCwdFromEntry NO-CWD-FOUND', {
      diag: 'extractCwd-none', watch: watch.name,
      hasCwdPath: !!schema.cwdPath,
      sessionContextEvents: schema.events.filter(e => e.action === 'session_context').map(e => e.name),
    });
    return undefined;
  }

  /**
   * Extract the sessionId from a rollout entry using the schema's sessionIdPath.
   * Public so the watcher can resolve the SAME sessionId the processor will later
   * use (from the record body, e.g. "sess_<uuid>"), rather than the UUID parsed
   * from the filename ("<uuid>" without the "sess_" prefix) — those are
   * different keys into the session map, and priming under the wrong one leaves
   * the real session's cwd empty.
   */
  extractSessionIdFromEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string
  ): string | null {
    const ctx = { watch, schema } as any;
    const fieldSpec = schema.sessionIdPath ? { path: schema.sessionIdPath } : undefined;
    if (fieldSpec) {
      const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
      if (typeof resolved === 'string' && resolved.trim()) return this.normalizeSessionId(resolved.trim(), schema);
      if (typeof resolved === 'number') return String(resolved);
    }
    // Fall back to the filename-derived override only when the record lacks a
    // structured sessionId (matches resolveSessionId's own fallback).
    if (sessionIdOverride && sessionIdOverride.trim()) return sessionIdOverride;
    return null;
  }

  private getSessionKey(watch: WatchTarget, sessionId: string): string {
    return `${watch.name}:${sessionId}`;
  }

  private getOrCreateSession(watch: WatchTarget, sessionId: string): SessionState {
    const key = this.getSessionKey(watch, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        sessionId,
        platformSource: normalizePlatformSource(watch.name),
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private resolveSessionId(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string
  ): string | null {
    const ctx = { watch, schema } as any;
    const fieldSpec = event.fields?.sessionId ?? (schema.sessionIdPath ? { path: schema.sessionIdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) {
      return this.normalizeSessionId(resolved.trim(), schema);
    }
    if (typeof resolved === 'number') return String(resolved);
    if (sessionIdOverride && sessionIdOverride.trim()) return this.normalizeSessionId(sessionIdOverride.trim(), schema);
    return null;
  }

  /**
   * Apply the schema's sessionIdTransform (if any) so the watcher-derived
   * sessionId matches the hook-derived one. This is a generic, schema-driven
   * transform — the processor does NOT hardcode any platform's id format. The
   * ZCode schema declares { stripPrefix: "sess_" } to align its rollout
   * "sess_<uuid>" with the hook's bare "<uuid>"; other schemas have no transform
   * and are returned unchanged.
   *
   * stripPrefix safety: the prefix is only stripped when what follows it looks
   * like a UUID (8-4-4-4-12 hex), so composite namespaces like
   * "sess_subagent_agent_xxx" (which contain underscores, not a UUID) are
   * preserved. This keeps the guard platform-agnostic while preventing
   * accidental over-stripping.
   */
  private normalizeSessionId(sessionId: string, schema: TranscriptSchema): string {
    const transform = schema.sessionIdTransform;
    if (!transform?.stripPrefix) return sessionId;
    const prefix = transform.stripPrefix;
    if (!sessionId.startsWith(prefix)) return sessionId;
    const rest = sessionId.slice(prefix.length);
    // Only strip if the remainder is UUID-shaped (hex-dash groups). This
    // protects "sess_subagent_..." from matching "sess_" stripPrefix.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest)) {
      return rest;
    }
    return sessionId;
  }

  private resolveCwd(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.cwd ?? (schema.cwdPath ? { path: schema.cwdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    // CWD_DIAG: trace every cwd decision so the cross-project bug is diagnosable.
    logger.debug('TRANSCRIPT', 'CWD_DIAG resolveCwd', {
      diag: 'resolveCwd',
      watch: watch.name,
      sessionId: session.sessionId,
      event: event.name,
      hasCwdFieldSpec: !!fieldSpec,
      resolvedType: typeof resolved,
      resolvedValue: typeof resolved === 'string' ? resolved.slice(0, 200) : resolved,
      hasWatchWorkspace: !!watch.workspace,
      hasSessionCwd: !!session.cwd,
    });
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    // FALLBACK ORDER (was the cross-project bug site):
    // An event WITHOUT its own cwd field (e.g. session_init, assistant_message,
    // session_end) must NOT clobber the cwd that a PRIOR session_context event
    // already extracted from the record and cached on session.cwd. Previously
    // watch.workspace was tried FIRST — but watch.workspace is a static global
    // default (often the worker process's startup dir, e.g. claude-mem), so
    // every follow-up event overwrote the correct per-session cwd and
    // mis-attributed the whole session to the wrong project.
    // Correct precedence: the already-resolved per-session cwd wins; the
    // watch-level workspace is only a last-resort default for sessions that
    // never had a cwd extracted at all.
    if (session.cwd) return session.cwd;
    return watch.workspace;
  }

  private resolveProject(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.project ?? (schema.projectPath ? { path: schema.projectPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    // CWD_DIAG: trace how project is derived — this is the value written to
    // sdk_sessions.project (write-once), so the first call's value wins.
    logger.debug('TRANSCRIPT', 'CWD_DIAG resolveProject', {
      diag: 'resolveProject',
      watch: watch.name,
      sessionId: session.sessionId,
      event: event.name,
      resolvedType: typeof resolved,
      resolvedValue: typeof resolved === 'string' ? resolved.slice(0, 100) : resolved,
      hasWatchProject: !!watch.project,
      sessionCwd: session.cwd ?? null,
      sessionProject: session.project ?? null,
    });
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    // Same precedence fix as resolveCwd: a project already resolved from a
    // prior event's cwd (cached on session.project) must not be clobbered by
    // the static watch.project default. watch.project is only a last resort for
    // sessions that never resolved a project.
    if (session.project) return session.project;
    if (session.cwd) return getProjectContext(session.cwd).primary;
    if (watch.project) return watch.project;
    return undefined;
  }

  private async handleEvent(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string
  ): Promise<void> {
    const sessionId = this.resolveSessionId(entry, watch, schema, event, sessionIdOverride);
    if (!sessionId) {
      logger.debug('TRANSCRIPT', 'Skipping event without sessionId', { event: event.name, watch: watch.name });
      return;
    }

    const session = this.getOrCreateSession(watch, sessionId);
    const cwd = this.resolveCwd(entry, watch, schema, event, session);
    if (cwd) session.cwd = cwd;
    const project = this.resolveProject(entry, watch, schema, event, session);
    if (project) session.project = project;

    // CWD_DIAG: the state of session.cwd at the moment session_init fires is
    // decisive — handleSessionInit falls back to process.cwd() when it is empty,
    // which mis-attributes the project. Log before dispatching the action.
    logger.debug('TRANSCRIPT', 'CWD_DIAG handleEvent pre-dispatch', {
      diag: 'handleEvent',
      watch: watch.name,
      event: event.name,
      action: event.action,
      sessionId,
      resolvedCwd: cwd ?? null,
      resolvedProject: project ?? null,
      sessionCwdAfter: session.cwd ?? null,
      sessionProjectAfter: session.project ?? null,
    });

    const fields = resolveFields(event.fields, entry, { watch, schema, session: session as unknown as Record<string, unknown> });

    logger.debug('TRANSCRIPT_DEBUG', `handleEvent action=${event.action}`, {
      event: event.name,
      sessionId,
      fieldsKeys: Object.keys(fields),
      toolName: fields.toolName,
      toolId: fields.toolId,
      hasToolInput: fields.toolInput !== undefined,
      hasToolResponse: fields.toolResponse !== undefined,
    });

    switch (event.action) {
      case 'session_context':
        this.applySessionContext(session, fields);
        break;
      case 'session_init':
        await this.handleSessionInit(session, fields);
        if (watch.context?.updateOn?.includes('session_start')) {
          await this.updateContext(session, watch);
        }
        break;
      case 'user_message':
        if (typeof fields.message === 'string') session.lastUserMessage = fields.message;
        if (typeof fields.prompt === 'string') session.lastUserMessage = fields.prompt;
        break;
      case 'assistant_message':
        if (typeof fields.message === 'string') session.lastAssistantMessage = fields.message;
        break;
      case 'tool_use':
        await this.handleToolUse(session, fields);
        break;
      case 'tool_result':
        await this.handleToolResult(session, fields);
        break;
      case 'observation':
        await this.sendObservation(session, fields);
        break;
      case 'file_edit':
        await this.sendFileEdit(session, fields);
        break;
      case 'session_end':
        if (!session.sessionEnded) {
          session.sessionEnded = true;
          await this.handleSessionEnd(session, watch);
        }
        break;
      default:
        break;
    }
  }

  private applySessionContext(session: SessionState, fields: Record<string, unknown>): void {
    const cwd = typeof fields.cwd === 'string' ? fields.cwd : undefined;
    const project = typeof fields.project === 'string' ? fields.project : undefined;
    if (cwd) session.cwd = cwd;
    if (project) session.project = project;
  }

  private async handleSessionInit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
    // NOTE: session-init does NOT use the cwd-guard (unlike sendObservation).
    // The hook path creates the session row first with the correct project
    // (from the hook's cwd), and createSDKSession is write-once for project, so
    // even if the watcher's cwd is wrong here it cannot clobber the hook-set
    // project. The sessionId normalization (stripping "sess_") ensures the
    // watcher's session-init lands on the SAME row the hook already created.
    const cwd = session.cwd ?? process.cwd();

    // CWD_DIAG: THIS is the cross-project bug site. When session.cwd is empty,
    // we fall back to process.cwd() — the worker's startup dir (claude-mem) —
    // which attributes the session to the WRONG project. Log both values so a
    // mis-attribution is unambiguous. Also flag the dedup return (which happens
    // BEFORE this matters) separately below.
    logger.debug('TRANSCRIPT', 'CWD_DIAG handleSessionInit cwd-decision', {
      diag: 'handleSessionInit',
      sessionId: session.sessionId,
      platformSource: session.platformSource,
      hasSessionCwd: !!session.cwd,
      sessionCwd: session.cwd ?? null,
      fallbackProcessCwd: process.cwd(),
      chosenCwd: cwd,
      promptPreview: prompt ? prompt.slice(0, 80) : '(empty)',
    });

    // Dedup: rollout records carry full conversation history, so the same
    // user prompt appears in every subsequent record. Only trigger session-init
    // when the prompt is NEW (different from the last one we processed).
    // This mirrors how Claude Code's UserPromptSubmit hook fires once per prompt.
    if (prompt && prompt === session.lastUserMessage) {
      logger.debug('TRANSCRIPT', 'CWD_DIAG handleSessionInit dedup-skip', {
        diag: 'handleSessionInit-dedup', sessionId: session.sessionId,
      });
      return;
    }
    if (prompt) {
      session.lastUserMessage = prompt;
      // New prompt = new turn: reset session_end flag so the next finishReason=stop
      // triggers a fresh summary for this turn.
      session.sessionEnded = false;
    }

    await sessionInitHandler.execute({
      sessionId: session.sessionId,
      cwd,
      prompt,
      platform: session.platformSource
    });
  }

  private async handleToolUse(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolInput = this.maybeParseJson(fields.toolInput);
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    if (toolName === 'apply_patch' && typeof toolInput === 'string') {
      const files = this.parseApplyPatchFiles(toolInput);
      for (const filePath of files) {
        await this.sendFileEdit(session, {
          filePath,
          edits: [{ type: 'apply_patch', patch: toolInput }]
        });
      }
    }

    if (toolName && toolResponse !== undefined) {
      await this.sendObservation(session, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
    } else if (toolName && toolId) {
      if (!session.pendingTools) session.pendingTools = new Map();
      session.pendingTools.set(toolId, { toolName, toolInput });
    }
  }

  private async handleToolResult(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    let toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolResponse = this.maybeParseJson(fields.toolResponse);
    let toolInput = this.maybeParseJson(fields.toolInput);

    if (toolId && session.pendingTools) {
      const pending = session.pendingTools.get(toolId);
      if (pending) {
        if (!toolName) toolName = pending.toolName;
        if (toolInput === undefined) toolInput = pending.toolInput;
        session.pendingTools.delete(toolId);
      }
    }

    if (toolName) {
      await this.sendObservation(session, {
        toolName,
        toolInput,
        toolResponse,
        toolUseId: toolId,
      });
    } else {
      logger.debug('TRANSCRIPT', 'Dropping tool_result with no resolvable toolName', {
        sessionId: session.sessionId,
        toolId,
      });
    }
  }

  private async sendObservation(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    if (!toolName) return;

    // Dedup by toolUseId: rollout records replay full conversation history, so
    // the same tool call appears in every subsequent record. Skip if already sent.
    const toolUseId = typeof fields.toolUseId === 'string' ? fields.toolUseId : undefined;
    if (toolUseId) {
      if (!session.processedToolUseIds) session.processedToolUseIds = new Set();
      if (session.processedToolUseIds.has(toolUseId)) {
        logger.debug('TRANSCRIPT', 'Skipping duplicate tool observation (already sent)', {
          sessionId: session.sessionId, toolUseId, toolName,
        });
        return;
      }
      session.processedToolUseIds.add(toolUseId);
    }

    // cwd guard: when the session has no resolvable cwd (the schema could not
    // extract it AND the watch defines no workspace), SKIP the observation
    // rather than falling back to process.cwd(). The worker process's cwd is
    // fixed at startup and unrelated to the user's project, so using it would
    // attribute the observation to the WRONG project — the cross-project
    // "records all land under one project" bug. Dropping the record loses one
    // observation but never corrupts another project's memory.
    const cwd = session.cwd;
    if (!cwd) {
      logger.debug('TRANSCRIPT', 'Skipping observation with no resolvable session cwd (would mis-attribute project)', {
        sessionId: session.sessionId, toolName, toolUseId,
      });
      return;
    }

    const result = await ingestObservation({
      contentSessionId: session.sessionId,
      cwd,
      toolName,
      toolInput: this.maybeParseJson(fields.toolInput),
      toolResponse: this.maybeParseJson(fields.toolResponse),
      platformSource: session.platformSource,
      toolUseId,
    });

    if (!result.ok) {
      throw new Error(`ingestObservation failed: ${result.reason}`);
    }
  }

  private async sendFileEdit(session: SessionState, fields: Record<string, unknown>): Promise<void> {
    const filePath = typeof fields.filePath === 'string' ? fields.filePath : undefined;
    if (!filePath) return;

    // Same cwd guard: never fall back to process.cwd() (see sendObservation).
    if (!session.cwd) {
      logger.debug('TRANSCRIPT', 'Skipping file-edit with no resolvable session cwd (would mis-attribute project)', {
        sessionId: session.sessionId, filePath,
      });
      return;
    }

    await fileEditHandler.execute({
      sessionId: session.sessionId,
      cwd: session.cwd,
      filePath,
      edits: Array.isArray(fields.edits) ? fields.edits : undefined,
      platform: session.platformSource
    });
  }

  private maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      logger.debug('TRANSCRIPT', 'Field looked like JSON but did not parse; using raw string', {
        preview: trimmed.slice(0, 120),
      }, error instanceof Error ? error : undefined);
      return value;
    }
  }

  private parseApplyPatchFiles(patch: string): string[] {
    const files: string[] = [];
    const lines = patch.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*** Update File: ')) {
        files.push(trimmed.replace('*** Update File: ', '').trim());
      } else if (trimmed.startsWith('*** Add File: ')) {
        files.push(trimmed.replace('*** Add File: ', '').trim());
      } else if (trimmed.startsWith('*** Delete File: ')) {
        files.push(trimmed.replace('*** Delete File: ', '').trim());
      } else if (trimmed.startsWith('*** Move to: ')) {
        files.push(trimmed.replace('*** Move to: ', '').trim());
      } else if (trimmed.startsWith('+++ ')) {
        const path = trimmed.replace('+++ ', '').replace(/^b\//, '').trim();
        if (path && path !== '/dev/null') files.push(path);
      }
    }
    return Array.from(new Set(files));
  }

  private async handleSessionEnd(session: SessionState, watch: WatchTarget): Promise<void> {
    await this.queueSummary(session);
    await this.updateContext(session, watch);
    session.pendingTools?.clear();
    // Do NOT delete the session from the map — ZCode sessions are long-lived
    // (one rollout file per session). The sessionEnded flag prevents duplicate
    // session_end processing, and a new user prompt (session_init with a
    // different lastUserMessage) will naturally reset the flow for the next turn.
  }

  private async queueSummary(session: SessionState): Promise<void> {
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const lastAssistantMessage = session.lastAssistantMessage ?? '';
    const requestBody = JSON.stringify({
      contentSessionId: session.sessionId,
      last_assistant_message: lastAssistantMessage,
      platformSource: session.platformSource
    });

    try {
      await workerHttpRequest('/api/sessions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Summary request failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async updateContext(session: SessionState, watch: WatchTarget): Promise<void> {
    if (!watch.context) return;
    if (watch.context.mode !== 'agents') return;
    if (shouldSuppressNativeCodexAgentsContext(watch)) return;

    const workerReady = await ensureWorkerRunning();
    if (!workerReady) return;

    const cwd = session.cwd ?? watch.workspace;
    if (!cwd) return;

    const context = getProjectContext(cwd);
    const projectsParam = context.allProjects.join(',');

    const contextUrl = `/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;
    const agentsPath = expandHomePath(watch.context.path ?? `${cwd}/AGENTS.md`);

    const resolvedAgentsPath = path.resolve(agentsPath);
    const allowedRoots = [path.resolve(cwd), path.resolve(DATA_DIR)];
    const isPathSafe = allowedRoots.some(root => resolvedAgentsPath.startsWith(root + path.sep) || resolvedAgentsPath === root);
    if (!isPathSafe) {
      logger.warn('SECURITY', 'Rejected path traversal attempt in watch.context.path', {
        original: watch.context.path,
        resolved: resolvedAgentsPath,
        allowedRoots
      });
      return;
    }

    let response: Awaited<ReturnType<typeof workerHttpRequest>>;
    try {
      response = await workerHttpRequest(contextUrl);
    } catch (error: unknown) {
      logger.warn('TRANSCRIPT', 'Failed to fetch AGENTS.md context', {
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!response.ok) return;

    const content = (await response.text()).trim();
    if (!content) return;

    writeAgentsMd(agentsPath, content);
    logger.debug('TRANSCRIPT', 'Updated AGENTS.md context', { agentsPath, watch: watch.name });
  }
}
