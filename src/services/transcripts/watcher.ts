import { existsSync, statSync, watch as fsWatch, createReadStream, readFileSync } from 'fs';
import { basename, join, resolve as resolvePath, sep as pathSep } from 'path';
import { globSync } from 'glob';
import { logger } from '../../utils/logger.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';

interface TailState {
  offset: number;
  partial: string;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void
  ) {
    this.tailState = { offset: initialOffset, partial: '' };
  }

  start(): void {
    this.readNewData().catch(() => undefined);
    this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
      this.readNewData().catch(() => undefined);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  poke(): void {
    this.readNewData().catch(() => undefined);
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.offset) {
      // File shrank (truncated/rotated/replaced). Jump to the current end
      // instead of resetting to 0 — resetting would replay the entire file
      // and wedge the watcher on large transcripts (the original bug).
      // Skipping to the end loses any truncated content but that content is
      // gone from disk anyway, so there is nothing to read.
      logger.info('TRANSCRIPT', 'File shrank below saved offset, jumping to end', {
        file: this.filePath,
        oldOffset: this.tailState.offset,
        newSize: size,
      });
      this.tailState.offset = size;
      this.onOffset(size);
    }

    if (size === this.tailState.offset) return;

    const stream = createReadStream(this.filePath, {
      start: this.tailState.offset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }

    this.tailState.offset = size;
    this.onOffset(this.tailState.offset);

    const combined = this.tailState.partial + data;
    const lines = combined.split('\n');
    this.tailState.partial = lines.pop() ?? '';

    logger.debug('TRANSCRIPT_DEBUG', `readNewData result`, {
      file: this.filePath.slice(-50),
      dataLen: data.length,
      linesParsed: lines.length,
      partialLen: this.tailState.partial.length,
    });

    if (lines.length > 0) {
      logger.debug('TRANSCRIPT_DEBUG', `FileTailer readNewData: ${lines.length} new line(s)`, {
        file: this.filePath.slice(-60),
        offset: this.tailState.offset,
        size,
      });
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.onLine(trimmed);
    }
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rootWatchers: Array<ReturnType<typeof fsWatch>> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: TranscriptWatchConfig, private statePath: string) {
    this.state = loadWatchState(statePath);
  }

  async start(): Promise<void> {
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
    // Polling fallback: fsWatch on Windows is unreliable for large files that
    // are appended to frequently (the change callback may never fire). Poll
    // every 3s to guarantee we catch new data regardless of the OS.
    this.pollTimer = setInterval(() => {
      for (const tailer of this.tailers.values()) {
        tailer.poke();
      }
    }, 3000);
    // NOTE: do NOT unref this timer. Under bun, unref'd intervals can be
    // garbage-collected even while the process is alive, silently killing
    // the polling fallback. The worker process is long-lived so this timer
    // must persist.
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    for (const watcher of this.rootWatchers) {
      watcher.close();
    }
    this.rootWatchers = [];
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema);
    }

    const watchRoot = this.deepestNonGlobAncestor(resolvedPath);
    if (!watchRoot || !existsSync(watchRoot)) {
      logger.debug('TRANSCRIPT', 'Watch root does not exist, skipping fs.watch', { watch: watch.name, watchRoot });
      return;
    }

    try {
      const watcher = fsWatch(watchRoot, { recursive: true, persistent: true }, (event, name) => {
        if (!name) return;
        const changed = resolvePath(watchRoot, name).replace(/\\/g, '/');
        const existingTailer = this.tailers.get(changed);
        if (existingTailer) {
          existingTailer.poke();
          return;
        }
        const matches = this.resolveWatchFiles(resolvedPath);
        for (const filePath of matches) {
          if (!this.tailers.has(filePath)) {
            // Runtime-discovered file (not present at startup) — isNewFile so
            // it's processed from the beginning instead of startAtEnd.
            void this.addTailer(filePath, watch, schema, true);
          }
        }
      });
      this.rootWatchers.push(watcher);
      logger.info('TRANSCRIPT', 'Watching transcript root recursively', { watch: watch.name, watchRoot });
    } catch (error) {
      logger.warn('TRANSCRIPT', 'Failed to start recursive fs.watch on transcript root', {
        watch: watch.name,
        watchRoot,
      }, error instanceof Error ? error : undefined);
    }
  }

  private deepestNonGlobAncestor(inputPath: string): string {
    if (!this.hasGlob(inputPath)) {
      if (existsSync(inputPath)) {
        try {
          const stat = statSync(inputPath);
          return stat.isDirectory() ? inputPath : resolvePath(inputPath, '..');
        } catch {
          return resolvePath(inputPath, '..');
        }
      }
      return inputPath;
    }

    const segments = inputPath.split(/[/\\]/);
    const literalSegments: string[] = [];
    for (const segment of segments) {
      if (/[*?[\]{}()]/.test(segment)) break;
      literalSegments.push(segment);
    }
    if (literalSegments.length === 0) return '';
    if (literalSegments.length === 1 && literalSegments[0] === '') {
      return '';
    }
    return literalSegments.join(pathSep);
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return globSync(this.normalizeGlobPattern(inputPath), { nodir: true, absolute: true });
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return globSync(this.normalizeGlobPattern(pattern), { nodir: true, absolute: true });
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private normalizeGlobPattern(inputPath: string): string {
    return inputPath.replace(/\\/g, '/');
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    isNewFile: boolean = false
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    const hasExistingOffset = Object.prototype.hasOwnProperty.call(this.state.offsets, filePath);
    let offset = this.state.offsets[filePath] ?? 0;
    // startAtEnd: skip to the end of the file so we only process NEW data.
    // BUT a file discovered at runtime via fs.watch (isNewFile) that has no
    // prior offset is processed from the beginning — otherwise a session that
    // writes one record and stops is skipped entirely (startAtEnd jumps past
    // its only record) and never recorded. Files present at startup, or files
    // we've already tracked (hasExistingOffset), still startAtEnd to avoid
    // replaying history.
    const shouldStartAtEnd = watch.startAtEnd && !isNewFile;
    if (shouldStartAtEnd) {
      try {
        offset = statSync(filePath).size;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    } else if (offset > 0) {
      // Validate persisted offset against actual file size (rotation guard).
      try {
        const size = statSync(filePath).size;
        if (size < offset) offset = size;
      } catch {
        // leave offset as-is if stat fails
      }
    }

    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride);
      },
      (newOffset: number) => {
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      }
    );

    // Prime the session-level cwd by scanning the file HEAD for the first record
    // that carries it. ZCode rollouts put the working directory in the first
    // record's system prompt; later turns may omit the system block. Even though
    // new files are now processed from the beginning (so session_context fires
    // naturally), the prime is still valuable for: (a) files that were already
    // tracked (startAtEnd skips their head), and (b) records where the system
    // block appears only in a non-first record. Cheap + idempotent.
    if (sessionIdOverride) {
      this.primeCwdFromHead(filePath, watch, schema, sessionIdOverride).catch(() => undefined);
    }

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
    }
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }

  /**
   * Scan the HEAD of a rollout file (at most HEAD_SCAN_MAX_LINES records) for
   * the first record that yields a session cwd, then prime the processor's
   * session state with it. This recovers the working directory that
   * startAtEnd skipped: ZCode writes cwd into the first record's system prompt,
   * but the tailer only sees follow-up turns (which omit the system block), so
   * without this the session's cwd is never resolved and observations
   * mis-attribute to the worker's startup dir.
   *
   * Best-effort and non-fatal: a parse failure or missing cwd simply leaves
   * the session un-primed (the session_context event can still fire later if a
   * record happens to carry a system block).
   */
  private async primeCwdFromHead(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride: string
  ): Promise<void> {
    const HEAD_SCAN_MAX_LINES = 10;
    try {
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      let scanned = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (scanned >= HEAD_SCAN_MAX_LINES) break;
        scanned++;
        try {
          const entry = JSON.parse(trimmed);
          const cwd = this.processor.extractCwdFromEntry(entry, watch, schema);
          if (cwd) {
            // Resolve the sessionId from the RECORD BODY (e.g. "sess_<uuid>"),
            // NOT the filename UUID — the processor keys sessions by the body
            // sessionId, so priming under the filename UUID would create a
            // separate session object whose cwd the real session never sees.
            const sessionId = this.processor.extractSessionIdFromEntry(entry, watch, schema, sessionIdOverride);
            logger.debug('TRANSCRIPT', 'CWD_DIAG primeCwdFromHead found-cwd', {
              diag: 'primeCwd-found', file: basename(filePath),
              filenameSessionId: sessionIdOverride, bodySessionId: sessionId ?? null,
              cwd, scannedRecords: scanned,
            });
            if (sessionId) {
              this.processor.primeSessionContext(watch, sessionId, cwd);
              logger.debug('TRANSCRIPT', 'Primed session cwd from rollout file head', {
                file: basename(filePath), sessionId, cwd, scannedRecords: scanned,
              });
            }
            return;
          }
        } catch {
          // skip unparseable lines
        }
      }
      // CWD_DIAG: reached the end of the head scan without finding a cwd.
      logger.debug('TRANSCRIPT', 'CWD_DIAG primeCwdFromHead NO-CWD-IN-HEAD', {
        diag: 'primeCwd-none', file: basename(filePath),
        filenameSessionId: sessionIdOverride, linesScanned: scanned,
      });
    } catch (error: unknown) {
      logger.debug('TRANSCRIPT', 'primeCwdFromHead failed (non-fatal)', {
        file: basename(filePath), error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
