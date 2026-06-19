import { EventEmitter } from 'node:events';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { STAGE_ORDER, type StageId, type StageRunConfig } from '../orchestrator/types.js';
import { RuleEngine } from '../queue/RuleEngine.js';
import type {
  QueueEvent,
  QueueJob,
  QueueJobConfigSnapshot,
  QueueJobPatch,
  QueueJobStatus,
  QueueJobView,
  QueueProvider,
  QueueRepository,
  QueueRepositoryTx,
  QueueRule,
  QueueRuleDecision,
  QueueState,
  QueueStep,
  QueueStepPatch,
} from '../queue/types.js';
import { QUEUE_TERMINAL_STATUSES } from '../queue/types.js';

const QUEUE_STATE_EVENT_LIMIT = 120;

export interface EnqueueQueueJobInput {
  prompt: string;
  workspacePath?: string;
  projectName?: string;
  provider?: QueueProvider;
  priority?: number;
  maxAttempts?: number;
  configSnapshot?: QueueJobConfigSnapshot;
}

export type LeaseNextResult =
  | { kind: 'leased'; job: QueueJob }
  | { kind: 'blocked'; job: QueueJob; decision: QueueRuleDecision }
  | { kind: 'empty' };

export interface QueueControlEvent {
  action: 'pause' | 'cancel';
  jobId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(base: string, ms: number): string {
  return new Date(new Date(base).getTime() + ms).toISOString();
}

function cleanPrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, '\n').trim();
}

function sanitizeProjectName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '') || 'queue-project';
}

function inferProvider(input: EnqueueQueueJobInput): QueueProvider {
  if (input.provider) return input.provider;
  const configs = input.configSnapshot?.configs;
  if (!configs) return 'claude';
  const used = new Set<Exclude<QueueProvider, 'mixed'>>();
  for (const cfg of Object.values(configs)) {
    if (!cfg) continue;
    if ((cfg.claudeAgents ?? 0) > 0) used.add('claude');
    if ((cfg.codexAgents ?? 0) > 0) used.add('codex');
    if ((cfg.antigravityAgents ?? 0) > 0) used.add('antigravity');
  }
  if (used.size > 1) return 'mixed';
  const [only] = used;
  return only ?? 'claude';
}

function event(jobId: string | null, type: string, message: string, payload: Record<string, unknown> | null = null): QueueEvent {
  return { id: nanoid(), jobId, type, message, payload, createdAt: nowIso() };
}

function httpError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

function isDispatchable(job: QueueJob, now: string): boolean {
  if (job.status !== 'queued' && job.status !== 'retrying') return false;
  if (job.resumeAfter && new Date(job.resumeAfter).getTime() > new Date(now).getTime()) return false;
  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() > new Date(now).getTime()) return false;
  return true;
}

function statusAllowsPause(status: QueueJobStatus): boolean {
  return status === 'queued' || status === 'retrying' || status === 'running' || status === 'blocked_by_limit';
}

function statusAllowsResume(status: QueueJobStatus): boolean {
  return status === 'paused' || status === 'blocked_by_limit';
}

function statusAllowsRetry(status: QueueJobStatus): boolean {
  return status === 'failed' || status === 'canceled';
}

export class QueueService extends EventEmitter {
  private readonly ruleEngine = new RuleEngine();

  constructor(private readonly repo: QueueRepository) {
    super();
  }

  async getState(): Promise<QueueState> {
    const [jobs, rules, events] = await Promise.all([
      this.repo.listJobs(),
      this.repo.listRules(),
      this.repo.listEvents(QUEUE_STATE_EVENT_LIMIT),
    ]);
    const views: QueueJobView[] = [];
    for (const job of jobs) {
      views.push({ ...job, steps: await this.repo.listSteps(job.id) });
    }
    return { jobs: views, rules, events, updatedAt: nowIso() };
  }

