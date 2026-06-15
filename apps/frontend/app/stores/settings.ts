import type { AppSettings } from '~/types';

export const useSettingsStore = defineStore('settings', () => {
  const api = useApi();
  const settings = ref<AppSettings | null>(null);

  async function load() {
    settings.value = await api.getSettings();
  }
  async function update(patch: Partial<AppSettings>) {
    settings.value = await api.updateSettings(patch);
  }

  return { settings, load, update };
});
