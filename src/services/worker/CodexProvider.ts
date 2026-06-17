import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { spawnHidden } from '../../shared/spawn.js';
import { DATA_DIR, ensureDir } from '../../shared/paths.js';
import { estimateTokens } from '../../shared/timeline-formatting.js';
import { logger } from '../../utils/logger.js';
import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ModeConfig } from '../domain/types.js';
import { processAgentResponse, isAbortError, type WorkerRef } from './agents/index.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';

const DEFAULT_CODEX_MODEL = 'gpt-5.5';
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const DEFAULT_TIMEOUT_MS = 300000;

interface CodexQueryResult {
  content: string;
}

interface CodexConfig {
  cliPath: string;
  model: string;
  cwd: string;
  timeoutMs: number;
}

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'config.toml');
}

function readCodexConfigText(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const path = codexConfigPath(env);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  } catch {
    return '';
  }
}

function parseTomlStringValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return null;
  const body = trimmed.slice(1, -1);
  if (quote === "'") return body;
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

export function parseCodexTomlStringSetting(configText: string, key: string): string | null {
  const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${keyPattern}\\s*=\\s*([^#\\r\\n]+)`, 'm');
  const match = configText.match(pattern);
  if (!match) return null;
  return parseTomlStringValue(match[1])?.trim() || null;
}

function findCommandPath(command: string): string | null {
  try {
    if (process.platform === 'win32') {
      const result = execFileSync('where', [command], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).split(/\r?\n/).map(line => line.trim()).find(Boolean);
      return result || null;
    } else {
      const result = execFileSync('which', [command], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result || null;
    }
  } catch {
    return null;
  }
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value);
}

function candidateUsable(candidate: string): boolean {
  if (!candidate) return false;
  if (looksLikePath(candidate)) return existsSync(candidate);
  return findCommandPath(candidate) !== null;
}

export function resolveCodexCliPath(input?: {
  env?: NodeJS.ProcessEnv;
  configText?: string;
}): string {
  const env = input?.env ?? process.env;
  const configText = input?.configText ?? readCodexConfigText(env);
  const candidates = [
    env.CODEX_CLI_PATH,
    parseCodexTomlStringSetting(configText, 'CODEX_CLI_PATH'),
    'codex',
  ]
    .map(value => value?.trim())
    .filter((value): value is string => !!value);

  for (const candidate of candidates) {
    if (looksLikePath(candidate) && existsSync(candidate)) return candidate;
    if (!looksLikePath(candidate)) {
      const resolved = findCommandPath(candidate);
      if (resolved) return resolved;
    }
  }

  return candidates[0] ?? 'codex';
}

export function resolveCodexModel(input?: {
  configText?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const configText = input?.configText ?? readCodexConfigText(input?.env ?? process.env);
  return parseCodexTomlStringSetting(configText, 'model')
    || DEFAULT_CODEX_MODEL;
}

export function buildCodexExecArgs(input: {
  model: string;
  cwd: string;
  outputLastMessagePath: string;
}): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-m',
    input.model,
    '-C',
    input.cwd,
    '-o',
    input.outputLastMessagePath,
    '-',
  ];
}

export function buildCodexConversationPrompt(history: ConversationMessage[]): string {
  const transcript = history.map((message, index) => {
    const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER';
    return `<turn index="${index + 1}" role="${role}">\n${message.content}\n</turn>`;
  }).join('\n\n');

  return [
    'You are claude-mem\'s observer compression model running through Codex.',
    'Continue the transcript below. The final USER turn is the current task.',
    'Follow the XML/protocol instructions inside the USER turns exactly.',
    'Do not use tools. Return only the assistant response for the current task.',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
  ].join('\n');
}

export function classifyCodexError(err: unknown): ClassifiedProviderError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const errAny = err as { code?: string; status?: number };

  if (
    errAny.code === 'ENOENT' ||
    lower.includes('not found') ||
    lower.includes('could not find') ||
    lower.includes('enoent')
  ) {
    return new ClassifiedProviderError(message, { kind: 'unrecoverable', cause: err });
  }

  if (
    lower.includes('not logged in') ||
    lower.includes('login required') ||
    lower.includes('please log in') ||
    lower.includes('authentication') ||
    lower.includes('unauthorized')
  ) {
    return new ClassifiedProviderError(message, { kind: 'auth_invalid', cause: err });
  }

  if (
    lower.includes('quota') ||
    lower.includes('weekly limit') ||
    lower.includes('usage limit') ||
    lower.includes('insufficient credits')
  ) {
    return new ClassifiedProviderError(message, { kind: 'quota_exhausted', cause: err });
  }

  if (errAny.status === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new ClassifiedProviderError(message, { kind: 'rate_limit', cause: err });
  }

  return new ClassifiedProviderError(message, { kind: 'transient', cause: err });
}