  async enqueue(input: EnqueueQueueJobInput): Promise<QueueJob> {
    const prompt = cleanPrompt(input.prompt);
    if (!prompt) throw httpError(400, 'prompt is required');
    const created = nowIso();
    const id = nanoid();
    const projectName = input.projectName?.trim() || `Queue ${created.slice(0, 19).replace(/[T:]/g, '-')}`;
    const workspacePath =
      input.workspacePath?.trim() ||
      path.join(config.dataDir, 'queue-workspaces', `${sanitizeProjectName(projectName)}-${id.slice(0, 8)}`);
    const configSnapshot = input.configSnapshot ?? {};
    const job = await this.repo.transaction(async (tx) => {
      const position = await tx.nextPosition();
      const nextJob: QueueJob = {
        id,
        position,
        status: 'queued',
        priority: Number.isInteger(input.priority) ? input.priority! : 0,
        provider: inferProvider(input),
        workspacePath,
        projectName,
        prompt,
        configSnapshot,
        attempts: 0,
        maxAttempts: Number.isInteger(input.maxAttempts) && input.maxAttempts! > 0 ? input.maxAttempts! : 1,
        blockedReason: null,
        resumeAfter: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        currentStep: null,
        startedAt: null,
        completedAt: null,
        createdAt: created,
        updatedAt: created,
      };
      await tx.insertJob(nextJob);
      for (let i = 0; i < STAGE_ORDER.length; i++) {
        await tx.insertStep(makeStep(nextJob.id, STAGE_ORDER[i]!, i + 1, created));
      }
      await tx.insertEvent(event(nextJob.id, 'queue.submitted', 'Prompt submitted to the autonomous queue.', { provider: nextJob.provider }));
      await tx.insertEvent(
        event(nextJob.id, 'prompt.submitted', 'Queued prompt submitted.', {
          queueJobId: nextJob.id,
          projectId: nextJob.workspacePath,
          inputText: nextJob.prompt,
          provider: nextJob.provider,
        }),
      );
      return nextJob;
    });
    await this.emitState();
    this.emitHistoryChanged();
    return job;
  }

