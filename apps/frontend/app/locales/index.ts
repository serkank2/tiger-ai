// Locale registry. Add new locales here (see ./en.ts header for the full recipe).
import en from './en';

export const DEFAULT_LOCALE = 'en';

/** Locale codes the UI can switch to. The first entry is the default. */
export const AVAILABLE_LOCALES = ['en'] as const;
export type LocaleCode = (typeof AVAILABLE_LOCALES)[number];

// `en` is the canonical message shape; every other locale is a partial of it and
// falls back to `en` for missing keys (configured in the i18n plugin).
export type MessageSchema = typeof en;

export const messages = {
  en,
} satisfies Record<LocaleCode, MessageSchema>;
