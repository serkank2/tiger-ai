import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TeamRoleTile from '~/components/team/TeamRoleTile.vue';
import type { RoleSnapshot } from '~/types';

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), 'app/components/team', relativePath), 'utf8');
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

    expect(teamView).toContain('grid-template-columns: minmax(260px, 320px) 1fr;');
    expect(teamView).toContain('@media (max-width: 720px)');
    expect(teamView).toMatch(/\.workspace \{\r?\n\s+grid-template-columns: 1fr;\r?\n\s+\}/);
    expect(teamView).toMatch(/\.rail \{[\s\S]*?border-right: 0;[\s\S]*?border-bottom: 1px solid var\(--border\);[\s\S]*?\}/);
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
