import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import EmptyState from '~/components/ui/EmptyState.vue';

// Empty-/error-state surface. Title + description, optional icon, optional #actions
// slot for a call-to-action, and a danger tone for failed-to-load states.
describe('ui/EmptyState', () => {
  it('renders the title', () => {
    const wrapper = mount(EmptyState, { props: { title: 'No terminals yet' } });
    expect(wrapper.find('.empty-title').text()).toBe('No terminals yet');
  });

  it('renders the description only when provided', () => {
    const without = mount(EmptyState, { props: { title: 't' } });
    expect(without.find('.empty-desc').exists()).toBe(false);

    const withDesc = mount(EmptyState, { props: { title: 't', description: 'Add one to begin.' } });
    expect(withDesc.find('.empty-desc').text()).toBe('Add one to begin.');
  });

  it('applies the danger tone modifier', () => {
    expect(mount(EmptyState, { props: { title: 't' } }).find('.empty').classes()).not.toContain('danger');
    expect(mount(EmptyState, { props: { title: 't', tone: 'danger' } }).find('.empty').classes()).toContain(
      'danger',
    );
  });

  it('renders the actions area only when the #actions slot is filled', () => {
    const without = mount(EmptyState, { props: { title: 't' } });
    expect(without.find('.empty-actions').exists()).toBe(false);

    const withSlot = mount(EmptyState, {
      props: { title: 't' },
      slots: { actions: '<button>Create</button>' },
    });
    expect(withSlot.find('.empty-actions').exists()).toBe(true);
    expect(withSlot.find('.empty-actions button').text()).toBe('Create');
  });
});
