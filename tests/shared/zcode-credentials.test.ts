import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseZcodeProviderKeys,
  readZcodeApiKey,
  DEFAULT_BIGMODEL_ANTHROPIC_URL,
} from '../../src/shared/zcode-credentials.js';

/**
 * ZCode client credential sourcing — reads bigmodel API key from the ZCode
 * desktop client's userData file (inner-provider-api-keys.dat). Mirrors the
 * oauth-token.test.ts pattern: the parse layer is tested directly, and the
 * file-read layer is exercised via a temp dir + CLAUDE_MEM_ZCODE_CREDENTIALS_DIR
 * override so no real ZCode install is required.
 */

const ORIGINAL_DIR_ENV = process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_DIR;
const ORIGINAL_PATH_ENV = process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH;

function validPayload(apiKey = '42aa43293db74a4485ca4db458415512.KUFr1egSAj9zApWG'): string {
  return JSON.stringify({
    apiKeys: {
      bigmodel: { apiKey, isActive: true, providerId: 'bigmodel' },
    },
  });
}

describe('parseZcodeProviderKeys — parse layer', () => {
  it('returns present when bigmodel key is active', () => {
    const r = parseZcodeProviderKeys(validPayload());
    expect(r.kind).toBe('present');
    if (r.kind === 'present') {
      expect(r.apiKey).toBe('42aa43293db74a4485ca4db458415512.KUFr1egSAj9zApWG');
      expect(r.source).toBe('zcode-client');
    }
  });

  it('returns absent when isActive is false', () => {
    const raw = JSON.stringify({
      apiKeys: { bigmodel: { apiKey: 'sk-x', isActive: false, providerId: 'bigmodel' } },
    });
    expect(parseZcodeProviderKeys(raw).kind).toBe('absent');
  });

  it('treats missing isActive as active (only explicit false disables)', () => {
    const raw = JSON.stringify({
      apiKeys: { bigmodel: { apiKey: 'sk-x', providerId: 'bigmodel' } },
    });
    const r = parseZcodeProviderKeys(raw);
    expect(r.kind).toBe('present');
  });

  it('returns absent when bigmodel provider entry is missing', () => {
    const raw = JSON.stringify({ apiKeys: { openai: { apiKey: 'sk-x', isActive: true } } });
    const r = parseZcodeProviderKeys(raw);
    expect(r.kind).toBe('absent');
    if (r.kind === 'absent') expect(r.reason).toContain('bigmodel');
  });

  it('returns absent when apiKey is empty / whitespace', () => {
    for (const empty of ['', '   ']) {
      const raw = JSON.stringify({
        apiKeys: { bigmodel: { apiKey: empty, isActive: true, providerId: 'bigmodel' } },
      });
      expect(parseZcodeProviderKeys(raw).kind).toBe('absent');
    }
  });

  it('trims whitespace from the key', () => {
    const raw = JSON.stringify({
      apiKeys: { bigmodel: { apiKey: '  sk-padded  ', isActive: true, providerId: 'bigmodel' } },
    });
    const r = parseZcodeProviderKeys(raw);
    expect(r.kind).toBe('present');
    if (r.kind === 'present') expect(r.apiKey).toBe('sk-padded');
  });

  it('returns absent when JSON is malformed', () => {
    const r = parseZcodeProviderKeys('{not json');
    expect(r.kind).toBe('absent');
    if (r.kind === 'absent') expect(r.reason).toContain('JSON');
  });

  it('returns absent when apiKeys object is missing', () => {
    const r = parseZcodeProviderKeys(JSON.stringify({ foo: 'bar' }));
    expect(r.kind).toBe('absent');
  });
});

describe('readZcodeApiKey — file-read layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cm-zcode-cred-'));
    process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_DIR = tempDir;
    delete process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (ORIGINAL_DIR_ENV === undefined) delete process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_DIR;
    else process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_DIR = ORIGINAL_DIR_ENV;
    if (ORIGINAL_PATH_ENV === undefined) delete process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH;
    else process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH = ORIGINAL_PATH_ENV;
  });

  it('reads the key from a valid file', () => {
    writeFileSync(join(tempDir, 'inner-provider-api-keys.dat'), validPayload());
    const r = readZcodeApiKey();
    expect(r.kind).toBe('present');
    if (r.kind === 'present') expect(r.apiKey).toBe('42aa43293db74a4485ca4db458415512.KUFr1egSAj9zApWG');
  });

  it('returns absent when the file does not exist', () => {
    const r = readZcodeApiKey();
    expect(r.kind).toBe('absent');
    if (r.kind === 'absent') expect(r.reason).toContain('not found');
  });

  it('returns absent when the file is corrupt', () => {
    writeFileSync(join(tempDir, 'inner-provider-api-keys.dat'), 'corrupt {{{');
    expect(readZcodeApiKey().kind).toBe('absent');
  });

  it('honors CLAUDE_MEM_ZCODE_CREDENTIALS_PATH (explicit file override)', () => {
    const custom = join(tempDir, 'custom-creds.dat');
    writeFileSync(custom, validPayload('sk-from-custom-path'));
    process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH = custom;
    const r = readZcodeApiKey();
    expect(r.kind).toBe('present');
    if (r.kind === 'present') expect(r.apiKey).toBe('sk-from-custom-path');
  });
});

describe('DEFAULT_BIGMODEL_ANTHROPIC_URL', () => {
  it('points at the bigmodel Anthropic-compatible gateway', () => {
    expect(DEFAULT_BIGMODEL_ANTHROPIC_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });
});
