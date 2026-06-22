import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import PromptGenerationPanel from '~/components/prompt/PromptGenerationPanel.vue';
import type { PromptGenerationState } from '~/types';
import { createTestI18n } from '../support/i18n';

function state(status: PromptGenerationState['generation']['status'], outputText: string | null = null): PromptGenerationState {
  return {
    generation: {
      id: 'g1',
      inputText: 'rough prompt',
      outputText,
      status,
      agentType: 'claude',
      model: 'opus',
      error: status === 'failed' ? 'agent failed' : null,
      projectId: null,
      terminalId: null,
      createdAt: '2026-06-18T07:00:00.000Z',
      updatedAt: '2026-06-18T07:00:00.000Z',
      startedAt: status === 'pending' ? null : '2026-06-18T07:00:01.000Z',
      completedAt: status === 'done' || status === 'failed' ? '2026-06-18T07:01:00.000Z' : null,
    },
    progress: status === 'running' ? 'running' : 'idle',
    reuseActions: status === 'done' ? ['copy', 'edit', 'save-to-library', 'use-as-project-prompt', 'enqueue'] : [],
  };
}

describe('PromptGenerationPanel', () => {
  it('submits a rough draft for generation', async () => {
    const wrapper = mount(PromptGenerationPanel, {
      props: { state: null },
      global: { plugins: [createTestI18n()], stubs: { Spinner: true } },
    });

    await wrapper.find('textarea').setValue('make this clearer');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
      inputText: 'make this clearer',
      agentType: 'claude',
    });
  });

  it('renders running, done, and failed states', async () => {
    const wrapper = mount(PromptGenerationPanel, {
      props: { state: state('running') },
      global: { plugins: [createTestI18n()], stubs: { Spinner: true } },
    });

    expect(wrapper.text()).toContain('Progress: running');

    await wrapper.setProps({ state: state('done', 'Improved prompt text') });
    expect(wrapper.text()).toContain('Improved prompt text');
    await wrapper.find('.result-actions button').trigger('click');
    expect(wrapper.emitted('selectResult')).toHaveLength(1);

    await wrapper.setProps({ state: state('failed') });
    expect(wrapper.text()).toContain('Generation failed');
    expect(wrapper.text()).toContain('agent failed');
  });
});
