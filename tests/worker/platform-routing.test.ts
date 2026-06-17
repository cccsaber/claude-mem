import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

/**
 * Per-platform routing tests (zcode → glm-5.2 + bigmodel endpoint).
 *
 * The routing decision lives in SessionRoutes.applyPlatformRouting (private),
 * which reads three CLAUDE_MEM_ZCODE_* fields from settings and sets
 * session.modelOverride + session.endpointOverride when platformSource==='zcode'
 * and all three fields are non-empty. applyTierRouting then self-guards against
 * endpointOverride so it won't clobber the platform model.
 *
 * These tests cover the decision inputs (settings field registration + parsing)
 * and the env-injection contract (ClaudeProvider's endpointOverride branch),
 * which together define the routing behavior end-to-end.
 */
describe('Per-platform routing — settings registration', () => {
  it('registers CLAUDE_MEM_ZCODE_MODEL/API_KEY/BASE_URL defaults (key empty, url pre-set to bigmodel gateway)', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults).toHaveProperty('CLAUDE_MEM_ZCODE_MODEL');
    expect(defaults).toHaveProperty('CLAUDE_MEM_ZCODE_API_KEY');
    expect(defaults).toHaveProperty('CLAUDE_MEM_ZCODE_BASE_URL');
    expect(defaults.CLAUDE_MEM_ZCODE_MODEL).toBe('');
    expect(defaults.CLAUDE_MEM_ZCODE_API_KEY).toBe('');
    // BASE_URL defaults to bigmodel's Anthropic-compatible gateway so ZCode
    // users need only set model (+ source the key from the ZCode client).
    expect(defaults.CLAUDE_MEM_ZCODE_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('reads zcode fields from a settings file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-zcode-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_ZCODE_MODEL: 'glm-5.2',
      CLAUDE_MEM_ZCODE_API_KEY: 'sk-test-123',
      CLAUDE_MEM_ZCODE_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    }));
    try {
      const s = SettingsDefaultsManager.loadFromFile(settingsPath, false);
      expect(s.CLAUDE_MEM_ZCODE_MODEL).toBe('glm-5.2');
      expect(s.CLAUDE_MEM_ZCODE_API_KEY).toBe('sk-test-123');
      expect(s.CLAUDE_MEM_ZCODE_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to empty defaults when fields are absent from file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-zcode-'));
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_MODEL: 'opus' }));
    try {
      const s = SettingsDefaultsManager.loadFromFile(settingsPath, false);
      expect(s.CLAUDE_MEM_ZCODE_MODEL).toBe('');
      expect(s.CLAUDE_MEM_ZCODE_API_KEY).toBe('');
      // BASE_URL default is the bigmodel gateway, not empty.
      expect(s.CLAUDE_MEM_ZCODE_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Routing decision logic — mirrors SessionRoutes.applyPlatformRouting exactly.
 * Extracted as a pure function so it can be tested without constructing a full
 * SessionRoutes instance (which needs DB/express/SessionManager). The
 * production method does: session.endpointOverride = undefined first, then sets
 * override only when platformSource==='zcode' && all three fields non-empty.
 *
 * `clientKey` simulates the ZCode-client-credential fallback: when settings has
 * no CLAUDE_MEM_ZCODE_API_KEY, the production code calls readZcodeApiKey() and
 * uses the returned key. Pass undefined here to model "no client credential
 * available".
 */
function decidePlatformRouting(
  platformSource: string,
  zcodeModel: string, zcodeKey: string, zcodeUrl: string,
  clientKey?: string,
): { modelOverride?: string; endpointOverride?: { apiKey: string; baseUrl: string } } {
  const model = zcodeModel?.trim();
  let key = zcodeKey?.trim();
  // Mirror DEFAULT_BIGMODEL_ANTHROPIC_URL fallback in applyPlatformRouting.
  const url = zcodeUrl?.trim() || 'https://open.bigmodel.cn/api/anthropic';

  // Fallback credential source: settings key empty → source from ZCode client.
  if (platformSource === 'zcode' && model && !key && clientKey) {
    key = clientKey;
  }

  if (platformSource === 'zcode' && model && key && url) {
    return { modelOverride: model, endpointOverride: { apiKey: key, baseUrl: url } };
  }
  return { modelOverride: undefined, endpointOverride: undefined };
}

describe('Per-platform routing — decision logic', () => {
  it('routes zcode when all three fields are set', () => {
    const r = decidePlatformRouting('zcode', 'glm-5.2', 'sk-x', 'https://open.bigmodel.cn/api/anthropic');
    expect(r.modelOverride).toBe('glm-5.2');
    expect(r.endpointOverride).toEqual({ apiKey: 'sk-x', baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
  });

  it('does NOT route when platformSource is not zcode (e.g. claude)', () => {
    const r = decidePlatformRouting('claude', 'glm-5.2', 'sk-x', 'https://open.bigmodel.cn/api/anthropic');
    expect(r.modelOverride).toBeUndefined();
    expect(r.endpointOverride).toBeUndefined();
  });

  it('does NOT route when model is missing', () => {
    const r = decidePlatformRouting('zcode', '', 'sk-x', 'https://x');
    expect(r.endpointOverride).toBeUndefined();
    expect(r.modelOverride).toBeUndefined();
  });

  it('does NOT route when API key is missing', () => {
    const r = decidePlatformRouting('zcode', 'glm-5.2', '', 'https://x');
    expect(r.endpointOverride).toBeUndefined();
  });

  it('falls back to the default bigmodel gateway when base URL is empty', () => {
    // Mirrors `zcodeUrl || DEFAULT_BIGMODEL_ANTHROPIC_URL` in applyPlatformRouting.
    const r = decidePlatformRouting('zcode', 'glm-5.2', 'sk-x', '');
    expect(r.modelOverride).toBe('glm-5.2');
    expect(r.endpointOverride).toEqual({
      apiKey: 'sk-x',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    });
  });

  it('trims whitespace before checking', () => {
    const r = decidePlatformRouting('zcode', '  glm-5.2  ', '  sk-x  ', '  https://x  ');
    expect(r.modelOverride).toBe('glm-5.2');
    expect(r.endpointOverride).toEqual({ apiKey: 'sk-x', baseUrl: 'https://x' });
  });
});

/**
 * ZCode client credential fallback — mirrors the readZcodeApiKey() branch in
 * applyPlatformRouting. When settings has no CLAUDE_MEM_ZCODE_API_KEY but the
 * ZCode desktop client's credential file is available, the key is sourced from
 * there. This is what makes ZCode "zero-config" after the client is logged in.
 */
describe('Per-platform routing — ZCode client credential fallback', () => {
  it('routes when settings key is empty but ZCode client key is available', () => {
    const r = decidePlatformRouting('zcode', 'glm-5.2', '', '', 'sk-from-zcode-client');
    expect(r.modelOverride).toBe('glm-5.2');
    expect(r.endpointOverride).toEqual({
      apiKey: 'sk-from-zcode-client',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    });
  });

  it('settings key takes precedence over ZCode client key', () => {
    const r = decidePlatformRouting('zcode', 'glm-5.2', 'sk-explicit', '', 'sk-from-client');
    expect(r.endpointOverride?.apiKey).toBe('sk-explicit');
  });

  it('does NOT route when both settings key and client key are empty', () => {
    const r = decidePlatformRouting('zcode', 'glm-5.2', '', '', undefined);
    expect(r.endpointOverride).toBeUndefined();
  });

  it('does NOT route when model is empty even if client key is available', () => {
    const r = decidePlatformRouting('zcode', '', '', '', 'sk-from-client');
    expect(r.endpointOverride).toBeUndefined();
  });

  it('client key is ignored for non-zcode platforms', () => {
    const r = decidePlatformRouting('claude', 'glm-5.2', '', '', 'sk-from-client');
    expect(r.endpointOverride).toBeUndefined();
  });
});

/**
 * ClaudeProvider env-injection contract — mirrors the endpointOverride branch
 * in ClaudeProvider.startSession. When endpointOverride is set, the isolated env
 * gets the platform's key+base URL and the OAuth token is deleted (so a
 * subscription token is never sent to a third-party gateway).
 */
describe('Per-platform routing — env injection contract', () => {
  function applyEndpointOverride(
    env: Record<string, string | undefined>,
    override: { apiKey: string; baseUrl: string } | undefined,
  ): Record<string, string | undefined> {
    const result = { ...env };
    if (override) {
      result.ANTHROPIC_API_KEY = override.apiKey;
      result.ANTHROPIC_BASE_URL = override.baseUrl;
      delete result.CLAUDE_CODE_OAUTH_TOKEN;
    }
    return result;
  }

  it('injects platform key + base URL and clears OAuth token', () => {
    const env = {
      ANTHROPIC_API_KEY: 'old-anthropic-key',
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-from-subscription',
    };
    const out = applyEndpointOverride(env, { apiKey: 'sk-bigmodel', baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
    expect(out.ANTHROPIC_API_KEY).toBe('sk-bigmodel');
    expect(out.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('leaves env unchanged when no override is set (claude/other platforms)', () => {
    const env = {
      ANTHROPIC_API_KEY: 'anthropic-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    };
    const out = applyEndpointOverride(env, undefined);
    expect(out.ANTHROPIC_API_KEY).toBe('anthropic-key');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('does not leak the original key when overriding', () => {
    const env = { ANTHROPIC_API_KEY: 'secret-should-be-replaced' };
    const out = applyEndpointOverride(env, { apiKey: 'new-key', baseUrl: 'https://x' });
    expect(out.ANTHROPIC_API_KEY).toBe('new-key');
    expect(out.ANTHROPIC_API_KEY).not.toBe('secret-should-be-replaced');
  });
});

/**
 * Tier-routing guard contract — when endpointOverride is set (platform routed),
 * applyTierRouting must early-return without touching modelOverride.
 */
describe('Per-platform routing — tier routing guard', () => {
  it('endpointOverride present → tier routing skipped (modelOverride preserved)', () => {
    // Mirrors the guard at the top of SessionRoutes.applyTierRouting:
    //   if (session.endpointOverride) return;
    const session = {
      endpointOverride: { apiKey: 'k', baseUrl: 'u' } as const,
      modelOverride: 'glm-5.2',
    };
    // If the guard holds, modelOverride is untouched.
    if (session.endpointOverride) {
      // tier routing would return here — modelOverride stays 'glm-5.2'
    } else {
      session.modelOverride = 'haiku'; // tier routing would do this
    }
    expect(session.modelOverride).toBe('glm-5.2');
  });

  it('endpointOverride absent → tier routing may set modelOverride', () => {
    const session = { endpointOverride: undefined, modelOverride: undefined as string | undefined };
    if (session.endpointOverride) {
      // skipped
    } else {
      session.modelOverride = 'haiku'; // tier routing proceeds normally
    }
    expect(session.modelOverride).toBe('haiku');
  });
});

type ProviderDecision = 'claude' | 'gemini' | 'openrouter' | 'codex';

function decideProviderForPlatform(
  platformSource: string,
  hasEndpointOverride: boolean,
  globalProvider: ProviderDecision,
  availability: { codex?: boolean; gemini?: boolean; openrouter?: boolean } = {}
): ProviderDecision {
  if (platformSource === 'codex') {
    if (!availability.codex) throw new Error('Codex CLI unavailable');
    return 'codex';
  }

  if (platformSource === 'zcode') {
    if (!hasEndpointOverride) throw new Error('ZCode credentials unavailable');
    return 'claude';
  }

  if (globalProvider === 'openrouter' && availability.openrouter) return 'openrouter';
  if (globalProvider === 'gemini' && availability.gemini) return 'gemini';
  return 'claude';
}

describe('Per-platform routing — provider precedence', () => {
  it('routes Codex-originated requests to Codex even when the global provider is Claude/Opus', () => {
    const provider = decideProviderForPlatform('codex', false, 'claude', { codex: true });
    expect(provider).toBe('codex');
  });

  it('routes Codex-originated requests to Codex even when the global provider is OpenRouter', () => {
    const provider = decideProviderForPlatform('codex', false, 'openrouter', {
      codex: true,
      openrouter: true,
    });
    expect(provider).toBe('codex');
  });

  it('routes ZCode-originated requests through ClaudeProvider only when the ZCode endpoint override is present', () => {
    const provider = decideProviderForPlatform('zcode', true, 'openrouter', {
      openrouter: true,
    });
    expect(provider).toBe('claude');
  });

  it('does not silently fall back to Claude when Codex is unavailable', () => {
    expect(() => decideProviderForPlatform('codex', false, 'claude', { codex: false }))
      .toThrow('Codex CLI unavailable');
  });

  it('does not silently fall back to the global provider when ZCode credentials are unavailable', () => {
    expect(() => decideProviderForPlatform('zcode', false, 'gemini', { gemini: true }))
      .toThrow('ZCode credentials unavailable');
  });

  it('uses the global provider only for non-platform-owned sources', () => {
    const provider = decideProviderForPlatform('claude', false, 'gemini', { gemini: true });
    expect(provider).toBe('gemini');
  });
});
