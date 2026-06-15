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
  private stopping = false;

  // --- definitions ---

  setDefinitions(defs: TerminalDefinition[]): void {
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }
  upsertDefinition(def: TerminalDefinition): void {
    this.defs.set(def.id, def);
    this.sessions.get(def.id)?.updateDefinition(def);
  }
  getDefinition(id: TerminalId): TerminalDefinition | undefined {
    return this.defs.get(id);
  }

  // --- lifecycle ---

  private ensureSession(def: TerminalDefinition): TerminalSession {
    let s = this.sessions.get(def.id);
    if (!s) {
      s = new TerminalSession(def);
      s.on('output', (data: string) =>
        this.emit('output', { termId: def.id, data } satisfies ManagerOutputEvent),
      );
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
    return s.start(cols, rows);
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
    const s = this.ensureSession(def);
    s.updateDefinition(def);
    return s.restart(cols, rows);
  }

  write(id: TerminalId, data: string): void {
    this.sessions.get(id)?.write(data);
  }
  resize(id: TerminalId, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
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
  listStatuses(): TerminalRuntimeStatus[] {
    return [...this.sessions.values()].map((s) => s.getStatus());
  }

  /** Dispose the live process (used when a definition is deleted). */
  async remove(id: TerminalId): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      await s.dispose();
      this.sessions.delete(id);
    }
    this.defs.delete(id);
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
        return target.termIds.filter((id) => this.defs.has(id));
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
      if (!this.defs.has(id)) {
        failed.push({ termId: id, code: 'UNKNOWN' });
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
      this.write(id, payload);
      written += 1;
    }

    return { matched: ids.length, written, failed };
  }
}
