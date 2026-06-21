import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import BaseTabs, { type BaseTab } from '~/components/ui/BaseTabs.vue';

const tabs: BaseTab[] = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' },
];

function mountTabs(options: { initial?: string; items?: BaseTab[] } = {}) {
  const Harness = defineComponent({
    components: { BaseTabs },
    setup() {
      return {
        active: ref(options.initial ?? 'one'),
        tabs: options.items ?? tabs,
      };
    },
    template: `
      <BaseTabs v-model="active" :tabs="tabs" label="Demo tabs" id-prefix="demo-tabs">
        <template #one><p data-testid="panel-one">One panel</p></template>
        <template #two><p data-testid="panel-two">Two panel</p></template>
        <template #three><p data-testid="panel-three">Three panel</p></template>
      </BaseTabs>
      <output data-testid="active">{{ active }}</output>
    `,
  });

  return mount(Harness, { attachTo: document.body });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('BaseTabs', () => {
  it('renders labeled tabs with roving tabindex and a labelled active panel', () => {
    const wrapper = mountTabs();

    const tablist = wrapper.find('[role="tablist"]');
    expect(tablist.exists()).toBe(true);
    expect(tablist.attributes('aria-label')).toBe('Demo tabs');

    const renderedTabs = wrapper.findAll('[role="tab"]');
    expect(renderedTabs).toHaveLength(3);
    expect(renderedTabs.map((tab) => tab.text())).toEqual(['One', 'Two', 'Three']);
    expect(renderedTabs[0]!.attributes()).toMatchObject({
      id: 'demo-tabs-tab-one',
      'aria-selected': 'true',
      'aria-controls': 'demo-tabs-panel-one',
      tabindex: '0',
    });
    expect(renderedTabs[1]!.attributes()).toMatchObject({
      id: 'demo-tabs-tab-two',
      'aria-selected': 'false',
      tabindex: '-1',
    });

    const panel = wrapper.find('[role="tabpanel"]');
    expect(panel.attributes()).toMatchObject({
      id: 'demo-tabs-panel-one',
      'aria-labelledby': 'demo-tabs-tab-one',
    });
    expect(wrapper.find('[data-testid="panel-one"]').exists()).toBe(true);
  });

  it('updates v-model and panel labelling on click', async () => {
    const wrapper = mountTabs();

    await wrapper.find('#demo-tabs-tab-two').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="active"]').text()).toBe('two');
    expect(wrapper.find('#demo-tabs-tab-two').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('[role="tabpanel"]').attributes()).toMatchObject({
      id: 'demo-tabs-panel-two',
      'aria-labelledby': 'demo-tabs-tab-two',
    });
    expect(wrapper.find('[data-testid="panel-two"]').exists()).toBe(true);
  });

  it('moves and activates tabs with ArrowLeft, ArrowRight, Home, and End', async () => {
    const wrapper = mountTabs();

    await wrapper.find('#demo-tabs-tab-one').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(wrapper.find('[data-testid="active"]').text()).toBe('two');
    expect(document.activeElement).toBe(wrapper.find('#demo-tabs-tab-two').element);

    await wrapper.find('#demo-tabs-tab-two').trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(wrapper.find('[data-testid="active"]').text()).toBe('one');
    expect(document.activeElement).toBe(wrapper.find('#demo-tabs-tab-one').element);

    await wrapper.find('#demo-tabs-tab-one').trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(wrapper.find('[data-testid="active"]').text()).toBe('three');
    expect(document.activeElement).toBe(wrapper.find('#demo-tabs-tab-three').element);

    await wrapper.find('#demo-tabs-tab-three').trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(wrapper.find('[data-testid="active"]').text()).toBe('one');
    expect(document.activeElement).toBe(wrapper.find('#demo-tabs-tab-one').element);
  });

  it('falls back safely for a stale active id', async () => {
    const wrapper = mountTabs({ initial: 'missing' });
    await flushPromises();

    expect(wrapper.find('[data-testid="active"]').text()).toBe('one');
    expect(wrapper.find('#demo-tabs-tab-one').attributes('tabindex')).toBe('0');
    expect(wrapper.find('[role="tabpanel"]').attributes('id')).toBe('demo-tabs-panel-one');
  });

  it('handles single and zero tab lists without throwing', async () => {
    const single = mountTabs({ items: [{ id: 'one', label: 'One' }] });
    await single.find('#demo-tabs-tab-one').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(single.find('[data-testid="active"]').text()).toBe('one');
    expect(single.find('[role="tabpanel"]').exists()).toBe(true);

    const empty = mountTabs({ initial: 'missing', items: [] });
    await flushPromises();
    expect(empty.findAll('[role="tab"]')).toHaveLength(0);
    expect(empty.find('[role="tabpanel"]').exists()).toBe(false);
    expect(empty.find('[data-testid="active"]').text()).toBe('missing');
  });
});
