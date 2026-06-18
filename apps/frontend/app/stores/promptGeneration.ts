import type {
  PromptGenerationReuseAction,
  PromptGenerationStartInput,
  PromptGenerationRecord,
  PromptGenerationState,
} from '~/types';
import { errText } from '~/lib/apiError';

export const usePromptGenerationStore = defineStore('promptGeneration', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const current = ref<PromptGenerationState | null>(null);
  const records = ref<PromptGenerationRecord[]>([]);
  const starting = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  let unbindSocket: (() => void) | null = null;

  function upsert(record: PromptGenerationRecord): void {
    const i = records.value.findIndex((item) => item.id === record.id);
    if (i >= 0) records.value[i] = record;
    else records.value.unshift(record);
  }

  function applyState(state: PromptGenerationState): void {
    current.value = state;
    upsert(state.generation);
    loadError.value = null;
  }

  async function start(input: PromptGenerationStartInput): Promise<PromptGenerationState | null> {
    starting.value = true;
    try {
      const state = await api.startPromptGeneration(input);
      applyState(state);
      notices.push('Prompt generation queued', 'info');
      return state;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Generation failed to start: ${loadError.value}`, 'error');
      return null;
    } finally {
      starting.value = false;
    }
  }

  async function fetchOne(id: string): Promise<PromptGenerationState | null> {
    loading.value = true;
    try {
      const state = await api.getPromptGeneration(id);
      applyState(state);
      return state;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Generation load failed: ${loadError.value}`, 'error');
      return null;
    } finally {
      loading.value = false;
    }
  }

  async function reuse(id: string, action: PromptGenerationReuseAction, body: Record<string, unknown> = {}) {
    try {
      const res = await api.reusePromptGeneration(id, action, body);
      const state = (res as { generation?: PromptGenerationRecord }).generation;
      if (state) upsert(state);
      return res;
    } catch (e) {
      notices.push(`Reuse failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  function bindSocket(): () => void {
    if (!unbindSocket) {
      unbindSocket = useSocket().onServerEvent('generation.state', (msg) => {
        const state = (msg as unknown as { state?: PromptGenerationState }).state;
        if (state?.generation?.id) applyState(state);
      });
    }
    return () => {
      unbindSocket?.();
      unbindSocket = null;
    };
  }

  return {
    current,
    records,
    starting,
    loading,
    loadError,
    applyState,
    start,
    fetchOne,
    reuse,
    bindSocket,
  };
});
