import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import LimitTopPanel from '~/components/shell/LimitTopPanel.vue';
import { useConnectionStore } from '~/stores/connection';
import { useLimitsStore } from '~/stores/limits';
import { useQueueStore } from '~/stores/queue';
import type { LimitSnapshot, LimitStatus, QueueJobView, QueueState, TigerAgentType } from '~/types';

const api = vi.hoisted(() => ({
  getLimits: vi.fn(),
  refreshLimits: vi.fn(),
  getQueueState: vi.fn(),
}));

const socketMock = vi.hoisted(() => {
  const handlers: Record<string, (msg: unknown) => void> = {};
  return {
    handlers,
    onServerEvent: vi.fn((type: string, cb: (msg: unknown) => void) => {
      handlers[type] = cb;
      return vi.fn();
    }),
  };
});

vi.mock('~/composables/useApi', () => ({ useApi: () => api }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => socketMock }));
vi.mock('~/components/ui/Skeleton.vue', () => ({
  default: {
    name: 'Skeleton',
    template: '<span data-testid="skeleton-stub">Skeleton</span>',
  },
}));

const NOW = new Date('2026-06-21T09:00:00.000Z').getTime();
const providers: TigerAgentType[] = ['claude', 'codex', 'antigravity'];

const LimitStatusBadgeStub = {
  name: 'LimitStatusBadge',
  template: '<button data-testid="fallback-badge">Limits</button>',
};

let wrappers: VueWrapper[] = [];

function iso(offsetMs = 0): string {
  return new Date(NOW + offsetMs).toISOString();
}

function snapshot(
  provider: TigerAgentType,
  windowKey: string,
  percentUsed: number | null,
  overrides: Partial<LimitSnapshot> = {},
): LimitSnapshot {
  return {
    id: `${provider}-${windowKey}-${percentUsed ?? 'unknown'}-${overrides.checkedAt ?? 'now'}`,
    provider,
    windowKey,
    label: windowKey === '5h' ? '5h window' : windowKey,
    percentUsed,
    metricRaw: percentUsed === null ? null : { percent: percentUsed, metric: 'used' },
    resetText: null,
    resetAt: iso(60 * 60_000),
    ok: true,
    rawPanel: `${provider} panel`,
    parseConfidence: 'trusted',
    checkedAt: iso(-60_000),
    ...overrides,
  };
}

function selectedWindowFrom(snapshot: LimitSnapshot): NonNullable<LimitStatus['decision']['selectedWindow']> {
  return {
    provider: snapshot.provider,
    windowKey: snapshot.windowKey,
    label: snapshot.label,
    percentUsed: snapshot.percentUsed,
    resetAt: snapshot.resetAt,
    parseConfidence: snapshot.parseConfidence,
    checkedAt: snapshot.checkedAt,
    stale: false,
    ok: snapshot.ok,
    error: snapshot.error,
  };
}

function limitStatus(latest: LimitSnapshot[], overrides: Partial<LimitStatus> = {}): LimitStatus {
  const providerState = Object.fromEntries(
    providers.map((provider) => {
      const providerLatest = latest.filter((item) => item.provider === provider);
      const error = providerLatest.find((item) => item.error)?.error;
      return [
        provider,
        {
          provider,
          latest: providerLatest,
          latestCheckedAt: providerLatest[0]?.checkedAt ?? null,
          ok: providerLatest.length > 0 && providerLatest.every((item) => item.ok && !item.error),
          ...(error ? { error } : {}),
        },
      ];
    }),
  ) as LimitStatus['providers'];

  return {
    snapshots: latest,
    latest,
    providers: providerState,
    rules: [],
    decision: {
      allowed: true,
      action: 'allow',
      reason: 'No active limit rule is blocking execution.',
      resumeAfter: null,
      conservative: false,
      checkedAt: iso(),
    },
    staleAfterMs: 15 * 60_000,
    updatedAt: iso(),
    ...overrides,
  };
}

function job(overrides: Partial<QueueJobView> = {}): QueueJobView {
  return {
    id: 'job-1',
    position: 1,
    status: 'queued',
    priority: 0,
    provider: 'codex',
    workspacePath: 'C:\\repo',
    projectName: 'Queued job',
    prompt: 'Run the job',
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
    createdAt: iso(-10 * 60_000),
    updatedAt: iso(-5 * 60_000),
    steps: [],
    ...overrides,
  };
}

function queueState(jobs: QueueJobView[] = [], overrides: Partial<QueueState> = {}): QueueState {
  return {
    jobs,
    liveItems: jobs,
    rules: [],
    events: [],
    runningByProvider: { claude: 0, codex: 0, antigravity: 0, mixed: 0 },
    providerConcurrency: { claude: 1, codex: 1, antigravity: 1, mixed: 1 },
    updatedAt: iso(),
    ...overrides,
  };
}

