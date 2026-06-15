import type {
  CommandTarget,
  CommandTargetMode,
  TerminalDto,
  TerminalInput,
  TerminalRunState,
  TerminalStatus,
} from '~/types';

export const useTerminalsStore = defineStore('terminals', () => {
  const api = useApi();

  const items = ref<TerminalDto[]>([]);
  const activeId = ref<string | null>(null);
  const selectedIds = ref<string[]>([]);
  const commandMode = ref<CommandTargetMode>('all');
  const commandGroupId = ref<string | null>(null);

  const byId = computed<Record<string, TerminalDto>>(() => Object.fromEntries(items.value.map((t) => [t.id, t])));
  const active = computed(() => (activeId.value ? byId.value[activeId.value] ?? null : null));

  async function fetchAll() {
    items.value = await api.listTerminals();
    if (!activeId.value && items.value.length) activeId.value = items.value[0]!.id;
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
    await api.deleteTerminal(id);
    items.value = items.value.filter((t) => t.id !== id);
    selectedIds.value = selectedIds.value.filter((x) => x !== id);
    if (activeId.value === id) activeId.value = items.value[0]?.id ?? null;
  }

  async function start(id: string, size?: { cols?: number; rows?: number }) {
    applyStatusObj(id, await api.startTerminal(id, size));
  }
  async function stop(id: string) {
    applyStatusObj(id, await api.stopTerminal(id));
  }
  async function restart(id: string, size?: { cols?: number; rows?: number }) {
    applyStatusObj(id, await api.restartTerminal(id, size));
  }

  function replace(dto: TerminalDto) {
    const i = items.value.findIndex((t) => t.id === dto.id);
    if (i >= 0) items.value[i] = dto;
    else items.value.push(dto);
  }
  // WS-driven updates:
  function applyStatus(id: string, state: TerminalRunState, pid?: number) {
    const t = byId.value[id];
    if (t) {
      t.status.state = state;
      if (pid !== undefined) t.status.pid = pid;
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
