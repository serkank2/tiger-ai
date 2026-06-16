import { THEMES, DEFAULT_THEME_ID, findTheme, applyTheme, xtermTheme } from '~/theme/themes';
import type { KaplanTheme } from '~/theme/themes';

export const useThemeStore = defineStore('theme', () => {
  const id = ref<string>(DEFAULT_THEME_ID);
  const current = computed<KaplanTheme>(() => findTheme(id.value));
  const xterm = computed(() => xtermTheme(current.value));

  function apply(themeId: string) {
    id.value = findTheme(themeId).id;
    applyTheme(current.value);
  }
  /** Apply + persist the chosen theme. */
  function set(themeId: string) {
    apply(themeId);
    useSettingsStore()
      .update({ theme: id.value })
      .catch(() => useNoticesStore().push('Could not save theme preference', 'error'));
  }
  /** Apply on load (from persisted settings) without re-persisting. */
  function init(themeId?: string | null) {
    apply(themeId || id.value);
  }

  return { id, current, xterm, themes: THEMES, apply, set, init };
});
