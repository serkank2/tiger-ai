import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { TeamTemplate, TigerConfig, TigerRunTemplate, TigerStageRunConfig } from '~/types';
import TemplatesView from '~/components/TemplatesView.vue';

const mocks = vi.hoisted(() => ({
  team: {} as Record<string, unknown>,
  prompts: {} as Record<string, unknown>,
  cue: {} as Record<string, unknown>,
  templates: {} as Record<string, unknown>,
  tiger: {} as Record<string, unknown>,
}));

vi.mock('~/stores/team', () => ({
  useTeamStore: () => mocks.team,
}));

vi.mock('~/stores/prompts', () => ({
  usePromptsStore: () => mocks.prompts,
}));

vi.mock('~/stores/cue', () => ({
  useCueStore: () => mocks.cue,
}));

vi.mock('~/stores/templates', () => ({
  templateRef: (template: { id?: string; name: string }) => template.id ?? template.name,
  useTemplatesStore: () => mocks.templates,
}));

vi.mock('~/stores/tiger', () => ({
  useTigerStore: () => mocks.tiger,
}));

vi.mock('~/components/prompt/PromptLibrary.vue', () => ({
  default: {
    name: 'PromptLibrary',
    props: ['items', 'currentPath', 'dirty', 'loading', 'error'],
    emits: ['open', 'create', 'remove', 'rename', 'refresh'],
    template:
      '<div data-testid="prompt-library"><span data-testid="prompt-count">{{ items.length }}</span><button @click="$emit(\'refresh\')">Refresh prompts</button><button v-for="item in items" :key="item.path" data-testid="prompt-open" @click="$emit(\'open\', item.path)">{{ item.title || item.path }}</button></div>',
  },
}));

vi.mock('~/components/cue/CueSubscriptionCard.vue', () => ({
  default: {
    name: 'CueSubscriptionCard',
    props: ['sub', 'busy'],
    emits: ['trigger'],
    template:
      '<div data-testid="cue-card"><span>{{ sub.name || sub.id }}</span><span>{{ sub.event }}</span><span>{{ sub.target }}</span><button data-testid="cue-trigger" :disabled="busy" @click="$emit(\'trigger\', sub.id)">Trigger</button></div>',
  },
}));

vi.mock('~/components/tiger/StageConfigPanel.vue', () => ({
  default: {
    name: 'StageConfigPanel',
    props: {
      config: { type: Object, required: true },
      stage: { type: String, required: true },
      cfg: { type: Object, required: true },
      disabled: { type: Boolean, default: false },
    },
    template:
      '<div data-testid="stage-config" :data-stage="stage" :data-disabled="String(!!disabled)">{{ stage }} {{ cfg.claudeAgents }} {{ cfg.codexAgents }}</div>',
  },
}));

vi.mock('~/components/team/TeamTemplateEditor.vue', () => ({
  default: {
    name: 'TeamTemplateEditor',
    props: ['template'],
    emits: ['saved', 'close'],
    template:
      '<div data-testid="team-template-editor"><span>{{ template ? template.name : "new team template" }}</span><button @click="$emit(\'saved\', { id: \'saved-template\', name: \'Saved\', description: \'\', roles: [] })">save</button></div>',
  },
}));

function role(overrides: Partial<TeamTemplate['roles'][number]> = {}): TeamTemplate['roles'][number] {
  return {
    id: 'lead',
    name: 'Lead',
    description: '',
    persona: 'Coordinate the team.',
    responsibilities: ['Coordinate work'],
    agent: { tool: 'codex', model: 'gpt-5', effort: 'medium', permission: 'workspace-write' },
    canWriteCode: false,
    requiredForSignoff: true,
    ...overrides,
  };
}

function template(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'team-template-1',
    name: 'Balanced Team',
    description: 'Lead plus developer.',
    builtin: false,
    roles: [
      role(),
      role({
        id: 'developer',
        name: 'Developer',
        persona: 'Implement the work.',
        responsibilities: ['Implement'],
        canWriteCode: true,
      }),
    ],
    ...overrides,
  };
}

