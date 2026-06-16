/**
 * Read the ZCode desktop client's stored bigmodel API key from its userData
 * directory. ZCode (智谱/GLM ADE) is an Electron app that persists per-provider
 * API keys the user enters in its settings UI as a plaintext JSON file at
 * `inner-provider-api-keys.dat`. By sourcing the key from there, claude-mem
 * needs no separate `CLAUDE_MEM_ZCODE_API_KEY` configuration — the key the
 * user already gave ZCode is reused, mirroring how oauth-token.ts reuses
 * Claude Desktop's keychain entry.
 *
 * Contract: this module NEVER throws. Every failure path returns
 * `{ kind: 'absent', reason }` so the routing layer can silently fall back to
 * the global provider without surfacing an error.
 *
 * Format (confirmed against the ZCode client on Windows,
 * %APPDATA%\ai.z.zcode\inner-provider-api-keys.dat):
 *   {"apiKeys":{"bigmodel":{"apiKey":"...","isActive":true,"providerId":"bigmodel"}}}
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

const PROVIDER_KEYS_FILENAME = 'inner-provider-api-keys.dat';
const TARGET_PROVIDER = 'bigmodel';

/** Bigmodel's Anthropic-compatible gateway. Used as ZCODE_BASE_URL default. */
export const DEFAULT_BIGMODEL_ANTHROPIC_URL = 'https://open.bigmodel.cn/api/anthropic';

export type ZcodeCredentialResult =
  | { kind: 'present'; apiKey: string; source: 'zcode-client' }
  | { kind: 'absent'; reason: string };

/**
 * Resolve the ZCode client's userData directory per platform, following the
 * Electron `app.getPath('userData')` convention. The folder name is the app's
 * reverse-DNS identifier `ai.z.zcode` (verified on Windows; macOS/Linux follow
 * the same convention since Electron does not rename per-OS).
 *
 * Override for tests / advanced setups via CLAUDE_MEM_ZCODE_CREDENTIALS_DIR
 * (points at the directory containing the .dat file) or
 * CLAUDE_MEM_ZCODE_CREDENTIALS_PATH (the .dat file itself).
 */
function resolveCredentialsFilePath(): string {
  const overridePath = process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_PATH;
  if (overridePath) return overridePath;

  const overrideDir = process.env.CLAUDE_MEM_ZCODE_CREDENTIALS_DIR;
  if (overrideDir) return join(overrideDir, PROVIDER_KEYS_FILENAME);

  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
      return join(appData, 'ai.z.zcode', PROVIDER_KEYS_FILENAME);
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'ai.z.zcode', PROVIDER_KEYS_FILENAME);
    default: {
      // Linux / other Unix: honor XDG_CONFIG_HOME.
      const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
      return join(configHome, 'ai.z.zcode', PROVIDER_KEYS_FILENAME);
    }
  }
}

interface ZcodeProviderKeysFile {
  apiKeys?: Record<string, {
    apiKey?: string;
    isActive?: boolean;
    providerId?: string;
  }>;
}

/**
 * Parse the ZCode client's provider-keys file and return the bigmodel key when
 * present and active. Exposed for direct unit testing of the parse layer.
 */
export function parseZcodeProviderKeys(raw: string): ZcodeCredentialResult {
  let payload: ZcodeProviderKeysFile;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { kind: 'absent', reason: 'ZCode credentials file is not valid JSON' };
  }

  const provider = payload.apiKeys?.[TARGET_PROVIDER];
  if (!provider) {
    return { kind: 'absent', reason: `ZCode credentials file has no "${TARGET_PROVIDER}" provider entry` };
  }

  if (provider.isActive === false) {
    return { kind: 'absent', reason: `ZCode "${TARGET_PROVIDER}" provider entry is marked inactive` };
  }

  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  if (!apiKey) {
    return { kind: 'absent', reason: `ZCode "${TARGET_PROVIDER}" provider entry has an empty apiKey` };
  }

  return { kind: 'present', apiKey, source: 'zcode-client' };
}

/**
 * Resolve the ZCode v2 config path (the opencode-schema config that holds the
 * active provider's apiKey). This is where ZCode stores the key the user
 * actually logs in with — the inner-provider-api-keys.dat may hold a stale
 * or different key (e.g. from a previous login session).
 */
function resolveV2ConfigPath(): string {
  switch (process.platform) {
    case 'win32': {
      const home = homedir();
      return join(home, '.zcode', 'v2', 'config.json');
    }
    case 'darwin':
      return join(homedir(), '.zcode', 'v2', 'config.json');
    default:
      return join(homedir(), '.zcode', 'v2', 'config.json');
  }
}

/**
 * Read the bigmodel API key from ZCode's v2/config.json provider config.
 * The v2 config (opencode schema) stores active providers with their apiKey
 * under `provider.<id>.options.apiKey`. We look for any enabled bigmodel
 * provider and return its key.
 */
function readV2ConfigKey(): ZcodeCredentialResult {
  const configPath = resolveV2ConfigPath();
  if (!existsSync(configPath)) {
    return { kind: 'absent', reason: `ZCode v2 config not found at ${configPath}` };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'absent', reason: `Failed to read ZCode v2 config: ${message}` };
  }

  try {
    const config = JSON.parse(raw) as { provider?: Record<string, { enabled?: boolean; options?: { apiKey?: string } }> };
    if (!config.provider) {
      return { kind: 'absent', reason: 'ZCode v2 config has no provider section' };
    }
    // Find any enabled provider with a bigmodel baseURL and non-empty apiKey.
    for (const [id, provider] of Object.entries(config.provider)) {
      if (provider.enabled !== false && provider.options?.apiKey) {
        const apiKey = provider.options.apiKey.trim();
        if (apiKey) {
          logger.debug('ZCODE', 'API key sourced from ZCode v2 config', { providerId: id });
          return { kind: 'present', apiKey, source: 'zcode-client' };
        }
      }
    }
    return { kind: 'absent', reason: 'No enabled provider with apiKey in ZCode v2 config' };
  } catch {
    return { kind: 'absent', reason: 'ZCode v2 config is not valid JSON' };
  }
}

/**
 * Read the ZCode client's bigmodel API key. Tries v2/config.json first (the
 * active provider key), then falls back to inner-provider-api-keys.dat.
 * Returns `absent` for any failure — never throws.
 */
export function readZcodeApiKey(): ZcodeCredentialResult {
  // Priority 1: v2/config.json (current/active key)
  const v2Result = readV2ConfigKey();
  if (v2Result.kind === 'present') return v2Result;

  // Priority 2: inner-provider-api-keys.dat (legacy/fallback)
  const filePath = resolveCredentialsFilePath();
  if (!existsSync(filePath)) {
    return { kind: 'absent', reason: `ZCode credentials file not found at ${filePath}` };
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'absent', reason: `Failed to read ZCode credentials file: ${message}` };
  }

  const result = parseZcodeProviderKeys(raw);
  if (result.kind === 'present') {
    logger.debug('ZCODE', 'API key sourced from ZCode client credentials (legacy)', { path: filePath });
  } else {
    logger.debug('ZCODE', 'ZCode client credentials unavailable, falling back', {
      path: filePath,
      reason: result.reason,
    });
  }
  return result;
}
