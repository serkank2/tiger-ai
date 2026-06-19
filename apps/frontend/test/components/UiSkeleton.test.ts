import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import Skeleton from '~/components/ui/Skeleton.vue';

// ui/Skeleton uses Nuxt's auto-imported `computed`; expose it as a global for vitest.
beforeAll(() => {
  vi.stubGlobal('computed', computed);
});

// Decorative loading placeholder: always hidden from assistive tech; renders stacked
// line placeholders when asked for more than one line.
describe('ui/Skeleton', () => {
  it('renders a single decorative block by default', () => {
    const wrapper = mount(Skeleton);
    expect(wrapper.findAll('.skel')).toHaveLength(1);
    expect(wrapper.find('.skel').attributes('aria-hidden')).toBe('true');
  });

  it('renders the requested number of lines', () => {
    const wrapper = mount(Skeleton, { props: { lines: 4 } });
    expect(wrapper.findAll('.skel')).toHaveLength(4);
    expect(wrapper.find('.skel-lines').attributes('aria-hidden')).toBe('true');
  });
});
