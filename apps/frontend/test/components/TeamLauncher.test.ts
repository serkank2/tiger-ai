import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import TeamLauncher from '~/components/team/TeamLauncher.vue';
import { useTeamStore } from '~/stores/team';
import type { RoleTemplate, TeamRunState, TeamTemplate } from '~/types';

const mocks = vi.hoisted(() => ({
  api: {
    startTeamRun: vi.fn(),
    listTeamMessages: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listTeamArtifacts: vi.fn(async () => []),
  },
  notices: { push: vi.fn() },
  dialog: { confirm: vi.fn() },
}));

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }));
vi.mock('~/stores/notices', () => ({ useNoticesStore: () => mocks.notices }));
vi.mock('~/composables/useDialog', () => ({ useDialog: () => mocks.dialog }));
vi.mock('~/components/team/TeamTemplateEditor.vue', () => ({
  default: { name: 'TeamTemplateEditor', template: '<div />' },
}));

const BaseButtonStub = {
  props: ['disabled', 'loading'],
  emits: ['click'],
  template: '<button :disabled="disabled || loading" @click="$emit(\'click\', $event)"><slot /></button>',
};

const BadgeStub = { props: ['tool'], template: '<span />' };
const EmptyStub = { template: '<div />' };

const roleTemplate: RoleTemplate = {
  id: 'lead',
  name: 'Lead',
  description: 'Coordinates delivery',
  persona: 'You lead the team.',
  responsibilities: ['Plan the work'],
  agent: {
    tool: 'codex',
    model: 'gpt-5',
    effort: 'medium',
    permission: 'workspace-write',
  },
  canWriteCode: true,
  requiredForSignoff: true,
};

function template(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'template-1',
    name: 'Delivery team',
    description: 'Builds and reviews product changes',
    builtin: true,
    roles: [roleTemplate],
    ...overrides,
  };
}

function state(overrides: Partial<TeamRunState> = {}): TeamRunState {
  return {
    id: 'run-1',
    name: 'Delivery team run',
    goal: 'Build the feature',
    status: 'running',
    roles: [],
    doneGate: { satisfied: false, requiredRoleIds: [], signedOffRoleIds: [], pendingRoleIds: [] },
    messageCount: 0,
    recentMessages: [],
    pendingSteering: [],
    ...overrides,
  };
}

async function mountLauncher(teamTemplates: TeamTemplate[] = [template()]) {
  const store = useTeamStore();
  store.templates = teamTemplates;
  store.projects = ['C:\\repo'];
  store.lastWorkspace = 'C:\\repo';

  const wrapper = mount(TeamLauncher, {
    global: {
      stubs: {
        BaseButton: BaseButtonStub,
        FolderPicker: EmptyStub,
        TeamAgentBadge: BadgeStub,
        TeamTemplateEditor: EmptyStub,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

function resetTeamTestState() {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.api.startTeamRun.mockResolvedValue({ state: state({ orchestrationMode: 'legacy' }) });
  mocks.api.listTeamMessages.mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  mocks.api.listTeamArtifacts.mockResolvedValue([]);
}

describe('TeamLauncher orchestration mode', () => {
  beforeEach(() => {
    resetTeamTestState();
  });

  it('omits orchestrationMode by default so the server config default applies', async () => {
    const wrapper = await mountLauncher();

    await wrapper.find('[data-testid="team-goal"]').setValue('Build the feature');
    await wrapper.find('[data-testid="team-start"]').trigger('click');
    await flushPromises();

    expect(mocks.api.startTeamRun).toHaveBeenCalledWith({
      goal: 'Build the feature',
      templateId: 'template-1',
      path: 'C:\\repo',
    });
  });

  it('sends the selected Company orchestration mode in the start payload', async () => {
    mocks.api.startTeamRun.mockResolvedValue({ state: state({ orchestrationMode: 'company' }) });
    const wrapper = await mountLauncher();

    await wrapper.find('[data-testid="team-goal"]').setValue('Build the feature');
    await wrapper.find('[data-testid="team-orchestration-mode"]').setValue('company');
    await wrapper.find('[data-testid="team-start"]').trigger('click');
    await flushPromises();

    expect(mocks.api.startTeamRun).toHaveBeenCalledWith({
      goal: 'Build the feature',
      templateId: 'template-1',
      path: 'C:\\repo',
      orchestrationMode: 'company',
    });
    expect(useTeamStore().activeRun?.orchestrationMode).toBe('company');
  });
});

describe('TeamLauncher template selection accessibility', () => {
  beforeEach(() => {
    resetTeamTestState();
  });

  it('separates the native template selector from card action buttons', async () => {
    const wrapper = await mountLauncher([
      template(),
      template({
        id: 'template-2',
        name: 'Review team',
        description: 'Reviews product changes',
        builtin: false,
      }),
    ]);

    const cards = wrapper.findAll('.tpl');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.attributes('role')).toBeUndefined();
    expect(cards[0]!.attributes('tabindex')).toBeUndefined();

    let selectors = wrapper.findAll('.tpl-select');
    expect(selectors).toHaveLength(2);
    expect(selectors[0]!.element.tagName).toBe('BUTTON');
    expect(selectors[0]!.attributes('type')).toBe('button');
    expect(selectors[0]!.attributes('aria-pressed')).toBe('true');
    expect(selectors[1]!.attributes('aria-pressed')).toBe('false');
    expect(selectors[0]!.element.querySelector('button')).toBeNull();
    expect(cards[1]!.find('.tpl-actions').element.parentElement).toBe(cards[1]!.element);

    await cards[1]!.find('.tpl-actions button').trigger('click');
    await flushPromises();
    selectors = wrapper.findAll('.tpl-select');
    expect(selectors[0]!.attributes('aria-pressed')).toBe('true');
    expect(selectors[1]!.attributes('aria-pressed')).toBe('false');

    await selectors[1]!.trigger('click');
    await flushPromises();
    selectors = wrapper.findAll('.tpl-select');
    expect(selectors[0]!.attributes('aria-pressed')).toBe('false');
    expect(selectors[1]!.attributes('aria-pressed')).toBe('true');
  });
});
