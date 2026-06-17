import { describe, expect, it } from 'vitest';
import { errText } from '~/lib/apiError';

// errText is how every store turns a failed $fetch into the inline/notice message the
// UI shows, so its precedence (structured API error > generic message > fallback) is
// part of the error-feedback contract the forms rely on.
describe('apiError.errText', () => {
  it('prefers the structured API error message', () => {
    const e = { data: { error: { message: 'cwd does not exist' } }, message: 'Request failed' };
    expect(errText(e)).toBe('cwd does not exist');
  });

  it('falls back to a plain Error message', () => {
    expect(errText(new Error('network down'))).toBe('network down');
  });

  it('uses the default when nothing is available', () => {
    expect(errText({})).toBe('Request failed');
    expect(errText(null)).toBe('Request failed');
    expect(errText(undefined)).toBe('Request failed');
  });
});
