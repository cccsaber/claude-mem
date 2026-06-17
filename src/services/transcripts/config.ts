import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { paths } from '../../shared/paths.js';
import type { TranscriptSchema, TranscriptWatchConfig } from './types.js';

export const DEFAULT_CONFIG_PATH = paths.transcriptsConfig();
export const DEFAULT_STATE_PATH = paths.transcriptsState();

export const CODEX_SAMPLE_SCHEMA: TranscriptSchema = {
  name: 'codex',
  version: '0.3',
  description: 'Legacy schema for Codex session JSONL files. Codex native hooks are preferred.',
  events: [
    {
      name: 'session-meta',
      match: { path: 'type', equals: 'session_meta' },
      action: 'session_context',
      fields: {
        sessionId: 'payload.id',
        cwd: 'payload.cwd'
      }
    },
    {
      name: 'turn-context',
      match: { path: 'type', equals: 'turn_context' },
      action: 'session_context',
      fields: {
        cwd: 'payload.cwd'
      }
    },
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        prompt: 'payload.message'
      }
    },
    {
      name: 'assistant-message',
      match: { path: 'payload.type', equals: 'agent_message' },
      action: 'assistant_message',
      fields: {
        message: 'payload.message'
      }
    },
    {
      name: 'tool-use',
      match: { path: 'payload.type', in: ['function_call', 'custom_tool_call', 'web_search_call'] },
      action: 'tool_use',
      fields: {
        toolId: 'payload.call_id',
        toolName: {
          coalesce: [
            'payload.name',
            'payload.type'
          ]
        },
        toolInput: {
          coalesce: [
            'payload.arguments',
            'payload.input',
            'payload.command',
            'payload.action'
          ]
        }
      }
    },
    {
      name: 'tool-result',
      match: { path: 'payload.type', in: ['function_call_output', 'custom_tool_call_output'] },
      action: 'tool_result',
      fields: {
        toolId: 'payload.call_id',
        toolResponse: 'payload.output'
      }
    },
    {
      name: 'exec-command-end',
      match: { path: 'payload.type', in: ['exec_command_end', 'exec_command_output'] },
      action: 'observation',
      fields: {
        toolUseId: 'payload.call_id',
        toolName: { value: 'exec_command' },
        toolInput: {
          coalesce: [
            'payload.command',
            'payload.input'
          ]
        },
        toolResponse: {
          coalesce: [
            'payload.aggregated_output',
            'payload.output',
            'payload.stdout',
            'payload.stderr'
          ]
        }
      }
    },
    {
      name: 'session-end',
      match: { path: 'payload.type', in: ['turn_aborted', 'turn_completed', 'task_complete'] },
      action: 'session_end'
    }
  ]
};

/**
 * ZCode (智谱 ADE) rollout JSONL schema.
 *
 * ZCode writes one JSONL record per model round-trip at:
 *   ~/.zcode/cli/rollout/model-io-sess_<id>.jsonl
 *
 * Each record has type:"model_io" and contains:
 *   - response.toolCalls[]  → {id, name, input}   (assistant tool_use)
 *   - request.body.messages[].content[].{type:"tool_result", tool_use_id, content}
 *       (the tool results from the PREVIOUS turn, sent back as user messages)
 *   - sessionId, turnId, traceId at the top level
 *
 * The processor's pendingTools mechanism pairs a tool_use (stored when a
 * toolCalls entry has no result yet) with the subsequent tool_result (matched
 * by tool_use_id) to emit a full observation — exactly the codex flow.
 *
 * cwd is NOT a structured field in model_io records, but it IS embedded in the
 * system prompt: request.body.system[2].text contains an "# Environment" block
 * with a "- Primary working directory: D:\\code\\db" line (verified stable at
 * index 2 across all main-session rollout records; subagent sessions omit the
 * block entirely). The zcode-session-context event extracts it via FieldSpec's
 * `extract` regex and caches it on the session, so subsequent tool_use /
 * tool_result observations resolve to the CORRECT project instead of falling
 * back to the worker process's cwd (which caused cross-project records to all
 * land under a single project — the original bug).
 *
 * Array wildcard paths ("toolCalls[].id", "messages[].content[].tool_use_id")
 * are resolved by getValueByPath's "[]" support, returning the first non-empty
 * match across array elements.
 */
