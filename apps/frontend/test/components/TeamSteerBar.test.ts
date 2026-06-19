import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamSteerBar from '~/components/team/TeamSteerBar.vue';
import { useTeamStore } from '~/stores/team';
import type { SteeringDirective, TeamRunState } from '~/types';

// The store instantiates these at setup; mock them so mounting the bar never reaches the
// network. The bar itself only uses the store's activeRunId / isBusy / directives / state /
// steer(), so a real store over a mocked API is enough to exercise its behavior.
const mocks = vi.hoisted(() => ({
  api: { steerTeamRun: vi.fn() },
  notices: { push: vi.fn() },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/stores/connection', () => ({ useConnectionStore: () => ({ status: 'connected' }) }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => ({ onServerEvent: vi.fn(() => () => {}) }) }));

// BaseButton relies on Nuxt's auto-imported `computed`, which is not present under plain
// vitest; stub it to a minimal native button that renders its label slot and forwards clicks.
const BaseButtonStub = {
  props: ['loading', 'disabled', 'variant', 'size'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
};

function mountBar() {
  return mount(TeamSteerBar, { global: { stubs: { BaseButton: BaseButtonStub } } });
}

function state(overrides: Partial<TeamRunState> = {}): TeamRunState {
  return {
    id: 'run-1',
    name: 'Run',
    goal: 'Goal',
    status: 'running',
    roles: [],
    doneGate: { satisfied: false, requiredRoleIds: [], signedOffRoleIds: [], pendingRoleIds: [] },
    messageCount: 0,
    recentMessages: [],
    pendingSteering: [],
    ...overrides,
  };
}

function directive(id: string): SteeringDirective {
  return { id, runId: 'run-1', body: `prompt ${id}`, createdAt: '2026-06-19T00:00:00.000Z', acknowledged: false };
}

describe('TeamSteerBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('frames the input as messaging the Lead, not steering the team', () => {
    const store = useTeamStore();
    store.applyState(state());

    const wrapper = mountBar();
    const placeholder = (wrapper.find('textarea').attributes('placeholder') ?? '').toLowerCase();
    expect(placeholder).toContain('lead');
    expect(placeholder).not.toContain('steer the team');
    expect(wrapper.find('button').text().toLowerCase()).toContain('lead');
  });

  it('submits the typed prompt to the Lead through the store', async () => {
    mocks.api.steerTeamRun.mockResolvedValue({ state: state() });
    const store = useTeamStore();
    store.applyState(state());

    const wrapper = mountBar();
    await wrapper.find('textarea').setValue('Build the login page');
    await wrapper.find('button').trigger('click');
    await flushPromises();

    expect(mocks.api.steerTeamRun).toHaveBeenCalledWith('run-1', { body: 'Build the login page' });
    expect(mocks.notices.push).toHaveBeenCalledWith('Message sent to the Lead', 'info');
  });

  it('shows that the Lead is waiting when the run has idled to a blocked state', () => {
    const store = useTeamStore();
    store.applyState(state({ status: 'blocked' }));

    const wrapper = mountBar();
    expect(wrapper.find('.hint').text().toLowerCase()).toContain('waiting');
    expect(wrapper.find('button').text()).toBe('Reply to Lead');
  });

  it('surfaces the run waiting message when present', () => {
    const store = useTeamStore();
    store.applyState(state({ status: 'blocked', message: 'The Lead is waiting for a user prompt.' }));

    const wrapper = mountBar();
    expect(wrapper.find('.hint').text()).toBe('The Lead is waiting for a user prompt.');
  });

  it('surfaces how many prompts are queued for the Lead', () => {
    const store = useTeamStore();
    store.applyState(state({ status: 'running', pendingSteering: [directive('d1'), directive('d2')] }));

    const wrapper = mountBar();
    expect(wrapper.find('.hint').text()).toContain('2 messages queued for the Lead');
  });
});
