import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

function sampleObservation(title: string) {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: `${title} narrative`,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

describe('SessionStore platform source attribution', () => {
  let store: SessionStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it('enables foreign-key cascades for shared Database connections', () => {
    const db = new Database(':memory:');
    store = new SessionStore(db);

    const sessionDbId = store.createSDKSession('session-codex', 'db', 'prompt', undefined, 'codex');
    store.updateMemorySessionId(sessionDbId, 'codex-session-codex-old');
    store.storeObservation('codex-session-codex-old', 'db', sampleObservation('Codex cascade check'));

    store.updateMemorySessionId(sessionDbId, 'codex-session-codex-new');

    const row = store.db.prepare(`
      SELECT o.memory_session_id, s.platform_source
        FROM observations o
        JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
       WHERE o.title = ?
    `).get('Codex cascade check') as { memory_session_id: string; platform_source: string };

    expect(row.memory_session_id).toBe('codex-session-codex-new');
    expect(row.platform_source).toBe('codex');
  });

  it('repairs orphaned synthetic Codex memory ids left by earlier missing cascades', () => {
    const db = new Database(':memory:');
    store = new SessionStore(db);

    const sessionDbId = store.createSDKSession('session-repair', 'db', 'prompt', undefined, 'codex');
    store.updateMemorySessionId(sessionDbId, 'codex-session-repair-new');

    store.db.run('PRAGMA foreign_keys = OFF');
    store.storeObservation('codex-session-repair-old', 'db', sampleObservation('Codex orphan repair'));
    store.db.run('PRAGMA foreign_keys = ON');

    store = new SessionStore(db);

    const row = store.db.prepare(`
      SELECT o.memory_session_id, s.platform_source
        FROM observations o
        JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
       WHERE o.title = ?
    `).get('Codex orphan repair') as { memory_session_id: string; platform_source: string };

    expect(row.memory_session_id).toBe('codex-session-repair-new');
    expect(row.platform_source).toBe('codex');
  });

  it('keeps manual sessions source-specific when a non-default platform is provided', () => {
    const db = new Database(':memory:');
    store = new SessionStore(db);

    const legacyManualSession = store.getOrCreateManualSession('db');
    const codexManualSession = store.getOrCreateManualSession('db', 'codex');

    expect(legacyManualSession).toBe('manual-db');
    expect(codexManualSession).toBe('manual-codex-db');

    const rows = store.db.prepare(`
      SELECT memory_session_id, platform_source
        FROM sdk_sessions
       WHERE memory_session_id IN (?, ?)
       ORDER BY memory_session_id
    `).all(legacyManualSession, codexManualSession) as Array<{ memory_session_id: string; platform_source: string }>;

    expect(rows).toEqual([
      { memory_session_id: 'manual-codex-db', platform_source: 'codex' },
      { memory_session_id: 'manual-db', platform_source: 'claude' },
    ]);
  });

  it('normalizes path-like manual session projects before deriving ids', () => {
    const db = new Database(':memory:');
    store = new SessionStore(db);

    const codexManualSession = store.getOrCreateManualSession('D:\\code\\db', 'codex');

    expect(codexManualSession).toBe('manual-codex-db');

    const row = store.db.prepare(`
      SELECT memory_session_id, content_session_id, project, platform_source
        FROM sdk_sessions
       WHERE memory_session_id = ?
    `).get(codexManualSession) as {
      memory_session_id: string;
      content_session_id: string;
      project: string;
      platform_source: string;
    };

    expect(row).toEqual({
      memory_session_id: 'manual-codex-db',
      content_session_id: 'manual-content-codex-db',
      project: 'db',
      platform_source: 'codex',
    });
  });
});
