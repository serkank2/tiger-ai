import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import QueueView from '~/components/queue/QueueView.vue';
import { useDialogStore } from '~/stores/dialog';
import type { QueueEvent, QueueJobView, QueueState, QueueStep, TigerStageId } from '~/types';

const api = vi.hoisted(() => ({
  getQueueState: vi.fn(),
  enqueueQueue: vi.fn(),
  reorderQueue: vi.fn(),
  bulkQueue: vi.fn(),
  pauseQueueJob: vi.fn(),
  resumeQueueJob: vi.fn(),
  cancelQueueJob: vi.fn(),
  retryQueueJob: vi.fn(),
  createQueueRule: vi.fn(),
  updateQueueRule: vi.fn(),
  deleteQueueRule: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  conn: { status: 'connected' },
  socket: { onServerEvent: vi.fn(() => vi.fn()) },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));
vi.mock('~/stores/connection', () => ({ useConnectionStore: () => mocks.conn }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => mocks.socket }));

function step(jobId: string, stepKey: TigerStageId, position: number, status: QueueStep['status'] = 'pending'): QueueStep {
  return {
    id: `${jobId}-${stepKey}`,
    jobId,
    stepKey,
    position,
    status,
    attempts: status === 'pending' ? 0 : 1,
    error: status === 'failed' ? 'Step failed' : null,
    checkpoint: null,
    startedAt: status === 'running' || status === 'completed' ? '2026-06-18T08:00:00.000Z' : null,
    completedAt: status === 'completed' ? '2026-06-18T08:05:00.000Z' : null,
    createdAt: '2026-06-18T07:00:00.000Z',
    updatedAt: '2026-06-18T08:00:00.000Z',
  };
}

function job(id: string, overrides: Partial<QueueJobView> = {}): QueueJobView {
  const base: QueueJobView = {
    id,
    position: id === 'first' ? 1 : 2,
    status: 'queued',
    priority: 0,
    provider: 'codex',
    workspacePath: `C:\\queue\\${id}`,
    projectName: id,
    prompt: `Prompt for ${id}`,
    configSnapshot: {},
    attempts: 0,
    maxAttempts: 1,
    blockedReason: null,
    resumeAfter: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStep: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-06-18T07:00:00.000Z',
    updatedAt: '2026-06-18T07:00:00.000Z',
    steps: [step(id, 'brainstorming', 1), step(id, 'writing-plan', 2)],
  };
  return { ...base, ...overrides };
}

function event(id: string, jobId: string | null, type: string, message: string, createdAt = '2026-06-18T08:00:00.000Z'): QueueEvent {
  return { id, jobId, type, message, payload: null, createdAt };
}

function state(jobs: QueueJobView[], events: QueueEvent[] = []): QueueState {
  return {
    jobs,
    rules: [
      {
        id: 'rule-1',
        name: 'Claude usage >= 90%',
        enabled: true,
        provider: 'claude',
        windowKey: 'any',
        metric: 'percent_used',
        operator: 'gte',
        threshold: 90,
        action: 'block_dispatch',
        config: null,
        createdAt: '2026-06-18T07:00:00.000Z',
        updatedAt: '2026-06-18T07:00:00.000Z',
      },
    ],
    events,
    runningByProvider: { claude: 0, codex: 0, antigravity: 0, mixed: 0 },
    providerConcurrency: { claude: 2, codex: 2, antigravity: 1, mixed: 1 },
    updatedAt: '2026-06-18T08:00:00.000Z',
  };
}

// BaseButton relies on Nuxt's auto-imported `computed`, which the bare Vitest env
// doesn't provide. Stub it with a plain <button> that forwards click + attrs
// (data-testid/type fall through to the root element automatically).
const BaseButtonStub = {
  props: ['disabled', 'loading'],
  emits: ['click'],
  template:
    '<button :disabled="disabled || loading" @click="$emit(\'click\', $event)"><slot /></button>',
};

