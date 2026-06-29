import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamAttemptsPanel from '~/components/team/TeamAttemptsPanel.vue';
import { useTeamStore } from '~/stores/team';
import type { TeamAttemptSnapshot } from '~/types';

const mocks = vi.hoisted(() => ({
  api: {
    createTeamAttempt: vi.fn(async () => ({ state: null })),
    promoteTeamAttempt: vi.fn(async () => ({ state: null })),
    getTeamAttemptDiff: vi.fn(async () => ({})),
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
  template: '<button class="bb" :title="title" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
};

function attempt(overrides: Partial<TeamAttemptSnapshot> = {}): TeamAttemptSnapshot {
  return {
    id: 'a1',
    attemptNumber: 1,
    status: 'completed',
    branch: 'kaplan/run-1-attempt-1',
    baseRef: 'deadbeef',
    summary: { files: 2, insertions: 10, deletions: 3 },
    startedAt: '2026-06-19T00:00:00.000Z',
    current: false,
    promoted: false,
    ...overrides,
  };
}

function seedState(attempts: TeamAttemptSnapshot[], promotedAttemptId: string | null = null): void {
  const team = useTeamStore();
  team.state = {
    id: 'run-1',
    name: 'Run',
    goal: 'Goal',
    status: 'completed',
    roles: [],
    doneGate: { satisfied: false, requiredRoleIds: [], signedOffRoleIds: [], pendingRoleIds: [], openBlockers: [] },
    messageCount: 0,
    recentMessages: [],
    pendingSteering: [],
    attempts,
    promotedAttemptId,
  } as never;
}

function mountPanel() {
  return mount(TeamAttemptsPanel, { global: { stubs: { BaseButton: BaseButtonStub } } });
}

describe('TeamAttemptsPanel', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('lists attempts with status and diff summary', () => {
    seedState([attempt({ id: 'a1', attemptNumber: 1 }), attempt({ id: 'a2', attemptNumber: 2, current: true, status: 'running' })]);
    const wrapper = mountPanel();
    const rows = wrapper.findAll('.attempt');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('#1');
    expect(rows[0]!.text()).toContain('Completed');
    expect(rows[0]!.text()).toContain('2 files');
    expect(rows[0]!.text()).toContain('+10');
    expect(rows[0]!.text()).toContain('-3');
    // The current attempt is tagged.
    expect(rows[1]!.text()).toContain('current');
  });

  it('promotes an attempt via the store/API', async () => {
    seedState([attempt({ id: 'a1', attemptNumber: 1, status: 'completed' })]);
    const wrapper = mountPanel();
    const buttons = wrapper.findAll('button.bb');
    const promote = buttons.find((b) => b.text() === 'Promote');
    expect(promote).toBeTruthy();
    await promote!.trigger('click');
    expect(mocks.api.promoteTeamAttempt).toHaveBeenCalledWith('run-1', 'a1');
  });

  it('hides Promote once an attempt is already promoted (one promotion per run)', () => {
    seedState(
      [attempt({ id: 'a1', status: 'promoted', promoted: true }), attempt({ id: 'a2', attemptNumber: 2, status: 'completed' })],
      'a1',
    );
    const wrapper = mountPanel();
    const promoteButtons = wrapper.findAll('button.bb').filter((b) => b.text() === 'Promote');
    expect(promoteButtons).toHaveLength(0);
  });

  it('requests an attempt diff and emits view-diff', async () => {
    seedState([attempt({ id: 'a1' })]);
    const wrapper = mountPanel();
    const diffBtn = wrapper.findAll('button.bb').find((b) => b.text() === 'Diff');
    await diffBtn!.trigger('click');
    expect(mocks.api.getTeamAttemptDiff).toHaveBeenCalledWith('run-1', 'a1');
    expect(wrapper.emitted('view-diff')?.[0]).toEqual(['a1']);
  });

  it('shows an empty state and the New attempt button when there are no attempts', () => {
    seedState([]);
    const wrapper = mountPanel();
    expect(wrapper.find('.empty').exists()).toBe(true);
    const newBtn = wrapper.findAll('button.bb').find((b) => b.text().includes('New attempt'));
    expect(newBtn).toBeTruthy();
  });
});
