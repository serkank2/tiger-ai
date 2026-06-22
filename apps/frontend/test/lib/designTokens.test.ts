import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainCss = readFileSync(resolve(process.cwd(), 'app/assets/css/main.css'), 'utf8');

describe('shared design tokens', () => {
  it('exposes soft status and agent identity tokens', () => {
    expect(mainCss).toContain('--amber-soft: color-mix(in srgb, var(--amber) 16%, transparent);');
    expect(mainCss).toContain('--agent-claude-color: #d97757;');
    expect(mainCss).toContain('--agent-claude-bg: rgba(217, 119, 87, 0.16);');
    expect(mainCss).toContain('--agent-codex-color: var(--blue);');
    expect(mainCss).toContain('--agent-codex-bg: color-mix(in srgb, var(--blue) 16%, transparent);');
    expect(mainCss).toContain('--agent-antigravity-color: #4285f4;');
    expect(mainCss).toContain('--agent-antigravity-bg: rgba(66, 133, 244, 0.16);');
  });
});
