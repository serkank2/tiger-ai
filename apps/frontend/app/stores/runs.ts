import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { useSocket } from '~/composables/useSocket';
import { errText } from '~/lib/apiError';
import type { RunChanges, RunCreateConfigInput, RunEventDto, RunIndexEntry, RunSnapshot, ServerMessage } from '~/types';

/**
 * v2 runs store — the single source of truth the Runs screen reads.
 *
 * Live model (REST = control, WS = data): the full snapshot arrives on every
 * `run.state` frame; individual `run.event` frames append to a bounded local
 * feed. On (re)connect the store reconciles by re-fetching the snapshot and
 * replaying events after its last seen seq, so the feed never gaps or dupes.
 */
export const useRunsStore = defineStore('runs', () => {
  const api = useApi();

  const run = ref<RunSnapshot | null>(null);
  const events = ref<RunEventDto[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const busyKeys = ref<Record<string, boolean>>({});
  const lastSeq = ref(0);
  /** Working-tree changes of the current run (fetched on demand). */
  const changes = ref<RunChanges | null>(null);
  /** Global run-history index (newest first). */
  const history = ref<RunIndexEntry[]>([]);
  /** A past run opened read-only from the history list. */
  const historyRun = ref<RunSnapshot | null>(null);

  const status = computed(() => run.value?.status ?? null);
  const items = computed(() => run.value?.graph.items ?? []);
  const isActive = computed(() => status.value === 'running');
  const canStart = computed(
    () => status.value === 'created' || status.value === 'blocked' || status.value === 'stopped',
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

  function applySnapshot(next: RunSnapshot | null): void {
    run.value = next;
    loaded.value = true;
    loadError.value = null;
  }

  const EVENT_FEED_CAP = 500;

  function appendEvent(event: RunEventDto): void {
    if (event.seq <= lastSeq.value) return; // replay/dupe guard
    lastSeq.value = event.seq;
    const next = events.value.length >= EVENT_FEED_CAP ? events.value.slice(-EVENT_FEED_CAP + 1) : events.value.slice();
    next.push(event);
    events.value = next;
  }

  /** WS fan-in. Registered once by the page; returns the unsubscribe pair. */
  function bindSocket(): () => void {
    const socket = useSocket();
    const offState = socket.onServerEvent('run.state', (msg: ServerMessage) => {
      applySnapshot(msg.state as unknown as RunSnapshot);
    });
    const offEvent = socket.onServerEvent('run.event', (msg: ServerMessage) => {
      if (msg.event) appendEvent(msg.event);
    });
    return () => {
      offState();
      offEvent();
    };
  }

  async function load(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    try {
      const { run: snapshot } = await api.getCurrentRun();
      applySnapshot(snapshot);
      if (snapshot) {
        // Reconcile the feed: replay anything we missed while disconnected.
        const { events: missed } = await api.listRunEvents(lastSeq.value);
        for (const event of missed) appendEvent(event);
      }
    } catch (e) {
      loadError.value = errText(e);
      loaded.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function create(input: { workspace: string; goal: string; config?: RunCreateConfigInput }): Promise<void> {
    setBusy('create', true);
    loadError.value = null;
    try {
      const { run: snapshot } = await api.createRun(input);
      events.value = [];
      lastSeq.value = 0;
      applySnapshot(snapshot);
    } catch (e) {
      loadError.value = errText(e);
      throw e;
    } finally {
      setBusy('create', false);
    }
  }

  async function start(): Promise<void> {
    setBusy('start', true);
    try {
      const { run: snapshot } = await api.startRun();
      applySnapshot(snapshot);
    } catch (e) {
      loadError.value = errText(e);
      throw e;
    } finally {
      setBusy('start', false);
    }
  }

  async function stop(): Promise<void> {
    setBusy('stop', true);
    try {
      const { run: snapshot } = await api.stopRun();
      applySnapshot(snapshot);
    } catch (e) {
      loadError.value = errText(e);
      throw e;
    } finally {
      setBusy('stop', false);
    }
  }

  async function steer(body: string, interrupt = false): Promise<void> {
    setBusy('steer', true);
    try {
      const { run: snapshot } = await api.steerRun(body, interrupt);
      applySnapshot(snapshot);
    } catch (e) {
      loadError.value = errText(e);
      notify(e);
      throw e;
    } finally {
      setBusy('steer', false);
    }
  }

  /** Surface an action failure as a toast (loadError already renders inline). */
  function notify(e: unknown): void {
    try {
      useNoticesStore().push(errText(e), 'error');
    } catch {
      /* no Pinia in some unit tests */
    }
  }

  async function loadChanges(): Promise<void> {
    setBusy('changes', true);
    try {
      const { changes: next } = await api.getRunChanges();
      changes.value = next;
    } catch (e) {
      loadError.value = errText(e);
    } finally {
      setBusy('changes', false);
    }
  }

  async function loadHistory(): Promise<void> {
    setBusy('history', true);
    try {
      const { runs: entries } = await api.listRuns();
      history.value = entries;
    } catch (e) {
      loadError.value = errText(e);
    } finally {
      setBusy('history', false);
    }
  }

  /** Open a past run read-only (null closes the panel). */
  async function openHistoryRun(runId: string | null): Promise<void> {
    if (!runId) {
      historyRun.value = null;
      return;
    }
    setBusy(`history:${runId}`, true);
    try {
      const { run: snapshot } = await api.getRunById(runId);
      historyRun.value = snapshot;
    } catch (e) {
      loadError.value = errText(e);
      notify(e);
    } finally {
      setBusy(`history:${runId}`, false);
    }
  }

  return {
    run,
    events,
    loaded,
    loading,
    loadError,
    busyKeys,
    lastSeq,
    changes,
    history,
    historyRun,
    status,
    items,
    isActive,
    canStart,
    isBusy,
    applySnapshot,
    appendEvent,
    bindSocket,
    load,
    create,
    start,
    stop,
    steer,
    loadChanges,
    loadHistory,
    openHistoryRun,
  };
});