export const ZCODE_SAMPLE_SCHEMA: TranscriptSchema = {
  name: 'zcode',
  // version is a migration fingerprint (migrateBuiltinSchemas): bump it whenever
  // the events/fields definition changes, so on-disk configs older than the bump
  // get refreshed on the next load.
  //   1.1 = added zcode-session-context cwd extract.
  //   1.2 = added sessionIdTransform { stripPrefix: 'sess_' }.
  version: '1.2',
  description: 'ZCode (GLM ADE) rollout JSONL. Mirrors Claude Code hooks: session_init (UserPromptSubmit), observation (PostToolUse), session_end (Stop).',
  sessionIdPath: 'sessionId',
  // ZCode's rollout records carry sessionId="sess_<uuid>" while the
  // UserPromptSubmit hook reports the bare "<uuid>". Strip the prefix so the
  // watcher's observations land on the SAME session row the hook created
  // (with the correct project). "sess_subagent_*" is a distinct namespace and
  // must NOT be stripped — the transform only matches a bare "sess_" prefix
  // followed by a UUID-shaped body.
  sessionIdTransform: { stripPrefix: 'sess_' },
  events: [
    {
      // Extract cwd from the system-prompt Environment block and cache it on
      // the session BEFORE any observation is emitted. Runs on every record
      // (the block is present in all main-session records) so session.cwd stays
      // fresh even across project switches within the same rollout file.
      // Mirrors codex's session-meta/turn-context session_context action.
      name: 'zcode-session-context',
      match: { path: 'request.body.system', exists: true },
      action: 'session_context',
      fields: {
        cwd: {
          path: 'request.body.system.2.text',
          // "Primary working directory: D:\code\db" followed by \n. The path may
          // contain backslashes (Windows) or forward slashes; stop at the line
          // break. JSON-decoded, the text holds literal backslashes, so the
          // regex matches a single backslash. Capture group 1 = the path.
          extract: 'Primary working directory: ([^\n]+)',
        },
      },
    },
    {
      // UserPromptSubmit equivalent: record the user's prompt.
      name: 'zcode-session-init',
      match: { path: 'request.messages[role=user,-<].content', exists: true },
      action: 'session_init',
      fields: {
        prompt: 'request.messages[role=user,-<].content',
      },
    },
    {
      // Capture the assistant's text response (response.text) so session_end
      // can use it as last_assistant_message for summary generation.
      name: 'zcode-assistant-message',
      match: { path: 'response.text', exists: true },
      action: 'assistant_message',
      fields: {
        message: 'response.text',
      },
    },
    {
      // PostToolUse equivalent: tool call (assistant issued a tool_use).
      name: 'zcode-tool-use',
      match: { path: 'response.toolCalls[].id', exists: true },
      action: 'observation',
      fields: {
        toolUseId: 'response.toolCalls[].id',
        toolName: 'response.toolCalls[].name',
        toolInput: 'response.toolCalls[].input',
      },
    },
    {
      // PostToolUse equivalent: tool result (from previous turn's tool calls).
      name: 'zcode-tool-result',
      match: { path: 'request.messages[].toolCallId', exists: true },
      action: 'observation',
      fields: {
        toolUseId: 'request.messages[].toolCallId',
        toolName: 'request.messages[].toolName',
        toolResponse: 'request.messages[].content',
      },
    },
    {
      // Stop equivalent: turn ended with no more tool calls (finishReason=stop).
      name: 'zcode-session-end',
      match: { path: 'response.finishReason', equals: 'stop' },
      action: 'session_end',
    },
  ],
};

export const SAMPLE_CONFIG: TranscriptWatchConfig = {
  version: 1,
  schemas: { zcode: ZCODE_SAMPLE_SCHEMA },
  watches: [
    {
      name: 'zcode',
      path: '~/.zcode/cli/rollout/model-io-sess_*.jsonl',
      schema: 'zcode',
      startAtEnd: true,
    },
  ],
  stateFile: DEFAULT_STATE_PATH
};

export function isNativeHookBackedCodexWatch(watch: { name?: string; path?: string; schema?: string | TranscriptSchema }): boolean {
  const schemaName = typeof watch.schema === 'string' ? watch.schema : watch.schema?.name;
  const nameOrSchemaIsCodex = watch.name === 'codex' || schemaName === 'codex';
  if (!nameOrSchemaIsCodex || !watch.path) return false;

  const normalizedPath = expandHomePath(watch.path).replace(/\\/g, '/');
  const codexSessionsRoot = join(homedir(), '.codex', 'sessions').replace(/\\/g, '/');
  return normalizedPath === `${codexSessionsRoot}/**/*.jsonl`;
}

