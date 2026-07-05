import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { useSocket } from '~/composables/useSocket';
import { errText } from '~/lib/apiError';
import type {
  RunAgentEventDto,
  RunChanges,
  RunCreateConfigInput,
  RunEventDto,
  RunIndexEntry,
  RunSnapshot,
  ServerMessage,
} from '~/types';

/** One rendered line of a per-agent terminal (a trimmed agent event). */
export interface RunTerminalLine {
  seq: number;
  at: string;
  type: RunAgentEventDto['type'];
  text?: string;
  tool?: { name: string; detail?: string };
}

/** One per-agent terminal pane, accumulated from `run.event` agent frames. */
export interface RunTerminal {
  id: string;
  provider?: string;
  model?: string;
  itemId?: string;
  live: boolean;
  lines: RunTerminalLine[];
  lastAt: string;
}

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
  /** Per-agent terminal panes (keyed by agentId, insertion-ordered). */
  const terminals = ref<Record<string, RunTerminal>>({});

  const status = computed(() => run.value?.status ?? null);
  const items = computed(() => run.value?.graph.items ?? []);
  const terminalList = computed(() => Object.values(terminals.value));
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
    // A settled run has no in-flight turns — every terminal goes idle.
    if (next?.status !== 'running' && Object.values(terminals.value).some((pane) => pane.live)) {
      const settled: Record<string, RunTerminal> = {};
      for (const [id, pane] of Object.entries(terminals.value)) settled[id] = { ...pane, live: false };
      terminals.value = settled;
    }
  }

  const EVENT_FEED_CAP = 500;
  const TERMINAL_LINE_CAP = 400;

  function appendEvent(event: RunEventDto): void {
    if (event.seq <= lastSeq.value) return; // replay/dupe guard
    lastSeq.value = event.seq;
    const next = events.value.length >= EVENT_FEED_CAP ? events.value.slice(-EVENT_FEED_CAP + 1) : events.value.slice();
    next.push(event);
    events.value = next;
    if (event.type === 'agent' && event.agentId && event.agent) appendTerminalLine(event, event.agent);
  }

  /** Route an agent event into its terminal pane (bounded per-agent scrollback). */
  function appendTerminalLine(event: RunEventDto, agent: RunAgentEventDto): void {
    const id = event.agentId!;
    const existing = terminals.value[id];
    const pane: RunTerminal = existing
      ? { ...existing }
      : {
          id,
          provider: event.provider,
          model: event.model,
          itemId: event.itemId,
          live: true,
          lines: [],
          lastAt: event.at,
        };
    pane.provider = event.provider ?? pane.provider;
    pane.model = event.model ?? pane.model;
    pane.itemId = event.itemId ?? pane.itemId;
    pane.lastAt = event.at;
    // `result` is the provider's authoritative end-of-turn signal.
    pane.live = agent.type !== 'result';
    if (agent.type !== 'usage') {
      const lines =
        pane.lines.length >= TERMINAL_LINE_CAP ? pane.lines.slice(-TERMINAL_LINE_CAP + 1) : pane.lines.slice();
      lines.push({ seq: event.seq, at: agent.at, type: agent.type, text: agent.text, tool: agent.tool });
      pane.lines = lines;
    }
    terminals.value = { ...terminals.value, [id]: pane };
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
      terminals.value = {};
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

  /** Interactive mode: route a user keystroke into a live agent's PTY. */
  async function interactiveInput(agentId: string, data: string): Promise<void> {
    try {
      await api.interactiveInput(agentId, data);
    } catch (e) {
      notify(e);
    }
  }

  /** Interactive mode: mark a live agent's turn complete. */
  async function interactiveComplete(agentId: string): Promise<void> {
    setBusy(`complete:${agentId}`, true);
    try {
      await api.interactiveComplete(agentId);
    } catch (e) {
      notify(e);
    } finally {
      setBusy(`complete:${agentId}`, false);
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
    terminals,
    terminalList,
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
    interactiveInput,
    interactiveComplete,
  };
});
