import type { PromptFile, PromptSummary } from '~/types';
import { errText } from '~/lib/apiError';

/**
 * Prompt library store: holds the on-disk prompt summaries and wraps CRUD with
 * toast-on-error (mirrors the terminals store's `guarded` pattern). The composer
 * modal owns the open prompt + editor/dirty state; this store is the data layer.
 */
export const usePromptsStore = defineStore('prompts', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const items = ref<PromptSummary[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  async function fetchAll(): Promise<void> {
    loading.value = true;
    try {
      items.value = (await api.listPrompts()).items;
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function open(path: string): Promise<PromptFile | null> {
    try {
      return await api.readPrompt(path);
    } catch (e) {
      notices.push(`Open failed: ${errText(e)}`, 'error');
      return null;
    }
  }

  async function create(path: string, content: string, overwrite = false): Promise<PromptFile | null> {
    try {
      const f = await api.createPrompt(path, content, overwrite);
      await fetchAll();
      return f;
    } catch (e) {
      notices.push(`Create failed: ${errText(e)}`, 'error');
      return null;
    }
  }

  async function update(path: string, content: string, expectedVersion?: string): Promise<PromptFile | null> {
    try {
      const f = await api.updatePrompt(path, content, expectedVersion);
      await fetchAll();
      return f;
    } catch (e) {
      // 409 → file changed on disk since we loaded it
      notices.push(`Save failed: ${errText(e)}`, 'error');
      return null;
    }
  }

  async function remove(path: string): Promise<boolean> {
    try {
      await api.deletePrompt(path);
      await fetchAll();
      return true;
    } catch (e) {
      notices.push(`Delete failed: ${errText(e)}`, 'error');
      return false;
    }
  }

  async function rename(fromPath: string, toPath: string): Promise<PromptFile | null> {
    try {
      const f = await api.renamePrompt(fromPath, toPath);
      await fetchAll();
      return f;
    } catch (e) {
      notices.push(`Rename failed: ${errText(e)}`, 'error');
      return null;
    }
  }

  return { items, loaded, loading, loadError, fetchAll, open, create, update, remove, rename };
});
