import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import { STAGE_ORDER, type OrchestratorState, type StageId, type StageRunConfig, type TigerConfig } from '../orchestrator/types.js';
import type { ExecutionOwner } from '../orchestrator/persistence.js';
import type { QueueService, QueueControlEvent } from '../services/QueueService.js';
import type { QueueJob } from './types.js';

export interface QueueOrchestrator extends EventEmitter {
  initialize(workspace: string, projectPrompt: string): Promise<void>;
  getConfig(): TigerConfig;
  getState(): OrchestratorState;
  startStage(stageId: StageId, cfg: StageRunConfig, auto?: boolean): void;
  stopStage(): void;
  setExecutionOwner(owner: ExecutionOwner | null): void;
}

export interface SchedulerOptions {
  owner?: string;
  /** Execution owner persisted for queue-dispatched runs. Defaults to a per-process `queue:*` owner. */
  executionOwner?: ExecutionOwner;
  leaseMs?: number;
  idlePollMs?: number;
}

const TERMINAL_STAGE_STATUSES = new Set(['completed', 'failed', 'stopped']);

function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultStageConfig(config: TigerConfig, stageId: StageId): StageRunConfig {
  const d = config.defaults;
  return {
    claudeAgents: d.claudeAgents,
    codexAgents: d.codexAgents,
    antigravityAgents: d.antigravityAgents,
    claudeModel: d.claudeModel,
    codexModel: d.codexModel,
    antigravityModel: d.antigravityModel,
    claudeEffort: d.claudeEffort,
    codexEffort: d.codexEffort,
    antigravityEffort: d.antigravityEffort,
    claudePermission: d.claudePermission,
    codexPermission: d.codexPermission,
    antigravityPermission: d.antigravityPermission,
    parallel: d.parallel,
    mergeAgent: stageId === 'merge-tasks' ? 'claude' : undefined,
  };
}

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Scheduler {
  private readonly owner: string;
  private readonly executionOwner: ExecutionOwner;
  private readonly leaseMs: number;
  private readonly idlePollMs: number;
  private wakeTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private working = false;
  private stopped = false;
  private activeJobId: string | null = null;

  constructor(
    private readonly queue: QueueService,
    private readonly orchestrator: QueueOrchestrator,
    options: SchedulerOptions = {},
  ) {
    this.owner = options.owner ?? `queue-${process.pid}`;
    this.executionOwner = options.executionOwner ?? { type: 'queue', id: `${process.pid}:${nanoid(6)}` };
    this.leaseMs = options.leaseMs ?? 60_000;
    this.idlePollMs = options.idlePollMs ?? 5_000;
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
    if (evt.action === 'pause' || evt.action === 'cancel') this.orchestrator.stopStage();
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
    // Persist every Tiger stage this job dispatches under the queue owner so execution_runs,
    // run_stages, agent_runs, task claims, and finding claims are recorded as queue-owned (not manual).
    this.orchestrator.setExecutionOwner(this.executionOwner);
    let leaseRefresh: NodeJS.Timeout | null = null;
    try {
      leaseRefresh = setInterval(() => void this.queue.refreshLease(job.id, this.owner, this.leaseMs), Math.max(1000, this.leaseMs / 2));
      leaseRefresh.unref();
      await fs.mkdir(job.workspacePath, { recursive: true });
      await this.orchestrator.initialize(job.workspacePath, job.prompt);

      const steps = await this.queue.listSteps(job.id);
      const fromStage = job.configSnapshot.fromStage;
      const fromIndex = fromStage ? STAGE_ORDER.indexOf(fromStage) : 0;
      const firstIndex = fromIndex >= 0 ? fromIndex : 0;

      for (const stage of STAGE_ORDER.slice(firstIndex)) {
        if (this.stopped) return;
        const latest = await this.queue.getJob(job.id);
        if (!latest || latest.status !== 'running') return;

        const step = steps.find((s) => s.stepKey === stage) ?? (await this.queue.listSteps(job.id)).find((s) => s.stepKey === stage);
        if (step?.status === 'completed' || step?.status === 'skipped') continue;

        const decision = await this.queue.evaluateJobRules(latest);
        if (!decision.allowed) {
          await this.queue.blockRunningJob(job.id, decision);
          await this.queue.markStepPending(job.id, stage, decision.reason);
          return;
        }

        await this.queue.markStepRunning(job.id, stage);
        const cfg = job.configSnapshot.configs?.[stage] ?? defaultStageConfig(this.orchestrator.getConfig(), stage);
        const outcome = await this.runStage(stage, cfg);
        const after = await this.queue.getJob(job.id);
        if (!after) return;
        if (after.status === 'paused') {
          await this.queue.markStepPending(job.id, stage, 'Paused by user.');
          return;
        }
        if (after.status === 'canceled') {
          await this.queue.markStepPending(job.id, stage, 'Canceled by user.');
          return;
        }
        if (outcome.status === 'completed') {
          await this.queue.markStepCompleted(job.id, stage);
          continue;
        }
        const reason = outcome.message || `Stage ${stage} ended with status ${outcome.status}.`;
        await this.queue.markStepFailed(job.id, stage, reason);
        await this.queue.failJob(job.id, reason);
        return;
      }

      await this.queue.completeJob(job.id);
    } catch (err) {
      await this.queue.failJob(job.id, messageFromUnknown(err));
    } finally {
      if (leaseRefresh) clearInterval(leaseRefresh);
      this.orchestrator.setExecutionOwner(null);
      this.activeJobId = null;
    }
  }

  private runStage(stageId: StageId, cfg: StageRunConfig): Promise<{ status: string; message?: string }> {
    return new Promise((resolve, reject) => {
      const onState = (state: OrchestratorState): void => {
        const stage = state.stages[stageId];
        if (!stage || stage.status === 'running' || !TERMINAL_STAGE_STATUSES.has(stage.status)) return;
        cleanup();
        resolve({ status: stage.status, message: stage.message });
      };
      const cleanup = (): void => {
        this.orchestrator.off('state', onState);
      };
      this.orchestrator.on('state', onState);
      try {
        this.orchestrator.startStage(stageId, cfg, false);
        onState(this.orchestrator.getState());
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
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
