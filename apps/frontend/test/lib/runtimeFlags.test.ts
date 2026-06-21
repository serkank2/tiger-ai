import { describe, expect, it } from 'vitest';
import { isLimitTopPanelEnabled } from '~/lib/runtimeFlags';

describe('runtime flags', () => {
  describe('isLimitTopPanelEnabled', () => {
    it('defaults the limits top panel on when the env value is unset or empty', () => {
      expect(isLimitTopPanelEnabled(undefined)).toBe(true);
      expect(isLimitTopPanelEnabled(null)).toBe(true);
      expect(isLimitTopPanelEnabled('')).toBe(true);
    });

    it.each(['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO'])(
      'turns the limits top panel off for explicit opt-out value %s',
      (value) => {
        expect(isLimitTopPanelEnabled(value)).toBe(false);
      },
    );

    it.each(['1', 'true', 'on', 'yes', 'anything-else'])(
      'keeps the limits top panel on for non-off value %s',
      (value) => {
        expect(isLimitTopPanelEnabled(value)).toBe(true);
      },
    );
  });
});
