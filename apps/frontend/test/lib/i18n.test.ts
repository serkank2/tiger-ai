import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, messages } from '~/locales';
import { NAV_ITEMS } from '~/lib/navigation';

// Scaffolding sanity: the i18n setup the plugin uses must resolve real keys,
// interpolate params, and cover every nav label so localized rails never show a
// raw key. This mirrors the plugin's createI18n config without a full Nuxt app.
function makeI18n() {
  return createI18n({
    legacy: false,
    locale: DEFAULT_LOCALE,
    fallbackLocale: DEFAULT_LOCALE,
    messages,
  });
}

describe('i18n scaffolding', () => {
  it('exposes the default locale among the available locales', () => {
    expect(AVAILABLE_LOCALES).toContain(DEFAULT_LOCALE);
    expect(messages[DEFAULT_LOCALE]).toBeTruthy();
  });

  it('resolves a representative set of user-facing keys', () => {
    const { t } = makeI18n().global;
    expect(t('nav.terminals')).toBe('Terminals');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('terminals.send')).toBe('Send ⏎');
  });

  it('interpolates named params', () => {
    const { t } = makeI18n().global;
    expect(t('terminals.sendPlaceholder', { n: 3 })).toContain('3');
    expect(t('connection.backendStatus', { status: 'connected' })).toContain('connected');
  });

  it('has a translation for every nav item labelKey', () => {
    const { t } = makeI18n().global;
    for (const item of NAV_ITEMS) {
      const translated = t(item.labelKey);
      // A missing key falls back to echoing the key itself; assert we got real copy.
      expect(translated).not.toBe(item.labelKey);
      expect(translated.length).toBeGreaterThan(0);
    }
  });
});
