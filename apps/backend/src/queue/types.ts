import type { StageId, StageRunConfig } from '../orchestrator/types.js';

export type QueueProvider = 'claude' | 'codex' | 'antigravity' | 'mixed';

export type QueueJobStatus =
  | 'queued'
  | 'running'
  | 'blocked_by_limit'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'retrying';

export type QueueStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type QueueRuleProvider = QueueProvider | 'any';
export type QueueRuleOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
export type QueueRuleAction = 'block_dispatch';

export const QUEUE_TERMINAL_STATUSES = new Set<QueueJobStatus>(['completed', 'failed', 'canceled']);

export interface QueueJobConfigSnapshot {
  fromStage?: StageId;
  configs?: Partial<Record<StageId, StageRunConfig>>;
  templateName?: string;
  values?: Record<string, unknown>;
}

export interface QueueJob {
  id: string;
  position: number;
  status: QueueJobStatus;
  priority: number;
  provider: QueueProvider;
  workspacePath: string;
  projectName: string | null;
  prompt: string;
  configSnapshot: QueueJobConfigSnapshot;
  attempts: number;
  maxAttempts: number;
  blockedReason: string | null;
  resumeAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  currentStep: StageId | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueStep {
  id: string;
  jobId: string;
  stepKey: StageId;
  position: number;
  status: QueueStepStatus;
  attempts: number;
  error: string | null;
  checkpoint: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueEvent {
  id: string;
  jobId: string | null;
  type: string;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface QueueRule {
  id: string;
  name: string;
  enabled: boolean;
  provider: QueueRuleProvider;
  windowKey: string;
  metric: 'percent_used';
  operator: QueueRuleOperator;
  threshold: number;
  action: QueueRuleAction;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueLimitSnapshot {
  provider: Exclude<QueueProvider, 'mixed'>;
  windowKey: string;
  percentUsed: number | null;
  resetAt: string | null;
  checkedAt: string;
}

export interface QueueJobView extends QueueJob {
  steps: QueueStep[];
}

export interface QueueState {
  jobs: QueueJobView[];
  rules: QueueRule[];
  events: QueueEvent[];
  updatedAt: string;
}

export interface QueueRuleDecision {
  allowed: boolean;
  reason: string;
  ruleId?: string;
  resumeAfter: string | null;
}

export interface QueueJobPatch {
  position?: number;
  status?: QueueJobStatus;
  priority?: number;
  provider?: QueueProvider;
  workspacePath?: string;
  projectName?: string | null;
  prompt?: string;
  configSnapshot?: QueueJobConfigSnapshot;
  attempts?: number;
  maxAttempts?: number;
  blockedReason?: string | null;
  resumeAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  currentStep?: StageId | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

export interface QueueStepPatch {
  status?: QueueStepStatus;
  attempts?: number;
  error?: string | null;
  checkpoint?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

export interface QueueRepositoryTx {
  nextPosition(): Promise<number>;
  insertJob(job: QueueJob): Promise<void>;
  insertStep(step: QueueStep): Promise<void>;
  insertEvent(event: QueueEvent): Promise<void>;
  getJob(id: string): Promise<QueueJob | null>;
  listJobs(): Promise<QueueJob[]>;
  /**
   * Lock and return dispatchable jobs ordered for dispatch (priority, position, age).
   * In SQL this uses `SELECT ... FOR UPDATE SKIP LOCKED`; concurrent schedulers never
   * see the same candidate. Only meaningful inside `transaction()`.
   */
  lockDispatchableJobs(now: string): Promise<QueueJob[]>;
  /**
   * Lock running jobs whose lease has expired (or that belong to `owner`) so they can
   * be reclaimed without stealing a job whose owner is still refreshing its lease.
   * Only meaningful inside `transaction()`.
   */
  lockReclaimableJobs(now: string, owner: string): Promise<QueueJob[]>;
  listSteps(jobId: string): Promise<QueueStep[]>;
  /** Fetch steps for many jobs in one query (avoids N+1 when assembling QueueState). */
  listStepsForJobs(jobIds: string[]): Promise<QueueStep[]>;
  listEvents(limit?: number): Promise<QueueEvent[]>;
  listRules(): Promise<QueueRule[]>;
  getLatestLimitSnapshot(provider: Exclude<QueueProvider, 'mixed'>): Promise<QueueLimitSnapshot | null>;
  updateJob(id: string, patch: QueueJobPatch): Promise<void>;
  updateStep(jobId: string, stepKey: StageId, patch: QueueStepPatch): Promise<void>;
  replacePositions(ids: string[], now: string): Promise<void>;
  upsertRule(rule: QueueRule): Promise<void>;
  deleteRule(id: string): Promise<boolean>;
}

export interface QueueRepository extends QueueRepositoryTx {
  transaction<T>(fn: (tx: QueueRepositoryTx) => Promise<T>): Promise<T>;
}

export function cloneQueueJob(job: QueueJob): QueueJob {
  return structuredClone(job);
}

export function cloneQueueStep(step: QueueStep): QueueStep {
  return structuredClone(step);
}

export function cloneQueueEvent(event: QueueEvent): QueueEvent {
  return structuredClone(event);
}

export function cloneQueueRule(rule: QueueRule): QueueRule {
  return structuredClone(rule);
}
