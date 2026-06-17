import { describe, it, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCodexConversationPrompt,
  buildCodexExecArgs,
  parseCodexTomlStringSetting,
  resolveCodexTempRoot,
  resolveCodexModel,
} from '../../src/services/worker/CodexProvider.js';

describe('CodexProvider helpers', () => {
  it('parses Codex config string settings without exposing secrets', () => {
    const config = `
model = "gpt-5.5"

[mcp_servers.node_repl.env]
CODEX_CLI_PATH = 'C:\\Users\\alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe'
`;
    expect(parseCodexTomlStringSetting(config, 'model')).toBe('gpt-5.5');
    expect(parseCodexTomlStringSetting(config, 'CODEX_CLI_PATH')).toBe('C:\\Users\\alice\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe');
  });

  it('uses the Codex config model, then falls back to gpt-5.5', () => {
    expect(resolveCodexModel({ configText: 'model = "gpt-5.5"' })).toBe('gpt-5.5');
    expect(resolveCodexModel({ configText: '' })).toBe('gpt-5.5');
  });

  it('builds an isolated codex exec invocation that reuses auth but skips user config/hooks', () => {
    const args = buildCodexExecArgs({
      model: 'gpt-5.5',
      cwd: 'C:\\tmp\\claude-mem',
      outputLastMessagePath: 'C:\\tmp\\last-message.txt',
    });

    expect(args).toContain('exec');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('-o');
    expect(args[args.length - 1]).toBe('-');
  });

  it('flattens multi-turn history and tells Codex not to use tools', () => {
    const prompt = buildCodexConversationPrompt([
      { role: 'user', content: '<observation>first</observation>' },
      { role: 'assistant', content: '<observation><type>decision</type></observation>' },
      { role: 'user', content: '<summary>final</summary>' },
    ]);

    expect(prompt).toContain('Do not use tools');
    expect(prompt).toContain('role="USER"');
    expect(prompt).toContain('role="ASSISTANT"');
    expect(prompt).toContain('<summary>final</summary>');
  });

  it('falls back to DATA_DIR/temp when Bun reports an invalid Windows tmpdir', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-data-'));
    try {
      const resolved = resolveCodexTempRoot({
        env: {},
        osTmpDir: 'undefined\\temp',
        dataDir,
      });

      expect(resolved).toBe(join(dataDir, 'temp'));
      expect(existsSync(resolved)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('uses a valid TEMP env var when os.tmpdir is unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-temp-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-codex-data-'));
    try {
      const resolved = resolveCodexTempRoot({
        env: { TEMP: root },
        osTmpDir: 'undefined\\temp',
        dataDir,
      });

      expect(resolved).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
