import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SaveIndicator from '~/components/state/SaveIndicator.vue';

// Inline persistence-state indicator used by editable panels (saving / saved / error).
describe('SaveIndicator', () => {
  it('renders nothing in the idle state', () => {
    const wrapper = mount(SaveIndicator, { props: { state: 'idle' } });
    expect(wrapper.find('.save-indicator').exists()).toBe(false);
  });

  it('shows a spinner and label while saving', () => {
    const wrapper = mount(SaveIndicator, { props: { state: 'saving' } });
    expect(wrapper.find('.spinner').exists()).toBe(true);
    expect(wrapper.find('.label').text()).toBe('Saving…');
  });

  it('shows the saved state', () => {
    const wrapper = mount(SaveIndicator, { props: { state: 'saved' } });
    expect(wrapper.find('.save-indicator').classes()).toContain('saved');
    expect(wrapper.find('.label').text()).toBe('Saved');
  });

  it('shows the error state with an assertive live region', () => {
    const wrapper = mount(SaveIndicator, { props: { state: 'error' } });
    expect(wrapper.find('.save-indicator').classes()).toContain('error');
    expect(wrapper.find('.save-indicator').attributes('aria-live')).toBe('assertive');
    expect(wrapper.find('.label').text()).toBe('Save failed');
  });

  it('allows overriding the label text', () => {
    const wrapper = mount(SaveIndicator, { props: { state: 'error', message: 'Network down' } });
    expect(wrapper.find('.label').text()).toBe('Network down');
  });
});
