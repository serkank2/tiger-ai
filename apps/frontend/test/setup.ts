// Global test harness. Installs a real vue-i18n instance (built from the app's own
// en/tr locale catalogue) into Vue Test Utils' shared mount config, so EVERY
// `mount()`/`shallowMount()` resolves `useT()`/`useI18n()` instead of throwing
// "Need to install with `app.use` function". This mirrors app/plugins/i18n.ts and
// removes the need for per-test i18n wiring (and prevents the crash recurring for
// any future component that calls useT()).
import { config } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, messages } from '~/locales';

const i18n = createI18n({
  legacy: false, // Composition API mode — required for useI18n() in <script setup>
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  // Keep test output clean; missing keys still fall back to en.
  missingWarn: false,
  fallbackWarn: false,
  messages,
});

config.global.plugins = [...(config.global.plugins ?? []), i18n];