export function shouldSuppressNativeCodexAgentsContext(watch: {
  name?: string;
  path?: string;
  schema?: string | TranscriptSchema;
  context?: { mode?: string };
}): boolean {
  const schemaName = typeof watch.schema === 'string' ? watch.schema : watch.schema?.name;
  const isCanonicalCodexWatch = watch.name === 'codex' && (!schemaName || schemaName === 'codex');
  return watch.context?.mode === 'agents' && isCanonicalCodexWatch && isNativeHookBackedCodexWatch(watch);
}

export function filterNativeHookBackedCodexWatches(
  config: TranscriptWatchConfig,
  allowCodexTranscriptIngestion: boolean
): { config: TranscriptWatchConfig; removed: number } {
  if (allowCodexTranscriptIngestion) {
    return { config, removed: 0 };
  }

  const watches = config.watches.filter(watch => !isNativeHookBackedCodexWatch(watch));
  return {
    config: {
      ...config,
      watches,
    },
    removed: config.watches.length - watches.length,
  };
}

export function expandHomePath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~')) {
    return join(homedir(), inputPath.slice(1));
  }
  return inputPath;
}

export function loadTranscriptWatchConfig(path = DEFAULT_CONFIG_PATH): TranscriptWatchConfig {
  const resolvedPath = expandHomePath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Transcript watch config not found: ${resolvedPath}`);
  }
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as TranscriptWatchConfig;
  if (!parsed.version || !parsed.watches) {
    throw new Error(`Invalid transcript watch config: ${resolvedPath}`);
  }
  if (!parsed.stateFile) {
    parsed.stateFile = DEFAULT_STATE_PATH;
  }
  // Migrate built-in schemas in place: the on-disk config may predate a schema
  // fix (e.g. the ZCode cwd-extraction session_context event). We refresh the
  // schema definition from the code constant whenever its `version` fingerprint
  // is older, so an upgrade takes effect without the user having to delete and
  // regenerate the config. Only the schema DEFINITION (events/match/fields) is
  // touched — watches, stateFile, and any user-added custom schemas are left
  // intact. Returns the (possibly updated) config and writes it back to disk.
  migrateBuiltinSchemas(parsed, resolvedPath);
  return parsed;
}

/**
 * Refresh built-in schema definitions (currently zcode) on the loaded config
 * when the on-disk copy's `version` is older than the code constant's. This is
 * the upgrade-migration seam: a schema fix shipped in code must reach an
 * already-written ~/.claude-mem/transcript-watch.json without requiring the
 * user to wipe it.
 *
 * Design notes:
 *  - Compares `schema.version` (a developer-bumped fingerprint string). When the
 *    disk value is missing or differs, the whole schema object is replaced with
 *    the code constant. We do NOT diff event-by-event — a version bump is an
 *    explicit signal that the definition changed.
 *  - Watches are untouched: a watch references a schema by NAME, so replacing
 *    the schema definition under the same name keeps every existing watch
 *    working with the new events.
 *  - User-defined custom schemas (any name not matching a built-in) are never
 *    touched.
 *  - The file is rewritten only when a migration actually happened, so a steady
 *    state incurs zero disk writes per startup.
 */
function migrateBuiltinSchemas(config: TranscriptWatchConfig, resolvedPath: string): boolean {
  if (!config.schemas || typeof config.schemas !== 'object') {
    config.schemas = {};
  }
  let changed = false;

  const builtins: Record<string, TranscriptSchema> = {
    zcode: ZCODE_SAMPLE_SCHEMA,
  };

  for (const [name, latest] of Object.entries(builtins)) {
    const onDisk = config.schemas[name];
    // Only migrate schemas we recognize as OURS: if the user hand-defined a
    // schema that happens to share a name but carries a different shape, a
    // version mismatch still triggers replacement — that is intentional, since
    // the built-in name is reserved. A user who wants a custom schema should
    // use a distinct name.
    if (!onDisk || onDisk.version !== latest.version) {
      config.schemas[name] = latest;
      changed = true;
    }
  }

  if (changed) {
    try {
      const dir = dirname(resolvedPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(resolvedPath, JSON.stringify(config, null, 2));
    } catch {
      // Non-fatal: the in-memory config is already migrated, so this run works
      // correctly. The disk write failing (permissions, full disk) just means
      // we retry the migration next startup.
    }
  }
  return changed;
}

export function writeSampleConfig(path = DEFAULT_CONFIG_PATH): void {
  const resolvedPath = expandHomePath(path);
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolvedPath, JSON.stringify(SAMPLE_CONFIG, null, 2));
}
