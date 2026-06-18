import { ref } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { useSocket } from '~/composables/useSocket';
import { useNoticesStore } from '~/stores/notices';
import type { PromptHistoryEvent, PromptHistoryFilters } from '~/types';
import { errText } from '~/lib/apiError';

export const usePromptHistoryStore = defineStore('promptHistory', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const items = ref<PromptHistoryEvent[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const refreshing = ref(false);
  const loadError = ref<string | null>(null);
  const total = ref<number | null>(null);
  const lastChangedAt = ref<string | null>(null);
  let unbindSocket: (() => void) | null = null;

  function cleanFilters(filters: PromptHistoryFilters = {}): PromptHistoryFilters {
    return Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ) as PromptHistoryFilters;
  }

  async function fetchAll(filters: PromptHistoryFilters = {}, opts: { silent?: boolean } = {}): Promise<void> {
    if (opts.silent) refreshing.value = true;
    else loading.value = true;
    try {
      const res = await api.listPromptHistory(cleanFilters(filters));
      items.value = res.items;
      total.value = res.total ?? res.items.length;
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      if (!opts.silent) notices.push(`Prompt history: ${loadError.value}`, 'error');
      throw e;
    } finally {
      loading.value = false;
      refreshing.value = false;
    }
  }

  function applyChanged(): void {
    lastChangedAt.value = new Date().toISOString();
    if (!loaded.value) return;
    void fetchAll({}, { silent: true }).catch(() => {});
  }

  function bindSocket(): () => void {
    if (!unbindSocket) {
      unbindSocket = useSocket().onServerEvent('history.changed', () => applyChanged());
    }
    return () => {
      unbindSocket?.();
      unbindSocket = null;
    };
  }

  return {
    items,
    loaded,
    loading,
    refreshing,
    loadError,
    total,
    lastChangedAt,
    fetchAll,
    applyChanged,
    bindSocket,
  };
});
