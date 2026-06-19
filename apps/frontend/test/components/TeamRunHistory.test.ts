import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamRunHistory from '~/components/team/TeamRunHistory.vue';
import { useTeamStore } from '~/stores/team';
import type { TeamRunStateResponse, TeamRunSummary } from '~/types';

const mocks = vi.hoisted(() => ({
  api: {
    listTeamRuns: vi.fn(),
    getTeamRun: vi.fn(),
    listTeamMessages: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listTeamArtifacts: vi.fn(async () => []),
    teamExportUrl: vi.fn((id: string, fmt: string) => `http://api.test/api/team/runs/${id}/export?format=${fmt}`),
  },
  notices: { push: vi.fn() },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/stores/connection', () => ({ useConnectionStore: () => ({ status: 'connected' }) }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => ({ onServerEvent: vi.fn(() => () => {}) }) }));

const BaseButtonStub = {
  inheritAttrs: false,
  props: ['loading', 'disabled', 'variant', 'size', 'title', 'iconOnly', 'ariaLabel'],
  emits: ['click'],
  template:
    '<button class="bb" :title="title" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
};
const SpinnerStub = { props: ['size'], template: '<span class="spinner" />' };

function summary(overrides: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return {
    runId: 'run-1',
    name: 'First run',
    goal: 'Build it',
    status: 'completed',
    roleCount: 3,
    turnCount: 7,
    messageCount: 42,
    createdAt: '2026-06-19T00:00:00.000Z',
    closed: true,
    ...overrides,
  };
}

function runStateResponse(): TeamRunStateResponse {
  return {
    state: {
      id: 'run-2',
      name: 'Second run',
      goal: 'Goal',
      status: 'stopped',
      roles: [],
      doneGate: { satisfied: false, requiredRoleIds: [], signedOffRoleIds: [], pendingRoleIds: [] },
      messageCount: 0,
      recentMessages: [],
      pendingSteering: [],
    },
  };
}

function mountHistory() {
  return mount(TeamRunHistory, { global: { stubs: { BaseButton: BaseButtonStub, Spinner: SpinnerStub } } });
}

describe('TeamRunHistory', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('lists past runs newest-first with role/turn/message counts', async () => {
    mocks.api.listTeamRuns.mockResolvedValue({
      runs: [summary({ runId: 'run-2', name: 'Second run', status: 'running' }), summary()],
    });
    const wrapper = mountHistory();
    await flushPromises();

    const runs = wrapper.findAll('.run');
    expect(runs).toHaveLength(2);
    expect(runs[0]!.text()).toContain('Second run');
    expect(runs[1]!.text()).toContain('First run');
    expect(runs[1]!.text()).toContain('3 roles');
    expect(runs[1]!.text()).toContain('7 turns');
    expect(runs[1]!.text()).toContain('42 msgs');
  });

  it('shows an empty state when there are no runs', async () => {
    mocks.api.listTeamRuns.mockResolvedValue({ runs: [] });
    const wrapper = mountHistory();
    await flushPromises();
    expect(wrapper.find('.h-state.empty').exists()).toBe(true);
  });

  it('opens a past run read-only through the store and emits opened', async () => {
    mocks.api.listTeamRuns.mockResolvedValue({ runs: [summary({ runId: 'run-2' })] });
    mocks.api.getTeamRun.mockResolvedValue(runStateResponse());
    const wrapper = mountHistory();
    await flushPromises();

    const openBtn = wrapper.findAll('.run .bb').find((b) => b.text() === 'Open');
    expect(openBtn).toBeTruthy();
    await openBtn!.trigger('click');
    await flushPromises();

    expect(mocks.api.getTeamRun).toHaveBeenCalledWith('run-2');
    const store = useTeamStore();
    expect(store.viewingRunId).toBe('run-2');
    expect(store.readOnly).toBe(true);
    expect(wrapper.emitted('opened')).toBeTruthy();
  });

  it('exports a run to markdown via the store download helper', async () => {
    mocks.api.listTeamRuns.mockResolvedValue({ runs: [summary({ runId: 'run-9' })] });
    const wrapper = mountHistory();
    await flushPromises();

    const md = wrapper.findAll('.run .bb').find((b) => b.text() === 'MD');
    await md!.trigger('click');
    expect(mocks.api.teamExportUrl).toHaveBeenCalledWith('run-9', 'markdown');
  });
});
