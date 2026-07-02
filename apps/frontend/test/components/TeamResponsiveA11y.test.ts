import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TeamRoleTile from '~/components/team/TeamRoleTile.vue';
import type { RoleSnapshot } from '~/types';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'app/components/team', relativePath), 'utf8');
}

function templateSource(relativePath: string): string {
  const match = source(relativePath).match(/<template>([\s\S]*?)<\/template>/);
  return (match?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

function contrast(hexA: string, hexB: string): number {
  const luminance = (hex: string): number => {
    const value = hex.replace('#', '');
    const rgb = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
    const linear = rgb.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const [lighter, darker] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function role(overrides: Partial<RoleSnapshot> = {}): RoleSnapshot {
  return {
    id: 'developer',
    name: 'Developer',
    tool: 'codex',
    model: 'gpt-5.5',
    effort: 'xhigh',
    permission: 'yolo',
    status: 'idle',
    canWriteCode: true,
    requiredForSignoff: true,
    signedOff: false,
    ...overrides,
  };
}

describe('Team responsive layout and role tile accessibility', () => {
  it('stacks the Team workspace below the narrow breakpoint', () => {
    const teamView = source('TeamView.vue');

    expect(teamView).toContain('grid-template-columns: minmax(232px, 292px) 1fr;');
    expect(teamView).toContain('@media (max-width: 720px)');
    expect(teamView).toMatch(/\.workspace \{\r?\n\s+grid-template-columns: 1fr;\r?\n\s+\}/);
    expect(teamView).toMatch(
      /\.rail \{[\s\S]*?border-right: 0;[\s\S]*?border-bottom: 1px solid var\(--border\);[\s\S]*?\}/,
    );
  });

  it('uses compact Team surface typography, contrast, and non-decorative active backgrounds', () => {
    const teamView = source('TeamView.vue');
    expect(teamView).toContain('--text-xs: 12px;');
    expect(teamView).toContain('--text-sm: 13px;');
    expect(teamView).toContain('--text-md: 15px;');
    expect(teamView).not.toContain('radial-gradient');

    // The Team surface derives its dim/faint text from the ACTIVE theme via color-mix —
    // never from hardcoded hex (that made light themes unreadable). Verify the derived
    // colors still clear WCAG 4.5:1 on the default dark theme's elevated surface by
    // resolving the mix ratios against the kaplan-dark palette (text/bg from themes.ts).
    const dimMix = /--text-dim:\s*color-mix\(in srgb, var\(--text\) (\d+)%, var\(--bg\)\);/.exec(teamView)?.[1];
    const faintMix = /--text-faint:\s*color-mix\(in srgb, var\(--text\) (\d+)%, var\(--bg\)\);/.exec(teamView)?.[1];
    expect(dimMix).toBeTruthy();
    expect(faintMix).toBeTruthy();
    expect(teamView).not.toMatch(/--text-(?:dim|faint):\s*#[0-9a-fA-F]{3,6};/);

    const mix = (pct: number, fgHex: string, bgHex: string): string => {
      const channel = (hex: string, index: number): number => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
      const blended = [0, 1, 2].map((index) =>
        Math.round((channel(fgHex, index) * pct + channel(bgHex, index) * (100 - pct)) / 100),
      );
      return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    };
    // kaplan-dark: --text #ece6db, --bg #131110, --bg-elev-2 #241f1a (see app/theme/themes.ts).
    const dim = mix(Number(dimMix), '#ece6db', '#131110');
    const faint = mix(Number(faintMix), '#ece6db', '#131110');
    expect(contrast(dim, '#241f1a')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(faint, '#241f1a')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the Team launcher within the compact Team scale', () => {
    const launcher = source('TeamLauncher.vue');

    expect(launcher).toContain('padding: var(--space-4);');
    expect(launcher).toContain('max-width: 1100px;');
    expect(launcher).toContain('grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);');
    expect(launcher).toContain('font-size: var(--text-xl);');
    expect(launcher).toContain('min-height: 176px;');
  });

  it('does not render Team mojibake or glyph-only operational labels', () => {
    const disallowed =
      /\?\?\s+\{\{|>\?\s|\s\?\s+\{\{|\u2039|\u21e9|\u2192|\u2715|\u2713|\u25b8|\u25be|\uff0b|\u2212|\u2387|\u{1f9d1}|\u2699|\u00d7/u;
    const files = [
      'TeamAgentBadge.vue',
      'TeamAttemptsPanel.vue',
      'TeamChangesPanel.vue',
      'TeamChatPanel.vue',
      'TeamCoordinationPanel.vue',
      'TeamDoneGate.vue',
      'TeamMetricsPanel.vue',
      'TeamRoleTile.vue',
      'TeamRunHistory.vue',
      'TeamTerminalPane.vue',
      'TeamVerifications.vue',
      'TeamView.vue',
    ];

    for (const file of files) {
      expect(templateSource(file), file).not.toMatch(disallowed);
    }
  });

  it('keeps compact Team typography centralized in variables', () => {
    const files = [
      'TeamAgentBadge.vue',
      'TeamAttemptsPanel.vue',
      'TeamChangesPanel.vue',
      'TeamChatPanel.vue',
      'TeamCoordinationPanel.vue',
      'TeamDoneGate.vue',
      'TeamLauncher.vue',
      'TeamMetricsPanel.vue',
      'TeamRoleControls.vue',
      'TeamRoleTile.vue',
      'TeamRunHistory.vue',
      'TeamSteerBar.vue',
      'TeamTemplateEditor.vue',
      'TeamTerminalPane.vue',
      'TeamVerifications.vue',
      'TeamView.vue',
    ];

    for (const file of files) {
      expect(source(file), file).not.toMatch(/font-size:\s*(?:10|11|12|13|14|15)px/);
    }
  });

  it('activates clickable role tiles with Enter or Space from the tile root only', async () => {
    const wrapper = mount(TeamRoleTile, {
      props: { role: role({ terminalId: 'term-1' }) },
    });

    const tile = wrapper.find('.role-tile');
    expect(tile.attributes('role')).toBe('button');
    expect(tile.attributes('tabindex')).toBe('0');

    await tile.trigger('keydown', { key: ' ' });
    await tile.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toHaveLength(2);

    await wrapper.find('.agent-badge').trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('select')).toHaveLength(2);
  });

  it('does not add keyboard button semantics to role tiles without terminals', async () => {
    const wrapper = mount(TeamRoleTile, {
      props: { role: role({ terminalId: undefined }) },
    });

    const tile = wrapper.find('.role-tile');
    expect(tile.attributes('role')).toBeUndefined();
    expect(tile.attributes('tabindex')).toBeUndefined();

    await tile.trigger('keydown', { key: ' ' });
    await tile.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toBeUndefined();
  });
});
