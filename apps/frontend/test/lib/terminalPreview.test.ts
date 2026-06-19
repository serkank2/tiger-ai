import { describe, expect, it } from 'vitest';
import { lastOutputLine } from '~/lib/terminalPreview';

describe('lastOutputLine', () => {
  it('returns empty string for empty / nullish input', () => {
    expect(lastOutputLine('')).toBe('');
    expect(lastOutputLine(null)).toBe('');
    expect(lastOutputLine(undefined)).toBe('');
  });

  it('returns the last non-empty trimmed line', () => {
    expect(lastOutputLine('npm install\n\n$ ')).toBe('$');
    expect(lastOutputLine('first\nsecond\nthird')).toBe('third');
  });

  it('skips trailing blank lines and strips carriage returns', () => {
    expect(lastOutputLine('build done\r\n\r\n   \r\n')).toBe('build done');
  });

  it('handles a single line with no newline', () => {
    expect(lastOutputLine('ready')).toBe('ready');
  });
});
