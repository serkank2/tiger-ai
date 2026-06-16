import type {
  CommandTarget,
  CommandTargetMode,
  TerminalDto,
  TerminalInput,
  TerminalRunState,
  TerminalStatus,
} from '~/types';

interface StatusInfo {
  pid?: number;
  exitCode?: number | null;
  signal?: number | null;
  error?: { message: string; code?: string };
}

export const useTerminalsStore = defineStore('terminals', () => {
  const api = useApi();
  const notices = useNoticesStore();

  function errText(e: unknown): string {
    const err = e as { data?: { error?: { message?: string } }; message?: string };
    return err?.data?.error?.message ?? err?.message ?? 'Request failed';
  }
  // Wrap a lifecycle call: surface failures as a toast, and resync on a 404 (stale id).
  async function guarded(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;
      notices.push(`${label} failed: ${errText(e)}`, 'error');
      if (status === 404) await fetchAll().catch(() => {});
    }
  }

  const items = ref<TerminalDto[]>([]);
  const activeId = ref<string | null>(null);
  const selectedIds = ref<string[]>([]);
  const commandMode = ref<CommandTargetMode>('all');
  const commandGroupId = ref<string | null>(null);
  const loaded = ref(false);
  const loadError = ref<string | null>(null);

  const byId = computed<Record<string, TerminalDto>>(() => Object.fromEntries(items.value.map((t) => [t.id, t])));
  const active = computed(() => (activeId.value ? byId.value[activeId.value] ?? null : null));

  async function fetchAll() {
    try {
      const list = await api.listTerminals();
      items.value = list;
      // reconcile selection/active against the fresh list
      const ids = new Set(list.map((t) => t.id));
      selectedIds.value = selectedIds.value.filter((id) => ids.has(id));
      if (activeId.value && !ids.has(activeId.value)) activeId.value = null;
      if (!activeId.value && list.length) activeId.value = list[0]!.id;
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      const err = e as { data?: { error?: { message?: string } }; message?: string };
      loadError.value = err?.data?.error?.message ?? err?.message ?? 'Cannot reach backend';
      throw e;
    }
  }

  /** Refresh only the lastOutput previews (status stays live via WebSocket). */
  async function refreshPreviews() {
    const list = await api.listTerminals();
    const map = byId.value;
    for (const dto of list) {
      const t = map[dto.id];
      if (t) t.lastOutput = dto.lastOutput;
    }
  }

  async function create(body: TerminalInput) {
    const dto = await api.createTerminal(body);
    items.value.push(dto);
    return dto;
  }
  async function update(id: string, body: Partial<TerminalInput>) {
    replace(await api.updateTerminal(id, body));
  }
  async function remove(id: string) {
    await guarded('Delete', async () => {
      await api.deleteTerminal(id);
      items.value = items.value.filter((t) => t.id !== id);
      selectedIds.value = selectedIds.value.filter((x) => x !== id);
      if (activeId.value === id) activeId.value = items.value[0]?.id ?? null;
    });
  }

  async function start(id: string, size?: { cols?: number; rows?: number }) {
    await guarded('Start', async () => applyStatusObj(id, await api.startTerminal(id, size)));
  }
  async function stop(id: string) {
    await guarded('Stop', async () => applyStatusObj(id, await api.stopTerminal(id)));
  }
  async function restart(id: string, size?: { cols?: number; rows?: number }) {
    await guarded('Restart', async () => applyStatusObj(id, await api.restartTerminal(id, size)));
  }

  function replace(dto: TerminalDto) {
    const i = items.value.findIndex((t) => t.id === dto.id);
    if (i >= 0) items.value[i] = dto;
    else items.value.push(dto);
  }
  // WS-driven updates:
  function applyStatus(id: string, state: TerminalRunState, info: StatusInfo = {}) {
    const t = byId.value[id];
    if (!t) return;
    t.status.state = state;
    if (state === 'running' || state === 'starting') {
      if (info.pid !== undefined) t.status.pid = info.pid;
      // a fresh run clears the previous exit/error info
      t.status.exitCode = null;
      t.status.signal = null;
      t.status.error = undefined;
    } else {
      t.status.pid = undefined; // clear stale pid once not running
      if (info.exitCode !== undefined) t.status.exitCode = info.exitCode;
      if (info.signal !== undefined) t.status.signal = info.signal;
      if (info.error !== undefined) t.status.error = info.error;
    }
  }
  function applyExit(id: string, exitCode: number | null, signal: number | null) {
    const t = byId.value[id];
    if (t) {
      t.status.exitCode = exitCode;
      t.status.signal = signal;
    }
  }
  function applyStatusObj(id: string, st: TerminalStatus) {
    const t = byId.value[id];
    if (t) t.status = st;
  }

  function setActive(id: string) {
    activeId.value = id;
  }
  function toggleSelected(id: string) {
    const i = selectedIds.value.indexOf(id);
    if (i >= 0) selectedIds.value.splice(i, 1);
    else selectedIds.value.push(id);
  }
  function clearSelection() {
    selectedIds.value = [];
  }

  /** Build the WS command target from the current UI selection. */
  function buildTarget(): CommandTarget {
    if (commandMode.value === 'selected') return { mode: 'selected', termIds: [...selectedIds.value] };
    if (commandMode.value === 'group') return { mode: 'group', groupId: commandGroupId.value ?? '' };
    return { mode: 'all' };
  }

  return {
    items,
    activeId,
    selectedIds,
    commandMode,
    commandGroupId,
    loaded,
    loadError,
    byId,
    active,
    fetchAll,
    refreshPreviews,
    create,
    update,
    remove,
    start,
    stop,
    restart,
    replace,
    applyStatus,
    applyExit,
    setActive,
    toggleSelected,
    clearSelection,
    buildTarget,
  };
});
