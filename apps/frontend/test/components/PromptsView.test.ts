import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import PromptsView from '~/components/PromptsView.vue';

const stores = vi.hoisted(() => ({
  prompts: {
    items: [],
    loading: false,
    loaded: true,
    loadError: null,
    fetchAll: vi.fn(async () => {}),
    open: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
  },
  history: {
    items: [],
    loading: false,
    loaded: true,
    refreshing: false,
    loadError: null,
    fetchAll: vi.fn(async () => {}),
    bindSocket: vi.fn(() => vi.fn()),
  },
  generation: {
    current: { generation: { outputText: 'Generated prompt text', id: 'gen-1', status: 'done' } },
    starting: false,
    loading: false,
    loadError: null,
    start: vi.fn(),
    reuse: vi.fn(),
    bindSocket: vi.fn(() => vi.fn()),
  },
  terminals: {
    items: [],
    byId: {},
    loaded: true,
    fetchAll: vi.fn(async () => {}),
    unprotectedIds: vi.fn((ids: string[]) => ids),
  },
  groups: {
    groups: [],
    loaded: true,
    load: vi.fn(async () => {}),
  },
  tiger: {
    initialized: false,
    workspace: null,
    loaded: true,
    load: vi.fn(async () => {}),
    replaceProjectPrompt: vi.fn(),
  },
  conn: { status: 'connected' },
  notices: { push: vi.fn() },
  socket: { broadcast: vi.fn() },
  api: { enqueueQueueJob: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    reactive,
    ref,
    watch,
    usePromptsStore: () => stores.prompts,
    usePromptHistoryStore: () => stores.history,
    usePromptGenerationStore: () => stores.generation,
    useTerminalsStore: () => stores.terminals,
    useGroupsStore: () => stores.groups,
    useTigerStore: () => stores.tiger,
    useConnectionStore: () => stores.conn,
    useNoticesStore: () => stores.notices,
    useSocket: () => stores.socket,
    useApi: () => stores.api,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

const BaseButtonStub = {
  props: ['disabled', 'loading', 'variant', 'block'],
  emits: ['click'],
  template: '<button :disabled="disabled || loading" @click="$emit(\'click\', $event)"><slot /></button>',
};

async function mountPromptsView() {
  const wrapper = mount(PromptsView, {
    attachTo: document.body,
    global: {
      stubs: {
        BaseButton: BaseButtonStub,
        EmptyState: { template: '<div class="empty"><slot /></div>' },
        PromptEditor: { template: '<div data-testid="prompt-editor" />' },
        PromptGenerationPanel: { template: '<div data-testid="generation-panel" />' },
        PromptHistoryPanel: { template: '<div data-testid="history-panel" />' },
        PromptLibrary: { template: '<div data-testid="prompt-library" />' },
        PromptTargetPicker: { template: '<div data-testid="target-picker" />' },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('PromptsView accessibility', () => {
  it('exposes section controls as keyboard-operable ARIA tabs', async () => {
    const wrapper = await mountPromptsView();
    const tablist = wrapper.find('[role="tablist"][aria-label="Prompt sections"]');
    expect(tablist.exists()).toBe(true);

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.text())).toEqual(['Library', 'History', 'Generation']);
    expect(tabs[0]!.attributes()).toMatchObject({
      id: 'prompt-section-tab-library',
      'aria-selected': 'true',
      'aria-controls': 'prompt-section-panel-library',
      tabindex: '0',
    });
    expect(tabs[1]!.attributes()).toMatchObject({
      id: 'prompt-section-tab-history',
      'aria-selected': 'false',
      tabindex: '-1',
    });

    let panel = wrapper.find('[role="tabpanel"]');
    expect(panel.attributes()).toMatchObject({
      id: 'prompt-section-panel-library',
      'aria-labelledby': 'prompt-section-tab-library',
    });

    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(wrapper.find('#prompt-section-tab-history').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('#prompt-section-tab-history').attributes('tabindex')).toBe('0');
    expect(document.activeElement).toBe(wrapper.find('#prompt-section-tab-history').element);
    panel = wrapper.find('[role="tabpanel"]');
    expect(panel.attributes()).toMatchObject({
      id: 'prompt-section-panel-history',
      'aria-labelledby': 'prompt-section-tab-history',
    });

    await wrapper.find('#prompt-section-tab-history').trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(wrapper.find('#prompt-section-tab-generation').attributes('aria-selected')).toBe('true');

    await wrapper.find('#prompt-section-tab-generation').trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(wrapper.find('#prompt-section-tab-library').attributes('aria-selected')).toBe('true');
  });

  it('gives the save-path input a programmatic accessible name', async () => {
    const wrapper = await mountPromptsView();
    await wrapper.find('#prompt-section-tab-generation').trigger('click');
    await flushPromises();

    const input = wrapper.find('input[placeholder="library-path.md"]');

    expect(input.exists()).toBe(true);
    expect(input.attributes('aria-label')).toBe('Save path');
  });
});