function mountPanel(): VueWrapper {
  const wrapper = mount(LimitTopPanel, {
    global: {
      stubs: {
        LimitStatusBadge: LimitStatusBadgeStub,
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('LimitTopPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setActivePinia(createPinia());
    vi.stubGlobal('useApi', () => api);
    useConnectionStore().setStatus('connected');
    vi.clearAllMocks();
    for (const key of Object.keys(socketMock.handlers)) delete socketMock.handlers[key];
    api.getLimits.mockResolvedValue(limitStatus([]));
    api.refreshLimits.mockResolvedValue(limitStatus([]));
    api.getQueueState.mockResolvedValue(queueState());
  });

  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    wrappers = [];
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders loading skeleton cards before the first limits state resolves', () => {
    api.getLimits.mockReturnValue(new Promise(() => {}));

    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="limit-top-panel"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="limit-panel-loading"]')).toHaveLength(4);
  });

  it('renders empty provider cards with Refresh and does not fabricate zero usage', async () => {
    useLimitsStore().applyState(limitStatus([]));

    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="limit-provider-claude"]').text()).toContain('No limit snapshot');
    expect(wrapper.find('[data-testid="limit-provider-codex"]').text()).toContain('No limit snapshot');
    expect(wrapper.find('[data-testid="limit-provider-antigravity"]').text()).toContain('Unsupported');
    expect(wrapper.text()).not.toContain('0%');

    (wrapper.find('[data-testid="limit-refresh"]').element as HTMLButtonElement).click();
    await flushPromises();

    expect(api.refreshLimits).toHaveBeenCalledOnce();
  });

  it('surfaces load errors with retry controls', () => {
    const limits = useLimitsStore();
    limits.loaded = true;
    limits.loadError = 'GET /api/limits failed';

    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="limit-panel-error"]').text()).toContain('GET /api/limits failed');
    expect(wrapper.find('[data-testid="limit-refresh"]').exists()).toBe(true);
  });

  it('marks stale provider snapshots without hiding the last known value', () => {
    const oldCodex = snapshot('codex', 'weekly', 63, { checkedAt: iso(-60 * 60_000) });
    useLimitsStore().applyState(limitStatus([oldCodex], { staleAfterMs: 1_000 }));

    const wrapper = mountPanel();
    const codex = wrapper.find('[data-testid="limit-provider-codex"]');

    expect(codex.text()).toContain('Stale');
    expect(codex.text()).toContain('63%');
  });

  it('renders blocked gate state, blocked queue summary, and queue lane chips', () => {
    const claude = snapshot('claude', 'weekly', 91);
    useLimitsStore().applyState(
      limitStatus([claude], {
        decision: {
          allowed: false,
          action: 'block',
          reason: 'Claude weekly is above 90%.',
          ruleId: 'rule-1',
          selectedWindow: selectedWindowFrom(claude),
          resumeAfter: iso(60 * 60_000),
          conservative: false,
          checkedAt: iso(),
        },
      }),
    );
    useQueueStore().applyState(
      queueState(
        [
          job({
            id: 'blocked',
            status: 'blocked_by_limit',
            provider: 'claude',
            blockedReason: 'Claude usage is above 90%.',
            resumeAfter: iso(30 * 60_000),
          }),
        ],
        {
          runningByProvider: { claude: 0, codex: 1, antigravity: 0, mixed: 0 },
          providerConcurrency: { claude: 1, codex: 2, antigravity: 1, mixed: 1 },
        },
      ),
    );

    const wrapper = mountPanel();

    expect(wrapper.find('[data-testid="limit-gate-card"]').text()).toContain('Block');
    expect(wrapper.find('[data-testid="limit-gate-card"]').text()).toContain('Claude weekly is above 90%.');
    expect(wrapper.find('[data-testid="limit-blocked-summary"]').text()).toContain('Claude usage is above 90%.');
    expect(wrapper.find('[data-testid="limit-lanes"]').text()).toContain('Codex 1/2');
  });

  it('renders Antigravity unsupported instead of a zero percent chart value', () => {
    const unsupported = snapshot('antigravity', 'probe', null, {
      ok: false,
      error: 'agy exposes no usage or limit command.',
      metricRaw: null,
      resetAt: null,
      resetText: null,
    });
    useLimitsStore().applyState(limitStatus([unsupported]));

    const wrapper = mountPanel();
    const card = wrapper.find('[data-testid="limit-provider-antigravity"]');

    expect(card.text()).toContain('Unsupported');
    expect(card.text()).toContain('agy exposes no usage or limit command.');
    expect(card.text()).not.toContain('0%');
  });

  it('renders healthy usage, reset countdown, and a chronological sparkline', () => {
    const history = [10, 20, 35, 45, 55].map((percent, index) =>
      snapshot('claude', '5h', percent, {
        id: `claude-${index}`,
        checkedAt: iso((index - 5) * 60_000),
      }),
    );
    const latest = history[history.length - 1]!;
    useLimitsStore().applyState(limitStatus([latest], { snapshots: history }));

    const wrapper = mountPanel();
    const claude = wrapper.find('[data-testid="limit-provider-claude"]');
    const polyline = wrapper.find('[data-testid="sparkline-claude"] polyline');

    expect(claude.text()).toContain('Healthy');
    expect(claude.text()).toContain('55%');
    expect(claude.text()).toContain('Reset');
    expect(polyline.exists()).toBe(true);
    expect(polyline.attributes('points')?.trim().split(' ')).toHaveLength(5);
  });

  it('applies limit.state and queue.state websocket updates in place', async () => {
    useLimitsStore().applyState(limitStatus([]));
    useQueueStore().applyState(queueState());
    const wrapper = mountPanel();

    socketMock.handlers['limit.state']?.({
      type: 'limit.state',
      state: limitStatus([snapshot('codex', 'session', 44)]),
    });
    socketMock.handlers['queue.state']?.({
      type: 'queue.state',
      state: queueState([], {
        runningByProvider: { claude: 0, codex: 1, antigravity: 0, mixed: 0 },
        providerConcurrency: { claude: 1, codex: 2, antigravity: 1, mixed: 1 },
      }),
    });
    await nextTick();

    expect(wrapper.find('[data-testid="limit-provider-codex"]').text()).toContain('44%');
    expect(wrapper.find('[data-testid="limit-lanes"]').text()).toContain('Codex 1/2');
  });
});
