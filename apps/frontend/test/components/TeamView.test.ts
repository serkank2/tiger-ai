import { flushPromises, mount, shallowMount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeamView from '~/components/team/TeamView.vue';
import { useTeamStore } from '~/stores/team';
import type { TeamRunState } from '~/types';

// The store and the view reach for the API, socket, connection, and notices at setup/mount.
// Mock them so mounting never touches the network; the view's onMounted hydrate is then a
// no-op and we drive the run state explicitly through the store's applyState.
const mocks = vi.hoisted(() => ({
  api: {
    listTeamTemplates: vi.fn(async () => ({ teams: [], roles: [] })),
    getTeamState: vi.fn(async () => null),
    listTeamMessages: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listTeamArtifacts: vi.fn(async () => []),
    listTeamProjects: vi.fn(async () => ({ projects: [], lastWorkspace: null })),
    resumeTeamRun: vi.fn(),
  },
  notices: { push: vi.fn() },
  socket: { onServerEvent: vi.fn(() => () => {}) },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/composables/useSocket', () => ({ useSocket: () => mocks.socket }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/stores/connection', () => ({ useConnectionStore: () => ({ status: 'connected' }) }));

// TeamView's child components pull in further stores/components that rely on Nuxt
// auto-imports (e.g. defineStore) not present under plain vitest. This test only exercises
// TeamView's own header, so replace the children with inert stubs to keep the module graph
// light and focused. Factories are hoisted above the file, so the stub must be inlined.
vi.mock('~/components/team/TeamLauncher.vue', () => ({ default: { name: 'TeamLauncher', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamRoleTile.vue', () => ({ default: { name: 'TeamRoleTile', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamRoleControls.vue', () => ({ default: { name: 'TeamRoleControls', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamChatPanel.vue', () => ({ default: { name: 'TeamChatPanel', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamDoneGate.vue', () => ({ default: { name: 'TeamDoneGate', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamSteerBar.vue', () => ({ default: { name: 'TeamSteerBar', inheritAttrs: false, template: '<div />' } }));
vi.mock('~/components/team/TeamTerminalPane.vue', () => ({ default: { name: 'TeamTerminalPane', inheritAttrs: false, template: '<div />' } }));

// A slot-rendering BaseButton stub (the real one relies on Nuxt's auto-imported `computed`).
// Rendering the label slot lets the control tests assert which buttons are offered, and the
// data-variant/title attributes are preserved for diagnostics.
const BaseButtonStub = {
  inheritAttrs: false,
  props: ['loading', 'disabled', 'variant', 'size', 'title', 'iconOnly', 'ariaLabel'],
  emits: ['click'],
  template:
    '<button class="ctl-btn" :data-variant="variant" :title="title" :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>',
};
const SpinnerStub = { props: ['size'], template: '<span class="spinner" />' };

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

async function mountView(runState: TeamRunState | null) {
  const store = useTeamStore();
  const wrapper = shallowMount(TeamView);
  await flushPromises(); // let the onMounted hydrate settle to its (mocked) empty result
  if (runState) store.applyState(runState);
  await flushPromises();
  return wrapper;
}

describe('TeamView header progress wording', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('shows Lead-managed progress with total role turns, never round-robin language', async () => {
    const wrapper = await mountView(state({ turnCount: 3, round: 5 }));

    const meter = wrapper.find('.progress-meter');
    expect(meter.exists()).toBe(true);
    const text = meter.text().toLowerCase();
    expect(text).toContain('lead-managed');
    expect(text).toContain('3 role turns');
    expect(text).not.toContain('round');

    // The hover tooltip must also avoid round-robin framing.
    const title = (meter.attributes('title') ?? '').toLowerCase();
    expect(title).toContain('lead-managed');
    expect(title).not.toContain('round');
  });

  it('renders no round language anywhere in the run header', async () => {
    const wrapper = await mountView(state({ turnCount: 7, round: 9 }));

    const header = wrapper.find('.run-meta');
    expect(header.html().toLowerCase()).not.toContain('round');
  });

  it('uses a singular role-turn label for a single turn', async () => {
    const wrapper = await mountView(state({ turnCount: 1, round: 1 }));
    expect(wrapper.find('.progress-meter').text()).toContain('1 role turn');
    expect(wrapper.find('.progress-meter').text()).not.toContain('1 role turns');
  });

  it('hides the progress meter when no turn count is reported', async () => {
    const wrapper = await mountView(state({ turnCount: undefined, round: undefined }));
    expect(wrapper.find('.progress-meter').exists()).toBe(false);
  });
});

describe('TeamView run controls', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  // Full mount so the slot-rendering BaseButton stub exposes each control's label; the heavy
  // team children stay mocked (above) and Spinner is stubbed.
  async function mountControls(runState: TeamRunState) {
    const store = useTeamStore();
    const wrapper = mount(TeamView, {
      global: { stubs: { BaseButton: BaseButtonStub, Spinner: SpinnerStub } },
    });
    await flushPromises();
    store.applyState(runState);
    await flushPromises();
    return wrapper;
  }

  function controlLabels(wrapper: Awaited<ReturnType<typeof mountControls>>): string[] {
    return wrapper.findAll('.controls button').map((b) => b.text());
  }

  it('exposes Resume and Close for a stopped run — Stop is a resumable halt, not a dead end', async () => {
    const wrapper = await mountControls(state({ status: 'stopped', turnCount: 2 }));
    const labels = controlLabels(wrapper);
    expect(labels).toContain('Resume');
    expect(labels).toContain('Close');
    // A stopped run is halted, not paused or active, so neither Pause nor Stop is offered.
    expect(labels).not.toContain('Pause');
    expect(labels).not.toContain('Stop');
  });

  it('offers Pause/Stop/Close while running and no Resume', async () => {
    const labels = controlLabels(await mountControls(state({ status: 'running', turnCount: 1 })));
    expect(labels).toEqual(expect.arrayContaining(['Pause', 'Stop', 'Close']));
    expect(labels).not.toContain('Resume');
  });

  it('offers neither Resume nor Close for a completed run (sessions are gone)', async () => {
    const labels = controlLabels(await mountControls(state({ status: 'completed', turnCount: 4 })));
    expect(labels).not.toContain('Resume');
    expect(labels).not.toContain('Close');
  });

  it('routes a Resume click for a stopped run through the store', async () => {
    mocks.api.resumeTeamRun.mockResolvedValue({ state: state({ status: 'running' }) });
    const wrapper = await mountControls(state({ status: 'stopped', turnCount: 2 }));
    const resume = wrapper.findAll('.controls button').find((b) => b.text() === 'Resume');
    expect(resume).toBeTruthy();
    await resume!.trigger('click');
    await flushPromises();
    expect(mocks.api.resumeTeamRun).toHaveBeenCalledWith('run-1');
  });
});
