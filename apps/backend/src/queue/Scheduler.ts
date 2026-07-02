import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import type { QueueService, QueueControlEvent } from '../services/QueueService.js';
import type { QueueJob, QueueTargetType, QueueTeamTargetPayload, QueueTerminalTargetPayload } from './types.js';
import type { PersistedState, TerminalDefinition, TerminalRuntimeStatus } from '../store/types.js';

// ---------------------------------------------------------------------------
// Queue dispatcher. Leases jobs (SKIP LOCKED upstream) and executes them
// against one of two targets:
//   - terminal: create + start a PTY terminal with the job's command (human
//     terminals remain a first-class feature).
//   - run (legacy target types 'project' and 'team' both map here): drive the
//     v2 RunEngine — 'project'/'team create' jobs become a new run with the
//     job's prompt as the goal; 'team append' jobs steer the active run. The
//     v1 Tiger stage pipeline and Team role-chat these targets used to drive
//     are gone (docs/REDESIGN.md).
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  owner?: string;
  leaseMs?: number;
  idlePollMs?: number;
  terminalTarget?: QueueTerminalTargetRuntime;
  runTarget?: QueueRunTargetRuntime;
}

export interface QueueTerminalTargetRuntime {
  state: Pick<PersistedState, 'terminals' | 'settings'>;
  manager: {
    upsertDefinition(def: TerminalDefinition): { deferred: boolean };
    start(id: string, cols?: number, rows?: number): Promise<TerminalRuntimeStatus>;
  };
  save(): Promise<void>;
}

/** Minimal structural view of the v2 RunEngine the scheduler drives. */
export interface QueueRunTargetRuntime {
  getSnapshot(): { runId: string; status: string } | null;
  createRun(input: { workspace: string; goal: string }): Promise<{ runId: string }>;
  start(): { runId: string; status: string };
  stop(reason?: string): Promise<unknown>;
  steer(body: string): Promise<unknown>;
  on(event: 'engine-event', listener: (payload: QueueRunEngineEvent) => void): unknown;
  off(event: 'engine-event', listener: (payload: QueueRunEngineEvent) => void): unknown;
}

export interface QueueRunEngineEvent {
  kind: string;
  state?: { runId: string; status: string; message?: string };
}

const RUN_TERMINAL_STATUSES = new Set(['completed', 'blocked', 'failed', 'stopped']);

function nowMs(): number {
  return Date.now();
}

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isQueueTargetType(value: unknown): value is QueueTargetType {
  return value === 'terminal' || value === 'project' || value === 'team';
}

function effectiveTargetType(job: QueueJob): QueueTargetType {
  return isQueueTargetType(job.targetType) ? job.targetType : 'project';
}

function terminalPayload(job: QueueJob): QueueTerminalTargetPayload {
  const payload = job.targetPayload;
  if (!isRecord(payload) || typeof payload.name !== 'string' || !payload.name.trim()) {
    throw new Error('Terminal target payload is missing a name.');
  }
  return payload as unknown as QueueTerminalTargetPayload;
}

function teamPayload(job: QueueJob): QueueTeamTargetPayload {
  const payload = job.targetPayload;
  if (!isRecord(payload) || (payload.mode !== 'append' && payload.mode !== 'create')) {
    throw new Error('Team target payload is missing a mode.');
  }
  if (payload.mode === 'append' && (typeof payload.runId !== 'string' || !payload.runId.trim())) {
    throw new Error('Team append target payload is missing a runId.');
  }
  return payload as unknown as QueueTeamTargetPayload;
}

export class Scheduler {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly idlePollMs: number;
  private readonly terminalTarget?: QueueTerminalTargetRuntime;
  private readonly runTarget?: QueueRunTargetRuntime;
  private wakeTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private working = false;
  private stopped = false;
  private activeJobId: string | null = null;