const stageConfig: TigerStageRunConfig = {
  claudeAgents: 2,
  codexAgents: 1,
  antigravityAgents: 0,
  claudeModel: 'sonnet',
  codexModel: 'gpt-5',
  antigravityModel: '',
  claudeEffort: 'medium',
  codexEffort: 'high',
  antigravityEffort: '',
  claudePermission: 'dangerous',
  codexPermission: 'yolo',
  antigravityPermission: 'dangerous',
  parallel: true,
  mergeAgent: 'claude',
};

const tigerConfig: TigerConfig = {
  version: 1,
  cli: {
    claude: {
      executable: 'claude',
      models: ['sonnet', 'opus'],
      modelFlag: '--model',
      effortFlag: '--effort',
      permissionModes: { dangerous: ['--dangerously-skip-permissions'] },
    },
    codex: {
      executable: 'codex',
      models: ['gpt-5'],
      modelFlag: '--model',
      effortConfigKey: 'model_reasoning_effort',
      permissionModes: { yolo: ['--dangerously-bypass-approvals-and-sandbox'] },
    },
    antigravity: {
      executable: 'agy',
      models: [],
      modelFlag: '--model',
      permissionModes: { dangerous: ['--dangerously-skip-permissions'] },
    },
  },
  defaults: stageConfig,
  timing: {},
  execution: {
    parallel: true,
    locking: true,
    maxConcurrent: 2,
    lockTtlMs: 1,
    maxCorrectionCycles: 1,
    deleteTigerOnComplete: false,
  },
};

function runTemplate(overrides: Partial<TigerRunTemplate> = {}): TigerRunTemplate {
  return {
    id: 'run-template-1',
    name: 'Full review run',
    description: 'Default Tiger stages.',
    fromStage: 'writing-plan',
    builtin: true,
    configs: {
      'writing-plan': stageConfig,
      'merge-tasks': { ...stageConfig, mergeAgent: 'codex' },
    },
    ...overrides,
  };
}

function prompt(overrides: Record<string, unknown> = {}) {
  return {
    path: 'review.md',
    title: 'Review prompt',
    description: 'Reusable review block.',
    tags: ['review'],
    ...overrides,
  };
}

function cueSub(overrides: Record<string, unknown> = {}) {
  return {
    id: 'manual-review',
    name: 'Manual review cue',
    event: 'cli.trigger',
    target: 'queue',
    enabled: true,
    fireCount: 0,
    pendingSources: [],
    lastFiredAt: null,
    lastError: null,
    ...overrides,
  };
}

