// vue-i18n plugin. Installs a single app-wide i18n instance in Composition mode so
// every component can call `useT()` (our thin wrapper, see composables/useT.ts) and
// templates resolve `t('nav.terminals')` etc.
//
// Missing keys fall back to `en` and emit no warning in production builds, so a
// partially-translated locale degrades gracefully rather than rendering blanks.
import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, messages } from '~/locales';

export default defineNuxtPlugin((nuxtApp) => {
  const i18n = createI18n({
    legacy: false, // Composition API mode — required for `useI18n()` in <script setup>
    globalInjection: true, // exposes `$t` in templates without per-component setup
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    missingWarn: import.meta.dev,
    fallbackWarn: import.meta.dev,
    messages,
  });

  nuxtApp.vueApp.use(i18n);
});
