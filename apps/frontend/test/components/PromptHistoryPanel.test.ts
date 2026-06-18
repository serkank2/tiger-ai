import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PromptHistoryPanel from '~/components/prompt/PromptHistoryPanel.vue';
import type { PromptHistoryEvent } from '~/types';

const items: PromptHistoryEvent[] = [
  {
    id: 'h1',
    projectId: 'project-a',
    kind: 'generated',
    inputText: 'rough deploy note',
    outputText: 'Polished deploy prompt',
    generationId: 'g1',
    metadata: { status: 'done' },
    createdAt: '2026-06-18T07:00:00.000Z',
  },
  {
    id: 'h2',
    projectId: 'project-b',
    kind: 'enqueue_requested',
    inputText: 'queue this refactor',
    outputText: null,
    generationId: null,
    metadata: { status: 'queued' },
    createdAt: '2026-06-17T07:00:00.000Z',
  },
];

describe('PromptHistoryPanel', () => {
  it('filters history by text and shows the comparison for the selected prompt', async () => {
    const wrapper = mount(PromptHistoryPanel, {
      props: { items, selectedId: 'h1' },
    });

    expect(wrapper.text()).toContain('Polished deploy prompt');
    expect(wrapper.text()).toContain('rough deploy note');

    await wrapper.find('input[placeholder="Search text, project, generation id"]').setValue('refactor');
    expect(wrapper.findAll('.row')).toHaveLength(1);
    expect(wrapper.text()).toContain('queue this refactor');
    expect(wrapper.text()).not.toContain('Polished deploy prompt');
  });

  it('renders an unavailable state with a retry action', async () => {
    const wrapper = mount(PromptHistoryPanel, {
      props: { items: [], selectedId: null, error: 'history endpoint missing' },
    });

    expect(wrapper.text()).toContain('Prompt history unavailable');
    expect(wrapper.text()).toContain('history endpoint missing');
    await wrapper.find('button.refresh').trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
  });
});