function mountView() {
  return mount(TemplatesView, {
    global: {
      stubs: {
        BaseButton: {
          props: ['disabled', 'loading'],
          emits: ['click'],
          template: '<button :disabled="disabled || loading" @click="$emit(\'click\', $event)"><slot /></button>',
        },
      },
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper.findAll('button').find((candidate) => candidate.text().trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('TemplatesView', () => {
  beforeEach(() => {
    mocks.team = reactive({
      templates: [
        template({ id: 'builtin-team', name: 'Built-in Team', builtin: true }),
        template({ id: 'custom-team', name: 'Custom Team', builtin: false }),
      ],
      templatesLoaded: true,
      templatesLoading: false,
      loadError: null,
      actionError: null,
      loadTemplates: vi.fn().mockResolvedValue(undefined),
      duplicateTemplate: vi.fn().mockResolvedValue(template({ id: 'copy-team', name: 'Custom Team Copy' })),
      deleteTemplate: vi.fn().mockResolvedValue(undefined),
      isBusy: vi.fn().mockReturnValue(false),
    });
    mocks.prompts = reactive({
      items: [prompt()],
      loaded: true,
      loading: false,
      loadError: null,
      fetchAll: vi.fn().mockResolvedValue(undefined),
      open: vi.fn().mockResolvedValue({
        ...prompt(),
        body: 'Opened prompt body',
        version: 'v1',
      }),
      remove: vi.fn().mockResolvedValue(true),
      rename: vi.fn().mockResolvedValue({ ...prompt({ path: 'renamed.md' }), body: '', version: 'v2' }),
    });
    mocks.cue = reactive({
      loaded: true,
      loading: false,
      loadError: null,
      disabled: false,
      subscriptions: [cueSub()],
      manualSubscriptions: [cueSub()],
      running: true,
      workspace: 'C:/repo',
      configPath: 'C:/repo/.kaplan/cue.json',
      load: vi.fn().mockResolvedValue(undefined),
      reload: vi.fn().mockResolvedValue(undefined),
      trigger: vi.fn().mockResolvedValue(undefined),
      isBusy: vi.fn().mockReturnValue(false),
    });
    const builtinRun = runTemplate();
    const customRun = runTemplate({
      id: 'custom-run',
      name: 'Custom regression run',
      description: 'Custom stage preset.',
      builtin: false,
      fromStage: 'executing-plan',
    });
    mocks.templates = reactive({
      items: [builtinRun, customRun],
      builtins: [builtinRun],
      custom: [customRun],
      loaded: true,
      loading: false,
      loadError: null,
      operationError: null,
      savedMessage: null,
      saving: false,
      duplicatingId: null,
      archivingId: null,
      load: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(runTemplate({ id: 'created-run', name: 'Focused author run', builtin: false })),
      update: vi.fn().mockResolvedValue(runTemplate({ id: 'custom-run', name: 'Updated custom run', builtin: false })),
      duplicate: vi.fn().mockResolvedValue(runTemplate({ id: 'copy-run', name: 'Full review run Copy', builtin: false })),
      archive: vi.fn().mockResolvedValue(undefined),
      clearFeedback: vi.fn(),
    });
    mocks.tiger = reactive({
      config: tigerConfig,
      loading: false,
      loadError: null,
      load: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders the unified category shell and keeps team structure as the active category', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(mocks.team.loadTemplates).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Team structure');
    expect(wrapper.text()).toContain('Prompt library');
    expect(wrapper.text()).toContain('Cue configuration');
    expect(wrapper.text()).toContain('Tiger run templates');
    expect(wrapper.text()).toContain('Built-in Team');
    expect(wrapper.text()).toContain('Developer');

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Full review run');
    expect(wrapper.text()).not.toContain('This category will be added in a follow-on templates increment.');

    await wrapper.findAll('.category-row')[0]!.trigger('click');
    expect(wrapper.text()).toContain('Team templates');
  });

  it('opens the existing team template editor for create and edit actions', async () => {
    const wrapper = mountView();
    await flushPromises();

    await buttonByText(wrapper, 'New team template').trigger('click');
    expect(wrapper.find('[data-testid="team-template-editor"]').text()).toContain('new team template');

    await wrapper.findAll('.template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Edit').trigger('click');
    expect(wrapper.find('[data-testid="team-template-editor"]').text()).toContain('Custom Team');
  });

  it('surfaces the empty team-template state with a create action', async () => {
    Object.assign(mocks.team, {
      templates: [],
      templatesLoaded: true,
      templatesLoading: false,
      loadError: null,
      actionError: null,
    });

    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('No team templates yet.');
    await buttonByText(wrapper, 'Create team template').trigger('click');
    expect(wrapper.find('[data-testid="team-template-editor"]').exists()).toBe(true);
  });

  it('loads and renders the prompt-library category through the existing prompts store', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[1]!.trigger('click');
    await flushPromises();

    expect(mocks.prompts.fetchAll).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="prompt-library"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="prompt-count"]').text()).toBe('1');
    expect(wrapper.text()).toContain('Review prompt');
    expect(wrapper.text()).not.toContain('This category will be added in a follow-on templates increment.');

    await wrapper.find('[data-testid="prompt-open"]').trigger('click');
    await flushPromises();

    expect(mocks.prompts.open).toHaveBeenCalledWith('review.md');
    expect(wrapper.text()).toContain('Opened prompt body');
  });

  it('shows prompt-library empty and error states', async () => {
    Object.assign(mocks.prompts, {
      items: [],
      loaded: true,
      loading: false,
      loadError: null,
    });

    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[1]!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('No prompts yet.');
    expect(wrapper.text()).toContain('Refresh prompt library');

    Object.assign(mocks.prompts, {
      loaded: false,
      loading: false,
      loadError: 'Prompt disk unavailable',
    });
    await wrapper.findAll('.category-row')[1]!.trigger('click');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Prompt disk unavailable');
  });

  it('loads and renders the cue-config category through the existing cue store', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[2]!.trigger('click');
    await flushPromises();

    expect(mocks.cue.load).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="cue-card"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Manual review cue');
    expect(wrapper.text()).toContain('C:/repo/.kaplan/cue.json');
    expect(wrapper.text()).not.toContain('This category will be added in a follow-on templates increment.');

    await wrapper.find('[data-testid="cue-trigger"]').trigger('click');
    await flushPromises();

    expect(mocks.cue.trigger).toHaveBeenCalledWith('manual-review');
  });

  it('shows cue-config loading, empty, error, and disabled states', async () => {
    Object.assign(mocks.cue, {
      loaded: false,
      loading: true,
      loadError: null,
      disabled: false,
      subscriptions: [],
    });

    let wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[2]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Loading Cue configuration...');

    wrapper.unmount();
    Object.assign(mocks.cue, {
      loaded: true,
      loading: false,
      loadError: null,
      disabled: false,
      subscriptions: [],
    });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[2]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No cue subscriptions.');

    wrapper.unmount();
    Object.assign(mocks.cue, {
      loaded: true,
      loading: false,
      loadError: 'Cue config invalid',
      disabled: false,
      subscriptions: [],
    });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[2]!.trigger('click');
    await flushPromises();
    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Cue config invalid');

    wrapper.unmount();
    Object.assign(mocks.cue, {
      loaded: true,
      loading: false,
      loadError: null,
      disabled: true,
      subscriptions: [],
    });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[2]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Cue engine is not enabled.');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('loads and renders the tiger-run-templates category through the existing stores', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();

    expect(mocks.templates.load).toHaveBeenCalled();
    expect(mocks.tiger.load).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Built-in runs');
    expect(wrapper.text()).toContain('Custom runs');
    expect(wrapper.text()).toContain('Full review run');
    expect(wrapper.text()).toContain('Custom regression run');
    expect(wrapper.text()).toContain('Starts from Writing Plan');
    expect(wrapper.find('[data-testid="stage-config"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stage-config"]').attributes('data-disabled')).toBe('true');
    expect(wrapper.text()).not.toContain('This category will be added in a follow-on templates increment.');
  });

  it('duplicates and archives tiger run templates with the existing store actions', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();

    await buttonByText(wrapper, 'Duplicate').trigger('click');
    await flushPromises();
    expect(mocks.templates.duplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-template-1' }));

    await wrapper.findAll('.run-template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Archive').trigger('click');
    await flushPromises();
    expect(mocks.templates.archive).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-run' }));
  });

  it('shows tiger-run-templates empty and load-error states', async () => {
    Object.assign(mocks.templates, {
      items: [],
      builtins: [],
      custom: [],
      loaded: true,
      loading: false,
      loadError: null,
      operationError: null,
    });

    let wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('No run templates yet.');
    expect(wrapper.text()).toContain('Create one from the Tiger Run All flow.');

    wrapper.unmount();
    Object.assign(mocks.templates, {
      items: [],
      builtins: [],
      custom: [],
      loaded: false,
      loading: false,
      loadError: 'Template API unavailable',
      operationError: null,
    });
    wrapper = mountView();
    await flushPromises();
    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Template API unavailable');
  });

  it('shows the tiger run-template configuration fallback when tiger config is unavailable', async () => {
    Object.assign(mocks.tiger, {
      config: null,
      loading: false,
      load: vi.fn().mockResolvedValue(undefined),
    });

    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();

    expect(mocks.tiger.load).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Loading configuration...');
    expect(wrapper.find('[data-testid="stage-config"]').exists()).toBe(false);
  });

  it('authors a new tiger run template with the existing create action', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();
    await buttonByText(wrapper, 'New template').trigger('click');
    await flushPromises();

    expect(buttonByText(wrapper, 'Save template').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('[data-testid="stage-config"]').some((panel) => panel.attributes('data-disabled') === 'false')).toBe(true);

    await wrapper.find('[data-testid="run-template-name"]').setValue('Focused author run');
    await wrapper.find('[data-testid="run-template-description"]').setValue('A reusable authored run.');
    await wrapper.find('[data-testid="run-template-from-stage"]').setValue('task-review');
    await buttonByText(wrapper, 'Save template').trigger('click');
    await flushPromises();

    expect(mocks.templates.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Focused author run',
        description: 'A reusable authored run.',
        fromStage: 'task-review',
      }),
    );
    const payload = vi.mocked(mocks.templates.create).mock.calls[0]![0] as { configs: Record<string, TigerStageRunConfig> };
    expect(payload.configs['writing-plan'].claudeAgents).toBe(2);
    expect(payload.configs['writing-plan'].codexAgents).toBe(1);
  });

  it('edits only custom tiger run templates with the existing update action', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();

    expect(wrapper.findAll('button').some((button) => button.text().trim() === 'Edit')).toBe(false);

    await wrapper.findAll('.run-template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Edit').trigger('click');
    await flushPromises();

    expect((wrapper.find('[data-testid="run-template-name"]').element as HTMLInputElement).value).toBe('Custom regression run');
    expect((wrapper.find('[data-testid="run-template-description"]').element as HTMLTextAreaElement).value).toBe('Custom stage preset.');
    expect((wrapper.find('[data-testid="run-template-from-stage"]').element as HTMLSelectElement).value).toBe('executing-plan');

    await wrapper.find('[data-testid="run-template-name"]').setValue('Updated custom run');
    await buttonByText(wrapper, 'Save template').trigger('click');
    await flushPromises();

    expect(mocks.templates.update).toHaveBeenCalledWith(
      'custom-run',
      expect.objectContaining({
        name: 'Updated custom run',
        description: 'Custom stage preset.',
        fromStage: 'executing-plan',
      }),
    );
  });

  it('keeps the tiger run-template editor open and surfaces save errors', async () => {
    mocks.templates.create = vi.fn().mockImplementation(async () => {
      mocks.templates.operationError = 'Template name already exists';
      throw new Error('duplicate');
    });

    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();
    await buttonByText(wrapper, 'New template').trigger('click');
    await wrapper.find('[data-testid="run-template-name"]').setValue('Duplicate run');
    await buttonByText(wrapper, 'Save template').trigger('click');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Template name already exists');
    expect(wrapper.find('[data-testid="run-template-name"]').exists()).toBe(true);
  });

  it('keeps the tiger run-template editor open and surfaces update errors', async () => {
    mocks.templates.update = vi.fn().mockImplementation(async () => {
      mocks.templates.operationError = 'Template update failed';
      throw new Error('update failed');
    });

    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.category-row')[3]!.trigger('click');
    await flushPromises();
    await wrapper.findAll('.run-template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Edit').trigger('click');
    await wrapper.find('[data-testid="run-template-name"]').setValue('Broken custom run');
    await buttonByText(wrapper, 'Save template').trigger('click');
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('Template update failed');
    expect(wrapper.find('[data-testid="run-template-name"]').exists()).toBe(true);
  });
});
