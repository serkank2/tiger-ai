import type { AppSettings } from '~/types';
import { errText } from '~/lib/apiError';

export const useSettingsStore = defineStore('settings', () => {
  const api = useApi();
  const notices = useNoticesStore();
  const settings = ref<AppSettings | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  async function load() {
    loading.value = true;
    try {
      settings.value = await api.getSettings();
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Load settings failed: ${loadError.value}`, 'error');
      throw e;
    } finally {
      loading.value = false;
    }
  }
  async function update(patch: Partial<AppSettings>) {
    try {
      settings.value = await api.updateSettings(patch);
    } catch (e) {
      notices.push(`Save settings failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  return { settings, loaded, loading, loadError, load, update };
});
