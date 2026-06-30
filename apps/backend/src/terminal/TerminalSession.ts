import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import pty from 'node-pty';
import type { IDisposable, IPty } from 'node-pty';
import { config } from '../config.js';
import { resolveExistingDir } from '../util/paths.js';
import type { ShellSpec, TerminalDefinition, TerminalRunState, TerminalRuntimeStatus } from '../store/types.js';

/** Resolve a ShellSpec to an executable + args for the current platform. */
export function resolveShell(spec: ShellSpec): { file: string; args: string[] } {
  const isWin = process.platform === 'win32';
  switch (spec.kind) {
    case 'custom':
      if (!spec.path) throw new Error('custom shell requires a path');
      return { file: spec.path, args: spec.args ?? [] };
    case 'powershell':
      return { file: 'powershell.exe', args: spec.args ?? [] };
    case 'pwsh':
      return { file: 'pwsh', args: spec.args ?? [] };
    case 'cmd':
      return { file: 'cmd.exe', args: spec.args ?? [] };
    case 'bash':
      return { file: 'bash', args: spec.args ?? [] };
    case 'zsh':
      return { file: 'zsh', args: spec.args ?? [] };
    case 'fish':
      return { file: 'fish', args: spec.args ?? [] };
    case 'system-default':
    default:
      return isWin
        ? { file: process.env.ComSpec || 'cmd.exe', args: [] }
        : { file: process.env.SHELL || 'bash', args: [] };
  }
}

/**
 * Owns a single pty process. All lifecycle operations (start/stop/restart/dispose)
 * are serialized through one queue so they can't interleave, and every pty is
 * tagged with a monotonic `generation` so stale onData/onExit callbacks from a
 * previous process can never mutate the state of a newer one.
 *
 * Events: 'output' (string), 'status' (TerminalRuntimeStatus), 'exit' (TerminalRuntimeStatus).
 */
export class TerminalSession extends EventEmitter {
  readonly id: string;
  private def: TerminalDefinition;
  // A definition edited while the pty is live: held here and promoted on the next start
  // (cwd/shell/env/initialCommand only take effect at spawn time, so they can't be applied
  // under the running process). null when there is no deferred edit.
  private pendingDef: TerminalDefinition | null = null;
  private proc: IPty | null = null;
  private generation = 0;

  private state: TerminalRunState = 'stopped';
  private pid?: number;
  private exitCode: number | null = null;
  private signal: number | null = null;
  private errorInfo?: { message: string; code?: string };
  private startedAt?: string;
  private endedAt?: string;
  private cols = 80;
  private rows = 30;

  // lifecycle serialization + user-stop tracking
  private lock: Promise<unknown> = Promise.resolve();
  private stopRequested = false;
  private disposed = false;
  private dataDisp?: IDisposable;
  private exitDisp?: IDisposable;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  // output coalescing + scrollback
  private pending = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ring = '';

  constructor(def: TerminalDefinition) {
    super();
    this.id = def.id;
    // Store a copy so later in-place mutation of the caller's object (e.g. the HTTP
    // PUT route's Object.assign on the shared state entry) can't leak into a live session.
    this.def = { ...def };
  }

  /**
   * Apply a definition edit.
   *
   * While the pty is live, cwd/shell/env/initialCommand cannot be changed under the
   * already-spawned process, so the edit is *deferred*: it is held as a pending definition
   * and promoted on the next start (e.g. via restart). The returned `deferred` flag lets the
   * caller tell the client the change only takes effect after a restart. While stopped, the
   * edit applies immediately and the next start uses it. A copy is stored so later in-place
   * mutation of the source object can't leak into a running session.
   */
  updateDefinition(def: TerminalDefinition): { deferred: boolean } {
    if (this.isAlive()) {
      this.pendingDef = { ...def };
      return { deferred: true };
    }
    this.def = { ...def };
    this.pendingDef = null;
    return { deferred: false };
  }

  /** The definition the current/next pty actually runs with (pending edits excluded). */
  getEffectiveDefinition(): TerminalDefinition {
    return this.def;
  }

