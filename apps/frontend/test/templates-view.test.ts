import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { TigerConfig, TigerRunTemplate, TigerStageRunConfig } from '~/types';
import TemplatesView from '~/components/TemplatesView.vue';

const mocks = vi.hoisted(() => ({
  templates: {} as Record<string, unknown>,
  tiger: {} as Record<string, unknown>,
}));

vi.mock('~/stores/templates', () => ({
  templateRef: (template: { id?: string; name: string }) => template.id ?? template.name,
  useTemplatesStore: () => mocks.templates,
}));

vi.mock('~/stores/tiger', () => ({
  useTigerStore: () => mocks.tiger,
}));

const validConfig: TigerStageRunConfig = {
  claudeAgents: 1,
  codexAgents: 1,
  antigravityAgents: 0,
  claudeModel: 'sonnet',
  codexModel: 'gpt-5',
  antigravityModel: 'Gemini 3.1 Pro (High)',
  claudeEffort: 'medium',
  codexEffort: 'medium',
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
      models: ['Gemini 3.1 Pro (High)', 'Claude Sonnet 4.6 (Thinking)'],
      modelFlag: '--model',
      permissionModes: { default: [], sandbox: ['--sandbox'], dangerous: ['--dangerously-skip-permissions'] },
    },
  },
  defaults: validConfig,
  timing: {
    readyIdleMs: 1,
    readyMaxWaitMs: 1,
    doneIdleMs: 1,
    markerPollMs: 1,
    agentTimeoutMs: 1,
    settleMaxWaitMs: 1,
    submitDelayMs: 1,
  },
  execution: {
    parallel: true,
    locking: true,
    maxConcurrent: 2,
    lockTtlMs: 1,
    maxCorrectionCycles: 1,
    deleteTigerOnComplete: false,
  },
};

function template(overrides: Partial<TigerRunTemplate>): TigerRunTemplate {
  return {
    id: 'custom-1',
    name: 'Custom Template',
    description: 'Editable template',
    fromStage: 'writing-plan',
    builtin: false,
    configs: { 'writing-plan': validConfig },
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
        StageConfigPanel: {
          props: ['config', 'stage', 'cfg', 'disabled'],
          template: '<div data-test="stage-config" />',
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
    const builtin = template({
      id: 'builtin-optimum',
      name: 'Optimum',
      description: 'Default built-in',
      builtin: true,
    });
    const custom = template({});

    const state = reactive({
      items: [builtin, custom],
      loaded: true,
      loading: false,
      loadError: null,
      operationError: null,
      savedMessage: null,
      saving: false,
      applyingId: null,
      duplicatingId: null,
      archivingId: null,
      clearFeedback: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
      update: vi.fn(),
      duplicate: vi.fn(async () => {
        const copy = template({ id: 'copy-1', name: 'Optimum Copy', builtin: false });
        state.items.push(copy);
        return copy;
      }),
      archive: vi.fn().mockResolvedValue(undefined),
      apply: vi.fn().mockResolvedValue(builtin),
    });
    mocks.templates = state;
    mocks.tiger = reactive({
      config: tigerConfig,
      load: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders built-in templates as read-only and still allows duplicate/apply', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('Built-ins are read-only');
    expect((wrapper.find('input[placeholder="Template name"]').element as HTMLInputElement).disabled).toBe(true);

    await buttonByText(wrapper, 'Duplicate').trigger('click');
    await flushPromises();
    expect(mocks.templates.duplicate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'builtin-optimum', builtin: true }),
    );

    await buttonByText(wrapper, 'Apply').trigger('click');
    await flushPromises();
    expect(mocks.templates.apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'copy-1' }));
  });

  it('edits custom templates and shows backend validation errors inline', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Edit').trigger('click');

    const name = wrapper.find('input[placeholder="Template name"]');
    expect((name.element as HTMLInputElement).disabled).toBe(false);
    await name.setValue('Invalid Custom');

    vi.mocked(mocks.templates.update).mockImplementation(async () => {
      mocks.templates.operationError = 'configs.writing-plan.claudeAgents must be between 1 and 8';
      throw new Error('invalid');
    });

    await buttonByText(wrapper, 'Save').trigger('click');
    await flushPromises();

    expect(mocks.templates.update).toHaveBeenCalledWith(
      'custom-1',
      expect.objectContaining({ name: 'Invalid Custom' }),
    );
    expect(wrapper.text()).toContain('configs.writing-plan.claudeAgents must be between 1 and 8');
  });

  it('archives custom templates only after confirmation', async () => {
    const wrapper = mountView();
    await flushPromises();

    await wrapper.findAll('.template-row')[1]!.trigger('click');
    await buttonByText(wrapper, 'Archive').trigger('click');
    expect(wrapper.text()).toContain('Confirm archive');

    await buttonByText(wrapper, 'Confirm archive').trigger('click');
    await flushPromises();

    expect(mocks.templates.archive).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom-1' }));
  });
});
