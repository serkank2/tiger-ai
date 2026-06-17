import { describe, expect, it } from 'vitest';
import { SHELL_LIMITS, limitFor, strictestLimit } from '~/lib/shellLimits';

// Command-/prompt-length validator rules. These back the inline over-length checks
// the migrated forms surface (the only validation rule extracted into a shared,
// unit-testable module today; see execution log for the deferred rule set).
describe('shellLimits — command-length validator', () => {
  it('exposes conservative per-shell limits', () => {
    expect(SHELL_LIMITS.cmd).toBe(8190);
    expect(SHELL_LIMITS['system-default']).toBe(8190);
    expect(SHELL_LIMITS.powershell).toBe(16380);
    expect(SHELL_LIMITS.pwsh).toBe(16380);
  });

  describe('limitFor', () => {
    it('returns the limit for a known shell kind', () => {
      expect(limitFor('cmd')).toBe(8190);
      expect(limitFor('powershell')).toBe(16380);
    });

    it('defaults to system-default when kind is omitted', () => {
      expect(limitFor()).toBe(8190);
      expect(limitFor(undefined)).toBe(8190);
    });

    it('treats unbounded/unknown shells (bash, zsh, custom) as Infinity', () => {
      expect(limitFor('bash')).toBe(Infinity);
      expect(limitFor('zsh')).toBe(Infinity);
      expect(limitFor('custom')).toBe(Infinity);
      expect(limitFor('totally-unknown')).toBe(Infinity);
    });
  });

  describe('strictestLimit', () => {
    it('picks the smallest limit across a set of shells', () => {
      expect(strictestLimit(['powershell', 'cmd'])).toBe(8190);
      expect(strictestLimit(['powershell', 'pwsh'])).toBe(16380);
    });

    it('returns Infinity for an empty set (no constraint)', () => {
      expect(strictestLimit([])).toBe(Infinity);
    });

    it('a single unbounded shell does not constrain a bounded one', () => {
      // bash is Infinity, so cmd (8190) remains the binding constraint.
      expect(strictestLimit(['bash', 'cmd'])).toBe(8190);
    });

    it('an undefined kind is treated as system-default in the mix', () => {
      // limitFor(undefined) -> 8190, which then binds against an unbounded shell.
      expect(strictestLimit([undefined, 'bash'])).toBe(8190);
    });

    it('a set of only unbounded shells stays Infinity', () => {
      expect(strictestLimit(['bash', 'zsh', 'fish'])).toBe(Infinity);
    });
  });

  describe('over-length decision (how forms consume the rule)', () => {
    it('flags a command longer than the strictest limit and accepts one at the boundary', () => {
      const limit = strictestLimit(['cmd']);
      const ok = 'a'.repeat(limit);
      const tooLong = 'a'.repeat(limit + 1);
      expect(ok.length > limit).toBe(false);
      expect(tooLong.length > limit).toBe(true);
    });
  });
});
