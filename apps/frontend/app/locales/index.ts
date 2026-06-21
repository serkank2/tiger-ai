// Locale registry. Add new locales here (see ./en.ts header for the full recipe).
import en from './en';

export const DEFAULT_LOCALE = 'en';

/** Locale codes the UI can switch to. The first entry is the default. */
export const AVAILABLE_LOCALES = ['en', 'tr'] as const;
export type LocaleCode = (typeof AVAILABLE_LOCALES)[number];

// `en` is the canonical message shape; every other locale is a partial of it and
// falls back to `en` for missing keys (configured in the i18n plugin).
export type MessageSchema = typeof en;

/** Human-readable, self-described names for each locale (for pickers/menus). */
export const LOCALE_LABELS: Record<LocaleCode, string> = {
  en: 'English',
  tr: 'Türkçe',
};

// Imported after MessageSchema is declared so locale files can `import type
// { MessageSchema }` from here without a circular value dependency.
import tr from './tr';

export const messages = {
  en,
  tr,
} satisfies Record<LocaleCode, MessageSchema>;
