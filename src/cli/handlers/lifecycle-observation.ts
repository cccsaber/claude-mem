// Records Codex lifecycle hooks that are not ordinary tool completions.
// These hooks must stay non-blocking: they enrich memory, never decide policy.
import type { EventHandler, HookResult, NormalizedHookInput } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { recordObservationInput } from './observation.js';

const SYNTHETIC_TOOL_PREFIX = 'CodexLifecycle';

function definedEntries(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null)
  );
}

function syntheticToolName(eventName: string | undefined): string {
  return eventName ? `${SYNTHETIC_TOOL_PREFIX}:${eventName}` : SYNTHETIC_TOOL_PREFIX;
}

function syntheticToolUseId(input: NormalizedHookInput): string | undefined {
  if (!input.toolUseId || !input.hookEventName) return undefined;
  return `${input.hookEventName}:${input.toolUseId}`;
}

function buildLifecycleToolInput(input: NormalizedHookInput): Record<string, unknown> {
  return definedEntries({
    hook_event_name: input.hookEventName,
    turn_id: input.turnId,
    trigger: input.trigger,
    permission_mode: input.permissionMode,
    model: input.model,
    source: input.sessionSource,
    tool_name: input.toolName,
    tool_input: input.toolInput,
    tool_use_id: input.toolUseId,
    transcript_path: input.transcriptPath,
    agent_id: input.agentId,
    agent_type: input.agentType,
    agent_transcript_path: input.agentTranscriptPath,
  });
}

function buildLifecycleToolResponse(input: NormalizedHookInput): Record<string, unknown> {
  return definedEntries({
    event: input.hookEventName,
    last_assistant_message: input.lastAssistantMessage,
    stop_hook_active: input.stopHookActive,
  });
}

export const lifecycleObservationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    await recordObservationInput({
      ...input,
      toolName: syntheticToolName(input.hookEventName),
      toolInput: buildLifecycleToolInput(input),
      toolResponse: buildLifecycleToolResponse(input),
      toolUseId: syntheticToolUseId(input),
    });

    // PermissionRequest and PreToolUse do not support `continue` in Codex hook
    // JSON output. Emit an empty success body through the adapter.
    return { exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
