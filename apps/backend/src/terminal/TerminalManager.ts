import { EventEmitter } from 'node:events';
import type {
  CommandTarget,
  RouteResult,
  TerminalDefinition,
  TerminalId,
  TerminalRuntimeStatus,
} from '../store/types.js';
import { TerminalSession } from './TerminalSession.js';

export interface ManagerOutputEvent {
  termId: TerminalId;
  data: string;
}

export interface RouteOptions {
  appendNewline: boolean;
  startTerminalOnSend: boolean;
}

/**
 * Registry + lifecycle layer over TerminalSession instances. Owns the live
 * process map and the terminal definitions, fans session events out as
 * id-tagged manager events, and implements command routing (selected/group/all).
 *
 * Events: 'output' (ManagerOutputEvent), 'status' (TerminalRuntimeStatus), 'exit' (TerminalRuntimeStatus).
 */
function stoppedStatus(id: TerminalId): TerminalRuntimeStatus {
  return { id, state: 'stopped', cols: 80, rows: 30, exitCode: null };
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<TerminalId, TerminalSession>();
  private defs = new Map<TerminalId, TerminalDefinition>();
  private sizes = new Map<TerminalId, { cols: number; rows: number }>();
  private stopping = false;

  // --- definitions ---

  setDefinitions(defs: TerminalDefinition[]): void {
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }
  /**
   * Store/replace a definition. If the terminal is currently running, the runtime-affecting
   * fields can't be applied under the live pty, so the session defers them to the next start;
   * `deferred` is true in that case so the caller can tell the client the edit takes effect
   * after a restart.
   */
  upsertDefinition(def: TerminalDefinition): { deferred: boolean } {
    this.defs.set(def.id, def);
    return this.sessions.get(def.id)?.updateDefinition(def) ?? { deferred: false };
  }
  getDefinition(id: TerminalId): TerminalDefinition | undefined {
    return this.defs.get(id);
  }

  // --- lifecycle ---

  /**
   * Construct the session backing a definition. Isolated so tests can subclass the manager
   * and substitute a fake session (avoiding a real pty spawn); production always uses the
   * real {@link TerminalSession}. Behavior is otherwise identical.
   */
  protected createSession(def: TerminalDefinition): TerminalSession {
    return new TerminalSession(def);
  }

  private ensureSession(def: TerminalDefinition): TerminalSession {
    let s = this.sessions.get(def.id);
    if (!s) {
      s = this.createSession(def);
      s.on('output', (data: string) => this.emit('output', { termId: def.id, data } satisfies ManagerOutputEvent));
      s.on('status', (status: TerminalRuntimeStatus) => this.emit('status', status));
      s.on('exit', (status: TerminalRuntimeStatus) => this.emit('exit', status));
      this.sessions.set(def.id, s);
    }
    return s;
  }

  async start(id: TerminalId, cols?: number, rows?: number): Promise<TerminalRuntimeStatus> {
    const def = this.defs.get(id);
    if (!def) throw new Error(`unknown terminal: ${id}`);
    if (this.stopping) return stoppedStatus(id); // don't spawn during shutdown
    const s = this.ensureSession(def);
    s.updateDefinition(def);
    const size = this.sizes.get(id);
    return s.start(cols ?? size?.cols, rows ?? size?.rows);
  }

  // Idempotent: stopping a known-but-never-started terminal is a no-op, not an error.
  async stop(id: TerminalId): Promise<TerminalRuntimeStatus> {
    const s = this.sessions.get(id);
    if (!s) {
      if (this.defs.has(id)) return stoppedStatus(id);
      throw new Error(`unknown terminal: ${id}`);
    }
    return s.stop();
  }

  async restart(id: TerminalId, cols?: number, rows?: number): Promise<TerminalRuntimeStatus> {
    const def = this.defs.get(id);
    if (!def) throw new Error(`unknown terminal: ${id}`);
    if (this.stopping) return stoppedStatus(id); // don't respawn during shutdown
    const s = this.ensureSession(def);
    s.updateDefinition(def);
    const size = this.sizes.get(id);
    return s.restart(cols ?? size?.cols, rows ?? size?.rows);
  }

  /** Returns true if written to a live pty. */
  write(id: TerminalId, data: string): boolean {
    return this.sessions.get(id)?.write(data) ?? false;
  }
  resize(id: TerminalId, cols: number, rows: number): void {
    // Guard here too, not just in TerminalSession.resize: a bad size (0/NaN from
    // a momentarily-hidden xterm tile) is REMEMBERED and later fed to pty.spawn
    // on the next start/restart, which node-pty rejects. Drop invalid sizes.
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return;
    const size = { cols: Math.floor(cols), rows: Math.floor(rows) };
    this.sizes.set(id, size); // remembered even with no live session, used on next start
    this.sessions.get(id)?.resize(size.cols, size.rows);
  }

  /** Drain a session's coalesced output (used before an attach snapshot). */
  flush(id: TerminalId): void {
    this.sessions.get(id)?.flushPending();
  }

  hasSession(id: TerminalId): boolean {
    const s = this.sessions.get(id);
    return !!s && s.isAlive();
  }
  getStatus(id: TerminalId): TerminalRuntimeStatus | undefined {
    return this.sessions.get(id)?.getStatus();
  }
  getBuffer(id: TerminalId): string {
    return this.sessions.get(id)?.getBuffer() ?? '';
  }

  /** Dispose the live process (used when a definition is deleted). */
  async remove(id: TerminalId): Promise<void> {
    // Remove the definition FIRST so a concurrent start/restart/route can't resolve
    // this id; the session's `disposed` flag then rejects anything already queued.
    this.defs.delete(id);
    this.sizes.delete(id);
    const s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      await s.dispose();
    }
  }

  async autostartAll(): Promise<void> {
    for (const def of this.defs.values()) {
      if (this.stopping) break; // shutdown began — stop launching
      if (def.autostart) {
        try {
          await this.start(def.id);
        } catch (err) {
          console.error(`[autostart] ${def.name} (${def.id}) failed:`, err);
        }
      }
    }
  }

  /** Signal shutdown so autostart stops launching and no new sessions spawn. */
  beginShutdown(): void {
    this.stopping = true;
  }

  async killAll(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].map((s) => s.dispose()));
    this.sessions.clear();
  }

  // --- command routing (send to selected / group / all) ---

  private resolveTargets(target: CommandTarget): TerminalId[] {
    switch (target.mode) {
      case 'selected':
        // keep unknown ids (don't filter) so routeInput reports UNKNOWN → client resync,
        // instead of silently reporting "Sent to 0".
        return [...new Set(target.termIds)];
      case 'group':
        return [...this.defs.values()].filter((d) => d.groupId === target.groupId).map((d) => d.id);
      case 'all':
        return [...this.defs.values()].map((d) => d.id);
    }
  }

  async routeInput(target: CommandTarget, data: string, opts: RouteOptions): Promise<RouteResult> {
    const ids = this.resolveTargets(target);
    const payload = opts.appendNewline ? data + '\r' : data;
    const failed: RouteResult['failed'] = [];
    let written = 0;

    for (const id of ids) {
      const def = this.defs.get(id);
      if (!def) {
        failed.push({ termId: id, code: 'UNKNOWN' });
        continue;
      }
      if (def.protected) {
        // protected terminals never receive a fan-out/broadcast command
        failed.push({ termId: id, code: 'PROTECTED' });
        continue;
      }
      if (!this.hasSession(id)) {
        if (!opts.startTerminalOnSend) {
          failed.push({ termId: id, code: 'NOT_RUNNING' });
          continue;
        }
        try {
          await this.start(id);
        } catch {
          failed.push({ termId: id, code: 'START_FAILED' });
          continue;
        }
      }
      if (this.write(id, payload)) {
        written += 1;
      } else {
        failed.push({ termId: id, code: 'NOT_RUNNING' }); // exited between check and write
      }
    }

    return { matched: ids.length, written, failed };
  }
}
