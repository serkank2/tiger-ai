import { EventEmitter } from 'node:events';
import { spawn as spawnChild } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import pty from 'node-pty';
import type { IPty } from 'node-pty';
import { config } from '../config.js';
import type {
  ShellSpec,
  TerminalDefinition,
  TerminalRunState,
  TerminalRuntimeStatus,
} from '../store/types.js';

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
 * Owns a single pty process: spawn, stream (coalesced) output, maintain a
 * bounded scrollback ring buffer, write input, resize, and stop/restart/kill
 * with a Windows-safe process-tree kill.
 *
 * Events: 'output' (string), 'status' (TerminalRuntimeStatus), 'exit' (TerminalRuntimeStatus).
 */
export class TerminalSession extends EventEmitter {
  readonly id: string;
  private def: TerminalDefinition;
  private proc: IPty | null = null;

  private state: TerminalRunState = 'stopped';
  private pid?: number;
  private exitCode: number | null = null;
  private signal: number | null = null;
  private errorInfo?: { message: string; code?: string };
  private startedAt?: string;
  private endedAt?: string;
  private cols = 80;
  private rows = 30;

  // output coalescing + scrollback
  private pending = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ring = '';

  constructor(def: TerminalDefinition) {
    super();
    this.id = def.id;
    this.def = def;
  }

  updateDefinition(def: TerminalDefinition): void {
    this.def = def;
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

  /** Bounded scrollback, replayed to a client when it attaches. */
  getBuffer(): string {
    return this.ring;
  }

  isAlive(): boolean {
    return this.proc !== null && (this.state === 'running' || this.state === 'starting');
  }

  async start(cols = this.cols, rows = this.rows): Promise<TerminalRuntimeStatus> {
    if (this.isAlive()) return this.getStatus();

    await this.validateCwd(this.def.cwd);
    const { file, args } = resolveShell(this.def.shell);
    // Merge over process.env so Windows essentials (SystemRoot, ComSpec, Path, ...) survive.
    const env = { ...process.env, ...(this.def.env ?? {}) } as Record<string, string>;

    this.cols = cols;
    this.rows = rows;
    this.exitCode = null;
    this.signal = null;
    this.errorInfo = undefined;
    this.endedAt = undefined;
    this.ring = '';
    this.pending = '';
    this.setState('starting');

    try {
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.def.cwd,
        env,
      });
      this.proc = proc;
      this.pid = proc.pid;
      this.startedAt = new Date().toISOString();
      this.setState('running');

      proc.onData((data) => this.handleData(data));
      proc.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null));

      // Run the initial command once the shell prompt is ready (avoid shell-string spawning).
      const initial = this.def.initialCommand?.trim();
      if (initial) {
        setTimeout(() => {
          if (this.isAlive()) this.write(initial + '\r');
        }, 350);
      }
    } catch (err) {
      this.errorInfo = { message: errMessage(err), code: errCode(err) };
      this.proc = null;
      this.setState('failed');
      throw err;
    }

    return this.getStatus();
  }

  write(data: string): void {
    if (this.proc && this.isAlive()) this.proc.write(data);
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

  /** Graceful stop (Ctrl+C, then force-kill after a timeout) or immediate force kill. */
  async stop(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<TerminalRuntimeStatus> {
    const proc = this.proc;
    if (!proc || !this.isAlive()) {
      this.setState('stopped');
      return this.getStatus();
    }
    const pid = this.pid;

    if (opts.force) {
      this.forceKill(pid);
    } else {
      try {
        proc.write('\x03'); // Ctrl+C
      } catch {
        /* ignore */
      }
      const timeout = opts.timeoutMs ?? config.stopTimeoutMs;
      await new Promise<void>((resolve) => {
        let done = false;
        const onExit = () => {
          if (done) return;
          done = true;
          resolve();
        };
        this.once('exit', onExit);
        setTimeout(() => {
          if (done) return;
          done = true;
          this.removeListener('exit', onExit);
          this.forceKill(pid);
          resolve();
        }, timeout);
      });
    }

    this.setState('stopped');
    return this.getStatus();
  }

  async restart(cols = this.cols, rows = this.rows): Promise<TerminalRuntimeStatus> {
    await this.stop({ force: false });
    return this.start(cols, rows);
  }

  async dispose(): Promise<void> {
    await this.stop({ force: true });
    this.removeAllListeners();
  }

  // --- internals ---

  private forceKill(pid?: number): void {
    // On Windows, taskkill gives a reliable process-tree kill AND avoids node-pty's
    // ConPTY console-list helper, which spawns a subprocess that logs
    // "AttachConsole failed" while the console is being torn down during kill().
    // node-pty frees the ConPTY when it observes the process exit (onExit).
    if (process.platform === 'win32' && pid) {
      try {
        spawnChild('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        return;
      } catch {
        /* fall through to pty.kill() as a last resort */
      }
    }
    try {
      this.proc?.kill();
    } catch {
      /* already dead */
    }
  }

  private async validateCwd(cwd: string): Promise<void> {
    try {
      const st = await fsp.stat(cwd);
      if (!st.isDirectory()) {
        throw makeError(`cwd is not a directory: ${cwd}`, 'EINVAL_CWD');
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'EINVAL_CWD') throw err;
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = code === 'ENOENT' ? `cwd does not exist: ${cwd}` : errMessage(err);
      throw makeError(msg, 'EINVAL_CWD');
    }
  }

  private handleData(data: string): void {
    this.ring += data;
    if (this.ring.length > config.scrollbackBytes) {
      this.ring = this.ring.slice(this.ring.length - config.scrollbackBytes);
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

  private handleExit(exitCode: number, signal: number | null): void {
    this.flush();
    this.exitCode = exitCode;
    this.signal = signal;
    this.endedAt = new Date().toISOString();
    this.proc = null;
    // Natural end of the process. (A user-initiated stop overrides this to 'stopped'.)
    this.setState('exited');
    this.emit('exit', this.getStatus());
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
