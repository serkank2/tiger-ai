// Locale selection + persistence. The i18n plugin reads the persisted value on
// init (see app/plugins/i18n.ts); this composable is the runtime knob that lets
// any component read the current locale, list the available ones, and switch —
// writing the choice back to localStorage so it survives reloads.
import { useI18n } from 'vue-i18n';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, LOCALE_LABELS, type LocaleCode } from '~/locales';

/** localStorage key for the persisted UI locale. */
export const LOCALE_STORAGE_KEY = 'kaplan.locale';

/** Narrow an arbitrary string to a known LocaleCode (or undefined). */
function asLocaleCode(value: string | null | undefined): LocaleCode | undefined {
  return (AVAILABLE_LOCALES as readonly string[]).includes(value ?? '') ? (value as LocaleCode) : undefined;
}

/**
 * Read the persisted locale, falling back to DEFAULT_LOCALE when unset, invalid,
 * or when localStorage is unavailable (SSR / privacy mode). Safe to call before
 * the i18n instance exists, so the plugin can seed `locale` from it.
 */
export function getStoredLocale(): LocaleCode {
  if (typeof localStorage === 'undefined') return DEFAULT_LOCALE;
  try {
    return asLocaleCode(localStorage.getItem(LOCALE_STORAGE_KEY)) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Persist (best-effort) the chosen locale. */
function persistLocale(code: LocaleCode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, code);
  } catch {
    /* ignore quota / privacy-mode failures — locale just won't persist */
  }
}

export function useLocale() {
  const i18n = useI18n({ useScope: 'global' });

  /** Locale codes paired with their self-described labels, for pickers. */
  const locales = AVAILABLE_LOCALES.map((code) => ({ code, label: LOCALE_LABELS[code] }));

  /** The active locale code (reactive). */
  const locale = computed<LocaleCode>(() => asLocaleCode(i18n.locale.value) ?? DEFAULT_LOCALE);

  /** Switch the live UI locale and persist the choice. */
  function setLocale(code: LocaleCode): void {
    if (!asLocaleCode(code)) return;
    i18n.locale.value = code;
    persistLocale(code);
  }

  return { locale, locales, setLocale };
}
