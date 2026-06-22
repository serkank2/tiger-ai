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

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value)
      .flatMap(([key, nested]) => leafKeys(nested, prefix ? `${prefix}.${key}` : key))
      .sort();
  }
  return prefix ? [prefix] : [];
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

  it('keeps locale catalogs key-for-key in sync', () => {
    const expectedKeys = leafKeys(messages.en);
    for (const locale of AVAILABLE_LOCALES) {
      expect(leafKeys(messages[locale])).toEqual(expectedKeys);
    }
  });

  it('exposes shared foundation keys for upcoming feature wiring', () => {
    const { t } = makeI18n().global;
    const requiredKeys = [
      'prompts.editor.placeholders.title',
      'prompts.editor.placeholders.description',
      'prompts.editor.placeholders.body',
      'cue.status.running',
      'cue.status.stopped',
      'limits.chip.error',
      'limits.chip.empty',
      'limits.chip.stale',
      'queue.rules.createRule',
      'queue.rules.updateRule',
      'queue.target.label',
      'queue.pipeline.history',
      'queue.pipeline.livePipeline',
      'queue.enqueue.placeholders.prompt',
      'team.changes.commit',
      'team.changes.createPr',
      'team.export.jsonTooltip',
      'team.export.markdownTooltip',
      'tiger.runAll.builtInTemplate',
      'tiger.runAll.customTemplate',
      'prompts.view.saved',
      'prompts.view.unsaved',
      'prompts.view.ready',
      'prompts.generation.status.queued',
      'prompts.generation.status.running',
      'team.steer.placeholder',
    ];

    for (const key of requiredKeys) {
      expect(t(key)).not.toBe(key);
    }
  });
});
