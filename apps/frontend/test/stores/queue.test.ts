import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useQueueStore } from '~/stores/queue';
import type { QueueEvent, QueueJobView, QueueState, QueueStep, TigerStageId } from '~/types';

const api = vi.hoisted(() => ({
  getQueueState: vi.fn(),
  getQueueHistory: vi.fn(),
  enqueueQueue: vi.fn(),
  reorderQueue: vi.fn(),
  bulkQueue: vi.fn(),
  pauseQueueJob: vi.fn(),
  resumeQueueJob: vi.fn(),
  cancelQueueJob: vi.fn(),
  retryQueueJob: vi.fn(),
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));

function step(jobId: string, stepKey: TigerStageId, position: number, status: QueueStep['status'] = 'pending'): QueueStep {
  return {
    id: `${jobId}-${stepKey}`,
    jobId,
    stepKey,
    position,
    status,
    attempts: status === 'pending' ? 0 : 1,
    error: null,
    checkpoint: null,
    startedAt: status === 'running' || status === 'completed' ? '2026-06-18T08:00:00.000Z' : null,
    completedAt: status === 'completed' ? '2026-06-18T08:05:00.000Z' : null,
    createdAt: '2026-06-18T07:00:00.000Z',
    updatedAt: '2026-06-18T08:00:00.000Z',
  };
}

function job(id: string, overrides: Partial<QueueJobView> = {}): QueueJobView {
  const base: QueueJobView = {
    id,
    position: id === 'a' ? 2 : 1,
    status: 'queued',
    priority: 0,
    provider: 'codex',
    workspacePath: `C:\\queue\\${id}`,
    projectName: `Project ${id}`,
    prompt: `Prompt ${id}`,
    configSnapshot: {},
    attempts: 0,
    maxAttempts: 1,
    blockedReason: null,
    resumeAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-06-18T07:00:00.000Z',
    updatedAt: '2026-06-18T07:00:00.000Z',
    steps: [step(id, 'brainstorming', 1), step(id, 'writing-plan', 2)],
  };
  return { ...base, ...overrides };
}

function event(id: string, jobId: string | null, type: string, message: string, createdAt = '2026-06-18T08:00:00.000Z'): QueueEvent {
  return { id, jobId, type, message, payload: null, createdAt };
}

function state(jobs: QueueJobView[], events: QueueEvent[] = []): QueueState {
  return {
    queuePipelineV2: false,
    jobs,
    rules: [
      {
        id: 'rule-1',
        name: 'Claude usage >= 90%',
        enabled: true,
        provider: 'claude',
        windowKey: 'any',
        metric: 'percent_used',
        operator: 'gte',
        threshold: 90,
        action: 'block_dispatch',
        config: null,
        createdAt: '2026-06-18T07:00:00.000Z',
        updatedAt: '2026-06-18T07:00:00.000Z',
      },
    ],
    events,
    runningByProvider: { claude: 0, codex: 0, antigravity: 0, mixed: 0 },
    providerConcurrency: { claude: 1, codex: 1, antigravity: 1, mixed: 1 },
    updatedAt: '2026-06-18T08:00:00.000Z',
  };
}

function v2State(allJobs: QueueJobView[], liveItems?: QueueJobView[]): QueueState {
  const terminalJobs = allJobs.filter((item) => item.status === 'completed' || item.status === 'failed' || item.status === 'canceled');
  return {
    ...state(allJobs),
    queuePipelineV2: true,
    liveItems: liveItems ?? allJobs.filter((item) => item.status !== 'completed' && item.status !== 'failed' && item.status !== 'canceled'),
    historyCounts: {
      total: terminalJobs.length,
      byStatus: terminalJobs.reduce<NonNullable<QueueState['historyCounts']>['byStatus']>((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {}),
      byTarget: {},
    },
  };
}

describe('useQueueStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    api.getQueueHistory.mockResolvedValue({ items: [], total: 0, nextCursor: null, hasMore: false });
  });

  it('loads and exposes jobs in queue order', async () => {
    api.getQueueState.mockResolvedValueOnce(state([job('a'), job('b')]));
    const store = useQueueStore();

    await store.load();

    expect(store.loaded).toBe(true);
    expect(store.jobs.map((item) => item.id)).toEqual(['b', 'a']);
    expect(store.rules).toHaveLength(1);
  });

  it('uses liveItems as the visible queue when the explicit v2 flag is enabled', async () => {
    const finished = job('finished', { status: 'completed', completedAt: '2026-06-18T09:00:00.000Z' });
    const live = [job('a'), job('b')];
    api.getQueueState.mockResolvedValueOnce(v2State([finished, ...live], live));
    const store = useQueueStore();

    await store.load();

    expect(store.queuePipelineV2).toBe(true);
    expect(store.jobs.map((item) => item.id)).toEqual(['b', 'a']);
    expect(store.historyCounts.total).toBe(1);
    expect(store.jobs.some((item) => item.id === 'finished')).toBe(false);
  });

  it('does not infer v2 from liveItems/historyCounts when the explicit flag is disabled', async () => {
    const finished = job('finished', { status: 'completed', completedAt: '2026-06-18T09:00:00.000Z' });
    const live = [job('a')];
    api.getQueueState.mockResolvedValueOnce({ ...v2State([finished, ...live], live), queuePipelineV2: false });
    const store = useQueueStore();

    await store.load();

    expect(store.queuePipelineV2).toBe(false);
    expect(store.jobs.map((item) => item.id)).toEqual(['finished', 'a']);
    expect(store.terminalJobs.map((item) => item.id)).toEqual(['finished']);
  });

  it('loads queue history pages separately from live jobs', async () => {
    api.getQueueHistory.mockResolvedValueOnce({
      items: [job('finished', { status: 'failed', targetType: 'team', completedAt: '2026-06-18T09:00:00.000Z' })],
      total: 1,
      nextCursor: null,
      hasMore: false,
    });
    const store = useQueueStore();

    await store.loadHistory({ status: 'failed', target: 'team', limit: 25 });

    expect(api.getQueueHistory).toHaveBeenCalledWith({ status: 'failed', target: 'team', limit: 25 });
    expect(store.historyItems.map((item) => item.id)).toEqual(['finished']);
    expect(store.historyTotal).toBe(1);
    expect(store.historyHasMore).toBe(false);
  });

  it('enqueues then reconciles through REST state', async () => {
    api.enqueueQueue.mockResolvedValueOnce(job('a'));
    api.getQueueState.mockResolvedValueOnce(state([job('a')]));
    const store = useQueueStore();

    await store.enqueue({ prompt: 'Run this', provider: 'codex', maxAttempts: 2 });

    expect(api.enqueueQueue).toHaveBeenCalledWith({ prompt: 'Run this', provider: 'codex', maxAttempts: 2 });
    expect(api.getQueueState).toHaveBeenCalledOnce();
    expect(store.jobs[0]?.id).toBe('a');
  });

  it('runs job controls and reloads after each mutation', async () => {
    api.getQueueState.mockResolvedValue(state([job('a')]));
    api.pauseQueueJob.mockResolvedValue(job('a', { status: 'paused' }));
    api.resumeQueueJob.mockResolvedValue(job('a'));
    api.cancelQueueJob.mockResolvedValue(job('a', { status: 'canceled' }));
    api.retryQueueJob.mockResolvedValue(job('a', { status: 'retrying' }));
    const store = useQueueStore();

    await store.pause('a');
    await store.resume('a');
    await store.cancel('a');
    await store.retry('a');

    expect(api.pauseQueueJob).toHaveBeenCalledWith('a');
    expect(api.resumeQueueJob).toHaveBeenCalledWith('a');
    expect(api.cancelQueueJob).toHaveBeenCalledWith('a');
    expect(api.retryQueueJob).toHaveBeenCalledWith('a');
    expect(api.getQueueState).toHaveBeenCalledTimes(4);
  });

  it('runs bulk actions and reconciles from the returned state', async () => {
    const store = useQueueStore();
    api.bulkQueue.mockResolvedValueOnce({
      action: 'cancel',
      results: [
        { id: 'a', ok: true, status: 'canceled' },
        { id: 'b', ok: false, error: 'cannot cancel job in completed state' },
      ],
      state: state([job('a', { status: 'canceled' }), job('b', { status: 'completed' })]),
    });

    const results = await store.bulk('cancel', ['a', 'b']);

    expect(api.bulkQueue).toHaveBeenCalledWith('cancel', ['a', 'b']);
    expect(results).toHaveLength(2);
    expect(results[1]?.ok).toBe(false);
    expect(store.jobs.find((item) => item.id === 'a')?.status).toBe('canceled');
  });

  it('skips the bulk request when no ids are selected', async () => {
    const store = useQueueStore();
    const results = await store.bulk('pause', []);
    expect(results).toEqual([]);
    expect(api.bulkQueue).not.toHaveBeenCalled();
  });

  it('applies queue.state snapshots and restores persisted events', () => {
    const store = useQueueStore();
    store.applyState(state([job('a')], [event('evt-submitted', 'a', 'queue.submitted', 'Submitted')]));

    store.applyState(
      state([
        job('a', {
          status: 'running',
          currentStep: 'brainstorming',
          updatedAt: '2026-06-18T08:10:00.000Z',
          steps: [step('a', 'brainstorming', 1, 'running'), step('a', 'writing-plan', 2)],
        }),
      ], [
        event('evt-step', 'a', 'queue.step.running', 'Queue step started: brainstorming.', '2026-06-18T08:10:00.000Z'),
      ]),
    );

    expect(store.activeJob?.id).toBe('a');
    expect(store.events.map((event) => event.type)).toContain('queue.submitted');
    expect(store.events.map((event) => event.type)).toContain('queue.step.running');
    expect(store.events.some((event) => event.type === 'queue.step.current')).toBe(false);
  });
});
