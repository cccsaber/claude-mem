import type { HookResult, NormalizedHookInput, PlatformAdapter } from '../types.js';
import { AdapterRejectedInput, isValidCwd } from './errors.js';

// ZCode (智谱 ADE, GLM) is a Claude-Code-derived kernel. It fires the same
// SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop events,
// but the stdin JSON payload differs from Claude Code in three load-bearing
// ways (verified against D:\Program Files\ZCode\resources\glm\zcode.cjs):
//
//   1. Fields are camelCase: sessionId / toolName / toolInput / turnId, not
//      the snake_case session_id / tool_name / tool_input / turn_id that the
//      claude-code adapter reads.
//   2. PostToolUse carries `toolResultPreview` (a truncated preview), NOT a
//      full `tool_response`. We map the preview onto NormalizedHookInput.
//      toolResponse so the observation handler still records something; the
//      truncation is a known limitation and noted below.
//   3. There is no `transcript_path`. Extra diagnostic fields unique to ZCode
//      (toolCallId, mode, traceId) are preserved in `metadata` for telemetry.
//
// The platform string `zcode` flows through to normalizePlatformSource()
// (fallback branch, returns 'zcode' verbatim), which is written to
// sdk_sessions.platform_source. That column is audit/telemetry only: the
// context-injection read path (ObservationCompiler) filters by `project`
// alone, so ZCode and Claude Code observations in the same repo share memory.

type ZCodeEventName =
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'Stop';

const EVENT_NAMES = new Set<ZCodeEventName>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
]);

function eventName(value: unknown): ZCodeEventName | undefined {
  return typeof value === 'string' && EVENT_NAMES.has(value as ZCodeEventName)
    ? value as ZCodeEventName
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cloneToolInput(toolInput: unknown): unknown {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    return { ...(toolInput as Record<string, unknown>) };
  }
  return toolInput;
}

function buildBaseOutput(result: HookResult): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (result.continue !== undefined) output.continue = result.continue;
  if (result.systemMessage) output.systemMessage = result.systemMessage;
  if (result.decision === 'block') output.decision = 'block';
  if (result.reason) output.reason = result.reason;
  return output;
}

function inferOutputEvent(result: HookResult): ZCodeEventName | undefined {
  return eventName(result.hookSpecificOutput?.hookEventName);
}

export const zcodeAdapter: PlatformAdapter = {
  normalizeInput(raw): NormalizedHookInput {
    const r = (raw ?? {}) as Record<string, unknown>;
    const cwd = typeof r.cwd === 'string' ? r.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput('invalid_cwd');
    }

    const sessionId = stringOrUndefined(r.sessionId);
    if (!sessionId) {
      throw new AdapterRejectedInput('missing_session_id');
    }

    const toolName = stringOrUndefined(r.toolName);
    const toolInput = cloneToolInput(r.toolInput);

    // ZCode's PostToolUse hands us `toolResultPreview` (a truncated preview of
    // the tool result) instead of a full tool_response. We accept it as-is;
    // truncation is a known limitation to revisit if ZCode later exposes the
    // full payload.
    const toolResponse = r.toolResultPreview;

    const metadata: Record<string, unknown> = {};
    if (r.toolCallId !== undefined) metadata.toolCallId = r.toolCallId;
    if (r.mode !== undefined) metadata.mode = r.mode;
    if (r.traceId !== undefined) metadata.traceId = r.traceId;
    if (r.timestamp !== undefined) metadata.timestamp = r.timestamp;

    return {
      sessionId,
      cwd,
      prompt: stringOrUndefined(r.prompt),
      toolName,
      toolInput,
      toolResponse,
      // ZCode does not emit a transcript_path.
      turnId: stringOrUndefined(r.turnId),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  },

  formatOutput(result): unknown {
    const r = result ?? {};
    const output = buildBaseOutput(r);
    const hookSpecific = r.hookSpecificOutput;
    const outputEvent = inferOutputEvent(r);

    // ZCode is a Claude-Code-derived kernel and reads the same
    // hookSpecificOutput shape (additionalContext for context injection,
    // permissionDecision / updatedInput for PreToolUse gating). This mirrors
    // the codex adapter's formatOutput so the context handler's
    // additionalContext is delivered to the model on SessionStart.
    if (!hookSpecific || !outputEvent || outputEvent === 'Stop') {
      return output;
    }

    const specific: Record<string, unknown> = {
      hookEventName: outputEvent,
    };

    if (hookSpecific.additionalContext) {
      specific.additionalContext = hookSpecific.additionalContext;
    }

    if (outputEvent === 'PreToolUse') {
      if (hookSpecific.permissionDecision === 'deny') {
        specific.permissionDecision = 'deny';
        if (hookSpecific.permissionDecisionReason) {
          specific.permissionDecisionReason = hookSpecific.permissionDecisionReason;
        }
      }
      if (hookSpecific.updatedInput) {
        specific.updatedInput = hookSpecific.updatedInput;
      }
    }

    output.hookSpecificOutput = specific;
    return output;
  },
};
