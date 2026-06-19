import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../obs/logger.js';
import { KeyedDebouncer } from './debounce.js';
import type { CueChangeType } from './types.js';

const log = logger.child({ mod: 'cue.file-watcher' });

/** Directory names we never surface changes for (noise + churn that would hot-loop a cue). */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.tiger', '.kaplan', 'dist', '.nuxt', '.output']);

export interface FileChange {
  path: string;
  changeType: CueChangeType;
}

/**
 * Decide whether a relative path (forward-slashed) is under an ignored directory. Pure helper so
 * the ignore policy is testable and shared.
 */
export function isIgnoredPath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/');
  return parts.some((p) => IGNORED_DIRS.has(p));
}

export interface FileWatcherOptions {
  /** Absolute directory to watch recursively. */
  dir: string;
  /** Debounce window collapsing rapid saves into one change. */
  debounceMs: number;
  /** Called once per debounced change. Must never throw. */
  onChange: (change: FileChange) => void;
}

/**
 * A safe recursive file watcher built on `node:fs.watch({ recursive: true })`. Debounced per-path,
 * ignores VCS/build dirs, and NEVER throws into the caller: a watch error is logged and the watcher
 * keeps the process alive. `recursive` is supported on Windows + macOS natively; on Linux modern
 * Node also supports it. If the platform rejects recursive mode we log and degrade to no-op rather
 * than crash.
 */
export class CueFileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private readonly debouncer: KeyedDebouncer;
  private closed = false;

  constructor(private readonly opts: FileWatcherOptions) {
    this.debouncer = new KeyedDebouncer(opts.debounceMs);
  }

  start(): void {
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(this.opts.dir, { recursive: true });
    } catch (err) {
      log.warn('cue file watch unavailable; subscription inert', {
        dir: this.opts.dir,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.watcher = watcher;
    watcher.on('error', (err) => {
      // Watch errors (e.g. a transient ENOENT on a deleted subtree) must not crash the process.
      log.warn('cue file watcher error (continuing)', { dir: this.opts.dir, err });
    });
    watcher.on('change', (eventType: fs.WatchEventType, filename) => {
      if (this.closed || filename == null) return;
      const rel = typeof filename === 'string' ? filename : filename.toString('utf8');
      if (!rel || isIgnoredPath(rel)) return;
      const abs = path.resolve(this.opts.dir, rel);
      this.debouncer.trigger(abs, () => {
        void this.resolveAndEmit(abs, eventType);
      });
    });
    log.info('cue file watcher started', { dir: this.opts.dir, debounceMs: this.opts.debounceMs });
  }

  /** Stat the path to derive created/modified/deleted, then emit (guarded). */
  private async resolveAndEmit(abs: string, eventType: fs.WatchEventType): Promise<void> {
    if (this.closed) return;
    let changeType: CueChangeType;
    try {
      await fsp.stat(abs);
      // fs.watch can't distinguish create vs modify portably; 'rename' usually means add/remove.
      changeType = eventType === 'rename' ? 'created' : 'modified';
    } catch {
      changeType = 'deleted';
    }
    try {
      this.opts.onChange({ path: abs, changeType });
    } catch (err) {
      log.warn('cue file change handler threw (ignored)', { abs, err });
    }
  }

  close(): void {
    this.closed = true;
    this.debouncer.cancelAll();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }
}