  async reorder(ids: string[]): Promise<void> {
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      await tx.replacePositions(unique, now);
      await tx.insertEvent(event(null, 'queue.reordered', 'Queue order changed.', { ids: unique }));
    });
    await this.emitState();
  }

  async pause(id: string): Promise<QueueJob> {
    let shouldControl = false;
    const job = await this.transitionJob(id, async (tx, current, now) => {
      if (!statusAllowsPause(current.status)) throw httpError(409, `cannot pause job in ${current.status} state`);
      shouldControl = current.status === 'running';
      const patch: QueueJobPatch = {
        status: 'paused',
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: null,
        resumeAfter: null,
        updatedAt: now,
      };
      await tx.updateJob(id, patch);
      await tx.insertEvent(event(id, 'queue.paused', 'Queue job paused.'));
      return { ...current, ...patch };
    });
    if (shouldControl) this.emit('control', { action: 'pause', jobId: id } satisfies QueueControlEvent);
    await this.emitState();
    return job;
  }

  async resume(id: string): Promise<QueueJob> {
    const job = await this.transitionJob(id, async (tx, current, now) => {
      if (!statusAllowsResume(current.status)) throw httpError(409, `cannot resume job in ${current.status} state`);
      const patch: QueueJobPatch = {
        status: 'queued',
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: null,
        resumeAfter: null,
        updatedAt: now,
      };
      await tx.updateJob(id, patch);
      await tx.insertEvent(event(id, 'queue.resumed', 'Queue job resumed.'));
      return { ...current, ...patch };
    });
    await this.emitState();
    return job;
  }

  async cancel(id: string): Promise<QueueJob> {
    let shouldControl = false;
    const job = await this.transitionJob(id, async (tx, current, now) => {
      if (QUEUE_TERMINAL_STATUSES.has(current.status)) return current;
      shouldControl = current.status === 'running';
      const patch: QueueJobPatch = {
        status: 'canceled',
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: null,
        resumeAfter: null,
        completedAt: now,
        updatedAt: now,
      };
      await tx.updateJob(id, patch);
      await tx.insertEvent(event(id, 'queue.canceled', 'Queue job canceled.'));
      return { ...current, ...patch };
    });
    if (shouldControl) this.emit('control', { action: 'cancel', jobId: id } satisfies QueueControlEvent);
    await this.emitState();
    return job;
  }

  async retry(id: string): Promise<QueueJob> {
    const job = await this.transitionJob(id, async (tx, current, now) => {
      if (!statusAllowsRetry(current.status)) throw httpError(409, `cannot retry job in ${current.status} state`);
      const patch: QueueJobPatch = {
        status: 'retrying',
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: null,
        resumeAfter: null,
        completedAt: null,
        updatedAt: now,
      };
      await tx.updateJob(id, patch);
      const steps = await tx.listSteps(id);
      for (const step of steps) {
        if (step.status === 'completed' || step.status === 'skipped') continue;
        await tx.updateStep(id, step.stepKey, {
          status: 'pending',
          error: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        });
      }
      await tx.insertEvent(event(id, 'queue.retrying', 'Queue job scheduled for retry.'));
      return { ...current, ...patch };
    });
    await this.emitState();
    return job;
  }

  async listRules(): Promise<QueueRule[]> {
    return this.repo.listRules();
  }

  async upsertRule(rule: Omit<QueueRule, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }): Promise<QueueRule> {
    const now = nowIso();
    const next: QueueRule = {
      ...rule,
      createdAt: rule.createdAt ?? now,
      updatedAt: rule.updatedAt ?? now,
    };
    await this.repo.transaction(async (tx) => {
      await tx.upsertRule(next);
      await tx.insertEvent(event(null, 'queue.rule.saved', `Queue rule saved: ${next.name}.`, { ruleId: next.id }));
    });
    await this.emitState();
    return next;
  }

  async deleteRule(id: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const deleted = await tx.deleteRule(id);
      if (!deleted) throw httpError(404, 'rule not found');
      await tx.insertEvent(event(null, 'queue.rule.deleted', 'Queue rule deleted.', { ruleId: id }));
    });
    await this.emitState();
  }

  async leaseNext(owner: string, leaseMs: number): Promise<LeaseNextResult> {
    const result = await this.repo.transaction<LeaseNextResult>(async (tx) => {
      const now = nowIso();
      const jobs = (await tx.listJobs())
        .filter((job) => isDispatchable(job, now))
        .sort((a, b) => b.priority - a.priority || a.position - b.position || a.createdAt.localeCompare(b.createdAt));
      const candidate = jobs[0];
      if (!candidate) return { kind: 'empty' };

      const decision = await this.evaluateRules(tx, candidate, now);
      if (!decision.allowed) {
        const patch: QueueJobPatch = {
          status: 'blocked_by_limit',
          blockedReason: decision.reason,
          resumeAfter: decision.resumeAfter,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        };
        await tx.updateJob(candidate.id, patch);
        await tx.insertEvent(event(candidate.id, 'queue.blocked_by_limit', decision.reason, { resumeAfter: decision.resumeAfter }));
        return { kind: 'blocked', job: { ...candidate, ...patch }, decision };
      }

      const patch: QueueJobPatch = {
        status: 'running',
        attempts: candidate.attempts + 1,
        leaseOwner: owner,
        leaseExpiresAt: addMs(now, leaseMs),
        blockedReason: null,
        resumeAfter: null,
        startedAt: candidate.startedAt ?? now,
        completedAt: null,
        updatedAt: now,
      };
      await tx.updateJob(candidate.id, patch);
      await tx.insertEvent(event(candidate.id, 'queue.leased', 'Queue job leased by scheduler.', { owner }));
      return { kind: 'leased', job: { ...candidate, ...patch } };
    });
    if (result.kind !== 'empty') await this.emitState();
    return result;
  }

  async refreshLease(id: string, owner: string, leaseMs: number): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const job = await requireJob(tx, id);
      if (job.status !== 'running' || job.leaseOwner !== owner) return;
      const now = nowIso();
      await tx.updateJob(id, { leaseExpiresAt: addMs(now, leaseMs), updatedAt: now });
    });
  }

  async markStepRunning(jobId: string, stepKey: StageId): Promise<void> {
    await this.patchStepAndJob(jobId, stepKey, {
      step: (step, now) => ({
        status: 'running',
        attempts: step.attempts + 1,
        error: null,
        startedAt: step.startedAt ?? now,
        completedAt: null,
        updatedAt: now,
      }),
      job: (_job, now) => ({ currentStep: stepKey, updatedAt: now }),
      eventType: 'queue.step.running',
      message: `Queue step started: ${stepKey}.`,
    });
  }

  async markStepCompleted(jobId: string, stepKey: StageId): Promise<void> {
    await this.patchStepAndJob(jobId, stepKey, {
      step: (_step, now) => ({ status: 'completed', error: null, completedAt: now, updatedAt: now }),
      job: (_job, now) => ({ currentStep: stepKey, updatedAt: now }),
      eventType: 'queue.step.completed',
      message: `Queue step completed: ${stepKey}.`,
    });
  }

  async markStepPending(jobId: string, stepKey: StageId, reason: string): Promise<void> {
    await this.patchStepAndJob(jobId, stepKey, {
      step: (_step, now) => ({
        status: 'pending',
        error: reason,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      }),
      job: (_job, now) => ({ currentStep: stepKey, updatedAt: now }),
      eventType: 'queue.step.pending',
      message: reason,
    });
  }

  async markStepFailed(jobId: string, stepKey: StageId, reason: string): Promise<void> {
    await this.patchStepAndJob(jobId, stepKey, {
      step: (_step, now) => ({ status: 'failed', error: reason, completedAt: now, updatedAt: now }),
      job: (_job, now) => ({ currentStep: stepKey, updatedAt: now }),
      eventType: 'queue.step.failed',
      message: reason,
    });
  }

  async completeJob(id: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      const job = await requireJob(tx, id);
      await tx.updateJob(id, {
        status: 'completed',
        leaseOwner: null,
        leaseExpiresAt: null,
        blockedReason: null,
        resumeAfter: null,
        completedAt: now,
        updatedAt: now,
      });
      await tx.insertEvent(event(id, 'queue.completed', 'Queue job completed.'));
      await tx.insertEvent(
        event(id, 'prompt.completed', 'Queued prompt completed.', {
          queueJobId: id,
          projectId: job.workspacePath,
          inputText: job.prompt,
        }),
      );
    });
    await this.emitState();
    this.emitHistoryChanged();
  }

  async failJob(id: string, reason: string): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      const job = await requireJob(tx, id);
      const retry = job.attempts < job.maxAttempts;
      await tx.updateJob(id, {
        status: retry ? 'retrying' : 'failed',
        blockedReason: retry ? reason : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: retry ? null : now,
        updatedAt: now,
      });
      await tx.insertEvent(event(id, retry ? 'queue.retrying' : 'queue.failed', reason));
      await tx.insertEvent(
        event(id, retry ? 'prompt.retrying' : 'prompt.failed', reason, {
          queueJobId: id,
          projectId: job.workspacePath,
          inputText: job.prompt,
        }),
      );
    });
    await this.emitState();
    this.emitHistoryChanged();
  }

  async blockRunningJob(id: string, decision: QueueRuleDecision): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      await requireJob(tx, id);
      await tx.updateJob(id, {
        status: 'blocked_by_limit',
        blockedReason: decision.reason,
        resumeAfter: decision.resumeAfter,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      await tx.insertEvent(event(id, 'queue.blocked_by_limit', decision.reason, { resumeAfter: decision.resumeAfter }));
    });
    await this.emitState();
  }

  async getJob(id: string): Promise<QueueJob | null> {
    return this.repo.getJob(id);
  }

  async listSteps(id: string): Promise<QueueStep[]> {
    return this.repo.listSteps(id);
  }

  async evaluateJobRules(job: QueueJob): Promise<QueueRuleDecision> {
    return this.repo.transaction((tx) => this.evaluateRules(tx, job, nowIso()));
  }

  async reclaimStaleLeases(owner: string): Promise<number> {
    let count = 0;
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      const jobs = await tx.listJobs();
      for (const job of jobs) {
        if (job.status !== 'running') continue;
        count++;
        await tx.updateJob(job.id, {
          status: 'retrying',
          leaseOwner: null,
          leaseExpiresAt: null,
          blockedReason: 'Recovered after backend restart; resuming from the last completed step.',
          updatedAt: now,
        });
        for (const step of await tx.listSteps(job.id)) {
          if (step.status === 'running') {
            await tx.updateStep(job.id, step.stepKey, {
              status: 'pending',
              error: 'Recovered after backend restart.',
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            });
          }
        }
        await tx.insertEvent(event(job.id, 'queue.lease.reclaimed', 'Stale queue lease reclaimed.', { owner: job.leaseOwner }));
      }
    });
    if (count > 0) await this.emitState();
    return count;
  }

  async resumeLimitBlockedJobs(): Promise<number> {
    let count = 0;
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      const jobs = (await tx.listJobs()).filter((job) => job.status === 'blocked_by_limit');
      for (const job of jobs) {
        const dueByTime = !!job.resumeAfter && new Date(job.resumeAfter).getTime() <= Date.now();
        const decision = await this.evaluateRules(tx, job, now);
        if (!dueByTime && !decision.allowed) continue;
        count++;
        await tx.updateJob(job.id, {
          status: 'queued',
          blockedReason: null,
          resumeAfter: null,
          updatedAt: now,
        });
        await tx.insertEvent(
          event(job.id, 'queue.limit_resumed', dueByTime ? 'Limit reset time reached; queue job resumed.' : 'Fresh limit snapshot allows dispatch.'),
        );
      }
    });
    if (count > 0) await this.emitState();
    return count;
  }

  async nextResumeAfter(): Promise<string | null> {
    const jobs = await this.repo.listJobs();
    return jobs
      .filter((job) => job.status === 'blocked_by_limit' && !!job.resumeAfter)
      .map((job) => job.resumeAfter!)
      .sort()[0] ?? null;
  }

  private async evaluateRules(tx: QueueRepositoryTx, job: QueueJob, now: string): Promise<QueueRuleDecision> {
    const rules = await tx.listRules();
    const snapshots = {
      claude: await tx.getLatestLimitSnapshot('claude'),
      codex: await tx.getLatestLimitSnapshot('codex'),
      antigravity: await tx.getLatestLimitSnapshot('antigravity'),
    };
    return this.ruleEngine.evaluate(job, rules, snapshots, new Date(now));
  }

  private async transitionJob(
    id: string,
    fn: (tx: QueueRepositoryTx, job: QueueJob, now: string) => Promise<QueueJob>,
  ): Promise<QueueJob> {
    return this.repo.transaction(async (tx) => fn(tx, await requireJob(tx, id), nowIso()));
  }

  private async patchStepAndJob(
    jobId: string,
    stepKey: StageId,
    opts: {
      step: (step: QueueStep, now: string) => QueueStepPatch;
      job: (job: QueueJob, now: string) => QueueJobPatch;
      eventType: string;
      message: string;
    },
  ): Promise<void> {
    await this.repo.transaction(async (tx) => {
      const now = nowIso();
      const job = await requireJob(tx, jobId);
      const step = (await tx.listSteps(jobId)).find((s) => s.stepKey === stepKey);
      if (!step) throw httpError(404, 'queue step not found');
      await tx.updateStep(jobId, stepKey, opts.step(step, now));
      await tx.updateJob(jobId, opts.job(job, now));
      await tx.insertEvent(event(jobId, opts.eventType, opts.message, { step: stepKey }));
    });
    await this.emitState();
  }

  private async emitState(): Promise<void> {
    this.emit('state', await this.getState());
  }

  private emitHistoryChanged(): void {
    this.emit('history.changed');
  }
}

function makeStep(jobId: string, stepKey: StageId, position: number, now: string): QueueStep {
  return {
    id: nanoid(),
    jobId,
    stepKey,
    position,
    status: 'pending',
    attempts: 0,
    error: null,
    checkpoint: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function requireJob(tx: QueueRepositoryTx, id: string): Promise<QueueJob> {
  const job = await tx.getJob(id);
  if (!job) throw httpError(404, 'queue job not found');
  return job;
}