export class CodexProvider {
  constructor(
    private dbManager: DatabaseManager,
    private sessionManager: SessionManager
  ) {}

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = this.getCodexConfig();
    session.lastModelId = config.model;
    session.endpointClass = undefined;

    if (!isCodexAvailable()) {
      throw new Error('Codex platform request received, but Codex CLI was not found. Install/login to Codex so claude-mem can reuse Codex login state.');
    }

    if (!session.memorySessionId) {
      const syntheticMemorySessionId = `codex-${session.contentSessionId}-${Date.now()}`;
      session.memorySessionId = syntheticMemorySessionId;
      this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
      logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Codex`);
    }

    const mode = ModeManager.getInstance().getActiveMode();
    const initPrompt = session.lastPromptNumber === 1
      ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
      : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

    session.conversationHistory.push({ role: 'user', content: initPrompt });

    try {
      session.lastPromptSentAt = Date.now();
      session.lastGeneratorSource = 'init';
      const initResponse = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
      await this.handleResponse(initResponse, session, worker, null, undefined, config.model);
    } catch (error: unknown) {
      logger.error('SDK', 'Codex init failed', { sessionId: session.sessionDbId, model: config.model }, error instanceof Error ? error : new Error(String(error)));
      return this.handleCodexError(error, session);
    }

    let lastCwd: string | undefined;

    try {
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.pendingAgentId = message.agentId ?? null;
        session.pendingAgentType = message.agentType ?? null;

        if (message.cwd) {
          lastCwd = message.cwd;
        }
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          await this.processObservationMessage(session, message, worker, config, originalTimestamp, lastCwd);
        } else if (message.type === 'summarize') {
          await this.processSummaryMessage(session, message, worker, config, mode, originalTimestamp, lastCwd);
        }
      }
    } catch (error: unknown) {
      logger.error('SDK', 'Codex message processing failed', { sessionId: session.sessionDbId, model: config.model }, error instanceof Error ? error : new Error(String(error)));
      return this.handleCodexError(error, session);
    }

    logger.success('SDK', 'Codex agent completed', {
      sessionId: session.sessionDbId,
      duration: `${((Date.now() - session.startTime) / 1000).toFixed(1)}s`,
      historyLength: session.conversationHistory.length,
      model: config.model,
    });
  }

  private async processObservationMessage(
    session: ActiveSession,
    message: { prompt_number?: number; tool_name?: string; tool_input?: unknown; tool_response?: unknown; cwd?: string },
    worker: WorkerRef | undefined,
    config: CodexConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (message.prompt_number !== undefined) {
      session.lastPromptNumber = message.prompt_number;
    }

    if (!session.memorySessionId) {
      throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: message.tool_name!,
      tool_input: JSON.stringify(message.tool_input),
      tool_output: JSON.stringify(message.tool_response),
      created_at_epoch: originalTimestamp ?? Date.now(),
      cwd: message.cwd,
    });

    session.conversationHistory.push({ role: 'user', content: obsPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'ingest';
    const response = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
    await this.handleResponse(response, session, worker, originalTimestamp, lastCwd, config.model);
  }

  private async processSummaryMessage(
    session: ActiveSession,
    message: { last_assistant_message?: string },
    worker: WorkerRef | undefined,
    config: CodexConfig,
    mode: ModeConfig,
    originalTimestamp: number | null,
    lastCwd: string | undefined
  ): Promise<void> {
    if (!session.memorySessionId) {
      throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
    }

    const summaryPrompt = buildSummaryPrompt({
      id: session.sessionDbId,
      memory_session_id: session.memorySessionId,
      project: session.project,
      user_prompt: session.userPrompt,
      last_assistant_message: message.last_assistant_message || '',
    }, mode);

    session.conversationHistory.push({ role: 'user', content: summaryPrompt });
    session.lastPromptSentAt = Date.now();
    session.lastGeneratorSource = 'summarize';
    const response = await this.queryCodexMultiTurn(session.conversationHistory, config, session.abortController.signal);
    await this.handleResponse(response, session, worker, originalTimestamp, lastCwd, config.model);
  }

  private async handleResponse(
    response: CodexQueryResult,
    session: ActiveSession,
    worker: WorkerRef | undefined,
    originalTimestamp: number | null,
    lastCwd: string | undefined,
    model: string
  ): Promise<void> {
    if (!response.content) {
      logger.warn('SDK', 'Empty Codex response, leaving queue intact', { sessionId: session.sessionDbId, model });
      return;
    }

    session.conversationHistory.push({ role: 'assistant', content: response.content });
    session.lastUsage = null;
    await processAgentResponse(
      response.content,
      session,
      this.dbManager,
      this.sessionManager,
      worker,
      0,
      originalTimestamp,
      'Codex',
      lastCwd,
      model
    );
  }

  private handleCodexError(error: unknown, session: ActiveSession): never {
    if (isAbortError(error)) {
      logger.warn('SDK', 'Codex agent aborted', { sessionId: session.sessionDbId });
      throw error;
    }

    throw classifyCodexError(error);
  }

  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const maxMessages = DEFAULT_MAX_CONTEXT_MESSAGES;
    const maxTokens = DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= maxMessages) {
      const totalTokens = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
      if (totalTokens <= maxTokens) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      const messageTokens = estimateTokens(message.content);
      if (truncated.length > 0 && (truncated.length >= maxMessages || tokenCount + messageTokens > maxTokens)) {
        logger.warn('SDK', 'Codex context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: maxTokens,
        });
        break;
      }
      truncated.unshift(message);
      tokenCount += messageTokens;
    }

    return truncated;
  }

  private async queryCodexMultiTurn(
    history: ConversationMessage[],
    config: CodexConfig,
    signal: AbortSignal
  ): Promise<CodexQueryResult> {
    const truncatedHistory = this.truncateHistory(history);
    const prompt = buildCodexConversationPrompt(truncatedHistory);
    const tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-'));
    const outputLastMessagePath = join(tempDir, 'last-message.txt');
    const args = buildCodexExecArgs({
      model: config.model,
      cwd: config.cwd,
      outputLastMessagePath,
    });

    logger.info('SDK', 'Starting Codex exec query', {
      cliPath: config.cliPath,
      model: config.model,
      turns: truncatedHistory.length,
      totalTurns: history.length,
      totalChars: truncatedHistory.reduce((sum, message) => sum + message.content.length, 0),
    });

    try {
      const { stdout, stderr } = await this.runCodexExec(config.cliPath, args, prompt, config.timeoutMs, signal);
      let content = '';
      try {
        content = existsSync(outputLastMessagePath) ? readFileSync(outputLastMessagePath, 'utf-8') : '';
      } catch {
        content = '';
      }
      const fallback = stdout.trim();
      const finalContent = content.trim() || fallback;
      if (!finalContent && stderr.trim()) {
        logger.warn('SDK', 'Codex exec returned no final message but wrote stderr', {
          stderr: stderr.slice(0, 500),
        });
      }
      return { content: finalContent };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private async runCodexExec(
    cliPath: string,
    args: string[],
    prompt: string,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CODEX_HOME: codexHome(),
      };
      const child = spawnHidden(cliPath, args, {
        cwd: DATA_DIR,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const killChild = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // best-effort
        }
      };

      const onAbort = () => {
        killChild();
        finish(() => reject(new Error('Codex exec aborted')));
      };

      const timer = setTimeout(() => {
        killChild();
        finish(() => reject(new Error(`Codex exec timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      timer.unref?.();

      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
      });
      child.stderr?.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
      });

      child.on('error', error => {
        finish(() => reject(error));
      });

      child.on('close', code => {
        if (code === 0) {
          finish(() => resolve({ stdout, stderr }));
          return;
        }
        const message = `Codex exec failed with exit code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim().slice(0, 1000)}` : ''}`;
        finish(() => reject(new Error(message)));
      });

      child.stdin?.end(prompt);
    });
  }

  private getCodexConfig(): CodexConfig {
    ensureDir(DATA_DIR);
    const cliPath = resolveCodexCliPath();
    const model = resolveCodexModel();
    const timeoutMs = DEFAULT_TIMEOUT_MS;

    return {
      cliPath,
      model,
      cwd: DATA_DIR,
      timeoutMs,
    };
  }
}

export function isCodexAvailable(): boolean {
  const cliPath = resolveCodexCliPath();
  return candidateUsable(cliPath);
}
