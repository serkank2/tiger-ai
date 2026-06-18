import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import LimitStatusChip from '~/components/limits/LimitStatusChip.vue';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import type { LimitStatus } from '~/types';

const checkedAt = '2026-06-18T07:00:00.000Z';

function makeStatus(overrides: Partial<LimitStatus> = {}): LimitStatus {
  const snapshot = {
    id: 'snap-1',
    provider: 'claude' as const,
    windowKey: '5h',
    label: '5h window',
    percentUsed: 12,
    metricRaw: { percent: 95, metric: 'left' as const },
    resetText: 'in 2h',
    resetAt: '2026-06-18T09:00:00.000Z',
    ok: true,
    rawPanel: 'Claude usage panel',
    parseConfidence: 'trusted' as const,
    checkedAt,
  };

  return {
    snapshots: [snapshot],
    latest: [snapshot],
    providers: {
      claude: { provider: 'claude', latest: [snapshot], latestCheckedAt: checkedAt, ok: true },
      codex: { provider: 'codex', latest: [], latestCheckedAt: null, ok: false },
    },
    rules: [],
    decision: {
      allowed: true,
      action: 'allow',
      reason: 'No active limit rule is blocking execution.',
      resumeAfter: null,
      conservative: false,
      checkedAt,
    },
    staleAfterMs: 15 * 60 * 1000,
    updatedAt: checkedAt,
    ...overrides,
  };
}

describe('LimitStatusChip', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders backend-normalized percentUsed without using the raw left metric', () => {
    useConnectionStore().setStatus('connected');
    useLimitsStore().applyState(makeStatus());

    const wrapper = mount(LimitStatusChip);

    expect(wrapper.find('.pct').text()).toBe('12%');
    expect(wrapper.text()).not.toContain('95%');
    expect(wrapper.text()).not.toContain('5%');
  });

  it('shows the backend gate decision when blocked', () => {
    useConnectionStore().setStatus('connected');
    useLimitsStore().applyState(
      makeStatus({
        decision: {
          allowed: false,
          action: 'block',
          reason: 'Claude is over the configured limit.',
          resumeAfter: '2026-06-18T09:00:00.000Z',
          conservative: false,
          checkedAt,
        },
      }),
    );

    const wrapper = mount(LimitStatusChip);

    expect(wrapper.find('.label').text()).toBe('Blocked');
    expect(wrapper.classes()).toContain('state-blocked');
  });

  it('surfaces disconnected and stale states', () => {
    const conn = useConnectionStore();
    const limits = useLimitsStore();

    conn.setStatus('disconnected');
    limits.applyState(makeStatus());
    expect(mount(LimitStatusChip).find('.label').text()).toBe('Offline');

    conn.setStatus('connected');
    limits.applyState(makeStatus({ staleAfterMs: 1 }));
    expect(mount(LimitStatusChip).find('.label').text()).toBe('Limits stale');
  });
});
