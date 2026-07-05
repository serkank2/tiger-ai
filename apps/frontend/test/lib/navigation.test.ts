import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, activeNavKey } from '~/lib/navigation';

// The nav config is the single source of truth for the shell's information
// architecture: every major area must have exactly one reachable home.
describe('navigation', () => {
  it('exposes a home for every major area', () => {
    const keys = NAV_ITEMS.map((i) => i.key);
    for (const required of ['terminals', 'runs', 'queue', 'prompts', 'limits', 'settings']) {
      expect(keys).toContain(required);
    }
  });

  it('has unique keys and route paths', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.to)).size).toBe(NAV_ITEMS.length);
  });

  it('gives every entry a label, icon and absolute route', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
      expect(item.to.startsWith('/')).toBe(true);
    }
  });

  it('resolves the active entry by exact path and nested prefix', () => {
    expect(activeNavKey('/terminals')).toBe('terminals');
    expect(activeNavKey('/runs')).toBe('runs');
    expect(activeNavKey('/limits/usage')).toBe('limits');
    expect(activeNavKey('/settings')).toBe('settings');
  });

  it('returns null for paths outside the nav (e.g. the index redirect)', () => {
    expect(activeNavKey('/')).toBeNull();
    expect(activeNavKey('/nope')).toBeNull();
  });
});
