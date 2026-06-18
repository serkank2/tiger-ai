import type { StageId } from '../orchestrator/types.js';
import type {
  QueueEvent,
  QueueJob,
  QueueJobPatch,
  QueueLimitSnapshot,
  QueueRepository,
  QueueRepositoryTx,
  QueueRule,
  QueueStep,
  QueueStepPatch,
} from './types.js';
import { cloneQueueEvent, cloneQueueJob, cloneQueueRule, cloneQueueStep } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function defaultRule(now = nowIso()): QueueRule {
  return {
    id: 'builtin-claude-usage-gte-90',
    name: 'Claude usage >= 90% pauses queue dispatch',
    enabled: true,
    provider: 'claude',
    windowKey: 'any',
    metric: 'percent_used',
    operator: 'gte',
    threshold: 90,
    action: 'block_dispatch',
    config: { resumeFrom: 'reset_at' },
    createdAt: now,
    updatedAt: now,
  };
}

interface Snapshot {
  jobs: QueueJob[];
  steps: QueueStep[];
  events: QueueEvent[];
  rules: QueueRule[];
  limitSnapshots: QueueLimitSnapshot[];
}

export class MemoryQueueRepository implements QueueRepository {
  private jobs = new Map<string, QueueJob>();
  private steps = new Map<string, QueueStep>();
  private events = new Map<string, QueueEvent>();
  private rules = new Map<string, QueueRule>();
  private limitSnapshots: QueueLimitSnapshot[] = [];
  private gate: Promise<unknown> = Promise.resolve();

  constructor(seedRules = true) {
    if (seedRules) {
      const rule = defaultRule();
      this.rules.set(rule.id, rule);
    }
  }

  addLimitSnapshot(snapshot: QueueLimitSnapshot): void {
    this.limitSnapshots.push(structuredClone(snapshot));
  }

  async transaction<T>(fn: (tx: QueueRepositoryTx) => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const snap = this.snapshot();
      try {
        return await fn(this);
      } catch (err) {
        this.restore(snap);
        throw err;
      }
    });
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async nextPosition(): Promise<number> {
    return [...this.jobs.values()].reduce((max, job) => Math.max(max, job.position), 0) + 1;
  }

  async insertJob(job: QueueJob): Promise<void> {
    this.jobs.set(job.id, cloneQueueJob(job));
  }

  async insertStep(step: QueueStep): Promise<void> {
    this.steps.set(step.id, cloneQueueStep(step));
  }

  async insertEvent(event: QueueEvent): Promise<void> {
    this.events.set(event.id, structuredClone(event));
  }

  async getJob(id: string): Promise<QueueJob | null> {
    const job = this.jobs.get(id);
    return job ? cloneQueueJob(job) : null;
  }

  async listJobs(): Promise<QueueJob[]> {
    return [...this.jobs.values()]
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))
      .map(cloneQueueJob);
  }

  async listSteps(jobId: string): Promise<QueueStep[]> {
    return [...this.steps.values()]
      .filter((step) => step.jobId === jobId)
      .sort((a, b) => a.position - b.position)
      .map(cloneQueueStep);
  }

  async listEvents(limit = 120): Promise<QueueEvent[]> {
    const requested = Number.isFinite(limit) ? Math.trunc(limit) : 120;
    const bounded = Math.max(1, Math.min(500, requested));
    return [...this.events.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, bounded)
      .map(cloneQueueEvent);
  }

  async listRules(): Promise<QueueRule[]> {
    return [...this.rules.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(cloneQueueRule);
  }

  async getLatestLimitSnapshot(provider: Exclude<QueueLimitSnapshot['provider'], never>): Promise<QueueLimitSnapshot | null> {
    const snapshots = this.limitSnapshots
      .filter((snapshot) => snapshot.provider === provider)
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
    return snapshots[0] ? structuredClone(snapshots[0]) : null;
  }

  async updateJob(id: string, patch: QueueJobPatch): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.set(id, { ...job, ...structuredClone(patch) });
  }

  async updateStep(jobId: string, stepKey: StageId, patch: QueueStepPatch): Promise<void> {
    const step = [...this.steps.values()].find((s) => s.jobId === jobId && s.stepKey === stepKey);
    if (!step) return;
    this.steps.set(step.id, { ...step, ...structuredClone(patch) });
  }

  async replacePositions(ids: string[], now: string): Promise<void> {
    const wanted = new Set(ids);
    let position = 1;
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (job) this.jobs.set(id, { ...job, position: position++, updatedAt: now });
    }
    const rest = [...this.jobs.values()]
      .filter((job) => !wanted.has(job.id))
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    for (const job of rest) {
      this.jobs.set(job.id, { ...job, position: position++, updatedAt: now });
    }
  }

  async upsertRule(rule: QueueRule): Promise<void> {
    this.rules.set(rule.id, cloneQueueRule(rule));
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  private snapshot(): Snapshot {
    return {
      jobs: [...this.jobs.values()].map(cloneQueueJob),
      steps: [...this.steps.values()].map(cloneQueueStep),
      events: [...this.events.values()].map(cloneQueueEvent),
      rules: [...this.rules.values()].map(cloneQueueRule),
      limitSnapshots: this.limitSnapshots.map((snapshot) => structuredClone(snapshot)),
    };
  }

  private restore(snapshot: Snapshot): void {
    this.jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
    this.steps = new Map(snapshot.steps.map((step) => [step.id, step]));
    this.events = new Map(snapshot.events.map((event) => [event.id, event]));
    this.rules = new Map(snapshot.rules.map((rule) => [rule.id, rule]));
    this.limitSnapshots = snapshot.limitSnapshots;
  }
}
