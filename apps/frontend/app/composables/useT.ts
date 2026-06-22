import { useI18n } from 'vue-i18n';
import { DEFAULT_LOCALE, messages } from '~/locales';

function lookupMessage(key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (!node || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, messages[DEFAULT_LOCALE]);
}

function renderFallback(key: string, params?: Record<string, unknown>): string {
  const raw = lookupMessage(key);
  const template = typeof raw === 'string' ? raw : key;
  return template
    .replace(/\{'\{\{'\}/g, '{{')
    .replace(/\{'\}\}'\}/g, '}}')
    .replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match));
}

// App-wide translation accessor. A thin, typed re-export of vue-i18n's `useI18n`
// so components depend on `~/composables/useT` rather than the library directly:
// this keeps the call site stable if the i18n backend ever changes, and gives us
// one place to set defaults.
//
// Usage in <script setup>:
//   const { t } = useT();
//   t('nav.terminals')               // -> "Terminals"
//   t('terminals.sendPlaceholder', { n: 3 })
export function useT() {
  try {
    // useScope: 'global' - we maintain one shared catalogue, not per-component messages.
    return useI18n({ useScope: 'global' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('Need to install with `app.use` function')) throw error;
    return { t: renderFallback };
  }
}
