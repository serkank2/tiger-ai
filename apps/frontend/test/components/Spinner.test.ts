import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Spinner from '~/components/Spinner.vue';

// Loading-feedback primitive: must announce itself to assistive tech (role=status)
// with a sensible accessible name.
describe('Spinner', () => {
  it('is a status region with a default accessible label', () => {
    const wrapper = mount(Spinner);
    const status = wrapper.find('[role="status"]');
    expect(status.exists()).toBe(true);
    expect(status.attributes('aria-label')).toBe('Loading');
  });

  it('uses a custom label for both the aria-label and the visible text', () => {
    const wrapper = mount(Spinner, { props: { label: 'Saving…' } });
    expect(wrapper.find('[role="status"]').attributes('aria-label')).toBe('Saving…');
    expect(wrapper.find('.label').text()).toBe('Saving…');
  });

  it('renders no visible label text when none is provided', () => {
    const wrapper = mount(Spinner);
    expect(wrapper.find('.label').exists()).toBe(false);
  });

  it('applies the small modifier class', () => {
    const wrapper = mount(Spinner, { props: { small: true } });
    expect(wrapper.classes()).toContain('small');
  });
});
