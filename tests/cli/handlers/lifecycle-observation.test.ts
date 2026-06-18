import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realWorkerUtils from '../../../src/shared/worker-utils.js';

const realHookSettingsSnapshot = { ...realHookSettings };
const realWorkerUtilsSnapshot = { ...realWorkerUtils };

const workerCalls: Array<{ path: string; method: string; body: any }> = [];

mock.module('../../../src/shared/hook-settings.js', () => ({
  loadFromFileOnce: () => ({
    CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_RUNTIME: 'worker',
  }),
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  executeWithWorkerFallback: async (path: string, method: string, body: any) => {
    workerCalls.push({ path, method, body });
    return { status: 'queued' };
  },
  isWorkerFallback: () => false,
}));

import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCalls.length = 0;
  loggerSpies.forEach(spy => spy.mockRestore());
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterAll(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/shared/worker-utils.js', () => realWorkerUtilsSnapshot);
});

describe('lifecycleObservationHandler', () => {
  it('records PermissionRequest as a non-blocking synthetic observation', async () => {
    const { lifecycleObservationHandler } = await import('../../../src/cli/handlers/lifecycle-observation.js');

    const result = await lifecycleObservationHandler.execute({
      sessionId: 'session-1',
      cwd: process.cwd(),
      platform: 'codex',
      hookEventName: 'PermissionRequest',
      turnId: 'turn-1',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolInput: { command: 'npm test', description: 'Run tests' },
      permissionMode: 'default',
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].path).toBe('/api/sessions/observations');
    expect(workerCalls[0].method).toBe('POST');
    expect(workerCalls[0].body).toMatchObject({
      contentSessionId: 'session-1',
      platformSource: 'codex',
      tool_name: 'CodexLifecycle:PermissionRequest',
      toolUseId: 'PermissionRequest:tool-1',
      cwd: process.cwd(),
    });
    expect(workerCalls[0].body.tool_input).toMatchObject({
      hook_event_name: 'PermissionRequest',
      turn_id: 'turn-1',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_use_id: 'tool-1',
      tool_input: { command: 'npm test', description: 'Run tests' },
    });
  });

  it('records SubagentStop with agent metadata and final response text', async () => {
    const { lifecycleObservationHandler } = await import('../../../src/cli/handlers/lifecycle-observation.js');

    const result = await lifecycleObservationHandler.execute({
      sessionId: 'session-2',
      cwd: process.cwd(),
      platform: 'codex',
      hookEventName: 'SubagentStop',
      turnId: 'turn-2',
      agentId: 'agent-abc',
      agentType: 'Explore',
      agentTranscriptPath: '/tmp/subagent.jsonl',
      lastAssistantMessage: 'subagent done',
      stopHookActive: false,
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0].body).toMatchObject({
      contentSessionId: 'session-2',
      platformSource: 'codex',
      tool_name: 'CodexLifecycle:SubagentStop',
      agentId: 'agent-abc',
      agentType: 'Explore',
    });
    expect(workerCalls[0].body.tool_input).toMatchObject({
      hook_event_name: 'SubagentStop',
      turn_id: 'turn-2',
      agent_id: 'agent-abc',
      agent_type: 'Explore',
      agent_transcript_path: '/tmp/subagent.jsonl',
    });
    expect(workerCalls[0].body.tool_response).toEqual({
      event: 'SubagentStop',
      last_assistant_message: 'subagent done',
      stop_hook_active: false,
    });
  });
});