async function mountQueue(initial: QueueState) {
  api.getQueueState.mockResolvedValue(initial);
  const wrapper = mount(QueueView, { global: { stubs: { BaseButton: BaseButtonStub } } });
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe('QueueView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.conn = reactive({ status: 'connected' });
    mocks.socket = { onServerEvent: vi.fn(() => vi.fn()) };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders empty and disconnected states', async () => {
    mocks.conn.status = 'disconnected';
    const wrapper = await mountQueue(state([]));

    expect(wrapper.find('[data-testid="disconnected-banner"]').text()).toContain('disconnected');
    expect(wrapper.find('[data-testid="empty-state"]').text()).toContain('No queued jobs');
  });

  it('submits a new queue job', async () => {
    const wrapper = await mountQueue(state([]));
    api.enqueueQueue.mockResolvedValue(job('new'));

    await wrapper.find('[data-testid="enqueue-project"]').setValue('Queued project');
    await wrapper.find('[data-testid="enqueue-provider"]').setValue('mixed');
    await wrapper.find('[data-testid="enqueue-prompt"]').setValue('Build the queue screen');
    await wrapper.find('[data-testid="enqueue-form"]').trigger('submit');
    await flushPromises();

    expect(api.enqueueQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'Queued project',
        provider: 'mixed',
        prompt: 'Build the queue screen',
      }),
    );
  });

  it('renders blocked-by-limit reason and resume countdown', async () => {
    const blocked = job('blocked', {
      status: 'blocked_by_limit',
      blockedReason: 'Claude usage is above 90%.',
      resumeAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    const wrapper = await mountQueue(state([blocked]));

    expect(wrapper.find('[data-testid="blocked-panel"]').text()).toContain('Claude usage is above 90%.');
    expect(wrapper.find('[data-testid="selected-blocked"]').text()).toContain('Countdown');
    expect(wrapper.find('[data-testid="rules-panel"]').text()).toContain('claude any');
  });

  it('runs reorder, pause, cancel, and retry controls', async () => {
    const first = job('first');
    const second = job('second');
    const wrapper = await mountQueue(state([first, second]));
    api.reorderQueue.mockResolvedValue(state([{ ...second, position: 1 }, { ...first, position: 2 }]));
    api.pauseQueueJob.mockResolvedValue(job('first', { status: 'paused' }));
    api.cancelQueueJob.mockResolvedValue(job('first', { status: 'canceled' }));
    api.retryQueueJob.mockResolvedValue(job('first', { status: 'retrying' }));

    await wrapper.find('[data-testid="move-down-job"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="pause-job"]').trigger('click');
    await flushPromises();

    const failedState = state([job('first', { status: 'failed', completedAt: '2026-06-18T08:30:00.000Z' })]);
    const handler = mocks.socket.onServerEvent.mock.calls[0]![1] as (msg: unknown) => void;
    handler({ type: 'queue.state', state: failedState });
    await nextTick();

    await wrapper.find('[data-testid="retry-job"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="cancel-job"]').trigger('click');
    await flushPromises();

    expect(api.reorderQueue).toHaveBeenCalledWith(['second', 'first']);
    expect(api.pauseQueueJob).toHaveBeenCalledWith('first');
    expect(api.retryQueueJob).toHaveBeenCalledWith('first');
    expect(api.cancelQueueJob).toHaveBeenCalledWith('first');
  });

  it('creates, updates, and deletes queue limit rules from the queue screen', async () => {
    const wrapper = await mountQueue(state([]));
    api.createQueueRule.mockResolvedValue({});
    api.updateQueueRule.mockResolvedValue({});
    api.deleteQueueRule.mockResolvedValue(undefined);

    await wrapper.find('[data-testid="rule-name"]').setValue('Codex usage >= 80%');
    await wrapper.find('[data-testid="rule-provider"]').setValue('codex');
    await wrapper.find('[data-testid="rule-threshold"]').setValue(80);
    await wrapper.find('[data-testid="rule-form"]').trigger('submit');
    await flushPromises();

    expect(api.createQueueRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Codex usage >= 80%',
        provider: 'codex',
        threshold: 80,
        action: 'block_dispatch',
      }),
    );

    await wrapper.find('[data-testid="edit-rule"]').trigger('click');
    await wrapper.find('[data-testid="rule-threshold"]').setValue(85);
    await wrapper.find('[data-testid="rule-form"]').trigger('submit');
    await flushPromises();

    expect(api.updateQueueRule).toHaveBeenCalledWith(
      'rule-1',
      expect.objectContaining({
        id: 'rule-1',
        threshold: 85,
      }),
    );

    await wrapper.find('[data-testid="delete-rule"]').trigger('click');
    await flushPromises();

    expect(api.deleteQueueRule).toHaveBeenCalledWith('rule-1');
  });

  it('reorders queued jobs via native drag-and-drop', async () => {
    const first = job('first');
    const second = job('second');
    const wrapper = await mountQueue(state([first, second]));
    api.reorderQueue.mockResolvedValue(state([{ ...second, position: 1 }, { ...first, position: 2 }]));

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    await wrapper.find('[data-testid="job-row-first"]').trigger('dragstart', { dataTransfer });
    await wrapper.find('[data-testid="job-row-second"]').trigger('dragover', { dataTransfer });
    await wrapper.find('[data-testid="job-row-second"]').trigger('drop', { dataTransfer });
    await flushPromises();

    // Dragging "first" onto "second" moves it after second.
    expect(api.reorderQueue).toHaveBeenCalledWith(['second', 'first']);
  });

  it('multi-selects jobs and applies a bulk action to the selection', async () => {
    const first = job('first');
    const second = job('second');
    const wrapper = await mountQueue(state([first, second]));
    api.bulkQueue.mockResolvedValue({
      action: 'cancel',
      results: [
        { id: 'first', ok: true, status: 'canceled' },
        { id: 'second', ok: true, status: 'canceled' },
      ],
      state: state([job('first', { status: 'canceled' }), job('second', { status: 'canceled' })]),
    });

    await wrapper.find('[data-testid="select-job-first"]').setValue(true);
    await wrapper.find('[data-testid="select-job-second"]').setValue(true);
    expect(wrapper.find('[data-testid="bulk-bar"]').text()).toContain('2 selected');

    // Bulk cancel is destructive: it now asks for confirmation via useDialog().
    // Confirm the pending dialog so the bulk action proceeds.
    await wrapper.find('[data-testid="bulk-cancel"]').trigger('click');
    await nextTick();
    const dialog = useDialogStore();
    const pending = dialog.current;
    expect(pending).not.toBeNull();
    dialog.settle(pending!.id, true);
    await flushPromises();

    expect(api.bulkQueue).toHaveBeenCalledWith('cancel', ['first', 'second']);
    // Selection clears after a successful bulk action.
    expect(wrapper.find('[data-testid="bulk-bar"]').exists()).toBe(false);
  });

  it('shows per-provider concurrency lanes from queue state', async () => {
    const running = state([job('first', { status: 'running', provider: 'claude' })]);
    running.runningByProvider = { claude: 1, codex: 0, antigravity: 0, mixed: 0 };
    const wrapper = await mountQueue(running);

    const lanes = wrapper.find('[data-testid="lanes-panel"]').text();
    expect(lanes).toContain('Claude 1/2');
    expect(lanes).toContain('Codex 0/2');
  });

  it('applies queue.state websocket updates to active progress and event log', async () => {
    const wrapper = await mountQueue(state([job('first')]));
    const running = state(
      [
        job('first', {
          status: 'running',
          currentStep: 'brainstorming',
          startedAt: '2026-06-18T08:00:00.000Z',
          updatedAt: '2026-06-18T08:10:00.000Z',
          steps: [step('first', 'brainstorming', 1, 'running'), step('first', 'writing-plan', 2)],
        }),
      ],
      [event('evt-leased', 'first', 'queue.leased', 'Queue job leased by scheduler.', '2026-06-18T08:10:00.000Z')],
    );

    const handler = mocks.socket.onServerEvent.mock.calls[0]![1] as (msg: unknown) => void;
    handler({ type: 'queue.state', state: running });
    await nextTick();

    expect(wrapper.find('[data-testid="active-panel"]').text()).toContain('brainstorming');
    expect(wrapper.find('[data-testid="step-timeline"]').text()).toContain('running');
    expect(wrapper.find('[data-testid="event-log"]').text()).toContain('queue.leased');
  });
});
