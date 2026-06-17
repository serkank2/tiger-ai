import { describe, expect, it } from 'vitest';
import { serializePrompt } from '~/lib/frontmatter';

// Frontmatter serialization mirrors the backend writer and is the client-side guard
// against value injection (newlines that could forge or terminate the YAML block).
describe('frontmatter.serializePrompt', () => {
  it('returns the body verbatim when there is no meta', () => {
    expect(serializePrompt({}, 'just a body')).toBe('just a body');
  });

  it('emits a full frontmatter block', () => {
    const out = serializePrompt(
      { title: 'Deploy', description: 'ship it', tags: ['ops', 'ci'], target: 'all', run: true },
      'echo hi',
    );
    expect(out).toBe('---\ntitle: Deploy\ndescription: ship it\ntags: [ops, ci]\ntarget: all\nrun: true\n---\necho hi');
  });

  it('only includes the keys that are present', () => {
    expect(serializePrompt({ title: 'Only' }, 'body')).toBe('---\ntitle: Only\n---\nbody');
  });

  it('serializes run: false explicitly (not dropped as falsy)', () => {
    expect(serializePrompt({ run: false }, 'body')).toBe('---\nrun: false\n---\nbody');
  });

  it('collapses newlines in values to prevent frontmatter injection', () => {
    const out = serializePrompt({ title: 'a\nb\r\nc' }, 'body');
    expect(out).toBe('---\ntitle: a b c\n---\nbody');
    // A crafted title must not be able to introduce extra YAML lines or close the block.
    expect(out.split('\n').filter((l) => l === '---')).toHaveLength(2);
  });

  it('strips list/bracket characters from tags and drops empties', () => {
    const out = serializePrompt({ tags: ['a,b', '[c]', '   '] }, 'body');
    expect(out).toBe('---\ntags: [a b, c]\n---\nbody');
  });

  it('omits the tags line entirely when nothing survives sanitization', () => {
    expect(serializePrompt({ tags: ['   ', ''] }, 'body')).toBe('body');
  });
});
