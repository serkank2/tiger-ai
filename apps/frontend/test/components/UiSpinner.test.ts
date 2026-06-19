import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import Spinner from '~/components/ui/Spinner.vue';

// ui/Spinner uses Nuxt's auto-imported `computed`; expose it as a global for vitest.
beforeAll(() => {
  vi.stubGlobal('computed', computed);
});

// Loading-feedback primitive: announces itself to assistive tech by default, but
// renders decoratively (aria-hidden, no role) when given an empty label.
describe('ui/Spinner', () => {
  it('is a status region with a default accessible label', () => {
    const wrapper = mount(Spinner);
    const status = wrapper.find('[role="status"]');
    expect(status.exists()).toBe(true);
    expect(wrapper.find('.sr-only').text()).toBe('Loading…');
  });

  it('uses a custom label as screen-reader text', () => {
    const wrapper = mount(Spinner, { props: { label: 'Saving…' } });
    expect(wrapper.find('.sr-only').text()).toBe('Saving…');
  });

  it('renders decoratively (no role, aria-hidden) when label is empty', () => {
    const wrapper = mount(Spinner, { props: { label: '' } });
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.spinner').attributes('aria-hidden')).toBe('true');
    expect(wrapper.find('.sr-only').exists()).toBe(false);
  });

  it('applies a numeric size as pixels', () => {
    const wrapper = mount(Spinner, { props: { size: 24 } });
    expect(wrapper.find('.spinner').attributes('style')).toContain('width: 24px');
  });
});
