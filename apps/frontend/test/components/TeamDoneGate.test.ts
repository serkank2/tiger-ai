import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TeamDoneGate from '~/components/team/TeamDoneGate.vue';
import type { DoneGateState } from '~/types';

function gate(overrides: Partial<DoneGateState> = {}): DoneGateState {
  return {
    satisfied: false,
    requiredRoleIds: ['dev', 'qa'],
    signedOffRoleIds: ['dev'],
    pendingRoleIds: ['qa'],
    openBlockers: [],
    ...overrides,
  };
}

describe('TeamDoneGate blockers', () => {
  it('renders each open blocker with a human label and the explanation', () => {
    const wrapper = mount(TeamDoneGate, {
      props: {
        gate: gate({
          openBlockers: [
            { code: 'verification_failed', message: 'npm test exited non-zero' },
            { code: 'signoff_missing', message: 'QA has not signed off' },
          ],
        }),
        status: 'blocked',
      },
    });

    const items = wrapper.findAll('.blocker');
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain('Verification failed');
    expect(items[0]!.text()).toContain('npm test exited non-zero');
    expect(items[1]!.text()).toContain('Sign-off missing');
  });

  it('falls back to the raw code when it is unknown', () => {
    const wrapper = mount(TeamDoneGate, {
      props: { gate: gate({ openBlockers: [{ code: 'novel_code', message: 'why' }] }), status: 'running' },
    });
    expect(wrapper.find('.bcode').text()).toBe('novel_code');
  });

  it('renders no blocker list when the gate is satisfied', () => {
    const wrapper = mount(TeamDoneGate, {
      props: { gate: gate({ satisfied: true, openBlockers: [] }), status: 'completed' },
    });
    expect(wrapper.find('.blockers').exists()).toBe(false);
    expect(wrapper.find('.done-gate').classes()).toContain('satisfied');
  });

  it('tolerates a snapshot without openBlockers (optional field)', () => {
    const base = gate();
    delete (base as Partial<DoneGateState>).openBlockers;
    const wrapper = mount(TeamDoneGate, { props: { gate: base, status: 'running' } });
    expect(wrapper.find('.blockers').exists()).toBe(false);
  });
});
