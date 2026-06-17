import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Skeleton from '~/components/Skeleton.vue';

// Loading-placeholder primitive: decorative, so it must be hidden from assistive tech
// and render the requested number of shimmer lines.
describe('Skeleton', () => {
  it('renders a single line by default', () => {
    const wrapper = mount(Skeleton);
    expect(wrapper.findAll('.line')).toHaveLength(1);
  });

  it('renders the requested number of lines', () => {
    const wrapper = mount(Skeleton, { props: { lines: 4 } });
    expect(wrapper.findAll('.line')).toHaveLength(4);
  });

  it('is hidden from assistive technology', () => {
    const wrapper = mount(Skeleton);
    expect(wrapper.find('.skeleton').attributes('aria-hidden')).toBe('true');
  });
});
