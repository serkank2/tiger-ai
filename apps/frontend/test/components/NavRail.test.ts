import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NavRail from '~/components/shell/NavRail.vue';
import { NAV_ITEMS } from '~/lib/navigation';

// Stub NuxtLink with a plain anchor so the rail renders without the Nuxt router.
const NuxtLink = { props: ['to'], template: '<a :href="to"><slot /></a>' };

function mountRail(activePath: string) {
  return mount(NavRail, {
    props: { items: NAV_ITEMS, activePath },
    global: { stubs: { NuxtLink } },
  });
}

describe('NavRail', () => {
  it('renders one link per nav item', () => {
    const wrapper = mountRail('/terminals');
    expect(wrapper.findAll('a.item')).toHaveLength(NAV_ITEMS.length);
  });

  it('marks the active item from an exact path match', () => {
    const wrapper = mountRail('/queue');
    const active = wrapper.findAll('a.item.active');
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain('Queue');
    expect(active[0]!.attributes('aria-current')).toBe('page');
  });

  it('marks the active item from a nested route prefix', () => {
    const wrapper = mountRail('/tiger/run');
    const active = wrapper.findAll('a.item.active');
    expect(active).toHaveLength(1);
    expect(active[0]!.text()).toContain('Projects');
  });

  it('marks nothing active for an unknown path', () => {
    const wrapper = mountRail('/');
    expect(wrapper.findAll('a.item.active')).toHaveLength(0);
  });
});
