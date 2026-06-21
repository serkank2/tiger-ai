import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { errText } from '~/lib/apiError';
import type {
  QueueBulkAction,
  QueueBulkResult,
  QueueClientEvent,
  QueueEnqueueInput,
  QueueHistoryQuery,
  QueueHistoryResponse,
  QueueJobStatus,
  QueueJobView,
  QueueRule,
  QueueState,
  QueueStepStatus,
} from '~/types';

const TERMINAL_STATUSES = new Set<QueueJobStatus>(['completed', 'failed', 'canceled']);
const EVENT_LIMIT = 120;

function byQueueOrder(a: QueueJobView, b: QueueJobView): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt);
}

function statusText(status: QueueJobStatus | QueueStepStatus): string {
  return status.replace(/_/g, ' ');
}

function eventId(jobId: string | null, type: string, at: string, suffix = ''): string {
  return `${jobId ?? 'queue'}:${type}:${at}:${suffix}`;
}

function sortEvents(items: QueueClientEvent[]): QueueClientEvent[] {
  return items
    .filter((event) => event.id && event.createdAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, EVENT_LIMIT);
}

export const useQueueStore = defineStore('queue', () => {
  const api = useApi();

  const state = ref<QueueState | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const actionError = ref<string | null>(null);
  const busyKeys = ref<Record<string, boolean>>({});
  const events = ref<QueueClientEvent[]>([]);
  const historyItems = ref<QueueJobView[]>([]);
  const historyTotal = ref(0);
  const historyNextCursor = ref<string | null>(null);
  const historyHasMore = ref(false);
  const historyLoaded = ref(false);
  const historyLoading = ref(false);
  const historyError = ref<string | null>(null);

  const queuePipelineV2 = computed(() => state.value?.queuePipelineV2 === true);
  const jobs = computed(() =>
    [...(queuePipelineV2.value ? state.value?.liveItems ?? [] : state.value?.jobs ?? [])].sort(byQueueOrder),
  );
  const rules = computed(() => state.value?.rules ?? []);
  const updatedAt = computed(() => state.value?.updatedAt ?? null);
  const activeJob = computed(() => jobs.value.find((job) => job.status === 'running') ?? null);
  const blockedJobs = computed(() => jobs.value.filter((job) => job.status === 'blocked_by_limit'));
  const pausedJobs = computed(() => jobs.value.filter((job) => job.status === 'paused'));
  const dispatchableJobs = computed(() =>
    jobs.value.filter((job) => job.status === 'queued' || job.status === 'retrying'),
  );
  const terminalJobs = computed(() =>
    queuePipelineV2.value ? [...historyItems.value] : jobs.value.filter((job) => TERMINAL_STATUSES.has(job.status)),
  );
  const historyCounts = computed(() =>
    state.value?.historyCounts ?? {
      total: jobs.value.filter((job) => TERMINAL_STATUSES.has(job.status)).length,
      byStatus: {},
      byTarget: {},
    },
  );

  function setBusy(key: string, busy: boolean): void {
    const next = { ...busyKeys.value };
    if (busy) next[key] = true;
    else delete next[key];
    busyKeys.value = next;
  }

  function isBusy(key: string): boolean {
    return !!busyKeys.value[key];
  }

  function collectTransitionEvents(previous: QueueState, next: QueueState): QueueClientEvent[] {
    const previousJobs = new Map(previous.jobs.map((job) => [job.id, job]));
    const created: QueueClientEvent[] = [];

    for (const job of next.jobs) {
      const before = previousJobs.get(job.id);
      if (!before) {
        created.push({
          id: eventId(job.id, 'queue.submitted', job.createdAt),
          jobId: job.id,
          type: 'queue.submitted',
          message: `${job.projectName ?? 'Untitled job'} entered the queue.`,
          createdAt: job.createdAt,
        });
        continue;
      }

      if (before.status !== job.status) {
        created.push({
          id: eventId(job.id, `queue.${job.status}`, job.updatedAt),
          jobId: job.id,
          type: `queue.${job.status}`,
          message: `${job.projectName ?? 'Untitled job'} is ${statusText(job.status)}.`,
          createdAt: job.updatedAt,
        });
      }

      if (before.currentStep !== job.currentStep && job.currentStep) {
        created.push({
          id: eventId(job.id, 'queue.step.current', job.updatedAt, job.currentStep),
          jobId: job.id,
          type: 'queue.step.current',
          message: `Current step is ${job.currentStep}.`,
          createdAt: job.updatedAt,
        });
      }

      const beforeSteps = new Map(before.steps.map((step) => [step.stepKey, step]));
      for (const step of job.steps) {
        const oldStep = beforeSteps.get(step.stepKey);
        if (!oldStep || oldStep.status === step.status) continue;
        created.push({
          id: eventId(job.id, `queue.step.${step.status}`, step.updatedAt, step.stepKey),
          jobId: job.id,
          type: `queue.step.${step.status}`,
          message: `${step.stepKey} is ${statusText(step.status)}${step.error ? `: ${step.error}` : '.'}`,
          createdAt: step.updatedAt,
        });
      }
    }

    return created;
  }

  function rememberEvents(next: QueueState): void {
    const hasPersistedEvents = Array.isArray((next as Partial<QueueState>).events);
    const persisted = hasPersistedEvents ? next.events : [];
    const created = !hasPersistedEvents && state.value ? collectTransitionEvents(state.value, next) : [];
    if (persisted.length === 0 && created.length === 0) return;

    const unique = new Map<string, QueueClientEvent>();
    for (const evt of [...events.value, ...created, ...persisted]) unique.set(evt.id, evt);
    events.value = sortEvents([...unique.values()]);
  }

  function applyState(next: QueueState): void {
    rememberEvents(next);
    state.value = next;
    loaded.value = true;
    loadError.value = null;
  }

  async function load(options: { quiet?: boolean } = {}): Promise<void> {
    loading.value = true;
    try {
      applyState(await api.getQueueState());
      actionError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      if (!options.quiet) actionError.value = loadError.value;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function enqueue(input: QueueEnqueueInput): Promise<void> {
    setBusy('enqueue', true);
    actionError.value = null;
    try {
      await api.enqueueQueue(input);
      await load({ quiet: true });
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy('enqueue', false);
    }
  }

  async function loadHistory(query: QueueHistoryQuery = {}, options: { append?: boolean } = {}): Promise<QueueHistoryResponse> {
    setBusy('history', true);
    historyLoading.value = true;
    historyError.value = null;
    try {
      const res = await api.getQueueHistory(query);
      historyItems.value = options.append ? [...historyItems.value, ...res.items] : res.items;
      historyTotal.value = res.total;
      historyNextCursor.value = res.nextCursor;
      historyHasMore.value = res.hasMore;
      historyLoaded.value = true;
      return res;
    } catch (e) {
      historyError.value = errText(e);
      actionError.value = historyError.value;
      throw e;
    } finally {
      historyLoading.value = false;
      setBusy('history', false);
    }
  }

  async function reorder(ids: string[]): Promise<void> {
    setBusy('reorder', true);
    actionError.value = null;
    try {
      applyState(await api.reorderQueue(ids));
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy('reorder', false);
    }
  }

  async function control(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
    const key = `${action}:${id}`;
    setBusy(key, true);
    actionError.value = null;
    try {
      if (action === 'pause') await api.pauseQueueJob(id);
      else if (action === 'resume') await api.resumeQueueJob(id);
      else if (action === 'cancel') await api.cancelQueueJob(id);
      else await api.retryQueueJob(id);
      await load({ quiet: true });
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy(key, false);
    }
  }

  const pause = (id: string) => control(id, 'pause');
  const resume = (id: string) => control(id, 'resume');
  const cancel = (id: string) => control(id, 'cancel');
  const retry = (id: string) => control(id, 'retry');

  async function bulk(action: QueueBulkAction, ids: string[]): Promise<QueueBulkResult[]> {
    if (ids.length === 0) return [];
    setBusy('bulk', true);
    actionError.value = null;
    try {
      const res = await api.bulkQueue(action, ids);
      applyState(res.state);
      return res.results;
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy('bulk', false);
    }
  }

  async function saveRule(input: Partial<QueueRule> & { id?: string }): Promise<void> {
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : null;
    const key = id ? `rule:update:${id}` : 'rule:create';
    setBusy(key, true);
    actionError.value = null;
    try {
      if (id) await api.updateQueueRule(id, input);
      else await api.createQueueRule(input);
      await load({ quiet: true });
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy(key, false);
    }
  }

  async function deleteRule(id: string): Promise<void> {
    const key = `rule:delete:${id}`;
    setBusy(key, true);
    actionError.value = null;
    try {
      await api.deleteQueueRule(id);
      await load({ quiet: true });
    } catch (e) {
      actionError.value = errText(e);
      throw e;
    } finally {
      setBusy(key, false);
    }
  }

  return {
    state,
    loaded,
    loading,
    loadError,
    actionError,
    busyKeys,
    events,
    historyItems,
    historyTotal,
    historyNextCursor,
    historyHasMore,
    historyLoaded,
    historyLoading,
    historyError,
    queuePipelineV2,
    jobs,
    rules,
    updatedAt,
    activeJob,
    blockedJobs,
    pausedJobs,
    dispatchableJobs,
    terminalJobs,
    historyCounts,
    isBusy,
    applyState,
    load,
    loadHistory,
    enqueue,
    reorder,
    pause,
    resume,
    cancel,
    retry,
    bulk,
    saveRule,
    deleteRule,
  };
});
