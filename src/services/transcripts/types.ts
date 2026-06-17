export type FieldSpec =
  | string
  | {
      path?: string;
      value?: unknown;
      coalesce?: FieldSpec[];
      default?: unknown;
      /**
       * Regex applied to the resolved (string) value to extract a substring —
       * the FIRST capture group is returned. Used when a target value lives
       * embedded in free-text (e.g. ZCode's "Primary working directory: D:\code"
       * line inside a system-prompt block) rather than a structured field.
       * A non-matching value falls through to default/undefined. An invalid
       * regex logs a debug warning and returns the raw value.
       */
      extract?: string;
    };

export interface MatchRule {
  path?: string;
  equals?: unknown;
  not_equals?: unknown;
  in?: unknown[];
  not_in?: unknown[];
  contains?: string;
  not_contains?: string;
  exists?: boolean;
  regex?: string;
}

export type EventAction =
  | 'session_init'
  | 'session_context'
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'observation'
  | 'file_edit'
  | 'session_end';

export interface SchemaEvent {
  name: string;
  match?: MatchRule;
  action: EventAction;
  fields?: Record<string, FieldSpec>;
}

export interface TranscriptSchema {
  name: string;
  version?: string;
  description?: string;
  eventTypePath?: string;
  sessionIdPath?: string;
  cwdPath?: string;
  projectPath?: string;
  /**
   * Transform applied to the sessionId resolved from a transcript record, so it
   * matches the sessionId the hook path reports. Without this, platforms whose
   * transcript uses a DIFFERENT id format than their hooks (e.g. ZCode writes
   * "sess_<uuid>" in rollout records but the UserPromptSubmit hook reports the
   * bare "<uuid>") would create a second sdk_sessions row under the prefixed id,
   * never reusing the correct session the hook already established.
   *
   * - { stripPrefix: "sess_" } removes a leading "sess_" (but not "sess_subagent_").
   * - undefined (default) leaves the sessionId unchanged (codex, cursor, etc.).
   */
  sessionIdTransform?: { stripPrefix: string };
  events: SchemaEvent[];
}

export interface WatchContextConfig {
  mode: 'agents';
  path?: string;
  updateOn?: Array<'session_start' | 'session_end'>;
}

export interface WatchTarget {
  name: string;
  path: string;
  schema: string | TranscriptSchema;
  workspace?: string;
  project?: string;
  context?: WatchContextConfig;
  startAtEnd?: boolean;
}

export interface TranscriptWatchConfig {
  version: 1;
  schemas?: Record<string, TranscriptSchema>;
  watches: WatchTarget[];
  stateFile?: string;
}