  getStatus(): TerminalRuntimeStatus {
    return {
      id: this.id,
      state: this.state,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.errorInfo,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }

  getBuffer(): string {
    return this.ring;
  }

  isAlive(): boolean {
    return this.proc !== null && (this.state === 'running' || this.state === 'starting');
  }

  // --- public lifecycle (serialized) ---

  start(cols = this.cols, rows = this.rows): Promise<TerminalRuntimeStatus> {
    return this.serialize(() => this.startImpl(cols, rows));
  }
  stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<TerminalRuntimeStatus> {
    return this.serialize(() => this.stopImpl(opts));
  }
  restart(cols = this.cols, rows = this.rows): Promise<TerminalRuntimeStatus> {
    return this.serialize(async () => {
      await this.stopImpl({ force: false });
      return this.startImpl(cols, rows);
    });
  }
  dispose(): Promise<void> {
    return this.serialize(async () => {
      this.disposed = true; // reject any start queued behind this in the lock
      await this.stopImpl({ force: true });
      this.clearInitialTimer();
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.removeAllListeners();
    });
  }

  /** Drain coalesced output immediately (used before producing an attach snapshot). */
  flushPending(): void {
    this.flush();
  }

  /** Run lifecycle ops one at a time, regardless of prior success/failure. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // --- non-lifecycle (safe to call any time) ---

  /** Returns true if the data was written to a live pty. */
  write(data: string): boolean {
    if (this.proc && this.isAlive()) {
      this.proc.write(data);
      return true;
    }
    return false;
  }

  resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    if (this.proc && this.isAlive()) {
      try {
        this.proc.resize(cols, rows);
      } catch {
        /* pty may have just exited */
      }
    }
  }

  // --- impl ---

