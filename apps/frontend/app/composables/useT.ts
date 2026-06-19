// App-wide translation accessor. A thin, typed re-export of vue-i18n's `useI18n`
// so components depend on `~/composables/useT` rather than the library directly:
// this keeps the call site stable if the i18n backend ever changes, and gives us
// one place to set defaults.
//
// Usage in <script setup>:
//   const { t } = useT();
//   t('nav.terminals')               // -> "Terminals"
//   t('terminals.sendPlaceholder', { n: 3 })
import { useI18n } from 'vue-i18n';

export function useT() {
  // useScope: 'global' — we maintain one shared catalogue, not per-component messages.
  return useI18n({ useScope: 'global' });
}
