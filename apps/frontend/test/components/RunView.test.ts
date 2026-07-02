import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import RunView from '~/components/runs/RunView.vue';
import type { RunSnapshot } from '~/types';

const api = vi.hoisted(() => ({
  getCurrentRun: vi.fn(),
  createRun: vi.fn(),
  startRun: vi.fn(),
  stopRun: vi.fn(),
  steerRun: vi.fn(),
  listRunEvents: vi.fn(),
  getRunChanges: vi.fn(),
  listRuns: vi.fn(),
  getRunById: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  socket: { onServerEvent: vi.fn(() => vi.fn()) },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => mocks.socket }));

// The ui primitives lean on Nuxt auto-imports (computed/useId) that the bare
// Vitest env doesn't provide — stub them with plain elements (QueueView.test
// established the pattern). BaseModal is stubbed WITHOUT teleport so the modal
// content stays inside the wrapper for find().
const stubs = {
  BaseButton: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: `<button :disabled="disabled || loading" @click="$emit('click', $event)"><slot /></button>`,
  },
  BaseField: { props: ['label'], template: '<label><span>{{ label }}</span><slot /></label>' },
  BaseInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
  },
  BaseSelect: {
    props: ['modelValue', 'options'],
    emits: ['update:modelValue'],
    template: `<select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)"><option v-for="o in options ?? []" :key="o.value" :value="o.value">{{ o.label }}</option></select>`,
  },
  BaseModal: { props: ['title'], template: '<div v-bind="$attrs"><b>{{ title }}</b><slot /></div>' },
  FolderPicker: { template: '<div />' },
  EmptyState: { props: ['title'], template: '<div>{{ title }}</div>' },
  Spinner: { template: '<span />' },
};

function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'run-1',
    workspace: 'C:/w',
    goal: 'Ship the feature',
    status: 'running',
    createdAt: '2026-07-02T10:00:00.000Z',
    profile: 'mission',
    importance: 'normal',
    council: { plan: 1, review: 1, providers: ['claude'] },
    seq: 5,
    usage: { turns: 2, inputTokens: 1200, outputTokens: 400, costUsd: 0.1234 },
    graph: {
      items: [
        {
          id: 'P1',
          kind: 'plan',
          title: 'Plan the work',
          description: 'Decompose the goal.',
          dependsOn: [],
          status: 'done',
          agentKey: 'planner',
          attempts: 1,
          createdAt: 'x',
          resultSummary: 'planned two tasks',
        },
        {
          id: 'T1',
          kind: 'build',
          title: 'Implement A',
          description: 'do A fully',
          dependsOn: [],
          status: 'running',
          agentKey: 'builder',
          attempts: 1,
          createdAt: 'x',
        },
      ],
    },
    verifications: [],
    steering: [],
    ...over,
  };
}

async function mountView(run: RunSnapshot | null) {
  api.getCurrentRun.mockResolvedValue({ run });
  api.listRunEvents.mockResolvedValue({ events: [] });
  const wrapper = mount(RunView, { attachTo: document.body, global: { stubs } });
  await flushPromises();
  return wrapper;
}

describe('RunView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('shows the create form when no run exists', async () => {
    const wrapper = await mountView(null);
    expect(wrapper.find('[data-testid="run-create-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="run-status"]').exists()).toBe(false);
  });

  it('renders the work graph, status chip, and usage for a live run', async () => {
    const wrapper = await mountView(snapshot());
    expect(wrapper.find('[data-testid="run-status"]').text().toLowerCase()).toContain('running');
    expect(wrapper.find('[data-testid="run-item-P1"]').text()).toContain('planned two tasks');
    expect(wrapper.find('[data-testid="run-item-T1"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('$0.1234');
    // Steer button disabled until text is entered.
    expect(wrapper.find('[data-testid="run-steer"]').attributes('disabled')).toBeDefined();
  });

  it('opens the work-item drill-down modal on click', async () => {
    const wrapper = await mountView(snapshot());
    await wrapper.find('[data-testid="run-item-P1"]').trigger('click');
    expect(wrapper.find('[data-testid="run-item-modal"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="run-item-modal"]').text()).toContain('Decompose the goal.');
  });

  it('fetches and shows the changes panel on toggle', async () => {
    api.getRunChanges.mockResolvedValue({
      changes: {
        isGitRepo: true,
        head: 'abc',
        branch: 'main',
        files: [{ path: 'src/a.ts', status: 'modified' }],
        diff: '+++ b/src/a.ts\n+added line',
        diffTruncated: false,
        summary: { files: 1, insertions: 1, deletions: 0 },
        generatedAt: 'now',
      },
    });
    const wrapper = await mountView(snapshot());
    await wrapper.find('[data-testid="run-toggle-changes"]').trigger('click');
    await flushPromises();
    expect(api.getRunChanges).toHaveBeenCalled();
    const panel = wrapper.find('[data-testid="run-changes"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('src/a.ts');
  });

  it('loads and lists run history on toggle', async () => {
    api.listRuns.mockResolvedValue({
      runs: [
        {
          runId: 'run-0',
          workspace: 'C:/w',
          goalPreview: 'previous goal',
          status: 'completed',
          createdAt: '2026-07-01T10:00:00.000Z',
          turns: 4,
          itemsDone: 3,
          itemsTotal: 3,
          costUsd: 0.5,
        },
      ],
    });
    const wrapper = await mountView(snapshot());
    await wrapper.find('[data-testid="run-toggle-history"]').trigger('click');
    await flushPromises();
    const panel = wrapper.find('[data-testid="run-history"]');
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain('previous goal');
    expect(panel.find('[data-testid="run-history-open-run-0"]').exists()).toBe(true);
  });
});
