import type {
  CommandTarget,
  CommandTargetMode,
  TerminalDto,
  TerminalInput,
  TerminalRunState,
  TerminalStatus,
} from '~/types';
import { errText } from '~/lib/apiError';

interface StatusInfo {
  pid?: number;
  exitCode?: number | null;
  signal?: number | null;
  error?: { message: string; code?: string };
}

export const useTerminalsStore = defineStore('terminals', () => {
  const api = useApi();
  const notices = useNoticesStore();

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
  const commandMode = ref<CommandTargetMode>('selected'); // safe default (not 'all' — avoids accidental fan-out)
  const commandGroupId = ref<string | null>(null);
  const layoutMode = ref<'focus' | 'grid'>('focus');
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  const byId = computed<Record<string, TerminalDto>>(() => Object.fromEntries(items.value.map((t) => [t.id, t])));
  const active = computed(() => (activeId.value ? (byId.value[activeId.value] ?? null) : null));
  const someSelected = computed(() => selectedIds.value.length > 0);
  // "all" means all SELECTABLE (unprotected) terminals — protected ones are excluded from bulk.
  const allSelected = computed(() => {
    const sel = items.value.filter((t) => !t.protected);
    return sel.length > 0 && sel.every((t) => selectedIds.value.includes(t.id));
  });
  const isProtected = (id: string) => byId.value[id]?.protected === true;
  const unprotectedIds = (ids: string[]) => ids.filter((id) => !isProtected(id));
  function notifyProtectedSkipped(total: number, usable: number) {
    const n = total - usable;
    if (n > 0) notices.push(`Skipped ${n} protected terminal(s)`, 'info');
  }

  async function fetchAll() {
    loading.value = true;
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
    } finally {
      loading.value = false;
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

  // bulk actions over the current multi-selection
  async function startMany(ids: string[]) {
    const usable = unprotectedIds(ids);
    for (const id of usable) await start(id);
    notifyProtectedSkipped(ids.length, usable.length);
  }
  async function stopMany(ids: string[]) {
    const usable = unprotectedIds(ids);
    for (const id of usable) await stop(id);
    notifyProtectedSkipped(ids.length, usable.length);
  }
  async function startSelected() {
    await startMany(selectedIds.value);
  }
  async function stopSelected() {
    await stopMany(selectedIds.value);
  }
  async function removeSelected() {
    const usable = unprotectedIds([...selectedIds.value]);
    for (const id of usable) await remove(id);
    notifyProtectedSkipped(selectedIds.value.length, usable.length);
  }

  /** Clone an existing terminal's config as a new "<name> copy". */
  async function duplicate(id: string) {
    const t = byId.value[id];
    if (!t) return;
    await create({
      name: `${t.name} copy`,
      groupId: t.groupId,
      cwd: t.cwd,
      initialCommand: t.initialCommand,
      shell: t.shell,
      env: t.env,
      autostart: t.autostart,
    });
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
  function selectAll() {
    selectedIds.value = items.value.filter((t) => !t.protected).map((t) => t.id);
  }
  /** Select every terminal, or clear if all are already selected. */
  function toggleSelectAll() {
    if (allSelected.value) clearSelection();
    else selectAll();
  }
  /** Select all ids in the list (a group), or deselect them if they're already all selected. */
  function toggleGroup(ids: string[]) {
    const usable = unprotectedIds(ids); // protected terminals aren't bulk-selectable
    const allSel = usable.length > 0 && usable.every((id) => selectedIds.value.includes(id));
    if (allSel) {
      const set = new Set(usable);
      selectedIds.value = selectedIds.value.filter((id) => !set.has(id));
    } else {
      selectedIds.value = [...new Set([...selectedIds.value, ...usable])];
    }
  }

  /** Build the WS command target from the current UI selection. */
  function buildTarget(): CommandTarget {
    if (commandMode.value === 'selected') return { mode: 'selected', termIds: [...selectedIds.value] };
    if (commandMode.value === 'group') {
      // a real group, or empty (never 'all') when no group is chosen — send is disabled anyway
      return commandGroupId.value
        ? { mode: 'group', groupId: commandGroupId.value }
        : { mode: 'selected', termIds: [] };
    }
    return { mode: 'all' };
  }

  return {
    items,
    activeId,
    selectedIds,
    commandMode,
    commandGroupId,
    layoutMode,
    loaded,
    loading,
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
    startSelected,
    stopSelected,
    startMany,
    stopMany,
    removeSelected,
    duplicate,
    replace,
    applyStatus,
    applyExit,
    setActive,
    toggleSelected,
    clearSelection,
    selectAll,
    toggleSelectAll,
    toggleGroup,
    someSelected,
    allSelected,
    isProtected,
    unprotectedIds,
    buildTarget,
  };
});