  private async startImpl(cols: number, rows: number): Promise<TerminalRuntimeStatus> {
    if (this.disposed) return this.getStatus(); // removed while this start was queued
    if (this.isAlive()) return this.getStatus();

    // A definition edited while the previous process was running was deferred — apply it now,
    // so this (re)start uses the up-to-date cwd/shell/env/initialCommand.
    if (this.pendingDef) {
      this.def = this.pendingDef;
      this.pendingDef = null;
    }

    // A previous force-kill may have failed, leaving a live process still referenced by
    // this.proc (state 'failed'). Spawning now would overwrite the reference and orphan
    // that process — retry the kill, and refuse to start if it's still alive.
    if (this.proc) {
      await this.forceKill(this.pid);
      await this.waitForExit(1500);
      if (this.proc) throw makeError('previous process is still alive; cannot start', 'EKILL');
    }

    this.stopRequested = false;
    this.cols = cols;
    this.rows = rows;
    this.exitCode = null;
    this.signal = null;
    this.errorInfo = undefined;
    this.endedAt = undefined;
    this.pid = undefined;
    this.ring = '';
    this.pending = '';
    this.clearInitialTimer();
    // dispose any stale pty listeners (e.g. an old generation that never reached handleExit)
    this.dataDisp?.dispose();
    this.exitDisp?.dispose();
    this.dataDisp = this.exitDisp = undefined;
    this.setState('starting');

    let proc: IPty;
    let cwd: string;
    try {
      cwd = await this.validateCwd(this.def.cwd);
      const { file, args } = resolveShell(this.def.shell);
      // Merge over process.env so Windows essentials (SystemRoot, ComSpec, Path, ...) survive.
      // Drop undefined values so node-pty never receives them (process.env values are string|undefined).
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...(this.def.env ?? {}) }).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      );
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    } catch (err) {
      this.errorInfo = { message: errMessage(err), code: errCode(err) };
      this.proc = null;
      this.pid = undefined;
      this.setState('failed');
      throw err;
    }

    const gen = ++this.generation;
    this.proc = proc;
    this.pid = proc.pid;
    this.startedAt = new Date().toISOString();
    this.setState('running');

    this.dataDisp = proc.onData((data) => {
      if (gen === this.generation) this.handleData(data);
    });
    this.exitDisp = proc.onExit(({ exitCode, signal }) => this.handleExit(gen, exitCode, signal ?? null));

    // Run the initial command once the shell prompt is ready. Tied to this generation
    // so a quick restart never writes the old command into the new shell.
    const initial = this.def.initialCommand?.trim();
    if (initial) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        if (gen === this.generation && this.isAlive()) this.write(initial + '\r');
      }, 350);
    }

    return this.getStatus();
  }

  private async stopImpl(opts: { force?: boolean; timeoutMs?: number }): Promise<TerminalRuntimeStatus> {
    this.stopRequested = true;
    this.clearInitialTimer();

    const proc = this.proc;
    if (!proc || !this.isAlive()) {
      this.setState('stopped');
      return this.getStatus();
    }
    const pid = this.pid;

    if (opts.force) {
      await this.forceKill(pid);
      await this.waitForExit(1500);
    } else {
      try {
        proc.write('\x03'); // Ctrl+C
      } catch {
        /* ignore */
      }
      const exited = await this.waitForExit(opts.timeoutMs ?? config.stopTimeoutMs);
      if (!exited) {
        await this.forceKill(pid);
        await this.waitForExit(1500);
      }
    }

    // If the process is somehow still alive, the kill failed — be honest rather than
    // claiming 'stopped' (which would let a restart orphan the old process).
    if (this.proc && this.isAlive()) {
      this.errorInfo = { message: 'failed to terminate process', code: 'EKILL' };
      this.setState('failed');
    } else if (this.state !== 'stopped') {
      // handleExit (if it fired) already set 'stopped' because stopRequested is true.
      this.setState('stopped');
    }
    return this.getStatus();
  }

  /** Resolve true if the pty exits within the timeout, false otherwise. */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.removeListener('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      this.once('exit', onExit);
      // Backstop: resolve on the proc===null transition even if the 'exit' event never reaches us
      // (e.g. a stale-generation handleExit nulls proc and returns before emitting). Without this,
      // a pty that already exited would make us wait the full timeout for an event that won't come.
      const poll = setInterval(() => {
        if (!this.proc) finish(true);
      }, 25);
      poll.unref?.();
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /** Windows: taskkill the tree (avoids node-pty's console-list helper). Awaited. */
  private forceKill(pid?: number): Promise<void> {
    const proc = this.proc; // snapshot — a concurrent restart may reassign this.proc
    return new Promise((resolve) => {
      if (process.platform === 'win32' && pid) {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          const tk = spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          tk.on('close', (code) => {
            // taskkill returned non-zero (tree not fully killed) → fall back to node-pty's kill
            if (code !== 0) {
              try {
                proc?.kill();
              } catch {
                /* already dead */
              }
            }
            done();
          });
          tk.on('error', () => {
            try {
              proc?.kill();
            } catch {
              /* already dead */
            }
            done();
          });
          setTimeout(done, 1500).unref();
        } catch {
          try {
            proc?.kill();
          } catch {
            /* already dead */
          }
          done();
        }
        return;
      }
      try {
        proc?.kill();
      } catch {
        /* already dead */
      }
      resolve();
    });
  }

  /** Validate + normalize the cwd via the shared path guard (rejects relative/UNC/missing). */
  private async validateCwd(cwd: string): Promise<string> {
    const check = await resolveExistingDir(cwd);
    if (!check.ok) throw makeError(`cwd ${check.reason}`, 'EINVAL_CWD');
    return check.path;
  }

  private handleData(data: string): void {
    this.ring += data;
    if (this.ring.length > config.scrollbackBytes) {
      let start = this.ring.length - config.scrollbackBytes;
      // never cut inside a surrogate pair — a lone surrogate breaks the JSON snapshot on re-attach
      const code = this.ring.charCodeAt(start);
      if (code >= 0xdc00 && code <= 0xdfff) start += 1;
      this.ring = this.ring.slice(start);
    }
    this.pending += data;
    if (this.pending.length >= config.outputFlushBytes) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), config.outputFlushMs);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;
    const chunk = this.pending;
    this.pending = '';
    this.emit('output', chunk);
  }

  private handleExit(gen: number, exitCode: number, signal: number | null): void {
    if (gen !== this.generation) return; // stale pty from a previous run
    this.dataDisp?.dispose();
    this.exitDisp?.dispose();
    this.dataDisp = this.exitDisp = undefined;
    this.clearInitialTimer();
    this.flush();
    this.exitCode = exitCode;
    this.signal = signal;
    this.endedAt = new Date().toISOString();
    this.pid = undefined;
    this.proc = null;
    // 'stopped' for a user-initiated stop; 'exited' for a natural end.
    this.setState(this.stopRequested ? 'stopped' : 'exited');
    this.emit('exit', this.getStatus());
  }

  private clearInitialTimer(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  private setState(s: TerminalRunState): void {
    this.state = s;
    this.emit('status', this.getStatus());
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function errCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? c : undefined;
}
function makeError(message: string, code: string): Error {
  const e = new Error(message);
  (e as NodeJS.ErrnoException).code = code;
  return e;
}
