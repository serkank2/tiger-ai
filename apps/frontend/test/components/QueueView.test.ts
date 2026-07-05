import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import QueueView from '~/components/queue/QueueView.vue';
import { useDialogStore } from '~/stores/dialog';
import type { QueueEvent, QueueJobView, QueueState, QueueStep, TigerStageId } from '~/types';

const api = vi.hoisted(() => ({
  getQueueState: vi.fn(),
  getQueueHistory: vi.fn(),
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

function step(
  jobId: string,
  stepKey: TigerStageId,
  position: number,
  status: QueueStep['status'] = 'pending',
): QueueStep {
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

function event(
  id: string,
  jobId: string | null,
  type: string,
  message: string,
  createdAt = '2026-06-18T08:00:00.000Z',
): QueueEvent {
  return { id, jobId, type, message, payload: null, createdAt };
}

function state(jobs: QueueJobView[], events: QueueEvent[] = []): QueueState {
  return {
    queuePipelineV2: false,
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

function v2State(allJobs: QueueJobView[], liveItems?: QueueJobView[], events: QueueEvent[] = []): QueueState {
  const terminalJobs = allJobs.filter(
    (item) => item.status === 'completed' || item.status === 'failed' || item.status === 'canceled',
  );
  const live =
    liveItems ??
    allJobs.filter((item) => item.status !== 'completed' && item.status !== 'failed' && item.status !== 'canceled');
  return {
    ...state(allJobs, events),
    queuePipelineV2: true,
    liveItems: live,
    historyCounts: {
      total: terminalJobs.length,
      byStatus: terminalJobs.reduce<NonNullable<QueueState['historyCounts']>['byStatus']>((acc, item) => {
        acc[item.status] = (acc[item.status] ?? 0) + 1;
        return acc;
      }, {}),
      byTarget: terminalJobs.reduce<NonNullable<QueueState['historyCounts']>['byTarget']>((acc, item) => {
        const target = item.targetType ?? 'project';
        acc[target] = (acc[target] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}

// BaseButton relies on Nuxt's auto-imported `computed`, which the bare Vitest env
// doesn't provide. Stub it with a plain <button> that forwards click + attrs
// (data-testid/type fall through to the root element automatically).
const BaseButtonStub = {
  props: ['disabled', 'loading'],
  emits: ['click'],
  template: '<button :disabled="disabled || loading" @click="$emit(\'click\', $event)"><slot /></button>',
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
    api.getQueueHistory.mockResolvedValue({ items: [], total: 0, nextCursor: null, hasMore: false });
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
    expect(wrapper.find('[data-testid="pipeline-mode-panel"]').text()).toContain('Legacy');
    expect(wrapper.find('[data-testid="pipeline-mode-panel"]').text()).toContain('KAPLAN_QUEUE_PIPELINE_V2=on');
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
    expect(api.enqueueQueue.mock.calls[0]?.[0]).not.toHaveProperty('target');
  });

  it('splits v2 live items from paginated history', async () => {
    const live = [
      job('live-1', { position: 1, status: 'queued' }),
      job('live-2', { position: 2, status: 'running' }),
      job('live-3', { position: 3, status: 'paused' }),
    ];
    const history = Array.from({ length: 100 }, (_, i) =>
      job(`history-${i}`, {
        position: i + 4,
        status: i === 0 ? 'failed' : 'completed',
        targetType: i === 0 ? 'terminal' : 'project',
        targetRef: i === 0 ? { terminalId: 'term-1' } : null,
        blockedReason: i === 0 ? 'Terminal failed to start.' : null,
        attempts: 1,
        completedAt: '2026-06-18T09:00:00.000Z',
      }),
    );
    api.getQueueHistory.mockResolvedValueOnce({ items: history, total: 100, nextCursor: null, hasMore: false });

    const wrapper = await mountQueue(v2State([...live, ...history], live));

    expect(wrapper.find('[data-testid="pipeline-mode-panel"]').text()).toContain('Pipeline v2');
    expect(wrapper.find('[data-testid="pipeline-mode-panel"]').text()).not.toContain('KAPLAN_QUEUE_PIPELINE_V2=on');
    expect(wrapper.find('[data-testid="queue-tab-live"]').text()).toContain('Live 3');
    expect(wrapper.find('[data-testid="queue-tab-history"]').text()).toContain('History 100');
    expect(wrapper.findAll('.job-row')).toHaveLength(3);
    expect(wrapper.text()).not.toContain('history-1');

    await wrapper.find('[data-testid="queue-tab-history"]').trigger('click');
    await flushPromises();

    expect(api.getQueueHistory).toHaveBeenCalledWith({ limit: 50 });
    expect(wrapper.findAll('.job-row')).toHaveLength(100);
    expect(wrapper.find('[data-testid="job-row-history-0"]').text()).toContain('Terminal');
    await wrapper.find('[data-testid="job-row-history-0"]').trigger('click');
    expect(wrapper.find('[data-testid="failure-detail"]').text()).toContain('Terminal failed to start.');
    expect(wrapper.find('[data-testid="target-detail"]').text()).toContain('term-1');
    expect(wrapper.find('[data-testid="retry-as-new-job"]').exists()).toBe(true);
  });

  it('exposes v2 filters as segmented controls with dynamic list labels', async () => {
    const first = job('live-1', { position: 1, status: 'queued' });
    const second = job('live-2', { position: 2, status: 'queued' });
    const historyItem = job('history-done', {
      position: 3,
      status: 'completed',
      completedAt: '2026-06-18T09:00:00.000Z',
    });
    api.getQueueHistory.mockResolvedValue({ items: [historyItem], total: 1, nextCursor: null, hasMore: false });
    api.reorderQueue.mockResolvedValue(
      v2State(
        [
          { ...second, position: 1 },
          { ...first, position: 2 },
        ],
        [second, first],
      ),
    );

    const wrapper = await mountQueue(v2State([first, second], [first, second]));

    const targetGroup = wrapper.find('[data-testid="enqueue-target-tabs"]');
    expect(targetGroup.attributes('role')).toBe('group');
    expect(targetGroup.attributes('aria-label')).toBe('Queue target');
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="enqueue-target-project"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-testid="enqueue-target-terminal"]').attributes('aria-pressed')).toBe('false');

    await wrapper.find('[data-testid="enqueue-target-terminal"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-testid="enqueue-target-project"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="enqueue-target-terminal"]').attributes('aria-pressed')).toBe('true');

    const queueGroup = wrapper.find('[data-testid="queue-tabs"]');
    expect(queueGroup.attributes('role')).toBe('group');
    expect(queueGroup.attributes('aria-label')).toBe('Queue list view');
    expect(wrapper.find('[data-testid="queue-tab-live"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-testid="queue-tab-history"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="job-list"]').attributes('aria-label')).toBe('Live queue jobs');

    await wrapper.find('[data-testid="select-job-live-1"]').setValue(true);
    expect(wrapper.find('[data-testid="bulk-bar"]').text()).toContain('1 selected');

    await wrapper.find('[data-testid="move-down-job"]').trigger('click');
    await flushPromises();
    expect(api.reorderQueue).toHaveBeenCalledWith(['live-2', 'live-1']);

    await wrapper.find('[data-testid="queue-tab-history"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="queue-tab-live"]').attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('[data-testid="queue-tab-history"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-testid="job-list"]').attributes('aria-label')).toBe('Queue history items');
    expect(wrapper.find('[data-testid="select-job-history-done"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="bulk-bar"]').exists()).toBe(false);
  });

  it('renders legacy single-list UI when the explicit v2 flag is false despite v2-shaped fields', async () => {
    const finished = job('finished', { position: 1, status: 'completed', completedAt: '2026-06-18T09:00:00.000Z' });
    const live = job('live', { position: 2, status: 'queued' });
    const wrapper = await mountQueue({ ...v2State([finished, live], [live]), queuePipelineV2: false });

    expect(wrapper.find('[data-testid="pipeline-mode-panel"]').text()).toContain('Legacy');
    expect(wrapper.find('[data-testid="enqueue-target-tabs"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="queue-tabs"]').exists()).toBe(false);
    expect(wrapper.find('.list-head').text()).toContain('Ordered jobs');
    expect(wrapper.findAll('.job-row')).toHaveLength(2);
    expect(wrapper.find('[data-testid="job-row-finished"]').exists()).toBe(true);
  });

  it('submits v2 project, terminal, and team target payloads', async () => {
    const wrapper = await mountQueue(v2State([]));
    api.enqueueQueue.mockResolvedValue(job('new'));

    await wrapper.find('[data-testid="enqueue-project"]').setValue('Queued project');
    await wrapper.find('[data-testid="enqueue-provider"]').setValue('mixed');
    await wrapper.find('[data-testid="enqueue-prompt"]').setValue('Build the project');
    await wrapper.find('[data-testid="enqueue-form"]').trigger('submit');
    await flushPromises();

    await wrapper.find('[data-testid="enqueue-target-terminal"]').trigger('click');
    await wrapper.find('[data-testid="enqueue-terminal-name"]').setValue('Test terminal');
    await wrapper.find('[data-testid="enqueue-terminal-cwd"]').setValue('C:\\repo');
    await wrapper.find('[data-testid="enqueue-terminal-shell"]').setValue('pwsh');
    await wrapper.find('[data-testid="enqueue-terminal-command"]').setValue('npm test');
    await wrapper.find('[data-testid="enqueue-form"]').trigger('submit');
    await flushPromises();

    await wrapper.find('[data-testid="enqueue-target-team"]').trigger('click');
    await wrapper.find('[data-testid="enqueue-team-mode"]').setValue('append');
    await wrapper.find('[data-testid="enqueue-team-run-id"]').setValue('run-123');
    await wrapper.find('[data-testid="enqueue-team-body"]').setValue('Review the queue results');
    await wrapper.find('[data-testid="enqueue-form"]').trigger('submit');
    await flushPromises();

    expect(api.enqueueQueue).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        prompt: 'Build the project',
        projectName: 'Queued project',
        provider: 'mixed',
        target: { type: 'project' },
        payload: expect.objectContaining({ projectName: 'Queued project', provider: 'mixed' }),
      }),
    );
    expect(api.enqueueQueue).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        prompt: 'npm test',
        body: 'npm test',
        target: { type: 'terminal' },
        payload: expect.objectContaining({
          name: 'Test terminal',
          cwd: 'C:\\repo',
          initialCommand: 'npm test',
          shell: { kind: 'pwsh' },
        }),
      }),
    );
    expect(api.enqueueQueue).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        prompt: 'Review the queue results',
        body: 'Review the queue results',
        target: { type: 'team' },
        payload: expect.objectContaining({ mode: 'append', runId: 'run-123' }),
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
    api.reorderQueue.mockResolvedValue(
      state([
        { ...second, position: 1 },
        { ...first, position: 2 },
      ]),
    );
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
    api.reorderQueue.mockResolvedValue(
      state([
        { ...second, position: 1 },
        { ...first, position: 2 },
      ]),
    );

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
