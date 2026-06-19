import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TeamMetricsPanel from '~/components/team/TeamMetricsPanel.vue';
import type { TeamMetrics } from '~/types';

function metrics(overrides: Partial<TeamMetrics> = {}): TeamMetrics {
  return {
    durationMs: 125_000,
    turnCount: 4,
    perRole: [
      { roleId: 'lead', roleName: 'Lead', provider: 'codex', turnCount: 2, durationMs: 60_000 },
      { roleId: 'qa', roleName: 'Tester', provider: 'claude', turnCount: 2, durationMs: 65_000 },
    ],
    tokens: null,
    cost: null,
    ...overrides,
  };
}

describe('TeamMetricsPanel', () => {
  it('shows run totals, per-role rows with provider, turns and duration', () => {
    const wrapper = mount(TeamMetricsPanel, { props: { metrics: metrics() } });

    const totals = wrapper.find('.totals').text();
    expect(totals).toContain('2m 5s'); // 125s
    expect(totals).toContain('4'); // turn count

    const rows = wrapper.findAll('.per-role tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('Lead');
    expect(rows[0]!.text()).toContain('codex');
    expect(rows[1]!.text()).toContain('Tester');
    expect(rows[1]!.text()).toContain('claude');
  });

  it('renders tokens and cost as n/a with an explanatory tooltip', () => {
    const wrapper = mount(TeamMetricsPanel, { props: { metrics: metrics() } });
    const naCells = wrapper.findAll('.v.na');
    expect(naCells).toHaveLength(2);
    expect(naCells.map((c) => c.text())).toEqual(['n/a', 'n/a']);
    const tip = wrapper.findAll('.kv').find((k) => k.text().includes('Tokens'))?.attributes('title') ?? '';
    expect(tip.toLowerCase()).toContain('usage');
  });

  it('shows cost when reported and a placeholder when metrics are absent', () => {
    const withCost = mount(TeamMetricsPanel, { props: { metrics: metrics({ cost: 1.5, tokens: 1000 }) } });
    expect(withCost.find('.totals').text()).toContain('$1.50');
    expect(withCost.find('.totals').text()).toContain('1000');

    const none = mount(TeamMetricsPanel, { props: { metrics: null } });
    expect(none.find('.empty').exists()).toBe(true);
  });
});
