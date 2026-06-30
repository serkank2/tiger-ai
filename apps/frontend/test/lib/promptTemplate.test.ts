import { describe, expect, it } from 'vitest';
import { detectVariables, hasPerTerminalVars, render } from '~/lib/promptTemplate';

// Prompt-template parsing/validation: which {{placeholders}} a body declares and how
// they resolve. The composer uses these to drive its variable inputs and per-terminal
// send behavior, so the rules are part of the form-validation surface.
describe('promptTemplate', () => {
  describe('detectVariables', () => {
    it('collects user-defined variables', () => {
      expect(detectVariables('Hi {{name}}, ticket {{ticket}}')).toEqual(['name', 'ticket']);
    });

    it('deduplicates repeated variables', () => {
      expect(detectVariables('{{a}} {{a}} {{b}}')).toEqual(['a', 'b']);
    });

    it('excludes built-ins (terminal.name, terminal.cwd, date)', () => {
      expect(detectVariables('{{terminal.name}} in {{terminal.cwd}} on {{date}} for {{user}}')).toEqual(['user']);
    });

    it('ignores escaped placeholders', () => {
      expect(detectVariables('literal \\{{notavar}} but {{real}}')).toEqual(['real']);
    });

    it('returns an empty array when there are no variables', () => {
      expect(detectVariables('plain text, no placeholders')).toEqual([]);
    });
  });

  describe('render', () => {
    const base = { values: {}, terminal: { name: 'web', cwd: '/srv/app' }, date: '2026-06-17' };

    it('substitutes built-ins', () => {
      expect(render('{{terminal.name}}@{{terminal.cwd}} ({{date}})', base)).toBe('web@/srv/app (2026-06-17)');
    });

    it('substitutes user values', () => {
      expect(render('Hello {{who}}', { ...base, values: { who: 'world' } })).toBe('Hello world');
    });

    it('unescapes \\{{x}} to a literal {{x}}', () => {
      expect(render('\\{{keep}}', base)).toBe('{{keep}}');
    });

    it('leaves unresolved user variables untouched', () => {
      expect(render('{{missing}}', base)).toBe('{{missing}}');
    });

    it('leaves the placeholder visible when a value is blank/whitespace', () => {
      expect(render('x={{v}}', { ...base, values: { v: '   ' } })).toBe('x={{v}}');
      expect(render('x={{v}}', { ...base, values: { v: '' } })).toBe('x={{v}}');
    });

    it('emits empty strings for missing terminal context built-ins', () => {
      expect(render('[{{terminal.name}}]', { values: {} })).toBe('[]');
    });
  });

  describe('hasPerTerminalVars', () => {
    it('is true when a per-terminal built-in is used', () => {
      expect(hasPerTerminalVars('cd {{terminal.cwd}}')).toBe(true);
      expect(hasPerTerminalVars('hi {{terminal.name}}')).toBe(true);
    });

    it('is false for non-per-terminal content', () => {
      expect(hasPerTerminalVars('on {{date}} for {{user}}')).toBe(false);
    });

    it('ignores escaped per-terminal placeholders', () => {
      expect(hasPerTerminalVars('\\{{terminal.cwd}}')).toBe(false);
    });
  });
});
