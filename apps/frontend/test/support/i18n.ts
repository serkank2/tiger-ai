import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, messages } from '~/locales';

// Real i18n plugin for component tests. Mirrors app/plugins/i18n.ts so components
// that call `useT()` resolve actual English copy (instead of throwing because no
// i18n instance is installed, or echoing raw keys). Install via
// `mount(C, { global: { plugins: [createTestI18n()] } })`.
export function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    messages,
  });
}
