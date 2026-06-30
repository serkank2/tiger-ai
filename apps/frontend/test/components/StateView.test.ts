import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StateView from '~/components/state/StateView.vue';

// Shared cross-cutting state panel used by relocated screens for the recurring
// empty / loading / error / blocked / etc. lifecycle states.
describe('StateView', () => {
  it('renders a default heading per kind', () => {
    expect(
      mount(StateView, { props: { kind: 'empty' } })
        .find('.title')
        .text(),
    ).toBe('Nothing here yet');
    expect(
      mount(StateView, { props: { kind: 'error' } })
        .find('.title')
        .text(),
    ).toBe('Something went wrong');
    expect(
      mount(StateView, { props: { kind: 'blocked' } })
        .find('.title')
        .text(),
    ).toBe('Blocked');
    expect(
      mount(StateView, { props: { kind: 'canceled' } })
        .find('.title')
        .text(),
    ).toBe('Canceled');
  });

  it('allows overriding the title and description', () => {
    const wrapper = mount(StateView, {
      props: { kind: 'error', title: 'Custom title', description: 'Details here' },
    });
    expect(wrapper.find('.title').text()).toBe('Custom title');
    expect(wrapper.find('.desc').text()).toBe('Details here');
  });

  it('shows a spinner and marks aria-busy for busy states', () => {
    const wrapper = mount(StateView, { props: { kind: 'loading' } });
    expect(wrapper.find('.spinner').exists()).toBe(true);
    expect(wrapper.find('.state-view').attributes('aria-busy')).toBe('true');
  });

  it('shows a static icon (not a spinner) for resting states', () => {
    const wrapper = mount(StateView, { props: { kind: 'empty' } });
    expect(wrapper.find('.spinner').exists()).toBe(false);
    expect(wrapper.find('.icon').exists()).toBe(true);
  });

  it('applies the tone class for the kind', () => {
    expect(
      mount(StateView, { props: { kind: 'error' } })
        .find('.state-view')
        .classes(),
    ).toContain('error');
    expect(
      mount(StateView, { props: { kind: 'blocked' } })
        .find('.state-view')
        .classes(),
    ).toContain('warn');
    expect(
      mount(StateView, { props: { kind: 'empty' } })
        .find('.state-view')
        .classes(),
    ).toContain('neutral');
  });

  it('renders an actions area only when the default slot is filled', () => {
    const without = mount(StateView, { props: { kind: 'error' } });
    expect(without.find('.actions').exists()).toBe(false);
    const withSlot = mount(StateView, {
      props: { kind: 'error' },
      slots: { default: '<button>Retry</button>' },
    });
    expect(withSlot.find('.actions button').text()).toBe('Retry');
  });
});
