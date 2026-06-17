import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import EmptyState from '~/components/EmptyState.vue';

// Empty-/error-state feedback primitive used where lists or panels have no content.
describe('EmptyState', () => {
  it('renders the title', () => {
    const wrapper = mount(EmptyState, { props: { title: 'No terminals yet' } });
    expect(wrapper.find('.title').text()).toBe('No terminals yet');
  });

  it('renders the description only when provided', () => {
    const without = mount(EmptyState, { props: { title: 't' } });
    expect(without.find('.desc').exists()).toBe(false);

    const withDesc = mount(EmptyState, { props: { title: 't', description: 'Add one to begin.' } });
    expect(withDesc.find('.desc').text()).toBe('Add one to begin.');
  });

  it('defaults to the neutral tone and supports the error tone', () => {
    expect(mount(EmptyState, { props: { title: 't' } }).find('.empty-state').classes()).toContain('neutral');
    expect(
      mount(EmptyState, { props: { title: 't', tone: 'error' } }).find('.empty-state').classes(),
    ).toContain('error');
  });

  it('renders an actions area only when the default slot is filled', () => {
    const without = mount(EmptyState, { props: { title: 't' } });
    expect(without.find('.actions').exists()).toBe(false);

    const withSlot = mount(EmptyState, {
      props: { title: 't' },
      slots: { default: '<button>Create</button>' },
    });
    expect(withSlot.find('.actions').exists()).toBe(true);
    expect(withSlot.find('.actions button').text()).toBe('Create');
  });
});