  constructor(
    private readonly queue: QueueService,
    options: SchedulerOptions = {},
  ) {
    this.owner = options.owner ?? `queue-${process.pid}-${nanoid(4)}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.idlePollMs = options.idlePollMs ?? 5_000;
    this.terminalTarget = options.terminalTarget;
    this.runTarget = options.runTarget;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.queue.reclaimStaleLeases(this.owner);
    this.queue.on('state', this.onQueueState);
    this.queue.on('control', this.onQueueControl);
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.queue.off('state', this.onQueueState);
    this.queue.off('control', this.onQueueControl);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.wakeTimer = null;
    this.resumeTimer = null;
  }

  wake(): void {
    if (this.stopped) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => void this.runLoop(), 0);
    this.wakeTimer.unref();
  }

  private readonly onQueueState = (): void => {
    this.wake();
  };

  private readonly onQueueControl = (evt: QueueControlEvent): void => {
    if (evt.jobId !== this.activeJobId) return;
    if (evt.action === 'pause' || evt.action === 'cancel') {
      void this.runTarget?.stop(`Queue job ${evt.action} requested.`);
    }
  };

  private async runLoop(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      await this.queue.resumeLimitBlockedJobs();
      while (!this.stopped) {
        const leased = await this.queue.leaseNext(this.owner, this.leaseMs);
        if (leased.kind === 'empty') break;
        if (leased.kind === 'blocked') {
          await this.armResumeTimer();
          continue;
        }
        await this.runJob(leased.job);
        await this.queue.resumeLimitBlockedJobs();
      }
      await this.armResumeTimer();
    } finally {
      this.working = false;
      if (!this.stopped) {
        this.wakeTimer = setTimeout(() => void this.runLoop(), this.idlePollMs);
        this.wakeTimer.unref();
      }
    }
  }

  private async runJob(job: QueueJob): Promise<void> {
    this.activeJobId = job.id;
    let leaseRefresh: NodeJS.Timeout | null = null;
    try {
      leaseRefresh = setInterval(
        () => void this.queue.refreshLease(job.id, this.owner, this.leaseMs),
        Math.max(1000, this.leaseMs / 2),
      );
      leaseRefresh.unref();
      const targetType = effectiveTargetType(job);
      if (targetType === 'terminal') {
        await this.runTerminalJob(job);
        return;
      }
      if (targetType === 'team') {
        await this.runTeamJob(job);
        return;
      }
      await this.runWorkspaceJob(job);
    } catch (err) {
      const targetType = effectiveTargetType(job);
      await this.queue.failJob(
        job.id,
        messageFromUnknown(err),
        targetType === 'project' ? undefined : `${targetType}_dispatch`,
      );
    } finally {
      if (leaseRefresh) clearInterval(leaseRefresh);
      this.activeJobId = null;
    }
  }

  /** 'project' jobs: run the queued prompt as a full v2 run against the workspace. */
  private async runWorkspaceJob(job: QueueJob): Promise<void> {
    const target = this.requireRunTarget();
    await fs.mkdir(job.workspacePath, { recursive: true });
    const created = await target.createRun({ workspace: job.workspacePath, goal: job.prompt });
    await this.queue.recordTargetRef(job.id, { runId: created.runId });
    const outcome = await this.driveRunToEnd(target, created.runId);
    if (outcome.status === 'completed') {
      await this.queue.completeJob(job.id);
      return;
    }
    await this.queue.failJob(job.id, outcome.message ?? `run ended with status ${outcome.status}`, 'run_dispatch');
  }

  private async runTerminalJob(job: QueueJob): Promise<void> {
    if (!this.terminalTarget) throw new Error('Queue terminal target is not configured.');
    const payload = terminalPayload(job);
    const now = new Date().toISOString();
    const cwd = payload.cwd || job.workspacePath;
    await fs.mkdir(cwd, { recursive: true });
    const def: TerminalDefinition = {
      id: nanoid(),
      name: payload.name,
      groupId: payload.groupId ?? null,
      cwd,
      initialCommand: payload.initialCommand ?? job.body ?? job.prompt,
      shell:
        (payload.shell as TerminalDefinition['shell'] | undefined) ?? this.terminalTarget.state.settings.defaultShell,
      env: payload.env,
      autostart: payload.autostart,
      protected: payload.protected,
      createdAt: now,
      updatedAt: now,
    };
    this.terminalTarget.state.terminals.push(def);
    this.terminalTarget.manager.upsertDefinition(def);
    await this.terminalTarget.save();
    await this.terminalTarget.manager.start(def.id, payload.cols, payload.rows);
    await this.queue.recordTargetRef(job.id, { terminalId: def.id });
    await this.queue.completeJob(job.id);
  }

  /** 'team' jobs map onto the v2 run: append = steer the active run; create = new run. */
  private async runTeamJob(job: QueueJob): Promise<void> {
    const target = this.requireRunTarget();
    const payload = teamPayload(job);
    const body = job.body ?? job.prompt;
    if (payload.mode === 'append') {
      const active = target.getSnapshot();
      if (!active || active.runId !== payload.runId) {
        throw new Error(`No active run is available for ${payload.runId}.`);
      }
      await target.steer(body);
      await this.queue.recordTargetRef(job.id, { runId: active.runId });
      await this.queue.completeJob(job.id);
      return;
    }

    const created = await target.createRun({
      workspace: payload.workspacePath ?? payload.workspace ?? job.workspacePath,
      goal: body,
    });
    await this.queue.recordTargetRef(job.id, { runId: created.runId });
    const outcome = await this.driveRunToEnd(target, created.runId);
    if (outcome.status === 'completed') {
      await this.queue.completeJob(job.id);
      return;
    }
    await this.queue.failJob(job.id, outcome.message ?? `run ended with status ${outcome.status}`, 'run_dispatch');
  }

  /** Start the created run and resolve when the engine reports a terminal status. */
  private driveRunToEnd(target: QueueRunTargetRuntime, runId: string): Promise<{ status: string; message?: string }> {
    return new Promise((resolve, reject) => {
      const onEvent = (payload: QueueRunEngineEvent): void => {
        if (payload.kind !== 'state' || payload.state?.runId !== runId) return;
        if (!RUN_TERMINAL_STATUSES.has(payload.state.status)) return;
        cleanup();
        resolve({ status: payload.state.status, message: payload.state.message });
      };
      const cleanup = (): void => {
        target.off('engine-event', onEvent);
      };
      target.on('engine-event', onEvent);
      try {
        const started = target.start();
        if (RUN_TERMINAL_STATUSES.has(started.status)) {
          cleanup();
          resolve({ status: started.status });
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  private requireRunTarget(): QueueRunTargetRuntime {
    if (!this.runTarget) throw new Error('Queue run target is not configured.');
    return this.runTarget;
  }

  private async armResumeTimer(): Promise<void> {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    const resumeAfter = await this.queue.nextResumeAfter();
    if (!resumeAfter) return;
    const delay = Math.max(0, new Date(resumeAfter).getTime() - nowMs()) + 25;
    this.resumeTimer = setTimeout(() => this.wake(), delay);
    this.resumeTimer.unref();
  }
}
